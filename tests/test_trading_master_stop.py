"""Master Stop-Loss scorer (trading/master_stop.py) — pure-function tests on synthetic 1-min bars.

No broker, no network, no files: everything is built in memory.
"""

import copy
import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "trading"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import master_stop as m  # noqa: E402
from risk_policy import defaults, validate  # noqa: E402

NOW = 1_800_000_000.0
FRESH = NOW - 5.0
BIG_IV = 50.0  # 5000 % implied vol → volatility factor 0 (isolates the other factors)


def policy(**over):
    p = validate(defaults())
    p["master_stop"].update(over)
    return p


def mk_bars(closes, vols=None, spread=0.02, t0=None):
    vols = vols or [1000.0] * len(closes)
    if t0 is None:
        t0 = NOW - 60 * len(closes)  # newest bar started 60 s ago (fresh)
    return [{"t": t0 + 60 * i, "o": c, "h": c + spread, "l": c - spread, "c": c, "v": float(v)}
            for i, (c, v) in enumerate(zip(closes, vols))]


def trend_bars(start, step, *, n_flat=35, n_trend=15, base_vol=1000.0, surge_vol=None, spread=0.02):
    """`n_flat` bars at `start`, then `n_trend` bars moving `step` per bar; the last 3 get `surge_vol`."""
    closes = [start] * n_flat + [start + step * (i + 1) for i in range(n_trend)]
    vols = [base_vol] * len(closes)
    if surge_vol is not None:
        vols[-3:] = [surge_vol] * 3
    return mk_bars(closes, vols, spread)


def long_pos(qty=10, avg=100.0):
    return {"symbol": "SPY", "conId": 756733, "position": qty, "avgCost": avg}


def short_pos(qty=10, avg=100.0):
    return {"symbol": "SPY", "conId": 756733, "position": -qty, "avgCost": avg}


def run(position=None, *, price, bars, atr=1.0, iv=BIG_IV, price_time=FRESH, now=NOW, pol=None, prev=0):
    return m.assess(position=position or long_pos(), price=price, price_time=price_time, now=now, bars=bars,
                    atr_pct=atr, iv=iv, policy=pol or policy(), prev_confirm=prev)


def breakdown_bars_long():
    # steep fall (−0.1/bar ≈ 0.1 ATR/bar) on 3× volume
    return trend_bars(99.4, -0.1, surge_vol=3000.0)


def breakdown_bars_short():
    return trend_bars(100.6, 0.1, surge_vol=3000.0)


OUTPUT_KEYS = {
    "symbol", "conId", "side", "qty", "price", "entry", "unrealizedPnl", "drawdownPct", "atrPct", "noiseBufferPct",
    "slopePerBar", "slopeAtrPerBar", "relVolume", "realizedVol", "iv", "ivFallback", "factors", "score", "tier",
    "reasonCodes", "confirmCount", "dataAgeS", "stale", "action",
}


class HelperTests(unittest.TestCase):
    def test_slope_linear(self):
        self.assertAlmostEqual(m.slope_per_bar([1, 2, 3, 4, 5]), 1.0)
        self.assertAlmostEqual(m.slope_per_bar([10, 9.5, 9.0, 8.5]), -0.5)
        self.assertAlmostEqual(m.slope_per_bar([5, 5, 5]), 0.0)

    def test_slope_least_squares_noisy(self):
        # y = 2x + noise with zero-sum symmetric noise → slope still 2
        ys = [0 + 0.1, 2 - 0.1, 4 - 0.1, 6 + 0.1]
        self.assertAlmostEqual(m.slope_per_bar(ys), 2.0, places=9)  # exact OLS

    def test_slope_needs_three_points(self):
        self.assertIsNone(m.slope_per_bar([]))
        self.assertIsNone(m.slope_per_bar([1.0, 2.0]))
        self.assertIsNone(m.slope_per_bar([1.0, None, 2.0]))

    def test_relative_volume(self):
        bars = mk_bars([100.0] * 33, [1000.0] * 30 + [2000.0, 3000.0, 4000.0])
        self.assertAlmostEqual(m.relative_volume(bars, 30), 3.0)
        # only the `window` bars immediately before the last 3 form the base
        bars2 = mk_bars([100.0] * 40, [9999.0] * 7 + [500.0] * 30 + [1000.0] * 3)
        self.assertAlmostEqual(m.relative_volume(bars2, 30), 2.0)

    def test_relative_volume_not_enough_or_zero_base(self):
        self.assertIsNone(m.relative_volume(mk_bars([100.0] * 32), 30))
        self.assertIsNone(m.relative_volume([], 30))
        self.assertIsNone(m.relative_volume(mk_bars([100.0] * 33, [0.0] * 30 + [100.0] * 3), 30))

    def test_relative_volume_accepts_long_field_names(self):
        bars = [{"close": 100.0, "volume": 1000.0}] * 30 + [{"close": 100.0, "volume": 1500.0}] * 3
        self.assertAlmostEqual(m.relative_volume(bars, 30), 1.5)

    def test_realized_vol_constant_is_zero(self):
        self.assertAlmostEqual(m.realized_vol_annual(mk_bars([100.0] * 20)), 0.0)

    def test_realized_vol_matches_formula(self):
        closes = [100.0, 101.0, 100.0, 101.0, 100.0]
        rets = [math.log(closes[i] / closes[i - 1]) for i in range(1, len(closes))]
        mean = sum(rets) / len(rets)
        sd = math.sqrt(sum((r - mean) ** 2 for r in rets) / (len(rets) - 1))
        self.assertAlmostEqual(m.realized_vol_annual(mk_bars(closes)), sd * math.sqrt(252 * 390))
        self.assertAlmostEqual(m.realized_vol_annual(mk_bars(closes), bar_minutes=5.0), sd * math.sqrt(252 * 390 / 5))

    def test_realized_vol_needs_three_closes(self):
        self.assertIsNone(m.realized_vol_annual(mk_bars([100.0, 101.0])))
        self.assertIsNone(m.realized_vol_annual([]))


