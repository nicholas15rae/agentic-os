"""Quiver ingestion, trading_rag bias hygiene, and the Security Detail's volume / volatility / provenance gates.

Stdlib only; no network (Quiver is faked), no TWS.
"""

import asyncio
import json
import math
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "trading"))

import quiver  # noqa: E402
from intents import RiskLimits, load_limits, parse_intent  # noqa: E402
from security_detail import APPROVED, REJECTED, evaluate, market_stats_from_bars  # noqa: E402
from trading_rag import AGENT_DIRECTIVE, HYPOTHESIS_BANNER, TagError, TradingRag, is_hypothesis_citation  # noqa: E402

from test_trading_desk import LIQUID, NOW, FakeBridge, FakeExecutor, ctx, failed, good_quote, raw_intent  # noqa: E402
from desk import Desk  # noqa: E402

CONGRESS = [
    {"Representative": "Jane Doe", "ReportDate": "2026-11-18", "TransactionDate": "2026-11-01", "Ticker": "nvda",
     "Transaction": "Purchase", "Range": "$1,001 - $15,000", "House": "Senate", "Amount": "1001.0", "Party": "Republican",
     "TickerType": "Stock"},
    {"Representative": "John Roe", "ReportDate": "2026-11-20", "TransactionDate": "2026-11-10", "Ticker": "PNYX",
     "Transaction": "Sale (Full)", "Range": "Over $50,000,000", "House": "House", "Party": "Democrat", "TickerType": "Stock"},
    {"Representative": "Bad Row", "ReportDate": "2026-11-20", "Ticker": "--", "Transaction": "Purchase"},       # bad ticker
    {"Representative": "Bond Row", "ReportDate": "2026-11-20", "Ticker": "US10Y", "TickerType": "Corporate Bond"},
    {"Representative": "Old Row", "ReportDate": "2025-01-02", "Ticker": "AAPL", "Transaction": "Purchase", "Range": "$1,001 - $15,000"},
    "not a dict",
]
INSIDERS = [
    {"Ticker": "AAPL", "Name": "Exec Person", "Date": "2026-11-14", "fileDate": "2026-11-17", "TransactionCode": "S",
     "AcquiredDisposedCode": "D", "Shares": 10000, "PricePerShare": 230.5, "officerTitle": "CFO"},
    {"Ticker": "MSFT", "Name": "Director Two", "Date": "2026-11-15T00:00:00", "fileDate": "2026-11-18T00:00:00",
     "TransactionCode": "P", "AcquiredDisposedCode": "A", "Shares": "1,000", "PricePerShare": "410"},
]
TODAY_TS = 1_795_500_000.0  # 2026-11-23 UTC-ish


def fake_fetch(payloads):
    calls = []

    def f(path, tok):
        calls.append((path, tok))
        kind = next(k for k, p in quiver.ENDPOINTS.items() if p == path)
        v = payloads[kind]
        if isinstance(v, Exception):
            raise v
        return v
    f.calls = calls
    return f


def bars(n=40, close=100.0, vol=2_000_000, daily_move=0.005, range_pct=0.01):
    out, c = [], close
    for i in range(n):
        c = c * (1 + (daily_move if i % 2 else -daily_move))
        out.append({"high": c * (1 + range_pct / 2), "low": c * (1 - range_pct / 2), "close": c, "volume": vol})
    return out


