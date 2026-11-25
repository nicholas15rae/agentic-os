"""Broker-side fail-safe actions for the overseer and desk-cli: cancel by ownership, selective
liquidation, emergency stops, cancel-entries and flatten-all. Async, over `tws_adapter`-shaped
adapters (`IbAdapter` in production, `tests/fake_tws.FakeTws` in tests). Plain dicts in and out.

Ownership. TWS only lets the client id that placed an API order cancel it. `cancel_orders` routes
each order to its owner:
  * the acting client's own orders              → `act.cancel_order`
  * the bridge executor's (13) while it is alive → refused (OWNER_IS_BRIDGE): never steal its id
  * read-only workers (11, 12) / manual (0)      → refused (OWNER_NEVER_BORROWED)
  * an order without a usable orderId            → refused (NO_ORDER_ID): it can't be addressed
  * any other id                                 → borrowed: `adapter_factory(owner, False)`, connect
                                                   (refused → OWNER_BUSY), cancel, disconnect

Order identity. TWS order ids are per client, so an order is identified by (clientId, orderId):
two clients' orders that share an id are two orders, never one.

Every cancellation is confirmed twice: `order_status` must report the order done (polled until
`wait_s` passes), and a fresh `act.open_orders()` must no longer list it. An order that fails
either check is reported unconfirmed, never assumed gone.

Liquidation never sells while an order that could reduce the position may still be resting (a
stop, take-profit or exit, and also the exit-side children of a still-working entry bracket):
one filling next to the market sell would flip the position. The sell is sized from a fresh
broker read and checked against it again once filled. Every function writes one ledger line.
A read-only adapter as `act` is refused up front (ReadOnlyAdapter propagates).
"""

from __future__ import annotations

import asyncio
import inspect
import math
import time
from typing import Any, Awaitable, Callable

from reconcile import bracket_status, classify_orders, order_roles  # noqa: F401  (re-exported for callers)
from tws_adapter import DONE, STOP_TYPES, ReadOnlyAdapter

BRIDGE_OWNED_IDS = frozenset({13})   # the bridge's executor; never borrowed while the bridge is alive
NEVER_BORROW = frozenset({11, 12})   # read-only workers never own orders
PROTECTIVE_ROLES = ("stop", "take_profit", "exit")
ENTRY_ROLES = ("entry", "pending_child")
OPTION_SEC_TYPES = ("OPT", "BAG")
ACCEPTED = ("PreSubmitted", "Submitted")   # an order TWS has accepted and is working
NOT_COVERING = ("PendingCancel",)          # working, but already on its way out: not protection
POLL_S = 0.25
EPS = 1e-9

Sleep = Callable[[float], Awaitable[Any]]
Clock = Callable[[], float]


class ActionError(RuntimeError):
    pass


class CancelBlocked(ActionError):
    pass


# ── helpers ──────────────────────────────────────────────────────────
def _f(v: Any) -> float | None:
    """A finite float, or None (missing / non-numeric / NaN / inf / bool)."""
    if isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _oid(v: Any) -> int | None:
    if isinstance(v, bool):
        return None
    try:
        i = int(v)
    except (TypeError, ValueError):
        return None
    return i or None


def _con(v: Any) -> int | None:
    """A usable conId (positive int; a numeric string is accepted), else None."""
    i = _oid(v)
    return i if i is not None and i > 0 else None


def _cid(o: dict[str, Any]) -> int:
    return _oid(o.get("clientId")) or 0


def _key(o: dict[str, Any]) -> tuple[int, int] | None:
    """(clientId, orderId): TWS order ids are per client."""
    oid = _oid(o.get("orderId"))
    return None if oid is None else (_cid(o), oid)


def _working(o: dict[str, Any]) -> bool:
    return (o.get("status") or "") not in DONE


def _open_qty(o: dict[str, Any]) -> float:
    q = abs(_f(o.get("quantity")) or 0.0)
    filled = abs(_f(o.get("filled")) or 0.0)
    return max(q - filled, 0.0)


def _err(e: BaseException) -> str:
    return f"{type(e).__name__}: {e}"


def _require_rw(act: Any) -> None:
    if getattr(act, "readonly", True):
        raise ReadOnlyAdapter(f"client {getattr(act, 'client_id', '?')} is read-only; refusing to touch orders")


def _log(ledger: Any, kind: str, payload: dict[str, Any], *, ref: str, verdict: str, actor: str) -> None:
    if ledger is not None:
        ledger.append(kind, payload, ref=ref, verdict=verdict, actor=actor)


async def _disconnect(adapter: Any) -> None:
    try:
        r = adapter.disconnect()
        if inspect.isawaitable(r):
            await r
    except Exception:  # noqa: BLE001
        pass


def _side(q: float | None) -> str | None:
    """The action that reduces a position of signed size q (None when flat / unknown)."""
    if q is None:
        return None
    if q > EPS:
        return "SELL"
    if q < -EPS:
        return "BUY"
    return None


def _exit_action(position: dict[str, Any]) -> str:
    s = _side(_f(position.get("position")))
    if s is None:
        raise ActionError(f"no position to reduce in {position.get('symbol')} (conId {position.get('conId')})")
    return s