class AssessShapeTests(unittest.TestCase):
    def test_output_keys_and_basic_fields(self):
        r = run(price=98.0, bars=breakdown_bars_long())
        self.assertEqual(set(r), OUTPUT_KEYS)
        self.assertEqual(set(r["factors"]), {"drawdown", "slope", "rel_volume", "volatility"})
        self.assertEqual(r["side"], "long")
        self.assertEqual(r["qty"], 10)
        self.assertEqual(r["entry"], 100.0)
        self.assertAlmostEqual(r["unrealizedPnl"], -20.0)
        self.assertAlmostEqual(r["drawdownPct"], 2.0)
        self.assertAlmostEqual(r["dataAgeS"], 5.0)
        self.assertFalse(r["stale"])
        self.assertAlmostEqual(r["noiseBufferPct"], 0.5)  # max(0.5 * 1.0, 0.35)
        self.assertEqual(r["score"], round(r["score"], 4))
        for v in r["factors"].values():
            self.assertTrue(0.0 <= v <= 1.0)
        self.assertIn(r["tier"], (0, 1, 2))

    def test_noise_buffer_floor(self):
        r = run(price=99.9, bars=breakdown_bars_long(), atr=0.2)
        self.assertAlmostEqual(r["noiseBufferPct"], 0.35)  # 0.5 * 0.2 = 0.1 < floor 0.35

    def test_inputs_not_mutated(self):
        pos, bars, pol = long_pos(), breakdown_bars_long(), policy()
        snap = copy.deepcopy((pos, bars, pol))
        run(pos, price=98.0, bars=bars, pol=pol)
        self.assertEqual((pos, bars, pol), snap)

    def test_deterministic(self):
        a = run(price=98.0, bars=breakdown_bars_long())
        b = run(price=98.0, bars=breakdown_bars_long())
        self.assertEqual(a, b)


class NoiseBufferTests(unittest.TestCase):
    def test_dip_inside_noise_with_steep_slope_and_volume_surge_stays_tier0(self):
        r = run(price=99.6, bars=breakdown_bars_long(), iv=0.0001)  # dd 0.4 % < buffer 0.5 %
        self.assertAlmostEqual(r["drawdownPct"], 0.4)
        # the other factors are screaming...
        self.assertEqual(r["factors"]["slope"], 1.0)
        self.assertEqual(r["factors"]["rel_volume"], 1.0)
        self.assertEqual(r["factors"]["volatility"], 1.0)
        # ...but the noise buffer never triggers
        self.assertEqual(r["tier"], 0)
        self.assertEqual(r["reasonCodes"], ["NOISE_BUFFER"])
        self.assertEqual(r["confirmCount"], 0)
        self.assertEqual(r["action"], "hold")

    def test_noise_buffer_resets_confirmation(self):
        r = run(price=99.6, bars=breakdown_bars_long(), prev=2)
        self.assertEqual((r["tier"], r["confirmCount"]), (0, 0))

    def test_in_profit(self):
        r = run(price=101.0, bars=breakdown_bars_long())
        self.assertLess(r["drawdownPct"], 0)
        self.assertEqual(r["tier"], 0)
        self.assertEqual(r["reasonCodes"], ["IN_PROFIT"])
        self.assertEqual(r["action"], "hold")

    def test_exactly_at_buffer_is_noise(self):
        r = run(price=99.5, bars=breakdown_bars_long())
        self.assertEqual(r["reasonCodes"], ["NOISE_BUFFER"])


