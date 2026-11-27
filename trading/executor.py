"""Paper order executor — the only code that places orders, and only for approved intents.

Uses its own IBKR client id (13) and a NON-read-only connection, opened lazily
when the desk is in SEMI_AUTO / FULL_AUTO. Immediately before every placement
it re-checks the kill-switch lock and the paper endpoint (no time-of-check /
time-of-use gap between the Security Detail verdict and the socket call).

Every stock entry is a bracket: parent (LMT or MKT, DAY) + protective STOP (GTC)
and, when given, a take-profit LMT (GTC). Options (OPT single leg / BAG debit
vertical) get parent LMT + take-profit LMT only: a STP on an option or combo
triggers off thin last-trade prints, so the premium stop and the expiry-day
flatten are enforced by the desk's options monitor instead (close_option()). Children are GTC so a filled DAY entry is
never left unprotected overnight. `orderRef` = intent_id ties fills back to
the intent and the audit log.
"""

from __future__ import annotations

import logging
from typing import Any, Callable

from config import load_config, resolve_endpoint
from intents import OrderIntent
import kill_switch

log = logging.getLogger("trading.executor")


class ExecutionRefused(RuntimeError):
    pass


PENDING = {"", "PendingSubmit", "ApiPending"}
REJECTED = {"Cancelled", "ApiCancelled", "Inactive"}
ACK_TIMEOUT_S = 15.0  # a TWS order-confirmation dialog on the first API order can take a few seconds
CANCEL_SETTLE_S = 5.0  # after cancelling an unacknowledged parent: how long to wait to learn whether it filled first


def rejection(trade: Any, refuse_warnings: bool = True) -> str | None:
    """Why TWS refused this order, or None. A dead status counts; so does a ValidationError log entry
    when `refuse_warnings`. Note: ib_async logs TWS *warnings* (399, 404, 2100-2199, ...) as ValidationError
    while the order stays live, so that is fail-closed: right for an entry (await_ack checks fills first),
    wrong for a risk-reducing exit, which must not be cancelled over a warning (refuse_warnings=False)."""
    for e in getattr(trade, "log", []) or []:
        st = getattr(e, "status", "")
        if (refuse_warnings and st == "ValidationError") or (getattr(e, "errorCode", 0) and st in REJECTED):
            return getattr(e, "message", "") or f"error {e.errorCode}"
    st = trade.orderStatus.status
    if st in REJECTED and not (trade.orderStatus.filled or 0):
        return f"order {trade.order.orderId} {st}"
    return None


def _filled(trades: list[Any]) -> bool:
    """A leg has (partly) filled: a position exists, so its protective legs must be left alone. ib_async records an
    execution in trade.fills (execDetails) separately from orderStatus, so either counts."""
    return any((t.orderStatus.filled or 0) > 0 or t.orderStatus.status == "Filled" or getattr(t, "fills", None) for t in trades)


def _is_child(t: Any) -> bool:
    return bool(getattr(t.order, "parentId", 0))


async def await_ack(ib: Any, trades: list[Any], timeout: float = ACK_TIMEOUT_S, sleep: Any = None,
                    settle: float = CANCEL_SETTLE_S, refuse_warnings: bool = True, what: str = "entry") -> list[str]:
    """Wait until TWS has acknowledged every order (a bracket, or one exit). Returns warnings (empty when clean).

    A rejection, or no acknowledgement within `timeout`:
    - nothing filled: cancel the parent (TWS cancels its attached children) and raise ExecutionRefused, so
      the desk records "failed", not a phantom "submitted". If the parent fills before the cancel lands,
      its stop / take-profit are still working: return warnings instead of raising.
    - something filled: a position exists (or, for an exit, has shrunk). Never cancel; return the problems as
      warnings so the desk records what really happened (the stop of a filled entry is never stripped).
    refuse_warnings=False (exits): a TWS warning alone is not a refusal. The order counts as acknowledged once
    TWS gives it a live status; still only ValidationError / pending at the deadline = not acknowledged."""
    import asyncio
    import time

    sleep = sleep or asyncio.sleep
    pending = PENDING if refuse_warnings else PENDING | {"ValidationError"}
    # Exits: once TWS has given the order a live status it is acknowledged, even if a later warning (ib_async sets
    # status = ValidationError for 399/404/2100-2199 on a live order) left that as the last word.
    acked = (lambda t: t.orderStatus.status not in pending) if refuse_warnings else \
        (lambda t: t.orderStatus.status not in pending or _was_live(t))
    deadline = time.monotonic() + timeout
    while True:
        bad = [r for r in (rejection(t, refuse_warnings) for t in trades) if r]
        if not bad and all(acked(t) for t in trades):
            return [f"TWS warning (order not cancelled): {m}" for m in _warnings_logged(trades)]
        timed_out = time.monotonic() >= deadline
        if bad or timed_out:
            problems = list(dict.fromkeys(bad)) if bad else [f"TWS didn't acknowledge the order within {timeout:g}s"]
            if _filled(trades):
                return _fill_warnings(problems, trades, what, _trim_unprotected(ib, trades))
            seen = "; ".join(_describe(t) for t in trades)
            failed: list[Any] = []
            sent = _cancel_live(ib, trades, failed)
            if await _filled_after_cancel(sent, trades, settle, sleep):
                return _fill_warnings(problems + [f"the {what} filled before the cancel landed"], trades, what)
            # Say what really happened to the cancel: if it couldn't be sent (e.g. the socket dropped), the order
            # may still be working at TWS and the caller must not assume it's gone.
            unsent = (f"; the cancel for {', '.join(f'#{t.order.orderId}' for t in failed)} could NOT be sent, so it may "
                      f"still be working [{seen}]") if failed else ""
            if bad:
                raise ExecutionRefused("TWS rejected the order: " + "; ".join(problems) + unsent)
            raise ExecutionRefused(f"{problems[0]}{unsent or f'; cancelled to avoid an orphan [{seen}]'}")
        await sleep(0.2)


