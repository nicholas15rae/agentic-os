"""Voice turn latency, stage by stage (Part 2 of the Section 26 latency pass).

    python scripts/bench_voice_latency.py tts  [--reps 2]   # ElevenLabs: whole MP3 vs first PCM chunk
    python scripts/bench_voice_latency.py stt               # Whisper: Nic's own last decodes (from /health)
    python scripts/bench_voice_latency.py early [--end 500] # Whisper started early: decode vs head start
    python scripts/bench_voice_latency.py prefill           # Tony's prompt prefill, from the engine's log

`tts` makes a few short ElevenLabs calls with Tony's voice and model from providers.json (a few
hundred characters of credit in all). The key comes from ELEVENLABS_API_KEY or `<repo>/.env` and is
never printed. `early` replays the `tts` clips (saved under data/engine/bench/voice/) through the
local Whisper server: it decodes each clip as the early start would (the speech plus 150 ms of
pause) and reports how much of that decode the rest of the end-of-turn pause hides.

Read-only apart from the ElevenLabs calls and two files in data/engine/bench/voice/.
"""
from __future__ import annotations

import argparse
import io
import json
import os
import re
import statistics
import sys
import time
import urllib.request
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "engine" / "bench" / "voice"
CFG = Path(os.environ.get("APPDATA", "")) / "os.agentic.commandcenter"
STT = "http://127.0.0.1:8177"
SENTENCES = [
    "Doing good, Nic.",
    "It's a quarter past ten, and it's cold out there.",
    "Sure thing, I'll keep an eye on it and let you know.",
]
# What the early start waits for before it decodes: this much pause after the last speech frame.
EARLY_AT_MS = 150


def _key() -> str:
    k = os.environ.get("ELEVENLABS_API_KEY", "").strip()
    if k:
        return k
    for env in (ROOT / ".env", Path("G:/agentic os/.env")):
        if env.exists():
            for line in env.read_text(encoding="utf-8", errors="ignore").splitlines():
                m = re.match(r"\s*ELEVENLABS_API_KEY\s*=\s*(.+)\s*$", line)
                if m:
                    return m.group(1).strip().strip('"').strip("'")
    sys.exit("no ElevenLabs key (ELEVENLABS_API_KEY or .env)")


def _tony_voice() -> tuple[str, str]:
    p = json.loads((CFG / "providers.json").read_text(encoding="utf-8-sig"))
    roster = (p.get("agentVoices") or {}).get("general") or {}
    el = next((x for x in p.get("providers", []) if x.get("engine") == "elevenlabs"), {})
    voice = roster.get("voice") if roster.get("engine") == "elevenlabs" and roster.get("voice") else el.get("voice")
    model = roster.get("model") if roster.get("engine") == "elevenlabs" and roster.get("model") else el.get("model")
    return voice or "", model or "eleven_v4"


def _speak(key: str, voice: str, model: str, text: str, fmt: str, first_bytes: int) -> dict:
    body = json.dumps({"text": text, "model_id": model, "voice_settings": {"stability": 0.5, "similarity_boost": 0.75}}).encode()
    req = urllib.request.Request(f"https://api.elevenlabs.io/v1/text-to-speech/{voice}/stream?output_format={fmt}", data=body, method="POST",
                                 headers={"xi-api-key": key, "Content-Type": "application/json"})
    t0 = time.perf_counter()
    first = playable = None
    buf = bytearray()
    with urllib.request.urlopen(req, timeout=45) as r:
        while True:
            chunk = r.read1(4096) if hasattr(r, "read1") else r.read(4096)
            if not chunk:
                break
            if first is None:
                first = time.perf_counter() - t0
            buf += chunk
            if playable is None and len(buf) >= first_bytes:
                playable = time.perf_counter() - t0
    done = time.perf_counter() - t0
    return {"first": first, "playable": playable or done, "done": done, "bytes": bytes(buf)}


def cmd_tts(a) -> None:
    key = _key()
    voice, model = _tony_voice()
    if not voice:
        sys.exit("no ElevenLabs voice for Tony in providers.json")
    OUT.mkdir(parents=True, exist_ok=True)
    rows = []
    for rep in range(a.reps):
        for i, s in enumerate(SENTENCES):
            mp3 = _speak(key, voice, model, s, "mp3_44100_128", 1 << 30)
            # 24 kHz 16-bit mono: 4800 bytes = 100 ms, the first chunk the stream player starts on.
            pcm = _speak(key, voice, model, s, "pcm_24000", 4800)
            if rep == 0:
                (OUT / f"clip{i}.pcm").write_bytes(pcm["bytes"])
            rows.append({"text": s, "mp3First": mp3["first"], "mp3Done": mp3["done"], "pcmFirst": pcm["first"], "pcmPlayable": pcm["playable"], "pcmDone": pcm["done"],
                         "audioSecs": len(pcm["bytes"]) / 48000})
            print(f"{s[:40]:40s}  today (whole mp3) {mp3['done']:.3f}s   stream (first 100 ms of pcm) {pcm['playable']:.3f}s   audio {len(pcm['bytes']) / 48000:.2f}s")
    med = lambda k: statistics.median(r[k] for r in rows)
    print(f"\nmodel {model}: median whole-sentence MP3 {med('mp3Done'):.3f}s (first byte {med('mp3First'):.3f}s); streamed PCM playable at {med('pcmPlayable'):.3f}s")
    (OUT / f"{time.strftime('%Y%m%d-%H%M%S')}-tts.json").write_text(json.dumps({"model": model, "rows": rows}, indent=2), encoding="utf-8")


