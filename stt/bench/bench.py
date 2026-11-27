"""STT benchmark: whisper.cpp base.en (:8178, today's engine) vs faster-whisper (:8177) arms.

Every request carries the fields the desktop sends (voice.rs transcribe_bytes: json, temperature 0,
language en, the vocabulary prompt), over HTTP to the running servers, so the numbers include the
real request path. faster-whisper arms: model x compute type (hot-swapped through POST /load)
x beam 1/5 x vocabulary as initial prompt vs hotwords.

Per arm: one warm-up request (dropped), then `--runs` passes over every clip.
  * latency p50 / p95 by clip duration (<=2 s, 2-5 s, 5-10 s, 10-30 s), client wall time
  * WER (Whisper-style English normalisation) and vocabulary recall, from the first pass
  * false positives on the non-speech clips, raw and after the callers' junk / prompt-echo guards
  * GPU memory: after the load, and the least free seen while the arm ran

Clips come from gen_clips.py (data/stt-bench/clips). Results: data/stt-bench/results-<time>.json.

It drives the LIVE :8177 server (Tony's STT): the arms hot-swap its model, and live voice turns
queue behind the benchmark's decodes while it runs. The model the server had at the start is put
back at the end (POST /load in a finally block), also after an error or Ctrl+C, and also when the
run stops while an arm's load is still in flight (that load is queued: the restore lands after it).
The results JSON is written before the restore (with "complete": false after an early stop), so a
restore that fails (:8177 down at the end) prints "[restore] failed" and costs no numbers.

  python -I "G:\\agentic os\\stt\\bench\\bench.py" [--runs 3] [--arms whispercpp,distil-large-v3:int8_float16]
"""
from __future__ import annotations

import argparse
import json
import re
import statistics
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CLIPS = ROOT / "data" / "stt-bench" / "clips"
WCPP = "http://127.0.0.1:8178/v1"
FW = "http://127.0.0.1:8177"
# voice.rs DEFAULT_STT_PROMPT (command center/src-tauri/src/commands/dispatch.rs), "Nic" included
PROMPT = ("Tony, Nic, Gabagool mode. Take it easy. Cut it. Whoa. Madone, aspetta. Prompter, Designer, Coder, Booking Desk, "
          "Librarian and Ops. Bilmuri, Erra. WhatsApp, Gmail, Spotify, Tauri, Kokoro, Serena, checkpoint.")
VOCAB = ["tony", "gabagool", "madone", "aspetta", "bilmuri", "erra", "booking desk", "librarian", "kokoro", "tauri", "nic",
         "serena", "call sheet", "deal memo", "whatsapp", "spotify", "checkpoint"]
BUCKETS = ((0, 2, "<=2s"), (2, 5, "2-5s"), (5, 10, "5-10s"), (10, 31, "10-30s"))
JUNK = ("[blank_audio]", "(silence)", "[ silence ]", "[silence]")

# ── normalisation / scoring ─────────────────────────────────────────────────
NUM = {w: str(i) for i, w in enumerate("zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen "
                                         "fifteen sixteen seventeen eighteen nineteen twenty".split())}
SPELL = {"ok": "okay", "whats": "whats", "alright": "all right", "gonna": "going to", "wanna": "want to"}


def norm(s: str) -> list[str]:
    """Whisper-style English normalisation (the parts that matter for these clips): lower case, no
    bracketed asides, hyphens/slashes split words, punctuation and apostrophes dropped, number
    words <-> digits, "o'clock" and "9:00"-style minutes folded, a few spelling variants unified."""
    s = s.lower()
    s = re.sub(r"[\[(][^\])]*[\])]", " ", s)
    s = re.sub(r"(\d+):00\b", r"\1", s)
    s = s.replace("o'clock", " ").replace("-", " ").replace("/", " ")
    s = re.sub(r"[^a-z0-9' ]+", " ", s).replace("'", "")
    out = []
    for w in s.split():
        w = NUM.get(w, w)
        out.extend(SPELL.get(w, w).split())
    return out


def edits(ref: list[str], hyp: list[str]) -> int:
    d = list(range(len(hyp) + 1))
    for i in range(1, len(ref) + 1):
        prev, d[0] = d[0], i
        for j in range(1, len(hyp) + 1):
            cur = min(d[j] + 1, d[j - 1] + 1, prev + (ref[i - 1] != hyp[j - 1]))
            prev, d[j] = d[j], cur
    return d[len(hyp)]