LIVE = {"PreSubmitted", "Submitted", "Filled"}


def _was_live(t: Any) -> bool:
    """TWS reported this order working (or filled) at some point: a live status in its log or right now."""
    return t.orderStatus.status in LIVE or any(getattr(e, "status", "") in LIVE for e in (getattr(t, "log", []) or []))


def _warnings_logged(trades: list[Any]) -> list[str]:
    return list(dict.fromkeys(getattr(e, "message", "") or f"warning {getattr(e, 'errorCode', '?')}"
                              for t in trades for e in (getattr(t, "log", []) or []) if getattr(e, "status", "") == "ValidationError"))


def _dead_stops(trades: list[Any]) -> list[Any]:
    return [t for t in trades if _is_child(t) and getattr(t.order, "orderType", "") == "STP"
            and t.orderStatus.status in REJECTED and not (t.orderStatus.filled or 0)]


def _trim_unprotected(ib: Any, trades: list[Any]) -> list[str]:
    """A partly filled entry whose stop is dead: cancel the parent's unfilled remainder, so the position without a
    stop can't grow. Its filled part is never touched. (Whether TWS then resizes the take-profit to the filled
    quantity or cancels it isn't clearly documented; either beats more unprotected shares.)"""
    dead_parents = {t.order.parentId for t in _dead_stops(trades)}
    notes = []
    for t in trades:
        if _is_child(t) or t.order.orderId not in dead_parents or t.orderStatus.status in REJECTED or t.isDone():
            continue
        try:
            ib.cancelOrder(t.order)
            notes.append(f"cancelled the unfilled remainder of #{t.order.orderId} ({t.orderStatus.filled or 0:g} filled) so the unprotected position can't grow")
        except Exception as e:  # noqa: BLE001
            notes.append(f"could NOT cancel the unfilled remainder of #{t.order.orderId}: {e}")
    return notes


def _fill_warnings(problems: list[str], trades: list[Any], what: str = "entry", trimmed: list[str] | None = None) -> list[str]:
    """The legs line shows each leg's real status: a rejected stop shows as Cancelled, and the position is then
    without it (broker-vs-desk reconcile and the overseer's master stop-loss, once armed, are the backstops)."""
    legs = "; ".join(_describe(t) for t in trades)
    alarm = [f"NO STOP: protective STP #{t.order.orderId} is {t.orderStatus.status}; the filled position is unprotected" for t in _dead_stops(trades)]
    return alarm + list(trimmed or []) + [f"{what} filled, so nothing else was cancelled: {p}" for p in problems] + [f"legs: {legs}"]


async def _filled_after_cancel(sent: list[Any], trades: list[Any], settle: float, sleep: Any) -> bool:
    """After cancelling: wait (bounded by `settle`) until TWS has answered each cancel, then report whether anything
    filled. ib_async's cancelOrder sets the status itself before TWS answers (a PendingSubmit, non-transmit bracket
    parent goes straight to a local "Cancelled"), so done-ness alone proves nothing: wait for a log entry newer than
    the one cancelOrder wrote (TWS's orderStatus, an execution, or an error). Nothing sent = nothing to wait for."""
    import time

    if not sent:
        return _filled(trades)
    marks = {id(t): len(getattr(t, "log", []) or []) for t in sent}
    answered = lambda t: t.isDone() and len(getattr(t, "log", []) or []) > marks[id(t)]  # noqa: E731
    deadline = time.monotonic() + settle
    while not _filled(trades) and not all(answered(t) for t in sent) and time.monotonic() < deadline:
        await sleep(0.2)
    return _filled(trades)


