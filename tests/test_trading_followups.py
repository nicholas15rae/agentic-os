"""Follow-ups wired into the trading module: the bridge's POST /orders/cancel (executor-owned orders),
bridge-routed cancels in safety actions / overseer / desk-cli, reset_lock honouring requiresReconcile,
and desk-cli client ids registered in config."""

import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace as NS

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "trading"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import config as tcfg  # noqa: E402
import desk_lock  # noqa: E402
import kill_switch  # noqa: E402
from audit import AuditLog  # noqa: E402
from desk_harness import Env  # noqa: E402

run = asyncio.run


class BridgeRoutedCancels(unittest.TestCase):
    def test_overseer_liquidates_a_bridge_owned_position_through_the_bridge(self):
        e = Env()
        try:
            e.arm()
            e.bridge_route = True
            e.position_with_bracket("XLE", 4, 20, 50.0, 48.0, 52.0, client_id=13)   # desk bracket: executor-owned
            e.position_with_bracket("SPY", 1, 10, 100.0, 97.0, 104.0, client_id=13)  # healthy
            e.market("XLE", 48.8, slope_per_bar=0.06, surge=5.0)
            e.market("SPY", 100.1)
            e.b.busy_clients.add(13)  # the live bridge holds 13: never borrowed
            ov = e.overseer()
            for _ in range(3):
                run(ov.tick())
                e.advance(6)
                e.market("SPY", 100.1)
                if 4 in e.b.positions:
                    e.market("XLE", 48.8, slope_per_bar=0.06, surge=5.0)
            self.assertNotIn(4, e.b.positions)
            self.assertEqual(e.b.positions[1]["position"], 10)
            self.assertTrue(e.bridge_cancels and all(set(ids) <= {o for o in e.b.orders if e.b.orders[o]["symbol"] == "XLE"}
                                                     for ids, _ in e.bridge_cancels))
            spy_live = [o for o in e.b.orders.values() if o["symbol"] == "SPY" and o["status"] in ("Submitted", "PreSubmitted")]
            self.assertEqual(len(spy_live), 2)
        finally:
            e.close()

    def test_old_bridge_without_the_route_blocks_and_never_sells(self):
        e = Env()
        try:
            e.bridge_route = False  # cancel callable present but answers 404 → treated as blocked
            e.position_with_bracket("XLE", 4, 20, 50.0, 48.0, 52.0, client_id=13)
            e.b.busy_clients.add(13)
            deps = e.deps()
            deps.bridge_cancel = lambda ids, reason: (_ for _ in ()).throw(OSError("404 Not Found"))
            from desk_cli import main

            code = main(["kill", "--symbol", "XLE", "--force", "--confirm-token", "CONFIRM LIQUIDATE XLE"], deps)
            self.assertEqual(code, 5)
            self.assertEqual(e.b.positions[4]["position"], 20)  # not sold: its legs couldn't be cancelled
            self.assertFalse([a for a in e.b.actions if a[0] == "place"])
        finally:
            e.close()

    def test_cli_selective_kill_uses_the_bridge_route(self):
        e = Env()
        try:
            e.bridge_route = True
            e.position_with_bracket("XLE", 4, 20, 50.0, 48.0, 52.0, client_id=13)
            e.b.busy_clients.add(13)
            code, out, err = e.cli(["kill", "--symbol", "XLE", "--force", "--confirm-token", "CONFIRM LIQUIDATE XLE"])
            self.assertEqual(code, 0, err + out)
            self.assertNotIn(4, e.b.positions)
        finally:
            e.close()


