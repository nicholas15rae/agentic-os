"""Desk call book: the Trading Agent's proposals, Engine A's signals and an always-long-SPY
baseline, scored exactly like Discord calls (outcomes.score_call), so they share one leaderboard.

A "call" is (source, symbol, direction, time). Every agent call records a matching baseline call
("buy SPY at the same moment"), so a rising market can't flatter the agent. Calls are scored at
1 / 5 / 20 sessions as soon as each horizon has played out (not only after 20 days), so the
ADVISORY week produces feedback daily.
"""

from __future__ import annotations

import sqlite3
from collections import defaultdict
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import outcomes

SOURCES = {"trading_agent": "Trading Agent", "engine_a": "Engine A", "baseline_spy": "Always-long SPY (baseline)"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS desk_calls (
  call_id TEXT PRIMARY KEY, source TEXT NOT NULL, symbol TEXT NOT NULL, direction TEXT NOT NULL,
  ts_ms INTEGER NOT NULL, ref TEXT, verdict TEXT
);
CREATE INDEX IF NOT EXISTS desk_calls_src ON desk_calls(source, ts_ms);
CREATE TABLE IF NOT EXISTS desk_call_outcomes (
  call_id TEXT NOT NULL, horizon INTEGER NOT NULL, ret REAL, hit INTEGER, scored_at INTEGER NOT NULL,
  PRIMARY KEY (call_id, horizon)
);
"""


class CallBook:
    def __init__(self, db: Path) -> None:
        self.db = db
        with self._conn() as c:
            c.executescript(SCHEMA)

    @contextmanager
    def _conn(self):
        c = sqlite3.connect(self.db, timeout=10, isolation_level=None)
        try:
            yield c
        finally:
            c.close()

    def add(self, call_id: str, source: str, symbol: str, direction: str, ts_ms: int, ref: str = "", verdict: str = "",
            baseline: bool = False) -> bool:
        """Idempotent on call_id. With baseline=True also records 'buy SPY now' as a paired call."""
        if source not in SOURCES or direction not in ("bullish", "bearish"):
            raise ValueError("unknown source / direction")
        with self._conn() as c:
            cur = c.execute("INSERT OR IGNORE INTO desk_calls VALUES (?,?,?,?,?,?,?)", (call_id, source, symbol, direction, ts_ms, ref, verdict))
            if baseline and cur.rowcount:
                c.execute("INSERT OR IGNORE INTO desk_calls VALUES (?,?,?,?,?,?,?)",
                          (f"baseline:{call_id}", "baseline_spy", "SPY", "bullish", ts_ms, call_id, ""))
            return bool(cur.rowcount)

    def pending(self, now_ms: int, limit: int = 400) -> list[dict[str, Any]]:
        """Calls at least a day old whose longest horizon isn't scored yet."""
        with self._conn() as c:
            rows = c.execute(
                "SELECT call_id, source, symbol, direction, ts_ms FROM desk_calls d WHERE ts_ms < ? AND NOT EXISTS "
                "(SELECT 1 FROM desk_call_outcomes o WHERE o.call_id = d.call_id AND o.horizon = ?) ORDER BY ts_ms LIMIT ?",
                (now_ms - 86_400_000, max(outcomes.HORIZONS), limit)).fetchall()
        return [dict(zip(("callId", "source", "symbol", "direction", "ts"), r)) for r in rows]

    def save(self, rows: list[tuple[str, int, float | None, int | None, int]]) -> None:
        with self._conn() as c:
            c.execute("BEGIN")
            c.executemany("INSERT OR REPLACE INTO desk_call_outcomes VALUES (?,?,?,?,?)", rows)
            c.execute("COMMIT")

    def outcome_rows(self) -> list[dict[str, Any]]:
        with self._conn() as c:
            rows = c.execute("SELECT o.horizon, o.ret, o.hit, d.source FROM desk_call_outcomes o JOIN desk_calls d ON d.call_id = o.call_id "
                             "WHERE o.hit IS NOT NULL").fetchall()
        # Shape matches outcomes.leaderboard's input (source plays the 'author').
        return [{"horizon": h, "ret": r, "hit": hit, "authorId": s, "author": SOURCES.get(s, s), "channelId": "desk", "channel": "desk"}
                for h, r, hit, s in rows]

    def leaderboard(self, horizon: int = 5) -> list[dict[str, Any]]:
        return outcomes.leaderboard(self.outcome_rows(), horizon=horizon, by="author", min_calls=1)

    def counts(self) -> dict[str, int]:
        with self._conn() as c:
            return {s: n for s, n in c.execute("SELECT source, COUNT(*) FROM desk_calls GROUP BY source").fetchall()}

    async def score(self, md: Any, now_ms: int) -> dict[str, Any]:
        calls = self.pending(now_ms)
        by_sym: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for c in calls:
            by_sym[c["symbol"]].append(c)
        rows: list[tuple[str, int, float | None, int | None, int]] = []
        errors = []
        for sym, cs in by_sym.items():
            days = int((now_ms - min(c["ts"] for c in cs)) / 86_400_000) + 40
            try:
                bars = await md.daily_bars(sym, days=days)
            except LookupError as e:
                errors.append(f"{sym}: {e}")
                rows += [(c["callId"], max(outcomes.HORIZONS), None, None, now_ms) for c in cs]  # unscoreable: stop re-queuing
                continue
            except Exception as e:  # noqa: BLE001 — transient: retry next pass
                errors.append(f"{sym}: {type(e).__name__}: {e}"[:160])
                continue
            for c in cs:
                for h, s in outcomes.score_call(bars, c["ts"], c["direction"]).items():
                    rows.append((c["callId"], h, s["ret"], s["hit"], now_ms))
        if rows:
            self.save(rows)
        return {"calls": len(calls), "rows": len(rows), "errors": errors}
