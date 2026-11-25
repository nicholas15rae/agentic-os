"""IBKR chart bars: Yahoo-style request mapping and BarData → candle conversion (pure, stdlib only)."""

import sys
import unittest
from datetime import date, datetime, timezone
from pathlib import Path
from types import SimpleNamespace as NS

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "trading"))

from bars import BarsRefused, bar_request, bar_time, to_candles  # noqa: E402


class BarRequestTests(unittest.TestCase):
    def test_us_etf_maps_to_ibkr_strings(self):
        r = bar_request("spy", "5m", "5d")
        self.assertEqual((r["symbol"], r["currency"], r["barSize"], r["duration"]), ("SPY", "USD", "5 mins", "1 W"))
        self.assertEqual(r["cacheS"], 20.0)

    def test_daily_bars_cache_longer(self):
        r = bar_request("QQQ", "1d", "6mo")
        self.assertEqual((r["barSize"], r["duration"], r["cacheS"]), ("1 day", "6 M", 900))

    def test_tsx_suffix_becomes_cad(self):
        r = bar_request("SHOP.TO", "15m", "1mo")
        self.assertEqual((r["symbol"], r["currency"]), ("SHOP", "CAD"))

    def test_range_is_clamped_for_small_bars(self):
        r = bar_request("SPY", "1m", "1y")
        self.assertEqual((r["range"], r["duration"]), ("5d", "1 W"))

    def test_non_equities_are_refused_with_a_reason(self):
        for s in ("ES=F", "BTC-USD", "^GSPC", "EURUSD=X"):
            with self.subTest(s=s), self.assertRaisesRegex(BarsRefused, "TradingView"):
                bar_request(s, "5m", "5d")

    def test_bad_inputs(self):
        with self.assertRaises(BarsRefused):
            bar_request("SPY", "2m", "5d")
        with self.assertRaises(BarsRefused):
            bar_request("SPY", "5m", "10y")
        with self.assertRaises(BarsRefused):
            bar_request("", "5m", "5d")
        with self.assertRaises(BarsRefused):
            bar_request("SPY;DROP", "5m", "5d")


class ConversionTests(unittest.TestCase):
    def test_intraday_utc_datetime(self):
        d = datetime(2026, 11, 24, 14, 30, tzinfo=timezone.utc)
        self.assertEqual(bar_time(d), int(d.timestamp()))

    def test_daily_date_lands_on_ny_close(self):
        self.assertEqual(bar_time(date(2026, 11, 24)), int(datetime(2026, 11, 24, 21, tzinfo=timezone.utc).timestamp()))
        self.assertEqual(bar_time("20261124"), bar_time(date(2026, 11, 24)))
        self.assertEqual(bar_time("1795545600"), 1795545600)

    def test_candles_drop_malformed_rows(self):
        t0 = datetime(2026, 11, 24, 14, 30, tzinfo=timezone.utc)
        bars = [
            NS(date=t0, open=718.0, high=719.0, low=717.5, close=718.6, volume=1200.0),
            NS(date=t0, open=float("nan"), high=1, low=1, close=1, volume=1),
            NS(date=None, open=1, high=1, low=1, close=1, volume=1),
            NS(date=t0, open=-1, high=1, low=1, close=1, volume=1),  # IBKR uses -1 for "no data"
            NS(date=t0, open=1, high=1, low=1, close=1, volume=-1),
        ]
        out = to_candles(bars)
        self.assertEqual(len(out), 2)
        self.assertEqual(out[0], {"t": int(t0.timestamp()), "o": 718.0, "h": 719.0, "l": 717.5, "c": 718.6, "v": 1200.0})
        self.assertEqual(out[1]["v"], 0.0)


if __name__ == "__main__":
    unittest.main()
