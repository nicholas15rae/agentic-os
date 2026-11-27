"""stt/bench/bench.py drives the LIVE :8177 server: it must put back the model it found.

A fake server (its /health and /load) stands in; no HTTP, no GPU, no clips.
Run with: python -m pytest tests/test_stt_bench.py -q
"""
import contextlib
import io
import json
import shutil
import socket
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "stt" / "bench"))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "stt"))

import bench  # noqa: E402
import fw_server as fw  # noqa: E402


class FakeServer:
    """fw_server's /health and /load, as bench.jget / bench.jpost see them."""

    def __init__(self, model="large-v3-turbo", compute="int8_float16", device="cuda"):
        self.state = {"ready": model is not None, "model": model, "compute_type": compute, "device": device}
        self.loads = []

    def jget(self, url, timeout=10):
        assert url == f"{bench.FW}/health", url
        return dict(self.state)

    def jpost(self, url, body, timeout=300):
        assert url == f"{bench.FW}/load", url
        self.loads.append(dict(body))
        self.state.update(ready=True, model=body["model"], compute_type=body.get("compute_type"), device=body.get("device", "cuda"))
        return 200, dict(self.state)


def fake_result(arm, clips, runs):
    lat = {b[2]: {"n": 1, "p50": 0.3, "p95": 0.3, "mean": 0.3} for b in bench.BUCKETS}
    return {"arm": arm["name"], "key": arm["key"], "latency": lat, "wer": 0.0, "vocab_recall": 1.0, "noise_fp_raw": [], "noise_fp_guarded": [],
            "gpu_min_free_mb": 2400, "errors": 0}


