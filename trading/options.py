"""Options math, limits and contract selection for Engine B — pure (no I/O).

Engine B is defined-risk only:
  * single-leg BUY of a call or put (max loss = premium paid), or
  * a DEBIT vertical: buy one strike, sell a further-OTM strike, same expiry and
    right (max loss = net debit).
Naked short options, ratio spreads and credit structures are refused by the
schema and the Security Detail in this build.

Separate caps live in `data/trading/option_limits.json` (created with these
defaults). Premium at risk is the WHOLE debit — the worst case — not the stop.
"""

from __future__ import annotations

import json
import math
from dataclasses import asdict, dataclass, fields
from datetime import date, datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")


@dataclass(frozen=True)
class OptionLimits:
    max_premium_pct: float = 0.25        # whole debit at risk, % of equity used for sizing
    max_premium_base: float = 1000.0     # same, absolute cap in base currency
    max_option_positions: int = 3        # open option lines (single legs + spreads)
    min_dte: int = 21                    # never open inside this
    max_dte: int = 45
    target_delta_min: float = 0.35       # long leg |delta|
    target_delta_max: float = 0.55
    short_leg_delta_min: float = 0.15    # vertical short leg |delta|
    short_leg_delta_max: float = 0.35
    min_open_interest: int = 500
    min_volume: int = 25
    max_spread_pct: float = 10.0         # (ask-bid)/mid per leg and for the spread, %
    stop_loss_pct: float = 50.0          # exit when the position has lost this % of premium
    take_profit_pct: float = 80.0        # exit when it has gained this % (singles); verticals cap at 90% of width
    flatten_dte: int = 1                 # close anything at or inside this DTE
    expiry_day_flatten_et: str = "15:00" # and on expiration day after this NY time, whatever happens

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


OPTION_LIMIT_FIELDS = {f.name for f in fields(OptionLimits)}


def load_option_limits(path: Path) -> OptionLimits:
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(OptionLimits().to_dict(), indent=2), encoding="utf-8")
        return OptionLimits()
    data = json.loads(path.read_text(encoding="utf-8"))
    unknown = set(data) - OPTION_LIMIT_FIELDS
    if unknown:
        raise ValueError(f"option_limits.json: unknown field(s) {sorted(unknown)}")
    lim = OptionLimits(**data)
    if not (0 < lim.max_premium_pct <= 5):
        raise ValueError("option_limits.json: max_premium_pct must be in (0, 5]")
    if not (0 < lim.min_dte <= lim.max_dte):
        raise ValueError("option_limits.json: need 0 < min_dte <= max_dte")
    if not (0 <= lim.flatten_dte < lim.min_dte):
        raise ValueError("option_limits.json: need 0 <= flatten_dte < min_dte")
    return lim


# ── dates ────────────────────────────────────────────────────────────────────
def parse_expiry(expiry: str) -> date:
    return datetime.strptime(expiry[:8], "%Y%m%d").date()


def ny_today(now: float) -> date:
    return datetime.fromtimestamp(now, NY).date()


def dte(expiry: str, now: float) -> int:
    """Calendar days from today (New York) to expiry; 0 on expiration day."""
    return (parse_expiry(expiry) - ny_today(now)).days


def past_flatten_time(now: float, hhmm: str) -> bool:
    t = datetime.fromtimestamp(now, NY)
    h, m = (int(x) for x in hhmm.split(":"))
    return (t.hour, t.minute) >= (h, m)


def must_flatten(expiry: str, now: float, lim: OptionLimits) -> bool:
    """Close at DTE <= flatten_dte (default 1: the day before expiry). If flatten_dte is 0,
    expiration day after `expiry_day_flatten_et` is the hard backstop. Never hold into exercise."""
    d = dte(expiry, now)
    if d < 0 or d < lim.flatten_dte or (d == lim.flatten_dte and d > 0):
        return True
    return d == 0 and (lim.flatten_dte > 0 or past_flatten_time(now, lim.expiry_day_flatten_et))


