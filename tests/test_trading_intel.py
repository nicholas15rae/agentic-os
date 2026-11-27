"""Phase 4: Discord ETL (export + API formats), dedup, extraction, trading_rag bias hygiene,
live poller, outcome scoring + leaderboard, trade journal + Financer roll-up.

Stdlib only; no network, no TWS. Fixtures follow DiscordChatExporter's JSON / CSV shapes
and the Discord REST message object.
"""

import asyncio
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "trading"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import discord_ingest as di  # noqa: E402
import discord_live  # noqa: E402
import journal as jr  # noqa: E402
import outcomes  # noqa: E402
from desk import Desk  # noqa: E402
from test_trading_desk import FakeBridge, FakeExecutor, good_quote, good_stats  # noqa: E402
from test_trading_engines import FakeMD  # noqa: E402
from trading_rag import TagError, TradingRag, is_hypothesis_citation, validate_tags  # noqa: E402

CH = "111111111111111111"
CH2 = "222222222222222222"


def msg(i, content, author="42", name="trader_joe", ts="2026-10-01T14:30:00.1234567+00:00", bot=False, kind="Default", attach=0):
    return {"id": str(9000 + i), "type": kind, "timestamp": ts, "content": content,
            "author": {"id": author, "name": name, "nickname": None, "isBot": bot},
            "attachments": [{"url": "x"}] * attach, "stickers": [], "embeds": [], "reactions": []}


def export(messages, ch=CH, name="options-flow"):
    return {"guild": {"id": "777", "name": "Alpha Traders"}, "channel": {"id": ch, "name": name, "category": "Trading"},
            "messages": messages, "messageCount": len(messages)}


class ExtractTests(unittest.TestCase):
    def test_option_call(self):
        x = di.extract("$SPY 580c 12/20 looking for a breakout above 575, PT 590 stop 570. CPI tomorrow")
        self.assertEqual(x.tickers, ["SPY"])
        self.assertEqual((x.asset_class, x.direction), ("option", "bullish"))
        self.assertEqual(x.strikes[0], {"ticker": "SPY", "strike": 580.0, "right": "C"})
        self.assertIn("12/20", x.expiries)
        self.assertIn({"kind": "pt", "price": 590.0}, x.levels)
        self.assertIn("CPI", x.catalysts)

    def test_bearish_commodity_and_index_alias(self):
        x = di.extract("GLD rejected at resistance 240, puts into FOMC. SPX weak too")
        self.assertEqual(x.direction, "bearish")
        self.assertEqual(x.tickers[:2], ["GLD", "SPY"])  # SPX → SPY proxy
        self.assertEqual(x.asset_class, "commodity")
        self.assertIn("FOMC", x.catalysts)

    def test_ambiguous_words_need_a_dollar(self):
        self.assertEqual(di.extract("it is ALL about the open, F this market").tickers, [])
        self.assertEqual(di.extract("loading $F calls").tickers, ["F"])

    def test_no_direction_is_not_a_call(self):
        x = di.extract("what do you all think about QQQ here?")
        self.assertEqual(x.tickers, ["QQQ"])
        self.assertFalse(x.is_call)

    def test_noise(self):
        m = di.RawMessage("1", CH, "42", "a", 0, "")
        self.assertEqual(di.is_noise(m, ""), "empty")
        self.assertEqual(di.is_noise(di.RawMessage("1", CH, "42", "a", 0, "", attachments=1), ""), "attachment-only")
        self.assertEqual(di.is_noise(m, "https://tenor.com/x.gif"), "link-only")
        self.assertEqual(di.is_noise(m, "🚀🚀🚀 :pepe:"), "emoji-only")
        self.assertEqual(di.is_noise(m, "lol"), "too short")
        self.assertIsNone(di.is_noise(m, "$TSLA"))
        self.assertEqual(di.is_noise(di.RawMessage("1", CH, "42", "a", 0, "SPY calls", is_bot=True), "SPY calls"), "bot")

    def test_timestamps(self):
        self.assertEqual(di.parse_ts("2026-10-01T14:30:00.1234567+00:00"), int(datetime(2026, 10, 1, 14, 30, tzinfo=timezone.utc).timestamp() * 1000) + 123)
        self.assertEqual(di.parse_ts("2026-10-01T14:30:00Z"), int(datetime(2026, 10, 1, 14, 30, tzinfo=timezone.utc).timestamp() * 1000))


