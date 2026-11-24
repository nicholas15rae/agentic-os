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
automatically every weekday at 09:00 New York before the open.
"""

from __future__ import annotations

import asyncio
import dataclasses
import json
import socket
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
LOOP_LIMITS = {"drawdown_monitor": 60, "options_guard": 240, "auto_scan": 120, "intel": 240}
FRESH_TELEMETRY_S = 20


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


def lan_exposed(port: int = 7497, timeout: float = 0.6) -> list[str]:
    """Is the TWS API socket reachable on a non-loopback address of this machine?"""
    hits = []
    try:
        addrs = {a[4][0] for a in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)}
    except OSError:
        return hits
    for ip in sorted(a for a in addrs if not a.startswith("127.")):
        try:
            with socket.create_connection((ip, port), timeout=timeout):
                hits.append(ip)
        except OSError:
            continue
    return hits


async def run_checks(desk: Any, *, dry_run_kill: bool = True, now: float | None = None,
                     lan_probe: Callable[[], list[str]] = lan_exposed,
                     tws_probe: Callable[[], bool] = tws_listening) -> dict[str, Any]:
    from config import is_paper_account, load_config, resolve_endpoint
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
        if hits:
            return WARN, f"TWS API port 7497 answers on {', '.join(hits)} — enable 'Allow connections from localhost only' in TWS"
        return PASS, "TWS API not reachable from the network"
    await step("safety", "tws_exposure", exposure)

    # 2. Broker connection ────────────────────────────────────────────
    snap = desk.bridge.snapshot()
    connected = snap.get("state") == "CONNECTED"

    def bridge():
        if not connected:
            return FAIL, f"bridge {snap.get('state')}: {'; '.join(snap.get('reasons') or []) or snap.get('lastError') or 'is TWS running and logged in to paper?'}"
        age = now - (snap.get("updatedAt") or 0)
        acct = (snap.get("account") or {}).get("account") or ""
        if not is_paper_account(acct):
            return FAIL, f"connected account {acct!r} is not a paper account"
        if age > FRESH_TELEMETRY_S:
            return WARN, f"telemetry {age:.0f}s old"
        return PASS, f"{acct} · client {snap.get('clientId')} · {'read-only' if snap.get('readOnly') else 'read/write'} · NetLiq {(snap.get('account') or {}).get('netLiquidation')}"
    await step("broker", "bridge", bridge)

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
              "counts": {s: sum(1 for c in checks if c.status == s) for s in (PASS, WARN, FAIL, SKIP)},
              "checks": [c.to_dict() for c in checks]}
    out = desk.d / "healthcheck"
    out.mkdir(parents=True, exist_ok=True)
    (out / "latest.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    desk.audit.append("healthcheck", {"overall": result["overall"], "counts": result["counts"],
                                      "failed": [c.name for c in checks if c.status == FAIL]}, ref="healthcheck", verdict=result["overall"], actor="healthcheck")
    return result


def last_result(d: Path) -> dict[str, Any] | None:
    try:
        return json.loads((d / "healthcheck" / "latest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


async def morning_loop(desk: Any) -> None:
    """Weekdays at 09:00 New York: one full check before the open."""
    last_day = ""
    while True:
        await asyncio.sleep(60)
        t = datetime.fromtimestamp(desk.clock(), NY)
        day = t.strftime("%Y-%m-%d")
        if t.weekday() < 5 and (t.hour, t.minute) >= (9, 0) and t.hour < 10 and day != last_day:
            last_day = day
            try:
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
