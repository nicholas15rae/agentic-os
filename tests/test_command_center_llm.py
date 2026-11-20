"""Gateway local-LLM link: the :1235 default (env override), loaded-model pinning, health
against a stub LM Studio on a free port, and the cooperative GPU lease (/api/os/gpu).

No real model server is contacted: a stdlib stub stands in for LM Studio.

Run with: python3 tests/run_all.py  (or: python3 tests/test_command_center_llm.py)
"""
import json
import socket
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_os_inbox import GatewayCase, IsolatedCC  # noqa: E402

import command_center_api as cc  # noqa: E402

LOADED = "qwen/qwen3.5-9b"


class StubLMStudio:
    """/v1/models lists a big unloaded model first; /api/v0/models says which one is loaded;
    /v1/chat/completions records the model it was asked for and answers with JSON."""

    def __init__(self, v0=True):
        self.calls = []
        self.v0 = v0
        stub = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, code, obj):
                raw = json.dumps(obj).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_GET(self):
                if self.path == "/v1/models":
                    return self._send(200, {"data": [{"id": "qwen2.5-coder-14b-instruct"}, {"id": LOADED}, {"id": "text-embedding-nomic-embed-text-v1.5"}]})
                if self.path == "/api/v0/models" and stub.v0:
                    return self._send(200, {"data": [
                        {"id": "qwen2.5-coder-14b-instruct", "type": "llm", "state": "not-loaded"},
                        {"id": LOADED, "type": "vlm", "state": "loaded"},
                        {"id": "text-embedding-nomic-embed-text-v1.5", "type": "embeddings", "state": "not-loaded"},
                    ]})
                return self._send(404, {"error": "nope"})

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                stub.calls.append(body)
                if self.path == "/v1/chat/completions":
                    return self._send(200, {"choices": [{"message": {"content": '{"title": "Stubbed"}'}}]})
                return self._send(404, {})

        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            self.port = s.getsockname()[1]
        self.srv = ThreadingHTTPServer(("127.0.0.1", self.port), H)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    @property
    def base(self):
        return f"http://127.0.0.1:{self.port}/v1"

    def close(self):
        self.srv.shutdown()
        self.srv.server_close()


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class DefaultsTests(unittest.TestCase):
    def test_default_base_url_is_the_lm_studio_port(self):
        self.assertEqual(cc.DEFAULT_LLM_BASE_URL, "http://127.0.0.1:1235/v1")
        self.assertEqual(cc._default_llm_base({}), "http://127.0.0.1:1235/v1")
        self.assertEqual(cc._default_llm_base({"CC_LLM_BASE_URL": "http://127.0.0.1:9999/v1"}), "http://127.0.0.1:9999/v1")
        self.assertEqual(cc._default_llm_base({"CC_LLM_BASE_URL": "not a url"}), "http://127.0.0.1:1235/v1")

    def test_cc_data_dir_env_is_honoured_in_a_fresh_process(self):
        import os
        import subprocess
        import tempfile
        d = tempfile.mkdtemp(prefix="agentic-os-ccdir-")
        root = Path(__file__).resolve().parent.parent
        out = subprocess.run(
            [sys.executable, "-c", "import command_center_api as cc; print(cc.CC_DIR); print(cc.DB_PATH)"],
            cwd=str(root), env={**os.environ, "CC_DATA_DIR": d, "CC_LLM_BASE_URL": ""}, capture_output=True, text=True, timeout=60,
        )
        import shutil
        shutil.rmtree(d, ignore_errors=True)
        self.assertEqual(out.returncode, 0, out.stderr)
        cc_dir, db_path = out.stdout.strip().splitlines()[-2:]
        self.assertEqual(Path(cc_dir), Path(d).resolve())
        self.assertEqual(Path(db_path), Path(d).resolve() / "cc.db")


