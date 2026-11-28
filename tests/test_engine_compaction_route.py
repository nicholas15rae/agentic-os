"""Section 26: memory compaction's "already-loaded model" check follows Tony's engine switch.
OFF (default / bad engine.json / another URL): exactly LM Studio's /api/v0 listing. ON: the
engine's /health, and never the plain /v1/models listing. No real server."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine import llama_engine as le  # noqa: E402
from memory_scrolls import lmstudio  # noqa: E402

ENGINE = "http://127.0.0.1:1238/v1"
LM = "http://127.0.0.1:1235/v1"


class CompactionRouteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cfg = Path(self.tmp.name)
        self.p = mock.patch.object(le, "APP_CFG_DIR", self.cfg)
        self.p.start()
        self.urls = []

    def tearDown(self):
        self.p.stop()
        self.tmp.cleanup()

    def fake(self, url, timeout=0, headers=None):
        self.urls.append(url)
        if url.endswith("/health"):
            return {"status": "ok"}
        if url.endswith("/api/v0/models"):
            return {"data": [{"id": "qwen/qwen3.5-9b", "state": "loaded", "type": "llm"}]}
        raise AssertionError(f"unexpected {url}")

    def test_off_is_lm_studio_only(self):
        for text in (None, "{broken", json.dumps({"enabled": True}), json.dumps({"route_tony": True})):
            if text is not None:
                (self.cfg / "engine.json").write_text(text)
            self.urls.clear()
            with mock.patch.object(lmstudio.net, "get_json", side_effect=self.fake):
                self.assertEqual(lmstudio.loaded_chat_model(LM), "qwen/qwen3.5-9b")
            self.assertEqual(self.urls, ["http://127.0.0.1:1235/api/v0/models"], text)

    def test_on_uses_the_engine_health(self):
        (self.cfg / "engine.json").write_text(json.dumps({"enabled": True, "route_tony": True}))
        with mock.patch.object(lmstudio.net, "get_json", side_effect=self.fake):
            self.assertEqual(lmstudio.loaded_chat_model(ENGINE), "qwen/qwen3.5-9b")
            # LM Studio's own URL still asks LM Studio its way.
            self.assertEqual(lmstudio.loaded_chat_model(LM), "qwen/qwen3.5-9b")
        self.assertNotIn("http://127.0.0.1:1238/v1/models", self.urls)

        def down(url, timeout=0, headers=None):
            raise OSError("refused")
        with mock.patch.object(lmstudio.net, "get_json", side_effect=down):
            self.assertIsNone(lmstudio.loaded_chat_model(ENGINE))


if __name__ == "__main__":
    unittest.main()
