"""Read-only market data for the engines — its own IBKR client id (12, `data`).

Engines never place orders and never touch the executor; they read bars,
quotes and option chains here and hand OrderIntents to the desk. Everything
returns plain dicts so engine logic stays pure and testable with fakes.

The connection is opened lazily through the same paper-only endpoint gate and
`readonly=True`, and uses the configured market-data type (delayed by default).
"""

from __future__ import annotations

import asyncio
import logging
import math
import time
from typing import Any

from config import load_config, resolve_endpoint

log = logging.getLogger("trading.market_data")

QUOTE_WAIT_S = 12.0  # the first (delayed) subscription after a fresh connect is slow
BAR_CACHE_S = 15 * 60


def _clean(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(f) or math.isinf(f) or f < 0 or f >= 1e300 else f


class MarketData:
    def __init__(self) -> None:
        self.ib: Any = None
        self._lock = asyncio.Lock()
        self._bars: dict[str, tuple[float, list[dict[str, Any]]]] = {}
        self._charts: dict[str, tuple[float, dict[str, Any]]] = {}
        self._chart_lock = asyncio.Lock()

    async def _ensure(self) -> Any:
        async with self._lock:
            if self.ib is not None and self.ib.isConnected():
                return self.ib
            from ib_async import IB

            cfg = load_config()
            ep = resolve_endpoint(cfg)
            if ep.locked or ep.port is None:
                raise ConnectionError("endpoint LOCKED: " + "; ".join(ep.reasons))
            self.ib = IB()
            await self.ib.connectAsync(ep.host, ep.port, clientId=cfg.client_ids["data"], readonly=True, timeout=10)
            self.ib.reqMarketDataType(cfg.market_data_type)
            return self.ib

    def disconnect(self) -> None:
        if self.ib is not None:
            try:
                self.ib.disconnect()
            except Exception:  # noqa: BLE001
                pass
        self.ib = None

    # ── stocks / ETFs ────────────────────────────────────────────────
    async def stock(self, symbol: str, currency: str = "USD") -> Any:
        from ib_async import Stock

        ib = await self._ensure()
        q = await ib.qualifyContractsAsync(Stock(symbol, "SMART", currency))
        if not q or not getattr(q[0], "conId", 0):
            raise LookupError(f"unknown contract {symbol} {currency}")
        return q[0]

    async def daily_bars(self, symbol: str, currency: str = "USD", days: int = 80) -> list[dict[str, Any]]:
        key = f"{symbol}:{currency}:{days}"
        hit = self._bars.get(key)
        if hit and time.time() - hit[0] < BAR_CACHE_S:
            return hit[1]
        ib = await self._ensure()
        c = await self.stock(symbol, currency)
        # IBKR wants "Y" units past a year; "D" requests are capped well below that.
        duration = f"{int(days * 1.5)} D" if days * 1.5 <= 365 else f"{math.ceil(days / 252) + 1} Y"
        bars = await asyncio.wait_for(ib.reqHistoricalDataAsync(c, "", duration, "1 day", "TRADES", useRTH=True, formatDate=1), 60)
        out = [{"date": str(b.date), "open": b.open, "high": b.high, "low": b.low, "close": b.close, "volume": b.volume} for b in bars or []]
        self._bars[key] = (time.time(), out)
        return out

    async def chart_bars(self, symbol: str, interval: str, rng: str) -> dict[str, Any]:
        """Bars for the Command Center "IBKR bars" chart. Yahoo-style inputs (see bars.py);
        raises bars.BarsRefused for what IBKR bars don't cover. Serialised and cached so a
        re-render or a second window never sends an identical request inside IBKR's 15 s pacing."""
        from bars import bar_request, to_candles

        req = bar_request(symbol, interval, rng)
        key = f"{req['symbol']}:{req['currency']}:{req['barSize']}:{req['duration']}"
        async with self._chart_lock:
            hit = self._charts.get(key)
            if hit and time.time() - hit[0] < req["cacheS"]:
                return {**hit[1], "cached": True}
            ib = await self._ensure()
            c = await self.stock(req["symbol"], req["currency"])
            raw = await asyncio.wait_for(
                ib.reqHistoricalDataAsync(c, "", req["duration"], req["barSize"], "TRADES", useRTH=True, formatDate=2), 60)
            candles = to_candles(raw)
            out = {"ok": bool(candles), "symbol": req["symbol"], "currency": req["currency"], "interval": interval,
                   "range": req["range"], "barSize": req["barSize"], "duration": req["duration"], "candles": candles,
                   "fetchedAt": time.time()}
            if not candles:  # ib_async logs the TWS error (e.g. 162 no permissions) and returns []
                out["error"] = "TWS returned no bars (market-data permissions or pacing; see the bridge log)"
                return out
            self._charts[key] = (time.time(), out)
            return out

    async def quote(self, contract: Any) -> dict[str, float | None]:
        ib = await self._ensure()
        t = ib.reqMktData(contract, "", False, False)
        # ib_async reuses one Ticker per contract and cancelMktData doesn't clear it: wipe the previous
        # subscription's values before yielding, so a quote (and its time) only ever reflects THIS request.
        t.bid = t.ask = t.last = t.close = float("nan")
        t.time = None
        try:
            deadline = time.monotonic() + QUOTE_WAIT_S
            while time.monotonic() < deadline:
                await asyncio.sleep(0.2)
                if _clean(t.bid) and _clean(t.ask):
                    break
        finally:
            ib.cancelMktData(contract)
        ts = t.time.timestamp() if getattr(t, "time", None) is not None and hasattr(t.time, "timestamp") else None
        # `time` (epoch s of the last tick received) feeds the pre-trade stale-quote gate; None fails it closed.
        return {"bid": _clean(t.bid), "ask": _clean(t.ask), "last": _clean(t.last), "close": _clean(t.close), "time": ts}

    async def stock_quote(self, symbol: str, currency: str = "USD") -> dict[str, float | None]:
        return await self.quote(await self.stock(symbol, currency))

    # ── options ──────────────────────────────────────────────────────
    async def option_chain(self, symbol: str, currency: str = "USD") -> dict[str, Any]:
        """Expirations and strikes on SMART for the underlying (no quotes)."""
        ib = await self._ensure()
        und = await self.stock(symbol, currency)
        params = await asyncio.wait_for(ib.reqSecDefOptParamsAsync(und.symbol, "", und.secType, und.conId), 20)
        smart = [p for p in params if p.exchange == "SMART"] or list(params)
        if not smart:
            raise LookupError(f"no option chain for {symbol}")
        p = max(smart, key=lambda x: len(x.strikes))
        return {"symbol": symbol, "currency": currency, "tradingClass": p.tradingClass, "multiplier": int(p.multiplier or 100),
                "expirations": sorted(p.expirations), "strikes": sorted(float(s) for s in p.strikes), "underConId": und.conId}

    async def option_quotes(self, symbol: str, currency: str, trading_class: str, multiplier: int,
                            specs: list[tuple[str, float, str]]) -> list[dict[str, Any]]:
        """Quote option contracts [(expiry, strike, right)] → bid/ask/last/volume/OI/delta/iv per contract."""
        from ib_async import Option

        ib = await self._ensure()
        contracts = [Option(symbol, e, k, r, "SMART", tradingClass=trading_class, multiplier=str(multiplier), currency=currency) for e, k, r in specs]
        qualified = [c for c in await ib.qualifyContractsAsync(*contracts) if c and getattr(c, "conId", 0)]
        tickers = [ib.reqMktData(c, "100,101,106", False, False) for c in qualified]
        try:
            deadline = time.monotonic() + QUOTE_WAIT_S
            while time.monotonic() < deadline:
                await asyncio.sleep(0.25)
                if all(_clean(t.bid) is not None and _clean(t.ask) for t in tickers):
                    break
        finally:
            for c in qualified:
                ib.cancelMktData(c)
        rows = []
        for c, t in zip(qualified, tickers):
            g = t.modelGreeks
            oi = t.callOpenInterest if c.right == "C" else t.putOpenInterest
            rows.append({
                "conId": c.conId, "expiry": c.lastTradeDateOrContractMonth, "strike": float(c.strike), "right": c.right,
                "bid": _clean(t.bid), "ask": _clean(t.ask), "last": _clean(t.last),
                "volume": _clean(t.volume), "openInterest": _clean(oi),
                "delta": None if g is None or g.delta is None or math.isnan(g.delta) else float(g.delta),
                "iv": None if g is None or g.impliedVol is None or math.isnan(g.impliedVol) else float(g.impliedVol),
                "undPrice": None if g is None else _clean(g.undPrice),
            })
        return rows