class ConfirmationTests(unittest.TestCase):
    def test_breakdown_needs_n_consecutive_evals(self):
        pol = policy()
        n = pol["master_stop"]["tier2_confirm_evals"]
        self.assertEqual(n, 3)
        prev = 0
        results = []
        for _ in range(n):
            r = run(price=98.0, bars=breakdown_bars_long(), pol=pol, prev=prev)
            results.append(r)
            prev = r["confirmCount"]
        self.assertGreaterEqual(results[0]["score"], pol["master_stop"]["tier2_score"])
        self.assertAlmostEqual(results[0]["score"], 0.8)  # 0.4 dd + 0.25 slope + 0.15 volume
        for r in results[:-1]:
            self.assertEqual(r["tier"], 1)
            self.assertIn("TIER2_PENDING_CONFIRMATION", r["reasonCodes"])
            self.assertEqual(r["action"], "alert")
        self.assertEqual([r["confirmCount"] for r in results], [1, 2, 3])
        last = results[-1]
        self.assertEqual(last["tier"], 2)
        self.assertEqual(last["action"], "liquidate")
        self.assertNotIn("TIER2_PENDING_CONFIRMATION", last["reasonCodes"])
        for code in ("DRAWDOWN", "ADVERSE_SLOPE", "VOLUME_SURGE"):
            self.assertIn(code, last["reasonCodes"])

    def test_interrupted_streak_restarts(self):
        r1 = run(price=98.0, bars=breakdown_bars_long(), prev=0)
        r2 = run(price=98.0, bars=breakdown_bars_long(), prev=r1["confirmCount"])
        self.assertEqual(r2["confirmCount"], 2)
        calm = run(price=99.0, bars=trend_bars(99.0, 0.0), prev=r2["confirmCount"])
        self.assertEqual((calm["tier"], calm["confirmCount"]), (0, 0))
        r3 = run(price=98.0, bars=breakdown_bars_long(), prev=calm["confirmCount"])
        self.assertEqual((r3["tier"], r3["confirmCount"]), (1, 1))

    def test_single_confirm_policy(self):
        r = run(price=98.0, bars=breakdown_bars_long(), pol=policy(tier2_confirm_evals=1))
        self.assertEqual((r["tier"], r["confirmCount"], r["action"]), (2, 1, "liquidate"))

    def test_tier1_band_resets_confirm(self):
        # slope −0.05/bar ≈ 0.051 ATR/bar → 0.64 factor, flat volume → 0.4 + 0.159 ≈ 0.559
        r = run(price=98.0, bars=trend_bars(98.75, -0.05), prev=2)
        self.assertTrue(0.45 <= r["score"] < 0.7, r["score"])
        self.assertEqual((r["tier"], r["confirmCount"], r["action"]), (1, 0, "alert"))
        self.assertIn("DRAWDOWN", r["reasonCodes"])
        self.assertIn("ADVERSE_SLOPE", r["reasonCodes"])
        self.assertNotIn("VOLUME_SURGE", r["reasonCodes"])
        self.assertNotIn("TIER2_PENDING_CONFIRMATION", r["reasonCodes"])

    def test_tier1_lock_desk(self):
        r = run(price=98.0, bars=trend_bars(98.75, -0.05), pol=policy(tier1_lock_desk=True))
        self.assertEqual((r["tier"], r["action"]), (1, "alert_lock"))

    def test_below_threshold(self):
        r = run(price=99.0, bars=trend_bars(99.0, 0.0), prev=2)  # dd 1 % → 0.333 * 0.4 = 0.133
        self.assertAlmostEqual(r["score"], 0.1333)
        self.assertEqual((r["tier"], r["confirmCount"], r["action"]), (0, 0, "hold"))
        self.assertEqual(r["reasonCodes"][0], "BELOW_THRESHOLD")


class StaleDataTests(unittest.TestCase):
    def test_stale_price_caps_at_tier1(self):
        pol = policy()
        old = NOW - pol["master_stop"]["max_data_age_s"] - 1
        r = run(price=98.0, bars=breakdown_bars_long(), price_time=old, prev=5)
        self.assertTrue(r["stale"])
        self.assertEqual(r["tier"], 1)
        self.assertEqual(r["action"], "alert")
        self.assertIn("STALE_DATA", r["reasonCodes"])
        self.assertIn("TIER2_PENDING_CONFIRMATION", r["reasonCodes"])
        # stale evals neither add nor erase confirmations
        self.assertEqual(r["confirmCount"], 5)

    def test_stale_eval_does_not_advance_confirmation(self):
        old = NOW - 1000
        r1 = run(price=98.0, bars=breakdown_bars_long(), prev=0)
        s = run(price=98.0, bars=breakdown_bars_long(), price_time=old, prev=r1["confirmCount"])
        s2 = run(price=98.0, bars=breakdown_bars_long(), price_time=old, prev=s["confirmCount"])
        self.assertEqual([r1["confirmCount"], s["confirmCount"], s2["confirmCount"]], [1, 1, 1])
        r2 = run(price=98.0, bars=breakdown_bars_long(), prev=s2["confirmCount"])
        r3 = run(price=98.0, bars=breakdown_bars_long(), prev=r2["confirmCount"])
        self.assertEqual((r2["tier"], r3["tier"]), (1, 2))

    def test_missing_price_time_is_stale(self):
        r = run(price=98.0, bars=breakdown_bars_long(), price_time=None, prev=10)
        self.assertTrue(r["stale"])
        self.assertIsNone(r["dataAgeS"])
        self.assertEqual(r["tier"], 1)

    def test_no_bars_is_stale(self):
        r = run(price=95.0, bars=[], prev=10)  # also past the hard stop
        self.assertTrue(r["stale"])
        self.assertEqual(r["tier"], 1)
        self.assertIn("HARD_STOP", r["reasonCodes"])
        self.assertIn("STALE_DATA", r["reasonCodes"])

    def test_stale_hard_stop_alerts_only(self):
        r = run(price=95.0, bars=breakdown_bars_long(), price_time=NOW - 600)
        self.assertEqual((r["tier"], r["action"]), (1, "alert"))
        self.assertEqual(r["reasonCodes"][:2], ["HARD_STOP", "STALE_DATA"])

    def test_age_exactly_at_limit_is_fresh(self):
        pol = policy()
        r = run(price=98.0, bars=breakdown_bars_long(), price_time=NOW - pol["master_stop"]["max_data_age_s"], prev=2)
        self.assertFalse(r["stale"])
        self.assertEqual(r["tier"], 2)


