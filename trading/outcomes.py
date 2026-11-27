"""Outcome tracking: score every Discord call against what price actually did next.

For a call (ticker + bullish/bearish) posted at time t:
  reference = close of the last session that had CLOSED before t (no look-ahead:
              a call posted at 11:00 is not credited with that morning's move)
  exit(h)   = close h sessions later, for h in HORIZONS (1, 5, 20 sessions)
  return    = (exit / reference - 1) * 100, sign-flipped for bearish calls
  hit       = return > HIT_THRESHOLD_PCT (beating noise, not just > 0)

The leaderboard ranks authors and channels by a SHRUNK hit rate:
(hits + PRIOR_WEIGHT * 0.5) / (calls + PRIOR_WEIGHT) — a coin-flip prior, so
three lucky calls don't turn someone into a guru. The Trading Agent sees these
numbers next to every Discord hypothesis it is given.

Displayed rankings need a real sample: a source is RANKED only once it has
MIN_SCORED (30) scored calls, by the lower bound of its 95% Wilson interval;
smaller samples are listed after the ranking as "not enough calls yet".
Scores are context only: nothing here turns a call into a trade.
"""

from __future__ import annotations

import logging
import math
import statistics
import time
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo

log = logging.getLogger("trading.outcomes")

HORIZONS = (1, 5, 20)
HIT_THRESHOLD_PCT = 0.25
PRIOR_WEIGHT = 10
MIN_SCORED = 30     # scored calls before an author / channel / desk source is RANKED (fewer: "not enough calls yet")
WILSON_Z = 1.96     # 95% Wilson score interval
NY = ZoneInfo("America/New_York")
SESSION_CLOSE = (16, 0)


def _session_close_ms(day: str) -> int:
    """'2026-11-20' or '20261120' → that day's 16:00 New York close, as UTC ms."""
    d = day.replace("-", "")[:8]
    dt = datetime(int(d[:4]), int(d[4:6]), int(d[6:8]), *SESSION_CLOSE, tzinfo=NY)
    return int(dt.timestamp() * 1000)


def score_call(bars: list[dict[str, Any]], ts_ms: int, direction: str, horizons: tuple[int, ...] = HORIZONS) -> dict[int, dict[str, Any]]:
    """Pure. bars: daily, oldest first, each {date, close}. Returns {horizon: {ref, exit, ret, hit}} for horizons with data."""
    if direction not in ("bullish", "bearish"):
        return {}
    closes = [(_session_close_ms(str(b["date"])), float(b["close"])) for b in bars if b.get("close") and math.isfinite(float(b["close"]))]
    closes.sort()
    ref_idx = None
    for i, (t, _) in enumerate(closes):
        if t <= ts_ms:
            ref_idx = i
        else:
            break
    if ref_idx is None:
        return {}
    ref = closes[ref_idx][1]
    sign = 1 if direction == "bullish" else -1
    out = {}
    for h in horizons:
        j = ref_idx + h
        if j >= len(closes):
            continue
        exit_px = closes[j][1]
        ret = (exit_px / ref - 1) * 100 * sign
        out[h] = {"ref": ref, "exit": exit_px, "ret": round(ret, 4), "hit": int(ret > HIT_THRESHOLD_PCT)}
    return out


def wilson(hits: int, n: int, z: float = WILSON_Z) -> tuple[float, float]:
    """95% Wilson score interval for a hit rate (hits / n). (0, 1) when n == 0."""
    if n <= 0:
        return 0.0, 1.0
    p = hits / n
    den = 1 + z * z / n
    mid = (p + z * z / (2 * n)) / den
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return max(0.0, mid - half), min(1.0, mid + half)


