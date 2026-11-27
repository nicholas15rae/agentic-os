"""engine/baton.py: yield remembers the model and stops; reclaim restarts that model; nothing to
reclaim / engine switched off meanwhile are no-ops."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine import baton  # noqa: E402
from engine.llama_engine import EngineSettings  # noqa: E402


class FakeEngine:
    def __init__(self, data, enabled=True):
        self.data, self.s = data, EngineSettings(enabled=enabled)
        self.pid_file = data / "engine.pid"
        self.started = []

    def _pid_info(self):
        try:
            return json.loads(self.pid_file.read_text())
        except OSError:
            return None

    def stop(self):
        self.pid_file.unlink(missing_ok=True)
        return True

    def start(self, model, alias=None, force=False):
        self.started.append((model, alias))
        self.pid_file.write_text(json.dumps({"pid": 7, "model": model, "alias": alias}))
        return {"health": "ok"}


class BatonTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = Path(self.tmp.name)
        self.eng = FakeEngine(self.d)

    def tearDown(self):
        self.tmp.cleanup()

    def test_yield_then_reclaim_same_model(self):
        self.assertFalse(baton.yield_gpu("comfy", self.eng)["yielded"])  # not running
        self.eng.pid_file.write_text(json.dumps({"pid": 5, "model": "tony.gguf", "alias": "qwen/qwen3.5-9b"}))
        r = baton.yield_gpu("comfy · render", self.eng)
        self.assertTrue(r["yielded"])
        self.assertIsNone(self.eng._pid_info())
        self.assertTrue(baton.reclaim_gpu(self.eng)["reclaimed"])
        self.assertEqual(self.eng.started, [("tony.gguf", "qwen/qwen3.5-9b")])
        self.assertFalse(baton.reclaim_gpu(self.eng)["reclaimed"])  # the note is gone

    def test_switched_off_meanwhile_stays_off(self):
        self.eng.pid_file.write_text(json.dumps({"pid": 5, "model": "tony.gguf"}))
        baton.yield_gpu("training", self.eng)
        self.eng.s.enabled = False
        r = baton.reclaim_gpu(self.eng)
        self.assertEqual((r["reclaimed"], r["reason"]), (False, "engine is off"))
        self.assertEqual(self.eng.started, [])


if __name__ == "__main__":
    unittest.main()
