"""engine/bench_tony.py: summary maths, the safety preflight and the run loop (no server, no GPU)."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine import bench_tony as b  # noqa: E402


class SummaryTests(unittest.TestCase):
    def test_medians_ignore_failures_and_report_first_rep(self):
        s = [b.Sample("a", 0, 2.0, 3.0, 10), b.Sample("a", 1, 1.0, 2.0, 10),
             b.Sample("b", 0, 1.2, 2.5, 10), b.Sample("b", 1, None, 30.0, 0, "TimeoutError")]
        out = b.summarize(s)
        self.assertEqual((out["n"], out["ok"], out["errors"]), (4, 3, 1))
        self.assertEqual(out["ttft_median"], 1.2)
        self.assertEqual(out["ttft_min"], 1.0)
        self.assertEqual(out["hit_target"], 2)
        self.assertEqual(out["ttft_first_median"], 1.6)

    def test_all_failed(self):
        out = b.summarize([b.Sample("a", 0, None, 1.0, 0, "x")])
        self.assertEqual(out["ok"], 0)
        self.assertNotIn("ttft_median", out)
        r = b.Result("engine", "u", "m", "now", [b.Sample("a", 0, None, 1.0, 0, "x")])
        self.assertIn("all 1 failed", b.markdown_line(r))


class PreflightTests(unittest.TestCase):
    def _get(self, gpu=None, models=None):
        def get(url, timeout=4.0):
            if url.endswith("/api/os/gpu"):
                if gpu is None:
                    raise OSError("no gateway")
                return gpu
            if models is None:
                raise OSError("down")
            return models
        return get

    def test_refuses_while_baton_held(self):
        why = b.preflight("lmstudio", "u", "m", get_json=self._get({"active": True, "holder": "comfy"}),
                          model_state=lambda *_: "loaded")
        self.assertIn("comfy", why)

    def test_lmstudio_needs_model_already_loaded(self):
        for state in ("not-loaded", "absent", None):
            why = b.preflight("lmstudio", "u", "m", get_json=self._get({"active": False}), model_state=lambda *_: state)
            self.assertIn("never JIT-load", why)
        self.assertIsNone(b.preflight("lmstudio", "u", "m", get_json=self._get(None), model_state=lambda *_: "loaded"))

    def test_engine_must_serve_the_model(self):
        self.assertIn("not reachable", b.preflight("engine", "u", "m", get_json=self._get({"active": False})))
        why = b.preflight("engine", "u", "m", get_json=self._get({"active": False}, {"data": [{"id": "other"}]}))
        self.assertIn("not m", why)
        self.assertIsNone(b.preflight("engine", "u", "m", get_json=self._get({"active": False}, {"data": [{"id": "m"}]})))


class RunTests(unittest.TestCase):
    def test_times_first_delta_and_records_errors(self):
        t = [0.0]

        def clock():
            return t[0]

        def stream(msgs, *, on_delta, **kw):
            if msgs[-1]["content"] == "boom":
                t[0] += 5
                raise TimeoutError("no first token")
            t[0] += 0.8
            on_delta("Hi")
            t[0] += 0.7
            on_delta(" Nic")
            return "Hi Nic"

        res = b.run("engine", 2, prompts=("hello", "boom"), base="u", model="m", stream=stream,
                    build=lambda p: [{"role": "user", "content": p["text"]}], clock=clock, max_tokens=50)
        self.assertEqual(len(res.samples), 4)
        ok = [s for s in res.samples if not s.error]
        for s in ok:
            self.assertAlmostEqual(s.ttft_s, 0.8)
            self.assertAlmostEqual(s.total_s, 1.5)
        self.assertEqual([s.chars for s in ok], [6, 6])
        self.assertTrue(all(s.error.startswith("TimeoutError") for s in res.samples if s.prompt == "boom"))
        self.assertEqual([s.rep for s in res.samples], [0, 0, 1, 1])


if __name__ == "__main__":
    unittest.main()