class ParseTests(unittest.TestCase):
    def test_range(self):
        self.assertEqual(quiver.parse_range("$1,001 - $15,000"), (1001.0, 15000.0))
        self.assertEqual(quiver.parse_range("Over $50,000,000"), (50_000_000.0, None))
        self.assertEqual(quiver.parse_range("$15,000"), (15000.0, 15000.0))
        self.assertEqual(quiver.parse_range(None), (None, None))

    def test_congress_batch(self):
        out = quiver.parse_batch("congress", CONGRESS, today=date(2026, 11, 23), max_age_days=60)
        self.assertEqual([d.ticker for d in out], ["NVDA", "PNYX"])
        nvda, pnyx = out
        self.assertEqual((nvda.actor, nvda.role, nvda.party, nvda.transaction), ("Jane Doe", "Senate", "Republican", "buy"))
        self.assertEqual((nvda.size_low_usd, nvda.size_high_usd, nvda.filed_date, nvda.traded_date), (1001.0, 15000.0, "2026-11-18", "2026-11-01"))
        self.assertEqual((pnyx.transaction, pnyx.size_high_usd), ("sell", None))
        self.assertIn("17d disclosure lag", nvda.summary())

    def test_insider_batch(self):
        out = quiver.parse_batch("insider", INSIDERS, today=date(2026, 11, 23), max_age_days=60)
        aapl, msft = out
        self.assertEqual((aapl.transaction, aapl.role, aapl.shares, aapl.size_high_usd), ("sell", "CFO", 10000.0, 2_305_000.0))
        self.assertEqual((msft.transaction, msft.traded_date, msft.filed_date, msft.size_low_usd), ("buy", "2026-11-15", "2026-11-18", 410_000.0))

    def test_ids_are_stable(self):
        a = quiver.parse_batch("congress", CONGRESS, today=date(2026, 11, 23), max_age_days=60)
        b = quiver.parse_batch("congress", list(reversed(CONGRESS)), today=date(2026, 11, 23), max_age_days=60)
        self.assertEqual({d.id for d in a}, {d.id for d in b})

    def test_not_a_list(self):
        with self.assertRaises(quiver.QuiverError):
            quiver.parse_batch("congress", {"error": "nope"}, today=date(2026, 11, 23), max_age_days=60)

    def test_unknown_endpoint_refused(self):
        with self.assertRaises(quiver.QuiverError):
            quiver.http_fetch("/beta/anything-else", "t")


