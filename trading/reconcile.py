"""Broker-vs-desk reconciliation for desk-cli and the overseer. Pure: no I/O, no clock reads.

Inputs are the plain dicts of `tws_adapter` (positions / working orders / executions) plus the
desk's `intents` rows; `now` is passed in. The result says, per position, whether it is
protected by a GTC stop (and take-profit), which working orders are entries vs protective legs,
and lists every drift between what the desk believes and what TWS holds.

Order roles (`classify_orders`):
  pending_child  child of a still-working parent (part of an unfilled entry bracket)
  stop           reduces a position, orderType in STOP_TYPES
  take_profit    reduces a position, LMT
  exit           reduces a position, any other type (MKT ...)
  entry          everything else: it would open or add exposure

Order ids are per TWS API client, so orders are identified by (clientId, orderId): a child's
parentId names a working order of the same client, and a desk intent's result orderIds only match
working orders that carry the intent's orderRef (or none). Two clients' orders sharing an id never
borrow each other's role.

Fail closed. A malformed order quantity counts as no coverage; a stop in PendingCancel is not
protection; a position whose size is not a finite number is reported as MALFORMED_DATA drift (and
its nakedSince timer carried over) instead of being dropped.

Options. Adapter positions carry `symbol` = localSymbol and `underlying` = the root, while desk
intents use the root symbol. An intents row may optionally carry `secType` (or `sec_type`, or a
desk.db `intent` JSON with `sec_type`); option intents (OPT/BAG) then track option positions by
underlying and are left out of the share-count comparison (contracts are not shares, and their
exits use `GUARD-` refs). Without it an intent is a stock intent (the contract's behaviour) and
accounts only for the stock position of its symbol, never an option on that underlying.
"""

from __future__ import annotations

import json
import math
from typing import Any

try:  # the canonical definitions live in the adapter; fall back so this module stays importable alone
    from tws_adapter import DONE, STOP_TYPES
except Exception:  # noqa: BLE001
    DONE = {"Filled", "Cancelled", "ApiCancelled", "Inactive"}
    STOP_TYPES = {"STP", "STP LMT", "TRAIL", "TRAIL LIMIT"}

KNOWN_REF_PREFIXES = ("KILL-", "GUARD-", "MSL-", "DMS-", "CLI-")
OPTION_SEC_TYPES = ("OPT", "BAG")
ACTIVE_STATUSES = ("submitted", "closed_stop")
EPS = 1e-6

UNPROTECTED = ("NAKED", "UNDERSIZED", "NOT_GTC")


# Working, but already on its way out: a stop in PendingCancel is not protection.
NOT_PROTECTIVE_STATUSES = ("PendingCancel",)


# ── small helpers ────────────────────────────────────────────────────
def _num(v: Any) -> float | None:
    """A finite float, or None for missing / non-numeric / NaN / inf (and bools)."""
    if isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _f(v: Any) -> float:
    """Lenient number: anything malformed reads as 0 (callers only use it where 0 fails closed)."""
    f = _num(v)
    return 0.0 if f is None else f


def _oid(v: Any) -> int | None:
    try:
        i = int(v)
    except (TypeError, ValueError):
        return None
    return i or None


def signed(qty: float, action: str) -> float:
    """BUY (or BOT) positive, SELL (or SLD) negative."""
    a = (action or "").upper()
    q = abs(_f(qty))
    if a in ("BUY", "BOT"):
        return q
    if a in ("SELL", "SLD"):
        return -q
    raise ValueError(f"unknown action {action!r}")


def _working(o: dict[str, Any]) -> bool:
    return (o.get("status") or "") not in DONE


def _key(o: dict[str, Any], id_field: str = "orderId") -> tuple[Any, int] | None:
    """TWS order ids are per API client: (clientId, orderId) identifies an order; a child's parentId
    names an order of the same client."""
    i = _oid(o.get(id_field))
    return None if i is None else (o.get("clientId"), i)


def _working_keys(orders: list[dict[str, Any]]) -> set[tuple[Any, int]]:
    return {k for k in (_key(o) for o in orders if _working(o)) if k is not None}


