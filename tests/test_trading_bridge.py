"""IBKR bridge (Phase 1): paper-only port lock, telemetry shaping, reconnect/lock state machine.

Stdlib only — no TWS, no ib_async: the bridge takes an injectable IB factory.
"""

import asyncio
import math
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace as NS

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "trading"))

import config as tcfg  # noqa: E402
import telemetry  # noqa: E402
from ibkr_bridge import Bridge  # noqa: E402

EMPTY_DOTENV = Path(tempfile.gettempdir()) / "agentic-os-no-such-dotenv"


def cfg(**env):
    return tcfg.load_config(env=env, dotenv=EMPTY_DOTENV)


class PortLockTests(unittest.TestCase):
    def test_default_is_paper_7497(self):
        ep = tcfg.resolve_endpoint(cfg())
        self.assertFalse(ep.locked, ep.reasons)
        self.assertEqual((ep.mode, ep.host, ep.port), ("PAPER", "127.0.0.1", 7497))

    def test_paper_pointed_at_live_port_locks(self):
        ep = tcfg.resolve_endpoint(cfg(IBKR_PAPER_PORT="7496"))
        self.assertTrue(ep.locked)
        self.assertIsNone(ep.port)

    def test_live_locked_even_with_every_flag(self):
        ep = tcfg.resolve_endpoint(cfg(TRADING_MODE="LIVE", ALLOW_LIVE_EXECUTION="TRUE"))
        self.assertTrue(ep.locked)
        self.assertIsNone(ep.port)
        self.assertTrue(any("not enabled in this build" in r for r in ep.reasons))

    def test_live_confirmation_cannot_come_from_env(self):
        self.assertFalse(cfg(TRADING_MODE="LIVE", ALLOW_LIVE_EXECUTION="TRUE", LIVE_CONFIRMED="TRUE").live_confirmed)

    def test_unknown_mode_locks(self):
        self.assertTrue(tcfg.resolve_endpoint(cfg(TRADING_MODE="YOLO")).locked)

    def test_non_loopback_host_locks(self):
        self.assertTrue(tcfg.resolve_endpoint(cfg(IBKR_HOST="192.168.1.20")).locked)

    def test_client_ids_distinct_and_nonzero(self):
        self.assertTrue(tcfg.resolve_endpoint(cfg(IBKR_CLIENT_ID_DATA="11")).locked)
        self.assertTrue(tcfg.resolve_endpoint(cfg(IBKR_CLIENT_ID_KILL="0")).locked)

    def test_malformed_number_locks(self):
        self.assertTrue(tcfg.resolve_endpoint(cfg(IBKR_PAPER_PORT="seven")).locked)

    def test_dotenv_read_and_env_wins(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / ".env"
            p.write_text("# c\nTRADING_MODE=LIVE\nIBKR_CLIENT_ID_BRIDGE='21'\n", encoding="utf-8")
            c = tcfg.load_config(env={"TRADING_MODE": "PAPER"}, dotenv=p)
            self.assertEqual(c.mode, "PAPER")
            self.assertEqual(c.client_ids["bridge"], 21)

    def test_paper_account_prefix(self):
        self.assertTrue(tcfg.is_paper_account("DU1234567"))
        self.assertFalse(tcfg.is_paper_account("U1234567"))


class TelemetryTests(unittest.TestCase):
    def test_account_block_skips_base_rows(self):
        rows = [
            NS(account="DU1", tag="NetLiquidation", value="1000.5", currency="BASE", modelCode=""),
            NS(account="DU1", tag="NetLiquidation", value="999.5", currency="CAD", modelCode=""),
            NS(account="DU1", tag="BuyingPower", value="4000", currency="CAD", modelCode=""),
            NS(account="DU2", tag="BuyingPower", value="1", currency="CAD", modelCode=""),
        ]
        b = telemetry.account_block(rows, "DU1")
        self.assertEqual((b["netLiquidation"], b["buyingPower"], b["currency"]), (999.5, 4000.0, "CAD"))
        self.assertIsNone(b["totalCash"])

    def test_nan_and_unset_double_become_none(self):
        self.assertIsNone(telemetry.num(math.nan))
        self.assertIsNone(telemetry.num(sys.float_info.max))
        self.assertEqual(telemetry.pnl_block(NS(dailyPnL=math.nan, unrealizedPnL=5, realizedPnL=0))["unrealized"], 5.0)

    def test_positions_and_orders(self):
        c = NS(symbol="SPY", localSymbol="SPY", secType="STK", currency="USD", conId=756733)
        pos = telemetry.positions_block([
            NS(contract=c, position=10, averageCost=500, marketPrice=510, marketValue=5100, unrealizedPNL=100, realizedPNL=0),
            NS(contract=c, position=0, averageCost=0, marketPrice=0, marketValue=0, unrealizedPNL=0, realizedPNL=0),
        ])
        self.assertEqual(len(pos), 1)
        self.assertEqual(pos[0]["unrealizedPnl"], 100.0)
        working = NS(contract=c, order=NS(orderId=1, permId=9, clientId=13, action="BUY", totalQuantity=10, orderType="LMT", lmtPrice=500, auxPrice=sys.float_info.max, tif="DAY"), orderStatus=NS(status="Submitted", filled=0, remaining=10))
        done = NS(contract=c, order=working.order, orderStatus=NS(status="Filled", filled=10, remaining=0))
        orders = telemetry.orders_block([working, done])
        self.assertEqual(len(orders), 1)
        self.assertEqual((orders[0]["limitPrice"], orders[0]["stopPrice"]), (500.0, None))


class FakeIB:
    def __init__(self, accounts=("DU1",), fail=False, live_ticks=2):
        self.accounts, self.fail, self.ticks = list(accounts), fail, live_ticks
        self.connected_with = None
        self.disconnected = False

    async def connectAsync(self, host, port, clientId, readonly, timeout):
        if self.fail:
            raise ConnectionRefusedError("TWS down")
        self.connected_with = (host, port, clientId, readonly)

    def managedAccounts(self):
        return self.accounts

    def reqMarketDataType(self, t):
        self.mdt = t

    def reqPnL(self, account):
        return NS(dailyPnL=1.0, unrealizedPnL=2.0, realizedPnL=3.0)

    async def reqAllOpenOrdersAsync(self):
        return []

    def isConnected(self):
        self.ticks -= 1
        return self.ticks >= 0

    def accountValues(self, account):
        return [NS(account=account, tag="NetLiquidation", value="100", currency="USD", modelCode="")]

    def portfolio(self, account):
        return []

    def openTrades(self):
        return []

    def fills(self):
        return []

    def disconnect(self):
        self.disconnected = True


def run_bridge(bridge, max_sleeps):
    """Drive bridge.run() until it has slept `max_sleeps` times, recording states."""
    seen = []

    async def fake_sleep(_s):
        seen.append(bridge.state["state"])
        if len(seen) >= max_sleeps:
            bridge.stop()

    bridge._sleep = fake_sleep
    asyncio.run(bridge.run())
    return seen


class BridgeStateTests(unittest.TestCase):
    def test_connects_read_only_with_bridge_client_id(self):
        ib = FakeIB()
        b = Bridge(config_loader=cfg, ib_factory=lambda: ib)
        seen = run_bridge(b, 2)
        self.assertIn("CONNECTED", seen)
        self.assertEqual(ib.connected_with, ("127.0.0.1", 7497, 11, True))
        self.assertEqual(b.state["account"]["netLiquidation"], 100.0)
        self.assertEqual(b.state["pnl"]["realized"], 3.0)

    def test_open_orders_follow_the_tws_snapshot_not_stale_local_trades(self):
        """Client 11 never hears about cancels made by clients 13/19 (seen live after the kill switch:
        the desk kept showing a cancelled bracket and an old flatten order). The reqAllOpenOrders
        snapshot is what TWS really has working."""
        c = NS(symbol="SPY", localSymbol="SPY", secType="STK", currency="USD", conId=756733)

        def tr(oid, otype):
            return NS(contract=c, order=NS(orderId=oid, permId=oid, clientId=19, action="SELL", totalQuantity=1, orderType=otype,
                                           lmtPrice=0.0, auxPrice=0.0, tif="DAY", orderRef=""), orderStatus=NS(status="PreSubmitted", filled=0, remaining=1))
        ib = FakeIB(live_ticks=3)
        ib.openTrades = lambda: [tr(15, "STP"), tr(16, "LMT"), tr(17, "MKT"), tr(20, "MKT")]  # stale local view

        async def snapshot():
            return [tr(20, "MKT")]  # what TWS actually has open
        ib.reqAllOpenOrdersAsync = snapshot
        b = Bridge(config_loader=cfg, ib_factory=lambda: ib)
        run_bridge(b, 2)
        self.assertEqual([o["orderId"] for o in b.state["openOrders"]], [20])

    def test_drop_goes_to_reconnecting_and_retries(self):
        made = []
        b = Bridge(config_loader=cfg, ib_factory=lambda: made.append(FakeIB(live_ticks=1)) or made[-1])
        seen = run_bridge(b, 3)
        self.assertIn("RECONNECTING", seen)
        self.assertGreaterEqual(len(made), 2)
        self.assertTrue(made[0].disconnected)

    def test_refused_connection_backs_off(self):
        b = Bridge(config_loader=cfg, ib_factory=lambda: FakeIB(fail=True))
        seen = run_bridge(b, 3)
        self.assertEqual(seen, ["RECONNECTING"] * 3)
        self.assertIn("TWS down", b.state["lastError"])

    def test_locked_config_never_dials(self):
        made = []
        b = Bridge(config_loader=lambda: cfg(IBKR_PAPER_PORT="7496"), ib_factory=lambda: made.append(1) or FakeIB())
        seen = run_bridge(b, 2)
        self.assertEqual(seen, ["LOCKED", "LOCKED"])
        self.assertEqual(made, [])

    def test_non_paper_account_locks_and_disconnects(self):
        ib = FakeIB(accounts=("U7654321",))
        b = Bridge(config_loader=cfg, ib_factory=lambda: ib)
        seen = run_bridge(b, 1)
        self.assertEqual(seen, ["LOCKED"])
        self.assertTrue(ib.disconnected)

    def test_mode_flip_while_connected_drops_session(self):
        calls = {"n": 0}

        def loader():
            calls["n"] += 1
            return cfg() if calls["n"] <= 1 else cfg(TRADING_MODE="LIVE", ALLOW_LIVE_EXECUTION="TRUE")

        ib = FakeIB(live_ticks=50)
        b = Bridge(config_loader=loader, ib_factory=lambda: ib)
        seen = run_bridge(b, 1)
        self.assertEqual(seen, ["LOCKED"])
        self.assertTrue(ib.disconnected)


class GatewayProxyTests(unittest.TestCase):
    def test_offline_status_matches_bridge_shape(self):
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
        import trading_api

        off = trading_api.offline_status("x")
        live = Bridge(config_loader=cfg, ib_factory=FakeIB).snapshot()
        self.assertEqual(set(off), set(live))
        self.assertEqual(off["state"], "BRIDGE_OFFLINE")


if __name__ == "__main__":
    unittest.main()
