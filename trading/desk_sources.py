"""Read-only data sources shared by desk-cli and the overseer.

  * bridge HTTP (127.0.0.1:<TRADING_BRIDGE_PORT>/status, /health) — the GUI's telemetry, no new TWS session;
  * desk.db intents, opened with SQLite `mode=ro` (never written here);
  * audit.db order failures (rejection-storm breaker), `mode=ro`;
  * risk_limits.json (daily loss cap, concurrent positions) via intents.load_limits;
  * a read-only TWS adapter (client 22 / 20) for what the bridge snapshot lacks:
    executions and parentId.

`gather()` returns one broker view {positions, orders, executions, source, errors}; executions is
None when TWS executions could not be read (reconcile then warns instead of flagging fills).
"""

from __future__ import annotations

import asyncio
import json
import os
import sqlite3
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable

BRIDGE_STALE_S = 10.0


def bridge_port() -> int:
    try:
        return int(os.environ.get("TRADING_BRIDGE_PORT", "8091"))
    except ValueError:
        return 8091


def http_get(path: str, timeout: float = 3.0) -> dict[str, Any]:
    url = f"http://127.0.0.1:{bridge_port()}{path}"
    with urllib.request.urlopen(url, timeout=timeout) as r:  # noqa: S310 — fixed loopback URL
        return json.loads(r.read().decode("utf-8"))


BridgeGet = Callable[[str], dict]


def bridge_cancel_http(actor: str) -> Callable[[list[int], str], dict]:
    """safety_actions.cancel_orders' `bridge_cancel`: ask the live bridge to cancel its executor's (13) orders."""
    def cancel(order_ids: list[int], reason: str) -> dict[str, Any]:
        url = f"http://127.0.0.1:{bridge_port()}/orders/cancel"
        req = urllib.request.Request(url, data=json.dumps({"orderIds": [int(i) for i in order_ids], "reason": reason[:200] or actor}).encode(),
                                     method="POST", headers={"Content-Type": "application/json", "x-trading-actor": actor})
        with urllib.request.urlopen(req, timeout=20) as r:  # noqa: S310 — fixed loopback URL
            return json.loads(r.read().decode("utf-8"))

    return cancel


def bridge_snapshot(get: BridgeGet, now: float) -> tuple[dict[str, Any] | None, str | None]:
    """(snapshot with an added `ageS`, error). A reachable bridge whose loop stopped updating is reported stale."""
    try:
        snap = get("/status")
    except (urllib.error.URLError, OSError, ValueError, TimeoutError) as e:
        return None, f"bridge unreachable ({type(e).__name__})"
    if not isinstance(snap, dict):
        return None, "bridge returned a non-object"
    snap = dict(snap)
    snap["ageS"] = max(0.0, now - float(snap.get("updatedAt") or 0))
    return snap, None


def bridge_alive(get: BridgeGet, now: float) -> dict[str, Any]:
    """Heartbeat: /health answers AND the snapshot is fresh. Returns {ok, state, ageS, detail}."""
    try:
        h = get("/health")
    except (urllib.error.URLError, OSError, ValueError, TimeoutError) as e:
        return {"ok": False, "state": "UNREACHABLE", "ageS": None, "detail": type(e).__name__}
    snap, err = bridge_snapshot(get, now)
    if snap is None:
        return {"ok": False, "state": "NO_SNAPSHOT", "ageS": None, "detail": err}
    fresh = snap["ageS"] <= BRIDGE_STALE_S
    return {"ok": bool(h.get("ok")) and fresh, "state": snap.get("state"), "ageS": round(snap["ageS"], 1),
            "detail": "" if fresh else f"snapshot {snap['ageS']:.0f}s old (bridge loop frozen?)"}


def _ro(path: Path) -> sqlite3.Connection:
    return sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True, timeout=5)


def desk_intents(d: Path, statuses: tuple[str, ...] = ("submitted", "closed_stop", "submitting", "closed")) -> list[dict[str, Any]]:
    p = Path(d) / "desk.db"
    if not p.exists():
        return []
    c = _ro(p)
    try:
        rows = c.execute(f"SELECT intent_id, status, symbol, action, quantity, result, updated, intent FROM intents "
                         f"WHERE status IN ({','.join('?' * len(statuses))})", statuses).fetchall()
    finally:
        c.close()  # a sqlite error propagates: callers must not mistake "unreadable" for "no intents"
    out = []
    for r in rows:
        try:
            res = json.loads(r[5]) if r[5] else None
        except ValueError:
            res = None
        try:
            body = json.loads(r[7]) if r[7] else {}
        except ValueError:
            body = {}
        out.append({"intentId": r[0], "status": r[1], "symbol": r[2], "action": r[3], "quantity": r[4], "result": res, "updated": r[6],
                    "secType": (body or {}).get("sec_type") or "STK"})
    return out