class HardStopTests(unittest.TestCase):
    def test_hard_stop_on_fresh_data_liquidates_immediately(self):
        r = run(price=95.5, bars=trend_bars(95.5, 0.0), prev=0)  # dd 4.5 % ≥ 4 %; slope flat
        self.assertEqual(r["tier"], 2)
        self.assertEqual(r["action"], "liquidate")
        self.assertEqual(r["reasonCodes"][0], "HARD_STOP")
        self.assertIn("DRAWDOWN", r["reasonCodes"])  # plus factor codes
        self.assertEqual(r["confirmCount"], 3)

    def test_hard_stop_threshold_exact(self):
        r = run(price=96.0, bars=trend_bars(96.0, 0.0))
        self.assertEqual(r["tier"], 2)
        self.assertIn("HARD_STOP", r["reasonCodes"])

    def test_hard_stop_short(self):
        r = run(short_pos(), price=104.5, bars=trend_bars(104.5, 0.0))
        self.assertEqual((r["tier"], r["reasonCodes"][0]), (2, "HARD_STOP"))


class VolatilityTests(unittest.TestCase):
    def test_iv_path(self):
        bars = breakdown_bars_long()
        iv = 0.2
        r = run(price=98.0, bars=bars, iv=iv)
        self.assertFalse(r["ivFallback"])
        self.assertNotIn("IV_FALLBACK", r["reasonCodes"])
        realized = m.realized_vol_annual(bars, 1.0)
        self.assertAlmostEqual(r["realizedVol"], realized)
        expect = max(0.0, min(1.0, (realized / iv - 1) / (2.0 - 1)))
        self.assertAlmostEqual(r["factors"]["volatility"], round(expect, 4))
        self.assertEqual(r["iv"], iv)

    def test_iv_expansion_code(self):
        r = run(price=98.0, bars=breakdown_bars_long(), iv=0.0001)
        self.assertEqual(r["factors"]["volatility"], 1.0)
        self.assertIn("VOL_EXPANSION", r["reasonCodes"])
        self.assertFalse(r["ivFallback"])

    def test_iv_calm(self):
        r = run(price=98.0, bars=breakdown_bars_long(), iv=BIG_IV)
        self.assertEqual(r["factors"]["volatility"], 0.0)
        self.assertNotIn("VOL_EXPANSION", r["reasonCodes"])

    def test_fallback_when_no_iv(self):
        for iv in (None, 0.0, -1.0):
            # wide bars: each 1-min bar spans 1 % of price → range ≫ ATR * sqrt(15/390)
            r = run(price=98.0, bars=trend_bars(99.4, -0.1, surge_vol=3000.0, spread=0.5), iv=iv)
            self.assertTrue(r["ivFallback"], iv)
            self.assertIn("IV_FALLBACK", r["reasonCodes"])
            self.assertEqual(r["factors"]["volatility"], 1.0)
            self.assertIn("VOL_EXPANSION", r["reasonCodes"])

    def test_fallback_ratio_math(self):
        bars = trend_bars(98.0, 0.0, spread=0.015)  # flat closes, range 0.03 on the last 15 bars
        r = run(price=98.0, bars=bars, iv=None, atr=0.1)  # noise floor 0.35 → dd 2 % is beyond it
        range_pct = 0.03 / 98.0 * 100
        ratio = range_pct / (0.1 * math.sqrt(15 / 390))
        expect = max(0.0, min(1.0, (ratio - 1) / (2.0 - 1)))
        self.assertAlmostEqual(r["factors"]["volatility"], round(expect, 4), places=4)
        self.assertTrue(0 < r["factors"]["volatility"] < 1)

    def test_vol_unknown_with_iv(self):
        r = run(price=98.0, bars=mk_bars([98.1, 98.0]), iv=0.2)
        self.assertFalse(r["ivFallback"])
        self.assertIsNone(r["realizedVol"])
        self.assertEqual(r["factors"]["volatility"], 0.0)
        self.assertIn("VOL_UNKNOWN", r["reasonCodes"])
        self.assertIsNone(r["slopePerBar"])
        self.assertEqual(r["factors"]["slope"], 0.0)

    def test_vol_unknown_fallback(self):
        r = run(price=98.0, bars=mk_bars([98.1, 98.0]), iv=None)
        self.assertTrue(r["ivFallback"])
        self.assertIn("VOL_UNKNOWN", r["reasonCodes"])
        self.assertIn("IV_FALLBACK", r["reasonCodes"])


