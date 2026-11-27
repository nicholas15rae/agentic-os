"""Trading pipeline health check — read-only, safe to run any time.

Proves the live system is wired and safe, stage by stage, and says exactly which
stage is broken. Nothing is ever sent to the broker:

  * the gate probe builds a synthetic 1-share SPY intent and EVALUATES it in
    memory against live quotes / bars / account data — it is never submitted,
    stored, or counted toward cooldowns;
  * the kill switch runs as a DRY RUN (read-only connection; it only writes its
    usual audit row and dry-run incident file);
  * engines scan / read chains with submit disabled.

Each check returns PASS / WARN / FAIL / SKIP with a one-line detail. Overall is
the worst status. Run from the UI ("Run check"), the gateway
(POST /api/trading/health/check), the CLI (`python trading/healthcheck.py`), or
automatically every trading day at 09:00 New York before the open (not on NYSE holidays).

One connection state everywhere: the stored result's broker.bridge row is replaced by the LIVE
bridge state whenever it is read (`with_live_bridge`), and the result is marked stale ("as of
HH:MM") when the connection changed since it ran; the morning loop then re-runs the whole check.
"""

from __future__ import annotations

import asyncio
import dataclasses
import json
import socket
import struct
import sys
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Callable
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent))

PASS, WARN, FAIL, SKIP = "PASS", "WARN", "FAIL", "SKIP"
ORDER = {PASS: 0, SKIP: 0, WARN: 1, FAIL: 2}
NY = ZoneInfo("America/New_York")

# name -> max seconds since the loop's last iteration before it counts as stalled
# "agent" is gone: the LLM Trading Agent loop is retired. Engine R scans on the CPU; the analyst ticks every minute.
LOOP_LIMITS = {"drawdown_monitor": 60, "options_guard": 240, "auto_scan": 120, "intel": 240, "rule_engine": 120, "analyst": 300}
FRESH_TELEMETRY_S = 20
RERUN_STABLE_S = 60        # the live state must hold this long before an automatic re-run
RERUN_MIN_GAP_S = 600      # and automatic re-runs are at least this far apart


@dataclasses.dataclass
class Check:
    stage: str
    name: str
    status: str
    detail: str
    ms: int = 0

    def to_dict(self) -> dict[str, Any]:
        return dataclasses.asdict(self)


def overall(checks: list[Check]) -> str:
    worst = max((ORDER[c.status] for c in checks), default=0)
    return {0: PASS, 1: WARN, 2: FAIL}[worst]


def tws_listening(port: int = 7497, timeout: float = 0.6) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout):
            return True
    except OSError:
        return False


def api_handshake_accepted(ip: str, port: int = 7497, timeout: float = 2.0) -> bool:
    """Does TWS accept the IB API handshake from `ip`? A bare TCP connect isn't enough: TWS listens
    on every interface even with "Allow connections from localhost only" ticked, then aborts the
    connection at the handshake. Only a server-version reply means a client could actually trade."""
    try:
        s = socket.create_connection((ip, port), timeout=timeout)
    except OSError:
        return False
    try:
        msg = b"v100..187"
        s.sendall(b"API\x00" + struct.pack(">I", len(msg)) + msg)
        s.settimeout(timeout)
        return bool(s.recv(64))
    except OSError:  # timeout, ConnectionAbortedError / ResetError = refused at the handshake
        return False
    finally:
        s.close()


def is_cgnat(ip: str) -> bool:
    """100.64.0.0/10: the shared address space mesh VPNs (NetBird, Tailscale) hand out."""
    parts = ip.split(".")
    return len(parts) == 4 and parts[0] == "100" and parts[1].isdigit() and 64 <= int(parts[1]) <= 127


def lan_exposed(port: int = 7497, timeout: float = 2.0) -> list[str]:
    """Non-loopback addresses of this machine on which TWS accepts the IB API handshake."""
    try:
        addrs = {a[4][0] for a in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)}
    except OSError:
        return []
    return [ip for ip in sorted(a for a in addrs if not a.startswith("127.")) if api_handshake_accepted(ip, port, timeout)]


