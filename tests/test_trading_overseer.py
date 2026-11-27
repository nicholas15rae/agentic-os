"""Overseer (Dead Man's Switch, breakers, Master Stop-Loss) against the mocked TWS.

Proves: observe mode never acts; clean close → HIBERNATE (autonomy halted, brackets verified, nothing
cancelled); crash → LOCK after the grace window, unfilled entries cancelled, protected positions
untouched (DEGRADED_LOCKED), naked positions get an emergency stop; TWS down → LOCK now, broker steps
deferred until it returns, and the desk stays LOCKED; noise is NOT liquidated while a confirmed
breakdown is selectively liquidated and a healthy position keeps its bracket; breakers persist the
LOCK across restarts; STATE_DRIFT needs two consecutive ticks.
"""

import asyncio
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "trading"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import desk_lock  # noqa: E402
import kill_switch  # noqa: E402
from desk_harness import Env  # noqa: E402

run = asyncio.run


def kinds(env, verdict=None):
    return [(r["kind"], r["verdict"]) for r in env.ledger().read() if verdict is None or r["verdict"] == verdict]


class ObserveModeTests(unittest.TestCase):
    def test_observe_never_touches_broker_or_lock(self):
        env = Env()
        try:
            env.position_with_bracket("SPY", 1, 10, 100.0, 98.0, 103.0)
            env.b.add_position("IWM", 5, 200.0, 2)  # naked, untracked
            env.add_intent("intent-iwm-001", "IWM", 5, [env.b.add_order("IWM", 2, "BUY", 5, "LMT", limit=200.0, status="Filled", ref="intent-iwm-001")])
            env.market("IWM", 200.0)
            ov = env.overseer()
            env.cc.state = "RUNNING"
            run(ov.tick())
            env.cc.state, env.cc.exit_code = "EXITED_CRASH", 0xC0000005
            run(ov.tick())
            env.advance(31)
            out = run(ov.tick())
            self.assertFalse(out["armed"])
            self.assertIn("lock", [a["kind"] for a in out["plannedActions"]])
            self.assertIn("emergency_stop", [a["kind"] for a in out["plannedActions"]])
            self.assertEqual(env.b.actions, [])
            self.assertFalse(desk_lock.is_locked(env.d))
            self.assertIn(("would_act", "OBSERVE"), kinds(env))
        finally:
            env.close()


