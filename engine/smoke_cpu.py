"""End-to-end smoke test of the engine runner on the CPU only (no GPU, no VRAM).

Starts the real pinned llama-server through Engine (CUDA hidden from the process:
CUDA_VISIBLE_DEVICES=-1, -ngl 0), small context, one slot, waits for health, runs the live
template / tool-call checks and one timed streamed turn, then ALWAYS stops it. engine.json is not
touched (enabled stays false); nothing routes to the engine. CPU numbers are not the GPU benchmark:
they only prove the runner, the template and the thinking-off default work on a real server.

    python -m engine.smoke_cpu
"""
from __future__ import annotations

import dataclasses
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from engine.llama_engine import Engine, load_settings  # noqa: E402
from engine.template_check import live_checks  # noqa: E402


def main() -> int:
    s = dataclasses.replace(load_settings(), enabled=False, gpu_layers=0, ctx=4096, parallel=1, flash_attn=False,
                            kv_type_k="f16", kv_type_v="f16", threads=8, prompt_cache=False)
    eng = Engine(s)
    if eng.health() != "down":
        print(f"REFUSED: something already answers on port {s.port}")
        return 2
    old = os.environ.get("CUDA_VISIBLE_DEVICES")
    os.environ["CUDA_VISIBLE_DEVICES"] = "-1"  # the child inherits: CUDA sees no GPU
    out: dict = {"settings": {"ctx": s.ctx, "gpu_layers": s.gpu_layers, "threads": s.threads, "model": s.model_path}}
    try:
        t0 = time.monotonic()
        st = eng.start(force=True, wait_s=300)
        out["startSecs"] = round(time.monotonic() - t0, 1)
        out["status"] = st
        out["checks"] = live_checks(s.base_url, s.alias)
        import command_center_api as cc
        first: list[float] = []
        t1 = time.monotonic()
        text = cc.llm_stream([{"role": "user", "content": "Say hi to Nic in five words."}], model=s.alias, base_url=s.base_url,
                             max_tokens=24, first_token_s=120, total_s=240,
                             on_delta=lambda p: first.append(time.monotonic() - t1) if p and not first else None)
        out["stream"] = {"firstTokenSecs": round(first[0], 2) if first else None, "totalSecs": round(time.monotonic() - t1, 2), "text": text}
    except Exception as e:
        out["error"] = f"{type(e).__name__}: {e}"[:400]
    finally:
        out["stopped"] = eng.stop()
        if old is None:
            os.environ.pop("CUDA_VISIBLE_DEVICES", None)
        else:
            os.environ["CUDA_VISIBLE_DEVICES"] = old
    print(json.dumps(out, indent=2, ensure_ascii=False))
    ok = "error" not in out and all(c["ok"] for c in out.get("checks", []))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