def bridge_check(snap: dict[str, Any], now: float) -> tuple[str, str]:
    """The broker.bridge row from a bridge snapshot (shared by run_checks and the live overlay)."""
    from config import is_paper_account

    if snap.get("state") != "CONNECTED":
        why = snap.get("downReason") or "; ".join(snap.get("reasons") or []) or snap.get("lastError") or "is TWS running and logged in to paper?"
        return FAIL, f"bridge {snap.get('state')}: {why}"
    age = now - (snap.get("updatedAt") or 0)
    acct = (snap.get("account") or {}).get("account") or ""
    if not is_paper_account(acct):
        return FAIL, f"connected account {acct!r} is not a paper account"
    if age > FRESH_TELEMETRY_S:
        return WARN, f"telemetry {age:.0f}s old"
    return PASS, f"{acct} · client {snap.get('clientId')} · {'read-only' if snap.get('readOnly') else 'read/write'} · NetLiq {(snap.get('account') or {}).get('netLiquidation')}"


def agent_model_probe(gateway: str = "http://127.0.0.1:8080") -> dict[str, Any]:
    import urllib.request

    with urllib.request.urlopen(f"{gateway}/api/trading/agent/model", timeout=6) as r:  # noqa: S310 — local gateway
        return json.loads(r.read().decode("utf-8"))


