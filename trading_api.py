"""Gateway side of the IBKR paper-trading module: /api/trading/*.

The broker connection does NOT live in this process. `trading/ibkr_bridge.py`
runs in its own venv (ib_async) bound to 127.0.0.1:<TRADING_BRIDGE_PORT>, so a
gateway crash or restart never drops the TWS session, and this file only
proxies its loopback HTTP surface. Auth is whatever server.py's
ZeroTrustMiddleware already enforces for /api (loopback trusted, mesh needs the
gateway token).

Routes: status, desk view, intents (+approve/reject), mode, comms, and the
kill switch. The kill switch is fail-safe: if the bridge can't be reached the
gateway writes the persistent lock itself (stdlib only, no ib_async) and then
starts `trading/kill_switch.py` in the trading venv to cancel and flatten.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request

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


def _bridge_post(path: str, payload: dict, actor: str, timeout: float = 15.0) -> dict:
    url = f"http://127.0.0.1:{_bridge_port()}{path}"
    req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), method="POST",
                                 headers={"Content-Type": "application/json", "x-trading-actor": actor})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 — fixed loopback URL
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        try:
            detail = json.loads(detail).get("detail", detail)
        except ValueError:
            pass
        raise HTTPException(e.code, detail) from None


def _actor(request: Request) -> str:
    host = request.client.host if request.client else "?"
    return "ui:desktop" if host in ("127.0.0.1", "::1", "localhost") else f"ui:mesh:{host}"


async def _json(request: Request) -> dict:
    try:
        data = await request.json()
    except ValueError:
        raise HTTPException(400, "body must be JSON") from None
    if not isinstance(data, dict):
        raise HTTPException(400, "body must be a JSON object")
    return data


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
        "fx": {},
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


OFFLINE = (urllib.error.URLError, OSError, ValueError)


def _offline(e: Exception):
    return HTTPException(503, f"trading bridge not reachable on 127.0.0.1:{_bridge_port()} ({type(e).__name__})")


@router.get("/desk")
def trading_desk():
    try:
        return _bridge_get("/desk", timeout=6.0)
    except OFFLINE as e:
        raise _offline(e) from None


@router.post("/intents")
async def trading_intent(request: Request):
    body = await _json(request)
    try:
        return _bridge_post("/intents", body, _actor(request), timeout=30.0)
    except OFFLINE as e:
        raise _offline(e) from None


@router.post("/intents/{intent_id}/{verb}")
def trading_intent_verb(intent_id: str, verb: str, request: Request):
    if verb not in ("approve", "reject"):
        raise HTTPException(404, "unknown action")
    try:
        return _bridge_post(f"/intents/{urllib.parse.quote(intent_id, safe='')}/{verb}", {}, _actor(request), timeout=30.0)
    except OFFLINE as e:
        raise _offline(e) from None


@router.post("/mode")
async def trading_mode(request: Request):
    body = await _json(request)
    try:
        return _bridge_post("/mode", body, _actor(request))
    except OFFLINE as e:
        raise _offline(e) from None


@router.post("/comms")
async def trading_comms(request: Request):
    body = await _json(request)
    try:
        return _bridge_post("/comms", body, _actor(request))
    except OFFLINE as e:
        raise _offline(e) from None


@router.get("/signals")
def trading_signals(q: str = "", ticker: str = "", k: int = 8):
    """trading_rag context for the Trading Agent (Quiver disclosures arrive as External Signal Hypotheses)."""
    qs = urllib.parse.urlencode({k_: v for k_, v in {"q": q[:200], "ticker": ticker[:10], "k": max(1, min(k, 25))}.items() if v})
    try:
        return _bridge_get(f"/signals?{qs}", timeout=6.0)
    except OFFLINE as e:
        raise _offline(e) from None


@router.post("/quiver/ingest")
def trading_quiver_ingest(request: Request):
    try:
        return _bridge_post("/quiver/ingest", {}, _actor(request), timeout=90.0)
    except OFFLINE as e:
        raise _offline(e) from None


@router.post("/kill-switch/reset")
async def trading_kill_reset(request: Request):
    body = await _json(request)
    try:
        return _bridge_post("/kill-switch/reset", body, _actor(request))
    except OFFLINE as e:
        raise _offline(e) from None


@router.post("/kill-switch")
async def trading_kill_switch(request: Request):
    """E-stop. Never depends on the bridge being alive to at least LOCK."""
    try:
        body = await _json(request)
    except HTTPException:
        body = {}
    dry = bool(body.get("dryRun"))
    reason = str(body.get("reason") or "manual kill switch")[:200]
    actor = _actor(request)
    try:
        return _bridge_post("/kill-switch", {"reason": reason, "dryRun": dry}, actor, timeout=45.0)
    except OFFLINE as e:
        if dry:
            raise _offline(e) from None
        return _gateway_failsafe_kill(reason, actor, e)


def _write_lock_failsafe(reason: str, actor: str, incident: str) -> dict:
    """Same file and format as trading/kill_switch.write_lock (not imported: its module
    names `config` / `audit` would shadow the gateway's own imports)."""
    d = Path(os.environ.get("TRADING_DATA_DIR") or BASE_DIR / "data" / "trading")
    d.mkdir(parents=True, exist_ok=True)
    p = d / "TRADING_LOCKED.json"
    if p.exists():
        try:
            existing = json.loads(p.read_text(encoding="utf-8"))
            if isinstance(existing, dict) and existing.get("incidentId"):
                return existing
        except (OSError, ValueError):
            pass
    data = {"locked": True, "at": time.time(), "reason": reason, "actor": actor, "incidentId": incident}
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    tmp.replace(p)
    return data


def _gateway_failsafe_kill(reason: str, actor: str, err: Exception) -> dict:
    incident = "gw-" + time.strftime("%Y%m%d-%H%M%S")
    lock = _write_lock_failsafe(f"{reason} (bridge unreachable)", actor, incident)
    spawned = False
    if VENV_PY.exists():
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        log = open(LOG_DIR / "kill-switch.log", "ab")  # noqa: SIM115
        subprocess.Popen(  # noqa: S603
            [str(VENV_PY), str(TRADING_DIR / "kill_switch.py"), "--reason", reason, "--actor", f"{actor}+gateway"],
            cwd=str(BASE_DIR), stdout=log, stderr=log, stdin=subprocess.DEVNULL,
            creationflags=(subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0),
        )
        spawned = True
    return {"ok": True, "failsafe": True, "lock": lock, "cancelFlattenStarted": spawned,
            "note": f"bridge unreachable ({type(err).__name__}); lock written by the gateway"}


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
