"""Hardwired Kill Switch (E-Stop).

Order of operations is fixed and every step is attempted even if an earlier
network step fails — the lock is written before ANY network I/O:

  1. Write the persistent lock (`TRADING_LOCKED.json`). From this moment every
     new OrderIntent is refused (Security Detail `kill_switch` check, and the
     executor re-checks the file immediately before placing anything).
  2. Connect with the dedicated kill client id (19) and `reqGlobalCancel()`.
  3. Fetch every open position and submit a MARKET order to flatten each one.
  4. Sever the Trading Agent's loop (caller sets mode ADVISORY + agent halt).
  5. Write an incident snapshot to `incidents/<id>.json` and the audit log.

The lock survives restarts and is only cleared by `reset_lock()` with the typed
confirmation "RESET". If the lock file exists but can't be read, trading is
treated as LOCKED (fail closed).

Dry run: no lock, no cancel, no orders. It connects READ-ONLY, lists exactly
what would be cancelled and flattened, and checks the lock path is writable and
the audit chain verifies — so the E-stop can be rehearsed against the paper
account with TWS still in Read-Only API mode.

CLI (used by the gateway when the bridge is unreachable):
  trading/.venv/Scripts/python trading/kill_switch.py --reason "..." [--dry-run]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
import uuid
from pathlib import Path
from typing import Any, Awaitable, Callable

sys.path.insert(0, str(Path(__file__).resolve().parent))

from audit import AuditLog  # noqa: E402
from config import data_dir, load_config, resolve_endpoint  # noqa: E402

LOCK_NAME = "TRADING_LOCKED.json"
RESET_PHRASE = "RESET"
FILL_WAIT_S = 6.0


def lock_path(d: Path | None = None) -> Path:
    return (d or data_dir()) / LOCK_NAME


def read_lock(d: Path | None = None) -> dict[str, Any] | None:
    """None = unlocked. Any lock file (even unreadable) = locked."""
    p = lock_path(d)
    if not p.exists():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {"locked": True, "reason": "unreadable lock file"}
    except (OSError, ValueError):
        return {"locked": True, "reason": "unreadable lock file"}


def is_locked(d: Path | None = None) -> bool:
    return read_lock(d) is not None


STAMP_LOCK_TIMEOUT_S = 1.0  # the kill stamp never makes the E-stop wait longer than this


def write_lock(reason: str, actor: str, incident_id: str, d: Path | None = None) -> dict[str, Any]:
    """Lock for a kill-switch incident (which then cancels everything and flattens at market). An existing lock
    keeps its first incident as the cause and is stamped `killedAt`, so the options guard knows a flatten ran and
    stands down (allows_risk_reducing). The stamp is best-effort and never raises: it must not stop the E-stop."""
    from contextlib import ExitStack

    p = lock_path(d)
    with ExitStack() as held:
        # desk_lock's file lock, so a concurrent breaker write (overseer / desk-cli) can't overwrite the kill's lock or
        # drop its stamp. Best-effort, at most STAMP_LOCK_TIMEOUT_S: the E-stop never waits on it.
        no_lock = ""
        try:
            from ledger import file_lock

            held.enter_context(file_lock(p.with_name(LOCK_NAME + ".lock"), timeout=STAMP_LOCK_TIMEOUT_S))
        except Exception as e:  # noqa: BLE001
            no_lock = f"{type(e).__name__}: {e}"
        existing = read_lock(d)
        if existing and existing.get("incidentId"):
            return _stamp_killed(p, existing, incident_id, reason, no_lock)
        now = time.time()
        data = {"locked": True, "at": now, "reason": reason, "actor": actor, "incidentId": incident_id, "killedAt": now}
        _write_json(p, data)  # with or without the file lock; if this raises, execute_kill records it and still cancels / flattens
        # Written without the file lock: a concurrent breaker write could replace it. Say so (in-memory only).
        return {**data, "stampFailed": f"lock written without the file lock ({no_lock})"} if no_lock else data


def _stamp_killed(p: Path, existing: dict[str, Any], incident_id: str, reason: str, no_lock: str) -> dict[str, Any]:
    """Mark an already-held lock as flattened by the kill switch (the caller holds desk_lock's file lock unless
    `no_lock` says why not). Never raises: on any failure the lock is returned as it was, with `stampFailed` (the
    bridge's in-process stand-down still stops the guard: Desk.kill)."""
    if "killedAt" in existing:
        return existing
    if no_lock:
        return {**existing, "stampFailed": no_lock}  # unlocked read-modify-write could lose a breaker: don't
    try:
        now = time.time()
        cur = {**existing, "killedAt": now, "killIncidentId": incident_id, "killReason": reason[:300], "updatedAt": now}
        _write_json(p, cur)
        return cur
    except Exception as e:  # noqa: BLE001 — never let the stamp stop the E-stop
        return {**existing, "stampFailed": f"{type(e).__name__}: {e}"}


def _write_json(p: Path, data: dict[str, Any]) -> None:
    tmp = p.with_name(p.name + f".{uuid.uuid4().hex[:6]}.tmp")
    tmp.write_text(json.dumps(data, indent=2, default=str), encoding="utf-8")
    tmp.replace(p)


# Automatic overseer / desk-cli breakers whose only action is "lock": nothing is being flattened or liquidated
# under them, so the options guard's risk-reducing exits (premium stop, expiry flatten) must keep running, or a
# lock (e.g. a REJECTION_STORM the guard's own retries caused) would leave options unguarded into expiry.
# Anything else (the kill switch, the security / gateway failsafes, KILL, DAILY_LOSS, dead-man's-switch breakers,
# an operator's MANUAL_LOCK / HALT, an unreadable lock) stands the guard down, as before.
LOCK_ONLY_BREAKERS = frozenset({"REJECTION_STORM", "STATE_DRIFT", "POLICY_INVALID", "LIMITS_INVALID"})


def allows_risk_reducing(d: Path | None = None) -> bool:
    """True when the options guard may send risk-reducing exits: unlocked, or locked only by LOCK_ONLY_BREAKERS
    (an overseer / desk-cli lock, desk_lock.lock) with no kill-switch flatten since (killedAt) and no security
    hard lock (the remote / Rust failsafe sever execution, and don't overwrite a lock that is already held)."""
    lk = read_lock(d)
    if lk is None:
        return True
    if "killedAt" in lk or lk.get("source") not in ("overseer", "desk-cli") or security_hard_locked(d):
        return False
    breakers = lk.get("breakers")
    # Fail closed on anything malformed: every entry must be a breaker dict whose code is lock-only.
    return (isinstance(breakers, list) and bool(breakers)
            and all(isinstance(b, dict) and str(b.get("code")) in LOCK_ONLY_BREAKERS for b in breakers))


def security_hard_locked(d: Path | None = None) -> bool:
    """The security layer's hard lock (data/security/state.json "hardLocked", AGENTIC_OS_SECURITY_DIR overrides; the
    security dir sits next to the trading data dir). Written by both failsafes (security_api.hard_lock, Rust
    security::shared::hard_lock). Unreadable = locked, like security_api.read_state."""
    env = os.environ.get("AGENTIC_OS_SECURITY_DIR", "").strip()
    p = (Path(env) if env else (d or data_dir()).parent / "security") / "state.json"
    if not p.exists():
        return False
    try:
        s = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return True
    return bool(s.get("hardLocked")) if isinstance(s, dict) else True


def reset_lock(confirm: str, actor: str, audit: AuditLog, d: Path | None = None) -> dict[str, Any]:
    if confirm != RESET_PHRASE:
        raise PermissionError(f'type "{RESET_PHRASE}" to unlock trading')
    prev = read_lock(d)
    if prev is None:
        return {"locked": False, "note": "was not locked"}
    if prev.get("requiresReconcile"):
        # Locks written by the overseer / desk-cli (Dead Man's Switch, breakers, STATE_DRIFT) stay until the
        # broker reconciles clean: run `desk-cli reconcile` (or `desk-cli unlock`) first. Typed RESET still required.
        import desk_lock
        import risk_policy

        try:
            pol = risk_policy.load_policy(risk_policy.policy_path(d or data_dir()))
            max_age = pol["unlock"]["reconcile_max_age_s"]
        except risk_policy.PolicyError:
            max_age = risk_policy.DEFAULTS["unlock"]["reconcile_max_age_s"]
        why = desk_lock.unlock_blockers(d or data_dir(), max_age)
        if why:
            audit.append("kill_switch_reset", {"previous": prev, "refused": why}, ref=str(prev.get("incidentId", "")), verdict="REFUSED", actor=actor)
            raise PermissionError("this lock needs a passing reconcile first (`desk-cli reconcile`): " + "; ".join(why))
    lock_path(d).unlink()
    audit.append("kill_switch_reset", {"previous": prev}, ref=str(prev.get("incidentId", "")), verdict="UNLOCKED", actor=actor)
    return {"locked": False, "previous": prev}


def _flatten_contract(c: Any) -> Any:
    """Position contracts often come back without an exchange; route through SMART."""
    if getattr(c, "secType", "") in ("STK", "OPT", "ETF") or not getattr(c, "exchange", ""):
        c.exchange = "SMART"
    return c


async def execute_kill(
    *,
    reason: str,
    actor: str,
    dry_run: bool,
    connect: Callable[[bool], Awaitable[Any]],
    audit: AuditLog,
    d: Path | None = None,
    market_order: Callable[[str, float], Any] | None = None,
    fill_wait_s: float = FILL_WAIT_S,
    sever: Callable[[], str | None] | None = None,
) -> dict[str, Any]:
    """Run the E-stop. `connect(readonly)` returns a connected ib_async.IB (the kill client id; a read-only dry run
    gets its own, kill_dry, so it can never hold the id a live kill needs). `sever()` (the desk's) halts the agent and
    sets ADVISORY, returning None or why it couldn't; the sever_agent step records that truthfully."""
    d = d or data_dir()
    incident_id = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
    inc: dict[str, Any] = {
        "incidentId": incident_id, "dryRun": dry_run, "reason": reason, "actor": actor,
        "startedAt": time.time(), "steps": [], "cancelled": [], "flatten": [], "errors": [],
    }

    def step(name: str, ok: bool, detail: str = "") -> None:
        inc["steps"].append({"step": name, "ok": ok, "detail": detail, "at": time.time()})

    # 1. Lock first — no network involved.
    if dry_run:
        try:
            probe = d / f".lock-probe-{incident_id}"
            probe.write_text("x", encoding="utf-8")
            probe.unlink()
            step("lock", True, f"dry run: {lock_path(d)} is writable (not written)")
        except OSError as e:
            step("lock", False, f"dry run: lock path not writable: {e}")
    else:
        # A lock-step failure is recorded, never fatal: cancelling and flattening still run below.
        try:
            inc["lock"] = write_lock(reason, actor, incident_id, d)
            stamp = inc["lock"].get("stampFailed")
            step("lock", True, f"TRADING_LOCKED written ({lock_path(d)})")
            if stamp:
                # Its own failed step, so the operator sees it (incident ok=False): the lock holds, but another process
                # may not know a flatten ran (the bridge's in-process stand-down still covers its own options guard).
                step("lock_stamp", False, stamp)
                inc["errors"].append(f"lock stamp: {stamp}")
        except Exception as e:  # noqa: BLE001
            step("lock", False, f"{type(e).__name__}: {e}")
            inc["errors"].append(f"lock: {e}")

    ib = None
    try:
        ib = await connect(dry_run)  # dry run connects read-only
        step("connect", True, "kill client connected" + (" (read-only)" if dry_run else ""))
    except Exception as e:  # noqa: BLE001
        step("connect", False, f"{type(e).__name__}: {e}")
        inc["errors"].append(f"connect: {e}")

    if ib is not None:
        # Disconnect in a finally: a cancelled kill (CancelledError is a BaseException) must not leave the kill's
        # client id bound at TWS, or every later kill fails to connect (326).
        try:
            # 2. Cancel every working order.
            try:
                await asyncio.wait_for(ib.reqAllOpenOrdersAsync(), 8)
                working = [t for t in ib.openTrades() if t.orderStatus.status not in ("Filled", "Cancelled", "ApiCancelled", "Inactive")]
                inc["cancelled"] = [{"orderId": t.order.orderId, "permId": t.order.permId, "symbol": t.contract.symbol,
                                     "action": t.order.action, "qty": t.order.totalQuantity, "type": t.order.orderType} for t in working]
                if not dry_run:
                    ib.reqGlobalCancel()
                step("global_cancel", True, f"{'would cancel' if dry_run else 'reqGlobalCancel sent for'} {len(working)} working order(s)")
            except Exception as e:  # noqa: BLE001
                step("global_cancel", False, f"{type(e).__name__}: {e}")
                inc["errors"].append(f"global_cancel: {e}")

            # 3. Flatten every position with a market order.
            try:
                positions = await asyncio.wait_for(ib.reqPositionsAsync(), 8)
                # Buy back short option legs before selling longs: a vertical is never left as a naked short.
                positions = sorted(positions, key=lambda p: (getattr(p.contract, "secType", "") != "OPT" or float(p.position) > 0))
                trades = []
                for p in positions:
                    qty = float(p.position)
                    if not qty:
                        continue
                    side = "SELL" if qty > 0 else "BUY"
                    row = {"account": p.account, "symbol": p.contract.localSymbol or p.contract.symbol, "secType": p.contract.secType,
                           "conId": p.contract.conId, "position": qty, "action": side, "qty": abs(qty)}
                    if not dry_run:
                        if market_order is None:
                            from ib_async import MarketOrder

                            order = MarketOrder(side, abs(qty))
                        else:
                            order = market_order(side, abs(qty))
                        order.orderRef = f"KILL-{incident_id}"
                        order.tif = "DAY"
                        trade = ib.placeOrder(_flatten_contract(p.contract), order)
                        trades.append((row, trade))
                        row["orderId"] = trade.order.orderId
                    inc["flatten"].append(row)
                if trades and fill_wait_s > 0:
                    deadline = time.monotonic() + fill_wait_s
                    while time.monotonic() < deadline and any(not t.isDone() for _, t in trades):
                        await asyncio.sleep(0.25)
                    for row, t in trades:
                        row["status"] = t.orderStatus.status
                        row["filled"] = t.orderStatus.filled
                        row["errors"] = [e.message for e in t.log if getattr(e, "errorCode", 0)]
                step("flatten", True, f"{'would flatten' if dry_run else 'market orders sent for'} {len(inc['flatten'])} position(s)")
            except Exception as e:  # noqa: BLE001
                step("flatten", False, f"{type(e).__name__}: {e}")
                inc["errors"].append(f"flatten: {e}")
        finally:
            try:
                ib.disconnect()
            except Exception:  # noqa: BLE001
                pass

    # 4. Agent loop severance is applied by the caller (the desk, through `sever`); recorded here.
    if dry_run:
        step("sever_agent", True, "dry run: agent would be halted and mode set to ADVISORY")
    else:
        sever_err = None
        if sever is not None:
            try:
                sever_err = sever()
            except Exception as e:  # noqa: BLE001
                sever_err = f"{type(e).__name__}: {e}"
        step("sever_agent", sever_err is None, sever_err or "agent halted, mode ADVISORY")
        if sever_err:
            inc["errors"].append(f"sever_agent: {sever_err}")

    # 5. Incident snapshot + audit.
    ok_chain, chain_note = audit.verify_chain()
    step("audit_chain", ok_chain, chain_note)
    inc["finishedAt"] = time.time()
    inc["ok"] = all(s["ok"] for s in inc["steps"])
    inc_dir = d / "incidents"
    inc_dir.mkdir(parents=True, exist_ok=True)
    (inc_dir / f"{incident_id}{'-dryrun' if dry_run else ''}.json").write_text(json.dumps(inc, indent=2, default=str), encoding="utf-8")
    audit.append("kill_switch_dry_run" if dry_run else "kill_switch", inc, ref=incident_id,
                 verdict=("DRY_RUN_OK" if inc["ok"] else "DRY_RUN_FAILED") if dry_run else ("LOCKED" if inc["ok"] else "LOCKED_WITH_ERRORS"), actor=actor)
    return inc


def ib_connector(client_id: int | None = None) -> Callable[[bool], Awaitable[Any]]:
    """Connect through the same paper-only endpoint gate: a live kill as the kill client id, a read-only dry run as
    kill_dry. TWS refuses a duplicate client id (326), so a dry run (healthcheck, UI rehearsal) on the kill id would
    make a live E-stop pressed meanwhile fail to connect."""

    async def connect(readonly: bool) -> Any:
        from ib_async import IB

        cfg = load_config()
        ep = resolve_endpoint(cfg)
        if ep.locked or ep.port is None:
            raise ConnectionError("endpoint LOCKED: " + "; ".join(ep.reasons))
        ib = IB()
        cid = client_id or cfg.client_ids["kill_dry" if readonly else "kill"]
        await ib.connectAsync(ep.host, ep.port, clientId=cid, readonly=readonly, timeout=10)
        return ib

    return connect


def main() -> int:
    ap = argparse.ArgumentParser(description="Trading kill switch (E-stop)")
    ap.add_argument("--reason", default="manual kill switch (CLI)")
    ap.add_argument("--actor", default="cli")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    inc = asyncio.run(execute_kill(reason=args.reason, actor=args.actor, dry_run=args.dry_run,
                                   connect=ib_connector(), audit=AuditLog(data_dir() / "audit.db")))
    print(json.dumps({k: inc[k] for k in ("incidentId", "dryRun", "ok", "steps", "cancelled", "flatten", "errors")}, indent=2, default=str))
    return 0 if inc["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
