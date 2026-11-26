"""Engine R — the deterministic, rule-based executor. CPU only; no model is ever called here.

  15:45 New York, weekdays ─► gate (paper endpoint, kill-switch lock, autonomous halt, enabled,
  connected, hard limits load) ─► daily bars (cached to disk) ─► signal_at() per universe symbol
  ─► hard limits (daily loss, trades/day, open positions, position size) ─► OrderIntent
  (source "rule_engine", bracket) ─► desk.submit ─► Security Detail + pre-trade gates + desk mode
  (ADVISORY logs only / SEMI_AUTO waits for Nic / FULL_AUTO sends to the IBKR PAPER bridge)

The rule (`trend_breakout`, a parameterised Engine A): close > SMA(fast) > SMA(slow), close at a new
N-session high, relative volume >= min, ATR% <= max. Entry = marketable LMT at the ask, stop =
entry - k x ATR, take-profit = entry + m x ATR (GTC children). Long only. Parameters come from the
ACTIVE approved version in desk.db (rules.RuleStore); only Nic's approval changes them.

Nothing external reaches this module: no news, no Quantgress, no Discord, no model output. Inputs
are IBKR daily bars, the live quote, the account snapshot and the approved rule parameters.

Every scan, every per-symbol decision and every submitted trade is written to the hash-chained
audit log with its reason (rule_scan / rule_signal / rule_trade / rule_limit_block).
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Callable
from zoneinfo import ZoneInfo

import kill_switch
import rules as rl
from engines.common import intent_id, ny_day

log = logging.getLogger("trading.rule_engine")
NY = ZoneInfo("America/New_York")
PAPER_PORT = 7497
LIVE_BARS_DAYS = 120          # sessions per live scan (raised to sma_slow + 40 when the rule needs more)
HISTORY_DAYS = 760            # ~3 years of sessions for the evaluation (fetched outside the scan, cached)
SCAN_GRACE_S = 10 * 60        # a scan missed by more than this (bridge down at 15:45) is skipped for the day
LOOP_S = 30
ENTRY_STATUSES_EXCLUDED = ("rejected", "failed", "expired", "dismissed")
ASSET_CLASS = {"GLD": "commodity_etf", "SLV": "commodity_etf", "USO": "commodity_etf", "UNG": "commodity_etf", "DBC": "commodity_etf"}


# ── the rule: one definition, used live and by the backtest ────────────────
def signal_at(bars: list[dict[str, Any]], i: int, p: dict[str, Any]) -> dict[str, Any]:
    """Signal on the completed bar `i` of clean daily bars (oldest first). Pure; reads bars[..i] only."""
    f, s, lb, n = p["sma_fast"], p["sma_slow"], p["breakout_lookback"], p["atr_period"]
    need = max(s, lb + 1, n + 1)
    if i + 1 < need:
        return {"signal": False, "why": f"only {i + 1} bars (need {need})"}
    close = bars[i]["close"]
    sma_f = sum(b["close"] for b in bars[i - f + 1:i + 1]) / f
    sma_s = sum(b["close"] for b in bars[i - s + 1:i + 1]) / s
    prior = bars[i - lb:i]
    prior_high = max(b["high"] for b in prior)
    avg_vol = sum(b["volume"] for b in prior) / lb
    rel_vol = bars[i]["volume"] / avg_vol if avg_vol > 0 else 0.0
    trs = [max(bars[k]["high"] - bars[k]["low"], abs(bars[k]["high"] - bars[k - 1]["close"]), abs(bars[k]["low"] - bars[k - 1]["close"]))
           for k in range(i - n + 1, i + 1)]
    atr = sum(trs) / n
    atr_pct = atr / close * 100
    momentum = (close / bars[i - lb]["close"] - 1) * 100
    conds = {"trend": close > sma_f > sma_s, "breakout": close >= prior_high * 0.999,
             "volume": rel_vol >= p["min_rel_volume"], "volatility": atr_pct <= p["max_atr_pct"]}
    ok = all(conds.values())
    return {"signal": ok, "conditions": conds, "close": close, "date": bars[i].get("date"), "smaFast": sma_f, "smaSlow": sma_s,
            "priorHigh": prior_high, "relVolume": rel_vol, "atr": atr, "atrPct": atr_pct, "momentum": momentum,
            "why": "trend breakout" if ok else "no setup: " + ", ".join(k for k, v in conds.items() if not v)}


def signal(bars: list[dict[str, Any]], p: dict[str, Any]) -> dict[str, Any]:
    from backtest import prepare

    b = prepare({"_": bars})["_"]
    return signal_at(b, len(b) - 1, p) if b else {"signal": False, "why": "no usable bars"}


# ── hard limits ────────────────────────────────────────────────────────────
def limit_block(lim: rl.HardLimits, *, daily_pnl_base: float | None, entries_today: int, open_count: int) -> str | None:
    """Why no NEW entry may be sent right now, or None. Unknown P&L fails closed."""
    if daily_pnl_base is None:
        return "daily P&L unknown (fails closed)"
    if daily_pnl_base <= -lim.max_daily_loss_base:
        return f"daily loss limit hit: P&L {daily_pnl_base:.2f} <= -{lim.max_daily_loss_base:.2f}"
    if entries_today >= lim.max_trades_per_day:
        return f"max trades per day reached ({entries_today}/{lim.max_trades_per_day})"
    if open_count >= lim.max_open_positions:
        return f"max open positions reached ({open_count}/{lim.max_open_positions})"
    return None


def size(lim: rl.HardLimits, *, risk_budget_base: float, entry: float, stop: float, fx: float) -> tuple[int, str]:
    """Shares for one entry: the risk budget, capped by max_position_shares and max_position_notional_base."""
    if entry <= 0 or stop <= 0 or entry <= stop or fx <= 0:
        return 0, "no valid entry / stop / FX"
    by_risk = math.floor(risk_budget_base / ((entry - stop) * fx))
    by_notional = math.floor(lim.max_position_notional_base / (entry * fx))
    qty = max(0, min(by_risk, lim.max_position_shares, by_notional))
    caps = {"risk": by_risk, "shares cap": lim.max_position_shares, "notional cap": by_notional}
    binding = min(caps, key=caps.get)  # type: ignore[arg-type]
    return qty, f"{qty} sh (bound by {binding}: risk {by_risk}, shares cap {lim.max_position_shares}, notional cap {by_notional})"


def open_symbols(snap: dict[str, Any]) -> set[str]:
    """Symbols held, plus symbols with a working DAY entry order (bracket children are GTC)."""
    held = {p.get("symbol") for p in snap.get("positions") or [] if p.get("position")}
    working = {o.get("symbol") for o in snap.get("openOrders") or []
               if o.get("action") == "BUY" and o.get("orderType") in ("LMT", "MKT") and o.get("tif") == "DAY"}
    return {s for s in held | working if s}


def ny_midnight(now: float) -> float:
    return datetime.fromtimestamp(now, NY).replace(hour=0, minute=0, second=0, microsecond=0).timestamp()


def scan_key(now: float, scan_time_et: str) -> str | None:
    """'20261124-1545' while today's scan is due (weekday, within the grace window)."""
    t = datetime.fromtimestamp(now, NY)
    if t.weekday() >= 5:
        return None
    h, m = (int(x) for x in scan_time_et.split(":"))
    start = t.replace(hour=h, minute=m, second=0, microsecond=0).timestamp()
    if start <= now < start + SCAN_GRACE_S:
        return f"{t.strftime('%Y%m%d')}-{h:02d}{m:02d}"
    return None


