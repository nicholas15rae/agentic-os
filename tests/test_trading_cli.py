"""desk-cli against the mocked TWS: read-only commands change nothing, two-stage confirmation on every
destructive command, reconcile drift exits non-zero, selective vs full kill, ledger tamper detection."""

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "trading"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import desk_lock  # noqa: E402
from desk_harness import Env  # noqa: E402


def live_like(e):
    """Mirror of the live rehearsal: 1 SPY @717.25, bracket STP 712 / LMT 719.80 GTC, owned by the bridge's executor (13)."""
    return e.position_with_bracket("SPY", 756733, 1, 717.25, 712.0, 719.8, client_id=13, ref="rehearsal-145646")


class ReadOnlyCommandTests(unittest.TestCase):
    def setUp(self):
        self.e = Env()
        live_like(self.e)

    def tearDown(self):
        self.e.close()

    def test_status_json_reads_orders_on_its_own_read_only_client(self):
        code, out, _ = self.e.cli(["status", "--json"])
        self.assertEqual(code, 0)
        s = json.loads(out)
        self.assertEqual(s["positions"][0]["symbol"], "SPY")
        self.assertEqual((s["positions"][0]["bracket"], s["positions"][0]["stop"], s["positions"][0]["takeProfit"]), ("PROTECTED", 712.0, 719.8))
        self.assertEqual(s["brokerSource"], "tws:client25")
        self.assertEqual(self.e.b.connected, set())  # disconnected again
        self.assertEqual(self.e.b.actions, [])

    def test_status_bridge_only_is_flagged_as_possibly_stale(self):
        code, out, _ = self.e.cli(["status", "--json", "--bridge-only"])
        s = json.loads(out)
        self.assertEqual(s["brokerSource"], "bridge")
        self.assertTrue(any("stale" in e or "may not show" in e for e in s["brokerErrors"]))
        self.assertEqual(self.e.b.connected, set())

    def test_status_shows_naked_after_an_outside_cancel(self):
        # The live 2026-11-24 case: the kill switch cancelled the bracket; the bridge's cache still lists it.
        for o in self.e.b.orders.values():
            if o["orderType"] in ("STP", "LMT") and o["action"] == "SELL":
                o["status"] = "Cancelled"
        code, out, _ = self.e.cli(["status", "--json"])
        self.assertEqual(json.loads(out)["positions"][0]["bracket"], "NAKED")

    def test_reconcile_live_example_is_ok_and_read_only(self):
        code, out, _ = self.e.cli(["reconcile", "--json"])
        self.assertEqual(code, 0, out)
        r = json.loads(out)
        self.assertTrue(r["ok"])
        self.assertEqual(r["positions"][0]["bracket"]["status"], "PROTECTED")
        self.assertEqual(r["brokerSource"], "tws:client22")
        self.assertEqual(self.e.b.actions, [])
        self.assertTrue(desk_lock.read_reconcile_stamp(self.e.d)["ok"])
        self.assertEqual(self.e.ledger().tail(1)[0]["kind"], "reconcile")

    def test_reconcile_drift_exits_2_and_optionally_locks(self):
        self.e.b.add_order("SPY", 756733, "BUY", 5, "LMT", limit=700.0, client_id=0, ref="")  # manual order: phantom
        code, out, _ = self.e.cli(["reconcile"])
        self.assertEqual(code, 2)
        self.assertIn("PHANTOM_ORDER", out)
        self.assertFalse(desk_lock.is_locked(self.e.d))
        code, _, _ = self.e.cli(["reconcile", "--lock-on-drift"])
        self.assertEqual(code, 2)
        self.assertIn("STATE_DRIFT", [b["code"] for b in desk_lock.read_lock(self.e.d)["breakers"]])

    def test_reconcile_detects_qty_mismatch_unlogged_fill_and_naked(self):
        b = self.e.b
        b.positions[756733]["position"] = 3  # broker holds more than the desk expects
        b._execute({"orderId": 999, "permId": 1, "clientId": 0, "conId": 756733, "symbol": "SPY", "action": "BUY", "orderRef": ""}, 2, 717.0)
        for o in b.orders.values():
            if o["orderType"] == "STP":
                o["status"] = "Cancelled"  # stop gone
        code, out, _ = self.e.cli(["reconcile", "--json"])
        self.assertEqual(code, 2)
        codes = {x["code"] for x in json.loads(out)["drift"]}
        self.assertTrue({"QTY_MISMATCH", "UNLOGGED_FILL", "NAKED_POSITION"} <= codes, codes)

    def test_snapshot_json_shape_and_no_side_effects(self):
        code, out, err = self.e.cli(["overseer-snapshot", "--json"])
        self.assertEqual(code, 0, err)
        s = json.loads(out)
        for k in ("lock", "deadMansSwitch", "heartbeats", "reconcile", "positions", "circuitBreakers", "ledger"):
            self.assertIn(k, s)
        p = s["positions"][0]
        for k in ("unrealizedPnl", "drawdownPct", "slopeAtrPerBar", "relVolume", "atrPct", "iv", "tier", "reasonCodes", "bracket"):
            self.assertIn(k, p)
        self.assertEqual(p["bracket"], "PROTECTED")
        self.assertTrue(s["reconcile"]["ok"])
        self.assertEqual(self.e.b.actions, [])
        self.assertFalse(desk_lock.is_locked(self.e.d))

    def test_watch_count(self):
        code, out, _ = self.e.cli(["watch", "--interval", "1s", "--count", "2", "--json"])
        self.assertEqual(code, 0)
        self.assertEqual(len(out.strip().splitlines()), 2)

    def test_audit_verifies_and_detects_tamper(self):
        self.e.cli(["lock", "--reason", "a"])
        self.e.cli(["reconcile"])
        code, out, _ = self.e.cli(["audit", "--json"])
        self.assertEqual(code, 0)
        self.assertTrue(json.loads(out)["chain"]["ok"])
        p = self.e.d / "ledger.jsonl"
        p.write_text(p.read_text(encoding="utf-8").replace('"a"', '"b"', 1), encoding="utf-8")
        code, out, _ = self.e.cli(["audit"])
        self.assertEqual(code, 2)