def _open_qty(o: dict[str, Any]) -> float:
    """Unfilled quantity of a working order (quantity - filled). `remaining` is not trusted alone:
    before TWS sends an orderStatus it reads 0, which would make a real stop look absent.
    Malformed quantities read as 0 (no coverage: fails closed)."""
    q = abs(_f(o.get("quantity")))
    filled = abs(_f(o.get("filled")))
    return max(q - filled, 0.0) if filled > 0 else q


def _covers(o: dict[str, Any]) -> bool:
    """A working order that can still protect (not already being cancelled)."""
    return _working(o) and (o.get("status") or "") not in NOT_PROTECTIVE_STATUSES


def _is_option(sec_type: Any) -> bool:
    return (sec_type or "STK") in OPTION_SEC_TYPES


def _result(intent: dict[str, Any]) -> dict[str, Any]:
    r = intent.get("result")
    if isinstance(r, str):
        try:
            r = json.loads(r)
        except ValueError:
            return {}
    return r if isinstance(r, dict) else {}


def _result_order_ids(intent: dict[str, Any]) -> list[int]:
    out = []
    for o in _result(intent).get("orders") or []:
        i = _oid(o.get("orderId")) if isinstance(o, dict) else _oid(o)
        if i is not None:
            out.append(i)
    return out


def _intent_sec_type(intent: dict[str, Any]) -> str:
    """secType / sec_type on the row, else `sec_type` inside the row's `intent` JSON (desk.db column), else STK."""
    st = intent.get("secType") or intent.get("sec_type")
    if not st:
        body = intent.get("intent")
        if isinstance(body, str):
            try:
                body = json.loads(body)
            except ValueError:
                body = None
        if isinstance(body, dict):
            st = body.get("sec_type") or body.get("secType")
    return str(st or "STK").upper()


def _parent_working(intent: dict[str, Any], orders: list[dict[str, Any]]) -> bool:
    """Is the intent's entry parent (result.orders[0]) still a working order? Matched by orderId and
    the desk's orderRef, so another client's order that happens to share the id does not count."""
    ids = _result_order_ids(intent)
    return bool(ids) and _intent_order_working(intent, orders, ids[:1])


def _intent_order_working(intent: dict[str, Any], orders: list[dict[str, Any]], ids: list[int]) -> bool:
    iid = intent.get("intentId")
    want = set(ids)
    return any(_working(o) and _oid(o.get("orderId")) in want and (o.get("orderRef") or "") in ("", iid) for o in orders)


def _known_ref(ref: str, intent_ids: set[str]) -> bool:
    return bool(ref) and (ref in intent_ids or ref.startswith(KNOWN_REF_PREFIXES))


def _net_by_con(positions: list[dict[str, Any]]) -> dict[Any, float]:
    out: dict[Any, float] = {}
    for p in positions:
        out[p.get("conId")] = out.get(p.get("conId"), 0.0) + _f(p.get("position"))
    return out


# ── order roles ──────────────────────────────────────────────────────
def _roles(positions: list[dict[str, Any]], orders: list[dict[str, Any]]) -> list[str]:
    """Role of each order, aligned with `orders` (per order, so two clients' orders that share an
    orderId never borrow each other's role)."""
    net = _net_by_con(positions)
    working = _working_keys(orders)
    working_any = {k[1] for k in working}
    out: list[str] = []
    for o in orders:
        me, parent = _key(o), _key(o, "parentId")
        # an order without a clientId cannot be scoped: any working order with its parentId counts
        pending = parent is not None and parent != me and (
            parent in working or (o.get("clientId") is None and parent[1] in working_any))
        if pending:
            out.append("pending_child")
            continue
        pos = net.get(o.get("conId"), 0.0)
        action = (o.get("action") or "").upper()
        if (pos > EPS and action == "SELL") or (pos < -EPS and action == "BUY"):
            typ = (o.get("orderType") or "").upper()
            out.append("stop" if typ in STOP_TYPES else "take_profit" if typ == "LMT" else "exit")
        else:
            out.append("entry")
    return out