class DirectionTests(unittest.TestCase):
    def test_short_mirrors_long(self):
        lr = run(long_pos(), price=98.0, bars=breakdown_bars_long())
        sr = run(short_pos(), price=102.0, bars=breakdown_bars_short())
        self.assertEqual(sr["side"], "short")
        self.assertAlmostEqual(sr["drawdownPct"], 2.0)
        self.assertAlmostEqual(sr["unrealizedPnl"], -20.0)
        self.assertEqual(lr["factors"], sr["factors"])
        self.assertEqual(lr["score"], sr["score"])
        self.assertEqual(lr["tier"], sr["tier"])
        self.assertEqual(sorted(lr["reasonCodes"]), sorted(sr["reasonCodes"]))
        self.assertLess(lr["slopeAtrPerBar"], 0)
        self.assertGreater(sr["slopeAtrPerBar"], 0)

    def test_short_confirmed_breakdown(self):
        prev, r = 0, None
        for _ in range(3):
            r = run(short_pos(), price=102.0, bars=breakdown_bars_short(), prev=prev)
            prev = r["confirmCount"]
        self.assertEqual((r["tier"], r["action"]), (2, "liquidate"))

    def test_down_slope_is_not_adverse_for_short(self):
        # short losing 2 % but the market is now falling hard on volume → slope/volume help, not hurt
        r = run(short_pos(), price=102.0, bars=trend_bars(103.5, -0.1, surge_vol=3000.0))
        self.assertEqual(r["factors"]["slope"], 0.0)
        self.assertEqual(r["factors"]["rel_volume"], 0.0)
        self.assertNotIn("ADVERSE_SLOPE", r["reasonCodes"])

    def test_volume_surge_ignored_when_slope_favourable(self):
        r = run(long_pos(), price=98.0, bars=trend_bars(96.5, 0.1, surge_vol=9000.0))
        self.assertGreater(r["relVolume"], 3)
        self.assertEqual(r["factors"]["rel_volume"], 0.0)
        self.assertNotIn("VOLUME_SURGE", r["reasonCodes"])

    def test_short_in_profit(self):
        r = run(short_pos(), price=98.0, bars=breakdown_bars_long())
        self.assertEqual(r["reasonCodes"], ["IN_PROFIT"])
        self.assertAlmostEqual(r["unrealizedPnl"], 20.0)


class DataMissingTests(unittest.TestCase):
    def test_missing_price_is_tier0(self):
        r = run(price=None, bars=breakdown_bars_long(), prev=4)
        self.assertEqual((r["tier"], r["confirmCount"], r["action"]), (0, 0, "hold"))
        self.assertEqual(r["reasonCodes"], ["DATA_MISSING"])
        self.assertIsNone(r["drawdownPct"])

    def test_missing_entry_is_tier0(self):
        pos = long_pos()
        pos["avgCost"] = None
        r = run(pos, price=95.0, bars=breakdown_bars_long())
        self.assertEqual((r["tier"], r["reasonCodes"]), (0, ["DATA_MISSING"]))

    def test_missing_atr_caps_at_tier1(self):
        r = run(price=90.0, bars=breakdown_bars_long(), atr=None, prev=4)  # 10 % down, would be a hard stop
        self.assertEqual((r["tier"], r["confirmCount"], r["action"]), (1, 0, "alert"))
        self.assertIn("DATA_MISSING", r["reasonCodes"])
        self.assertIn("HARD_STOP", r["reasonCodes"])
        self.assertAlmostEqual(r["drawdownPct"], 10.0)

    def test_missing_atr_small_dip_holds(self):
        r = run(price=99.8, bars=breakdown_bars_long(), atr=None)
        self.assertEqual(r["tier"], 0)
        self.assertEqual(r["reasonCodes"], ["DATA_MISSING", "NOISE_BUFFER"])
        r2 = run(price=101.0, bars=breakdown_bars_long(), atr=0.0)
        self.assertEqual(r2["reasonCodes"], ["DATA_MISSING", "IN_PROFIT"])

    def test_missing_atr_moderate_loss_alerts(self):
        r = run(price=98.0, bars=breakdown_bars_long(), atr=None)
        self.assertEqual((r["tier"], r["reasonCodes"]), (1, ["DATA_MISSING"]))


