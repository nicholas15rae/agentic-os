"""Overseer: the out-of-process Dead Man's Switch, circuit breakers and Master Stop-Loss loop.

Run detached (`desk-cli overseer --detach`) or in a terminal (`desk-cli overseer`). One instance
(OS lock on `overseer.lock`). Each tick (policy `dead_mans_switch.poll_s`):

  1. Heartbeats
       cc      Command Center process (procwatch.CcProbe): RUNNING / HUNG / EXITED_CLEAN / EXITED_CRASH / ABSENT
       bridge  /health answers and the snapshot is fresh
       tws     reqCurrentTime on the overseer's own read-only client (20), or the bridge reporting CONNECTED
  2. Dead Man's Switch
       clean close (EXITED_CLEAN)  → HIBERNATE: verify every position's broker-side GTC stop + take-profit,
                                     halt autonomous entries (state.json agentHalted, mode ADVISORY)
       crash / freeze / heartbeat lost longer than the grace window (30-60 s)
                                   → persistent LOCK, cancel unfilled entry orders, then per position:
                                     protected and within tolerance → left alone, DEGRADED_LOCKED alert
                                     naked → configured fail-safe (emergency broker stop | liquidate)
                                     Master Stop tier 2 → selective liquidation
       connection back             → stays LOCKED (RECOVERING_LOCKED) until `desk-cli reconcile` passes
                                     and the operator runs `desk-cli unlock` (dual confirmation)
  3. Circuit breakers (always override the tiers): daily loss cap, rejection / error storm, a naked
     position beyond its grace window, STATE_DRIFT (reconcile drift on two consecutive ticks).
  4. Master Stop-Loss per position every `master_stop.eval_interval_s` (master_stop.assess).

Observe vs armed: the overseer starts in OBSERVE mode. It computes everything and writes what it
WOULD do to the ledger, but never locks, cancels or trades. `desk-cli overseer --arm` (dual
confirmation) flips `overseer_armed.json`; the running loop picks it up on its next tick.

All broker writes go through a read-write client (21) opened only for the actions of one tick, and
the order-ownership routing in safety_actions (TWS only lets the placing client id cancel).
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

import desk_lock
import desk_sources as src
import master_stop
import reconcile as rc
import risk_policy
import safety_actions as sa
from ledger import Ledger, file_lock
from security_detail import NY, market_stats_from_bars

log = logging.getLogger("trading.overseer")

STATE = "overseer_state.json"
HEARTBEAT = "overseer_heartbeat.json"
ARMED = "overseer_armed.json"
INFLIGHT_S = 120.0
IV_CACHE_S = 600.0


def armed(d: Path) -> bool:
    v = src.read_json(Path(d) / ARMED)
    return bool(v and v.get("armed"))


def set_armed(d: Path, on: bool, actor: str) -> dict[str, Any]:
    data = {"armed": bool(on), "at": time.time(), "actor": actor}
    src.write_json(Path(d) / ARMED, data)
    return data


def _blank_state() -> dict[str, Any]:
    return {"dms": "STARTING", "heartbeats": {}, "lostSince": {}, "triggered": {}, "pendingActions": [], "confirm": {},
            "nakedSince": {}, "driftStreak": 0, "assessments": {}, "lastEval": {}, "alerts": [], "breakers": {},
            "inflight": {}, "ccSeenRunning": False, "ccExit": None, "hibernated": False, "lastTws": 0.0, "twsOk": None}


class Overseer:
    def __init__(self, d: Path, *, ledger: Ledger | None = None, adapter_factory: Callable[[int, bool], Any] | None = None,
                 bridge_get: Callable[[str], dict] | None = None, cc_probe: Any = None, clock: Callable[[], float] = time.time,
                 sleep: Callable[[float], Any] = asyncio.sleep, ids: dict[str, int] | None = None,
                 bridge_cancel: Any = "http") -> None:
        self.d = Path(d)
        # Cancels of the live bridge's executor (13) orders go through its POST /orders/cancel. None = no route.
        self.bridge_cancel = src.bridge_cancel_http("overseer") if bridge_cancel == "http" else bridge_cancel
        self.ledger = ledger or Ledger(self.d / "ledger.jsonl")
        if adapter_factory is None:
            from tws_adapter import IbAdapter

            adapter_factory = lambda cid, ro: IbAdapter(cid, readonly=ro, d=self.d)  # noqa: E731
        self.factory = adapter_factory
        self.bridge_get = bridge_get or src.http_get
        if cc_probe is None:
            from procwatch import CcProbe

            cc_probe = CcProbe()
        self.cc = cc_probe
        self.clock, self.sleep = clock, sleep
        if ids is None:
            from tws_adapter import client_ids

            ids = client_ids()
        self.ids = ids
        self.ro: Any = None
        self._own_ok = False  # the overseer's OWN read-only probe worked this tick (not just the bridge's word)
        self.state = {**_blank_state(), **(src.read_json(self.d / STATE) or {})}
        # Timers from a previous run describe an outage this process never saw: restart the grace window
        # (keep the keys: "cc" in lostSince is how a crash is told from a clean close after a restart).
        t0 = self.clock()
        self.state["lostSince"] = {k: t0 for k in (self.state.get("lostSince") or {})}
        if not desk_lock.is_locked(self.d):
            # The lock those triggers / deferred actions belonged to was cleared while we were down.
            self.state.update(triggered={}, pendingActions=[], pendingDms=False, pendingIncident=None)
            self.state.pop("degraded", None)
        self._daily: dict[str, tuple[str, float | None]] = {}
        self._iv: dict[str, tuple[float, float | None]] = {}

    # ── helpers ──────────────────────────────────────────────────────
    def _alert(self, code: str, detail: str, now: float, *, symbol: str = "", persist: bool = True) -> dict[str, Any]:
        a = {"code": code, "detail": detail[:300], "symbol": symbol, "at": now}
        if persist:
            self.state["alerts"] = (self.state.get("alerts") or [])[-19:] + [a]
        return a

    def _ro(self) -> Any:
        if self.ro is None:
            self.ro = self.factory(self.ids["overseer"], True)
        return self.ro

    def close(self) -> None:
        if self.ro is not None:
            try:
                self.ro.disconnect()
            except Exception:  # noqa: BLE001
                pass
            self.ro = None

    # ── 1. heartbeats ────────────────────────────────────────────────
    async def heartbeats(self, now: float, policy: dict[str, Any] | None, *, probe_tws: bool = True) -> dict[str, Any]:
        st = self.state
        cc = self.cc.poll()
        cc_ok = cc["state"] == "RUNNING"
        if cc_ok:
            st["ccSeenRunning"] = True
            st["hibernated"] = False
        if cc["state"] in ("EXITED_CLEAN", "EXITED_CRASH"):
            st["ccExit"] = {"state": cc["state"], "exitCode": cc.get("exitCode"), "at": now}
        bridge = src.bridge_alive(self.bridge_get, now)
        snap, _err = src.bridge_snapshot(self.bridge_get, now) if bridge["state"] not in ("UNREACHABLE",) else (None, None)
        tws_s = (policy or risk_policy.DEFAULTS)["dead_mans_switch"]["tws_probe_s"]
        tws_ok, tws_detail = st.get("twsOk"), st.get("twsDetail", "")
        # Probe every tws_probe_s, every tick while failing, and at once when the bridge says TWS dropped.
        bridge_says_down = snap is not None and snap.get("state") != "CONNECTED"
        if probe_tws and (now - float(st.get("lastTws") or 0) >= tws_s or tws_ok is None or not tws_ok or bridge_says_down):
            try:
                await asyncio.wait_for(self._ro().current_time(), 8)
                tws_ok, tws_detail = True, f"reqCurrentTime ok (client {self.ids['overseer']})"
                self._own_ok = True
            except Exception as e:  # noqa: BLE001
                self._own_ok = False
                via_bridge = bool(snap) and snap.get("state") == "CONNECTED" and snap.get("ageS", 99) <= src.BRIDGE_STALE_S
                tws_ok = via_bridge
                tws_detail = (f"bridge reports CONNECTED; own probe failed ({type(e).__name__}: {e})" if via_bridge
                              else f"{type(e).__name__}: {e}")
                if self.ro is not None:
                    try:
                        self.ro.disconnect()
                    except Exception:  # noqa: BLE001
                        pass
            st["lastTws"], st["twsOk"], st["twsDetail"] = now, tws_ok, tws_detail
        hb = {
            "cc": {**cc, "ok": cc_ok},
            "bridge": bridge,
            "tws": {"ok": bool(tws_ok), "detail": tws_detail, "checkedAt": st.get("lastTws")},
        }
        for k, v in hb.items():
            prev = (st["heartbeats"].get(k) or {})
            v["lastOk"] = now if v["ok"] else prev.get("lastOk")
        st["heartbeats"] = hb
        return {"hb": hb, "snap": snap}

    # ── 2. Dead Man's Switch ─────────────────────────────────────────
    def dms(self, now: float, hb: dict[str, Any], policy: dict[str, Any] | None, is_armed: bool = True) -> dict[str, Any]:
        """Update lost timers; return {'crash': [sources past grace, newly], 'hibernate': bool, 'lost': {...}}.
        A trigger seen while in OBSERVE mode is only 'observed': arming during the same outage fires it for real."""
        st = self.state
        grace = (policy or risk_policy.DEFAULTS)["dead_mans_switch"]["grace_s"]
        lost_now: dict[str, str] = {}
        cc = hb["cc"]
        if cc["state"] == "HUNG":
            lost_now["cc"] = "Command Center not responding"
        elif cc["state"] == "EXITED_CRASH" or (cc["state"] == "ABSENT" and (st.get("ccExit") or {}).get("state") == "EXITED_CRASH"
                                                 and "cc" in st["lostSince"]):
            lost_now["cc"] = f"Command Center crashed (exit {(st.get('ccExit') or {}).get('exitCode')})"
        if not hb["bridge"]["ok"]:
            lost_now["bridge"] = f"bridge {hb['bridge']['state']}: {hb['bridge'].get('detail', '')}"
        if not hb["tws"]["ok"]:
            lost_now["tws"] = f"TWS API: {hb['tws']['detail']}"
        hibernate = False
        if cc["state"] == "EXITED_CLEAN" or (cc["state"] == "ABSENT" and st.get("ccSeenRunning") and "cc" not in st["lostSince"]):
            hs = st.get("hibernated")
            if not hs or (is_armed and hs == "observed"):
                hibernate = True
                st["hibernated"] = True if is_armed else "observed"
        for k in list(st["lostSince"]):
            if k not in lost_now:
                st["lostSince"].pop(k)
                self.ledger.append("heartbeat_restored", {"source": k}, ref=k, verdict="OK", actor="overseer")
        crash = []
        for k, why in lost_now.items():
            if k not in st["lostSince"]:
                st["lostSince"][k] = now
                self.ledger.append("heartbeat_lost", {"source": k, "detail": why, "graceS": grace}, ref=k, verdict="GRACE", actor="overseer")
            t = st["triggered"].get(k)
            if now - st["lostSince"][k] >= grace and (t is None or (is_armed and not t.get("acted"))):
                st["triggered"][k] = {"at": now, "detail": why, "acted": bool(is_armed)}
                crash.append(k)
        locked = desk_lock.read_lock(self.d)
        for k in list(st["triggered"]):
            if k not in lost_now and locked is None:
                st["triggered"].pop(k)  # operator unlocked after recovery: the trigger is spent
        if not st["triggered"]:
            st.pop("degraded", None)  # incident over: the next one starts clean
        self._validate_pending(locked)
        return {"crash": crash, "hibernate": hibernate, "lost": lost_now, "graceS": grace}

    def _validate_pending(self, locked: dict[str, Any] | None) -> None:
        """Deferred broker steps belong to the lock incident that created them; an unlock (or another incident) voids them."""
        st = self.state
        if (st.get("pendingActions") or st.get("pendingDms")) and (locked is None or locked.get("incidentId") != st.get("pendingIncident")):
            st.update(pendingActions=[], pendingDms=False, pendingIncident=None)

    def dms_label(self, lost: dict[str, str], hb: dict[str, Any]) -> str:
        st = self.state
        locked = desk_lock.is_locked(self.d)
        if st["triggered"] and lost:
            return "DEGRADED_LOCKED" if st.get("degraded") else "TRIGGERED"
        if st["triggered"] and locked:
            return "RECOVERING_LOCKED"
        if lost:
            return "GRACE"
        if hb["cc"]["state"] in ("ABSENT", "EXITED_CLEAN"):
            return "HIBERNATE" if st.get("ccSeenRunning") else "DETACHED"
        return "WATCHING"

    # ── 3. breakers ──────────────────────────────────────────────────
    def breakers(self, now: float, policy: dict[str, Any] | None, snap: dict[str, Any] | None, rec: dict[str, Any] | None,
                 *, persist: bool = True) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        if policy is None:
            return [{"code": "POLICY_INVALID", "detail": "risk-policy.json failed validation", "action": "lock"}]
        cb = policy["circuit_breakers"]
        # daily loss
        try:
            lim = src.risk_limits(self.d)
        except Exception as e:  # noqa: BLE001
            out.append({"code": "LIMITS_INVALID", "detail": f"risk_limits.json: {e}", "action": "lock"})
            lim = None
        if lim and snap and snap.get("state") == "CONNECTED":
            eq = (snap.get("account") or {}).get("netLiquidation")
            pnl = (snap.get("pnl") or {}).get("daily")
            if eq and pnl is not None:
                floor = -lim["max_daily_loss_pct"] / 100 * (eq - pnl)
                if pnl <= floor:
                    out.append({"code": "DAILY_LOSS", "detail": f"daily P&L {pnl:.2f} <= {floor:.2f} ({lim['max_daily_loss_pct']}%)",
                                "action": cb["daily_loss_action"]})
        # rejection / error storm
        since = now - cb["rejection_storm_window_s"]
        n = src.audit_failures_since(self.d, since)
        n += sum(1 for r in self.ledger.since(since) if r.get("verdict") in ("FAILED", "REJECTED_BY_BROKER"))
        if n >= cb["rejection_storm_count"]:
            out.append({"code": "REJECTION_STORM", "detail": f"{n} broker rejections / failures in {cb['rejection_storm_window_s']}s", "action": "lock"})
        if rec is not None:
            # naked beyond grace
            for p in rec["positions"]:
                if p.get("nakedForS") is not None and p["nakedForS"] >= cb["naked_grace_s"]:
                    out.append({"code": "NAKED_POSITION", "detail": f"{p['symbol']} unprotected for {p['nakedForS']:.0f}s",
                                "action": "naked_action", "conId": p["conId"], "symbol": p["symbol"]})
            # STATE_DRIFT on two consecutive ticks (one-tick races between an ack and a snapshot are ignored)
            drift = [x for x in rec["drift"] if x["severity"] == "drift" and x["code"] not in ("NAKED_POSITION",)]
            streak = (self.state.get("driftStreak", 0) + 1) if drift else 0
            if persist:
                self.state["driftStreak"] = streak
            if drift and streak >= 2:
                out.append({"code": "STATE_DRIFT", "detail": "; ".join(f"{x['code']} {x.get('symbol', '')}" for x in drift)[:300], "action": "lock"})
        return out

    # ── 4. Master Stop-Loss ──────────────────────────────────────────
    async def _atr(self, sym: str, cur: str, now: float) -> float | None:
        day = datetime.fromtimestamp(now, NY).strftime("%Y%m%d")
        hit = self._daily.get(sym)
        if hit and hit[0] == day:
            return hit[1]
        bars = await self._ro().bars(sym, cur, "1 day", "40 D")
        stats = market_stats_from_bars([{"high": b["h"], "low": b["l"], "close": b["c"], "volume": b["v"]} for b in bars])
        atr = stats["atr_pct"] if stats else None
        self._daily[sym] = (day, atr)
        return atr

    async def _ivol(self, sym: str, cur: str, now: float) -> float | None:
        hit = self._iv.get(sym)
        if hit and now - hit[0] < IV_CACHE_S:
            return hit[1]
        try:
            iv = await self._ro().implied_vol(sym, cur)
        except Exception:  # noqa: BLE001
            iv = None
        self._iv[sym] = (now, iv)
        return iv

    async def assess_all(self, now: float, policy: dict[str, Any], positions: list[dict[str, Any]], *, persist: bool = True,
                         force: bool = False) -> dict[str, dict[str, Any]]:
        ms = policy["master_stop"]
        out: dict[str, dict[str, Any]] = {}
        # Hard time budget: market-data waits must never stall the Dead Man's Switch past its grace window.
        t_end = time.monotonic() + min(15.0, policy["dead_mans_switch"]["grace_s"] / 3)
        for p in positions:
            key = str(p["conId"])
            if p.get("secType") not in ("STK", "ETF"):
                continue  # options: the desk's options guard owns premium stops / expiry
            last = (self.state.get("lastEval") or {}).get(key, 0)
            if not force and now - last < ms["eval_interval_s"] and key in self.state["assessments"]:
                out[key] = self.state["assessments"][key]
                continue
            if not self._own_ok or time.monotonic() >= t_end:
                # No own data connection, or out of time: keep the previous assessment (lastEval untouched → next tick).
                if key in self.state["assessments"]:
                    out[key] = self.state["assessments"][key]
                continue
            sym, cur = p.get("underlying") or p["symbol"], p.get("currency") or "USD"
            price = price_t = atr = iv = None
            bars: list[dict[str, Any]] = []
            errs = []
            try:
                q = await self._ro().quote(sym, cur)
                mid = (q["bid"] + q["ask"]) / 2 if q.get("bid") and q.get("ask") else None
                price, price_t = mid or q.get("last"), q.get("time")
            except Exception as e:  # noqa: BLE001
                errs.append(f"quote: {type(e).__name__}")
            try:
                bars = await self._ro().bars(sym, cur, ms["bar_size"], ms["bar_duration"])
            except Exception as e:  # noqa: BLE001
                errs.append(f"bars: {type(e).__name__}")
            try:
                atr = await self._atr(sym, cur, now)
            except Exception as e:  # noqa: BLE001
                errs.append(f"atr: {type(e).__name__}")
            iv = await self._ivol(sym, cur, now)
            if price is None and p.get("marketPrice"):
                price, price_t = p["marketPrice"], None  # bridge mark, no tick time → stale (alerts only)
            a = master_stop.assess(position=p, price=price, price_time=price_t, now=now, bars=bars, atr_pct=atr, iv=iv,
                                   policy=policy, prev_confirm=int((self.state.get("confirm") or {}).get(key, 0)))
            if errs:
                a["dataErrors"] = errs
            out[key] = a
            if persist:
                self.state["confirm"][key] = a["confirmCount"]
                self.state["lastEval"][key] = now
                self.state["assessments"][key] = a
        if persist:
            live = {str(p["conId"]) for p in positions}
            for k in list(self.state["assessments"]):
                if k not in live:
                    for m in ("assessments", "confirm", "lastEval"):
                        self.state[m].pop(k, None)
        return out

    # ── planning (pure) ──────────────────────────────────────────────
    def plan(self, *, now: float, policy: dict[str, Any] | None, dms: dict[str, Any], breakers: list[dict[str, Any]],
             rec: dict[str, Any] | None, assessments: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
        pol = policy or risk_policy.DEFAULTS
        dmsp = pol["dead_mans_switch"]
        acts: list[dict[str, Any]] = []
        lock_codes = []
        for k in dms["crash"]:
            lock_codes.append((f"DMS_{k.upper()}", dms["lost"].get(k, "")))
        for b in breakers:
            lock_codes.append((b["code"], b["detail"]))
        for code, detail in lock_codes:
            acts.append({"kind": "lock", "breaker": code, "detail": detail})
        if dms["hibernate"] and dmsp["on_clean_close"] == "halt_autonomous":
            acts.append({"kind": "halt_autonomy", "why": "Command Center closed cleanly (HIBERNATE)"})
        if lock_codes:
            acts.append({"kind": "halt_autonomy", "why": "desk locked"})
        # Only a DMS trigger (now, or deferred from an earlier tick of the same lock incident) means crash mode.
        pend = set(self.state.get("pendingActions") or [])
        crashed = bool(dms["crash"]) or bool(self.state.get("pendingDms"))
        flatten = "flatten_all" in pend or any(b["code"] == "DAILY_LOSS" and b["action"] == "flatten_all" for b in breakers)
        if flatten:
            acts.append({"kind": "flatten_all", "why": "daily loss cap (flatten_all)"})
            return acts
        if (crashed and dmsp["cancel_unfilled_entries"]) or "cancel_entries" in pend or any(b["code"] == "DAILY_LOSS" for b in breakers):
            acts.append({"kind": "cancel_entries", "why": "DMS trigger" if crashed else ("deferred" if "cancel_entries" in pend else "daily loss cap")})
        if rec is None:
            return acts
        naked_breach = {b["conId"] for b in breakers if b["code"] == "NAKED_POSITION"}
        # A naked position with a working exit is a liquidation in progress: re-drive it, never stack a stop on it.
        exiting = {o.get("conId") for o in rec.get("orders") or [] if o.get("role") == "exit"}
        if dms["hibernate"]:
            # Clean close: verify every position's broker-side GTC stop + take-profit before going quiet.
            for p in rec["positions"]:
                status = (p.get("bracket") or {}).get("status")
                if status not in ("PROTECTED", "DESK_GUARDED"):
                    acts.append({"kind": "alert", "code": "HIBERNATE_UNPROTECTED", "symbol": p["symbol"],
                                 "detail": f"bracket {status} at HIBERNATE; naked positions get the fail-safe after naked_grace_s"})
        for p in rec["positions"]:
            key = str(p["conId"])
            a = assessments.get(key) or {}
            status = (p.get("bracket") or {}).get("status")
            naked = status in ("NAKED", "UNDERSIZED", "NOT_GTC")
            if a.get("tier") == 2:
                acts.append({"kind": "liquidate", "conId": p["conId"], "symbol": p["symbol"],
                             "why": f"Master Stop tier 2 (score {a.get('score')}, {', '.join(a.get('reasonCodes') or [])})"})
                acts.append({"kind": "lock", "breaker": f"MASTER_STOP_{p['symbol']}", "detail": "tier 2 breakdown"})
            elif naked and (p["conId"] in naked_breach or crashed):
                if dmsp["naked_action"] == "liquidate" or p["conId"] in exiting or p.get("secType") in ("OPT", "BAG"):
                    why = ("naked with an exit in progress" if p["conId"] in exiting else
                           "naked option (no stop orders on options)" if p.get("secType") in ("OPT", "BAG") else "naked")
                    acts.append({"kind": "liquidate", "conId": p["conId"], "symbol": p["symbol"], "why": f"{why} ({status})"})
                else:
                    acts.append({"kind": "emergency_stop", "conId": p["conId"], "symbol": p["symbol"], "why": f"naked ({status})"})
            elif a.get("tier") == 1:
                acts.append({"kind": "alert", "code": "MASTER_STOP_TIER1", "symbol": p["symbol"],
                             "detail": f"score {a.get('score')} {a.get('reasonCodes')}"})
                if a.get("action") == "alert_lock":
                    acts.append({"kind": "lock", "breaker": f"TIER1_{p['symbol']}", "detail": "tier 1 with tier1_lock_desk"})
            elif crashed:
                acts.append({"kind": "alert", "code": "DEGRADED_LOCKED", "symbol": p["symbol"],
                             "detail": f"protected ({status}), tier {a.get('tier', 0)}: left in place under the lock"})
        # Lock before anything else touches the broker, and only once per code.
        seen, ordered = set(), []
        for x in sorted(acts, key=lambda x: 0 if x["kind"] == "lock" else 1):
            k = (x["kind"], x.get("breaker") or x.get("conId") or x.get("code") or x.get("why"))
            if k not in seen:
                seen.add(k)
                ordered.append(x)
        return ordered


    # ── execution ────────────────────────────────────────────────────
    async def execute(self, now: float, actions: list[dict[str, Any]], policy: dict[str, Any] | None, view: dict[str, Any] | None,
                      hb: dict[str, Any], *, dms_crash: bool = False) -> list[dict[str, Any]]:
        """Run a plan. Locks first. Broker steps are recorded as a durable debt (pendingActions, tied to the
        lock incident) BEFORE they run, and the debt is cleared only when every one of them succeeded, so a
        connect failure, an exception or an unconfirmed cancel is retried on the next tick, never dropped."""
        results: list[dict[str, Any]] = []
        pol = policy or risk_policy.DEFAULTS
        broker_kinds = ("cancel_entries", "liquidate", "emergency_stop", "flatten_all")
        broker_needed = [a for a in actions if a["kind"] in broker_kinds]
        tws_ready = view is not None and view.get("positions") is not None and hb["tws"]["ok"]
        act: Any = None
        act_err: str | None = None
        debt_recorded = False
        inflight = self.state.setdefault("inflight", {})

        def record_debt() -> None:
            lk = desk_lock.read_lock(self.d) or {}
            self.state["pendingActions"] = sorted(set(self.state.get("pendingActions") or [])
                                                  | {a["kind"] for a in broker_needed if a["kind"] in ("cancel_entries", "flatten_all")})
            self.state["pendingDms"] = bool(self.state.get("pendingDms")) or dms_crash
            self.state["pendingIncident"] = lk.get("incidentId")

        try:
            for a in actions:
                kind = a["kind"]
                try:
                    if kind == "lock":
                        lk = desk_lock.lock(self.d, f"overseer: {a['breaker']}", "overseer", source="overseer", breaker=a["breaker"],
                                            detail=a.get("detail", ""), now=now)
                        self.state["breakers"][a["breaker"]] = {"at": now, "detail": a.get("detail", "")}
                        self.ledger.append("lock", {"breaker": a["breaker"], "detail": a.get("detail", ""), "incidentId": lk.get("incidentId")},
                                           ref=a["breaker"], verdict="LOCKED", actor="overseer")
                        results.append({**a, "ok": True})
                        continue
                    if kind == "halt_autonomy":
                        st = desk_lock.read_state(self.d)
                        if not st.get("agentHalted") or st.get("mode") != "ADVISORY":
                            desk_lock.halt_autonomy(self.d, now)
                            self.ledger.append("halt_autonomy", {"why": a["why"]}, ref="state", verdict="HALTED", actor="overseer")
                        results.append({**a, "ok": True})
                        continue
                    if kind == "alert":
                        key = a.get("symbol", "") + a["code"]
                        if (self.state.get("lastAlertKey") or {}).get(key) != a["detail"]:
                            self.ledger.append("alert", a, ref=a.get("symbol", ""), verdict=a["code"], actor="overseer")
                            self.state.setdefault("lastAlertKey", {})[key] = a["detail"]
                        self._alert(a["code"], a["detail"], now, symbol=a.get("symbol", ""))
                        if a["code"] == "DEGRADED_LOCKED":
                            self.state["degraded"] = True
                        results.append({**a, "ok": True})
                        continue
                    # ── broker steps ──
                    if not debt_recorded:
                        record_debt()
                        debt_recorded = True
                    if not tws_ready:
                        self._alert("ACTIONS_PENDING", "TWS unreachable: broker-side fail-safes deferred until the API returns", now)
                        results.append({**a, "ok": False, "error": "deferred: TWS unreachable"})
                        continue
                    ikey = f"{kind}:{a.get('conId', '')}"
                    if now - float(inflight.get(ikey, 0)) < INFLIGHT_S:
                        results.append({**a, "ok": None, "note": "already in flight"})
                        continue
                    if act is None and act_err is None:
                        try:
                            act = self.factory(self.ids["overseer_act"], False)
                            await act.connect()
                        except Exception as e:  # noqa: BLE001 — LeaseBusy / refused / timeout: retry next tick
                            try:
                                if act is not None:
                                    act.disconnect()
                            except Exception:  # noqa: BLE001
                                pass
                            act, act_err = None, f"{type(e).__name__}: {e}"
                            self._alert("ACT_CONNECT_FAILED", act_err, now)
                            self.ledger.append("act_connect_failed", {"error": act_err}, ref="overseer", verdict="ERROR", actor="overseer")
                    if act is None:
                        results.append({**a, "ok": False, "error": f"deferred: act client unavailable ({act_err})"})
                        continue
                    inflight[ikey] = now  # only once the read-write client is really open
                    positions, orders = view["positions"], view["orders"]
                    ref = f"DMS-{int(now)}" if kind != "liquidate" else f"MSL-{int(now)}"
                    common = {"act": act, "adapter_factory": self.factory, "bridge_alive": bool(hb["bridge"]["ok"]),
                              "ledger": self.ledger, "actor": "overseer",
                              "bridge_cancel": self.bridge_cancel if hb["bridge"]["ok"] else None}
                    if kind == "cancel_entries":
                        r = await sa.cancel_entries(positions, orders, **common, sleep=self.sleep)
                        self.state["selfCancelled"] = sorted(set(self.state.get("selfCancelled") or []) | set(r.get("cancelled") or []))[-200:]
                        ok = not r.get("blocked") and not r.get("unconfirmed")
                    elif kind == "flatten_all":
                        r = await sa.flatten_all(act=act, ledger=self.ledger, actor="overseer", ref=f"DMS-FLAT-{int(now)}", sleep=self.sleep)
                        ok = bool(r.get("ok", True))
                    else:
                        pos = next((p for p in positions if p["conId"] == a["conId"]), None)
                        if pos is None:
                            results.append({**a, "ok": True, "note": "position already gone"})
                            continue
                        if kind == "liquidate":
                            r = await sa.liquidate_position(pos, orders, **common, ref=f"{ref}-{a['symbol']}", reason=a["why"], sleep=self.sleep)
                        else:
                            asm = (self.state.get("assessments") or {}).get(str(a["conId"])) or {}
                            # Never the entry cost: a stop priced off avgCost can sit on the wrong side of the market.
                            price = asm.get("price") or pos.get("marketPrice")
                            if not price or float(price) <= 0:
                                inflight.pop(ikey, None)
                                self._alert("EMERGENCY_STOP_NO_PRICE", f"{a['symbol']}: no quote or mark; stop deferred (desk stays locked)", now,
                                            symbol=a["symbol"])
                                results.append({**a, "ok": False, "error": "deferred: no market price"})
                                continue
                            r = await sa.place_emergency_stop(pos, act=act, ledger=self.ledger, actor="overseer", ref=f"{ref}-STOP-{a['symbol']}",
                                                              price=float(price), atr_pct=asm.get("atrPct"), policy=pol, sleep=self.sleep)
                            if r.get("verdict") == "COVERED":
                                still = (next((p for p in (view.get("reconcilePositions") or []) if p["conId"] == a["conId"]), {})
                                         .get("bracket") or {}).get("status")
                                if still in rc.UNPROTECTED:
                                    self._alert("EMERGENCY_STOP_NOOP", f"{a['symbol']}: stop reported COVERED but bracket is {still}", now,
                                                symbol=a["symbol"])
                        ok = bool(r.get("ok", True))
                    results.append({**a, "result": r, "ok": ok})
                except Exception as e:  # noqa: BLE001 — one failed step must not drop the others or the debt
                    results.append({**a, "ok": False, "error": f"{type(e).__name__}: {e}"})
                    self.ledger.append("overseer_action_error", {"action": a, "error": f"{type(e).__name__}: {e}"}, ref=kind,
                                       verdict="ERROR", actor="overseer")
            broker_results = [r for r in results if r["kind"] in broker_kinds]
            if debt_recorded and broker_results and all(r.get("ok") is True for r in broker_results):
                self.state.update(pendingActions=[], pendingDms=False, pendingIncident=None)
        finally:
            if act is not None:
                try:
                    act.disconnect()
                except Exception:  # noqa: BLE001
                    pass
        return results

    # ── one tick ─────────────────────────────────────────────────────
    async def tick(self, *, dry: bool = False) -> dict[str, Any]:
        """One pass. dry=True (overseer-snapshot): compute everything, change nothing (no lock, no orders, no state file)."""
        now = self.clock()
        saved = None
        if dry:
            import copy

            saved = copy.deepcopy(self.state)
        try:
            policy = risk_policy.load_policy(risk_policy.policy_path(self.d)) if not dry or risk_policy.policy_path(self.d).exists() else risk_policy.defaults()
            policy_err = None
        except risk_policy.PolicyError as e:
            policy, policy_err = None, str(e)
        is_armed = armed(self.d)
        h = await self.heartbeats(now, policy)
        hb, snap = h["hb"], h["snap"]
        dms = self.dms(now, hb, policy, is_armed) if not dry else self._dms_readonly(now, hb, policy)
        view = rec = None
        assessments: dict[str, dict[str, Any]] = {}
        if hb["tws"]["ok"] or (snap and snap.get("state") == "CONNECTED"):
            ro = self._ro() if self._own_ok else None  # own probe down → read the bridge, don't stall on reconnects
            view = await src.gather(adapter=ro, snap=snap)
            if view.get("positions") is not None:
                intents = src.desk_intents(self.d, ("submitted", "closed_stop", "submitting", "closed", "rejected", "cancelled",
                                                    "failed", "hypothetical", "expired", "dismissed", "pending_approval"))
                kw = dict(positions=view["positions"], orders=view["orders"], executions=view["executions"], now=now,
                          options_exempt=(policy or risk_policy.DEFAULTS)["pretrade"]["options_exempt_from_stop"])
                rec = rc.reconcile(intents=intents, naked_since=self.state.get("nakedSince") or {}, **kw)
                if not dry and is_armed and self.state.get("selfCancelled"):
                    # Broker-is-truth: intents whose orders THIS overseer cancelled (TWS-acknowledged) move to cancelled.
                    import broker_truth

                    mine = set(self.state["selfCancelled"])
                    ids = {i["intentId"]: {int(o.get("orderId")) for o in ((i.get("result") or {}).get("orders") or []) if o.get("orderId")}
                           for i in intents}
                    trans = [t for t in broker_truth.transitions(rec, view["executions"] is not None) if ids.get(t["intentId"], set()) & mine]
                    if broker_truth.apply(self.d, trans, self.ledger, "overseer", now):
                        intents = src.desk_intents(self.d, ("submitted", "closed_stop", "submitting", "closed", "rejected", "cancelled",
                                                            "failed", "hypothetical", "expired", "dismissed", "pending_approval"))
                        rec = rc.reconcile(intents=intents, naked_since=self.state.get("nakedSince") or {}, **kw)
                if not dry:
                    self.state["nakedSince"] = rec["nakedSince"]
                view["reconcilePositions"] = rec["positions"]
                if policy is not None:
                    assessments = await self.assess_all(now, policy, view["positions"], persist=not dry, force=dry)
        brk = self.breakers(now, policy, snap, rec, persist=not dry)
        if policy_err:
            brk = [{"code": "POLICY_INVALID", "detail": policy_err, "action": "lock"}]
        # Breakers already asserted in the lock are not re-planned (the lock is persistent).
        held = {b.get("code") for b in (desk_lock.read_lock(self.d) or {}).get("breakers") or []}
        new_brk = [b for b in brk if b["code"] not in held or b["code"] == "NAKED_POSITION"]
        actions = self.plan(now=now, policy=policy, dms=dms, breakers=new_brk, rec=rec, assessments=assessments)
        actions = [a for a in actions if not (a["kind"] == "lock" and a["breaker"] in held)]
        results: list[dict[str, Any]] = []
        if dms["hibernate"] and not dry:
            self.ledger.append("hibernate", {"brackets": [{"symbol": p["symbol"], "status": p["bracket"]["status"]} for p in (rec or {}).get("positions", [])],
                                             "verified": rec is not None}, ref="cc", verdict="HIBERNATE", actor="overseer")
        if dry:
            pass
        elif is_armed:
            results = await self.execute(now, actions, policy, view, hb, dms_crash=bool(dms["crash"]))
        else:
            sig = [(a["kind"], a.get("breaker") or a.get("symbol") or a.get("code")) for a in actions if a["kind"] != "alert"]
            if sig and sig != self.state.get("lastWould"):
                self.ledger.append("would_act", {"actions": actions}, ref="observe", verdict="OBSERVE", actor="overseer")
            self.state["lastWould"] = sig
        label = self.dms_label(dms["lost"], hb)
        out = {"at": now, "armed": is_armed, "dms": label, "heartbeats": hb, "lost": dms["lost"], "graceS": dms["graceS"],
               "reconcile": rec, "assessments": assessments, "breakers": brk, "plannedActions": actions, "results": results,
               "brokerSource": (view or {}).get("source"), "brokerErrors": (view or {}).get("errors"), "policyError": policy_err,
               "snapshot": snap}
        if dry:
            self.state = saved
        else:
            self.state.update(dms=label, lastTick=now, pid=os.getpid())
            src.write_json(self.d / STATE, self.state)
            src.write_json(self.d / HEARTBEAT, {"pid": os.getpid(), "at": now, "armed": is_armed, "dms": label,
                                                "lost": dms["lost"], "pendingActions": self.state.get("pendingActions")})
        return out

    def _dms_readonly(self, now: float, hb: dict[str, Any], policy: dict[str, Any] | None) -> dict[str, Any]:
        """DMS view for a snapshot: the running overseer's timers, never advanced or triggered here."""
        grace = (policy or risk_policy.DEFAULTS)["dead_mans_switch"]["grace_s"]
        lost = {}
        if hb["cc"]["state"] == "HUNG":
            lost["cc"] = "Command Center not responding"
        if not hb["bridge"]["ok"]:
            lost["bridge"] = f"bridge {hb['bridge']['state']}"
        if not hb["tws"]["ok"]:
            lost["tws"] = f"TWS API: {hb['tws']['detail']}"
        return {"crash": [], "hibernate": False, "lost": lost, "graceS": grace}

    async def run(self, interval: float | None = None, max_ticks: int | None = None) -> None:
        with file_lock(self.d / "overseer.lock", blocking=False):
            self.ledger.append("overseer_start", {"pid": os.getpid(), "armed": armed(self.d)}, ref="overseer", verdict="START", actor="overseer")
            n = 0
            try:
                while max_ticks is None or n < max_ticks:
                    n += 1
                    try:
                        out = await self.tick()
                        poll = interval or (risk_policy.DEFAULTS["dead_mans_switch"]["poll_s"] if out["policyError"] else
                                            risk_policy.load_policy(risk_policy.policy_path(self.d))["dead_mans_switch"]["poll_s"])
                    except Exception as e:  # noqa: BLE001 — the watchdog must not die on one bad tick
                        log.exception("overseer tick failed")
                        # verdict ERROR (not FAILED): the watchdog's own faults don't count as broker rejections
                        self.ledger.append("overseer_error", {"error": f"{type(e).__name__}: {e}"}, ref="overseer", verdict="ERROR", actor="overseer")
                        poll = interval or 5
                    await self.sleep(poll)
            finally:
                self.close()
                self.ledger.append("overseer_stop", {"pid": os.getpid()}, ref="overseer", verdict="STOP", actor="overseer")
