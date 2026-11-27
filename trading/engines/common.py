"""Shared engine helpers: deterministic intent ids, indicators, sizing hints."""

from __future__ import annotations

import hashlib
import math
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")


def ny_day(now: float) -> str:
    return datetime.fromtimestamp(now, NY).strftime("%Y%m%d")


def intent_id(prefix: str, *parts: Any) -> str:
    """Same signal on the same day → same id → the desk's idempotency check stops repeats."""
    h = hashlib.sha256("|".join(str(p) for p in parts).encode()).hexdigest()[:12]
    return f"{prefix}-{h}"


def sma(values: list[float], n: int) -> float | None:
    return sum(values[-n:]) / n if len(values) >= n else None


def atr(bars: list[dict[str, Any]], n: int = 14) -> float | None:
    if len(bars) < n + 1:
        return None
    trs = []
    for i in range(len(bars) - n, len(bars)):
        h, lo, pc = bars[i]["high"], bars[i]["low"], bars[i - 1]["close"]
        trs.append(max(h - lo, abs(h - pc), abs(lo - pc)))
    return sum(trs) / n


def clean_bars(bars: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    for b in bars:
        try:
            row = {k: float(b[k]) for k in ("open", "high", "low", "close", "volume")}
        except (KeyError, TypeError, ValueError):
            continue
        if all(math.isfinite(v) for v in row.values()) and row["close"] > 0 and row["high"] >= row["low"] > 0:
            row["date"] = str(b.get("date", ""))
            out.append(row)
    return out


def qty_for_risk(budget_base: float, per_unit_risk: float, fx: float) -> int:
    if per_unit_risk <= 0 or fx <= 0:
        return 0
    return max(0, math.floor(budget_base / (per_unit_risk * fx)))