def _net_con(positions: list[dict[str, Any]], con: int) -> tuple[float, bool]:
    """Net signed size of conId `con` across rows (several accounts), and whether a row for it had a
    size that is not a finite number (then nothing about the position can be trusted)."""
    net, bad = 0.0, False
    for p in positions or []:
        if not isinstance(p, dict) or _con(p.get("conId")) != con:
            continue
        q = _f(p.get("position"))
        if q is None:
            bad = True
        else:
            net += q
    return net, bad


def reduce_only(position: dict[str, Any], action: str, qty: float) -> None:
    """Raise ActionError unless `action` reduces `position` and 0 < qty <= |position|."""
    pos = _f(position.get("position"))
    q = _f(qty)
    act = (action or "").upper() if isinstance(action, str) else ""
    if pos is None or abs(pos) <= EPS:
        raise ActionError(f"reduce-only: no open position in {position.get('symbol')} (conId {position.get('conId')})")
    want = "SELL" if pos > 0 else "BUY"
    if act != want:
        raise ActionError(f"reduce-only: {act or '?'} would add to a {'long' if pos > 0 else 'short'} {pos:g} "
                          f"{position.get('symbol')}; only {want} reduces it")
    if q is None or q <= 0:
        raise ActionError(f"reduce-only: quantity must be > 0 (got {qty!r})")
    if q > abs(pos) + EPS:
        raise ActionError(f"reduce-only: {act} {q:g} exceeds the position {abs(pos):g} {position.get('symbol')} (it would flip it)")


def _order_spec(position: dict[str, Any], con: int, action: str, qty: float, order_type: str, tif: str, ref: str,
                **extra: Any) -> dict[str, Any]:
    spec = {"conId": con, "symbol": position.get("symbol"), "currency": position.get("currency") or "USD",
            "secType": position.get("secType") or "STK", "action": action, "quantity": qty, "orderType": order_type,
            "tif": tif, "orderRef": ref}
    spec.update(extra)
    return spec


async def _poll_done(adapter: Any, ids: list[int], deadline: float, *, sleep: Sleep, clock: Clock,
                     until: Callable[[dict[str, Any]], bool] | None = None) -> dict[int, dict[str, Any]]:
    """Poll order_status for `ids` until each is done (or `until(status)`), or the deadline passes.
    Always checks at least once. Returns the last status dict seen per id."""
    until = until or (lambda st: (st.get("status") or "") in DONE)
    last: dict[int, dict[str, Any]] = {}
    pending = list(dict.fromkeys(ids))
    while True:
        for oid in list(pending):
            try:
                st = await adapter.order_status(oid)
                if not isinstance(st, dict):
                    st = {"orderId": oid, "status": "Unknown"}
            except Exception as e:  # noqa: BLE001 — a failed status read is just "not confirmed yet"
                st = {"orderId": oid, "status": "Unknown", "error": _err(e)}
            last[oid] = st
            if until(st):
                pending.remove(oid)
        if not pending or clock() >= deadline:
            return last
        await sleep(POLL_S)