def _describe(t: Any) -> str:
    """'#12 LMT PendingSubmit: <last TWS message>' for a diagnosable timeout error."""
    last = next((e for e in reversed(getattr(t, "log", []) or []) if getattr(e, "message", "")), None)
    msg = f": {last.message}" if last else ""
    return f"#{t.order.orderId} {getattr(t.order, 'orderType', '')} {t.orderStatus.status or 'no status'}{msg}"


def _cancel_live(ib: Any, trades: list[Any], failed: list[Any] | None = None) -> list[Any]:
    """Cancel an unfilled bracket by its parent: TWS cancels the attached children with it. A child whose
    parent is still live is never cancelled directly, so if the parent fills just as the cancel goes out
    (the cancel then fails), its stop / take-profit stay working. A child with no live parent is cancelled.
    Returns the trades a cancel was sent for; ones whose cancel raised (e.g. disconnected) go in `failed`."""
    live = lambda t: t.orderStatus.status not in REJECTED and not t.isDone()  # noqa: E731
    live_parents = {t.order.orderId for t in trades if not _is_child(t) and live(t)}
    sent = []
    for t in trades:
        if not live(t) or (_is_child(t) and t.order.parentId in live_parents):
            continue
        try:
            ib.cancelOrder(t.order)
            sent.append(t)
        except Exception:  # noqa: BLE001
            if failed is not None:
                failed.append(t)
    return sent


def opposite(action: str) -> str:
    return "SELL" if action == "BUY" else "BUY"


def build_bracket(intent: OrderIntent, qty: int, parent_id: int, factories: dict[str, Callable[..., Any]]) -> list[Any]:
    """Pure order construction (factories injected so tests need no ib_async)."""
    if intent.order_type == "LMT":
        parent = factories["limit"](intent.action, qty, intent.limit_price)
    else:
        parent = factories["market"](intent.action, qty)
    parent.orderId = parent_id
    parent.tif = intent.time_in_force
    parent.orderRef = intent.intent_id
    parent.transmit = False
    exit_side = opposite(intent.action)
    orders = [parent]
    if not intent.is_option:
        stop = factories["stop"](exit_side, qty, intent.stop_loss)
        stop.parentId = parent_id
        stop.tif = "GTC"
        stop.orderRef = intent.intent_id
        orders.append(stop)
    if intent.take_profit is not None:
        tp = factories["limit"](exit_side, qty, intent.take_profit)
        tp.parentId = parent_id
        tp.tif = "GTC"
        tp.orderRef = intent.intent_id
        orders.append(tp)
    for o in orders:
        o.transmit = False
    orders[-1].transmit = True  # the last child transmits the whole bracket atomically
    return orders


