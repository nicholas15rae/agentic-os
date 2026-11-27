"""engine/api.py: every route is loopback-only, settings PUT validates and rejects unknown keys,
load is refused while the engine is off, boot() starts nothing but the watchdog while off.
Uses FastAPI's TestClient with the engine's paths pointed at a temp folder."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from engine import api  # noqa: E402
from engine import llama_engine as le  # noqa: E402


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cfg = Path(self.tmp.name)
        self.patches = [mock.patch.object(le, "APP_CFG_DIR", self.cfg),
                        mock.patch.object(le, "DATA_DIR", self.cfg / "data")]
        for p in self.patches:
            p.start()
        app = FastAPI()
        app.include_router(api.router)
        self.local = TestClient(app, client=("127.0.0.1", 5000))
        self.remote = TestClient(app, client=("100.84.1.20", 5000))

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def test_phone_is_refused_everywhere(self):
        for method, path in (("get", "/api/engine/status"), ("get", "/api/engine/settings"), ("put", "/api/engine/settings"),
                             ("get", "/api/engine/models"), ("post", "/api/engine/load"), ("post", "/api/engine/unload"),
                             ("post", "/api/engine/download"), ("post", "/api/engine/delete"), ("get", "/api/engine/downloads"),
                             ("get", "/api/engine/watchdog")):
            kw = {"json": {}} if method in ("put", "post") else {}
            r = getattr(self.remote, method)(path, **kw)
            self.assertEqual(r.status_code, 403, (method, path, r.text))
        r = self.local.get("/api/engine/settings", headers={"X-Forwarded-For": "100.84.1.20"})
        self.assertEqual(r.status_code, 403)  # proxied

    def test_settings_roundtrip_and_validation(self):
        r = self.local.get("/api/engine/settings")
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.json()["enabled"])
        self.assertEqual(self.local.put("/api/engine/settings", json={"ctx": 16384}).json()["ctx"], 16384)
        self.assertEqual(le.load_settings(self.cfg).ctx, 16384)
        self.assertEqual(self.local.put("/api/engine/settings", json={"host": "0.0.0.0"}).status_code, 400)
        self.assertEqual(self.local.put("/api/engine/settings", json={"rm_rf": True}).status_code, 400)
        self.assertFalse(le.load_settings(self.cfg).enabled)

    def test_load_refused_while_off(self):
        f = self.cfg / "m.gguf"
        f.write_bytes(b"GGUF")
        r = self.local.post("/api/engine/load", json={"path": str(f)})
        self.assertEqual(r.status_code, 409)
        self.assertIn("off", r.json()["detail"])

    def test_download_and_delete_validate_before_doing_anything(self):
        with mock.patch.object(api.mdl, "library_roots", return_value=[str(self.cfg)]):
            r = self.local.post("/api/engine/download", json={"repo": "../etc", "filename": "x.gguf", "destRoot": str(self.cfg)})
            self.assertEqual(r.status_code, 400)
            m = self.cfg / "keep.gguf"
            m.write_bytes(b"x")
            r = self.local.post("/api/engine/delete", json={"path": str(m), "confirm": "yes"})
            self.assertEqual(r.status_code, 400)
            self.assertTrue(m.exists())

    def test_watchdog_log_tail(self):
        log = self.cfg / "data" / "logs"
        log.mkdir(parents=True)
        (log / "watchdog.jsonl").write_text('{"event":"crash"}\nnot json\n{"event":"restarted"}\n')
        self.assertEqual([e["event"] for e in self.local.get("/api/engine/watchdog").json()], ["crash", "restarted"])


class BootTests(unittest.TestCase):
    def test_off_starts_only_the_watchdog(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.object(le, "APP_CFG_DIR", Path(d)), \
                mock.patch.object(api, "_booted", False), mock.patch.object(api.threading, "Thread") as T, \
                mock.patch.object(api.Engine, "start") as start:
            r = api.boot()
            self.assertEqual((r["enabled"], r["started"]), (False, None))
            start.assert_not_called()
            self.assertEqual(T.call_args.kwargs["name"], "engine-watchdog")
            self.assertEqual(api.boot(), {"booted": "already"})


if __name__ == "__main__":
    unittest.main()


class AgentRouteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cfg = Path(self.tmp.name)
        self.p = [mock.patch.object(le, "APP_CFG_DIR", self.cfg), mock.patch.object(le, "DATA_DIR", self.cfg / "data")]
        for p in self.p:
            p.start()
        app = FastAPI()
        app.include_router(api.router)
        self.local = TestClient(app, client=("127.0.0.1", 5000))
        self.remote = TestClient(app, client=("100.84.1.20", 5000))

    def tearDown(self):
        for p in self.p:
            p.stop()
        self.tmp.cleanup()

    def test_off_by_default_and_desktop_only(self):
        self.assertEqual(self.remote.post("/api/engine/agents/coder/run", json={"text": "hi"}).status_code, 403)
        self.assertEqual(self.remote.get("/api/engine/agents").status_code, 403)
        r = self.local.post("/api/engine/agents/coder/run", json={"text": "hi"})
        self.assertEqual(r.status_code, 409)
        self.assertIn("route_agents=false", r.json()["detail"])
        self.assertFalse(self.local.get("/api/engine/agents").json()["routeAgents"])

    def test_agents_summary_has_no_prompt_text(self):
        from engine import agent_runner as ar
        t = self.cfg / "agents.json"
        t.write_text(json.dumps({"agents": {"coder": {"prompt": "SECRET PROMPT TEXT", "promptSource": "built in", "toolAccess": [{"tool": "fetch", "access": "write"}]}}}))
        with mock.patch.object(ar, "TABLE", t):
            r = self.local.get("/api/engine/agents").json()
        self.assertTrue(r["agents"]["coder"]["hasPrompt"])
        self.assertNotIn("SECRET PROMPT TEXT", json.dumps(r))