def vocab_hits(ref: str, hyp: str) -> tuple[int, int]:
    r, h = " " + " ".join(norm(ref)) + " ", " " + " ".join(norm(hyp)) + " "
    want = [v for v in VOCAB for _ in range(r.count(f" {v} "))]
    got = sum(min(r.count(f" {v} "), h.count(f" {v} ")) for v in set(want))
    return got, len(want)


def prompt_words(s: str) -> list[str]:
    return [w.replace("'", "").lower() for w in re.split(r"[^\w']+", s) if w.replace("'", "")]


REFLEX = [["take", "it", "easy"], ["take", "it", "ease"], ["cut", "it", "out"], ["cut", "it"], ["cut", "that"], ["whoa"], ["madone"],
          ["aspetta"], ["hey"], ["yo"], ["tony"], ["ok"], ["okay"], ["man"]]


def only_reflex(words: list[str]) -> bool:
    i = 0
    while i < len(words):
        for p in REFLEX:
            if words[i:i + len(p)] == p:
                i += len(p)
                break
        else:
            return False
    return True


def echoes_prompt(text: str, prompt: str) -> bool:
    """voice.rs echoes_prompt: >= 70% of the words sit in 4-word runs copied from the prompt."""
    t, p = prompt_words(text), prompt_words(prompt)
    if len(t) < 4 or len(p) < 4 or only_reflex(t):
        return False
    grams = {tuple(p[i:i + 4]) for i in range(len(p) - 3)}
    cov = [False] * len(t)
    for i in range(len(t) - 3):
        if tuple(t[i:i + 4]) in grams:
            cov[i:i + 4] = [True] * 4
    return sum(cov) * 10 >= len(t) * 7


def guarded(text: str) -> str:
    t = text.strip()
    if t.lower() in JUNK or echoes_prompt(t, PROMPT):
        return ""
    return t


# ── HTTP ─────────────────────────────────────────────────────────────────────

def post(url: str, wav: bytes, fields: dict, timeout: float = 120) -> tuple[float, str, int]:
    bnd = "----bench" + uuid.uuid4().hex
    body = bytearray()
    for k, v in fields.items():
        body += f'--{bnd}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
    body += f'--{bnd}\r\nContent-Disposition: form-data; name="file"; filename="speech.wav"\r\nContent-Type: audio/wav\r\n\r\n'.encode()
    body += wav + f"\r\n--{bnd}--\r\n".encode()
    req = urllib.request.Request(url, data=bytes(body), headers={"Content-Type": f"multipart/form-data; boundary={bnd}"}, method="POST")
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8")
            code = r.status
    except urllib.error.HTTPError as e:
        return time.perf_counter() - t0, "", e.code
    dt = time.perf_counter() - t0
    try:
        return dt, str(json.loads(raw).get("text") or "").strip(), code
    except ValueError:
        return dt, raw.strip(), code


def jget(url: str, timeout: float = 10) -> dict:
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def jpost(url: str, body: dict, timeout: float = 300) -> tuple[int, dict]:
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8") or "{}")


def gpu() -> tuple[int, int]:
    out = subprocess.run(["nvidia-smi", "--query-gpu=memory.used,memory.free", "--format=csv,noheader,nounits"],
                         capture_output=True, text=True, timeout=5).stdout.strip().splitlines()[0]
    u, f = (int(x) for x in out.split(","))
    return u, f


class GpuWatch:
    """Least free / most used GPU memory while an arm runs (nvidia-smi every 0.25 s)."""

    def __init__(self):
        self.min_free, self.max_used, self._stop = 10 ** 9, 0, threading.Event()
        self._t = threading.Thread(target=self._run, daemon=True)

    def _run(self):
        while not self._stop.is_set():
            try:
                u, f = gpu()
                self.min_free, self.max_used = min(self.min_free, f), max(self.max_used, u)
            except Exception:  # noqa: BLE001
                pass
            self._stop.wait(0.25)

    def __enter__(self):
        self._t.start()
        return self

    def __exit__(self, *a):
        self._stop.set()
        self._t.join(2)


# ── arms ─────────────────────────────────────────────────────────────────────

