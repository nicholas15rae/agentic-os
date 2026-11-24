"""Engine B — defined-risk options: long calls/puts and debit verticals.

propose(symbol, view, structure):
  1. Underlying quote + chain (expirations / strikes) from MarketData (client 12).
  2. Expiry: inside [min_dte, max_dte], nearest the middle of the window.
  3. Strikes from ATM outward on the view's side; per-contract quotes with
     OI / volume / model delta (Black-Scholes from the mid if IBKR has no greeks).
  4. Select: single = liquid contract with |delta| in the target band;
     vertical = that long leg + a further-OTM short leg in the short band (debit).
  5. Intent: LMT at the mid (rounded to the tick, kept inside bid/ask), premium
     stop and take-profit from OptionLimits, size from the premium cap.

`view` comes from the caller (the Trading Agent / you), or "auto": Engine A's
trend_breakout on the underlying → bullish when it fires, otherwise no trade.
Bearish views buy puts / put debit spreads.

The expiry guard (`flatten_plan`) is pure: given held option positions it
lists the closing orders — shorts are bought back BEFORE longs are sold, so a
vertical is never left as a naked short, and nothing is held into exercise.
"""

from __future__ import annotations

import time
from typing import Any, Callable

from engines.common import intent_id, ny_day
from engines.equities_commodities import trend_breakout
from options import (OptionLimits, candidate_strikes, dte, exit_levels, mid, must_flatten, pick_expiry,
                     select_single, select_vertical, tick)

VIEWS = ("bullish", "bearish", "auto")
STRUCTURES = ("single", "vertical")


def structure_limit(bid: float, ask: float) -> float | None:
    """Mid rounded to the tick, clamped inside the market."""
    if not (ask and bid is not None and ask >= bid >= 0):
        return None
    px = tick((bid + ask) / 2)
    px = min(max(px, round(bid, 2)), round(ask, 2))
    return px if px > 0 else None