class ReasonCodeCoverageTests(unittest.TestCase):
    def test_every_reason_code_is_reachable(self):
        seen = set()
        cases = [
            dict(price=None, bars=breakdown_bars_long()),
            dict(price=98.0, bars=breakdown_bars_long(), price_time=None),
            dict(price=101.0, bars=breakdown_bars_long()),
            dict(price=99.6, bars=breakdown_bars_long()),
            dict(price=95.0, bars=trend_bars(95.0, 0.0)),
            dict(price=98.0, bars=breakdown_bars_long(), iv=0.0001),
            dict(price=98.0, bars=breakdown_bars_long(), iv=None),
            dict(price=98.0, bars=mk_bars([98.1, 98.0]), iv=0.2),
            dict(price=98.0, bars=breakdown_bars_long()),
            dict(price=99.0, bars=trend_bars(99.0, 0.0)),
        ]
        for c in cases:
            seen.update(run(**c)["reasonCodes"])
        expected = {"DATA_MISSING", "STALE_DATA", "IN_PROFIT", "NOISE_BUFFER", "HARD_STOP", "DRAWDOWN",
                    "ADVERSE_SLOPE", "VOLUME_SURGE", "VOL_EXPANSION", "IV_FALLBACK", "VOL_UNKNOWN",
                    "TIER2_PENDING_CONFIRMATION", "BELOW_THRESHOLD"}
        self.assertEqual(expected - seen, set())


FACTOR_CODE_NAMES = {"drawdown": "DRAWDOWN", "slope": "ADVERSE_SLOPE", "rel_volume": "VOLUME_SURGE",
                     "volatility": "VOL_EXPANSION"}


class ReviewFailClosedTimeTests(unittest.TestCase):
    """Reviewer additions: malformed / future / stale timestamps never count as fresh."""

    def assert_capped(self, r):
        self.assertTrue(r["stale"])
        self.assertLessEqual(r["tier"], 1)
        self.assertNotEqual(r["action"], "liquidate")

    def test_nan_price_time_is_stale(self):
        # NaN > max_age is False: a naive comparison would call this fresh
        r = run(price=95.0, bars=trend_bars(95.0, 0.0), price_time=float("nan"), prev=10)
        self.assert_capped(r)
        self.assertIn("STALE_DATA", r["reasonCodes"])
        self.assertIsNone(r["dataAgeS"])

    def test_nan_or_missing_now_is_stale(self):
        for now in (float("nan"), None, float("inf")):
            r = run(price=95.0, bars=trend_bars(95.0, 0.0), now=now, prev=10)
            self.assert_capped(r)

    def test_non_numeric_price_time_is_stale_not_a_crash(self):
        r = run(price=95.0, bars=trend_bars(95.0, 0.0), price_time="yesterday", prev=10)
        self.assert_capped(r)

    def test_future_price_time_is_stale(self):
        r = run(price=95.0, bars=trend_bars(95.0, 0.0), price_time=NOW + 3600, prev=10)
        self.assert_capped(r)
        # small clock skew is tolerated
        ok = run(price=95.0, bars=trend_bars(95.0, 0.0), price_time=NOW + 2)
        self.assertFalse(ok["stale"])
        self.assertEqual(ok["tier"], 2)

    def test_old_bars_with_fresh_price_are_stale(self):
        # e.g. after the close: fresh quote but the last RTH bar is hours old
        pol = policy()
        lim = pol["master_stop"]["max_data_age_s"] + 60
        old = trend_bars(99.4, -0.1, surge_vol=3000.0)
        shift = NOW - 3 * 3600 - old[-1]["t"]
        for b in old:
            b["t"] += shift
        r = run(price=98.0, bars=old, prev=10)
        self.assert_capped(r)
        r = run(price=95.0, bars=old, prev=10)  # hard stop on stale bars → alert only
        self.assert_capped(r)
        self.assertIn("HARD_STOP", r["reasonCodes"])
        # newest bar exactly at the limit (age limit + one bar) is still fresh
        edge = trend_bars(99.4, -0.1, surge_vol=3000.0)
        shift = NOW - lim - edge[-1]["t"]
        for b in edge:
            b["t"] += shift
        self.assertFalse(run(price=98.0, bars=edge, prev=2)["stale"])
        for b in edge:
            b["t"] -= 1
        self.assertTrue(run(price=98.0, bars=edge, prev=2)["stale"])

    def test_future_bars_are_stale(self):
        bars = trend_bars(95.0, 0.0)
        for b in bars:
            b["t"] += 3600
        self.assert_capped(run(price=95.0, bars=bars, prev=10))

    def test_bars_without_time_are_stale(self):
        bars = [{"high": b["h"], "low": b["l"], "close": b["c"], "volume": b["v"]} for b in trend_bars(95.0, 0.0)]
        r = run(price=95.0, bars=bars, prev=10)
        self.assert_capped(r)
        # one bar missing its time is enough
        bars = trend_bars(95.0, 0.0)
        del bars[10]["t"]
        self.assert_capped(run(price=95.0, bars=bars, prev=10))

    def test_all_malformed_bars_count_as_no_bars(self):
        bad = [None, "x", 3, {"t": NOW - 60}, {"t": NOW - 60, "c": float("nan")}, {"t": NOW - 60, "c": None}]
        r = run(price=95.0, bars=bad, prev=10)
        self.assert_capped(r)
        self.assertIn("STALE_DATA", r["reasonCodes"])

    def test_malformed_bars_mixed_in_are_skipped(self):
        good = breakdown_bars_long()
        mixed = list(good)
        mixed.insert(5, None)
        mixed.insert(20, {"t": NOW - 100, "c": float("nan"), "v": 1.0})
        a = run(price=98.0, bars=good)
        b = run(price=98.0, bars=mixed)
        self.assertEqual((a["score"], a["tier"], a["factors"]), (b["score"], b["tier"], b["factors"]))

    def test_bars_out_of_order_are_sorted_by_time(self):
        good = breakdown_bars_long()
        a = run(price=98.0, bars=good)
        b = run(price=98.0, bars=list(reversed(good)))
        self.assertEqual(a, b)
        self.assertLess(b["slopePerBar"], 0)


