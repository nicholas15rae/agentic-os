"""Module B: pre-trade gates (trading/pretrade.py). Pure checks + one ledger line per gate. Temp dirs only."""

import copy
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "trading"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import pretrade  # noqa: E402
import risk_policy as rp  # noqa: E402
from intents import parse_intent  # noqa: E402
from ledger import Ledger  # noqa: E402

NOW = 1_800_000_000.0


def stk(**over):
    raw = {"intent_id": "intent-0001", "source": "trading_agent", "asset_class": "etf", "symbol": "SPY",
           "action": "BUY", "quantity": 10, "order_type": "LMT", "limit_price": 700.0,
           "stop_loss": 690.0, "take_profit": 720.0, "thesis": "t", "citations": ["c1"], "created_at": 1.0}
    raw.update(over)
    return parse_intent(raw).to_dict()


def opt(**over):
    raw = {"intent_id": "intent-opt-01", "source": "trading_agent", "asset_class": "option", "symbol": "SPY",
           "action": "BUY", "quantity": 2, "order_type": "LMT", "limit_price": 3.50, "stop_loss": 1.75,
           "take_profit": 7.0, "sec_type": "OPT",
           "legs": [{"action": "BUY", "right": "C", "strike": 720.0, "expiry": "20261218"}]}
    raw.update(over)
    return parse_intent(raw).to_dict()


def ctx(**over):
    c = {"now": NOW, "quote": {"bid": 699.9, "ask": 700.1, "last": 700.0, "time": NOW - 2},
         "snapshot_age_s": 3.0, "recent": [], "fx_to_base": 1.0, "entry_price": None}
    c.update(over)
    return c


def policy(**pretrade_over):
    p = rp.defaults()
    p["pretrade"].update(pretrade_over)
    return rp.validate(p)


def by_name(checks):
    return {c["name"]: c for c in checks}


class Base(unittest.TestCase):
    def check(self, name, intent=None, c=None, p=None):
        res = by_name(pretrade.evaluate(intent or stk(), c or ctx(), p or policy()))
        return res[name]

    def assertPass(self, name, **kw):
        r = self.check(name, **kw)
        self.assertTrue(r["ok"], r["detail"])
        return r

    def assertFail(self, name, **kw):
        r = self.check(name, **kw)
        self.assertFalse(r["ok"], r["detail"])
        return r


class HashTests(unittest.TestCase):
    def test_same_content_new_id_collides(self):
        a = stk(intent_id="intent-aaaa", thesis="one", citations=["x"], created_at=5.0)
        b = stk(intent_id="intent-bbbb", thesis="two", citations=["y", "z"], created_at=99.0)
        self.assertEqual(pretrade.intent_hash(a), pretrade.intent_hash(b))

    def test_hex_sha256(self):
        h = pretrade.intent_hash(stk())
        self.assertEqual(len(h), 64)
        int(h, 16)

    def test_price_change_differs(self):
        base = pretrade.intent_hash(stk())
        self.assertNotEqual(base, pretrade.intent_hash(stk(limit_price=701.0)))
        self.assertNotEqual(base, pretrade.intent_hash(stk(stop_loss=689.0)))
        self.assertNotEqual(base, pretrade.intent_hash(stk(take_profit=721.0)))

    def test_rounding_to_cents(self):
        self.assertEqual(pretrade.intent_hash(stk(limit_price=700.001)), pretrade.intent_hash(stk(limit_price=700.0)))
        self.assertNotEqual(pretrade.intent_hash(stk(limit_price=700.01)), pretrade.intent_hash(stk(limit_price=700.0)))

    def test_other_fields_differ(self):
        base = pretrade.intent_hash(stk())
        self.assertNotEqual(base, pretrade.intent_hash(stk(quantity=11)))
        self.assertNotEqual(base, pretrade.intent_hash(stk(symbol="QQQ")))
        self.assertNotEqual(base, pretrade.intent_hash(stk(source="engine_a")))
        self.assertNotEqual(base, pretrade.intent_hash(stk(action="SELL", stop_loss=710.0, take_profit=680.0)))

    def test_none_stays_none(self):
        a = stk(take_profit=None)
        self.assertIsNone(a["take_profit"])
        self.assertNotEqual(pretrade.intent_hash(a), pretrade.intent_hash(stk()))
        pretrade.intent_hash({"symbol": "SPY"})  # sparse dict does not crash

    def test_legs_in_hash(self):
        a = opt()
        b = opt(legs=[{"action": "BUY", "right": "C", "strike": 725.0, "expiry": "20261218"}])
        self.assertNotEqual(pretrade.intent_hash(a), pretrade.intent_hash(b))
        self.assertEqual(pretrade.intent_hash(a), pretrade.intent_hash(opt(intent_id="intent-opt-02")))


