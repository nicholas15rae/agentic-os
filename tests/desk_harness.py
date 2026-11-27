"""Shared harness for desk-cli / overseer tests: a temp data dir, a mocked TWS, a fake bridge and a
scripted Command Center probe. Nothing here touches the real data dir, TWS, the bridge or the gateway."""

from __future__ import annotations

import io
import json
import sqlite3
import sys
import tempfile
import time
import urllib.error
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "trading"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from fake_tws import FakeBroker, factory  # noqa: E402

NOW = float(int(time.time()))  # real wall time: the ledger stamps rows with time.time(), breakers window on the clock
IDS = {"overseer": 20, "overseer_act": 21, "cli": 22, "cli_act": 23, "snapshot": 24, "status": 25}

INTENTS_DDL = """CREATE TABLE IF NOT EXISTS intents (intent_id TEXT PRIMARY KEY, status TEXT NOT NULL, symbol TEXT NOT NULL,
 action TEXT NOT NULL, quantity INTEGER NOT NULL, intent TEXT NOT NULL, decision TEXT NOT NULL, result TEXT,
 created REAL NOT NULL, updated REAL NOT NULL)"""


class ScriptedProbe:
    def __init__(self, state: str = "RUNNING", pid: int = 4242) -> None:
        self.state, self.pid, self.exit_code = state, pid, None

    def poll(self) -> dict[str, Any]:
        return {"state": self.state, "pid": self.pid, "exitCode": self.exit_code, "detail": "scripted"}


async def nosleep(_s: float) -> None:
    return None