def leaderboard(rows: list[dict[str, Any]], *, horizon: int = 5, by: str = "author", min_calls: int = 3,
                min_scored: int = MIN_SCORED) -> list[dict[str, Any]]:
    """rows from DiscordStore.outcome_rows(). by = 'author' | 'channel'.

    min_calls is only the floor for being LISTED; min_scored (MIN_SCORED = 30) is the floor for being
    RANKED. Every row carries its sample size, a 95% Wilson band (wilsonLow / wilsonHigh) and
    `ranked`. Ranked rows come first, ordered by the Wilson lower bound (then the shrunk hit rate,
    then average return); rows with too few scored calls follow, by sample size, flagged
    ranked=False ("not enough calls yet") so a display never presents them as a ranking."""
    key_id, key_name = ("authorId", "author") if by == "author" else ("channelId", "channel")
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    names: dict[str, str] = {}
    for r in rows:
        if r["horizon"] != horizon:
            continue
        groups[r[key_id]].append(r)
        names[r[key_id]] = r.get(key_name) or r[key_id]
    out = []
    for gid, rs in groups.items():
        n = len(rs)
        if n < min_calls:
            continue
        hits = sum(r["hit"] for r in rs)
        rets = [r["ret"] for r in rs]
        lo, hi = wilson(hits, n)
        out.append({"id": gid, "name": names[gid], "calls": n, "hits": hits, "hitRate": hits / n,
                    "shrunkHitRate": (hits + PRIOR_WEIGHT * 0.5) / (n + PRIOR_WEIGHT),
                    "wilsonLow": round(lo, 4), "wilsonHigh": round(hi, 4), "ranked": n >= min_scored, "minScored": min_scored,
                    "avgRet": statistics.fmean(rets), "medianRet": statistics.median(rets), "horizon": horizon})
    ranked = sorted((x for x in out if x["ranked"]), key=lambda x: (x["wilsonLow"], x["shrunkHitRate"], x["avgRet"]), reverse=True)
    rest = sorted((x for x in out if not x["ranked"]), key=lambda x: (x["calls"], x["shrunkHitRate"]), reverse=True)
    return ranked + rest


def rankings(rows: list[dict[str, Any]], *, horizon: int = 5, by: str = "author", min_calls: int = 3,
             min_scored: int = MIN_SCORED) -> dict[str, Any]:
    """The same board split for display: {'ranked': [...], 'notEnough': [...], 'minScored': n}."""
    lb = leaderboard(rows, horizon=horizon, by=by, min_calls=min_calls, min_scored=min_scored)
    return {"ranked": [r for r in lb if r["ranked"]], "notEnough": [r for r in lb if not r["ranked"]], "minScored": min_scored}


async def score_pending(store: Any, md: Any, *, now_ms: int | None = None, limit: int = 500) -> dict[str, Any]:
    """Score calls whose longest horizon has had time to play out (re-scoring shorter ones is idempotent)."""
    now_ms = now_ms or int(time.time() * 1000)
    calls = store.calls_to_score(max(HORIZONS), now_ms, limit)
    by_ticker: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for c in calls:
        by_ticker[c["ticker"]].append(c)
    rep: dict[str, Any] = {"calls": len(calls), "tickers": len(by_ticker), "scored": 0, "errors": []}
    rows = []
    for ticker, cs in by_ticker.items():
        oldest = min(c["ts"] for c in cs)
        days = int((now_ms - oldest) / 86_400_000) + 40
        try:
            bars = await md.daily_bars(ticker, days=days)
        except LookupError as e:
            # Unknown / delisted / not a stock (VIX is an index): mark these calls unscoreable once
            # (hit NULL, excluded from leaderboards) so they don't head every future batch.
            rep["errors"].append(f"{ticker}: {type(e).__name__}: {e}"[:160])
            rows += [{"key": c["key"], "ticker": ticker, "horizon": max(HORIZONS), "direction": c["direction"], "ref": None,
                      "exit": None, "ret": None, "hit": None, "scoredAt": now_ms} for c in cs]
            rep["unscoreable"] = rep.get("unscoreable", 0) + len(cs)
            continue
        except Exception as e:  # noqa: BLE001 — transient (TWS down, timeout): retry next run
            rep["errors"].append(f"{ticker}: {type(e).__name__}: {e}"[:160])
            continue
        for c in cs:
            for h, s in score_call(bars, c["ts"], c["direction"]).items():
                rows.append({"key": c["key"], "ticker": ticker, "horizon": h, "direction": c["direction"], "ref": s["ref"],
                             "exit": s["exit"], "ret": s["ret"], "hit": s["hit"], "scoredAt": now_ms})
            rep["scored"] += 1
    if rows:
        store.save_outcomes(rows)
    rep["rows"] = len(rows)
    rep["at"] = datetime.fromtimestamp(now_ms / 1000, timezone.utc).isoformat()
    return rep
