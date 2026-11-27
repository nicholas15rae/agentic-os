"""Engine R track record vs. its backtest: a READ-ONLY report (Section 14.6). Stdlib only, pure.

Puts the PAPER journal (Engine R's closed paper trades) next to the backtest's build and test
splits and an SPY buy-and-hold baseline over the same periods, and flags drift:

  * n < MIN_PAPER paper trades          -> "too few paper trades to judge"
  * paper expectancy outside the TEST split's 95% interval for expectancy
    (test mean +/- 1.96 x stdR / sqrt(n_test))  -> "drift" (above or below)
  * otherwise                           -> "within"

It also shows progress toward GOAL_TRADES paper trades with positive expectancy as an
INFORMATION line only. Nothing here is wired to a desk mode, gate, limit or order path, and nothing
is written anywhere: the gateway loads this file by path and returns the dict.

Inputs are what the bridge already serves: GET /rules/evaluation (the last 70/30 report),
GET /intel/journal (closed paper trades) and Engine R's cached SPY daily bars (bars_cache/SPY.json).
"""

from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Any

MIN_PAPER = 20        # below this many paper trades the comparison is not judged
GOAL_TRADES = 100     # information line: 100+ paper trades with positive expectancy
Z95 = 1.96

try:
    from zoneinfo import ZoneInfo

    _NY: Any = ZoneInfo("America/New_York")
except Exception:  # noqa: BLE001 — no tz database: dates fall back to UTC
    _NY = timezone.utc


def norm_date(s: Any) -> str:
    """'2026-11-24' or '20261124' (IBKR) -> '2026-11-24'. Same rule as backtest.norm_date."""
    s = str(s or "").strip()[:10]
    if len(s) >= 8 and s[:8].isdigit():
        return f"{s[:4]}-{s[4:6]}-{s[6:8]}"
    return s


def _day(ts: Any) -> str | None:
    try:
        return datetime.fromtimestamp(float(ts), _NY).strftime("%Y-%m-%d")
    except (TypeError, ValueError, OverflowError, OSError):
        return None


def paper_trades(journal: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Engine R's closed paper trades (same filter as backtest.paper_trades), oldest entry first."""
    out = []
    for j in journal or []:
        if j.get("source") != "rule_engine" or j.get("rMultiple") is None or not j.get("entryPrice"):
            continue
        try:
            r = float(j["rMultiple"])
        except (TypeError, ValueError):
            continue
        if not math.isfinite(r):
            continue
        out.append({"symbol": j.get("symbol"), "entryDate": _day(j.get("openedAt")), "exitDate": _day(j.get("closedAt")),
                    "r": round(r, 4), "intentId": j.get("intentId")})
    out.sort(key=lambda t: (t["entryDate"] or "", t["symbol"] or ""))
    return out


def _std(xs: list[float]) -> float | None:
    if len(xs) < 2:
        return None
    m = sum(xs) / len(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1))


def summary(trades: list[dict[str, Any]], risk_pct: float | None) -> dict[str, Any]:
    """count, win rate, expectancy (= mean R), avg win / loss R, total R, max drawdown in R."""
    n = len(trades)
    rs = [t["r"] for t in trades]
    wins = [r for r in rs if r > 0]
    losses = [r for r in rs if r < 0]
    peak = cum = dd = 0.0
    for t in sorted(trades, key=lambda t: (t.get("exitDate") or "", t.get("entryDate") or "")):
        cum += t["r"]
        peak = max(peak, cum)
        dd = max(dd, peak - cum)
    total = sum(rs)
    sd = _std(rs)
    rnd = lambda v: None if v is None else round(v, 4)  # noqa: E731
    return {"trades": n, "wins": len(wins), "losses": len(losses),
            "winRate": rnd(len(wins) / n) if n else None,
            "expectancyR": rnd(total / n) if n else None,
            "avgWinR": rnd(sum(wins) / len(wins)) if wins else None, "avgLossR": rnd(sum(losses) / len(losses)) if losses else None,
            "totalR": round(total, 4), "stdR": rnd(sd), "maxDrawdownR": round(dd, 4),
            "pctEquity": round(total * risk_pct, 4) if risk_pct is not None else None,
            "from": min((t["entryDate"] for t in trades if t["entryDate"]), default=None),
            "to": max((t["exitDate"] for t in trades if t["exitDate"]), default=None)}


def expectancy_interval(m: dict[str, Any] | None) -> dict[str, Any] | None:
    """95% interval for a split's expectancy from backtest.metrics(). Uses stdR when the report has it,
    else approximates the spread from the win / loss averages (flagged approx: within-group spread is ignored)."""
    if not m:
        return None
    n, mean = m.get("trades") or 0, m.get("expectancyR")
    if n < 2 or mean is None:
        return None
    sd, approx = m.get("stdR"), False
    if sd is None:
        pw, pl = (m.get("wins") or 0) / n, (m.get("losses") or 0) / n
        aw, al = m.get("avgWinR") or 0.0, m.get("avgLossR") or 0.0
        var = max(0.0, pw * aw * aw + pl * al * al - mean * mean) * n / (n - 1)
        sd, approx = math.sqrt(var), True
    half = Z95 * sd / math.sqrt(n)
    return {"low": round(mean - half, 4), "high": round(mean + half, 4), "mean": mean, "n": n, "stdR": round(sd, 4), "approx": approx}


