"""Phase 3: Engine A (ETFs / commodities), Engine B (defined-risk options), options gate, expiry guard.

Stdlib only; market data, quotes and the executor are fakes. NOW = 2026-11-24 01:00 New York.
"""

import asyncio
import json
import math
import sys
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path
from types import SimpleNamespace as NS

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "trading"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import options as opt  # noqa: E402
from desk import Desk, structure_quote  # noqa: E402
from engines.equities_commodities import ContractRefused, EngineA, Watchlist, build_intent, resolve, trend_breakout  # noqa: E402
from engines.options_engine import EngineB, flatten_plan  # noqa: E402
from executor import build_bracket  # noqa: E402
from intents import IntentError, parse_intent  # noqa: E402
from security_detail import APPROVED, MODIFIED, REJECTED, evaluate  # noqa: E402
from test_trading_desk import FakeBridge, FakeExecutor, ctx, good_quote, good_stats  # noqa: E402

NOW = 1_795_500_000.0
TODAY = date(2026, 11, 24)


def exp(days: int) -> str:
    return (TODAY + timedelta(days=days)).strftime("%Y%m%d")


def bars_trending(n=70, breakout=True):
    out, px = [], 100.0
    for i in range(n):
        px *= 1.004
        out.append({"date": f"d{i}", "open": px * 0.998, "high": px * 1.005, "low": px * 0.993, "close": px, "volume": 1_000_000})
    if breakout:
        last = out[-1]
        last.update(close=last["close"] * 1.02, high=last["close"] * 1.025, volume=2_000_000)
    return out


def opt_raw(**over):
    d = {"intent_id": "opt-000001", "source": "engine_b", "asset_class": "option", "symbol": "SPY", "sec_type": "BAG",
         "action": "BUY", "quantity": 2, "order_type": "LMT", "limit_price": 4.0, "stop_loss": 2.0, "take_profit": 7.0,
         "legs": [{"action": "BUY", "right": "C", "strike": 730, "expiry": exp(30)},
                  {"action": "SELL", "right": "C", "strike": 740, "expiry": exp(30)}],
         "citations": ["telemetry:SPY:option_chain"]}
    d.update(over)
    return d


LIQ_LEG = {"bid": 3.9, "ask": 4.1, "openInterest": 5000, "volume": 900}


def octx(**over):
    # 1M CAD account (like the paper account): options cap = min(0.25% x 1M, 1000) = 1000 CAD.
    base = dict(equity_base=1_000_000.0, quote={"bid": 3.9, "ask": 4.1, "last": 4.0}, option_limits=opt.OptionLimits(),
                option_legs=[dict(LIQ_LEG), dict(LIQ_LEG)])
    base.update(over)
    return ctx(**base)


