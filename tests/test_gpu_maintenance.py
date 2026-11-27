"""The GPU maintenance window (A3, Model Lab compare): while the desktop's GPU lease holder starts
"maintenance" (`maintenance · model compare`, a bench, a reload), the model loaded on Bionic may
be one under test, so the gateway's own LLM users hold back:

  * command_center_api: `gpu_maintenance()` / `gpu_state()["maintenance"]`; `llm_chat` raises
    GpuMaintenance instead of answering on whatever is loaded (even with gpu_wait=0, the trading
    analyst's call); an ordinary busy lease keeps today's behaviour.
  * language hub /llm answers 503 during the window (its gpu_busy check).
  * gateway Tony, during a model TEST (`testing_window`: the compare's "maintenance · model
    compare", a "maintenance · bench …"): an eligible phone turn is claimed at POST even with the
    desktop present and answered at once with MAINTENANCE_LINE, with no load and no generation; a
    test that starts during a cold load stops it; with no window the desktop still gets its turn.
  * gateway Tony, during any other maintenance holder (a short reload, "maintenance · local fit"):
    a desktop that is here keeps its turn; a turn the gateway holds waits for the window to clear
    (bounded) and is then answered normally, or gets HOLD_LINE; no load request meanwhile.

No real model server is contacted (the FakeBionic stub from test_gateway_tony).

Run with: python -m pytest tests/test_gpu_maintenance.py -q -p no:cacheprovider
"""
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_gateway_tony import ROOT, TONY, FakeBionic, TonyEnv, result_of, rust_const  # noqa: E402
from test_os_inbox import GatewayCase, until  # noqa: E402

import command_center_api as cc  # noqa: E402
import gateway_tony as gt  # noqa: E402
import os_api  # noqa: E402

HOLDER = "maintenance · model compare"
RELOAD = "maintenance · local fit"  # services.rs local_fit_once: a short reload, not a model test
BENCH = "maintenance · bench qwen/qwen3.5-9b"  # modellab.rs model_bench
RUST_CMDS = ROOT / "command center" / "src-tauri" / "src" / "commands"


class HolderTests(unittest.TestCase):
    def tearDown(self):
        cc.gpu_set(False)

    def test_only_a_compare_or_a_bench_is_a_model_test(self):
        for h in (HOLDER, BENCH, "Maintenance · Model Compare", "maintenance: bench x", "maintenance · bench"):
            self.assertTrue(gt.testing_holder(h), h)
        for h in (RELOAD, "maintenance · reload", "maintenance", "maintenance · local fit (qwen)", "lmstudio · Tony (streaming)", "", None, "bench · maintenance"):
            self.assertFalse(gt.testing_holder(h), h)

    def test_the_holders_match_the_rust_labels(self):
        # compare.rs HOLDER is what its slot and its gateway lease carry; the bench and the local-fit
        # reload are labelled in modellab.rs / services.rs (acquire_maintenance adds "maintenance · ").
        self.assertEqual(rust_const(RUST_CMDS / "modellab" / "compare.rs", "HOLDER"), HOLDER)
        self.assertEqual("maintenance · " + rust_const(RUST_CMDS / "modellab" / "compare.rs", "SLOT_LABEL"), HOLDER)
        self.assertIn('acquire_maintenance(&format!("bench {}"', (RUST_CMDS / "modellab.rs").read_text(encoding="utf-8"))
        self.assertIn('acquire_maintenance("local fit"', (RUST_CMDS / "services.rs").read_text(encoding="utf-8"))
        self.assertTrue(gt.testing_holder(HOLDER))

    def test_testing_window_needs_a_live_test_lease(self):
        cc.gpu_set(True, HOLDER, time.time() + 60)
        self.assertTrue(gt.testing_window())
        cc.gpu_set(True, RELOAD, time.time() + 60)
        self.assertTrue(cc.gpu_maintenance(), "a reload is still a maintenance window (no generation during it)")
        self.assertFalse(gt.testing_window(), "but not a model test")
        cc.gpu_set(True, HOLDER, time.time() - 1, now=time.time() - 40)
        self.assertFalse(gt.testing_window(), "a lapsed lease is no window")
        cc.gpu_set(False)
        self.assertFalse(gt.testing_window())


