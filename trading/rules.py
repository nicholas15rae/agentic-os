"""Engine R's rulebook: the versioned rule parameters, the hard limits, and the rule-change queue.

Two files of policy with two different owners:

  rule parameters   versioned in desk.db (`rule_versions`). The analyst (LLM) may only SUGGEST a
                    change; a suggestion is stored as a PENDING row in `rule_changes` and nothing
                    changes until Nic approves it with the typed confirmation "APPROVE". Only the
                    knobs in PARAM_SCHEMA exist, each with hard bounds, so no suggestion can name
                    anything else (an order, a limit, a symbol outside the universe).
  hard limits       `data/trading/rules/limits.json` (HardLimits). Never part of a suggestion: only
                    Nic changes them (edit the file, or POST /engines/r/limits with confirm "LIMITS").
                    Strict, fail-closed loading like risk_limits.json.

Every proposal, approval, rejection and limit change is written to the hash-chained audit log with
its reason (kinds rule_change_proposed / rule_change_approved / rule_change_rejected /
ruleset_activated / rule_limits_changed).
"""

from __future__ import annotations

import json
import math
import re
import sqlite3
import time
import uuid
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path
from typing import Any

RULE_ID = "trend_breakout"
APPROVE_PHRASE = "APPROVE"
LIMITS_PHRASE = "LIMITS"
TICKER_RE = re.compile(r"^[A-Z][A-Z0-9.]{0,9}$")
RATIONALE_MAX = 600
CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


class RuleError(ValueError):
    pass


# ── tunable rule parameters ─────────────────────────────────────────────────
# name -> (type, min, max, default, meaning). "symbols" = a list of universe tickers.
PARAM_SCHEMA: dict[str, tuple[str, float | None, float | None, Any, str]] = {
    "sma_fast": ("int", 5, 50, 20, "trend filter: close > SMA(fast) > SMA(slow)"),
    "sma_slow": ("int", 20, 200, 50, "trend filter: slow SMA period"),
    "breakout_lookback": ("int", 5, 60, 20, "close at a new N-session high"),
    "min_rel_volume": ("float", 0.5, 5.0, 1.2, "today's volume / N-session average volume, at least"),
    "atr_period": ("int", 5, 30, 14, "ATR period for stops, targets and the volatility filter"),
    "stop_atr_mult": ("float", 0.5, 5.0, 2.0, "stop = entry - mult x ATR"),
    "target_atr_mult": ("float", 0.5, 10.0, 3.0, "take-profit = entry + mult x ATR"),
    "max_atr_pct": ("float", 0.5, 10.0, 4.0, "skip a symbol whose ATR is above this % of its close"),
    "risk_per_trade_pct": ("float", 0.05, 0.5, 0.25, "equity risked if the stop is hit (the hard limits cap the size anyway)"),
    "disabled_symbols": ("symbols", None, None, [], "universe tickers the rule must not trade"),
}
DEFAULT_PARAMS: dict[str, Any] = {k: (list(v[3]) if isinstance(v[3], list) else v[3]) for k, v in PARAM_SCHEMA.items()}


def validate_params(raw: Any, universe: list[str]) -> dict[str, Any]:
    """A full parameter set: every knob present, right type, inside its bounds. Raises RuleError."""
    if not isinstance(raw, dict):
        raise RuleError("rule parameters must be an object")
    unknown = set(raw) - set(PARAM_SCHEMA)
    if unknown:
        raise RuleError(f"unknown rule parameter(s): {sorted(unknown)}")
    out: dict[str, Any] = {}
    for name, (kind, lo, hi, default, _help) in PARAM_SCHEMA.items():
        out[name] = _coerce(name, raw.get(name, default), kind, lo, hi, universe)
    if out["sma_fast"] >= out["sma_slow"]:
        raise RuleError("sma_fast must be below sma_slow")
    return out


