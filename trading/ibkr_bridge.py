"""IBKR TWS bridge — paper-only, read-only telemetry (Phase 1).

Run:   trading/.venv/Scripts/python trading/ibkr_bridge.py            # service on 127.0.0.1:8091
       trading/.venv/Scripts/python trading/ibkr_bridge.py --check    # connect once, print, exit

What it does:
  * Resolves the socket ONLY through `config.resolve_endpoint()` (7497/PAPER or LOCKED).
  * Connects with the bridge's own client id, `readonly=True` — this process
    cannot place orders. Execution comes in Phase 2/3 behind the Security Detail.
  * After connecting, verifies every managed account is a paper account (DU/DF).
    A non-paper account on the paper port disconnects and locks.
  * Reconnects with capped exponential backoff (TWS restarts daily; sockets drop).
  * Serves the latest snapshot over loopback HTTP for the gateway to proxy.

State machine: DISCONNECTED → CONNECTING → CONNECTED ⇄ RECONNECTING, or LOCKED
(re-evaluated every few seconds, so fixing .env clears it without a restart).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
import time
from pathlib import Path
from typing import Any, Callable

sys.path.insert(0, str(Path(__file__).resolve().parent))

try:  # module-level so FastAPI can resolve `req: Request` (annotations are strings here)
    from fastapi import HTTPException, Request
except ImportError:  # tests / --check without fastapi
    HTTPException = Request = Any  # type: ignore[misc,assignment]

from config import Endpoint, TradingConfig, is_paper_account, load_config, resolve_endpoint  # noqa: E402
from telemetry import account_block, fills_block, fx_block, orders_block, pnl_block, positions_block  # noqa: E402

log = logging.getLogger("ibkr_bridge")

REFRESH_S = 2.0
ORDERS_REFRESH_S = 5.0
LOCK_RECHECK_S = 5.0
BACKOFF_MIN_S = 2.0
BACKOFF_MAX_S = 60.0
CONNECT_TIMEOUT_S = 10.0


class Bridge:
    def __init__(
        self,
        config_loader: Callable[[], TradingConfig] = load_config,
        ib_factory: Callable[[], Any] | None = None,
        sleep: Callable[[float], Any] = asyncio.sleep,
    ) -> None:
        self._load = config_loader
        self._ib_factory = ib_factory
        self._sleep = sleep
        self.ib: Any = None
        self._pnl: Any = None
        # Authoritative open-order list from the last reqAllOpenOrders: client 11 never hears about
        # cancels made by other clients (executor 13, kill 19), so its openTrades() keeps dead orders.
        self._open_trades: list[Any] | None = None
        self._stop = asyncio.Event()
        self.attempts = 0
        self.state: dict[str, Any] = {
            "state": "DISCONNECTED",
            "mode": "PAPER",
            "host": None,
            "port": None,
            "clientId": None,
            "readOnly": True,
            "reasons": [],
            "lastError": None,
            "connectedSince": None,
            "updatedAt": time.time(),
            "account": None,
            "fx": {},
            "pnl": pnl_block(None),
            "positions": [],
            "openOrders": [],
            "fills": [],
        }

    # ── state helpers ────────────────────────────────────────────────
    def _set(self, **kw: Any) -> None:
        self.state.update(kw, updatedAt=time.time())

    def snapshot(self) -> dict[str, Any]:
        return json.loads(json.dumps(self.state))  # deep copy, JSON-safe

    def stop(self) -> None:
        self._stop.set()

    def _new_ib(self) -> Any:
        if self._ib_factory:
            return self._ib_factory()
        from ib_async import IB  # imported lazily so tests never need it

        return IB()

    # ── main loop ────────────────────────────────────────────────────
    async def run(self) -> None:
        backoff = BACKOFF_MIN_S
        while not self._stop.is_set():
            cfg = self._load()
            ep = resolve_endpoint(cfg)
            if ep.locked:
                self._lock(ep, list(ep.reasons))
                await self._sleep(LOCK_RECHECK_S)
                continue
            try:
                ok = await self._session(cfg, ep)
                if ok:
                    backoff = BACKOFF_MIN_S  # a healthy session resets the backoff
            except Exception as e:  # noqa: BLE001 — every failure means "retry later"
                self._set(lastError=f"{type(e).__name__}: {e}")
                log.warning("session failed: %s", e)
            finally:
                self._disconnect()
            if self._stop.is_set():
                break
            if self.state["state"] != "LOCKED":
                self._set(state="RECONNECTING", connectedSince=None)
                await self._sleep(backoff)
                backoff = min(backoff * 2, BACKOFF_MAX_S)
            else:
                await self._sleep(LOCK_RECHECK_S)
        self._set(state="DISCONNECTED", connectedSince=None)

    def _lock(self, ep: Endpoint, reasons: list[str]) -> None:
        self._set(state="LOCKED", mode=ep.mode, host=ep.host, port=ep.port, reasons=reasons, connectedSince=None)

    async def _session(self, cfg: TradingConfig, ep: Endpoint) -> bool:
        """One connected session. Returns True if it reached CONNECTED."""
        self.attempts += 1
        client_id = cfg.client_ids["bridge"]
        self._set(
            state="CONNECTING" if self.state["state"] in ("DISCONNECTED", "LOCKED") else "RECONNECTING",
            mode=ep.mode, host=ep.host, port=ep.port, clientId=client_id, reasons=[],
        )
        self.ib = self._new_ib()
        await self.ib.connectAsync(ep.host, ep.port, clientId=client_id, readonly=True, timeout=CONNECT_TIMEOUT_S)

        accounts = list(self.ib.managedAccounts())
        live = [a for a in accounts if not is_paper_account(a)]
        if not accounts or live:
            self._lock(ep, [f"non-paper account(s) on paper port {ep.port}: {live or 'none reported'}"])
            return False

        account = accounts[0]
        self.ib.reqMarketDataType(cfg.market_data_type)
        self._pnl = self.ib.reqPnL(account)
        await self._refresh_orders()
        self._set(state="CONNECTED", connectedSince=time.time(), lastError=None, reasons=[], accounts=accounts)
        log.info("connected to %s:%s as client %s (%s)", ep.host, ep.port, client_id, account)

        last_orders = time.monotonic()
        while self.ib.isConnected() and not self._stop.is_set():
            # Re-check the gate every tick: an .env change to LIVE or another port drops the session.
            ep2 = resolve_endpoint(self._load())
            if ep2.locked or ep2.port != ep.port:
                self._lock(ep2, list(ep2.reasons) or ["endpoint changed while connected"])
                return True
            if time.monotonic() - last_orders >= ORDERS_REFRESH_S:
                await self._refresh_orders()
                last_orders = time.monotonic()
            self._collect(account)
            await self._sleep(REFRESH_S)
        return True

    async def _refresh_orders(self) -> None:
        try:
            trades = await asyncio.wait_for(self.ib.reqAllOpenOrdersAsync(), 5)
            self._open_trades = list(trades or [])
        except Exception as e:  # noqa: BLE001 — orders are best-effort telemetry
            log.debug("open orders refresh failed: %s", e)

    def _collect(self, account: str) -> None:
        ib = self.ib
        values = ib.accountValues(account)
        self._set(
            account=account_block(values, account),
            fx=fx_block(values, account),
            pnl=pnl_block(self._pnl),
            positions=positions_block(ib.portfolio(account)),
            openOrders=orders_block(self._open_trades if self._open_trades is not None else ib.openTrades()),
            fills=fills_block(ib.fills()),
        )

    def _disconnect(self) -> None:
        if self.ib is not None:
            try:
                self.ib.disconnect()
            except Exception:  # noqa: BLE001
                pass
        self.ib = None
        self._pnl = None
        self._open_trades = None


# ── HTTP surface (loopback only; the gateway proxies /api/trading/*) ──────
def create_app(bridge: Bridge, desk: Any = None):
    from contextlib import asynccontextmanager

    from fastapi import FastAPI

    if desk is None:
        from desk import Desk

        desk = Desk(bridge)

    @asynccontextmanager
    async def lifespan(_app):
        tasks = [asyncio.create_task(bridge.run()), asyncio.create_task(desk.monitor()),
                 asyncio.create_task(desk.options_guard_loop()), asyncio.create_task(desk.auto_scan_loop()),
                 asyncio.create_task(desk.intel_loop())]
        import healthcheck

        tasks.append(asyncio.create_task(healthcheck.morning_loop(desk)))
        from agent import TradingAgent
        from analyst import Analyst
        from rule_engine import RuleEngine

        if desk.agent is None:
            desk.agent = TradingAgent(desk)  # retired as a trader: kept for its run history; its loop is NOT started
        if desk.rules is None:
            desk.rules = RuleEngine(desk)
        if desk.analyst is None:
            desk.analyst = Analyst(desk, desk.rules)
        tasks.append(asyncio.create_task(desk.rules.loop()))     # Engine R: deterministic, CPU, the 15:45 ET scan
        tasks.append(asyncio.create_task(desk.analyst.loop()))   # the LLM: after the close only, pending suggestions only
        import discord_live

        tasks.append(asyncio.create_task(discord_live.poll_forever(desk.discord, desk.rag, desk.watchlist.symbols, desk.discord_status)))
        import quantgress

        if quantgress.api_key():
            tasks.append(asyncio.create_task(quantgress.poll_forever(desk.rag)))
        try:
            yield
        finally:
            bridge.stop()
            desk.executor.disconnect()
            desk.md.disconnect()
            for t in tasks:
                t.cancel()

    app = FastAPI(title="IBKR bridge", lifespan=lifespan, docs_url=None, redoc_url=None)

    async def body(req: Request) -> dict:
        try:
            data = await req.json()
        except ValueError:
            raise HTTPException(400, "body must be JSON") from None
        if not isinstance(data, dict):
            raise HTTPException(400, "body must be a JSON object")
        return data

    def actor(req: Request) -> str:
        return (req.headers.get("x-trading-actor") or "unknown")[:40]

    # ── Trading Agent (Phase 5) ──────────────────────────────────────
    @app.get("/agent")
    def agent_view():
        return desk.agent.view() if desk.agent else {"enabled": False, "blocked": "agent not started", "runs": []}

    @app.post("/agent/run")
    async def agent_run(req: Request):
        """Retired: the LLM no longer proposes trades. Engine R executes; the analyst runs after the close."""
        raise HTTPException(410, "the Trading Agent is retired as a trader: Engine R executes rules "
                                 "(POST /engines/r/scan); the LLM analyst runs after the close (POST /engines/r/analyst)")

    @app.post("/agent/enable")
    async def agent_enable(req: Request):
        raise HTTPException(410, "the Trading Agent is retired as a trader: use POST /engines/r/enable or /engines/r/analyst-enable")

    # ── Engine R (deterministic rules) + the after-hours analyst ─────
    def rules_engine():
        if desk.rules is None:
            raise HTTPException(503, "Engine R not started")
        return desk.rules

    def rule_call(fn, *a, **kw):
        import rules as rl

        try:
            return fn(*a, **kw)
        except PermissionError as e:
            raise HTTPException(403, str(e)) from None
        except rl.RuleError as e:
            raise HTTPException(409, str(e)) from None

    @app.get("/rules")
    def rules_view():
        return {**rules_engine().view(), "analyst": desk.analyst.view() if desk.analyst else None}

    @app.get("/rules/evaluation")
    def rules_evaluation():
        return rules_engine().last_evaluation() or {"at": None, "note": "no evaluation yet: POST /engines/r/evaluate"}

    @app.get("/rules/log")
    def rules_log(limit: int = 100):
        return {"rows": rules_engine().log(max(1, min(limit, 500)))}

    @app.get("/rules/changes")
    def rules_changes(status: str = "", limit: int = 30):
        return {"changes": rules_engine().store.changes(status or None, limit)}

    @app.post("/engines/r/scan")
    async def rules_scan(req: Request):
        """Scan now (respects every gate and hard limit). submit=false: dry run, nothing sent to the desk."""
        b = await body(req)
        return await rules_engine().scan("manual", submit=b.get("submit", True) is not False)

    @app.post("/engines/r/enable")
    async def rules_enable(req: Request):
        b = await body(req)
        return rules_engine().set_enabled(bool(b.get("enabled")), actor(req))

    @app.post("/engines/r/evaluate")
    async def rules_evaluate(req: Request):
        b = await body(req)
        return await rules_engine().evaluate(refresh=b.get("refresh", True) is not False, actor=actor(req))

    @app.post("/engines/r/propose")
    async def rules_propose(req: Request):
        """Nic's own proposal: scored on the same 70/30 cutoff and stored PENDING like an analyst suggestion."""
        import rules as rl

        b = await body(req)
        try:
            return await rules_engine().propose(b.get("params"), source="manual", actor=actor(req), rationale=str(b.get("reason") or ""))
        except rl.RuleError as e:
            raise HTTPException(409, str(e)) from None

    @app.post("/engines/r/changes/{change_id}/{verb}")
    async def rules_decide(change_id: str, verb: str, req: Request):
        b = await body(req)
        store = rules_engine().store
        if verb == "approve":
            return rule_call(store.approve, change_id, confirm=str(b.get("confirm", "")), actor=actor(req), note=str(b.get("note") or ""))
        if verb == "reject":
            return rule_call(store.reject, change_id, actor=actor(req), note=str(b.get("note") or ""))
        raise HTTPException(404, "unknown action")

    @app.post("/engines/r/limits")
    async def rules_limits(req: Request):
        b = await body(req)
        lim = rule_call(rules_engine().store.set_limits, b.get("limits"), str(b.get("confirm", "")), str(b.get("reason") or ""), actor(req))
        return {"ok": True, "limits": lim.to_dict()}

    @app.post("/engines/r/analyst")
    async def rules_analyst(req: Request):
        """Run the analyst now. Refused inside trading hours (weekdays 08:45-16:30 New York)."""
        b = await body(req)
        if desk.analyst is None:
            raise HTTPException(503, "analyst not started")
        return await desk.analyst.run("manual", force_suggest=bool(b.get("suggest", True)))

    @app.post("/engines/r/analyst-enable")
    async def rules_analyst_enable(req: Request):
        b = await body(req)
        if desk.analyst is None:
            raise HTTPException(503, "analyst not started")
        return desk.analyst.set_enabled(bool(b.get("enabled")), actor(req))

    @app.post("/health/check")
    async def health_check(req: Request):
        import healthcheck

        b = await body(req)
        return await healthcheck.run_checks(desk, dry_run_kill=b.get("dryRunKill", True) is not False)

    @app.get("/health/last")
    def health_last():
        import healthcheck

        return healthcheck.last_result(desk.d) or {"overall": None, "checks": []}

    @app.get("/health")
    def health():
        return {"ok": True, "state": bridge.state["state"]}

    @app.get("/status")
    def status():
        return bridge.snapshot()

    @app.get("/desk")
    def desk_view():
        return desk.view()

    @app.post("/intents")
    async def submit(req: Request):
        return await desk.submit(await body(req), actor(req))

    @app.post("/intents/{intent_id}/approve")
    async def approve(intent_id: str, req: Request):
        return await desk.approve(intent_id, actor(req))

    @app.post("/intents/{intent_id}/reject")
    def reject(intent_id: str, req: Request):
        return desk.reject(intent_id, actor(req))

    @app.post("/mode")
    async def mode(req: Request):
        b = await body(req)
        try:
            return {"ok": True, "state": desk.set_mode(str(b.get("mode", "")), actor(req), bool(b.get("confirm")))}
        except (ValueError, PermissionError) as e:
            raise HTTPException(409, str(e)) from None

    @app.post("/kill-switch")
    async def kill(req: Request):
        b = await body(req)
        return await desk.kill(str(b.get("reason") or "manual kill switch")[:200], actor(req), dry_run=bool(b.get("dryRun")))

    @app.post("/kill-switch/reset")
    async def reset(req: Request):
        b = await body(req)
        try:
            return desk.reset(str(b.get("confirm", "")), actor(req))
        except PermissionError as e:
            raise HTTPException(409, str(e)) from None

    @app.post("/orders/cancel")
    async def orders_cancel(req: Request):
        """desk-cli / overseer: cancel working orders owned by this bridge's executor (client 13), which TWS
        lets no other client id cancel. Risk-reducing only (never places anything); audited."""
        b = await body(req)
        ids = b.get("orderIds")
        reason = str(b.get("reason") or "").strip()[:200]
        if not isinstance(ids, list) or not ids or len(ids) > 50 or not all(isinstance(i, int) and not isinstance(i, bool) and i > 0 for i in ids):
            raise HTTPException(400, "orderIds: a list of 1-50 positive integer order ids")
        if not reason:
            raise HTTPException(400, "reason is required")
        try:
            results = await desk.executor.cancel_ids(ids)
        except Exception as e:  # noqa: BLE001
            desk.audit.append("orders_cancel", {"orderIds": ids, "reason": reason, "error": str(e)}, ref="cancel", verdict="FAILED", actor=actor(req))
            raise HTTPException(503, f"{type(e).__name__}: {e}") from None
        desk.audit.append("orders_cancel", {"orderIds": ids, "reason": reason, "results": results}, ref="cancel", verdict="OK", actor=actor(req))
        return {"ok": True, "results": results}

    @app.post("/comms")
    async def comms_in(req: Request):
        return desk.handle_comms(await body(req), actor(req))

    @app.get("/signals")
    def signals(q: str = "", ticker: str | None = None, k: int = 8):
        return desk.signals(q[:200], ticker.upper()[:10] if ticker else None, k)

    @app.post("/signals/ingest")
    async def signals_ingest(req: Request):
        import quantgress

        try:
            rep = await asyncio.to_thread(quantgress.ingest, desk.rag, d=desk.d)
        except quantgress.QuantgressError as e:
            raise HTTPException(409, str(e)) from None
        desk.audit.append("signals_ingest", {"source": "quantgress", "new": rep["new"], "feeds": rep["feeds"]}, ref="quantgress",
                          verdict="OK" if rep["ok"] else "FAILED", actor=actor(req))
        return rep


    # ── chart bars (Command Center "IBKR bars" tab) ──────────────────
    @app.get("/bars")
    async def chart_bars(symbol: str = "SPY", interval: str = "5m", range: str = "5d"):  # noqa: A002
        from bars import BarsRefused

        try:
            return await desk.md.chart_bars(symbol, interval, range)
        except BarsRefused as e:
            raise HTTPException(400, str(e)) from None
        except (ConnectionError, LookupError, asyncio.TimeoutError) as e:
            raise HTTPException(503, f"{type(e).__name__}: {e}") from None

    # ── engines (Phase 3) ────────────────────────────────────────────
    @app.get("/engines")
    def engines():
        return desk.engines_view()

    @app.post("/engines/a/scan")
    async def engine_a_scan(req: Request):
        b = await body(req)
        syms = b.get("symbols")
        if syms is not None and (not isinstance(syms, list) or len(syms) > 40 or not all(isinstance(x, str) for x in syms)):
            raise HTTPException(400, "symbols: a list of up to 40 tickers")
        return await desk.engine_a_scan([x.upper()[:10] for x in syms] if syms else None, bool(b.get("submit")), actor(req))

    @app.post("/engines/a/watchlist")
    async def watchlist_add(req: Request):
        b = await body(req)
        from engines.equities_commodities import ContractRefused

        try:
            return await desk.watchlist_add(str(b.get("symbol", "")), str(b.get("source") or actor(req)), str(b.get("reason", "")))
        except ContractRefused as e:
            raise HTTPException(400, str(e)) from None

    @app.post("/engines/a/watchlist/{symbol}/remove")
    def watchlist_remove(symbol: str, req: Request):
        ok = desk.watchlist.remove(symbol)
        desk.audit.append("watchlist_remove", {"symbol": symbol.upper()}, ref=symbol.upper(), verdict="OK" if ok else "ABSENT", actor=actor(req))
        return {"ok": ok}

    @app.post("/engines/a/auto")
    async def engine_a_auto(req: Request):
        b = await body(req)
        try:
            return desk.set_auto_scan(int(b.get("minutes", 0)), actor(req))
        except (TypeError, ValueError) as e:
            raise HTTPException(400, str(e)) from None

    @app.post("/engines/b/propose")
    async def engine_b_propose(req: Request):
        b = await body(req)
        try:
            return await desk.engine_b_propose(str(b.get("symbol", "SPY"))[:10], str(b.get("view", "auto")),
                                               str(b.get("structure", "single")), bool(b.get("submit")), actor(req))
        except ValueError as e:
            raise HTTPException(400, str(e)) from None

    # ── intel: Discord, outcomes, journal (Phase 4) ──────────────────
    @app.get("/intel")
    def intel():
        return desk.intel_view()

    @app.get("/intel/discord/search")
    def discord_search(q: str = "", ticker: str | None = None, limit: int = 20):
        return {"results": desk.discord.search(q[:200], ticker=ticker.upper()[:10] if ticker else None, limit=max(1, min(limit, 100)))}

    @app.post("/intel/discord/import")
    async def discord_import(req: Request):
        return await asyncio.to_thread(desk.discord_import, actor(req))

    @app.post("/intel/discord/ingest")
    async def discord_ingest(req: Request):
        b = await body(req)
        msgs = b.get("messages")
        if not isinstance(msgs, list):
            raise HTTPException(400, "messages: a list of Discord API message objects")
        return await asyncio.to_thread(desk.discord_ingest_api, msgs, actor(req))

    @app.post("/intel/discord/poll")
    async def discord_poll(req: Request):
        import discord_live

        rep = await asyncio.to_thread(discord_live.poll_once, desk.discord, desk.rag, universe=desk.watchlist.symbols())
        desk.discord_status.clear()
        desk.discord_status.update(rep)
        return rep

    @app.post("/intel/outcomes/score")
    async def outcomes_score(req: Request):
        return await desk.score_outcomes(actor(req))

    @app.get("/intel/leaderboards")
    def leaderboards(horizon: int = 5):
        if horizon not in (1, 5, 20):
            raise HTTPException(400, "horizon: 1, 5 or 20")
        return desk.leaderboards(horizon)

    @app.post("/intel/journal/pass")
    def journal_pass(req: Request):
        return desk.journal_pass()

    @app.get("/intel/journal")
    def journal(limit: int = 30):
        return {"trades": desk.journal_list(limit)}

    @app.post("/engines/b/guard")
    async def engine_b_guard(req: Request):
        """Run one options-guard pass now (it also runs every minute)."""
        return await desk.options_guard()

    return app