# ── cancel by ownership ──────────────────────────────────────────────
async def cancel_orders(orders: list[dict[str, Any]], *, act: Any, adapter_factory: Callable[[int, bool], Any],
                        bridge_alive: bool, ledger: Any, actor: str, wait_s: float = 10.0,
                        sleep: Sleep = asyncio.sleep, clock: Clock = time.monotonic, ref: str = "",
                        bridge_cancel: Callable[[list[int], str], Any] | None = None) -> dict[str, Any]:
    """Cancel each working order through the client id that owns it, then confirm.
    Orders owned by the live bridge's executor (13) go through `bridge_cancel(order_ids, reason)` — the
    bridge's POST /orders/cancel — when given; otherwise they are blocked (OWNER_IS_BRIDGE).
    Returns {"ok", "verdict", "cancelled", "unconfirmed", "blocked", "filled", "statuses"}."""
    _require_rw(act)
    me = _oid(getattr(act, "client_id", None))
    deadline = clock() + wait_s
    seen: set[tuple[int, int]] = set()
    groups: dict[int, list[dict[str, Any]]] = {}
    via_bridge: list[tuple[int, int]] = []
    blocked: list[dict[str, Any]] = []
    for o in orders or []:
        if not isinstance(o, dict) or not _working(o):
            continue
        owner = _cid(o)
        oid = _oid(o.get("orderId"))
        if owner in BRIDGE_OWNED_IDS and owner != me and bridge_alive:
            if bridge_cancel is not None and oid is not None:
                if (owner, oid) not in seen:
                    seen.add((owner, oid))
                    via_bridge.append((owner, oid))
                continue
            reason = "OWNER_IS_BRIDGE"
        elif owner != me and (owner in NEVER_BORROW or owner == 0):
            reason = "OWNER_NEVER_BORROWED"
        elif oid is None:
            reason = "NO_ORDER_ID"  # an order we can't address can't be cancelled: never skip it silently
        else:
            reason = None
        if oid is not None:
            if (owner, oid) in seen:
                continue
            seen.add((owner, oid))
        if reason:
            blocked.append({"orderId": oid if oid is not None else o.get("orderId"), "clientId": owner, "reason": reason})
            continue
        groups.setdefault(owner, []).append(o)

    done_keys: list[tuple[int, int]] = []
    unconfirmed_keys: list[tuple[int, int]] = []
    statuses: dict[int, str] = {}

    async def run(adapter: Any, owner: int, group: list[dict[str, Any]]) -> None:
        sent: list[int] = []
        for o in group:
            oid = int(o["orderId"])
            try:
                await adapter.cancel_order(oid)
                sent.append(oid)
            except ReadOnlyAdapter:
                raise
            except Exception as e:  # noqa: BLE001 — NotOwner on an already-finished order is fine: confirm below
                try:
                    st = await adapter.order_status(oid)
                except Exception:  # noqa: BLE001
                    st = {"status": "Unknown"}
                if ((st or {}).get("status") or "") in DONE:
                    sent.append(oid)
                else:
                    blocked.append({"orderId": oid, "clientId": owner, "reason": "CANCEL_FAILED", "error": _err(e)})
        if not sent:
            return
        last = await _poll_done(adapter, sent, deadline, sleep=sleep, clock=clock)
        for oid in sent:
            s = (last.get(oid) or {}).get("status") or "Unknown"
            statuses[oid] = s
            (done_keys if s in DONE else unconfirmed_keys).append((owner, oid))

    if me is not None and me in groups:
        await run(act, me, groups.pop(me))
    for owner, group in groups.items():
        adapter = None
        try:
            try:
                adapter = adapter_factory(owner, False)
                await adapter.connect()
            except Exception as e:  # noqa: BLE001
                for o in group:
                    blocked.append({"orderId": int(o["orderId"]), "clientId": owner, "reason": "OWNER_BUSY", "error": _err(e)})
                continue
            await run(adapter, owner, group)
        finally:
            if adapter is not None:
                await _disconnect(adapter)

    if via_bridge:
        # The bridge cancels its own executor's orders and reports per-id TWS status; anything it can't
        # confirm (or an old bridge without the route) stays blocked / unconfirmed, never assumed gone.
        try:
            r = bridge_cancel([oid for _, oid in via_bridge], ref or actor)
            if inspect.isawaitable(r):
                r = await r
            got = {_oid(x.get("orderId")): (x.get("status") or "Unknown") for x in (r or {}).get("results") or [] if isinstance(x, dict)}
            for owner, oid in via_bridge:
                s = got.get(oid, "Unknown")
                statuses[oid] = s
                (done_keys if s in DONE else unconfirmed_keys).append((owner, oid))
        except Exception as e:  # noqa: BLE001
            for owner, oid in via_bridge:
                blocked.append({"orderId": oid, "clientId": owner, "reason": "OWNER_IS_BRIDGE", "error": f"bridge cancel failed: {_err(e)}"})

    # Second confirmation: the broker's open-order book (every client) must no longer list the order.
    # order_status alone can be wrong (e.g. it matched another client's finished order with the same id).
    verify_error = None
    if done_keys:
        try:
            live = {k for k in (_key(o) for o in await act.open_orders() if isinstance(o, dict) and _working(o)) if k}
        except Exception as e:  # noqa: BLE001 — can't prove they are gone: fail closed
            live, verify_error = None, _err(e)
        for k in list(done_keys):
            if live is None or k in live:
                done_keys.remove(k)
                unconfirmed_keys.append(k)
                statuses[k[1]] = statuses.get(k[1], "Unknown") + ("+STILL_WORKING" if live is not None else "+UNVERIFIED")

    cancelled = [k[1] for k in done_keys]
    unconfirmed = [k[1] for k in unconfirmed_keys]
    filled = [k[1] for k in done_keys if statuses.get(k[1]) == "Filled"]
    if not blocked and not unconfirmed:
        verdict = "OK"
    elif blocked and not cancelled:
        verdict = "BLOCKED"
    else:
        verdict = "PARTIAL"
    out = {"ok": verdict == "OK", "verdict": verdict, "cancelled": cancelled, "unconfirmed": unconfirmed,
           "blocked": blocked, "filled": filled, "statuses": statuses}
    if verify_error:
        out["verifyError"] = verify_error
    _log(ledger, "orders_cancel", {"cancelled": cancelled, "unconfirmed": unconfirmed, "blocked": blocked, "filled": filled,
                                   "statuses": {str(k): v for k, v in statuses.items()}, "bridgeAlive": bool(bridge_alive),
                                   "client": me, **({"verifyError": verify_error} if verify_error else {})},
         ref=ref, verdict=verdict, actor=actor)
    return out


# ── selective liquidation ────────────────────────────────────────────
def _legs(orders: list[dict[str, Any]], con: int, symbol: Any, sides: set[str]) -> list[dict[str, Any]]:
    """Working orders on this contract that could reduce it (action in `sides`, or an unreadable
    action), whatever their role: stops, take-profits, exits AND the exit-side children of a
    still-working entry bracket (they go live as the parent fills). Plus the working parents of
    those children, so a half-filled entry can't keep filling naked after its children are gone.
    An order with no usable conId but the same symbol counts too (it can't be ruled out)."""
    def on_con(o: dict[str, Any]) -> bool:
        c = _con(o.get("conId"))
        return c == con or (c is None and symbol is not None and o.get("symbol") == symbol)

    working = [o for o in orders or [] if isinstance(o, dict) and _working(o) and on_con(o)]
    legs = [o for o in working if (str(o.get("action") or "").upper() in sides
                                   or str(o.get("action") or "").upper() not in ("BUY", "SELL"))]
    parents = {(_cid(o), _oid(o.get("parentId"))) for o in legs if _oid(o.get("parentId"))}
    legs += [o for o in working if _key(o) in parents and not any(o is x for x in legs)]
    return legs


