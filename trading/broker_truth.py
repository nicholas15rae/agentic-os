"""Broker-is-truth state machine for desk intents.

Agents and engines only PROPOSE (desk.db `intents` rows). Only TWS evidence moves an intent's
state after submission. The one transition owned here:

  submitted → cancelled
      evidence: none of the intent's orders is working at TWS, TWS reports no execution carrying
      its orderRef (executions must be AVAILABLE; without them nothing moves), and there is no
      position in its symbol. That is reconcile's ORPHAN_INTENT drift.

Everything else (fills → closed, stops → closed_stop) stays with the desk's journal pass, which
already works from TWS fills. A contradiction this module cannot resolve stays as drift, and the
overseer turns persistent drift into STATE_DRIFT → LOCK.

Writes are a single guarded UPDATE (`WHERE status = 'submitted'`), so a concurrent desk update
always wins and nothing is ever moved backwards.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

from ledger import Ledger


def transitions(rec: dict[str, Any], executions_available: bool) -> list[dict[str, Any]]:
    if not executions_available:
        return []
    return [{"intentId": x["ref"], "symbol": x.get("symbol"), "from": "submitted", "to": "cancelled", "evidence": x["detail"]}
            for x in rec.get("drift") or [] if x["code"] == "ORPHAN_INTENT" and x.get("ref")]


def apply(d: Path, trans: list[dict[str, Any]], ledger: Ledger, actor: str, now: float) -> list[dict[str, Any]]:
    done = []
    p = Path(d) / "desk.db"
    if not trans or not p.exists():
        return done
    c = sqlite3.connect(p, timeout=10, isolation_level=None)
    try:
        for t in trans:
            row = c.execute("SELECT result FROM intents WHERE intent_id = ? AND status = 'submitted'", (t["intentId"],)).fetchone()
            if row is None:
                continue
            try:
                res = json.loads(row[0]) if row[0] else {}
            except ValueError:
                res = {"raw": row[0]}
            if not isinstance(res, dict):
                res = {"raw": res}
            res["brokerTruth"] = {"to": "cancelled", "evidence": t["evidence"], "at": now, "by": actor}
            cur = c.execute("UPDATE intents SET status = 'cancelled', result = ?, updated = ? WHERE intent_id = ? AND status = 'submitted'",
                            (json.dumps(res, default=str), now, t["intentId"]))
            if cur.rowcount:
                ledger.append("broker_truth", t, ref=t["intentId"], verdict="CANCELLED", actor=actor)
                done.append(t)
    finally:
        c.close()
    return done
