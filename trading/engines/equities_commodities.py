"""Engine A — equities, index ETFs and commodity ETFs.

Universe: core index ETFs (SPY, QQQ, IWM) + commodity ETF proxies (GLD, SLV,
USO, UNG, DBC) + a dynamic watchlist. Additions (from the Trading Agent, a
Quantgress/RAG catalyst, or you) must pass a liquidity prefilter here, and every
intent still faces the Security Detail's own liquidity, volume and volatility
checks.

Signal (deterministic, explainable — the LLM agent proposes, this engine only
executes a rule): `trend_breakout` = close > SMA20 > SMA50, close at a new
20-session high, relative volume >= 1.2. Entry is a marketable LMT at the ask;
stop = entry - 2*ATR14, target = entry + 3*ATR14 (1.5R). Long only by default.

Contract resolver: STK on SMART for everything in this build. Futures roots
(ES, NQ, CL, GC, …) are recognised and refused until a futures resolver with
its own caps is switched on.
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable

from engines.common import atr, clean_bars, intent_id, ny_day, qty_for_risk, sma

CORE = ("SPY", "QQQ", "IWM")
COMMODITIES = ("GLD", "SLV", "USO", "UNG", "DBC")
FUTURES_ROOTS = {"ES", "NQ", "YM", "RTY", "CL", "GC", "SI", "NG", "HG", "ZB", "ZN", "MES", "MNQ"}
SYMBOL_RE = re.compile(r"^[A-Z][A-Z0-9.]{0,9}$")
ASSET_CLASS = {**{s: "etf" for s in CORE}, **{s: "commodity_etf" for s in COMMODITIES}}


class ContractRefused(ValueError):
    pass


def resolve(symbol: str) -> dict[str, str]:
    """Symbol → contract spec for an OrderIntent. Futures are recognised and refused."""
    s = symbol.strip().upper()
    # Only explicit futures notation counts (ESZ6, ESZ26, ES1!, ES=F): bare roots are real
    # stock tickers too (CL = Colgate, ES = Eversource), so "CL" resolves to the stock.
    m = re.match(r"^([A-Z]{1,3})(?:[FGHJKMNQUVXZ]\d{1,2}|\d?!|=F)$", s)
    if m and m.group(1) in FUTURES_ROOTS:
        raise ContractRefused(f"{s}: futures are not enabled (needs a futures resolver with its own caps)")
    if not SYMBOL_RE.match(s):
        raise ContractRefused(f"{symbol!r} is not a valid ticker")
    return {"symbol": s, "sec_type": "STK", "exchange": "SMART", "currency": "USD", "asset_class": ASSET_CLASS.get(s, "etf")}


@dataclass(frozen=True)
class Prefilter:
    min_price: float = 5.0
    min_adv_value_usd: float = 50_000_000.0   # 20-day average dollar volume
    max_spread_pct: float = 0.10


def trend_breakout(bars: list[dict[str, Any]], *, lookback: int = 20, min_rel_volume: float = 1.2) -> dict[str, Any]:
    """Pure signal on daily bars (oldest first). Always returns the metrics; `signal` is True/False."""
    b = clean_bars(bars)
    if len(b) < 55:
        return {"signal": False, "why": f"only {len(b)} usable bars (need 55)"}
    closes = [x["close"] for x in b]
    last = b[-1]
    s20, s50, a14 = sma(closes, 20), sma(closes, 50), atr(b, 14)
    prior_high = max(x["high"] for x in b[-lookback - 1:-1])
    avg_vol = sum(x["volume"] for x in b[-lookback - 1:-1]) / lookback
    rel_vol = last["volume"] / avg_vol if avg_vol > 0 else 0.0
    mom = (last["close"] / b[-lookback - 1]["close"] - 1) * 100
    conds = {
        "trend": last["close"] > s20 > s50,
        "breakout": last["close"] >= prior_high * 0.999,
        "volume": rel_vol >= min_rel_volume,
    }
    return {
        "signal": all(conds.values()), "conditions": conds, "close": last["close"], "date": last["date"],
        "sma20": s20, "sma50": s50, "atr": a14, "priorHigh": prior_high, "relVolume": rel_vol, "momentum20": mom,
        "why": "trend breakout" if all(conds.values()) else "no setup: " + ", ".join(k for k, v in conds.items() if not v),
    }


def build_intent(symbol: str, sig: dict[str, Any], quote: dict[str, Any], *, now: float, risk_budget_base: float, fx: float) -> dict[str, Any] | None:
    """Signal + live quote → raw OrderIntent JSON (bracket). None if there's no tradable price."""
    ask, bid = quote.get("ask"), quote.get("bid")
    if not (ask and bid and ask >= bid > 0) or not sig.get("atr"):
        return None
    spec = resolve(symbol)
    entry = round(ask, 2)
    stop = round(entry - 2 * sig["atr"], 2)
    target = round(entry + 3 * sig["atr"], 2)
    qty = qty_for_risk(risk_budget_base, entry - stop, fx)
    if qty < 1 or stop <= 0:
        return None
    return {
        "intent_id": intent_id("ea", symbol, ny_day(now), "trend_breakout", sig["date"]),
        "source": "engine_a", "asset_class": spec["asset_class"], "symbol": spec["symbol"], "sec_type": "STK",
        "currency": spec["currency"], "action": "BUY", "quantity": qty, "order_type": "LMT",
        "limit_price": entry, "stop_loss": stop, "take_profit": target, "time_in_force": "DAY",
        "thesis": (f"Engine A trend breakout: close {sig['close']:.2f} > SMA20 {sig['sma20']:.2f} > SMA50 {sig['sma50']:.2f}, "
                   f"new {20}-session high (prior {sig['priorHigh']:.2f}), rel. volume {sig['relVolume']:.2f}x. "
                   f"Stop 2xATR ({sig['atr']:.2f}), target 3xATR."),
        "citations": [f"telemetry:{symbol}:daily_bars:{sig['date']}", f"telemetry:{symbol}:quote:{int(now)}", "engine_a:trend_breakout:v1"],
        "created_at": now,
    }