async def liquidate_position(position: dict[str, Any], orders: list[dict[str, Any]], *, act: Any,
                             adapter_factory: Callable[[int, bool], Any], bridge_alive: bool, ledger: Any, actor: str,
                             ref: str, reason: str, wait_s: float = 15.0, sleep: Sleep = asyncio.sleep,
                             clock: Clock = time.monotonic, bridge_cancel: Callable[[list[int], str], Any] | None = None) -> dict[str, Any]:
    """Cancel ONE position's protective legs, then close it with a reduce-only market order.
    Verdicts: FILLED / SUBMITTED / FAILED / BLOCKED, plus FLAT when the position is already gone
    (e.g. a leg filled during the cancel) and nothing is left to sell. Other positions' orders are
    never touched."""
    _require_rw(act)
    position = position if isinstance(position, dict) else {}
    con = _con(position.get("conId"))
    sym = position.get("symbol")
    steps: list[dict[str, Any]] = []
    base = {"symbol": sym, "conId": con if con is not None else position.get("conId"), "reason": reason,
            "positionBefore": _f(position.get("position"))}

    def done(verdict: str, ok: bool, error: str | None = None, **extra: Any) -> dict[str, Any]:
        out = {"ok": ok, "verdict": verdict, **base, "steps": steps, **extra}
        if error:
            out["error"] = error
        _log(ledger, "liquidation", out, ref=ref, verdict=verdict, actor=actor)
        return out

    if con is None:
        steps.append({"step": "validate", "error": f"no usable conId {position.get('conId')!r}"})
        return done("FAILED", False, "INVALID_POSITION")

    # (0) fresh view: legs come from the broker's book when it can be read (a stale snapshot can miss a leg)
    try:
        book = [o for o in await act.open_orders() if isinstance(o, dict)]
        book_src = "broker"
    except Exception as e:  # noqa: BLE001
        book, book_src = list(orders or []), "caller"
        steps.append({"step": "read_orders", "error": _err(e)})
    try:
        net0, bad0 = _net_con(await act.positions(), con)
        if bad0:
            steps.append({"step": "read_positions", "error": "malformed position size from the broker"})
            return done("FAILED", False, "MALFORMED_POSITION")
    except Exception as e:  # noqa: BLE001
        net0 = None
        steps.append({"step": "read_positions", "error": _err(e)})
    sides = {s for s in (_side(_f(position.get("position"))), _side(net0)) if s}
    if not sides and net0 is None:
        steps.append({"step": "validate", "error": f"position size {position.get('position')!r} unusable and the broker can't be read"})
        return done("FAILED", False, "INVALID_POSITION")

    # (1) + (2) cancel the legs
    legs = _legs(book, con, sym, sides)
    leg_keys = {k for k in (_key(o) for o in legs) if k}
    steps.append({"step": "legs", "source": book_src, "orderIds": [o.get("orderId") for o in legs]})
    c = await cancel_orders(legs, act=act, adapter_factory=adapter_factory, bridge_alive=bridge_alive, ledger=ledger,
                            actor=actor, wait_s=wait_s, sleep=sleep, clock=clock, ref=ref, bridge_cancel=bridge_cancel)
    steps.append({"step": "cancel", "verdict": c["verdict"], "cancelled": c["cancelled"], "unconfirmed": c["unconfirmed"],
                  "blocked": c["blocked"]})
    if c["blocked"] or c["unconfirmed"]:
        return done("BLOCKED", False, "LIQUIDATION_BLOCKED", cancel=c,
                    detail="a protective leg could not be cancelled; not selling (it could fill too and flip the position)")
    unprotected = bool(c["cancelled"])

    # (3) re-read: no leg may still be working, and size the sell from the CURRENT position
    async def reread() -> tuple[list[dict[str, Any]], float, bool]:
        fo = [o for o in await act.open_orders() if isinstance(o, dict)]
        q, bad = _net_con(await act.positions(), con)
        return fo, q, bad

    try:
        fresh_orders, cur_q, bad = await reread()
    except Exception as e:  # noqa: BLE001
        steps.append({"step": "reread", "error": _err(e)})
        return done("FAILED", False, "REREAD_FAILED", unprotected=unprotected)
    if bad:
        steps.append({"step": "reread", "error": "malformed position size from the broker"})
        return done("FAILED", False, "MALFORMED_POSITION", unprotected=unprotected)
    cur_side = _side(cur_q)
    still_orders = [o for o in fresh_orders if _working(o) and _key(o) in leg_keys]
    if cur_side:
        still_orders += [o for o in _legs(fresh_orders, con, sym, {cur_side}) if not any(o is x for x in still_orders)]
    still = [o.get("orderId") for o in still_orders]
    steps.append({"step": "reread", "stillWorking": still, "position": cur_q})
    if still:
        return done("BLOCKED", False, "LIQUIDATION_BLOCKED", cancel=c, unprotected=unprotected,
                    detail=f"protective leg(s) {still} still working after cancel; not selling")
    if cur_side is None:
        # Flat. A leg that filled explains it; otherwise read once more before believing it
        # (a glitchy empty read must not end a liquidation with the legs already cancelled).
        if not c.get("filled"):
            await sleep(POLL_S)
            try:
                q2, bad2 = _net_con(await act.positions(), con)
            except Exception as e:  # noqa: BLE001
                steps.append({"step": "confirm_flat", "error": _err(e)})
                return done("FAILED", False, "REREAD_FAILED", unprotected=unprotected)
            steps.append({"step": "confirm_flat", "position": q2})
            if bad2 or _side(q2) is not None:
                return done("FAILED", False, "POSITION_READ_INCONSISTENT", unprotected=unprotected,
                            detail="the broker reported the position flat, then open again; not selling on an inconsistent view")
        return done("FLAT", True, detail="position already flat (a leg filled, or it was closed elsewhere); nothing to sell")

    # (4) reduce-only market order
    cur = {**position, "conId": con, "position": cur_q}
    action = cur_side
    qty = abs(cur_q)
    try:
        reduce_only(cur, action, qty)
    except ActionError as e:
        steps.append({"step": "reduce_only", "error": str(e)})
        return done("FAILED", False, "REDUCE_ONLY", unprotected=unprotected)
    spec = _order_spec(cur, con, action, qty, "MKT", "DAY", ref)
    try:
        placed = await act.place_order(spec)
    except ReadOnlyAdapter:
        raise
    except Exception as e:  # noqa: BLE001
        steps.append({"step": "place", "spec": spec, "error": _err(e)})
        return done("FAILED", False, "PLACE_FAILED", unprotected=unprotected)
    placed = placed if isinstance(placed, dict) else {}
    oid = _oid(placed.get("orderId"))
    steps.append({"step": "place", "spec": spec, "orderId": oid, "status": placed.get("status")})
    if oid is None:
        return done("FAILED", False, "PLACE_FAILED", unprotected=unprotected)

    # (5) confirm the fill, then that the broker's position reflects it
    deadline = clock() + wait_s
    last = await _poll_done(act, [oid], deadline, sleep=sleep, clock=clock)
    st = last.get(oid) or {}
    status = st.get("status") or "Unknown"
    steps.append({"step": "confirm", "status": status, "filled": st.get("filled")})
    if status in DONE and status != "Filled":
        return done("FAILED", False, "ORDER_DEAD", orderId=oid, status=status, unprotected=unprotected)
    if status != "Filled":
        return done("SUBMITTED", False, "NOT_CONFIRMED_FILLED", orderId=oid, status=status, filled=st.get("filled"))
    after: float | None = None
    while True:
        try:
            after, bad = _net_con(await act.positions(), con)
            if bad:
                after = None
        except Exception:  # noqa: BLE001
            after = None
        if (after is not None and abs(after) <= EPS) or clock() >= deadline:
            break
        await sleep(POLL_S)
    steps.append({"step": "verify", "positionAfter": after})
    if after is None or abs(after) > EPS:
        return done("SUBMITTED", False, "FILL_NOT_REFLECTED", orderId=oid, status=status, filled=st.get("filled"),
                    positionAfter=after,
                    detail="the order reports Filled but the broker position is not flat; check before acting again")
    return done("FILLED", True, orderId=oid, status=status, filled=st.get("filled"), positionAfter=after)