def _coerce(name: str, v: Any, kind: str, lo: float | None, hi: float | None, universe: list[str]) -> Any:
    if kind == "symbols":
        if not isinstance(v, list) or not all(isinstance(s, str) for s in v):
            raise RuleError(f"{name} must be a list of tickers")
        syms = sorted({s.strip().upper() for s in v})
        bad = [s for s in syms if not TICKER_RE.match(s) or s not in universe]
        if bad:
            raise RuleError(f"{name}: {bad} not in the universe {universe}")
        return syms
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(float(v)):
        raise RuleError(f"{name} must be a number")
    if kind == "int":
        if float(v) != int(v):
            raise RuleError(f"{name} must be a whole number")
        v = int(v)
    else:
        v = round(float(v), 4)
    if not lo <= v <= hi:  # type: ignore[operator]
        raise RuleError(f"{name}={v} outside [{lo}, {hi}]")
    return v


def diff_params(old: dict[str, Any], new: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {k: {"from": old.get(k), "to": new[k]} for k in PARAM_SCHEMA if new.get(k) != old.get(k)}


def apply_diff(params: dict[str, Any], diff: dict[str, dict[str, Any]], universe: list[str]) -> dict[str, Any]:
    """Apply {param: {from, to}} to `params`. Refuses (RuleError) when a `from` no longer matches:
    the change was written against an older version, so approving it could silently undo another."""
    if not diff:
        raise RuleError("the change is empty")
    out = dict(params)
    for k, ch in diff.items():
        if k not in PARAM_SCHEMA:
            raise RuleError(f"unknown rule parameter {k!r}")
        if params.get(k) != ch.get("from"):
            raise RuleError(f"stale change: {k} is {params.get(k)!r} now, the change expected {ch.get('from')!r}")
        out[k] = ch.get("to")
    return validate_params(out, universe)


def clean_text(s: Any, limit: int = RATIONALE_MAX) -> str:
    """Model / user prose stored as DATA: control characters stripped, length capped. Never parsed."""
    return CONTROL.sub(" ", str(s or "")).strip()[:limit]


# ── hard limits (Nic only) ───────────────────────────────────────────────────
DAILY_LOSS_ACTIONS = ("stop_entries", "kill_switch")
DEFAULT_UNIVERSE = ["SPY", "QQQ", "IWM", "GLD", "SLV", "USO", "UNG"]


@dataclass(frozen=True)
class HardLimits:
    max_daily_loss_base: float = 1500.0       # day's P&L (realized + unrealized, account base currency) floor
    on_daily_loss: str = "stop_entries"       # stop_entries: no new entries today | kill_switch: E-stop (lock, cancel, flatten)
    max_position_shares: int = 200            # one entry, shares
    max_position_notional_base: float = 25_000.0  # one entry, notional in base currency
    max_trades_per_day: int = 3               # Engine R entries submitted per New York day
    max_open_positions: int = 3               # positions held + working entries, all sources
    scan_time_et: str = "15:45"               # the one daily scan (daily-bar rule; mirrors the backtest's close entries)
    universe: list[str] = field(default_factory=lambda: list(DEFAULT_UNIVERSE))

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


LIMIT_FIELDS = {f.name for f in fields(HardLimits)}
SCAN_TIME_RE = re.compile(r"^(0[9]|1[0-5]):[0-5]\d$")


def check_limits(raw: Any) -> HardLimits:
    if not isinstance(raw, dict):
        raise RuleError("limits must be an object")
    unknown = set(raw) - LIMIT_FIELDS
    if unknown:
        raise RuleError(f"limits.json: unknown field(s) {sorted(unknown)}")
    merged = {**HardLimits().to_dict(), **raw}
    for name, lo, hi in (("max_daily_loss_base", 1, 1e7), ("max_position_notional_base", 1, 1e7)):
        v = merged[name]
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not lo <= v <= hi:
            raise RuleError(f"limits.json: {name} must be a number in [{lo:g}, {hi:g}]")
        merged[name] = float(v)
    for name, lo, hi in (("max_position_shares", 1, 100_000), ("max_trades_per_day", 0, 50), ("max_open_positions", 0, 50)):
        v = merged[name]
        if isinstance(v, bool) or not isinstance(v, (int, float)) or float(v) != int(v) or not lo <= v <= hi:
            raise RuleError(f"limits.json: {name} must be a whole number in [{lo}, {hi}]")
        merged[name] = int(v)
    if merged["on_daily_loss"] not in DAILY_LOSS_ACTIONS:
        raise RuleError(f"limits.json: on_daily_loss must be one of {', '.join(DAILY_LOSS_ACTIONS)}")
    if not isinstance(merged["scan_time_et"], str) or not SCAN_TIME_RE.match(merged["scan_time_et"]) or merged["scan_time_et"] < "09:35":
        raise RuleError("limits.json: scan_time_et must be HH:MM between 09:35 and 15:59 New York")
    u = merged["universe"]
    if not isinstance(u, list) or not u or not all(isinstance(s, str) and TICKER_RE.match(s.strip().upper()) for s in u):
        raise RuleError("limits.json: universe must be a non-empty list of tickers")
    merged["universe"] = list(dict.fromkeys(s.strip().upper() for s in u))
    return HardLimits(**merged)


def limits_path(d: Path) -> Path:
    return Path(d) / "rules" / "limits.json"


def load_limits(d: Path) -> HardLimits:
    """Read (or create with defaults). Corrupt / invalid → RuleError: callers treat it as 'no trading'."""
    p = limits_path(d)
    if not p.exists():
        p.parent.mkdir(parents=True, exist_ok=True)
        _write_json(p, HardLimits().to_dict())
        return HardLimits()
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise RuleError(f"limits.json unreadable ({e})") from None
    return check_limits(raw)


def _write_json(p: Path, data: Any) -> None:
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    tmp.replace(p)


# ── versions + change queue (desk.db) ────────────────────────────────────────
SCHEMA = """
CREATE TABLE IF NOT EXISTS rule_versions (
  version INTEGER PRIMARY KEY, params TEXT NOT NULL, created REAL NOT NULL,
  change_id TEXT, approved_by TEXT NOT NULL, reason TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rule_changes (
  change_id TEXT PRIMARY KEY, created REAL NOT NULL, source TEXT NOT NULL, actor TEXT NOT NULL,
  status TEXT NOT NULL, base_version INTEGER NOT NULL, diff TEXT NOT NULL, rationale TEXT NOT NULL,
  evaluation TEXT, decided REAL, decided_by TEXT, note TEXT, new_version INTEGER
);
CREATE INDEX IF NOT EXISTS rule_changes_status ON rule_changes(status, created);
"""
CHANGE_SOURCES = ("analyst", "manual")
MAX_PENDING = 12


class RuleStore:
    def __init__(self, d: Path, audit: Any, clock: Any = time.time) -> None:
        self.d = Path(d)
        self.db = self.d / "desk.db"
        self.audit = audit
        self.clock = clock
        (self.d / "rules").mkdir(parents=True, exist_ok=True)
        with self._conn() as c:
            c.executescript(SCHEMA)
            if c.execute("SELECT COUNT(*) FROM rule_versions").fetchone()[0] == 0:
                c.execute("INSERT INTO rule_versions VALUES (1, ?, ?, NULL, 'system', 'initial rule set (Engine A defaults)')",
                          (json.dumps(DEFAULT_PARAMS), self.clock()))
        self._mirror()

    @contextmanager
    def _conn(self):
        c = sqlite3.connect(self.db, timeout=10, isolation_level=None)
        try:
            yield c
        finally:
            c.close()

    def limits(self) -> HardLimits:
        return load_limits(self.d)

    def set_limits(self, raw: Any, confirm: str, reason: str, actor: str) -> HardLimits:
        if confirm != LIMITS_PHRASE:
            raise PermissionError(f'type "{LIMITS_PHRASE}" to change the hard limits')
        reason = clean_text(reason, 300)
        if not reason:
            raise RuleError("a reason is required")
        if not isinstance(raw, dict):
            raise RuleError("limits must be an object")
        prev = self.limits()
        new = check_limits({**prev.to_dict(), **raw})
        _write_json(limits_path(self.d), new.to_dict())
        changed = {k: {"from": prev.to_dict()[k], "to": v} for k, v in new.to_dict().items() if prev.to_dict()[k] != v}
        self.audit.append("rule_limits_changed", {"changed": changed, "reason": reason}, ref="limits", verdict="CHANGED" if changed else "UNCHANGED", actor=actor)
        return new

    # versions
    def active(self) -> dict[str, Any]:
        with self._conn() as c:
            r = c.execute("SELECT version, params, created, change_id, approved_by, reason FROM rule_versions ORDER BY version DESC LIMIT 1").fetchone()
        params = json.loads(r[1])
        return {"version": r[0], "params": params, "created": r[2], "changeId": r[3], "approvedBy": r[4], "reason": r[5], "rule": RULE_ID}

    def versions(self, limit: int = 20) -> list[dict[str, Any]]:
        with self._conn() as c:
            rows = c.execute("SELECT version, params, created, change_id, approved_by, reason FROM rule_versions ORDER BY version DESC LIMIT ?",
                             (max(1, min(limit, 200)),)).fetchall()
        return [{"version": r[0], "params": json.loads(r[1]), "created": r[2], "changeId": r[3], "approvedBy": r[4], "reason": r[5]} for r in rows]

    def _mirror(self) -> None:
        """A human-readable copy of the active version (the database is the source of truth)."""
        try:
            _write_json(self.d / "rules" / "active.json", self.active())
        except OSError:
            pass

    # change queue
    def propose(self, new_params: Any, *, source: str, actor: str, rationale: str, evaluation: dict[str, Any] | None = None) -> dict[str, Any]:
        """Store a PENDING change against the active version. Nothing is applied here."""
        if source not in CHANGE_SOURCES:
            raise RuleError("unknown change source")
        act = self.active()
        universe = self.limits().universe
        if not isinstance(new_params, dict):
            raise RuleError("params must be an object")
        proposed = validate_params({**act["params"], **new_params}, universe)
        diff = diff_params(act["params"], proposed)
        if not diff:
            raise RuleError("the proposal does not change anything")
        with self._conn() as c:
            pend = c.execute("SELECT diff FROM rule_changes WHERE status='pending' AND base_version=?", (act["version"],)).fetchall()
            if any(json.loads(p[0]) == diff for p in pend):
                raise RuleError("an identical change is already pending")
            if len(pend) >= MAX_PENDING:
                raise RuleError(f"{MAX_PENDING} changes are already pending; approve or reject some first")
            cid = f"rc-{time.strftime('%Y%m%d', time.gmtime(self.clock()))}-{uuid.uuid4().hex[:8]}"
            why = {"text": clean_text(rationale), "untrusted": source == "analyst"}
            c.execute("INSERT INTO rule_changes(change_id, created, source, actor, status, base_version, diff, rationale, evaluation) "
                      "VALUES (?,?,?,?, 'pending', ?,?,?,?)",
                      (cid, self.clock(), source, actor[:40], act["version"], json.dumps(diff), json.dumps(why), json.dumps(evaluation, default=str)))
        self.audit.append("rule_change_proposed", {"diff": diff, "baseVersion": act["version"], "source": source, "rationale": why,
                                                   "evaluation": _eval_summary(evaluation)}, ref=cid, verdict="PENDING", actor=actor)
        return self.change(cid)  # type: ignore[return-value]

    def change(self, cid: str) -> dict[str, Any] | None:
        with self._conn() as c:
            r = c.execute("SELECT change_id, created, source, actor, status, base_version, diff, rationale, evaluation, decided, decided_by, note, "
                          "new_version FROM rule_changes WHERE change_id = ?", (cid,)).fetchone()
        return _change_row(r) if r else None

    def changes(self, status: str | None = None, limit: int = 30) -> list[dict[str, Any]]:
        q = ("SELECT change_id, created, source, actor, status, base_version, diff, rationale, evaluation, decided, decided_by, note, new_version "
             "FROM rule_changes")
        args: list[Any] = []
        if status:
            q += " WHERE status = ?"
            args.append(status)
        q += " ORDER BY created DESC LIMIT ?"
        args.append(max(1, min(limit, 200)))
        with self._conn() as c:
            return [_change_row(r) for r in c.execute(q, args).fetchall()]

    def approve(self, cid: str, *, confirm: str, actor: str, note: str = "") -> dict[str, Any]:
        """Nic's approval: the typed phrase, a still-pending change, and a diff that still applies to the
        active version. Writes version N+1 and audits the change with its reason."""
        if confirm != APPROVE_PHRASE:
            raise PermissionError(f'type "{APPROVE_PHRASE}" to approve a rule change')
        ch = self.change(cid)
        if not ch or ch["status"] != "pending":
            raise RuleError("no pending change with that id")
        act = self.active()
        try:
            new = apply_diff(act["params"], ch["diff"], self.limits().universe)
        except RuleError as e:
            with self._conn() as c:
                c.execute("UPDATE rule_changes SET status='stale', decided=?, decided_by=?, note=? WHERE change_id=?",
                          (self.clock(), actor[:40], str(e)[:300], cid))
            self.audit.append("rule_change_rejected", {"diff": ch["diff"], "why": str(e)}, ref=cid, verdict="STALE", actor=actor)
            raise
        note = clean_text(note, 300)
        reason = f"{ch['source']} change {cid} approved" + (f": {note}" if note else "") + f" · rationale: {ch['rationale']['text'][:200]}"
        with self._conn() as c:
            c.execute("BEGIN IMMEDIATE")
            ver = c.execute("SELECT MAX(version) FROM rule_versions").fetchone()[0] + 1
            c.execute("INSERT INTO rule_versions VALUES (?,?,?,?,?,?)", (ver, json.dumps(new), self.clock(), cid, actor[:40], reason))
            c.execute("UPDATE rule_changes SET status='approved', decided=?, decided_by=?, note=?, new_version=? WHERE change_id=?",
                      (self.clock(), actor[:40], note, ver, cid))
            # Other pending changes were written against the old version: they must be re-checked (apply_diff does) on approval.
            c.execute("COMMIT")
        self.audit.append("rule_change_approved", {"diff": ch["diff"], "fromVersion": act["version"], "toVersion": ver, "note": note,
                                                   "rationale": ch["rationale"], "evaluation": _eval_summary(ch.get("evaluation"))},
                          ref=cid, verdict="APPROVED", actor=actor)
        self.audit.append("ruleset_activated", {"version": ver, "params": new, "reason": reason}, ref=f"v{ver}", verdict="ACTIVE", actor=actor)
        self._mirror()
        return {"ok": True, "change": self.change(cid), "active": self.active()}

    def reject(self, cid: str, *, actor: str, note: str = "") -> dict[str, Any]:
        ch = self.change(cid)
        if not ch or ch["status"] != "pending":
            raise RuleError("no pending change with that id")
        note = clean_text(note, 300)
        with self._conn() as c:
            c.execute("UPDATE rule_changes SET status='rejected', decided=?, decided_by=?, note=? WHERE change_id=?", (self.clock(), actor[:40], note, cid))
        self.audit.append("rule_change_rejected", {"diff": ch["diff"], "note": note}, ref=cid, verdict="REJECTED", actor=actor)
        return {"ok": True, "change": self.change(cid)}


def _change_row(r: tuple) -> dict[str, Any]:
    return {"changeId": r[0], "created": r[1], "source": r[2], "actor": r[3], "status": r[4], "baseVersion": r[5],
            "diff": json.loads(r[6]), "rationale": json.loads(r[7]), "evaluation": json.loads(r[8]) if r[8] else None,
            "decided": r[9], "decidedBy": r[10], "note": r[11], "newVersion": r[12]}


def _eval_summary(ev: dict[str, Any] | None) -> dict[str, Any] | None:
    """The headline numbers of an evaluation, for the audit row (the full report stays on the change)."""
    if not ev:
        return None
    out: dict[str, Any] = {"cutoff": ev.get("cutoff")}
    for side in ("current", "proposed"):
        s = ev.get(side) or {}
        out[side] = {part: {k: (s.get(part) or {}).get(k) for k in ("trades", "winRate", "avgWinR", "avgLossR", "maxDrawdownR")}
                     for part in ("build", "test")}
    return out
