"""Why an intent didn't trade: one structured reason for every rejected / failed intent.

    {"code": "rejected_by_ibkr", "label": "Rejected by IBKR", "detail": "TWS rejected the order: ..."}

Codes (the UI maps them to labels; unknown codes show their label / detail as is):
  rejected_by_ibkr  TWS refused or never acknowledged the order (its own text in detail)
  no_quote          no usable two-sided quote / no daily bars, so the gate couldn't price or size it
  market_closed     outside the regular session, a holiday or after a half-day close
  bridge_down       TWS / the bridge not connected, or the endpoint locked
  risk_limit        a Security Detail or pre-trade limit (size, exposure, drawdown, cooldown, ...)
  kill_switch       trading LOCKED by the kill switch, or autonomous trading halted
  schema            the intent itself was malformed
  policy            refused by design (LLM-sourced intent, agent scope, signal provenance)
  other             anything else (detail carries the text)

`classify(status, result, decision)` works on new rows (result["failure"] is stored) and on old
rows without one (derived from their decision checks / error text), so history stays readable.
"""

from __future__ import annotations

from typing import Any

LABELS = {
    "rejected_by_ibkr": "Rejected by IBKR",
    "no_quote": "No quote",
    "market_closed": "Market closed",
    "bridge_down": "Bridge down",
    "risk_limit": "Risk limit",
    "kill_switch": "Kill switch",
    "schema": "Invalid intent",
    "policy": "Refused by policy",
    "other": "Failed",
}
FAILED_STATUSES = ("rejected", "failed")

# Security Detail check name -> code. Checked in this priority order (the first hit names the failure).
_CHECK_PRIORITY: list[tuple[str, tuple[str, ...]]] = [
    ("kill_switch", ("kill_switch",)),
    ("bridge_down", ("port_mode",)),
    ("market_closed", ("market_hours",)),
    ("no_quote", ()),  # detected from the detail text below
    ("policy", ("agent_scope", "signal_provenance")),
]


def failure(code: str, detail: str) -> dict[str, Any]:
    code = code if code in LABELS else "other"
    return {"code": code, "label": LABELS[code], "detail": str(detail)[:500]}


def _is_no_quote(c: dict[str, Any]) -> bool:
    d = str(c.get("detail", ""))
    return ("no usable two-sided quote" in d or "no daily bars" in d) or (c.get("name") == "position_size" and "entry price unknown" in d)


def from_checks(checks: list[dict[str, Any]]) -> dict[str, Any] | None:
    bad = [c for c in checks or [] if not c.get("ok")]
    if not bad:
        return None
    detail = "; ".join(f"{c.get('name')}: {c.get('detail')}" for c in bad)
    for code, names in _CHECK_PRIORITY:
        hit = [c for c in bad if (c.get("name") in names) or (code == "no_quote" and _is_no_quote(c))]
        if hit:
            first = hit[0]
            return failure(code, f"{first.get('name')}: {first.get('detail')}" + (f" (+{len(bad) - 1} more)" if len(bad) > 1 else ""))
    return failure("risk_limit", detail)


def from_error(error: str) -> dict[str, Any]:
    e = str(error or "")
    low = e.lower()
    if low.startswith("schema:"):
        return failure("schema", e)
    if "llm-sourced" in low:
        return failure("policy", e)
    if "kill switch" in low or "halted" in low:
        return failure("kill_switch", e)
    if "tws rejected" in low or "didn't acknowledge" in low or "error 321" in low or "read-only mode" in low:
        return failure("rejected_by_ibkr", e)
    if ("endpoint locked" in low or "not connected" in low or "connectionrefused" in low or "connectionerror" in low
            or "timeouterror" in low or "winerror 1225" in low or "connect call failed" in low):
        return failure("bridge_down", e)
    if low.startswith("pretrade:"):
        return failure("risk_limit", e)
    if "market closed" in low or "outside regular trading hours" in low:
        return failure("market_closed", e)
    return failure("other", e or "no reason recorded")


def classify(status: str, result: Any, decision: dict[str, Any] | None) -> dict[str, Any] | None:
    """The failure reason for a rejected / failed row, else None."""
    if status not in FAILED_STATUSES:
        return None
    res = result if isinstance(result, dict) else {}
    stored = res.get("failure")
    if isinstance(stored, dict) and stored.get("code"):
        return stored
    recheck = res.get("recheck")
    if isinstance(recheck, dict):
        f = from_checks(recheck.get("checks") or [])
        if f:
            return f
    pre = res.get("pretrade")
    if pre:
        if isinstance(pre, dict):
            # either pretrade.gate()'s {"failed": [...]} or the desk's whole refusal {"error": "pretrade: ...", "pretrade": {...}}
            inner = pre.get("pretrade")
            failed = pre.get("failed") or (inner.get("failed") if isinstance(inner, dict) else None)
            if failed:
                return failure("risk_limit", "pretrade: " + ", ".join(map(str, failed)))
            return from_error(str(pre.get("error") or f"pretrade: {pre}"))
        return from_error(str(pre) if str(pre).startswith("pretrade") else f"pretrade: {pre}")
    if res.get("error"):
        return from_error(str(res["error"]))
    f = from_checks((decision or {}).get("checks") or [])
    if f:
        return f
    if result is not None and not isinstance(result, dict):
        return from_error(str(result))
    return failure("other", "no reason recorded" if status == "failed" else "rejected (no reason recorded)")