def arms(selected: set[str] | None) -> list[dict]:
    out = [{"name": "whispercpp base.en (current)", "key": "whispercpp", "url": f"{WCPP}/audio/transcriptions",
            "fields": {"model": "base.en", "response_format": "json", "temperature": "0", "language": "en", "prompt": PROMPT}}]
    for model in ("distil-large-v3", "large-v3-turbo"):
        for compute in ("int8_float16", "float16"):
            # Silero VAD on (the server default) for every arm, plus one VAD-off arm per model/compute.
            for beam, bias, vad in ((1, "prompt", "1"), (1, "hotwords", "1"), (5, "prompt", "1"), (5, "hotwords", "1"), (5, "prompt", "0")):
                out.append({"name": f"fw {model} {compute} beam{beam} {bias}{'' if vad == '1' else ' no-vad'}", "key": f"{model}:{compute}",
                            "load": (model, compute), "url": f"{FW}/v1/audio/transcriptions",
                            "fields": {"model": model, "response_format": "json", "temperature": "0", "language": "en",
                                       "beam_size": str(beam), bias: PROMPT, "vad": vad}})
    return [a for a in out if not selected or a["key"] in selected or a["name"] in selected]


def pct(xs: list[float], q: float) -> float | None:
    if not xs:
        return None
    xs = sorted(xs)
    k = (len(xs) - 1) * q
    lo, hi = int(k), min(len(xs) - 1, int(k) + 1)
    return round(xs[lo] + (xs[hi] - xs[lo]) * (k - lo), 3)


def run_arm(arm: dict, clips: list[dict], runs: int) -> dict:
    wavs = {c["id"]: (CLIPS / f"{c['id']}.wav").read_bytes() for c in clips}
    lat: dict[str, list[float]] = {b[2]: [] for b in BUCKETS}
    errs = 0
    first: dict[str, str] = {}
    post(arm["url"], wavs[clips[0]["id"]], arm["fields"])  # warm-up, dropped
    with GpuWatch() as gw:
        for r in range(runs):
            for c in clips:
                dt, text, code = post(arm["url"], wavs[c["id"]], arm["fields"])
                if code != 200:
                    errs += 1
                    continue
                if r == 0:
                    first[c["id"]] = text
                if c["kind"] == "speech":
                    b = next(b[2] for b in BUCKETS if b[0] < c["seconds"] <= b[1] or (b[0] == 0 and c["seconds"] <= b[1]))
                    lat[b].append(dt)
    e = n = vh = vn = 0
    misses: list[dict] = []
    fp_raw, fp_guarded = [], []
    for c in clips:
        hyp = first.get(c["id"], "")
        if c["kind"] == "noise":
            if hyp:
                fp_raw.append({"id": c["id"], "text": hyp})
            if guarded(hyp):
                fp_guarded.append({"id": c["id"], "text": hyp})
            continue
        g = guarded(hyp)
        ref = norm(c["text"])
        ed = edits(ref, norm(g))
        e, n = e + ed, n + len(ref)
        h, w = vocab_hits(c["text"], g)
        vh, vn = vh + h, vn + w
        if ed:
            misses.append({"id": c["id"], "ref": c["text"], "hyp": hyp})
    return {
        "arm": arm["name"], "key": arm["key"], "errors": errs,
        "latency": {k: {"n": len(v), "p50": pct(v, 0.5), "p95": pct(v, 0.95), "mean": round(statistics.mean(v), 3) if v else None} for k, v in lat.items()},
        "wer": round(e / n, 4) if n else None, "word_errors": e, "words": n,
        "vocab_recall": round(vh / vn, 4) if vn else None, "vocab_hits": vh, "vocab_terms": vn,
        "noise_fp_raw": fp_raw, "noise_fp_guarded": fp_guarded,
        "gpu_min_free_mb": gw.min_free if gw.min_free < 10 ** 9 else None, "gpu_max_used_mb": gw.max_used or None,
        "misses": misses,
    }


def fw_health() -> dict | None:
    """The live :8177 server's /health, or None (down / not JSON)."""
    try:
        h = jget(f"{FW}/health", 5)
    except Exception:  # noqa: BLE001 — down
        return None
    return h if isinstance(h, dict) else None


def model_of(h: dict | None) -> dict | None:
    """{model, compute_type, device} that a /health names, or None (no model)."""
    if not h or not h.get("model"):
        return None
    dev = str(h.get("device") or "cuda")
    # "cpu-unavailable": it wanted the GPU and had too little VRAM; /load takes "cuda" for that.
    return {"model": h["model"], "compute_type": h.get("compute_type") or "int8_float16", "device": "cuda" if dev.endswith("-unavailable") else dev}


def live_model() -> dict | None:
    """What the live :8177 server has loaded ({model, compute_type, device}), or None (down, or no model)."""
    return model_of(fw_health())


