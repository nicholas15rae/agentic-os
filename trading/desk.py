"""Trading desk: execution modes, the SEMI_AUTO approval queue, the drawdown
monitor, Financer comms and the kill switch — wired around the Security Detail.

Flow for every OrderIntent (from the Trading Agent, an engine, or manual):

  parse_intent (strict schema) ─► build Context from live telemetry + quote
  ─► security_detail.evaluate ─► audit "intent_evaluated" (every verdict)
  ─► REJECTED: stop.  (drawdown breach also trips the kill switch)
  ─► ADVISORY:  logged as a hypothetical trade, never sent
  ─► SEMI_AUTO: queued as a trade card; on approval it is RE-EVALUATED with
                fresh data before anything is sent (cards expire after
                approval_ttl_s)
  ─► FULL_AUTO: sent at once through the executor (paper, within the caps)

Defaults: mode ADVISORY. Leaving ADVISORY needs an explicit confirmation, and
the kill switch (or a Financer "halt") drops the desk back to ADVISORY with
the agent halted.
"""

from __future__ import annotations

import asyncio
import dataclasses
import json
import logging
import math
import sqlite3
import time
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Awaitable, Callable

import comms
import kill_switch
from audit import AuditLog
from config import data_dir
from executor import ExecutionRefused, Executor
from fx import FxSource, merged_rates
from intents import IntentError, OrderIntent, RiskLimits, load_limits, parse_intent
from quiver import last_report as quiver_last_report
from trading_rag import TradingRag
from security_detail import NY, Context, Decision, evaluate, market_stats_from_bars, regular_hours_fallback, session_open_from_hours

log = logging.getLogger("trading.desk")

MODES = ("ADVISORY", "SEMI_AUTO", "FULL_AUTO")
ACTIVE = ("pending_approval", "submitted", "hypothetical")
MONITOR_S = 10.0

DESK_SCHEMA = """
CREATE TABLE IF NOT EXISTS intents (
  intent_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  symbol TEXT NOT NULL,
  action TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  intent TEXT NOT NULL,
  decision TEXT NOT NULL,
  result TEXT,
  created REAL NOT NULL,
  updated REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS intents_status ON intents(status, updated);
"""

QuoteFn = Callable[[OrderIntent], Awaitable[tuple[dict[str, float | None] | None, bool | None]]]
StatsFn = Callable[[OrderIntent], Awaitable[dict[str, float] | None]]


def ny_midnight(now: float) -> float:
    t = datetime.fromtimestamp(now, NY)
    return t.replace(hour=0, minute=0, second=0, microsecond=0).timestamp()