class RagHygieneTests(unittest.TestCase):
    def test_discord_must_be_a_hypothesis(self):
        with self.assertRaises(TagError):
            validate_tags(["class:market_telemetry", "source:discord"])
        validate_tags(["class:external_signal_hypothesis", "source:discord"])
        validate_tags(["class:trade_journal", "source:desk"])
        self.assertTrue(is_hypothesis_citation("discord:dc:1:2"))

    def test_put_many_is_idempotent_and_bannered(self):
        with tempfile.TemporaryDirectory() as d:
            rag = TradingRag(Path(d))
            items = [("SPY calls", ["class:external_signal_hypothesis", "source:discord", "ticker:SPY"], "dc:1:1", 1),
                     ("bad", ["no-class"], "dc:1:2", 2)]
            self.assertEqual(rag.put_many(items), 1)  # bad tags skipped, not fatal
            self.assertEqual(rag.put_many(items), 0)
            e = rag.query("", ticker="SPY")[0]
            self.assertTrue(e.text.startswith("[External Signal Hypothesis"))
            self.assertIn("discord:", rag.render_context([e]))


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.d = Path(self.td.name)
        self.store = di.DiscordStore(self.d / "discord.db")
        self.rag = TradingRag(self.d / "rag")

    def tearDown(self):
        self.td.cleanup()

    def test_json_export_ingest_dedup_and_rag(self):
        msgs = [msg(1, "$SPY 580c 12/20 breakout, PT 590"), msg(2, "lol"), msg(3, "", attach=1), msg(4, "SPY calls", bot=True),
                msg(5, "$SPY 580c 12/20 breakout, PT 590", ts="2026-10-01T14:33:00+00:00"),  # cross-post within 10 min
                msg(6, "QQQ looks heavy, buying puts", author="43", name="bear_bob", ts="2026-10-01T15:00:00+00:00"),
                msg(7, "anyone watching the game tonight?", author="44", ts="2026-10-01T15:05:00+00:00")]
        rep = self.store.ingest(di.parse_export_json(export(msgs)), via="import", rag=self.rag)
        self.assertEqual((rep["kept"], rep["calls"], rep["dup"], rep["rag"]), (3, 2, 1, 2))
        self.assertEqual(rep["noise"], {"too short": 1, "attachment-only": 1, "bot": 1})
        again = self.store.ingest(di.parse_export_json(export(msgs)), via="import", rag=self.rag)
        self.assertEqual((again["kept"], again["dup"]), (0, 4))
        hits = self.store.search("puts")
        self.assertEqual(hits[0]["author"], "bear_bob")
        self.assertEqual(hits[0]["direction"], "bearish")
        self.assertEqual(self.store.search("", ticker="SPY")[0]["tickers"], ["SPY"])
        entries = self.rag.query("", ticker="QQQ")
        self.assertIn("source:discord", entries[0].tags)
        self.assertIn(f"channel:{CH}", entries[0].tags)

    def test_channel_filter(self):
        rep = self.store.ingest(di.parse_export_json(export([msg(1, "$SPY calls now")], ch=CH2)), via="import", rag=self.rag, channels={CH})
        self.assertEqual((rep["kept"], rep["skipped_channel"]), (0, 1))

    def test_csv_export_and_inbox(self):
        inbox = self.d / "inbox"
        inbox.mkdir()
        p = inbox / f"Alpha Traders - Trading - swing-calls [{CH}].csv"
        p.write_text('AuthorID,Author,Date,Content,Attachments,Reactions\n42,trader_joe,2026-10-02T15:00:00.000+00:00,"$IWM long into close, stop 215",,\n'
                     '42,trader_joe,2026-10-02T15:01:00.000+00:00,ok,,\n', encoding="utf-8")
        (inbox / "notes.txt").write_text("ignore me", encoding="utf-8")
        (inbox / "broken.json").write_text("{", encoding="utf-8")
        with mock.patch.dict(os.environ, {"DISCORD_TRADING_CHANNEL_IDS": CH}):
            rep = di.import_inbox(self.store, self.rag, inbox)
        files = {f["file"]: f for f in rep["files"]}
        self.assertEqual(files[p.name]["calls"], 1)
        self.assertIn("error", files["broken.json"])
        self.assertTrue(list((inbox / "done").iterdir()))
        self.assertTrue(list((inbox / "failed").iterdir()))
        self.assertTrue((inbox / "notes.txt").exists())
        self.assertEqual(self.store.stats()["sources"][0]["channel"], "swing-calls")

    def test_csv_name_needs_channel_id(self):
        p = self.d / "random.csv"
        p.write_text("AuthorID,Author,Date,Content\n", encoding="utf-8")
        with self.assertRaises(ValueError):
            di.parse_export_csv(p)