async def _check() -> int:
    """Connect once (read-only), print a summary, exit. Non-zero if not CONNECTED."""
    bridge = Bridge()
    task = asyncio.create_task(bridge.run())
    deadline = time.monotonic() + 25
    while time.monotonic() < deadline:
        await asyncio.sleep(1)
        if bridge.state["state"] == "CONNECTED" and bridge.state["account"]:
            break
        if bridge.state["state"] == "LOCKED":
            break
    snap = bridge.snapshot()
    bridge.stop()
    task.cancel()
    summary = {k: snap[k] for k in ("state", "mode", "host", "port", "clientId", "readOnly", "reasons", "lastError")}
    acct = snap.get("account") or {}
    summary["account"] = {k: acct.get(k) for k in ("account", "currency", "netLiquidation", "buyingPower")}
    summary["pnl"] = snap["pnl"]
    summary["positions"] = len(snap["positions"])
    summary["openOrders"] = len(snap["openOrders"])
    print(json.dumps(summary, indent=2))
    return 0 if snap["state"] == "CONNECTED" else 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--check", action="store_true", help="connect once, print a summary, exit")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    logging.getLogger("ib_async").setLevel(logging.WARNING)
    if args.check:
        return asyncio.run(_check())

    import uvicorn

    cfg = load_config()
    # Bound to loopback unconditionally — this port is never exposed to the LAN/NetBird.
    uvicorn.run(create_app(Bridge()), host="127.0.0.1", port=cfg.bridge_port, log_level="warning")
    return 0


if __name__ == "__main__":
    sys.exit(main())
