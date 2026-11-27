"""Security Detail — the deterministic risk gatekeeper between the Trading Agent and IBKR.

`evaluate(intent, ctx)` is a pure function: no I/O, no LLM, no clock reads
(time comes in through `ctx.now`). Every check runs and is reported, so the
audit log shows *all* reasons, not just the first. Verdicts:

  APPROVED  every check passed as submitted
  MODIFIED  only the size was too large; quantity was cut to fit the caps
  REJECTED  any hard check failed (port/mode, lock, drawdown, idempotency,
            hours, liquidity, spread, volume, volatility, signal provenance,
            concurrency, exposure, or size can't fit ≥ 1)

Fail-closed rule: missing data (no quote, unknown hours, unknown equity, no FX
rate, no daily bars for volume / volatility) is a failure, never a pass.

Alternative data has no override: an intent built on a Quantgress disclosure faces
exactly the same checks as any other, and there is no field through which a
disclosure's size or a politician's volume can relax one. On top of that, an
intent whose citations are ONLY external hypotheses (`quantgress:` / `hypothesis:`)
is rejected (`signal_provenance`) — it must also cite market telemetry.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

import market_calendar
from config import PAPER_PORT
from intents import OrderIntent, RiskLimits
from trading_rag import is_hypothesis_citation

APPROVED, MODIFIED, REJECTED = "APPROVED", "MODIFIED", "REJECTED"
MIN_BARS = 15
NY = ZoneInfo("America/New_York")
TZ_ALIASES = {"US/Eastern": "America/New_York", "EST": "America/New_York", "US/Central": "America/Chicago", "MST": "America/Denver"}


@dataclass
class Context:
    now: float
    mode: str
    port: int | None
    connected: bool
    locked: bool
    limits: RiskLimits
    equity_base: float | None
    daily_pnl_base: float | None
    base_currency: str | None
    fx_to_base: dict[str, float] = field(default_factory=dict)
    positions: list[dict[str, Any]] = field(default_factory=list)
    open_orders: list[dict[str, Any]] = field(default_factory=list)
    quote: dict[str, float | None] | None = None
    # From market_stats_from_bars(): adv_shares, adv_value (instrument currency), volatility_pct, atr_pct.
    market_stats: dict[str, float] | None = None
    session_open: bool | None = None
    seen_intent: bool = False
    recent: list[dict[str, Any]] = field(default_factory=list)  # [{symbol, action, quantity, ts}] accepted intents
    orders_today: int = 0
    # Options only (Engine B): options.OptionLimits, and per-leg quotes [{bid, ask, openInterest, volume}]
    # in intent.legs order. ctx.quote is then the quote of the whole structure (per contract).
    option_limits: Any = None
    option_legs: list[dict[str, Any]] | None = None
    # Trading Agent scope (Phase 5): the symbols it may propose (watchlist). None for other sources.
    allowed_symbols: set[str] | None = None


@dataclass
class Decision:
    verdict: str
    intent_id: str
    quantity: int
    requested_quantity: int
    checks: list[dict[str, Any]]
    trip_kill: bool = False
    entry_ref: float | None = None
    risk_base: float | None = None
    notional_base: float | None = None

    @property
    def reasons(self) -> list[str]:
        return [f"{c['name']}: {c['detail']}" for c in self.checks if not c["ok"]]

    @property
    def executable(self) -> bool:
        return self.verdict in (APPROVED, MODIFIED)

    def to_dict(self) -> dict[str, Any]:
        return {
            "verdict": self.verdict, "intentId": self.intent_id, "quantity": self.quantity,
            "requestedQuantity": self.requested_quantity, "checks": self.checks, "reasons": self.reasons,
            "tripKill": self.trip_kill, "entryRef": self.entry_ref, "riskBase": self.risk_base,
            "notionalBase": self.notional_base,
        }


def session_open_from_hours(liquid_hours: str, tz_id: str, now: float) -> bool | None:
    """Parse IBKR `liquidHours` ("20261123:0930-20261123:1600;20261124:CLOSED") → open now?"""
    if not liquid_hours:
        return None
    try:
        tz = ZoneInfo(TZ_ALIASES.get(tz_id, tz_id or "America/New_York"))
    except Exception:  # noqa: BLE001
        return None
    t = datetime.fromtimestamp(now, tz)
    for part in liquid_hours.split(";"):
        if "-" not in part or "CLOSED" in part:
            continue
        a, b = part.split("-", 1)
        try:
            start = datetime.strptime(a, "%Y%m%d:%H%M").replace(tzinfo=tz)
            end = datetime.strptime(b, "%Y%m%d:%H%M").replace(tzinfo=tz)
        except ValueError:
            continue
        if start <= t < end:
            return True
    return False


def regular_hours_fallback(now: float) -> bool:
    """US regular session from the static calendar (market_calendar): Mon-Fri 09:30-16:00 New York,
    shut on NYSE holidays, 13:00 close on half days. Used when liquidHours is missing."""
    return market_calendar.regular_session_open(now)


def us_market_closed_reason(intent: OrderIntent, now: float) -> str | None:
    """A US (USD) instrument on a day/time the calendar says the market is shut → why; else None.
    Checked in the gate on top of TWS liquidHours, so a holiday can never be traded, extended hours or not."""
    if intent.currency != "USD":
        return None
    t = datetime.fromtimestamp(now, NY)
    d = t.date()
    if market_calendar.holiday(d):
        return f"market closed: holiday ({market_calendar.holiday(d)})"
    if market_calendar.early_close(d) and t.time() >= market_calendar.EARLY_CLOSE:
        return f"market closed: early close 1:00 PM ET ({market_calendar.early_close(d)})"
    return None


def market_stats_from_bars(bars: list[dict[str, Any]]) -> dict[str, float] | None:
    """Daily bars (oldest first, each {high, low, close, volume}) → liquidity / volatility stats.

    Uses the last 20 sessions for volume and realized volatility, the last 14 for
    ATR. Returns None (→ fail closed) with fewer than MIN_BARS usable bars.
    """
    clean = []
    for b in bars:
        try:
            h, lo, c, v = float(b["high"]), float(b["low"]), float(b["close"]), float(b["volume"])
        except (KeyError, TypeError, ValueError):
            continue
        if all(math.isfinite(x) for x in (h, lo, c, v)) and c > 0 and h >= lo > 0 and v >= 0:
            clean.append((h, lo, c, v))
    if len(clean) < MIN_BARS:
        return None
    last20 = clean[-20:]
    adv_shares = sum(v for *_, v in last20) / len(last20)
    adv_value = sum(c * v for _, _, c, v in last20) / len(last20)
    rets = [math.log(last20[i][2] / last20[i - 1][2]) for i in range(1, len(last20))]
    mean = sum(rets) / len(rets)
    var = sum((r - mean) ** 2 for r in rets) / max(1, len(rets) - 1)
    vol_pct = math.sqrt(var) * math.sqrt(252) * 100
    trs = []
    window = clean[-15:]
    for i in range(1, len(window)):
        h, lo, _, _ = window[i]
        pc = window[i - 1][2]
        trs.append(max(h - lo, abs(h - pc), abs(lo - pc)))
    atr_pct = (sum(trs) / len(trs)) / clean[-1][2] * 100
    return {"adv_shares": adv_shares, "adv_value": adv_value, "volatility_pct": vol_pct, "atr_pct": atr_pct, "bars": float(len(clean))}


def evaluate(intent: OrderIntent, ctx: Context) -> Decision:
    lim = ctx.limits
    checks: list[dict[str, Any]] = []
    trip = False

    def check(name: str, ok: bool, detail: str) -> bool:
        checks.append({"name": name, "ok": bool(ok), "detail": detail})
        return ok

    # 1. Port & mode
    check("port_mode", ctx.mode == "PAPER" and ctx.port == PAPER_PORT and ctx.connected,
          f"mode={ctx.mode} port={ctx.port} connected={ctx.connected} (needs PAPER on {PAPER_PORT})")

    # 1b. Trading Agent scope: ETFs / commodity ETFs in the watchlist, shares, long only (phase 5 v1).
    if intent.source == "trading_agent":
        in_scope = (ctx.allowed_symbols is not None and intent.symbol in ctx.allowed_symbols and intent.sec_type == "STK"
                    and intent.asset_class in ("etf", "commodity_etf") and intent.action == "BUY")
        check("agent_scope", in_scope, f"{intent.action} {intent.sec_type} {intent.symbol} ({intent.asset_class})"
              + ("" if in_scope else " — the agent may only BUY watchlist ETFs / commodity ETFs"))

    # 2. Kill switch lock
    check("kill_switch", not ctx.locked, "trading is LOCKED by the kill switch" if ctx.locked else "not locked")

    # 3. Daily drawdown circuit breaker
    equity = ctx.equity_base
    if equity is None or equity <= 0 or ctx.daily_pnl_base is None:
        check("daily_drawdown", False, "equity or daily P&L unknown")
    else:
        start_equity = equity - ctx.daily_pnl_base
        floor = -lim.max_daily_loss_pct / 100 * start_equity
        breached = ctx.daily_pnl_base <= floor
        trip = breached
        check("daily_drawdown", not breached,
              f"daily P&L {ctx.daily_pnl_base:.2f} vs limit {floor:.2f} ({lim.max_daily_loss_pct}%)" + (" — circuit breaker TRIPS" if breached else ""))

    # 4. Idempotency, duplicates, cooldown, daily order cap
    check("idempotency", not ctx.seen_intent, "intent_id already processed" if ctx.seen_intent else "new intent_id")
    dup = [r for r in ctx.recent if r["symbol"] == intent.symbol and r["action"] == intent.action
           and r["quantity"] == intent.quantity and ctx.now - r["ts"] < lim.duplicate_window_s]
    check("duplicate", not dup, f"identical {intent.action} {intent.quantity} {intent.symbol} within {lim.duplicate_window_s}s" if dup else "no duplicate")
    hot = [r for r in ctx.recent if r["symbol"] == intent.symbol and ctx.now - r["ts"] < lim.symbol_cooldown_s]
    check("cooldown", not hot, f"{intent.symbol} traded {int(ctx.now - max(r['ts'] for r in hot))}s ago (cooldown {lim.symbol_cooldown_s}s)" if hot else "clear")
    check("daily_order_cap", ctx.orders_today < lim.max_orders_per_day, f"{ctx.orders_today}/{lim.max_orders_per_day} orders today")

    # 5. Market hours (the static NYSE calendar wins over everything: no trade on a holiday / after a half-day close)
    closed_why = us_market_closed_reason(intent, ctx.now)
    if closed_why:
        check("market_hours", False, closed_why)
    elif lim.allow_extended_hours:
        check("market_hours", True, "extended hours allowed by limits")
    elif ctx.session_open is None:
        check("market_hours", False, "trading hours unknown")
    else:
        check("market_hours", ctx.session_open, "regular session open" if ctx.session_open else "outside regular trading hours")

    # 6. Liquidity: real two-sided quote, tight spread, entry near the market
    q = ctx.quote or {}
    bid, ask = q.get("bid"), q.get("ask")
    entry: float | None = None
    if not (bid and ask and bid > 0 and ask > 0 and ask >= bid):
        check("liquidity", False, f"no usable two-sided quote (bid={bid}, ask={ask})")
    else:
        mid = (bid + ask) / 2
        spread_pct = (ask - bid) / mid * 100
        max_spread = ctx.option_limits.max_spread_pct if intent.is_option and ctx.option_limits else lim.max_spread_pct
        check("liquidity", spread_pct <= max_spread, f"spread {spread_pct:.3f}% (max {max_spread}%)")
        entry = intent.limit_price if intent.order_type == "LMT" else (ask if intent.is_long else bid)
        if intent.is_option:
            # Premium moves in big % steps; the rule is "inside the market, never chase past the ask".
            check("price_sanity", bid <= entry <= ask, f"limit {entry:.2f} vs market {bid:.2f} x {ask:.2f} (must be inside)")
        else:
            drift = abs(entry - mid) / mid * 100
            check("price_sanity", drift <= lim.max_price_drift_pct, f"entry {entry:.4f} is {drift:.2f}% from mid {mid:.4f} (max {lim.max_price_drift_pct}%)")
        # The stop must still be on the protective side of where we'd actually fill.
        stop_ok = intent.stop_loss < entry if intent.is_long else intent.stop_loss > entry
        check("stop_side", stop_ok, f"stop {intent.stop_loss} vs entry {entry:.4f}")

    fx = ctx.fx_to_base.get(intent.currency) if intent.currency != ctx.base_currency else 1.0

    # 6b. Illiquidity and volatility filters (daily bars). No bars → reject.
    ms = ctx.market_stats
    if not ms:
        check("avg_volume", False, f"no daily bars for {intent.symbol} — volume unknown")
        check("volatility", False, f"no daily bars for {intent.symbol} — volatility unknown")
    else:
        adv_value_base = ms["adv_value"] * fx if fx else None
        vol_ok = ms["adv_shares"] >= lim.min_avg_daily_volume and adv_value_base is not None and adv_value_base >= lim.min_avg_dollar_volume_base
        check("avg_volume", vol_ok,
              f"20d avg {ms['adv_shares']:,.0f} sh/day (min {lim.min_avg_daily_volume:,}), "
              + (f"{adv_value_base:,.0f} {ctx.base_currency}/day (min {lim.min_avg_dollar_volume_base:,.0f})" if adv_value_base is not None else f"no FX rate for {intent.currency}"))
        calm = ms["volatility_pct"] <= lim.max_volatility_pct and ms["atr_pct"] <= lim.max_atr_pct
        check("volatility", calm,
              f"20d realized vol {ms['volatility_pct']:.1f}% (max {lim.max_volatility_pct}%), 14d ATR {ms['atr_pct']:.2f}% (max {lim.max_atr_pct}%)")

    # 6c. Signal provenance: external hypotheses (Quantgress disclosures) are context, not a trade reason on their own.
    hyp = [c for c in intent.citations if is_hypothesis_citation(c)]
    if hyp and lim.require_corroboration:
        corroborated = len(intent.citations) > len(hyp)
        check("signal_provenance", corroborated,
              f"{len(hyp)} external-hypothesis citation(s) " + ("plus market telemetry" if corroborated else "and NO telemetry citation — a disclosure alone is not a trade reason"))

    # 6d. Options: defined risk, DTE window, per-leg liquidity, option line count.
    olim = ctx.option_limits
    if intent.is_option:
        _option_checks(intent, ctx, olim, check)

    # 7-8. Size: risk per trade and per-order notional (may MODIFY quantity down)
    qty = intent.quantity
    risk_base = notional_base = None
    sizing_ok = False
    if equity is None or equity <= 0 or not fx or entry is None or (intent.is_option and olim is None):
        check("position_size", False, "can't size: " + ("no FX rate for " + intent.currency if not fx else "option limits unavailable" if intent.is_option and olim is None else "equity or entry price unknown"))
    else:
        alloc = lim.financer_allocation_base
        eq_used = min(equity, alloc) if alloc else equity
        if intent.is_option:
            # Defined risk: the whole debit is the worst case, whatever the stop says.
            per_share = entry * intent.multiplier * fx
            risk_cap = min(olim.max_premium_pct / 100 * eq_used, olim.max_premium_base)
            notional_cap = risk_cap
            max_by_notional = math.floor(notional_cap / per_share) if per_share > 0 else 0
        else:
            per_share = abs(entry - intent.stop_loss) * fx
            risk_cap = min(lim.max_risk_per_trade_pct / 100 * eq_used, lim.max_risk_per_trade_base)
            notional_cap = lim.max_position_pct / 100 * eq_used
            max_by_notional = math.floor(notional_cap / (entry * fx))
        max_by_risk = math.floor(risk_cap / per_share) if per_share > 0 else 0
        qty = min(intent.quantity, max_by_risk, max_by_notional)
        risk_base = qty * per_share
        notional_base = qty * per_share if intent.is_option else qty * entry * fx
        sizing_ok = qty >= 1
        if not sizing_ok:
            check("position_size", False, f"even 1 {'contract' if intent.is_option else 'share'} breaches caps (risk cap {risk_cap:.2f}, notional cap {notional_cap:.2f} {ctx.base_currency})")
        elif qty < intent.quantity:
            check("position_size", True, f"cut {intent.quantity}→{qty}: risk {risk_base:.2f}/{risk_cap:.2f}, notional {notional_base:.2f}/{notional_cap:.2f} {ctx.base_currency}")
        else:
            check("position_size", True, f"risk {risk_base:.2f}/{risk_cap:.2f}, notional {notional_base:.2f}/{notional_cap:.2f} {ctx.base_currency}")

        # 9. Concurrent positions (adding to / reducing an existing line doesn't open a new one)
        held = {p["underlying"] or p["symbol"] for p in ctx.positions if p.get("position")}
        pending = {o["symbol"] for o in ctx.open_orders} - held
        opens_new = intent.symbol not in held and intent.symbol not in pending
        n = len(held) + len(pending)
        check("concurrent_positions", not opens_new or n < lim.max_concurrent_positions,
              f"{n} open/pending lines (max {lim.max_concurrent_positions})")

        # 10. Gross exposure incl. working orders
        def base(v: float | None, cur: str) -> float:
            r = 1.0 if cur == ctx.base_currency else ctx.fx_to_base.get(cur)
            return abs(v or 0) * (r or math.inf)  # unknown FX → infinite exposure → fail closed

        gross = sum(base(p.get("marketValue"), p.get("currency", "")) for p in ctx.positions)
        gross += sum(base((o.get("remaining") or 0) * (o.get("limitPrice") or 0), o.get("currency", "")) for o in ctx.open_orders)
        cap = lim.max_gross_exposure_pct / 100 * eq_used
        check("gross_exposure", gross + notional_base <= cap, f"{gross + notional_base:.2f} incl. this order (max {cap:.2f} {ctx.base_currency})")

    failed = [c for c in checks if not c["ok"]]
    if failed:
        verdict = REJECTED
    elif sizing_ok and qty < intent.quantity:
        verdict = MODIFIED
    else:
        verdict = APPROVED
    return Decision(verdict, intent.intent_id, qty if verdict != REJECTED else 0, intent.quantity, checks, trip, entry, risk_base, notional_base)


def _option_checks(intent: OrderIntent, ctx: Context, olim: Any, check: Any) -> None:
    """Engine B rules on top of the common checks. olim is options.OptionLimits (None → fail closed)."""
    if olim is None:
        check("option_rules", False, "option limits unavailable")
        return
    from options import dte as _dte

    days = _dte(intent.expiry, ctx.now)
    check("option_dte", olim.min_dte <= days <= olim.max_dte, f"{days} DTE (window {olim.min_dte}-{olim.max_dte})")
    # Schema already refuses naked/credit structures; re-assert here so the gate never trusts a caller.
    long_first = intent.legs and intent.legs[0]["action"] == "BUY" and intent.action == "BUY"
    defined = long_first and (len(intent.legs) == 1 or (len(intent.legs) == 2 and intent.legs[1]["action"] == "SELL"))
    check("defined_risk", bool(defined), "long option or debit vertical" if defined else "undefined-risk structure")
    legs = ctx.option_legs or []
    if len(legs) != len(intent.legs):
        check("option_liquidity", False, "per-leg quotes missing")
    else:
        bad = []
        for spec, q in zip(intent.legs, legs):
            name = f"{spec['right']}{spec['strike']:g}"
            if (q.get("openInterest") or 0) < olim.min_open_interest:
                bad.append(f"{name} OI {q.get('openInterest')}")
            if (q.get("volume") or 0) < olim.min_volume:
                bad.append(f"{name} vol {q.get('volume')}")
            b, a = q.get("bid"), q.get("ask")
            if not (b is not None and a and a >= b) or (a - b) / ((a + b) / 2) * 100 > olim.max_spread_pct:
                bad.append(f"{name} spread")
        check("option_liquidity", not bad, "; ".join(bad) if bad else f"OI ≥ {olim.min_open_interest}, vol ≥ {olim.min_volume}, spreads ≤ {olim.max_spread_pct}% per leg")
    lines = {(p.get("underlying") or p.get("symbol"), p.get("secType")) for p in ctx.positions if p.get("position") and p.get("secType") in ("OPT", "BAG")}
    pending = {(o.get("symbol"), o.get("secType")) for o in ctx.open_orders if o.get("secType") in ("OPT", "BAG")}
    n = len(lines | pending)
    check("option_positions", n < olim.max_option_positions, f"{n} open/pending option lines (max {olim.max_option_positions})")