class ReviewMalformedInputTests(unittest.TestCase):
    def test_option_position_is_not_scored(self):
        # TWS avgCost for options is per contract: 2.50 premium → avgCost 250; price is the stock's
        pos = {"symbol": "SPY 261218C00720000", "conId": 1, "secType": "OPT", "position": 1, "avgCost": 250.0}
        r = run(pos, price=2.40, bars=trend_bars(2.40, 0.0), prev=10)
        self.assertEqual((r["tier"], r["action"], r["confirmCount"]), (0, "hold", 0))
        self.assertEqual(r["reasonCodes"], ["DATA_MISSING", "UNSUPPORTED_SEC_TYPE"])
        for st in ("BAG", "FUT", "opt"):
            pos["secType"] = st
            self.assertEqual(run(pos, price=2.40, bars=trend_bars(2.40, 0.0))["tier"], 0)

    def test_stock_sec_type_is_scored(self):
        pos = long_pos()
        pos["secType"] = "STK"
        r = run(pos, price=95.5, bars=trend_bars(95.5, 0.0))
        self.assertEqual((r["tier"], r["reasonCodes"][0]), (2, "HARD_STOP"))

    def test_malformed_prev_confirm_restarts_streak(self):
        for prev in (float("nan"), "abc", None, -5, float("inf")):
            r = run(price=98.0, bars=breakdown_bars_long(), prev=prev)
            self.assertEqual((r["tier"], r["confirmCount"]), (1, 1), prev)

    def test_nan_inputs_never_liquidate(self):
        nan = float("nan")
        for kw in (dict(price=nan), dict(atr=nan), dict(position={"symbol": "SPY", "conId": 1, "position": nan,
                                                                    "avgCost": 100.0}),
                   dict(position={"symbol": "SPY", "conId": 1, "position": 10, "avgCost": nan})):
            base = dict(price=90.0, bars=breakdown_bars_long(), prev=10)
            base.update(kw)
            r = run(**base)
            self.assertLessEqual(r["tier"], 1, kw)
            self.assertIn("DATA_MISSING", r["reasonCodes"])
            self.assertEqual(r["confirmCount"], 0)

    def test_nan_iv_uses_fallback(self):
        r = run(price=98.0, bars=breakdown_bars_long(), iv=float("nan"))
        self.assertTrue(r["ivFallback"])
        self.assertIn("IV_FALLBACK", r["reasonCodes"])


def _scenarios():
    """A grid of adverse scenarios for the property tests (long side; shorts mirrored)."""
    for price in (100.0, 99.9, 99.6, 99.5, 99.0, 98.0, 97.0, 96.0, 95.0, 90.0, 80.0):
        for step, surge in ((-0.1, 3000.0), (-0.3, 9000.0), (0.0, None), (0.1, 3000.0)):
            for iv in (0.0001, 0.2, None, BIG_IV):
                for atr in (0.2, 1.0, 3.0):
                    yield price, step, surge, iv, atr