class AllowlistTests(Base):
    def test_pass(self):
        self.assertPass("allowlist")

    def test_fail(self):
        self.assertFail("allowlist", intent=stk(symbol="AAPL"))

    def test_empty_allowlist_refuses_everything(self):
        r = self.assertFail("allowlist", p=policy(allowlist=[]))
        self.assertIn("empty", r["detail"])

    def test_option_uses_underlying(self):
        r = self.assertPass("allowlist", intent=opt())
        self.assertIn("underlying", r["detail"])
        self.assertFail("allowlist", intent=opt(symbol="AAPL"))


class MaxSharesTests(Base):
    def test_pass_at_cap(self):
        self.assertPass("max_shares", intent=stk(quantity=200, limit_price=10.0, stop_loss=9.0, take_profit=11.0))

    def test_fail_over_cap(self):
        self.assertFail("max_shares", intent=stk(quantity=201, limit_price=10.0, stop_loss=9.0, take_profit=11.0))

    def test_options_compare_contracts_to_shares_over_100(self):
        p = policy(max_shares_per_order=250)  # -> 2 contracts
        self.assertPass("max_shares", intent=opt(quantity=2), p=p)
        self.assertFail("max_shares", intent=opt(quantity=3), p=p)

    def test_options_cap_min_one(self):
        p = policy(max_shares_per_order=50)  # 50 // 100 = 0 -> 1
        self.assertPass("max_shares", intent=opt(quantity=1), p=p)
        self.assertFail("max_shares", intent=opt(quantity=2), p=p)

    def test_bad_quantity_fails(self):
        i = stk()
        i["quantity"] = 0
        self.assertFail("max_shares", intent=i)


class MaxNotionalTests(Base):
    def test_pass_with_limit_price(self):
        r = self.assertPass("max_notional")  # 10 x 700 = 7000
        self.assertIn("limit_price", r["detail"])

    def test_fail_over_cap(self):
        self.assertFail("max_notional", intent=stk(quantity=40))  # 28,000 > 25,000

    def test_ctx_entry_price_wins(self):
        r = self.assertFail("max_notional", c=ctx(entry_price=3000.0))  # 30,000
        self.assertIn("ctx entry_price", r["detail"])

    def test_market_order_uses_quote_ask_for_buy(self):
        i = stk(order_type="MKT", limit_price=None)
        r = self.assertPass("max_notional", intent=i)
        self.assertIn("quote ask", r["detail"])
        self.assertFail("max_notional", intent=i, c=ctx(quote={"bid": 2000.0, "ask": 2600.0, "time": NOW}))

    def test_market_sell_uses_bid(self):
        i = stk(order_type="MKT", limit_price=None, action="SELL", stop_loss=720.0, take_profit=680.0)
        r = self.assertPass("max_notional", intent=i)
        self.assertIn("quote bid", r["detail"])

    def test_unknown_entry_fails_closed(self):
        i = stk(order_type="MKT", limit_price=None)
        r = self.assertFail("max_notional", intent=i, c=ctx(quote=None))
        self.assertIn("fail closed", r["detail"])
        self.assertFail("max_notional", intent=i, c=ctx(quote={"bid": 0, "ask": 0, "time": NOW}))

    def test_unknown_fx_fails_closed(self):
        r = self.assertFail("max_notional", c=ctx(fx_to_base=None))
        self.assertIn("FX", r["detail"])
        self.assertFail("max_notional", c=ctx(fx_to_base=0))
        self.assertFail("max_notional", c=ctx(fx_to_base=float("nan")))
        c = ctx()
        del c["fx_to_base"]
        self.assertFail("max_notional", c=c)

    def test_fx_scales(self):
        self.assertFail("max_notional", c=ctx(fx_to_base=4.0))  # 7000 * 4 = 28,000

    def test_option_multiplier(self):
        # 2 contracts x 3.50 x 100 = 700
        r = self.assertPass("max_notional", intent=opt())
        self.assertIn("x 100", r["detail"])
        self.assertFail("max_notional", intent=opt(limit_price=150.0, stop_loss=75.0, take_profit=300.0))  # 30,000


