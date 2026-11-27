"""The Trading Agent — Phase 5. RETIRED AS A TRADER (Nov 2026).

The LLM no longer makes live buy/sell decisions: the bridge does not start this loop any more, its
/agent/run and /agent/enable routes refuse, and the desk refuses every intent with source
"trading_agent" (desk.LLM_SOURCES). Deterministic execution is Engine R (rule_engine.py); the model
is now the after-hours analyst (analyst.py), which only files PENDING rule-change suggestions.
This module stays for its run history (the status card), its gateway_think() client (reused by the
analyst) and its tests. The original design, for reference:

The LLM judgment layer on top of the existing desk.

  slots / events ─► run gate ─► context pack (agent_context) ─► local model (gateway /agent/think,
  waits for Tony's GPU turn) ─► validate JSON ─► OrderIntents (source trading_agent) ─► desk.submit
  ─► Security Detail ─► desk mode (ADVISORY: logged as hypothetical) ─► call book (scored vs SPY)

It can only propose: ETFs / commodity ETFs in the watchlist, long only, at most 2 per run, each
citing telemetry. The gate re-checks all of that (agent_scope) plus every risk rule. If the model
is busy, down or returns junk, the run does nothing. A kill switch or Financer halt stops it.

Cadence (New York): pre-market brief 09:15, hourly 10:00-15:00, plus at most 3 event runs a day
(a new Discord call on a universe symbol from a strong author, or a new Quantgress insider buy),
at least 20 minutes after any other run.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sqlite3
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from datetime import datetime
from typing import Any, Awaitable, Callable
from zoneinfo import ZoneInfo

import agent_context as ac
from intents import IntentError, parse_intent
from trading_rag import EXTERNAL_SIGNAL_HYPOTHESIS

log = logging.getLogger("trading.agent")
NY = ZoneInfo("America/New_York")

SLOTS = [(9, 15), (10, 0), (11, 0), (12, 0), (13, 0), (14, 0), (15, 0)]
SLOT_GRACE_S = 40 * 60          # a slot missed by more than this (bridge down, GPU busy all along) is skipped
EVENT_MAX_PER_DAY = 3
EVENT_MIN_GAP_S = 20 * 60
EVENT_MIN_ADJ = 0.60
EVENT_MIN_CALLS = 10
GATEWAY = "http://127.0.0.1:8080"
# Same default as the gateway's /agent/think (trading_api._agent_model); both read TRADING_AGENT_MODEL.
AGENT_MODEL = (os.environ.get("TRADING_AGENT_MODEL") or "qwen/qwen3.5-9b").strip()
ADVISORY_DAYS = 7
ETF_CLASSES = {"etf", "commodity_etf"}
RETIRED = ("retired as a trader: the LLM is an after-hours analyst that files pending rule-change suggestions; "
           "Engine R (deterministic rules) executes")

RUNS_SCHEMA = """
CREATE TABLE IF NOT EXISTS agent_runs (
  run_id TEXT PRIMARY KEY, kind TEXT NOT NULL, started REAL NOT NULL, finished REAL, status TEXT NOT NULL,
  detail TEXT, context TEXT, output TEXT, decisions TEXT, results TEXT, model_s REAL, waited_s REAL
);
CREATE INDEX IF NOT EXISTS agent_runs_started ON agent_runs(started);
"""

ThinkFn = Callable[[str, str], Awaitable[dict[str, Any]]]


def gateway_think(gateway: str = GATEWAY, timeout: float = 420.0) -> ThinkFn:
    async def think(system: str, prompt: str) -> dict[str, Any]:
        def call() -> dict[str, Any]:
            req = urllib.request.Request(f"{gateway}/api/trading/agent/think", method="POST",
                                         data=json.dumps({"system": system, "prompt": prompt, "maxTokens": 3000, "waitS": 90}).encode(),
                                         headers={"Content-Type": "application/json"})
            try:
                with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 — local gateway
                    return json.loads(r.read().decode("utf-8"))
            except urllib.error.HTTPError as e:
                return {"ok": False, "skipped": "gateway_error", "detail": f"HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:200]}"}
            except (urllib.error.URLError, OSError, ValueError) as e:
                return {"ok": False, "skipped": "gateway_unreachable", "detail": str(e)[:200]}
        return await asyncio.to_thread(call)
    return think


def _f(v: Any) -> float | None:
    if isinstance(v, bool) or v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def validate_output(obj: Any, *, universe: list[str], asset_class: Callable[[str], str], run_id: str, now: float,
                    max_props: int = ac.MAX_PROPOSALS) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str]]:
    """Model JSON → (raw OrderIntents, normalized decisions, errors). Never raises on bad model output."""
    errors: list[str] = []
    if not isinstance(obj, dict) or not isinstance(obj.get("decisions"), list):
        return [], [], ["output is not an object with a 'decisions' list"]
    decisions, proposals = [], []
    allowed = {s.upper() for s in universe}
    for d in obj["decisions"][:12]:
        if not isinstance(d, dict):
            errors.append("a decision is not an object")
            continue
        sym = str(d.get("symbol", "")).upper().strip()
        action = str(d.get("action", "")).lower().strip()
        conf = _f(d.get("confidence"))
        thesis = str(d.get("thesis") or "")[:1500]
        cites = [str(c)[:300] for c in (d.get("citations") or []) if isinstance(c, str)][:20]
        norm = {"symbol": sym, "action": action, "confidence": conf, "thesis": thesis, "citations": cites}
        decisions.append(norm)
        if action not in ("propose", "watch", "skip"):
            errors.append(f"{sym}: unknown action {action!r}")
            continue
        if sym not in allowed:
            errors.append(f"{sym}: outside the agent's universe")
            norm["action"] = "rejected_scope"
            continue
        if action != "propose":
            continue
        it = d.get("intent") if isinstance(d.get("intent"), dict) else {}
        if not any(c.startswith("telemetry:") for c in cites):
            errors.append(f"{sym}: proposal cites no telemetry")
            norm["action"] = "rejected_citations"
            continue
        qty = _f(it.get("quantity"))
        ot = str(it.get("order_type", "LMT")).upper()
        raw: dict[str, Any] = {
            "intent_id": f"ag-{run_id}-{sym}"[:64], "source": "trading_agent", "asset_class": asset_class(sym), "symbol": sym,
            "sec_type": "STK", "action": "BUY", "quantity": int(qty) if qty and qty == int(qty) else qty,
            "order_type": ot, "stop_loss": _f(it.get("stop_loss")), "take_profit": _f(it.get("take_profit")),
            "time_in_force": "DAY", "thesis": thesis, "citations": cites, "created_at": now,
        }
        if ot == "LMT":
            raw["limit_price"] = _f(it.get("limit_price"))
        if raw["take_profit"] is None:
            raw.pop("take_profit")
        try:
            parse_intent(raw)
        except IntentError as e:
            errors.append(f"{sym}: {e}")
            norm["action"] = "rejected_schema"
            continue
        proposals.append((conf or 0.0, raw, norm))
    proposals.sort(key=lambda x: -x[0])
    for _, _, norm in proposals[max_props:]:
        norm["action"] = "rejected_cap"
        errors.append(f"{norm['symbol']}: over the {max_props}-proposal cap")
    return [raw for _, raw, _ in proposals[:max_props]], decisions, errors


def slot_key(now: float) -> str | None:
    """The slot due at `now` (weekdays, within the grace window), e.g. '20261124-1000'."""
    t = datetime.fromtimestamp(now, NY)
    if t.weekday() >= 5:
        return None
    for h, m in SLOTS:
        start = t.replace(hour=h, minute=m, second=0, microsecond=0).timestamp()
        if start <= now < start + SLOT_GRACE_S:
            return f"{t.strftime('%Y%m%d')}-{h:02d}{m:02d}"
    return None


def in_session(now: float) -> bool:
    t = datetime.fromtimestamp(now, NY)
    return t.weekday() < 5 and (9, 30) <= (t.hour, t.minute) < (16, 0)


class TradingAgent:
    def __init__(self, desk: Any, *, think_fn: ThinkFn | None = None, clock: Callable[[], float] | None = None) -> None:
        self.desk = desk
        self.think = think_fn or gateway_think()
        self.clock = clock or desk.clock
        self._lock = asyncio.Lock()
        self._event_cursor_ms = int(self.clock() * 1000)
        with self._conn() as c:
            c.executescript(RUNS_SCHEMA)

    @contextmanager
    def _conn(self):
        c = sqlite3.connect(self.desk.d / "desk.db", timeout=10, isolation_level=None)
        try:
            yield c
        finally:
            c.close()

    # ── settings ──────────────────────────────────────────────────────
    def settings(self) -> dict[str, Any]:
        return {"enabled": True, **(self.desk.state().get("agent") or {})}

    def set_enabled(self, enabled: bool, actor: str) -> dict[str, Any]:
        s = {**self.settings(), "enabled": bool(enabled)}
        if enabled and not s.get("advisoryStart"):
            s["advisoryStart"] = self.clock()  # the ADVISORY week starts the first time it's switched on
        self.desk._save_state(agent=s)
        self.desk.audit.append("agent_enabled", {"enabled": bool(enabled)}, ref="trading_agent", verdict="ON" if enabled else "OFF", actor=actor)
        return s

    # ── gate ──────────────────────────────────────────────────────────
    def blocked(self, kind: str) -> str | None:
        import healthcheck
        import kill_switch

        if kill_switch.is_locked(self.desk.d):
            return "trading is LOCKED by the kill switch"
        st = self.desk.state()
        if st.get("agentHalted"):
            return "the agent is halted (kill switch / Financer halt)"
        if kind != "manual" and not self.settings()["enabled"]:
            return "the agent is switched off"
        if self.desk.bridge.snapshot().get("state") != "CONNECTED":
            return "bridge not connected to TWS"
        last = healthcheck.last_result(self.desk.d)
        if kind != "manual" and last and last.get("overall") == "FAIL" and self.clock() - (last.get("at") or 0) < 3 * 3600:
            return "the last health check FAILED"
        return None

    # ── inputs ────────────────────────────────────────────────────────
    def _track_maps(self) -> tuple[dict[str, dict], dict[str, dict]]:
        import outcomes

        rows = self.desk.discord.outcome_rows()
        authors = {r["id"]: {"calls": r["calls"], "adj": r["shrunkHitRate"], "avg": r["avgRet"]}
                   for r in outcomes.leaderboard(rows, horizon=5, by="author", min_calls=1)}
        chans = {r["id"]: {"calls": r["calls"], "adj": r["shrunkHitRate"], "avg": r["avgRet"]}
                 for r in outcomes.leaderboard(rows, horizon=5, by="channel", min_calls=1)}
        return authors, chans

    def _hypotheses(self, sym: str, authors: dict, chans: dict) -> list[dict[str, Any]]:
        from trading_rag import HYPOTHESIS_BANNER

        out = []
        now_ms = self.clock() * 1000
        for e in self.desk.rag.query("", ticker=sym, signal_class=EXTERNAL_SIGNAL_HYPOTHESIS, k=12, char_budget=12_000):
            src = e.tag("source") or "hypothesis"
            item = {"cite": f"{src}:{e.id}", "kind": src, "text": e.text.replace(HYPOTHESIS_BANNER, "").strip(),
                    "ageDays": max(0.0, (now_ms - e.at) / 86_400_000)}
            if src == "discord":
                item["track"] = authors.get(e.tag("author") or "")
                item["channelTrack"] = chans.get(e.tag("channel") or "")
            out.append(item)
        # Scored, strong sources first; then newest.
        out.sort(key=lambda h: (-((h.get("track") or {}).get("adj") or 0), h["ageDays"]))
        return out

    async def gather(self, kind: str, event_reason: str = "") -> dict[str, Any]:
        from agent_context import bar_metrics
        from engines.equities_commodities import trend_breakout

        d = self.desk
        snap = d.bridge.snapshot()
        acct = snap.get("account") or {}
        universe = []
        for sym in d.watchlist.symbols():
            try:
                bars = await d.md.daily_bars(sym)
                try:  # live bid/ask: the daily bar's last close is stale intraday, and the gate measures drift from the live mid
                    quote = await d.md.stock_quote(sym)
                except Exception:  # noqa: BLE001
                    quote = None
                universe.append({"symbol": sym, "metrics": bar_metrics(bars), "engineA": trend_breakout(bars), "quote": quote})
            except Exception as e:  # noqa: BLE001 — a symbol without data is shown as such
                universe.append({"symbol": sym, "metrics": None, "engineA": {"why": f"no data ({type(e).__name__})"}})
        authors, chans = self._track_maps()
        hyps = {u["symbol"]: self._hypotheses(u["symbol"], authors, chans) for u in universe}
        lessons = [j["postMortem"] for j in d.journal_list(6)]
        board = {r["id"]: r for r in d.calls.leaderboard(5)}
        me, base = board.get("trading_agent"), board.get("baseline_spy")
        record = (f"{me['calls']} scored proposals, 5-day adj hit {me['shrunkHitRate'] * 100:.0f}%, avg {me['avgRet']:+.2f}% "
                  f"(always-long SPY baseline: {base['shrunkHitRate'] * 100:.0f}%, {base['avgRet']:+.2f}%)" if me and base else None)
        return {
            "now_ny": datetime.fromtimestamp(self.clock(), NY).strftime("%Y-%m-%d %H:%M"), "run_kind": kind, "event_reason": event_reason,
            "mode": d.state()["mode"],
            "account": {"equity": acct.get("netLiquidation"), "currency": acct.get("currency"), "buyingPower": acct.get("buyingPower"),
                        "dailyPnl": (snap.get("pnl") or {}).get("daily")},
            "limits": d.limits().to_dict(), "positions": snap.get("positions") or [], "open_orders": snap.get("openOrders") or [],
            "orders_today": d.audit.count_since("order_submitted", d_midnight(self.clock())),
            "universe": universe, "hypotheses": hyps, "lessons": lessons, "record": record,
        }

    # ── one run ───────────────────────────────────────────────────────
    async def run(self, kind: str = "manual", *, submit: bool = True, event_reason: str = "", run_id: str | None = None) -> dict[str, Any]:
        from engines.equities_commodities import ASSET_CLASS

        async with self._lock:
            now = self.clock()
            run_id = run_id or (slot_key(now) if kind == "slot" else None) or f"{datetime.fromtimestamp(now, NY).strftime('%Y%m%d-%H%M%S')}-{kind}"
            rec: dict[str, Any] = {"runId": run_id, "kind": kind, "started": now, "submit": submit, "status": "running"}
            why = self.blocked(kind)
            if why:
                return self._finish(rec, "blocked", why)
            inp = await self.gather(kind, event_reason)
            system, user, meta = ac.build_prompts(inp)
            rec["context"] = meta
            res = await self.think(system, user)
            rec["modelS"], rec["waitedS"] = res.get("seconds"), res.get("waitedS")
            if not res.get("ok"):
                return self._finish(rec, "skipped" if res.get("skipped") else "no_json",
                                    f"{res.get('skipped') or 'model returned no JSON'}: {res.get('detail') or ''}".strip(": "),
                                    output={"raw": (res.get("raw") or "")[-2000:]})
            out = res["json"]
            raws, decisions, errors = validate_output(out, universe=[u["symbol"] for u in inp["universe"]],
                                                      asset_class=lambda s: ASSET_CLASS.get(s, "etf"), run_id=run_id, now=now)
            results = []
            for raw in raws:
                if submit:
                    r = await self.desk.submit(raw, "trading_agent")
                    dec = r.get("decision") or {}
                    results.append({"intentId": raw["intent_id"], "symbol": raw["symbol"], "status": r.get("status"),
                                    "verdict": dec.get("verdict"), "reasons": dec.get("reasons", []), "error": r.get("error")})
                    self.desk.calls.add(f"agent:{raw['intent_id']}", "trading_agent", raw["symbol"], "bullish", int(now * 1000),
                                        ref=raw["intent_id"], verdict=dec.get("verdict") or r.get("status") or "", baseline=True)
                else:
                    results.append(await self._dry_evaluate(raw))
            view = str(out.get("market_view") or "")[:1200]
            if view and submit:
                try:
                    self.desk.rag.put(f"Trading Agent market view ({inp['now_ny']} NY, {kind}): {view}",
                                      ["class:desk_note", "source:desk", "agent:market_view"], entry_id=f"agentview:{run_id}", now_ms=int(now * 1000))
                except Exception as e:  # noqa: BLE001
                    log.info("market view note: %s", e)
            output = {"marketView": view, "watchlistAdd": out.get("watchlist_add") if isinstance(out.get("watchlist_add"), list) else [],
                      "notes": str(out.get("notes") or "")[:800]}
            return self._finish(rec, "done" if submit else "dry_run", "; ".join(errors)[:1000], output=output, decisions=decisions, results=results)

    async def _dry_evaluate(self, raw: dict[str, Any]) -> dict[str, Any]:
        """Dry run: evaluate the intent in memory (like the health check) — nothing stored or sent."""
        from security_detail import evaluate

        intent = parse_intent({**raw, "intent_id": raw["intent_id"][:56] + "-dry"})
        dec = evaluate(intent, await self.desk.build_context(intent))
        return {"intentId": raw["intent_id"], "symbol": raw["symbol"], "status": "dry_run", "verdict": dec.verdict,
                "reasons": dec.reasons, "quantity": dec.quantity, "intent": raw}

    def _finish(self, rec: dict[str, Any], status: str, detail: str, **parts: Any) -> dict[str, Any]:
        rec.update(status=status, detail=detail, finished=self.clock(), **parts)
        with self._conn() as c:
            c.execute("INSERT OR REPLACE INTO agent_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                      (rec["runId"], rec["kind"], rec["started"], rec["finished"], status, detail,
                       json.dumps(rec.get("context")), json.dumps(rec.get("output")), json.dumps(rec.get("decisions")),
                       json.dumps(rec.get("results")), rec.get("modelS"), rec.get("waitedS")))
        self.desk.audit.append("agent_run", {k: rec.get(k) for k in ("kind", "status", "detail", "results", "modelS", "waitedS")},
                               ref=rec["runId"], verdict=status.upper(), actor="trading_agent")
        return rec

    # ── events ────────────────────────────────────────────────────────
    def check_events(self) -> str | None:
        """A strong new external signal on a universe symbol since the last check → a reason string."""
        now_ms = int(self.clock() * 1000)
        since, self._event_cursor_ms = self._event_cursor_ms, now_ms
        universe = set(self.desk.watchlist.symbols())
        authors, _ = self._track_maps()
        c = sqlite3.connect(self.desk.discord.path, timeout=10)
        try:
            rows = c.execute("SELECT m.author, m.author_id, s.primary_ticker, s.direction FROM messages m JOIN signals s ON s.msg_key = m.msg_key "
                             "WHERE m.is_call = 1 AND m.ts_ms > ? AND m.ts_ms <= ? ORDER BY m.ts_ms DESC", (since, now_ms)).fetchall()
        finally:
            c.close()
        for author, aid, sym, direction in rows:
            tr = authors.get(aid)
            if sym in universe and tr and tr["calls"] >= EVENT_MIN_CALLS and tr["adj"] >= EVENT_MIN_ADJ:
                return f"Discord {direction} call on {sym} by {author} (adj hit {tr['adj'] * 100:.0f}% over {tr['calls']})"
        for sym in sorted(universe):
            for e in self.desk.rag.query("", ticker=sym, signal_class=EXTERNAL_SIGNAL_HYPOTHESIS, k=5, touch=False):
                if e.tag("source") == "quantgress" and e.tag("side") == "buy" and since < e.at <= now_ms:
                    return f"Quantgress insider/Congress buy on {sym}"
        return None

    def _runs_today(self, kinds: tuple[str, ...]) -> list[tuple[str, float]]:
        start = d_midnight(self.clock())
        with self._conn() as c:
            return c.execute(f"SELECT kind, started FROM agent_runs WHERE started >= ? AND kind IN ({','.join('?' * len(kinds))}) "
                             "AND status IN ('done','dry_run','running')", (start, *kinds)).fetchall()

    def _slot_done(self, key: str) -> bool:
        with self._conn() as c:
            return c.execute("SELECT 1 FROM agent_runs WHERE run_id = ?", (key,)).fetchone() is not None

    async def loop(self) -> None:
        while True:
            self.desk.heartbeats["agent"] = self.clock()
            try:
                now = self.clock()
                key = slot_key(now)
                if key and not self._slot_done(key) and self.settings()["enabled"]:
                    await self.run("slot", run_id=key)
                elif in_session(now) and self.settings()["enabled"]:
                    reason = self.check_events()
                    recent = self._runs_today(("slot", "event", "manual"))
                    events = [t for k, t in recent if k == "event"]
                    gap_ok = all(now - t >= EVENT_MIN_GAP_S for _, t in recent)
                    if reason and len(events) < EVENT_MAX_PER_DAY and gap_ok:
                        await self.run("event", event_reason=reason)
            except Exception as e:  # noqa: BLE001
                log.warning("agent loop: %s", e)
            await asyncio.sleep(30)

    # ── view ──────────────────────────────────────────────────────────
    def runs(self, limit: int = 10) -> list[dict[str, Any]]:
        with self._conn() as c:
            rows = c.execute("SELECT run_id, kind, started, finished, status, detail, context, output, decisions, results, model_s, waited_s "
                             "FROM agent_runs ORDER BY started DESC LIMIT ?", (max(1, min(limit, 50)),)).fetchall()
        keys = ("runId", "kind", "started", "finished", "status", "detail", "context", "output", "decisions", "results", "modelS", "waitedS")
        out = []
        for r in rows:
            row = dict(zip(keys, r))
            for k in ("context", "output", "decisions", "results"):
                row[k] = json.loads(row[k]) if row[k] else None
            out.append(row)
        return out

    def next_slot(self) -> str | None:
        t = datetime.fromtimestamp(self.clock(), NY)
        for add in range(0, 8):
            day = t.date().fromordinal(t.date().toordinal() + add)
            if day.weekday() >= 5:
                continue
            for h, m in SLOTS:
                start = datetime(day.year, day.month, day.day, h, m, tzinfo=NY)
                if start.timestamp() + SLOT_GRACE_S > self.clock() and not self._slot_done(f"{day.strftime('%Y%m%d')}-{h:02d}{m:02d}"):
                    return start.strftime("%a %H:%M")
        return None

    def advisory_start(self) -> float | None:
        """When the ADVISORY week began: saved on first enable; for an agent switched on before that
        was recorded, the earliest 'agent_enabled ON' audit row (then saved)."""
        s = self.settings()
        if s.get("advisoryStart"):
            return float(s["advisoryStart"])
        ons = [r["ts"] for r in self.desk.audit.tail(500, kinds=("agent_enabled",)) if r["verdict"] == "ON"]
        if not ons:
            return None
        start = min(ons)
        self.desk._save_state(agent={**s, "advisoryStart": start})
        return start

    def config(self) -> dict[str, Any]:
        """The agent's active configuration for the UI status card (TradingAgentConfig in the contract)."""
        import healthcheck

        start = self.advisory_start()
        last = healthcheck.last_result(self.desk.d) or {}
        exp = next((c for c in last.get("checks", []) if c.get("name") == "tws_exposure"), None)
        localhost_only = None if not exp or exp["status"] == "SKIP" else exp["status"] == "PASS"
        return {
            "model": AGENT_MODEL,
            "schedule": "09:15 ET pre-market + hourly 10:00–15:00 ET + up to "
                        f"{EVENT_MAX_PER_DAY} event runs/day",
            "universe": self.desk.watchlist.symbols(),
            "deskMode": self.desk.state()["mode"],
            "advisoryStart": start, "advisoryEnd": start + ADVISORY_DAYS * 86400 if start else None,
            "isolation": {"peer": "finance", "broker": "127.0.0.1:7497", "localhostOnly": localhost_only},
        }

    def view(self) -> dict[str, Any]:
        s = self.settings()
        return {"retired": RETIRED, "enabled": s["enabled"], "blocked": self.blocked("slot"), "nextSlot": self.next_slot(),
                "eventsToday": len([1 for k, _ in self._runs_today(("event",)) if k == "event"]), "eventMax": EVENT_MAX_PER_DAY,
                "runs": self.runs(10), "leaderboard": self.desk.calls.leaderboard(5), "callCounts": self.desk.calls.counts(),
                "config": self.config()}


def d_midnight(now: float) -> float:
    return datetime.fromtimestamp(now, NY).replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