# ── Black-Scholes (fallback when IBKR model greeks aren't available) ─────────
def _ncdf(x: float) -> float:
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def bs_price(s: float, k: float, t: float, vol: float, right: str, r: float = 0.04) -> float:
    if t <= 0 or vol <= 0:
        return max(0.0, s - k) if right == "C" else max(0.0, k - s)
    d1 = (math.log(s / k) + (r + vol * vol / 2) * t) / (vol * math.sqrt(t))
    d2 = d1 - vol * math.sqrt(t)
    if right == "C":
        return s * _ncdf(d1) - k * math.exp(-r * t) * _ncdf(d2)
    return k * math.exp(-r * t) * _ncdf(-d2) - s * _ncdf(-d1)


def bs_delta(s: float, k: float, t: float, vol: float, right: str, r: float = 0.04) -> float:
    if t <= 0 or vol <= 0:
        return (1.0 if s > k else 0.0) if right == "C" else (-1.0 if s < k else 0.0)
    d1 = (math.log(s / k) + (r + vol * vol / 2) * t) / (vol * math.sqrt(t))
    return _ncdf(d1) if right == "C" else _ncdf(d1) - 1


def implied_vol(price: float, s: float, k: float, t: float, right: str, r: float = 0.04) -> float | None:
    if price <= 0 or t <= 0:
        return None
    lo, hi = 1e-3, 5.0
    if not (bs_price(s, k, t, lo, right, r) <= price <= bs_price(s, k, t, hi, right, r)):
        return None
    for _ in range(80):
        mid = (lo + hi) / 2
        if bs_price(s, k, t, mid, right, r) < price:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def mid(row: dict[str, Any]) -> float | None:
    b, a = row.get("bid"), row.get("ask")
    if b is None or a is None or a <= 0 or b < 0 or a < b:
        return None
    return (a + b) / 2


def spread_pct(row: dict[str, Any]) -> float | None:
    m = mid(row)
    return None if not m else (row["ask"] - row["bid"]) / m * 100


def fill_delta(row: dict[str, Any], under: float, now: float) -> float | None:
    """IBKR model delta if present, else Black-Scholes from the option mid (implied vol)."""
    if row.get("delta") is not None:
        return row["delta"]
    m = mid(row)
    t = max(dte(row["expiry"], now), 0) / 365
    if not m or not under or t <= 0:
        return None
    iv = implied_vol(m, under, row["strike"], t, row["right"])
    return None if iv is None else bs_delta(under, row["strike"], t, iv, row["right"])


# ── selection ────────────────────────────────────────────────────────────────
def pick_expiry(expirations: list[str], now: float, lim: OptionLimits) -> str | None:
    """The expiry inside [min_dte, max_dte] nearest the middle of the window."""
    target = (lim.min_dte + lim.max_dte) / 2
    ok = [e for e in expirations if lim.min_dte <= dte(e, now) <= lim.max_dte]
    return min(ok, key=lambda e: abs(dte(e, now) - target)) if ok else None


def candidate_strikes(strikes: list[float], under: float, right: str, n: int = 8) -> list[float]:
    """Strikes from ATM outward in the OTM direction (calls: up, puts: down)."""
    if right == "C":
        side = [k for k in strikes if k >= under * 0.97]
    else:
        side = [k for k in strikes if k <= under * 1.03]
    return sorted(side, key=lambda k: abs(k - under))[: n * 2]


def liquid(row: dict[str, Any], lim: OptionLimits) -> tuple[bool, str]:
    sp = spread_pct(row)
    if sp is None:
        return False, "no two-sided quote"
    if sp > lim.max_spread_pct:
        return False, f"spread {sp:.1f}% > {lim.max_spread_pct}%"
    if (row.get("openInterest") or 0) < lim.min_open_interest:
        return False, f"OI {row.get('openInterest')} < {lim.min_open_interest}"
    if (row.get("volume") or 0) < lim.min_volume:
        return False, f"volume {row.get('volume')} < {lim.min_volume}"
    return True, "ok"


