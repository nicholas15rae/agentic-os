"""desk.submit / desk.approve run the deterministic pre-trade gates (trading/pretrade.py) right before execution."""

import asyncio
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "trading"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from desk import Desk  # noqa: E402
from ledger import Ledger  # noqa: E402
from test_trading_desk import NOW, FakeBridge, FakeExecutor, good_stats, raw_intent  # noqa: E402


def quote_fn(age_s=1.0, with_time=True):
    async def q(_intent):
        return {"bid": 499.95, "ask": 500.05, "last": 500.0, "time": (time.time() - age_s) if with_time else None}, True

    return q


class DeskPretradeTests(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.d = Path(self.td.name)
        self.ex = FakeExecutor()

    def tearDown(self):
        self.td.cleanup()

    def desk(self, q=None, **bridge):
        return Desk(FakeBridge(updatedAt=time.time(), **bridge), executor=self.ex, quote_fn=q or quote_fn(), stats_fn=good_stats,
                    fx_source=False, d=self.d, clock=lambda: NOW)

    def submit(self, dk, **over):
        return asyncio.run(dk.submit(raw_intent(**over), "test"))

    def test_full_auto_passes_the_gate_and_logs_it(self):
        dk = self.desk()
        dk.set_mode("FULL_AUTO", "t", confirm=True)
        r = self.submit(dk)
        self.assertEqual(r["status"], "submitted", r)
        rows = [x for x in Ledger(self.d / "ledger.jsonl").read() if x["kind"] == "pretrade_check"]
        self.assertEqual([x["verdict"] for x in rows], ["PASS"])
        self.assertTrue((self.d / "risk-policy.json").exists())

    def test_stale_or_untimed_quote_is_refused_before_tws(self):
        for q in (quote_fn(age_s=120), quote_fn(with_time=False)):
            dk = self.desk(q)
            dk.set_mode("FULL_AUTO", "t", confirm=True)
            r = self.submit(dk, intent_id=f"intent-{id(q)}")
            self.assertEqual(r["status"], "rejected")
            self.assertIn("stale_quote", r["error"])
        self.assertEqual(self.ex.placed, [])

    def test_symbol_outside_the_allowlist_is_refused(self):
        dk = self.desk()
        dk.set_mode("FULL_AUTO", "t", confirm=True)
        r = self.submit(dk, source="manual", symbol="DBC")
        self.assertEqual(r["status"], "rejected")
        self.assertIn("allowlist", r["error"])
        self.assertEqual(self.ex.placed, [])

    def test_missing_take_profit_is_refused(self):
        dk = self.desk()
        dk.set_mode("FULL_AUTO", "t", confirm=True)
        r = self.submit(dk, take_profit=None)
        self.assertIn("bracket", r.get("error", ""))
        self.assertEqual(self.ex.placed, [])

    def test_semi_auto_approval_is_gated_at_send_time(self):
        dk = self.desk()
        dk.set_mode("SEMI_AUTO", "t", confirm=True)
        self.assertEqual(self.submit(dk)["status"], "pending_approval")
        dk._quote = quote_fn(age_s=300)  # by the time the human approves, the quote is stale
        r = asyncio.run(dk.approve("intent-0001", "t"))
        self.assertEqual(r["status"], "rejected")
        self.assertEqual(self.ex.placed, [])
        self.assertEqual(dk._row("intent-0001")["status"], "rejected")

    def test_invalid_policy_fails_closed(self):
        (self.d / "risk-policy.json").write_text(json.dumps({"dead_mans_switch": {"grace_s": 5}}), encoding="utf-8")
        dk = self.desk()
        dk.set_mode("FULL_AUTO", "t", confirm=True)
        r = self.submit(dk)
        self.assertEqual(r["status"], "rejected")
        self.assertIn("pretrade", r["error"])
        self.assertEqual(self.ex.placed, [])


if __name__ == "__main__":
    unittest.main()
