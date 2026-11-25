"""Gateway side of the IBKR paper-trading module: /api/trading/*.

The broker connection does NOT live in this process. `trading/ibkr_bridge.py`
runs in its own venv (ib_async) bound to 127.0.0.1:<TRADING_BRIDGE_PORT>, so a
gateway crash or restart never drops the TWS session, and this file only
proxies its loopback HTTP surface. Auth is whatever server.py's
ZeroTrustMiddleware already enforces for /api (loopback trusted, mesh needs the
gateway token).

Routes: status, desk view, intents (+approve/reject), mode, comms, chart bars, and the
kill switch. The kill switch is fail-safe: if the bridge can't be reached the
gateway writes the persistent lock itself (stdlib only, no ib_async) and then
starts `trading/kill_switch.py` in the trading venv to cancel and flatten.
"""

from __future__ import annotations

import asyncio
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
        "fills": [],
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
        return await asyncio.to_thread(_bridge_post, "/intents", body, _actor(request), timeout=30.0)
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
        return await asyncio.to_thread(_bridge_post, "/mode", body, _actor(request))
    except OFFLINE as e:
        raise _offline(e) from None


@router.post("/comms")
async def trading_comms(request: Request):
    body = await _json(request)
    try:
        return await asyncio.to_thread(_bridge_post, "/comms", body, _actor(request))
    except OFFLINE as e:
        raise _offline(e) from None


@router.get("/signals")
def trading_signals(q: str = "", ticker: str = "", k: int = 8):
    """trading_rag context for the Trading Agent (Quantgress disclosures arrive as External Signal Hypotheses)."""
    qs = urllib.parse.urlencode({k_: v for k_, v in {"q": q[:200], "ticker": ticker[:10], "k": max(1, min(k, 25))}.items() if v})
    try:
        return _bridge_get(f"/signals?{qs}", timeout=6.0)
    except OFFLINE as e:
        raise _offline(e) from None


@router.post("/signals/ingest")
def trading_signals_ingest(request: Request):
    try:
        return _bridge_post("/signals/ingest", {}, _actor(request), timeout=90.0)
    except OFFLINE as e:
        raise _offline(e) from None


ENGINE_POSTS = {"a/scan", "a/watchlist", "a/auto", "b/propose", "b/guard"}
INTEL_POSTS = {"discord/import", "discord/ingest", "discord/poll", "outcomes/score", "journal/pass"}
INTEL_GETS = {"", "discord/search", "leaderboards", "journal"}


@router.get("/intel")
@router.get("/intel/{path:path}")
def trading_intel_get(request: Request, path: str = ""):
    if path not in INTEL_GETS:
        raise HTTPException(404, "unknown intel view")
    qs = urllib.parse.urlencode([(k, v) for k, v in request.query_params.items() if k in ("q", "ticker", "limit", "horizon")])
    try:
        return _bridge_get(f"/intel{'/' + path if path else ''}{'?' + qs if qs else ''}", timeout=10.0)
    except OFFLINE as e:
        raise _offline(e) from None


@router.post("/intel/{path:path}")
async def trading_intel_post(path: str, request: Request):
    """Discord import / relay ingest / poll, outcome scoring, journal pass. Read-only for the broker."""
    if path not in INTEL_POSTS:
        raise HTTPException(404, "unknown intel action")
    body = await _json(request)
    try:
        return await asyncio.to_thread(_bridge_post, f"/intel/{path}", body, _actor(request), timeout=300.0)
    except OFFLINE as e:
        raise _offline(e) from None


@router.get("/engines")
def trading_engines():
    try:
        return _bridge_get("/engines", timeout=6.0)
    except OFFLINE as e:
        raise _offline(e) from None


@router.get("/bars")
def trading_bars(symbol: str = "SPY", interval: str = "5m", range: str = "5d"):  # noqa: A002 — the UI's query name
    """IBKR historical bars for the Trading view's "IBKR bars" chart (read-only, market-data client).
    Yahoo-style inputs; the bridge maps them (trading/bars.py) and caches to stay inside IBKR pacing.
    A bridge refusal (unsupported symbol, no permissions, pacing) comes back as 200 {ok: false, error}
    so the chart can show the reason; only an unreachable bridge is a 503."""
    qs = urllib.parse.urlencode({"symbol": symbol[:16], "interval": interval[:4], "range": range[:4]})
    try:
        return _bridge_get(f"/bars?{qs}", timeout=65.0)
    except urllib.error.HTTPError as e:  # the bridge answered: pass its reason through
        detail = e.read().decode("utf-8", "replace")
        try:
            detail = json.loads(detail).get("detail", detail)
        except ValueError:
            pass
        if e.code == 404 and detail == "Not Found":
            detail = "the running trading bridge has no /bars route yet; restart it to load the IBKR bars feed"
        return {"ok": False, "error": str(detail)[:400], "status": e.code, "symbol": symbol, "interval": interval, "range": range, "candles": []}
    except OFFLINE as e:
        raise _offline(e) from None


