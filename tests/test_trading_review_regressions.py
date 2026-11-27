"""Regression tests for the adversarial review of desk-cli / overseer (one test per confirmed finding)."""

import asyncio
import importlib.util
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace as NS

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "trading"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import desk_lock  # noqa: E402
from desk_harness import Env  # noqa: E402
from fake_tws import FakeTws  # noqa: E402

run = asyncio.run


def naked_iwm(e, price=199.0):
    p = e.b.add_order("IWM", 2, "BUY", 5, "LMT", limit=200.0, status="Filled", ref="intent-iwm-001", client_id=30)
    e.b.add_position("IWM", 5, 200.0, 2)
    e.add_intent("intent-iwm-001", "IWM", 5, [p])
    if price:
        e.market("IWM", price)


class StatusNeverOpensTws(unittest.TestCase):
    def test_status_never_holds_the_kill_client_22(self):  # finding 1
        e = Env()
        try:
            e.position_with_bracket("SPY", 1, 10, 100.0, 98.0, 103.0)
            e.bridge_up = False
            seen = []
            from fake_tws import factory

            make = factory(e.b)
            deps = e.deps()
            deps.adapter_factory = lambda cid, ro: (seen.append((cid, ro)), make(cid, ro))[1]
            from desk_cli import main

            self.assertEqual(main(["status", "--json"], deps), 0)
            self.assertEqual(json.loads(deps.stdout.getvalue())["positions"][0]["bracket"], "PROTECTED")  # truth even with the bridge down
            self.assertEqual(seen, [(25, True)])
            self.assertEqual(e.b.connected, set())
        finally:
            e.close()

    def test_snapshot_uses_its_own_client_id(self):  # finding 1
        e = Env()
        try:
            e.position_with_bracket("SPY", 1, 10, 100.0, 98.0, 103.0)
            seen = []
            from fake_tws import factory

            make = factory(e.b)
            deps = e.deps()
            deps.adapter_factory = lambda cid, ro: (seen.append(cid), make(cid, ro))[1]
            from desk_cli import main

            self.assertEqual(main(["overseer-snapshot", "--json"], deps), 0)
            self.assertEqual(set(seen), {24})
        finally:
            e.close()


class ArmDuringOutage(unittest.TestCase):
    def test_trigger_observed_in_observe_mode_fires_once_armed(self):  # findings 2, 8
        e = Env()
        try:
            e.position_with_bracket("SPY", 1, 10, 100.0, 98.0, 103.0)
            ov = e.overseer()
            run(ov.tick())
            e.cc.state, e.cc.exit_code = "EXITED_CRASH", 1
            run(ov.tick())
            e.advance(31)
            run(ov.tick())
            self.assertFalse(desk_lock.is_locked(e.d))
            e.arm()
            e.advance(5)
            run(ov.tick())
            self.assertIn("DMS_CC", [b["code"] for b in desk_lock.read_lock(e.d)["breakers"]])
        finally:
            e.close()


class DurableDebt(unittest.TestCase):
    def test_act_connect_failure_defers_and_retries(self):  # findings 4, 7, 17
        e = Env()
        try:
            e.arm()
            qqq = e.b.add_bracket("QQQ", 3, 5, 400.0, 392.0, 410.0, ref="intent-qqq-001", client_id=31, filled=False)
            e.add_intent("intent-qqq-001", "QQQ", 5, qqq)
            e.market("QQQ", 401.0)
            ov = e.overseer()
            run(ov.tick())
            e.b.busy_clients.add(21)  # overseer_act can't connect
            e.cc.state, e.cc.exit_code = "HUNG", None
            run(ov.tick())
            e.advance(31)
            run(ov.tick())
            self.assertTrue(desk_lock.is_locked(e.d))
            self.assertTrue(all(e.b.orders[o["orderId"]]["status"] != "Cancelled" for o in qqq))
            self.assertIn("cancel_entries", ov.state["pendingActions"])
            e.b.busy_clients.discard(21)
            e.advance(5)
            run(ov.tick())
            self.assertTrue(all(e.b.orders[o["orderId"]]["status"] == "Cancelled" for o in qqq))
            self.assertEqual(ov.state["pendingActions"], [])
        finally:
            e.close()

    def test_stale_debt_is_voided_by_an_unlock(self):  # finding 9
        e = Env()
        try:
            e.arm()
            e.position_with_bracket("SPY", 1, 10, 100.0, 98.0, 103.0)
            ov = e.overseer()
            run(ov.tick())
            e.b.up = False
            run(ov.tick())
            e.advance(31)
            run(ov.tick())
            self.assertTrue(ov.state["pendingActions"])
            (e.d / "TRADING_LOCKED.json").unlink()  # operator unlocked meanwhile (e.g. after the overseer was stopped)
            ov2 = e.overseer()  # restart
            self.assertEqual(ov2.state["pendingActions"], [])
            self.assertEqual(ov2.state["triggered"], {})
        finally:
            e.close()

    def test_restart_restarts_the_grace_window(self):  # finding 12
        e = Env()
        try:
            e.arm()
            ov = e.overseer()
            run(ov.tick())
            e.b.up = False
            run(ov.tick())
            e.advance(600)  # overseer was down for 10 minutes, TWS still down
            ov2 = e.overseer()
            run(ov2.tick())
            self.assertFalse(desk_lock.is_locked(e.d), "no instant trigger from an old timer")
            e.advance(31)
            run(ov2.tick())
            self.assertTrue(desk_lock.is_locked(e.d))
        finally:
            e.close()


