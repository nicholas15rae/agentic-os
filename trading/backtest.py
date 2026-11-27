"""Engine R's evaluation: a deterministic daily-bar simulator, the chronological 70/30 split and
the report Nic reads before approving a rule change. Pure functions, no I/O, CPU only.

Anti-overfitting contract
  * Trades are ordered by entry date. The CUTOFF is the entry date of the trade at the 70% mark of
    the ACTIVE rule's full trade list (outcomes are not used to place it). Older trades = BUILD set,
    the newest ~30% = TEST set.
  * BUILD numbers come from a simulation that is only given bars dated before the cutoff, so a
    trade still open at the cutoff never resolves with test-period prices: nothing after the cutoff
    can shape what is built or tuned.
  * TEST numbers are the trades that ENTER on or after the cutoff. They are reported next to the
    build numbers and are never fed to the analyst.
  * A proposed change is scored against the SAME cutoff as the active rule, so a candidate can't
    move the holdout boundary to flatter itself.

Simulation (mirrors the live engine): the signal is evaluated on each session's completed daily bar
and the entry fills at that close (+ slippage); the bracket is stop = entry - stop_atr_mult x ATR and
take-profit = entry + target_atr_mult x ATR, both GTC. Each later bar: a low through the stop exits
at the stop (or the open on a gap down, minus slippage); a high through the target exits at the
target (or the open on a gap up). A bar that touches both counts as a STOP (conservative). The hard
limits' max_open_positions and max_trades_per_day apply across symbols, in symbol order.

Metrics per set: trades, wins, losses, win rate, average win / loss (R multiples and % price move),
expectancy, total R, and max drawdown of the cumulative-R curve (also in % of equity, assuming each
trade risks risk_per_trade_pct of equity, additively).
"""

from __future__ import annotations

import math
from typing import Any

from engines.common import clean_bars

BUILD_FRAC = 0.7
SLIPPAGE_BPS = 5.0
MIN_MEANINGFUL = 20


def norm_date(s: Any) -> str:
    """IBKR daily bars come as '2026-11-24' or '20261124'; compare them as ISO dates."""
    s = str(s or "").strip()[:10]
    if len(s) >= 8 and s[:8].isdigit():
        return f"{s[:4]}-{s[4:6]}-{s[6:8]}"
    return s


def prepare(bars_by_symbol: dict[str, list[dict[str, Any]]], until: str | None = None) -> dict[str, list[dict[str, Any]]]:
    out = {}
    for sym, bars in bars_by_symbol.items():
        b = []
        for x in clean_bars(bars):
            x = {**x, "date": norm_date(x["date"])}
            if until is None or x["date"] < until:
                b.append(x)
        b.sort(key=lambda x: x["date"])
        dedup = {x["date"]: x for x in b}  # a re-fetched bar replaces the cached one
        out[sym] = [dedup[k] for k in sorted(dedup)]
    return out


def simulate(bars_by_symbol: dict[str, list[dict[str, Any]]], params: dict[str, Any], *, max_open: int, max_per_day: int,
             until: str | None = None, slippage_bps: float = SLIPPAGE_BPS) -> dict[str, Any]:
    """Closed trades (oldest entry first) + the positions still open at the end of the data."""
    from rule_engine import signal_at  # the live engine's own signal: one definition for both

    data = prepare(bars_by_symbol, until)
    index = {s: {b["date"]: i for i, b in enumerate(bs)} for s, bs in data.items()}
    dates = sorted({b["date"] for bs in data.values() for b in bs})
    disabled = set(params.get("disabled_symbols") or [])
    slip = slippage_bps / 10_000
    open_pos: dict[str, dict[str, Any]] = {}
    trades: list[dict[str, Any]] = []
    for d in dates:
        # 1. Exits on today's bar for positions opened before today.
        for sym in sorted(open_pos):
            i = index[sym].get(d)
            if i is None:
                continue
            p = open_pos[sym]
            bar = data[sym][i]
            exit_px = reason = None
            if bar["low"] <= p["stop"]:
                exit_px, reason = min(bar["open"], p["stop"]) * (1 - slip), "stop_loss"
            elif bar["high"] >= p["target"]:
                exit_px, reason = max(bar["open"], p["target"]), "take_profit"
            if exit_px is not None:
                risk = p["entry"] - p["stop"]
                trades.append({**p, "exitDate": d, "exit": round(exit_px, 4), "exitReason": reason, "barsHeld": i - p["entryIndex"],
                               "r": round((exit_px - p["entry"]) / risk, 4) if risk > 0 else 0.0,
                               "retPct": round((exit_px / p["entry"] - 1) * 100, 4)})
                del open_pos[sym]
        # 2. Entries at today's close.
        entered = 0
        for sym in sorted(data):
            if sym in disabled or sym in open_pos:
                continue
            if len(open_pos) >= max_open or entered >= max_per_day:
                break
            i = index[sym].get(d)
            if i is None:
                continue
            sig = signal_at(data[sym], i, params)
            if not sig["signal"]:
                continue
            entry = data[sym][i]["close"] * (1 + slip)
            stop = entry - params["stop_atr_mult"] * sig["atr"]
            if stop <= 0:
                continue
            open_pos[sym] = {"symbol": sym, "entryDate": d, "entryIndex": i, "entry": round(entry, 4), "stop": round(stop, 4),
                             "target": round(entry + params["target_atr_mult"] * sig["atr"], 4),
                             "features": {k: round(sig[k], 4) for k in ("relVolume", "atrPct", "momentum")}}
            entered += 1
    for t in trades:
        t.pop("entryIndex", None)
    trades.sort(key=lambda t: (t["entryDate"], t["symbol"]))
    return {"trades": trades, "open": [{k: v for k, v in p.items() if k != "entryIndex"} for p in open_pos.values()],
            "range": {"from": dates[0] if dates else None, "to": dates[-1] if dates else None}, "symbols": sorted(data)}


