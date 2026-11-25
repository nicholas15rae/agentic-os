"""Tests for trading/reconcile.py (pure broker-vs-desk reconciliation). No TWS, no data dir."""

import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "trading"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import reconcile as rc  # noqa: E402
from fake_tws import FakeBroker  # noqa: E402

NOW = 1_800_000_000.0
SPY = 756733


def pos(symbol="SPY", qty=1.0, con=SPY, sec="STK", underlying=None, avg=717.25):
    return {"account": "DU123", "conId": con, "symbol": symbol, "underlying": underlying or symbol, "secType": sec,
            "currency": "USD", "position": float(qty), "avgCost": avg}


def order(oid, action, qty, typ, *, con=SPY, symbol="SPY", tif="GTC", ref="", parent=0, client=13, status="Submitted",
          stop=None, limit=None, filled=0.0, sec="STK"):
    return {"orderId": oid, "permId": 9000 + oid, "clientId": client, "parentId": parent, "ocaGroup": "", "conId": con,
            "symbol": symbol, "underlying": symbol, "secType": sec, "currency": "USD", "action": action, "quantity": float(qty),
            "orderType": typ, "limitPrice": limit, "stopPrice": stop, "tif": tif, "status": status, "filled": filled,
            "remaining": float(qty) - filled, "orderRef": ref}


def execution(eid, oid, side, shares, ref, symbol="SPY", con=SPY, client=13, price=717.25):
    return {"execId": eid, "orderId": oid, "permId": 9000 + oid, "clientId": client, "conId": con, "symbol": symbol,
            "side": side, "shares": float(shares), "price": price, "time": NOW - 60, "orderRef": ref}


def intent(iid, symbol="SPY", action="BUY", qty=1, status="submitted", orders=None, con=SPY, **extra):
    res = None if orders is None else {"conId": con, "orders": [{"orderId": o} for o in orders]}
    return {"intentId": iid, "status": status, "symbol": symbol, "action": action, "quantity": qty, "result": res, **extra}


def live_example():
    """What the real broker looks like right now (see CONTRACTS.md)."""
    positions = [pos()]
    orders = [order(15, "SELL", 1, "STP", stop=712.00, ref="rehearsal-145646", parent=14, status="PreSubmitted"),
              order(16, "SELL", 1, "LMT", limit=719.80, ref="rehearsal-145646", parent=14)]
    intents = [intent("rehearsal-145646", orders=[14, 15, 16])]
    return positions, orders, intents


def codes(rep, severity=None):
    return [d["code"] for d in rep["drift"] if severity is None or d["severity"] == severity]


# ─────────────────────────────────────────────────────────────────────
class TestSigned(unittest.TestCase):
    def test_signs(self):
        self.assertEqual(rc.signed(3, "BUY"), 3.0)
        self.assertEqual(rc.signed(3, "SELL"), -3.0)
        self.assertEqual(rc.signed(-3, "SELL"), -3.0)  # magnitude, sign from action
        self.assertEqual(rc.signed(2, "BOT"), 2.0)
        self.assertEqual(rc.signed(2, "SLD"), -2.0)
        self.assertEqual(rc.signed(2, "buy"), 2.0)

    def test_unknown_action_raises(self):
        with self.assertRaises(ValueError):
            rc.signed(1, "HOLD")

    def test_known_prefixes(self):
        self.assertEqual(rc.KNOWN_REF_PREFIXES, ("KILL-", "GUARD-", "MSL-", "DMS-", "CLI-"))


class TestClassifyOrders(unittest.TestCase):
    def test_long_protective_roles(self):
        roles = rc.classify_orders([pos(qty=10)], [
            order(1, "SELL", 10, "STP", stop=700), order(2, "SELL", 10, "LMT", limit=730), order(3, "SELL", 10, "MKT"),
            order(4, "SELL", 10, "TRAIL"), order(5, "SELL", 10, "STP LMT", stop=700, limit=699)])
        self.assertEqual(roles, {1: "stop", 2: "take_profit", 3: "exit", 4: "stop", 5: "stop"})

    def test_short_protective_roles(self):
        roles = rc.classify_orders([pos(qty=-5)], [order(1, "BUY", 5, "STP", stop=730), order(2, "BUY", 5, "LMT", limit=700),
                                                   order(3, "SELL", 5, "LMT", limit=740)])
        self.assertEqual(roles, {1: "stop", 2: "take_profit", 3: "entry"})

    def test_same_side_and_no_position_are_entries(self):
        roles = rc.classify_orders([pos(qty=10)], [order(1, "BUY", 5, "LMT", limit=710),
                                                   order(2, "SELL", 5, "STP", con=999, symbol="QQQ", stop=400)])
        self.assertEqual(roles, {1: "entry", 2: "entry"})

    def test_children_of_working_parent_are_pending(self):
        orders = [order(20, "BUY", 5, "LMT", limit=710, tif="DAY"),
                  order(21, "SELL", 5, "STP", stop=700, parent=20, status="PreSubmitted"),
                  order(22, "SELL", 5, "LMT", limit=730, parent=20, status="PreSubmitted")]
        # Even with an existing long in the same conId, unfilled-bracket children are not protection.
        for positions in ([], [pos(qty=5)]):
            roles = rc.classify_orders(positions, orders)
            self.assertEqual(roles[21], "pending_child")
            self.assertEqual(roles[22], "pending_child")
        self.assertEqual(rc.classify_orders([], orders)[20], "entry")

    def test_children_of_filled_parent_are_protective(self):
        p, orders, _ = live_example()
        self.assertEqual(rc.classify_orders(p, orders), {15: "stop", 16: "take_profit"})

    def test_parent_in_done_status_does_not_make_child_pending(self):
        orders = [order(20, "BUY", 1, "LMT", status="Filled"), order(21, "SELL", 1, "STP", stop=700, parent=20)]
        self.assertEqual(rc.classify_orders([pos()], orders)[21], "stop")


