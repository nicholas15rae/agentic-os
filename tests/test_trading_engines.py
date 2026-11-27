"""Phase 3: Engine A (ETFs / commodities), Engine B (defined-risk options), options gate, expiry guard.

Stdlib only; market data, quotes and the executor are fakes. NOW = 2026-11-24 01:00 New York.
"""

import asyncio
import json
import math
import os
import sys
import tempfile
import unittest
from unittest import mock
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
    error 321 'The API interface is currently in Read-Only mode' arrived after placeOrder returned),
    and it must never strip the stop of an entry that has already filled."""

    DONE = ("Filled", "Cancelled", "ApiCancelled", "Inactive")
    RO = NS(status="ValidationError", errorCode=321, message="Warning 321: The API interface is currently in Read-Only mode.")
    W399 = NS(status="ValidationError", errorCode=399, message="Warning 399: Order Message: your order will not be placed at the exchange until 09:30")

    def trade(self, oid, status="PendingSubmit", log=(), parent=0, otype="LMT", filled=0, transmit=True):
        t = NS(order=NS(orderId=oid, parentId=parent, orderType=otype, transmit=transmit), orderStatus=NS(status=status, filled=filled),
               log=list(log))
        t.isDone = lambda: t.orderStatus.status in self.DONE
        return t

    def bracket(self, parent="PendingSubmit", stop="PendingSubmit", tp="PendingSubmit", **logs):
        """Parent #4 (LMT entry) with a STP child #5 and a take-profit LMT child #6, as build_bracket makes them:
        only the last child transmits."""
        return [self.trade(4, parent, logs.get("p", ()), transmit=False),
                self.trade(5, stop, logs.get("s", ()), parent=4, otype="STP", transmit=False),
                self.trade(6, tp, logs.get("t", ()), parent=4)]

    @staticmethod
    def ib_async_cancel(t):
        """What ib_async 2.1.0 IB.cancelOrder does locally, before TWS answers (ib.py cancelOrder): a PendingSubmit,
        non-transmit order (a bracket parent) or an Inactive one goes straight to Cancelled; others to PendingCancel."""
        if t.isDone():
            return
        st = t.orderStatus.status
        new = "Cancelled" if (st == "PendingSubmit" and not getattr(t.order, "transmit", True)) or st == "Inactive" else "PendingCancel"
        t.log.append(NS(status=new, errorCode=0, message=""))
        t.orderStatus.status = new

    @staticmethod
    def tws_status(t, status, filled=None):
        """A TWS orderStatus: ib_async logs it only when the status changes."""
        if filled is not None:
            t.orderStatus.filled = filled
        if t.orderStatus.status != status:
            t.orderStatus.status = status
            t.log.append(NS(status=status, errorCode=0, message=""))

    def run_ack(self, trades, timeout=1.0, evolve=None, fill_on_cancel=False, silent_tws=False):
        """Fake TWS behind ib_async: cancelOrder changes the local status at once (ib_async_cancel); TWS answers on the
        next tick and cancels the attached children with their parent, so a loop that also cancels the children would
        be seen doing it. fill_on_cancel: the parent fills before the cancel lands (TWS refuses the cancel; the
        children stay working). self.ib stays readable after a raise."""
        import executor as ex

        self.ib = ib = NS(cancelled=[], warnings=None)
        pending = []

        def cancel(o):
            ib.cancelled.append(o.orderId)
            if silent_tws:  # the cancel goes out, but neither ib_async nor TWS ever changes the order's state
                return
            pending.append(o.orderId)
            self.ib_async_cancel(next(t for t in trades if t.order.orderId == o.orderId))

        def land():
            for oid in pending:
                for t in trades:
                    if t.order.orderId != oid and t.order.parentId != oid:
                        continue
                    if fill_on_cancel:
                        if t.order.orderId == oid:
                            self.tws_status(t, "Filled", filled=1)  # overrides ib_async's local Cancelled / PendingCancel
                        elif t.orderStatus.status in ("PendingSubmit", "PendingCancel"):
                            self.tws_status(t, "PreSubmitted")
                    elif t.orderStatus.status != "Filled":
                        self.tws_status(t, "Cancelled")
            pending.clear()
        ib.cancelOrder = cancel
        self.ticks = ticks = {"n": 0}

        async def sleep(_s):
            ticks["n"] += 1
            land()
            if evolve:
                evolve(ticks["n"], trades)
        ib.warnings = asyncio.run(ex.await_ack(ib, trades, timeout=timeout, sleep=sleep, settle=0.05))
        return ib

    def statuses(self, trades):
        return [t.orderStatus.status for t in trades]

    def test_read_only_rejection_raises_and_cancels_by_the_parent(self):
        import executor as ex

        trades = self.bracket(p=[self.RO])
        with self.assertRaises(ex.ExecutionRefused) as cm:
            self.run_ack(trades)
        self.assertIn("Read-Only", str(cm.exception))
        self.assertEqual(self.ib.cancelled, [4])                                # the children go with the parent
        self.assertEqual(self.statuses(trades), ["Cancelled"] * 3)

    def test_accepted_bracket_returns(self):
        def evolve(n, ts):
            if n == 2:
                for t, s in zip(ts, ("Submitted", "PreSubmitted", "PreSubmitted")):
                    t.orderStatus.status = s
        ib = self.run_ack(self.bracket(), evolve=evolve)
        self.assertEqual((ib.cancelled, ib.warnings), ([], []))

    def test_one_leg_cancelled_kills_the_bracket(self):
        import executor as ex

        def evolve(n, ts):
            if n == 1:
                ts[0].orderStatus.status = "Submitted"
                ts[1].orderStatus.status = "Cancelled"
        trades = self.bracket()
        with self.assertRaises(ex.ExecutionRefused):
            self.run_ack(trades, evolve=evolve)
        self.assertEqual(self.ib.cancelled, [4])
        self.assertEqual(self.statuses(trades), ["Cancelled"] * 3)

    def test_no_acknowledgement_times_out_and_cancels(self):
        import executor as ex

        trades = self.bracket()
        with self.assertRaises(ex.ExecutionRefused) as cm:
            self.run_ack(trades, timeout=0.05)
        self.assertIn("didn't acknowledge", str(cm.exception))
        self.assertIn("cancelled to avoid an orphan [#4 LMT PendingSubmit", str(cm.exception))
        self.assertEqual(self.ib.cancelled, [4])

    def test_rejected_child_of_a_live_unfilled_parent_cancels_only_the_parent(self):
        """A child is never cancelled directly while its parent is live: if the parent fills just as the
        cancel goes out, the stop and take-profit must still be there."""
        import executor as ex

        e201 = NS(status="Cancelled", errorCode=201, message="Error 201: Order rejected - reason: invalid stop price")
        trades = self.bracket(parent="Submitted", stop="Cancelled", tp="PreSubmitted", s=[e201])
        with self.assertRaises(ex.ExecutionRefused) as cm:
            self.run_ack(trades)
        self.assertIn("Error 201", str(cm.exception))
        self.assertEqual(self.ib.cancelled, [4])
        self.assertEqual(self.statuses(trades), ["Cancelled"] * 3)

    def test_late_warning_on_a_filled_entry_keeps_its_protection(self):
        """ib_async logs TWS warnings (here 399) as ValidationError while the order stays live. Once the entry
        has filled, cancelling would strip its stop and leave a naked position that the desk records as 'failed'."""
        trades = self.bracket(parent="Filled", stop="PreSubmitted", tp="PreSubmitted", s=[self.W399])
        trades[0].orderStatus.filled = 1
        ib = self.run_ack(trades)
        self.assertEqual(ib.cancelled, [])
        self.assertEqual(self.statuses(trades), ["Filled", "PreSubmitted", "PreSubmitted"])
        self.assertTrue(ib.warnings[0].startswith("entry filled, so nothing else was cancelled: Warning 399"), ib.warnings)

    def test_filled_entry_with_an_unacknowledged_child_is_not_cancelled_on_timeout(self):
        trades = self.bracket(parent="Filled", stop="PreSubmitted", tp="PendingSubmit")
        trades[0].orderStatus.filled = 1
        ib = self.run_ack(trades, timeout=0.05)
        self.assertEqual(ib.cancelled, [])
        self.assertIn("didn't acknowledge", ib.warnings[0])
        self.assertIn("#6 LMT PendingSubmit", ib.warnings[-1])

    def test_partial_fill_counts_as_a_position(self):
        trades = self.bracket(parent="Submitted", stop="PreSubmitted", tp="PreSubmitted", t=[self.RO])
        trades[0].orderStatus.filled = 1  # 1 share of N filled, the rest still working
        ib = self.run_ack(trades)
        self.assertEqual(ib.cancelled, [])
        self.assertIn("Read-Only", ib.warnings[0])

    def test_pending_submit_parent_that_fills_as_it_is_cancelled_is_a_trade(self):
        """Review of 5751989, reproduced against real ib_async: cancelOrder marks a PendingSubmit, non-transmit
        parent Cancelled locally before TWS answers. The settle check must wait for TWS, which here says Filled."""
        for logs, timeout in (({}, 0.05), ({"s": [self.W399]}, 1.0)):          # ack timeout; a 399 warning on the stop
            with self.subTest(logs=logs):
                trades = self.bracket(**logs)                                   # all PendingSubmit: no TWS status yet
                ib = self.run_ack(trades, timeout=timeout, fill_on_cancel=True)
                self.assertEqual(ib.cancelled, [4])
                self.assertEqual(self.statuses(trades)[0], "Filled")
                self.assertNotIn("Cancelled", self.statuses(trades)[1:])        # stop + take-profit still working
                self.assertIn("filled before the cancel landed", " ".join(ib.warnings))

    def test_settle_wait_is_bounded_when_tws_never_answers_the_cancel(self):
        import executor as ex

        trades = self.bracket(p=[self.RO])
        with self.assertRaises(ex.ExecutionRefused) as cm:
            self.run_ack(trades, silent_tws=True)
        self.assertIn("Read-Only", str(cm.exception))
        self.assertEqual(self.ib.cancelled, [4])
        self.assertGreater(self.ticks["n"], 0)                                  # it did wait, up to settle (0.05 s)

    def test_live_children_of_a_dead_parent_are_cancelled_directly(self):
        import executor as ex

        e201 = NS(status="Cancelled", errorCode=201, message="Error 201: Order rejected - reason: margin")
        trades = self.bracket(parent="Cancelled", stop="PreSubmitted", tp="PreSubmitted", p=[e201])
        with self.assertRaises(ex.ExecutionRefused):
            self.run_ack(trades)
        self.assertEqual(self.ib.cancelled, [5, 6])
        self.assertEqual(self.statuses(trades), ["Cancelled"] * 3)

    E201_STOP = NS(status="Cancelled", errorCode=201, message="Error 201: Order rejected - reason: invalid stop price")

    def test_partly_filled_entry_whose_stop_was_rejected_cancels_its_remainder(self):
        """The filled part has no stop; the remainder must not fill and grow that unprotected position."""
        trades = self.bracket(parent="Submitted", stop="Cancelled", tp="PreSubmitted", s=[self.E201_STOP])
        trades[0].orderStatus.filled = 1  # partly filled, remainder working
        ib = self.run_ack(trades)
        self.assertEqual(ib.cancelled, [4])                                     # the parent's remainder, nothing else
        self.assertTrue(ib.warnings[0].startswith("NO STOP: protective STP #5 is Cancelled"), ib.warnings)
        self.assertEqual(ib.warnings[1], "cancelled the unfilled remainder of #4 (1 filled) so the unprotected position can't grow")

    def test_fully_filled_entry_whose_stop_was_rejected_has_no_remainder_to_cancel(self):
        trades = self.bracket(parent="Filled", stop="Cancelled", tp="PreSubmitted", s=[self.E201_STOP])
        trades[0].orderStatus.filled = 10
        ib = self.run_ack(trades)
        self.assertEqual(ib.cancelled, [])
        self.assertTrue(ib.warnings[0].startswith("NO STOP"), ib.warnings)
        self.assertFalse(any("remainder" in w for w in ib.warnings))

    def test_partly_filled_entry_with_a_working_stop_keeps_its_remainder(self):
        e201_tp = NS(status="Cancelled", errorCode=201, message="Error 201: Order rejected - reason: take-profit price")
        trades = self.bracket(parent="Submitted", stop="PreSubmitted", tp="Cancelled", t=[e201_tp])
        trades[0].orderStatus.filled = 1
        ib = self.run_ack(trades)
        self.assertEqual(ib.cancelled, [])                                      # the stop protects the whole bracket
        self.assertFalse(any(w.startswith("NO STOP") for w in ib.warnings))

    def test_an_execution_reported_before_its_order_status_counts_as_filled(self):
        """ib_async records execDetails in trade.fills before (or without) an orderStatus Filled."""
        trades = self.bracket(parent="Submitted", stop="PreSubmitted", tp="PreSubmitted", t=[self.RO])
        trades[0].fills = [NS(execution=NS(shares=1))]                              # orderStatus.filled still 0
        ib = self.run_ack(trades)
        self.assertEqual(ib.cancelled, [])
        self.assertTrue(any(w.startswith("entry filled") for w in ib.warnings), ib.warnings)

    def test_a_cancel_that_cannot_be_sent_is_not_reported_as_cancelled(self):
        import executor as ex

        trades = self.bracket()

        def down(_o):
            raise ConnectionError("Not connected")
        with self.assertRaises(ex.ExecutionRefused) as cm:
            asyncio.run(ex.await_ack(NS(cancelOrder=down), trades, timeout=0.05, sleep=self._noop_sleep, settle=0.05))
        msg = str(cm.exception)
        self.assertIn("could NOT be sent, so it may still be working", msg)
        self.assertNotIn("cancelled to avoid an orphan", msg)

    @staticmethod
    async def _noop_sleep(_s):
        return None

    def test_nothing_left_to_cancel_means_no_settle_wait(self):
        import executor as ex

        e201 = NS(status="Cancelled", errorCode=201, message="Error 201: Order rejected")
        trades = self.bracket(parent="Cancelled", stop="Cancelled", tp="Cancelled", p=[e201])
        with self.assertRaises(ex.ExecutionRefused):
            self.run_ack(trades)
        self.assertEqual((self.ib.cancelled, self.ticks["n"]), ([], 0))

    def test_entry_that_fills_before_the_cancel_lands_is_a_trade_not_a_failure(self):
        trades = self.bracket(parent="Submitted", stop="PreSubmitted", tp="PendingSubmit", t=[self.RO])
        ib = self.run_ack(trades, fill_on_cancel=True)
        self.assertEqual(ib.cancelled, [4])                                     # only the parent was sent a cancel
        self.assertEqual(self.statuses(trades), ["Filled", "PreSubmitted", "PreSubmitted"])  # children never cancelled
        self.assertIn("filled before the cancel landed", " ".join(ib.warnings))

    def test_place_reports_ack_warnings_on_the_result(self):
        import executor as ex
        from test_trading_desk import raw_intent

        w399 = self.W399
        done = self.DONE
        cancels = []

        class IB:
            client = NS(getReqId=lambda: 4)

            def __init__(self):
                self.n = 0

            def isConnected(self):
                return True

            async def qualifyContractsAsync(self, _c):
                return [NS(conId=756733)]

            def placeOrder(self, _contract, o):
                self.n += 1  # 1 = entry (fills at once), 2 = stop (a 399 warning), 3 = take-profit
                o.orderId = getattr(o, "orderId", 0) or 3 + self.n  # ib_async gives children their own ids here
                st, filled, log = {1: ("Filled", 1, []), 2: ("PreSubmitted", 0, [w399])}.get(self.n, ("PreSubmitted", 0, []))
                t = NS(order=o, orderStatus=NS(status=st, filled=filled), log=list(log))
                t.isDone = lambda: t.orderStatus.status in done
                return t

            def cancelOrder(self, o):
                cancels.append(o.orderId)  # recorded, not raised: _cancel_live swallows exceptions from cancelOrder

        f = {"limit": lambda a, q, p: NS(orderType="LMT", action=a, totalQuantity=q, lmtPrice=p),
             "market": lambda a, q: NS(orderType="MKT", action=a, totalQuantity=q),
             "stop": lambda a, q, p: NS(orderType="STP", action=a, totalQuantity=q, auxPrice=p),
             "stock": lambda s, e, c: NS(symbol=s)}
        with tempfile.TemporaryDirectory() as td:
            e = ex.Executor(lock_dir=Path(td))
            e.ib = IB()
            res = asyncio.run(e.place(parse_intent(raw_intent()), 1, factories=f))
        self.assertEqual([(o["type"], o["status"]) for o in res["orders"]], [("LMT", "Filled"), ("STP", "PreSubmitted"), ("LMT", "PreSubmitted")])
        self.assertIn("Warning 399", res["ackWarnings"][0])
        self.assertEqual(cancels, [])                                           # a filled entry's legs are never cancelled


class LockPolicyTests(unittest.TestCase):
    """Which locks let the options guard keep sending risk-reducing exits (kill_switch.allows_risk_reducing)."""

    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        root = Path(self.td.name)
        self.d = root / "trading"  # the security dir is its sibling, as data/trading and data/security
        self.d.mkdir()
        self.sec = root / "security"
        self.env = mock.patch.dict(os.environ, {"AGENTIC_OS_SECURITY_DIR": ""})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.td.cleanup()

    def test_a_security_hard_lock_stands_the_guard_down_even_over_a_lock_only_breaker(self):
        """The remote / Rust failsafe never overwrites a held lock; their hard lock is the signal."""
        import desk_lock
        import kill_switch as ks

        desk_lock.lock(self.d, "storm", "overseer", source="overseer", breaker="REJECTION_STORM")
        self.assertTrue(ks.allows_risk_reducing(self.d))
        self.sec.mkdir()
        for state, allowed in (('{"hardLocked": true}', False), ('{"hardLocked": false}', True), ("{broken", False)):
            (self.sec / "state.json").write_text(state, encoding="utf-8")
            self.assertEqual(ks.allows_risk_reducing(self.d), allowed, state)

    def test_malformed_locks_fail_closed(self):
        import kill_switch as ks

        base = {"locked": True, "source": "overseer", "incidentId": "i"}
        for lk in ({**base, "breakers": [{"code": "REJECTION_STORM"}, "junk"]},          # a non-dict entry
                   {**base, "breakers": [{"code": "REJECTION_STORM"}], "killedAt": None},  # killed, however stamped
                   {**base, "breakers": {"code": "REJECTION_STORM"}},                   # not a list
                   {**base, "breakers": []}):
            ks.lock_path(self.d).write_text(json.dumps(lk), encoding="utf-8")
            self.assertFalse(ks.allows_risk_reducing(self.d), lk)

    def test_kill_stamp_waits_at_most_a_second_for_a_lock_another_process_holds(self):
        """The real file lock, held by another process (as the overseer would): the E-stop's stamp gives up in ~1 s."""
        import subprocess
        import desk_lock
        import kill_switch as ks
        import time as _t

        desk_lock.lock(self.d, "storm", "overseer", source="overseer", breaker="REJECTION_STORM")
        holder = subprocess.Popen(
            [sys.executable, "-c", "import sys, time; sys.path.insert(0, sys.argv[1]); from ledger import file_lock\n"
             "with file_lock(__import__('pathlib').Path(sys.argv[2])):\n print('held', flush=True); time.sleep(8)",
             str(Path(__file__).resolve().parent.parent / "trading"), str(ks.lock_path(self.d).with_name(ks.LOCK_NAME + ".lock"))],
            stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(holder.stdout.readline().strip(), "held")
            t0 = _t.monotonic()
            out = ks.write_lock("E-stop", "ui", "inc-2", self.d)
            took = _t.monotonic() - t0
        finally:
            holder.kill()
            holder.wait()
        self.assertGreaterEqual(took, 0.9)
        self.assertLess(took, 3.0)
        self.assertIn("TimeoutError", out["stampFailed"])
        self.assertNotIn("killedAt", ks.read_lock(self.d))                          # not stamped without the lock

    def test_kill_stamp_never_blocks_or_raises(self):
        import desk_lock
        import kill_switch as ks
        import time as _t

        first = desk_lock.lock(self.d, "storm", "overseer", source="overseer", breaker="REJECTION_STORM")
        with mock.patch("ledger.file_lock", side_effect=TimeoutError("held by another process")):
            t0 = _t.monotonic()
            out = ks.write_lock("E-stop", "ui", "inc-1", self.d)
        self.assertLess(_t.monotonic() - t0, 0.5)
        self.assertEqual(out["incidentId"], first["incidentId"])
        self.assertIn("TimeoutError", out["stampFailed"])

    def test_a_failing_lock_step_never_stops_the_e_stop(self):
        import kill_switch as ks
        from audit import AuditLog

        connected = []

        async def connect(readonly):  # never a real TWS in tests
            connected.append(readonly)
            raise ConnectionError("no TWS in tests")
        with mock.patch.object(ks, "write_lock", side_effect=PermissionError("replace denied")):
            inc = asyncio.run(ks.execute_kill(reason="t", actor="t", dry_run=False, connect=connect, audit=AuditLog(self.d / "a.db"), d=self.d))
        self.assertEqual((inc["steps"][0]["step"], inc["steps"][0]["ok"]), ("lock", False))
        self.assertEqual(connected, [False])                                          # it still went on to cancel / flatten
        self.assertIn("lock: replace denied", inc["errors"])

    def test_matrix(self):
        import desk_lock
        import kill_switch as ks

        self.assertTrue(ks.allows_risk_reducing(self.d))                           # unlocked
        cases = [
            (lambda: desk_lock.lock(self.d, "overseer: REJECTION_STORM", "overseer", source="overseer", breaker="REJECTION_STORM"), True),
            (lambda: desk_lock.lock(self.d, "drift", "cli", breaker="STATE_DRIFT"), True),                     # desk-cli source
            (lambda: desk_lock.lock(self.d, "manual", "cli", breaker="MANUAL_LOCK"), False),                  # operator's lock
            (lambda: desk_lock.lock(self.d, "overseer: DMS_CC", "overseer", source="overseer", breaker="DMS_CC"), False),  # liquidates
            (lambda: desk_lock.lock(self.d, "kill", "cli", breaker="KILL"), False),
            (lambda: ks.write_lock("E-stop", "ui", "inc", self.d), False),                                    # the kill switch
            (lambda: ks.lock_path(self.d).write_text(json.dumps({"locked": True, "source": "security-failsafe", "incidentId": "x"})), False),
            (lambda: ks.lock_path(self.d).write_text("{not json"), False),                                    # unreadable
        ]
        for make, allowed in cases:
            ks.lock_path(self.d).unlink(missing_ok=True)
            make()
            self.assertEqual(ks.allows_risk_reducing(self.d), allowed, ks.read_lock(self.d))
        ks.lock_path(self.d).unlink()
        desk_lock.lock(self.d, "storm", "overseer", source="overseer", breaker="REJECTION_STORM")
        desk_lock.lock(self.d, "dms", "overseer", source="overseer", breaker="DMS_CC")                      # widened
        self.assertFalse(ks.allows_risk_reducing(self.d))

    def test_kill_on_top_of_a_breaker_lock_stamps_it_and_keeps_the_first_cause(self):
        import desk_lock
        import kill_switch as ks

        first = desk_lock.lock(self.d, "overseer: REJECTION_STORM", "overseer", source="overseer", breaker="REJECTION_STORM")
        out = ks.write_lock("E-stop from the phone", "webhook", "inc-9", self.d)
        self.assertEqual((out["incidentId"], out["breakers"], out["reason"]), (first["incidentId"], first["breakers"], first["reason"]))
        self.assertEqual((out["killIncidentId"], out["killReason"]), ("inc-9", "E-stop from the phone"))
        self.assertGreaterEqual(out["updatedAt"], out["killedAt"])                 # invalidates an older reconcile
        self.assertEqual(ks.read_lock(self.d), out)
        self.assertFalse(ks.allows_risk_reducing(self.d))

    def test_executor_guard_lets_only_risk_reducing_calls_through_a_breaker_lock(self):
        import desk_lock
        import executor as ex

        desk_lock.lock(self.d, "storm", "overseer", source="overseer", breaker="REJECTION_STORM")
        e = ex.Executor(lock_dir=self.d)
        e._guard(risk_reducing=True)                                               # options guard exit: allowed
        with self.assertRaises(ex.ExecutionRefused):
            e._guard()                                                             # a new entry: refused
        import kill_switch as ks
        ks.write_lock("E-stop", "ui", "inc", self.d)
        with self.assertRaises(ex.ExecutionRefused):
            e._guard(risk_reducing=True)                                           # after a kill: refused too


class RiskReducingExecutorTests(unittest.TestCase):
    """The real Executor's risk-reducing calls (close_option, cancel_working, working_qty) under each lock state."""

    DONE = AckTests.DONE

    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        root = Path(self.td.name)
        self.d = root / "trading"  # its sibling root/"security" (absent) is the security dir
        self.d.mkdir()
        self.env = mock.patch.dict(os.environ, {"AGENTIC_OS_SECURITY_DIR": ""})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.td.cleanup()

    def executor(self, open_trades=()):
        import executor as ex

        placed, cancelled, done = [], [], self.DONE

        def trade(o, status="Submitted", filled=0.0, remaining=None):
            t = NS(order=o, orderStatus=NS(status=status, filled=filled, remaining=remaining if remaining is not None else o.totalQuantity), log=[])
            t.isDone = lambda: t.orderStatus.status in done
            return t

        class IB:
            def isConnected(self):
                return True

            def placeOrder(self, _c, o):
                o.orderId = 77
                placed.append(o)
                return trade(o, status="PreSubmitted")

            def cancelOrder(self, o):
                cancelled.append(o.orderId)

            async def reqAllOpenOrdersAsync(self):
                return []

            def openTrades(self):
                return [trade(NS(orderId=i, orderRef=ref, totalQuantity=q), filled=f, remaining=r) for i, ref, q, f, r in open_trades] + \
                       [NS(order=NS(orderId=9, orderRef="other"), orderStatus=NS(status="Submitted", filled=0, remaining=5),
                           contract=NS(conId=1, secType="OPT", symbol="SPY"), isDone=lambda: False)]

        e = ex.Executor(lock_dir=self.d)
        e.ib = IB()
        return e, placed, cancelled

    F = {"limit": lambda a, q, p: NS(orderType="LMT", action=a, totalQuantity=q, lmtPrice=p),
         "market": lambda a, q: NS(orderType="MKT", action=a, totalQuantity=q)}

    def close(self, e):
        async def sleep(_s):
            return None
        return asyncio.run(e.close_option(NS(conId=1, secType="OPT", exchange="SMART"), 1, 1.7, "GUARD-STOP-x", factories=self.F, sleep=sleep, ack_timeout=0.05))

    def test_exits_go_out_under_a_lock_only_breaker_and_stop_after_a_kill(self):
        import desk_lock
        import executor as ex
        import kill_switch

        desk_lock.lock(self.d, "storm", "overseer", source="overseer", breaker="REJECTION_STORM")
        e, placed, _ = self.executor()
        self.assertEqual(self.close(e)["status"], "PreSubmitted")
        self.assertEqual(len(placed), 1)
        kill_switch.write_lock("E-stop", "ui", "inc", self.d)
        with self.assertRaises(ex.ExecutionRefused):
            self.close(e)
        with self.assertRaises(ex.ExecutionRefused):
            asyncio.run(e.cancel_working(ref="x"))
        self.assertEqual(len(placed), 1)

    def test_cancel_working_runs_under_a_lock_only_breaker(self):
        import desk_lock

        desk_lock.lock(self.d, "drift", "cli", breaker="STATE_DRIFT")
        e, _, cancelled = self.executor(open_trades=[(5, "opt-1", 1.0, 0.0, 1.0)])
        self.assertEqual(asyncio.run(e.cancel_working(ref="opt-1")), 1)
        self.assertEqual(cancelled, [5])

    def test_stand_down_refuses_risk_reducing_calls_but_not_the_entry_guard(self):
        import executor as ex

        e, placed, _ = self.executor()
        e.stand_down = True
        with self.assertRaises(ex.ExecutionRefused) as cm:
            self.close(e)
        self.assertIn("standing down", str(cm.exception))
        with self.assertRaises(ex.ExecutionRefused):
            e._guard(risk_reducing=True)
        e._guard()                                                                  # entries: only the lock file decides
        self.assertEqual(placed, [])

    def test_working_qty_counts_an_order_without_a_status_yet_in_full(self):
        e, _, _ = self.executor(open_trades=[(5, "GUARD-STOP-x", 2.0, 0.0, 0.0), (6, "GUARD-STOP-x", 3.0, 1.0, 2.0), (7, "GUARD-STOP-y", 4.0, 0.0, 4.0)])
        self.assertEqual(asyncio.run(e.working_qty("GUARD-STOP-x")), 4.0)          # 2 (no status: in full) + 2 remaining


class CloseOptionAckTests(unittest.TestCase):
    """The options guard's exit (premium stop / expiry flatten) must be acknowledged by TWS before the desk
    records it, but a TWS *warning* on a live exit must not cancel it: that would undo the risk reduction."""

    DONE = AckTests.DONE

    def close(self, status="PendingSubmit", log=(), evolve=None, filled=0, ack_timeout=1.0):
        """Run Executor.close_option against a fake TWS. evolve(tick, trade) moves the order's state; a cancel lands
        on the next tick. Returns (result or exception, cancelled ids, trade)."""
        import executor as ex

        box, cancelled, pending = {}, [], []

        class IB:
            def isConnected(self):
                return True

            def placeOrder(self, _contract, o):
                o.orderId = 77
                t = NS(order=o, orderStatus=NS(status=status, filled=filled), log=list(log))
                t.isDone = lambda: t.orderStatus.status in CloseOptionAckTests.DONE
                box["t"] = t
                return t

            def cancelOrder(self, o):
                cancelled.append(o.orderId)
                pending.append(o.orderId)
                AckTests.ib_async_cancel(box["t"])  # ib_async: PendingCancel locally (an exit transmits)

        ticks = {"n": 0}

        async def sleep(_s):
            ticks["n"] += 1
            if pending:
                AckTests.tws_status(box["t"], "Cancelled")  # TWS confirms on the next tick
                pending.clear()
            if evolve:
                evolve(ticks["n"], box["t"])

        f = {"limit": lambda a, q, p: NS(orderType="LMT", action=a, totalQuantity=q, lmtPrice=p),
             "market": lambda a, q: NS(orderType="MKT", action=a, totalQuantity=q)}
        with tempfile.TemporaryDirectory() as td:
            e = ex.Executor(lock_dir=Path(td))
            e.ib = IB()
            try:
                out = asyncio.run(e.close_option(NS(conId=1, secType="OPT", exchange="SMART"), 1, 1.7, "GUARD-STOP-opt-000001",
                                                 factories=f, sleep=sleep, ack_timeout=ack_timeout))
            except ex.ExecutionRefused as err:
                out = err
        return out, cancelled, box["t"]

    def test_acknowledged_exit_returns(self):
        out, cancelled, _ = self.close(evolve=lambda n, t: setattr(t.orderStatus, "status", "Submitted") if n == 1 else None)
        self.assertEqual((out["status"], cancelled, "ackWarnings" in out), ("Submitted", [], False))

    def test_refused_exit_raises_so_the_guard_retries(self):
        import executor as ex

        e201 = NS(status="Cancelled", errorCode=201, message="Error 201: Order rejected - reason: no trading permissions")
        out, cancelled, _ = self.close(status="Cancelled", log=[e201])
        self.assertIsInstance(out, ex.ExecutionRefused)
        self.assertIn("Error 201", str(out))
        self.assertEqual(cancelled, [])  # nothing was live to cancel

    def test_read_only_exit_never_acknowledged_is_cancelled_and_raises(self):
        """321 Read-Only: ib_async marks it ValidationError and TWS never gives it a live status."""
        import executor as ex

        out, cancelled, t = self.close(status="ValidationError", log=[AckTests.RO], ack_timeout=0.05)
        self.assertIsInstance(out, ex.ExecutionRefused)
        self.assertIn("didn't acknowledge", str(out))
        self.assertIn("Read-Only", str(out))
        self.assertEqual((cancelled, t.orderStatus.status), ([77], "Cancelled"))

    def test_warning_on_a_live_exit_does_not_cancel_it(self):
        """399 and friends: logged as ValidationError, then TWS gives the order a live status. It must keep working."""
        out, cancelled, t = self.close(status="ValidationError", log=[AckTests.W399],
                                       evolve=lambda n, tr: setattr(tr.orderStatus, "status", "PreSubmitted") if n == 1 else None)
        self.assertEqual((cancelled, t.orderStatus.status), ([], "PreSubmitted"))
        self.assertTrue(out["ackWarnings"][0].startswith("TWS warning (order not cancelled): Warning 399"), out)

    def test_warning_after_the_live_status_does_not_cancel_a_live_exit(self):
        """ib_async's error() sets status = ValidationError for a 399 even on a PreSubmitted order. If TWS then says
        nothing more, the exit is still live: it must not be cancelled as 'not acknowledged'."""
        def evolve(n, t):
            if n == 1:
                AckTests.tws_status(t, "PreSubmitted")
                t.log.append(AckTests.W399)
                t.orderStatus.status = "ValidationError"
        out, cancelled, t = self.close(evolve=evolve, ack_timeout=0.05)
        self.assertEqual((cancelled, t.orderStatus.status), ([], "ValidationError"))
        self.assertIn("Warning 399", out["ackWarnings"][0])

    def test_filled_exit_is_never_cancelled(self):
        out, cancelled, _ = self.close(status="Filled", filled=1, log=[AckTests.RO])
        self.assertEqual(cancelled, [])
        self.assertEqual(out["status"], "Filled")

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
        self.working = {}  # orderRef -> qty TWS still has working (Executor.working_qty)

    async def cancel_working(self, **kw):
        self.calls.append(("cancel", kw))
        return 1

    async def working_qty(self, ref):
        return self.working.get(ref, 0.0)

    async def close_option(self, contract, qty, limit, ref, action="SELL"):
        self.calls.append(("close", contract.conId if hasattr(contract, "conId") else contract, qty, limit, action, ref))
        return {"orderId": 77, "status": "Submitted"}

    async def _ensure(self, **_kw):
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
                    option_quote_fn=option_quote, market_data=md or FakeMD(), d=self.d, clock=lambda: NOW,
                    pretrade=False)  # engine flow only; the pre-trade gates are tested in test_trading_desk_pretrade.py

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

    def _premium_stop_desk(self):
        async def fixed(intent):
            return {"bid": 3.9, "ask": 4.1}, [dict(LIQ_LEG) for _ in intent.legs]
        dk = self.desk(option_quote=fixed)
        dk.set_mode("FULL_AUTO", "t", confirm=True)
        asyncio.run(dk.submit(opt_raw(), "t"))
        dk.bridge = big_bridge(positions=[{"conId": 1, "symbol": "SPY 730C", "underlying": "SPY", "secType": "OPT", "position": 2,
                                           "expiry": exp(30), "strike": 730.0, "right": "C", "currency": "USD"}])

        async def crashed(intent):
            return {"bid": 1.7, "ask": 1.9}, []
        dk._option_quote = crashed
        return dk

    def test_guard_premium_stop_refused_by_tws_is_retried_not_recorded(self):
        """Before close_option waited for TWS, a refused exit was recorded as closed_stop and never looked at again."""
        from executor import ExecutionRefused

        dk = self._premium_stop_desk()
        real = self.ex.close_option
        tries = []

        async def refuse_once(*a, **kw):
            tries.append(a[3])
            if len(tries) == 1:
                raise ExecutionRefused("TWS rejected the order: Warning 321: The API interface is currently in Read-Only mode.")
            return await real(*a, **kw)
        self.ex.close_option = refuse_once
        rep = asyncio.run(dk.options_guard())
        self.assertEqual(rep["stops"], [])
        self.assertIn("Read-Only", rep["errors"][0])
        self.assertEqual(dk._row("opt-000001")["status"], "submitted")           # still watched
        failed = dk.audit.tail(10, kinds=("options_premium_stop",))[0]
        self.assertEqual((failed["verdict"], failed["ref"]), ("FAILED", "opt-000001"))
        self.assertIn("Read-Only", failed["payload"]["error"])
        self.assertEqual(asyncio.run(dk.options_guard())["waiting"][0]["key"], "stop:opt-000001")  # backing off
        self.assertEqual(tries, ["GUARD-STOP-opt-000001"])
        dk.clock = lambda: NOW + 61                                                  # past the first backoff
        rep2 = asyncio.run(dk.options_guard())                                     # retried
        self.assertEqual(len(rep2["stops"]), 1, rep2)
        self.assertEqual(dk._row("opt-000001")["status"], "closed_stop")
        self.assertEqual(tries, ["GUARD-STOP-opt-000001"] * 2)

    def test_guard_expiry_flatten_refusal_is_audited_and_replanned(self):
        from executor import ExecutionRefused

        pos = [{"conId": 1, "symbol": "SPY 730C", "underlying": "SPY", "secType": "OPT", "position": 2, "expiry": exp(1), "currency": "USD"}]
        dk = self.desk(bridge=big_bridge(positions=pos), md=FakeMD())
        real = self.ex.close_option
        tries = []

        async def refuse_once(*a, **kw):
            tries.append(a[3])
            if len(tries) == 1:
                raise ExecutionRefused("TWS didn't acknowledge the order within 15s; cancelled to avoid an orphan [#77 MKT PendingSubmit]")
            return await real(*a, **kw)
        self.ex.close_option = refuse_once
        rep = asyncio.run(dk.options_guard(contract_factory=lambda **kw: NS(**kw)))
        self.assertEqual(rep["flatten"], [])
        row = dk.audit.tail(10, kinds=("options_expiry_flatten",))[0]
        self.assertEqual((row["verdict"], row["ref"]), ("FAILED", "1"))
        dk.clock = lambda: NOW + 61                                                  # past the first backoff
        rep2 = asyncio.run(dk.options_guard(contract_factory=lambda **kw: NS(**kw)))
        self.assertEqual(len(rep2["flatten"]), 1)
        self.assertEqual(tries, ["GUARD-EXP-1"] * 2)

    HELD = [{"conId": 1, "symbol": "SPY 730C", "underlying": "SPY", "secType": "OPT", "position": 2, "expiry": exp(30),
             "strike": 730.0, "right": "C", "currency": "USD"}]

    def _failing_close(self, exc_text, fail_times=99):
        from executor import ExecutionRefused

        real, tries = self.ex.close_option, []

        async def close(*a, **kw):
            tries.append(a[3])
            if len(tries) <= fail_times:
                raise ExecutionRefused(exc_text)
            return await real(*a, **kw)
        self.ex.close_option = close
        return tries

    def test_guard_premium_stop_never_doubles_an_exit_still_working(self):
        """close_option raised, but the exit lived on at TWS (lost ack / dropped socket): the next pass must see it
        working in the bridge's snapshot and not send a second full-size SELL."""
        dk = self._premium_stop_desk()
        tries = self._failing_close("TWS didn't acknowledge the order within 15s; the cancel for #77 could NOT be sent, so it may still be working")
        asyncio.run(dk.options_guard())
        working = {"orderRef": "GUARD-STOP-opt-000001", "conId": 1, "action": "SELL", "quantity": 1.0, "remaining": 1.0, "status": "Submitted"}
        dk.bridge = big_bridge(positions=self.HELD, openOrders=[working])
        dk.clock = lambda: NOW + 600                                               # well past any backoff
        rep = asyncio.run(dk.options_guard())
        self.assertEqual(tries, ["GUARD-STOP-opt-000001"])                        # not sent again
        self.assertIn("already done or working (filled 0, working 1)", rep["waiting"][0]["why"])
        self.assertEqual(dk._row("opt-000001")["status"], "submitted")

    def test_guard_retries_back_off_and_count_once_toward_the_rejection_storm(self):
        import desk_sources

        dk = self._premium_stop_desk()
        tries = self._failing_close("TWS rejected the order: Error 201: no trading permissions")
        verdicts = []
        for t, expect_try in ((0, 1), (30, 1), (61, 2), (100, 2), (182, 3)):     # backoff 60 s, then 120 s
            dk.clock = lambda t=t: NOW + t
            asyncio.run(dk.options_guard())
            self.assertEqual(len(tries), expect_try, t)
        verdicts = [r["verdict"] for r in reversed(dk.audit.tail(10, kinds=("options_premium_stop",)))]
        self.assertEqual(verdicts, ["FAILED", "RETRY_FAILED", "RETRY_FAILED"])
        self.assertEqual(desk_sources.audit_failures_since(self.d, 0), 1)      # what the overseer's storm check counts

    def test_guard_keeps_exiting_under_a_lock_only_breaker_but_not_after_a_kill(self):
        import desk_lock
        import kill_switch

        dk = self._premium_stop_desk()
        desk_lock.lock(self.d, "overseer: REJECTION_STORM", "overseer", source="overseer", breaker="REJECTION_STORM")
        rep = asyncio.run(dk.options_guard())
        self.assertEqual(rep.get("underLock"), ["REJECTION_STORM"])
        self.assertEqual(len(rep["stops"]), 1, rep)                                 # the premium stop still ran
        kill_switch.write_lock("E-stop", "ui", "inc-1", self.d)                    # E-stop on top: it flattens everything
        self.assertTrue(kill_switch.read_lock(self.d).get("killedAt"))
        self.assertIn("skipped", asyncio.run(dk.options_guard()))                  # so the guard stands down

    def test_a_kill_stands_the_guard_down_in_process_even_if_the_lock_stamp_failed(self):
        import kill_switch

        dk = self._premium_stop_desk()

        async def no_tws(_readonly):  # never a real TWS in tests: this kill must not touch the network
            raise ConnectionError("no TWS in tests")
        dk._kill_connect = no_tws
        asyncio.run(dk.kill("E-stop", "ui"))
        self.assertTrue(dk._killed and self.ex.stand_down)
        with mock.patch.object(kill_switch, "allows_risk_reducing", return_value=True):  # as if the stamp had failed
            self.assertIn("skipped", asyncio.run(dk.options_guard()))
        self.assertFalse([c for c in self.ex.calls if c[0] == "close"])
        dk.reset("RESET", "ui")
        self.assertFalse(dk._killed or self.ex.stand_down)

    def test_premium_stop_yields_to_the_expiry_flatten_inside_its_window(self):
        """Inside the expiry window step 1 owns the legs; a premium stop as well would stack a second SELL."""
        import desk as desk_mod

        dk = self._premium_stop_desk()
        with mock.patch.object(desk_mod.opt, "must_flatten", return_value=True):
            rep = asyncio.run(dk.options_guard())
        self.assertEqual(rep["stops"], [])
        self.assertFalse([c for c in self.ex.calls if c[0] == "close" and str(c[5]).startswith("GUARD-STOP")])
        self.assertEqual(dk._row("opt-000001")["status"], "submitted")

    def _kill(self, dk, write_lock_fails=False):
        import kill_switch

        async def no_tws(_readonly):  # never a real TWS in tests: this kill must not touch the network
            raise ConnectionError("no TWS in tests")
        dk._kill_connect = no_tws
        if write_lock_fails:
            with mock.patch.object(kill_switch, "write_lock", side_effect=PermissionError("replace denied")):
                asyncio.run(dk.kill("E-stop", "ui"))
        else:
            asyncio.run(dk.kill("E-stop", "ui"))

    def test_stand_down_clears_after_an_unlock_elsewhere_and_the_settle(self):
        """desk-cli unlock runs in another process: Desk.reset never runs. The guard must not stay silently off
        once trading is unlocked and re-armed."""
        import desk as desk_mod
        import desk_lock

        dk = self._premium_stop_desk()
        self._kill(dk)
        desk_lock.write_reconcile_stamp(self.d, True, {})                           # a passing reconcile after the kill...
        desk_lock.unlock(self.d, "cli", 1e9)                                       # ...then desk-cli unlock (wall clock, as the lock)
        self.assertIn("skipped", asyncio.run(dk.options_guard()))                 # the flatten is still settling
        with self.assertRaises(PermissionError):
            dk.set_mode("FULL_AUTO", "t", confirm=True)
        dk.clock = lambda: NOW + desk_mod.KILL_SETTLE_S + 1
        rep = asyncio.run(dk.options_guard())
        self.assertNotIn("skipped", rep)
        self.assertEqual(len(rep["stops"]), 1, rep)                                 # the premium stop is back
        self.assertFalse(dk._killed or self.ex.stand_down)
        self.assertEqual(dk.audit.tail(5, kinds=("kill_stand_down_cleared",))[0]["verdict"], "OK")
        dk.set_mode("FULL_AUTO", "t", confirm=True)                                # re-arming works again

    def test_stand_down_clears_after_a_kill_whose_lock_step_failed(self):
        import desk as desk_mod
        import kill_switch

        dk = self._premium_stop_desk()
        self._kill(dk, write_lock_fails=True)
        self.assertFalse(kill_switch.is_locked(self.d))
        self.assertIn("skipped", asyncio.run(dk.options_guard()))
        dk.clock = lambda: NOW + desk_mod.KILL_SETTLE_S + 1
        self.assertEqual(len(asyncio.run(dk.options_guard())["stops"]), 1)

    def test_premium_stop_retry_nets_out_what_an_earlier_attempt_filled(self):
        """The line holds 2, the intent owns 1. A first exit raised but filled at TWS: a retry must not sell the
        other contract. The fill is kept on the intent row, so the next day (no fill in the snapshot) still knows."""
        dk = self._premium_stop_desk()
        tries = self._failing_close("TWS didn't acknowledge the order within 15s; the cancel for #77 could NOT be sent, so it may still be working")
        asyncio.run(dk.options_guard())
        held_after = [{**self.HELD[0], "position": 1}]                             # the exit filled: 2 -> 1
        fill = {"execId": "0001.01", "orderRef": "GUARD-STOP-opt-000001", "conId": 1, "side": "SLD", "shares": 1.0}
        dk.bridge = big_bridge(positions=held_after, fills=[fill])
        dk.clock = lambda: NOW + 600
        rep = asyncio.run(dk.options_guard())
        self.assertEqual(tries, ["GUARD-STOP-opt-000001"])                        # not sent again
        self.assertIn("already done or working (filled 1", rep["waiting"][0]["why"])
        self.assertEqual(dk._row("opt-000001")["result"]["exitFills"], {"0001.01": 1.0})
        dk.bridge = big_bridge(positions=held_after, fills=[])                     # next day: today's fills are empty
        dk.clock = lambda: NOW + 86_400
        asyncio.run(dk.options_guard())
        self.assertEqual(tries, ["GUARD-STOP-opt-000001"])

    def test_premium_stop_checks_tws_itself_for_a_working_exit(self):
        """The bridge snapshot is polled; the executor's fresh reqAllOpenOrders is the last word."""
        dk = self._premium_stop_desk()
        self.ex.working["GUARD-STOP-opt-000001"] = 1.0
        rep = asyncio.run(dk.options_guard())
        self.assertFalse([c for c in self.ex.calls if c[0] == "close"])
        self.assertIn("still working at TWS", rep["waiting"][0]["why"])

    def test_guard_stands_down_under_an_operator_lock(self):
        import desk_lock

        dk = self._premium_stop_desk()
        desk_lock.lock(self.d, "manual", "cli", breaker="MANUAL_LOCK")
        self.assertIn("skipped", asyncio.run(dk.options_guard()))
        self.assertFalse([c for c in self.ex.calls if c[0] == "close"])

    def test_expiry_flatten_never_sells_the_long_leg_after_a_failed_short_buy_back(self):
        pos = [{"conId": 1, "symbol": "SPY 730C", "underlying": "SPY", "secType": "OPT", "position": 2, "expiry": exp(1), "currency": "USD"},
               {"conId": 2, "symbol": "SPY 740C", "underlying": "SPY", "secType": "OPT", "position": -2, "expiry": exp(1), "currency": "USD"},
               {"conId": 3, "symbol": "QQQ 500C", "underlying": "QQQ", "secType": "OPT", "position": 1, "expiry": exp(1), "currency": "USD"}]
        dk = self.desk(bridge=big_bridge(positions=pos), md=FakeMD())
        tries = self._failing_close("TWS rejected the order: Error 201", fail_times=1)  # the first close (SPY short buy-back) fails
        rep = asyncio.run(dk.options_guard(contract_factory=lambda **kw: NS(**kw)))
        self.assertEqual(tries, ["GUARD-EXP-2", "GUARD-EXP-3"])                   # SPY long not sold; QQQ unaffected
        self.assertTrue(any("buying back the short leg on SPY" in e for e in rep["errors"]), rep["errors"])
        dk.clock = lambda: NOW + 30                                                # still backing off: the long stays held too
        asyncio.run(dk.options_guard(contract_factory=lambda **kw: NS(**kw)))
        self.assertNotIn("GUARD-EXP-1", tries)

    def test_guard_skips_when_locked(self):
        import kill_switch

        dk = self.desk()
        kill_switch.write_lock("x", "t", "inc", self.d)
        self.assertIn("skipped", asyncio.run(dk.options_guard()))


if __name__ == "__main__":
    unittest.main()
