"""Tests for trading/safety_actions.py over tests/fake_tws.py. No TWS, no bridge, no data dir:
every ledger lives in a temp dir, every broker is a FakeBroker, `sleep` is a fake-clock no-op."""

import asyncio
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "trading"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import risk_policy  # noqa: E402
import safety_actions as sa  # noqa: E402
from fake_tws import FakeBroker, FakeTws, factory  # noqa: E402
from ledger import Ledger  # noqa: E402
from tws_adapter import DONE, ReadOnlyAdapter  # noqa: E402

SPY, QQQ = 756733, 320227571
ACT = 21  # overseer_act


def run(coro):
    return asyncio.run(coro)


class FakeClock:
    """Monotonic clock that only moves when the code under test sleeps."""

    def __init__(self) -> None:
        self.t = 1000.0
        self.sleeps = 0

    def __call__(self) -> float:
        return self.t

    async def sleep(self, s: float) -> None:
        self.sleeps += 1
        self.t += s


# ── adapters that misbehave in specific ways ─────────────────────────
class StickyTws(FakeTws):
    """cancel_order is accepted but never takes effect (status stays working)."""

    async def cancel_order(self, order_id):
        self._require_rw()
        await self._ensure()
        self.b.actions.append(("cancel_ignored", self.client_id, order_id))


class FillOnCancelTws(FakeTws):
    """The stop fills while we are cancelling it (race with the market)."""

    async def cancel_order(self, order_id):
        self._require_rw()
        await self._ensure()
        o = self.b.orders[order_id]
        if o["orderType"] == "STP" and o["status"] not in DONE:
            self.b.fill(order_id, o["stopPrice"])
            return
        await super().cancel_order(order_id)


class LyingStatusTws(FakeTws):
    """order_status claims Cancelled, but the order is still resting at the broker."""

    async def cancel_order(self, order_id):
        self._require_rw()
        await self._ensure()
        self.b.actions.append(("cancel_ignored", self.client_id, order_id))

    async def order_status(self, order_id):
        await self._ensure()
        return {"orderId": order_id, "status": "Cancelled", "filled": 0.0, "remaining": 0.0}


class RestingMktTws(FakeTws):
    """Market orders are accepted but do not fill within the wait."""

    async def place_order(self, spec):
        self._require_rw()
        await self._ensure()
        self.b.actions.append(("place", self.client_id, dict(spec)))
        o = self.b.add_order(spec["symbol"], int(spec["conId"]), spec["action"], float(spec["quantity"]), spec["orderType"],
                             client_id=self.client_id, tif=spec.get("tif", "DAY"), ref=spec.get("orderRef", ""),
                             stop=spec.get("stopPrice"), limit=spec.get("limitPrice"))
        return {"orderId": o["orderId"], "status": "Submitted"}


class NoopGlobalCancelTws(FakeTws):
    async def global_cancel(self):
        self._require_rw()
        await self._ensure()
        self.b.actions.append(("global_cancel_ignored", self.client_id))


def mixed_factory(broker, overrides):
    """adapter_factory where some client ids get a special adapter class."""

    def make(client_id, readonly):
        return overrides.get(client_id, FakeTws)(broker, client_id, readonly)

    return make


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.ledger = Ledger(Path(self.tmp.name) / "ledger.jsonl")
        self.b = FakeBroker()
        self.clock = FakeClock()
        self.policy = risk_policy.defaults()

    def tearDown(self):
        self.tmp.cleanup()

    def act(self, cls=FakeTws, client_id=ACT, readonly=False):
        return cls(self.b, client_id, readonly)

    def kw(self, act, *, bridge_alive=False, fac=None):
        return {"act": act, "adapter_factory": fac or factory(self.b), "bridge_alive": bridge_alive, "ledger": self.ledger,
                "actor": "test", "sleep": self.clock.sleep, "clock": self.clock}

    def rows(self, kind=None):
        return [r for r in self.ledger.read() if kind is None or r["kind"] == kind]

    def live_spy(self):
        """The live example: 1 SPY @717.25, stop #15 (parent 14 filled) + TP #16, client 13."""
        return self.b.add_bracket("SPY", SPY, 1, 717.25, 712.00, 719.80, ref="rehearsal-145646", client_id=13)

    def places(self):
        return [a for a in self.b.actions if a[0] == "place"]

    def cancels(self):
        return [a for a in self.b.actions if a[0] == "cancel"]

    def assertLedgerOk(self):
        ok, msg = self.ledger.verify()
        self.assertTrue(ok, msg)


# ─────────────────────────────────────────────────────────────────────
class TestReduceOnly(unittest.TestCase):
    long = {"symbol": "SPY", "conId": SPY, "position": 10.0}
    short = {"symbol": "SPY", "conId": SPY, "position": -10.0}

    def test_allows_reducing_orders(self):
        sa.reduce_only(self.long, "SELL", 10)
        sa.reduce_only(self.long, "sell", 3)
        sa.reduce_only(self.short, "BUY", 10)
        sa.reduce_only(self.short, "BUY", 0.5)

    def test_refuses_adding(self):
        with self.assertRaises(sa.ActionError):
            sa.reduce_only(self.long, "BUY", 1)
        with self.assertRaises(sa.ActionError):
            sa.reduce_only(self.short, "SELL", 1)

    def test_refuses_flip(self):
        with self.assertRaises(sa.ActionError):
            sa.reduce_only(self.long, "SELL", 11)
        with self.assertRaises(sa.ActionError):
            sa.reduce_only(self.short, "BUY", 10.5)

    def test_refuses_bad_quantity(self):
        for q in (0, -1, None, "x", float("nan")):
            with self.assertRaises(sa.ActionError, msg=repr(q)):
                sa.reduce_only(self.long, "SELL", q)

    def test_refuses_flat_or_missing_position(self):
        for p in ({"symbol": "SPY", "position": 0}, {"symbol": "SPY"}, {"symbol": "SPY", "position": None}):
            with self.assertRaises(sa.ActionError):
                sa.reduce_only(p, "SELL", 1)

    def test_refuses_unknown_action(self):
        with self.assertRaises(sa.ActionError):
            sa.reduce_only(self.long, "", 1)
        with self.assertRaises(sa.ActionError):
            sa.reduce_only(self.long, "SSHORT", 1)

    def test_error_types(self):
        self.assertTrue(issubclass(sa.CancelBlocked, sa.ActionError))
        self.assertTrue(issubclass(sa.ActionError, RuntimeError))
        self.assertEqual(sa.BRIDGE_OWNED_IDS, frozenset({13}))
        self.assertEqual(sa.NEVER_BORROW, frozenset({11, 12}))