def classify_orders(positions: list[dict[str, Any]], orders: list[dict[str, Any]]) -> dict[int, str]:
    """{orderId: role}. TWS order ids are per client, so two working orders can share an id. On such a
    collision the protective role wins (stop > take_profit > exit > pending_child > entry): a caller that
    cancels "entries" then never cancels a protective stop, and a liquidation that cancels "legs" first
    cancels too much rather than leaving a stop working. Use `order_roles` for exact per-order roles;
    bracket_status / reconcile use those."""
    rank = {"entry": 0, "pending_child": 1, "exit": 2, "take_profit": 3, "stop": 4}
    roles: dict[int, str] = {}
    for o, role in zip(orders, _roles(positions, orders)):
        oid = _oid(o.get("orderId"))
        if oid is None:
            continue
        if oid not in roles or rank[role] > rank[roles[oid]]:
            roles[oid] = role
    return roles


def order_roles(positions: list[dict[str, Any]], orders: list[dict[str, Any]]) -> list[str]:
    """Role of each order, aligned with `orders` (exact even when order ids collide across clients)."""
    return _roles(positions, orders)


def _leg(o: dict[str, Any], price_key: str) -> dict[str, Any]:
    other = "limitPrice" if price_key == "stopPrice" else "stopPrice"
    price = o.get(price_key)
    if price is None:
        price = o.get(other)
    return {"orderId": o.get("orderId"), "price": price, "qty": _open_qty(o), "tif": o.get("tif"), "clientId": o.get("clientId")}


def bracket_status(position: dict[str, Any], orders: list[dict[str, Any]], *, options_exempt: bool = True) -> dict[str, Any]:
    raw = _num(position.get("position"))
    size = abs(raw) if raw is not None else 0.0
    con = position.get("conId")
    pairs = [(o, r) for o, r in zip(orders, _roles([position], orders)) if o.get("conId") == con and _covers(o)]
    stops = [o for o, r in pairs if r == "stop"]
    tps = [o for o, r in pairs if r == "take_profit"]
    stop_qty = sum(_open_qty(o) for o in stops)
    tp_qty = sum(_open_qty(o) for o in tps)
    gtc_stop_qty = sum(_open_qty(o) for o in stops if (o.get("tif") or "").upper() == "GTC")
    gtc_tp_qty = sum(_open_qty(o) for o in tps if (o.get("tif") or "").upper() == "GTC")
    stop = _leg(max(stops, key=_open_qty), "stopPrice") if stops else None
    tp = _leg(max(tps, key=_open_qty), "limitPrice") if tps else None

    if raw is None:
        status = "NAKED"  # malformed position size: nothing can be proven to cover it (fail closed)
    elif stop_qty <= EPS:
        # Only LONG options: the desk's options guard premium-stops long lines; a short option with no stop is naked.
        status = ("DESK_GUARDED" if options_exempt and _is_option(position.get("secType")) and _f(position.get("position")) > 0
                  else "NAKED")
    elif stop_qty > size + EPS:
        status = "OVER_HEDGED"
    elif stop_qty < size - EPS:
        status = "UNDERSIZED"
    elif gtc_stop_qty < size - EPS:
        status = "NOT_GTC"
    elif gtc_tp_qty >= size - EPS:
        status = "PROTECTED"
    else:
        status = "STOP_ONLY"
    return {"status": status, "stop": stop, "takeProfit": tp, "stopQty": stop_qty, "tpQty": tp_qty}


# ── desk expectations ────────────────────────────────────────────────
def _contribution(intent: dict[str, Any], orders: list[dict[str, Any]], executions: list[dict[str, Any]] | None) -> float:
    iid = intent.get("intentId")
    status = intent.get("status")
    decided = signed(intent.get("quantity"), intent.get("action") or "")
    ids = _result_order_ids(intent)
    parent = ids[0] if ids else None
    parent_working = _parent_working(intent, orders)
    mine = [e for e in executions if iid and e.get("orderRef") == iid] if executions is not None else []
    if mine:
        net = sum(signed(e.get("shares"), e.get("side") or "") for e in mine)
        # TWS reports executions for the current day only. When none of today's fills for this ref is the
        # entry (the parent's orderId, or a fill on the entry side: the bracket's children all trade the
        # other way), e.g. yesterday's entry and today's stop fill, the entry is assumed filled earlier.
        entry_today = any((parent is not None and _oid(e.get("orderId")) == parent)
                          or signed(1, e.get("side") or "") * decided > 0 for e in mine)
        if status == "submitted" and not parent_working and not entry_today:
            net += decided
        return net
    if parent_working:
        return 0.0
    if status == "submitted":
        return decided
    return 0.0