async def run_checks(desk: Any, *, dry_run_kill: bool = True, now: float | None = None,
                     lan_probe: Callable[[], list[str]] = lan_exposed,
                     tws_probe: Callable[[], bool] = tws_listening,
                     model_probe: Callable[[], dict[str, Any]] = agent_model_probe) -> dict[str, Any]:
    from config import load_config, resolve_endpoint
    from fx import merged_rates
    from intents import parse_intent
    import kill_switch
    from security_detail import evaluate

    now = now or desk.clock()
    checks: list[Check] = []

    async def step(stage: str, name: str, fn: Callable[[], Any]) -> Any:
        t0 = time.perf_counter()
        try:
            res = fn()
            if asyncio.iscoroutine(res):
                res = await res
            status, detail = res[0], res[1]
            extra = res[2] if len(res) > 2 else None
        except Exception as e:  # noqa: BLE001 — a crashing check is a FAIL, never a crash of the check
            status, detail, extra = FAIL, f"{type(e).__name__}: {e}"[:300], None
        checks.append(Check(stage, name, status, detail, int((time.perf_counter() - t0) * 1000)))
        return extra

    # 1. Safety config ────────────────────────────────────────────────
    def cfg_lock():
        cfg = load_config()
        ep = resolve_endpoint(cfg)
        live = resolve_endpoint(dataclasses.replace(cfg, mode="LIVE", allow_live_execution=True))
        if ep.locked or ep.mode != "PAPER" or ep.port != 7497:
            return FAIL, f"paper endpoint not usable: {'; '.join(ep.reasons) or ep}"
        if not live.locked or live.port is not None:
            return FAIL, "LIVE is NOT locked out"
        return PASS, f"PAPER → {ep.host}:7497; LIVE locked ({live.reasons[0]})"
    await step("safety", "paper_lock", cfg_lock)

    def limits_files():
        lim, olim = desk.limits(), desk.option_limits()
        return PASS, f"risk {lim.max_risk_per_trade_pct}%/trade, daily trip {lim.max_daily_loss_pct}%; options premium {olim.max_premium_pct}%, DTE {olim.min_dte}-{olim.max_dte}"
    await step("safety", "limits_files", limits_files)

    def lock_state():
        lock = kill_switch.read_lock(desk.d)
        st = desk.state()
        if lock:
            return WARN, f"trading LOCKED since {datetime.fromtimestamp(lock.get('at', 0)).strftime('%Y-%m-%d %H:%M')}: {lock.get('reason')} (reset in the UI)"
        if st.get("agentHalted"):
            return WARN, "agent / engines halted"
        return PASS, f"unlocked · mode {st['mode']} · auto-scan {st.get('autoScanMinutes') or 'off'}"
    await step("safety", "kill_lock", lock_state)

    def audit_chain():
        ok, note = desk.audit.verify_chain()
        return (PASS if ok else FAIL), f"hash chain {note}"
    await step("safety", "audit_chain", audit_chain)

    def exposure():
        if not tws_probe():
            return SKIP, "TWS is not listening on 127.0.0.1:7497, so its network exposure can't be tested"
        hits = lan_probe()
        # This PC's own mesh address (CGNAT 100.64.0.0/10: NetBird / Tailscale) is a SELF-connection: TWS
        # accepts it even with localhost-only on and an empty Trusted IPs list, while a real mesh peer is
        # refused (verified 2026-11-24 from the droplet). It says nothing about the mesh, so it's noted,
        # not warned. A LAN address answering is a real network path and stays a WARN.
        mesh = [ip for ip in hits if is_cgnat(ip)]
        lan = [ip for ip in hits if ip not in mesh]
        if lan:
            return WARN, (f"TWS accepts the API handshake on {', '.join(lan)} — tick 'Allow connections from localhost only' in TWS API "
                          "settings; if it's already ticked, remove these addresses from TWS's Trusted IPs")
        if mesh:
            return PASS, (f"LAN refused. TWS answers this PC on its own mesh address {', '.join(mesh)} (a self-connection, not "
                          "exposure); a remote mesh peer must test it: see docs/netbird-least-privilege-acl.md")
        return PASS, "TWS API not reachable from the network"
    await step("safety", "tws_exposure", exposure)

    # 2. Broker connection ────────────────────────────────────────────
    snap = desk.bridge.snapshot()
    connected = snap.get("state") == "CONNECTED"

    await step("broker", "bridge", lambda: bridge_check(snap, now))

    async def fx():
        base = (snap.get("account") or {}).get("currency")
        if not base:
            return SKIP, "no account currency (bridge not connected)"
        rates, prov = await asyncio.to_thread(merged_rates, snap.get("fx") or {}, {"USD"}, base, desk.fx)
        if base != "USD" and not rates.get("USD"):
            return FAIL, f"no USD→{base} rate: every USD order would be rejected"
        return PASS, f"USD→{base} {rates.get('USD', 1.0):.4f} ({prov.get('USD', 'base')})"
    await step("broker", "fx_rate", fx)

    # 3. Market data ──────────────────────────────────────────────────
    bars_box: dict[str, Any] = {}

    async def data():
        if not connected:
            return SKIP, "needs TWS (bridge not connected)"
        bars = await desk.md.daily_bars("SPY")
        bars_box["bars"] = bars
        if len(bars) < 55:
            return FAIL, f"only {len(bars)} daily bars for SPY"
        return PASS, f"{len(bars)} SPY daily bars, last {bars[-1]['date']} close {bars[-1]['close']}"
    await step("data", "daily_bars", data)

    # 4. Gate probe (synthetic intent, evaluated in memory only) ──────
    async def gate():
        if not connected or not bars_box.get("bars"):
            return SKIP, "needs the bridge and daily bars"
        c = float(bars_box["bars"][-1]["close"])
        raw = {"intent_id": f"health-{uuid.uuid4().hex[:12]}", "source": "manual", "asset_class": "etf", "symbol": "SPY",
               "action": "BUY", "quantity": 1, "order_type": "MKT", "stop_loss": round(c * 0.97, 2), "take_profit": round(c * 1.05, 2),
               "citations": ["telemetry:SPY:healthcheck"], "thesis": "health check probe — never submitted"}
        intent = parse_intent(raw)
        ctx = await desk.build_context(intent)
        if ctx.session_open and not (ctx.quote or {}).get("ask"):
            # The first quote after a fresh (re)connect can time out; one retry before calling it broken.
            ctx = await desk.build_context(intent)
        d = evaluate(intent, ctx)
        failed = {x["name"]: x["detail"] for x in d.checks if not x["ok"]}
        closed = ctx.session_open is False
        tolerated = {"cooldown", "duplicate", "daily_order_cap"}  # protective, depend on today's activity
        if closed:
            tolerated |= {"market_hours"}
        quote_less = {"liquidity", "price_sanity", "stop_side", "position_size", "gross_exposure"}
        hard = {k: v for k, v in failed.items() if k not in tolerated}
        if closed and hard and set(hard) <= quote_less and not (ctx.quote or {}).get("ask"):
            return WARN, f"market closed and no SPY quote right now: {', '.join(hard)} could not be checked"
        if hard:
            return FAIL, "; ".join(f"{k}: {v}" for k, v in hard.items())
        note = f"{len(d.checks)} checks ran" + (f"; expected now: {', '.join(sorted(failed))}" if failed else "; all passed")
        return PASS, f"{d.verdict if not failed else 'evaluated'} — {note}"
    await step("gate", "security_detail_probe", gate)

    # 5. Kill switch dry run ───────────────────────────────────────────
    async def kill():
        if not dry_run_kill:
            return SKIP, "skipped (dry_run_kill=False)"
        if not connected:
            return SKIP, "needs TWS (bridge not connected)"
        inc = await desk.kill("health check dry run", "healthcheck", dry_run=True)
        bad = [f"{s['step']}: {s['detail']}" for s in inc["steps"] if not s["ok"]]
        if bad:
            return FAIL, "; ".join(bad)
        return PASS, f"6/6 steps · would cancel {len(inc['cancelled'])} order(s), flatten {len(inc['flatten'])} position(s)"
    await step("kill_switch", "dry_run", kill)

    # 6. Engines ───────────────────────────────────────────────────────
    async def engine_a():
        if not connected:
            return SKIP, "needs TWS (bridge not connected)"
        prev = desk.engine_a.last_scan  # don't overwrite the scan table the UI shows
        try:
            rep = await desk.engine_a.scan(symbols=["SPY", "GLD"], risk_budget_base=1.0, fx_usd=1.0, submit=None)
        finally:
            desk.engine_a.last_scan = prev
        errs = [r for r in rep["rows"] if str(r.get("why", "")).startswith("error")]
        if errs:
            return FAIL, "; ".join(f"{r['symbol']}: {r['why']}" for r in errs)
        return PASS, "; ".join(f"{r['symbol']}: {'SETUP' if r['signal'] else r['why']}" for r in rep["rows"])
    await step("engines", "engine_a_scan", engine_a)

    async def engine_b():
        if not connected:
            return SKIP, "needs TWS (bridge not connected)"
        chain = await desk.md.option_chain("SPY")
        from options import pick_expiry
        exp = pick_expiry(chain["expirations"], now, desk.option_limits())
        if not exp:
            return FAIL, "no SPY expiry inside the DTE window"
        return PASS, f"SPY chain: {len(chain['expirations'])} expiries, {len(chain['strikes'])} strikes; next in window {exp}"
    await step("engines", "engine_b_chain", engine_b)

    # 7. Intel / vault / journal ───────────────────────────────────────
    def vault():
        st = desk.rag.stats()
        if not st["active"]:
            return WARN, "trading_rag is empty: import Discord history / run a Quantgress ingest"
        return PASS, f"{st['active']} active · {st['archived']} archived · " + ", ".join(f"{k} {v}" for k, v in st["byClass"].items())
    await step("intel", "trading_rag", vault)

    def discord():
        st = desk.discord.stats()
        live = desk.discord_status or {}
        errs = [c.get("error") for c in live.get("channels") or [] if c.get("error")]
        if errs:
            return WARN, f"live poll error: {errs[0]}"
        if not st["messages"]:
            return WARN, "no Discord messages imported yet"
        return PASS, f"{st['messages']} messages · {st['calls']} calls · {st['scoredCalls']} scored · {len(st['sources'])} channel(s)"
    await step("intel", "discord", discord)

    def scoring():
        st = desk.discord.stats()
        if st["calls"] and not st["scoredCalls"]:
            return WARN, "calls imported but none scored yet (Score now, or wait for the 6-hourly run)"
        last = desk.last_scoring
        return PASS, f"{st['scoredCalls']} calls scored" + (f"; last run {last['at']}" if last else "")
    await step("intel", "outcome_scoring", scoring)

    def journal():
        rep = desk.journal_pass()
        return PASS, f"journal pass ok ({len(rep.get('closed', []))} newly closed)"
    await step("intel", "journal", journal)

    # 7b. Trading Agent ─────────────────────────────────────────────
    async def agent_model():
        if getattr(desk, "agent", None) is None:
            return SKIP, "agent not started in this process"
        m = await asyncio.to_thread(model_probe)
        # Only the after-hours analyst uses the model now (execution is Engine R, CPU only): a missing model
        # delays the analyst, it never stops trading, so it is a WARN, not a FAIL.
        if not m.get("reachable"):
            return WARN, f"LM Studio unreachable (the after-hours analyst will skip): {m.get('error', '')}"
        if not m.get("loaded"):
            return WARN, f"{m.get('model')} is not loaded in LM Studio (loaded: {', '.join(m.get('loadedModels') or []) or 'none'}); the analyst will skip"
        return PASS, f"{m.get('model')} loaded" + (" · GPU held by the desktop right now" if (m.get("gpu") or {}).get("active") else "")
    await step("agent", "agent_model", agent_model)

    def rule_engine():
        eng = getattr(desk, "rules", None)
        if eng is None:
            return SKIP, "Engine R not started in this process"
        v = eng.view()
        if v["limitsError"]:
            return FAIL, f"hard limits invalid: {v['limitsError']}"
        last = v["lastScan"] or {}
        state = (f"{'on' if v['enabled'] else 'OFF'} · rules v{v['active']['version']} · {v['entriesToday']} entr(y/ies) today"
                 f" · {len(v['pending'])} pending change(s)" + (f" · blocked: {v['blocked']}" if v["blocked"] else ""))
        detail = state + (f" · last scan {last.get('status')}" + (f" ({str(last.get('detail'))[:100]})" if last.get("detail") else "") if last else "")
        return PASS, detail
    await step("agent", "rule_engine", rule_engine)

    def analyst_runs():
        an = getattr(desk, "analyst", None)
        if an is None:
            return SKIP, "analyst not started in this process"
        runs = an.runs(3)
        if not runs:
            return PASS, f"{'on' if an.settings()['enabled'] else 'OFF'} · no runs yet (after the close only)"
        last = runs[0]
        detail = f"last run {last['day']} {last['status']}" + (f" ({str(last['detail'])[:120]})" if last.get("detail") else "")
        if len(runs) >= 3 and all(r["status"] == "skipped" for r in runs):
            return WARN, f"the last {len(runs)} analyst runs were skipped — {detail}"
        return PASS, detail
    await step("agent", "analyst", analyst_runs)

    # 8. Background loops ──────────────────────────────────────────────
    def loops():
        hb = getattr(desk, "heartbeats", {}) or {}
        t_now = max([desk.clock(), now, *hb.values()])
        stale = []
        for name, limit in LOOP_LIMITS.items():
            t = hb.get(name)
            if t is None or t_now - t > limit:
                stale.append(f"{name} ({'never' if t is None else f'{t_now - t:.0f}s ago'})")
        if stale:
            return FAIL, "stalled / not running: " + ", ".join(stale)
        return PASS, ", ".join(f"{k} {t_now - hb[k]:.0f}s ago" for k in LOOP_LIMITS)
    await step("runtime", "background_loops", loops)

    result = {"at": now, "atNy": datetime.fromtimestamp(now, NY).strftime("%Y-%m-%d %H:%M %Z"), "overall": overall(checks),
              "bridgeState": snap.get("state"),
              "counts": {s: sum(1 for c in checks if c.status == s) for s in (PASS, WARN, FAIL, SKIP)},
              "checks": [c.to_dict() for c in checks]}
    out = desk.d / "healthcheck"
    out.mkdir(parents=True, exist_ok=True)
    (out / "latest.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    desk.audit.append("healthcheck", {"overall": result["overall"], "counts": result["counts"],
                                      "failed": [c.name for c in checks if c.status == FAIL]}, ref="healthcheck", verdict=result["overall"], actor="healthcheck")
    return result