class TestBracketStatus(unittest.TestCase):
    def test_protected(self):
        p, orders, _ = live_example()
        b = rc.bracket_status(p[0], orders)
        self.assertEqual(b["status"], "PROTECTED")
        self.assertEqual(b["stop"], {"orderId": 15, "price": 712.00, "qty": 1.0, "tif": "GTC", "clientId": 13})
        self.assertEqual(b["takeProfit"], {"orderId": 16, "price": 719.80, "qty": 1.0, "tif": "GTC", "clientId": 13})
        self.assertEqual((b["stopQty"], b["tpQty"]), (1.0, 1.0))
        self.assertEqual(set(b), {"status", "stop", "takeProfit", "stopQty", "tpQty"})

    def test_stop_only_no_tp(self):
        b = rc.bracket_status(pos(qty=10), [order(1, "SELL", 10, "STP", stop=700)])
        self.assertEqual(b["status"], "STOP_ONLY")
        self.assertIsNone(b["takeProfit"])

    def test_stop_only_insufficient_or_day_tp(self):
        self.assertEqual(rc.bracket_status(pos(qty=10), [order(1, "SELL", 10, "STP", stop=700),
                                                         order(2, "SELL", 4, "LMT", limit=730)])["status"], "STOP_ONLY")
        self.assertEqual(rc.bracket_status(pos(qty=10), [order(1, "SELL", 10, "STP", stop=700),
                                                         order(2, "SELL", 10, "LMT", limit=730, tif="DAY")])["status"], "STOP_ONLY")

    def test_undersized(self):
        b = rc.bracket_status(pos(qty=10), [order(1, "SELL", 4, "STP", stop=700), order(2, "SELL", 10, "LMT", limit=730)])
        self.assertEqual(b["status"], "UNDERSIZED")
        self.assertEqual(b["stopQty"], 4.0)

    def test_not_gtc(self):
        b = rc.bracket_status(pos(qty=10), [order(1, "SELL", 10, "STP", stop=700, tif="DAY"), order(2, "SELL", 10, "LMT", limit=730)])
        self.assertEqual(b["status"], "NOT_GTC")
        b = rc.bracket_status(pos(qty=10), [order(1, "SELL", 6, "STP", stop=700), order(3, "SELL", 4, "STP", stop=698, tif="DAY")])
        self.assertEqual(b["status"], "NOT_GTC")

    def test_over_hedged(self):
        b = rc.bracket_status(pos(qty=10), [order(1, "SELL", 10, "STP", stop=700), order(2, "SELL", 5, "STP", stop=695)])
        self.assertEqual(b["status"], "OVER_HEDGED")
        self.assertEqual(b["stopQty"], 15.0)
        self.assertEqual(b["stop"]["orderId"], 1)  # largest-qty stop is the detail

    def test_naked(self):
        b = rc.bracket_status(pos(qty=10), [order(2, "SELL", 10, "LMT", limit=730), order(3, "BUY", 5, "STP", stop=740)])
        self.assertEqual(b["status"], "NAKED")
        self.assertIsNone(b["stop"])
        self.assertEqual(b["stopQty"], 0)

    def test_short_position(self):
        b = rc.bracket_status(pos(qty=-10), [order(1, "BUY", 10, "STP", stop=730), order(2, "BUY", 10, "LMT", limit=690)])
        self.assertEqual(b["status"], "PROTECTED")
        self.assertEqual(rc.bracket_status(pos(qty=-10), [order(1, "SELL", 10, "STP", stop=690)])["status"], "NAKED")

    def test_split_stops_sum_and_largest_detail(self):
        b = rc.bracket_status(pos(qty=10), [order(1, "SELL", 3, "STP", stop=705), order(2, "SELL", 7, "STP", stop=700),
                                            order(3, "SELL", 6, "LMT", limit=730), order(4, "SELL", 4, "LMT", limit=735)])
        self.assertEqual(b["status"], "PROTECTED")
        self.assertEqual((b["stopQty"], b["tpQty"]), (10.0, 10.0))
        self.assertEqual(b["stop"]["orderId"], 2)
        self.assertEqual(b["takeProfit"]["orderId"], 3)

    def test_partially_filled_stop_counts_unfilled_qty(self):
        b = rc.bracket_status(pos(qty=6), [order(1, "SELL", 10, "STP", stop=700, filled=4), order(2, "SELL", 6, "LMT", limit=730)])
        self.assertEqual(b["stopQty"], 6.0)
        self.assertEqual(b["status"], "PROTECTED")

    def test_pending_children_do_not_protect(self):
        orders = [order(20, "BUY", 10, "LMT", limit=710, tif="DAY"), order(21, "SELL", 10, "STP", stop=700, parent=20),
                  order(22, "SELL", 10, "LMT", limit=730, parent=20)]
        self.assertEqual(rc.bracket_status(pos(qty=10), orders)["status"], "NAKED")

    def test_other_conid_orders_ignored(self):
        b = rc.bracket_status(pos(qty=10), [order(1, "SELL", 10, "STP", con=1, stop=700)])
        self.assertEqual(b["status"], "NAKED")

    def test_options_desk_guarded(self):
        opt = pos("SPY   261218C00700000", qty=2, con=555, sec="OPT", underlying="SPY", avg=350)
        self.assertEqual(rc.bracket_status(opt, [])["status"], "DESK_GUARDED")
        self.assertEqual(rc.bracket_status({**opt, "secType": "BAG"}, [])["status"], "DESK_GUARDED")
        self.assertEqual(rc.bracket_status(opt, [], options_exempt=False)["status"], "NAKED")
        stp = order(1, "SELL", 2, "STP", con=555, symbol=opt["symbol"], stop=1.5, sec="OPT")
        self.assertEqual(rc.bracket_status(opt, [stp])["status"], "STOP_ONLY")  # a stop present is evaluated normally


