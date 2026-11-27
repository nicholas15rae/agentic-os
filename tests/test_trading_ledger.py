"""Foundations: hash-chained JSONL ledger, risk-policy.json validation, the persistent desk lock, client-id leases."""

import json
import multiprocessing
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "trading"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import desk_lock  # noqa: E402
import kill_switch  # noqa: E402
import risk_policy as rp  # noqa: E402
from ledger import Ledger  # noqa: E402
from tws_adapter import ClientLease, LeaseBusy  # noqa: E402


def _append_many(path: str, n: int, tag: str) -> None:
    led = Ledger(Path(path))
    for i in range(n):
        led.append("proc", {"tag": tag, "i": i})


class LedgerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.p = Path(self.tmp.name) / "ledger.jsonl"

    def tearDown(self):
        self.tmp.cleanup()

    def test_chain_verifies_and_tail_is_chronological(self):
        led = Ledger(self.p)
        for i in range(5):
            led.append("k", {"i": i}, ref=f"r{i}", verdict="OK", actor="t")
        ok, note = led.verify()
        self.assertTrue(ok, note)
        self.assertEqual([r["payload"]["i"] for r in led.tail(3)], [2, 3, 4])
        self.assertEqual(led.read()[0]["prev"], "0" * 64)

    def test_edit_delete_and_reorder_break_the_chain(self):
        led = Ledger(self.p)
        for i in range(4):
            led.append("k", {"i": i})
        lines = self.p.read_text(encoding="utf-8").splitlines()
        edited = json.loads(lines[1])
        edited["payload"]["i"] = 99
        for bad in ([lines[0], json.dumps(edited), *lines[2:]], [lines[0], *lines[2:]], [lines[1], lines[0], *lines[2:]]):
            self.p.write_text("\n".join(bad) + "\n", encoding="utf-8")
            self.assertFalse(led.verify()[0])

    def test_torn_last_line_is_skipped_for_appends_but_reported(self):
        led = Ledger(self.p)
        led.append("k", {"i": 1})
        with open(self.p, "a", encoding="utf-8") as f:
            f.write('{"seq": 2, "ts"')  # crash mid-write
        self.assertFalse(led.verify()[0])

    def test_concurrent_processes_keep_one_chain(self):
        procs = [multiprocessing.Process(target=_append_many, args=(str(self.p), 15, t)) for t in "abc"]
        for p in procs:
            p.start()
        for p in procs:
            p.join(30)
        led = Ledger(self.p)
        ok, note = led.verify()
        self.assertTrue(ok, note)
        self.assertEqual(len(led.read()), 45)


class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.p = Path(self.tmp.name) / "risk-policy.json"

    def tearDown(self):
        self.tmp.cleanup()

    def test_created_with_defaults(self):
        pol = rp.load_policy(self.p)
        self.assertTrue(self.p.exists())
        self.assertEqual(pol["dead_mans_switch"]["grace_s"], 45)

    def test_partial_file_merges_over_defaults(self):
        self.p.write_text(json.dumps({"master_stop": {"tier2_confirm_evals": 5}}), encoding="utf-8")
        pol = rp.load_policy(self.p)
        self.assertEqual(pol["master_stop"]["tier2_confirm_evals"], 5)
        self.assertEqual(pol["master_stop"]["tier2_score"], 0.7)

    def test_fail_closed_on_bad_input(self):
        bad = [
            {"nope": 1},
            {"pretrade": {"max_shares_per_order": "10"}},
            {"dead_mans_switch": {"grace_s": 5}},
            {"dead_mans_switch": {"grace_s": 120}},
            {"dead_mans_switch": {"naked_action": "pray"}},
            {"master_stop": {"tier1_score": 0.8, "tier2_score": 0.7}},
            {"master_stop": {"weights": {"drawdown": 0.9, "slope": 0.9, "rel_volume": 0, "volatility": 0}}},
            {"pretrade": {"allowlist": ["SPY", "not a ticker!"]}},
            {"pretrade": {"require_take_profit": 1}},
        ]
        for b in bad:
            self.p.write_text(json.dumps(b), encoding="utf-8")
            with self.assertRaises(rp.PolicyError, msg=str(b)):
                rp.load_policy(self.p)
        self.p.write_text("{not json", encoding="utf-8")
        with self.assertRaises(rp.PolicyError):
            rp.load_policy(self.p)


class DeskLockTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_lock_is_the_kill_switch_lock_and_widens(self):
        a = desk_lock.lock(self.d, "operator lock", "cli", now=100.0)
        self.assertTrue(kill_switch.is_locked(self.d))  # the bridge's own check sees it
        b = desk_lock.lock(self.d, "breaker", "overseer", breaker="DAILY_LOSS", now=200.0)
        self.assertEqual(a["incidentId"], b["incidentId"])
        self.assertEqual([x["code"] for x in b["breakers"]], ["MANUAL_LOCK", "DAILY_LOSS"])
        self.assertTrue(b["requiresReconcile"])

    def test_kill_switch_lock_is_kept_as_first_incident(self):
        kill_switch.write_lock("e-stop", "ui", "inc-1", self.d)
        out = desk_lock.lock(self.d, "x", "cli", breaker="STATE_DRIFT")
        self.assertEqual(out["incidentId"], "inc-1")
        self.assertEqual(out["reason"], "e-stop")

    def test_unlock_needs_fresh_passing_reconcile_newer_than_lock(self):
        desk_lock.lock(self.d, "x", "cli", now=1000.0)
        with self.assertRaises(desk_lock.UnlockRefused):
            desk_lock.unlock(self.d, "cli", 120, now=1010.0)  # no reconcile
        desk_lock.write_reconcile_stamp(self.d, False, {}, now=1005.0)
        with self.assertRaises(desk_lock.UnlockRefused):
            desk_lock.unlock(self.d, "cli", 120, now=1010.0)  # drift
        desk_lock.write_reconcile_stamp(self.d, True, {}, now=990.0)
        with self.assertRaises(desk_lock.UnlockRefused):
            desk_lock.unlock(self.d, "cli", 120, now=1010.0)  # older than the lock
        desk_lock.write_reconcile_stamp(self.d, True, {}, now=1001.0)
        with self.assertRaises(desk_lock.UnlockRefused):
            desk_lock.unlock(self.d, "cli", 120, now=1500.0)  # too old
        out = desk_lock.unlock(self.d, "cli", 120, now=1050.0)
        self.assertFalse(out["locked"])
        self.assertFalse(desk_lock.is_locked(self.d))

    def test_unreadable_lock_is_locked(self):
        (self.d / "TRADING_LOCKED.json").write_text("garbage", encoding="utf-8")
        self.assertTrue(desk_lock.is_locked(self.d))

    def test_halt_autonomy_keeps_other_state(self):
        (self.d / "state.json").write_text(json.dumps({"mode": "FULL_AUTO", "agentHalted": False, "financer": {"x": 1}}), encoding="utf-8")
        s = desk_lock.halt_autonomy(self.d)
        self.assertEqual((s["mode"], s["agentHalted"], s["financer"]), ("ADVISORY", True, {"x": 1}))


class LeaseTests(unittest.TestCase):
    def test_second_holder_is_refused_until_release(self):
        with tempfile.TemporaryDirectory() as t:
            with ClientLease(Path(t), 22):
                with self.assertRaises(LeaseBusy):
                    with ClientLease(Path(t), 22):
                        pass
                with ClientLease(Path(t), 23):
                    pass  # other ids are independent
            with ClientLease(Path(t), 22):
                pass


if __name__ == "__main__":
    unittest.main()