class RateLimitTests(Base):
    def test_pass_below_limit(self):
        rec = [{"ts": NOW - 50, "hash": "x", "symbol": "QQQ"}, {"ts": NOW - 40, "hash": "y", "symbol": "QQQ"}]
        self.assertPass("rate_limit", c=ctx(recent=rec))

    def test_fail_at_limit(self):
        rec = [{"ts": NOW - s, "hash": str(s), "symbol": "QQQ"} for s in (50, 40, 30)]
        self.assertFail("rate_limit", c=ctx(recent=rec))

    def test_old_rows_ignored(self):
        rec = [{"ts": NOW - s, "hash": str(s), "symbol": "QQQ"} for s in (60, 100, 30)]  # 60 is not > now-60
        self.assertPass("rate_limit", c=ctx(recent=rec))

    def test_missing_history_fails_closed(self):
        self.assertFail("rate_limit", c=ctx(recent=None))


class CooldownTests(Base):
    def test_pass_no_recent(self):
        r = self.assertPass("global_cooldown")
        self.assertIn("no recent", r["detail"])

    def test_pass_after_cooldown(self):
        self.assertPass("global_cooldown", c=ctx(recent=[{"ts": NOW - 20, "hash": "a", "symbol": "QQQ"}]))

    def test_fail_inside_cooldown(self):
        rec = [{"ts": NOW - 300, "hash": "a", "symbol": "QQQ"}, {"ts": NOW - 5, "hash": "b", "symbol": "IWM"}]
        self.assertFail("global_cooldown", c=ctx(recent=rec))

    def test_zero_cooldown(self):
        self.assertPass("global_cooldown", c=ctx(recent=[{"ts": NOW, "hash": "a", "symbol": "QQQ"}]), p=policy(global_cooldown_s=0))


class IntentHashCheckTests(Base):
    def test_pass_different_hash(self):
        self.assertPass("intent_hash", c=ctx(recent=[{"ts": NOW - 30, "hash": "other", "symbol": "SPY"}]))

    def test_fail_same_hash_new_id(self):
        h = pretrade.intent_hash(stk(intent_id="intent-first"))
        r = self.assertFail("intent_hash", intent=stk(intent_id="intent-retry"),
                            c=ctx(recent=[{"ts": NOW - 300, "hash": h, "symbol": "SPY"}]))
        self.assertIn("identical", r["detail"])

    def test_pass_outside_window(self):
        h = pretrade.intent_hash(stk())
        self.assertPass("intent_hash", c=ctx(recent=[{"ts": NOW - 901, "hash": h, "symbol": "SPY"}]))

    def test_price_change_is_new_order(self):
        h = pretrade.intent_hash(stk())
        self.assertPass("intent_hash", intent=stk(limit_price=701.0),
                        c=ctx(recent=[{"ts": NOW - 30, "hash": h, "symbol": "SPY"}]))