# ── bars, cached so the evaluation works with TWS closed ───────────────────
class BarStore:
    def __init__(self, d: Path, md: Any) -> None:
        self.d = Path(d)
        self.md = md

    def path(self, sym: str) -> Path:
        return self.d / f"{sym.upper()}.json"

    def cached(self, sym: str) -> list[dict[str, Any]]:
        try:
            data = json.loads(self.path(sym).read_text(encoding="utf-8"))
            return data.get("bars") or [] if isinstance(data, dict) else []
        except (OSError, ValueError):
            return []

    def _merge(self, sym: str, fresh: list[dict[str, Any]]) -> list[dict[str, Any]]:
        from backtest import norm_date

        rows = {norm_date(b.get("date")): b for b in self.cached(sym)}
        rows.update({norm_date(b.get("date")): {**b, "date": norm_date(b.get("date"))} for b in fresh if b.get("date")})
        merged = [rows[k] for k in sorted(rows)]
        self.d.mkdir(parents=True, exist_ok=True)
        tmp = self.path(sym).with_suffix(".tmp")
        tmp.write_text(json.dumps({"symbol": sym.upper(), "updated": time.time(), "bars": merged}), encoding="utf-8")
        tmp.replace(self.path(sym))
        return merged

    async def get(self, sym: str, days: int) -> tuple[list[dict[str, Any]], str]:
        """Fresh bars from IBKR (merged into the cache), else the cache. ('fresh' | 'cache' | 'none')."""
        try:
            fresh = await self.md.daily_bars(sym, days=days)
        except Exception as e:  # noqa: BLE001 — TWS closed / pacing: fall back to the cache
            log.info("daily bars %s: %s", sym, e)
            fresh = None
        if fresh:
            return self._merge(sym, fresh), "fresh"
        cached = self.cached(sym)
        return cached, "cache" if cached else "none"


