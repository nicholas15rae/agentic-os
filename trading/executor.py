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

from typing import Any, Callable

from config import load_config, resolve_endpoint
from intents import OrderIntent
import kill_switch


class ExecutionRefused(RuntimeError):
    pass


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

    def _new_ib(self) -> Any:
        if self._ib_factory:
            return self._ib_factory()
        from ib_async import IB

        return IB()

    def _guard(self) -> Any:
        if kill_switch.is_locked(self._lock_dir):
            raise ExecutionRefused("trading is LOCKED by the kill switch")
        cfg = load_config()
        ep = resolve_endpoint(cfg)
        if ep.locked or ep.port is None:
            raise ExecutionRefused("endpoint LOCKED: " + "; ".join(ep.reasons))
        return cfg, ep

    async def _ensure(self) -> Any:
        cfg, ep = self._guard()
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
        return {"conId": contract.conId, "orders": [{"orderId": t.order.orderId, "type": t.order.orderType,
                                                      "action": t.order.action, "qty": t.order.totalQuantity,
                                                      "status": t.orderStatus.status} for t in trades]}

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

    async def close_option(self, contract: Any, qty: float, limit: float | None, ref: str, action: str = "SELL") -> dict[str, Any]:
        """Risk-reducing exit for a held long option / spread (premium stop or expiry flatten).
        Refused while LOCKED (the kill switch already flattened at market)."""
        ib = await self._ensure()
        from ib_async import LimitOrder, MarketOrder

        if action not in ("BUY", "SELL"):
            raise ExecutionRefused("close action must be BUY (cover a short leg) or SELL (close a long)")
        order = LimitOrder(action, qty, limit) if limit else MarketOrder(action, qty)
        order.tif = "DAY"
        order.orderRef = ref
        if getattr(contract, "secType", "") != "BAG" and not getattr(contract, "exchange", ""):
            contract.exchange = "SMART"
        self._guard()
        t = ib.placeOrder(contract, order)
        return {"orderId": t.order.orderId, "type": t.order.orderType, "qty": qty, "limit": limit, "status": t.orderStatus.status}

    async def cancel_working(self, *, ref: str | None = None, con_ids: set[int] | None = None, symbol: str | None = None) -> int:
        """Cancel working orders by orderRef, by contract conId, or (combos) by underlying symbol.
        Used before a guard exit so a resting take-profit can't fill afterwards and open a short."""
        ib = await self._ensure()
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

    def disconnect(self) -> None:
        if self.ib is not None:
            try:
                self.ib.disconnect()
            except Exception:  # noqa: BLE001
                pass
        self.ib = None