def select_single(rows: list[dict[str, Any]], under: float, now: float, lim: OptionLimits) -> tuple[dict[str, Any] | None, list[str]]:
    """Best liquid contract whose |delta| is inside the target band (closest to the band's middle)."""
    notes, best, best_gap = [], None, math.inf
    target = (lim.target_delta_min + lim.target_delta_max) / 2
    for r in rows:
        ok, why = liquid(r, lim)
        d = fill_delta(r, under, now)
        if not ok or d is None:
            notes.append(f"{r['right']}{r['strike']:g}: {why if not ok else 'no delta'}")
            continue
        r = {**r, "delta": d}
        if not (lim.target_delta_min <= abs(d) <= lim.target_delta_max):
            continue
        gap = abs(abs(d) - target)
        if gap < best_gap:
            best, best_gap = r, gap
    return best, notes


def select_vertical(rows: list[dict[str, Any]], under: float, now: float, lim: OptionLimits) -> tuple[dict[str, Any] | None, list[str]]:
    """Debit vertical: long leg in the target band, short leg further OTM in the short band."""
    long_leg, notes = select_single(rows, under, now, lim)
    if not long_leg:
        return None, notes
    shorts = []
    for r in rows:
        if r["right"] != long_leg["right"] or r["expiry"] != long_leg["expiry"]:
            continue
        further = r["strike"] > long_leg["strike"] if r["right"] == "C" else r["strike"] < long_leg["strike"]
        ok, _ = liquid(r, lim)
        d = fill_delta(r, under, now)
        if further and ok and d is not None and lim.short_leg_delta_min <= abs(d) <= lim.short_leg_delta_max:
            # The structure's spread is ~the sum of both legs' spreads: it must pass the gate's rule too.
            s_bid, s_ask = long_leg["bid"] - r["ask"], long_leg["ask"] - r["bid"]
            s_mid = (s_bid + s_ask) / 2
            if s_mid > 0 and (s_ask - s_bid) / s_mid * 100 <= lim.max_spread_pct:
                shorts.append({**r, "delta": d})
            else:
                notes.append(f"{r['right']}{r['strike']:g}: vertical spread too wide")
    if not shorts:
        return None, notes + ["no liquid short leg in the delta band (with a tight enough structure spread)"]
    short_leg = min(shorts, key=lambda r: abs(abs(r["delta"]) - (lim.short_leg_delta_min + lim.short_leg_delta_max) / 2))
    debit = mid(long_leg) - mid(short_leg)
    width = abs(short_leg["strike"] - long_leg["strike"])
    if debit <= 0 or debit >= width:
        return None, notes + [f"degenerate vertical (debit {debit:.2f}, width {width:g})"]
    return {"long": long_leg, "short": short_leg, "debit": debit, "width": width,
            "bid": long_leg["bid"] - short_leg["ask"], "ask": long_leg["ask"] - short_leg["bid"]}, notes


def tick(price: float) -> float:
    """Option price increments: 0.05 at/above $3, 0.01 below (penny-pilot names quote in pennies under $3)."""
    step = 0.05 if price >= 3 else 0.01
    return round(round(price / step) * step, 2)


def exit_levels(premium: float, lim: OptionLimits, width: float | None = None) -> tuple[float, float]:
    stop = tick(max(0.01, premium * (1 - lim.stop_loss_pct / 100)))
    tp = premium * (1 + lim.take_profit_pct / 100)
    if width is not None:
        tp = min(tp, width * 0.9)
    tp = tick(tp)
    if tp <= premium:
        tp = tick(premium + (0.05 if premium >= 3 else 0.01))
    return stop, tp