def last_result(d: Path, live: dict[str, Any] | None = None, now: float | None = None) -> dict[str, Any] | None:
    """The stored result; with `live` (a bridge snapshot) its connection row is the live one (see with_live_bridge)."""
    try:
        res = json.loads((d / "healthcheck" / "latest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return with_live_bridge(res, live, now if now is not None else time.time()) if live is not None else res


def _stored_bridge(res: dict[str, Any]) -> dict[str, Any] | None:
    return next((c for c in res.get("checks") or [] if c.get("stage") == "broker" and c.get("name") == "bridge"), None)


def with_live_bridge(res: dict[str, Any], snap: dict[str, Any], now: float) -> dict[str, Any]:
    """Replace the stored broker.bridge row with the live bridge state, so the health card can never say FAIL
    while the account card says Connected (or the reverse). If the connection changed since the check ran,
    the result is marked stale: its later stages (SKIPped, or run while it was different) are "as of HH:MM"."""
    res = json.loads(json.dumps(res))
    status, detail = bridge_check(snap, now)
    old = res.get("checks") or []
    idx = next((i for i, c in enumerate(old) if c.get("stage") == "broker" and c.get("name") == "bridge"), None)
    stored = old[idx] if idx is not None else None
    row = {"stage": "broker", "name": "bridge", "status": status, "detail": detail, "ms": 0, "live": True}
    checks = [c for i, c in enumerate(old) if i != idx]
    checks.insert(idx if idx is not None else len(checks), row)
    as_of = datetime.fromtimestamp(float(res.get("at") or now), NY).strftime("%H:%M")
    was = stored.get("status") if stored else None
    res.update(checks=checks, asOfNy=as_of, live={"bridge": status, "state": snap.get("state"), "at": now}, stale=was != status)
    if was != status:
        res["staleReason"] = (f"connection changed since the check at {as_of} ET (then {was or 'not checked'}, now {status}): "
                              "the other rows are as of then; run the check again")
    res["overall"] = overall([Check(c.get("stage", ""), c.get("name", ""), c["status"], "") for c in checks if c.get("status") in ORDER])
    res["counts"] = {s: sum(1 for c in checks if c.get("status") == s) for s in (PASS, WARN, FAIL, SKIP)}
    return res


def rerun_due(stored: dict[str, Any] | None, snap: dict[str, Any], now: float, last_auto: float) -> bool:
    """Re-run the full check automatically: the live connection disagrees with the stored result,
    the live state has held for RERUN_STABLE_S, and the last automatic re-run is RERUN_MIN_GAP_S old."""
    if not stored or now - last_auto < RERUN_MIN_GAP_S:
        return False
    row = _stored_bridge(stored)
    live_status, _ = bridge_check(snap, now)
    if row and row.get("status") == live_status:
        return False
    since = snap.get("connectedSince") if snap.get("state") == "CONNECTED" else snap.get("downSince")
    return since is not None and now - float(since) >= RERUN_STABLE_S


async def morning_loop(desk: Any) -> None:
    """Trading days at 09:00 New York: one full check before the open (skipped on NYSE holidays).
    Every minute, also re-run it when the live connection no longer matches the stored result."""
    import market_calendar

    last_day = ""
    last_auto = 0.0
    while True:
        await asyncio.sleep(60)
        now = desk.clock()
        t = datetime.fromtimestamp(now, NY)
        day = t.strftime("%Y-%m-%d")
        try:
            if market_calendar.is_trading_day(t.date()) and (t.hour, t.minute) >= (9, 0) and t.hour < 10 and day != last_day:
                last_day = day
                await run_checks(desk)
            elif rerun_due(last_result(desk.d), desk.bridge.snapshot(), now, last_auto):
                last_auto = now
                await run_checks(desk)
        except Exception:  # noqa: BLE001
            pass


def main() -> int:
    """CLI: run the check through the gateway and print a table. Exit 0 PASS, 1 WARN, 2 FAIL."""
    import argparse
    import urllib.error
    import urllib.request

    # Windows consoles default to cp1252; details contain arrows / middots / ticker emoji.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser(description="Trading pipeline health check (read-only)")
    ap.add_argument("--gateway", default="http://127.0.0.1:8080")
    ap.add_argument("--no-dry-run", action="store_true", help="skip the kill-switch dry run")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    req = urllib.request.Request(f"{args.gateway}/api/trading/health/check", data=json.dumps({"dryRunKill": not args.no_dry_run}).encode(),
                                 method="POST", headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=240) as r:  # noqa: S310 — local gateway
            res = json.loads(r.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError) as e:
        print(f"FAIL  gateway/bridge unreachable: {e}")
        return 2
    if args.json:
        print(json.dumps(res, indent=2))
    else:
        print(f"Trading health check · {res['atNy']} · OVERALL {res['overall']}  {res['counts']}")
        for c in res["checks"]:
            print(f"  {c['status']:<4}  {c['stage']:<11} {c['name']:<22} {c['detail']}")
    return {PASS: 0, WARN: 1, FAIL: 2}[res["overall"]]


if __name__ == "__main__":
    sys.exit(main())
