"""Mocked TWS for desk-cli / overseer / safety-action tests. No sockets, no ib_async.

`FakeBroker` is the shared broker state (positions, working orders, executions, quotes,
bars). `FakeTws(broker, client_id, readonly)` is one API client: it implements the same
async methods as `tws_adapter.IbAdapter`, including TWS's ownership rule (only the placing
client id may cancel an API order) and read-only refusal. Every state-changing call is
recorded in `broker.actions`, so a test can prove that a read-only path changed nothing.
"""

from __future__ import annotations

import itertools
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "trading"))

from tws_adapter import DONE, AdapterError, NotOwner, ReadOnlyAdapter  # noqa: E402


class FakeBroker:
    def __init__(self, now: float = 1_800_000_000.0) -> None:
        self.now = now
        self.positions: dict[int, dict[str, Any]] = {}   # conId -> position dict
        self.orders: dict[int, dict[str, Any]] = {}      # orderId -> order dict
        self.executions: list[dict[str, Any]] = []
        self.quotes: dict[str, dict[str, Any]] = {}
        self.bars: dict[str, list[dict[str, Any]]] = {}
        self.ivs: dict[str, float | None] = {}
        self.actions: list[tuple] = []
        self.up = True                       # TWS reachable
        self.busy_clients: set[int] = set()  # ids already connected elsewhere (connect refused, like TWS error 326)
        self.connected: set[int] = set()
        self.reject_types: set[str] = set()  # order types TWS rejects (status Inactive)
        self._ids = itertools.count(100)
        self._exec = itertools.count(1)

    # ── setup helpers ────────────────────────────────────────────────
    def add_position(self, symbol: str, qty: float, avg: float, con_id: int, currency: str = "USD") -> dict[str, Any]:
        p = {"account": "DU123", "conId": con_id, "symbol": symbol, "underlying": symbol, "secType": "STK",
             "currency": currency, "position": float(qty), "avgCost": float(avg)}
        self.positions[con_id] = p
        return p

    def add_order(self, symbol: str, con_id: int, action: str, qty: float, order_type: str, *, client_id: int = 13,
                  limit: float | None = None, stop: float | None = None, tif: str = "GTC", ref: str = "",
                  parent_id: int = 0, status: str = "Submitted", order_id: int | None = None) -> dict[str, Any]:
        oid = order_id or next(self._ids)
        o = {"orderId": oid, "permId": 9000 + oid, "clientId": client_id, "parentId": parent_id, "ocaGroup": "",
             "conId": con_id, "symbol": symbol, "underlying": symbol, "secType": "STK", "currency": "USD", "action": action,
             "quantity": float(qty), "orderType": order_type, "limitPrice": limit, "stopPrice": stop, "tif": tif,
             "status": status, "filled": 0.0, "remaining": float(qty), "orderRef": ref}
        self.orders[oid] = o
        return o

    def add_bracket(self, symbol: str, con_id: int, qty: float, entry: float, stop: float, tp: float | None,
                    *, ref: str, client_id: int = 13, filled: bool = True) -> list[dict[str, Any]]:
        """A desk bracket. filled=True: parent filled → position + resting GTC children."""
        side, exit_side = ("BUY", "SELL") if qty > 0 else ("SELL", "BUY")
        parent = self.add_order(symbol, con_id, side, abs(qty), "LMT", client_id=client_id, limit=entry, tif="DAY", ref=ref,
                                status="Filled" if filled else "Submitted")
        kids = [self.add_order(symbol, con_id, exit_side, abs(qty), "STP", client_id=client_id, stop=stop, ref=ref,
                               parent_id=parent["orderId"], status="PreSubmitted")]
        if tp is not None:
            kids.append(self.add_order(symbol, con_id, exit_side, abs(qty), "LMT", client_id=client_id, limit=tp, ref=ref,
                                       parent_id=parent["orderId"], status="PreSubmitted" if not filled else "Submitted"))
        if filled:
            parent["filled"], parent["remaining"] = abs(qty), 0.0
            cur = self.positions.get(con_id)
            if cur:
                cur["position"] += qty
            else:
                self.add_position(symbol, qty, entry, con_id)
            self._execute(parent, abs(qty), entry)
        return [parent, *kids]

    def set_quote(self, symbol: str, bid: float, ask: float, last: float | None = None, age_s: float = 1.0) -> None:
        self.quotes[symbol] = {"bid": bid, "ask": ask, "last": last if last is not None else (bid + ask) / 2,
                               "close": None, "time": self.now - age_s}

    def _execute(self, o: dict[str, Any], qty: float, price: float) -> None:
        n = next(self._exec)
        self.executions.append({"execId": f"E{n}", "orderId": o["orderId"], "permId": o["permId"], "clientId": o["clientId"],
                                "conId": o["conId"], "symbol": o["symbol"], "side": "BOT" if o["action"] == "BUY" else "SLD",
                                "shares": qty, "price": price, "time": self.now, "orderRef": o["orderRef"]})

    def working(self) -> list[dict[str, Any]]:
        return [dict(o) for o in self.orders.values() if o["status"] not in DONE]

    def fill(self, order_id: int, price: float) -> None:
        """Simulate a resting order filling (and TWS cancelling its OCA siblings)."""
        o = self.orders[order_id]
        qty = o["remaining"]
        o.update(status="Filled", filled=o["quantity"], remaining=0.0)
        signed = qty if o["action"] == "BUY" else -qty
        p = self.positions.get(o["conId"])
        if p:
            p["position"] += signed
            if not p["position"]:
                del self.positions[o["conId"]]
        else:
            self.add_position(o["symbol"], signed, price, o["conId"])
        self._execute(o, qty, price)
        if o["parentId"]:
            for sib in self.orders.values():
                if sib["parentId"] == o["parentId"] and sib["orderId"] != order_id and sib["status"] not in DONE:
                    sib["status"] = "Cancelled"