class LiveTests(unittest.TestCase):
    def test_poll_uses_cursor_and_reports_auth_errors(self):
        with tempfile.TemporaryDirectory() as d:
            store, rag = di.DiscordStore(Path(d) / "x.db"), TradingRag(Path(d) / "rag")
            calls = []

            def fetch(path, token):
                calls.append((path, token))
                if path == f"/channels/{CH}":
                    return {"name": "options-flow", "guild_id": "777"}
                if path.startswith(f"/channels/{CH}/messages"):
                    return [{"id": "1300", "channel_id": CH, "timestamp": "2026-11-23T15:00:00+00:00", "type": 0,
                             "content": "$GLD calls, breakout", "author": {"id": "42", "username": "joe"}}]
                raise discord_live.DiscordAuthError("HTTP 403: missing access")

            env = {"DISCORD_BOT_TOKEN": "bot-secret", "DISCORD_TRADING_CHANNEL_IDS": f"{CH},{CH2}"}
            with mock.patch.dict(os.environ, env):
                rep = discord_live.poll_once(store, rag, universe=[], fetch=fetch)
                rep2 = discord_live.poll_once(store, rag, universe=[], fetch=fetch)
            ok = next(c for c in rep["channels"] if c["channelId"] == CH)
            self.assertEqual((ok["kept"], ok["calls"]), (1, 1))
            self.assertIn("error", next(c for c in rep["channels"] if c["channelId"] == CH2))
            self.assertIn(f"/channels/{CH}/messages?limit=100&after=1300", [p for p, _ in calls])  # follows the cursor
            self.assertEqual(next(c for c in rep2["channels"] if c["channelId"] == CH)["dup"], 1)
            self.assertNotIn("bot-secret", json.dumps(rep))

    def test_unconfigured_is_a_noop(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.dict(os.environ, {"DISCORD_BOT_TOKEN": "", "DISCORD_TRADING_CHANNEL_IDS": ""}), \
                mock.patch.object(discord_live, "_env", return_value=""), mock.patch.object(di, "allowed_channels", return_value=set()), \
                mock.patch.object(discord_live, "allowed_channels", return_value=set()):
            rep = discord_live.poll_once(di.DiscordStore(Path(d) / "x.db"), TradingRag(Path(d) / "r"), universe=[])
        self.assertIn("skipped", rep)


def daily(start: str, closes):
    d0 = datetime.strptime(start, "%Y-%m-%d")
    out, i, day = [], 0, d0
    while i < len(closes):
        if day.weekday() < 5:
            out.append({"date": day.strftime("%Y-%m-%d"), "close": closes[i]})
            i += 1
        day += timedelta(days=1)
    return out


class OutcomeTests(unittest.TestCase):
    def test_no_look_ahead_and_direction(self):
        bars = daily("2026-10-01", [100, 101, 102, 103, 104, 105, 106, 107])
        ts = int(datetime(2026, 10, 2, 15, 0, tzinfo=timezone.utc).timestamp() * 1000)  # 11:00 NY on Oct 2: ref = Oct 1 close
        s = outcomes.score_call(bars, ts, "bullish", horizons=(1, 5))
        self.assertEqual((s[1]["ref"], s[1]["exit"], s[1]["hit"]), (100, 101, 1))
        self.assertAlmostEqual(s[5]["ret"], 5.0)
        b = outcomes.score_call(bars, ts, "bearish", horizons=(1,))
        self.assertEqual(b[1]["hit"], 0)
        self.assertEqual(outcomes.score_call(bars, ts, "bullish", horizons=(20,)), {})  # not enough future yet
        self.assertEqual(outcomes.score_call(bars, ts - 30 * 86_400_000, "bullish"), {})  # before any bar

    def test_unscoreable_tickers_are_marked_once_transient_errors_retry(self):
        with tempfile.TemporaryDirectory() as d:
            store = di.DiscordStore(Path(d) / "x.db")
            msgs = [msg(1, "$EVTV calls, breakout", ts="2026-09-01T15:00:00+00:00"),
                    msg(2, "$SPY calls, breakout", ts="2026-09-02T15:00:00+00:00", author="43")]
            store.ingest(di.parse_export_json(export(msgs)), via="import", rag=None)
            now = int(datetime(2026, 11, 24, tzinfo=timezone.utc).timestamp() * 1000)

            class MD:
                def __init__(self, down=False):
                    self.down = down

                async def daily_bars(self, t, days=80):
                    if t == "EVTV":
                        raise LookupError("unknown contract EVTV USD")
                    if self.down:
                        raise ConnectionRefusedError("TWS down")
                    return daily("2026-08-03", [100 + i for i in range(80)])

            r1 = asyncio.run(outcomes.score_pending(store, MD(down=True), now_ms=now))
            self.assertEqual((r1["unscoreable"], r1["scored"]), (1, 0))
            r2 = asyncio.run(outcomes.score_pending(store, MD(), now_ms=now))
            self.assertEqual((r2["calls"], r2["scored"]), (1, 1))  # EVTV not re-queued; SPY retried after the outage
            self.assertEqual(asyncio.run(outcomes.score_pending(store, MD(), now_ms=now))["calls"], 0)
            self.assertEqual(store.stats()["scoredCalls"], 1)  # the unscoreable call doesn't count as scored
            self.assertTrue(all(r["authorId"] == "43" for r in store.outcome_rows()))

    def test_leaderboard_shrinks_small_samples(self):
        rows = [{"horizon": 5, "ret": 3.0, "hit": 1, "authorId": "lucky", "author": "lucky", "channelId": CH, "channel": "c"}] * 3
        rows += [{"horizon": 5, "ret": 1.0, "hit": i % 10 < 7, "authorId": "steady", "author": "steady", "channelId": CH, "channel": "c"} for i in range(40)]
        lb = outcomes.leaderboard(rows, horizon=5)
        self.assertEqual(lb[0]["name"], "steady")  # 70% over 40 calls beats 3/3
        self.assertEqual(next(x for x in lb if x["name"] == "lucky")["hitRate"], 1.0)


def fill(order_id, ref, side, shares, price, t, con=1, comm=1.0, realized=None):
    return {"symbol": "SPY", "conId": con, "orderId": order_id, "orderRef": ref, "side": side, "shares": shares,
            "price": price, "time": t, "commission": comm, "realizedPnl": realized}


def stock_row(**over):
    row = {"intent": {"intent_id": "intent-0001", "source": "engine_a", "symbol": "SPY", "action": "BUY", "quantity": 10,
                      "limit_price": 500.0, "stop_loss": 495.0, "take_profit": 510.0, "sec_type": "STK", "multiplier": 1,
                      "currency": "USD", "thesis": "breakout", "citations": ["telemetry:SPY:daily_bars", "discord:dc:1:2"]},
           "decision": {"entryRef": 500.05}, "result": {"orders": [{"orderId": 10, "type": "LMT"}, {"orderId": 11, "type": "STP"}, {"orderId": 12, "type": "LMT"}]}}
    row.update(over)
    return row


class JournalTests(unittest.TestCase):
    def test_open_trade_has_no_record(self):
        self.assertIsNone(jr.build_record(stock_row(), [fill(10, "intent-0001", "BOT", 10, 500.02, 1000)]))
        self.assertIsNone(jr.build_record(stock_row(), [fill(10, "intent-0001", "BOT", 10, 500.02, 1000), fill(12, "intent-0001", "SLD", 4, 510, 2000)]))

    def test_take_profit_trade(self):
        fills = [fill(10, "intent-0001", "BOT", 10, 500.02, 1000), fill(12, "intent-0001", "SLD", 10, 510.0, 1000 + 7200, realized=97.8)]
        r = jr.build_record(stock_row(), fills)
        self.assertEqual((r["exitReason"], r["outcome"]), ("take_profit", "win"))
        self.assertAlmostEqual(r["pnl"], 99.8 - 2.0)
        self.assertAlmostEqual(r["slippage"], 0.02)
        self.assertAlmostEqual(r["rMultiple"], 97.8 / 50.0)
        self.assertEqual(r["hypothesisCitations"], ["discord:dc:1:2"])
        self.assertAlmostEqual(r["holdHours"], 2.0)
        text, tags, eid = jr.rag_entry(r)
        self.assertIn("class:trade_journal", tags)
        self.assertEqual(eid, "journal:intent-0001")
        validate_tags(tags)

    def test_kill_switch_exit_matched_by_contract(self):
        fills = [fill(10, "intent-0001", "BOT", 10, 500.0, 1000), fill(99, "KILL-20261124-abc", "SLD", 10, 490.0, 5000),
                 fill(98, "KILL-20261124-abc", "SLD", 5, 80.0, 5000, con=2)]  # another position flattened too
        r = jr.build_record(stock_row(), fills)
        self.assertEqual((r["exitReason"], r["outcome"]), ("kill_switch", "loss"))
        self.assertTrue(any("kill switch" in l for l in r["lessons"]))
        self.assertTrue(any("hypothesis-backed" in l for l in r["lessons"]))

    def test_debit_vertical_per_leg(self):
        row = stock_row(intent={**stock_row()["intent"], "sec_type": "BAG", "multiplier": 100, "quantity": 2, "limit_price": 4.0, "stop_loss": 2.0,
                                "legs": [{"action": "BUY", "right": "C", "strike": 730, "expiry": "20261224"},
                                         {"action": "SELL", "right": "C", "strike": 740, "expiry": "20261224"}]},
                        result={"orders": [{"orderId": 20, "type": "LMT"}, {"orderId": 21, "type": "LMT"}]})
        fills = [fill(20, "intent-0001", "BOT", 2, 10.0, 1000, con=1), fill(20, "intent-0001", "SLD", 2, 6.0, 1000, con=2),
                 fill(21, "intent-0001", "SLD", 2, 14.0, 9000, con=1), fill(21, "intent-0001", "BOT", 2, 7.0, 9000, con=2)]
        r = jr.build_record(row, fills)
        self.assertAlmostEqual(r["entryPrice"], 4.0)       # net debit per spread
        self.assertAlmostEqual(r["exitPrice"], 7.0)
        self.assertAlmostEqual(r["pnl"], (7.0 - 4.0) * 100 * 2 - 4.0)
        self.assertEqual(r["exitReason"], "take_profit")


class DeskIntelTests(unittest.TestCase):
    def test_journal_pass_closes_writes_rag_and_reports_to_financer(self):
        with tempfile.TemporaryDirectory() as td:
            d = Path(td)
            bridge = FakeBridge(account={"netLiquidation": 1_000_000.0, "currency": "CAD"})
            desk = Desk(bridge, executor=FakeExecutor(), quote_fn=good_quote, stats_fn=good_stats, fx_source=False,
                        market_data=FakeMD(), d=d, clock=lambda: 1_795_500_000.0)
            row = stock_row()
            from intents import parse_intent
            from security_detail import Decision

            intent = parse_intent({k: v for k, v in row["intent"].items() if k not in ("multiplier",)} | {"asset_class": "etf", "order_type": "LMT"})
            desk._put(intent, "submitted", Decision("APPROVED", "intent-0001", 10, 10, []), row["result"])
            t = 1_795_497_000.0  # after NY midnight of the desk clock: today's trade
            bridge.snap["fills"] = [fill(10, "intent-0001", "BOT", 10, 500.02, t), fill(12, "intent-0001", "SLD", 10, 510.0, t + 3600)]
            rep = desk.journal_pass()
            self.assertEqual(rep["closed"][0]["exitReason"], "take_profit")
            self.assertTrue(rep["financer"]["ok"], rep["financer"])
            self.assertEqual(rep["financer"]["envelope"]["payload"]["trades"], 1)
            self.assertAlmostEqual(rep["financer"]["envelope"]["payload"]["realized_base"], round(97.8 * 1.4, 2))
            self.assertEqual(desk._row("intent-0001")["status"], "closed")
            self.assertEqual(desk.rag.query("", ticker="SPY")[0].tag("class"), "trade_journal")
            self.assertEqual(desk.journal_pass()["closed"], [])  # idempotent
            v = desk.intel_view()
            self.assertEqual((v["journal"]["trades"], v["journal"]["wins"]), (1, 1))
            self.assertTrue((d / "financer_outbox.jsonl").exists())


if __name__ == "__main__":
    unittest.main()
