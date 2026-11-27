"""Section 14: every failed / rejected intent carries a structured reason; the bridge's down alert and
down reason; the health card's connection row is the live bridge state. Stdlib only, no TWS."""

import asyncio
import json
import sqlite3
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "trading"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import failures  # noqa: E402
import healthcheck as hc  # noqa: E402
import ibkr_bridge  # noqa: E402
from desk import Desk  # noqa: E402
from executor import ExecutionRefused  # noqa: E402
from test_trading_desk import NOW, FakeBridge, FakeExecutor, good_quote, good_stats, raw_intent  # noqa: E402

NY = ZoneInfo("America/New_York")


def ny(y, mo, d, h=12, mi=0):
    return datetime(y, mo, d, h, mi, tzinfo=NY).timestamp()


class FailingExecutor(FakeExecutor):
    def __init__(self, exc):
        super().__init__()
        self.exc = exc

    async def place(self, intent, qty):
        raise self.exc


class ClassifyTests(unittest.TestCase):
    def test_error_texts(self):
        cases = {
            "ExecutionRefused: TWS rejected the order: API is in Read-Only mode": "rejected_by_ibkr",
            "ExecutionRefused: TWS didn't acknowledge the order within 15s; cancelled": "rejected_by_ibkr",
            "ConnectionRefusedError: [WinError 1225] The remote computer refused the network connection": "bridge_down",
            "ExecutionRefused: endpoint LOCKED: LIVE": "bridge_down",
            "ExecutionRefused: trading is LOCKED by the kill switch": "kill_switch",
            "autonomous trading halted": "kill_switch",
            "schema: quantity must be > 0": "schema",
            "pretrade: max_shares": "risk_limit",
            "something odd": "other",
        }
        for err, code in cases.items():
            self.assertEqual(failures.from_error(err)["code"], code, err)

    def test_checks_priority(self):
        chk = lambda n, d="x": {"name": n, "ok": False, "detail": d}  # noqa: E731
        self.assertEqual(failures.from_checks([chk("cooldown"), chk("kill_switch")])["code"], "kill_switch")
        self.assertEqual(failures.from_checks([chk("port_mode", "connected=False")])["code"], "bridge_down")
        self.assertEqual(failures.from_checks([chk("market_hours", "market closed: holiday (Thanksgiving)")])["code"], "market_closed")
        self.assertEqual(failures.from_checks([chk("liquidity", "no usable two-sided quote (bid=None, ask=None)")])["code"], "no_quote")
        self.assertEqual(failures.from_checks([chk("gross_exposure"), chk("position_size")])["code"], "risk_limit")
        self.assertEqual(failures.from_checks([chk("signal_provenance")])["code"], "policy")
        self.assertIsNone(failures.from_checks([{"name": "a", "ok": True, "detail": ""}]))

    def test_old_rows_stay_readable(self):
        # failed row from before failures existed: {"error": "Type: msg"}
        f = failures.classify("failed", {"error": "ExecutionRefused: TWS rejected the order: 201"}, {"checks": []})
        self.assertEqual((f["code"], f["label"]), ("rejected_by_ibkr", "Rejected by IBKR"))
        self.assertIn("201", f["detail"])
        # rejected row with only the decision stored
        f = failures.classify("rejected", None, {"checks": [{"name": "market_hours", "ok": False, "detail": "outside regular trading hours"}]})
        self.assertEqual(f["code"], "market_closed")
        # approval re-check / pretrade shapes
        self.assertEqual(failures.classify("rejected", {"recheck": {"checks": [{"name": "kill_switch", "ok": False, "detail": "LOCKED"}]}}, None)["code"], "kill_switch")
        self.assertEqual(failures.classify("rejected", {"pretrade": {"failed": ["rate_limit"]}}, None)["detail"], "pretrade: rate_limit")
        self.assertEqual(failures.classify("rejected", {"pretrade": "pretrade: bad policy"}, None)["code"], "risk_limit")
        self.assertEqual(failures.classify("failed", None, None)["code"], "other")
        self.assertIsNone(failures.classify("submitted", {"orders": []}, None))


