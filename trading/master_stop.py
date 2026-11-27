"""Master Stop-Loss — a pure, explainable scorer that decides whether an open position is
breaking down (and should be liquidated) or merely wobbling inside its normal noise.

No I/O, no clock reads, no broker calls: the overseer feeds in the position, the latest
price (+ its timestamp), 1-min bars, the daily ATR % and the underlying's implied vol, and
gets back a dict that says what it would do and why.

Design rules (see CONTRACTS.md, Module C):
  * the noise buffer (max(k * ATR%, floor %)) never triggers anything, whatever the
    other factors say;
  * a breakdown must be confirmed by N consecutive evaluations at or above tier2_score;
  * stale or missing data can alert (tier 1) but never liquidate (tier 2);
  * the hard stop (loss % from entry) is a confirmed breakdown on its own when data is fresh;
  * every factor is direction-aware: for a short an UP move is adverse.

Bars are the adapter's shape `{t, o, h, l, c, v}` (oldest first); the long names
`{high, low, close, volume}` are accepted too.
"""

from __future__ import annotations

import math
from typing import Any

TIER_HOLD, TIER_ALERT, TIER_LIQUIDATE = 0, 1, 2
FACTOR_CODES = {
    "drawdown": "DRAWDOWN",
    "slope": "ADVERSE_SLOPE",
    "rel_volume": "VOLUME_SURGE",
    "volatility": "VOL_EXPANSION",
}
MINUTES_PER_SESSION = 390
TRADING_DAYS = 252
# A timestamp this far ahead of `now` is malformed (or a skewed clock), not "fresh".
FUTURE_SKEW_S = 5.0
# Only plain stock positions are scored: for OPT/FUT/BAG TWS reports avgCost per contract
# (price x multiplier) and the adapter's quote/bars are the underlying stock's, so the
# drawdown would be nonsense (e.g. a 2.50 call bought at avgCost 250 looks 99 % down).
SCORED_SEC_TYPES = ("STK",)


# ── small helpers ─────────────────────────────────────────────────────────


def _num(v: Any) -> float | None:
    if v is None or isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _field(bar: dict[str, Any], short: str, long: str) -> float | None:
    if not isinstance(bar, dict):
        return None
    v = bar.get(short)
    if v is None:
        v = bar.get(long)
    return _num(v)


def _closes(bars: list[dict[str, Any]]) -> list[float]:
    out = []
    for b in bars or []:
        c = _field(b, "c", "close")
        if c is not None:
            out.append(c)
    return out


def _clamp(x: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, x))


def _bar_minutes(bar_size: str) -> float:
    """'1 min' / '2 mins' / '5 mins' → minutes per bar (defaults to 1)."""
    try:
        m = float(str(bar_size).split()[0])
        return m if m > 0 else 1.0
    except (ValueError, IndexError):
        return 1.0


# ── public pure helpers ───────────────────────────────────────────────────


def slope_per_bar(closes: list[float]) -> float | None:
    """Least-squares slope of closes vs bar index, in price units per bar. None if < 3 points."""
    ys = [y for y in (_num(c) for c in closes or []) if y is not None]
    n = len(ys)
    if n < 3:
        return None
    mx = (n - 1) / 2
    my = sum(ys) / n
    sxx = sum((i - mx) ** 2 for i in range(n))
    sxy = sum((i - mx) * (y - my) for i, y in enumerate(ys))
    return sxy / sxx


def relative_volume(bars: list[dict[str, Any]], window: int) -> float | None:
    """Mean volume of the last 3 bars / mean volume of the `window` bars before them.

    None when there are fewer than window + 3 bars, a volume is unusable, or the base is 0.
    """
    window = int(window)
    if window < 1 or not bars or len(bars) < window + 3:
        return None
    vols = [_field(b, "v", "volume") for b in bars[-(window + 3):]]
    if any(v is None or v < 0 for v in vols):
        return None
    base = sum(vols[:window]) / window
    if base <= 0:
        return None
    return (sum(vols[window:]) / 3) / base


def realized_vol_annual(bars: list[dict[str, Any]], bar_minutes: float = 1.0) -> float | None:
    """Sample stdev of the log returns of closes, annualised with sqrt(252 * 390 / bar_minutes).

    Returns a fraction (0.18 = 18 %). None with fewer than 3 positive closes.
    """
    closes = [c for c in _closes(bars) if c > 0]
    if len(closes) < 3 or not bar_minutes or bar_minutes <= 0:
        return None
    rets = [math.log(closes[i] / closes[i - 1]) for i in range(1, len(closes))]
    mean = sum(rets) / len(rets)
    var = sum((r - mean) ** 2 for r in rets) / (len(rets) - 1)
    return math.sqrt(var) * math.sqrt(TRADING_DAYS * MINUTES_PER_SESSION / bar_minutes)