def _health() -> dict:
    with urllib.request.urlopen(f"{STT}/health", timeout=5) as r:
        return json.loads(r.read().decode())


def cmd_stt(_a) -> None:
    h = _health()
    last = [x for x in h.get("last", []) if not x.get("partial")]
    if not last:
        sys.exit("no final decodes in /health yet")
    ms = sorted(x["decode_ms"] for x in last)
    print(f"{len(ms)} recent finals ({h.get('model')}, beam {h.get('beam_size')}, {h.get('device')}): median {statistics.median(ms)} ms, range {ms[0]}-{ms[-1]} ms, "
          f"audio {min(x['audio_s'] for x in last)}-{max(x['audio_s'] for x in last)} s; GPU free {h.get('gpu_free_mb')} MB")


def _wav16k(pcm24: bytes, tail_ms: int) -> bytes:
    """24 kHz PCM16 -> 16 kHz PCM16 WAV (linear resample) with `tail_ms` of silence after it."""
    import array
    src = array.array("h", pcm24)
    n = int(len(src) * 16000 / 24000)
    out = array.array("h", (src[min(len(src) - 1, int(i * 1.5))] for i in range(n)))
    out.extend([0] * int(16 * tail_ms))
    b = io.BytesIO()
    with wave.open(b, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(out.tobytes())
    return b.getvalue()


def _transcribe(wav: bytes) -> tuple[float, str]:
    boundary = "----benchvoice"
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.wav\"\r\nContent-Type: audio/wav\r\n\r\n").encode() + wav + \
           f"\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"response_format\"\r\n\r\njson\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(f"{STT}/v1/audio/transcriptions", data=body, method="POST", headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=30) as r:
        text = json.loads(r.read().decode()).get("text", "")
    return time.perf_counter() - t0, text


def cmd_early(a) -> None:
    clips = sorted(OUT.glob("clip*.pcm"))
    if not clips:
        sys.exit("run the tts bench first (it saves the clips)")
    head = (a.end - EARLY_AT_MS) / 1000
    rows = []
    for c in clips:
        pcm = c.read_bytes()
        today, t_full = _transcribe(_wav16k(pcm, a.end))
        early, t_early = _transcribe(_wav16k(pcm, EARLY_AT_MS))
        wait = max(0.0, early - head)
        same = t_full.strip().lower() == t_early.strip().lower()
        rows.append((today, wait, same))
        print(f"{c.name}: today {today:.3f}s after the pause; early start decodes in {early:.3f}s with {head:.2f}s of pause still to run -> {wait:.3f}s left; same text: {same}")
    print(f"\nend-of-turn {a.end} ms: Whisper wait median {statistics.median(r[0] for r in rows):.3f}s today -> {statistics.median(r[1] for r in rows):.3f}s with the early start")


def cmd_prefill(_a) -> None:
    logs = [Path("G:/agentic os/data/engine/logs/llama-server.err.log"), Path("G:/agentic-os-engine/data/engine/logs/llama-server.err.log")]
    log = next((p for p in logs if p.exists()), None)
    if not log:
        sys.exit("no engine log")
    pe = re.compile(r"prompt eval time =\s+([\d.]+) ms /\s+(\d+) tokens")
    ev = re.compile(r"\beval time =\s+([\d.]+) ms /\s+(\d+) tokens")
    rows, cur = [], {}
    for line in log.read_text(encoding="utf-8", errors="ignore").splitlines()[-600:]:
        if m := pe.search(line):
            cur = {"prefill_ms": float(m.group(1)), "prefill_tok": int(m.group(2))}
        elif cur and (m := ev.search(line)):
            cur.update(gen_ms=float(m.group(1)), gen_tok=int(m.group(2)))
            rows.append(cur)
            cur = {}
    rows = [r for r in rows if r["prefill_tok"] >= 20][-20:]
    if not rows:
        sys.exit("no requests in the log")
    print(f"last {len(rows)} engine requests: prefill median {statistics.median(r['prefill_ms'] for r in rows):.0f} ms for {statistics.median(r['prefill_tok'] for r in rows):.0f} new tokens; "
          f"per generated token {statistics.median(r['gen_ms'] / max(1, r['gen_tok']) for r in rows):.1f} ms")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("tts")
    t.add_argument("--reps", type=int, default=2)
    sub.add_parser("stt")
    e = sub.add_parser("early")
    e.add_argument("--end", type=int, default=500, help="end-of-turn pause in ms")
    sub.add_parser("prefill")
    a = ap.parse_args()
    {"tts": cmd_tts, "stt": cmd_stt, "early": cmd_early, "prefill": cmd_prefill}[a.cmd](a)


if __name__ == "__main__":
    main()
