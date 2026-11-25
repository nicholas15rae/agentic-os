"""Append-only, hash-chained JSON Lines ledger for desk-cli, the overseer and the risk engine.

`data/trading/ledger.jsonl`. One JSON object per line:

  {"seq", "ts", "kind", "ref", "verdict", "actor", "payload", "prev", "hash"}

`hash = sha256(prev + canonical(record without hash))`, `prev` is the previous
line's hash (GENESIS for the first). Editing, reordering or deleting a line
breaks `verify()`. Appends from several processes (CLI, overseer, bridge) are
serialised with an OS file lock on a sidecar `.lock` file and fsynced, so a
crash can lose at most the line being written, never corrupt earlier ones.

This complements `audit.db` (the desk's SQLite audit chain); it does not replace it.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

GENESIS = "0" * 64
LOCK_TIMEOUT_S = 10.0


def canonical(rec: dict[str, Any]) -> str:
    return json.dumps(rec, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)


def _hash(prev: str, rec: dict[str, Any]) -> str:
    body = {k: v for k, v in rec.items() if k != "hash"}
    return hashlib.sha256((prev + canonical(body)).encode("utf-8")).hexdigest()


@contextmanager
def file_lock(path: Path, timeout: float = LOCK_TIMEOUT_S, blocking: bool = True) -> Iterator[Any]:
    """Exclusive OS lock on `path` (created if missing). Cross-process on Windows and POSIX.
    Raises TimeoutError (blocking) or BlockingIOError (non-blocking) when held elsewhere."""
    path.parent.mkdir(parents=True, exist_ok=True)
    f = open(path, "a+b")  # noqa: SIM115 — closed in finally
    try:
        if f.seek(0, 2) == 0:
            f.write(b"\0")
            f.flush()
        deadline = time.monotonic() + timeout
        while True:
            try:
                _lock(f)
                break
            except OSError:
                if not blocking:
                    raise BlockingIOError(f"{path} is held by another process") from None
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"could not lock {path} within {timeout}s") from None
                time.sleep(0.05)
        try:
            yield f
        finally:
            _unlock(f)
    finally:
        f.close()


if os.name == "nt":
    import msvcrt

    def _lock(f: Any) -> None:
        f.seek(0)
        msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)

    def _unlock(f: Any) -> None:
        f.seek(0)
        try:
            msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
        except OSError:
            pass
else:
    import fcntl

    def _lock(f: Any) -> None:
        fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)

    def _unlock(f: Any) -> None:
        fcntl.flock(f.fileno(), fcntl.LOCK_UN)


class Ledger:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock_path = self.path.with_name(self.path.name + ".lock")

    def _last(self) -> tuple[int, str]:
        """(seq, hash) of the last complete line, or (0, GENESIS)."""
        if not self.path.exists():
            return 0, GENESIS
        with open(self.path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            back = min(size, 65536)
            while True:
                f.seek(size - back)
                chunk = f.read(back)
                lines = [ln for ln in chunk.split(b"\n") if ln.strip()]
                # The first line of a partial chunk may be cut; only trust it if we read from the start.
                if len(lines) >= 2 or back == size:
                    break
                back = min(size, back * 4)
        for raw in reversed(lines):
            try:
                rec = json.loads(raw.decode("utf-8"))
                return int(rec["seq"]), str(rec["hash"])
            except (ValueError, KeyError, UnicodeDecodeError):
                continue  # a torn final line (crash mid-write) is skipped; verify() reports it
        return 0, GENESIS

    def append(self, kind: str, payload: dict[str, Any] | None = None, *, ref: str = "", verdict: str = "", actor: str = "") -> dict[str, Any]:
        with file_lock(self._lock_path):
            seq, prev = self._last()
            rec: dict[str, Any] = {"seq": seq + 1, "ts": time.time(), "kind": kind, "ref": str(ref)[:120],
                                   "verdict": str(verdict)[:40], "actor": str(actor)[:60], "payload": payload or {}, "prev": prev}
            rec = json.loads(canonical(rec))  # normalise (default=str) so the hash matches what is stored
            rec["hash"] = _hash(prev, rec)
            line = (canonical(rec) + "\n").encode("utf-8")
            with open(self.path, "ab") as f:
                f.write(line)
                f.flush()
                os.fsync(f.fileno())
            return rec

    def read(self) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        out = []
        with open(self.path, encoding="utf-8") as f:
            for raw in f:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    out.append(json.loads(raw))
                except ValueError:
                    out.append({"seq": None, "kind": "CORRUPT_LINE", "raw": raw[:200]})
        return out

    def tail(self, limit: int = 25, kinds: tuple[str, ...] | None = None) -> list[dict[str, Any]]:
        """Newest last (chronological), like `tail -n`."""
        rows = self.read()
        if kinds:
            rows = [r for r in rows if r.get("kind") in kinds]
        return rows[-max(1, limit):]

    def since(self, ts: float, kinds: tuple[str, ...] | None = None) -> list[dict[str, Any]]:
        return [r for r in self.read() if (r.get("ts") or 0) >= ts and (not kinds or r.get("kind") in kinds)]

    def verify(self) -> tuple[bool, str]:
        prev = GENESIS
        expect = 1
        for r in self.read():
            if r.get("kind") == "CORRUPT_LINE":
                return False, f"unparseable line after seq {expect - 1}"
            if r.get("seq") != expect:
                return False, f"seq {r.get('seq')} where {expect} expected (line removed or reordered)"
            if r.get("prev") != prev:
                return False, f"seq {expect}: prev hash breaks the chain"
            if _hash(prev, r) != r.get("hash"):
                return False, f"seq {expect}: content does not match its hash"
            prev = r["hash"]
            expect += 1
        return True, f"ok ({expect - 1} entries)"
