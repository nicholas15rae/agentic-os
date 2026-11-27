"""Trading desk: execution modes, the SEMI_AUTO approval queue, the drawdown
monitor, Financer comms and the kill switch — wired around the Security Detail.

Flow for every OrderIntent (from Engine R, Engine A / B, or manual):

  parse_intent (strict schema) ─► LLM-sourced ("trading_agent")? refused, audited llm_trade_refused
  ─► build Context from live telemetry + quote
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
import failures
import kill_switch
from audit import AuditLog
from config import data_dir, load_config
from executor import ExecutionRefused, Executor
from fx import FxSource, merged_rates
from intents import IntentError, OrderIntent, RiskLimits, load_limits, parse_intent
from quantgress import last_report as quantgress_last_report
from trading_rag import TradingRag
import journal as jr
from telemetry import exec_key, open_qty
from callbook import CallBook
import options as opt
import outcomes
from discord_ingest import DiscordStore, import_inbox
from engines.equities_commodities import EngineA, Watchlist
from engines.options_engine import EngineB, flatten_plan
from security_detail import (NY, Context, Decision, evaluate, market_stats_from_bars, regular_hours_fallback, session_open_from_hours,
                             us_market_closed_reason)

log = logging.getLogger("trading.desk")

MODES = ("ADVISORY", "SEMI_AUTO", "FULL_AUTO")
ACTIVE = ("pending_approval", "submitted", "hypothetical")
# The LLM never places trades or makes live buy/sell decisions: an intent from it is refused before evaluation,
# in every mode, and a legacy pending card from it can't be approved. Execution is Engine R (rule_engine.py).
LLM_SOURCES = ("trading_agent",)
# Autonomous sources stop while the agent/engines are halted (kill switch, Financer halt, overseer).
AUTONOMOUS_SOURCES = ("trading_agent", "rule_engine")
LLM_REFUSAL = "LLM-sourced intents never reach the broker: the model is an analyst only (Engine R executes rules)"
MONITOR_S = 10.0
OPTIONS_GUARD_S = 60.0
GUARD_RETRY_BASE_S = 60.0  # options guard: first retry of a failed exit after this long, doubling...
GUARD_RETRY_MAX_S = 300.0  # ...up to this (expiry day leaves no room for longer)
KILL_SETTLE_S = 120.0  # after a kill with nothing left locked: how long its flatten's market orders get before the guard resumes


def kill_never_connected(inc: dict[str, Any]) -> bool:
    """Did this kill fail before it reached TWS (no connection), so it cancelled and sent nothing? Only then does a
    second press run the kill again. After a kill that connected but whose cancel or flatten failed, its KILL- market
    orders may still be queued: flattening again could double the exit."""
    return not any(st.get("step") == "connect" and st.get("ok") is True for st in inc.get("steps") or [])


ORDERS_STALE_S = 30.0  # the bridge refreshes openOrders every ~5 s: older than this and the list can't be trusted
# Closing orders the options guard can't cancel (other TWS clients: kill switch, overseer, desk-cli) or already owns:
# netted out of its own exits, so a line is never sold twice (reconcile.KNOWN_REF_PREFIXES).
GUARD_NETTED_PREFIXES = ("GUARD-", "KILL-", "MSL-", "DMS-", "CLI-")


def closes_now(o: dict[str, Any]) -> bool:
    """May the options guard count this order as buying a short back this pass? Only when its ref says it is a flatten
    or exit (GUARD_NETTED_PREFIXES) and its side and size are known. Another client's resting order (a manual limit
    in TWS, say) is still netted, so a line is never bought twice, but it may never fill."""
    return bool((o.get("orderRef") or "").startswith(GUARD_NETTED_PREFIXES) and o.get("action")
                and (o.get("quantity") or o.get("remaining")))


def describe_order(o: dict[str, Any]) -> str:
    """One open order for a report line: BUY 2 LMT @0.05 GTC (client 0, ref -, #812 perm 1234)."""
    lim, tif, perm = o.get("limitPrice"), o.get("tif"), o.get("permId")
    return (f"{o.get('action') or '?'} {open_qty(o):g} {o.get('orderType') or '?'}{f' @{lim}' if lim else ''}{f' {tif}' if tif else ''} "
            f"(client {o.get('clientId')}, ref {o.get('orderRef') or '-'}, #{o.get('orderId')}{f' perm {perm}' if perm else ''})")

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
        pretrade: bool = True,
    ) -> None:
        self.bridge = bridge
        self.d = d or data_dir()
        self.audit = AuditLog(self.d / "audit.db")
        # Deterministic pre-trade gates (trading/pretrade.py) right before anything is sent to TWS.
        # On in production (the bridge builds Desk(bridge)); only Security-Detail-only unit tests turn it off.
        self.pretrade = pretrade
        from ledger import Ledger

        self.ledger = Ledger(self.d / "ledger.jsonl")
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
        # Phase 5: the agent's / Engine A's calls + SPY baseline, scored like Discord calls.
        self.calls = CallBook(self.d / "desk.db")
        self.agent: Any = None  # set by the bridge (agent.TradingAgent; retired as a trader, kept for its run history)
        self.rules: Any = None  # set by the bridge (rule_engine.RuleEngine: Engine R, the only autonomous executor)
        self.analyst: Any = None  # set by the bridge (analyst.Analyst: the LLM, outside trading hours, suggestions only)
        self.last_call_scoring: dict[str, Any] | None = None
        self.last_scoring: dict[str, Any] | None = None
        # Background-loop heartbeats (name -> last iteration, epoch s) for the health check.
        self.heartbeats: dict[str, float] = {}
        self._guard_fails: dict[str, tuple[int, float]] = {}  # options-guard exit key -> (failures in a row, retry at)
        self._weak_cover_seen: set[str] = set()  # short lines already audited as covered only by a foreign order
        self._killed = False  # set by a live kill(); cleared by reset() or _stood_down(): the options guard stands down meanwhile
        self._kill_running = False
        self._kill_done_at = 0.0
        self._kill_evt: asyncio.Event | None = None  # set when the running live kill finishes
        self._last_kill: dict[str, Any] | None = None
        try:
            self._exec_client = int(load_config().client_ids.get("exec", 13))  # the executor's TWS client id
        except Exception:  # noqa: BLE001
            self._exec_client = 13
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
        decision, result = json.loads(r[3]), json.loads(r[4]) if r[4] else None
        return {"intentId": r[0], "status": r[1], "intent": json.loads(r[2]), "decision": decision,
                "result": result, "created": r[5], "updated": r[6],
                # why it didn't trade (rejected / failed only); derived from the error text for rows stored before it existed
                "failure": failures.classify(r[1], result, decision)}

    def _put(self, intent: OrderIntent, status: str, decision: Decision, result: Any = None) -> None:
        now = self.clock()
        with self._conn() as c:
            c.execute(
                "INSERT INTO intents(intent_id, status, symbol, action, quantity, intent, decision, result, created, updated) VALUES (?,?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(intent_id) DO UPDATE SET status=excluded.status, decision=excluded.decision, result=excluded.result, quantity=excluded.quantity, updated=excluded.updated",
                (intent.intent_id, status, intent.symbol, intent.action, decision.quantity or intent.quantity,
                 json.dumps(intent.to_dict()), json.dumps(decision.to_dict()), json.dumps(result, default=str) if result is not None else None, now, now),
            )

    def _note_exit_fills(self, intent_id: str, exit_fills: dict[str, float], seen: dict[str, float]) -> None:
        """Merge newly seen exit executions (keyed by exec_key, so a correction replaces the fill it corrects) into
        `exit_fills` and persist them on the intent row when anything changed."""
        changed = {k: v for k, v in seen.items() if exit_fills.get(k) != v}
        if changed:
            exit_fills.update(changed)
            self._merge_result(intent_id, {"exitFills": exit_fills})

    def _merge_result(self, intent_id: str, patch: dict[str, Any]) -> None:
        """Add keys to an intent's stored result without touching its status or `updated` (recent-activity checks)."""
        row = self._row(intent_id)
        res = row["result"] if row and isinstance(row["result"], dict) else {}
        with self._conn() as c:
            c.execute("UPDATE intents SET result = ? WHERE intent_id = ?", (json.dumps({**res, **patch}, default=str), intent_id))

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
        """Quote + trading session for the gate, via the market-data client (12).

        It used to borrow the bridge's telemetry connection (client 11) with an 8 s wait; a symbol's
        first quote there could miss (seen live on UNG while client 12 quoted it in ~1 s), and the
        gate then rejects a good idea for "no quote". Client 12 is built for quotes (12 s wait), and
        one retry during the session covers a slow first subscription."""
        try:
            c = await self.md.stock(intent.symbol, intent.currency)
        except Exception:  # noqa: BLE001 — unknown symbol / data client down → fail closed in the gate
            return None, None
        session = None
        try:
            details = await asyncio.wait_for(self.md.ib.reqContractDetailsAsync(c), 6)
            if details:
                session = session_open_from_hours(details[0].liquidHours, details[0].timeZoneId, self.clock())
        except Exception:  # noqa: BLE001
            session = None
        if session is None:
            session = regular_hours_fallback(self.clock())
        try:
            q = await self.md.quote(c)
            if session and not (q.get("bid") and q.get("ask")):
                q = await self.md.quote(c)
        except Exception:  # noqa: BLE001
            return None, session
        return {"bid": q.get("bid"), "ask": q.get("ask"), "last": q.get("last"), "time": q.get("time")}, session

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
        if session and us_market_closed_reason(intent, self.clock()):
            session = False  # the static NYSE calendar overrides: holiday / after a 13:00 half-day close
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
            allowed_symbols=set(self.watchlist.symbols()) if intent.source == "trading_agent" else None,
        )

    # ── intents ──────────────────────────────────────────────────────
    async def submit(self, raw: Any, actor: str) -> dict[str, Any]:
        try:
            intent = parse_intent(raw)
        except IntentError as e:
            ref = raw.get("intent_id", "") if isinstance(raw, dict) else ""
            self.audit.append("intent_schema_rejected", {"error": str(e), "raw": raw if isinstance(raw, dict) else str(raw)[:500]},
                              ref=str(ref)[:64], verdict="REJECTED", actor=actor)
            return {"ok": False, "status": "rejected", "error": f"schema: {e}", "failure": failures.failure("schema", f"schema: {e}")}
        if intent.source in LLM_SOURCES:
            self.audit.append("llm_trade_refused", {"intent": intent.to_dict(), "why": LLM_REFUSAL}, ref=intent.intent_id, verdict="REFUSED", actor=actor)
            return {"ok": False, "status": "rejected", "error": LLM_REFUSAL, "failure": failures.failure("policy", LLM_REFUSAL)}
        async with self._lock:
            ctx = await self.build_context(intent)
            decision = evaluate(intent, ctx)
            st = self.state()
            self.audit.append("intent_evaluated", {"intent": intent.to_dict(), "decision": decision.to_dict(), "mode": st["mode"]},
                              ref=intent.intent_id, verdict=decision.verdict, actor=actor)
            if decision.trip_kill:
                await self.kill("daily drawdown circuit breaker", "security_detail", dry_run=False)
            if not decision.executable:
                why = failures.from_checks(decision.checks)
                if not ctx.seen_intent:
                    self._put(intent, "rejected", decision, {"failure": why})
                return {"ok": False, "status": "rejected", "decision": decision.to_dict(), "failure": why}
            # A backstop for a kill whose halt write never landed: while its stand-down holds (the options guard is off,
            # its flatten may still be working), no autonomous entry goes out, whatever state.json says.
            if (st["agentHalted"] or self._stood_down()) and intent.source in AUTONOMOUS_SOURCES:
                why = failures.failure("kill_switch", "autonomous trading halted (kill switch / Financer halt / overseer)")
                self._put(intent, "rejected", decision, {"error": "autonomous trading halted", "failure": why})
                return {"ok": False, "status": "rejected", "error": "autonomous trading is halted", "decision": decision.to_dict(), "failure": why}
            if st["mode"] == "ADVISORY":
                self._put(intent, "hypothetical", decision)
                return {"ok": True, "status": "hypothetical", "decision": decision.to_dict()}
            if st["mode"] == "SEMI_AUTO":
                self._put(intent, "pending_approval", decision)
                return {"ok": True, "status": "pending_approval", "decision": decision.to_dict()}
            refused = self._pretrade(intent, decision, ctx, actor)
            if refused:
                refused["failure"] = failures.classify("rejected", {"pretrade": refused}, None)
                self._put(intent, "rejected", decision, {"pretrade": refused, "failure": refused["failure"]})
                return refused
            return await self._execute(intent, decision, actor)

    def _pretrade(self, intent: OrderIntent, decision: Decision, ctx: Context, actor: str) -> dict[str, Any] | None:
        """Run pretrade.gate (allowlist, size/notional, rate limit, cooldown, intent hash, bracket, stale data)
        immediately before execution. None = pass; otherwise the rejection to return. Fails closed."""
        if not self.pretrade:
            return None
        import pretrade
        import risk_policy

        try:
            policy = risk_policy.load_policy(risk_policy.policy_path(self.d))
        except risk_policy.PolicyError as e:
            self.audit.append("pretrade_rejected", {"error": str(e)}, ref=intent.intent_id, verdict="REJECTED", actor=actor)
            return {"ok": False, "status": "rejected", "error": f"pretrade: {e}", "decision": decision.to_dict()}
        snap = self.bridge.snapshot()
        now = time.time()  # the ledger stamps rows with wall time; windows must use the same clock
        age = now - float(snap["updatedAt"]) if snap.get("updatedAt") else None
        fx = 1.0 if intent.currency == ctx.base_currency else ctx.fx_to_base.get(intent.currency)
        r = pretrade.gate(intent.to_dict(), {"now": now, "quote": ctx.quote, "snapshot_age_s": age, "recent": None,
                                             "fx_to_base": fx, "entry_price": decision.entry_ref}, policy, self.ledger, actor)
        if r["ok"]:
            return None
        self.audit.append("pretrade_rejected", {"failed": r["failed"], "hash": r["hash"]}, ref=intent.intent_id, verdict="REJECTED", actor=actor)
        return {"ok": False, "status": "rejected", "error": "pretrade: " + ", ".join(r["failed"]), "pretrade": r, "decision": decision.to_dict()}

    async def _execute(self, intent: OrderIntent, decision: Decision, actor: str) -> dict[str, Any]:
        self._put(intent, "submitting", decision)
        try:
            res = await self.executor.place(intent, decision.quantity)
        except (ExecutionRefused, Exception) as e:  # noqa: BLE001
            err = f"{type(e).__name__}: {e}"
            why = failures.from_error(err)
            self._set_status(intent.intent_id, "failed", {"error": err, "failure": why})
            self.audit.append("order_failed", {"error": str(e), "failure": why}, ref=intent.intent_id, verdict="FAILED", actor=actor)
            return {"ok": False, "status": "failed", "error": str(e), "decision": decision.to_dict(), "failure": why}
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
            if intent.source in LLM_SOURCES:  # a card queued before the LLM was retired as a trader
                self._set_status(intent_id, "rejected", {"error": LLM_REFUSAL, "failure": failures.failure("policy", LLM_REFUSAL)})
                self.audit.append("llm_trade_refused", {"intent": intent.to_dict(), "why": LLM_REFUSAL, "path": "approve"}, ref=intent_id,
                                  verdict="REFUSED", actor=actor)
                return {"ok": False, "status": "rejected", "error": LLM_REFUSAL, "failure": failures.failure("policy", LLM_REFUSAL)}
            ctx = await self.build_context(intent, exclude_self=True)
            decision = evaluate(intent, ctx)
            self.audit.append("approval", {"decision": decision.to_dict()}, ref=intent_id, verdict=decision.verdict, actor=actor)
            if not decision.executable:
                why = failures.from_checks(decision.checks)
                self._set_status(intent_id, "rejected", {"recheck": decision.to_dict(), "failure": why})
                return {"ok": False, "status": "rejected", "decision": decision.to_dict(), "failure": why}
            refused = self._pretrade(intent, decision, ctx, actor)
            if refused:
                refused["failure"] = failures.classify("rejected", {"pretrade": refused}, None)
                self._set_status(intent_id, "rejected", {"pretrade": refused.get("pretrade") or refused.get("error"), "failure": refused["failure"]})
                return refused
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
            if self._stood_down():  # a kill just ran (its flatten still settling): don't re-arm with the guard stood down
                raise PermissionError("the kill switch just ran and its flatten isn't confirmed done yet (still working at TWS, "
                                      "or the bridge can't show its open orders): wait for that before re-arming")
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
        if dry_run:
            return await kill_switch.execute_kill(reason=reason, actor=actor, dry_run=True, connect=self._kill_connect, audit=self.audit, d=self.d,
                                                 market_order=self._kill_market_order)
        if self._kill_running:
            # A second live E-stop while one runs (button + hotkey, two devices): never flatten twice at once. Wait for
            # the running one. If it never connected (e.g. TWS refused its client id), it sent nothing and this press is
            # the retry that works, so run again. Otherwise report that kill as it is, errors included.
            while self._kill_running and self._kill_evt is not None:
                await self._kill_evt.wait()
            prev = self._last_kill or {}
            if not kill_never_connected(prev):
                self.audit.append("kill_already_running", {"reason": reason, "incidentId": prev.get("incidentId"), "ok": prev.get("ok")},
                                  ref="kill", verdict="IGNORED", actor=actor)
                note = ("A kill was already running and has cancelled and flattened: nothing more was sent." if prev.get("ok") else
                        "A kill was already running: it reached TWS but finished with errors (see its steps). Nothing more was "
                        "sent, so its orders aren't doubled. Check TWS; if positions remain, run python trading/kill_switch.py.")
                return {**prev, "alreadyRunning": True, "note": note}
        # The options guard and the executor's risk-reducing path stand down, in-process, so even a failed lock stamp
        # can't let a guard exit race the kill's flatten (kill_switch.allows_risk_reducing is the cross-process signal).
        self._killed = True
        self._kill_running = True
        self._kill_evt = asyncio.Event()
        self._last_kill = None  # if this kill raises, a waiting second press finds nothing sent and runs again
        self.executor.stand_down = True
        pre_errors: list[str] = []
        try:
            # Sever the agent BEFORE the network steps so nothing new is queued meanwhile. Best-effort: e.g. a state.json
            # replace refused by Windows (another process has it open) must never stop the lock / cancel / flatten.
            halted = True
            try:
                self._save_state(mode="ADVISORY", agentHalted=True)
            except Exception as e:  # noqa: BLE001
                halted = False
                pre_errors.append(f"halt state: {type(e).__name__}: {e}")
            try:
                with self._conn() as c:
                    c.execute("UPDATE intents SET status='expired', updated=? WHERE status='pending_approval'", (self.clock(),))
            except Exception as e:  # noqa: BLE001
                pre_errors.append(f"expire pending cards: {type(e).__name__}: {e}")

            def sever() -> str | None:
                """The kill's sever_agent step: if the halt write failed before the kill, try again now (the other
                process may have let go of state.json), then by desk_lock's own write. Only a halt that never landed fails
                the step, truthfully."""
                if halted:
                    return None
                try:
                    self._save_state(mode="ADVISORY", agentHalted=True)
                    return None
                except Exception as e1:  # noqa: BLE001
                    try:
                        import desk_lock

                        desk_lock.halt_autonomy(self.d)
                        return None
                    except Exception as e2:  # noqa: BLE001
                        return f"agent NOT halted: state.json could not be written ({type(e1).__name__}: {e1}; halt_autonomy: {type(e2).__name__}: {e2})"

            inc = await kill_switch.execute_kill(reason=reason, actor=actor, dry_run=False, connect=self._kill_connect, audit=self.audit, d=self.d,
                                                 market_order=self._kill_market_order, sever=sever)
            if pre_errors:
                inc.setdefault("errors", []).extend(pre_errors)
                inc["ok"] = False
                self.audit.append("kill_preamble_failed", {"errors": pre_errors}, ref=str(inc.get("incidentId", "")), verdict="ERROR", actor=actor)
            self._last_kill = inc
            return inc
        finally:
            self._kill_running = False
            self._kill_done_at = self.clock()
            self._kill_evt.set()

    def _kill_orders_working(self) -> bool | None:
        """Is the kill's flatten still working at TWS (any KILL- order with open quantity)? None = can't tell: the bridge
        isn't connected, or its open-order list is missing or stale. Outside the session those MKT DAY orders queue until
        the open, so a timer alone can't say the flatten is done."""
        snap = self.bridge.snapshot()
        at = snap.get("openOrdersAt")
        if snap.get("state") != "CONNECTED" or not at or self.clock() - float(at) > ORDERS_STALE_S:
            return None
        if float(at) <= self._kill_done_at:
            return None  # a list from before the kill finished placing its orders proves nothing
        return any((o.get("orderRef") or "").startswith("KILL-") and open_qty(o) > 0 for o in snap.get("openOrders") or [])

    def _stood_down(self) -> bool:
        """The in-process stand-down after a kill. It holds while the kill runs, while anything is locked, for at least
        KILL_SETTLE_S after it finished, and while its flatten orders (KILL-) are still working or that can't be checked
        (fail closed). Then it clears itself, audited, however the lock went away: Desk.reset, desk-cli unlock (another
        process), or a kill whose lock step failed. Otherwise unlock + re-arm would resume entries with the options
        guard silently off; lifting it on a timer alone would let the guard sell a line the kill's queued flatten sells."""
        if not self._killed:
            return False
        if self._kill_running or kill_switch.is_locked(self.d) or self.clock() - self._kill_done_at < KILL_SETTLE_S:
            return True
        if self._kill_orders_working() is not False:
            return True
        self._killed = False
        self.executor.stand_down = False
        self.audit.append("kill_stand_down_cleared", {"killDoneAt": self._kill_done_at}, ref="options_guard", verdict="OK", actor="desk")
        return False

    def reset(self, confirm: str, actor: str) -> dict[str, Any]:
        if self._kill_running:
            raise PermissionError("a kill is still running: wait for it to finish before resetting")
        out = kill_switch.reset_lock(confirm, actor, self.audit, self.d)
        # An explicit reset lifts the stand-down at once, unless its flatten is still working (or can't be checked):
        # then _stood_down() lifts it when that's done.
        if self._kill_orders_working() is False:
            self._killed = False
            self.executor.stand_down = False
        # Always ADVISORY: if a kill's halt write failed, the stored mode could still say FULL_AUTO, and resetting must
        # never resume entries by itself. Re-arming is a separate, confirmed step (set_mode).
        self._save_state(mode="ADVISORY", agentHalted=False)
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
        # Every live Engine A setup is a scored "call" (once per symbol per day), paired with the SPY baseline.
        day = datetime.fromtimestamp(self.clock(), NY).strftime("%Y%m%d")
        for r in res.get("rows") or []:
            if r.get("signal"):
                self.calls.add(f"engine_a:{r['symbol']}:{day}", "engine_a", r["symbol"], "bullish", int(self.clock() * 1000),
                               ref=str((r.get("intent") or {}).get("intent_id", "")), baseline=True)
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
        self.heartbeats["auto_scan"] = self.clock()  # alive from the start, not only after the first sleep
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
        report: dict[str, Any] = {"at": self.clock(), "flatten": [], "stops": [], "errors": [], "waiting": []}
        if self._stood_down() or not kill_switch.allows_risk_reducing(self.d):
            report["skipped"] = "locked (the kill switch flattened, or the lock forbids exits)"
            return report
        lk = kill_switch.read_lock(self.d)
        if lk:  # a lock-only circuit breaker: entries are locked, but risk-reducing exits keep running
            report["underLock"] = sorted({str(b.get("code")) for b in lk.get("breakers") or []})
        snap = self.bridge.snapshot()
        if snap.get("state") != "CONNECTED":
            report["skipped"] = "bridge not connected"
            return report
        olim = self.option_limits()
        positions, orders, fills = snap.get("positions") or [], snap.get("openOrders") or [], snap.get("fills") or []
        # Closing orders the guard must net out of its own exits: its own GUARD- ones, and ones it can't cancel (another TWS
        # client's: the kill switch's KILL-, the overseer's MSL-/DMS-, desk-cli's CLI-). Not the desk's own resting
        # take-profit (executor client, ref = intent id): cancel_working takes that out before an exit.
        netted = [o for o in orders if (o.get("orderRef") or "").startswith(GUARD_NETTED_PREFIXES)
                  or (o.get("clientId") is not None and o.get("clientId") != self._exec_client)]
        under = lambda con_id, sym: next((x.get("underlying") or x.get("symbol") for x in positions if x.get("conId") == con_id), sym)  # noqa: E731
        # 1. Expiry flatten (shorts bought back before longs are sold).
        now = self.clock()
        plan = flatten_plan(positions, netted, now, olim)
        # Underlyings whose short leg isn't bought back this pass, and why. A vertical's long leg is its cover: selling
        # it with the short still open leaves a naked short.
        uncovered: dict[str, str] = {}
        # flatten_plan nets every order on a due line that might close it (its side, or of unknown side or size), so the
        # guard never duplicates an order it can't cancel. Only one that closes it now (closes_now) is real cover:
        # another client's resting order (a manual GTC limit, client 0) may never fill. Then it is named, so an operator
        # can cancel or replace it in TWS, and a short line covered that way keeps its long legs unsold.
        for p in positions:
            if not (p.get("secType") == "OPT" and p.get("position") and p.get("expiry") and opt.must_flatten(p["expiry"], now, olim)):
                continue
            short = p["position"] < 0
            weak = [o for o in netted if o.get("conId") == p.get("conId") and not closes_now(o)
                    and (o.get("action") == ("BUY" if short else "SELL") or not o.get("action")
                         or not (o.get("quantity") or o.get("remaining")))]
            if not weak:
                continue
            u, sym, names = under(p["conId"], p.get("symbol")), p.get("symbol"), "; ".join(describe_order(o) for o in weak)
            if short:
                uncovered[u] = f"the short leg {sym} is covered by an order that may never fill: {names}"
                report["waiting"].append({"key": f"exp:{p['conId']}", "symbol": sym,
                                          "why": f"short {sym} is not bought back over an order the guard can't count on: {names}. "
                                                 f"The long legs on {u} are not sold until it fills or is cancelled"})
                report["errors"].append(f"flatten {sym}: short not bought back over an order that may never fill: {names}. "
                                        f"Cancel or replace it in TWS; until then the long legs on {u} are kept")
            else:
                report["errors"].append(f"flatten {sym}: left to an order that may never fill: {names}. "
                                        f"Cancel or replace it in TWS, or the line is held into expiry")
            seen = f"{p['conId']}:" + ",".join(sorted(str(o.get("orderId")) for o in weak))
            if seen not in self._weak_cover_seen:
                self._weak_cover_seen.add(seen)
                self.audit.append("options_expiry_flatten", {"conId": p["conId"], "symbol": sym, "underlying": u,
                                                             "position": p["position"], "coveredBy": weak},
                                  ref=str(p["conId"]), verdict="BLOCKED", actor="options_guard")
        if plan:
            if contract_factory is None:
                from ib_async import Contract as contract_factory  # noqa: N813
            for u in {under(st["conId"], st["symbol"]) for st in plan}:
                try:
                    await self.executor.cancel_working(symbol=u)  # resting take-profits must not fill after we exit
                except Exception as e:  # noqa: BLE001
                    report["errors"].append(f"cancel {u}: {e}")
            for st in plan:
                u, key = under(st["conId"], st["symbol"]), f"exp:{st['conId']}"
                if st["action"] == "SELL" and u in uncovered:
                    report["errors"].append(f"flatten {st['symbol']}: not sold, because {uncovered[u]}")
                    continue
                wait = self._guard_backoff(key)
                if wait:
                    report["waiting"].append({"key": key, "symbol": st["symbol"], "retryAt": wait})
                    if st["action"] == "BUY":
                        uncovered.setdefault(u, f"buying back the short leg on {u} is backing off after a failed attempt")
                    continue
                try:
                    res = await self.executor.close_option(contract_factory(conId=st["conId"], exchange="SMART"), st["qty"], None,
                                                           f"GUARD-EXP-{st['conId']}", action=st["action"])
                    self._guard_ok(key)
                    report["flatten"].append({**st, **res})
                    self.audit.append("options_expiry_flatten", {**st, **res}, ref=str(st["conId"]), verdict="SUBMITTED", actor="options_guard")
                except Exception as e:  # noqa: BLE001 — e.g. TWS refused / never acknowledged the exit; a later pass re-plans it
                    if st["action"] == "BUY":
                        uncovered.setdefault(u, f"buying back the short leg on {u} didn't go through this pass")
                    verdict, n, retry_at = self._guard_failed(key)
                    report["errors"].append(f"flatten {st['symbol']}: {e}")
                    self.audit.append("options_expiry_flatten", {**st, "error": str(e), "attempt": n, "retryAt": retry_at},
                                      ref=str(st["conId"]), verdict=verdict, actor="options_guard")
        # 2. Premium stops for structures the desk opened.
        with self._conn() as c:
            ids = [r[0] for r in c.execute("SELECT intent_id FROM intents WHERE status='submitted'").fetchall()]
        for iid in ids:
            row = self._row(iid)
            intent = parse_intent(row["intent"])
            if not intent.is_option:
                continue
            lg = intent.legs[0]
            if opt.must_flatten(lg["expiry"], self.clock(), olim):
                continue  # inside the expiry window step 1 owns these legs: a premium stop now would stack a second SELL
            held = [p for p in positions if p.get("secType") == "OPT" and (p.get("underlying") or "") == intent.symbol
                    and (p.get("position") or 0) > 0 and (p.get("expiry") or "").startswith(lg["expiry"])
                    and p.get("right") == lg["right"] and abs((p.get("strike") or 0) - lg["strike"]) < 1e-6]
            if not held:
                continue
            ref, key = f"GUARD-STOP-{iid}", f"stop:{iid}"
            # What earlier attempts of this stop already did. One can raise (ack wait timed out, socket dropped) and still
            # fill or stay working at TWS: net out both, or a retry sells contracts the desk never owned (the line can hold
            # more than this intent). Fills on the long leg are kept on the intent row by execId. The bridge's fills only
            # cover today, so they're recorded on every pass, before the mid check: a later day still sees them.
            leg_con = held[0].get("conId")
            exit_fills = dict((row.get("result") if isinstance(row.get("result"), dict) else {}).get("exitFills") or {})
            self._note_exit_fills(iid, exit_fills, {exec_key(f["execId"]): float(f.get("shares") or 0) for f in fills
                                                    if f.get("orderRef") == ref and f.get("conId") == leg_con and f.get("execId")})
            try:
                quote, _legs = await self._option_quote(intent)
            except Exception as e:  # noqa: BLE001
                report["errors"].append(f"quote {iid}: {e}")
                continue
            m = opt.mid(quote or {})
            if m is None or m > intent.stop_loss:
                continue
            # Other closing orders on the long leg (the kill's queued flatten, the overseer's, a GUARD-EXP) shrink what
            # is left to sell; so does this stop's own working exit.
            others = [o for o in netted if o.get("orderRef") != ref and o.get("conId") == leg_con and o.get("action") == "SELL"]
            other = sum(open_qty(o) for o in others)
            # Another client's resting SELL is netted too (selling on top of it could sell contracts the desk doesn't
            # own), but it may never fill: name it, so the stop that isn't being placed has a reason a human can act on.
            weak_names = "; ".join(describe_order(o) for o in others if not closes_now(o))
            weak = f"; netted orders that may never fill: {weak_names}" if weak_names else ""
            working = sum(open_qty(o) for o in orders if o.get("orderRef") == ref)
            need = lambda work: int(min(int(held[0]["position"]) - other, (row["decision"]["quantity"] or intent.quantity)  # noqa: E731
                                        - sum(exit_fills.values())) - work)
            qty = need(working)
            if qty <= 0:
                report["waiting"].append({"key": key, "intentId": iid, "why": f"stop {ref} already done or working "
                                          f"(filled {sum(exit_fills.values()):g}, working {working:g}, other exits {other:g}){weak}"})
                if weak_names:  # an endless wait behind an order that may never fill is not silent
                    report["errors"].append(f"stop {ref}: triggered (mid {m:g} <= stop {intent.stop_loss:g}) but not placed over "
                                            f"an order that may never fill: {weak_names}. Cancel or replace it in TWS")
                continue
            wait = self._guard_backoff(key)
            if wait:
                report["waiting"].append({"key": key, "intentId": iid, "retryAt": wait})
                continue
            try:
                # The bridge's view is polled, and it only sees another client's fills as TWS's master client: the
                # executor's own executions and open orders, right now, are the last word. Working size first: a fill
                # landing between the two reads is then counted twice (sells too little) rather than missed (too much).
                fresh = await self.executor.working_qty(ref)
                self._note_exit_fills(iid, exit_fills, await self.executor.exit_fills(ref, leg_con))
                qty = need(max(working, fresh))
                if qty <= 0:
                    report["waiting"].append({"key": key, "intentId": iid, "why": f"stop {ref} already done or working at TWS "
                                              f"(filled {sum(exit_fills.values()):g}, working {max(working, fresh):g}, "
                                              f"other exits {other:g}){weak}"})
                    continue
                await self.executor.cancel_working(ref=iid)  # the resting take-profit
                ib = await self.executor._ensure(risk_reducing=True)
                contract = await self.executor._contract(ib, intent, {})
                limit = opt.tick(max(quote["bid"], 0.01))
                # close_option waits for TWS to acknowledge the exit and raises if it was refused, so "closed_stop"
                # (which this pass never looks at again) is only recorded for an exit TWS has really taken.
                res = await self.executor.close_option(contract, qty, limit, ref, action="SELL")
                self._guard_ok(key)
                self._set_status(iid, "closed_stop", {"exit": res, "mid": m, "exitFills": exit_fills})
                report["stops"].append({"intentId": iid, "mid": m, "stop": intent.stop_loss, **res})
                self.audit.append("options_premium_stop", {"mid": m, "stop": intent.stop_loss, **res}, ref=iid, verdict="SUBMITTED", actor="options_guard")
            except Exception as e:  # noqa: BLE001 — the intent stays "submitted", so a later pass retries the stop
                verdict, n, retry_at = self._guard_failed(key)
                report["errors"].append(f"stop {iid}: {e}")
                self.audit.append("options_premium_stop", {"mid": m, "stop": intent.stop_loss, "error": str(e), "attempt": n, "retryAt": retry_at},
                                  ref=iid, verdict=verdict, actor="options_guard")
        self._save_state(optionsGuard={"at": report["at"], "flattened": len(report["flatten"]), "stopped": len(report["stops"]),
                                       "errors": report["errors"][:5]})
        return report

    # Retry backoff for the guard's exits (per premium-stop intent / expiry line): 60 s, doubling, capped at 5 min, so a
    # stuck exit is retried steadily without hammering TWS. Only the first failure of a streak is verdict FAILED (the
    # overseer's REJECTION_STORM counts those); repeats are RETRY_FAILED, so one stuck stop can't trip the storm lock.
    def _guard_backoff(self, key: str) -> float | None:
        n, retry_at = self._guard_fails.get(key, (0, 0.0))
        return retry_at if n and self.clock() < retry_at else None

    def _guard_failed(self, key: str) -> tuple[str, int, float]:
        n = self._guard_fails.get(key, (0, 0.0))[0] + 1
        retry_at = self.clock() + min(GUARD_RETRY_BASE_S * 2 ** (n - 1), GUARD_RETRY_MAX_S)
        self._guard_fails[key] = (n, retry_at)
        return ("FAILED" if n == 1 else "RETRY_FAILED"), n, retry_at

    def _guard_ok(self, key: str) -> None:
        self._guard_fails.pop(key, None)

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
                "channels": outcomes.leaderboard(rows, horizon=horizon, by="channel", min_calls=1)[:10],
                "desk": self.calls.leaderboard(horizon)}

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
        last_score = last_calls = 0.0
        while True:
            self.heartbeats["intel"] = self.clock()
            try:
                self.journal_pass()
                if self.clock() - last_calls > 3600:  # the agent's ADVISORY week needs daily feedback
                    last_calls = self.clock()
                    self.last_call_scoring = await self.calls.score(self.md, int(self.clock() * 1000))
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
            "agent": self.agent.view() if self.agent else None,
            "rules": self.rules.view() if self.rules else None,
            "analyst": self.analyst.view() if self.analyst else None,
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