class LeaseTests(unittest.TestCase):
    def tearDown(self):
        cc.gpu_set(False)

    def test_a_maintenance_holder_marks_the_window(self):
        cc.gpu_set(True, HOLDER, 1600.0, now=1000.0)
        self.assertTrue(cc.gpu_maintenance(now=1500.0))
        self.assertTrue(cc.gpu_state(now=1500.0)["maintenance"])
        self.assertFalse(cc.gpu_maintenance(now=1600.1), "a lapsed lease is no window")
        cc.gpu_set(True, "Maintenance · local fit", None, now=1000.0)
        self.assertTrue(cc.gpu_maintenance(now=1010.0), "any maintenance holder, any case")
        cc.gpu_set(True, "lmstudio · Tony (streaming)", 1600.0, now=1000.0)
        self.assertTrue(cc.gpu_busy(now=1500.0))
        self.assertFalse(cc.gpu_maintenance(now=1500.0), "a generation is no maintenance")
        self.assertFalse(cc.gpu_state(now=1500.0)["maintenance"])
        cc.gpu_set(False, HOLDER)
        self.assertFalse(cc.gpu_maintenance())
        self.assertFalse(cc.gpu_state()["maintenance"])

    def test_llm_chat_never_runs_during_a_window(self):
        cc.gpu_set(True, HOLDER, time.time() + 60)
        with mock.patch.object(cc, "_http_json") as http:
            for wait in (0, 0.05):
                with self.assertRaises(cc.GpuMaintenance):
                    cc.llm_chat([{"role": "user", "content": "hi"}], model="m", gpu_wait=wait)
            http.assert_not_called()
        self.assertTrue(issubclass(cc.GpuMaintenance, RuntimeError), "callers that catch Exception skip")

    def test_an_ordinary_lease_still_goes_ahead_after_its_wait(self):
        cc.gpu_set(True, "lmstudio · Tony (streaming)", time.time() + 60)
        with mock.patch.object(cc, "_http_json", return_value={"choices": [{"message": {"content": "ok"}}]}) as http:
            self.assertEqual(cc.llm_chat([{"role": "user", "content": "hi"}], model="m", gpu_wait=0.05), "ok")
            http.assert_called_once()

    def test_the_language_hub_answers_503_during_a_window(self):
        import language_hub_api
        from fastapi import HTTPException

        cc.gpu_set(True, HOLDER, time.time() + 60)
        with mock.patch.object(cc, "_http_json") as http:
            with self.assertRaises(HTTPException) as e:
                language_hub_api.llm({"system": "s", "prompt": "p"})
            self.assertEqual(e.exception.status_code, 503)
            http.assert_not_called()


