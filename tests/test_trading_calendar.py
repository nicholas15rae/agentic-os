"""NYSE calendar (trading/market_calendar.py): the static 2025-2028 table, checked date by date and
against the observance rules, plus every place that uses it (gate, Engine R scan, analyst, desk)."""

import sys
import unittest
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "trading"))

import analyst as an  # noqa: E402
import market_calendar as mc  # noqa: E402
import rule_engine as re_  # noqa: E402
from intents import parse_intent  # noqa: E402
from security_detail import regular_hours_fallback, us_market_closed_reason  # noqa: E402

NY = ZoneInfo("America/New_York")


def ny(y, mo, d, h=12, mi=0):
    return datetime(y, mo, d, h, mi, tzinfo=NY).timestamp()


# ── an independent rule-based generator, to cross-check the hand-copied table ──
def easter(y):
    a, b, c = y % 19, y // 100, y % 100
    d, e = b // 4, b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = c // 4, c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7  # noqa: E741
    m = (a + 11 * h + 22 * l) // 451
    month = (h + l - 7 * m + 114) // 31
    day = ((h + l - 7 * m + 114) % 31) + 1
    return date(y, month, day)


def nth_weekday(y, month, weekday, n):
    d = date(y, month, 1)
    d += timedelta(days=(weekday - d.weekday()) % 7)
    return d + timedelta(weeks=n - 1)


def last_weekday(y, month, weekday):
    d = date(y, month + 1, 1) - timedelta(days=1) if month < 12 else date(y, 12, 31)
    return d - timedelta(days=(d.weekday() - weekday) % 7)


def observed(d):
    return d - timedelta(days=1) if d.weekday() == 5 else d + timedelta(days=1) if d.weekday() == 6 else d


def rule_holidays(y):
    out = set()
    ny_day = date(y, 1, 1)
    if ny_day.weekday() != 5:  # a Saturday New Year's Day is not observed
        out.add(observed(ny_day))
    out |= {nth_weekday(y, 1, 0, 3), nth_weekday(y, 2, 0, 3), easter(y) - timedelta(days=2), last_weekday(y, 5, 0),
            observed(date(y, 6, 19)), observed(date(y, 7, 4)), nth_weekday(y, 9, 0, 1), nth_weekday(y, 11, 3, 4),
            observed(date(y, 12, 25))}
    return out


def rule_early_closes(y, holidays):
    out = {nth_weekday(y, 11, 3, 4) + timedelta(days=1)}
    for d in (date(y, 12, 24), date(y, 7, 3)):
        if d.weekday() < 5 and d not in holidays:
            out.add(d)
    return out


class CalendarTableTests(unittest.TestCase):
    def test_named_dates(self):
        self.assertEqual(mc.holiday(date(2026, 11, 26)), "Thanksgiving")
        self.assertEqual(mc.holiday(date(2026, 4, 3)), "Good Friday")
        self.assertEqual(mc.holiday(date(2027, 3, 26)), "Good Friday")
        # Juneteenth / Independence Day on weekends move to the observed weekday
        self.assertIn("Juneteenth", mc.holiday(date(2027, 6, 18)))   # Sat Jun 19 2027 -> Fri
        self.assertIsNone(mc.holiday(date(2027, 6, 19)))
        self.assertIn("Independence", mc.holiday(date(2026, 7, 3)))  # Sat Jul 4 2026 -> Fri Jul 3
        self.assertIn("Independence", mc.holiday(date(2027, 7, 5)))  # Sun Jul 4 2027 -> Mon Jul 5
        self.assertIn("Christmas", mc.holiday(date(2027, 12, 24)))   # Sat Dec 25 2027 -> Fri Dec 24
        self.assertIsNone(mc.holiday(date(2027, 12, 31)))            # Sat Jan 1 2028 is not observed
        self.assertIsNone(mc.holiday(date(2028, 1, 1)))

    def test_early_closes(self):
        self.assertEqual(mc.early_close(date(2026, 11, 27)), "day after Thanksgiving")
        self.assertEqual(mc.early_close(date(2026, 12, 24)), "Christmas Eve")
        self.assertIsNone(mc.early_close(date(2026, 7, 2)))   # Jul 3 2026 is the observed holiday itself
        self.assertEqual(mc.early_close(date(2025, 7, 3)), "day before Independence Day")
        self.assertEqual(mc.early_close(date(2028, 7, 3)), "day before Independence Day")
        self.assertIsNone(mc.early_close(date(2027, 12, 23)))  # Christmas observed on the 24th: no half day
        self.assertEqual(mc.close_time(date(2026, 11, 27)).hour, 13)
        self.assertEqual(mc.close_time(date(2026, 11, 25)).hour, 16)
        self.assertIsNone(mc.close_time(date(2026, 11, 26)))

    def test_table_matches_the_observance_rules(self):
        for y in range(mc.FIRST_YEAR, mc.LAST_YEAR + 1):
            table = {d for d in mc.HOLIDAYS if d.year == y}
            rules = rule_holidays(y)
            extra = table - rules
            self.assertEqual(rules - table, set(), f"{y}: holidays missing from the table")
            # the only special closure is the 2025-01-09 national day of mourning
            self.assertEqual(extra, {date(2025, 1, 9)} if y == 2025 else set(), f"{y}: unexpected closures")
            self.assertEqual({d for d in mc.EARLY_CLOSES if d.year == y}, rule_early_closes(y, table), f"{y}: early closes")
            self.assertTrue(all(d.weekday() < 5 for d in table))

    def test_market_status_labels(self):
        st = mc.market_status(ny(2026, 11, 26, 11, 0))
        self.assertFalse(st["open"])
        self.assertEqual(st["label"], "Market closed: holiday (Thanksgiving)")
        self.assertEqual(st["nextOpenNy"], "Fri 2026-11-27 09:30")
        half = mc.market_status(ny(2026, 11, 27, 11, 0))
        self.assertTrue(half["open"])
        self.assertTrue(half["earlyClose"])
        self.assertEqual(half["closeEt"], "13:00")
        self.assertTrue(half["label"].startswith("Early close 1:00 PM ET"))
        after = mc.market_status(ny(2026, 11, 27, 13, 0))
        self.assertFalse(after["open"])
        self.assertEqual(after["reason"], "after_hours")
        self.assertEqual(mc.market_status(ny(2026, 11, 28))["reason"], "weekend")
        self.assertEqual(mc.market_status(ny(2026, 11, 24, 10))["label"], "Market open until 4:00 PM ET")
        self.assertFalse(mc.market_status(ny(2029, 3, 1))["known"])


