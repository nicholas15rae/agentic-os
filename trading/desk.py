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
from quantgress import last_report as quantgress_last_report
from trading_rag import TradingRag
import journal as jr
import options as opt
import outcomes
from discord_ingest import DiscordStore, import_inbox
from engines.equities_commodities import EngineA, Watchlist
from engines.options_engine import EngineB, flatten_plan
from security_detail import NY, Context, Decision, evaluate, market_stats_from_bars, regular_hours_fallback, session_open_from_hours

log = logging.getLogger("trading.desk")

MODES = ("ADVISORY", "SEMI_AUTO", "FULL_AUTO")
ACTIVE = ("pending_approval", "submitted", "hypothetical")
MONITOR_S = 10.0
OPTIONS_GUARD_S = 60.0

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
CREATE TABLE IF NOT EXISTS journal (
  intent_id TEXT PRIMARY KEY,
  closed_at REAL NOT NULL,
  symbol TEXT NOT NULL,
  pnl REAL NOT NULL,
  outcome TEXT NOT NULL,
  record TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS journal_closed ON journal(closed_at);
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
        option_quote_fn: Callable[[OrderIntent], Awaitable[tuple[dict[str, Any] | None, list[dict[str, Any]]]]] | None = None,
        market_data: Any = None,
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
        # The Trading Agent's isolated vault (Quantgress disclosures land here as External Signal Hypotheses).
        self.rag = TradingRag(self.d / "trading_rag")
        # Engines read market data on their own read-only client (12); they only ever call submit().
        if market_data is None:
            from market_data import MarketData

            market_data = MarketData()
        self.md = market_data
        self._option_quote = option_quote_fn or self._md_option_quote
        self.watchlist = Watchlist(self.d / "watchlist.json")
        self.engine_a = EngineA(self.md, self.watchlist, clock=clock)
        self.engine_b = EngineB(self.md, clock=clock)
        # Phase 4: Discord intel store (inside the isolated trading_rag folder) + live status.
        self.discord = DiscordStore(self.d / "trading_rag" / "discord.db")
        self.discord_status: dict[str, Any] = {}
        self.last_scoring: dict[str, Any] | None = None
        # Background-loop heartbeats (name -> last iteration, epoch s) for the health check.
        self.heartbeats: dict[str, float] = {}
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

    def option_limits(self) -> opt.OptionLimits:
        return opt.load_option_limits(self.d / "option_limits.json")

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

    async def _md_option_quote(self, intent: OrderIntent) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
        """Per-leg quotes (in intent.legs order) and the structure's own bid/ask per contract."""
        rows = await self.md.option_quotes(intent.symbol, intent.currency, "", intent.multiplier,
                                           [(l["expiry"], l["strike"], l["right"]) for l in intent.legs])
        legs = []
        for l in intent.legs:
            m = [r for r in rows if r["expiry"].startswith(l["expiry"]) and abs(r["strike"] - l["strike"]) < 1e-6 and r["right"] == l["right"]]
            legs.append(m[0] if m else {})
        return structure_quote(intent, legs), legs

    async def build_context(self, intent: OrderIntent, *, exclude_self: bool = False) -> Context:
        snap = self.bridge.snapshot()
        acct = snap.get("account") or {}
        quote, session = await self._quote(intent)  # underlying quote + its trading session
        option_legs, option_limits = None, None
        if intent.is_option:
            try:
                option_limits = self.option_limits()
                quote, option_legs = await self._option_quote(intent)
            except Exception as e:  # noqa: BLE001 — missing option data → the gate fails closed
                log.warning("option context for %s: %s", intent.intent_id, e)
                quote, option_legs = None, None
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
            option_limits=option_limits, option_legs=option_legs,
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
            self.heartbeats["drawdown_monitor"] = self.clock()
            try:
                if self.drawdown_breached():
                    log.error("daily drawdown breached — tripping kill switch")
                    await self.kill("daily drawdown circuit breaker (monitor)", "security_detail", dry_run=False)
            except Exception as e:  # noqa: BLE001
                log.warning("monitor: %s", e)
            await asyncio.sleep(MONITOR_S)

    # ── engines ──────────────────────────────────────────────────────
    async def _sizing(self) -> tuple[float, float, float]:
        """(equity used for sizing, USD->base rate, stock risk budget): a size hint only; the gate caps."""
        snap = self.bridge.snapshot()
        acct = snap.get("account") or {}
        eq = acct.get("netLiquidation") or 0.0
        lim = self.limits()
        eq_used = min(eq, lim.financer_allocation_base) if lim.financer_allocation_base else eq
        base = acct.get("currency")
        fx, _ = await asyncio.to_thread(merged_rates, snap.get("fx") or {}, {"USD"}, base, self.fx)
        usd = 1.0 if base == "USD" else fx.get("USD", 0.0)
        budget = min(lim.max_risk_per_trade_pct / 100 * eq_used, lim.max_risk_per_trade_base)
        return eq_used, usd, budget

    def _engines_halted(self) -> str | None:
        if kill_switch.is_locked(self.d):
            return "trading is LOCKED by the kill switch"
        if self.state().get("agentHalted"):
            return "the agent / engines are halted"
        return None

    async def engine_a_scan(self, symbols: list[str] | None, submit: bool, actor: str) -> dict[str, Any]:
        halted = self._engines_halted()
        if submit and halted:
            return {"ok": False, "error": halted}
        _eq, usd, budget = await self._sizing()
        if submit and not usd:
            return {"ok": False, "error": "no USD rate, can't size"}
        res = await self.engine_a.scan(symbols=symbols, risk_budget_base=budget, fx_usd=usd or 1.0,
                                       submit=self.submit if submit else None, actor=actor)
        return {"ok": True, **res}

    async def engine_b_propose(self, symbol: str, view: str, structure: str, submit: bool, actor: str) -> dict[str, Any]:
        halted = self._engines_halted()
        if submit and halted:
            return {"ok": False, "error": halted}
        olim = self.option_limits()
        eq_used, usd, _budget = await self._sizing()
        if not usd:
            return {"ok": False, "error": "no USD rate, can't size"}
        budget = min(olim.max_premium_pct / 100 * eq_used, olim.max_premium_base)
        res = await self.engine_b.propose(symbol.upper(), view=view, structure=structure, lim=olim, premium_budget_base=budget,
                                          fx=usd, submit=self.submit if submit else None, actor=actor)
        return {"ok": True, **res}

    async def watchlist_add(self, symbol: str, source: str, reason: str) -> dict[str, Any]:
        stats = quote = None
        try:
            bars = await self.md.daily_bars(symbol.upper())
            stats = market_stats_from_bars(bars)
            quote = await self.md.stock_quote(symbol.upper())
        except Exception as e:  # noqa: BLE001 -- the prefilter then rejects for missing data
            log.info("watchlist prefilter data for %s: %s", symbol, e)
        row = self.watchlist.add(symbol, source=source, reason=reason, stats=stats, quote=quote, now=self.clock())
        self.audit.append("watchlist_add", row, ref=row["symbol"], verdict=row["status"].upper(), actor=source)
        return row

    def engines_view(self) -> dict[str, Any]:
        try:
            olim, olim_err = self.option_limits().to_dict(), None
        except Exception as e:  # noqa: BLE001
            olim, olim_err = None, str(e)
        st = self.state()
        return {"watchlist": self.watchlist.symbols(), "watchlistRows": self.watchlist.rows(),
                "lastScan": self.engine_a.last_scan, "lastOptions": self.engine_b.last,
                "optionLimits": olim, "optionLimitsError": olim_err,
                "autoScanMinutes": int(st.get("autoScanMinutes") or 0), "guard": st.get("optionsGuard") or {}}

    def set_auto_scan(self, minutes: int, actor: str) -> dict[str, Any]:
        if minutes not in (0, 5, 15, 30, 60):
            raise ValueError("autoScanMinutes must be 0 (off), 5, 15, 30 or 60")
        self._save_state(autoScanMinutes=minutes)
        self.audit.append("engine_auto_scan", {"minutes": minutes}, ref="engine_a", verdict="OK", actor=actor)
        return self.engines_view()

    async def auto_scan_loop(self) -> None:
        """Engine A on a timer (off by default). Skips whenever trading is locked or the agent is halted."""
        last = 0.0
        while True:
            await asyncio.sleep(30)
            self.heartbeats["auto_scan"] = self.clock()
            try:
                minutes = int(self.state().get("autoScanMinutes") or 0)
                if not minutes or self._engines_halted() or self.clock() - last < minutes * 60:
                    continue
                if not regular_hours_fallback(self.clock()):
                    continue
                last = self.clock()
                await self.engine_a_scan(None, True, "engine_a:auto")
            except Exception as e:  # noqa: BLE001
                log.warning("auto scan: %s", e)

    # ── options guard: premium stops + never hold into expiry ────────
    async def options_guard(self, contract_factory: Callable[..., Any] | None = None) -> dict[str, Any]:
        """One pass. Expiry flatten for every held option line; premium stop for desk-opened structures."""
        report: dict[str, Any] = {"at": self.clock(), "flatten": [], "stops": [], "errors": []}
        if kill_switch.is_locked(self.d):
            report["skipped"] = "locked (the kill switch already flattened)"
            return report
        snap = self.bridge.snapshot()
        if snap.get("state") != "CONNECTED":
            report["skipped"] = "bridge not connected"
            return report
        olim = self.option_limits()
        positions, orders = snap.get("positions") or [], snap.get("openOrders") or []
        guard_working = [o for o in orders if (o.get("orderRef") or "").startswith("GUARD-")]
        # 1. Expiry flatten (shorts bought back before longs are sold).
        plan = flatten_plan(positions, guard_working, self.clock(), olim)
        if plan:
            if contract_factory is None:
                from ib_async import Contract as contract_factory  # noqa: N813
            unders = {next((x.get("underlying") or x.get("symbol") for x in positions if x.get("conId") == st["conId"]), st["symbol"]) for st in plan}
            for u in unders:
                try:
                    await self.executor.cancel_working(symbol=u)  # resting take-profits must not fill after we exit
                except Exception as e:  # noqa: BLE001
                    report["errors"].append(f"cancel {u}: {e}")
            for st in plan:
                try:
                    res = await self.executor.close_option(contract_factory(conId=st["conId"], exchange="SMART"), st["qty"], None,
                                                           f"GUARD-EXP-{st['conId']}", action=st["action"])
                    report["flatten"].append({**st, **res})
                    self.audit.append("options_expiry_flatten", {**st, **res}, ref=str(st["conId"]), verdict="SUBMITTED", actor="options_guard")
                except Exception as e:  # noqa: BLE001
                    report["errors"].append(f"flatten {st['symbol']}: {e}")
        # 2. Premium stops for structures the desk opened.
        with self._conn() as c:
            ids = [r[0] for r in c.execute("SELECT intent_id FROM intents WHERE status='submitted'").fetchall()]
        for iid in ids:
            row = self._row(iid)
            intent = parse_intent(row["intent"])
            if not intent.is_option:
                continue
            lg = intent.legs[0]
            held = [p for p in positions if p.get("secType") == "OPT" and (p.get("underlying") or "") == intent.symbol
                    and (p.get("position") or 0) > 0 and (p.get("expiry") or "").startswith(lg["expiry"])
                    and p.get("right") == lg["right"] and abs((p.get("strike") or 0) - lg["strike"]) < 1e-6]
            if not held:
                continue
            try:
                quote, _legs = await self._option_quote(intent)
            except Exception as e:  # noqa: BLE001
                report["errors"].append(f"quote {iid}: {e}")
                continue
            m = opt.mid(quote or {})
            if m is None or m > intent.stop_loss:
                continue
            qty = min(int(held[0]["position"]), row["decision"]["quantity"] or intent.quantity)
            try:
                await self.executor.cancel_working(ref=iid)  # the resting take-profit
                ib = await self.executor._ensure()
                contract = await self.executor._contract(ib, intent, {})
                limit = opt.tick(max(quote["bid"], 0.01))
                res = await self.executor.close_option(contract, qty, limit, f"GUARD-STOP-{iid}", action="SELL")
                self._set_status(iid, "closed_stop", {"exit": res, "mid": m})
                report["stops"].append({"intentId": iid, "mid": m, "stop": intent.stop_loss, **res})
                self.audit.append("options_premium_stop", {"mid": m, "stop": intent.stop_loss, **res}, ref=iid, verdict="SUBMITTED", actor="options_guard")
            except Exception as e:  # noqa: BLE001
                report["errors"].append(f"stop {iid}: {e}")
        self._save_state(optionsGuard={"at": report["at"], "flattened": len(report["flatten"]), "stopped": len(report["stops"]),
                                       "errors": report["errors"][:5]})
        return report

    async def options_guard_loop(self) -> None:
        while True:
            self.heartbeats["options_guard"] = self.clock()
            try:
                await self.options_guard()
            except Exception as e:  # noqa: BLE001
                log.warning("options guard: %s", e)
            await asyncio.sleep(OPTIONS_GUARD_S)

    # ── Phase 4: Discord intel, outcome scoring, trade journal ──────
    def discord_import(self, actor: str) -> dict[str, Any]:
        rep = import_inbox(self.discord, self.rag, self.d / "discord" / "inbox", universe=self.watchlist.symbols())
        self.audit.append("discord_import", {"files": [{k: f.get(k) for k in ("file", "kept", "calls", "dup", "rag", "error")} for f in rep["files"]]},
                          ref="discord", verdict="OK" if all("error" not in f for f in rep["files"]) else "PARTIAL", actor=actor)
        return rep

    def discord_ingest_api(self, messages: list[dict[str, Any]], actor: str) -> dict[str, Any]:
        """Relay path (n8n etc.): Discord API message objects for the configured channels."""
        from discord_ingest import allowed_channels, parse_api_message

        parsed = []
        for m in messages[:500]:
            try:
                parsed.append(parse_api_message(m))
            except (KeyError, ValueError):
                continue
        rep = self.discord.ingest(parsed, via="relay", rag=self.rag, universe=self.watchlist.symbols(), channels=allowed_channels() or None)
        self.audit.append("discord_relay", {k: rep[k] for k in ("seen", "kept", "calls", "dup", "rag")}, ref="discord", verdict="OK", actor=actor)
        return rep

    async def score_outcomes(self, actor: str) -> dict[str, Any]:
        rep = await outcomes.score_pending(self.discord, self.md, now_ms=int(self.clock() * 1000))
        self.last_scoring = rep
        self.audit.append("outcomes_scored", {k: rep[k] for k in ("calls", "tickers", "scored", "rows")}, ref="discord", verdict="OK", actor=actor)
        return rep

    def leaderboards(self, horizon: int = 5) -> dict[str, Any]:
        rows = self.discord.outcome_rows()
        return {"horizon": horizon, "authors": outcomes.leaderboard(rows, horizon=horizon, by="author")[:25],
                "channels": outcomes.leaderboard(rows, horizon=horizon, by="channel", min_calls=1)[:10]}

    def journal_pass(self) -> dict[str, Any]:
        """Close out finished trades: journal record, trading_rag write-back, Financer P&L roll-up."""
        snap = self.bridge.snapshot()
        fills = snap.get("fills") or []
        rep: dict[str, Any] = {"closed": []}
        if not fills:
            return rep
        with self._conn() as c:
            ids = [r[0] for r in c.execute("SELECT intent_id FROM intents WHERE status IN ('submitted','closed_stop')").fetchall()]
        for iid in ids:
            row = self._row(iid)
            rec = jr.build_record(row, fills)
            if rec is None:
                continue
            with self._conn() as c:
                c.execute("INSERT OR IGNORE INTO journal VALUES (?,?,?,?,?,?)",
                          (iid, rec["closedAt"], rec["symbol"], rec["pnl"], rec["outcome"], json.dumps(rec, default=str)))
            self._set_status(iid, "closed", {**(row.get("result") or {}), "journal": {"pnl": rec["pnl"], "exitReason": rec["exitReason"]}})
            text, tags, eid = jr.rag_entry(rec)
            try:
                self.rag.put(text, tags, entry_id=eid, now_ms=int(rec["closedAt"] * 1000))
            except Exception as e:  # noqa: BLE001 — the journal row is the source of truth
                log.warning("journal rag write %s: %s", iid, e)
            self.audit.append("trade_closed", {k: rec[k] for k in ("symbol", "pnl", "rMultiple", "exitReason", "outcome", "slippage")},
                              ref=iid, verdict=rec["outcome"].upper(), actor="journal")
            rep["closed"].append({"intentId": iid, "pnl": rec["pnl"], "exitReason": rec["exitReason"]})
        if rep["closed"]:
            rep["financer"] = self.report_pnl_to_financer()
        return rep

    def report_pnl_to_financer(self) -> dict[str, Any]:
        """Today's realized P&L (journal, converted to base) through the Financer-only comms contract."""
        snap = self.bridge.snapshot()
        base = (snap.get("account") or {}).get("currency") or "USD"
        start = ny_midnight(self.clock())
        with self._conn() as c:
            rows = c.execute("SELECT record FROM journal WHERE closed_at >= ?", (start,)).fetchall()
        recs = [json.loads(r[0]) for r in rows]
        fx_rates = {**(snap.get("fx") or {})}
        realized = 0.0
        for r in recs:
            rate = 1.0 if r["currency"] == base else fx_rates.get(r["currency"]) or (self.fx.rate_to_base(r["currency"], base) if self.fx else None)
            realized += r["pnl"] * (rate or 0.0)
        day = datetime.fromtimestamp(self.clock(), NY).strftime("%Y-%m-%d")
        env = {"msg_id": f"pnl-{day.replace('-', '')}-{len(recs)}", "from": "trading", "to": "financer", "kind": "pnl_report",
               "payload": {"date": day, "realized_base": round(realized, 2),
                           "unrealized_base": float((snap.get("pnl") or {}).get("unrealized") or 0.0), "trades": len(recs)}}
        return self.handle_comms(env, "journal")

    def journal_list(self, limit: int = 30) -> list[dict[str, Any]]:
        with self._conn() as c:
            rows = c.execute("SELECT record FROM journal ORDER BY closed_at DESC LIMIT ?", (max(1, min(limit, 200)),)).fetchall()
        out = []
        for (r,) in rows:
            rec = json.loads(r)
            rec.pop("entryFills", None)
            rec.pop("exitFills", None)
            out.append(rec)
        return out

    def intel_view(self) -> dict[str, Any]:
        from discord_live import configured

        with self._conn() as c:
            agg = c.execute("SELECT COUNT(*), COALESCE(SUM(pnl),0), SUM(outcome='win') FROM journal").fetchone()
        return {"discord": {**self.discord.stats(), "live": configured(), "liveStatus": self.discord_status,
                            "inbox": str(self.d / "discord" / "inbox")},
                "lastScoring": self.last_scoring, "leaderboards": self.leaderboards(),
                "journal": {"trades": agg[0], "pnl": agg[1], "wins": agg[2] or 0, "recent": self.journal_list(10)},
                "rag": self.rag.stats()}

    async def intel_loop(self) -> None:
        """Journal every minute; outcome scoring every 6 hours (cheap when nothing is due)."""
        last_score = 0.0
        while True:
            self.heartbeats["intel"] = self.clock()
            try:
                self.journal_pass()
                if self.clock() - last_score > 6 * 3600:
                    last_score = self.clock()
                    await self.score_outcomes("outcomes:auto")
            except Exception as e:  # noqa: BLE001
                log.warning("intel loop: %s", e)
            await asyncio.sleep(60)

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
            "signals": {"rag": self.rag.stats(), "quantgress": quantgress_last_report(self.d)},
            "engines": self.engines_view(),
        }

    def signals(self, q: str = "", ticker: str | None = None, k: int = 8) -> dict[str, Any]:
        """Context block for the Trading Agent: hypotheses come wrapped in the bias-hygiene directive."""
        entries = self.rag.query(q, ticker=ticker, k=max(1, min(k, 25)))
        return {"entries": [dataclasses.asdict(e) for e in entries], "context": self.rag.render_context(entries)}


def structure_quote(intent: OrderIntent, legs: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Bid/ask of the whole structure per contract: a single leg, or long - short for a debit vertical."""
    if not legs or any(not l or l.get("bid") is None or not l.get("ask") for l in legs):
        return None
    if len(legs) == 1:
        return {"bid": legs[0]["bid"], "ask": legs[0]["ask"], "last": legs[0].get("last")}
    long_q, short_q = legs
    bid = round(long_q["bid"] - short_q["ask"], 4)
    ask = round(long_q["ask"] - short_q["bid"], 4)
    return {"bid": max(bid, 0.0), "ask": ask, "last": None} if ask > 0 else None