class FakeTws:
    def __init__(self, broker: FakeBroker, client_id: int, readonly: bool = True) -> None:
        self.b = broker
        self.client_id = client_id
        self.readonly = readonly
        self._connected = False

    async def connect(self) -> None:
        if not self.b.up:
            raise ConnectionRefusedError("TWS not reachable (fake)")
        if self.client_id in self.b.busy_clients or self.client_id in self.b.connected:
            raise AdapterError(f"client id {self.client_id} already in use (fake error 326)")
        self.b.connected.add(self.client_id)
        self._connected = True

    def disconnect(self) -> None:
        if self._connected:
            self.b.connected.discard(self.client_id)
        self._connected = False

    def is_connected(self) -> bool:
        return self._connected and self.b.up

    async def _ensure(self) -> None:
        if not self.b.up:
            self._connected = False
            raise ConnectionRefusedError("TWS not reachable (fake)")
        if not self._connected:
            await self.connect()

    async def current_time(self) -> float:
        await self._ensure()
        return self.b.now

    async def positions(self) -> list[dict[str, Any]]:
        await self._ensure()
        return [dict(p) for p in self.b.positions.values()]

    async def open_orders(self) -> list[dict[str, Any]]:
        await self._ensure()
        return self.b.working()

    async def executions(self) -> list[dict[str, Any]]:
        await self._ensure()
        return [dict(e) for e in self.b.executions]

    async def quote(self, symbol: str, currency: str = "USD", wait_s: float = 0) -> dict[str, Any]:
        await self._ensure()
        q = self.b.quotes.get(symbol)
        if q is None:
            return {"bid": None, "ask": None, "last": None, "close": None, "time": None}
        return dict(q)

    async def implied_vol(self, symbol: str, currency: str = "USD", wait_s: float = 0) -> float | None:
        await self._ensure()
        return self.b.ivs.get(symbol)

    async def bars(self, symbol: str, currency: str = "USD", bar_size: str = "1 min", duration: str = "7200 S",
                   use_rth: bool = True) -> list[dict[str, Any]]:
        await self._ensure()
        key = f"{symbol}:{bar_size}"
        return [dict(x) for x in self.b.bars.get(key, self.b.bars.get(symbol, []))]

    def _require_rw(self) -> None:
        if self.readonly:
            raise ReadOnlyAdapter(f"client {self.client_id} is read-only; refusing to touch orders")

    async def place_order(self, spec: dict[str, Any]) -> dict[str, Any]:
        self._require_rw()
        await self._ensure()
        self.b.actions.append(("place", self.client_id, dict(spec)))
        sym = spec.get("symbol") or next((p["symbol"] for p in self.b.positions.values() if p["conId"] == spec["conId"]), "?")
        o = self.b.add_order(sym, int(spec["conId"]), spec["action"], float(spec["quantity"]), spec["orderType"],
                             client_id=self.client_id, limit=spec.get("limitPrice"), stop=spec.get("stopPrice"),
                             tif=spec.get("tif", "DAY"), ref=spec.get("orderRef", ""))
        if spec["orderType"] in self.b.reject_types:
            o["status"] = "Inactive"
            return {"orderId": o["orderId"], "status": "Inactive"}
        if spec["orderType"] == "MKT":
            q = self.b.quotes.get(sym) or {}
            px = (q.get("bid") if spec["action"] == "SELL" else q.get("ask")) or q.get("last") or 0.0
            self.b.fill(o["orderId"], px)
        return {"orderId": o["orderId"], "status": self.b.orders[o["orderId"]]["status"]}

    async def cancel_order(self, order_id: int) -> None:
        self._require_rw()
        await self._ensure()
        o = self.b.orders.get(order_id)
        if o is None or o["status"] in DONE:
            raise NotOwner(f"order {order_id} is not a working order of client {self.client_id}")
        if o["clientId"] != self.client_id:
            raise NotOwner(f"order {order_id} belongs to client {o['clientId']}, not {self.client_id}")
        self.b.actions.append(("cancel", self.client_id, order_id))
        o["status"] = "Cancelled"

    async def global_cancel(self) -> None:
        self._require_rw()
        await self._ensure()
        self.b.actions.append(("global_cancel", self.client_id))
        for o in self.b.orders.values():
            if o["status"] not in DONE:
                o["status"] = "Cancelled"

    async def order_status(self, order_id: int) -> dict[str, Any]:
        await self._ensure()
        o = self.b.orders.get(order_id)
        if not o:
            return {"orderId": order_id, "status": "Unknown", "filled": None, "remaining": None}
        return {"orderId": order_id, "status": o["status"], "filled": o["filled"], "remaining": o["remaining"]}


def factory(broker: FakeBroker):
    """adapter_factory(client_id, readonly) for code that opens its own adapters."""

    def make(client_id: int, readonly: bool) -> FakeTws:
        return FakeTws(broker, client_id, readonly)

    return make
