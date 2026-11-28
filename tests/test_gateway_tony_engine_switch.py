"""Section 26: gateway Tony's switch to the built-in engine. OFF (default, or engine off, or a bad
engine.json): Tony's path is exactly Bionic's. ON: the engine's alias + base, its own state check,
a cold load that starts the engine, and the provider label. No real server."""
import json
import os
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import command_center_api as cc  # noqa: E402
import gateway_tony as gt  # noqa: E402
from engine import llama_engine as le  # noqa: E402

ENGINE_ROOT = "http://127.0.0.1:1238"


class SwitchTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cfg = Path(self.tmp.name)
        (self.cfg / "providers.json").write_text(json.dumps({"providers": [
            {"id": "lmstudio", "baseUrl": "http://127.0.0.1:1235/v1", "model": "qwen/qwen3.5-9b"}]}))
        self.p = [mock.patch.object(le, "APP_CFG_DIR", self.cfg), mock.patch.object(gt, "_app_dir", return_value=self.cfg)]
        for p in self.p:
            p.start()

    def tearDown(self):
        for p in self.p:
            p.stop()
        self.tmp.cleanup()

    def settings(self, **kw):
        (self.cfg / "engine.json").write_text(json.dumps(kw))

    def test_off_by_default_means_bionic_exactly(self):
        self.assertIsNone(gt.engine_route())
        self.assertEqual(gt.tony_model(), ("qwen/qwen3.5-9b", "http://127.0.0.1:1235/v1"))
        for kw in ({"enabled": True}, {"route_tony": True}, {"enabled": False, "route_tony": True}):
            self.settings(**kw)
            self.assertIsNone(gt.engine_route(), kw)
            self.assertEqual(gt.tony_model()[1], "http://127.0.0.1:1235/v1")
        (self.cfg / "engine.json").write_text("{broken")
        self.assertIsNone(gt.engine_route())  # fails closed

    def test_switch_is_read_from_the_gateway_config_dir(self):
        # Only the gateway's folder is repointed here; the engine module's own path is a folder
        # whose engine.json says ON. The switch must follow the gateway's folder (off).
        other = tempfile.TemporaryDirectory()
        self.addCleanup(other.cleanup)
        (Path(other.name) / "engine.json").write_text(json.dumps({"enabled": True, "route_tony": True}))
        with mock.patch.object(le, "APP_CFG_DIR", Path(other.name)):
            self.assertIsNone(gt.engine_route())
            self.settings(enabled=True, route_tony=True)
            self.assertEqual(gt.engine_route(), ("qwen/qwen3.5-9b", "http://127.0.0.1:1238/v1"))

    def test_off_never_touches_the_engine_branch(self):
        calls = []
        with mock.patch.object(cc, "_http_json", side_effect=lambda url, *a, **k: calls.append(url) or {"data": [{"id": "qwen/qwen3.5-9b", "state": "loaded"}]}):
            self.assertEqual(gt.model_state("http://127.0.0.1:1235", "qwen/qwen3.5-9b"), "loaded")
            self.assertEqual(gt.model_state(ENGINE_ROOT, "qwen/qwen3.5-9b"), "loaded")  # off: even :1238 is asked Bionic's way
        self.assertTrue(all("/api/v0/models" in u for u in calls), calls)

    def test_on_routes_to_the_engine(self):
        self.settings(enabled=True, route_tony=True)
        self.assertEqual(gt.tony_model(), ("qwen/qwen3.5-9b", "http://127.0.0.1:1238/v1"))
        self.assertTrue(gt._engine_root(ENGINE_ROOT))
        self.assertFalse(gt._engine_root("http://127.0.0.1:1235"))

    def test_engine_state(self):
        self.settings(enabled=True, route_tony=True)

        def fake(health=None, models=None):
            def f(url, *a, **k):
                if url.endswith("/health"):
                    if isinstance(health, Exception):
                        raise health
                    return {"status": "ok"}
                return models
            return f
        cases = [
            (fake(health=urllib.error.URLError("refused")), "not-loaded"),
            (fake(health=urllib.error.HTTPError(ENGINE_ROOT, 503, "loading", {}, None)), "loading"),
            (fake(health=urllib.error.HTTPError(ENGINE_ROOT, 500, "boom", {}, None)), None),
            (fake(models={"data": [{"id": "qwen/qwen3.5-9b"}]}), "loaded"),
            (fake(models={"data": [{"id": "pixtral"}]}), "absent"),
        ]
        for f, want in cases:
            with mock.patch.object(cc, "_http_json", side_effect=f):
                self.assertEqual(gt.model_state(ENGINE_ROOT, "qwen/qwen3.5-9b"), want)

    def test_cold_load_starts_the_engine_and_reports(self):
        self.settings(enabled=True, route_tony=True)
        gt.forget_loads()
        loads = []

        class FakeMM:
            def __init__(self, eng):
                pass

            def load(self, path, alias=""):
                loads.append((path, alias))

        with mock.patch("engine.models.ModelManager", FakeMM):
            ld = gt._request_load(ENGINE_ROOT, "qwen/qwen3.5-9b", 0.0, timeout=5)
            ld.join(5)
        self.assertTrue(ld.answered and not ld.failed)
        self.assertEqual(loads[0][1], "qwen/qwen3.5-9b")
        gt.forget_loads()

        class Refusing(FakeMM):
            def load(self, path, alias=""):
                raise le.EngineRefused("won't fit")

        with mock.patch("engine.models.ModelManager", Refusing):
            ld = gt._request_load(ENGINE_ROOT, "qwen/qwen3.5-9b", 0.0, timeout=5)
            ld.join(5)
        self.assertTrue(ld.failed)
        gt.forget_loads()


if __name__ == "__main__":
    unittest.main()