def restore_model(found: dict | None) -> dict | None:
    """Put back the model the run found (POST /load), unless the server has it, loaded and settled.
    -> what was done. Never raises: a failed restore is reported in "failed" (the run's results are
    already written by then)."""
    if not found:
        return None
    h = fw_health()
    now = model_of(h)
    # Mid-load (an arm's POST /load still in flight after Ctrl+C or jpost's timeout) /health says
    # ready False, loading True and still names the OLD model: that is not "it still has it", the
    # queued arm load replaces it a moment later. POST anyway: the worker runs loads in order, so
    # this one lands after the in-flight one and the found model is what stays.
    settled = bool(h and h.get("ready") and not h.get("loading"))
    if settled and now and (now["model"], now["compute_type"], now["device"]) == (found["model"], found["compute_type"], found["device"]):
        return {"restored": False, "model": found["model"], "compute_type": found["compute_type"]}
    try:
        code, body = jpost(f"{FW}/load", found)
    except Exception as e:  # noqa: BLE001 — :8177 down or restarting, a timeout: say so, don't lose the run
        return {"restored": False, "model": found["model"], "compute_type": found["compute_type"], "failed": f"{type(e).__name__}: {e}"[:300]}
    return {"restored": code == 200, "status": code, "model": body.get("model"), "compute_type": body.get("compute_type"), "error": body.get("error")}


def write_results(out: Path, base_gpu, runs: int, clips: int, results: list[dict], complete: bool) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"at": time.strftime("%Y-%m-%d %H:%M:%S"), "gpu_before": base_gpu, "runs": runs, "clips": clips,
                               "complete": complete, "results": results}, indent=1), encoding="utf-8")
    print(f"-> {out}{'' if complete else ' (stopped early: the arms that finished)'}", file=sys.stderr, flush=True)


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--arms", default="")
    ap.add_argument("--out", default="")
    a = ap.parse_args(argv)
    clips = json.loads((CLIPS / "manifest.json").read_text(encoding="utf-8"))
    sel = {s.strip() for s in a.arms.split(",") if s.strip()} or None
    results, loads = [], {}
    base_gpu = gpu()
    found = live_model()  # the live server's model: restored in the finally below
    swapped = complete = False
    out = Path(a.out) if a.out else ROOT / "data" / "stt-bench" / f"results-{time.strftime('%Y%m%d-%H%M%S')}.json"
    try:
        for arm in arms(sel):
            if "load" in arm and arm["key"] not in loads:
                model, compute = arm["load"]
                t0 = time.perf_counter()
                swapped = True
                code, h = jpost(f"{FW}/load", {"model": model, "compute_type": compute})
                loads[arm["key"]] = {"status": code, "seconds": round(time.perf_counter() - t0, 1), "vram_mb": h.get("vram_mb"), "gpu_after": gpu(),
                                     "device": h.get("device"), "error": h.get("error"), "warmup_ms": h.get("warmup_ms")}
                print(f"[load] {arm['key']}: {loads[arm['key']]}", file=sys.stderr, flush=True)
                if code != 200:
                    continue
            res = run_arm(arm, clips, a.runs)
            if "load" in arm:
                res["load"] = loads[arm["key"]]
            results.append(res)
            lt = res["latency"]
            print(f"{res['arm']:48} 2-5s p50 {lt['2-5s']['p50']} p95 {lt['2-5s']['p95']} | <=2s {lt['<=2s']['p50']} | 5-10s {lt['5-10s']['p50']} "
                  f"| 10-30s {lt['10-30s']['p50']} | WER {res['wer']:.2%} vocab {res['vocab_recall']:.1%} | FP raw {len(res['noise_fp_raw'])} "
                  f"guarded {len(res['noise_fp_guarded'])} | minfree {res['gpu_min_free_mb']} err {res['errors']}", flush=True)
        complete = True
    finally:
        # Results first (also the arms that finished before an error or Ctrl+C), then the restore:
        # a restore that fails (:8177 down at the end) must not cost the run's numbers.
        try:
            write_results(out, base_gpu, a.runs, len(clips), results, complete)
        finally:
            if swapped:
                if found:
                    r = restore_model(found)
                    if r and r.get("failed"):
                        print(f"[restore] failed: {found['model']} {found['compute_type']} was not put back ({r['failed']}); "
                              f"POST {FW}/load {json.dumps(found)} by hand or restart :8177", file=sys.stderr, flush=True)
                    else:
                        print(f"[restore] {found['model']} {found['compute_type']}: {r}", file=sys.stderr, flush=True)
                else:
                    print("[restore] the server had no model at the start; it keeps the last arm's", file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
