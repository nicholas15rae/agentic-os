"""The engine's side of the GPU baton (Section 26 item 13).

A GPU borrower (ComfyUI renders, training; `model_swap.rs` does the same against Bionic today)
calls yield_gpu() before it takes the card and reclaim_gpu() after. yield_gpu remembers which model
the engine had (data/engine/yielded.json) and stops llama-server; reclaim_gpu starts that same model
again (Tony's by default), warm, then forgets the note. The watchdog waits while the baton is held,
so it never fights the borrower; a yielded engine has no pid file, so the watchdog leaves it alone
even after the baton is released, until reclaim_gpu runs.
"""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Optional

from engine.llama_engine import Engine


def _note(eng: Engine) -> Path:
    return eng.data / "yielded.json"


def yield_gpu(holder: str, eng: Optional[Engine] = None) -> dict:
    eng = eng or Engine()
    info = eng._pid_info()
    if not info:
        return {"yielded": False, "reason": "engine not running"}
    note = {"holder": holder, "model": info.get("model"), "alias": info.get("alias"), "at": time.time()}
    _note(eng).parent.mkdir(parents=True, exist_ok=True)
    _note(eng).write_text(json.dumps(note), encoding="utf-8")
    eng.stop()
    return {"yielded": True, **note}


def reclaim_gpu(eng: Optional[Engine] = None) -> dict:
    eng = eng or Engine()
    p = _note(eng)
    try:
        note = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"reclaimed": False, "reason": "nothing was yielded"}
    if not eng.s.enabled:  # switched off meanwhile: don't bring it back
        p.unlink(missing_ok=True)
        return {"reclaimed": False, "reason": "engine is off"}
    st = eng.start(note.get("model"), alias=note.get("alias"))
    p.unlink(missing_ok=True)
    return {"reclaimed": True, "status": st}