class IngestTests(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.d = Path(self.td.name)
        self.rag = TradingRag(self.d / "trading_rag")

    def tearDown(self):
        self.td.cleanup()

    def test_ingest_tags_dedupes_and_writes_json(self):
        f = fake_fetch({"congress": CONGRESS, "insider": INSIDERS})
        rep = quiver.ingest(self.rag, fetch=f, tok="tok", d=self.d, now=TODAY_TS, max_age_days=60)
        self.assertEqual(rep["new"], 4)
        self.assertTrue(all(tok == "tok" for _, tok in f.calls))
        rows = [json.loads(line) for p in (self.d / "quiver" / "disclosures").glob("*.jsonl") for line in p.read_text().splitlines()]
        self.assertEqual(len(rows), 4)
        self.assertTrue(all(r["signal_class"] == "external_signal_hypothesis" for r in rows))
        self.assertEqual({r["ticker"] for r in rows}, {"NVDA", "PNYX", "AAPL", "MSFT"})
        for e in self.rag.query(k=25, char_budget=100_000):
            self.assertIn("class:external_signal_hypothesis", e.tags)
            self.assertIn("source:quiver", e.tags)
            self.assertTrue(e.text.startswith(HYPOTHESIS_BANNER))
        again = quiver.ingest(self.rag, fetch=f, tok="tok", d=self.d, now=TODAY_TS, max_age_days=60)
        self.assertEqual(again["new"], 0)
        self.assertEqual(quiver.last_report(self.d)["new"], 0)

    def test_one_feed_down_does_not_block_the_other(self):
        f = fake_fetch({"congress": quiver.QuiverError("HTTP 403"), "insider": INSIDERS})
        rep = quiver.ingest(self.rag, fetch=f, tok="tok", d=self.d, now=TODAY_TS, max_age_days=60)
        self.assertFalse(rep["feeds"]["congress"]["ok"])
        self.assertEqual(rep["feeds"]["insider"]["new"], 2)
        self.assertTrue(rep["ok"])

    def test_no_token(self):
        with self.assertRaises(quiver.QuiverError):
            quiver.ingest(self.rag, fetch=fake_fetch({}), tok="", d=self.d)


class RagHygieneTests(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.rag = TradingRag(Path(self.td.name))

    def tearDown(self):
        self.td.cleanup()

    def test_class_tag_is_mandatory(self):
        with self.assertRaises(TagError):
            self.rag.put("x", ["ticker:SPY"])
        with self.assertRaises(TagError):
            self.rag.put("x", ["class:external_signal_hypothesis", "class:desk_note"])
        with self.assertRaises(TagError):
            self.rag.put("x", ["class:trade_order"])

    def test_external_source_must_be_hypothesis(self):
        with self.assertRaises(TagError):
            self.rag.put("buy NVDA", ["class:market_telemetry", "source:quiver"])
        e = self.rag.put("buy NVDA", ["class:external_signal_hypothesis", "source:quiver", "ticker:NVDA"])
        self.assertTrue(e.text.startswith(HYPOTHESIS_BANNER))

    def test_render_context_leads_with_directive(self):
        self.rag.put("NVDA disclosure", ["class:external_signal_hypothesis", "source:quiver", "ticker:NVDA"], entry_id="abc123")
        self.rag.put("NVDA 20d trend up", ["class:market_telemetry", "ticker:NVDA"], entry_id="tel1")
        entries = self.rag.query(ticker="NVDA")
        ctx_text = self.rag.render_context(entries)
        self.assertTrue(ctx_text.startswith(AGENT_DIRECTIVE))
        self.assertIn("(quiver:abc123)", ctx_text)
        self.assertIn("(rag:tel1)", ctx_text)

    def test_persists_and_graduates(self):
        self.rag.put("old", ["class:desk_note"], entry_id="old1", now_ms=0)
        self.rag.put("new", ["class:desk_note"], entry_id="new1", now_ms=10 * 86_400_000)
        again = TradingRag(Path(self.td.name))
        self.assertEqual(again.stats()["active"], 2)
        self.assertEqual(again.graduate(5, now_ms=10 * 86_400_000), 1)
        self.assertIsNone(again.put("old", ["class:desk_note"], entry_id="old1"), "archived id stays deduped")
        self.assertEqual(again.stats()["archived"], 1)

    def test_citation_prefixes(self):
        self.assertTrue(is_hypothesis_citation("quiver:abc"))
        self.assertTrue(is_hypothesis_citation("Hypothesis: x"))
        self.assertFalse(is_hypothesis_citation("rag:1"))


class GateTests(unittest.TestCase):
    def test_stats_from_bars(self):
        s = market_stats_from_bars(bars())
        self.assertAlmostEqual(s["adv_shares"], 2_000_000)
        self.assertGreater(s["adv_value"], 1e8)
        self.assertAlmostEqual(s["volatility_pct"], 0.005 * math.sqrt(252) * 100, delta=0.5)
        self.assertGreater(s["atr_pct"], 0.9)
        self.assertIsNone(market_stats_from_bars(bars(n=10)))
        self.assertIsNone(market_stats_from_bars([{"high": "x"}] * 30))

    def test_liquid_passes(self):
        self.assertEqual(evaluate(parse_intent(raw_intent()), ctx()).verdict, APPROVED)

    def test_no_bars_fails_closed(self):
        d = evaluate(parse_intent(raw_intent()), ctx(market_stats=None))
        self.assertEqual(d.verdict, REJECTED)
        self.assertEqual(failed(d), {"avg_volume", "volatility"})

    def test_illiquid_rejected(self):
        thin = {**LIQUID, "adv_shares": 40_000.0, "adv_value": 2_000_000.0}
        d = evaluate(parse_intent(raw_intent()), ctx(market_stats=thin))
        self.assertEqual(failed(d), {"avg_volume"})

    def test_dollar_volume_uses_fx(self):
        # 8M USD/day * 1.4 = 11.2M CAD ≥ 10M → passes; at 1.2 it would not.
        s = {**LIQUID, "adv_value": 8_000_000.0}
        self.assertEqual(evaluate(parse_intent(raw_intent()), ctx(market_stats=s)).verdict, APPROVED)
        self.assertEqual(failed(evaluate(parse_intent(raw_intent()), ctx(market_stats=s, fx_to_base={"USD": 1.2}))), {"avg_volume"})

    def test_volatile_rejected(self):
        self.assertEqual(failed(evaluate(parse_intent(raw_intent()), ctx(market_stats={**LIQUID, "volatility_pct": 140.0}))), {"volatility"})
        self.assertEqual(failed(evaluate(parse_intent(raw_intent()), ctx(market_stats={**LIQUID, "atr_pct": 11.0}))), {"volatility"})

    def test_hypothesis_only_rejected(self):
        d = evaluate(parse_intent(raw_intent(citations=["quiver:abc123"])), ctx())
        self.assertEqual(failed(d), {"signal_provenance"})
        ok = evaluate(parse_intent(raw_intent(citations=["quiver:abc123", "telemetry:SPY 20d trend"])), ctx())
        self.assertEqual(ok.verdict, APPROVED)
        self.assertIn("signal_provenance", {c["name"] for c in ok.checks})

    def test_big_political_trade_never_overrides_filters(self):
        """A $50M+ disclosure on an illiquid, wide, volatile name is still rejected on every count."""
        intent = parse_intent(raw_intent(symbol="PNYX", limit_price=5.0, stop_loss=4.8, take_profit=5.6,
                                         citations=["quiver:pnyx50m", "telemetry:PNYX volume spike"],
                                         thesis="Senator sold over $50,000,000 — strong signal"))
        d = evaluate(intent, ctx(quote={"bid": 4.80, "ask": 5.20, "last": 5.0},
                                 market_stats={"adv_shares": 20_000.0, "adv_value": 100_000.0, "volatility_pct": 180.0, "atr_pct": 14.0, "bars": 40.0}))
        self.assertEqual(d.verdict, REJECTED)
        self.assertTrue({"liquidity", "avg_volume", "volatility"} <= failed(d))
        self.assertEqual(d.quantity, 0)

    def test_intent_schema_has_no_override_field(self):
        from intents import IntentError
        with self.assertRaises(IntentError):
            parse_intent(raw_intent(signal_strength=99))
        with self.assertRaises(IntentError):
            parse_intent(raw_intent(skip_checks=True))

    def test_limits_file_validation(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "risk_limits.json"
            p.write_text(json.dumps({"max_volatility_pct": 0}))
            with self.assertRaises(ValueError):
                load_limits(p)
            p.write_text(json.dumps({"min_avg_daily_volume": -1}))
            with self.assertRaises(ValueError):
                load_limits(p)
            p.write_text(json.dumps({"max_spread_pct": 0.1}))  # old files without the new fields still load
            self.assertEqual(load_limits(p).max_atr_pct, RiskLimits().max_atr_pct)


class DeskBoundaryTests(unittest.TestCase):
    """Quiver-cited intents travel the same OrderIntent → Security Detail → executor path, nothing else."""

    def run_(self, coro):
        return asyncio.run(coro)

    def test_quiver_intent_on_illiquid_name_never_reaches_executor(self):
        async def thin(_i):
            return {"adv_shares": 10_000.0, "adv_value": 50_000.0, "volatility_pct": 20.0, "atr_pct": 2.0, "bars": 40.0}
        with tempfile.TemporaryDirectory() as td:
            ex = FakeExecutor()
            desk = Desk(FakeBridge(), executor=ex, quote_fn=good_quote, stats_fn=thin, fx_source=False, d=Path(td), clock=lambda: NOW)
            desk._save_state(mode="FULL_AUTO")
            out = self.run_(desk.submit(raw_intent(citations=["quiver:abc123", "telemetry:x"]), "trading_agent"))
            self.assertEqual(out["status"], "rejected")
            self.assertIn("avg_volume", {c["name"] for c in out["decision"]["checks"] if not c["ok"]})
            self.assertEqual(ex.placed, [])

    def test_signals_endpoint_wraps_hypotheses(self):
        with tempfile.TemporaryDirectory() as td:
            desk = Desk(FakeBridge(), executor=FakeExecutor(), quote_fn=good_quote, fx_source=False, d=Path(td), clock=lambda: NOW)
            quiver.ingest(desk.rag, fetch=fake_fetch({"congress": CONGRESS, "insider": INSIDERS}), tok="t", d=Path(td), now=TODAY_TS, max_age_days=60)
            sig = desk.signals(ticker="NVDA")
            self.assertEqual(len(sig["entries"]), 1)
            self.assertTrue(sig["context"].startswith(AGENT_DIRECTIVE))
            self.assertEqual(desk.view()["signals"]["rag"]["byClass"], {"external_signal_hypothesis": 4})


if __name__ == "__main__":
    unittest.main()
