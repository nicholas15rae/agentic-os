"""`state.json` (watermarks, archive pin, per-archive progress, sync ledger, last run). State dir only."""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any, Dict

from . import fsutil

SCHEMA = 1
MAX_ERRORS = 20

DEFAULT: Dict[str, Any] = {
    "schema": SCHEMA,
    "archive_root": {"pinned": None, "pinned_at": None},
    "watermarks": {
        "threads": {},
        "envelopes": {},
        "handoff_seq": 0,
        "staging": {},
        "notes": {},
        "training_logs": {},
        "gateway_chat": 0,
    },
    "archives": {},
    "sync": {},
    "kg_pending": [],
    "last_errors": [],
    "last_run": None,
}


def default() -> Dict[str, Any]:
    return copy.deepcopy(DEFAULT)


def state_path(state_dir: Path) -> Path:
    return Path(state_dir) / "state.json"


def load(state_dir: Path) -> Dict[str, Any]:
    """The state (defaults filled in). A missing file is the default; a corrupt one is an error."""
    p = state_path(state_dir)
    data = copy.deepcopy(DEFAULT)
    if not p.exists():
        return data
    raw = json.loads(p.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError("state.json is not an object")
    for k, v in raw.items():
        if k == "watermarks" and isinstance(v, dict):
            data["watermarks"].update(v)
        else:
            data[k] = v
    return data


def pinned_root(state_dir: Path) -> str | None:
    """The pinned archive root, read without creating anything (None when absent/unreadable)."""
    try:
        return (load(state_dir).get("archive_root") or {}).get("pinned")
    except (OSError, ValueError):
        return None


def save(state_dir: Path, data: Dict[str, Any]) -> None:
    fsutil.refuse_protected(state_dir, "state dir")
    data["last_errors"] = list(data.get("last_errors") or [])[-MAX_ERRORS:]
    fsutil.atomic_write(state_path(state_dir), (json.dumps(data, indent=2, ensure_ascii=False) + "\n").encode("utf-8"))


def add_error(data: Dict[str, Any], at: str, where: str, reason: str) -> None:
    errs = list(data.get("last_errors") or [])
    errs.append({"at": at, "where": where, "reason": reason[:300]})
    data["last_errors"] = errs[-MAX_ERRORS:]
