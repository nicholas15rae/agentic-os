"""Append-only, hash-chained audit log for every trading decision.

`data/trading/audit.db` (SQLite). Same design as the Rust `ops_audit.rs`:
BEFORE UPDATE / BEFORE DELETE triggers refuse edits, and each row stores
sha256(prev_hash + canonical row) so a tampered or removed row breaks
`verify_chain()`. Every approved, modified and rejected OrderIntent, every
submitted order, mode change, comms rejection and kill-switch event lands here.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
from contextlib import contextmanager
import time
from pathlib import Path
from typing import Any

GENESIS = "0" * 64

SCHEMA = """
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts REAL NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL DEFAULT '',
  verdict TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  row_hash TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS audit_ref ON audit(ref);
CREATE INDEX IF NOT EXISTS audit_kind_ts ON audit(kind, ts);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit
BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit
BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
"""


def _canon(ts: float, kind: str, ref: str, verdict: str, actor: str, payload: str) -> str:
    return json.dumps([repr(ts), kind, ref, verdict, actor, payload], separators=(",", ":"), ensure_ascii=False)


def _hash(prev: str, canon: str) -> str:
    return hashlib.sha256((prev + canon).encode("utf-8")).hexdigest()


class AuditLog:
    def __init__(self, path: Path) -> None:
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        with self._conn() as c:
            c.executescript(SCHEMA)

    @contextmanager
    def _conn(self):
        # sqlite3's own context manager commits but does NOT close; on Windows a leaked
        # handle keeps the file locked, so always close explicitly.
        c = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        try:
            c.execute("PRAGMA journal_mode=WAL")
            yield c
        finally:
            c.close()

    def append(self, kind: str, payload: dict[str, Any], *, ref: str = "", verdict: str = "", actor: str = "") -> dict[str, Any]:
        body = json.dumps(payload, sort_keys=True, default=str, ensure_ascii=False)
        with self._lock, self._conn() as c:
            c.execute("BEGIN IMMEDIATE")
            row = c.execute("SELECT row_hash FROM audit ORDER BY id DESC LIMIT 1").fetchone()
            prev = row[0] if row else GENESIS
            ts = time.time()
            h = _hash(prev, _canon(ts, kind, ref, verdict, actor, body))
            cur = c.execute(
                "INSERT INTO audit(ts, kind, ref, verdict, actor, payload, prev_hash, row_hash) VALUES (?,?,?,?,?,?,?,?)",
                (ts, kind, ref, verdict, actor, body, prev, h),
            )
            c.execute("COMMIT")
            return {"id": cur.lastrowid, "ts": ts, "kind": kind, "ref": ref, "verdict": verdict, "actor": actor, "hash": h}

    def tail(self, limit: int = 50, kinds: tuple[str, ...] | None = None) -> list[dict[str, Any]]:
        q = "SELECT id, ts, kind, ref, verdict, actor, payload FROM audit"
        args: list[Any] = []
        if kinds:
            q += f" WHERE kind IN ({','.join('?' * len(kinds))})"
            args += list(kinds)
        q += " ORDER BY id DESC LIMIT ?"
        args.append(max(1, min(limit, 500)))
        with self._conn() as c:
            rows = c.execute(q, args).fetchall()
        return [{"id": r[0], "ts": r[1], "kind": r[2], "ref": r[3], "verdict": r[4], "actor": r[5], "payload": json.loads(r[6])} for r in rows]

    def count_since(self, kind: str, since_ts: float, verdicts: tuple[str, ...] = ()) -> int:
        q = "SELECT COUNT(*) FROM audit WHERE kind = ? AND ts >= ?"
        args: list[Any] = [kind, since_ts]
        if verdicts:
            q += f" AND verdict IN ({','.join('?' * len(verdicts))})"
            args += list(verdicts)
        with self._conn() as c:
            return int(c.execute(q, args).fetchone()[0])

    def seen_ref(self, kind: str, ref: str) -> bool:
        with self._conn() as c:
            return c.execute("SELECT 1 FROM audit WHERE kind = ? AND ref = ? LIMIT 1", (kind, ref)).fetchone() is not None

    def verify_chain(self) -> tuple[bool, str]:
        prev = GENESIS
        with self._conn() as c:
            for r in c.execute("SELECT id, ts, kind, ref, verdict, actor, payload, prev_hash, row_hash FROM audit ORDER BY id"):
                if r[7] != prev:
                    return False, f"row {r[0]}: prev_hash breaks the chain"
                if _hash(prev, _canon(r[1], r[2], r[3], r[4], r[5], r[6])) != r[8]:
                    return False, f"row {r[0]}: content does not match its hash"
                prev = r[8]
        return True, "ok"
