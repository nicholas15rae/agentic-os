"""Phase 2: OrderIntent schema, Security Detail, audit chain, kill switch, desk modes, Financer-only comms.

Stdlib only. No TWS: the bridge, quotes, executor and IB connections are fakes.
"""

import asyncio
import dataclasses
import json
import sqlite3
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace as NS

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "trading"))

import comms  # noqa: E402
import kill_switch  # noqa: E402
from audit import AuditLog  # noqa: E402
from desk import Desk  # noqa: E402
from executor import build_bracket  # noqa: E402
from fx import SAFETY_MARGIN, FxSource, merged_rates  # noqa: E402
from intents import IntentError, RiskLimits, load_limits, parse_intent  # noqa: E402
from security_detail import APPROVED, MODIFIED, REJECTED, Context, evaluate, session_open_from_hours  # noqa: E402

NOW = 1_795_500_000.0
LIQUID = {"adv_shares": 60_000_000.0, "adv_value": 3.0e10, "volatility_pct": 15.0, "atr_pct": 1.2, "bars": 40.0}


def raw_intent(**over):
    # Default source "manual": the LLM's "trading_agent" source is refused by the desk outright (desk.LLM_SOURCES),
    # so desk-mechanics tests use a source that can still be evaluated; agent-scope tests pass source="trading_agent".
    d = {"intent_id": "intent-0001", "source": "manual", "asset_class": "etf", "symbol": "SPY",
         "action": "BUY", "quantity": 10, "order_type": "LMT", "limit_price": 500.0, "stop_loss": 495.0,
         "take_profit": 510.0, "thesis": "test", "citations": ["rag:1"]}
    d.update(over)
    return d


def ctx(**over):
    base = dict(now=NOW, mode="PAPER", port=7497, connected=True, locked=False, limits=RiskLimits(),
                equity_base=100_000.0, daily_pnl_base=0.0, base_currency="CAD", fx_to_base={"USD": 1.4},
                positions=[], open_orders=[], quote={"bid": 499.95, "ask": 500.05, "last": 500.0},
                market_stats=dict(LIQUID), session_open=True, seen_intent=False, recent=[], orders_today=0,
                # The desk scopes a Trading Agent intent to the watchlist (Phase 5; only for source trading_agent).
                allowed_symbols={"SPY", "QQQ", "IWM", "GLD", "SLV", "USO", "UNG", "DBC"})
    base.update(over)
    return Context(**base)


def failed(decision):
    return {c["name"] for c in decision.checks if not c["ok"]}


