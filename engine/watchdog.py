"""Watchdog for the built-in engine (Section 26 item 11/12).

Every `interval` seconds:
  * engine off (engine.json enabled=false)  → does nothing, ever (it never starts the engine)
  * no pid file (never started, or stopped on purpose) → does nothing (a stop is respected)
  * GPU baton held (ComfyUI render, training, a model test) → waits; the borrower owns the card
  * healthy → nothing; 'loading' → wait
  * process gone or health down/error for `fails_needed` checks in a row → restart llama-server
    with the SAME model it had (Tony's by default), warm it up, log it
  * a start limit: at most `max_restarts` restarts per `window_s`; past it the watchdog gives up,
    logs "gave-up" and leaves the engine down for a human (it can never crash-loop the GPU)

Log: data/engine/logs/watchdog.jsonl (one JSON object per event).
"""
from __future__ import annotations

import json
import sys
import time
import urllib.request
from collections import deque
from pathlib import Path
from typing import Callable, Optional

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from engine.llama_engine import Engine, load_settings  # noqa: E402

GATEWAY_GPU = "http://127.0.0.1:8080/api/os/gpu"


def baton_held(get: Callable = None) -> bool:
    try:
        if get:
            d = get(GATEWAY_GPU)
        else:
            with urllib.request.urlopen(GATEWAY_GPU, timeout=3) as r:
                d = json.loads(r.read().decode("utf-8"))
        return bool(isinstance(d, dict) and d.get("active"))
    except Exception:
        return False  # no gateway: nothing holds the baton through it


def _alive(pid: int) -> bool:
    import os
    import subprocess
    if not pid:
        return False
    if os.name == "nt":
        r = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH"], capture_output=True, text=True, timeout=10)
        return str(pid) in r.stdout
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


class Watchdog:
    def __init__(self, engine: Optional[Engine] = None, *, max_restarts: int = 3, window_s: float = 300.0,
                 fails_needed: int = 2, clock: Callable[[], float] = time.time,
                 alive: Callable[[int], bool] = _alive, held: Callable[[], bool] = baton_held,
                 log_path: Optional[Path] = None, reload_settings: bool = True):
        self.engine = engine or Engine()
        self.max_restarts, self.window_s, self.fails_needed = max_restarts, window_s, fails_needed
        self.clock, self.alive, self.held = clock, alive, held
        self.log_path = log_path or (self.engine.data / "logs" / "watchdog.jsonl")
        self.reload_settings = reload_settings
        self.restarts: deque[float] = deque()
        self.fails = 0
        self.gave_up = False

    def log(self, event: str, **kw) -> None:
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        rec = {"at": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(self.clock())), "event": event, **kw}
        with self.log_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec) + "\n")

    def check(self) -> str:
        """One pass; returns what it did: off, stopped, gave-up, baton, ok, loading, suspect,
        restarted, restart-failed, limit."""
        if self.reload_settings:
            self.engine.s = load_settings()
        if not self.engine.s.enabled:
            return "off"
        info = self.engine._pid_info()
        if not info:
            return "stopped"
        if self.gave_up:
            return "gave-up"
        if self.held():
            return "baton"
        pid = int(info.get("pid") or 0)
        alive = self.alive(pid)
        health = self.engine.health() if alive else "down"
        if health == "ok":
            self.fails = 0
            return "ok"
        if health == "loading":
            return "loading"
        self.fails += 1
        if alive and self.fails < self.fails_needed:
            return "suspect"
        now = self.clock()
        while self.restarts and now - self.restarts[0] > self.window_s:
            self.restarts.popleft()
        if len(self.restarts) >= self.max_restarts:
            self.gave_up = True
            self.log("gave-up", restarts=len(self.restarts), windowS=self.window_s, model=info.get("model"))
            return "limit"
        self.restarts.append(now)
        model, alias = info.get("model"), info.get("alias")
        self.log("crash" if not alive else "unhealthy", pid=pid, health=health, model=model)
        try:
            if alive:
                self.engine.stop()
            else:
                try:
                    self.engine.pid_file.unlink()
                except OSError:
                    pass
            st = self.engine.start(model, alias=alias)
            self.fails = 0
            self.log("restarted", pid=st.get("pid"), model=model, health=st.get("health"))
            return "restarted"
        except Exception as e:
            # keep the pid file of what we tried, so the next pass sees it and counts it
            self.log("restart-failed", model=model, error=str(e)[:300])
            if not self.engine._pid_info():
                self.engine.pid_file.parent.mkdir(parents=True, exist_ok=True)
                self.engine.pid_file.write_text(json.dumps({**info, "pid": 0}), encoding="utf-8")
            return "restart-failed"

    def run(self, interval: float = 10.0, stop: Optional[Callable[[], bool]] = None) -> None:
        self.log("watching", interval=interval)
        while not (stop and stop()):
            try:
                self.check()
            except Exception as e:
                self.log("error", error=str(e)[:300])
            time.sleep(interval)


def main(argv=None) -> int:
    import argparse
    ap = argparse.ArgumentParser(description="the built-in engine's watchdog (does nothing while the engine is off)")
    ap.add_argument("--interval", type=float, default=10.0)
    ap.add_argument("--once", action="store_true")
    a = ap.parse_args(argv)
    w = Watchdog()
    if a.once:
        print(w.check())
    else:
        w.run(a.interval)
    return 0


if __name__ == "__main__":
    sys.exit(main())
