"""Trade journal: every completed paper trade becomes a post-trade record.

Built only from IBKR's own executions (no guessing from quotes):
  entry fills  executions of the parent order (orderId from the desk's result)
  exit fills   the bracket children (same orderRef), the options guard
               (GUARD-STOP-<id> / GUARD-EXP-<conId>) and the kill switch
               (KILL-<incident>) on the same contracts after entry
  complete     every contract opened by the entry has been fully closed

Record: thesis + citations (Discord / Quantgress / telemetry), entry and exit
fills, slippage vs. the limit (or the ask at evaluation for MKT), P&L in the
instrument currency, R-multiple, hold time, exit reason, and a deterministic
post-mortem. It is stored in desk.db, written back into trading_rag as
class:trade_journal (real execution feedback the agent learns from), and rolls
up into the day's P&L report to the Financer.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any

EXIT_PREFIXES = ("GUARD-STOP-", "GUARD-EXP-", "KILL-")


def _exit_reason(fills: list[dict[str, Any]], order_types: dict[int, str]) -> str:
    refs = {f["orderRef"] for f in fills}
    if any(r.startswith("KILL-") for r in refs):
        return "kill_switch"
    if any(r.startswith("GUARD-EXP-") for r in refs):
        return "expiry_flatten"
    if any(r.startswith("GUARD-STOP-") for r in refs):
        return "premium_stop"
    kinds = {order_types.get(f["orderId"], "") for f in fills}
    if "STP" in kinds:
        return "stop_loss"
    if "LMT" in kinds:
        return "take_profit"
    return "manual"


def build_record(row: dict[str, Any], fills: list[dict[str, Any]]) -> dict[str, Any] | None:
    """row: a desk intent row (intent, decision, result). Returns a record once the trade is fully closed, else None."""
    intent, result = row["intent"], row.get("result") or {}
    iid = intent["intent_id"]
    orders = result.get("orders") or []
    if not orders:
        return None
    parent_id = orders[0]["orderId"]
    order_types = {o["orderId"]: o.get("type", "") for o in orders}
    mult = intent.get("multiplier") or 1
    entry = [f for f in fills if f["orderId"] == parent_id and f.get("shares")]
    if not entry:
        return None
    first_entry = min((f["time"] or 0) for f in entry)
    entry_cons = {f["conId"] for f in entry}
    exits = [f for f in fills if f.get("shares") and f["orderId"] != parent_id and f["time"] is not None and f["time"] >= first_entry and (
        (f["orderRef"] == iid) or f["orderRef"] == f"GUARD-STOP-{iid}"
        or (f["orderRef"].startswith(("GUARD-EXP-", "KILL-")) and f["conId"] in entry_cons))]
    # Complete when every contract the entry opened is closed (combo legs are reported per leg).
    opened, closed = defaultdict(float), defaultdict(float)
    for f in entry:
        opened[f["conId"]] += f["shares"]
    for f in exits:
        if f["conId"] in opened:
            closed[f["conId"]] += f["shares"]
    if any(closed[c] + 1e-9 < q for c, q in opened.items()):
        return None

    def cash(fs: list[dict[str, Any]]) -> float:  # + received, - paid
        return sum((f["price"] or 0) * f["shares"] * mult * (1 if f["side"] == "SLD" else -1) for f in fs)

    commissions = sum(f.get("commission") or 0 for f in entry + exits)
    gross = cash(entry) + cash(exits)
    pnl = gross - commissions
    ib_realized = [f["realizedPnl"] for f in exits if f.get("realizedPnl") is not None]

    # Per-unit entry / exit price of the whole structure (shares, one option, or one spread).
    units = intent["quantity"] if intent.get("sec_type") in ("BAG",) else sum(opened.values()) / max(len(opened), 1)
    units = max(units, 1e-9)
    entry_px = -cash(entry) / (units * mult) if intent["action"] == "BUY" else cash(entry) / (units * mult)
    exit_px = cash(exits) / (units * mult) if intent["action"] == "BUY" else -cash(exits) / (units * mult)
    ref = intent.get("limit_price") or (row.get("decision") or {}).get("entryRef")
    slippage = None if ref is None else (entry_px - ref if intent["action"] == "BUY" else ref - entry_px)
    if intent.get("sec_type") in ("OPT", "BAG"):
        risk_per_unit = entry_px  # defined risk: the debit
    else:
        risk_per_unit = abs((ref or entry_px) - intent["stop_loss"])
    r_mult = pnl / (risk_per_unit * units * mult) if risk_per_unit > 0 else None
    closed_at = max(f["time"] for f in exits)
    reason = _exit_reason(exits, order_types)
    cites = intent.get("citations") or []
    hyp = [c for c in cites if c.split(":", 1)[0] in ("discord", "quantgress", "quiver", "hypothesis")]
    outcome = "win" if pnl > 0 else "loss" if pnl < 0 else "flat"

    lessons = []
    if slippage is not None and ref and abs(slippage) / ref > 0.001:
        lessons.append(f"entry slippage {slippage:+.4f} ({slippage / ref * 100:+.2f}%)")
    if reason in ("kill_switch", "expiry_flatten"):
        lessons.append(f"closed by {reason.replace('_', ' ')}, not by the plan")
    if hyp and outcome == "loss":
        lessons.append("hypothesis-backed trade lost: check the source's track record before reusing it")
    if r_mult is not None and r_mult < -1.2:
        lessons.append(f"loss exceeded 1R ({r_mult:.2f}R): stop slipped or was gapped")
    hold_h = (closed_at - first_entry) / 3600

    legs = ", ".join(f"{'+' if l['action'] == 'BUY' else '-'}{l['right']}{l['strike']:g} {l['expiry']}" for l in intent.get("legs") or [])
    what = f"{intent['action']} {units:g} {intent['symbol']}" + (f" [{legs}]" if legs else "")
    post_mortem = (f"{what} @ {entry_px:.4f}" + (f" (ref {ref}, slip {slippage:+.4f})" if slippage is not None else "")
                   + f"; exit {reason.replace('_', ' ')} @ {exit_px:.4f} after {hold_h:.1f}h: {pnl:+.2f} {intent.get('currency', 'USD')}"
                   + (f" ({r_mult:+.2f}R)" if r_mult is not None else "")
                   + f". Source {intent['source']}; {len(cites)} citation(s), {len(hyp)} external hypothesis."
                   + (" Lessons: " + "; ".join(lessons) + "." if lessons else ""))
    return {
        "intentId": iid, "symbol": intent["symbol"], "secType": intent.get("sec_type", "STK"), "source": intent["source"],
        "action": intent["action"], "units": units, "multiplier": mult, "currency": intent.get("currency", "USD"),
        "thesis": intent.get("thesis", ""), "citations": cites, "hypothesisCitations": hyp,
        "entryFills": entry, "exitFills": exits, "entryPrice": entry_px, "exitPrice": exit_px, "refPrice": ref,
        "slippage": slippage, "commissions": commissions, "pnl": round(pnl, 2), "ibRealizedPnl": round(sum(ib_realized), 2) if ib_realized else None,
        "rMultiple": r_mult, "openedAt": first_entry, "closedAt": closed_at, "holdHours": hold_h,
        "exitReason": reason, "outcome": outcome, "lessons": lessons, "postMortem": post_mortem,
    }


def rag_entry(rec: dict[str, Any]) -> tuple[str, list[str], str]:
    tags = ["class:trade_journal", "source:desk", f"ticker:{rec['symbol']}", f"outcome:{rec['outcome']}",
            f"exit:{rec['exitReason']}", f"engine:{rec['source']}", f"sec:{rec['secType'].lower()}"]
    if rec["hypothesisCitations"]:
        tags.append("hypothesis_backed:yes")
    text = f"Trade journal: {rec['postMortem']} Thesis: {rec['thesis'][:400]}"
    return text, tags, f"journal:{rec['intentId']}"