# ── emergency stop ───────────────────────────────────────────────────
def emergency_stop_price(position: dict[str, Any], price: float, atr_pct: float | None, policy: dict[str, Any]) -> float:
    dms = policy["dead_mans_switch"]
    px = _f(price)
    if px is None or px <= 0:
        raise ActionError(f"emergency stop: no usable price for {position.get('symbol')} ({price!r})")
    atr = _f(atr_pct)
    dist = _f(dms["emergency_stop_min_pct"])
    if dist is None or dist <= 0:
        raise ActionError(f"emergency stop: policy emergency_stop_min_pct must be > 0 (got {dms['emergency_stop_min_pct']!r})")
    if atr is not None and atr > 0:
        mult = _f(dms["emergency_stop_atr_mult"])
        if mult is not None and mult > 0:
            dist = max(mult * atr, dist)
    side = _exit_action(position)  # SELL for a long, BUY for a short
    if side == "SELL" and dist >= 100:
        raise ActionError(f"emergency stop: distance {dist:g}% leaves no stop price above 0")
    stop = px * (1 - dist / 100) if side == "SELL" else px * (1 + dist / 100)
    stop = round(stop, 2)
    if stop <= 0 or (side == "SELL" and stop >= px) or (side == "BUY" and stop <= px):
        raise ActionError(f"emergency stop: {stop} is not on the protective side of {px}")
    return stop