class LockTests(unittest.TestCase):
    def test_lock_and_halt_never_touch_the_broker(self):
        e = Env()
        try:
            live_like(e)
            self.assertEqual(e.cli(["lock", "--reason", "lunch"])[0], 0)
            self.assertTrue(desk_lock.is_locked(e.d))
            self.assertEqual(e.cli(["halt"])[0], 0)
            st = json.loads((e.d / "state.json").read_text())
            self.assertEqual((st["mode"], st["agentHalted"]), ("ADVISORY", True))
            self.assertEqual(e.b.actions, [])
            self.assertEqual([b["code"] for b in desk_lock.read_lock(e.d)["breakers"]], ["MANUAL_LOCK", "HALT"])
        finally:
            e.close()


class ConfirmationTests(unittest.TestCase):
    def setUp(self):
        self.e = Env()
        live_like(self.e)
        self.e.cli(["lock"])

    def tearDown(self):
        self.e.close()

    def verdicts(self):
        return [r["verdict"] for r in self.e.ledger().read() if r["kind"] == "confirmation"]

    def test_non_interactive_without_flags_is_refused(self):
        code, _, err = self.e.cli(["unlock"])
        self.assertEqual(code, 3)
        self.assertIn("non-interactive", err)
        self.assertTrue(desk_lock.is_locked(self.e.d))
        self.assertEqual(self.verdicts(), ["REFUSED"])

    def test_unlock_never_accepts_a_system_trigger(self):
        code, _, err = self.e.cli(["unlock", "--system-trigger", "cron"])
        self.assertEqual(code, 3)
        self.assertTrue(desk_lock.is_locked(self.e.d))

    def test_force_needs_the_exact_token(self):
        self.assertEqual(self.e.cli(["unlock", "--force", "--confirm-token", "CONFIRM"])[0], 3)
        self.assertTrue(desk_lock.is_locked(self.e.d))
        self.assertEqual(self.e.cli(["unlock", "--force", "--confirm-token", "CONFIRM UNLOCK"])[0], 0)
        self.assertFalse(desk_lock.is_locked(self.e.d))
        self.assertEqual(self.verdicts(), ["REFUSED", "FORCED"])

    def test_interactive_two_stages(self):
        code, _, err = self.e.cli(["unlock"], stdin="n\n", tty=True)
        self.assertEqual(code, 3)
        code, _, err = self.e.cli(["unlock"], stdin="y\nCONFIRM UNLOK\n", tty=True)
        self.assertEqual(code, 3)
        self.assertTrue(desk_lock.is_locked(self.e.d))
        code, _, err = self.e.cli(["unlock"], stdin="y\nCONFIRM UNLOCK\n", tty=True)
        self.assertEqual(code, 0, err)
        self.assertIn("positions affected", err)  # the impact was shown before the prompt
        self.assertIn("SPY", err)
        self.assertFalse(desk_lock.is_locked(self.e.d))
        self.assertEqual(self.verdicts(), ["ABORTED", "ABORTED", "CONFIRMED"])

    def test_unlock_refused_while_reconcile_drifts(self):
        self.e.b.add_order("SPY", 756733, "BUY", 5, "LMT", limit=700.0, client_id=0, ref="")
        code, _, err = self.e.cli(["unlock", "--force", "--confirm-token", "CONFIRM UNLOCK"])
        self.assertEqual(code, 4)
        self.assertIn("drift", err)
        self.assertTrue(desk_lock.is_locked(self.e.d))
        self.assertEqual(self.verdicts(), [])  # refused before the confirmation stage

    def test_arm_and_disarm(self):
        from overseer import armed

        self.assertEqual(self.e.cli(["overseer", "--arm"])[0], 3)
        self.assertFalse(armed(self.e.d))
        self.assertEqual(self.e.cli(["overseer", "--arm", "--force", "--confirm-token", "CONFIRM ARM"])[0], 0)
        self.assertTrue(armed(self.e.d))
        self.assertEqual(self.e.cli(["overseer", "--disarm", "--system-trigger", "x"])[0], 3)  # disarm is human-only
        self.assertTrue(armed(self.e.d))
        self.assertEqual(self.e.cli(["overseer", "--disarm"], stdin="y\nCONFIRM DISARM\n", tty=True)[0], 0)
        self.assertFalse(armed(self.e.d))


