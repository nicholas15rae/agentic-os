"""TWS adapter for desk-cli and the overseer: one small async interface, plain dicts in and out.

`IbAdapter` talks to TWS through ib_async; tests use `tests/fake_tws.FakeTws`, which
implements the same methods. Nothing above this layer imports ib_async.

Client ids (never the GUI's / bridge's 11, 12, 13 or the kill switch's 19):

  overseer      20  read-only: heartbeat probe (reqCurrentTime), quotes, bars, IV
  overseer_act  21  read-write: opened ONLY when an armed overseer must act
  cli           22  read-only: reconcile / snapshot reads (executions, parentId)
  cli_act       23  read-write: opened ONLY after a dual-confirmed destructive command

Every connection first takes an exclusive OS lease on `data/trading/clients/<id>.lease`,
so two CLI invocations, or the CLI and the overseer, can never dial the same client id
(TWS would refuse the second, or worse, a crashed holder's orders would bind to it).
The endpoint itself still comes only from `config.resolve_endpoint()` (paper 7497, loopback).

Dict shapes:
  position  {account, conId, symbol, secType, currency, position, avgCost}
  order     {orderId, permId, clientId, parentId, ocaGroup, conId, symbol, secType, currency, action,
             quantity, orderType, limitPrice, stopPrice, tif, status, filled, remaining, orderRef}
  execution {execId, orderId, permId, clientId, conId, symbol, side, shares, price, time, orderRef}
  quote     {bid, ask, last, close, time}            time = epoch s of the last tick (None if no tick)
  bar       {t, o, h, l, c, v}                       oldest first
"""

from __future__ import annotations

import asyncio
import math
import os
import time
from contextlib import ExitStack
from pathlib import Path
from typing import Any

from config import load_config, resolve_endpoint
from ledger import file_lock

EXTRA_CLIENT_IDS = {"overseer": 20, "overseer_act": 21, "cli": 22, "cli_act": 23, "snapshot": 24, "status": 25}
DONE = {"Filled", "Cancelled", "ApiCancelled", "Inactive"}
STOP_TYPES = {"STP", "STP LMT", "TRAIL", "TRAIL LIMIT"}


class AdapterError(RuntimeError):
    pass


class ReadOnlyAdapter(AdapterError):
    pass


class LeaseBusy(AdapterError):
    pass


class NotOwner(AdapterError):
    """TWS only lets the client id that placed an API order cancel or modify it."""


def client_ids(env: dict[str, str] | None = None) -> dict[str, int]:
    """desk-cli / overseer role ids. They're registered in config.WORKERS (env IBKR_CLIENT_ID_<ROLE>), so
    config.resolve_endpoint() already refuses collisions with the bridge (11), data (12), exec (13), kill (19)."""
    cfg = load_config(env=env) if env is not None else load_config()
    all_ids = dict(cfg.client_ids)
    out = {role: int(all_ids.get(role, default)) for role, default in EXTRA_CLIENT_IDS.items()}
    ids = list(all_ids.values()) + [v for k, v in out.items() if k not in all_ids]
    if cfg.errors or any(i <= 0 for i in ids) or len(set(ids)) != len(ids):
        raise AdapterError(f"client ids must be positive integers and distinct: {all_ids} {list(cfg.errors)}")
    return out


