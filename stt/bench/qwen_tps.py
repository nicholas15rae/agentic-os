"""Tony's Qwen speed, read-only: one short completion to Bionic (:1235) with thinking off.

Never loads or unloads anything: it checks the model is already loaded and exits otherwise.
Prints JSON {model, completion_tokens, wall_s, tokens_per_s, server_tps}.

  python "G:\\agentic os\\stt\\bench\\qwen_tps.py" [--runs 2]
"""
from __future__ import annotations

import argparse
import json
import time
import urllib.request

BASE = "http://127.0.0.1:1235"
MODEL = "qwen/qwen3.5-9b"
PROMPT = "List the planets of the solar system with one short fact each."


def get(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=10) as r:
        return json.loads(r.read().decode("utf-8"))


def loaded(model: str) -> bool:
    try:
        data = get(f"{BASE}/api/v0/models").get("data") or []
        return any(m.get("id") == model and m.get("state") == "loaded" for m in data)
    except Exception:  # noqa: BLE001
        return False


def once(model: str) -> dict:
    body = {"model": model, "messages": [{"role": "user", "content": PROMPT}], "max_tokens": 160, "temperature": 0,
            "stream": False, "reasoning_effort": "none"}
    req = urllib.request.Request(f"{BASE}/api/v0/chat/completions", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}, method="POST")
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=180) as r:
        out = json.loads(r.read().decode("utf-8"))
    wall = time.perf_counter() - t0
    n = int((out.get("usage") or {}).get("completion_tokens") or 0)
    stats = out.get("stats") or {}
    return {"model": model, "completion_tokens": n, "wall_s": round(wall, 2), "tokens_per_s": round(n / wall, 1) if wall else None,
            "server_tps": round(float(stats.get("tokens_per_second") or 0), 1) or None, "ttft_s": stats.get("time_to_first_token")}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=2)
    ap.add_argument("--model", default=MODEL)
    a = ap.parse_args()
    if not loaded(a.model):
        print(json.dumps({"error": f"{a.model} is not loaded in Bionic; not loading it"}))
        return
    print(json.dumps([once(a.model) for _ in range(a.runs)]))


if __name__ == "__main__":
    main()