async def place_emergency_stop(position: dict[str, Any], *, act: Any, ledger: Any, actor: str, ref: str, price: float,
                               atr_pct: float | None, policy: dict[str, Any], orders: list[dict[str, Any]] | None = None,
                               wait_s: float = 10.0, sleep: Sleep = asyncio.sleep, clock: Clock = time.monotonic) -> dict[str, Any]:
    """Reduce-only GTC STP at `emergency_stop_price`, sized |position| minus the open quantity of stops
    already working on the contract (so stops never add up to more than the position: a fill of all
    of them would flip it). `orders` defaults to a fresh `act.open_orders()`. The stop counts as placed
    only once TWS reports it working (PreSubmitted / Submitted)."""
    _require_rw(act)
    base = {"symbol": position.get("symbol") if isinstance(position, dict) else None,
            "conId": position.get("conId") if isinstance(position, dict) else None, "price": price, "atrPct": atr_pct}

    def fail(error: str, detail: str, **extra: Any) -> dict[str, Any]:
        out = {"ok": False, "verdict": "FAILED", "error": error, "detail": detail, **base, **extra}
        _log(ledger, "emergency_stop", out, ref=ref, verdict="FAILED", actor=actor)
        return out

    try:
        con = _con(position.get("conId"))
        if con is None:
            raise ActionError(f"no usable conId {position.get('conId')!r}")
        action = _exit_action(position)
        size = abs(float(position["position"]))
        stop = emergency_stop_price(position, price, atr_pct, policy)
    except (ActionError, AttributeError, KeyError, TypeError, ValueError) as e:
        return fail("INVALID", str(e))

    orders_error = None
    if orders is None:
        try:
            orders = await act.open_orders()
        except Exception as e:  # noqa: BLE001 — protection first: place the full-size stop, say so
            orders, orders_error = [], _err(e)
    existing = [o for o in orders or [] if isinstance(o, dict) and _working(o) and _con(o.get("conId")) == con
                and str(o.get("action") or "").upper() == action and str(o.get("orderType") or "").upper() in STOP_TYPES
                and (o.get("status") or "") not in NOT_COVERING]
    # Only GTC stops count as coverage: a DAY stop expires at the close (reconcile's NOT_GTC).
    non_gtc = [o for o in existing if str(o.get("tif") or "").upper() != "GTC"]
    existing = [o for o in existing if str(o.get("tif") or "").upper() == "GTC"]
    existing_qty = sum(_open_qty(o) for o in existing)
    same_side = [o for o in orders or [] if isinstance(o, dict) and _working(o) and _con(o.get("conId")) == con
                 and str(o.get("action") or "").upper() == action and not any(o is x for x in existing) and not any(o is x for x in non_gtc)]
    # Market / other non-stop, non-limit exits = a liquidation in progress. (Stops pending cancel and
    # resting take-profits are not; a take-profit only earns a warning, as before.)
    other_exits = [o.get("orderId") for o in same_side if str(o.get("orderType") or "").upper() not in STOP_TYPES | {"LMT"}]
    tps = [o.get("orderId") for o in same_side if str(o.get("orderType") or "").upper() == "LMT"]
    info = {"positionSize": size, "existingStopQty": existing_qty, "existingStops": [o.get("orderId") for o in existing]}
    if orders_error:
        info["ordersError"] = orders_error
    if tps:
        info["warning"] = (f"take-profit / limit exit(s) {tps} also rest on this contract and are not OCA-linked with this stop: "
                           f"if both fill the position flips")
    # Fail closed instead of stacking: a second stop on top of a DAY stop, or of a resting market/stop exit,
    # can fill together with it and flip the position.
    if non_gtc:
        return fail("NOT_GTC_PRESENT", f"non-GTC stop(s) {[o.get('orderId') for o in non_gtc]} rest on this contract; "
                    "replace them with a GTC stop (or liquidate) instead of stacking another stop", **info)
    if other_exits:
        return fail("EXIT_PENDING", f"exit order(s) {other_exits} already rest on this contract (a liquidation in progress?); "
                    "not adding a stop that could fill with them", **info)
    qty = size - existing_qty
    if qty <= EPS:
        out = {"ok": True, "verdict": "COVERED", "action": action, "qty": 0.0, "stopPrice": stop, **info, **base,
               "detail": "working stops already cover the position; no stop placed"}
        _log(ledger, "emergency_stop", out, ref=ref, verdict="COVERED", actor=actor)
        return out
    try:
        reduce_only(position, action, qty)
        reduce_only(position, action, qty + existing_qty)  # the stops together, too
    except ActionError as e:
        return fail("INVALID", str(e), **info)
    spec = _order_spec(position, con, action, qty, "STP", "GTC", ref, stopPrice=stop)
    try:
        placed = await act.place_order(spec)
    except ReadOnlyAdapter:
        raise
    except Exception as e:  # noqa: BLE001
        return fail("PLACE_FAILED", _err(e), spec=spec, **info)
    placed = placed if isinstance(placed, dict) else {}
    oid = _oid(placed.get("orderId"))
    status = placed.get("status") or "Unknown"
    if oid is not None:
        last = await _poll_done(act, [oid], clock() + wait_s, sleep=sleep, clock=clock,
                                until=lambda s: (s.get("status") or "") in ACCEPTED or (s.get("status") or "") in DONE)
        status = (last.get(oid) or {}).get("status") or status
    if status in ACCEPTED:
        verdict, ok, error = "PLACED", True, None
    elif status == "Filled":
        verdict, ok, error = "FILLED", True, None  # triggered at once: the position is closed
    elif status in DONE:
        verdict, ok, error = "REJECTED", False, "STOP_REJECTED"
    else:
        verdict, ok, error = "UNCONFIRMED", False, "STOP_NOT_CONFIRMED"
    out = {"ok": ok, "verdict": verdict, "orderId": oid if oid is not None else placed.get("orderId"), "status": status,
           "stopPrice": stop, "action": action, "qty": qty, "spec": spec, **info, **base}
    if error:
        out["error"] = error
    _log(ledger, "emergency_stop", out, ref=ref, verdict=verdict, actor=actor)
    return out


