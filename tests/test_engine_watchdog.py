"""engine/watchdog.py: never acts while off or after a deliberate stop, waits for the GPU baton,
restarts a crashed engine with the same model and logs it, tolerates one bad health check, and
gives up after the start limit (no crash loop)."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine.llama_engine import EngineSettings  # noqa: E402
from engine.watchdog import Watchdog  # noqa: E402


class FakeEngine:
    def __init__(self, data: Path, enabled=True):
        self.s = EngineSettings(enabled=enabled)
        self.data = data
        self.pid_file = data / "engine.pid"
        self.health_value = "ok"
        self.starts = []
        self.stops = 0
        self.fail_start = False

    def _pid_info(self):
        try:
            return json.loads(self.pid_file.read_text())
        except (OSError, ValueError):
            return None

    def health(self):
        return self.health_value

    def stop(self):
        self.stops += 1
        self.pid_file.unlink(missing_ok=True)
        return True

    def start(self, model, alias=None, force=False):
        if self.fail_start:
            raise RuntimeError("llama-server exited with 1")
        self.starts.append((model, alias))
        self.data.mkdir(parents=True, exist_ok=True)
        self.pid_file.write_text(json.dumps({"pid": 100 + len(self.starts), "model": model, "alias": alias}))
        self.health_value = "ok"
        return {"pid": 100 + len(self.starts), "health": "ok"}


class WatchdogTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = Path(self.tmp.name)
        self.eng = FakeEngine(self.d)
        self.now = [1000.0]
        self.alive = {"v": True}
        self.held = {"v": False}
        self.wd = Watchdog(self.eng, clock=lambda: self.now[0], alive=lambda pid: self.alive["v"],
                           held=lambda: self.held["v"], log_path=self.d / "wd.jsonl", reload_settings=False)

    def tearDown(self):
        self.tmp.cleanup()

    def started(self):
        self.eng.pid_file.write_text(json.dumps({"pid": 42, "model": "tony.gguf", "alias": "qwen/qwen3.5-9b"}))

    def events(self):
        p = self.d / "wd.jsonl"
        return [json.loads(x)["event"] for x in p.read_text().splitlines()] if p.exists() else []

    def test_off_or_stopped_never_acts(self):
        self.eng.s.enabled = False
        self.started()
        self.alive["v"] = False
        self.assertEqual(self.wd.check(), "off")
        self.eng.s.enabled = True
        self.eng.pid_file.unlink()
        self.assertEqual(self.wd.check(), "stopped")
        self.assertEqual(self.eng.starts, [])

    def test_waits_while_baton_held(self):
        self.started()
        self.alive["v"] = False
        self.held["v"] = True
        self.assertEqual(self.wd.check(), "baton")
        self.assertEqual(self.eng.starts, [])

    def test_crash_restarts_same_model_and_logs(self):
        self.started()
        self.assertEqual(self.wd.check(), "ok")
        self.alive["v"] = False
        self.assertEqual(self.wd.check(), "restarted")
        self.assertEqual(self.eng.starts, [("tony.gguf", "qwen/qwen3.5-9b")])
        self.assertEqual(self.events(), ["crash", "restarted"])

    def test_one_bad_health_is_tolerated_then_restart(self):
        self.started()
        self.eng.health_value = "error"
        self.assertEqual(self.wd.check(), "suspect")
        self.assertEqual(self.wd.check(), "restarted")
        self.assertEqual(self.eng.stops, 1)  # the hung process is stopped first

    def test_start_limit_gives_up(self):
        self.started()
        self.alive["v"] = False
        for _ in range(3):
            self.assertEqual(self.wd.check(), "restarted")
            self.now[0] += 10
        self.assertEqual(self.wd.check(), "limit")
        self.assertEqual(self.wd.check(), "gave-up")
        self.assertEqual(len(self.eng.starts), 3)
        self.assertEqual(self.events()[-1], "gave-up")

    def test_old_restarts_age_out_of_the_window(self):
        self.started()
        self.alive["v"] = False
        for _ in range(3):
            self.wd.check()
            self.now[0] += 200  # spread over 600 s > the 300 s window
        self.assertEqual(self.wd.check(), "restarted")

    def test_failed_restart_is_logged_and_counted(self):
        self.started()
        self.alive["v"] = False
        self.eng.fail_start = True
        self.assertEqual(self.wd.check(), "restart-failed")
        self.assertIsNotNone(self.eng._pid_info())  # kept, so the next pass tries (and counts) again
        self.assertEqual(self.wd.check(), "restart-failed")
        self.assertEqual(self.wd.check(), "restart-failed")
        self.assertEqual(self.wd.check(), "limit")
        self.assertIn("restart-failed", self.events())


if __name__ == "__main__":
    unittest.main()
