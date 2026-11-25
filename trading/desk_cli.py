"""desk-cli: GUI-independent trading desk control. Works from PowerShell and Git Bash; no Tauri.

  desk-cli status [--json]
  desk-cli watch [--interval 2s] [--count N] [--json]
  desk-cli reconcile [--json] [--source auto|bridge|tws] [--lock-on-drift]     exit 2 on drift
  desk-cli lock [--reason TEXT]
  desk-cli unlock                                                              dual confirmation, needs a fresh passing reconcile
  desk-cli halt [--reason TEXT]                                                lock + stop autonomous entries (no broker change)
  desk-cli kill [--mode selective|all] [--symbol SYM ...] [--cancel-entries]   dual confirmation
  desk-cli audit [--limit 25] [--source ledger|db] [--verify] [--json]
  desk-cli overseer [--interval S] [--once] [--detach] [--arm | --disarm]
  desk-cli overseer-snapshot [--json]

Destructive commands (kill, flatten, cancel, unlock, arm/disarm) need two-stage confirmation:
a y/N prompt that shows the exact impact (positions, working orders, unrealized P&L), then a
typed token ("CONFIRM FLATTEN", "CONFIRM LIQUIDATE SPY", "CONFIRM CANCEL", "CONFIRM UNLOCK", ...).
Non-interactive: `--system-trigger <reason>` (never accepted for unlock / disarm) or
`--force --confirm-token <token>`. Every confirmation, refusal and action goes to the
append-only ledger (data/trading/ledger.jsonl).

Exit codes: 0 ok · 1 error · 2 reconcile drift / check failed · 3 confirmation refused or aborted
            · 4 refused by a safety rule (e.g. unlock without a passing reconcile) · 5 action partly failed
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, TextIO

sys.path.insert(0, str(Path(__file__).resolve().parent))

import desk_lock  # noqa: E402
import desk_sources as src  # noqa: E402
import reconcile as rc  # noqa: E402
import risk_policy  # noqa: E402
from config import data_dir  # noqa: E402
from ledger import Ledger  # noqa: E402

EXIT_OK, EXIT_ERR, EXIT_DRIFT, EXIT_CONFIRM, EXIT_REFUSED, EXIT_PARTIAL = 0, 1, 2, 3, 4, 5
ALL_STATUSES = ("submitted", "closed_stop", "submitting", "closed", "rejected", "failed", "hypothetical", "expired",
                "dismissed", "pending_approval", "cancelled")


@dataclass
class Deps:
    d: Path
    adapter_factory: Callable[[int, bool], Any] | None = None
    bridge_get: Callable[[str], dict] = src.http_get
    clock: Callable[[], float] = time.time
    stdin: TextIO = field(default_factory=lambda: sys.stdin)
    stdout: TextIO = field(default_factory=lambda: sys.stdout)
    stderr: TextIO = field(default_factory=lambda: sys.stderr)
    is_tty: Callable[[], bool] | None = None
    sleep: Callable[[float], Any] = asyncio.sleep
    cc_probe: Any = None
    ids: dict[str, int] | None = None
    bridge_cancel: Any = "http"  # the bridge's POST /orders/cancel for executor-owned orders; None = no route

    def __post_init__(self) -> None:
        self.d = Path(self.d)
        if self.adapter_factory is None:
            from tws_adapter import IbAdapter

            self.adapter_factory = lambda cid, ro: IbAdapter(cid, readonly=ro, d=self.d)  # noqa: E731
        if self.is_tty is None:
            self.is_tty = lambda: bool(getattr(self.stdin, "isatty", lambda: False)()) and bool(getattr(self.stderr, "isatty", lambda: False)())
        if self.ids is None:
            from tws_adapter import client_ids

            self.ids = client_ids()
        if self.bridge_cancel == "http":
            self.bridge_cancel = src.bridge_cancel_http("cli")

    @property
    def ledger(self) -> Ledger:
        return Ledger(self.d / "ledger.jsonl")


class Refused(Exception):
    def __init__(self, msg: str, code: int = EXIT_CONFIRM) -> None:
        super().__init__(msg)
        self.code = code


# ── output helpers ───────────────────────────────────────────────────────
def _emit(deps: Deps, args: argparse.Namespace, data: dict[str, Any], text: str) -> None:
    if getattr(args, "json", False):
        deps.stdout.write(json.dumps(data, indent=2, default=str) + "\n")
    else:
        deps.stdout.write(text.rstrip() + "\n")
    deps.stdout.flush()


def _say(deps: Deps, msg: str) -> None:
    """Prompts and progress go to stderr, so --json stdout stays parseable."""
    deps.stderr.write(msg + "\n")
    deps.stderr.flush()


def _money(v: Any) -> str:
    return "—" if v is None else f"{v:,.2f}"


def _policy(deps: Deps) -> dict[str, Any]:
    p = risk_policy.policy_path(deps.d)
    return risk_policy.load_policy(p) if p.exists() else risk_policy.defaults()


# ── broker views ─────────────────────────────────────────────────────────
async def _broker(deps: Deps, source: str = "auto") -> tuple[dict[str, Any], dict[str, Any] | None]:
    now = deps.clock()
    snap, err = src.bridge_snapshot(deps.bridge_get, now)
    adapter = None
    if source in ("auto", "tws"):
        adapter = deps.adapter_factory(deps.ids["cli"], True)  # read-only client 22
        # Another desk-cli may hold 22 for a moment: wait for the lease rather than lose the broker view.
        from tws_adapter import LeaseBusy

        deadline = deps.clock() + 15
        while True:
            try:
                await adapter.connect()
                break
            except LeaseBusy:
                if deps.clock() >= deadline:
                    break
                await deps.sleep(0.5)
            except Exception:  # noqa: BLE001 — gather() records the error and falls back to the bridge
                break
    try:
        view = await src.gather(adapter=adapter, snap=snap if source != "tws" else None)
    finally:
        if adapter is not None:
            try:
                adapter.disconnect()
            except Exception:  # noqa: BLE001
                pass
    if err:
        view.setdefault("errors", []).append(err)
    return view, snap


def _reconcile(deps: Deps, view: dict[str, Any], *, persist: bool = True) -> dict[str, Any] | None:
    if view.get("positions") is None:
        return None
    st_path = deps.d / "reconcile_state.json"
    naked = (src.read_json(st_path) or {}).get("nakedSince") or {}
    pol = _policy(deps)
    rep = rc.reconcile(positions=view["positions"], orders=view["orders"], executions=view["executions"],
                       intents=src.desk_intents(deps.d, ALL_STATUSES), now=deps.clock(), naked_since=naked,
                       options_exempt=pol["pretrade"]["options_exempt_from_stop"])
    if persist:
        src.write_json(st_path, {"nakedSince": rep["nakedSince"], "at": rep["at"]})
    return rep


def _impact(view: dict[str, Any], snap: dict[str, Any] | None, *, symbols: set[str] | None = None,
            order_filter: Callable[[dict[str, Any]], bool] | None = None) -> dict[str, Any]:
    positions = [p for p in view.get("positions") or [] if symbols is None or (p.get("underlying") or p["symbol"]) in symbols or p["symbol"] in symbols]
    orders = [o for o in view.get("orders") or [] if order_filter is None or order_filter(o)]
    unreal = [p.get("unrealizedPnl") for p in positions]
    return {
        "positions": [{k: p.get(k) for k in ("symbol", "conId", "position", "avgCost", "marketPrice", "unrealizedPnl")} for p in positions],
        "orders": [{k: o.get(k) for k in ("orderId", "clientId", "symbol", "action", "quantity", "orderType", "limitPrice", "stopPrice", "tif",
                                          "status", "orderRef")} for o in orders],
        "unrealizedPnl": None if any(u is None for u in unreal) else round(sum(unreal), 2),
        "accountDailyPnl": ((snap or {}).get("pnl") or {}).get("daily"),
        "brokerSource": view.get("source"),
    }


def _impact_text(imp: dict[str, Any]) -> str:
    lines = [f"  source: {imp['brokerSource']}"]
    lines.append(f"  positions affected ({len(imp['positions'])}):")
    for p in imp["positions"]:
        lines.append(f"    {p['symbol']:<8} qty {p['position']:>8g}  avg {_money(p['avgCost'])}  mark {_money(p['marketPrice'])}  uPnL {_money(p['unrealizedPnl'])}")
    lines.append(f"  working orders affected ({len(imp['orders'])}):")
    for o in imp["orders"]:
        px = o.get("stopPrice") or o.get("limitPrice")
        lines.append(f"    #{o['orderId']:<6} c{o['clientId']:<3} {o['action']:<4} {o['quantity']:g} {o['symbol']} {o['orderType']} {_money(px) if px else ''} {o['tif']} {o['status']} ref={o['orderRef']}")
    lines.append(f"  unrealized P&L at risk: {_money(imp['unrealizedPnl'])}   account daily P&L: {_money(imp['accountDailyPnl'])}")
    return "\n".join(lines)


# ── two-stage confirmation ───────────────────────────────────────────────
def confirm(deps: Deps, args: argparse.Namespace, *, action: str, token: str, impact: dict[str, Any] | None,
            allow_system_trigger: bool = True) -> str:
    """Returns how it was confirmed ("interactive" | "system-trigger" | "forced"); raises Refused otherwise."""
    led = deps.ledger
    base = {"action": action, "token": token, "impact": impact}
    _say(deps, f"\n== {action} ==")
    if impact is not None:
        _say(deps, _impact_text(impact))
    trig = getattr(args, "system_trigger", None)
    if trig:
        if not allow_system_trigger:
            led.append("confirmation", {**base, "via": "system-trigger", "reason": trig}, ref=action, verdict="REFUSED", actor="cli")
            raise Refused(f"{action} can't be system-triggered; a human must confirm it")
        led.append("confirmation", {**base, "via": "system-trigger", "reason": trig[:300]}, ref=action, verdict="SYSTEM_TRIGGER", actor="cli")
        return "system-trigger"
    if getattr(args, "force", False):
        if getattr(args, "confirm_token", None) != token:
            led.append("confirmation", {**base, "via": "force", "given": getattr(args, "confirm_token", None)}, ref=action, verdict="REFUSED", actor="cli")
            raise Refused(f'--force needs --confirm-token "{token}"')
        led.append("confirmation", {**base, "via": "force"}, ref=action, verdict="FORCED", actor="cli")
        return "forced"
    if not deps.is_tty():
        led.append("confirmation", {**base, "via": "non-interactive"}, ref=action, verdict="REFUSED", actor="cli")
        raise Refused(f'non-interactive {action} needs --system-trigger "<reason>" or --force --confirm-token "{token}"')
    deps.stderr.write("Proceed? [y/N] ")
    deps.stderr.flush()
    a = (deps.stdin.readline() or "").strip().lower()
    if a not in ("y", "yes"):
        led.append("confirmation", {**base, "via": "interactive", "stage": 1, "answer": a[:20]}, ref=action, verdict="ABORTED", actor="cli")
        raise Refused("aborted")
    deps.stderr.write(f'Type "{token}" to confirm: ')
    deps.stderr.flush()
    typed = (deps.stdin.readline() or "").strip()
    if typed != token:
        led.append("confirmation", {**base, "via": "interactive", "stage": 2}, ref=action, verdict="ABORTED", actor="cli")
        raise Refused("confirmation token did not match; aborted")
    led.append("confirmation", {**base, "via": "interactive"}, ref=action, verdict="CONFIRMED", actor="cli")
    return "interactive"


# ── commands ─────────────────────────────────────────────────────────────
def _overseer_info(deps: Deps) -> dict[str, Any]:
    hb = src.read_json(deps.d / "overseer_heartbeat.json") or {}
    from overseer import armed

    age = deps.clock() - float(hb.get("at") or 0) if hb else None
    return {"running": bool(hb) and age is not None and age < 60, "heartbeatAgeS": None if age is None else round(age, 1),
            "armed": armed(deps.d), "dms": hb.get("dms"), "lost": hb.get("lost"), "pid": hb.get("pid")}


async def status_data(deps: Deps, adapter: Any = None) -> dict[str, Any]:
    """`adapter`: a read-only client of its own (25, never 22 which kill/unlock need). The bridge's order list
    can't be trusted for other clients' orders (its ib cache never hears that they were cancelled), so working
    orders and bracket status come from TWS; the bridge is only the fallback, flagged as possibly stale."""
    now = deps.clock()
    snap, err = src.bridge_snapshot(deps.bridge_get, now)
    view = await src.gather(adapter=adapter, snap=snap)
    if view.get("source") == "bridge":
        view.setdefault("errors", []).append("orders from the bridge cache: other clients' cancels may not show; run `reconcile`")
    pos = []
    if view and view.get("positions") is not None:
        for p in view["positions"]:
            b = rc.bracket_status(p, view["orders"], options_exempt=True)
            pos.append({**{k: p.get(k) for k in ("symbol", "conId", "secType", "position", "avgCost", "marketPrice", "unrealizedPnl")},
                        "bracket": b["status"], "stop": (b.get("stop") or {}).get("price"), "takeProfit": (b.get("takeProfit") or {}).get("price")})
    st = desk_lock.read_state(deps.d)
    lk = desk_lock.read_lock(deps.d)
    return {
        "at": now, "lock": {"locked": lk is not None, **({k: lk.get(k) for k in ("reason", "actor", "at", "incidentId", "source", "requiresReconcile")} if lk else {}),
                            "breakers": [b.get("code") for b in (lk or {}).get("breakers") or []]},
        "desk": {"mode": st.get("mode", "ADVISORY"), "agentHalted": st.get("agentHalted", False)},
        "bridge": {"state": (snap or {}).get("state", "BRIDGE_OFFLINE"), "ageS": None if not snap else round(snap["ageS"], 1), "error": err,
                   "clientId": (snap or {}).get("clientId"), "port": (snap or {}).get("port")},
        "account": {k: ((snap or {}).get("account") or {}).get(k) for k in ("account", "currency", "netLiquidation")},
        "pnl": (snap or {}).get("pnl"),
        "positions": pos, "workingOrders": len((view or {}).get("orders") or []),
        "brokerSource": (view or {}).get("source"), "brokerErrors": (view or {}).get("errors"),
        "overseer": _overseer_info(deps),
    }


def status_text(s: dict[str, Any]) -> str:
    lk = s["lock"]
    out = [f"LOCK      {'LOCKED' if lk['locked'] else 'unlocked'}" + (f" — {lk.get('reason')} ({', '.join(lk['breakers'])})" if lk["locked"] else ""),
           f"DESK      mode {s['desk']['mode']}  agentHalted {s['desk']['agentHalted']}",
           f"BRIDGE    {s['bridge']['state']}  client {s['bridge']['clientId']}  port {s['bridge']['port']}  age {s['bridge']['ageS']}s"
           + (f"  ({s['bridge']['error']})" if s["bridge"]["error"] else ""),
           f"ACCOUNT   {s['account'].get('account')}  NLV {_money(s['account'].get('netLiquidation'))} {s['account'].get('currency') or ''}"
           f"  daily P&L {_money((s['pnl'] or {}).get('daily'))}  unrealized {_money((s['pnl'] or {}).get('unrealized'))}",
           f"POSITIONS ({len(s['positions'])})   working orders {s['workingOrders']}   source {s['brokerSource']}"]
    for e in s.get("brokerErrors") or []:
        out.append(f"  ! {e}")
    for p in s["positions"]:
        out.append(f"  {p['symbol']:<8} {p['position']:>6g} @ {_money(p['avgCost'])}  mark {_money(p['marketPrice'])}  uPnL {_money(p['unrealizedPnl'])}"
                   f"  bracket {p['bracket']} (stop {_money(p['stop'])}, tp {_money(p['takeProfit'])})")
    o = s["overseer"]
    out.append(f"OVERSEER  {'running' if o['running'] else 'not running'}  {'ARMED' if o['armed'] else 'observe'}  DMS {o['dms']}"
               + (f"  heartbeat {o['heartbeatAgeS']}s ago" if o["heartbeatAgeS"] is not None else ""))
    return "\n".join(out)


def _status_adapter(deps: Deps, args: argparse.Namespace) -> Any:
    return None if getattr(args, "bridge_only", False) else deps.adapter_factory(deps.ids["status"], True)


def _close(adapter: Any) -> None:
    if adapter is not None:
        try:
            adapter.disconnect()
        except Exception:  # noqa: BLE001
            pass


async def cmd_status(deps: Deps, args: argparse.Namespace) -> int:
    adapter = _status_adapter(deps, args)
    try:
        s = await status_data(deps, adapter)
    finally:
        _close(adapter)
    _emit(deps, args, s, status_text(s))
    return EXIT_OK


def _interval(v: str) -> float:
    m = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*(ms|s|m)?\s*", v or "")
    if not m:
        raise argparse.ArgumentTypeError(f"bad interval {v!r} (e.g. 2s, 500ms, 1m)")
    n, u = float(m.group(1)), m.group(2) or "s"
    s = n / 1000 if u == "ms" else n * 60 if u == "m" else n
    if s < 0.5:
        raise argparse.ArgumentTypeError("interval must be at least 0.5s")
    return s


async def cmd_watch(deps: Deps, args: argparse.Namespace) -> int:
    n = 0
    adapter = _status_adapter(deps, args)  # one read-only session for the whole watch
    try:
        return await _watch_loop(deps, args, adapter)
    finally:
        _close(adapter)


async def _watch_loop(deps: Deps, args: argparse.Namespace, adapter: Any) -> int:
    n = 0
    while args.count is None or n < args.count:
        n += 1
        s = await status_data(deps, adapter)
        if args.json:
            deps.stdout.write(json.dumps(s, default=str) + "\n")
        else:
            if deps.is_tty():
                deps.stdout.write("\x1b[2J\x1b[H")
            deps.stdout.write(time.strftime("%H:%M:%S") + "\n" + status_text(s) + "\n")
        deps.stdout.flush()
        if args.count is not None and n >= args.count:
            break
        await deps.sleep(args.interval)
    return EXIT_OK


def reconcile_text(rep: dict[str, Any]) -> str:
    out = [f"RECONCILE {'OK' if rep['ok'] else 'DRIFT'}  positions {rep['counts']['positions']}  orders {rep['counts']['orders']}"
           f"  drift {rep['counts']['drift']}  warnings {rep['counts']['warn']}"]
    for p in rep["positions"]:
        b = p["bracket"]
        out.append(f"  {p['symbol']:<8} {p['position']:>6g}  expected {p.get('expectedQty')}  bracket {b['status']}"
                   f"  stop {_money((b.get('stop') or {}).get('price'))} x{b.get('stopQty')}  tp {_money((b.get('takeProfit') or {}).get('price'))} x{b.get('tpQty')}"
                   f"  intents {','.join(p.get('intents') or []) or '—'}")
    for o in rep["orders"]:
        px = o.get("stopPrice") or o.get("limitPrice")
        out.append(f"  order #{o['orderId']} c{o['clientId']} {o['action']} {o['quantity']:g} {o['symbol']} {o['orderType']} {_money(px) if px else ''}"
                   f" {o['tif']} {o['status']} role={o['role']} ref={o['orderRef']}")
    for x in rep["drift"]:
        out.append(f"  [{x['severity'].upper()}] {x['code']} {x.get('symbol', '')} {x.get('ref', '')} — {x['detail']}")
    return "\n".join(out)


async def cmd_reconcile(deps: Deps, args: argparse.Namespace) -> int:
    view, snap = await _broker(deps, args.source)
    rep = _reconcile(deps, view)
    if rep is None:
        _emit(deps, args, {"ok": False, "error": "no broker source", "errors": view.get("errors")},
              "RECONCILE FAILED: no broker source\n" + "\n".join(view.get("errors") or []))
        deps.ledger.append("reconcile", {"ok": False, "errors": view.get("errors")}, ref="reconcile", verdict="NO_SOURCE", actor="cli")
        return EXIT_DRIFT
    if args.apply_broker_truth:
        import broker_truth

        trans = broker_truth.transitions(rep, view.get("executions") is not None)
        if trans:
            confirm(deps, args, action="APPLY BROKER TRUTH: mark desk intents with no order, fill or position at TWS as cancelled",
                    token="CONFIRM BROKER TRUTH", impact={"positions": [], "orders": [], "unrealizedPnl": None, "accountDailyPnl": None,
                                                          "brokerSource": view.get("source"), "transitions": trans})
            for t in trans:
                _say(deps, f"  {t['intentId']} {t['symbol']}: submitted → cancelled ({t['evidence']})")
            rep["brokerTruthApplied"] = broker_truth.apply(deps.d, trans, deps.ledger, "cli", deps.clock())
            rep = {**_reconcile(deps, view), "brokerTruthApplied": rep["brokerTruthApplied"]}
        elif view.get("executions") is None:
            _say(deps, "broker truth not applied: TWS executions unavailable (nothing moves without them)")
    rep["brokerSource"], rep["brokerErrors"] = view.get("source"), view.get("errors")
    summary ={"ok": rep["ok"], "counts": rep["counts"], "drift": [(x["code"], x.get("symbol")) for x in rep["drift"]], "source": view.get("source")}
    desk_lock.write_reconcile_stamp(deps.d, rep["ok"], summary, now=deps.clock())
    deps.ledger.append("reconcile", summary, ref="reconcile", verdict="OK" if rep["ok"] else "DRIFT", actor="cli")
    if not rep["ok"] and args.lock_on_drift:
        lk = desk_lock.lock(deps.d, "STATE_DRIFT (desk-cli reconcile --lock-on-drift)", "cli", breaker="STATE_DRIFT",
                            detail="; ".join(f"{a} {b}" for a, b in summary["drift"]))
        deps.ledger.append("lock", {"breaker": "STATE_DRIFT", "incidentId": lk.get("incidentId")}, ref="STATE_DRIFT", verdict="LOCKED", actor="cli")
        rep["locked"] = True
    _emit(deps, args, rep, reconcile_text(rep))
    return EXIT_OK if rep["ok"] else EXIT_DRIFT


async def cmd_lock(deps: Deps, args: argparse.Namespace) -> int:
    reason = (args.reason or "operator lock (desk-cli)")[:300]
    lk = desk_lock.lock(deps.d, reason, "cli", breaker="MANUAL_LOCK", detail=reason, now=deps.clock())
    deps.ledger.append("lock", {"reason": reason, "incidentId": lk.get("incidentId")}, ref="MANUAL_LOCK", verdict="LOCKED", actor="cli")
    _emit(deps, args, {"ok": True, "lock": lk}, f"LOCKED ({lk.get('incidentId')}): {lk.get('reason')}\nBroker-side brackets are untouched; new intents are refused.")
    return EXIT_OK


async def cmd_halt(deps: Deps, args: argparse.Namespace) -> int:
    reason = (args.reason or "operator halt (desk-cli)")[:300]
    lk = desk_lock.lock(deps.d, reason, "cli", breaker="HALT", detail=reason, now=deps.clock())
    st = desk_lock.halt_autonomy(deps.d, deps.clock())
    deps.ledger.append("halt", {"reason": reason, "incidentId": lk.get("incidentId"), "mode": st["mode"]}, ref="HALT", verdict="LOCKED", actor="cli")
    _emit(deps, args, {"ok": True, "lock": lk, "state": {"mode": st["mode"], "agentHalted": st["agentHalted"]}},
          f"HALTED: desk LOCKED, mode ADVISORY, agent halted. No order was cancelled; brackets stay at the broker.")
    return EXIT_OK


async def cmd_unlock(deps: Deps, args: argparse.Namespace) -> int:
    lk = desk_lock.read_lock(deps.d)
    if lk is None:
        _emit(deps, args, {"ok": True, "locked": False, "note": "was not locked"}, "not locked")
        return EXIT_OK
    pol = _policy(deps)
    # A fresh reconcile is part of the unlock: it must pass now, not just at some earlier time.
    view, snap = await _broker(deps, "auto")
    rep = _reconcile(deps, view)
    ok = rep is not None and rep["ok"]
    desk_lock.write_reconcile_stamp(deps.d, ok, {"by": "unlock", "drift": [(x["code"], x.get("symbol")) for x in (rep or {}).get("drift", [])]},
                                    now=deps.clock())
    deps.ledger.append("reconcile", {"ok": ok, "for": "unlock"}, ref="reconcile", verdict="OK" if ok else "DRIFT", actor="cli")
    blockers = desk_lock.unlock_blockers(deps.d, pol["unlock"]["reconcile_max_age_s"], now=deps.clock())
    if blockers:
        deps.ledger.append("unlock", {"blockers": blockers}, ref=str(lk.get("incidentId", "")), verdict="REFUSED", actor="cli")
        if rep is not None:
            _say(deps, reconcile_text(rep))
        raise Refused("unlock refused: " + "; ".join(blockers), EXIT_REFUSED)
    imp = _impact(view, snap)
    imp["lock"] = {k: lk.get(k) for k in ("reason", "incidentId", "at")}
    imp["breakers"] = [b.get("code") for b in lk.get("breakers") or []]
    confirm(deps, args, action="UNLOCK", token="CONFIRM UNLOCK", impact=imp, allow_system_trigger=False)
    try:
        # Bound to the lock that was previewed: a breaker added while the prompt was open refuses the unlock.
        out = desk_lock.unlock(deps.d, "cli", pol["unlock"]["reconcile_max_age_s"], now=deps.clock(), expected=lk)
    except desk_lock.UnlockRefused as e:
        deps.ledger.append("unlock", {"error": str(e)}, ref=str(lk.get("incidentId", "")), verdict="REFUSED", actor="cli")
        raise Refused(f"unlock refused: {e}", EXIT_REFUSED) from None
    deps.ledger.append("unlock", {"previous": out.get("previous")}, ref=str(lk.get("incidentId", "")), verdict="UNLOCKED", actor="cli")
    _emit(deps, args, {"ok": True, **out}, f"UNLOCKED (was: {lk.get('reason')}). Mode is unchanged; re-arming autonomy is a separate step in the GUI.")
    return EXIT_OK


async def cmd_kill(deps: Deps, args: argparse.Namespace) -> int:
    import safety_actions as sa

    view, snap = await _broker(deps, "auto")
    if view.get("positions") is None:
        # Still lock: a kill must never be blocked by a missing broker view.
        lk = desk_lock.lock(deps.d, "kill requested (broker unreachable)", "cli", breaker="KILL", now=deps.clock())
        deps.ledger.append("kill", {"error": "no broker source", "errors": view.get("errors")}, ref=str(lk.get("incidentId")), verdict="LOCKED_ONLY", actor="cli")
        _emit(deps, args, {"ok": False, "locked": True, "error": "no broker source", "errors": view.get("errors")},
              "LOCKED, but the broker is unreachable: nothing was cancelled or flattened.\n" + "\n".join(view.get("errors") or []))
        return EXIT_PARTIAL
    positions, orders = view["positions"], view["orders"]
    roles = rc.classify_orders(positions, orders)
    if args.mode == "all":
        token = "CONFIRM FLATTEN"
        imp = _impact(view, snap)
        action = "KILL ALL: lock, cancel EVERY working order (brackets included), flatten EVERY position at market"
    else:
        targets = {s.upper() for s in args.symbol or []}
        if not targets and not args.cancel_entries:
            # Default selective targets: what the overseer last scored tier 2, plus naked positions.
            ost = src.read_json(deps.d / "overseer_state.json") or {}
            t2 = {a.get("symbol") for a in (ost.get("assessments") or {}).values() if a.get("tier") == 2}
            naked = {p["symbol"] for p in positions if rc.bracket_status(p, orders)["status"] in ("NAKED", "UNDERSIZED", "NOT_GTC")}
            targets = {s for s in t2 | naked if s}
        unknown = targets - {p.get("underlying") or p["symbol"] for p in positions} - {p["symbol"] for p in positions}
        if unknown:
            raise Refused(f"no open position in {', '.join(sorted(unknown))}", EXIT_REFUSED)
        if not targets and not args.cancel_entries:
            raise Refused("nothing to do: no --symbol, no tier-2 or naked position, and no --cancel-entries", EXIT_REFUSED)
        tcon = {p["conId"] for p in positions if (p.get("underlying") or p["symbol"]) in targets or p["symbol"] in targets}
        imp = _impact(view, snap, symbols=targets or set(),
                      order_filter=lambda o: o["conId"] in tcon or (args.cancel_entries and roles.get(o["orderId"]) in ("entry", "pending_child")))
        if targets:
            token = "CONFIRM LIQUIDATE " + ",".join(sorted(targets))
            action = (f"SELECTIVE KILL: lock, cancel the bracket legs of {', '.join(sorted(targets))} and close only those at market"
                      + (", and cancel unfilled entry orders" if args.cancel_entries else "") + ". Other positions keep their brackets.")
        else:
            token = "CONFIRM CANCEL"
            action = "CANCEL ENTRIES: lock and cancel unfilled entry orders only. Positions and their protective legs are untouched."
    how = confirm(deps, args, action=action, token=token, impact=imp)
    reason = (args.reason or getattr(args, "system_trigger", None) or "desk-cli kill")[:200]
    lk = desk_lock.lock(deps.d, f"kill ({args.mode}): {reason}", "cli", breaker="KILL", detail=reason, now=deps.clock())
    desk_lock.halt_autonomy(deps.d, deps.clock())
    bridge_ok = src.bridge_alive(deps.bridge_get, deps.clock())["ok"]
    act = deps.adapter_factory(deps.ids["cli_act"], False)  # read-write client 23, only now
    results: dict[str, Any] = {"confirmedBy": how, "incidentId": lk.get("incidentId")}
    ok = True
    try:
        await act.connect()
        common = {"act": act, "adapter_factory": deps.adapter_factory, "bridge_alive": bridge_ok, "ledger": deps.ledger, "actor": "cli",
                  "bridge_cancel": deps.bridge_cancel if bridge_ok else None}
        if args.mode == "all":
            r = await sa.flatten_all(act=act, ledger=deps.ledger, actor="cli", ref=f"CLI-KILL-{lk.get('incidentId')}", sleep=deps.sleep)
            results["flatten"] = r
            ok = bool(r.get("ok", True))
        else:
            if args.cancel_entries:
                r = await sa.cancel_entries(positions, orders, **common, sleep=deps.sleep)
                results["cancelEntries"] = r
                ok = ok and not r.get("blocked") and not r.get("unconfirmed")
            liq = []
            for p in positions:
                if p["conId"] in tcon:
                    fresh = await act.open_orders()
                    r = await sa.liquidate_position(p, fresh, **common, ref=f"CLI-LIQ-{p['symbol']}-{int(deps.clock())}", reason=reason, sleep=deps.sleep)
                    liq.append({"symbol": p["symbol"], **r})
                    ok = ok and bool(r.get("ok"))
            results["liquidations"] = liq
    except Exception as e:  # noqa: BLE001
        ok = False
        results["error"] = f"{type(e).__name__}: {e}"
    finally:
        act.disconnect()
    deps.ledger.append("kill", {"mode": args.mode, "token": token, **results}, ref=str(lk.get("incidentId")), verdict="OK" if ok else "PARTIAL", actor="cli")
    _emit(deps, args, {"ok": ok, **results}, json.dumps(results, indent=2, default=str) + f"\n{'DONE' if ok else 'PARTIAL — see the ledger'}; desk LOCKED.")
    return EXIT_OK if ok else EXIT_PARTIAL


async def cmd_audit(deps: Deps, args: argparse.Namespace) -> int:
    if args.source == "db":
        from audit import AuditLog

        p = deps.d / "audit.db"
        if not p.exists():
            _emit(deps, args, {"rows": [], "chain": None}, "no audit.db")
            return EXIT_OK
        al = AuditLog(p)
        rows = list(reversed(al.tail(args.limit)))
        ok, note = al.verify_chain() if args.verify else (None, "not verified (--verify)")
        _emit(deps, args, {"source": "audit.db", "chain": {"ok": ok, "note": note}, "rows": rows},
              "\n".join(f"{time.strftime('%m-%d %H:%M:%S', time.localtime(r['ts']))} {r['kind']:<22} {r['verdict']:<12} {r['actor']:<14} {r['ref']}" for r in rows)
              + f"\nchain: {note}")
        return EXIT_OK if ok in (None, True) else EXIT_DRIFT
    led = deps.ledger
    rows = led.tail(args.limit)
    ok, note = led.verify()
    _emit(deps, args, {"source": str(led.path), "chain": {"ok": ok, "note": note}, "rows": rows},
          "\n".join(f"#{r.get('seq')} {time.strftime('%m-%d %H:%M:%S', time.localtime(r.get('ts') or 0))} {r.get('kind', ''):<20} {r.get('verdict', ''):<14} "
                    f"{r.get('actor', ''):<10} {r.get('ref', '')}" for r in rows) + f"\nchain: {note}")
    return EXIT_OK if ok else EXIT_DRIFT


async def snapshot_data(deps: Deps) -> dict[str, Any]:
    from overseer import Overseer

    ov = Overseer(deps.d, ledger=deps.ledger, adapter_factory=deps.adapter_factory, bridge_get=deps.bridge_get,
                  cc_probe=deps.cc_probe, clock=deps.clock, sleep=deps.sleep, ids={**deps.ids, "overseer": deps.ids["snapshot"]},
                  bridge_cancel=None)  # a dry snapshot never cancels anything
    try:
        t = await ov.tick(dry=True)
    finally:
        ov.close()
    lk = desk_lock.read_lock(deps.d)
    rec = t["reconcile"]
    positions = []
    for p in (rec or {}).get("positions", []):
        a = t["assessments"].get(str(p["conId"])) or {}
        positions.append({"symbol": p["symbol"], "conId": p["conId"], "qty": p["position"], "avgCost": p.get("avgCost"),
                          "bracket": p["bracket"]["status"], "stop": (p["bracket"].get("stop") or {}).get("price"),
                          "takeProfit": (p["bracket"].get("takeProfit") or {}).get("price"), "nakedForS": p.get("nakedForS"),
                          "unrealizedPnl": a.get("unrealizedPnl"), "drawdownPct": a.get("drawdownPct"), "slopeAtrPerBar": a.get("slopeAtrPerBar"),
                          "relVolume": a.get("relVolume"), "atrPct": a.get("atrPct"), "iv": a.get("iv"), "ivFallback": a.get("ivFallback"),
                          "score": a.get("score"), "tier": a.get("tier"), "reasonCodes": a.get("reasonCodes"), "stale": a.get("stale"),
                          "dataAgeS": a.get("dataAgeS")})
    led_rows = deps.ledger.tail(10)
    ok, note = deps.ledger.verify()
    return {
        "at": t["at"],
        "lock": {"locked": lk is not None, "reason": (lk or {}).get("reason"), "incidentId": (lk or {}).get("incidentId"),
                 "requiresReconcile": (lk or {}).get("requiresReconcile"), "breakers": (lk or {}).get("breakers") or []},
        "deadMansSwitch": {"overseer": _overseer_info(deps), "liveView": t["dms"], "lost": t["lost"], "graceS": t["graceS"]},
        "heartbeats": {k: {kk: v.get(kk) for kk in ("ok", "state", "detail", "ageS", "pid", "exitCode")} for k, v in t["heartbeats"].items()},
        "reconcile": None if rec is None else {"ok": rec["ok"], "counts": rec["counts"], "drift": rec["drift"], "source": t["brokerSource"]},
        "positions": positions,
        "circuitBreakers": {"active": t["breakers"], "inLock": [b.get("code") for b in (lk or {}).get("breakers") or []]},
        "plannedActions": t["plannedActions"],
        "brokerErrors": t["brokerErrors"],
        "policyError": t["policyError"],
        "ledger": {"chain": {"ok": ok, "note": note}, "last": [{k: r.get(k) for k in ("seq", "ts", "kind", "ref", "verdict", "actor")} for r in led_rows]},
    }


def snapshot_text(s: dict[str, Any]) -> str:
    lk = s["lock"]
    out = [f"LOCK  {'LOCKED — ' + str(lk['reason']) if lk['locked'] else 'unlocked'}",
           f"DMS   overseer {'running' if s['deadMansSwitch']['overseer']['running'] else 'NOT running'} "
           f"({'ARMED' if s['deadMansSwitch']['overseer']['armed'] else 'observe'}), live view {s['deadMansSwitch']['liveView']}, "
           f"grace {s['deadMansSwitch']['graceS']}s, lost {s['deadMansSwitch']['lost'] or 'none'}"]
    for k, v in s["heartbeats"].items():
        out.append(f"  hb {k:<7} {'ok' if v['ok'] else 'LOST'}  {v.get('state') or ''} {v.get('detail') or ''}")
    r = s["reconcile"]
    out.append(f"RECONCILE {'n/a' if r is None else ('OK' if r['ok'] else 'DRIFT')} {'' if r is None else r['counts']}")
    for p in s["positions"]:
        out.append(f"  {p['symbol']:<6} {p['qty']:g} @ {_money(p['avgCost'])} bracket {p['bracket']} (stop {_money(p['stop'])}, tp {_money(p['takeProfit'])})"
                   f" | uPnL {_money(p['unrealizedPnl'])} dd {p['drawdownPct']}% slope {p['slopeAtrPerBar']} ATR/bar relVol {p['relVolume']}"
                   f" ATR {p['atrPct']}% IV {p['iv']}{' (fallback)' if p['ivFallback'] else ''} → tier {p['tier']} score {p['score']} {p['reasonCodes']}")
    out.append(f"BREAKERS active {[b['code'] for b in s['circuitBreakers']['active']] or 'none'}  in lock {s['circuitBreakers']['inLock'] or 'none'}")
    out.append(f"PLANNED (if armed) {[a['kind'] + ':' + str(a.get('symbol') or a.get('breaker') or a.get('code') or '') for a in s['plannedActions']] or 'nothing'}")
    out.append(f"LEDGER ({s['ledger']['chain']['note']})")
    for e in s["ledger"]["last"]:
        out.append(f"  #{e['seq']} {e['kind']} {e['verdict']} {e['ref']}")
    return "\n".join(out)


async def cmd_snapshot(deps: Deps, args: argparse.Namespace) -> int:
    s = await snapshot_data(deps)
    _emit(deps, args, s, snapshot_text(s))
    return EXIT_OK


async def cmd_overseer(deps: Deps, args: argparse.Namespace) -> int:
    from overseer import Overseer, armed, set_armed

    if args.arm or args.disarm:
        on = bool(args.arm)
        if armed(deps.d) == on:
            _emit(deps, args, {"ok": True, "armed": on}, f"already {'armed' if on else 'in observe mode'}")
            return EXIT_OK
        imp = {"positions": [], "orders": [], "unrealizedPnl": None, "accountDailyPnl": None, "brokerSource": "n/a"}
        confirm(deps, args, action=("ARM the overseer: it may LOCK, cancel entries, place emergency stops and liquidate on its own"
                                    if on else "DISARM the overseer: Dead Man's Switch and Master Stop-Loss stop acting"),
                token="CONFIRM ARM" if on else "CONFIRM DISARM", impact=imp, allow_system_trigger=on)
        data = set_armed(deps.d, on, "cli")
        deps.ledger.append("overseer_arm", data, ref="overseer", verdict="ARMED" if on else "OBSERVE", actor="cli")
        _emit(deps, args, {"ok": True, **data}, f"overseer {'ARMED' if on else 'set to observe'}; a running overseer picks this up on its next tick")
        return EXIT_OK
    if args.detach:
        py = Path(sys.executable)
        pyw = py.with_name("pythonw.exe")
        exe = str(pyw if pyw.exists() else py)
        logf = open(deps.d / "overseer.log", "ab")  # noqa: SIM115 — handed to the child
        flags = 0
        if sys.platform == "win32":
            flags = subprocess.CREATE_NO_WINDOW | subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
        cmd = [exe, str(Path(__file__).resolve()), "overseer"] + (["--interval", str(args.interval)] if args.interval else [])
        p = subprocess.Popen(cmd, cwd=str(Path(__file__).resolve().parent.parent), stdout=logf, stderr=logf, stdin=subprocess.DEVNULL,  # noqa: S603
                             creationflags=flags, close_fds=True, env={**os.environ, "TRADING_DATA_DIR": str(deps.d)})
        deps.ledger.append("overseer_detach", {"pid": p.pid}, ref="overseer", verdict="STARTED", actor="cli")
        _emit(deps, args, {"ok": True, "pid": p.pid, "log": str(deps.d / "overseer.log")}, f"overseer started detached (pid {p.pid}); log {deps.d / 'overseer.log'}")
        return EXIT_OK
    ov = Overseer(deps.d, ledger=deps.ledger, adapter_factory=deps.adapter_factory, bridge_get=deps.bridge_get, cc_probe=deps.cc_probe,
                  clock=deps.clock, sleep=deps.sleep, ids=deps.ids, bridge_cancel=deps.bridge_cancel)
    try:
        await ov.run(interval=args.interval, max_ticks=1 if args.once else None)
    except BlockingIOError:
        raise Refused("another overseer is already running (overseer.lock is held)", EXIT_REFUSED) from None
    _emit(deps, args, {"ok": True, "state": ov.state.get("dms")}, f"overseer stopped (DMS {ov.state.get('dms')})")
    return EXIT_OK


# ── argument parsing ─────────────────────────────────────────────────────
def _confirm_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--system-trigger", metavar="REASON", help="non-interactive, automated caller (logged)")
    p.add_argument("--force", action="store_true", help="non-interactive with --confirm-token")
    p.add_argument("--confirm-token", metavar="TOKEN")


def parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="desk-cli", description="Trading desk control (paper, GUI-independent)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def add(name: str, help_: str) -> argparse.ArgumentParser:
        p = sub.add_parser(name, help=help_)
        p.add_argument("--json", action="store_true", help="machine-readable output")
        return p

    p = add("status", "lock, desk mode, bridge/TWS, positions + brackets, overseer")
    p.add_argument("--bridge-only", action="store_true", help="no TWS session (orders may be stale)")
    p = add("watch", "status, refreshed")
    p.add_argument("--bridge-only", action="store_true", help="no TWS session (orders may be stale)")
    p.add_argument("--interval", type=_interval, default=2.0)
    p.add_argument("--count", type=int, default=None, help="stop after N refreshes")
    p = add("reconcile", "broker ground truth vs the desk; exit 2 on drift")
    p.add_argument("--source", choices=("auto", "bridge", "tws"), default="auto")
    p.add_argument("--lock-on-drift", action="store_true")
    p.add_argument("--apply-broker-truth", action="store_true",
                   help="mark ORPHAN_INTENT desk intents cancelled (needs TWS executions; dual confirmation)")
    _confirm_args(p)
    p = add("lock", "persistent LOCK (blocks new intents; brackets untouched)")
    p.add_argument("--reason")
    p = add("unlock", "remove the LOCK (fresh passing reconcile + dual confirmation)")
    _confirm_args(p)
    p = add("halt", "LOCK + stop autonomous entries (agent halted, mode ADVISORY); no broker change")
    p.add_argument("--reason")
    p = add("kill", "lock, then cancel / liquidate (dual confirmation)")
    p.add_argument("--mode", choices=("selective", "all"), default="selective")
    p.add_argument("--symbol", action="append", help="position to liquidate (repeatable); selective mode")
    p.add_argument("--cancel-entries", action="store_true", help="also cancel unfilled entry orders")
    p.add_argument("--reason")
    _confirm_args(p)
    p = add("audit", "append-only ledger (or the desk's audit.db)")
    p.add_argument("--limit", type=int, default=25)
    p.add_argument("--source", choices=("ledger", "db"), default="ledger")
    p.add_argument("--verify", action="store_true", help="verify the audit.db hash chain too (ledger is always verified)")
    p = add("overseer", "run the Dead Man's Switch / Master Stop-Loss watchdog")
    p.add_argument("--interval", type=float, default=None, help="seconds between ticks (default: policy poll_s)")
    p.add_argument("--once", action="store_true")
    p.add_argument("--detach", action="store_true", help="start in the background (no console window)")
    g = p.add_mutually_exclusive_group()
    g.add_argument("--arm", action="store_true", help="let it act (dual confirmation)")
    g.add_argument("--disarm", action="store_true", help="observe only (dual confirmation)")
    _confirm_args(p)
    add("overseer-snapshot", "one compact payload: lock, heartbeats, positions + breakdown, breakers, last 10 ledger events")
    return ap


COMMANDS = {"status": cmd_status, "watch": cmd_watch, "reconcile": cmd_reconcile, "lock": cmd_lock, "unlock": cmd_unlock,
            "halt": cmd_halt, "kill": cmd_kill, "audit": cmd_audit, "overseer": cmd_overseer, "overseer-snapshot": cmd_snapshot}


def main(argv: list[str] | None = None, deps: Deps | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    args = parser().parse_args(argv)
    if deps is None:
        deps = Deps(d=data_dir())
    try:
        return asyncio.run(COMMANDS[args.cmd](deps, args))
    except Refused as e:
        _say(deps, f"REFUSED: {e}")
        if getattr(args, "json", False):
            deps.stdout.write(json.dumps({"ok": False, "refused": str(e)}) + "\n")
        return e.code
    except risk_policy.PolicyError as e:
        _say(deps, f"POLICY ERROR (fail closed): {e}")
        return EXIT_REFUSED
    except KeyboardInterrupt:
        return EXIT_ERR


if __name__ == "__main__":
    sys.exit(main())