# ─────────────────────────────────────────────────────────────────────
class TestEmergencyStopPrice(unittest.TestCase):
    pol = risk_policy.defaults()  # atr mult 1.5, min 1.0 %
    long = {"symbol": "SPY", "conId": SPY, "position": 1.0}
    short = {"symbol": "SPY", "conId": SPY, "position": -1.0}

    def test_long_uses_atr_when_wider(self):
        # 1.5 * 1.2 = 1.8 % below 700
        self.assertEqual(sa.emergency_stop_price(self.long, 700.0, 1.2, self.pol), round(700 * (1 - 0.018), 2))
        self.assertEqual(sa.emergency_stop_price(self.long, 700.0, 1.2, self.pol), 687.4)

    def test_short_mirrors(self):
        self.assertEqual(sa.emergency_stop_price(self.short, 700.0, 1.2, self.pol), 712.6)

    def test_min_pct_floor(self):
        # 1.5 * 0.4 = 0.6 % < 1.0 % floor
        self.assertEqual(sa.emergency_stop_price(self.long, 700.0, 0.4, self.pol), 693.0)
        self.assertEqual(sa.emergency_stop_price(self.short, 700.0, 0.4, self.pol), 707.0)

    def test_unknown_atr_uses_floor(self):
        self.assertEqual(sa.emergency_stop_price(self.long, 717.25, None, self.pol), round(717.25 * 0.99, 2))
        self.assertEqual(sa.emergency_stop_price(self.short, 717.25, None, self.pol), round(717.25 * 1.01, 2))
        self.assertEqual(sa.emergency_stop_price(self.long, 717.25, 0, self.pol), round(717.25 * 0.99, 2))

    def test_policy_knobs(self):
        pol = risk_policy.defaults()
        pol["dead_mans_switch"].update(emergency_stop_atr_mult=2.0, emergency_stop_min_pct=0.5)
        self.assertEqual(sa.emergency_stop_price(self.long, 100.0, 1.0, pol), 98.0)
        self.assertEqual(sa.emergency_stop_price(self.long, 100.0, 0.1, pol), 99.5)

    def test_rounded_to_cents(self):
        p = sa.emergency_stop_price(self.long, 123.4567, 0.777, self.pol)
        self.assertEqual(p, round(p, 2))

    def test_bad_inputs(self):
        with self.assertRaises(sa.ActionError):
            sa.emergency_stop_price(self.long, 0, 1.0, self.pol)
        with self.assertRaises(sa.ActionError):
            sa.emergency_stop_price(self.long, None, 1.0, self.pol)
        with self.assertRaises(sa.ActionError):
            sa.emergency_stop_price({"symbol": "SPY", "position": 0}, 100.0, 1.0, self.pol)


class TestPlaceEmergencyStop(Base):
    def test_long_places_reduce_only_gtc_stop(self):
        p = self.b.add_position("SPY", 5, 717.25, SPY)
        r = run(sa.place_emergency_stop(p, act=self.act(), ledger=self.ledger, actor="test", ref="DMS-1-STOP-SPY",
                                        price=700.0, atr_pct=1.2, policy=self.policy))
        self.assertTrue(r["ok"])
        self.assertEqual(r["verdict"], "PLACED")
        [(_, cid, spec)] = self.places()
        self.assertEqual(cid, ACT)
        self.assertEqual(spec["action"], "SELL")
        self.assertEqual(spec["quantity"], 5.0)
        self.assertEqual(spec["orderType"], "STP")
        self.assertEqual(spec["tif"], "GTC")
        self.assertEqual(spec["stopPrice"], 687.4)
        self.assertEqual(spec["orderRef"], "DMS-1-STOP-SPY")
        self.assertEqual(spec["conId"], SPY)
        o = self.b.orders[r["orderId"]]
        self.assertEqual((o["orderType"], o["tif"], o["status"]), ("STP", "GTC", "Submitted"))
        [row] = self.rows("emergency_stop")
        self.assertEqual(row["verdict"], "PLACED")
        self.assertEqual(row["ref"], "DMS-1-STOP-SPY")
        self.assertLedgerOk()

    def test_short_places_buy_stop_above(self):
        p = self.b.add_position("SPY", -3, 717.25, SPY)
        r = run(sa.place_emergency_stop(p, act=self.act(), ledger=self.ledger, actor="test", ref="DMS-2",
                                        price=700.0, atr_pct=None, policy=self.policy))
        self.assertTrue(r["ok"])
        spec = self.places()[0][2]
        self.assertEqual((spec["action"], spec["quantity"], spec["stopPrice"]), ("BUY", 3.0, 707.0))

    def test_rejected_stop_reported(self):
        self.b.reject_types.add("STP")
        p = self.b.add_position("SPY", 1, 717.25, SPY)
        r = run(sa.place_emergency_stop(p, act=self.act(), ledger=self.ledger, actor="test", ref="DMS-3",
                                        price=700.0, atr_pct=1.0, policy=self.policy))
        self.assertFalse(r["ok"])
        self.assertEqual(r["verdict"], "REJECTED")
        self.assertEqual(self.rows("emergency_stop")[0]["verdict"], "REJECTED")

    def test_flat_position_not_placed(self):
        r = run(sa.place_emergency_stop({"symbol": "SPY", "conId": SPY, "position": 0.0}, act=self.act(), ledger=self.ledger,
                                        actor="test", ref="DMS-4", price=700.0, atr_pct=1.0, policy=self.policy))
        self.assertFalse(r["ok"])
        self.assertEqual(self.places(), [])
        self.assertEqual(self.rows("emergency_stop")[0]["verdict"], "FAILED")

    def test_readonly_adapter_refused(self):
        p = self.b.add_position("SPY", 1, 717.25, SPY)
        with self.assertRaises(ReadOnlyAdapter):
            run(sa.place_emergency_stop(p, act=self.act(client_id=20, readonly=True), ledger=self.ledger, actor="test",
                                        ref="DMS-5", price=700.0, atr_pct=1.0, policy=self.policy))
        self.assertEqual(self.b.actions, [])