class DeadMansSwitchTests(unittest.TestCase):
    def setUp(self):
        self.env = Env()
        self.env.arm()
        e = self.env
        e.position_with_bracket("SPY", 1, 10, 100.0, 98.0, 103.0)           # protected
        # Unfilled entry bracket for QQQ (another API client, so it can be cancelled by borrowing its id).
        self.qqq = e.b.add_bracket("QQQ", 3, 5, 400.0, 392.0, 410.0, ref="intent-qqq-001", client_id=31, filled=False)
        e.add_intent("intent-qqq-001", "QQQ", 5, self.qqq)
        e.market("QQQ", 401.0)
        # Naked IWM: its stop was lost (only the filled parent remains).
        p = e.b.add_order("IWM", 2, "BUY", 5, "LMT", limit=200.0, status="Filled", ref="intent-iwm-001", client_id=30)
        e.b.add_position("IWM", 5, 200.0, 2)
        e.add_intent("intent-iwm-001", "IWM", 5, [p])
        e.market("IWM", 199.0)
        self.ov = e.overseer()

    def tearDown(self):
        self.env.close()

    def test_clean_close_hibernates_without_touching_orders(self):
        e = self.env
        run(self.ov.tick())
        e.cc.state, e.cc.exit_code = "EXITED_CLEAN", 0
        out = run(self.ov.tick())
        st = json.loads((e.d / "state.json").read_text())
        self.assertEqual((st["mode"], st["agentHalted"]), ("ADVISORY", True))
        self.assertFalse(desk_lock.is_locked(e.d))
        self.assertEqual([a for a in e.b.actions if a[0] in ("cancel", "global_cancel")], [])
        hib = [r for r in e.ledger().read() if r["kind"] == "hibernate"]
        self.assertEqual(len(hib), 1)
        self.assertTrue(hib[0]["payload"]["verified"])
        self.assertIn({"symbol": "SPY", "status": "PROTECTED"}, hib[0]["payload"]["brackets"])
        self.assertEqual(out["dms"], "HIBERNATE")
        # Later ticks with the app gone don't re-hibernate or crash-trigger.
        e.cc.state = "ABSENT"
        e.advance(120)
        run(self.ov.tick())
        self.assertEqual(len([r for r in e.ledger().read() if r["kind"] == "hibernate"]), 1)
        # The only lock is the naked-IWM breaker (beyond naked_grace_s), never a Dead Man's Switch trigger.
        codes = [b["code"] for b in (desk_lock.read_lock(e.d) or {}).get("breakers") or []]
        self.assertEqual(codes, ["NAKED_POSITION"])
        self.assertFalse(any(c.startswith("DMS_") for c in codes))

    def test_crash_locks_after_grace_cancels_entries_protects_naked_and_leaves_protected(self):
        e = self.env
        run(self.ov.tick())
        e.cc.state, e.cc.exit_code = "EXITED_CRASH", 0xC0000005
        out = run(self.ov.tick())
        self.assertFalse(desk_lock.is_locked(e.d), "inside the grace window nothing happens")
        self.assertEqual(out["dms"], "GRACE")
        e.advance(31)
        out = run(self.ov.tick())
        lk = desk_lock.read_lock(e.d)
        self.assertIsNotNone(lk)
        self.assertIn("DMS_CC", [b["code"] for b in lk["breakers"]])
        self.assertTrue(kill_switch.is_locked(e.d))  # the bridge's Security Detail / executor see it
        # QQQ entry bracket cancelled (all three legs), by its owner id.
        for o in self.qqq:
            self.assertEqual(e.b.orders[o["orderId"]]["status"], "Cancelled")
        # SPY bracket untouched.
        spy = [o for o in e.b.orders.values() if o["symbol"] == "SPY" and o["status"] not in ("Filled",)]
        self.assertTrue(spy and all(o["status"] in ("PreSubmitted", "Submitted") for o in spy))
        self.assertIn(("alert", "DEGRADED_LOCKED"), kinds(e))
        # IWM got a GTC emergency stop below the market, reduce-only, from the overseer's act client.
        stops = [o for o in e.b.orders.values() if o["symbol"] == "IWM" and o["orderType"] == "STP"]
        self.assertEqual(len(stops), 1)
        self.assertEqual((stops[0]["action"], stops[0]["quantity"], stops[0]["tif"], stops[0]["clientId"]), ("SELL", 5.0, "GTC", 21))
        self.assertLess(stops[0]["stopPrice"], 199.0)
        self.assertEqual(e.b.positions[1]["position"], 10)  # nothing sold
        self.assertEqual(e.b.positions[2]["position"], 5)
        # Broker truth: the cancelled QQQ intent moves to cancelled (TWS-acknowledged cancels).
        run(self.ov.tick())
        self.assertEqual(e.intent_status("intent-qqq-001"), "cancelled")
        # No repeat on later ticks.
        n = len(e.b.actions)
        e.advance(200)
        run(self.ov.tick())
        self.assertEqual(len([a for a in e.b.actions[n:] if a[0] == "place"]), 0)

    def test_tws_down_locks_now_defers_broker_steps_and_stays_locked_after_recovery(self):
        e = self.env
        run(self.ov.tick())
        e.b.up = False  # TWS gone (bridge still answers, but RECONNECTING)
        run(self.ov.tick())
        e.advance(31)
        out = run(self.ov.tick())
        self.assertTrue(desk_lock.is_locked(e.d))
        self.assertIn("DMS_TWS", [b["code"] for b in desk_lock.read_lock(e.d)["breakers"]])
        self.assertEqual([a for a in e.b.actions if a[0] != "noop"], [])
        self.assertTrue(self.ov.state["pendingActions"])
        e.b.up = True
        e.advance(10)
        out = run(self.ov.tick())
        self.assertEqual(self.ov.state["pendingActions"], [])
        self.assertTrue(any(a[0] == "cancel" for a in e.b.actions))           # deferred entry cancels ran
        self.assertTrue(any(a[0] == "place" and a[2]["orderType"] == "STP" for a in e.b.actions))
        self.assertTrue(desk_lock.is_locked(e.d))
        self.assertEqual(out["dms"], "RECOVERING_LOCKED")

    def test_bridge_owned_orders_are_never_cancelled_from_outside_while_the_bridge_lives(self):
        e = Env()
        try:
            e.arm()
            qqq = e.b.add_bracket("QQQ", 3, 5, 400.0, 392.0, 410.0, ref="intent-qqq-002", client_id=13, filled=False)
            e.add_intent("intent-qqq-002", "QQQ", 5, qqq)
            e.market("QQQ", 401.0)
            ov = e.overseer()
            run(ov.tick())
            e.cc.state, e.cc.exit_code = "HUNG", None
            run(ov.tick())
            e.advance(31)
            run(ov.tick())
            self.assertTrue(desk_lock.is_locked(e.d))  # the lock still blocks every new intent
            self.assertTrue(all(o["status"] != "Cancelled" for o in qqq))
            blocked = [r for r in e.ledger().read() if r["kind"] == "orders_cancel"]
            self.assertTrue(blocked and blocked[-1]["verdict"] == "BLOCKED")
        finally:
            e.close()