class Env:
    def __init__(self, policy: dict[str, Any] | None = None) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.d = Path(self.tmp.name)
        self.b = FakeBroker(now=NOW)
        self.clock = [NOW]
        self.bridge_up = True
        self.bridge_frozen_at: float | None = None
        self.nlv, self.daily = 100_000.0, 0.0
        self.cc = ScriptedProbe()
        self.bridge_cancels = []
        pol = {"master_stop": {"eval_interval_s": 5, "tier2_confirm_evals": 3}, "dead_mans_switch": {"grace_s": 30}}
        for k, v in (policy or {}).items():
            pol.setdefault(k, {}).update(v)
        (self.d / "risk-policy.json").write_text(json.dumps(pol), encoding="utf-8")
        (self.d / "state.json").write_text(json.dumps({"mode": "SEMI_AUTO", "agentHalted": False}), encoding="utf-8")
        c = sqlite3.connect(self.d / "desk.db")
        c.execute(INTENTS_DDL)
        c.commit()
        c.close()

    def close(self) -> None:
        self.tmp.cleanup()

    # ── desk.db ──────────────────────────────────────────────────────
    def add_intent(self, iid: str, symbol: str, qty: int, orders: list[dict[str, Any]], status: str = "submitted", action: str = "BUY") -> None:
        res = {"conId": orders[0]["conId"] if orders else None, "orders": [{"orderId": o["orderId"], "type": o["orderType"]} for o in orders]}
        c = sqlite3.connect(self.d / "desk.db")
        c.execute("INSERT INTO intents VALUES (?,?,?,?,?,?,?,?,?,?)",
                  (iid, status, symbol, action, qty, "{}", "{}", json.dumps(res), self.clock[0], self.clock[0]))
        c.commit()
        c.close()

    def intent_status(self, iid: str) -> str:
        c = sqlite3.connect(self.d / "desk.db")
        try:
            return c.execute("SELECT status FROM intents WHERE intent_id = ?", (iid,)).fetchone()[0]
        finally:
            c.close()

    # ── market ───────────────────────────────────────────────────────
    def position_with_bracket(self, symbol: str, con: int, qty: float, entry: float, stop: float, tp: float | None,
                              client_id: int = 30, ref: str | None = None) -> list[dict[str, Any]]:
        ref = ref or f"intent-{symbol.lower()}-001"
        orders = self.b.add_bracket(symbol, con, qty, entry, stop, tp, ref=ref, client_id=client_id)
        self.add_intent(ref, symbol, int(abs(qty)), orders, action="BUY" if qty > 0 else "SELL")
        self.market(symbol, entry)
        return orders

    def market(self, symbol: str, price: float, *, slope_per_bar: float = 0.0, vol: float = 1000.0, surge: float = 1.0,
               atr_pct: float = 1.0, n: int = 60) -> None:
        """Quote + 1-min bars ending now at `price` with the given slope, and 30 daily bars with ~atr_pct ATR."""
        now = self.clock[0]
        self.b.set_quote(symbol, round(price - 0.01, 2), round(price + 0.01, 2), price, age_s=1.0)
        bars = []
        for i in range(n):
            c = price + slope_per_bar * (n - 1 - i)  # slope_per_bar > 0 = price FALLING into `price`
            v = vol * (surge if i >= n - 3 else 1.0)
            bars.append({"t": now - 60 * (n - 1 - i), "o": c, "h": c * 1.0005, "l": c * 0.9995, "c": c, "v": v})
        self.b.bars[f"{symbol}:1 min"] = bars
        half = atr_pct / 200
        self.b.bars[f"{symbol}:1 day"] = [{"t": now - 86400 * (30 - i), "o": price, "h": price * (1 + half), "l": price * (1 - half),
                                           "c": price, "v": 5e6} for i in range(30)]

    def advance(self, s: float) -> None:
        self.clock[0] += s
        self.b.now = self.clock[0]
        for q in self.b.quotes.values():
            q["time"] = self.clock[0] - 1.0
        for k, bars in self.b.bars.items():
            if k.endswith(":1 min") and bars:
                shift = self.clock[0] - bars[-1]["t"]
                for x in bars:
                    x["t"] += shift

    # ── bridge ───────────────────────────────────────────────────────
    def bridge_get(self, path: str) -> dict[str, Any]:
        if not self.bridge_up:
            raise urllib.error.URLError("connection refused (fake)")
        if path == "/health":
            return {"ok": True, "state": "CONNECTED" if self.b.up else "RECONNECTING"}
        if path == "/status":
            pos = []
            for p in self.b.positions.values():
                q = self.b.quotes.get(p["symbol"]) or {}
                mark = q.get("last") or p["avgCost"]
                pos.append({**p, "marketPrice": mark, "marketValue": mark * p["position"],
                            "unrealizedPnl": round((mark - p["avgCost"]) * p["position"], 2)})
            return {"state": "CONNECTED" if self.b.up else "RECONNECTING", "mode": "PAPER", "port": 7497, "clientId": 11,
                    "updatedAt": self.bridge_frozen_at if self.bridge_frozen_at is not None else self.clock[0],
                    "account": {"account": "DU123", "currency": "USD", "netLiquidation": self.nlv},
                    "pnl": {"daily": self.daily, "unrealized": None, "realized": None},
                    "positions": pos, "openOrders": self.b.working(), "fills": []}
        raise urllib.error.URLError(f"404 {path}")

    # ── components ───────────────────────────────────────────────────
    def fake_bridge_cancel(self, order_ids, reason):
        """Stands in for the bridge's POST /orders/cancel: the executor (13) cancels its own orders."""
        if not self.bridge_route:
            raise urllib.error.HTTPError("http://127.0.0.1/orders/cancel", 404, "Not Found", None, None)
        self.bridge_cancels.append((list(order_ids), reason))
        out = []
        for oid in order_ids:
            o = self.b.orders.get(oid)
            if o and o["clientId"] == 13 and o["status"] not in ("Filled", "Cancelled", "ApiCancelled", "Inactive"):
                o["status"] = "Cancelled"
            out.append({"orderId": oid, "status": o["status"] if o and o["clientId"] == 13 else "NotWorking"})
        return {"ok": True, "results": out}

    # Never the real HTTP route in tests: None (no route) unless a test opts into the fake.
    bridge_route = False
    bridge_cancels: list = []

    def _bc(self):
        return self.fake_bridge_cancel if self.bridge_route else None

    def overseer(self):
        from overseer import Overseer

        return Overseer(self.d, adapter_factory=factory(self.b), bridge_get=self.bridge_get, cc_probe=self.cc,
                        clock=lambda: self.clock[0], sleep=nosleep, ids=dict(IDS), bridge_cancel=self._bc())

    def deps(self, stdin: str = "", tty: bool = False):
        from desk_cli import Deps

        return Deps(d=self.d, adapter_factory=factory(self.b), bridge_get=self.bridge_get, clock=lambda: self.clock[0],
                    stdin=io.StringIO(stdin), stdout=io.StringIO(), stderr=io.StringIO(), is_tty=lambda: tty, sleep=nosleep,
                    cc_probe=self.cc, ids=dict(IDS), bridge_cancel=self._bc())

    def cli(self, argv: list[str], stdin: str = "", tty: bool = False) -> tuple[int, str, str]:
        from desk_cli import main

        deps = self.deps(stdin, tty)
        code = main(argv, deps)
        return code, deps.stdout.getvalue(), deps.stderr.getvalue()

    def ledger(self):
        from ledger import Ledger

        return Ledger(self.d / "ledger.jsonl")

    def arm(self) -> None:
        from overseer import set_armed

        set_armed(self.d, True, "test")