@router.post("/engines/{path:path}")
async def trading_engine_post(path: str, request: Request):
    """Engine A scan / watchlist / auto-scan, Engine B propose / guard. Engines only ever SUBMIT
    intents to the desk; the Security Detail and the execution mode decide what happens next."""
    allowed = path in ENGINE_POSTS or (path.startswith("a/watchlist/") and path.endswith("/remove") and path.count("/") == 3)
    if not allowed:
        raise HTTPException(404, "unknown engine action")
    body = await _json(request)
    try:
        # Scans quote many symbols and option chains: give them time.
        return await asyncio.to_thread(_bridge_post, f"/engines/{path}", body, _actor(request), timeout=120.0)
    except OFFLINE as e:
        raise _offline(e) from None


@router.get("/health/last")
def trading_health_last():
    try:
        return _bridge_get("/health/last", timeout=6.0)
    except OFFLINE as e:
        raise _offline(e) from None


@router.post("/health/check")
async def trading_health_check(request: Request):
    """Read-only pipeline health check. If the bridge itself is down, say so as a FAIL result."""
    body = await _json(request)
    try:
        return await asyncio.to_thread(_bridge_post, "/health/check", body, _actor(request), timeout=240.0)
    except OFFLINE as e:
        now = time.time()
        return {"at": now, "atNy": time.strftime("%Y-%m-%d %H:%M", time.localtime(now)), "overall": "FAIL",
                "counts": {"PASS": 0, "WARN": 0, "FAIL": 1, "SKIP": 0},
                "checks": [{"stage": "runtime", "name": "bridge_process", "status": "FAIL", "ms": 0,
                            "detail": f"trading bridge not reachable on 127.0.0.1:{_bridge_port()} ({type(e).__name__}) - restart the gateway or run trading/ibkr_bridge.py"}]}


# ── Trading Agent (Phase 5) ──────────────────────────────────────────────────
# The agent runs in the bridge; its model call happens HERE, because the gateway is where the
# desktop's GPU baton is visible (command_center_api.gpu_busy). It never preempts Tony: wait up
# to `waitS` for the desktop to release the GPU, otherwise report "skipped" and let the agent
# try again at its next slot. It never JIT-loads a model next to Tony's either.
AGENT_PROMPT_MAX = 40_000
AGENT_SYSTEM_MAX = 8_000


def _agent_model() -> str:
    return (os.environ.get("TRADING_AGENT_MODEL") or "qwen/qwen3.5-9b").strip()


@router.get("/agent/model")
def trading_agent_model(request: Request):
    import command_center_api as cca

    cca.require_loopback(request)
    want = _agent_model()
    try:
        loaded = [m["id"] for m in cca.llm_loaded_models()]
    except Exception as e:  # noqa: BLE001
        return {"model": want, "loaded": False, "reachable": False, "error": str(e)[:200]}
    return {"model": want, "loaded": want in loaded, "reachable": True, "loadedModels": loaded, "gpu": cca.gpu_state()}