class RestoresTheLiveModel(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="stt-bench-"))
        (self.tmp / "manifest.json").write_text(json.dumps([{"id": "c1", "kind": "speech", "seconds": 3.0, "text": "Tony, cut it."}]), encoding="utf-8")
        self._saved = {k: getattr(bench, k) for k in ("jget", "jpost", "gpu", "run_arm", "CLIPS", "FW")}
        self.srv = FakeServer()
        bench.jget, bench.jpost, bench.gpu, bench.run_arm, bench.CLIPS = self.srv.jget, self.srv.jpost, lambda: (9000, 2500), fake_result, self.tmp

    def tearDown(self):
        for k, v in self._saved.items():
            setattr(bench, k, v)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_bench(self, arms):
        bench.main(["--runs", "1", "--arms", arms, "--out", str(self.tmp / "results.json")])

    def test_the_model_it_found_is_loaded_back_after_the_run(self):
        self.run_bench("distil-large-v3:int8_float16,large-v3-turbo:float16")
        self.assertEqual([(l["model"], l["compute_type"]) for l in self.srv.loads],
                         [("distil-large-v3", "int8_float16"), ("large-v3-turbo", "float16"), ("large-v3-turbo", "int8_float16")])
        self.assertEqual(self.srv.loads[-1], {"model": "large-v3-turbo", "compute_type": "int8_float16", "device": "cuda"})
        self.assertEqual((self.srv.state["model"], self.srv.state["compute_type"]), ("large-v3-turbo", "int8_float16"))
        self.assertEqual(len(json.loads((self.tmp / "results.json").read_text(encoding="utf-8"))["results"]), 10)

    def test_it_is_loaded_back_after_an_error_too(self):
        def boom(arm, clips, runs):
            raise KeyboardInterrupt  # Ctrl+C mid-run

        bench.run_arm = boom
        with self.assertRaises(KeyboardInterrupt):
            self.run_bench("distil-large-v3:int8_float16")
        self.assertEqual([l["model"] for l in self.srv.loads], ["distil-large-v3", "large-v3-turbo"])
        self.assertEqual(self.srv.state["model"], "large-v3-turbo")

    def test_no_load_when_nothing_was_swapped_or_it_still_has_it(self):
        self.run_bench("whispercpp")  # the whisper.cpp arm never touches :8177
        self.assertEqual(self.srv.loads, [])
        self.run_bench("large-v3-turbo:int8_float16")  # the arm IS the live model: no second load
        self.assertEqual([(l["model"], l["compute_type"]) for l in self.srv.loads], [("large-v3-turbo", "int8_float16")])

    def test_a_server_that_wanted_the_gpu_gets_cuda_back(self):
        self.srv.state.update(ready=False, device="cpu-unavailable")
        self.run_bench("distil-large-v3:int8_float16")
        self.assertEqual(self.srv.loads[-1], {"model": "large-v3-turbo", "compute_type": "int8_float16", "device": "cuda"})

    def test_a_server_with_no_model_is_left_alone(self):
        self.srv.state.update(ready=False, model=None)
        self.run_bench("distil-large-v3:int8_float16")
        self.assertEqual([l["model"] for l in self.srv.loads], ["distil-large-v3"])

    def server_dies(self):
        """From here on :8177 is gone: the real urllib jget/jpost against a closed port."""
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
        s.close()
        bench.FW, bench.jget, bench.jpost = f"http://127.0.0.1:{port}", self._saved["jget"], self._saved["jpost"]

    def test_a_server_down_at_the_end_costs_no_results(self):
        """:8177 crashed / restarting when the run ends: the restore's URLError used to escape the
        finally, so the results JSON was never written."""

        def arm_then_server_dies(arm, clips, runs):
            res = fake_result(arm, clips, runs)
            self.server_dies()
            return res

        bench.run_arm = arm_then_server_dies
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.run_bench("distil-large-v3:int8_float16")  # no exception
        saved = json.loads((self.tmp / "results.json").read_text(encoding="utf-8"))
        self.assertEqual([r["key"] for r in saved["results"]], ["distil-large-v3:int8_float16"] * 5)  # its 5 beam/bias arms
        self.assertTrue(saved["complete"])
        self.assertIn("[restore] failed: large-v3-turbo int8_float16 was not put back (URLError", err.getvalue())

    def test_an_early_stop_keeps_the_finished_arms_and_its_own_exception(self):
        """Ctrl+C in the second arm with :8177 down: the KeyboardInterrupt is what main raises (a
        failed restore doesn't mask it), and the first arm's numbers are on disk."""
        calls = []

        def second_arm_interrupted(arm, clips, runs):
            calls.append(arm["key"])
            if len(calls) == 2:
                self.server_dies()
                raise KeyboardInterrupt
            return fake_result(arm, clips, runs)

        bench.run_arm = second_arm_interrupted
        err = io.StringIO()
        with contextlib.redirect_stderr(err), self.assertRaises(KeyboardInterrupt):
            self.run_bench("distil-large-v3:int8_float16,large-v3-turbo:float16")
        saved = json.loads((self.tmp / "results.json").read_text(encoding="utf-8"))
        self.assertEqual([r["key"] for r in saved["results"]], ["distil-large-v3:int8_float16"])
        self.assertFalse(saved["complete"])
        self.assertIn("[restore] failed", err.getvalue())

    def test_restore_model_never_raises(self):
        def down(*a, **k):
            raise urllib.error.URLError(ConnectionRefusedError(10061, "refused"))

        bench.jget = bench.jpost = down
        r = bench.restore_model({"model": "large-v3-turbo", "compute_type": "int8_float16", "device": "cuda"})
        self.assertFalse(r["restored"])
        self.assertIn("URLError", r["failed"])


class SlowBackend:
    def transcribe(self, audio, opts):
        return {"text": "", "segments": []}