class Desk:
    def __init__(
        self,
        bridge: Any,
        *,
        executor: Executor | None = None,
        quote_fn: QuoteFn | None = None,
        stats_fn: StatsFn | None = None,
        kill_connect: Callable[[bool], Awaitable[Any]] | None = None,
        kill_market_order: Callable[[str, float], Any] | None = None,
        fx_source: FxSource | None | bool = None,
        d: Path | None = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.bridge = bridge
        self.d = d or data_dir()
        self.audit = AuditLog(self.d / "audit.db")
        self.executor = executor or Executor(lock_dir=self.d)
        self._quote = quote_fn or self._ib_quote
        self._stats = stats_fn or self._ib_stats
        self._stats_cache: dict[tuple[str, str, float], dict[str, float]] = {}
        self._kill_connect = kill_connect or kill_switch.ib_connector()
        self._kill_market_order = kill_market_order
        # None → Bank of Canada fallback; False → IBKR rates only (tests).
        self.fx = FxSource(self.d / "fx_cache.json") if fx_source is None else (fx_source or None)
        self.clock = clock
        # The Trading Agent's isolated vault (Quiver disclosures land here as External Signal Hypotheses).
        self.rag = TradingRag(self.d / "trading_rag")
        self._lock = asyncio.Lock()
        self._db = self.d / "desk.db"
        with self._conn() as c:
            c.executescript(DESK_SCHEMA)

    # ── persistence ──────────────────────────────────────────────────
    @contextmanager
    def _conn(self):
        c = sqlite3.connect(self._db, timeout=10, isolation_level=None)
        try:
            yield c
        finally:
            c.close()

    def state(self) -> dict[str, Any]:
        p = self.d / "state.json"
        base = {"mode": "ADVISORY", "agentHalted": False, "posture": "normal", "financer": {}}
        try:
            base.update(json.loads(p.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            pass
        if base["mode"] not in MODES:
            base["mode"] = "ADVISORY"  # unknown → safest
        return base

    def _save_state(self, **kw: Any) -> dict[str, Any]:
        s = self.state()
        s.update(kw, updatedAt=self.clock())
        tmp = self.d / "state.json.tmp"
        tmp.write_text(json.dumps(s, indent=2), encoding="utf-8")
        tmp.replace(self.d / "state.json")
        return s

    def limits(self) -> RiskLimits:
        lim = load_limits(self.d / "risk_limits.json")
        fin = self.state().get("financer") or {}
        if fin.get("allocation_base"):
            lim = dataclasses.replace(lim, financer_allocation_base=float(fin["allocation_base"]))
        if fin.get("max_daily_loss_pct"):
            lim = dataclasses.replace(lim, max_daily_loss_pct=comms.tightened_daily_loss(lim.max_daily_loss_pct, float(fin["max_daily_loss_pct"])))
        return lim

    def _row(self, intent_id: str) -> dict[str, Any] | None:
        with self._conn() as c:
            r = c.execute("SELECT intent_id, status, intent, decision, result, created, updated FROM intents WHERE intent_id = ?", (intent_id,)).fetchone()
        if not r:
            return None
        return {"intentId": r[0], "status": r[1], "intent": json.loads(r[2]), "decision": json.loads(r[3]),
                "result": json.loads(r[4]) if r[4] else None, "created": r[5], "updated": r[6]}

    def _put(self, intent: OrderIntent, status: str, decision: Decision, result: Any = None) -> None:
        now = self.clock()
        with self._conn() as c:
            c.execute(
                "INSERT INTO intents(intent_id, status, symbol, action, quantity, intent, decision, result, created, updated) VALUES (?,?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(intent_id) DO UPDATE SET status=excluded.status, decision=excluded.decision, result=excluded.result, quantity=excluded.quantity, updated=excluded.updated",
                (intent.intent_id, status, intent.symbol, intent.action, decision.quantity or intent.quantity,
                 json.dumps(intent.to_dict()), json.dumps(decision.to_dict()), json.dumps(result, default=str) if result is not None else None, now, now),
            )

    def _set_status(self, intent_id: str, status: str, result: Any = None) -> None:
        with self._conn() as c:
            c.execute("UPDATE intents SET status = ?, result = COALESCE(?, result), updated = ? WHERE intent_id = ?",
                      (status, json.dumps(result, default=str) if result is not None else None, self.clock(), intent_id))

    def _recent(self, exclude: str | None) -> list[dict[str, Any]]:
        since = self.clock() - 86400
        with self._conn() as c:
            rows = c.execute(f"SELECT intent_id, symbol, action, quantity, updated FROM intents WHERE status IN ({','.join('?' * len(ACTIVE))}) AND updated >= ?",
                             (*ACTIVE, since)).fetchall()
        return [{"symbol": r[1], "action": r[2], "quantity": r[3], "ts": r[4]} for r in rows if r[0] != exclude]

    # ── market context ───────────────────────────────────────────────
    async def _ib_quote(self, intent: OrderIntent):
        ib = getattr(self.bridge, "ib", None)
        if ib is None or not ib.isConnected():
            return None, None
        from ib_async import Stock

        c = Stock(intent.symbol, "SMART", intent.currency)
        q = await ib.qualifyContractsAsync(c)
        if not q or not getattr(q[0], "conId", 0):
            return None, None
        c = q[0]
        session = None
        try:
            details = await asyncio.wait_for(ib.reqContractDetailsAsync(c), 6)
            if details:
                session = session_open_from_hours(details[0].liquidHours, details[0].timeZoneId, self.clock())
        except Exception:  # noqa: BLE001
            session = None
        if session is None:
            session = regular_hours_fallback(self.clock())
        t = ib.reqMktData(c, "", False, False)
        try:
            # The first (delayed) subscription after a fresh connect can take several seconds.
            for _ in range(40):
                await asyncio.sleep(0.2)
                if t.bid == t.bid and t.ask == t.ask and t.bid > 0 and t.ask > 0:  # not NaN
                    break
        finally:
            ib.cancelMktData(c)
        clean = lambda v: None if v is None or (isinstance(v, float) and math.isnan(v)) or v <= 0 else float(v)  # noqa: E731
        return {"bid": clean(t.bid), "ask": clean(t.ask), "last": clean(t.last)}, session

    async def _ib_stats(self, intent: OrderIntent) -> dict[str, float] | None:
        """~40 sessions of daily TRADES bars → volume / volatility stats. Cached per symbol per NY day."""
        key = (intent.symbol, intent.currency, ny_midnight(self.clock()))
        if key in self._stats_cache:
            return self._stats_cache[key]
        ib = getattr(self.bridge, "ib", None)
        if ib is None or not ib.isConnected():
            return None
        from ib_async import Stock

        try:
            q = await ib.qualifyContractsAsync(Stock(intent.symbol, "SMART", intent.currency))
            if not q or not getattr(q[0], "conId", 0):
                return None
            bars = await asyncio.wait_for(ib.reqHistoricalDataAsync(
                q[0], endDateTime="", durationStr="40 D", barSizeSetting="1 day", whatToShow="TRADES", useRTH=True), 20)
        except Exception as e:  # noqa: BLE001 — no bars → the Security Detail fails closed
            log.warning("daily bars for %s: %s", intent.symbol, e)
            return None
        stats = market_stats_from_bars([{"high": b.high, "low": b.low, "close": b.close, "volume": b.volume} for b in bars or []])
        if stats:
            self._stats_cache = {k: v for k, v in self._stats_cache.items() if k[2] == key[2]}
            self._stats_cache[key] = stats
        return stats

    async def build_context(self, intent: OrderIntent, *, exclude_self: bool = False) -> Context:
        snap = self.bridge.snapshot()
        acct = snap.get("account") or {}
        quote, session = await self._quote(intent)
        stats = await self._stats(intent)
        row = self._row(intent.intent_id)
        seen = bool(row) and (not exclude_self or row["status"] == "submitted")
        base = acct.get("currency")
        needed = {intent.currency} | {p.get("currency", "") for p in snap.get("positions") or []} | {o.get("currency", "") for o in snap.get("openOrders") or []}
        fx, _prov = await asyncio.to_thread(merged_rates, snap.get("fx") or {}, {c for c in needed if c}, base, self.fx)
        return Context(
            now=self.clock(), mode=snap.get("mode"), port=snap.get("port"), connected=snap.get("state") == "CONNECTED",
            locked=kill_switch.is_locked(self.d), limits=self.limits(), equity_base=acct.get("netLiquidation"),
            daily_pnl_base=(snap.get("pnl") or {}).get("daily"), base_currency=base,
            fx_to_base=fx, positions=snap.get("positions") or [], open_orders=snap.get("openOrders") or [],
            quote=quote, market_stats=stats, session_open=session, seen_intent=seen, recent=self._recent(intent.intent_id),
            orders_today=self.audit.count_since("order_submitted", ny_midnight(self.clock())),
        )

    # ── intents ──────────────────────────────────────────────────────
    async def submit(self, raw: Any, actor: str) -> dict[str, Any]:
        try:
            intent = parse_intent(raw)
        except IntentError as e:
            ref = raw.get("intent_id", "") if isinstance(raw, dict) else ""
            self.audit.append("intent_schema_rejected", {"error": str(e), "raw": raw if isinstance(raw, dict) else str(raw)[:500]},
                              ref=str(ref)[:64], verdict="REJECTED", actor=actor)
            return {"ok": False, "status": "rejected", "error": f"schema: {e}"}
        async with self._lock:
            ctx = await self.build_context(intent)
            decision = evaluate(intent, ctx)
            st = self.state()
            self.audit.append("intent_evaluated", {"intent": intent.to_dict(), "decision": decision.to_dict(), "mode": st["mode"]},
                              ref=intent.intent_id, verdict=decision.verdict, actor=actor)
            if decision.trip_kill:
                await self.kill("daily drawdown circuit breaker", "security_detail", dry_run=False)
            if not decision.executable:
                if not ctx.seen_intent:
                    self._put(intent, "rejected", decision)
                return {"ok": False, "status": "rejected", "decision": decision.to_dict()}
            if st["agentHalted"] and intent.source == "trading_agent":
                self._put(intent, "rejected", decision, {"error": "agent halted"})
                return {"ok": False, "status": "rejected", "error": "the Trading Agent is halted", "decision": decision.to_dict()}
            if st["mode"] == "ADVISORY":
                self._put(intent, "hypothetical", decision)
                return {"ok": True, "status": "hypothetical", "decision": decision.to_dict()}
            if st["mode"] == "SEMI_AUTO":
                self._put(intent, "pending_approval", decision)
                return {"ok": True, "status": "pending_approval", "decision": decision.to_dict()}
            return await self._execute(intent, decision, actor)

    async def _execute(self, intent: OrderIntent, decision: Decision, actor: str) -> dict[str, Any]:
        self._put(intent, "submitting", decision)
        try:
            res = await self.executor.place(intent, decision.quantity)
        except (ExecutionRefused, Exception) as e:  # noqa: BLE001
            self._set_status(intent.intent_id, "failed", {"error": f"{type(e).__name__}: {e}"})
            self.audit.append("order_failed", {"error": str(e)}, ref=intent.intent_id, verdict="FAILED", actor=actor)
            return {"ok": False, "status": "failed", "error": str(e), "decision": decision.to_dict()}
        self._set_status(intent.intent_id, "submitted", res)
        self.audit.append("order_submitted", {"quantity": decision.quantity, **res}, ref=intent.intent_id, verdict="SUBMITTED", actor=actor)
        return {"ok": True, "status": "submitted", "result": res, "decision": decision.to_dict()}

    async def approve(self, intent_id: str, actor: str) -> dict[str, Any]:
        async with self._lock:
            row = self._row(intent_id)
            if not row or row["status"] != "pending_approval":
                return {"ok": False, "error": "no pending card with that id"}
            if self.state()["mode"] == "ADVISORY":
                return {"ok": False, "error": "desk is in ADVISORY mode"}
            if self.clock() - row["created"] > self.limits().approval_ttl_s:
                self._set_status(intent_id, "expired")
                self.audit.append("approval", {"note": "expired"}, ref=intent_id, verdict="EXPIRED", actor=actor)
                return {"ok": False, "status": "expired"}
            intent = parse_intent(row["intent"])
            decision = evaluate(intent, await self.build_context(intent, exclude_self=True))
            self.audit.append("approval", {"decision": decision.to_dict()}, ref=intent_id, verdict=decision.verdict, actor=actor)
            if not decision.executable:
                self._set_status(intent_id, "rejected", {"recheck": decision.to_dict()})
                return {"ok": False, "status": "rejected", "decision": decision.to_dict()}
            return await self._execute(intent, decision, actor)

    def reject(self, intent_id: str, actor: str) -> dict[str, Any]:
        row = self._row(intent_id)
        if not row or row["status"] != "pending_approval":
            return {"ok": False, "error": "no pending card with that id"}
        self._set_status(intent_id, "dismissed")
        self.audit.append("approval", {"note": "dismissed by user"}, ref=intent_id, verdict="DISMISSED", actor=actor)
        return {"ok": True, "status": "dismissed"}

    # ── mode / kill / comms ──────────────────────────────────────────
    def set_mode(self, mode: str, actor: str, confirm: bool = False) -> dict[str, Any]:
        if mode not in MODES:
            raise ValueError(f"mode must be one of {', '.join(MODES)}")
        if mode != "ADVISORY":
            if kill_switch.is_locked(self.d):
                raise PermissionError("trading is LOCKED — reset the kill switch first")
            if not confirm:
                raise PermissionError(f"switching to {mode} needs confirm=true")
        prev = self.state()["mode"]
        s = self._save_state(mode=mode, agentHalted=False if mode != "ADVISORY" else self.state()["agentHalted"])
        self.audit.append("mode_change", {"from": prev, "to": mode}, ref=mode, verdict="OK", actor=actor)
        if mode == "ADVISORY":
            # Pending cards can't be approved any more; mark them so the UI is honest.
            with self._conn() as c:
                c.execute("UPDATE intents SET status='expired', updated=? WHERE status='pending_approval'", (self.clock(),))
        return s

    async def kill(self, reason: str, actor: str, dry_run: bool = False) -> dict[str, Any]:
        if not dry_run:
            # Sever the agent BEFORE the network steps so nothing new is queued meanwhile.
            self._save_state(mode="ADVISORY", agentHalted=True)
            with self._conn() as c:
                c.execute("UPDATE intents SET status='expired', updated=? WHERE status='pending_approval'", (self.clock(),))
        return await kill_switch.execute_kill(reason=reason, actor=actor, dry_run=dry_run, connect=self._kill_connect, audit=self.audit, d=self.d,
                                             market_order=self._kill_market_order)

    def reset(self, confirm: str, actor: str) -> dict[str, Any]:
        out = kill_switch.reset_lock(confirm, actor, self.audit, self.d)
        self._save_state(agentHalted=False)  # mode stays ADVISORY; re-arming is a separate, confirmed step
        return out

    def handle_comms(self, raw: Any, actor: str) -> dict[str, Any]:
        try:
            env = comms.validate_envelope(raw)
        except comms.CommsError as e:
            self.audit.append("comms_rejected", {"error": str(e), "raw": raw if isinstance(raw, dict) else str(raw)[:500]},
                              ref=str(raw.get("msg_id", ""))[:64] if isinstance(raw, dict) else "", verdict="REJECTED", actor=actor)
            return {"ok": False, "error": str(e)}
        if self.audit.seen_ref("comms", env["msg_id"]):
            return {"ok": False, "error": "duplicate msg_id"}
        effect = "queued for the Financer"
        if env["to"] == "financer":
            comms.append_outbox(self.d / "financer_outbox.jsonl", env)
        elif env["kind"] == "budget_envelope":
            fin = dict(self.state().get("financer") or {})
            fin["allocation_base"] = env["payload"]["allocation_base"]
            if "max_daily_loss_pct" in env["payload"]:
                cur = fin.get("max_daily_loss_pct")
                new = env["payload"]["max_daily_loss_pct"]
                fin["max_daily_loss_pct"] = min(cur, new) if cur else new
            self._save_state(financer=fin)
            effect = f"allocation {fin['allocation_base']:.2f}, daily loss cap {self.limits().max_daily_loss_pct}%"
        elif env["kind"] == "risk_posture":
            posture = env["payload"]["posture"]
            if posture == "halt":
                self._save_state(posture=posture, mode="ADVISORY", agentHalted=True)
                effect = "agent halted, mode ADVISORY"
            else:
                self._save_state(posture=posture)
                effect = f"posture {posture}"
        self.audit.append("comms", env, ref=env["msg_id"], verdict=env["kind"], actor=actor)
        return {"ok": True, "effect": effect, "envelope": env}

    # ── drawdown monitor ─────────────────────────────────────────────
    def drawdown_breached(self) -> bool:
        snap = self.bridge.snapshot()
        if snap.get("state") != "CONNECTED" or kill_switch.is_locked(self.d):
            return False
        eq = (snap.get("account") or {}).get("netLiquidation")
        pnl = (snap.get("pnl") or {}).get("daily")
        if not eq or pnl is None:
            return False
        return pnl <= -self.limits().max_daily_loss_pct / 100 * (eq - pnl)

    async def monitor(self) -> None:
        while True:
            try:
                if self.drawdown_breached():
                    log.error("daily drawdown breached — tripping kill switch")
                    await self.kill("daily drawdown circuit breaker (monitor)", "security_detail", dry_run=False)
            except Exception as e:  # noqa: BLE001
                log.warning("monitor: %s", e)
            await asyncio.sleep(MONITOR_S)

    # ── view for the HUD ─────────────────────────────────────────────
    def view(self) -> dict[str, Any]:
        st = self.state()
        with self._conn() as c:
            pend = c.execute("SELECT intent_id FROM intents WHERE status='pending_approval' ORDER BY created DESC LIMIT 20").fetchall()
            recent = c.execute("SELECT intent_id FROM intents ORDER BY updated DESC LIMIT 15").fetchall()
        ok, note = self.audit.verify_chain()
        try:
            limits, limits_error = self.limits().to_dict(), None
        except Exception as e:  # noqa: BLE001
            limits, limits_error = None, str(e)
        return {
            "mode": st["mode"], "agentHalted": st["agentHalted"], "posture": st["posture"], "financer": st.get("financer") or {},
            "lock": kill_switch.read_lock(self.d), "limits": limits, "limitsError": limits_error,
            "pending": [self._row(r[0]) for r in pend], "recent": [self._row(r[0]) for r in recent],
            "audit": {"ok": ok, "note": note, "tail": self.audit.tail(25)},
            "signals": {"rag": self.rag.stats(), "quiver": quiver_last_report(self.d)},
        }

    def signals(self, q: str = "", ticker: str | None = None, k: int = 8) -> dict[str, Any]:
        """Context block for the Trading Agent: hypotheses come wrapped in the bias-hygiene directive."""
        entries = self.rag.query(q, ticker=ticker, k=max(1, min(k, 25)))
        return {"entries": [dataclasses.asdict(e) for e in entries], "context": self.rag.render_context(entries)}