def num(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(f) or math.isinf(f) or abs(f) >= 1e300 else f


class ClientLease:
    """Exclusive, non-blocking lease on one client id. Use as a context manager."""

    def __init__(self, d: Path, client_id: int) -> None:
        self.path = Path(d) / "clients" / f"{client_id}.lease"
        self._stack = ExitStack()

    def __enter__(self) -> "ClientLease":
        try:
            f = self._stack.enter_context(file_lock(self.path, blocking=False))
        except BlockingIOError:
            raise LeaseBusy(f"client id lease {self.path.name} is held by another desk-cli / overseer process") from None
        try:
            f.seek(0)
            f.truncate()
            f.write(f"{os.getpid()} {time.time():.0f}\n".encode())
            f.flush()
        except OSError:
            pass
        return self

    def __exit__(self, *exc: Any) -> None:
        self._stack.close()


class IbAdapter:
    """ib_async-backed adapter. `readonly=True` connects read-only and refuses place/cancel locally too."""

    def __init__(self, client_id: int, *, readonly: bool, d: Path, timeout: float = 10.0, ib_factory: Any = None) -> None:
        self.client_id = client_id
        self.readonly = readonly
        self.d = Path(d)
        self.timeout = timeout
        self._ib_factory = ib_factory
        self.ib: Any = None
        self._lease: ClientLease | None = None

    # ── connection ───────────────────────────────────────────────────
    async def connect(self) -> None:
        if self.ib is not None and self.ib.isConnected():
            return
        cfg = load_config()
        ep = resolve_endpoint(cfg)
        if ep.locked or ep.port is None:
            raise AdapterError("endpoint LOCKED: " + "; ".join(ep.reasons))
        if self._lease is None:
            self._lease = ClientLease(self.d, self.client_id)
            try:
                self._lease.__enter__()
            except LeaseBusy:
                self._lease = None
                raise
        if self._ib_factory:
            self.ib = self._ib_factory()
        else:
            from ib_async import IB

            self.ib = IB()
        try:
            await self.ib.connectAsync(ep.host, ep.port, clientId=self.client_id, readonly=self.readonly, timeout=self.timeout)
        except Exception:
            self.disconnect()
            raise
        accounts = list(self.ib.managedAccounts())
        from config import is_paper_account

        if not accounts or any(not is_paper_account(a) for a in accounts):
            self.disconnect()
            raise AdapterError(f"refusing non-paper account(s): {accounts}")
        self.ib.reqMarketDataType(cfg.market_data_type)

    def disconnect(self) -> None:
        if self.ib is not None:
            try:
                self.ib.disconnect()
            except Exception:  # noqa: BLE001
                pass
        self.ib = None
        if self._lease is not None:
            self._lease.__exit__(None, None, None)
            self._lease = None

    def is_connected(self) -> bool:
        return self.ib is not None and self.ib.isConnected()

    async def _ensure(self) -> Any:
        if not self.is_connected():
            await self.connect()
        return self.ib

    # ── reads ────────────────────────────────────────────────────────
    async def current_time(self) -> float:
        ib = await self._ensure()
        t = await asyncio.wait_for(ib.reqCurrentTimeAsync(), 5)
        return t.timestamp()

    async def positions(self) -> list[dict[str, Any]]:
        ib = await self._ensure()
        rows = await asyncio.wait_for(ib.reqPositionsAsync(), 8)
        out = []
        for p in rows:
            q = num(p.position)
            if not q:
                continue
            c = p.contract
            out.append({"account": p.account, "conId": c.conId, "symbol": c.localSymbol or c.symbol, "underlying": c.symbol,
                        "secType": c.secType, "currency": c.currency, "position": q, "avgCost": num(p.avgCost)})
        return out

    async def open_orders(self) -> list[dict[str, Any]]:
        ib = await self._ensure()
        trades = await asyncio.wait_for(ib.reqAllOpenOrdersAsync(), 8)
        # Other clients' orders in ib's cache are never updated after they're first seen (TWS doesn't send
        # this client their later orderStatus), so only the fresh reqAllOpenOrders reply counts for them.
        own = [t for t in ib.openTrades() if t.order.clientId == self.client_id]
        seen, out = set(), []
        for t in list(trades) + own:
            o, c, st = t.order, t.contract, t.orderStatus
            key = o.permId or (o.clientId, o.orderId)
            if key in seen or st.status in DONE:
                continue
            seen.add(key)
            out.append({"orderId": o.orderId, "permId": o.permId, "clientId": o.clientId, "parentId": o.parentId,
                        "ocaGroup": o.ocaGroup or "", "conId": c.conId, "symbol": c.localSymbol or c.symbol, "underlying": c.symbol,
                        "secType": c.secType, "currency": c.currency, "action": o.action, "quantity": num(o.totalQuantity),
                        "orderType": o.orderType, "limitPrice": num(o.lmtPrice) or None, "stopPrice": num(o.auxPrice) or None,
                        # Before TWS sends the first orderStatus, remaining reads 0: fall back to the order size.
                        "tif": o.tif, "status": st.status, "filled": num(st.filled),
                        "remaining": num(st.remaining) if (num(st.remaining) or num(st.filled)) else num(o.totalQuantity),
                        "orderRef": o.orderRef or ""})
        return out

    async def executions(self) -> list[dict[str, Any]]:
        ib = await self._ensure()
        fills = await asyncio.wait_for(ib.reqExecutionsAsync(), 10)
        out = []
        for f in fills:
            ex, c = f.execution, f.contract
            t = getattr(f, "time", None) or getattr(ex, "time", None)
            out.append({"execId": ex.execId, "orderId": ex.orderId, "permId": ex.permId, "clientId": ex.clientId,
                        "conId": c.conId, "symbol": c.localSymbol or c.symbol, "side": ex.side, "shares": num(ex.shares),
                        "price": num(ex.price), "time": t.timestamp() if hasattr(t, "timestamp") else None,
                        "orderRef": ex.orderRef or ""})
        return out

    async def _stock(self, symbol: str, currency: str) -> Any:
        from ib_async import Stock

        ib = await self._ensure()
        q = await asyncio.wait_for(ib.qualifyContractsAsync(Stock(symbol, "SMART", currency)), 8)
        if not q or not getattr(q[0], "conId", 0):
            raise AdapterError(f"unknown contract {symbol} {currency}")
        return q[0]

    async def quote(self, symbol: str, currency: str = "USD", wait_s: float = 8.0) -> dict[str, Any]:
        ib = await self._ensure()
        c = await self._stock(symbol, currency)
        t = ib.reqMktData(c, "", False, False)
        # ib_async reuses one Ticker per contract and cancelMktData doesn't clear it: wipe the last
        # subscription's values before yielding to the loop, so only ticks of THIS request count.
        nan = float("nan")
        t.bid = t.ask = t.last = t.close = nan
        t.time = None
        try:
            deadline = time.monotonic() + wait_s
            while time.monotonic() < deadline:
                await asyncio.sleep(0.2)
                if num(t.bid) and num(t.ask) and t.time:
                    break
        finally:
            ib.cancelMktData(c)
        ts = t.time.timestamp() if getattr(t, "time", None) else None
        return {"bid": num(t.bid), "ask": num(t.ask), "last": num(t.last), "close": num(t.close), "time": ts}

    async def implied_vol(self, symbol: str, currency: str = "USD", wait_s: float = 6.0) -> float | None:
        """30-day implied vol of the underlying (generic tick 106), annualised fraction; None if TWS has none."""
        ib = await self._ensure()
        c = await self._stock(symbol, currency)
        t = ib.reqMktData(c, "106", False, False)
        t.impliedVolatility = float("nan")  # see quote(): don't return a previous subscription's value
        try:
            deadline = time.monotonic() + wait_s
            while time.monotonic() < deadline and not num(t.impliedVolatility):
                await asyncio.sleep(0.25)
        finally:
            ib.cancelMktData(c)
        return num(t.impliedVolatility)

    async def bars(self, symbol: str, currency: str = "USD", bar_size: str = "1 min", duration: str = "7200 S",
                   use_rth: bool = True) -> list[dict[str, Any]]:
        ib = await self._ensure()
        c = await self._stock(symbol, currency)
        raw = await asyncio.wait_for(ib.reqHistoricalDataAsync(c, "", duration, bar_size, "TRADES", use_rth, formatDate=2), 60)
        out = []
        for b in raw or []:
            d = b.date
            ts = d.timestamp() if hasattr(d, "timestamp") else time.mktime(time.strptime(str(d), "%Y-%m-%d"))
            out.append({"t": ts, "o": num(b.open), "h": num(b.high), "l": num(b.low), "c": num(b.close), "v": num(b.volume) or 0.0})
        return out

    # ── writes (read-write adapters only) ────────────────────────────
    def _require_rw(self) -> None:
        if self.readonly:
            raise ReadOnlyAdapter(f"client {self.client_id} is read-only; refusing to touch orders")

    async def place_order(self, spec: dict[str, Any]) -> dict[str, Any]:
        """spec: {conId, symbol, currency, secType, action, quantity, orderType MKT|LMT|STP, limitPrice?, stopPrice?,
        tif, orderRef}. Returns {orderId, status}. Caller is responsible for the reduce-only check."""
        self._require_rw()
        from ib_async import Contract, LimitOrder, MarketOrder, StopOrder

        ib = await self._ensure()
        c = Contract(conId=int(spec["conId"]), exchange="SMART")
        q = await asyncio.wait_for(ib.qualifyContractsAsync(c), 8)
        if not q or not getattr(q[0], "conId", 0):
            raise AdapterError(f"could not qualify conId {spec['conId']}")
        typ, act, qty = spec["orderType"], spec["action"], float(spec["quantity"])
        if typ == "MKT":
            o = MarketOrder(act, qty)
        elif typ == "LMT":
            o = LimitOrder(act, qty, float(spec["limitPrice"]))
        elif typ == "STP":
            o = StopOrder(act, qty, float(spec["stopPrice"]))
        else:
            raise AdapterError(f"unsupported order type {typ}")
        o.tif = spec.get("tif", "DAY")
        o.orderRef = spec.get("orderRef", "")
        t = ib.placeOrder(q[0], o)
        return {"orderId": t.order.orderId, "status": t.orderStatus.status}

    async def cancel_order(self, order_id: int) -> None:
        """Cancel one of THIS client id's working orders. TWS only lets the placing client id cancel an
        API order, so orders owned by another id raise NotOwner (see safety_actions' owner routing)."""
        self._require_rw()
        ib = await self._ensure()
        await asyncio.wait_for(ib.reqOpenOrdersAsync(), 8)  # binds this client's own working orders
        for t in ib.openTrades():
            if t.order.orderId == order_id and t.order.clientId == self.client_id and t.orderStatus.status not in DONE:
                ib.cancelOrder(t.order)
                return
        raise NotOwner(f"order {order_id} is not a working order of client {self.client_id}")

    async def global_cancel(self) -> None:
        """reqGlobalCancel: every working order of every client AND manual TWS orders. Brackets included."""
        self._require_rw()
        ib = await self._ensure()
        ib.reqGlobalCancel()

    async def order_status(self, order_id: int) -> dict[str, Any]:
        """Status of THIS client's order `order_id` (order ids are only unique per client id)."""
        ib = await self._ensure()
        for t in ib.trades():
            if t.order.orderId == order_id and t.order.clientId == self.client_id:
                return {"orderId": order_id, "status": t.orderStatus.status, "filled": num(t.orderStatus.filled),
                        "remaining": num(t.orderStatus.remaining)}
        return {"orderId": order_id, "status": "Unknown", "filled": None, "remaining": None}