class StopsWhileAnArmLoads(unittest.TestCase):
    """The run stops while an arm's POST /load is in flight (Ctrl+C, or jpost's 300 s timeout), with
    the REAL fw_server.Worker behind /health and /load: mid-load /health says loading and still names
    the old model, so the restore used to see "it still has it" and post nothing; the queued arm load
    then left the live server on the benchmark's model."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="stt-bench-worker-"))
        for folder in fw.MODEL_ALIASES.values():
            (self.tmp / folder).mkdir()
            (self.tmp / folder / "model.bin").write_bytes(b"x")
        (self.tmp / "manifest.json").write_text(json.dumps([{"id": "c1", "kind": "speech", "seconds": 3.0, "text": "Tony, cut it."}]), encoding="utf-8")
        self.gate, self.in_slow_load, self.loader_calls, self.posts = threading.Event(), threading.Event(), [], []

        def loader(path, device, compute):
            self.loader_calls.append((path.name, compute))
            if path.name == fw.MODEL_ALIASES["distil-large-v3"]:
                self.in_slow_load.set()
                self.gate.wait(10)  # the arm's ~5-13 s load
            return SlowBackend()

        self.worker = fw.Worker(loader, self.tmp, gpu=lambda: (8400, 3700), retry_backoff=(0.0, 0.0))
        self.assertTrue(self.worker.load("large-v3-turbo", "cuda", "int8_float16").result(5)["ready"])
        self._saved = {k: getattr(bench, k) for k in ("jget", "jpost", "gpu", "run_arm", "CLIPS")}
        bench.jget, bench.jpost, bench.gpu, bench.CLIPS = self.jget, self.jpost, lambda: (9000, 2500), self.tmp
        bench.run_arm = fake_result

    def tearDown(self):
        self.gate.set()
        self.worker.stop()
        for k, v in self._saved.items():
            setattr(bench, k, v)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def jget(self, url, timeout=10):
        assert url == f"{bench.FW}/health", url
        return self.worker.health()

    def jpost(self, url, body, timeout=300):
        """fw_server's POST /load: queue the load on the worker and wait for it. The arm's load is
        cut off mid-flight by `self.stop_with` (the urlopen in the bench gives up, the worker doesn't)."""
        assert url == f"{bench.FW}/load", url
        self.posts.append(dict(body))
        fut = self.worker.load(body["model"], body.get("device") or "cuda", body.get("compute_type") or "int8_float16")
        if body["model"] == "distil-large-v3":
            self.assertTrue(self.in_slow_load.wait(5))
            h = self.worker.health()
            self.assertEqual((h["ready"], h["loading"], h["model"]), (False, True, "large-v3-turbo"))  # what restore sees
            raise self.stop_with
        self.gate.set()  # the in-flight arm load finishes now; this one is queued behind it
        st = fut.result(10)
        return (200 if st.get("ready") else 503), st

    def settle(self):
        self.gate.set()
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            h = self.worker.health()
            if h["ready"] and not h["loading"] and h["queue"] == 0 and len(self.loader_calls) >= 2:
                return h
            time.sleep(0.02)
        self.fail(f"the worker never settled: {self.worker.health()}")

    def check_restored(self, exc):
        self.stop_with = exc
        err = io.StringIO()
        with contextlib.redirect_stderr(err), self.assertRaises(type(exc)):
            bench.main(["--runs", "1", "--arms", "distil-large-v3:int8_float16", "--out", str(self.tmp / "results.json")])
        h = self.settle()
        self.assertEqual((h["model"], h["compute_type"], h["device"]), ("large-v3-turbo", "int8_float16", "cuda"))
        self.assertEqual(self.posts[-1], {"model": "large-v3-turbo", "compute_type": "int8_float16", "device": "cuda"})
        self.assertEqual([n for n, _ in self.loader_calls],
                         [fw.MODEL_ALIASES[m] for m in ("large-v3-turbo", "distil-large-v3", "large-v3-turbo")])
        self.assertIn("[restore] large-v3-turbo int8_float16: {'restored': True", err.getvalue())
        self.assertFalse(json.loads((self.tmp / "results.json").read_text(encoding="utf-8"))["complete"])

    def test_ctrl_c_during_the_arm_load(self):
        self.check_restored(KeyboardInterrupt())

    def test_the_bench_side_timeout_of_the_arm_load(self):
        self.check_restored(TimeoutError("timed out"))


if __name__ == "__main__":
    unittest.main()