class MaintenanceFlowTests(GatewayCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.fake = FakeBionic()
        cls.env = TonyEnv(cls.fake).__enter__()

    @classmethod
    def tearDownClass(cls):
        gt.stop()
        cc.gpu_set(False)
        cls.env.__exit__(None, None, None)
        cls.fake.close()
        super().tearDownClass()

    def setUp(self):
        gt.stop()
        cc.gpu_set(False)
        self.iso.sql("DELETE FROM os_queue")
        os_api._DESKTOP_SEEN.update(at=time.time(), resultAt=0.0)  # the desktop app IS here
        os_api._configure_gateway_tony()
        self.fake.reset()
        gt.forget_loads()
        self.env.providers()
        self.env.os_state()
        cc.save_config({**cc.load_config(), "gatewayTony": {"enabled": True}})
        gt.start()

    def tearDown(self):
        cc.gpu_set(False)
        if self.fake.gate is not None:
            self.fake.gate.set()
        gt.stop()

    def post(self, text="how's it going?"):
        s, d = self.api("POST", "/api/os/inbox", {"kind": "turn", "payload": {"text": text, "role": "general"}})
        self.assertEqual(s, 200, d)
        return d

    def wait_done(self, qid, timeout=10):
        until(lambda: result_of(self.iso, qid)["status"] not in ("pending", "running"), timeout=timeout, what=f"{qid} finished")
        return result_of(self.iso, qid)

    def test_a_phone_turn_in_a_window_gets_the_line_at_once_even_with_the_desktop_here(self):
        s, _ = self.api("PUT", "/api/os/gpu", {"busy": True, "holder": HOLDER, "until": time.time() + 120})
        self.assertEqual(s, 200)
        self.assertTrue(self.api("GET", "/api/os/gpu")[1]["maintenance"])
        d = self.post()
        self.assertEqual((d["status"], d.get("claimedBy")), ("running", "gateway"), "claimed at POST: the desktop would only queue it")
        r = self.wait_done(d["id"])
        res = r["result"]["result"]
        self.assertEqual((res["answer"], res["answeredBy"], res["reason"]), (gt.MAINTENANCE_LINE, "gateway", "gpu-maintenance"))
        self.assertEqual(self.fake.chat_calls, [], "no generation on a model under test")
        self.assertEqual(self.fake.load_calls, [], "never a parallel cold load of Tony's model")
        self.assertEqual(self.fake.v0_calls, 0, "not even a model-state poll")

    def test_a_cold_model_is_never_loaded_during_a_window(self):
        os_api._DESKTOP_SEEN["at"] = 0.0  # desktop gone too
        self.fake.models[TONY] = "not-loaded"
        cc.gpu_set(True, HOLDER, time.time() + 120)
        r = self.wait_done(self.post()["id"])
        self.assertEqual(r["result"]["result"]["answer"], gt.MAINTENANCE_LINE)
        self.assertEqual(self.fake.load_calls, [])
        self.assertEqual(self.fake.chat_calls, [])

    def test_a_window_that_opens_during_a_cold_load_stops_it(self):
        os_api._DESKTOP_SEEN["at"] = 0.0
        self.fake.models[TONY] = "not-loaded"
        self.fake.load_gate = threading.Event()  # the load stays in flight
        self.fake.on_load = lambda: cc.gpu_set(True, HOLDER, time.time() + 120)
        r = self.wait_done(self.post()["id"])
        res = r["result"]["result"]
        self.assertEqual((res["answer"], res["reason"], res["coldLoad"]), (gt.MAINTENANCE_LINE, "gpu-maintenance", True))
        self.assertEqual(res["streamPrefix"], gt.WAKING_LINE + " ")
        self.assertEqual(r["partial"], gt.WAKING_LINE + " " + gt.MAINTENANCE_LINE, "the phone hears the waking line, then the window line")
        self.assertEqual(self.fake.chat_calls, [])
        self.assertEqual(len(self.fake.load_calls), 1, "no second load request")

    def test_without_a_window_the_desktop_still_gets_its_turn(self):
        cc.gpu_set(True, "lmstudio · Tony (streaming)", time.time() + 120)  # a generation, not maintenance
        d = self.post()
        self.assertEqual(d["status"], "pending")
        self.assertNotIn("claimedBy", d)
        time.sleep(0.4)
        self.assertEqual(result_of(self.iso, d["id"])["status"], "pending")
        self.assertEqual(self.fake.chat_calls, [])

    def test_the_watchdog_takes_a_waiting_turn_once_a_window_opens(self):
        d = self.post()
        self.assertEqual(d["status"], "pending", "desktop here, no window: its turn")
        cc.gpu_set(True, HOLDER, time.time() + 120)
        r = self.wait_done(d["id"])
        self.assertEqual(r["result"]["result"]["answer"], gt.MAINTENANCE_LINE)
        self.assertEqual(self.fake.chat_calls, [])

    # ── a model test vs a short reload ──────────────────────────────────────────

    def clear_window_after(self, secs, holder=None):
        """Clear the lease (or hand it to `holder`) `secs` from now, from another thread."""
        def go():
            time.sleep(secs)
            if holder:
                cc.gpu_set(True, holder, time.time() + 120)
            else:
                cc.gpu_set(False)
        t = threading.Thread(target=go, daemon=True)
        t.start()
        return t

    def test_a_bench_is_a_model_test_too(self):
        cc.gpu_set(True, BENCH, time.time() + 120)
        d = self.post()
        self.assertEqual((d["status"], d.get("claimedBy")), ("running", "gateway"))
        res = self.wait_done(d["id"])["result"]["result"]
        self.assertEqual((res["answer"], res["reason"]), (gt.MAINTENANCE_LINE, "gpu-maintenance"))
        self.assertEqual(self.fake.chat_calls, [])

    def test_a_short_reload_leaves_the_turn_to_a_desktop_that_is_here(self):
        cc.gpu_set(True, RELOAD, time.time() + 120)
        d = self.post()
        self.assertEqual(d["status"], "pending", "the desktop answers it once its reload is done")
        self.assertNotIn("claimedBy", d)
        time.sleep(0.6)  # past WATCHDOG_MIN_AGE_SECS: the watchdog leaves it too
        self.assertEqual(result_of(self.iso, d["id"])["status"], "pending")
        self.assertEqual(self.fake.chat_calls, [])

    def test_a_short_reload_is_waited_out_then_answered_normally(self):
        os_api._DESKTOP_SEEN["at"] = 0.0  # the desktop isn't working the inbox
        cc.gpu_set(True, RELOAD, time.time() + 120)
        with mock.patch.object(gt, "MAINTENANCE_POLL_SECS", 0.05):
            self.clear_window_after(0.6)
            d = self.post()
            self.assertEqual((d["status"], d.get("claimedBy")), ("running", "gateway"))
            time.sleep(0.3)
            self.assertEqual(self.fake.chat_calls, [], "no generation while the reload holds the GPU")
            r = self.wait_done(d["id"])
        res = r["result"]["result"]
        self.assertEqual(res["answer"], "Hey Nic. All good here.", "a normal answer, not the testing line")
        self.assertNotIn(res.get("reason") or "", ("gpu-maintenance", "gpu-maintenance-wait"))
        self.assertEqual(len(self.fake.chat_calls), 1)
        self.assertEqual(self.fake.load_calls, [])

    def test_a_reload_that_outlasts_the_wait_gets_the_one_moment_line(self):
        os_api._DESKTOP_SEEN["at"] = 0.0
        cc.gpu_set(True, RELOAD, time.time() + 120)
        with mock.patch.object(gt, "MAINTENANCE_POLL_SECS", 0.05), mock.patch.object(gt, "MAINTENANCE_WAIT_SECS", 0.5):
            t0 = time.time()
            r = self.wait_done(self.post()["id"])
        res = r["result"]["result"]
        self.assertEqual((res["answer"], res["reason"], res["answeredBy"]), (gt.HOLD_LINE, "gpu-maintenance-wait", "gateway"))
        self.assertGreaterEqual(time.time() - t0, 0.5, "it waited for the window first")
        self.assertEqual((self.fake.chat_calls, self.fake.load_calls, self.fake.v0_calls), ([], [], 0), "no model call, no load, not even a state poll")
        self.assertNotEqual(gt.HOLD_LINE, gt.MAINTENANCE_LINE)

    def test_a_reload_that_turns_into_a_model_test_gets_the_testing_line(self):
        os_api._DESKTOP_SEEN["at"] = 0.0
        cc.gpu_set(True, RELOAD, time.time() + 120)
        with mock.patch.object(gt, "MAINTENANCE_POLL_SECS", 0.05):
            self.clear_window_after(0.4, holder=HOLDER)
            r = self.wait_done(self.post()["id"])
        res = r["result"]["result"]
        self.assertEqual((res["answer"], res["reason"]), (gt.MAINTENANCE_LINE, "gpu-maintenance"))
        self.assertEqual(self.fake.chat_calls, [])

    def test_a_cold_load_never_asks_for_a_load_during_a_reload(self):
        os_api._DESKTOP_SEEN["at"] = 0.0
        self.fake.models[TONY] = "not-loaded"
        window_at_load = []
        self.fake.on_load = lambda: window_at_load.append(cc.gpu_maintenance())
        # The reload starts once the waking line is out (mid cold load) and lasts 0.5 s.
        with mock.patch.object(gt, "MAINTENANCE_POLL_SECS", 0.05):
            orig_wake = gt._Turn.wake

            def wake_then_reload(turn):
                orig_wake(turn)
                cc.gpu_set(True, RELOAD, time.time() + 120)
                self.clear_window_after(0.5)

            with mock.patch.object(gt._Turn, "wake", wake_then_reload):
                r = self.wait_done(self.post()["id"])
        res = r["result"]["result"]
        self.assertEqual(res["answer"], "Hey Nic. All good here.", res)
        self.assertTrue(res["coldLoad"])
        self.assertEqual(window_at_load, [False], "one load request, made only after the reload ended")
        self.assertEqual(len(self.fake.chat_calls), 1)

    def reload_after_the_warm_check(self, leaves):
        """A reload ("local fit") opens right after the warm model_state check, leaves Tony's model
        `leaves` ('not-loaded': its reload failed; 'loaded': it worked) and clears 0.3 s later.
        Returns (the result, Tony's model state at each generation, the window at each load request)."""
        os_api._DESKTOP_SEEN["at"] = 0.0  # the desktop isn't working the inbox: the gateway answers
        orig_state, orig_stream = gt.model_state, cc.llm_stream
        fired, state_at_chat, window_at_load = [], [], []

        def model_state(root, model):
            s = orig_state(root, model)
            if not fired and s == "loaded":
                fired.append(1)
                cc.gpu_set(True, RELOAD, time.time() + 120)  # local fit: unload, then its reload
                with self.fake.lock:
                    self.fake.models[TONY] = leaves
                self.clear_window_after(0.3)  # the slot is released (whatever its reload did)
            return s

        def llm_stream(*a, **k):
            state_at_chat.append(self.fake.models.get(TONY))
            return orig_stream(*a, **k)

        self.fake.on_load = lambda: window_at_load.append(cc.gpu_maintenance())
        with mock.patch.object(gt, "model_state", model_state), mock.patch.object(cc, "llm_stream", llm_stream), \
                mock.patch.object(gt, "MAINTENANCE_POLL_SECS", 0.05):
            r = self.wait_done(self.post()["id"])
        self.assertEqual(fired, [1], "the reload began after the warm check")
        return r["result"]["result"], state_at_chat, window_at_load

    def test_a_reload_that_leaves_the_model_unloaded_is_cold_loaded_never_streamed_to(self):
        # Before the fix: the pre-generation wait ended and the turn streamed to the unloaded model
        # (chat 1, load 0), which on real Bionic JIT-loads it at its saved defaults (123k x 4).
        res, state_at_chat, window_at_load = self.reload_after_the_warm_check("not-loaded")
        self.assertEqual(state_at_chat, ["loaded"], "no generation while Tony's model isn't loaded")
        self.assertEqual(self.fake.load_calls, [gt.load_body(TONY)], "one load, at LOAD_CONTEXT x LOAD_PARALLEL")
        self.assertEqual((self.fake.load_calls[0]["context_length"], self.fake.load_calls[0]["parallel"]), (32768, 2))
        self.assertEqual(window_at_load, [False], "requested only once the reload's window had cleared")
        self.assertEqual((res["answer"], res["coldLoad"]), ("Hey Nic. All good here.", True), res)
        self.assertEqual(res["streamPrefix"], gt.WAKING_LINE + " ", "the waking line once, then the answer")

    def test_a_reload_that_puts_the_model_back_is_answered_warm(self):
        res, state_at_chat, _ = self.reload_after_the_warm_check("loaded")
        self.assertEqual(state_at_chat, ["loaded"])
        self.assertEqual(self.fake.load_calls, [], "the model is back: no load request")
        self.assertEqual((res["answer"], res["coldLoad"]), ("Hey Nic. All good here.", False), res)


if __name__ == "__main__":
    unittest.main()