# ─────────────────────────────────────────────────────────────────────
class TestCancelOrdersOwnership(Base):
    def test_own_order_cancelled_by_act(self):
        o = self.b.add_order("SPY", SPY, "BUY", 1, "LMT", client_id=ACT, limit=700, ref="CLI-1")
        r = run(sa.cancel_orders([o], **self.kw(self.act())))
        self.assertEqual(r["cancelled"], [o["orderId"]])
        self.assertEqual((r["unconfirmed"], r["blocked"], r["verdict"], r["ok"]), ([], [], "OK", True))
        self.assertEqual(self.cancels(), [("cancel", ACT, o["orderId"])])
        self.assertEqual(self.b.orders[o["orderId"]]["status"], "Cancelled")
        [row] = self.rows("orders_cancel")
        self.assertEqual(row["verdict"], "OK")
        self.assertEqual(row["payload"]["cancelled"], [o["orderId"]])
        self.assertLedgerOk()

    def test_borrowed_owner_when_bridge_dead(self):
        legs = self.live_spy()
        working = [legs[1], legs[2]]
        r = run(sa.cancel_orders(working, **self.kw(self.act(), bridge_alive=False)))
        self.assertEqual(sorted(r["cancelled"]), sorted(o["orderId"] for o in working))
        self.assertEqual({a[1] for a in self.cancels()}, {13})  # cancelled through the owner id, not 21
        self.assertNotIn(13, self.b.connected)  # borrowed client disconnected afterwards
        self.assertEqual(r["verdict"], "OK")

    def test_bridge_owned_blocked_while_bridge_alive(self):
        legs = self.live_spy()
        r = run(sa.cancel_orders(legs[1:], **self.kw(self.act(), bridge_alive=True)))
        self.assertEqual(r["cancelled"], [])
        self.assertEqual({b["reason"] for b in r["blocked"]}, {"OWNER_IS_BRIDGE"})
        self.assertEqual({b["clientId"] for b in r["blocked"]}, {13})
        self.assertEqual(r["verdict"], "BLOCKED")
        self.assertFalse(r["ok"])
        self.assertEqual(self.cancels(), [])
        self.assertTrue(all(self.b.orders[o["orderId"]]["status"] not in DONE for o in legs[1:]))
        self.assertNotIn(13, self.b.connected)
        self.assertEqual(self.rows("orders_cancel")[0]["verdict"], "BLOCKED")

    def test_busy_owner_blocked(self):
        o = self.b.add_order("SPY", SPY, "SELL", 1, "STP", client_id=23, stop=700, ref="CLI-9")
        self.b.busy_clients.add(23)
        r = run(sa.cancel_orders([o], **self.kw(self.act())))
        self.assertEqual(r["blocked"], [{"orderId": o["orderId"], "clientId": 23, "reason": "OWNER_BUSY",
                                         "error": r["blocked"][0]["error"]}])
        self.assertEqual(r["verdict"], "BLOCKED")
        self.assertEqual(self.b.orders[o["orderId"]]["status"], "Submitted")

    def test_manual_and_readonly_worker_orders_never_borrowed(self):
        manual = self.b.add_order("SPY", SPY, "BUY", 1, "LMT", client_id=0, limit=600)
        w11 = self.b.add_order("SPY", SPY, "BUY", 1, "LMT", client_id=11, limit=600)
        w12 = self.b.add_order("SPY", SPY, "BUY", 1, "LMT", client_id=12, limit=600)
        opened = []

        def spy_factory(cid, ro):
            opened.append(cid)
            return FakeTws(self.b, cid, ro)

        r = run(sa.cancel_orders([manual, w11, w12], **self.kw(self.act(), fac=spy_factory)))
        self.assertEqual(opened, [])
        self.assertEqual(sorted((b["clientId"], b["reason"]) for b in r["blocked"]),
                         [(0, "OWNER_NEVER_BORROWED"), (11, "OWNER_NEVER_BORROWED"), (12, "OWNER_NEVER_BORROWED")])
        self.assertEqual(self.cancels(), [])

    def test_mixed_is_partial(self):
        own = self.b.add_order("SPY", SPY, "BUY", 1, "LMT", client_id=ACT, limit=700, ref="CLI-1")
        manual = self.b.add_order("SPY", SPY, "BUY", 1, "LMT", client_id=0, limit=600)
        r = run(sa.cancel_orders([own, manual], **self.kw(self.act())))
        self.assertEqual(r["cancelled"], [own["orderId"]])
        self.assertEqual(len(r["blocked"]), 1)
        self.assertEqual(r["verdict"], "PARTIAL")
        self.assertEqual(self.rows("orders_cancel")[0]["verdict"], "PARTIAL")

    def test_unconfirmed_after_wait(self):
        o = self.b.add_order("SPY", SPY, "SELL", 1, "STP", client_id=30, stop=700, ref="CLI-2")
        fac = mixed_factory(self.b, {30: StickyTws})
        r = run(sa.cancel_orders([o], **self.kw(self.act(), fac=fac), wait_s=2.0))
        self.assertEqual((r["cancelled"], r["unconfirmed"]), ([], [o["orderId"]]))
        self.assertFalse(r["ok"])
        self.assertEqual(r["verdict"], "PARTIAL")
        self.assertGreater(self.clock.sleeps, 0)
        self.assertGreaterEqual(self.clock.t, 1002.0)  # waited out the deadline on the fake clock
        self.assertNotIn(30, self.b.connected)

    def test_already_finished_order_counts_as_done(self):
        o = self.b.add_order("SPY", SPY, "BUY", 1, "LMT", client_id=ACT, limit=700, ref="CLI-1")
        snapshot = dict(o)
        o["status"] = "Cancelled"  # gone between the read and the cancel: NotOwner, then confirmed DONE
        r = run(sa.cancel_orders([snapshot], **self.kw(self.act())))
        self.assertEqual(r["cancelled"], [o["orderId"]])
        self.assertEqual(r["verdict"], "OK")

    def test_done_and_duplicate_inputs_skipped(self):
        o = self.b.add_order("SPY", SPY, "BUY", 1, "LMT", client_id=ACT, limit=700, ref="CLI-1")
        filled = self.b.add_order("SPY", SPY, "BUY", 1, "LMT", client_id=ACT, limit=700, status="Filled")
        r = run(sa.cancel_orders([o, dict(o), filled], **self.kw(self.act())))
        self.assertEqual(r["cancelled"], [o["orderId"]])
        self.assertEqual(len(self.cancels()), 1)

    def test_empty_is_ok(self):
        r = run(sa.cancel_orders([], **self.kw(self.act())))
        self.assertEqual((r["verdict"], r["cancelled"], r["blocked"]), ("OK", [], []))

    def test_readonly_act_refused(self):
        o = self.b.add_order("SPY", SPY, "BUY", 1, "LMT", client_id=22, limit=700, ref="CLI-1")
        with self.assertRaises(ReadOnlyAdapter):
            run(sa.cancel_orders([o], **self.kw(self.act(client_id=22, readonly=True))))
        self.assertEqual(self.b.actions, [])


