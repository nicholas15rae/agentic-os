"""Chart bars from IBKR for the Command Center "IBKR bars" tab — pure helpers.

The UI speaks Yahoo-style symbols / intervals / ranges (SPY, SHOP.TO; 5m; 5d) because the
companion chart already does. This module maps them to a `reqHistoricalData` request and
turns ib_async BarData into the same {t,o,h,l,c,v} candles the companion chart draws.
No I/O here: market_data.MarketData.chart_bars() does the request.
"""

from __future__ import annotations

import calendar
import math
import re
from datetime import date, datetime
from typing import Any

# Yahoo interval → IBKR barSizeSetting
BAR_SIZES = {"1m": "1 min", "5m": "5 mins", "15m": "15 mins", "30m": "30 mins", "60m": "1 hour", "1h": "1 hour", "1d": "1 day"}
# Yahoo range → IBKR durationStr
DURATIONS = {"1d": "1 D", "5d": "1 W", "1mo": "1 M", "3mo": "3 M", "6mo": "6 M", "1y": "1 Y"}
# Keep each request inside IBKR's "step size" limits (roughly ≤ 2000 bars back); clamp the range.
MAX_RANGE = {"1m": "5d", "5m": "1mo", "15m": "3mo", "30m": "6mo", "60m": "1y", "1h": "1y", "1d": "1y"}
_RANGE_ORDER = list(DURATIONS)

TICKER_RE = re.compile(r"^[A-Z][A-Z0-9.]{0,9}$")
# Cache long enough to respect pacing (no identical request within 15 s; ≤ 60 per 10 min).
CACHE_S = {"1d": 15 * 60}
DEFAULT_CACHE_S = 20.0


class BarsRefused(ValueError):
    """The symbol / interval can't be charted from IBKR (yet). Message is user-facing."""


def bar_request(symbol: str, interval: str, rng: str) -> dict[str, Any]:
    """Validate and map a Yahoo-style request. Raises BarsRefused with a readable reason."""
    s = (symbol or "").strip().upper()
    if interval not in BAR_SIZES:
        raise BarsRefused(f"interval {interval!r} not supported (use {', '.join(BAR_SIZES)})")
    if rng not in DURATIONS:
        raise BarsRefused(f"range {rng!r} not supported (use {', '.join(DURATIONS)})")
    if s.endswith("=F") or s.endswith("=X") or s.startswith("^") or "-" in s:
        raise BarsRefused(f"{s}: IBKR bars cover stocks and ETFs for now; futures, FX, indices and crypto stay on TradingView")
    currency = "USD"
    if s.endswith(".TO"):
        s, currency = s[:-3], "CAD"
    if not TICKER_RE.match(s):
        raise BarsRefused(f"{symbol!r} is not a valid ticker")
    cap = MAX_RANGE[interval]
    if _RANGE_ORDER.index(rng) > _RANGE_ORDER.index(cap):
        rng = cap
    return {
        "symbol": s,
        "currency": currency,
        "barSize": BAR_SIZES[interval],
        "duration": DURATIONS[rng],
        "range": rng,
        "interval": interval,
        "cacheS": CACHE_S.get(interval, DEFAULT_CACHE_S),
    }


def _num(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(f) or math.isinf(f) else f


def bar_time(d: Any) -> int | None:
    """formatDate=2 gives tz-aware UTC datetimes for intraday bars and plain dates for daily ones.
    Daily bars are stamped 21:00 UTC (≈ the 16:00 New York close) so local labels land on the right day."""
    if isinstance(d, datetime):
        return int(d.timestamp()) if d.tzinfo else calendar.timegm(d.timetuple())
    if isinstance(d, date):
        return calendar.timegm(d.timetuple()) + 21 * 3600
    if isinstance(d, (int, float)):
        return int(d)
    if isinstance(d, str) and d.isdigit():
        return int(d) if len(d) > 8 else calendar.timegm(datetime.strptime(d, "%Y%m%d").timetuple()) + 21 * 3600
    return None


def to_candles(bars: list[Any]) -> list[dict[str, float | int]]:
    """ib_async BarData (oldest first) → companion-chart candles. Drops malformed rows."""
    out: list[dict[str, float | int]] = []
    for b in bars or []:
        t = bar_time(getattr(b, "date", None))
        o, h, low, c = (_num(getattr(b, k, None)) for k in ("open", "high", "low", "close"))
        if t is None or None in (o, h, low, c) or min(o, h, low, c) <= 0:  # type: ignore[type-var]
            continue
        v = _num(getattr(b, "volume", 0)) or 0.0
        out.append({"t": t, "o": o, "h": h, "l": low, "c": c, "v": max(0.0, v)})  # type: ignore[dict-item]
    return out