class IntentSchemaTests(unittest.TestCase):
    def test_valid(self):
        i = parse_intent(raw_intent())
        self.assertEqual((i.symbol, i.quantity, i.limit_price), ("SPY", 10, 500.0))

    def test_rejects(self):
        bad = [
            raw_intent(extra=1),                                  # unknown field
            {k: v for k, v in raw_intent().items() if k != "stop_loss"},  # every entry needs a stop
            raw_intent(stop_loss=505.0),                          # stop above long entry
            raw_intent(take_profit=499.0),                        # target below long entry
            raw_intent(order_type="MKT"),                         # MKT with a limit price
            raw_intent(order_type="LMT", limit_price=None),
            raw_intent(quantity=0), raw_intent(quantity=1.5), raw_intent(quantity=True),
            raw_intent(symbol="spy; drop"), raw_intent(sec_type="OPT"),
            raw_intent(exchange="ARCA"), raw_intent(intent_id="x"), raw_intent(source="coder"),
        ]
        for b in bad:
            with self.assertRaises(IntentError, msg=b):
                parse_intent(b)

    def test_limits_file_created_and_strict(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "risk_limits.json"
            self.assertEqual(load_limits(p), RiskLimits())
            p.write_text(json.dumps({"max_daily_loss_pct": 250}), encoding="utf-8")
            with self.assertRaises(ValueError):
                load_limits(p)
            p.write_text(json.dumps({"yolo": 1}), encoding="utf-8")
            with self.assertRaises(ValueError):
                load_limits(p)


class SecurityDetailTests(unittest.TestCase):
    def test_approved_baseline(self):
        d = evaluate(parse_intent(raw_intent()), ctx())
        self.assertEqual(d.verdict, APPROVED, d.reasons)
        self.assertEqual(d.quantity, 10)

    def test_oversize_is_cut_not_rejected(self):
        # risk cap = 0.5% * 100k = 500 CAD; per share = 5 USD * 1.4 = 7 CAD → 71 shares; notional cap 10k/(500*1.4) = 14.
        d = evaluate(parse_intent(raw_intent(quantity=1000)), ctx())
        self.assertEqual(d.verdict, MODIFIED)
        self.assertEqual(d.quantity, 14)

    def test_each_hard_check(self):
        cases = {
            "port_mode": dict(port=7496),
            "kill_switch": dict(locked=True),
            "idempotency": dict(seen_intent=True),
            "market_hours": dict(session_open=False),
            "daily_order_cap": dict(orders_today=20),
            "liquidity": dict(quote={"bid": 490.0, "ask": 510.0, "last": 500.0}),
        }
        for name, over in cases.items():
            d = evaluate(parse_intent(raw_intent()), ctx(**over))
            self.assertEqual(d.verdict, REJECTED, name)
            self.assertIn(name, failed(d))
        self.assertIn("port_mode", failed(evaluate(parse_intent(raw_intent()), ctx(mode="LIVE"))))
        self.assertIn("port_mode", failed(evaluate(parse_intent(raw_intent()), ctx(connected=False))))

    def test_missing_data_fails_closed(self):
        for over, name in [(dict(session_open=None), "market_hours"), (dict(quote=None), "liquidity"),
                           (dict(fx_to_base={}), "position_size"), (dict(equity_base=None), "daily_drawdown")]:
            d = evaluate(parse_intent(raw_intent()), ctx(**over))
            self.assertEqual(d.verdict, REJECTED, name)
            self.assertIn(name, failed(d))

    def test_drawdown_trips_kill(self):
        d = evaluate(parse_intent(raw_intent()), ctx(equity_base=97_000.0, daily_pnl_base=-3_000.0))
        self.assertTrue(d.trip_kill)
        self.assertIn("daily_drawdown", failed(d))

    def test_duplicate_and_cooldown(self):
        recent = [{"symbol": "SPY", "action": "BUY", "quantity": 10, "ts": NOW - 30}]
        self.assertTrue({"duplicate", "cooldown"} <= failed(evaluate(parse_intent(raw_intent()), ctx(recent=recent))))
        old = [{"symbol": "SPY", "action": "BUY", "quantity": 10, "ts": NOW - 400}]
        self.assertEqual(evaluate(parse_intent(raw_intent()), ctx(recent=old)).verdict, APPROVED)

    def test_price_drift_and_market_stop_side(self):
        self.assertIn("price_sanity", failed(evaluate(parse_intent(raw_intent(limit_price=520.0, stop_loss=515.0, take_profit=530.0)), ctx())))
        mkt = raw_intent(order_type="MKT", limit_price=None, stop_loss=501.0, take_profit=None)
        self.assertIn("stop_side", failed(evaluate(parse_intent(mkt), ctx())))

    def test_concurrency_and_exposure(self):
        pos = [{"symbol": s, "underlying": s, "position": 1, "marketValue": 100.0, "currency": "USD"} for s in ("A", "B", "C", "D", "E")]
        self.assertIn("concurrent_positions", failed(evaluate(parse_intent(raw_intent()), ctx(positions=pos))))
        # Adding to an already-held symbol doesn't open a new line.
        held = pos[:4] + [{"symbol": "SPY", "underlying": "SPY", "position": 1, "marketValue": 100.0, "currency": "USD"}]
        self.assertNotIn("concurrent_positions", failed(evaluate(parse_intent(raw_intent()), ctx(positions=held))))
        big = [{"symbol": "QQQ", "underlying": "QQQ", "position": 100, "marketValue": 36_000.0, "currency": "USD"}]  # 50.4k CAD
        self.assertIn("gross_exposure", failed(evaluate(parse_intent(raw_intent()), ctx(positions=big))))
        unknown_fx = [{"symbol": "X", "underlying": "X", "position": 1, "marketValue": 1.0, "currency": "EUR"}]
        self.assertIn("gross_exposure", failed(evaluate(parse_intent(raw_intent()), ctx(positions=unknown_fx))))

    def test_financer_allocation_caps_sizing(self):
        lim = dataclasses.replace(RiskLimits(), financer_allocation_base=20_000.0)
        d = evaluate(parse_intent(raw_intent(quantity=1000)), ctx(limits=lim))
        self.assertEqual(d.quantity, 2)  # 10% of 20k = 2k CAD / 700 CAD per share

    def test_liquid_hours(self):
        hours = "20261123:0930-20261123:1600;20261124:CLOSED"
        open_ts = 1_795_446_600.0  # 2026-11-23 10:10 New York
        self.assertTrue(session_open_from_hours(hours, "US/Eastern", open_ts))
        self.assertFalse(session_open_from_hours(hours, "US/Eastern", open_ts + 86400))
        self.assertIsNone(session_open_from_hours("", "US/Eastern", open_ts))


class AuditTests(unittest.TestCase):
    def test_chain_append_only_and_tamper(self):
        with tempfile.TemporaryDirectory() as d:
            a = AuditLog(Path(d) / "audit.db")
            for i in range(3):
                a.append("intent_evaluated", {"i": i}, ref=f"r{i}", verdict="APPROVED")
            self.assertEqual(a.verify_chain(), (True, "ok"))
            c = sqlite3.connect(Path(d) / "audit.db")
            with self.assertRaises(sqlite3.DatabaseError):
                c.execute("UPDATE audit SET verdict='X'")
            with self.assertRaises(sqlite3.DatabaseError):
                c.execute("DELETE FROM audit")
            c.execute("DROP TRIGGER audit_no_update")
            c.execute("UPDATE audit SET payload='{}' WHERE id=2")
            c.commit()
            c.close()
            ok, note = a.verify_chain()
            self.assertFalse(ok)
            self.assertIn("row 2", note)


class FakeTrade:
    def __init__(self, order, contract):
        self.order, self.contract = order, contract
        self.orderStatus = NS(status="Submitted", filled=0)
        self.log = []

    def isDone(self):
        return True


class FakeKillIB:
    def __init__(self, positions=(), working=()):
        self.calls = []
        self._positions = list(positions)
        self._working = list(working)

    async def reqAllOpenOrdersAsync(self):
        self.calls.append("reqAllOpenOrders")

    def openTrades(self):
        return self._working

    def reqGlobalCancel(self):
        self.calls.append("reqGlobalCancel")

    async def reqPositionsAsync(self):
        self.calls.append("reqPositions")
        return self._positions

    def placeOrder(self, contract, order):
        self.calls.append(("placeOrder", contract.symbol, order.action, order.totalQuantity))
        order.orderId = 900 + len(self.calls)
        return FakeTrade(order, contract)

    def disconnect(self):
        self.calls.append("disconnect")


def pos(symbol, qty, sec="STK"):
    return NS(account="DU1", position=qty, contract=NS(symbol=symbol, localSymbol=symbol, secType=sec, conId=1, exchange=""))


def mkt(side, qty):
    return NS(action=side, totalQuantity=qty, orderType="MKT", orderId=0)


class KillSwitchTests(unittest.TestCase):
    def run_kill(self, d, ib, dry=False, connect_error=None):
        async def connect(readonly):
            if connect_error:
                raise connect_error
            ib.readonly = readonly
            return ib
        return asyncio.run(kill_switch.execute_kill(reason="test", actor="t", dry_run=dry, connect=connect,
                                                    audit=AuditLog(d / "audit.db"), d=d, market_order=mkt, fill_wait_s=0))

    def test_full_sequence(self):
        with tempfile.TemporaryDirectory() as td:
            d = Path(td)
            working = [NS(order=NS(orderId=1, permId=2, action="BUY", totalQuantity=5, orderType="LMT"), contract=NS(symbol="QQQ"), orderStatus=NS(status="Submitted"))]
            ib = FakeKillIB([pos("SPY", 10), pos("GLD", -3), pos("IWM", 0)], working)
            inc = self.run_kill(d, ib)
            self.assertTrue(kill_switch.is_locked(d))
            self.assertFalse(ib.readonly)
            self.assertEqual(ib.calls[:2], ["reqAllOpenOrders", "reqGlobalCancel"])
            self.assertIn(("placeOrder", "SPY", "SELL", 10), ib.calls)
            self.assertIn(("placeOrder", "GLD", "BUY", 3), ib.calls)
            self.assertEqual(len(inc["flatten"]), 2)
            self.assertEqual(len(inc["cancelled"]), 1)
            self.assertTrue(inc["ok"])
            self.assertEqual([s["step"] for s in inc["steps"]], ["lock", "connect", "global_cancel", "flatten", "sever_agent", "audit_chain"])
            self.assertTrue((d / "incidents" / f"{inc['incidentId']}.json").exists())

    def test_lock_holds_even_if_tws_unreachable(self):
        with tempfile.TemporaryDirectory() as td:
            d = Path(td)
            inc = self.run_kill(d, FakeKillIB(), connect_error=ConnectionRefusedError("down"))
            self.assertTrue(kill_switch.is_locked(d))
            self.assertFalse(inc["ok"])

    def test_dry_run_changes_nothing(self):
        with tempfile.TemporaryDirectory() as td:
            d = Path(td)
            ib = FakeKillIB([pos("SPY", 10)])
            inc = self.run_kill(d, ib, dry=True)
            self.assertFalse(kill_switch.is_locked(d))
            self.assertTrue(ib.readonly)
            self.assertNotIn("reqGlobalCancel", ib.calls)
            self.assertFalse(any(isinstance(c, tuple) for c in ib.calls))
            self.assertEqual(inc["flatten"][0]["action"], "SELL")
            self.assertTrue(inc["ok"])

    def test_reset_needs_phrase_and_unreadable_lock_is_locked(self):
        with tempfile.TemporaryDirectory() as td:
            d = Path(td)
            a = AuditLog(d / "audit.db")
            kill_switch.write_lock("x", "t", "inc1", d)
            with self.assertRaises(PermissionError):
                kill_switch.reset_lock("reset", "t", a, d)
            kill_switch.reset_lock("RESET", "t", a, d)
            self.assertFalse(kill_switch.is_locked(d))
            kill_switch.lock_path(d).write_text("{garbage", encoding="utf-8")
            self.assertTrue(kill_switch.is_locked(d))


class FakeBridge:
    def __init__(self, **over):
        self.ib = None
        self.snap = {"state": "CONNECTED", "mode": "PAPER", "port": 7497,
                     "account": {"netLiquidation": 100_000.0, "currency": "CAD"}, "fx": {"USD": 1.4},
                     "pnl": {"daily": 0.0}, "positions": [], "openOrders": []}
        self.snap.update(over)

    def snapshot(self):
        return json.loads(json.dumps(self.snap))


class FakeExecutor:
    def __init__(self):
        self.placed = []

    async def place(self, intent, qty):
        self.placed.append((intent.intent_id, qty))
        return {"orders": [{"orderId": 1}]}

    def disconnect(self):
        pass


async def good_quote(_intent):
    return {"bid": 499.95, "ask": 500.05, "last": 500.0}, True


async def good_stats(_intent):
    return dict(LIQUID)


class DeskTests(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.d = Path(self.td.name)
        self.ex = FakeExecutor()
        self.kill_ib = FakeKillIB([pos("SPY", 4)])

        async def connect(readonly):
            return self.kill_ib

        self.desk = Desk(FakeBridge(), executor=self.ex, quote_fn=good_quote, stats_fn=good_stats, kill_connect=connect, kill_market_order=mkt, fx_source=False, d=self.d, clock=lambda: NOW,
                         pretrade=False)  # Security Detail flow only; the pre-trade gates are tested in test_trading_desk_pretrade.py

    def tearDown(self):
        self.td.cleanup()

    def submit(self, **over):
        return asyncio.run(self.desk.submit(raw_intent(**over), "test"))

    def test_default_advisory_never_executes(self):
        r = self.submit()
        self.assertEqual(r["status"], "hypothetical")
        self.assertEqual(self.ex.placed, [])

    def test_semi_auto_queue_and_approve_rechecks(self):
        with self.assertRaises(PermissionError):
            self.desk.set_mode("SEMI_AUTO", "t")
        self.desk.set_mode("SEMI_AUTO", "t", confirm=True)
        r = self.submit()
        self.assertEqual(r["status"], "pending_approval")
        self.assertEqual(self.ex.placed, [])
        out = asyncio.run(self.desk.approve("intent-0001", "t"))
        self.assertEqual(out["status"], "submitted", out)
        self.assertEqual(self.ex.placed, [("intent-0001", 10)])
        self.assertFalse(asyncio.run(self.desk.approve("intent-0001", "t"))["ok"])  # no double fire

    def test_approval_rechecks_lock(self):
        self.desk.set_mode("SEMI_AUTO", "t", confirm=True)
        self.submit()
        kill_switch.write_lock("x", "t", "inc", self.d)
        out = asyncio.run(self.desk.approve("intent-0001", "t"))
        self.assertEqual(out["status"], "rejected")
        self.assertEqual(self.ex.placed, [])

    def test_full_auto_executes_and_idempotent(self):
        self.desk.set_mode("FULL_AUTO", "t", confirm=True)
        self.assertEqual(self.submit()["status"], "submitted")
        self.assertEqual(self.submit()["status"], "rejected")  # same intent_id
        self.assertEqual(len(self.ex.placed), 1)

    def test_kill_switch_severs_and_locks_modes(self):
        self.desk.set_mode("SEMI_AUTO", "t", confirm=True)
        self.submit()
        inc = asyncio.run(self.desk.kill("test", "t"))
        self.assertTrue(inc["ok"])
        v = self.desk.view()
        self.assertEqual((v["mode"], v["agentHalted"]), ("ADVISORY", True))
        self.assertEqual(v["pending"], [])
        with self.assertRaises(PermissionError):
            self.desk.set_mode("FULL_AUTO", "t", confirm=True)
        self.assertEqual(self.submit(intent_id="intent-0002", symbol="QQQ")["status"], "rejected")
        # The bridge shows a fresh open-order list with no KILL- order left, so the reset lifts the guard stand-down
        # and re-arming works. (Without that proof, re-arming stays refused: Desk._stood_down fails closed.) The list
        # must be newer than the kill's end: one from before it finished placing orders proves nothing.
        self.desk.bridge = FakeBridge(openOrdersAt=NOW + 1)
        self.desk.reset("RESET", "t")
        self.desk.set_mode("FULL_AUTO", "t", confirm=True)
        self.assertEqual(self.desk.view()["audit"]["ok"], True)

    def test_no_autonomous_entry_while_the_kill_stand_down_holds(self):
        """Backstop: a kill whose halt write never landed can leave state.json at FULL_AUTO. While the kill's stand-down
        holds (options guard off, its flatten maybe still working), no autonomous entry goes out."""
        self.desk.set_mode("FULL_AUTO", "t", confirm=True)
        self.desk._killed, self.desk._kill_done_at = True, NOW                       # settling, nothing locked
        self.assertEqual(self.submit(source="rule_engine")["status"], "rejected")
        self.assertEqual(self.ex.placed, [])

    def test_drawdown_trips_kill_from_submit(self):
        self.desk.bridge = FakeBridge(account={"netLiquidation": 97_000.0, "currency": "CAD"}, pnl={"daily": -3_000.0})
        r = self.submit()
        self.assertEqual(r["status"], "rejected")
        self.assertTrue(kill_switch.is_locked(self.d))
        self.assertTrue(self.desk.drawdown_breached() is False)  # already locked → monitor stays quiet

    def test_halted_agent_blocked_but_manual_allowed(self):
        self.desk._save_state(agentHalted=True)
        self.assertEqual(self.submit(source="rule_engine")["status"], "rejected")   # autonomous sources stop while halted
        self.assertEqual(self.submit(intent_id="intent-0003", source="manual", symbol="QQQ")["status"], "hypothetical")


class CommsTests(unittest.TestCase):
    def env(self, frm, to, kind, payload, mid="msg-00000001"):
        return {"msg_id": mid, "from": frm, "to": to, "kind": kind, "payload": payload}

    def test_only_financer_routes(self):
        for frm, to in [("trading", "coder"), ("librarian", "trading"), ("tony", "trading"), ("trading", "tony"), ("trading", "trading")]:
            with self.assertRaises(comms.CommsError, msg=(frm, to)):
                comms.validate_envelope(self.env(frm, to, "pnl_report", {}))

    def test_kind_and_payload_are_closed(self):
        with self.assertRaises(comms.CommsError):
            comms.validate_envelope(self.env("trading", "financer", "budget_envelope", {"allocation_base": 1}))
        with self.assertRaises(comms.CommsError):
            comms.validate_envelope(self.env("financer", "trading", "budget_envelope", {"allocation_base": 1, "hack": 1}))
        ok = comms.validate_envelope(self.env("trading", "financer", "pnl_report", {"date": "2026-11-23", "realized_base": 1.5, "unrealized_base": 0, "trades": 2}))
        self.assertEqual(ok["kind"], "pnl_report")

    def test_desk_applies_and_only_tightens(self):
        with tempfile.TemporaryDirectory() as td:
            desk = Desk(FakeBridge(), executor=FakeExecutor(), quote_fn=good_quote, stats_fn=good_stats, fx_source=False, d=Path(td), clock=lambda: NOW)
            r = desk.handle_comms(self.env("financer", "trading", "budget_envelope", {"allocation_base": 20_000, "max_daily_loss_pct": 1.0}), "t")
            self.assertTrue(r["ok"], r)
            self.assertEqual(desk.limits().max_daily_loss_pct, 1.0)
            desk.handle_comms(self.env("financer", "trading", "budget_envelope", {"allocation_base": 20_000, "max_daily_loss_pct": 50}, "msg-00000002"), "t")
            self.assertEqual(desk.limits().max_daily_loss_pct, 1.0)  # can't loosen
            self.assertFalse(desk.handle_comms(self.env("financer", "trading", "risk_posture", {"posture": "halt"}, "msg-00000002"), "t")["ok"])  # dup id
            desk.set_mode("FULL_AUTO", "t", confirm=True)
            desk.handle_comms(self.env("financer", "trading", "risk_posture", {"posture": "halt"}, "msg-00000003"), "t")
            self.assertEqual((desk.state()["mode"], desk.state()["agentHalted"]), ("ADVISORY", True))
            bad = desk.handle_comms(self.env("coder", "trading", "risk_posture", {"posture": "normal"}, "msg-00000004"), "t")
            self.assertFalse(bad["ok"])
            self.assertEqual(desk.audit.tail(1)[0]["kind"], "comms_rejected")
            desk.handle_comms(self.env("trading", "financer", "capital_request", {"amount_base": 5000, "rationale": "x"}, "msg-00000005"), "t")
            self.assertTrue((Path(td) / "financer_outbox.jsonl").exists())


class FxTests(unittest.TestCase):
    def test_boc_fallback_margin_cache_and_ibkr_priority(self):
        calls = []

        def fetch(series):
            calls.append(series)
            return {"FXUSDCAD": (1.40, "2026-11-20"), "FXEURCAD": (1.50, "2026-11-20")}.get(series)

        with tempfile.TemporaryDirectory() as td:
            src = FxSource(Path(td) / "fx.json", fetch=fetch, clock=lambda: NOW)
            self.assertAlmostEqual(src.rate_to_base("USD", "CAD"), 1.40 * (1 + SAFETY_MARGIN))
            self.assertAlmostEqual(src.rate_to_base("EUR", "USD"), 1.50 / 1.40 * (1 + SAFETY_MARGIN))
            src.rate_to_base("USD", "CAD")
            self.assertEqual(calls.count("FXUSDCAD"), 1)  # cached after the first fetch
            rates, prov = merged_rates({"USD": 1.37}, {"USD", "EUR"}, "CAD", src)
            self.assertEqual((rates["USD"], prov["USD"]), (1.37, "ibkr"))
            self.assertIn("bank_of_canada", prov["EUR"])
            self.assertIsNone(src.rate_to_base("XYZ", "CAD"))

    def test_offline_uses_recent_cache_then_fails_closed(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "fx.json"
            p.write_text(json.dumps({"FXUSDCAD": {"rate": 1.4, "date": "x", "fetched": NOW - 86400}}), encoding="utf-8")

            def boom(_s):
                raise OSError("offline")

            self.assertIsNotNone(FxSource(p, fetch=boom, clock=lambda: NOW).rate_to_base("USD", "CAD"))
            self.assertIsNone(FxSource(p, fetch=boom, clock=lambda: NOW + 10 * 86400).rate_to_base("USD", "CAD"))


class BracketTests(unittest.TestCase):
    def test_bracket_shape(self):
        f = {"limit": lambda a, q, p: NS(orderType="LMT", action=a, totalQuantity=q, lmtPrice=p),
             "market": lambda a, q: NS(orderType="MKT", action=a, totalQuantity=q),
             "stop": lambda a, q, p: NS(orderType="STP", action=a, totalQuantity=q, auxPrice=p)}
        orders = build_bracket(parse_intent(raw_intent()), 7, 42, f)
        self.assertEqual([o.orderType for o in orders], ["LMT", "STP", "LMT"])
        self.assertEqual([o.action for o in orders], ["BUY", "SELL", "SELL"])
        self.assertEqual([o.transmit for o in orders], [False, False, True])
        self.assertEqual([getattr(o, "parentId", None) for o in orders[1:]], [42, 42])
        self.assertEqual([o.tif for o in orders], ["DAY", "GTC", "GTC"])
        self.assertTrue(all(o.orderRef == "intent-0001" and o.totalQuantity == 7 for o in orders))
        two = build_bracket(parse_intent(raw_intent(take_profit=None)), 1, 7, f)
        self.assertEqual([o.transmit for o in two], [False, True])


if __name__ == "__main__":
    unittest.main()