class GpuLeaseTests(unittest.TestCase):
    def tearDown(self):
        cc.gpu_set(False)

    def test_flag_without_until_goes_stale_after_30s(self):
        cc.gpu_set(True, "pipeline", None, now=1000.0)
        self.assertTrue(cc.gpu_busy(now=1000.0))
        self.assertTrue(cc.gpu_busy(now=1029.9))
        self.assertFalse(cc.gpu_busy(now=1030.1))

    def test_until_is_honoured_but_capped(self):
        cc.gpu_set(True, "coder", 1600.0, now=1000.0)
        self.assertTrue(cc.gpu_busy(now=1500.0))
        self.assertFalse(cc.gpu_busy(now=1600.1))
        cc.gpu_set(True, "coder", 1_000_000.0, now=1000.0)  # crashed desktop with a silly lease
        self.assertTrue(cc.gpu_busy(now=1899.0))
        self.assertFalse(cc.gpu_busy(now=1900.1))
        cc.gpu_set(True, "coder", 1_600_000.0, now=1000.0)  # epoch milliseconds are accepted
        self.assertTrue(cc.gpu_busy(now=1500.0))

    def test_release_clears(self):
        cc.gpu_set(True, "x", None, now=time.time())
        self.assertTrue(cc.gpu_busy())
        cc.gpu_set(False)
        self.assertFalse(cc.gpu_busy())

    def test_wait_gpu_times_out_then_frees(self):
        cc.gpu_set(True, "x", time.time() + 60)
        t0 = time.time()
        self.assertFalse(cc.wait_gpu(0.3, poll=0.05))
        self.assertGreaterEqual(time.time() - t0, 0.25)
        cc.gpu_set(False)
        self.assertTrue(cc.wait_gpu(0.3, poll=0.05))

    def test_loopback_rule(self):
        req = lambda host, headers=None: SimpleNamespace(client=SimpleNamespace(host=host), headers=headers or {})  # noqa: E731
        self.assertTrue(cc.is_loopback_request(req("127.0.0.1")))
        self.assertTrue(cc.is_loopback_request(req("::1")))
        self.assertFalse(cc.is_loopback_request(req("100.64.3.4")))
        self.assertFalse(cc.is_loopback_request(req("127.0.0.1", {"x-forwarded-for": "1.2.3.4"})))
        self.assertFalse(cc.is_loopback_request(SimpleNamespace(client=None, headers={})))


class LlmGatewayTests(GatewayCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.stub = StubLMStudio()

    @classmethod
    def tearDownClass(cls):
        cls.stub.close()
        super().tearDownClass()

    def setUp(self):
        cc.gpu_set(False)
        cc._models_cache.clear()
        cc._loaded_cache.clear()
        self.stub.calls.clear()
        cc.save_config({"llm": {"baseUrl": self.stub.base}})

    def tearDown(self):
        cc.gpu_set(False)

    def test_health_ok_against_stub_port(self):
        s, d = self.api("GET", "/api/cc/health")
        self.assertEqual(s, 200, d)
        self.assertTrue(d["llm"]["ok"], d["llm"])
        self.assertEqual(d["llm"]["baseUrl"], self.stub.base)
        self.assertEqual(d["llm"]["loaded"], [LOADED])

    def test_health_reports_a_dead_port(self):
        cc.save_config({"llm": {"baseUrl": f"http://127.0.0.1:{_free_port()}/v1"}})
        s, d = self.api("GET", "/api/cc/health")
        self.assertEqual(s, 200)
        self.assertFalse(d["llm"]["ok"])
        self.assertTrue(d["llm"]["error"])

    def test_pick_model_prefers_the_loaded_one(self):
        self.assertEqual(cc._pick_model(""), LOADED)  # not the first listed (would JIT-load 14B)
        self.assertEqual(cc._pick_model("explicit-model"), "explicit-model")

    def test_pick_model_falls_back_without_v0(self):
        self.stub.v0 = False
        try:
            self.assertEqual(cc._pick_model(""), "qwen2.5-coder-14b-instruct")
            self.assertEqual(cc._pick_model("", "embed"), "text-embedding-nomic-embed-text-v1.5")
        finally:
            self.stub.v0 = True

    def test_llm_json_uses_the_loaded_model(self):
        s, d = self.api("POST", "/api/cc/llm/json", {"system": "Return JSON", "prompt": "hello"})
        self.assertEqual(s, 200, d)
        self.assertEqual(d, {"title": "Stubbed"})
        self.assertEqual(self.stub.calls[-1]["model"], LOADED)

    def test_llm_json_falls_back_immediately_when_gpu_busy(self):
        s, d = self.api("PUT", "/api/os/gpu", {"busy": True, "holder": "pipeline:coder", "until": time.time() + 60})
        self.assertEqual(s, 200, d)
        self.assertTrue(d["active"])
        t0 = time.time()
        s, d = self.api("POST", "/api/cc/llm/json", {"system": "Return JSON", "prompt": "hello"})
        self.assertEqual(s, 503, d)
        self.assertLess(time.time() - t0, 3.0)
        self.assertEqual(self.stub.calls, [])  # the model was never asked
        s, d = self.api("GET", "/api/cc/health")
        self.assertTrue(d["llm"]["gpuBusy"])
        s, d = self.api("PUT", "/api/os/gpu", {"busy": False})
        self.assertFalse(d["active"])
        s, d = self.api("POST", "/api/cc/llm/json", {"system": "Return JSON", "prompt": "hello"})
        self.assertEqual(s, 200, d)

    def test_gpu_put_validates(self):
        self.assertEqual(self.api("PUT", "/api/os/gpu", {"busy": "yes"})[0], 400)
        self.assertEqual(self.api("GET", "/api/os/gpu")[0], 200)

    def test_llm_chat_waits_then_proceeds(self):
        cc.gpu_set(True, "x", time.time() + 60)
        t0 = time.time()
        out = cc.llm_chat([{"role": "user", "content": "hi"}], gpu_wait=0.6)
        self.assertGreaterEqual(time.time() - t0, 0.5)
        self.assertIn("Stubbed", out)


if __name__ == "__main__":
    unittest.main(verbosity=2)