class BracketTests(Base):
    def test_pass_full_bracket(self):
        r = self.assertPass("bracket")
        self.assertIn("GTC by construction", r["detail"])

    def test_missing_take_profit_fails_when_required(self):
        self.assertFail("bracket", intent=stk(take_profit=None))

    def test_missing_take_profit_ok_when_not_required(self):
        self.assertPass("bracket", intent=stk(take_profit=None), p=policy(require_take_profit=False))

    def test_missing_or_bad_stop_fails(self):
        for bad in (None, 0, -1.0, float("nan"), float("inf"), "690"):
            i = stk()
            i["stop_loss"] = bad
            self.assertFail("bracket", intent=i)

    def test_option_exempt_detail_mentions_options_guard(self):
        r = self.assertPass("bracket", intent=opt())
        self.assertIn("options guard", r["detail"])
        self.assertIn("premium stop 1.75", r["detail"])

    def test_option_exempt_still_needs_premium_stop(self):
        # The exemption removes only the RESTING STP; the guard needs a premium stop to enforce.
        for bad in (None, 0, -1.0, float("nan")):
            i = opt()
            i["stop_loss"] = bad
            r = self.assertFail("bracket", intent=i)
            self.assertIn("options guard needs a premium stop", r["detail"])

    def test_option_exempt_still_needs_take_profit(self):
        self.assertFail("bracket", intent=opt(take_profit=None))

    def test_option_not_exempt_needs_stop(self):
        p = policy(options_exempt_from_stop=False)
        i = opt()
        i["stop_loss"] = None
        self.assertFail("bracket", intent=i, p=p)
        r = self.assertPass("bracket", intent=opt(), p=p)
        self.assertNotIn("options guard", r["detail"])


class StaleQuoteTests(Base):
    def test_pass_fresh(self):
        self.assertPass("stale_quote")

    def test_fail_old(self):
        self.assertFail("stale_quote", c=ctx(quote={"bid": 1.0, "ask": 1.1, "time": NOW - 15.1}))

    def test_pass_at_limit(self):
        self.assertPass("stale_quote", c=ctx(quote={"bid": 1.0, "ask": 1.1, "time": NOW - 15.0}))

    def test_missing_timestamp_fails_closed(self):
        r = self.assertFail("stale_quote", c=ctx(quote={"bid": 1.0, "ask": 1.1, "time": None}))
        self.assertEqual(r["detail"], "quote has no timestamp")
        r = self.assertFail("stale_quote", c=ctx(quote={"bid": 1.0, "ask": 1.1}))
        self.assertEqual(r["detail"], "quote has no timestamp")

    def test_no_quote(self):
        self.assertFail("stale_quote", c=ctx(quote=None))

    def test_zero_or_missing_sides(self):
        self.assertFail("stale_quote", c=ctx(quote={"bid": 0, "ask": 1.1, "time": NOW}))
        self.assertFail("stale_quote", c=ctx(quote={"bid": 1.0, "ask": None, "time": NOW}))
        self.assertFail("stale_quote", c=ctx(quote={"bid": -1, "ask": 1.1, "time": NOW}))

    def test_far_future_timestamp_fails(self):
        self.assertFail("stale_quote", c=ctx(quote={"bid": 1.0, "ask": 1.1, "time": NOW + 3600}))


class StaleSnapshotTests(Base):
    def test_pass(self):
        self.assertPass("stale_snapshot")

    def test_fail_old(self):
        self.assertFail("stale_snapshot", c=ctx(snapshot_age_s=10.5))

    def test_pass_at_limit(self):
        self.assertPass("stale_snapshot", c=ctx(snapshot_age_s=10.0))

    def test_missing_fails_closed(self):
        self.assertFail("stale_snapshot", c=ctx(snapshot_age_s=None))
        c = ctx()
        del c["snapshot_age_s"]
        self.assertFail("stale_snapshot", c=c)