class TestExpectedPositions(unittest.TestCase):
    def test_executions_net(self):
        ints = [intent("A1", orders=[1, 2, 3], qty=5)]
        ex = [execution("E1", 1, "BOT", 5, "A1"), execution("E2", 2, "SLD", 2, "A1")]
        self.assertEqual(rc.expected_positions(ints, [], ex), {"SPY": 3.0})

    def test_parent_working_is_zero(self):
        ints = [intent("A1", orders=[20, 21, 22], qty=5)]
        self.assertEqual(rc.expected_positions(ints, [order(20, "BUY", 5, "LMT", tif="DAY")], []), {"SPY": 0.0})
        self.assertEqual(rc.expected_positions(ints, [order(20, "BUY", 5, "LMT", tif="DAY")], None), {"SPY": 0.0})

    def test_submitted_assumed_filled_earlier(self):
        ints = [intent("A1", orders=[14, 15, 16], qty=5), intent("S1", action="SELL", qty=3, orders=[30])]
        self.assertEqual(rc.expected_positions(ints, [], []), {"SPY": 2.0})
        self.assertEqual(rc.expected_positions(ints, [], None), {"SPY": 2.0})
        self.assertEqual(rc.expected_positions([intent("N", orders=None, qty=4)], [], None), {"SPY": 4.0})

    def test_closed_stop_without_executions_is_zero(self):
        self.assertEqual(rc.expected_positions([intent("A1", status="closed_stop", orders=None, qty=5)], [], []), {"SPY": 0.0})

    def test_closed_stop_with_executions_nets(self):
        ex = [execution("E1", 1, "BOT", 5, "A1"), execution("E2", 2, "SLD", 5, "A1")]
        self.assertEqual(rc.expected_positions([intent("A1", status="closed_stop", orders=[1, 2], qty=5)], [], ex), {"SPY": 0.0})

    def test_other_statuses_ignored(self):
        ints = [intent(f"X{s}", status=s, orders=[1], qty=5) for s in ("closed", "failed", "rejected", "pending_approval", "expired")]
        self.assertEqual(rc.expected_positions(ints, [], []), {})

    def test_executions_none_ignores_refs(self):
        ints = [intent("A1", orders=[1, 2], qty=5)]
        self.assertEqual(rc.expected_positions(ints, [], None), {"SPY": 5.0})

    def test_earlier_entry_with_todays_exit_fill(self):
        # Entry #14 filled yesterday (not in today's executions); today the stop #15 sold 1 → expected 0, not -1.
        ints = [intent("rehearsal-145646", orders=[14, 15, 16])]
        ex = [execution("E9", 15, "SLD", 1, "rehearsal-145646")]
        self.assertEqual(rc.expected_positions(ints, [], ex), {"SPY": 0.0})

    def test_result_as_json_string(self):
        it = intent("A1", qty=5)
        it["result"] = '{"conId": 756733, "orders": [{"orderId": 20}]}'
        self.assertEqual(rc.expected_positions([it], [order(20, "BUY", 5, "LMT")], None), {"SPY": 0.0})

    def test_multiple_symbols(self):
        ints = [intent("A1", qty=5, orders=[1]), intent("B1", symbol="QQQ", qty=2, orders=[2], con=2)]
        self.assertEqual(rc.expected_positions(ints, [], []), {"SPY": 5.0, "QQQ": 2.0})