def known_refs(d: Path) -> set[str]:
    """Every intent id the desk ever stored (any status), so a fill of a rejected/failed intent isn't 'unlogged'."""
    p = Path(d) / "desk.db"
    if not p.exists():
        return set()
    c = _ro(p)
    try:
        return {r[0] for r in c.execute("SELECT intent_id FROM intents")}
    except sqlite3.Error:
        return set()
    finally:
        c.close()


def audit_failures_since(d: Path, since: float) -> int:
    p = Path(d) / "audit.db"
    if not p.exists():
        return 0
    c = _ro(p)
    try:
        return int(c.execute("SELECT COUNT(*) FROM audit WHERE ts >= ? AND (kind = 'order_failed' OR verdict IN ('FAILED','LOCKED_WITH_ERRORS'))",
                             (since,)).fetchone()[0])
    except sqlite3.Error:
        return 0
    finally:
        c.close()


def risk_limits(d: Path) -> dict[str, Any]:
    """risk_limits.json as a dict; raises on a corrupt file (callers fail closed). Never creates the file."""
    p = Path(d) / "risk_limits.json"
    from intents import RiskLimits

    if not p.exists():
        return RiskLimits().to_dict()
    from intents import load_limits

    return load_limits(p).to_dict()


def read_json(p: Path) -> dict[str, Any] | None:
    try:
        v = json.loads(Path(p).read_text(encoding="utf-8"))
        return v if isinstance(v, dict) else None
    except (OSError, ValueError):
        return None


def write_json(p: Path, data: dict[str, Any]) -> None:
    p = Path(p)
    tmp = p.with_name(p.name + f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(data, indent=2, default=str), encoding="utf-8")
    tmp.replace(p)


def _bridge_positions(snap: dict[str, Any]) -> list[dict[str, Any]]:
    return [{"account": (snap.get("account") or {}).get("account"), "conId": p.get("conId"), "symbol": p.get("symbol"),
             "underlying": p.get("underlying"), "secType": p.get("secType"), "currency": p.get("currency"),
             "position": p.get("position"), "avgCost": p.get("avgCost"), "marketPrice": p.get("marketPrice"),
             "unrealizedPnl": p.get("unrealizedPnl")} for p in snap.get("positions") or [] if p.get("position")]


def _bridge_orders(snap: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for o in snap.get("openOrders") or []:
        out.append({**{k: o.get(k) for k in ("orderId", "permId", "clientId", "conId", "symbol", "underlying", "secType", "currency",
                                              "action", "quantity", "orderType", "limitPrice", "stopPrice", "tif", "status",
                                              "filled", "remaining", "orderRef")},
                    "parentId": o.get("parentId", 0), "ocaGroup": o.get("ocaGroup", "")})
    return out


async def gather(*, adapter: Any | None, snap: dict[str, Any] | None, timeout: float = 20.0) -> dict[str, Any]:
    """Broker truth. Prefer the read-only adapter (has executions + parentId); fall back to the bridge snapshot."""
    errors: list[str] = []
    if adapter is not None:
        try:
            async def _read():
                pos = await adapter.positions()
                orders = await adapter.open_orders()
                try:
                    ex = await adapter.executions()
                except Exception as e:  # noqa: BLE001
                    errors.append(f"executions: {type(e).__name__}: {e}")
                    ex = None
                return pos, orders, ex

            pos, orders, ex = await asyncio.wait_for(_read(), timeout)
            if snap:  # enrich with the bridge's portfolio marks (TWS positions carry no market price)
                marks = {p.get("conId"): p for p in snap.get("positions") or []}
                for p in pos:
                    m = marks.get(p["conId"]) or {}
                    p.setdefault("marketPrice", m.get("marketPrice"))
                    p.setdefault("unrealizedPnl", m.get("unrealizedPnl"))
            return {"positions": pos, "orders": orders, "executions": ex, "source": f"tws:client{getattr(adapter, 'client_id', '?')}",
                    "errors": errors}
        except Exception as e:  # noqa: BLE001 — fall back to the bridge
            errors.append(f"tws read-only client: {type(e).__name__}: {e}")
    if snap and snap.get("state") == "CONNECTED":
        return {"positions": _bridge_positions(snap), "orders": _bridge_orders(snap), "executions": None, "source": "bridge",
                "errors": errors}
    errors.append("no broker source: bridge not CONNECTED and TWS read-only client unavailable")
    return {"positions": None, "orders": None, "executions": None, "source": None, "errors": errors}


def now() -> float:
    return time.time()
