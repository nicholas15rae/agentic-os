"""Engine screen routes: /api/engine/bench/last (newest saved engine + LM Studio numbers) and
/api/engine/test (one timed Tony turn on the engine; refused while it isn't running; desktop only)."""
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


class EngineScreenRouteTests(unittest.TestCase):
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

    def test_bench_last_picks_the_newest_of_each(self):
        b = self.cfg / "data" / "bench"
        self.assertEqual(self.local.get("/api/engine/bench/last").json(), {"engine": None, "lmstudio": None})
        b.mkdir(parents=True)
        (b / "20261127-100000-lmstudio.json").write_text(json.dumps({"started": "old", "summary": {"ttft_median": 9}}))
        (b / "20261127-111606-lmstudio.json").write_text(json.dumps({"started": "new", "summary": {"ttft_median": 0.25}}))
        (b / "20261127-111537-swap.json").write_text(json.dumps({"started": "s", "steps": [
            {"step": "engine loaded", "engineMiB": 6176}, {"at": 1, "step": "benchmark", "ttft_median": 0.382, "total_median": 1.929}]}))
        (b / "20261127-120000-swap.json").write_text("{broken")
        r = self.local.get("/api/engine/bench/last").json()
        self.assertEqual(r["lmstudio"]["summary"]["ttft_median"], 0.25)
        self.assertEqual(r["engine"]["summary"], {"ttft_median": 0.382, "total_median": 1.929})
        self.assertEqual(r["engine"]["vramMiB"], 6176)
        self.assertEqual(self.remote.get("/api/engine/bench/last").status_code, 403)

    def test_test_reply_refused_while_down_and_desktop_only(self):
        self.assertEqual(self.remote.post("/api/engine/test", json={}).status_code, 403)
        with mock.patch.object(api.Engine, "health", return_value="down"):
            r = self.local.post("/api/engine/test", json={})
        self.assertEqual(r.status_code, 409)

    def test_test_reply_times_first_token_and_total(self):
        ticks = iter([0.0, 0.4, 1.5])
        seen = {}

        def stream(msgs, model, base_url, on_delta, **k):
            seen.update(model=model, base=base_url, msgs=msgs)
            on_delta("Yeah")
            on_delta(" man")
            return "Yeah man"
        out = api.test_reply(le.EngineSettings(), "hi", stream=stream, build=lambda b: [{"role": "user", "content": b["text"]}], clock=lambda: next(ticks))
        self.assertEqual((out["firstTokenSecs"], out["totalSecs"], out["text"]), (0.4, 1.5, "Yeah man"))
        self.assertEqual(seen["base"], "http://127.0.0.1:1238/v1")


if __name__ == "__main__":
    unittest.main()