class EmergencyStopPricing(unittest.TestCase):
    def test_no_quote_means_no_stop_from_avgcost(self):  # findings 3, 10
        e = Env({"circuit_breakers": {"naked_grace_s": 5}})
        try:
            e.arm()
            naked_iwm(e, price=None)  # no quote, no bars
            e.bridge_up = False       # and no bridge mark
            ov = e.overseer()
            run(ov.tick())
            e.advance(40)
            run(ov.tick())
            self.assertFalse([a for a in e.b.actions if a[0] == "place"])
            self.assertIn("EMERGENCY_STOP_NO_PRICE", [a["code"] for a in ov.state["alerts"]])
        finally:
            e.close()

    def test_exit_in_progress_is_re_liquidated_not_stopped(self):  # finding 11
        e = Env({"circuit_breakers": {"naked_grace_s": 5}})
        try:
            e.arm()
            naked_iwm(e)
            e.b.add_order("IWM", 2, "SELL", 5, "MKT", client_id=21, ref="MSL-1-IWM", tif="DAY")  # resting MKT exit (halt)
            ov = e.overseer()
            run(ov.tick())
            e.advance(10)
            e.market("IWM", 199.0)
            out = run(ov.tick())
            kinds = [a["kind"] for a in out["plannedActions"] if a.get("symbol") == "IWM"]
            self.assertIn("liquidate", kinds)
            self.assertNotIn("emergency_stop", kinds)
            self.assertFalse([a for a in e.b.actions if a[0] == "place" and a[2]["orderType"] == "STP"])
        finally:
            e.close()

    def test_day_stop_is_not_counted_as_coverage(self):  # finding 15
        import risk_policy
        import safety_actions as sa
        from fake_tws import FakeBroker

        b = FakeBroker()
        b.add_position("SPY", 1, 700, 1)
        b.add_order("SPY", 1, "SELL", 1, "STP", client_id=21, stop=690, tif="DAY", ref="x")
        act = FakeTws(b, 21, readonly=False)
        r = run(sa.place_emergency_stop(b.positions[1], act=act, ledger=None, actor="t", ref="r", price=700.0, atr_pct=1.0,
                                        policy=risk_policy.defaults()))
        self.assertEqual((r["ok"], r["error"]), (False, "NOT_GTC_PRESENT"))
        self.assertFalse([a for a in b.actions if a[0] == "place"])


class UnlockBinding(unittest.TestCase):
    def test_breaker_added_during_the_prompt_refuses_the_unlock(self):  # findings 5, 6
        e = Env()
        try:
            e.position_with_bracket("SPY", 1, 10, 100.0, 98.0, 103.0)
            e.cli(["lock"])
            import desk_cli

            real = desk_cli.confirm

            def racing_confirm(*a, **kw):
                how = real(*a, **kw)
                desk_lock.lock(e.d, "overseer: DMS_CC", "overseer", breaker="DMS_CC", now=e.clock[0] + 1)
                return how

            desk_cli.confirm = racing_confirm
            try:
                code, _, err = e.cli(["unlock", "--force", "--confirm-token", "CONFIRM UNLOCK"])
            finally:
                desk_cli.confirm = real
            self.assertEqual(code, 4, err)
            self.assertIn("DMS_CC", err)
            self.assertTrue(desk_lock.is_locked(e.d))
        finally:
            e.close()


@unittest.skipUnless(importlib.util.find_spec("ib_async"), "needs ib_async (pinned in trading\\.venv, the bridge's Python)")
class AdapterFreshness(unittest.TestCase):
    def _adapter(self, ib):
        import tempfile

        from tws_adapter import IbAdapter

        a = IbAdapter(20, readonly=True, d=Path(tempfile.mkdtemp()))
        a.ib = ib
        return a

    def test_open_orders_ignores_other_clients_stale_cache(self):  # finding 16
        def trade(cid, oid, status):
            return NS(order=NS(orderId=oid, permId=oid + 1000, clientId=cid, parentId=0, ocaGroup="", action="SELL", totalQuantity=1,
                               orderType="STP", lmtPrice=0, auxPrice=700, tif="GTC", orderRef="r"),
                      contract=NS(conId=1, localSymbol="SPY", symbol="SPY", secType="STK", currency="USD"),
                      orderStatus=NS(status=status, filled=0, remaining=1))

        stale = trade(13, 15, "Submitted")  # cancelled at TWS since, but this client's cache never heard
        own = trade(20, 7, "PreSubmitted")

        async def reply():
            return []  # TWS: no working orders of other clients any more

        ib = NS(isConnected=lambda: True, reqAllOpenOrdersAsync=reply, openTrades=lambda: [stale, own])
        rows = run(self._adapter(ib).open_orders())
        self.assertEqual([r["orderId"] for r in rows], [7])

    def test_quote_does_not_reuse_the_previous_subscription(self):  # finding 18
        cached = NS(bid=700.0, ask=700.1, last=700.05, close=699.0, time=NS(timestamp=lambda: 1.0))

        async def qualify(*_c):
            return [NS(conId=1)]

        ib = NS(isConnected=lambda: True, qualifyContractsAsync=qualify, reqMktData=lambda *a: cached, cancelMktData=lambda c: None)
        q = run(self._adapter(ib).quote("SPY", wait_s=0.3))
        self.assertIsNone(q["time"])
        self.assertIsNone(q["bid"])


if __name__ == "__main__":
    unittest.main()
