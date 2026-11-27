"""Section 14.6 / 14.7 (display / analysis only): Engine R's paper track record vs. its backtest,
and Discord / desk rankings that need a real sample (MIN_SCORED) with a 95% Wilson band.

Stdlib only; no network, no TWS. The gateway route is exercised with the bridge GETs stubbed and a
temp TRADING_DATA_DIR, so no live trading data is read or written.
"""

import ast
import asyncio
import json
import math
import os
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest import mock
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "trading"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import backtest as bt  # noqa: E402
import outcomes  # noqa: E402
import track_record as tr  # noqa: E402
from callbook import CallBook  # noqa: E402

NY = ZoneInfo("America/New_York")


def ny(y, m, d, h=15, mi=46):
    return datetime(y, m, d, h, mi, tzinfo=NY).timestamp()


def journal(rs, start=(2026, 9, 1), source="rule_engine"):
    base = ny(*start)
    return [{"source": source, "symbol": "GLD", "openedAt": base + i * 86400, "closedAt": base + i * 86400 + 3 * 86400,
             "entryPrice": 100.0, "exitPrice": 100.0 + r, "rMultiple": r, "exitReason": "x", "pnl": r, "intentId": f"re-{i}"}
            for i, r in enumerate(rs)]


def metrics_for(rs):
    trades = [{"symbol": "SPY", "entryDate": f"2025-01-{i % 28 + 1:02d}", "exitDate": f"2025-02-{i % 28 + 1:02d}", "r": r, "retPct": r}
              for i, r in enumerate(rs)]
    return bt.metrics(trades, 0.25)


def evaluation(test_rs, build_rs=(1.0, -1.0, 2.0, -1.0, 1.5)):
    build, test = metrics_for(list(build_rs)), metrics_for(list(test_rs))
    build.update({"from": "2024-01-02", "to": "2025-06-30"})
    test.update({"from": "2025-07-01", "to": "2026-08-01"})
    return {"at": 1_790_000_000, "version": 3, "params": {"risk_per_trade_pct": 0.25},
            "backtest": {"cutoff": "2025-07-01", "range": {"from": "2024-01-02", "to": "2026-08-31"}, "symbols": ["SPY"], "openAtEnd": 0,
                         "build": build, "test": test}}


def spy_bars():
    """Daily closes 2024-01-01 .. 2026-12-31, +0.05 per calendar day (dates as IBKR's YYYYMMDD)."""
    from datetime import date, timedelta

    d0 = date(2024, 1, 1)
    return [{"date": (d0 + timedelta(days=i)).strftime("%Y%m%d"), "close": 400 + 0.05 * i} for i in range(1096)]


class WilsonRankingTests(unittest.TestCase):
    def test_wilson_matches_known_values(self):
        lo, hi = outcomes.wilson(7, 10)
        self.assertAlmostEqual(lo, 0.3968, places=3)
        self.assertAlmostEqual(hi, 0.8922, places=3)
        self.assertEqual(outcomes.wilson(0, 0), (0.0, 1.0))
        lo, hi = outcomes.wilson(30, 30)
        self.assertLess(lo, 1.0)
        self.assertEqual(hi, 1.0)

    def test_min_scored_is_30_and_small_samples_are_not_ranked(self):
        self.assertEqual(outcomes.MIN_SCORED, 30)
        rows = [{"horizon": 5, "ret": 2.0, "hit": 1, "authorId": "hot", "author": "hot", "channelId": "c", "channel": "c"}] * 29
        rows += [{"horizon": 5, "ret": 0.5, "hit": int(i % 10 < 6), "authorId": "steady", "author": "steady", "channelId": "c", "channel": "c"}
                 for i in range(50)]
        rows += [{"horizon": 5, "ret": 0.5, "hit": int(i % 10 < 8), "authorId": "better", "author": "better", "channelId": "c", "channel": "c"}
                 for i in range(30)]
        lb = outcomes.leaderboard(rows, horizon=5)
        self.assertEqual([r["name"] for r in lb], ["better", "steady", "hot"])  # 29/29 never outranks a 30-call sample
        hot = lb[-1]
        self.assertFalse(hot["ranked"])
        self.assertEqual((hot["calls"], hot["minScored"]), (29, 30))
        for r in lb:
            self.assertLessEqual(r["wilsonLow"], r["hitRate"])
            self.assertGreaterEqual(r["wilsonHigh"], r["hitRate"])
        split = outcomes.rankings(rows, horizon=5)
        self.assertEqual([r["name"] for r in split["ranked"]], ["better", "steady"])
        self.assertEqual([r["name"] for r in split["notEnough"]], ["hot"])

    def test_ranked_order_is_by_wilson_lower_bound(self):
        mk = lambda who, n, h: [{"horizon": 5, "ret": 1.0, "hit": int(i < h), "authorId": who, "author": who,  # noqa: E731
                                 "channelId": "c", "channel": "c"} for i in range(n)]
        # 24/30 = 80% vs 150/200 = 75%: the bigger sample's lower bound is higher, so it ranks first.
        lb = outcomes.leaderboard(mk("small", 30, 24) + mk("big", 200, 150), horizon=5)
        self.assertEqual([r["name"] for r in lb], ["big", "small"])
        self.assertGreater(lb[0]["wilsonLow"], lb[1]["wilsonLow"])

    def test_min_scored_is_configurable(self):
        rows = [{"horizon": 5, "ret": 1.0, "hit": 1, "authorId": "a", "author": "a", "channelId": "c", "channel": "c"}] * 5
        self.assertTrue(outcomes.leaderboard(rows, horizon=5, min_scored=5)[0]["ranked"])
        self.assertFalse(outcomes.leaderboard(rows, horizon=5)[0]["ranked"])

    def test_callbook_flags_unranked_desk_sources(self):
        with tempfile.TemporaryDirectory() as d:
            cb = CallBook(Path(d) / "desk.db")
            ts = int(ny(2026, 10, 1, 11, 0) * 1000)
            cb.add("agent:x", "trading_agent", "GLD", "bullish", ts, baseline=True)

            class MD:
                async def daily_bars(self, sym, days=80):
                    from datetime import date, timedelta
                    return [{"date": (date(2026, 9, 1) + timedelta(days=i)).isoformat(), "close": 100 + i} for i in range(80)]

            asyncio.run(cb.score(MD(), int(ny(2026, 11, 24, 10, 0) * 1000)))
            board = cb.leaderboard(5)
            self.assertEqual({r["id"] for r in board}, {"trading_agent", "baseline_spy"})  # listed (internal record line needs them)
            self.assertTrue(all(r["ranked"] is False for r in board))                     # but never ranked on 1 call
            split = cb.rankings(5)
            self.assertEqual((split["ranked"], len(split["notEnough"]), split["minScored"]), ([], 2, 30))

    def test_callbook_no_longer_ranks_from_one_call(self):
        src = (ROOT / "trading" / "callbook.py").read_text(encoding="utf-8")
        self.assertNotIn("min_calls=1", src)
        self.assertIn("min_scored=outcomes.MIN_SCORED", src)


