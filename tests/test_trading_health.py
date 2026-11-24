"""Pipeline health check: statuses per scenario, and that it never sends orders or writes the lock."""

import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "trading"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import healthcheck as hc  # noqa: E402
import kill_switch  # noqa: E402
from desk import Desk  # noqa: E402
from test_trading_desk import FakeBridge, FakeExecutor, FakeKillIB, good_stats, mkt, pos  # noqa: E402
from test_trading_engines import FakeMD  # noqa: E402

NOW = 1_795_500_000.0


def by_name(res):
    return {c["name"]: c for c in res["checks"]}


class HealthTests(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.d = Path(self.td.name)
        self.ex = FakeExecutor()
        self.kill_ib = FakeKillIB([pos("SPY", 3)])
        self.session = True

    def tearDown(self):
        self.td.cleanup()

    def desk(self, bridge=None):
        async def connect(readonly):
            self.kill_ib.readonly = readonly
            return self.kill_ib

        async def quote(intent):
            return {"bid": 134.9, "ask": 135.1, "last": 135.0}, self.session

        dk = Desk(bridge or FakeBridge(updatedAt=NOW, clientId=11, readOnly=True,
                                       account={"account": "DU1234567", "netLiquidation": 100_000.0, "currency": "CAD"}),
                  executor=self.ex, quote_fn=quote, stats_fn=good_stats, kill_connect=connect, kill_market_order=mkt,
                  fx_source=False, market_data=FakeMD(), d=self.d, clock=lambda: NOW)
        dk.heartbeats = {k: NOW - 5 for k in hc.LOOP_LIMITS}
        dk.rag.put("SPY calls", ["class:external_signal_hypothesis", "source:discord", "ticker:SPY"])
        return dk

    def run_check(self, dk, **kw):
        kw.setdefault("lan_probe", lambda: [])
        kw.setdefault("tws_probe", lambda: True)
        return asyncio.run(hc.run_checks(dk, now=NOW, **kw))

    def test_healthy_system(self):
        res = self.run_check(self.desk())
        c = by_name(res)
        for name in ("paper_lock", "limits_files", "kill_lock", "audit_chain", "tws_exposure", "bridge", "fx_rate", "daily_bars",
                     "security_detail_probe", "dry_run", "engine_a_scan", "engine_b_chain", "trading_rag", "journal", "background_loops"):
            self.assertEqual(c[name]["status"], "PASS", (name, c[name]["detail"]))
        self.assertEqual(c["discord"]["status"], "WARN")  # nothing imported in this fixture
        self.assertEqual(res["overall"], "WARN")
        self.assertIn("LIVE locked", c["paper_lock"]["detail"])
        self.assertIn("would cancel 0 order(s), flatten 1 position(s)", c["dry_run"]["detail"])

    def test_never_sends_or_locks(self):
        dk = self.desk()
        self.run_check(dk)
        self.assertEqual(self.ex.placed, [])
        self.assertTrue(self.kill_ib.readonly)
        self.assertNotIn("reqGlobalCancel", self.kill_ib.calls)
        self.assertFalse(any(isinstance(x, tuple) for x in self.kill_ib.calls))  # no placeOrder
        self.assertFalse(kill_switch.is_locked(self.d))
        with dk._conn() as c:
            self.assertEqual(c.execute("SELECT COUNT(*) FROM intents").fetchone()[0], 0)  # the probe intent is never stored
        self.assertEqual(json.loads((self.d / "healthcheck" / "latest.json").read_text())["overall"], "WARN")
        self.assertEqual(dk.audit.tail(1)[0]["kind"], "healthcheck")

    def test_closed_market_is_expected_not_a_failure(self):
        self.session = False
        c = by_name(self.run_check(self.desk()))
        self.assertEqual(c["security_detail_probe"]["status"], "PASS", c["security_detail_probe"]["detail"])
        self.assertIn("market_hours", c["security_detail_probe"]["detail"])

    def test_disconnected_bridge(self):
        res = self.run_check(self.desk(FakeBridge(state="RECONNECTING", lastError="ConnectionRefusedError")))
        c = by_name(res)
        self.assertEqual(c["bridge"]["status"], "FAIL")
        self.assertIn("ConnectionRefusedError", c["bridge"]["detail"])
        # One root cause: everything that needs TWS is SKIP, only the bridge FAILs.
        for name in ("daily_bars", "security_detail_probe", "dry_run", "engine_a_scan", "engine_b_chain"):
            self.assertEqual(c[name]["status"], "SKIP", name)
        self.assertEqual([x["name"] for x in res["checks"] if x["status"] == "FAIL"], ["bridge"])
        self.assertEqual(res["overall"], "FAIL")

    def test_non_paper_account_fails(self):
        c = by_name(self.run_check(self.desk(FakeBridge(updatedAt=NOW, account={"account": "U7654321", "netLiquidation": 1.0, "currency": "CAD"}))))
        self.assertEqual(c["bridge"]["status"], "FAIL")

    def test_lock_exposure_and_stalled_loops(self):
        dk = self.desk()
        kill_switch.write_lock("test", "t", "inc", self.d)
        dk.heartbeats["options_guard"] = NOW - 3600
        del dk.heartbeats["intel"]
        c = by_name(self.run_check(dk, lan_probe=lambda: ["192.168.1.20"]))
        self.assertEqual(c["kill_lock"]["status"], "WARN")
        self.assertEqual(c["tws_exposure"]["status"], "WARN")
        self.assertIn("localhost only", c["tws_exposure"]["detail"])
        self.assertEqual(c["background_loops"]["status"], "FAIL")
        self.assertIn("options_guard (3600s ago)", c["background_loops"]["detail"])
        self.assertIn("intel (never)", c["background_loops"]["detail"])

    def test_exposure_skipped_when_tws_is_off(self):
        c = by_name(self.run_check(self.desk(), tws_probe=lambda: False, lan_probe=lambda: ["10.0.0.5"]))
        self.assertEqual(c["tws_exposure"]["status"], "SKIP")

    def test_loop_ages_never_negative(self):
        dk = self.desk()
        dk.heartbeats = {k: NOW + 30 for k in hc.LOOP_LIMITS}  # loops ticked while the check ran
        d = by_name(self.run_check(dk))["background_loops"]["detail"]
        self.assertNotIn("-", d)

    def test_a_crashing_check_is_a_fail_not_a_crash(self):
        dk = self.desk()

        async def boom(*a, **k):
            raise RuntimeError("chain service down")
        dk.md.option_chain = boom
        c = by_name(self.run_check(dk))
        self.assertEqual(c["engine_b_chain"]["status"], "FAIL")
        self.assertIn("chain service down", c["engine_b_chain"]["detail"])

    def test_kill_dry_run_can_be_skipped(self):
        c = by_name(self.run_check(self.desk(), dry_run_kill=False))
        self.assertEqual(c["dry_run"]["status"], "SKIP")
        self.assertEqual(self.kill_ib.calls, [])

    def test_overall(self):
        mk = lambda s: hc.Check("x", "y", s, "")  # noqa: E731
        self.assertEqual(hc.overall([mk("PASS"), mk("SKIP")]), "PASS")
        self.assertEqual(hc.overall([mk("PASS"), mk("WARN")]), "WARN")
        self.assertEqual(hc.overall([mk("WARN"), mk("FAIL")]), "FAIL")


if __name__ == "__main__":
    unittest.main()