def build_intent(symbol: str, chosen: dict[str, Any], structure: str, view: str, *, now: float, lim: OptionLimits,
                 premium_budget_base: float, fx: float, under: float, currency: str = "USD") -> dict[str, Any] | None:
    if structure == "single":
        legs = [{"action": "BUY", "right": chosen["right"], "strike": chosen["strike"], "expiry": chosen["expiry"]}]
        limit = structure_limit(chosen["bid"], chosen["ask"])
        width = None
        sec_type = "OPT"
        desc = f"long {chosen['right']}{chosen['strike']:g} {chosen['expiry']} (delta {chosen['delta']:+.2f})"
    else:
        lo, sh = chosen["long"], chosen["short"]
        legs = [{"action": "BUY", "right": lo["right"], "strike": lo["strike"], "expiry": lo["expiry"]},
                {"action": "SELL", "right": sh["right"], "strike": sh["strike"], "expiry": sh["expiry"]}]
        limit = structure_limit(max(chosen["bid"], 0.0), chosen["ask"])
        width = chosen["width"]
        sec_type = "BAG"
        desc = f"{lo['right']} debit vertical {lo['strike']:g}/{sh['strike']:g} {lo['expiry']} (width {width:g})"
    if not limit:
        return None
    stop, tp = exit_levels(limit, lim, width)
    if not stop < limit < tp:
        return None
    per_contract = limit * 100 * fx
    qty = int(premium_budget_base // per_contract) if per_contract > 0 else 0
    if qty < 1:
        return None
    exp = legs[0]["expiry"]
    return {
        "intent_id": intent_id("eb", symbol, ny_day(now), structure, exp, *(f"{l['right']}{l['strike']:g}" for l in legs)),
        "source": "engine_b", "asset_class": "option", "symbol": symbol, "sec_type": sec_type, "currency": currency,
        "action": "BUY", "quantity": qty, "order_type": "LMT", "limit_price": limit, "stop_loss": stop, "take_profit": tp,
        "time_in_force": "DAY", "legs": legs, "multiplier": 100,
        "thesis": (f"Engine B {view}: {desc} on {symbol} @ {under:.2f}, {dte(exp, now)} DTE. Max loss = debit {limit:.2f}/contract. "
                   f"Premium stop {stop:.2f} (-{lim.stop_loss_pct:g}%), target {tp:.2f}; flattened at DTE <= {lim.flatten_dte}."),
        "citations": [f"telemetry:{symbol}:option_chain:{ny_day(now)}", f"telemetry:{symbol}:quote:{int(now)}", "engine_b:defined_risk:v1"],
        "created_at": now,
    }


class EngineB:
    name = "engine_b"

    def __init__(self, md: Any, clock: Callable[[], float] = time.time) -> None:
        self.md = md
        self.clock = clock
        self.last: dict[str, Any] | None = None

    async def resolve_view(self, symbol: str, view: str) -> tuple[str | None, str]:
        if view in ("bullish", "bearish"):
            return view, f"view given: {view}"
        sig = trend_breakout(await self.md.daily_bars(symbol))
        return ("bullish", "auto: Engine A trend breakout") if sig.get("signal") else (None, f"auto: {sig.get('why')}")

    async def propose(self, symbol: str, *, view: str, structure: str, lim: OptionLimits, premium_budget_base: float,
                      fx: float, submit: Any = None, actor: str = "engine_b") -> dict[str, Any]:
        if view not in VIEWS or structure not in STRUCTURES:
            raise ValueError(f"view in {VIEWS}, structure in {STRUCTURES}")
        now = self.clock()
        out: dict[str, Any] = {"symbol": symbol, "structure": structure, "at": now}
        v, why = await self.resolve_view(symbol, view)
        out["view"], out["viewWhy"] = v, why
        if v is None:
            out["result"] = "no trade: " + why
            self.last = out
            return out
        q = await self.md.stock_quote(symbol)
        under = mid(q) or q.get("last") or q.get("close")
        chain = await self.md.option_chain(symbol)
        exp = pick_expiry(chain["expirations"], now, lim)
        if not under or not exp:
            out["result"] = "no trade: " + ("no underlying price" if not under else f"no expiry inside {lim.min_dte}-{lim.max_dte} DTE")
            self.last = out
            return out
        right = "C" if v == "bullish" else "P"
        strikes = candidate_strikes(chain["strikes"], under, right)
        rows = await self.md.option_quotes(symbol, chain["currency"], chain["tradingClass"], chain["multiplier"], [(exp, k, right) for k in strikes])
        chosen, notes = (select_single if structure == "single" else select_vertical)(rows, under, now, lim)
        out.update({"expiry": exp, "dte": dte(exp, now), "underlying": under, "scanned": len(rows), "notes": notes[:12]})
        if not chosen:
            unquoted = rows and all(r.get("bid") is None or not r.get("ask") for r in rows)
            out["result"] = ("no trade: no option quotes right now (US options quote 09:30-16:00 ET)" if unquoted
                             else "no trade: no contract met the delta / liquidity rules")
            self.last = out
            return out
        raw = build_intent(symbol, chosen, structure, v, now=now, lim=lim, premium_budget_base=premium_budget_base, fx=fx, under=under, currency=chain["currency"])
        out["intent"] = raw
        if raw is None:
            out["result"] = "no trade: premium cap allows < 1 contract or no tradable price"
        elif submit is not None:
            res = await submit(raw, actor)
            out["desk"] = {"status": res.get("status"), "verdict": (res.get("decision") or {}).get("verdict"),
                           "reasons": (res.get("decision") or {}).get("reasons", []), "error": res.get("error")}
            out["result"] = f"sent to desk: {out['desk']['status']}"
        else:
            out["result"] = "proposal only"
        self.last = out
        return out


def flatten_plan(positions: list[dict[str, Any]], open_orders: list[dict[str, Any]], now: float, lim: OptionLimits) -> list[dict[str, Any]]:
    """Closing orders for option positions that must not be held into expiry.

    Shorts (negative positions) are bought back first, then longs are sold, so a
    vertical is never momentarily a naked short. Lines that already have a
    working order are skipped (no duplicate exits).
    """
    working = {o.get("conId") for o in open_orders}
    due = [p for p in positions if p.get("secType") == "OPT" and p.get("position") and p.get("expiry")
           and must_flatten(p["expiry"], now, lim) and p.get("conId") not in working]
    due.sort(key=lambda p: (p["position"] > 0, p.get("underlying") or "", p.get("expiry")))
    return [{"conId": p["conId"], "symbol": p.get("symbol"), "expiry": p["expiry"],
             "action": "BUY" if p["position"] < 0 else "SELL", "qty": abs(p["position"]),
             "reason": f"expiry guard: {dte(p['expiry'], now)} DTE"} for p in due]