class TrackRecordTests(unittest.TestCase):
    def test_backtest_metrics_carry_std(self):
        m = metrics_for([1.0, -1.0, 2.0])
        self.assertAlmostEqual(m["stdR"], round(math.sqrt(((1 - 2 / 3) ** 2 + (-1 - 2 / 3) ** 2 + (2 - 2 / 3) ** 2) / 2), 4))
        self.assertIsNone(metrics_for([1.0])["stdR"])

    def test_paper_summary(self):
        rs = [1.0, -1.0, 2.0, -1.0, -1.0, 1.5]
        s = tr.summary(tr.paper_trades(journal(rs) + journal([5.0], source="trading_agent")), 0.25)
        self.assertEqual((s["trades"], s["wins"], s["losses"]), (6, 3, 3))
        self.assertAlmostEqual(s["winRate"], 0.5)
        self.assertAlmostEqual(s["expectancyR"], round(sum(rs) / 6, 4))
        self.assertAlmostEqual(s["avgWinR"], 1.5)
        self.assertAlmostEqual(s["avgLossR"], -1.0)
        self.assertAlmostEqual(s["maxDrawdownR"], 2.0)       # +2 peak, then -1 -1 to 0
        self.assertAlmostEqual(s["pctEquity"], round(1.5 * 0.25, 4))
        self.assertEqual(s["from"], "2026-09-01")

    def test_too_few_paper_trades(self):
        rep = tr.report(evaluation([0.5] * 30 + [-1.0] * 10), journal([1.0] * 19), spy_bars(), now=0)
        self.assertEqual(rep["drift"]["status"], "too_few")
        self.assertIn("too few paper trades to judge", rep["drift"]["message"])
        self.assertTrue(rep["readOnly"])

    def test_drift_flags_outside_the_test_interval(self):
        test_rs = [1.0, -0.5] * 20                                   # mean +0.25R, sd ~0.76
        ev = evaluation(test_rs)
        iv = tr.expectancy_interval(ev["backtest"]["test"])
        self.assertFalse(iv["approx"])
        self.assertLess(iv["low"], 0.25)
        self.assertGreater(iv["high"], 0.25)
        within = tr.report(ev, journal([1.0, -0.5] * 10), spy_bars(), now=0)
        self.assertEqual(within["drift"]["status"], "within")
        below = tr.report(ev, journal([-1.0] * 15 + [1.0] * 5), spy_bars(), now=0)
        self.assertEqual(below["drift"]["status"], "below")
        self.assertIn("DRIFT", below["drift"]["message"])
        above = tr.report(ev, journal([2.0] * 20), spy_bars(), now=0)
        self.assertEqual(above["drift"]["status"], "above")

    def test_interval_approximated_for_old_reports_without_std(self):
        test = dict(evaluation([1.0, -0.5] * 20)["backtest"]["test"])
        exact = tr.expectancy_interval(test)
        test.pop("stdR")
        approx = tr.expectancy_interval(test)
        self.assertTrue(approx["approx"])
        self.assertAlmostEqual(approx["low"], exact["low"], places=3)  # two-valued R: the approximation is exact
        self.assertIn("approximated", tr.drift({"trades": 25, "expectancyR": -2.0}, test)["message"])

    def test_spy_buy_and_hold_same_period(self):
        rep = tr.report(evaluation([0.5] * 10), journal([1.0] * 25), spy_bars(), now=0)
        paper = rep["spy"]["paper"]
        self.assertEqual((paper["from"], paper["buyDate"]), ("2026-09-01", "2026-09-01"))
        self.assertEqual(paper["to"], rep["paper"]["to"])
        self.assertGreater(paper["retPct"], 0)
        self.assertEqual(rep["spy"]["build"]["from"], "2024-01-02")
        self.assertEqual(rep["spy"]["test"]["to"], "2026-08-31")
        self.assertIsNotNone(rep["spy"]["test"]["retPct"])
        late = [b for b in spy_bars() if b["date"] >= "20260901"]
        self.assertIsNone(tr.spy_buy_hold(late, "2025-01-01", "2025-06-01")["retPct"])
        self.assertIsNone(tr.spy_buy_hold([], "2025-01-01", "2025-06-01")["retPct"])
        self.assertIsNone(tr.spy_buy_hold(late, None, None))

    def test_goal_line_is_information_only(self):
        g = tr.report(evaluation([0.5] * 10), journal([1.0, -0.5] * 60), spy_bars(), now=0)["goal"]
        self.assertTrue(g["met"] and g["informationOnly"])
        self.assertIn("100/100", g["text"])
        g2 = tr.goal({"trades": 40, "expectancyR": -0.1})
        self.assertFalse(g2["met"])
        self.assertIn("40/100", g2["text"])
        self.assertIn("not positive", g2["text"])

    def test_no_evaluation_yet(self):
        rep = tr.report({"at": None, "note": "no evaluation yet: POST /engines/r/evaluate"}, journal([1.0] * 3), [], now=0)
        self.assertIsNone(rep["build"])
        self.assertIsNone(rep["test"])
        self.assertIn("no evaluation yet", rep["notes"][0])
        self.assertEqual(rep["paper"]["trades"], 3)

    def test_module_is_stdlib_only_and_never_touches_execution(self):
        tree = ast.parse((ROOT / "trading" / "track_record.py").read_text(encoding="utf-8"))
        mods = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                mods |= {a.name.split(".")[0] for a in node.names}
            elif isinstance(node, ast.ImportFrom) and node.module:
                mods.add(node.module.split(".")[0])
        self.assertLessEqual(mods, {"__future__", "math", "datetime", "typing", "zoneinfo"})
        src = (ROOT / "trading" / "track_record.py").read_text(encoding="utf-8")
        for word in ("open(", "write_text", "submit", "executor", "kill_switch", "set_mode"):
            self.assertNotIn(word, src)