class ReviewPropertyTests(unittest.TestCase):
    def test_noise_buffer_never_escalates(self):
        # even with hard_stop_pct inside the buffer, a huge carried count and every factor maxed
        pol = policy(hard_stop_pct=0.1, tier2_confirm_evals=1, noise_buffer_atr_mult=10.0)
        for price, step, surge, iv, atr in _scenarios():
            bars = trend_bars(price - 15 * step, step, surge_vol=surge, spread=0.5)
            for pos, px in ((long_pos(), price), (short_pos(), 200.0 - price)):
                for pt in (FRESH, NOW - 10_000, None):
                    r = run(pos, price=px, bars=bars if pos["position"] > 0 else trend_bars(
                        px + 15 * step, -step, surge_vol=surge, spread=0.5), iv=iv, atr=atr, pol=pol,
                        price_time=pt, prev=99)
                    if r["drawdownPct"] is not None and r["drawdownPct"] <= r["noiseBufferPct"]:
                        self.assertEqual((r["tier"], r["action"], r["confirmCount"]), (0, "hold", 0))
                        self.assertIn(r["reasonCodes"], (["IN_PROFIT"], ["NOISE_BUFFER"]))

    def test_stale_never_reaches_tier2(self):
        pol = policy(tier2_confirm_evals=1)
        for price, step, surge, iv, atr in _scenarios():
            bars = trend_bars(price - 15 * step, step, surge_vol=surge, spread=0.5)
            for pt in (NOW - 121, NOW - 10_000, None, float("nan"), NOW + 600):
                for prev in (0, 2, 99):
                    r = run(price=price, bars=bars, iv=iv, atr=atr, pol=pol, price_time=pt, prev=prev)
                    self.assertTrue(r["stale"])
                    self.assertLessEqual(r["tier"], 1)
                    self.assertNotEqual(r["action"], "liquidate")
            r = run(price=price, bars=[], iv=iv, atr=atr, pol=pol, prev=99)
            self.assertLessEqual(r["tier"], 1)

    def test_short_mirrors_long_everywhere(self):
        """Same price, tape reflected around it, short entry chosen so the adverse move % is equal."""
        ms = policy()["master_stop"]
        for price, step, surge, iv, atr in _scenarios():
            lb = trend_bars(price - 15 * step, step, surge_vol=surge)
            sb = [dict(b, o=2 * price - b["o"], h=2 * price - b["l"], l=2 * price - b["h"], c=2 * price - b["c"])
                  for b in lb]
            short_entry = 100.0 * price / (200.0 - price)  # (price - E) / E == (100 - price) / 100
            for prev in (0, 2):
                lr = run(long_pos(), price=price, bars=lb, iv=iv, atr=atr, prev=prev)
                sr = run(short_pos(avg=short_entry), price=price, bars=sb, iv=iv, atr=atr, prev=prev)
                ctx = (price, step, iv, atr, prev)
                self.assertEqual((lr["side"], sr["side"]), ("long", "short"))
                self.assertAlmostEqual(lr["drawdownPct"], sr["drawdownPct"], places=9, msg=ctx)
                self.assertAlmostEqual(lr["slopeAtrPerBar"] or 0.0, -(sr["slopeAtrPerBar"] or 0.0), places=9, msg=ctx)
                for k in lr["factors"]:
                    self.assertAlmostEqual(lr["factors"][k], sr["factors"][k], places=3, msg=(ctx, k))
                dd, noise = lr["drawdownPct"], lr["noiseBufferPct"]
                near = (abs(dd - noise) < 1e-6 or abs(dd - ms["hard_stop_pct"]) < 1e-6
                        or any(abs(lr["score"] - t) < 2e-3 for t in (ms["tier1_score"], ms["tier2_score"]))
                        or any(abs(v - 0.5) < 2e-3 for v in lr["factors"].values()))
                if near:  # float ties at a threshold: skip the discrete comparisons
                    continue
                self.assertEqual(lr["tier"], sr["tier"], ctx)
                self.assertEqual(lr["confirmCount"], sr["confirmCount"], ctx)
                self.assertEqual(lr["action"], sr["action"], ctx)
                self.assertEqual(sorted(lr["reasonCodes"]), sorted(sr["reasonCodes"]), ctx)

    def test_reason_codes_match_reported_factors(self):
        for price, step, surge, iv, atr in _scenarios():
            r = run(price=price, bars=trend_bars(price - 15 * step, step, surge_vol=surge), iv=iv, atr=atr)
            if r["reasonCodes"] in (["IN_PROFIT"], ["NOISE_BUFFER"]):
                continue
            for k, code in FACTOR_CODE_NAMES.items():
                self.assertEqual(code in r["reasonCodes"], r["factors"][k] >= 0.5, (price, step, iv, atr, k))

    def test_tier2_only_with_fresh_data_and_confirmation_or_hard_stop(self):
        pol = policy()
        ms = pol["master_stop"]
        for price, step, surge, iv, atr in _scenarios():
            for prev in (0, 1, 2):
                r = run(price=price, bars=trend_bars(price - 15 * step, step, surge_vol=surge), iv=iv, atr=atr,
                        prev=prev, pol=pol)
                if r["tier"] == 2:
                    self.assertFalse(r["stale"])
                    self.assertGreater(r["drawdownPct"], r["noiseBufferPct"])
                    self.assertTrue("HARD_STOP" in r["reasonCodes"] or r["confirmCount"] >= ms["tier2_confirm_evals"])
                    self.assertTrue("HARD_STOP" in r["reasonCodes"] or r["score"] >= ms["tier2_score"])


if __name__ == "__main__":
    unittest.main()