class MasterStopTests(unittest.TestCase):
    def test_noise_held_breakdown_selectively_liquidated_healthy_untouched(self):
        e = Env()
        try:
            e.arm()
            e.position_with_bracket("SPY", 1, 10, 100.0, 97.0, 104.0, client_id=30)
            e.position_with_bracket("XLE", 4, 20, 50.0, 48.0, 52.0, client_id=30)
            # SPY: a dip inside the noise buffer (0.2% < 0.5% = 0.5 x 1% ATR) with a steep slope and a volume surge.
            e.market("SPY", 99.8, slope_per_bar=0.02, surge=5.0)
            # XLE: confirmed breakdown: 2.4% down (2.4 ATR), falling fast, heavy volume.
            e.market("XLE", 48.8, slope_per_bar=0.06, surge=5.0)
            ov = e.overseer()
            tiers = []
            for _ in range(3):
                out = run(ov.tick())
                tiers.append({a["symbol"]: a["tier"] for a in out["assessments"].values()})
                e.advance(6)
                e.market("SPY", 99.8, slope_per_bar=0.02, surge=5.0)
                if 4 in e.b.positions:
                    e.market("XLE", 48.8, slope_per_bar=0.06, surge=5.0)
            self.assertEqual([t["SPY"] for t in tiers], [0, 0, 0])
            self.assertEqual([t["XLE"] for t in tiers][:2], [1, 1])  # pending confirmation
            self.assertEqual(tiers[2]["XLE"], 2)
            self.assertNotIn(4, e.b.positions, "XLE liquidated")
            self.assertEqual(e.b.positions[1]["position"], 10, "SPY kept")
            spy_legs = [o for o in e.b.orders.values() if o["symbol"] == "SPY" and o["status"] not in ("Filled",)]
            self.assertTrue(spy_legs and all(o["status"] != "Cancelled" for o in spy_legs), "healthy bracket intact")
            xle_legs = [o for o in e.b.orders.values() if o["symbol"] == "XLE" and o["orderType"] in ("STP", "LMT") and o["action"] == "SELL"
                        and o["orderRef"].startswith("intent-")]
            self.assertTrue(all(o["status"] == "Cancelled" for o in xle_legs))
            lk = desk_lock.read_lock(e.d)
            self.assertIn("MASTER_STOP_XLE", [b["code"] for b in lk["breakers"]])
            liq = [r for r in e.ledger().read() if r["kind"] == "liquidation"]
            self.assertEqual(liq[-1]["verdict"], "FILLED")
        finally:
            e.close()


