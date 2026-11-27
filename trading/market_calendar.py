"""US equity market calendar (NYSE / Nasdaq): full-day holidays and 13:00 ET early closes.

A static table, 2025-2028, copied from the exchanges' published calendars (and cross-checked
against the rules in tests/test_trading_calendar.py). Observance rules, for whoever extends it:

  * a holiday on a Saturday is observed the Friday before, on a Sunday the Monday after;
  * EXCEPT New Year's Day on a Saturday: not observed at all (the year-end close stays open);
  * early close 13:00 ET: the day after Thanksgiving, Christmas Eve (a weekday that isn't itself
    the observed Christmas), and July 3 when it is a weekday and not itself the observed holiday.

Outside the table (before 2025 / after 2028) only weekends are known: `known` is False and the
regular Mon-Fri 09:30-16:00 session is assumed, so add the next years before 2029.

Pure functions, no I/O: the Security Detail calls them with ctx.now.
"""

from __future__ import annotations

from datetime import date, datetime, time as dtime
from typing import Any
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")
OPEN = dtime(9, 30)
CLOSE = dtime(16, 0)
EARLY_CLOSE = dtime(13, 0)
FIRST_YEAR, LAST_YEAR = 2025, 2028

HOLIDAYS: dict[date, str] = {
    # 2025
    date(2025, 1, 1): "New Year's Day",
    date(2025, 1, 9): "National Day of Mourning (President Carter)",
    date(2025, 1, 20): "Martin Luther King Jr. Day",
    date(2025, 2, 17): "Presidents' Day",
    date(2025, 4, 18): "Good Friday",
    date(2025, 5, 26): "Memorial Day",
    date(2025, 6, 19): "Juneteenth",
    date(2025, 7, 4): "Independence Day",
    date(2025, 9, 1): "Labor Day",
    date(2025, 11, 27): "Thanksgiving",
    date(2025, 12, 25): "Christmas",
    # 2026
    date(2026, 1, 1): "New Year's Day",
    date(2026, 1, 19): "Martin Luther King Jr. Day",
    date(2026, 2, 16): "Presidents' Day",
    date(2026, 4, 3): "Good Friday",
    date(2026, 5, 25): "Memorial Day",
    date(2026, 6, 19): "Juneteenth",
    date(2026, 7, 3): "Independence Day (observed)",
    date(2026, 9, 7): "Labor Day",
    date(2026, 11, 26): "Thanksgiving",
    date(2026, 12, 25): "Christmas",
    # 2027
    date(2027, 1, 1): "New Year's Day",
    date(2027, 1, 18): "Martin Luther King Jr. Day",
    date(2027, 2, 15): "Presidents' Day",
    date(2027, 3, 26): "Good Friday",
    date(2027, 5, 31): "Memorial Day",
    date(2027, 6, 18): "Juneteenth (observed)",
    date(2027, 7, 5): "Independence Day (observed)",
    date(2027, 9, 6): "Labor Day",
    date(2027, 11, 25): "Thanksgiving",
    date(2027, 12, 24): "Christmas (observed)",
    # 2028 (Jan 1 is a Saturday: not observed)
    date(2028, 1, 17): "Martin Luther King Jr. Day",
    date(2028, 2, 21): "Presidents' Day",
    date(2028, 4, 14): "Good Friday",
    date(2028, 5, 29): "Memorial Day",
    date(2028, 6, 19): "Juneteenth",
    date(2028, 7, 4): "Independence Day",
    date(2028, 9, 4): "Labor Day",
    date(2028, 11, 23): "Thanksgiving",
    date(2028, 12, 25): "Christmas",
}

EARLY_CLOSES: dict[date, str] = {
    date(2025, 7, 3): "day before Independence Day",
    date(2025, 11, 28): "day after Thanksgiving",
    date(2025, 12, 24): "Christmas Eve",
    date(2026, 11, 27): "day after Thanksgiving",
    date(2026, 12, 24): "Christmas Eve",
    date(2027, 11, 26): "day after Thanksgiving",
    date(2028, 7, 3): "day before Independence Day",
    date(2028, 11, 24): "day after Thanksgiving",
}


def known(d: date) -> bool:
    return FIRST_YEAR <= d.year <= LAST_YEAR


def holiday(d: date) -> str | None:
    return HOLIDAYS.get(d)


def early_close(d: date) -> str | None:
    return EARLY_CLOSES.get(d)


def is_trading_day(d: date) -> bool:
    return d.weekday() < 5 and d not in HOLIDAYS


def close_time(d: date) -> dtime | None:
    """Regular-session close (NY) for `d`, or None when the market is shut all day."""
    if not is_trading_day(d):
        return None
    return EARLY_CLOSE if d in EARLY_CLOSES else CLOSE


def ny_now(now: float) -> datetime:
    return datetime.fromtimestamp(now, NY)


def regular_session_open(now: float) -> bool:
    """Inside the regular session right now: a trading day, 09:30 to its close (13:00 on half days)."""
    t = ny_now(now)
    end = close_time(t.date())
    return end is not None and OPEN <= t.time() < end


def _fmt(t: dtime) -> str:
    h = t.hour % 12 or 12
    return f"{h}:{t.minute:02d} {'AM' if t.hour < 12 else 'PM'} ET"


def next_open(now: float) -> datetime:
    """The next regular-session open strictly after `now` (or today's, if before 09:30 on a trading day)."""
    from datetime import timedelta

    t = ny_now(now)
    d = t.date()
    if is_trading_day(d) and t.time() < OPEN:
        return datetime.combine(d, OPEN, NY)
    for _ in range(14):
        d += timedelta(days=1)
        if is_trading_day(d):
            return datetime.combine(d, OPEN, NY)
    return datetime.combine(d, OPEN, NY)


def market_status(now: float) -> dict[str, Any]:
    """What the UI shows, e.g. "Market closed: holiday (Thanksgiving)" or "Early close 1:00 PM ET"."""
    t = ny_now(now)
    d = t.date()
    hol, early = holiday(d), early_close(d)
    end = close_time(d)
    is_open = regular_session_open(now)
    if hol:
        reason, label = "holiday", f"Market closed: holiday ({hol})"
    elif d.weekday() >= 5:
        reason, label = "weekend", "Market closed: weekend"
    elif is_open:
        reason = "open"
        label = f"Early close {_fmt(EARLY_CLOSE)} ({early})" if early else f"Market open until {_fmt(CLOSE)}"
    elif t.time() < OPEN:
        reason, label = "pre_market", f"Market opens {_fmt(OPEN)}" + (f" · early close {_fmt(EARLY_CLOSE)} today" if early else "")
    else:
        reason, label = "after_hours", "Market closed for the day" + (f" (early close {_fmt(EARLY_CLOSE)})" if early else "")
    nxt = next_open(now)
    return {
        "open": is_open, "reason": reason, "label": label, "date": d.isoformat(),
        "holiday": hol, "earlyClose": bool(early) and end is not None, "earlyCloseReason": early,
        "closeEt": end.strftime("%H:%M") if end else None,
        "nextOpen": nxt.timestamp(), "nextOpenNy": nxt.strftime("%a %Y-%m-%d %H:%M"),
        "known": known(d),
    }