# ── the engine ─────────────────────────────────────────────────────────────
class RuleEngine:
    def __init__(self, desk: Any, *, clock: Callable[[], float] | None = None, sleep: Callable[[float], Any] | None = None) -> None:
        self.desk = desk
        self.clock = clock or desk.clock
        self._sleep = sleep or asyncio.sleep
        self.store = rl.RuleStore(desk.d, desk.audit, clock=self.clock)
        self.bars = BarStore(desk.d / "bars_cache", desk.md)
        self.last_scan: dict[str, Any] | None = None
        self._lock = asyncio.Lock()
        self._loss_tripped_day = ""

    # settings
    def settings(self) -> dict[str, Any]:
        return {"enabled": True, **(self.desk.state().get("rules") or {})}

    def set_enabled(self, enabled: bool, actor: str) -> dict[str, Any]:
        s = {**self.settings(), "enabled": bool(enabled)}
        self.desk._save_state(rules=s)
        self.desk.audit.append("rule_engine_enabled", {"enabled": bool(enabled)}, ref="rule_engine", verdict="ON" if enabled else "OFF", actor=actor)
        return s

    # gate
    def blocked(self, kind: str) -> str | None:
        if kill_switch.is_locked(self.desk.d):
            return "trading is LOCKED by the kill switch"
        if self.desk.state().get("agentHalted"):
            return "autonomous trading is halted (kill switch / Financer halt / overseer)"
        if kind != "manual" and not self.settings()["enabled"]:
            return "Engine R is switched off"
        snap = self.desk.bridge.snapshot()
        if snap.get("mode") != "PAPER" or snap.get("port") != PAPER_PORT:
            return f"not the IBKR PAPER endpoint (mode {snap.get('mode')}, port {snap.get('port')}): Engine R only trades paper"
        if snap.get("state") != "CONNECTED":
            return "bridge not connected to TWS"
        try:
            self.store.limits()
        except rl.RuleError as e:
            return f"hard limits invalid ({e}): fix data/trading/rules/limits.json"
        return None

    def entries_today(self) -> int:
        with self.desk._conn() as c:
            return int(c.execute(f"SELECT COUNT(*) FROM intents WHERE intent_id LIKE 're-%' AND created >= ? "
                                 f"AND status NOT IN ({','.join('?' * len(ENTRY_STATUSES_EXCLUDED))})",
                                 (ny_midnight(self.clock()), *ENTRY_STATUSES_EXCLUDED)).fetchone()[0])

    def _cooldown_s(self) -> float:
        import risk_policy

        try:
            pol = risk_policy.load_policy(risk_policy.policy_path(self.desk.d))["pretrade"]
        except risk_policy.PolicyError:
            pol = risk_policy.DEFAULTS["pretrade"]
        # Space orders by the global cooldown and keep under the per-minute rate limit.
        return max(float(pol["global_cooldown_s"]), 60.0 / max(int(pol["max_orders_per_minute"]), 1)) + 1.0

    async def _fx_usd(self) -> tuple[float, float]:
        """(equity used for sizing in base currency, USD -> base rate)."""
        eq_used, usd, _budget = await self.desk._sizing()
        return eq_used, usd

    # one scan
    async def scan(self, kind: str = "slot", *, submit: bool = True, scan_id: str | None = None) -> dict[str, Any]:
        async with self._lock:
            now = self.clock()
            scan_id = scan_id or f"{datetime.fromtimestamp(now, NY).strftime('%Y%m%d-%H%M%S')}-{kind}"
            act = self.store.active()
            rep: dict[str, Any] = {"scanId": scan_id, "kind": kind, "at": now, "version": act["version"], "submit": submit, "rows": []}
            why = self.blocked(kind)
            if why:
                if kind == "slot":
                    rep["scanId"] = f"{scan_id}:blocked"  # the day's slot stays open: retried while the grace window lasts
                return self._finish(rep, "blocked", why)
            lim = self.store.limits()
            p = act["params"]
            snap = self.desk.bridge.snapshot()
            pnl = (snap.get("pnl") or {}).get("daily")
            await self.enforce_daily_loss(snap, lim)
            why = self.blocked(kind)  # the daily-loss limit may just have tripped the kill switch
            if why:
                return self._finish(rep, "blocked", why)
            eq_used, usd = await self._fx_usd()
            if not usd:
                return self._finish(rep, "blocked", "no USD->base FX rate, can't size")
            risk_budget = min(p["risk_per_trade_pct"] / 100 * eq_used, self.desk.limits().max_risk_per_trade_base)
            held = open_symbols(snap)
            entries = self.entries_today()
            sent = 0
            disabled = set(p["disabled_symbols"])
            days = max(LIVE_BARS_DAYS, p["sma_slow"] + 40)
            for sym in lim.universe:
                row: dict[str, Any] = {"symbol": sym}
                rep["rows"].append(row)
                if sym in disabled:
                    row.update(action="skip", why="disabled by the active rule version")
                    continue
                if sym in held:
                    row.update(action="skip", why="already held / entry working")
                    continue
                bars, src = await self.bars.get(sym, days)
                row["bars"] = src
                if src != "fresh":
                    row.update(action="skip", why=f"no fresh IBKR daily bars ({src})")
                    continue
                sig = signal(bars, p)
                row.update({k: (round(sig[k], 4) if isinstance(sig.get(k), float) else sig.get(k))
                            for k in ("signal", "why", "close", "relVolume", "atrPct", "momentum", "date")})
                if not sig["signal"]:
                    row["action"] = "no_signal"
                    continue
                block = limit_block(lim, daily_pnl_base=pnl, entries_today=entries, open_count=len(held))
                if block:
                    row.update(action="limit_block", why=block)
                    self.desk.audit.append("rule_limit_block", {"symbol": sym, "why": block, "version": act["version"]}, ref=scan_id,
                                           verdict="BLOCKED", actor="rule_engine")
                    continue
                if submit and sent and self.desk.state()["mode"] == "FULL_AUTO":
                    # The pre-trade gate's global cooldown / rate limit would refuse a back-to-back order: wait first,
                    # then quote, so the entry is priced off a fresh quote.
                    await self._sleep(self._cooldown_s())
                try:
                    quote = await self.desk.md.stock_quote(sym)
                except Exception as e:  # noqa: BLE001
                    quote = None
                    row["quoteError"] = f"{type(e).__name__}"
                raw, sizing = self.build_intent(sym, sig, quote, p, lim, act["version"], now=now, risk_budget=risk_budget, fx=usd)
                row["sizing"] = sizing
                if raw is None:
                    row.update(action="skip", why=sizing)
                    continue
                row["intent"] = raw
                if not submit:
                    row["action"] = "would_submit"
                    continue
                sent += 1
                res = await self.desk.submit(raw, "rule_engine")
                dec = res.get("decision") or {}
                row.update(action="submitted", desk={"status": res.get("status"), "verdict": dec.get("verdict"),
                                                     "reasons": dec.get("reasons", []), "error": res.get("error")})
                self.desk.audit.append("rule_trade", {"symbol": sym, "version": act["version"], "reason": raw["thesis"], "quantity": raw["quantity"],
                                                      "limit": raw["limit_price"], "stop": raw["stop_loss"], "target": raw["take_profit"],
                                                      "sizing": sizing, "desk": row["desk"]},
                                       ref=raw["intent_id"], verdict=str(res.get("status") or "").upper(), actor="rule_engine")
                if res.get("status") not in ENTRY_STATUSES_EXCLUDED:
                    entries += 1
                    held.add(sym)
            for row in rep["rows"]:
                self.desk.audit.append("rule_signal", {k: row.get(k) for k in ("symbol", "action", "why", "close", "relVolume", "atrPct", "date")},
                                       ref=scan_id, verdict=str(row.get("action", "")).upper(), actor="rule_engine")
            return self._finish(rep, "done" if submit else "dry_run", "")

    def build_intent(self, sym: str, sig: dict[str, Any], quote: dict[str, Any] | None, p: dict[str, Any], lim: rl.HardLimits,
                     version: int, *, now: float, risk_budget: float, fx: float) -> tuple[dict[str, Any] | None, str]:
        bid, ask = (quote or {}).get("bid"), (quote or {}).get("ask")
        if not (ask and bid and ask >= bid > 0):
            return None, "no two-sided live quote"
        entry = round(ask, 2)
        stop = round(entry - p["stop_atr_mult"] * sig["atr"], 2)
        target = round(entry + p["target_atr_mult"] * sig["atr"], 2)
        qty, sizing = size(lim, risk_budget_base=risk_budget, entry=entry, stop=stop, fx=fx)
        if qty < 1:
            return None, f"size rounds to 0 ({sizing})"
        reason = (f"Engine R v{version} {rl.RULE_ID}: close {sig['close']:.2f} > SMA{p['sma_fast']} {sig['smaFast']:.2f} > SMA{p['sma_slow']} "
                  f"{sig['smaSlow']:.2f}; new {p['breakout_lookback']}-session high (prior {sig['priorHigh']:.2f}); rel. volume "
                  f"{sig['relVolume']:.2f}x >= {p['min_rel_volume']}; ATR {sig['atrPct']:.2f}% <= {p['max_atr_pct']}%. "
                  f"Stop {p['stop_atr_mult']}xATR, target {p['target_atr_mult']}xATR. {sizing}.")
        return {
            "intent_id": intent_id("re", sym, ny_day(now), rl.RULE_ID, version, sig.get("date")),
            "source": "rule_engine", "asset_class": ASSET_CLASS.get(sym, "etf"), "symbol": sym, "sec_type": "STK", "currency": "USD",
            "action": "BUY", "quantity": qty, "order_type": "LMT", "limit_price": entry, "stop_loss": stop, "take_profit": target,
            "time_in_force": "DAY", "thesis": reason,
            "citations": [f"telemetry:{sym}:daily_bars:{sig.get('date')}", f"telemetry:{sym}:quote:{int(now)}", f"rule:{rl.RULE_ID}:v{version}"],
            "created_at": now,
        }, sizing

    def _finish(self, rep: dict[str, Any], status: str, detail: str) -> dict[str, Any]:
        rep.update(status=status, detail=detail, finished=self.clock())
        self.last_scan = rep
        self.desk.audit.append("rule_scan", {k: rep.get(k) for k in ("kind", "version", "status", "detail", "submit")} |
                               {"taken": [r["symbol"] for r in rep["rows"] if r.get("action") in ("submitted", "would_submit")]},
                               ref=rep["scanId"], verdict=status.upper(), actor="rule_engine")
        return rep

    # the absolute daily-loss limit
    async def enforce_daily_loss(self, snap: dict[str, Any] | None = None, lim: rl.HardLimits | None = None) -> str | None:
        """With on_daily_loss = kill_switch, a breach trips the E-stop once per day. Returns the breach text."""
        snap = snap or self.desk.bridge.snapshot()
        try:
            lim = lim or self.store.limits()
        except rl.RuleError:
            return None
        pnl = (snap.get("pnl") or {}).get("daily")
        if snap.get("state") != "CONNECTED" or pnl is None or pnl > -lim.max_daily_loss_base:
            return None
        why = f"Engine R daily loss limit: P&L {pnl:.2f} <= -{lim.max_daily_loss_base:.2f}"
        day = datetime.fromtimestamp(self.clock(), NY).strftime("%Y%m%d")
        if lim.on_daily_loss == "kill_switch" and self._loss_tripped_day != day and not kill_switch.is_locked(self.desk.d):
            self._loss_tripped_day = day
            log.error("%s: tripping the kill switch", why)
            await self.desk.kill(why, "rule_engine", dry_run=False)
        return why

    # loop
    def _scan_done(self, key: str) -> bool:
        return self.desk.audit.seen_ref("rule_scan", key)

    async def loop(self) -> None:
        last_block: tuple[str, str] | None = None
        while True:
            self.desk.heartbeats["rule_engine"] = self.clock()
            try:
                lim = self.store.limits()
                key = scan_key(self.clock(), lim.scan_time_et)
                if key and not self._scan_done(key) and self.settings()["enabled"]:
                    why = self.blocked("slot")
                    if why is None:
                        await self.scan("slot", scan_id=key)
                    elif last_block != (key, why):  # one audit row per reason, not one every 30 s
                        last_block = (key, why)
                        self._finish({"scanId": f"{key}:blocked", "kind": "slot", "at": self.clock(), "version": None, "submit": True, "rows": []},
                                     "blocked", why)
                if self.settings()["enabled"]:
                    await self.enforce_daily_loss()
            except Exception as e:  # noqa: BLE001
                log.warning("rule engine loop: %s", e)
            await asyncio.sleep(LOOP_S)

    # evaluation (70/30) on cached history
    async def history(self, refresh: bool) -> dict[str, list[dict[str, Any]]]:
        out = {}
        for sym in self.store.limits().universe:
            if refresh:
                bars, _src = await self.bars.get(sym, HISTORY_DAYS)
            else:
                bars = self.bars.cached(sym)
            if bars:
                out[sym] = bars
        return out

    def eval_path(self) -> Path:
        return self.desk.d / "rules" / "evaluation.json"

    async def evaluate(self, *, refresh: bool = False, actor: str = "rule_engine") -> dict[str, Any]:
        """The 70/30 report for the active version (backtest on cached bars + the paper journal)."""
        import backtest as bt

        act, lim = self.store.active(), self.store.limits()
        hist = await self.history(refresh)
        ev = await asyncio.to_thread(bt.evaluate, hist, act["params"], max_open=lim.max_open_positions, max_per_day=lim.max_trades_per_day)
        rep = {"at": self.clock(), "version": act["version"], "rule": rl.RULE_ID, "params": act["params"],
               "backtest": {k: v for k, v in ev.items() if k not in ("buildTrades", "testTrades")},
               "paper": bt.paper_report(self.desk.journal_list(200), act["params"]["risk_per_trade_pct"]),
               "method": "chronological split by entry date: build = oldest ~70% (simulated with bars before the cutoff only), "
                         "test = newest ~30% (never used to build or tune)"}
        self.eval_path().parent.mkdir(parents=True, exist_ok=True)
        tmp = self.eval_path().with_suffix(".tmp")
        tmp.write_text(json.dumps(rep, indent=2, default=str), encoding="utf-8")
        tmp.replace(self.eval_path())
        self.desk.audit.append("rule_evaluation", {"version": act["version"], "cutoff": ev["cutoff"],
                                                   "build": ev["build"], "test": ev["test"], "paper": rep["paper"]},
                               ref=f"v{act['version']}", verdict="OK", actor=actor)
        return rep

    def last_evaluation(self) -> dict[str, Any] | None:
        try:
            return json.loads(self.eval_path().read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    async def propose(self, params: Any, *, source: str, actor: str, rationale: str) -> dict[str, Any]:
        """Validate, score against the active version on the same cutoff, store as PENDING. Never applied here."""
        import backtest as bt

        act, lim = self.store.active(), self.store.limits()
        if not isinstance(params, dict):
            raise rl.RuleError("params must be an object")
        proposed = rl.validate_params({**act["params"], **params}, lim.universe)
        hist = await self.history(False)
        ev = await asyncio.to_thread(bt.compare, hist, act["params"], proposed, max_open=lim.max_open_positions,
                                     max_per_day=lim.max_trades_per_day) if hist else {"error": "no cached daily bars yet: run an evaluation with TWS up"}
        return self.store.propose(proposed, source=source, actor=actor, rationale=rationale, evaluation=ev)

    # views
    def view(self) -> dict[str, Any]:
        try:
            lim, lim_err = self.store.limits().to_dict(), None
        except rl.RuleError as e:
            lim, lim_err = None, str(e)
        return {"enabled": self.settings()["enabled"], "blocked": self.blocked("slot"), "active": self.store.active(),
                "limits": lim, "limitsError": lim_err, "entriesToday": self.entries_today(),
                "schema": {k: {"type": v[0], "min": v[1], "max": v[2], "default": v[3], "help": v[4]} for k, v in rl.PARAM_SCHEMA.items()},
                "pending": self.store.changes("pending", 20), "recentChanges": self.store.changes(None, 10),
                "versions": self.store.versions(5), "lastScan": self.last_scan, "evaluation": self.last_evaluation()}

    def log(self, limit: int = 100) -> list[dict[str, Any]]:
        kinds = ("rule_trade", "rule_limit_block", "rule_scan", "rule_change_proposed", "rule_change_approved", "rule_change_rejected",
                 "ruleset_activated", "rule_limits_changed", "rule_engine_enabled", "rule_evaluation", "analyst_run", "llm_trade_refused",
                 "trade_closed", "order_submitted", "kill_switch")
        return self.desk.audit.tail(limit, kinds=kinds)