# ── cancel entries ───────────────────────────────────────────────────
async def cancel_entries(positions: list[dict[str, Any]], orders: list[dict[str, Any]], *, act: Any,
                         adapter_factory: Callable[[int, bool], Any], bridge_alive: bool, ledger: Any, actor: str,
                         **kw: Any) -> dict[str, Any]:
    """Cancel every working order that would open or add exposure (entries, and the children of an
    unfilled entry bracket). Protective legs of open positions are left alone. kw: wait_s, sleep, clock, ref.

    Roles are decided against the broker's CURRENT positions (re-read here; a stale or empty list from
    the caller would make every stop look like an entry). An order is cancelled only when both the
    caller's and the broker's positions call it an entry; an exit-side order on a contract that is
    held (a child of a half-filled entry) and its parent are kept; orders on a contract whose size
    is malformed are kept. Positions unreadable → nothing is cancelled."""
    _require_rw(act)
    ref = str(kw.get("ref", ""))
    try:
        fresh_pos = [p for p in await act.positions() if isinstance(p, dict)]
    except Exception as e:  # noqa: BLE001
        out = {"ok": False, "verdict": "BLOCKED", "error": "POSITIONS_UNAVAILABLE", "detail": _err(e), "targets": [], "kept": [],
               "skipped": [], "cancelled": [], "unconfirmed": [], "blocked": []}
        _log(ledger, "cancel_entries", out, ref=ref, verdict="BLOCKED", actor=actor)
        return out
    try:
        book = [o for o in await act.open_orders() if isinstance(o, dict)]
    except Exception:  # noqa: BLE001 — the caller's snapshot will do for choosing entries
        book = [o for o in orders or [] if isinstance(o, dict)]
    given = [p for p in positions or [] if isinstance(p, dict)]
    working = [o for o in book if _working(o)]

    held: dict[int, set[str]] = {}       # conId -> exit sides (by either view)
    malformed: set[int] = set()
    for plist in (fresh_pos, given):
        for p in plist:
            c = _con(p.get("conId"))
            if c is None:
                continue
            q = _f(p.get("position"))
            if q is None:
                malformed.add(c)
            elif _side(q):
                held.setdefault(c, set()).add(_side(q))
    roles_fresh = order_roles(fresh_pos, working)
    roles_given = order_roles(given, working)

    targets: list[dict[str, Any]] = []
    kept: list[Any] = []
    skipped: list[dict[str, Any]] = []
    keep_parents: set[tuple[int, int | None]] = set()
    for o, rf, rg in zip(working, roles_fresh, roles_given):
        c = _con(o.get("conId"))
        act_side = str(o.get("action") or "").upper()
        if rf in PROTECTIVE_ROLES or rg in PROTECTIVE_ROLES:
            kept.append(o.get("orderId"))
        elif c is not None and c in malformed:
            skipped.append({"orderId": o.get("orderId"), "reason": "POSITION_MALFORMED"})
        elif c is None or (c in held and (act_side in held[c] or act_side not in ("BUY", "SELL"))):
            # exit-side child of a half-filled entry on a held contract (or unknowable): it protects
            skipped.append({"orderId": o.get("orderId"), "reason": "PROTECTS_HELD_POSITION" if c is not None else "NO_CONID"})
            if _oid(o.get("parentId")):
                keep_parents.add((_cid(o), _oid(o.get("parentId"))))
        elif rf in ENTRY_ROLES and rg in ENTRY_ROLES:
            targets.append(o)
        else:
            kept.append(o.get("orderId"))
    if keep_parents:
        for o in [t for t in targets if _key(t) in keep_parents]:
            targets.remove(o)
            skipped.append({"orderId": o.get("orderId"), "reason": "PARENT_OF_PROTECTIVE_CHILD"})
    # children first: cancelling a parent makes TWS drop its children anyway, this keeps the confirm clean
    child = {id(o) for o, r in zip(working, roles_fresh) if r == "pending_child"}
    targets.sort(key=lambda o: 0 if id(o) in child else 1)
    ids = [o.get("orderId") for o in targets]
    if targets:
        c = await cancel_orders(targets, act=act, adapter_factory=adapter_factory, bridge_alive=bridge_alive, ledger=ledger,
                                actor=actor, **kw)
    else:
        c = {"ok": True, "verdict": "OK", "cancelled": [], "unconfirmed": [], "blocked": [], "statuses": {}}
    out = {"ok": c["ok"], "verdict": c["verdict"], "targets": ids, "kept": kept, "skipped": skipped, "cancelled": c["cancelled"],
           "unconfirmed": c["unconfirmed"], "blocked": c["blocked"]}
    _log(ledger, "cancel_entries", out, ref=ref, verdict=c["verdict"], actor=actor)
    return out