class Watchlist:
    """Dynamic additions, persisted in data/trading/watchlist.json with provenance."""

    def __init__(self, path: Path) -> None:
        self.path = path

    def _load(self) -> list[dict[str, Any]]:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            return data if isinstance(data, list) else []
        except (OSError, ValueError):
            return []

    def _save(self, rows: list[dict[str, Any]]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(rows, indent=2), encoding="utf-8")

    def symbols(self) -> list[str]:
        extra = [r["symbol"] for r in self._load() if r.get("status") == "active"]
        return list(dict.fromkeys([*CORE, *COMMODITIES, *extra]))

    def rows(self) -> list[dict[str, Any]]:
        return self._load()

    def add(self, symbol: str, *, source: str, reason: str, stats: dict[str, Any] | None, quote: dict[str, Any] | None,
            pre: Prefilter = Prefilter(), now: float | None = None) -> dict[str, Any]:
        spec = resolve(symbol)  # raises for futures / junk
        s = spec["symbol"]
        problems = []
        price = (quote or {}).get("ask") or (quote or {}).get("last")
        if not price or price < pre.min_price:
            problems.append(f"price {price} < {pre.min_price}")
        adv = (stats or {}).get("adv_value")
        if adv is None or adv < pre.min_adv_value_usd:
            problems.append(f"avg dollar volume {adv:,.0f} < {pre.min_adv_value_usd:,.0f}" if adv is not None else "no daily bars")
        b, a = (quote or {}).get("bid"), (quote or {}).get("ask")
        sp = (a - b) / ((a + b) / 2) * 100 if b and a and a >= b else None
        if sp is None or sp > pre.max_spread_pct:
            problems.append(f"spread {sp:.3f}% > {pre.max_spread_pct}%" if sp is not None else "no two-sided quote")
        row = {"symbol": s, "source": source[:40], "reason": reason[:300], "addedAt": now or time.time(),
               "status": "rejected" if problems else "active", "problems": problems,
               "advValueUsd": adv, "spreadPct": sp}
        rows = [r for r in self._load() if r["symbol"] != s]
        if s not in CORE and s not in COMMODITIES:
            rows.append(row)
            self._save(rows)
        return row

    def remove(self, symbol: str) -> bool:
        rows = self._load()
        keep = [r for r in rows if r["symbol"] != symbol.upper()]
        self._save(keep)
        return len(keep) != len(rows)


MarketDataLike = Any
SubmitFn = Callable[[dict[str, Any], str], Awaitable[dict[str, Any]]]


class EngineA:
    name = "engine_a"

    def __init__(self, md: MarketDataLike, watchlist: Watchlist, clock: Callable[[], float] = time.time) -> None:
        self.md = md
        self.watchlist = watchlist
        self.clock = clock
        self.last_scan: dict[str, Any] | None = None

    async def scan(self, *, symbols: list[str] | None, risk_budget_base: float, fx_usd: float,
                   submit: SubmitFn | None = None, actor: str = "engine_a") -> dict[str, Any]:
        """Score every symbol; for each live setup build an intent and (if `submit`) send it to the desk."""
        now = self.clock()
        rows = []
        for sym in symbols or self.watchlist.symbols():
            row: dict[str, Any] = {"symbol": sym}
            try:
                bars = await self.md.daily_bars(sym)
                sig = trend_breakout(bars)
                row.update({k: sig.get(k) for k in ("signal", "why", "close", "momentum20", "relVolume", "atr", "date")})
                if sig["signal"]:
                    quote = await self.md.stock_quote(sym)
                    raw = build_intent(sym, sig, quote, now=now, risk_budget_base=risk_budget_base, fx=fx_usd)
                    row["intent"] = raw
                    if raw is None:
                        row["why"] = "setup, but no tradable quote / size"
                    elif submit is not None:
                        res = await submit(raw, actor)
                        row["desk"] = {"status": res.get("status"), "verdict": (res.get("decision") or {}).get("verdict"),
                                       "reasons": (res.get("decision") or {}).get("reasons", []), "error": res.get("error")}
            except Exception as e:  # noqa: BLE001 — one bad symbol never stops the scan
                row.update({"signal": False, "why": f"error: {type(e).__name__}: {e}"})
            rows.append(row)
        rows.sort(key=lambda r: (not r.get("signal"), -(r.get("momentum20") or -1e9)))
        self.last_scan = {"at": now, "rows": rows}
        return self.last_scan