# ── the assessment ─────────────────────────────────────────────────────────


def assess(*, position: dict[str, Any], price: float | None, price_time: float | None, now: float,
           bars: list[dict[str, Any]], atr_pct: float | None, iv: float | None, policy: dict[str, Any],
           prev_confirm: int = 0) -> dict[str, Any]:
    ms = policy["master_stop"]
    n_confirm = int(ms["tier2_confirm_evals"])
    bar_minutes = _bar_minutes(ms.get("bar_size", "1 min"))
    # A malformed carried count restarts the streak (more confirmations, never fewer).
    pc = _num(prev_confirm)
    prev_confirm = max(0, int(pc)) if pc is not None else 0

    # Usable bars only (a dict with a finite close); ordered oldest first by their time.
    bars = [b for b in (bars or []) if _field(b, "c", "close") is not None]
    bar_times = [_field(b, "t", "time") for b in bars]
    last_bar_t = None
    if bars and all(t is not None for t in bar_times):
        order = sorted(range(len(bars)), key=lambda i: bar_times[i])
        bars = [bars[i] for i in order]
        last_bar_t = bar_times[order[-1]]

    qty_signed = _num(position.get("position")) or 0.0
    entry = _num(position.get("avgCost"))
    sec_type = position.get("secType")
    price = _num(price)
    atr = _num(atr_pct)
    if atr is not None and atr <= 0:
        atr = None
    iv_f = _num(iv)
    long = qty_signed > 0
    side = "long" if long else "short"

    # Fail closed on time: a missing / non-finite / future timestamp is stale, and so are
    # bars whose newest bar is older than the age limit plus one bar (or that carry no time).
    now_f = _num(now)
    pt = _num(price_time)
    max_age = float(ms["max_data_age_s"])
    data_age = (now_f - pt) if (now_f is not None and pt is not None) else None
    bar_age = (now_f - last_bar_t) if (now_f is not None and last_bar_t is not None) else None
    stale = (data_age is None or data_age > max_age or data_age < -FUTURE_SKEW_S
             or not bars or bar_age is None or bar_age > max_age + bar_minutes * 60
             or bar_age < -FUTURE_SKEW_S)

    out: dict[str, Any] = {
        "symbol": position.get("symbol"), "conId": position.get("conId"), "side": side,
        "qty": abs(qty_signed), "price": price, "entry": entry, "unrealizedPnl": None, "drawdownPct": None,
        "atrPct": atr, "noiseBufferPct": None, "slopePerBar": None, "slopeAtrPerBar": None,
        "relVolume": None, "realizedVol": None, "iv": iv_f, "ivFallback": not (iv_f is not None and iv_f > 0),
        "factors": {"drawdown": 0.0, "slope": 0.0, "rel_volume": 0.0, "volatility": 0.0},
        "score": 0.0, "tier": TIER_HOLD, "reasonCodes": [], "confirmCount": 0,
        "dataAgeS": data_age, "stale": stale, "action": "hold",
    }

    def finish(tier: int, reasons: list[str], confirm: int) -> dict[str, Any]:
        out["tier"] = tier
        out["reasonCodes"] = list(dict.fromkeys(reasons))  # de-dup, keep order
        out["confirmCount"] = confirm
        if tier == TIER_LIQUIDATE:
            out["action"] = "liquidate"
        elif tier == TIER_ALERT:
            out["action"] = "alert_lock" if ms["tier1_lock_desk"] else "alert"
        else:
            out["action"] = "hold"
        return out

    # Rule 1a: without a price, an entry or a quantity there is no drawdown → tier 0.
    if price is None or price <= 0 or entry is None or entry <= 0 or qty_signed == 0:
        return finish(TIER_HOLD, ["DATA_MISSING"], 0)
    # Non-stock positions: avgCost and price are not comparable → drawdown can't be computed.
    if sec_type not in (None, "") and str(sec_type).upper() not in SCORED_SEC_TYPES:
        return finish(TIER_HOLD, ["DATA_MISSING", "UNSUPPORTED_SEC_TYPE"], 0)

    dd = ((entry - price) / entry * 100) if long else ((price - entry) / entry * 100)
    out["unrealizedPnl"] = (price - entry) * qty_signed
    out["drawdownPct"] = dd

    # Descriptive metrics that don't need the ATR.
    window = int(ms["slope_window_bars"])
    recent = bars[-window:]
    slope = slope_per_bar(_closes(recent))
    rv = relative_volume(bars, int(ms["rel_volume_window_bars"]))
    realized = realized_vol_annual(bars, bar_minutes)
    out["slopePerBar"] = slope
    out["relVolume"] = rv
    out["realizedVol"] = realized

    # Rule 1b: price known but ATR missing → can't score; never above tier 1.
    if atr is None:
        noise = float(ms["noise_buffer_min_pct"])
        out["noiseBufferPct"] = noise
        if dd <= noise:
            return finish(TIER_HOLD, ["DATA_MISSING", "IN_PROFIT" if dd <= 0 else "NOISE_BUFFER"], 0)
        reasons = ["DATA_MISSING"]
        if dd >= float(ms["hard_stop_pct"]):
            reasons.append("HARD_STOP")
        if stale:
            reasons.append("STALE_DATA")
        return finish(TIER_ALERT, reasons, 0)

    noise = max(float(ms["noise_buffer_atr_mult"]) * atr, float(ms["noise_buffer_min_pct"]))
    out["noiseBufferPct"] = noise

    # Rule 5: factors (computed before the noise check so the output always explains itself).
    factors: dict[str, float] = {}
    denom = float(ms["drawdown_full_scale_atr_mult"]) * atr - noise
    factors["drawdown"] = 1.0 if denom <= 0 else _clamp((dd - noise) / denom)

    atr_price = atr / 100 * price
    adverse = None
    if slope is not None and atr_price > 0:
        sapb = slope / atr_price
        out["slopeAtrPerBar"] = sapb
        adverse = -sapb if long else sapb
    factors["slope"] = _clamp(adverse / float(ms["slope_full_scale_atr_per_bar"])) if adverse and adverse > 0 else 0.0

    if adverse is not None and adverse > 0 and rv is not None:
        factors["rel_volume"] = _clamp((rv - 1) / (float(ms["rel_volume_full_scale"]) - 1))
    else:
        factors["rel_volume"] = 0.0

    data_codes: list[str] = []
    ratio = None
    if iv_f is not None and iv_f > 0:
        out["ivFallback"] = False
        if realized is not None:
            ratio = realized / iv_f
    else:
        out["ivFallback"] = True
        highs = [h for h in (_field(b, "h", "high") for b in recent) if h is not None]
        lows = [lo for lo in (_field(b, "l", "low") for b in recent) if lo is not None]
        if len(recent) >= 3 and highs and lows:
            range_pct = (max(highs) - min(lows)) / price * 100
            expected = atr * math.sqrt(len(recent) / MINUTES_PER_SESSION)
            if expected > 0:
                ratio = range_pct / expected
    if ratio is None:
        factors["volatility"] = 0.0
        data_codes.append("VOL_UNKNOWN")
    else:
        factors["volatility"] = _clamp((ratio - 1) / (float(ms["vol_expansion_full_scale"]) - 1))
    if out["ivFallback"]:
        data_codes.append("IV_FALLBACK")

    weights = ms["weights"]
    score = round(sum(float(weights.get(k, 0.0)) * v for k, v in factors.items()), 4)
    out["factors"] = {k: round(v, 4) for k, v in factors.items()}
    out["score"] = score
    # Codes from the reported (4 dp) factors so the output is self-consistent.
    factor_codes = [code for k, code in FACTOR_CODES.items() if out["factors"][k] >= 0.5]

    # Rule 3: inside the noise buffer nothing ever triggers.
    if dd <= noise:
        return finish(TIER_HOLD, ["IN_PROFIT" if dd <= 0 else "NOISE_BUFFER"], 0)

    stale_codes = ["STALE_DATA"] if stale else []

    # Rule 4: hard stop — a confirmed breakdown on its own, but only on fresh data.
    if dd >= float(ms["hard_stop_pct"]):
        if not stale:
            return finish(TIER_LIQUIDATE, ["HARD_STOP"] + factor_codes + data_codes, n_confirm)
        # Stale: alert only; stale evaluations neither add nor erase confirmations.
        return finish(TIER_ALERT, ["HARD_STOP"] + stale_codes + factor_codes + data_codes, prev_confirm)

    # Rule 6: score → tier with N-eval confirmation for tier 2.
    if score >= float(ms["tier2_score"]):
        if stale:
            # Stale data never liquidates, and a re-read of the same old bars is not an
            # independent confirmation: carry the count without advancing it.
            return finish(TIER_ALERT, ["TIER2_PENDING_CONFIRMATION"] + stale_codes + factor_codes + data_codes, prev_confirm)
        confirm = prev_confirm + 1
        if confirm >= n_confirm:
            return finish(TIER_LIQUIDATE, factor_codes + data_codes, confirm)
        return finish(TIER_ALERT, ["TIER2_PENDING_CONFIRMATION"] + factor_codes + data_codes, confirm)
    if score >= float(ms["tier1_score"]):
        return finish(TIER_ALERT, factor_codes + data_codes + stale_codes, 0)
    return finish(TIER_HOLD, ["BELOW_THRESHOLD"] + factor_codes + data_codes + stale_codes, 0)
