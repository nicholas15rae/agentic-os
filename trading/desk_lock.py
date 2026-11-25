"""The persistent desk LOCK, shared with the kill switch, the Security Detail and the executor.

Same file and base format as `kill_switch.write_lock` (`TRADING_LOCKED.json`), so the
running bridge honours a lock written here immediately, with no restart:
  * Security Detail `kill_switch` check rejects every new intent;
  * `Executor._guard()` refuses to place anything.
Broker-side bracket orders are NOT touched by locking.

Extra fields (ignored by older readers):
  source            "desk-cli" | "overseer" | ...
  breakers          list of {code, at, detail} — every circuit breaker / trigger that (re)asserted the lock
  requiresReconcile unlock refused until a passing reconcile newer than the policy's max age exists

A lock is only ever widened while held: re-locking merges new breakers and keeps the
first incident as the cause. `unlock()` needs a fresh passing reconcile stamp; the
operator's dual confirmation is enforced by the caller (desk-cli).
"""

from __future__ import annotations

import json
import time
import uuid
from pathlib import Path
from typing import Any

from ledger import file_lock

LOCK_NAME = "TRADING_LOCKED.json"
RECONCILE_STAMP = "reconcile_last.json"
STATE_NAME = "state.json"


class UnlockRefused(PermissionError):
    pass


def lock_path(d: Path) -> Path:
    return Path(d) / LOCK_NAME


def read_lock(d: Path) -> dict[str, Any] | None:
    """None = unlocked. Any lock file, even unreadable, = locked (fail closed)."""
    p = lock_path(d)
    if not p.exists():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {"locked": True, "reason": "unreadable lock file"}
    except (OSError, ValueError):
        return {"locked": True, "reason": "unreadable lock file"}


def is_locked(d: Path) -> bool:
    return read_lock(d) is not None


def _atomic_write(p: Path, data: dict[str, Any]) -> None:
    tmp = p.with_name(p.name + f".{uuid.uuid4().hex[:6]}.tmp")
    tmp.write_text(json.dumps(data, indent=2, default=str), encoding="utf-8")
    tmp.replace(p)


def lock(d: Path, reason: str, actor: str, *, source: str = "desk-cli", breaker: str | None = None,
         detail: str = "", requires_reconcile: bool = True, now: float | None = None) -> dict[str, Any]:
    """Write (or widen) the lock. Returns the lock as stored."""
    d = Path(d)
    now = time.time() if now is None else now
    with file_lock(d / (LOCK_NAME + ".lock")):
        cur = read_lock(d)
        entry = {"code": breaker or "MANUAL_LOCK", "at": now, "detail": (detail or reason)[:300], "actor": actor}
        if cur is None:
            data = {"locked": True, "at": now, "reason": reason[:300], "actor": actor, "source": source,
                    "incidentId": time.strftime("%Y%m%d-%H%M%S", time.localtime(now)) + "-" + uuid.uuid4().hex[:6],
                    "breakers": [entry], "requiresReconcile": bool(requires_reconcile)}
        else:
            data = dict(cur)
            data.setdefault("locked", True)
            data.setdefault("incidentId", "legacy-" + uuid.uuid4().hex[:6])
            bl = list(data.get("breakers") or [])
            if not any(b.get("code") == entry["code"] for b in bl):
                bl.append(entry)
                data["updatedAt"] = now  # a widened lock invalidates any reconcile that predates it
            data["breakers"] = bl[-50:]
            data["requiresReconcile"] = bool(data.get("requiresReconcile")) or bool(requires_reconcile)
        _atomic_write(lock_path(d), data)
        return data


def write_reconcile_stamp(d: Path, ok: bool, summary: dict[str, Any], now: float | None = None) -> dict[str, Any]:
    data = {"ok": bool(ok), "at": time.time() if now is None else now, "summary": summary}
    _atomic_write(Path(d) / RECONCILE_STAMP, data)
    return data


def read_reconcile_stamp(d: Path) -> dict[str, Any] | None:
    try:
        data = json.loads((Path(d) / RECONCILE_STAMP).read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def unlock_blockers(d: Path, max_age_s: float, now: float | None = None) -> list[str]:
    """Why an unlock would be refused right now (empty = allowed, apart from the confirmation)."""
    now = time.time() if now is None else now
    cur = read_lock(d)
    if cur is None:
        return []
    out = []
    st = read_reconcile_stamp(d)
    if st is None:
        out.append("no reconcile has been recorded; run `desk-cli reconcile` first")
    elif not st.get("ok"):
        out.append("the last reconcile found drift; fix it and re-run `desk-cli reconcile`")
    elif now - float(st.get("at") or 0) > max_age_s:
        out.append(f"the last passing reconcile is {now - float(st.get('at') or 0):.0f}s old (max {max_age_s:.0f}s); re-run it")
    elif float(st.get("at") or 0) < _last_change(cur):
        out.append("the lock changed after the last passing reconcile; re-run it")
    return out


def _last_change(lk: dict[str, Any]) -> float:
    return max([float(b.get("at") or 0) for b in lk.get("breakers") or []] + [float(lk.get("at") or 0), float(lk.get("updatedAt") or 0)])


def _identity(lk: dict[str, Any]) -> tuple:
    return (lk.get("incidentId"), tuple(sorted(str(b.get("code")) for b in lk.get("breakers") or [])), _last_change(lk))


def unlock(d: Path, actor: str, max_age_s: float, now: float | None = None, expected: dict[str, Any] | None = None) -> dict[str, Any]:
    """Remove the lock. Refused (UnlockRefused) without a fresh passing reconcile, or when `expected` (the lock the
    operator saw and confirmed) no longer matches the lock on disk. Confirmation is the caller's job."""
    d = Path(d)
    with file_lock(d / (LOCK_NAME + ".lock")):
        cur = read_lock(d)
        if cur is None:
            return {"locked": False, "note": "was not locked"}
        if expected is not None and _identity(cur) != _identity(expected):
            new = sorted({str(b.get("code")) for b in cur.get("breakers") or []} - {str(b.get("code")) for b in expected.get("breakers") or []})
            raise UnlockRefused(f"the lock changed while you were confirming (new: {', '.join(new) or 'updated'}); re-run unlock")
        why = unlock_blockers(d, max_age_s, now)
        if why:
            raise UnlockRefused("; ".join(why))
        lock_path(d).unlink()
        return {"locked": False, "previous": cur, "by": actor}


# ── autonomy halt (state.json, the desk's own file) ──────────────────────
def read_state(d: Path) -> dict[str, Any]:
    try:
        data = json.loads((Path(d) / STATE_NAME).read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def halt_autonomy(d: Path, now: float | None = None) -> dict[str, Any]:
    """Same effect as the desk's kill step 4: mode ADVISORY + agent halted (engines skip, agent intents refused).
    Read-modify-write with an atomic replace; the desk re-reads state.json on every decision."""
    s = read_state(d)
    s.update(mode="ADVISORY", agentHalted=True, updatedAt=time.time() if now is None else now)
    _atomic_write(Path(d) / STATE_NAME, s)
    return s