class BreakerTests(unittest.TestCase):
    def test_daily_loss_lock_persists_across_restart_and_blocks_unlock_until_reconcile(self):
        e = Env()
        try:
            e.arm()
            e.position_with_bracket("SPY", 1, 10, 100.0, 98.0, 103.0)
            e.daily = -3000.0  # 3% of 100k start equity > 2.5% cap
            run(e.overseer().tick())
            self.assertIn("DAILY_LOSS", [b["code"] for b in desk_lock.read_lock(e.d)["breakers"]])
            st = json.loads((e.d / "state.json").read_text())
            self.assertTrue(st["agentHalted"])
            # "Restart": a brand new overseer and CLI process see the same lock.
            e.daily = 0.0
            run(e.overseer().tick())
            self.assertTrue(desk_lock.is_locked(e.d))
            code, out, err = e.cli(["unlock", "--force", "--confirm-token", "CONFIRM UNLOCK"])
            self.assertEqual(code, 0, err)  # unlock runs its own fresh reconcile, which passes here
            self.assertFalse(desk_lock.is_locked(e.d))
        finally:
            e.close()

    def test_rejection_storm_locks(self):
        e = Env({"circuit_breakers": {"rejection_storm_count": 3}})
        try:
            e.arm()
            for i in range(3):
                e.ledger().append("liquidation", {}, ref=f"x{i}", verdict="FAILED", actor="t")
            run(e.overseer().tick())
            self.assertIn("REJECTION_STORM", [b["code"] for b in desk_lock.read_lock(e.d)["breakers"]])
        finally:
            e.close()

    def test_naked_beyond_grace_gets_fail_safe_even_without_a_crash(self):
        e = Env({"circuit_breakers": {"naked_grace_s": 30}})
        try:
            e.arm()
            p = e.b.add_order("IWM", 2, "BUY", 5, "LMT", limit=200.0, status="Filled", ref="intent-iwm-001", client_id=30)
            e.b.add_position("IWM", 5, 200.0, 2)
            e.add_intent("intent-iwm-001", "IWM", 5, [p])
            e.market("IWM", 200.0)
            ov = e.overseer()
            run(ov.tick())
            self.assertFalse(any(a[0] == "place" for a in e.b.actions))
            e.advance(31)
            e.market("IWM", 200.0)
            run(ov.tick())
            self.assertTrue(any(a[0] == "place" and a[2]["orderType"] == "STP" for a in e.b.actions))
            self.assertIn("NAKED_POSITION", [b["code"] for b in desk_lock.read_lock(e.d)["breakers"]])
        finally:
            e.close()

    def test_state_drift_needs_two_consecutive_ticks(self):
        e = Env()
        try:
            e.arm()
            e.position_with_bracket("SPY", 1, 10, 100.0, 98.0, 103.0)
            e.b.add_order("SPY", 1, "BUY", 1, "LMT", limit=90.0, client_id=0, ref="")  # manual TWS order: phantom
            ov = e.overseer()
            run(ov.tick())
            self.assertFalse(desk_lock.is_locked(e.d))
            run(ov.tick())
            self.assertIn("STATE_DRIFT", [b["code"] for b in desk_lock.read_lock(e.d)["breakers"]])
        finally:
            e.close()

    def test_invalid_policy_fails_closed(self):
        e = Env()
        try:
            e.arm()
            (e.d / "risk-policy.json").write_text('{"dead_mans_switch": {"grace_s": 5}}', encoding="utf-8")
            run(e.overseer().tick())
            self.assertIn("POLICY_INVALID", [b["code"] for b in desk_lock.read_lock(e.d)["breakers"]])
        finally:
            e.close()


class SnapshotTests(unittest.TestCase):
    def test_dry_tick_changes_nothing(self):
        e = Env()
        try:
            e.arm()
            e.position_with_bracket("SPY", 1, 10, 100.0, 98.0, 103.0)
            e.daily = -5000.0
            before = sorted(p.name for p in e.d.iterdir())
            out = run(e.overseer().tick(dry=True))
            self.assertIn("DAILY_LOSS", [b["code"] for b in out["breakers"]])
            self.assertFalse(desk_lock.is_locked(e.d))
            self.assertEqual(e.b.actions, [])
            self.assertFalse((e.d / "overseer_state.json").exists())
            self.assertEqual(sorted(p.name for p in e.d.iterdir() if p.suffix != ".lease" and p.name != "clients"), before)
        finally:
            e.close()


if __name__ == "__main__":
    unittest.main()