def cutoff_for(trades: list[dict[str, Any]], frac: float = BUILD_FRAC) -> str | None:
    """Entry date of the first TEST trade: the trade at the frac mark (by count, oldest first). There is always
    at least one test trade, so a lone (newest) trade is held out rather than built on. None = no trades."""
    n = len(trades)
    if n == 0:
        return None
    if n == 1:
        return trades[0]["entryDate"]
    k = min(max(1, math.floor(n * frac)), n - 1)
    return sorted(t["entryDate"] for t in trades)[k]


def split(trades: list[dict[str, Any]], cutoff: str | None) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if cutoff is None:
        return list(trades), []
    return [t for t in trades if t["entryDate"] < cutoff], [t for t in trades if t["entryDate"] >= cutoff]


def _std(xs: list[float]) -> float | None:
    if len(xs) < 2:
        return None
    m = sum(xs) / len(xs)
    return round(math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1)), 4)


def metrics(trades: list[dict[str, Any]], risk_pct: float) -> dict[str, Any]:
    n = len(trades)
    wins = [t for t in trades if t["r"] > 0]
    losses = [t for t in trades if t["r"] < 0]

    def avg(xs: list[float]) -> float | None:
        return round(sum(xs) / len(xs), 4) if xs else None

    peak = cum = dd = 0.0
    for t in sorted(trades, key=lambda t: (t.get("exitDate") or "", t["entryDate"], t["symbol"])):
        cum += t["r"]
        peak = max(peak, cum)
        dd = max(dd, peak - cum)
    return {
        "trades": n, "wins": len(wins), "losses": len(losses),
        "winRate": round(len(wins) / n, 4) if n else None,
        "avgWinR": avg([t["r"] for t in wins]), "avgLossR": avg([t["r"] for t in losses]),
        "avgWinPct": avg([t["retPct"] for t in wins]), "avgLossPct": avg([t["retPct"] for t in losses]),
        "expectancyR": avg([t["r"] for t in trades]), "totalR": round(sum(t["r"] for t in trades), 4),
        # Sample standard deviation of R (display only: the track record's 95% expectancy interval).
        "stdR": _std([t["r"] for t in trades]),
        "maxDrawdownR": round(dd, 4), "maxDrawdownPct": round(dd * risk_pct, 4),
        "from": min((t["entryDate"] for t in trades), default=None), "to": max((t["entryDate"] for t in trades), default=None),
        "note": None if n >= MIN_MEANINGFUL else f"only {n} trade(s): too few to judge",
    }


def evaluate(bars_by_symbol: dict[str, list[dict[str, Any]]], params: dict[str, Any], *, max_open: int, max_per_day: int,
             cutoff: str | None = None) -> dict[str, Any]:
    """Build / test report for one parameter set. `cutoff` None = place it from these trades."""
    kw = {"max_open": max_open, "max_per_day": max_per_day}
    full = simulate(bars_by_symbol, params, **kw)
    cutoff = cutoff or cutoff_for(full["trades"])
    build = simulate(bars_by_symbol, params, until=cutoff, **kw)["trades"] if cutoff else full["trades"]
    _, test = split(full["trades"], cutoff)
    risk = params.get("risk_per_trade_pct", 0.25)
    return {"cutoff": cutoff, "range": full["range"], "symbols": full["symbols"], "openAtEnd": len(full["open"]),
            "build": metrics(build, risk), "test": metrics(test, risk), "buildTrades": build, "testTrades": test}