class DeskFailureTests(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.d = Path(self.td.name)

    def tearDown(self):
        self.td.cleanup()

    def desk(self, executor=None, bridge=None, quote=good_quote, clock=lambda: NOW):
        return Desk(bridge or FakeBridge(), executor=executor or FakeExecutor(), quote_fn=quote, stats_fn=good_stats,
                    fx_source=False, d=self.d, clock=clock, pretrade=False)

    def test_tws_rejection_is_stored_and_returned(self):
        dk = self.desk(FailingExecutor(ExecutionRefused("TWS rejected the order: API is in Read-Only mode (321)")))
        dk.set_mode("FULL_AUTO", "t", confirm=True)
        r = asyncio.run(dk.submit(raw_intent(), "t"))
        self.assertEqual(r["status"], "failed")
        self.assertEqual(r["failure"]["code"], "rejected_by_ibkr")
        row = dk._row("intent-0001")
        self.assertEqual(row["failure"]["code"], "rejected_by_ibkr")
        self.assertIn("Read-Only", row["failure"]["detail"])
        self.assertEqual(row["result"]["failure"]["code"], "rejected_by_ibkr")  # stored with the intent
        tail = [a for a in dk.audit.tail(10) if a["kind"] == "order_failed"]
        self.assertEqual(tail[0]["payload"]["failure"]["code"], "rejected_by_ibkr")

    def test_connection_refused_is_bridge_down(self):
        dk = self.desk(FailingExecutor(ConnectionRefusedError(1225, "The remote computer refused the network connection")))
        dk.set_mode("FULL_AUTO", "t", confirm=True)
        self.assertEqual(asyncio.run(dk.submit(raw_intent(), "t"))["failure"]["code"], "bridge_down")

    def test_gate_rejections_carry_a_reason(self):
        dk = self.desk(bridge=FakeBridge(state="RECONNECTING"))
        r = asyncio.run(dk.submit(raw_intent(), "t"))
        self.assertEqual(r["failure"]["code"], "bridge_down")
        self.assertEqual(dk._row("intent-0001")["failure"]["code"], "bridge_down")

    def test_holiday_is_market_closed(self):
        dk = self.desk(clock=lambda: ny(2026, 11, 26, 11, 0))  # Thanksgiving; the quote fn even claims the session is open
        r = asyncio.run(dk.submit(raw_intent(), "t"))
        self.assertEqual(r["status"], "rejected")
        self.assertEqual(r["failure"]["code"], "market_closed")
        self.assertIn("Thanksgiving", r["failure"]["detail"])

    def test_schema_and_halt(self):
        dk = self.desk()
        self.assertEqual(asyncio.run(dk.submit({"intent_id": "x"}, "t"))["failure"]["code"], "schema")
        dk.set_mode("FULL_AUTO", "t", confirm=True)
        dk._save_state(agentHalted=True)
        r = asyncio.run(dk.submit(raw_intent(source="rule_engine"), "t"))
        self.assertEqual(r["failure"]["code"], "kill_switch")

    def test_legacy_row_without_failure_is_derived(self):
        dk = self.desk()
        c = sqlite3.connect(self.d / "desk.db")
        with c:
            c.execute("INSERT INTO intents VALUES (?,?,?,?,?,?,?,?,?,?)",
                      ("old-000001", "failed", "SPY", "BUY", 1, json.dumps(raw_intent(intent_id="old-000001")),
                       json.dumps({"verdict": "APPROVED", "checks": []}), json.dumps({"error": "ExecutionRefused: TWS rejected the order: 110"}), NOW, NOW))
        c.close()
        row = dk._row("old-000001")
        self.assertEqual(row["failure"]["code"], "rejected_by_ibkr")
        self.assertIn(row["intentId"], [r["intentId"] for r in dk.view()["recent"]])


class BridgeAlertTests(unittest.TestCase):
    def bridge(self, t):
        box = {"t": t}
        b = ibkr_bridge.Bridge(config_loader=lambda: None, clock=lambda: box["t"])
        return b, box

    def test_down_since_and_reason(self):
        b, box = self.bridge(ny(2026, 11, 24, 10, 0))
        self.assertIsNotNone(b.state["downSince"])
        b._set(state="RECONNECTING", lastError="ConnectionRefusedError: [WinError 1225] refused", port=7497)
        snap = b.snapshot()
        self.assertIn("Enable ActiveX and Socket Clients", snap["downReason"])
        self.assertIn("7497", snap["downReason"])
        box["t"] += 30
        b._set(state="CONNECTED")
        self.assertIsNone(b.state["downSince"])
        self.assertIsNone(b.snapshot()["downReason"])

    def test_alert_after_two_minutes_in_market_hours_only(self):
        start = ny(2026, 11, 24, 10, 0)
        b, box = self.bridge(start)
        b._set(state="RECONNECTING", lastError="ConnectionRefusedError: refused")
        box["t"] = start + 60
        self.assertIsNone(b.snapshot()["alert"])
        box["t"] = start + 125
        alert = b.snapshot()["alert"]
        self.assertEqual(alert["code"], "bridge_down")
        self.assertEqual(alert["since"], start)
        self.assertIn("refused", alert["reason"])
        # down overnight: counts from 09:30, so the alert fires at 09:32, not at 09:30
        b2, box2 = self.bridge(ny(2026, 11, 24, 6, 0))
        box2["t"] = ny(2026, 11, 24, 9, 31)
        self.assertIsNone(b2.snapshot()["alert"])
        box2["t"] = ny(2026, 11, 24, 9, 33)
        self.assertIsNotNone(b2.snapshot()["alert"])
        # never on a holiday, a weekend, or after the close
        for t in (ny(2026, 11, 26, 11, 0), ny(2026, 11, 28, 11, 0), ny(2026, 11, 24, 17, 0), ny(2026, 11, 27, 14, 0)):
            b3, _ = self.bridge(t - 3600)
            b3._clock = lambda t=t: t
            self.assertIsNone(b3.snapshot()["alert"], t)

    def test_locked_counts_as_down(self):
        b, box = self.bridge(ny(2026, 11, 24, 10, 0))
        b._set(state="LOCKED", reasons=["LIVE requested"])
        box["t"] += 300
        snap = b.snapshot()
        self.assertTrue(snap["downReason"].startswith("endpoint LOCKED"))
        self.assertIsNotNone(snap["alert"])

    def test_auto_reconnect_backs_off_2_to_60_s(self):
        from test_trading_bridge import FakeIB, cfg

        b = ibkr_bridge.Bridge(config_loader=cfg, ib_factory=lambda: FakeIB(fail=True))
        waits = []

        async def fake_sleep(s):
            waits.append(s)
            if len(waits) >= 8:
                b.stop()

        b._sleep = fake_sleep
        asyncio.run(b.run())
        self.assertEqual(waits, [2.0, 4.0, 8.0, 16.0, 32.0, 60.0, 60.0, 60.0])
        self.assertEqual(b.state["state"], "DISCONNECTED")  # stopped; until then it kept retrying

    def test_snapshot_has_market(self):
        b, _ = self.bridge(ny(2026, 11, 26, 11, 0))
        self.assertEqual(b.snapshot()["market"]["label"], "Market closed: holiday (Thanksgiving)")


class HealthLiveTests(unittest.TestCase):
    def stored(self, bridge_status):
        return {"at": NOW, "atNy": "x", "overall": "FAIL" if bridge_status == "FAIL" else "PASS",
                "checks": [{"stage": "safety", "name": "paper_lock", "status": "PASS", "detail": "", "ms": 1},
                           {"stage": "broker", "name": "bridge", "status": bridge_status, "detail": "old", "ms": 0},
                           {"stage": "data", "name": "daily_bars", "status": "SKIP", "detail": "needs TWS", "ms": 0}]}

    def live(self, **over):
        s = {"state": "CONNECTED", "updatedAt": NOW, "clientId": 11, "readOnly": True, "connectedSince": NOW - 300,
             "account": {"account": "DU1234567", "netLiquidation": 1.0}}
        s.update(over)
        return s

    def test_live_row_replaces_a_stale_fail(self):
        r = hc.with_live_bridge(self.stored("FAIL"), self.live(), NOW)
        row = [c for c in r["checks"] if c["name"] == "bridge"][0]
        self.assertEqual((row["status"], row["live"]), ("PASS", True))
        self.assertEqual([c["name"] for c in r["checks"]], ["paper_lock", "bridge", "daily_bars"])
        self.assertEqual(r["overall"], "PASS")
        self.assertTrue(r["stale"])
        self.assertIn("run the check again", r["staleReason"])

    def test_live_down_overrides_a_stored_pass(self):
        r = hc.with_live_bridge(self.stored("PASS"), self.live(state="RECONNECTING", downReason="TWS API not reachable"), NOW)
        self.assertEqual(r["overall"], "FAIL")
        self.assertIn("TWS API not reachable", [c for c in r["checks"] if c["name"] == "bridge"][0]["detail"])

    def test_agreement_is_not_stale(self):
        self.assertFalse(hc.with_live_bridge(self.stored("PASS"), self.live(), NOW)["stale"])

    def test_last_result_overlays_when_given_live(self):
        with tempfile.TemporaryDirectory() as td:
            d = Path(td)
            (d / "healthcheck").mkdir()
            (d / "healthcheck" / "latest.json").write_text(json.dumps(self.stored("FAIL")), encoding="utf-8")
            self.assertEqual(hc.last_result(d)["overall"], "FAIL")  # raw, for the agent / CLI
            self.assertEqual(hc.last_result(d, live=self.live(), now=NOW)["overall"], "PASS")

    def test_rerun_due(self):
        stored = self.stored("FAIL")
        self.assertTrue(hc.rerun_due(stored, self.live(), NOW, 0.0))
        self.assertFalse(hc.rerun_due(stored, self.live(connectedSince=NOW - 10), NOW, 0.0))  # not stable yet
        self.assertFalse(hc.rerun_due(stored, self.live(), NOW, NOW - 60))                   # re-ran a minute ago
        self.assertFalse(hc.rerun_due(self.stored("PASS"), self.live(), NOW, 0.0))            # already agrees
        self.assertFalse(hc.rerun_due(None, self.live(), NOW, 0.0))


if __name__ == "__main__":
    unittest.main()