# ─────────────────────────────────────────────────────────────────────
class TestReconcile(unittest.TestCase):
    def run_rc(self, positions, orders, executions, intents, **kw):
        return rc.reconcile(positions=positions, orders=orders, executions=executions, intents=intents, now=kw.pop("now", NOW), **kw)

    def assertCodes(self, rep, expected):
        self.assertEqual(sorted(codes(rep)), sorted(expected), rep["drift"])

    def test_live_example_ok(self):
        p, o, i = live_example()
        for ex in ([], [execution("E1", 14, "BOT", 1, "rehearsal-145646")]):
            rep = self.run_rc(p, o, ex, i)
            self.assertTrue(rep["ok"], rep["drift"])
            self.assertEqual(rep["drift"], [])
            self.assertEqual(rep["at"], NOW)
            row = rep["positions"][0]
            self.assertEqual(row["bracket"]["status"], "PROTECTED")
            self.assertEqual(row["intents"], ["rehearsal-145646"])
            self.assertEqual(row["expectedQty"], 1.0)
            self.assertIsNone(row["nakedSince"])
            self.assertIsNone(row["nakedForS"])
            self.assertEqual({k for k in row}, {"symbol", "conId", "secType", "position", "avgCost", "bracket", "intents",
                                                "expectedQty", "nakedSince", "nakedForS"})
            self.assertEqual([(x["orderId"], x["role"], x["known"]) for x in rep["orders"]],
                             [(15, "stop", True), (16, "take_profit", True)])
            self.assertEqual(rep["nakedSince"], {})
            self.assertEqual(rep["counts"], {"positions": 1, "orders": 2, "drift": 0, "warn": 0})

    def test_live_example_with_fake_broker(self):
        b = FakeBroker(now=NOW)
        b.add_bracket("SPY", SPY, 1, 717.25, 712.00, 719.80, ref="rehearsal-145646")
        ids = sorted(b.orders)
        rep = self.run_rc(list(b.positions.values()), b.working(), list(b.executions),
                          [intent("rehearsal-145646", orders=ids)])
        self.assertTrue(rep["ok"], rep["drift"])
        self.assertEqual(rep["positions"][0]["bracket"]["status"], "PROTECTED")

    def test_unfilled_entry_bracket_ok(self):
        b = FakeBroker(now=NOW)
        legs = b.add_bracket("SPY", SPY, 5, 710.0, 700.0, 730.0, ref="intent-unfilled", filled=False)
        rep = self.run_rc(list(b.positions.values()), b.working(), list(b.executions),
                          [intent("intent-unfilled", qty=5, orders=[x["orderId"] for x in legs])])
        self.assertTrue(rep["ok"], rep["drift"])
        self.assertNotIn("QTY_MISMATCH", codes(rep))
        self.assertNotIn("ORPHAN_INTENT", codes(rep))
        roles = {x["orderId"]: x["role"] for x in rep["orders"]}
        self.assertEqual(roles, {legs[0]["orderId"]: "entry", legs[1]["orderId"]: "pending_child", legs[2]["orderId"]: "pending_child"})
        self.assertEqual(rep["positions"], [])

    def test_stop_filled_ok(self):
        b = FakeBroker(now=NOW)
        legs = b.add_bracket("SPY", SPY, 1, 717.25, 712.00, 719.80, ref="rehearsal-145646")
        b.fill(legs[1]["orderId"], 712.00)  # stop fills; TWS cancels the OCA take-profit
        self.assertEqual(b.positions, {})
        self.assertEqual(b.working(), [])
        rep = self.run_rc(list(b.positions.values()), b.working(), list(b.executions),
                          [intent("rehearsal-145646", orders=[x["orderId"] for x in legs])])
        self.assertTrue(rep["ok"], rep["drift"])
        self.assertEqual(rep["drift"], [])

    def test_stop_filled_entry_yesterday_ok(self):
        p, o, i = live_example()
        rep = self.run_rc([], [], [execution("E9", 15, "SLD", 1, "rehearsal-145646", price=712.0)], i)
        self.assertTrue(rep["ok"], rep["drift"])

    # ── each drift code ──────────────────────────────────────────────
    def test_phantom_order(self):
        p, o, i = live_example()
        manual = order(77, "BUY", 10, "LMT", symbol="QQQ", con=320227571, limit=400, client=0, ref="", tif="DAY")
        foreign = order(78, "BUY", 1, "LMT", limit=700, ref="somebody-else", client=5)
        system = [order(79, "SELL", 1, "MKT", ref="KILL-1", client=19, tif="DAY"),
                  order(80, "SELL", 1, "MKT", ref="CLI-flat", client=23, tif="DAY")]
        rep = self.run_rc(p, o + [manual, foreign] + system, [], i)
        self.assertFalse(rep["ok"])
        ph = [d for d in rep["drift"] if d["code"] == "PHANTOM_ORDER"]
        self.assertEqual([(d["ref"], d["symbol"], d["severity"]) for d in ph], [("", "QQQ", "drift"), ("somebody-else", "SPY", "drift")])
        known = {x["orderId"]: x["known"] for x in rep["orders"]}
        self.assertEqual(known, {15: True, 16: True, 77: False, 78: False, 79: True, 80: True})

    def test_phantom_order_ref_of_closed_intent_is_known(self):
        p, o, i = live_example()
        extra = order(81, "SELL", 1, "LMT", limit=740, ref="old-intent-0001")
        rep = self.run_rc(p, o + [extra], [], i + [intent("old-intent-0001", status="closed", orders=[50])])
        self.assertNotIn("PHANTOM_ORDER", codes(rep))

    def test_orphan_intent(self):
        p, o, i = live_example()
        ghost = intent("ghost-intent-01", symbol="QQQ", qty=3, orders=[90, 91, 92], con=2)
        rep = self.run_rc(p, o, [], i + [ghost])
        self.assertIn("ORPHAN_INTENT", codes(rep))
        d = next(x for x in rep["drift"] if x["code"] == "ORPHAN_INTENT")
        self.assertEqual((d["symbol"], d["ref"], d["severity"]), ("QQQ", "ghost-intent-01", "drift"))
        self.assertFalse(rep["ok"])

    def test_orphan_not_flagged_when_order_working_execution_or_position(self):
        p, o, i = live_example()
        # working order
        rep = self.run_rc(p, o + [order(90, "BUY", 3, "LMT", symbol="QQQ", con=2, ref="q-intent-001", tif="DAY")], [],
                          i + [intent("q-intent-001", symbol="QQQ", qty=3, orders=[90, 91], con=2)])
        self.assertNotIn("ORPHAN_INTENT", codes(rep))
        # execution carries its ref (it filled and stopped out today)
        ex = [execution("E1", 90, "BOT", 3, "q-intent-001", symbol="QQQ", con=2),
              execution("E2", 91, "SLD", 3, "q-intent-001", symbol="QQQ", con=2)]
        rep = self.run_rc(p, o, ex, i + [intent("q-intent-001", symbol="QQQ", qty=3, orders=[90, 91], con=2)])
        self.assertNotIn("ORPHAN_INTENT", codes(rep))
        self.assertTrue(rep["ok"], rep["drift"])
        # position in its symbol
        rep = self.run_rc(p, o, [], i)
        self.assertNotIn("ORPHAN_INTENT", codes(rep))

    def test_orphan_only_for_submitted(self):
        rep = self.run_rc([], [], [], [intent("cs-intent-001", status="closed_stop", orders=None)])
        self.assertNotIn("ORPHAN_INTENT", codes(rep))
        self.assertTrue(rep["ok"], rep["drift"])

    def test_qty_mismatch(self):
        p, o, i = live_example()
        p[0]["position"] = 2.0
        o = [dict(x, quantity=2.0, remaining=2.0) for x in o]
        rep = self.run_rc(p, o, [], i)
        self.assertEqual(codes(rep), ["QTY_MISMATCH"])
        d = rep["drift"][0]
        self.assertEqual((d["symbol"], d["severity"]), ("SPY", "drift"))
        self.assertIn("rehearsal-145646", d["ref"])
        self.assertFalse(rep["ok"])

    def test_qty_mismatch_when_position_missing(self):
        # Desk expects +1 (entry filled earlier, parent gone) but there is no position and no executions explain it.
        rep = self.run_rc([], [order(15, "SELL", 1, "STP", stop=712, ref="rehearsal-145646", parent=14)], [],
                          [intent("rehearsal-145646", orders=[14, 15, 16])])
        self.assertIn("QTY_MISMATCH", codes(rep))
        self.assertFalse(rep["ok"])

    def test_qty_tolerance(self):
        p, o, i = live_example()
        p[0]["position"] = 1.0 + 1e-9
        self.assertNotIn("QTY_MISMATCH", codes(self.run_rc(p, o, [], i)))

    def test_untracked_position(self):
        p, o, i = live_example()
        qqq = pos("QQQ", qty=10, con=320227571, avg=400)
        stp = order(60, "SELL", 10, "STP", symbol="QQQ", con=320227571, stop=390, ref="CLI-manual-stop", client=23)
        tp = order(61, "SELL", 10, "LMT", symbol="QQQ", con=320227571, limit=420, ref="CLI-manual-stop", client=23)
        rep = self.run_rc(p + [qqq], o + [stp, tp], [], i)
        self.assertEqual(codes(rep), ["UNTRACKED_POSITION"])
        d = rep["drift"][0]
        self.assertEqual((d["symbol"], d["ref"]), ("QQQ", "320227571"))
        self.assertEqual(rep["positions"][1]["intents"], [])
        self.assertIsNone(rep["positions"][1]["expectedQty"])

    def test_untracked_when_only_closed_intents(self):
        rep = self.run_rc([pos()], [order(15, "SELL", 1, "STP", stop=712, ref="x-intent-0001"),
                                    order(16, "SELL", 1, "LMT", limit=719, ref="x-intent-0001")], [],
                          [intent("x-intent-0001", status="closed", orders=[14, 15, 16])])
        self.assertEqual(codes(rep), ["UNTRACKED_POSITION"])

    def test_unlogged_fill(self):
        p, o, i = live_example()
        ex = [execution("E1", 14, "BOT", 1, "rehearsal-145646"),
              execution("E2", 0, "BOT", 5, "", symbol="QQQ", con=2, client=0),
              execution("E3", 40, "SLD", 1, "mystery-ref", symbol="IWM", con=3),
              execution("E4", 41, "SLD", 1, "GUARD-STOP-abc", symbol="IWM", con=3),
              execution("E5", 42, "SLD", 1, "MSL-1", symbol="IWM", con=3),
              execution("E6", 43, "SLD", 1, "old-intent-0001", symbol="IWM", con=3)]
        rep = self.run_rc(p, o, ex, i + [intent("old-intent-0001", symbol="IWM", status="closed", orders=[43], con=3)])
        un = [d for d in rep["drift"] if d["code"] == "UNLOGGED_FILL"]
        self.assertEqual([(d["ref"], d["symbol"]) for d in un], [("", "QQQ"), ("mystery-ref", "IWM")])
        self.assertTrue(all(d["severity"] == "drift" for d in un))
        self.assertFalse(rep["ok"])

    def test_naked_position(self):
        p, _, i = live_example()
        rep = self.run_rc(p, [order(16, "SELL", 1, "LMT", limit=719.8, ref="rehearsal-145646", parent=14)], [], i)
        self.assertEqual(codes(rep), ["NAKED_POSITION"])
        self.assertEqual(rep["positions"][0]["bracket"]["status"], "NAKED")
        self.assertEqual(rep["positions"][0]["nakedSince"], NOW)
        self.assertEqual(rep["positions"][0]["nakedForS"], 0.0)
        self.assertEqual(rep["nakedSince"], {str(SPY): NOW})
        self.assertFalse(rep["ok"])

    def test_naked_position_for_undersized_and_not_gtc(self):
        p = [pos(qty=10)]
        i = [intent("big-intent-001", qty=10, orders=[1, 2, 3])]
        under = [order(2, "SELL", 4, "STP", stop=700, ref="big-intent-001"), order(3, "SELL", 10, "LMT", limit=730, ref="big-intent-001")]
        day = [order(2, "SELL", 10, "STP", stop=700, tif="DAY", ref="big-intent-001"),
               order(3, "SELL", 10, "LMT", limit=730, ref="big-intent-001")]
        for orders, st in ((under, "UNDERSIZED"), (day, "NOT_GTC")):
            rep = self.run_rc(p, orders, [], i)
            self.assertEqual(codes(rep), ["NAKED_POSITION"], st)
            self.assertEqual(rep["positions"][0]["bracket"]["status"], st)
            self.assertIn(str(SPY), rep["nakedSince"])

    def test_over_hedged(self):
        p, o, i = live_example()
        rep = self.run_rc(p, o + [order(17, "SELL", 1, "STP", stop=705, ref="CLI-extra", client=23)], [], i)
        self.assertEqual(codes(rep), ["OVER_HEDGED"])
        self.assertEqual(rep["drift"][0]["severity"], "drift")
        self.assertEqual(rep["nakedSince"], {})
        self.assertFalse(rep["ok"])

    def test_missing_take_profit_is_warn(self):
        p, o, i = live_example()
        rep = self.run_rc(p, o[:1], [], i)
        self.assertEqual(codes(rep), ["MISSING_TAKE_PROFIT"])
        self.assertEqual(codes(rep, "warn"), ["MISSING_TAKE_PROFIT"])
        self.assertTrue(rep["ok"])
        self.assertEqual(rep["counts"], {"positions": 1, "orders": 1, "drift": 0, "warn": 1})

    def test_executions_unavailable_is_warn(self):
        p, o, i = live_example()
        rep = self.run_rc(p, o, None, i)
        self.assertEqual(codes(rep), ["EXECUTIONS_UNAVAILABLE"])
        self.assertEqual(rep["drift"][0]["severity"], "warn")
        self.assertTrue(rep["ok"])
        self.assertEqual(rep["counts"]["warn"], 1)

    def test_executions_unavailable_skips_unlogged_fill(self):
        rep = self.run_rc([], [], None, [])
        self.assertEqual(codes(rep), ["EXECUTIONS_UNAVAILABLE"])

    def test_orphan_without_executions_still_checked(self):
        rep = self.run_rc([], [], None, [intent("lost-intent-01", orders=[90])])
        self.assertIn("ORPHAN_INTENT", codes(rep))

    def test_options_position_desk_guarded_and_tracked(self):
        opt = pos("SPY   261218C00700000", qty=2, con=555, sec="OPT", underlying="SPY", avg=350)
        oi = intent("opt-intent-001", qty=2, orders=[70, 71], con=555, secType="OPT")
        tp = order(71, "SELL", 2, "LMT", con=555, symbol=opt["symbol"], limit=6.0, ref="opt-intent-001", sec="OPT")
        rep = self.run_rc([opt], [tp], [], [oi])
        self.assertTrue(rep["ok"], rep["drift"])
        self.assertEqual(rep["positions"][0]["bracket"]["status"], "DESK_GUARDED")
        self.assertEqual(rep["positions"][0]["intents"], ["opt-intent-001"])
        self.assertIsNone(rep["positions"][0]["expectedQty"])
        rep = self.run_rc([opt], [tp], [], [oi], options_exempt=False)
        self.assertEqual(codes(rep), ["NAKED_POSITION"])

    def test_option_intent_does_not_track_stock_position(self):
        oi = intent("opt-intent-001", qty=2, orders=[70], con=555, secType="OPT")
        rep = self.run_rc([pos()], [order(15, "SELL", 1, "STP", stop=712, ref="CLI-x"), order(16, "SELL", 1, "LMT", limit=719, ref="CLI-x")],
                          [], [oi])
        self.assertIn("UNTRACKED_POSITION", codes(rep))

    # ── nakedSince persistence ───────────────────────────────────────
    def test_naked_since_persistence(self):
        p, o, i = live_example()
        stop, tp = o
        r1 = self.run_rc(p, [tp], [], i, now=NOW, naked_since={})
        self.assertEqual(r1["nakedSince"], {str(SPY): NOW})
        r2 = self.run_rc(p, [tp], [], i, now=NOW + 90, naked_since=r1["nakedSince"])
        self.assertEqual(r2["nakedSince"], {str(SPY): NOW})
        self.assertEqual(r2["positions"][0]["nakedSince"], NOW)
        self.assertEqual(r2["positions"][0]["nakedForS"], 90.0)
        # Still unprotected but now UNDERSIZED-equivalent (DAY stop) keeps the earliest timestamp.
        r3 = self.run_rc(p, [dict(stop, tif="DAY"), tp], [], i, now=NOW + 120, naked_since=r2["nakedSince"])
        self.assertEqual(r3["positions"][0]["bracket"]["status"], "NOT_GTC")
        self.assertEqual(r3["nakedSince"], {str(SPY): NOW})
        self.assertEqual(r3["positions"][0]["nakedForS"], 120.0)
        # Protected again → reset.
        r4 = self.run_rc(p, [stop, tp], [], i, now=NOW + 150, naked_since=r3["nakedSince"])
        self.assertEqual(r4["nakedSince"], {})
        self.assertIsNone(r4["positions"][0]["nakedSince"])
        # Naked again later → a fresh timestamp.
        r5 = self.run_rc(p, [tp], [], i, now=NOW + 300, naked_since=r4["nakedSince"])
        self.assertEqual(r5["nakedSince"], {str(SPY): NOW + 300})

    def test_naked_since_drops_vanished_and_stop_only_counts_as_protected(self):
        p, o, i = live_example()
        rep = self.run_rc(p, o[:1], [], i, naked_since={str(SPY): NOW - 50, "999": NOW - 500})
        self.assertEqual(rep["nakedSince"], {})  # STOP_ONLY is protected; 999 no longer held
        self.assertIsNone(rep["positions"][0]["nakedForS"])

    def test_naked_since_input_not_mutated(self):
        p, o, i = live_example()
        ns = {str(SPY): NOW - 10}
        rep = self.run_rc(p, o, [], i, naked_since=ns)
        self.assertEqual(ns, {str(SPY): NOW - 10})
        self.assertEqual(rep["nakedSince"], {})

    # ── general ──────────────────────────────────────────────────────
    def test_inputs_not_mutated(self):
        p, o, i = live_example()
        ex = [execution("E1", 14, "BOT", 1, "rehearsal-145646")]
        snap = copy.deepcopy((p, o, ex, i))
        self.run_rc(p, o, ex, i)
        self.assertEqual((p, o, ex, i), snap)

    def test_zero_positions_and_done_orders_ignored(self):
        p, o, i = live_example()
        rep = self.run_rc(p + [pos("QQQ", qty=0, con=2)], o + [order(99, "BUY", 1, "LMT", ref="", status="Cancelled")], [], i)
        self.assertTrue(rep["ok"], rep["drift"])
        self.assertEqual(rep["counts"]["positions"], 1)
        self.assertEqual(rep["counts"]["orders"], 2)

    def test_empty_everything_ok(self):
        rep = self.run_rc([], [], [], [])
        self.assertEqual(rep, {"ok": True, "at": NOW, "positions": [], "orders": [], "drift": [], "nakedSince": {},
                               "counts": {"positions": 0, "orders": 0, "drift": 0, "warn": 0}})

    def test_live_example_real_adapter_shape_remaining_zero(self):
        # ib_async reports remaining 0 before the first orderStatus; the stop must still count.
        p, o, i = live_example()
        o = [dict(x, remaining=0.0) for x in o]
        rep = self.run_rc(p, o, [], i)
        self.assertTrue(rep["ok"], rep["drift"])
        self.assertEqual(rep["positions"][0]["bracket"]["status"], "PROTECTED")

    # ── review fixes: fail closed / order-id scoping ─────────────────
    def test_malformed_position_is_drift_not_dropped(self):
        for bad in (None, "abc", float("nan"), float("inf")):
            p = [pos(qty=1)]
            p[0]["position"] = bad
            rep = self.run_rc(p, live_example()[1], [], live_example()[2], naked_since={str(SPY): NOW - 100})
            self.assertFalse(rep["ok"], bad)
            self.assertIn("MALFORMED_DATA", codes(rep), bad)
            d = next(x for x in rep["drift"] if x["code"] == "MALFORMED_DATA")
            self.assertEqual((d["severity"], d["ref"]), ("drift", str(SPY)))
            # a bad read must not reset the unprotected timer
            self.assertEqual(rep["nakedSince"], {str(SPY): NOW - 100}, bad)

    def test_naked_since_non_finite_prev_never_resets_or_poisons(self):
        p, o, i = live_example()
        for bad in (float("nan"), "garbage", None):
            rep = self.run_rc(p, o[1:], [], i, naked_since={str(SPY): bad})
            row = rep["positions"][0]
            self.assertEqual(row["bracket"]["status"], "NAKED")
            self.assertTrue(row["nakedSince"] == row["nakedSince"] and row["nakedSince"] <= NOW, bad)  # finite, not NaN
            self.assertGreaterEqual(row["nakedForS"], 0.0)
        # a future timestamp (clock skew) is clamped to now
        rep = self.run_rc(p, o[1:], [], i, naked_since={str(SPY): NOW + 500})
        self.assertEqual(rep["nakedSince"], {str(SPY): NOW})

    def test_order_id_collision_across_clients_does_not_borrow_a_stop_role(self):
        # Client 23's BUY #15 and client 13's STP #15 share an id. Position 2, only 1 share is stopped.
        p = [pos(qty=2)]
        i = [intent("big-intent-002", qty=2, orders=[14, 15, 16])]
        orders = [order(15, "BUY", 1, "LMT", limit=700, tif="DAY", ref="CLI-add", client=23),
                  order(15, "SELL", 1, "STP", stop=712, ref="big-intent-002", parent=14),
                  order(16, "SELL", 2, "LMT", limit=730, ref="big-intent-002", parent=14)]
        b = rc.bracket_status(p[0], orders)
        self.assertEqual(b["status"], "UNDERSIZED")
        self.assertEqual(b["stopQty"], 1.0)
        rep = self.run_rc(p, orders, [], i)
        self.assertIn("NAKED_POSITION", codes(rep))
        self.assertEqual([x["role"] for x in rep["orders"]], ["entry", "stop", "take_profit"])
        self.assertEqual(rc.order_roles(p, orders), ["entry", "stop", "take_profit"])

    def test_classify_orders_collision_prefers_protective_role(self):
        # So cancel_entries never cancels a stop and a liquidation cancels too much rather than too little.
        p = [pos(qty=1)]
        for orders in ([order(15, "BUY", 1, "LMT", ref="CLI-x", client=23), order(15, "SELL", 1, "STP", stop=712, ref="r", parent=14)],
                       [order(15, "SELL", 1, "STP", stop=712, ref="r", parent=14), order(15, "BUY", 1, "LMT", ref="CLI-x", client=23)]):
            self.assertEqual(rc.classify_orders(p, orders)[15], "stop")

    def test_parent_of_another_client_does_not_make_live_stop_pending(self):
        # Client 13's stop #21 has parent #20 (filled). Client 23 happens to have a working #20 (another symbol).
        p = [pos(qty=1)]
        orders = [order(20, "BUY", 5, "LMT", con=2, symbol="QQQ", limit=400, tif="DAY", ref="CLI-q", client=23),
                  order(21, "SELL", 1, "STP", stop=712, ref="rehearsal-145646", parent=20),
                  order(22, "SELL", 1, "LMT", limit=719.8, ref="rehearsal-145646", parent=20)]
        self.assertEqual(rc.classify_orders(p, orders)[21], "stop")
        self.assertEqual(rc.bracket_status(p[0], orders)["status"], "PROTECTED")
        # but the same-client working parent still makes them pending
        same = [dict(orders[0], clientId=13)] + orders[1:]
        self.assertEqual(rc.order_roles(p, same)[1:], ["pending_child", "pending_child"])
        # an order without a clientId cannot be scoped: any working parent id counts (fail closed)
        nocid = [orders[0], dict(orders[1], clientId=None)]
        self.assertEqual(rc.order_roles(p, nocid)[1], "pending_child")

    def test_parent_id_collision_in_expected_positions_and_orphan(self):
        p, o, i = live_example()
        # Another client's working #14 (not the desk's entry) must not make the desk expect 0.
        other = order(14, "BUY", 1, "LMT", con=2, symbol="QQQ", limit=400, tif="DAY", ref="CLI-q", client=23)
        rep = self.run_rc(p, o + [other], [], i)
        self.assertNotIn("QTY_MISMATCH", codes(rep))
        self.assertEqual(rep["positions"][0]["expectedQty"], 1.0)
        # ... and must not hide an orphan intent
        ghost = intent("ghost-intent-02", symbol="IWM", qty=3, orders=[90], con=3)
        stranger = order(90, "BUY", 1, "LMT", con=2, symbol="QQQ", limit=400, tif="DAY", ref="CLI-q2", client=23)
        rep = self.run_rc(p, o + [stranger], [], i + [ghost])
        self.assertIn("ORPHAN_INTENT", codes(rep))
        # the desk's own working parent (same ref) still counts as not filled yet
        mine = order(90, "BUY", 3, "LMT", con=3, symbol="IWM", limit=200, tif="DAY", ref="ghost-intent-02")
        rep = self.run_rc(p, o + [mine], [], i + [ghost])
        self.assertNotIn("ORPHAN_INTENT", codes(rep))
        self.assertNotIn("QTY_MISMATCH", codes(rep))

    def test_pending_cancel_stop_is_not_protection(self):
        p, o, i = live_example()
        o = [dict(o[0], status="PendingCancel"), o[1]]
        rep = self.run_rc(p, o, [], i)
        self.assertEqual(rep["positions"][0]["bracket"]["status"], "NAKED")
        self.assertIn("NAKED_POSITION", codes(rep))
        self.assertFalse(rep["ok"])

    def test_fully_filled_but_still_listed_stop_covers_nothing(self):
        p, o, i = live_example()
        o = [dict(o[0], filled=1.0, remaining=0.0), o[1]]
        self.assertEqual(rc.bracket_status(p[0], o)["status"], "NAKED")
        o2 = [dict(o[0], filled=5.0), o[1]]  # over-reported fill never goes negative
        self.assertEqual(rc.bracket_status(p[0], o2)["stopQty"], 0.0)

    def test_malformed_stop_quantity_is_no_coverage(self):
        p, o, i = live_example()
        for bad in (float("nan"), None, "x", float("inf")):
            b = rc.bracket_status(p[0], [dict(o[0], quantity=bad), o[1]])
            self.assertEqual(b["status"], "NAKED", bad)
            self.assertEqual(b["stopQty"], 0.0)

    def test_bracket_status_malformed_position_is_naked(self):
        p, o, _ = live_example()
        for bad in (float("nan"), None, "abc"):
            self.assertEqual(rc.bracket_status(dict(p[0], position=bad), o)["status"], "NAKED", bad)

    def test_stock_intent_does_not_track_option_on_same_underlying(self):
        p, o, i = live_example()
        opt = pos("SPY   261218P00650000", qty=1, con=555, sec="OPT", underlying="SPY", avg=300)
        rep = self.run_rc(p + [opt], o, [], i)
        self.assertEqual(codes(rep), ["UNTRACKED_POSITION"])
        self.assertEqual(rep["drift"][0]["ref"], "555")
        # an orphaned stock intent is not hidden by an option on its underlying
        rep = self.run_rc([opt], [], [], [intent("stk-intent-009", orders=[90])])
        self.assertIn("ORPHAN_INTENT", codes(rep))

    def test_option_intent_from_desk_intent_json(self):
        opt = pos("SPY   261218C00700000", qty=2, con=555, sec="OPT", underlying="SPY", avg=350)
        oi = intent("opt-intent-002", qty=2, orders=[70, 71], con=555)
        oi["intent"] = '{"intent_id": "opt-intent-002", "symbol": "SPY", "sec_type": "OPT"}'
        tp = order(71, "SELL", 2, "LMT", con=555, symbol=opt["symbol"], limit=6.0, ref="opt-intent-002", sec="OPT")
        rep = self.run_rc([opt], [tp], [], [oi])
        self.assertTrue(rep["ok"], rep["drift"])
        self.assertEqual(rep["positions"][0]["intents"], ["opt-intent-002"])
        oi["intent"] = {"sec_type": "BAG"}
        self.assertTrue(self.run_rc([opt], [tp], [], [oi])["ok"])

    def test_entry_detected_by_side_when_exec_order_id_differs(self):
        # Today's entry fill is reported with another orderId (e.g. read by a different client); the
        # stop then filled. Net 0, not +1 from assuming the entry happened on an earlier day.
        i = [intent("rehearsal-145646", orders=[14, 15, 16])]
        ex = [execution("E1", 0, "BOT", 1, "rehearsal-145646"), execution("E2", 15, "SLD", 1, "rehearsal-145646", price=712)]
        self.assertEqual(rc.expected_positions(i, [], ex), {"SPY": 0.0})
        rep = self.run_rc([], [], ex, i)
        self.assertTrue(rep["ok"], rep["drift"])
        # short intent mirrors it
        si = [intent("short-intent-1", action="SELL", orders=[30, 31, 32])]
        self.assertEqual(rc.expected_positions(si, [], [execution("E3", 31, "BOT", 1, "short-intent-1")]), {"SPY": 0.0})
        self.assertEqual(rc.expected_positions(si, [], [execution("E4", 0, "SLD", 1, "short-intent-1")]), {"SPY": -1.0})

    def test_live_example_partial_take_profit_fill_today(self):
        # Entry yesterday, TP partially filled today on a 1-lot is impossible; use a 10-lot: 4 sold today.
        p = [pos(qty=6)]
        i = [intent("ten-intent-001", qty=10, orders=[14, 15, 16])]
        o = [order(15, "SELL", 10, "STP", stop=712, ref="ten-intent-001", parent=14),
             order(16, "SELL", 10, "LMT", limit=719.8, ref="ten-intent-001", parent=14, filled=4)]
        ex = [execution("E1", 16, "SLD", 4, "ten-intent-001", price=719.8)]
        rep = self.run_rc(p, o, ex, i)
        self.assertNotIn("QTY_MISMATCH", codes(rep))
        self.assertEqual(rep["positions"][0]["expectedQty"], 6.0)
        # OCA: TWS reduces the stop to 6 as well; until then the 10-lot stop over-hedges the 6 shares
        self.assertEqual(codes(rep), ["OVER_HEDGED"])
        rep = self.run_rc(p, [dict(o[0], quantity=6.0, remaining=6.0), o[1]], ex, i)
        self.assertTrue(rep["ok"], rep["drift"])

    def test_no_code_fires_on_clean_short(self):
        p = [pos(qty=-3)]
        i = [intent("short-intent-2", action="SELL", qty=3, orders=[40, 41, 42])]
        o = [order(41, "BUY", 3, "STP", stop=730, ref="short-intent-2", parent=40),
             order(42, "BUY", 3, "LMT", limit=700, ref="short-intent-2", parent=40)]
        rep = self.run_rc(p, o, [execution("E1", 40, "SLD", 3, "short-intent-2")], i)
        self.assertEqual(rep["drift"], [])
        self.assertEqual(rep["positions"][0]["bracket"]["status"], "PROTECTED")
        self.assertEqual(rep["positions"][0]["expectedQty"], -3.0)

    def test_drift_item_shape_and_counts(self):
        p, _, i = live_example()
        rep = self.run_rc(p, [order(77, "BUY", 1, "LMT", ref="", client=0)], None, i)
        for d in rep["drift"]:
            self.assertEqual(set(d), {"code", "severity", "symbol", "ref", "detail"})
            self.assertIn(d["severity"], ("drift", "warn"))
            self.assertIsInstance(d["detail"], str)
        self.assertEqual(sorted(codes(rep)), ["EXECUTIONS_UNAVAILABLE", "NAKED_POSITION", "PHANTOM_ORDER"])
        self.assertEqual(rep["counts"], {"positions": 1, "orders": 1, "drift": 2, "warn": 1})
        self.assertFalse(rep["ok"])


if __name__ == "__main__":
    unittest.main()