class EvaluateTests(unittest.TestCase):
    def test_every_check_reported_in_order(self):
        checks = pretrade.evaluate(stk(), ctx(), policy())
        self.assertEqual([c["name"] for c in checks], list(pretrade.CHECK_NAMES))
        for c in checks:
            self.assertEqual(set(c), {"name", "ok", "detail"})
            self.assertTrue(c["ok"], c)

    def test_every_check_reported_even_when_all_fail(self):
        i = stk(symbol="AAPL", quantity=500)
        i["stop_loss"] = None
        i["take_profit"] = None
        h = pretrade.intent_hash(i)
        rec = [{"ts": NOW - 1, "hash": h, "symbol": "AAPL"} for _ in range(3)]
        c = ctx(recent=rec, quote=None, snapshot_age_s=None, fx_to_base=None)
        checks = pretrade.evaluate(i, c, policy())
        self.assertEqual([x["name"] for x in checks], list(pretrade.CHECK_NAMES))
        self.assertEqual([x["name"] for x in checks if not x["ok"]], list(pretrade.CHECK_NAMES))

    def test_missing_now_fails_closed_without_raising(self):
        c = ctx()
        del c["now"]
        res = by_name(pretrade.evaluate(stk(), c, policy()))
        for name in ("rate_limit", "global_cooldown", "intent_hash", "stale_quote"):
            self.assertFalse(res[name]["ok"], name)
            self.assertIn("check error", res[name]["detail"])

    def test_malformed_policy_fails_closed(self):
        p = policy()
        del p["pretrade"]["max_notional_per_order_base"]
        res = by_name(pretrade.evaluate(stk(), ctx(), p))
        self.assertFalse(res["max_notional"]["ok"])
        self.assertTrue(res["allowlist"]["ok"])

    def test_pure_does_not_mutate_inputs(self):
        i, c, p = stk(), ctx(), policy()
        i0, c0, p0 = copy.deepcopy(i), copy.deepcopy(c), copy.deepcopy(p)
        pretrade.evaluate(i, c, p)
        self.assertEqual((i, c, p), (i0, c0, p0))