def spy_buy_hold(bars: list[dict[str, Any]], start: str | None, end: str | None) -> dict[str, Any] | None:
    """SPY bought at the close of the first session on/after `start`, held to the close of the last session
    on/before `end`. None when there is no period; {'retPct': None, 'why'} when the bars don't cover it."""
    if not start or not end:
        return None
    closes = []
    for b in bars or []:
        try:
            c = float(b.get("close"))
        except (TypeError, ValueError):
            continue
        if math.isfinite(c) and c > 0:
            closes.append((norm_date(b.get("date")), c))
    closes.sort()
    base = {"from": start, "to": end}
    if not closes:
        return {**base, "retPct": None, "why": "no cached SPY daily bars"}
    if closes[0][0] > start:
        return {**base, "retPct": None, "why": f"cached SPY bars start {closes[0][0]}, after {start}"}
    buy = next((x for x in closes if x[0] >= start), None)
    sell = next((x for x in reversed(closes) if x[0] <= end), None)
    if buy is None or sell is None or sell[0] < buy[0]:
        return {**base, "retPct": None, "why": f"cached SPY bars end {closes[-1][0]}, before {start}"}
    return {**base, "buyDate": buy[0], "sellDate": sell[0], "retPct": round((sell[1] / buy[1] - 1) * 100, 4),
            "partial": sell[0] < end}


def _split(m: dict[str, Any] | None, risk_pct: float | None) -> dict[str, Any] | None:
    if not m:
        return None
    keep = ("trades", "wins", "losses", "winRate", "expectancyR", "avgWinR", "avgLossR", "totalR", "stdR", "maxDrawdownR", "from", "to", "note")
    out = {k: m.get(k) for k in keep}
    out["pctEquity"] = round((m.get("totalR") or 0.0) * risk_pct, 4) if risk_pct is not None and m.get("totalR") is not None else None
    return out


def drift(paper: dict[str, Any], test: dict[str, Any] | None) -> dict[str, Any]:
    n, e = paper["trades"], paper["expectancyR"]
    iv = expectancy_interval(test)
    base = {"paperTrades": n, "paperExpectancyR": e, "interval": iv, "minPaper": MIN_PAPER}
    if n < MIN_PAPER:
        return {**base, "status": "too_few", "message": f"too few paper trades to judge ({n} of {MIN_PAPER} needed)"}
    if iv is None:
        return {**base, "status": "no_test", "message": "the backtest's test split has too few trades for a 95% interval"}
    approx = " (interval approximated from win/loss averages)" if iv["approx"] else ""
    if e < iv["low"]:
        return {**base, "status": "below", "message": f"DRIFT: paper expectancy {e:+.2f}R is below the test split's 95% interval "
                                                      f"[{iv['low']:+.2f}, {iv['high']:+.2f}]R{approx}"}
    if e > iv["high"]:
        return {**base, "status": "above", "message": f"DRIFT: paper expectancy {e:+.2f}R is above the test split's 95% interval "
                                                      f"[{iv['low']:+.2f}, {iv['high']:+.2f}]R{approx}"}
    return {**base, "status": "within", "message": f"paper expectancy {e:+.2f}R is within the test split's 95% interval "
                                                   f"[{iv['low']:+.2f}, {iv['high']:+.2f}]R{approx}"}


def goal(paper: dict[str, Any]) -> dict[str, Any]:
    """Information only. Not a gate: no mode, limit or order path reads this."""
    n, e = paper["trades"], paper["expectancyR"]
    positive = e is not None and e > 0
    met = n >= GOAL_TRADES and positive
    exp = "no expectancy yet" if e is None else f"expectancy {e:+.2f}R ({'positive' if positive else 'not positive'})"
    return {"target": GOAL_TRADES, "trades": n, "expectancyR": e, "positive": positive, "met": met, "informationOnly": True,
            "text": f"{min(n, GOAL_TRADES)}/{GOAL_TRADES} paper trades, {exp}"
                    + (" - milestone reached (information only)" if met else " (information only)")}


def report(evaluation: dict[str, Any] | None, journal: list[dict[str, Any]], spy_bars: list[dict[str, Any]], *,
           now: float, journal_limit: int | None = None) -> dict[str, Any]:
    ev = evaluation if isinstance(evaluation, dict) and evaluation.get("at") else None
    bt = (ev or {}).get("backtest") or {}
    params = (ev or {}).get("params") or {}
    risk = params.get("risk_per_trade_pct")
    risk = float(risk) if isinstance(risk, (int, float)) else None
    trades = paper_trades(journal)
    paper = summary(trades, risk)
    build, test = _split(bt.get("build"), risk), _split(bt.get("test"), risk)
    notes = []
    if ev is None:
        notes.append((evaluation or {}).get("note") or "no 70/30 evaluation yet: the backtest columns are empty")
    if journal_limit is not None and len(journal or []) >= journal_limit:
        notes.append(f"paper record uses the newest {journal_limit} journal records")
    return {
        "at": now, "evaluationAt": (ev or {}).get("at"), "version": (ev or {}).get("version"), "cutoff": bt.get("cutoff"),
        "riskPerTradePct": risk,
        "paper": paper, "build": build, "test": test,
        "spy": {"paper": spy_buy_hold(spy_bars, paper["from"], paper["to"]),
                "build": spy_buy_hold(spy_bars, (build or {}).get("from"), (bt.get("cutoff") or (build or {}).get("to"))),
                "test": spy_buy_hold(spy_bars, (test or {}).get("from"), (bt.get("range") or {}).get("to") or (test or {}).get("to"))},
        "drift": drift(paper, bt.get("test")),
        "goal": goal(paper),
        "notes": notes,
        "readOnly": True,
    }
