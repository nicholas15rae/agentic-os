"""Financer-only comms contract for the Trading Agent.

The Trading Agent has exactly one peer: the Financer. Every message is an
envelope `{msg_id, from, to, kind, payload}` checked against a closed route
table — any other sender, recipient or message kind is refused and audited.
The Rust side enforces the same boundary on the agent mesh (arbiter.rs:
`trading` only has edges to and from `finance`; Tony can't dispatch to it).

Direction      Kinds
trading → financer   capital_request, pnl_report, risk_posture_query
financer → trading   budget_envelope, risk_posture

Financer messages can only TIGHTEN risk: an allocation caps the equity used
for sizing (it can never exceed the account's real equity), a daily-loss limit
is applied only if it's stricter than the current one, and posture "halt"
stops the agent. So even a spoofed Financer message can't loosen a cap.

Trading → Financer messages go to `financer_outbox.jsonl` for the Financer to
pick up. Nothing here writes to the sealed finance vault; ledger writes keep
needing the user's approval (the finance_handoff pattern), wired in Phase 4.
"""

from __future__ import annotations

import json
import re
import time
from typing import Any, Callable

ROUTES: dict[tuple[str, str], frozenset[str]] = {
    ("trading", "financer"): frozenset({"capital_request", "pnl_report", "risk_posture_query"}),
    ("financer", "trading"): frozenset({"budget_envelope", "risk_posture"}),
}
ENVELOPE_KEYS = {"msg_id", "from", "to", "kind", "payload"}
MSG_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
POSTURES = ("normal", "defensive", "halt")


class CommsError(ValueError):
    pass


def _num(v: Any, name: str, *, lo: float | None = None, hi: float | None = None, positive: bool = False) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise CommsError(f"{name} must be a number")
    if positive and v <= 0:
        raise CommsError(f"{name} must be > 0")
    if lo is not None and v < lo or hi is not None and v > hi:
        raise CommsError(f"{name} out of range")
    return float(v)


def _exact(payload: Any, required: set[str], optional: set[str] = frozenset()) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise CommsError("payload must be an object")
    extra = set(payload) - required - set(optional)
    if extra:
        raise CommsError(f"unknown payload field(s): {sorted(extra)}")
    missing = required - set(payload)
    if missing:
        raise CommsError(f"missing payload field(s): {sorted(missing)}")
    return payload


PAYLOADS: dict[str, Callable[[Any], dict[str, Any]]] = {}


def _payload(kind: str):
    def deco(fn):
        PAYLOADS[kind] = fn
        return fn
    return deco


@_payload("capital_request")
def _capital_request(p: Any) -> dict[str, Any]:
    p = _exact(p, {"amount_base", "rationale"})
    if not isinstance(p["rationale"], str) or len(p["rationale"]) > 1000:
        raise CommsError("rationale: a string of at most 1000 characters")
    return {"amount_base": _num(p["amount_base"], "amount_base", positive=True), "rationale": p["rationale"]}


@_payload("pnl_report")
def _pnl_report(p: Any) -> dict[str, Any]:
    p = _exact(p, {"date", "realized_base", "unrealized_base", "trades"})
    if not isinstance(p["date"], str) or not DATE_RE.match(p["date"]):
        raise CommsError("date must be YYYY-MM-DD")
    if isinstance(p["trades"], bool) or not isinstance(p["trades"], int) or p["trades"] < 0:
        raise CommsError("trades must be a non-negative integer")
    return {"date": p["date"], "realized_base": _num(p["realized_base"], "realized_base"),
            "unrealized_base": _num(p["unrealized_base"], "unrealized_base"), "trades": p["trades"]}


@_payload("risk_posture_query")
def _posture_query(p: Any) -> dict[str, Any]:
    return _exact(p, set())


@_payload("budget_envelope")
def _budget(p: Any) -> dict[str, Any]:
    p = _exact(p, {"allocation_base"}, {"max_daily_loss_pct"})
    out = {"allocation_base": _num(p["allocation_base"], "allocation_base", positive=True)}
    if "max_daily_loss_pct" in p:
        out["max_daily_loss_pct"] = _num(p["max_daily_loss_pct"], "max_daily_loss_pct", lo=0.01, hi=100)
    return out


@_payload("risk_posture")
def _posture(p: Any) -> dict[str, Any]:
    p = _exact(p, {"posture"}, {"note"})
    if p["posture"] not in POSTURES:
        raise CommsError(f"posture must be one of {', '.join(POSTURES)}")
    note = p.get("note", "")
    if not isinstance(note, str) or len(note) > 500:
        raise CommsError("note: a string of at most 500 characters")
    return {"posture": p["posture"], "note": note}


def validate_envelope(raw: Any) -> dict[str, Any]:
    """The route table check. Raises CommsError for anything outside the contract."""
    if not isinstance(raw, dict):
        raise CommsError("envelope must be an object")
    extra = set(raw) - ENVELOPE_KEYS
    if extra:
        raise CommsError(f"unknown envelope field(s): {sorted(extra)}")
    missing = ENVELOPE_KEYS - set(raw)
    if missing:
        raise CommsError(f"missing envelope field(s): {sorted(missing)}")
    if not isinstance(raw["msg_id"], str) or not MSG_ID_RE.match(raw["msg_id"]):
        raise CommsError("msg_id: 8-64 letters, digits, _ or -")
    route = (str(raw["from"]).strip().lower(), str(raw["to"]).strip().lower())
    kinds = ROUTES.get(route)
    if kinds is None:
        raise CommsError(f"route {route[0]} → {route[1]} is not allowed: the Trading Agent talks only to the Financer")
    if raw["kind"] not in kinds:
        raise CommsError(f"{route[0]} → {route[1]} can't send {raw['kind']!r} (allowed: {', '.join(sorted(kinds))})")
    return {"msg_id": raw["msg_id"], "from": route[0], "to": route[1], "kind": raw["kind"],
            "payload": PAYLOADS[raw["kind"]](raw["payload"]), "received_at": time.time()}


def tightened_daily_loss(current: float, proposed: float | None) -> float:
    return current if proposed is None else min(current, proposed)


def append_outbox(path, envelope: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(envelope, sort_keys=True) + "\n")