# ─────────────────────────────────────────────────────────────────────
class TestLiquidatePosition(Base):
    def two_positions(self):
        spy = self.live_spy()
        qqq = self.b.add_bracket("QQQ", QQQ, 10, 500.0, 490.0, 515.0, ref="intent-qqq", client_id=13)
        self.b.set_quote("SPY", 716.90, 717.00)
        self.b.set_quote("QQQ", 501.0, 501.1)
        return spy, qqq

    def test_cancels_legs_then_sells_only_that_position(self):
        spy, qqq = self.two_positions()
        act = self.act()
        pos = dict(self.b.positions[SPY])
        r = run(sa.liquidate_position(pos, self.b.working(), **self.kw(act), ref="MSL-1-SPY", reason="tier 2"))
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["verdict"], "FILLED")
        self.assertNotIn(SPY, self.b.positions)
        # SPY legs cancelled, QQQ bracket untouched and still protecting QQQ
        self.assertEqual(sorted(a[2] for a in self.cancels()), sorted([spy[1]["orderId"], spy[2]["orderId"]]))
        for o in qqq[1:]:
            self.assertNotIn(o["status"], DONE)
        self.assertEqual(self.b.positions[QQQ]["position"], 10.0)
        # exactly one reduce-only market sell, from the acting client, with the ref
        [(_, cid, spec)] = self.places()
        self.assertEqual(cid, ACT)
        self.assertEqual((spec["conId"], spec["action"], spec["quantity"], spec["orderType"], spec["tif"], spec["orderRef"]),
                         (SPY, "SELL", 1.0, "MKT", "DAY", "MSL-1-SPY"))
        # ordering: every cancel happens before the sell
        idx = [i for i, a in enumerate(self.b.actions) if a[0] in ("cancel", "place")]
        kinds = [self.b.actions[i][0] for i in idx]
        self.assertEqual(kinds, ["cancel", "cancel", "place"])
        [row] = self.rows("liquidation")
        self.assertEqual((row["verdict"], row["ref"], row["payload"]["reason"]), ("FILLED", "MSL-1-SPY", "tier 2"))
        self.assertEqual([s["step"] for s in row["payload"]["steps"]], ["legs", "cancel", "reread", "place", "confirm", "verify"])
        self.assertEqual(len(self.rows("orders_cancel")), 1)
        self.assertLedgerOk()

    def test_own_legs_and_short_position(self):
        self.b.add_position("SPY", -4, 717.25, SPY)
        stp = self.b.add_order("SPY", SPY, "BUY", 4, "STP", client_id=ACT, stop=730, ref="DMS-9-STOP-SPY")
        self.b.set_quote("SPY", 716.9, 717.0)
        r = run(sa.liquidate_position(dict(self.b.positions[SPY]), self.b.working(), **self.kw(self.act()),
                                      ref="MSL-2-SPY", reason="hard stop"))
        self.assertEqual(r["verdict"], "FILLED")
        self.assertEqual(self.cancels(), [("cancel", ACT, stp["orderId"])])
        spec = self.places()[0][2]
        self.assertEqual((spec["action"], spec["quantity"]), ("BUY", 4.0))
        self.assertNotIn(SPY, self.b.positions)

    def test_naked_position_sells_without_cancels(self):
        self.b.add_position("SPY", 2, 717.25, SPY)
        self.b.set_quote("SPY", 716.9, 717.0)
        r = run(sa.liquidate_position(dict(self.b.positions[SPY]), [], **self.kw(self.act()), ref="MSL-3", reason="naked"))
        self.assertEqual(r["verdict"], "FILLED")
        self.assertEqual(self.cancels(), [])
        self.assertNotIn(SPY, self.b.positions)

    def test_refused_when_bridge_owns_legs(self):
        spy, qqq = self.two_positions()
        r = run(sa.liquidate_position(dict(self.b.positions[SPY]), self.b.working(), **self.kw(self.act(), bridge_alive=True),
                                      ref="MSL-4", reason="tier 2"))
        self.assertFalse(r["ok"])
        self.assertEqual((r["verdict"], r["error"]), ("BLOCKED", "LIQUIDATION_BLOCKED"))
        self.assertEqual(self.places(), [])
        self.assertEqual(self.b.positions[SPY]["position"], 1.0)
        self.assertNotIn(spy[1]["status"], DONE)  # the stop still protects it
        self.assertEqual(self.rows("liquidation")[0]["verdict"], "BLOCKED")

    def test_refused_when_one_leg_cannot_be_cancelled(self):
        # stop owned by a busy client, take-profit owned by us: the TP is cancelled, the sell is NOT sent
        self.b.add_position("SPY", 1, 717.25, SPY)
        stp = self.b.add_order("SPY", SPY, "SELL", 1, "STP", client_id=30, stop=712, ref="CLI-5")
        tp = self.b.add_order("SPY", SPY, "SELL", 1, "LMT", client_id=ACT, limit=720, ref="CLI-5")
        self.b.busy_clients.add(30)
        r = run(sa.liquidate_position(dict(self.b.positions[SPY]), self.b.working(), **self.kw(self.act()),
                                      ref="MSL-5", reason="tier 2"))
        self.assertEqual((r["ok"], r["verdict"], r["error"]), (False, "BLOCKED", "LIQUIDATION_BLOCKED"))
        self.assertEqual(r["cancel"]["blocked"][0]["reason"], "OWNER_BUSY")
        self.assertEqual(self.places(), [])
        self.assertEqual(self.b.orders[stp["orderId"]]["status"], "Submitted")
        self.assertEqual(self.b.orders[tp["orderId"]]["status"], "Cancelled")

    def test_refused_when_cancel_unconfirmed(self):
        self.b.add_position("SPY", 1, 717.25, SPY)
        self.b.add_order("SPY", SPY, "SELL", 1, "STP", client_id=30, stop=712, ref="CLI-6")
        fac = mixed_factory(self.b, {30: StickyTws})
        r = run(sa.liquidate_position(dict(self.b.positions[SPY]), self.b.working(), **self.kw(self.act(), fac=fac),
                                      ref="MSL-6", reason="tier 2", wait_s=3.0))
        self.assertEqual((r["verdict"], r["error"]), ("BLOCKED", "LIQUIDATION_BLOCKED"))
        self.assertEqual(len(r["cancel"]["unconfirmed"]), 1)
        self.assertEqual(self.places(), [])

    def test_refused_when_status_lies_but_leg_still_working(self):
        # order_status says Cancelled, the broker's open-order book still lists it: unconfirmed, no sell
        self.b.add_position("SPY", 1, 717.25, SPY)
        stp = self.b.add_order("SPY", SPY, "SELL", 1, "STP", client_id=ACT, stop=712, ref="CLI-7")
        r = run(sa.liquidate_position(dict(self.b.positions[SPY]), self.b.working(), **self.kw(self.act(LyingStatusTws)),
                                      ref="MSL-7", reason="tier 2"))
        self.assertEqual((r["verdict"], r["error"]), ("BLOCKED", "LIQUIDATION_BLOCKED"))
        self.assertIn(stp["orderId"], r["cancel"]["unconfirmed"])
        self.assertEqual(self.places(), [])

    def test_refused_when_a_new_leg_appears_before_the_sell(self):
        # the bridge re-protects between our cancel and the re-read: the re-read catches it, no sell
        self.b.add_position("SPY", 1, 717.25, SPY)
        self.b.add_order("SPY", SPY, "SELL", 1, "STP", client_id=ACT, stop=712, ref="CLI-7")
        b = self.b

        class Reprotect(FakeTws):
            async def cancel_order(self, order_id):
                await super().cancel_order(order_id)
                b.add_order("SPY", SPY, "SELL", 1, "STP", client_id=13, stop=711, ref="intent-new")

        r = run(sa.liquidate_position(dict(self.b.positions[SPY]), self.b.working(), **self.kw(self.act(Reprotect)),
                                      ref="MSL-7b", reason="tier 2"))
        self.assertEqual((r["verdict"], r["error"]), ("BLOCKED", "LIQUIDATION_BLOCKED"))
        self.assertTrue(r["steps"][-1]["stillWorking"])
        self.assertTrue(r["unprotected"])
        self.assertEqual(self.places(), [])

    def test_leg_filled_during_cancel_never_flips(self):
        self.b.add_position("SPY", 1, 717.25, SPY)
        self.b.add_order("SPY", SPY, "SELL", 1, "STP", client_id=ACT, stop=712, ref="CLI-8", order_id=15)
        self.b.add_order("SPY", SPY, "SELL", 1, "LMT", client_id=ACT, limit=720, ref="CLI-8", order_id=16)
        stale = dict(self.b.positions[SPY])
        r = run(sa.liquidate_position(stale, self.b.working(), **self.kw(self.act(FillOnCancelTws)), ref="MSL-8", reason="tier 2"))
        self.assertTrue(r["ok"])
        self.assertEqual(r["verdict"], "FLAT")
        self.assertEqual(self.places(), [])  # selling the stale qty would have opened a short
        self.assertNotIn(SPY, self.b.positions)

    def test_market_order_dead(self):
        self.b.add_position("SPY", 1, 717.25, SPY)
        self.b.reject_types.add("MKT")
        r = run(sa.liquidate_position(dict(self.b.positions[SPY]), [], **self.kw(self.act()), ref="MSL-9", reason="x"))
        self.assertEqual((r["ok"], r["verdict"], r["error"]), (False, "FAILED", "ORDER_DEAD"))
        self.assertEqual(self.rows("liquidation")[0]["verdict"], "FAILED")

    def test_market_order_not_filled_in_time(self):
        self.b.add_position("SPY", 1, 717.25, SPY)
        r = run(sa.liquidate_position(dict(self.b.positions[SPY]), [], **self.kw(self.act(RestingMktTws)),
                                      ref="MSL-10", reason="x", wait_s=5.0))
        self.assertEqual((r["ok"], r["verdict"]), (False, "SUBMITTED"))
        self.assertGreaterEqual(self.clock.t, 1005.0)
        self.assertEqual(self.rows("liquidation")[0]["verdict"], "SUBMITTED")

    def test_partial_position_sells_current_qty(self):
        # desk view says 10, broker now holds 6 (part of the stop filled): sell 6, never 10
        self.b.add_position("QQQ", 6, 500, QQQ)
        self.b.set_quote("QQQ", 501, 501.1)
        r = run(sa.liquidate_position({"symbol": "QQQ", "conId": QQQ, "position": 10.0, "secType": "STK", "currency": "USD"},
                                      [], **self.kw(self.act()), ref="MSL-11", reason="x"))
        self.assertEqual(r["verdict"], "FILLED")
        self.assertEqual(self.places()[0][2]["quantity"], 6.0)
        self.assertNotIn(QQQ, self.b.positions)

    def test_readonly_adapter_never_places(self):
        self.live_spy()
        with self.assertRaises(ReadOnlyAdapter):
            run(sa.liquidate_position(dict(self.b.positions[SPY]), self.b.working(),
                                      **self.kw(self.act(client_id=20, readonly=True)), ref="MSL-12", reason="x"))
        self.assertEqual(self.b.actions, [])


