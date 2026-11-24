"""Gateway side of the IBKR paper-trading module: /api/trading/*.

The broker connection does NOT live in this process. `trading/ibkr_bridge.py`
runs in its own venv (ib_async) bound to 127.0.0.1:<TRADING_BRIDGE_PORT>, so a
gateway crash or restart never drops the TWS session, and this file only
proxies its loopback HTTP surface. Auth is whatever server.py's
ZeroTrustMiddleware already enforces for /api (loopback trusted, mesh needs the
gateway token).

Phase 1 is read-only: GET /api/trading/status. Order, kill-switch and mode
endpoints arrive in Phase 2 together with the Security Detail.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from fastapi import APIRouter

BASE_DIR = Path(__file__).resolve().parent
TRADING_DIR = BASE_DIR / "trading"
VENV_PY = TRADING_DIR / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
LOG_DIR = BASE_DIR / "data" / "trading"

router = APIRouter(prefix="/api/trading", tags=["trading"])


def _bridge_port() -> int:
    try:
        return int(os.environ.get("TRADING_BRIDGE_PORT", "8091"))
    except ValueError:
        return 8091


def _bridge_get(path: str, timeout: float = 3.0) -> dict:
    url = f"http://127.0.0.1:{_bridge_port()}{path}"
    with urllib.request.urlopen(url, timeout=timeout) as r:  # noqa: S310 — fixed loopback URL
        return json.loads(r.read().decode("utf-8"))


def offline_status(reason: str) -> dict:
    """Same shape as the bridge snapshot, so the HUD has one code path."""
    return {
        "state": "BRIDGE_OFFLINE",
        "mode": "PAPER",
        "host": None,
        "port": None,
        "clientId": None,
        "readOnly": True,
        "reasons": [reason],
        "lastError": None,
        "connectedSince": None,
        "updatedAt": time.time(),
        "account": None,
        "pnl": {"daily": None, "unrealized": None, "realized": None},
        "positions": [],
        "openOrders": [],
    }


@router.get("/status")
def trading_status():
    try:
        return _bridge_get("/status")
    except (urllib.error.URLError, OSError, ValueError) as e:
        return offline_status(f"bridge not reachable on 127.0.0.1:{_bridge_port()} ({type(e).__name__})")


def autostart_bridge() -> str:
    """Spawn the bridge detached if it isn't answering. Called only from server.py's __main__.

    Skipped when TRADING_BRIDGE_AUTOSTART=0 or the trading venv is missing.
    Returns a short note for the gateway's startup log.
    """
    if os.environ.get("TRADING_BRIDGE_AUTOSTART", "1").strip() in ("0", "false", "FALSE", "no"):
        return "trading bridge autostart disabled"
    try:
        _bridge_get("/health", timeout=1.0)
        return "trading bridge already running"
    except (urllib.error.URLError, OSError, ValueError):
        pass
    if not VENV_PY.exists():
        return f"trading bridge not started: {VENV_PY} missing"
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log = open(LOG_DIR / "bridge.log", "ab")  # noqa: SIM115 — handed to the child process
    flags = 0
    if sys.platform == "win32":
        flags = subprocess.CREATE_NO_WINDOW | subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    subprocess.Popen(  # noqa: S603 — fixed interpreter + script path
        [str(VENV_PY), str(TRADING_DIR / "ibkr_bridge.py")],
        cwd=str(BASE_DIR),
        stdout=log,
        stderr=log,
        stdin=subprocess.DEVNULL,
        creationflags=flags,
        close_fds=True,
    )
    return "trading bridge started"