class CalendarUseTests(unittest.TestCase):
    def intent(self, currency="USD"):
        return parse_intent({"intent_id": "cal-0001", "source": "manual", "asset_class": "etf", "symbol": "SPY", "action": "BUY",
                             "quantity": 1, "order_type": "MKT", "stop_loss": 600.0, "currency": currency,
                             "citations": ["telemetry:SPY:test"], "thesis": "calendar test"})

    def test_session_fallback_knows_holidays_and_half_days(self):
        self.assertFalse(regular_hours_fallback(ny(2026, 11, 26, 10, 0)))  # Thanksgiving
        self.assertTrue(regular_hours_fallback(ny(2026, 11, 27, 12, 59)))
        self.assertFalse(regular_hours_fallback(ny(2026, 11, 27, 13, 0)))  # after the half-day close
        self.assertTrue(regular_hours_fallback(ny(2026, 11, 24, 15, 59)))
        self.assertFalse(regular_hours_fallback(ny(2026, 11, 24, 16, 0)))

    def test_gate_refuses_a_closed_us_market_even_with_extended_hours(self):
        self.assertEqual(us_market_closed_reason(self.intent(), ny(2026, 11, 26, 10)), "market closed: holiday (Thanksgiving)")
        self.assertIn("early close", us_market_closed_reason(self.intent(), ny(2026, 11, 27, 14)))
        self.assertIsNone(us_market_closed_reason(self.intent(), ny(2026, 11, 27, 11)))
        self.assertIsNone(us_market_closed_reason(self.intent("CAD"), ny(2026, 11, 26, 10)))  # TSX is open on US Thanksgiving

    def test_engine_r_scan_skips_holidays_and_half_days(self):
        self.assertIsNone(re_.scan_key(ny(2026, 11, 26, 15, 45), "15:45"))
        self.assertIsNone(re_.scan_key(ny(2026, 11, 27, 15, 45), "15:45"))  # 13:00 close
        self.assertEqual(re_.scan_key(ny(2026, 11, 25, 15, 45), "15:45"), "20261125-1545")
        self.assertEqual(re_.scan_key(ny(2026, 11, 27, 12, 30), "12:30"), "20261127-1230")

    def test_analyst_treats_holidays_as_outside_hours(self):
        self.assertTrue(an.outside_trading_hours(ny(2026, 11, 26, 11, 0)))
        self.assertFalse(an.outside_trading_hours(ny(2026, 11, 25, 11, 0)))
        self.assertEqual(an.review_day(ny(2026, 11, 27, 7, 0)), "2026-11-25")  # skips Thanksgiving
        self.assertEqual(an.review_day(ny(2026, 11, 26, 17, 0)), "2026-11-25")


if __name__ == "__main__":
    unittest.main()