# ─────────────────────────────────────────────────────────────────────
class TestCancelEntries(Base):
    def test_cancels_entries_and_pending_children_only(self):
        spy = self.live_spy()                                                   # protected position
        qqq = self.b.add_bracket("QQQ", QQQ, 10, 500.0, 490.0, 515.0, ref="intent-q", filled=False)  # unfilled entry bracket
        add_on = self.b.add_order("SPY", SPY, "BUY", 1, "LMT", client_id=13, limit=700, ref="intent-add")
        stray = self.b.add_order("IWM", 9579970, "SELL", 5, "STP", client_id=ACT, stop=200, ref="GUARD-x")  # no IWM position
        positions = list(self.b.positions.values())
        r = run(sa.cancel_entries(positions, self.b.working(), **self.kw(self.act())))
        self.assertTrue(r["ok"], r)
        want = sorted([o["orderId"] for o in qqq] + [add_on["orderId"], stray["orderId"]])
        self.assertEqual(sorted(r["targets"]), want)
        self.assertEqual(sorted(r["cancelled"]), want)
        self.assertEqual(sorted(r["kept"]), sorted([spy[1]["orderId"], spy[2]["orderId"]]))
        for o in spy[1:]:
            self.assertEqual(self.b.orders[o["orderId"]]["status"] in DONE, False)
        for oid in want:
            self.assertIn(self.b.orders[oid]["status"], DONE)
        self.assertEqual(self.b.positions[SPY]["position"], 1.0)
        self.assertEqual(self.places(), [])
        [row] = self.rows("cancel_entries")
        self.assertEqual(row["verdict"], "OK")
        self.assertEqual(len(self.rows("orders_cancel")), 1)
        self.assertLedgerOk()

    def test_bridge_entries_blocked_while_alive(self):
        self.b.add_bracket("QQQ", QQQ, 10, 500.0, 490.0, 515.0, ref="intent-q", filled=False)
        r = run(sa.cancel_entries([], self.b.working(), **self.kw(self.act(), bridge_alive=True)))
        self.assertFalse(r["ok"])
        self.assertEqual(r["verdict"], "BLOCKED")
        self.assertEqual({b["reason"] for b in r["blocked"]}, {"OWNER_IS_BRIDGE"})
        self.assertEqual(self.rows("cancel_entries")[0]["verdict"], "BLOCKED")

    def test_nothing_to_cancel(self):
        self.live_spy()
        r = run(sa.cancel_entries(list(self.b.positions.values()), self.b.working(), **self.kw(self.act())))
        self.assertEqual((r["ok"], r["targets"], r["verdict"]), (True, [], "OK"))
        self.assertEqual(self.cancels(), [])
        self.assertEqual(len(self.rows("cancel_entries")), 1)
        self.assertEqual(self.rows("orders_cancel"), [])

    def test_overseer_call_shape(self):
        """overseer.execute passes act/adapter_factory/bridge_alive/ledger/actor + sleep only."""
        self.b.add_order("SPY", SPY, "BUY", 1, "LMT", client_id=ACT, limit=700, ref="intent-x")
        r = run(sa.cancel_entries([], self.b.working(), act=self.act(), adapter_factory=factory(self.b), bridge_alive=False,
                                  ledger=self.ledger, actor="overseer", sleep=self.clock.sleep))
        self.assertTrue(r["ok"])

    def test_readonly_refused(self):
        self.b.add_order("SPY", SPY, "BUY", 1, "LMT", client_id=ACT, limit=700)
        with self.assertRaises(ReadOnlyAdapter):
            run(sa.cancel_entries([], self.b.working(), **self.kw(self.act(client_id=22, readonly=True))))
        self.assertEqual(self.b.actions, [])


