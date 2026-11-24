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

from config import Endpoint, TradingConfig, is_paper_account, load_config, resolve_endpoint  # noqa: E402
from telemetry import account_block, orders_block, pnl_block, positions_block  # noqa: E402

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
            "pnl": pnl_block(None),
            "positions": [],
            "openOrders": [],
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
            await asyncio.wait_for(self.ib.reqAllOpenOrdersAsync(), 5)
        except Exception as e:  # noqa: BLE001 — orders are best-effort telemetry
            log.debug("open orders refresh failed: %s", e)

    def _collect(self, account: str) -> None:
        ib = self.ib
        self._set(
            account=account_block(ib.accountValues(account), account),
            pnl=pnl_block(self._pnl),
            positions=positions_block(ib.portfolio(account)),
            openOrders=orders_block(ib.openTrades()),
        )

    def _disconnect(self) -> None:
        if self.ib is not None:
            try:
                self.ib.disconnect()
            except Exception:  # noqa: BLE001
                pass
        self.ib = None
        self._pnl = None


# ── HTTP surface (loopback only; the gateway proxies /api/trading/*) ──────
def create_app(bridge: Bridge):
    from contextlib import asynccontextmanager

    from fastapi import FastAPI

    @asynccontextmanager
    async def lifespan(_app):
        task = asyncio.create_task(bridge.run())
        try:
            yield
        finally:
            bridge.stop()
            task.cancel()

    app = FastAPI(title="IBKR bridge", lifespan=lifespan, docs_url=None, redoc_url=None)

    @app.get("/health")
    def health():
        return {"ok": True, "state": bridge.state["state"]}

    @app.get("/status")
    def status():
        return bridge.snapshot()

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