class ReviewGapTests(Base):
    """Fail-open paths found in review: each of these passed a check before the fix."""

    def dup_rows(self, intent=None, n=5):
        h = pretrade.intent_hash(intent or stk())
        return [{"ts": NOW - 1, "hash": h, "symbol": "SPY"} for _ in range(n)]

    def test_nan_or_bad_now_fails_every_history_check(self):
        # NaN made every "ts > now - window" False: rate_limit and intent_hash used to PASS on a duplicate storm.
        for bad in (float("nan"), float("inf"), "1800000000", True, None):
            res = by_name(pretrade.evaluate(stk(), ctx(now=bad, recent=self.dup_rows()), policy()))
            for name in ("rate_limit", "global_cooldown", "intent_hash", "stale_quote"):
                self.assertFalse(res[name]["ok"], f"{name} passed with now={bad!r}")

    def test_recent_not_a_list_fails_closed(self):
        for bad in ({"x": 1}, "abc", 5):
            for name in ("rate_limit", "global_cooldown", "intent_hash"):
                self.assertFail(name, c=ctx(recent=bad))

    def test_recent_row_with_bad_ts_fails_closed(self):
        h = pretrade.intent_hash(stk())
        for row in ({"ts": None, "hash": h}, {"hash": h}, {"ts": float("nan"), "hash": h}, {"ts": "x", "hash": h}, "row", None):
            for name in ("rate_limit", "global_cooldown", "intent_hash"):
                self.assertFail(name, c=ctx(recent=[row]))

    def test_future_history_row_fails_closed(self):
        h = pretrade.intent_hash(stk())
        self.assertFail("global_cooldown", c=ctx(recent=[{"ts": NOW + 30, "hash": "a", "symbol": "QQQ"}]),
                        p=policy(global_cooldown_s=0))
        self.assertFail("intent_hash", c=ctx(recent=[{"ts": NOW + 30, "hash": h, "symbol": "SPY"}]))

    def test_option_without_multiplier_is_not_undercounted(self):
        # 2 x 150 x 100 = 30,000 > 25,000. A missing multiplier used to default to 1 (= 300).
        i = opt(limit_price=150.0, stop_loss=75.0, take_profit=300.0)
        for m in (None,):
            i["multiplier"] = m
            r = self.assertFail("max_notional", intent=i)
            self.assertIn("x 100", r["detail"])
        del i["multiplier"]
        self.assertFail("max_notional", intent=i)

    def test_malformed_or_too_small_multiplier_fails(self):
        for m in (0, -100, float("nan"), "100", 1, 10):
            i = opt()
            i["multiplier"] = m
            self.assertFail("max_notional", intent=i)
        i = stk()
        i["multiplier"] = "1"
        self.assertFail("max_notional", intent=i)

    def test_malformed_entry_price_does_not_fall_through(self):
        for bad in (0, -1.0, float("nan"), float("inf"), "700"):
            self.assertFail("max_notional", c=ctx(entry_price=bad))
            i = stk()
            i["limit_price"] = bad
            self.assertFail("max_notional", intent=i)

    def test_allowlist_string_fails_closed(self):
        p = rp.defaults()
        p["pretrade"]["allowlist"] = "SPY"  # iterates as S, P, Y
        r = self.assertFail("allowlist", intent=stk(symbol="S"), p=p)
        self.assertIn("malformed", r["detail"])
        self.assertFail("allowlist", p=p)

    def test_zero_share_cap_refuses_options_too(self):
        p = rp.defaults()
        for bad in (0, -5, float("nan"), "200", None):
            p["pretrade"]["max_shares_per_order"] = bad
            self.assertFail("max_shares", intent=opt(quantity=1), p=p)
            self.assertFail("max_shares", intent=stk(quantity=1), p=p)

    def test_future_snapshot_fails(self):
        self.assertFail("stale_snapshot", c=ctx(snapshot_age_s=-500))
        self.assertFail("stale_snapshot", c=ctx(snapshot_age_s=float("nan")))
        self.assertPass("stale_snapshot", c=ctx(snapshot_age_s=-0.5))  # small clock skew tolerated

    def test_non_numeric_quote_time_fails(self):
        self.assertFail("stale_quote", c=ctx(quote={"bid": 1.0, "ask": 1.1, "time": "now"}))
        self.assertFail("stale_quote", c=ctx(quote={"bid": 1.0, "ask": 1.1, "time": float("nan")}))

    def test_nan_policy_knobs_fail(self):
        for key in ("max_notional_per_order_base", "global_cooldown_s", "intent_hash_window_s",
                    "max_quote_age_s", "max_snapshot_age_s"):
            p = rp.defaults()
            p["pretrade"][key] = float("nan")
            res = by_name(pretrade.evaluate(stk(), ctx(recent=[{"ts": NOW - 100, "hash": "z", "symbol": "Q"}]), p))
            self.assertFalse(all(c["ok"] for c in res.values()), key)

    def test_malformed_inputs_report_every_check_without_raising(self):
        for intent, c, p in (({"legs": [1]}, ctx(), policy()), (None, None, None), (stk(), ctx(), "policy"),
                             (stk(), ctx(), {"pretrade": ["x"]})):
            checks = pretrade.evaluate(intent, c, p)
            self.assertEqual([x["name"] for x in checks], list(pretrade.CHECK_NAMES))
            self.assertFalse(all(x["ok"] for x in checks))
        res = by_name(pretrade.evaluate({"symbol": "SPY", "legs": [1]}, ctx(), policy()))
        self.assertFalse(res["intent_hash"]["ok"])

    def test_bag_leg_order_does_not_change_hash(self):
        legs = [{"action": "BUY", "right": "C", "strike": 700.0, "expiry": "20261218"},
                {"action": "SELL", "right": "C", "strike": 710.0, "expiry": "20261218"}]
        a = opt(sec_type="BAG", legs=legs, limit_price=4.0, stop_loss=2.0, take_profit=8.0)
        b = dict(a)
        b["legs"] = list(reversed(a["legs"]))
        b["intent_id"] = "intent-retry-bag"
        self.assertEqual(pretrade.intent_hash(a), pretrade.intent_hash(b))
        self.assertFail("intent_hash", intent=b,
                        c=ctx(recent=[{"ts": NOW - 60, "hash": pretrade.intent_hash(a), "symbol": "SPY"}]))

    def test_retry_collides_whatever_the_new_id_and_metadata(self):
        first = stk(intent_id="intent-first")
        h = pretrade.intent_hash(first)
        retry = stk(intent_id="intent-zzzzzzzz", thesis="new", citations=["q"], created_at=123.0,
                    time_in_force="GTC")
        self.assertEqual(h, pretrade.intent_hash(retry))  # tif is not in the hashed field set
        self.assertFail("intent_hash", intent=retry, c=ctx(recent=[{"ts": NOW - 899, "hash": h, "symbol": "SPY"}]))


class LedgerGateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.led = Ledger(Path(self.tmp.name) / "ledger.jsonl")

    def tearDown(self):
        self.tmp.cleanup()

    def c(self, **over):
        now = time.time()  # ledger rows carry wall-clock ts, so "now" must be read after earlier appends
        base = ctx(now=now, quote={"bid": 699.9, "ask": 700.1, "last": 700.0, "time": now - 1}, recent=None)
        base.update(over)
        return base

    def test_pass_writes_one_line(self):
        res = pretrade.gate(stk(), self.c(), policy(), self.led, "test")
        self.assertTrue(res["ok"], res)
        self.assertEqual(set(res), {"ok", "hash", "checks", "failed"})
        self.assertEqual(res["failed"], [])
        rows = self.led.read()
        self.assertEqual(len(rows), 1)
        r = rows[0]
        self.assertEqual((r["kind"], r["ref"], r["verdict"], r["actor"]), ("pretrade_check", "intent-0001", "PASS", "test"))
        self.assertEqual(r["payload"]["hash"], res["hash"])
        self.assertEqual(r["payload"]["symbol"], "SPY")
        self.assertEqual(r["payload"]["failed"], [])
        self.assertEqual(len(r["payload"]["checks"]), len(pretrade.CHECK_NAMES))
        self.assertTrue(self.led.verify()[0])

    def test_reject_writes_one_line(self):
        res = pretrade.gate(stk(symbol="AAPL"), self.c(fx_to_base=None), policy(), self.led, "test")
        self.assertFalse(res["ok"])
        self.assertEqual(res["failed"], ["allowlist", "max_notional"])
        rows = self.led.read()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["verdict"], "REJECT")
        self.assertEqual(rows[0]["payload"]["failed"], ["allowlist", "max_notional"])
        self.assertEqual(rows[0]["payload"]["symbol"], "AAPL")

    def test_retry_under_new_id_rejected_from_ledger(self):
        p = policy(global_cooldown_s=0)
        self.assertTrue(pretrade.gate(stk(intent_id="intent-first"), self.c(), p, self.led, "test")["ok"])
        res = pretrade.gate(stk(intent_id="intent-retry"), self.c(), p, self.led, "test")
        self.assertFalse(res["ok"])
        self.assertEqual(res["failed"], ["intent_hash"])
        self.assertEqual(len(self.led.read()), 2)

    def test_cooldown_and_rate_limit_from_ledger(self):
        self.assertTrue(pretrade.gate(stk(), self.c(), policy(), self.led, "t")["ok"])
        res = pretrade.gate(stk(quantity=11), self.c(), policy(), self.led, "t")
        self.assertEqual(res["failed"], ["global_cooldown"])
        p = policy(global_cooldown_s=0, max_orders_per_minute=2)
        self.assertTrue(pretrade.gate(stk(quantity=12), self.c(), p, self.led, "t")["ok"])
        res = pretrade.gate(stk(quantity=13), self.c(), p, self.led, "t")
        self.assertEqual(res["failed"], ["rate_limit"])

    def test_rejects_do_not_count(self):
        for q in (300, 301, 302, 303):  # max_shares rejects
            self.assertFalse(pretrade.gate(stk(quantity=q, limit_price=10.0, stop_loss=9.0, take_profit=11.0),
                                           self.c(), policy(), self.led, "t")["ok"])
        self.assertTrue(pretrade.gate(stk(), self.c(), policy(), self.led, "t")["ok"])

    def test_caller_recent_is_used_and_ctx_not_mutated(self):
        c = self.c(recent=[])
        pretrade.gate(stk(), c, policy(), self.led, "t")
        pretrade.gate(stk(intent_id="intent-again"), c, policy(), self.led, "t")  # recent=[] given: no dup seen
        self.assertEqual(c["recent"], [])
        c2 = self.c()
        pretrade.gate(stk(), c2, policy(), self.led, "t")
        self.assertIsNone(c2["recent"])

    def test_recent_from_ledger(self):
        self.led.append("pretrade_check", {"hash": "h1", "symbol": "SPY"}, ref="a", verdict="PASS")
        self.led.append("pretrade_check", {"hash": "h2", "symbol": "QQQ"}, ref="b", verdict="REJECT")
        self.led.append("other_kind", {"hash": "h3", "symbol": "IWM"}, ref="c", verdict="PASS")
        rows = pretrade.recent_from_ledger(self.led, time.time(), 60)
        self.assertEqual([(r["hash"], r["symbol"]) for r in rows], [("h1", "SPY")])
        self.assertEqual(set(rows[0]), {"ts", "hash", "symbol"})
        self.assertEqual(pretrade.recent_from_ledger(self.led, time.time() + 1000, 60), [])

    def test_unreadable_ledger_history_fails_closed(self):
        class Broken:
            lines = []

            def since(self, ts, kinds=None):
                raise OSError("disk gone")

            def append(self, kind, payload=None, **kw):
                self.lines.append((kind, payload, kw))

        b = Broken()
        res = pretrade.gate(stk(), self.c(), policy(), b, "t")
        self.assertFalse(res["ok"])
        self.assertEqual(set(res["failed"]), {"rate_limit", "global_cooldown", "intent_hash"})
        self.assertEqual(len(b.lines), 1)
        self.assertEqual(b.lines[0][2]["verdict"], "REJECT")

    def test_gate_history_covers_a_long_cooldown(self):
        # cooldown 300 s, hash window 0: gate used to read only max(0, 60) s of history, so a PASS
        # 120 s ago was invisible and the cooldown passed.
        p = policy(global_cooldown_s=300, intent_hash_window_s=0)
        self.led.append("pretrade_check", {"hash": "old", "symbol": "QQQ"}, ref="x", verdict="PASS")
        now = time.time() + 120  # that PASS is 120 s old
        c = ctx(now=now, quote={"bid": 699.9, "ask": 700.1, "time": now - 1}, recent=None)
        res = pretrade.gate(stk(), c, p, self.led, "t")
        self.assertFalse(res["ok"])
        self.assertEqual(res["failed"], ["global_cooldown"])
        self.assertEqual(pretrade._history_window_s(p["pretrade"]), 300)

    def test_gate_history_covers_hash_window(self):
        p = policy(global_cooldown_s=0)
        self.assertTrue(pretrade.gate(stk(intent_id="intent-first"), self.c(), p, self.led, "t")["ok"])
        now = time.time() + 600  # 10 min later: outside 60 s, inside the 900 s hash window
        c = ctx(now=now, quote={"bid": 699.9, "ask": 700.1, "time": now - 1}, recent=None)
        res = pretrade.gate(stk(intent_id="intent-later"), c, p, self.led, "t")
        self.assertEqual(res["failed"], ["intent_hash"])

    def test_gate_bad_now_rejects_and_still_logs(self):
        res = pretrade.gate(stk(), self.c(now=float("nan")), policy(), self.led, "t")
        self.assertFalse(res["ok"])
        self.assertTrue({"rate_limit", "global_cooldown", "intent_hash", "stale_quote"} <= set(res["failed"]))
        rows = self.led.read()
        self.assertEqual((len(rows), rows[0]["verdict"]), (1, "REJECT"))

    def test_gate_unhashable_intent_rejects_and_logs(self):
        res = pretrade.gate({"intent_id": "bad-intent", "symbol": "SPY", "legs": [1]}, self.c(), policy(), self.led, "t")
        self.assertFalse(res["ok"])
        self.assertIn("intent_hash", res["failed"])
        self.assertEqual(self.led.read()[0]["verdict"], "REJECT")

    def test_ledger_append_failure_propagates(self):
        class NoWrite:
            def since(self, ts, kinds=None):
                return []

            def append(self, *a, **kw):
                raise OSError("disk full")

        with self.assertRaises(OSError):  # never a PASS without its ledger line
            pretrade.gate(stk(), self.c(), policy(), NoWrite(), "t")

    def test_payload_round_trips_json(self):
        pretrade.gate(stk(), self.c(), policy(), self.led, "t")
        raw = self.led.path.read_text(encoding="utf-8").strip()
        self.assertEqual(json.loads(raw)["payload"]["checks"][0]["name"], "allowlist")


if __name__ == "__main__":
    unittest.main()