# ─────────────────────────────────────────────────────────────────────
class TestFlattenAll(Base):
    def setup_book(self):
        self.live_spy()
        self.b.add_position("QQQ", -10, 500, QQQ)
        self.b.add_order("QQQ", QQQ, "BUY", 10, "STP", client_id=ACT, stop=510, ref="DMS-1")
        lo = self.b.add_position("SPY 261218C00720000", 2, 5.0, 111)
        lo["secType"], lo["underlying"] = "OPT", "SPY"
        so = self.b.add_position("SPY 261218P00700000", -3, 4.0, 222)
        so["secType"], so["underlying"] = "OPT", "SPY"
        self.b.add_order("SPY", SPY, "BUY", 1, "LMT", client_id=0, limit=600)  # manual: global cancel takes it too
        for s in ("SPY", "QQQ"):
            self.b.set_quote(s, 100, 100.1)

    def test_ends_flat_short_options_first(self):
        self.setup_book()
        r = run(sa.flatten_all(act=self.act(), ledger=self.ledger, actor="test", ref="DMS-FLAT-1",
                               sleep=self.clock.sleep, clock=self.clock))
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["verdict"], "FLAT")
        self.assertEqual(self.b.positions, {})
        self.assertEqual(self.b.working(), [])
        self.assertEqual(self.b.actions[0], ("global_cancel", ACT))
        specs = [a[2] for a in self.places()]
        self.assertEqual(specs[0]["conId"], 222)  # the short option is bought back first
        self.assertEqual(specs[0]["action"], "BUY")
        by_con = {s["conId"]: s for s in specs}
        self.assertEqual((by_con[SPY]["action"], by_con[SPY]["quantity"]), ("SELL", 1.0))
        self.assertEqual((by_con[QQQ]["action"], by_con[QQQ]["quantity"]), ("BUY", 10.0))
        self.assertEqual((by_con[111]["action"], by_con[111]["quantity"], by_con[111]["secType"]), ("SELL", 2.0, "OPT"))
        self.assertTrue(all(s["orderType"] == "MKT" and s["tif"] == "DAY" and s["orderRef"] == "DMS-FLAT-1" for s in specs))
        [row] = self.rows("flatten_all")
        self.assertEqual(row["verdict"], "FLAT")
        self.assertLedgerOk()

    def test_continues_when_orders_survive_global_cancel(self):
        self.setup_book()
        r = run(sa.flatten_all(act=self.act(NoopGlobalCancelTws), ledger=self.ledger, actor="test", ref="DMS-FLAT-2",
                               wait_s=3.0, sleep=self.clock.sleep, clock=self.clock))
        self.assertTrue(r["stillWorking"])
        self.assertGreaterEqual(self.clock.t, 1003.0)
        self.assertEqual(self.b.positions, {})  # positions still flattened
        # ...but orders still resting (the QQQ BUY stop would open a new long): not "FLAT"
        self.assertEqual((r["ok"], r["verdict"], r["error"]), (False, "PARTIAL", "ORDERS_STILL_WORKING"))
        self.assertTrue(r["workingAfter"])
        row = self.rows("flatten_all")[0]
        self.assertFalse([s for s in row["payload"]["steps"] if s["step"] == "orders_cleared"][0]["ok"])

    def test_partial_when_an_order_is_rejected(self):
        self.b.add_position("SPY", 1, 700, SPY)
        self.b.add_position("QQQ", 5, 500, QQQ)
        self.b.set_quote("SPY", 100, 100.1)
        self.b.set_quote("QQQ", 100, 100.1)

        class RejectQqq(FakeTws):
            async def place_order(self, spec):
                if spec["conId"] == QQQ:
                    raise RuntimeError("TWS error 201: order rejected")
                return await super().place_order(spec)

        r = run(sa.flatten_all(act=self.act(RejectQqq), ledger=self.ledger, actor="test", ref="DMS-FLAT-3",
                               sleep=self.clock.sleep, clock=self.clock))
        self.assertFalse(r["ok"])
        self.assertEqual(r["verdict"], "PARTIAL")
        self.assertEqual([p["conId"] for p in r["remaining"]], [QQQ])
        self.assertIn("error", [o for o in r["orders"] if o["conId"] == QQQ][0])

    def test_nothing_to_flatten(self):
        r = run(sa.flatten_all(act=self.act(), ledger=self.ledger, actor="test", ref="DMS-FLAT-4",
                               sleep=self.clock.sleep, clock=self.clock))
        self.assertEqual((r["ok"], r["verdict"]), (True, "FLAT"))
        self.assertEqual(self.places(), [])

    def test_positions_unavailable(self):
        self.b.add_position("SPY", 1, 700, SPY)

        class NoPositions(FakeTws):
            async def positions(self):
                raise ConnectionResetError("socket closed")

        r = run(sa.flatten_all(act=self.act(NoPositions), ledger=self.ledger, actor="test", ref="DMS-FLAT-5",
                               sleep=self.clock.sleep, clock=self.clock))
        self.assertEqual((r["ok"], r["verdict"], r["error"]), (False, "FAILED", "POSITIONS_UNAVAILABLE"))
        self.assertEqual(self.places(), [])
        self.assertEqual(self.rows("flatten_all")[0]["verdict"], "FAILED")

    def test_readonly_refused(self):
        self.setup_book()
        with self.assertRaises(ReadOnlyAdapter):
            run(sa.flatten_all(act=self.act(client_id=20, readonly=True), ledger=self.ledger, actor="test", ref="DMS-FLAT-6",
                               sleep=self.clock.sleep, clock=self.clock))
        self.assertEqual(self.b.actions, [])
        self.assertEqual(len(self.b.positions), 4)