def expected_positions(intents: list[dict[str, Any]], orders: list[dict[str, Any]],
                       executions: list[dict[str, Any]] | None) -> dict[str, float]:
    out: dict[str, float] = {}
    for it in intents:
        if it.get("status") not in ACTIVE_STATUSES:
            continue
        sym = it.get("symbol") or ""
        out[sym] = out.get(sym, 0.0) + _contribution(it, orders, executions)
    return out


def _tracks(intent: dict[str, Any], position: dict[str, Any]) -> bool:
    """Does this desk intent account for this broker position (by symbol, options by underlying)?"""
    sym = intent.get("symbol") or ""
    if not sym:
        return False
    if _is_option(_intent_sec_type(intent)):
        # option intents (OPT / BAG) account for option positions on their underlying
        return _is_option(position.get("secType")) and sym in (position.get("symbol"), position.get("underlying"))
    # a stock intent accounts only for the stock position of its symbol, never an option on it
    return not _is_option(position.get("secType")) and sym == position.get("symbol")


# ── reconcile ────────────────────────────────────────────────────────
def reconcile(*, positions: list[dict[str, Any]], orders: list[dict[str, Any]], executions: list[dict[str, Any]] | None,
              intents: list[dict[str, Any]], now: float, naked_since: dict[str, float] | None = None,
              options_exempt: bool = True) -> dict[str, Any]:
    naked_since = dict(naked_since or {})
    drift: list[dict[str, Any]] = []

    def add(code: str, symbol: Any, ref: Any, detail: str, severity: str = "drift") -> None:
        drift.append({"code": code, "severity": severity, "symbol": symbol, "ref": ref, "detail": detail})

    # A position whose size is not a finite number is never silently dropped: it is drift, and the
    # unprotected timer of its conId is carried over unchanged (a bad read must not reset it).
    carried: dict[str, float] = {}
    clean = []
    for p in positions or []:
        if _num(p.get("position")) is None:
            key = str(p.get("conId"))
            add("MALFORMED_DATA", p.get("symbol"), key, f"position for {p.get('symbol')} (conId {key}) has a non-numeric size "
                f"{p.get('position')!r}: its protection cannot be checked")
            if key in naked_since:
                carried[key] = naked_since[key]
            continue
        if abs(_f(p.get("position"))) > EPS:
            clean.append(p)
    positions = clean
    orders = [o for o in orders or [] if _working(o)]
    intents = list(intents or [])

    intent_ids = {str(i["intentId"]) for i in intents if i.get("intentId")}
    active = [i for i in intents if i.get("status") in ACTIVE_STATUSES]
    roles = _roles(positions, orders)

    # Orders
    out_orders = []
    for o, role in zip(orders, roles):
        ref = o.get("orderRef") or ""
        known = _known_ref(ref, intent_ids)
        out_orders.append({**o, "role": role, "known": known})
        if not known:
            add("PHANTOM_ORDER", o.get("symbol"), ref,
                f"order #{o.get('orderId')} {o.get('action')} {o.get('quantity')} {o.get('orderType')} client {o.get('clientId')} "
                f"has {'no orderRef' if not ref else 'an unknown orderRef'} (manual TWS order or foreign client)")

    # Positions + brackets
    out_positions = []
    new_naked: dict[str, float] = dict(carried)
    stock_active = [i for i in active if not _is_option(_intent_sec_type(i))]
    expected_stock = expected_positions(stock_active, orders, executions)
    for p in positions:
        key = str(p.get("conId"))
        b = bracket_status(p, orders, options_exempt=options_exempt)
        tracking = [i for i in active if _tracks(i, p)]
        since = None
        if b["status"] in UNPROTECTED:
            prev = naked_since.get(key)
            if prev is None:
                since = now
            else:
                # earliest wins; a persisted value that is not a finite number reads as 0 (the epoch), so a
                # corrupt state file can only make the position look unprotected for longer, never reset it
                since = min(_f(prev), now)
            new_naked[key] = since
        sym = p.get("symbol")
        out_positions.append({"symbol": sym, "conId": p.get("conId"), "secType": p.get("secType"), "position": _f(p.get("position")),
                              "avgCost": p.get("avgCost"), "bracket": b,
                              "intents": [i.get("intentId") for i in tracking],
                              "expectedQty": expected_stock.get(sym) if not _is_option(p.get("secType")) and sym in expected_stock else None,
                              "nakedSince": since, "nakedForS": (now - since) if since is not None else None})
        if not tracking:
            add("UNTRACKED_POSITION", sym, key, f"{p.get('secType') or 'STK'} position {_f(p.get('position')):g} {sym} (conId {key}) "
                f"has no submitted/closed_stop desk intent")
        st = b["status"]
        if st in UNPROTECTED:
            why = {"NAKED": "no protective stop",
                   "UNDERSIZED": f"stop covers {b['stopQty']:g} of {abs(_f(p.get('position'))):g}",
                   "NOT_GTC": "a covering stop is not GTC (expires at the close)"}[st]
            add("NAKED_POSITION", sym, key, f"{st}: {why}; unprotected for {now - since:.0f}s")
        elif st == "OVER_HEDGED":
            add("OVER_HEDGED", sym, key, f"stop qty {b['stopQty']:g} > position {abs(_f(p.get('position'))):g}: a fill would flip the position")
        elif st == "STOP_ONLY":
            add("MISSING_TAKE_PROFIT", sym, key, f"stop OK but GTC take-profit covers {b['tpQty']:g} of {abs(_f(p.get('position'))):g}",
                severity="warn")

    # Quantity drift (stock intents; option intents are guarded by the desk's options guard)
    for sym, exp in expected_stock.items():
        held = sum(_f(p.get("position")) for p in positions
                   if p.get("symbol") == sym and not _is_option(p.get("secType")))
        if abs(held - exp) > EPS:
            add("QTY_MISMATCH", sym, ",".join(str(i.get("intentId")) for i in stock_active if i.get("symbol") == sym),
                f"broker holds {held:g} {sym}, desk intents expect {exp:g}")

    # Orphan intents
    for it in active:
        if it.get("status") != "submitted":
            continue
        iid = it.get("intentId")
        if _intent_order_working(it, orders, _result_order_ids(it)):
            continue
        if executions is not None and any(e.get("orderRef") == iid for e in executions):
            continue
        if any(_tracks(it, p) for p in positions):
            continue
        add("ORPHAN_INTENT", it.get("symbol"), iid,
            f"intent {iid} is submitted but has no working order, {'no execution, ' if executions is not None else ''}and no position")

    # Executions
    if executions is None:
        add("EXECUTIONS_UNAVAILABLE", None, None, "TWS executions unavailable: fills could not be checked", severity="warn")
    else:
        for e in executions:
            ref = e.get("orderRef") or ""
            if not _known_ref(ref, intent_ids):
                add("UNLOGGED_FILL", e.get("symbol"), ref,
                    f"execution {e.get('execId')} {e.get('side')} {e.get('shares')} {e.get('symbol')} @ {e.get('price')} "
                    f"(order #{e.get('orderId')}, client {e.get('clientId')}) has {'no orderRef' if not ref else 'an unknown orderRef'}")

    n_drift = sum(1 for d in drift if d["severity"] == "drift")
    n_warn = sum(1 for d in drift if d["severity"] == "warn")
    return {"ok": n_drift == 0, "at": now, "positions": out_positions, "orders": out_orders, "drift": drift,
            "nakedSince": new_naked,
            "counts": {"positions": len(out_positions), "orders": len(out_orders), "drift": n_drift, "warn": n_warn}}