class OptionsMathTests(unittest.TestCase):
    def test_dte_and_flatten(self):
        lim = opt.OptionLimits()
        self.assertEqual(opt.dte(exp(30), NOW), 30)
        self.assertFalse(opt.must_flatten(exp(2), NOW, lim))
        self.assertTrue(opt.must_flatten(exp(1), NOW, lim))   # day before expiry
        self.assertTrue(opt.must_flatten(exp(0), NOW, lim))   # expiration day
        self.assertTrue(opt.must_flatten(exp(-1), NOW, lim))  # somehow still held
        zero = opt.OptionLimits(flatten_dte=0)
        self.assertFalse(opt.must_flatten(exp(0), NOW, zero))  # 01:00 NY, before the 15:00 backstop
        self.assertTrue(opt.must_flatten(exp(0), NOW + 15 * 3600, zero))

    def test_black_scholes_and_iv_roundtrip(self):
        p = opt.bs_price(100, 100, 30 / 365, 0.2, "C")
        self.assertAlmostEqual(opt.implied_vol(p, 100, 100, 30 / 365, "C"), 0.2, places=3)
        self.assertTrue(0.45 < opt.bs_delta(100, 100, 30 / 365, 0.2, "C") < 0.6)
        self.assertTrue(-0.6 < opt.bs_delta(100, 100, 30 / 365, 0.2, "P") < -0.4)

    def test_expiry_pick_ticks_and_exits(self):
        lim = opt.OptionLimits()
        self.assertEqual(opt.pick_expiry([exp(10), exp(28), exp(35), exp(60)], NOW, lim), exp(35))
        self.assertIsNone(opt.pick_expiry([exp(5), exp(90)], NOW, lim))
        self.assertEqual(opt.tick(3.07), 3.05)
        self.assertEqual(opt.tick(1.234), 1.23)
        stop, tp = opt.exit_levels(4.0, lim, width=5.0)
        self.assertEqual((stop, tp), (2.0, 4.5))  # target capped at 90% of width

    def test_limits_file_validation(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "option_limits.json"
            self.assertEqual(opt.load_option_limits(p), opt.OptionLimits())
            p.write_text(json.dumps({"min_dte": 10, "max_dte": 5}), encoding="utf-8")
            with self.assertRaises(ValueError):
                opt.load_option_limits(p)
            p.write_text(json.dumps({"flatten_dte": 30}), encoding="utf-8")
            with self.assertRaises(ValueError):
                opt.load_option_limits(p)


def chain_rows(under=730.0, e=None, right="C"):
    e = e or exp(30)
    rows = []
    for k in range(700, 781, 5):
        t = 30 / 365
        px = opt.bs_price(under, k, t, 0.18, right)
        # SPY-like markets: about 1% wide per leg.
        rows.append({"expiry": e, "strike": float(k), "right": right, "bid": round(px * 0.995, 2), "ask": round(px * 1.005, 2) + 0.01,
                     "openInterest": 2000, "volume": 300, "delta": None, "last": px})
    return rows


class SelectionTests(unittest.TestCase):
    def test_single_picks_target_delta_via_bs_fallback(self):
        best, _ = opt.select_single(chain_rows(), 730.0, NOW, opt.OptionLimits())
        self.assertIsNotNone(best)
        self.assertTrue(0.35 <= abs(best["delta"]) <= 0.55)

    def test_vertical_is_a_debit_with_short_leg_further_otm(self):
        v, _ = opt.select_vertical(chain_rows(), 730.0, NOW, opt.OptionLimits())
        self.assertIsNotNone(v)
        self.assertGreater(v["short"]["strike"], v["long"]["strike"])
        self.assertTrue(0 < v["debit"] < v["width"])

    def test_vertical_rejects_structures_wider_than_the_gate_allows(self):
        wide = [{**r, "bid": round(r["bid"] * 0.96, 2), "ask": round(r["ask"] * 1.04, 2)} for r in chain_rows()]
        v, notes = opt.select_vertical(wide, 730.0, NOW, opt.OptionLimits())
        self.assertIsNone(v)
        self.assertTrue(any("vertical spread too wide" in n for n in notes))

    def test_illiquid_rows_are_skipped(self):
        rows = [{**r, "openInterest": 10} for r in chain_rows()]
        best, notes = opt.select_single(rows, 730.0, NOW, opt.OptionLimits())
        self.assertIsNone(best)
        self.assertTrue(any("OI" in n for n in notes))


class OptionSchemaTests(unittest.TestCase):
    def test_valid_structures(self):
        v = parse_intent(opt_raw())
        self.assertEqual((v.sec_type, v.multiplier, v.legs[0]["action"]), ("BAG", 100, "BUY"))
        s = parse_intent(opt_raw(sec_type="OPT", legs=[{"action": "BUY", "right": "P", "strike": 700, "expiry": exp(30)}]))
        self.assertEqual(s.expiry, exp(30))

    def test_undefined_risk_is_refused(self):
        leg = lambda a, r, k, e=None: {"action": a, "right": r, "strike": k, "expiry": e or exp(30)}  # noqa: E731
        bad = [
            opt_raw(sec_type="OPT", legs=[leg("SELL", "C", 740)]),                    # naked short
            opt_raw(action="SELL", limit_price=4.0, stop_loss=7.0, take_profit=2.0),    # credit structure
            opt_raw(legs=[leg("BUY", "C", 740), leg("SELL", "C", 730)]),               # credit call vertical
            opt_raw(legs=[leg("BUY", "C", 730), leg("SELL", "P", 740)]),               # mixed rights
            opt_raw(legs=[leg("BUY", "C", 730), leg("SELL", "C", 740, exp(60))]),      # calendar
            opt_raw(order_type="MKT", limit_price=None),                                # market order
            opt_raw(multiplier=10),
            opt_raw(asset_class="etf"),
            {**opt_raw(sec_type="STK"), "asset_class": "etf"},                          # legs on a stock
        ]
        for b in bad:
            with self.assertRaises(IntentError, msg=b):
                parse_intent(b)


class OptionGateTests(unittest.TestCase):
    def test_vertical_approved_and_sized_on_whole_debit(self):
        d = evaluate(parse_intent(opt_raw(quantity=1)), octx())
        self.assertEqual(d.verdict, APPROVED, d.reasons)
        self.assertAlmostEqual(d.risk_base, 1 * 4.0 * 100 * 1.4)

    def test_premium_cap_cuts_contracts(self):
        # cap = min(0.25% * 100k, 1000) = 250 CAD; one contract = 4.0*100*1.4 = 560 CAD → can't fit even 1
        d = evaluate(parse_intent(opt_raw(limit_price=4.0)), octx(option_limits=opt.OptionLimits(max_premium_pct=0.25, max_premium_base=250)))
        self.assertEqual(d.verdict, REJECTED)
        self.assertIn("position_size", {c["name"] for c in d.checks if not c["ok"]})
        d2 = evaluate(parse_intent(opt_raw(quantity=10)), octx())
        self.assertEqual((d2.verdict, d2.quantity), (MODIFIED, 1))  # 1000 cap / 560 per contract

    def test_option_hard_checks(self):
        far = [{"action": "BUY", "right": "C", "strike": 730, "expiry": exp(90)}, {"action": "SELL", "right": "C", "strike": 740, "expiry": exp(90)}]
        cases = [
            ("option_dte", opt_raw(legs=far), octx()),
            ("option_liquidity", opt_raw(), octx(option_legs=[dict(LIQ_LEG), {**LIQ_LEG, "openInterest": 3}])),
            ("option_liquidity", opt_raw(), octx(option_legs=None)),
            ("price_sanity", opt_raw(limit_price=4.5, take_profit=7.0), octx()),
            ("option_positions", opt_raw(), octx(positions=[{"symbol": s, "underlying": s, "secType": "OPT", "position": 1, "marketValue": 1, "currency": "USD"} for s in ("A", "B", "C")])),
            ("position_size", opt_raw(), octx(option_limits=None)),
        ]
        for name, raw, c in cases:
            d = evaluate(parse_intent(raw), c)
            self.assertEqual(d.verdict, REJECTED, name)
            self.assertIn(name, {x["name"] for x in d.checks if not x["ok"]}, name)

    def test_option_spread_uses_option_threshold(self):
        # 5% wide: fine for options (max 10%), would fail the 0.25% stock rule.
        d = evaluate(parse_intent(opt_raw(limit_price=4.0)), octx(quote={"bid": 3.9, "ask": 4.1}))
        self.assertNotIn("liquidity", {x["name"] for x in d.checks if not x["ok"]})

    def test_structure_quote(self):
        intent = parse_intent(opt_raw())
        q = structure_quote(intent, [{"bid": 10.0, "ask": 10.4}, {"bid": 6.0, "ask": 6.2}])
        self.assertEqual((q["bid"], q["ask"]), (3.8, 4.4))
        self.assertIsNone(structure_quote(intent, [{"bid": 10.0, "ask": 10.4}, {}]))


class BracketOptionTests(unittest.TestCase):
    def test_options_have_no_stop_child(self):
        f = {"limit": lambda a, q, p: NS(orderType="LMT", action=a, totalQuantity=q, lmtPrice=p),
             "market": lambda a, q: NS(orderType="MKT", action=a, totalQuantity=q),
             "stop": lambda a, q, p: NS(orderType="STP", action=a, totalQuantity=q, auxPrice=p)}
        orders = build_bracket(parse_intent(opt_raw()), 2, 9, f)
        self.assertEqual([(o.orderType, o.action, o.transmit) for o in orders], [("LMT", "BUY", False), ("LMT", "SELL", True)])
        self.assertEqual(orders[1].tif, "GTC")


class AckTests(unittest.TestCase):
    """The executor must not call an order 'submitted' until TWS acknowledges it (seen live:
    error 321 'The API interface is currently in Read-Only mode' arrived after placeOrder returned)."""

    def trade(self, oid, status="PendingSubmit", log=()):
        t = NS(order=NS(orderId=oid), orderStatus=NS(status=status, filled=0), log=list(log))
        t.isDone = lambda: t.orderStatus.status in ("Filled", "Cancelled", "ApiCancelled", "Inactive")
        return t

    def run_ack(self, trades, timeout=1.0, evolve=None):
        import executor as ex

        ib = NS(cancelled=[])
        ib.cancelOrder = lambda o: ib.cancelled.append(o.orderId)
        ticks = {"n": 0}

        async def sleep(_s):
            ticks["n"] += 1
            if evolve:
                evolve(ticks["n"], trades)
        asyncio.run(ex.await_ack(ib, trades, timeout=timeout, sleep=sleep))
        return ib

    def test_read_only_rejection_raises_and_cancels_the_rest(self):
        import executor as ex

        ro = NS(status="ValidationError", errorCode=321, message="Warning 321: The API interface is currently in Read-Only mode.")
        trades = [self.trade(4, log=[ro]), self.trade(5), self.trade(6)]
        with self.assertRaises(ex.ExecutionRefused) as cm:
            self.run_ack(trades)
        self.assertIn("Read-Only", str(cm.exception))

    def test_accepted_bracket_returns(self):
        def evolve(n, ts):
            if n == 2:
                for t, s in zip(ts, ("Submitted", "PreSubmitted", "PreSubmitted")):
                    t.orderStatus.status = s
        ib = self.run_ack([self.trade(4), self.trade(5), self.trade(6)], evolve=evolve)
        self.assertEqual(ib.cancelled, [])

    def test_one_leg_cancelled_kills_the_bracket(self):
        import executor as ex

        def evolve(n, ts):
            ts[0].orderStatus.status = "Submitted"
            ts[1].orderStatus.status = "Cancelled"
        with self.assertRaises(ex.ExecutionRefused):
            self.run_ack([self.trade(4), self.trade(5), self.trade(6)], evolve=evolve)

    def test_no_acknowledgement_times_out_and_cancels(self):
        import executor as ex

        trades = [self.trade(4), self.trade(5)]
        with self.assertRaises(ex.ExecutionRefused) as cm:
            ib = self.run_ack(trades, timeout=0.05)
        self.assertIn("didn't acknowledge", str(cm.exception))


class EngineATests(unittest.TestCase):
    def test_signal_and_intent(self):
        sig = trend_breakout(bars_trending())
        self.assertTrue(sig["signal"], sig)
        self.assertFalse(trend_breakout(bars_trending(breakout=False))["signal"])
        self.assertFalse(trend_breakout(bars_trending(n=30))["signal"])
        raw = build_intent("GLD", sig, {"bid": 140.0, "ask": 140.05}, now=NOW, risk_budget_base=500, fx=1.4)
        i = parse_intent(raw)
        self.assertEqual((i.source, i.asset_class, i.sec_type), ("engine_a", "commodity_etf", "STK"))
        self.assertTrue(i.stop_loss < i.limit_price < i.take_profit)
        self.assertAlmostEqual(i.limit_price - i.stop_loss, 2 * sig["atr"], places=1)
        self.assertEqual(raw["intent_id"], build_intent("GLD", sig, {"bid": 140.0, "ask": 140.05}, now=NOW + 60, risk_budget_base=500, fx=1.4)["intent_id"])
        self.assertTrue(any(c.startswith("telemetry:") for c in i.citations))

    def test_resolver(self):
        for f in ("ESZ6", "ES1!", "CL=F", "GCZ26"):
            with self.assertRaises(ContractRefused, msg=f):
                resolve(f)
        self.assertEqual(resolve("CL")["sec_type"], "STK")  # Colgate, not crude
        self.assertEqual(resolve("uso")["asset_class"], "commodity_etf")

    def test_watchlist_prefilter(self):
        with tempfile.TemporaryDirectory() as d:
            w = Watchlist(Path(d) / "w.json")
            ok = w.add("XLE", source="user", reason="energy catalyst", stats={"adv_value": 9e8}, quote={"bid": 90.0, "ask": 90.02})
            bad = w.add("TINY", source="trading_agent", reason="x", stats={"adv_value": 1e6}, quote={"bid": 2.0, "ask": 2.2})
            self.assertEqual((ok["status"], bad["status"]), ("active", "rejected"))
            self.assertIn("XLE", w.symbols())
            self.assertNotIn("TINY", w.symbols())
            self.assertEqual(w.symbols()[:3], ["SPY", "QQQ", "IWM"])
            self.assertTrue(w.remove("XLE"))


class FakeMD:
    def __init__(self, bars=None, right="C"):
        self._bars = bars or bars_trending()
        self.right = right

    async def daily_bars(self, symbol, currency="USD", days=80):
        if symbol == "BAD":
            raise LookupError("unknown")
        return self._bars

    async def stock_quote(self, symbol, currency="USD"):
        return {"bid": 729.9, "ask": 730.1, "last": 730.0}

    async def option_chain(self, symbol, currency="USD"):
        return {"symbol": symbol, "currency": "USD", "tradingClass": symbol, "multiplier": 100,
                "expirations": [exp(9), exp(30), exp(65)], "strikes": [float(k) for k in range(650, 811, 5)], "underConId": 1}

    async def option_quotes(self, symbol, currency, trading_class, multiplier, specs):
        rows = []
        for e, k, r in specs:
            base = [x for x in chain_rows(e=e, right=r) if x["strike"] == k]
            if base:
                rows.append(base[0])
        return rows


class EngineBTests(unittest.TestCase):
    def propose(self, md, **kw):
        eng = EngineB(md, clock=lambda: NOW)
        args = dict(view="bullish", structure="vertical", lim=opt.OptionLimits(), premium_budget_base=1000, fx=1.4)
        args.update(kw)
        return asyncio.run(eng.propose("SPY", **args))

    def test_vertical_and_single_proposals_parse(self):
        v = self.propose(FakeMD())
        i = parse_intent(v["intent"])
        self.assertEqual((i.sec_type, i.expiry, v["dte"]), ("BAG", exp(30), 30))
        self.assertTrue(i.stop_loss < i.limit_price < i.take_profit)
        s = self.propose(FakeMD(), structure="single", view="bearish", premium_budget_base=5000)
        si = parse_intent(s["intent"])
        self.assertEqual((si.sec_type, si.legs[0]["right"]), ("OPT", "P"))

    def test_auto_view_without_signal_is_no_trade(self):
        r = self.propose(FakeMD(bars=bars_trending(breakout=False)), view="auto")
        self.assertIsNone(r["view"])
        self.assertTrue(r["result"].startswith("no trade"))

    def test_budget_too_small_is_no_trade(self):
        r = self.propose(FakeMD(), premium_budget_base=50)
        self.assertIsNone(r["intent"])

    def test_flatten_plan_buys_back_shorts_first_and_skips_guarded(self):
        pos = [{"conId": 1, "symbol": "SPY 730C", "underlying": "SPY", "secType": "OPT", "position": 2, "expiry": exp(1)},
               {"conId": 2, "symbol": "SPY 740C", "underlying": "SPY", "secType": "OPT", "position": -2, "expiry": exp(1)},
               {"conId": 3, "symbol": "QQQ 500C", "underlying": "QQQ", "secType": "OPT", "position": 1, "expiry": exp(20)},
               {"conId": 4, "symbol": "SPY", "underlying": "SPY", "secType": "STK", "position": 10, "expiry": None}]
        plan = flatten_plan(pos, [], NOW, opt.OptionLimits())
        self.assertEqual([(p["conId"], p["action"]) for p in plan], [(2, "BUY"), (1, "SELL")])
        self.assertEqual(flatten_plan(pos, [{"conId": 2}, {"conId": 1}], NOW, opt.OptionLimits()), [])


def big_bridge(**over):
    return FakeBridge(account={"netLiquidation": 1_000_000.0, "currency": "CAD"}, **over)


class GuardExecutor(FakeExecutor):
    def __init__(self):
        super().__init__()
        self.calls = []

    async def cancel_working(self, **kw):
        self.calls.append(("cancel", kw))
        return 1

    async def close_option(self, contract, qty, limit, ref, action="SELL"):
        self.calls.append(("close", contract.conId if hasattr(contract, "conId") else contract, qty, limit, action, ref))
        return {"orderId": 77, "status": "Submitted"}

    async def _ensure(self):
        return object()

    async def _contract(self, ib, intent, factories):
        return NS(conId="BAG", secType="BAG")


class DeskEngineTests(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.d = Path(self.td.name)
        self.ex = GuardExecutor()

    def tearDown(self):
        self.td.cleanup()

    def desk(self, bridge=None, option_quote=None, md=None):
        async def oq(intent):
            return {"bid": 3.9, "ask": 4.1}, [dict(LIQ_LEG) for _ in intent.legs]

        async def quote(intent):  # same market as FakeMD
            return {"bid": 729.9, "ask": 730.1, "last": 730.0}, True
        return Desk(bridge or big_bridge(), executor=self.ex, quote_fn=quote, stats_fn=good_stats, fx_source=False,
                    option_quote_fn=option_quote, market_data=md or FakeMD(), d=self.d, clock=lambda: NOW)

    def test_engine_a_scan_submits_through_the_gate(self):
        dk = self.desk()
        r = asyncio.run(dk.engine_a_scan(["GLD", "BAD"], True, "test"))
        gld = next(x for x in r["rows"] if x["symbol"] == "GLD")
        self.assertTrue(gld["signal"])
        self.assertEqual(gld["desk"]["status"], "hypothetical")  # ADVISORY default: nothing is sent
        self.assertIn("error", next(x for x in r["rows"] if x["symbol"] == "BAD")["why"])
        r2 = asyncio.run(dk.engine_a_scan(["GLD"], True, "test"))  # same day, same signal → idempotent
        self.assertEqual(r2["rows"][0]["desk"]["status"], "rejected")
        self.assertEqual(self.ex.placed, [])

    def test_engines_refuse_to_submit_when_locked(self):
        import kill_switch

        dk = self.desk()
        kill_switch.write_lock("x", "t", "inc", self.d)
        self.assertFalse(asyncio.run(dk.engine_a_scan(None, True, "t"))["ok"])
        self.assertFalse(asyncio.run(dk.engine_b_propose("SPY", "bullish", "vertical", True, "t"))["ok"])
        self.assertTrue(asyncio.run(dk.engine_a_scan(["GLD"], False, "t"))["ok"])  # a read-only scan is fine

    def test_engine_b_full_auto_executes_option_intent(self):
        dk = self.desk()
        dk.set_mode("FULL_AUTO", "t", confirm=True)
        r = asyncio.run(dk.engine_b_propose("SPY", "bullish", "vertical", True, "t"))
        self.assertEqual(r["desk"]["status"], "submitted", r)
        self.assertEqual(len(self.ex.placed), 1)

    def test_guard_expiry_flatten_order(self):
        pos = [{"conId": 1, "symbol": "SPY 730C", "underlying": "SPY", "secType": "OPT", "position": 2, "expiry": exp(1), "currency": "USD"},
               {"conId": 2, "symbol": "SPY 740C", "underlying": "SPY", "secType": "OPT", "position": -2, "expiry": exp(1), "currency": "USD"}]
        dk = self.desk(bridge=big_bridge(positions=pos), md=FakeMD())
        import engines.options_engine  # noqa: F401 — Contract factory injected below
        rep = asyncio.run(dk.options_guard(contract_factory=lambda **kw: NS(**kw)))
        closes = [c for c in self.ex.calls if c[0] == "close"]
        self.assertEqual([(c[1], c[4]) for c in closes], [(2, "BUY"), (1, "SELL")])
        self.assertEqual(self.ex.calls[0][0], "cancel")  # resting exits cancelled first
        self.assertEqual(len(rep["flatten"]), 2)

    def test_guard_premium_stop(self):
        async def fixed(intent):
            return {"bid": 3.9, "ask": 4.1}, [dict(LIQ_LEG) for _ in intent.legs]
        dk = self.desk(option_quote=fixed)
        dk.set_mode("FULL_AUTO", "t", confirm=True)
        asyncio.run(dk.submit(opt_raw(), "t"))
        held = [{"conId": 1, "symbol": "SPY 730C", "underlying": "SPY", "secType": "OPT", "position": 2, "expiry": exp(30),
                 "strike": 730.0, "right": "C", "currency": "USD"}]
        dk.bridge = big_bridge(positions=held)

        async def crashed(intent):
            return {"bid": 1.7, "ask": 1.9}, []
        dk._option_quote = crashed
        rep = asyncio.run(dk.options_guard())
        self.assertEqual(len(rep["stops"]), 1, rep)
        self.assertEqual(self.ex.calls[0], ("cancel", {"ref": "opt-000001"}))
        close = [c for c in self.ex.calls if c[0] == "close"][0]
        self.assertEqual((close[2], close[3], close[4]), (1, 1.7, "SELL"))  # the desk opened 1 (cut by the cap), so it closes 1
        self.assertEqual(dk._row("opt-000001")["status"], "closed_stop")

    def test_guard_skips_when_locked(self):
        import kill_switch

        dk = self.desk()
        kill_switch.write_lock("x", "t", "inc", self.d)
        self.assertIn("skipped", asyncio.run(dk.options_guard()))


if __name__ == "__main__":
    unittest.main()