class KillTests(unittest.TestCase):
    def setUp(self):
        self.e = Env()
        e = self.e
        self.spy = e.position_with_bracket("SPY", 1, 10, 100.0, 98.0, 103.0, client_id=23)
        self.xle = e.position_with_bracket("XLE", 4, 20, 50.0, 48.0, 52.0, client_id=23)
        self.qqq = e.b.add_bracket("QQQ", 3, 5, 400.0, 392.0, 410.0, ref="intent-qqq-001", client_id=23, filled=False)
        e.add_intent("intent-qqq-001", "QQQ", 5, self.qqq)
        e.market("QQQ", 401.0)

    def tearDown(self):
        self.e.close()

    def test_refused_kill_changes_nothing(self):
        code, _, err = self.e.cli(["kill", "--mode", "all"], stdin="y\nCONFIRM FLATEN\n", tty=True)
        self.assertEqual(code, 3)
        self.assertIn("CONFIRM FLATTEN", err)
        self.assertEqual(self.e.b.actions, [])
        self.assertFalse(desk_lock.is_locked(self.e.d))

    def test_kill_all_flattens_everything(self):
        code, out, err = self.e.cli(["kill", "--mode", "all", "--json"], stdin="y\nCONFIRM FLATTEN\n", tty=True)
        self.assertEqual(code, 0, err)
        self.assertEqual(self.e.b.positions, {})
        self.assertEqual(self.e.b.working(), [])
        self.assertTrue(desk_lock.is_locked(self.e.d))
        self.assertIn("unrealized P&L at risk", err)

    def test_selective_liquidates_only_the_target(self):
        code, out, err = self.e.cli(["kill", "--symbol", "XLE", "--force", "--confirm-token", "CONFIRM LIQUIDATE XLE"])
        self.assertEqual(code, 0, err + out)
        self.assertNotIn(4, self.e.b.positions)
        self.assertEqual(self.e.b.positions[1]["position"], 10)
        spy_live = [o for o in self.e.b.orders.values() if o["symbol"] == "SPY" and o["status"] in ("Submitted", "PreSubmitted")]
        self.assertEqual(len(spy_live), 2, "SPY stop + take-profit untouched")
        qqq_live = [o for o in self.e.b.orders.values() if o["symbol"] == "QQQ" and o["status"] in ("Submitted", "PreSubmitted")]
        self.assertEqual(len(qqq_live), 3, "entries untouched without --cancel-entries")
        self.assertTrue(desk_lock.is_locked(self.e.d))

    def test_cancel_entries_only(self):
        code, out, err = self.e.cli(["kill", "--cancel-entries", "--system-trigger", "test harness"])
        self.assertEqual(code, 0, err + out)
        self.assertTrue(all(self.e.b.orders[o["orderId"]]["status"] == "Cancelled" for o in self.qqq))
        self.assertEqual(len([o for o in self.e.b.working() if o["symbol"] in ("SPY", "XLE")]), 4)
        self.assertEqual(self.e.b.positions[1]["position"], 10)
        self.assertIn("SYSTEM_TRIGGER", [r["verdict"] for r in self.e.ledger().read() if r["kind"] == "confirmation"])

    def test_wrong_symbol_is_refused(self):
        code, _, err = self.e.cli(["kill", "--symbol", "TSLA", "--force", "--confirm-token", "CONFIRM LIQUIDATE TSLA"])
        self.assertEqual(code, 4)
        self.assertEqual(self.e.b.actions, [])

    def test_broker_truth_after_cancel_then_unlock(self):
        self.e.cli(["kill", "--cancel-entries", "--system-trigger", "t"])
        code, out, _ = self.e.cli(["reconcile", "--json"])
        self.assertEqual(code, 2)
        self.assertIn("ORPHAN_INTENT", {x["code"] for x in json.loads(out)["drift"]})
        code, out, err = self.e.cli(["reconcile", "--json", "--apply-broker-truth", "--force", "--confirm-token", "CONFIRM BROKER TRUTH"])
        self.assertEqual(code, 0, err)
        self.assertEqual(self.e.intent_status("intent-qqq-001"), "cancelled")
        self.assertEqual(self.e.cli(["unlock", "--force", "--confirm-token", "CONFIRM UNLOCK"])[0], 0)


if __name__ == "__main__":
    unittest.main()
