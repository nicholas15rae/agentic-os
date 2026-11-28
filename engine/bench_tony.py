"""Tony latency benchmark: time to first token and total reply time on an OpenAI-compatible server.

Sends Tony's real phone-turn messages (gateway_tony.build_messages: his system prompt, recent thread,
clock note) to a chat server and streams the answer, the same call gateway Tony makes
(command_center_api.llm_stream). Nothing is stored in Tony's thread or memory.

    python -m engine.bench_tony --target lmstudio --reps 3        # Bionic / LM Studio (today's path)
    python -m engine.bench_tony --target engine --reps 3          # the built-in llama-server (:1238)

Safety (it shares the GPU with the live Tony):
  * lmstudio: refuses unless Tony's model is already `loaded` in Bionic. A chat to an unloaded model
    makes Bionic JIT-load it at its saved defaults (123k x 4, past the 12 GB card).
  * refuses while the gateway's GPU baton is held (a ComfyUI render or a model test).
  * one request at a time; nothing is loaded, unloaded or written outside --out.
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
import urllib.request
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Callable, Optional

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

ENGINE_BASE = "http://127.0.0.1:1238/v1"
GATEWAY = "http://127.0.0.1:8080"
TARGET_TTFT_S = 1.5

# Short phone-style turns: the kind Tony answers most. Fixed so runs compare.
PROMPTS = (
    "hey tony, quick one: what time is it?",
    "what should I focus on this morning?",
    "remind me what you can help me with, in two lines",
    "give me one tip to stay focused today",
)


@dataclass
class Sample:
    prompt: str
    rep: int
    ttft_s: Optional[float]
    total_s: float
    chars: int
    error: str = ""


@dataclass
class Result:
    target: str
    base_url: str
    model: str
    started: str
    samples: list[Sample] = field(default_factory=list)

    def summary(self) -> dict:
        return summarize(self.samples)


def _pct(xs: list[float], p: float) -> float:
    xs = sorted(xs)
    if not xs:
        return float("nan")
    k = min(len(xs) - 1, max(0, round(p * (len(xs) - 1))))
    return xs[k]


def summarize(samples: list[Sample]) -> dict:
    """Median / p90 / min of time to first token and total, over the samples that worked. Rep 0 of
    each prompt is also reported alone ("first"): it pays for any prompt the cache didn't hold."""
    ok = [s for s in samples if not s.error and s.ttft_s is not None]
    first = [s for s in ok if s.rep == 0]
    out = {"n": len(samples), "ok": len(ok), "errors": len(samples) - len(ok)}
    if ok:
        t, tot = [s.ttft_s for s in ok], [s.total_s for s in ok]
        out.update(
            ttft_median=round(statistics.median(t), 3), ttft_p90=round(_pct(t, 0.9), 3), ttft_min=round(min(t), 3),
            total_median=round(statistics.median(tot), 3), total_p90=round(_pct(tot, 0.9), 3),
            hit_target=sum(1 for x in t if x <= TARGET_TTFT_S),
        )
    if first:
        out["ttft_first_median"] = round(statistics.median([s.ttft_s for s in first]), 3)
    return out


def _get_json(url: str, timeout: float = 4.0):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def preflight(target: str, base: str, model: str, *, get_json: Callable = _get_json,
              model_state: Optional[Callable] = None) -> Optional[str]:
    """None when it is safe to benchmark, else the reason not to."""
    try:
        gpu = get_json(f"{GATEWAY}/api/os/gpu")
        if isinstance(gpu, dict) and gpu.get("active"):
            return f"the GPU baton is held by {gpu.get('holder') or 'someone'}; try again later"
    except Exception:
        pass  # no gateway: nothing holds the baton through it
    if target == "lmstudio":
        state = model_state(base, model) if model_state else None
        if state != "loaded":
            return f"Tony's model {model} is {state or 'unreachable'} in Bionic; load it first (never JIT-load)"
        return None
    try:
        data = get_json(f"{base.rstrip('/')}/models")
    except Exception as e:
        return f"engine not reachable at {base}: {e}"
    ids = [m.get("id") for m in (data.get("data") or [])] if isinstance(data, dict) else []
    if model not in ids:
        return f"engine at {base} serves {ids or 'nothing'}, not {model}"
    return None


def run(target: str, reps: int, prompts=PROMPTS, base: str = "", model: str = "",
        stream: Optional[Callable] = None, build: Optional[Callable] = None,
        clock: Callable[[], float] = time.monotonic, max_tokens: Optional[int] = None) -> Result:
    """Each prompt `reps` times, round-robin (so each prompt's repeat follows other prompts, like real
    turns). `stream` / `build` default to gateway Tony's own llm_stream / build_messages."""
    if stream is None or build is None:
        import command_center_api as cc
        import gateway_tony as gt
        stream = stream or cc.llm_stream
        build = build or gt.build_messages
        max_tokens = max_tokens or gt.MAX_TOKENS
    res = Result(target, base, model, time.strftime("%Y-%m-%d %H:%M:%S"))
    for rep in range(reps):
        for p in prompts:
            msgs = build({"text": p})
            t0 = clock()
            first: list[float] = []
            chars = 0
            err = ""

            def on_delta(piece: str) -> None:
                nonlocal chars
                if piece and not first:
                    first.append(clock() - t0)
                chars += len(piece or "")

            try:
                stream(msgs, model=model, base_url=base, max_tokens=max_tokens or 400,
                       first_token_s=30.0, total_s=90.0, on_delta=on_delta)
            except Exception as e:
                err = f"{type(e).__name__}: {e}"[:200]
            res.samples.append(Sample(p, rep, first[0] if first else None, clock() - t0, chars, err))
    return res


def markdown_line(res: Result) -> str:
    s = res.summary()
    if not s.get("ok"):
        return f"| {res.target} ({res.model}) | all {s['n']} failed | {res.started} |"
    return (f"| {res.target} ({res.model}) | first token **{s['ttft_median']} s** median (p90 {s['ttft_p90']}, "
            f"min {s['ttft_min']}; {s['hit_target']}/{s['ok']} <= {TARGET_TTFT_S} s); total {s['total_median']} s "
            f"median (p90 {s['total_p90']}); {s['ok']}/{s['n']} ok | {res.started} |")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--target", choices=("lmstudio", "engine"), required=True)
    ap.add_argument("--reps", type=int, default=3)
    ap.add_argument("--base", default="", help="override the server base URL (…/v1)")
    ap.add_argument("--model", default="", help="override the model id")
    ap.add_argument("--out", default=str(ROOT / "data" / "engine" / "bench"), help="folder for the JSON result")
    a = ap.parse_args(argv)

    import gateway_tony as gt
    model, base = gt.tony_model()
    if a.target == "engine":
        base = ENGINE_BASE
    base, model = a.base or base, a.model or model
    why = preflight(a.target, base, model, model_state=lambda b, m: gt.model_state(gt.bionic_root(b), m))
    if why:
        print(f"REFUSED: {why}", file=sys.stderr)
        return 2
    res = run(a.target, max(1, a.reps), base=base, model=model)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    f = out / f"{time.strftime('%Y%m%d-%H%M%S')}-{a.target}.json"
    f.write_text(json.dumps({**asdict(res), "summary": res.summary()}, indent=2), encoding="utf-8")
    print(json.dumps(res.summary(), indent=2))
    print(markdown_line(res))
    print(f"saved {f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