class TrackRecordRouteTests(unittest.TestCase):
    def setUp(self):
        sys.path.insert(0, str(ROOT))
        import trading_api
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        self.api = trading_api
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        cache = Path(self.tmp.name) / "bars_cache"
        cache.mkdir()
        (cache / "SPY.json").write_text(json.dumps({"symbol": "SPY", "bars": spy_bars()}), encoding="utf-8")
        self.calls = []
        ev, jr = evaluation([1.0, -0.5] * 20), journal([1.0, -0.5] * 12)

        def fake_get(path, timeout=3.0):
            self.calls.append(path)
            return ev if path == "/rules/evaluation" else {"trades": jr}

        def no_post(*a, **k):
            raise AssertionError("the track record must never POST to the bridge")

        for p in (mock.patch.object(trading_api, "_bridge_get", fake_get), mock.patch.object(trading_api, "_bridge_post", no_post),
                  mock.patch.dict(os.environ, {"TRADING_DATA_DIR": self.tmp.name})):
            p.start()
            self.addCleanup(p.stop)
        app = FastAPI()
        app.include_router(trading_api.router)
        self.client = TestClient(app, client=("127.0.0.1", 50000))

    def test_route_composes_the_report(self):
        before = sorted(p.name for p in Path(self.tmp.name).rglob("*"))
        r = self.client.get("/api/trading/track-record")
        self.assertEqual(r.status_code, 200, r.text)
        out = r.json()
        self.assertEqual(self.calls, ["/rules/evaluation", "/intel/journal?limit=200"])
        self.assertEqual(out["paper"]["trades"], 24)
        self.assertEqual(out["drift"]["status"], "within")
        self.assertIsNotNone(out["spy"]["paper"]["retPct"])
        self.assertEqual(out["test"]["trades"], 40)
        self.assertTrue(out["goal"]["informationOnly"])
        self.assertEqual(sorted(p.name for p in Path(self.tmp.name).rglob("*")), before)  # wrote nothing

    def test_route_is_get_only_and_503_when_bridge_down(self):
        self.assertEqual(self.client.post("/api/trading/track-record", json={}).status_code, 405)

        def down(*a, **k):
            raise OSError("refused")

        with mock.patch.object(self.api, "_bridge_get", down):
            self.assertEqual(self.client.get("/api/trading/track-record").status_code, 503)


if __name__ == "__main__":
    unittest.main()
