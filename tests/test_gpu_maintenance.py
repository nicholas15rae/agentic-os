"""The GPU maintenance window (A3, Model Lab compare): while the desktop's GPU lease holder starts
"maintenance" (`maintenance · model compare`, a bench, a reload), the model loaded on Bionic may
be one under test, so the gateway's own LLM users hold back:

  * command_center_api: `gpu_maintenance()` / `gpu_state()["maintenance"]`; `llm_chat` raises
    GpuMaintenance instead of answering on whatever is loaded (even with gpu_wait=0, the trading
    analyst's call); an ordinary busy lease keeps today's behaviour.
  * language hub /llm answers 503 during the window (its gpu_busy check).
  * gateway Tony: an eligible phone turn is claimed at POST even with the desktop present and
    answered at once with MAINTENANCE_LINE, with no load and no generation; a window that opens
    during a cold load stops it; with no window the desktop still gets its turn.

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
from test_gateway_tony import TONY, FakeBionic, TonyEnv, result_of  # noqa: E402
from test_os_inbox import GatewayCase, until  # noqa: E402

import command_center_api as cc  # noqa: E402
import gateway_tony as gt  # noqa: E402
import os_api  # noqa: E402

HOLDER = "maintenance · model compare"


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


if __name__ == "__main__":
    unittest.main()