class BridgeRoute(unittest.TestCase):
    def _route(self, desk):
        from ibkr_bridge import create_app

        app = create_app(NS(state={"state": "CONNECTED"}, snapshot=lambda: {}), desk=desk)
        return next(r.endpoint for r in app.router.routes if getattr(r, "path", "") == "/orders/cancel")

    def _req(self, body):
        async def js():
            return body

        return NS(json=js, headers={"x-trading-actor": "test"})

    def test_route_validates_and_audits(self):
        calls = []

        class Ex:
            async def cancel_ids(self, ids):
                calls.append(ids)
                return [{"orderId": i, "status": "Cancelled"} for i in ids]

        with tempfile.TemporaryDirectory() as td:
            desk = NS(executor=Ex(), audit=AuditLog(Path(td) / "audit.db"))
            ep = self._route(desk)
            out = run(ep(self._req({"orderIds": [15, 16], "reason": "master stop XLE"})))
            self.assertEqual(out["results"], [{"orderId": 15, "status": "Cancelled"}, {"orderId": 16, "status": "Cancelled"}])
            self.assertEqual(desk.audit.tail(1)[0]["kind"], "orders_cancel")
            from fastapi import HTTPException

            for bad in ({"orderIds": [], "reason": "x"}, {"orderIds": ["15"], "reason": "x"}, {"orderIds": [15]}, {"orderIds": [True], "reason": "x"}):
                with self.assertRaises(HTTPException):
                    run(ep(self._req(bad)))
            self.assertEqual(calls, [[15, 16]])

    def test_executor_cancel_ids_only_touches_its_own_orders_and_works_while_locked(self):
        from executor import Executor

        class T:
            def __init__(self, oid, cid):
                self.order = NS(orderId=oid, clientId=cid)
                self.orderStatus = NS(status="Submitted")

            def isDone(self):
                return self.orderStatus.status == "Cancelled"

        mine, foreign = T(15, 13), T(7, 21)

        class IB:
            cancelled = []

            def isConnected(self):
                return True

            async def reqOpenOrdersAsync(self):
                return []

            def openTrades(self):
                return [mine, foreign]

            def cancelOrder(self, o):
                self.cancelled.append(o.orderId)
                (mine if o.orderId == 15 else foreign).orderStatus.status = "Cancelled"

        with tempfile.TemporaryDirectory() as td:
            kill_switch.write_lock("x", "t", "inc", Path(td))
            ex = Executor(lock_dir=Path(td))
            ex.ib = IB()

            async def nosleep(_):
                return None

            out = run(ex.cancel_ids([15, 7], sleep=nosleep))
            self.assertEqual(IB.cancelled, [15])
            self.assertEqual({r["orderId"]: r["status"] for r in out}, {15: "Cancelled", 7: "NotWorking"})


class ResetLockNeedsReconcile(unittest.TestCase):
    def test_gui_reset_refuses_an_overseer_lock_until_reconcile_passes(self):
        with tempfile.TemporaryDirectory() as td:
            d = Path(td)
            a = AuditLog(d / "audit.db")
            desk_lock.lock(d, "overseer: DMS_CC", "overseer", breaker="DMS_CC")
            with self.assertRaises(PermissionError):
                kill_switch.reset_lock("RESET", "ui", a, d)
            self.assertTrue(kill_switch.is_locked(d))
            desk_lock.write_reconcile_stamp(d, True, {})
            with self.assertRaises(PermissionError):
                kill_switch.reset_lock("reset", "ui", a, d)  # typed RESET still required
            kill_switch.reset_lock("RESET", "ui", a, d)
            self.assertFalse(kill_switch.is_locked(d))

    def test_plain_e_stop_lock_resets_as_before(self):
        with tempfile.TemporaryDirectory() as td:
            d = Path(td)
            kill_switch.write_lock("red button", "ui", "inc1", d)
            kill_switch.reset_lock("RESET", "ui", AuditLog(d / "audit.db"), d)
            self.assertFalse(kill_switch.is_locked(d))


class ClientIdsInConfig(unittest.TestCase):
    def test_desk_cli_ids_registered_and_collisions_lock(self):
        c = tcfg.load_config(env={}, dotenv=Path("nonexistent.env"))
        self.assertEqual({k: c.client_ids[k] for k in ("overseer", "overseer_act", "cli", "cli_act", "snapshot", "status")},
                         {"overseer": 20, "overseer_act": 21, "cli": 22, "cli_act": 23, "snapshot": 24, "status": 25})
        self.assertFalse(tcfg.resolve_endpoint(c).locked)
        self.assertTrue(tcfg.resolve_endpoint(tcfg.load_config(env={"IBKR_CLIENT_ID_DATA": "22"}, dotenv=Path("x.env"))).locked)
        self.assertEqual(c.market_data_type, 4)


if __name__ == "__main__":
    unittest.main()