class Executor:
    def __init__(self, ib_factory: Callable[[], Any] | None = None, lock_dir=None) -> None:
        self._ib_factory = ib_factory
        self._lock_dir = lock_dir
        self.ib: Any = None
        self.stand_down = False  # Desk.kill sets it, Desk.reset clears it: no risk-reducing (guard) orders meanwhile

    def _new_ib(self) -> Any:
        if self._ib_factory:
            return self._ib_factory()
        from ib_async import IB

        return IB()

    def _guard(self, risk_reducing: bool = False) -> Any:
        """Entries: refused under any lock. Risk-reducing exits (options guard): refused only under a lock that
        flattens or forbids them (kill_switch.allows_risk_reducing), or while this process's desk ran a kill
        (stand_down, set by Desk.kill). The paper-endpoint check applies to both."""
        if risk_reducing and self.stand_down:
            raise ExecutionRefused("standing down: the kill switch ran (reset it to resume the options guard)")
        if kill_switch.is_locked(self._lock_dir) and not (risk_reducing and kill_switch.allows_risk_reducing(self._lock_dir)):
            raise ExecutionRefused("trading is LOCKED by the kill switch")
        cfg = load_config()
        ep = resolve_endpoint(cfg)
        if ep.locked or ep.port is None:
            raise ExecutionRefused("endpoint LOCKED: " + "; ".join(ep.reasons))
        return cfg, ep

    async def _ensure(self, risk_reducing: bool = False) -> Any:
        cfg, ep = self._guard(risk_reducing)
        if self.ib is not None and self.ib.isConnected():
            return self.ib
        self.ib = self._new_ib()
        await self.ib.connectAsync(ep.host, ep.port, clientId=cfg.client_ids["exec"], readonly=False, timeout=10)
        return self.ib

    async def place(self, intent: OrderIntent, qty: int, factories: dict[str, Callable[..., Any]] | None = None) -> dict[str, Any]:
        ib = await self._ensure()
        if factories is None:
            from ib_async import LimitOrder, MarketOrder, Stock, StopOrder

            factories = {"limit": LimitOrder, "market": MarketOrder, "stop": StopOrder, "stock": Stock}
        contract = await self._contract(ib, intent, factories)
        orders = build_bracket(intent, qty, ib.client.getReqId(), factories)
        self._guard()  # last look: lock / endpoint, right before the socket call
        trades = [ib.placeOrder(contract, o) for o in orders]
        # Don't report "submitted" until TWS has acknowledged every order: a rejection (e.g. 321 "API is
        # in Read-Only mode") arrives a moment later, and the desk must record it as a failure, not a trade.
        # If the entry filled anyway, await_ack keeps its protection and returns warnings instead.
        warnings = await await_ack(ib, trades)
        res = {"conId": contract.conId, "orders": [{"orderId": t.order.orderId, "type": t.order.orderType,
                                                     "action": t.order.action, "qty": t.order.totalQuantity,
                                                     "status": t.orderStatus.status} for t in trades]}
        if warnings:
            log.warning("order %s filled with problems: %s", intent.intent_id, "; ".join(warnings))
            res["ackWarnings"] = warnings
        return res

    async def _contract(self, ib: Any, intent: OrderIntent, factories: dict[str, Callable[..., Any]]) -> Any:
        if not intent.is_option:
            q = await ib.qualifyContractsAsync(factories["stock"](intent.symbol, "SMART", intent.currency))
            if not q or not getattr(q[0], "conId", 0):
                raise ExecutionRefused(f"could not resolve contract {intent.symbol} {intent.currency}")
            return q[0]
        Option = factories.get("option")
        if Option is None:
            from ib_async import ComboLeg, Contract, Option  # noqa: N811

            factories = {**factories, "option": Option, "combo_leg": ComboLeg, "contract": Contract}
            Option = factories["option"]
        legs = [Option(intent.symbol, l["expiry"], l["strike"], l["right"], "SMART", multiplier=str(intent.multiplier), currency=intent.currency) for l in intent.legs]
        q = await ib.qualifyContractsAsync(*legs)
        if len(q) != len(legs) or not all(getattr(c, "conId", 0) for c in q):
            raise ExecutionRefused(f"could not resolve option leg(s) for {intent.symbol}")
        if intent.sec_type == "OPT":
            return q[0]
        bag = factories["contract"](secType="BAG", symbol=intent.symbol, currency=intent.currency, exchange="SMART")
        bag.comboLegs = [factories["combo_leg"](conId=c.conId, ratio=1, action=l["action"], exchange="SMART") for c, l in zip(q, intent.legs)]
        return bag

    async def close_option(self, contract: Any, qty: float, limit: float | None, ref: str, action: str = "SELL", *,
                           factories: dict[str, Callable[..., Any]] | None = None, sleep: Any = None,
                           ack_timeout: float = ACK_TIMEOUT_S) -> dict[str, Any]:
        """Risk-reducing exit for a held long option / spread (premium stop or expiry flatten).
        Refused while LOCKED (the kill switch already flattened at market).

        Waits for TWS to acknowledge the exit, like an entry, but a TWS warning alone doesn't cancel it (it's still
        working, and cancelling would undo the risk reduction). A refusal, or no acknowledgement, cancels it and raises
        ExecutionRefused, so the options guard doesn't record a stop that isn't there and retries on its next pass.
        Allowed under a lock-only circuit breaker (kill_switch.allows_risk_reducing), never after a kill-switch flatten."""
        ib = await self._ensure(risk_reducing=True)
        if factories is None:
            from ib_async import LimitOrder, MarketOrder

            factories = {"limit": LimitOrder, "market": MarketOrder}
        if action not in ("BUY", "SELL"):
            raise ExecutionRefused("close action must be BUY (cover a short leg) or SELL (close a long)")
        order = factories["limit"](action, qty, limit) if limit else factories["market"](action, qty)
        order.tif = "DAY"
        order.orderRef = ref
        if getattr(contract, "secType", "") != "BAG" and not getattr(contract, "exchange", ""):
            contract.exchange = "SMART"
        self._guard(risk_reducing=True)  # last look, right before the socket call
        t = ib.placeOrder(contract, order)
        warnings = await await_ack(ib, [t], timeout=ack_timeout, sleep=sleep, refuse_warnings=False, what="exit")
        res = {"orderId": t.order.orderId, "type": t.order.orderType, "qty": qty, "limit": limit, "status": t.orderStatus.status}
        if warnings:
            log.warning("exit %s: %s", ref, "; ".join(warnings))
            res["ackWarnings"] = warnings
        return res

    async def cancel_working(self, *, ref: str | None = None, con_ids: set[int] | None = None, symbol: str | None = None) -> int:
        """Cancel working orders by orderRef, by contract conId, or (combos) by underlying symbol.
        Used before a guard exit so a resting take-profit can't fill afterwards and open a short. Cancel-only, so
        allowed wherever the guard's exits are (kill_switch.allows_risk_reducing)."""
        ib = await self._ensure(risk_reducing=True)
        await ib.reqAllOpenOrdersAsync()
        n = 0
        for t in ib.openTrades():
            if t.orderStatus.status in ("Filled", "Cancelled", "ApiCancelled", "Inactive"):
                continue
            hit = (ref and t.order.orderRef == ref) or (con_ids and t.contract.conId in con_ids)                 or (symbol and t.contract.secType in ("OPT", "BAG") and t.contract.symbol == symbol and not (t.order.orderRef or "").startswith("GUARD-"))
            if hit:
                ib.cancelOrder(t.order)
                n += 1
        return n

    async def working_qty(self, ref: str) -> float:
        """How much of orderRef `ref` TWS has working right now (a fresh reqAllOpenOrders, not the bridge's polled
        snapshot). A not-done order without a positive `remaining` yet (no orderStatus) counts as quantity - filled.
        Read-only, so allowed wherever the guard's exits are."""
        ib = await self._ensure(risk_reducing=True)
        await ib.reqAllOpenOrdersAsync()
        total = 0.0
        for t in ib.openTrades():
            if (getattr(t.order, "orderRef", "") or "") != ref or t.isDone():
                continue
            rem = float(t.orderStatus.remaining or 0)
            total += rem if rem > 0 else max(float(t.order.totalQuantity or 0) - float(t.orderStatus.filled or 0), 0.0)
        return total

    async def cancel_ids(self, order_ids: list[int], wait_s: float = 10.0, sleep: Any = None) -> list[dict[str, Any]]:
        """Cancel THIS client's (13) working orders by id — for desk-cli / the overseer, which can't cancel
        another client id's orders. Risk-reducing, so allowed while LOCKED (the endpoint gate still applies;
        nothing is ever placed here). Returns [{orderId, status}] after waiting for TWS to confirm."""
        import asyncio
        import time

        sleep = sleep or asyncio.sleep
        cfg = load_config()
        ep = resolve_endpoint(cfg)
        if ep.locked or ep.port is None:
            raise ExecutionRefused("endpoint LOCKED: " + "; ".join(ep.reasons))
        if self.ib is None or not self.ib.isConnected():
            self.ib = self._new_ib()
            await self.ib.connectAsync(ep.host, ep.port, clientId=cfg.client_ids["exec"], readonly=False, timeout=10)
        ib = self.ib
        await asyncio.wait_for(ib.reqOpenOrdersAsync(), 8)  # bind this client's own working orders
        want = {int(i) for i in order_ids}
        mine = {t.order.orderId: t for t in ib.openTrades() if t.order.orderId in want and t.order.clientId == cfg.client_ids["exec"]}
        out: dict[int, str] = {}
        for oid in want:
            t = mine.get(oid)
            if t is None:
                out[oid] = "NotWorking"  # already done, or not ours: the caller's own book check decides
            elif t.orderStatus.status not in REJECTED and not t.isDone():
                ib.cancelOrder(t.order)
        deadline = time.monotonic() + wait_s
        while any(not t.isDone() for t in mine.values()) and time.monotonic() < deadline:
            await sleep(0.2)
        for oid, t in mine.items():
            out[oid] = t.orderStatus.status or "Unknown"
        return [{"orderId": k, "status": v} for k, v in sorted(out.items())]

    def disconnect(self) -> None:
        if self.ib is not None:
            try:
                self.ib.disconnect()
            except Exception:  # noqa: BLE001
                pass
        self.ib = None