def compare(bars_by_symbol: dict[str, list[dict[str, Any]]], current: dict[str, Any], proposed: dict[str, Any], *,
            max_open: int, max_per_day: int) -> dict[str, Any]:
    """Score a proposed parameter set against the active one, on the active rule's cutoff."""
    cur = evaluate(bars_by_symbol, current, max_open=max_open, max_per_day=max_per_day)
    new = evaluate(bars_by_symbol, proposed, max_open=max_open, max_per_day=max_per_day, cutoff=cur["cutoff"])
    strip = lambda r: {k: v for k, v in r.items() if k not in ("buildTrades", "testTrades")}  # noqa: E731
    verdict = _verdict(cur, new)
    return {"cutoff": cur["cutoff"], "range": cur["range"], "current": strip(cur), "proposed": strip(new), "verdict": verdict}


def _verdict(cur: dict[str, Any], new: dict[str, Any]) -> dict[str, Any]:
    """A plain-language flag for Nic. Never applied automatically: it only describes the numbers."""
    cb, ct, nb, nt = cur["build"], cur["test"], new["build"], new["test"]
    notes = []
    if (nt["trades"] or 0) < MIN_MEANINGFUL:
        notes.append(f"test set has {nt['trades']} trade(s): too few to trust either way")
    better_build = (nb["expectancyR"] or -9) > (cb["expectancyR"] or -9)
    better_test = (nt["expectancyR"] or -9) > (ct["expectancyR"] or -9)
    if better_build and not better_test:
        notes.append("better on the build set but NOT on the unseen test set: likely overfit")
    if better_test and nt["maxDrawdownR"] > ct["maxDrawdownR"] * 1.25 + 0.5:
        notes.append("higher test-set drawdown")
    label = "improves_out_of_sample" if better_build and better_test else "worse_out_of_sample" if not better_test else "mixed"
    return {"label": label, "notes": notes}


def paper_trades(journal: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Closed paper trades from the desk journal (Engine R's only), in the simulator's trade shape."""
    from datetime import datetime
    from zoneinfo import ZoneInfo

    ny = ZoneInfo("America/New_York")
    out = []
    for j in journal:
        if j.get("source") != "rule_engine" or j.get("rMultiple") is None or not j.get("entryPrice"):
            continue
        out.append({"symbol": j["symbol"], "entryDate": datetime.fromtimestamp(j["openedAt"], ny).strftime("%Y-%m-%d"),
                    "exitDate": datetime.fromtimestamp(j["closedAt"], ny).strftime("%Y-%m-%d"), "entry": j["entryPrice"],
                    "exit": j["exitPrice"], "exitReason": j.get("exitReason"), "r": round(float(j["rMultiple"]), 4),
                    "retPct": round((j["exitPrice"] / j["entryPrice"] - 1) * 100, 4), "pnl": j.get("pnl"), "intentId": j.get("intentId")})
    out.sort(key=lambda t: (t["entryDate"], t["symbol"]))
    return out


def paper_report(journal: list[dict[str, Any]], risk_pct: float) -> dict[str, Any]:
    trades = paper_trades(journal)
    cutoff = cutoff_for(trades)
    build, test = split(trades, cutoff)
    return {"cutoff": cutoff, "build": metrics(build, risk_pct), "test": metrics(test, risk_pct)}


def breakdown(trades: list[dict[str, Any]]) -> dict[str, Any]:
    """Grouped stats for the analyst's BUILD-set view: by symbol, exit reason and entry-feature bucket."""
    def group(key) -> dict[str, dict[str, Any]]:
        g: dict[str, list[float]] = {}
        for t in trades:
            g.setdefault(key(t), []).append(t["r"])
        return {k: {"trades": len(v), "winRate": round(sum(1 for r in v if r > 0) / len(v), 3), "avgR": round(sum(v) / len(v), 3)}
                for k, v in sorted(g.items())}

    def bucket(v: float | None, edges: tuple[float, ...]) -> str:
        if v is None:
            return "n/a"
        for e in edges:
            if v < e:
                return f"<{e:g}"
        return f">={edges[-1]:g}"

    feat = lambda t, k: (t.get("features") or {}).get(k)  # noqa: E731
    return {"bySymbol": group(lambda t: t["symbol"]), "byExit": group(lambda t: t.get("exitReason") or "?"),
            "byRelVolume": group(lambda t: bucket(feat(t, "relVolume"), (1.5, 2.0, 3.0))),
            "byAtrPct": group(lambda t: bucket(feat(t, "atrPct"), (1.0, 2.0, 3.0))),
            "byMomentum20Pct": group(lambda t: bucket(feat(t, "momentum"), (2.0, 5.0, 10.0)))}