# ─────────────────────────────────────────────────────────────────────
class TestReviewGaps(Base):
    """Fail-open paths found in review. Each test failed against the first version of the module."""

    # ── identity / malformed data ──
    def test_manual_unbound_stop_blocks_liquidation(self):
        # a TWS-UI stop has clientId 0 and (unbound) orderId 0: it still protects, so no sell
        self.b.add_position("SPY", 1, 700, SPY)
        self.b.set_quote("SPY", 700, 700.1)
        o = self.b.add_order("SPY", SPY, "SELL", 1, "STP", client_id=0, stop=690)
        o["orderId"] = 0
        r = run(sa.liquidate_position(dict(self.b.positions[SPY]), self.b.working(), **self.kw(self.act()), ref="MSL-G1", reason="x"))
        self.assertEqual((r["ok"], r["verdict"]), (False, "BLOCKED"))
        self.assertEqual(r["cancel"]["blocked"][0]["reason"], "OWNER_NEVER_BORROWED")
        self.assertEqual(self.places(), [])

    def test_order_without_id_reported_not_skipped(self):
        o = {"orderId": None, "clientId": 23, "conId": SPY, "action": "BUY", "status": "Submitted"}
        r = run(sa.cancel_orders([o], **self.kw(self.act())))
        self.assertEqual((r["verdict"], r["blocked"][0]["reason"]), ("BLOCKED", "NO_ORDER_ID"))

    def test_same_order_id_two_clients_both_handled(self):
        own = self.b.add_order("SPY", SPY, "BUY", 1, "LMT", client_id=ACT, limit=600, ref="CLI-1", order_id=50)
        manual = dict(own, clientId=0, permId=1)  # TWS ids are per client: a different order
        r = run(sa.cancel_orders([own, manual], **self.kw(self.act())))
        self.assertEqual(r["cancelled"], [50])
        self.assertEqual([(b["clientId"], b["reason"]) for b in r["blocked"]], [(0, "OWNER_NEVER_BORROWED")])
        self.assertEqual(r["verdict"], "PARTIAL")

    def test_string_conid_liquidates_instead_of_false_flat(self):
        self.live_spy()
        self.b.set_quote("SPY", 716.9, 717.0)
        pos = {**self.b.positions[SPY], "conId": str(SPY)}
        r = run(sa.liquidate_position(pos, self.b.working(), **self.kw(self.act()), ref="MSL-G2", reason="x"))
        self.assertEqual(r["verdict"], "FILLED")
        self.assertNotIn(SPY, self.b.positions)

    def test_missing_conid_fails_without_actions(self):
        self.b.add_position("SPY", 1, 700, SPY)
        for con in (None, 0, "abc", True):
            r = run(sa.liquidate_position({"symbol": "SPY", "conId": con, "position": 1.0}, [], **self.kw(self.act()),
                                          ref="MSL-G3", reason="x"))
            self.assertEqual((r["ok"], r["verdict"], r["error"]), (False, "FAILED", "INVALID_POSITION"), repr(con))
        self.assertEqual(self.b.actions, [])

    def test_malformed_broker_size_fails_without_actions(self):
        self.live_spy()
        self.b.positions[SPY]["position"] = float("nan")
        r = run(sa.liquidate_position({"symbol": "SPY", "conId": SPY, "position": 1.0}, self.b.working(), **self.kw(self.act()),
                                      ref="MSL-G4", reason="x"))
        self.assertEqual((r["ok"], r["error"]), (False, "MALFORMED_POSITION"))
        self.assertEqual(self.b.actions, [])

    def test_reduce_only_rejects_bools(self):
        with self.assertRaises(sa.ActionError):
            sa.reduce_only({"position": 1.0}, "SELL", True)
        with self.assertRaises(sa.ActionError):
            sa.reduce_only({"position": True}, "SELL", 1)

    # ── liquidation ──
    def test_half_filled_entry_children_cancelled_before_sell(self):
        # parent BUY 10 filled 6 and still working; its exit children are "pending_child", yet they go
        # live as the parent fills: selling with them resting could flip the position
        par = self.b.add_order("SPY", SPY, "BUY", 10, "LMT", client_id=23, limit=700, tif="DAY", ref="i")
        par["filled"], par["remaining"] = 6.0, 4.0
        self.b.add_position("SPY", 6, 700, SPY)
        self.b.set_quote("SPY", 700, 700.1)
        stp = self.b.add_order("SPY", SPY, "SELL", 10, "STP", client_id=23, stop=690, ref="i", parent_id=par["orderId"],
                               status="PreSubmitted")
        r = run(sa.liquidate_position(dict(self.b.positions[SPY]), self.b.working(), **self.kw(self.act()), ref="MSL-G5", reason="x"))
        self.assertEqual(r["verdict"], "FILLED")
        self.assertIn(self.b.orders[stp["orderId"]]["status"], DONE)
        self.assertIn(self.b.orders[par["orderId"]]["status"], DONE)
        kinds = [a[0] for a in self.b.actions if a[0] in ("cancel", "place")]
        self.assertEqual(kinds[-1], "place")
        self.assertEqual(self.places()[0][2]["quantity"], 6.0)

    def test_legs_read_from_broker_when_caller_snapshot_is_stale(self):
        self.b.add_position("SPY", 1, 700, SPY)
        self.b.set_quote("SPY", 700, 700.1)
        stp = self.b.add_order("SPY", SPY, "SELL", 1, "STP", client_id=ACT, stop=690, ref="CLI-1")
        r = run(sa.liquidate_position(dict(self.b.positions[SPY]), [], **self.kw(self.act()), ref="MSL-G6", reason="x"))
        self.assertEqual(r["verdict"], "FILLED")
        self.assertEqual(self.cancels(), [("cancel", ACT, stp["orderId"])])

    def test_other_position_untouched_even_with_borrowing(self):
        spy = self.live_spy()
        qqq = self.b.add_bracket("QQQ", QQQ, 10, 500.0, 490.0, 515.0, ref="q", client_id=23)
        self.b.set_quote("SPY", 716.9, 717.0)
        run(sa.liquidate_position(dict(self.b.positions[SPY]), self.b.working(), **self.kw(self.act()), ref="MSL-G7", reason="x"))
        self.assertTrue(all(a[2] in (spy[1]["orderId"], spy[2]["orderId"]) for a in self.cancels()))
        self.assertTrue(all(self.b.orders[o["orderId"]]["status"] not in DONE for o in qqq[1:]))

    def test_glitchy_empty_position_read_is_not_flat(self):
        self.b.add_position("SPY", 1, 700, SPY)
        stp = self.b.add_order("SPY", SPY, "SELL", 1, "STP", client_id=ACT, stop=690, ref="CLI-1")

        class Glitch(FakeTws):
            n = 0

            async def positions(self):
                Glitch.n += 1
                return [] if Glitch.n == 2 else await super().positions()  # the re-read after the cancel comes back empty

        r = run(sa.liquidate_position(dict(self.b.positions[SPY]), self.b.working(), **self.kw(self.act(Glitch)),
                                      ref="MSL-G8", reason="x"))
        self.assertEqual((r["ok"], r["error"]), (False, "POSITION_READ_INCONSISTENT"))
        self.assertTrue(r["unprotected"])
        self.assertEqual(self.places(), [])
        self.assertIn(self.b.orders[stp["orderId"]]["status"], DONE)

    def test_filled_status_without_position_change_is_not_filled(self):
        # order_status says Filled (e.g. it matched another client's order with the same id) but the
        # broker still holds the position: never report FILLED
        self.b.add_position("SPY", 1, 700, SPY)

        class PhantomFill(RestingMktTws):
            async def order_status(self, order_id):
                return {"orderId": order_id, "status": "Filled", "filled": 1.0, "remaining": 0.0}

        r = run(sa.liquidate_position(dict(self.b.positions[SPY]), [], **self.kw(self.act(PhantomFill)), ref="MSL-G9",
                                      reason="x", wait_s=2.0))
        self.assertEqual((r["ok"], r["verdict"], r["error"]), (False, "SUBMITTED", "FILL_NOT_REFLECTED"))
        self.assertEqual(r["positionAfter"], 1.0)

    # ── cancel_orders ──
    def test_factory_failure_is_blocked_not_raised(self):
        o = self.b.add_order("SPY", SPY, "SELL", 1, "STP", client_id=30, stop=700, ref="CLI-2")

        def broken(cid, ro):
            raise OSError("no socket")

        r = run(sa.cancel_orders([o], **self.kw(self.act(), fac=broken)))
        self.assertEqual((r["verdict"], r["blocked"][0]["reason"]), ("BLOCKED", "OWNER_BUSY"))
        self.assertEqual(len(self.rows("orders_cancel")), 1)

    def test_status_lie_caught_by_open_order_book(self):
        o = self.b.add_order("SPY", SPY, "BUY", 1, "LMT", client_id=ACT, limit=600, ref="CLI-1")
        r = run(sa.cancel_orders([o], **self.kw(self.act(LyingStatusTws))))
        self.assertEqual((r["cancelled"], r["unconfirmed"], r["ok"]), ([], [o["orderId"]], False))

    def test_unverifiable_cancel_is_unconfirmed(self):
        o = self.b.add_order("SPY", SPY, "BUY", 1, "LMT", client_id=ACT, limit=600, ref="CLI-1")

        class NoBook(FakeTws):
            async def open_orders(self):
                raise TimeoutError("reqAllOpenOrders timed out")

        r = run(sa.cancel_orders([o], **self.kw(self.act(NoBook))))
        self.assertEqual((r["cancelled"], r["unconfirmed"]), ([], [o["orderId"]]))
        self.assertIn("verifyError", r)

    # ── cancel_entries ──
    def test_cancel_entries_stale_empty_positions_keep_protection(self):
        # overseer / cli pass a snapshot; if it says "no positions" every stop would look like an entry
        spy = self.live_spy()
        r = run(sa.cancel_entries([], self.b.working(), **self.kw(self.act())))
        self.assertEqual(r["targets"], [])
        self.assertEqual(self.cancels(), [])
        self.assertTrue(all(self.b.orders[o["orderId"]]["status"] not in DONE for o in spy[1:]))

    def test_cancel_entries_positions_unreadable_cancels_nothing(self):
        self.b.add_order("SPY", SPY, "BUY", 1, "LMT", client_id=ACT, limit=600)

        class NoPositions(FakeTws):
            async def positions(self):
                raise ConnectionResetError("socket closed")

        r = run(sa.cancel_entries([], self.b.working(), **self.kw(self.act(NoPositions))))
        self.assertEqual((r["ok"], r["verdict"], r["error"]), (False, "BLOCKED", "POSITIONS_UNAVAILABLE"))
        self.assertEqual(self.b.actions, [])

    def test_cancel_entries_malformed_size_keeps_orders(self):
        self.b.add_position("SPY", 1, 700, SPY)["position"] = None
        stp = self.b.add_order("SPY", SPY, "SELL", 1, "STP", client_id=ACT, stop=690, ref="CLI-1")
        r = run(sa.cancel_entries(list(self.b.positions.values()), self.b.working(), **self.kw(self.act())))
        self.assertEqual(r["targets"], [])
        self.assertEqual(r["skipped"][0]["reason"], "POSITION_MALFORMED")
        self.assertEqual(self.b.orders[stp["orderId"]]["status"], "Submitted")

    def test_cancel_entries_keeps_children_of_half_filled_entry(self):
        par = self.b.add_order("SPY", SPY, "BUY", 10, "LMT", client_id=23, limit=700, tif="DAY", ref="i")
        par["filled"], par["remaining"] = 6.0, 4.0
        self.b.add_position("SPY", 6, 700, SPY)
        stp = self.b.add_order("SPY", SPY, "SELL", 10, "STP", client_id=23, stop=690, ref="i", parent_id=par["orderId"],
                               status="PreSubmitted")
        other = self.b.add_order("QQQ", QQQ, "BUY", 1, "LMT", client_id=23, limit=400, ref="j")
        r = run(sa.cancel_entries(list(self.b.positions.values()), self.b.working(), **self.kw(self.act())))
        self.assertEqual(r["targets"], [other["orderId"]])
        self.assertEqual(self.b.orders[stp["orderId"]]["status"], "PreSubmitted")
        self.assertEqual(self.b.orders[par["orderId"]]["status"], "Submitted")
        self.assertEqual(sorted(s["reason"] for s in r["skipped"]), ["PARENT_OF_PROTECTIVE_CHILD", "PROTECTS_HELD_POSITION"])

    # ── emergency stop ──
    def estop(self, act=None, **kw):
        p = dict(self.b.positions[SPY])
        return run(sa.place_emergency_stop(p, act=act or self.act(), ledger=self.ledger, actor="test", ref="DMS-G",
                                           price=700.0, atr_pct=1.0, policy=self.policy, sleep=self.clock.sleep,
                                           clock=self.clock, **kw))

    def test_emergency_stop_tops_up_undersized_never_over_hedges(self):
        self.b.add_position("SPY", 100, 700, SPY)
        self.b.add_order("SPY", SPY, "SELL", 50, "STP", client_id=13, stop=690, ref="i")
        r = self.estop()
        self.assertEqual((r["ok"], r["verdict"], r["qty"]), (True, "PLACED", 50.0))
        self.assertEqual(self.places()[0][2]["quantity"], 50.0)

    def test_emergency_stop_already_covered_places_nothing(self):
        self.b.add_position("SPY", 1, 700, SPY)
        self.b.add_order("SPY", SPY, "SELL", 1, "STP", client_id=13, stop=690, ref="i")
        r = self.estop()
        self.assertEqual((r["ok"], r["verdict"]), (True, "COVERED"))
        self.assertEqual(self.places(), [])
        self.assertEqual(self.rows("emergency_stop")[0]["verdict"], "COVERED")

    def test_emergency_stop_pending_cancel_stop_does_not_cover(self):
        self.b.add_position("SPY", 1, 700, SPY)
        self.b.add_order("SPY", SPY, "SELL", 1, "STP", client_id=13, stop=690, ref="i", status="PendingCancel")
        r = self.estop()
        self.assertEqual((r["verdict"], r["qty"]), ("PLACED", 1.0))

    def test_emergency_stop_warns_about_resting_take_profit(self):
        self.b.add_position("SPY", 1, 700, SPY)
        self.b.add_order("SPY", SPY, "SELL", 1, "LMT", client_id=13, limit=720, ref="i")
        r = self.estop()
        self.assertEqual(r["verdict"], "PLACED")
        self.assertIn("warning", r)

    def test_emergency_stop_async_reject_is_not_placed(self):
        self.b.add_position("SPY", 1, 700, SPY)

        class LateReject(FakeTws):
            async def place_order(self, spec):
                r = await super().place_order(spec)
                self.b.orders[r["orderId"]]["status"] = "Inactive"
                return {"orderId": r["orderId"], "status": "PendingSubmit"}

        r = self.estop(act=self.act(LateReject))
        self.assertEqual((r["ok"], r["verdict"]), (False, "REJECTED"))

    def test_emergency_stop_never_accepted_is_unconfirmed(self):
        self.b.add_position("SPY", 1, 700, SPY)

        class Pending(FakeTws):
            async def place_order(self, spec):
                r = await super().place_order(spec)
                self.b.orders[r["orderId"]]["status"] = "PendingSubmit"
                return {"orderId": r["orderId"], "status": "PendingSubmit"}

        r = self.estop(act=self.act(Pending), wait_s=2.0)
        self.assertEqual((r["ok"], r["verdict"], r["error"]), (False, "UNCONFIRMED", "STOP_NOT_CONFIRMED"))

    def test_emergency_stop_zero_distance_refused(self):
        self.b.add_position("SPY", 1, 700, SPY)
        for v in (0, -1, None, "x"):
            pol = risk_policy.defaults()
            pol["dead_mans_switch"]["emergency_stop_min_pct"] = v
            with self.assertRaises(sa.ActionError, msg=repr(v)):
                sa.emergency_stop_price({"position": 1.0}, 700.0, None, pol)
            self.policy = pol
            r = self.estop()
            self.assertEqual((r["ok"], r["verdict"]), (False, "FAILED"))
        self.assertEqual(self.places(), [])

    def test_emergency_stop_with_caller_orders(self):
        self.b.add_position("SPY", 10, 700, SPY)
        r = self.estop(orders=[{"orderId": 5, "clientId": 13, "conId": SPY, "action": "SELL", "orderType": "STP",
                                "quantity": 10, "filled": 4, "status": "Submitted", "tif": "GTC"}])
        self.assertEqual(r["qty"], 4.0)  # the existing stop's open qty is 6

    # ── flatten ──
    def test_flatten_malformed_position_is_not_flat(self):
        self.b.add_position("SPY", 1, 700, SPY)["position"] = float("nan")
        r = run(sa.flatten_all(act=self.act(), ledger=self.ledger, actor="test", ref="DMS-FLAT-G",
                               sleep=self.clock.sleep, clock=self.clock))
        self.assertFalse(r["ok"])
        self.assertNotEqual(r["verdict"], "FLAT")
        self.assertEqual(self.places(), [])


if __name__ == "__main__":
    unittest.main()
