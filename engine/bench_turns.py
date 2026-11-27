"""Tony's time to first word, end to end: phone-style turns through the gateway inbox, answered by
whoever claims them (the desktop app when it runs, else gateway Tony). This is the whole turn
path (routing, cues, tools, memory, the model), not just the model's first token.

    python -m engine.bench_turns [--reps 2] [--out data/engine/bench]

Each prompt is a normal turn (it lands in Tony's history like any phone turn), so the prompts are
harmless: greetings, small talk, the time, the weather, a status line. Prints medians per kind and
saves `<stamp>-turns.json`. Refuses while the GPU baton is held (a test would only time the wait).
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
import urllib.request
from pathlib import Path
from typing import Callable, Optional

ROOT = Path(__file__).resolve().parent.parent
GATEWAY = "http://127.0.0.1:8080"

PROMPTS = [
    ("greeting", "Hey Tony"),
    ("small talk", "How's it going?"),
    ("time", "What time is it?"),
    ("weather", "What's the weather like?"),
    ("small talk", "Thanks, that's all for now"),
]


def _json(method: str, url: str, body: Optional[dict] = None, timeout: float = 30.0):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def one_turn(text: str, get: Callable = _json, clock: Callable[[], float] = time.monotonic, limit_s: float = 60.0) -> dict:
    """Post one turn and follow it: seconds to the first streamed piece and to done."""
    t0 = clock()
    posted = get("POST", f"{GATEWAY}/api/os/inbox", {"kind": "turn", "payload": {"text": text, "role": "general", "history": []}})
    qid, seq, first, by = posted["id"], -1, None, posted.get("claimedBy")
    while clock() - t0 < limit_s:
        v = get("GET", f"{GATEWAY}/api/os/inbox/{qid}?wait=10&after={seq}")
        by = v.get("claimed_by") or v.get("claimedBy") or by
        if first is None and (v.get("partial") or (v.get("status") == "done" and v.get("result"))):
            first = clock() - t0
        if v.get("partialSeq", seq) == seq and v.get("status") in ("pending", "running"):
            time.sleep(0.05)  # an answer that came back at once with nothing new: don't spin
        seq = v.get("partialSeq", seq)
        if v.get("status") in ("done", "failed", "cancelled", "error"):
            res = v.get("result") or {}
            answer = (res.get("answer") or res.get("error")) if isinstance(res, dict) else str(res)
            return {"text": text, "firstSecs": round(first, 3) if first is not None else None, "doneSecs": round(clock() - t0, 3),
                    "status": v["status"], "answer": (answer or "")[:160], "by": by}
    return {"text": text, "firstSecs": first, "doneSecs": None, "status": "timeout", "answer": "", "by": by}


def summarize(rows: list[dict]) -> dict:
    out: dict = {}
    kinds = sorted({r["kind"] for r in rows})
    for k in kinds + ["all"]:
        rs = [r for r in rows if (k == "all" or r["kind"] == k) and r.get("firstSecs") is not None]
        if rs:
            out[k] = {"n": len(rs), "firstMedian": round(statistics.median(r["firstSecs"] for r in rs), 3),
                      "doneMedian": round(statistics.median(r["doneSecs"] for r in rs if r.get("doneSecs") is not None), 3)}
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--reps", type=int, default=2)
    ap.add_argument("--label", default="")
    ap.add_argument("--out", default=str(ROOT / "data" / "engine" / "bench"))
    a = ap.parse_args(argv)
    gpu = _json("GET", f"{GATEWAY}/api/os/gpu")
    if gpu.get("busy"):
        print(f"REFUSED: the GPU baton is held by {gpu.get('holder')}")
        return 2
    rows = []
    for rep in range(a.reps):
        for kind, text in PROMPTS:
            r = one_turn(text)
            r.update(kind=kind, rep=rep)
            rows.append(r)
            print(f"{kind:10} {r['firstSecs']!s:>6} s first, {r['doneSecs']!s:>6} s done  [{r['by']}] {r['answer'][:70]!r}")
            time.sleep(1.0)
    s = summarize(rows)
    print(json.dumps(s, indent=2))
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    (out / f"{stamp}-turns{('-' + a.label) if a.label else ''}.json").write_text(json.dumps({"started": stamp, "label": a.label, "rows": rows, "summary": s}, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