# ── flatten everything ───────────────────────────────────────────────
def _flatten_order(p: dict[str, Any]) -> tuple[int, str]:
    q = _f(p.get("position")) or 0.0
    short_opt = (p.get("secType") or "STK") in OPTION_SEC_TYPES and q < 0
    return (0 if short_opt else 1, str(p.get("symbol") or ""))


async def _working_ids(act: Any) -> list[Any]:
    return [o.get("orderId") for o in await act.open_orders() if isinstance(o, dict) and _working(o)]


async def flatten_all(*, act: Any, ledger: Any, actor: str, ref: str, wait_s: float = 15.0, sleep: Sleep = asyncio.sleep,
                      clock: Clock = time.monotonic) -> dict[str, Any]:
    """Global cancel, then a reduce-only market order for every position (short options first).
    FLAT only when the broker shows no position AND no working order afterwards."""
    _require_rw(act)
    steps: list[dict[str, Any]] = []
    try:
        await act.global_cancel()
        steps.append({"step": "global_cancel", "ok": True})
    except ReadOnlyAdapter:
        raise
    except Exception as e:  # noqa: BLE001 — keep going: positions must be flattened
        steps.append({"step": "global_cancel", "ok": False, "error": _err(e)})

    deadline = clock() + wait_s
    still: list[Any] = []
    while True:
        try:
            still = await _working_ids(act)
        except Exception as e:  # noqa: BLE001
            still = ["UNKNOWN"]
            steps.append({"step": "open_orders", "error": _err(e)})
        if not still or clock() >= deadline:
            break
        await sleep(POLL_S)
    steps.append({"step": "orders_cleared", "ok": not still, "stillWorking": still})

    try:
        raw = [p for p in await act.positions() if isinstance(p, dict)]
    except Exception as e:  # noqa: BLE001
        steps.append({"step": "positions", "error": _err(e)})
        out = {"ok": False, "verdict": "FAILED", "error": "POSITIONS_UNAVAILABLE", "steps": steps, "orders": [], "remaining": None,
               "stillWorking": still}
        _log(ledger, "flatten_all", out, ref=ref, verdict="FAILED", actor=actor)
        return out
    malformed = [{"symbol": p.get("symbol"), "conId": p.get("conId"), "position": p.get("position")}
                 for p in raw if _f(p.get("position")) is None]
    positions = [p for p in raw if abs(_f(p.get("position")) or 0.0) > EPS]
    positions.sort(key=_flatten_order)

    placed: list[dict[str, Any]] = []
    for p in positions:
        try:
            con = _con(p.get("conId"))
            if con is None:
                raise ActionError(f"no usable conId {p.get('conId')!r}")
            action = _exit_action(p)
            qty = abs(float(p["position"]))
            reduce_only(p, action, qty)
            spec = _order_spec(p, con, action, qty, "MKT", "DAY", ref)
            r = await act.place_order(spec)
            r = r if isinstance(r, dict) else {}
            placed.append({"symbol": p.get("symbol"), "conId": con, "secType": p.get("secType"), "action": action,
                           "qty": qty, "orderId": _oid(r.get("orderId")), "status": r.get("status")})
        except ReadOnlyAdapter:
            raise
        except Exception as e:  # noqa: BLE001
            placed.append({"symbol": p.get("symbol"), "conId": p.get("conId"), "secType": p.get("secType"), "error": _err(e)})

    ids = [x["orderId"] for x in placed if x.get("orderId")]
    if ids:
        last = await _poll_done(act, ids, clock() + wait_s, sleep=sleep, clock=clock)
        for x in placed:
            if x.get("orderId") in last:
                x["status"] = last[x["orderId"]].get("status")
    try:
        after = [p for p in await act.positions() if isinstance(p, dict)]
        remaining = [{"symbol": p.get("symbol"), "conId": p.get("conId"), "position": _f(p.get("position"))}
                     for p in after if _f(p.get("position")) is None or abs(_f(p.get("position")) or 0.0) > EPS]
    except Exception as e:  # noqa: BLE001
        remaining = None
        steps.append({"step": "verify", "error": _err(e)})
    try:
        working_after = await _working_ids(act)
    except Exception as e:  # noqa: BLE001
        working_after = ["UNKNOWN"]
        steps.append({"step": "verify_orders", "error": _err(e)})

    out_extra: dict[str, Any] = {}
    if remaining == [] and not working_after and not malformed:
        verdict = "FLAT"
    elif remaining == [] or any(x.get("status") == "Filled" for x in placed):
        verdict = "PARTIAL"
        if remaining == []:
            out_extra["error"] = "ORDERS_STILL_WORKING" if working_after else "MALFORMED_POSITION"
    else:
        verdict = "FAILED"
    out = {"ok": verdict == "FLAT", "verdict": verdict, "steps": steps, "orders": placed, "remaining": remaining,
           "stillWorking": still, "workingAfter": working_after, **out_extra}
    if malformed:
        out["malformed"] = malformed
    _log(ledger, "flatten_all", out, ref=ref, verdict=verdict, actor=actor)
    return out