@router.post("/agent/think")
async def trading_agent_think(request: Request):
    import asyncio

    import command_center_api as cca

    cca.require_loopback(request)
    body = await _json(request)
    system, prompt = str(body.get("system") or ""), str(body.get("prompt") or "")
    if not system or not prompt:
        raise HTTPException(400, "system and prompt are required")
    if len(system) > AGENT_SYSTEM_MAX or len(prompt) > AGENT_PROMPT_MAX:
        raise HTTPException(413, f"system <= {AGENT_SYSTEM_MAX} and prompt <= {AGENT_PROMPT_MAX} characters")
    max_tokens = max(256, min(int(body.get("maxTokens") or 3000), 6000))
    wait_s = max(0.0, min(float(body.get("waitS") or 90), 180))
    model = _agent_model()
    try:
        loaded = [m["id"] for m in cca.llm_loaded_models()]
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "skipped": "model_unreachable", "detail": str(e)[:200], "model": model}
    if model not in loaded:
        return {"ok": False, "skipped": "model_not_loaded", "detail": f"{model} is not loaded in LM Studio (loaded: {loaded})", "model": model}
    t_wait = time.time()
    free = await asyncio.to_thread(cca.wait_gpu, wait_s)
    waited = time.time() - t_wait
    if not free:
        return {"ok": False, "skipped": "gpu_busy", "detail": f"the desktop held the GPU for {waited:.0f}s ({cca.gpu_state().get('holder')})",
                "model": model, "waitedS": round(waited, 1)}
    msgs = [{"role": "system", "content": system}, {"role": "user", "content": prompt}]
    # qwen3.5 is a thinking model and ignores /no_think, enable_thinking and reasoning_effort: left alone
    # it spends the whole token budget on hidden reasoning and returns empty content (~80 s per try).
    # Pre-filling an empty think block makes it answer directly (measured: 0 reasoning tokens, ~1 s on
    # a short prompt). The JSON's "thesis" fields still carry its explicit reasoning.
    thinking = bool(body.get("thinking"))
    prefill = [] if thinking else [{"role": "assistant", "content": "<think>\n\n</think>\n\n"}]
    t0 = time.time()
    try:
        out = await asyncio.to_thread(cca.llm_chat, msgs + prefill, model=model, max_tokens=max_tokens, temperature=0.2, gpu_wait=0)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "skipped": "model_error", "detail": str(e)[:300], "model": model}
    j = cca.extract_json(out)
    retried = False
    if j is None and not cca.gpu_busy():
        retried = True
        try:
            out2 = await asyncio.to_thread(cca.llm_chat, msgs + [{"role": "assistant", "content": out[-4000:]},
                                                                 {"role": "user", "content": "Return ONLY the JSON object, nothing else."}] + prefill,
                                           model=model, max_tokens=max_tokens, temperature=0.1, gpu_wait=0)
            j = cca.extract_json(out2)
            out = out2 if j is not None else out
        except Exception:  # noqa: BLE001
            j = None
    return {"ok": j is not None, "json": j, "model": model, "seconds": round(time.time() - t0, 1), "waitedS": round(waited, 1),
            "rawChars": len(out), "retried": retried, "raw": None if j is not None else out[-3000:]}


@router.get("/agent")
def trading_agent_view():
    try:
        return _bridge_get("/agent", timeout=8.0)
    except OFFLINE as e:
        raise _offline(e) from None


@router.post("/agent/{verb}")
async def trading_agent_post(verb: str, request: Request):
    if verb not in ("run", "enable"):
        raise HTTPException(404, "unknown agent action")
    body = await _json(request)
    try:
        # A run includes one local-model call (can wait for the GPU first): allow minutes.
        return await asyncio.to_thread(_bridge_post, f"/agent/{verb}", body, _actor(request), timeout=600.0)
    except OFFLINE as e:
        raise _offline(e) from None


@router.post("/kill-switch/reset")
async def trading_kill_reset(request: Request):
    body = await _json(request)
    try:
        return await asyncio.to_thread(_bridge_post, "/kill-switch/reset", body, _actor(request))
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
    if not dry:
        _security_audit_kill(reason, actor)
    try:
        return await asyncio.to_thread(_bridge_post, "/kill-switch", {"reason": reason, "dryRun": dry}, actor, timeout=45.0)
    except OFFLINE as e:
        if dry:
            raise _offline(e) from None
        return _gateway_failsafe_kill(reason, actor, e)


def _security_audit_kill(reason: str, actor: str) -> None:
    """CRITICAL entry in security_audit.jsonl + SMS, off the E-stop's path (never delays or fails it)."""
    def run():
        try:
            import security_api  # noqa: PLC0415 — server.py imports it first; lazy to avoid a cycle
            security_api.audit("trading_kill_switch", "critical", "success", "trading", f"gateway:{actor}", {"reason": reason})
        except Exception as e:  # noqa: BLE001
            print(f"[security] trading kill-switch audit failed: {type(e).__name__}")
    import threading  # noqa: PLC0415
    threading.Thread(target=run, daemon=True).start()


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
