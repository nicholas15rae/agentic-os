"""engine/llama_engine.py: settings (off by default, validated), the llama-server command line,
start / stop with a fake process and fake health (no real server, no GPU)."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine import llama_engine as le  # noqa: E402


class SettingsTests(unittest.TestCase):
    def test_off_by_default_and_safe(self):
        s = le.EngineSettings()
        self.assertFalse(s.enabled)
        self.assertEqual((s.host, s.port), ("127.0.0.1", 1238))
        self.assertEqual(s.base_url, "http://127.0.0.1:1238/v1")
        self.assertEqual((s.ctx, s.parallel, s.flash_attn), (32768, 2, True))  # Tony's production values
        self.assertEqual(s.alias, "qwen/qwen3.5-9b")
        self.assertEqual(s.validate(), [])

    def test_validate_rejects_unsafe(self):
        bad = le.EngineSettings(host="0.0.0.0", port=1235, kv_type_k="zz", extra_args=["--port", "9"])
        msgs = " | ".join(bad.validate())
        for part in ("loopback", "reserved", "unknown KV", "may not override"):
            self.assertIn(part, msgs)
        self.assertTrue(le.EngineSettings(port=1236).validate())  # start-ai-stack.ps1's CPU Tony
        self.assertTrue(le.EngineSettings(kv_type_v="q8_0", flash_attn=False).validate())

    def test_load_save_roundtrip_ignores_bad_types(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            self.assertFalse(le.load_settings(d).enabled)  # no file
            (d / "engine.json").write_text(json.dumps({"enabled": "yes", "ctx": 8192, "port": True, "nope": 1,
                                                        "extra_args": ["--cache-ram", "0"]}))
            s = le.load_settings(d)
            self.assertFalse(s.enabled)  # a string is not a bool
            self.assertEqual(s.ctx, 8192)
            self.assertEqual(s.port, 1238)  # a bool is not an int
            self.assertEqual(s.extra_args, ["--cache-ram", "0"])
            s.parallel = 1
            le.save_settings(s, d)
            self.assertEqual(le.load_settings(d).parallel, 1)
            with self.assertRaises(ValueError):
                le.save_settings(le.EngineSettings(host="0.0.0.0"), d)
            self.assertEqual(le.load_settings(d).host, "127.0.0.1")  # the bad save wrote nothing

    def test_garbage_file_gives_defaults(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "engine.json").write_text("[1,2")
            self.assertEqual(le.load_settings(Path(d)), le.EngineSettings())


class ArgsTests(unittest.TestCase):
    def test_command_line(self):
        a = le.build_args(le.EngineSettings(model_path="m.gguf"))
        joined = " ".join(a)
        for part in ("-m m.gguf", "--host 127.0.0.1", "--port 1238", "-a qwen/qwen3.5-9b", "-c 32768", "-np 2",
                     "-ngl 999", "-fa on", "-ctk f16", "-ctv f16", "--jinja", "--cache-reuse 256", "--slot-save-path",
                     "--no-webui"):
            self.assertIn(part, joined)
        self.assertNotIn("--mmproj", a)

    def test_switches(self):
        a = le.build_args(le.EngineSettings(cache_reuse=0, prompt_cache=False, jinja=False, flash_attn=False,
                                            mmproj="p.gguf", threads=6), model_path="x.gguf")
        self.assertNotIn("--cache-reuse", a)
        self.assertNotIn("--slot-save-path", a)
        self.assertNotIn("--jinja", a)
        self.assertIn("off", a[a.index("-fa") + 1])
        self.assertEqual(a[a.index("--mmproj") + 1], "p.gguf")
        self.assertEqual(a[a.index("-m") + 1], "x.gguf")
        self.assertEqual(a[a.index("-t") + 1], "6")


class FakeProc:
    pid = 4242
    returncode = None

    def poll(self):
        return self.returncode


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = Path(self.tmp.name)
        self.exe = d / "llama-server.exe"
        self.exe.write_text("")
        self.model = d / "m.gguf"
        self.model.write_text("")
        self.health = ["down"]
        self.calls = []

        def get(url, timeout=3.0):
            h = self.health[0] if len(self.health) == 1 else self.health.pop(0)
            if h == "down":
                raise OSError("refused")
            return {"ok": 200, "loading": 503}[h], {}

        def popen(args, **kw):
            self.calls.append(args)
            return self.proc

        self.proc = FakeProc()
        s = le.EngineSettings(exe=str(self.exe), model_path=str(self.model), keep_warm=False)
        self.eng = le.Engine(s, data_dir=d / "data", http_get=get, popen=popen)

    def tearDown(self):
        self.tmp.cleanup()

    def test_refuses_while_disabled(self):
        with self.assertRaises(le.EngineRefused) as c:
            self.eng.start()
        self.assertIn("off", str(c.exception))
        self.assertEqual(self.calls, [])

    def test_force_starts_and_waits_for_health(self):
        self.health[:] = ["down", "loading", "loading", "ok"]
        st = self.eng.start(force=True, sleep=lambda _: None)
        self.assertEqual(st["health"], "ok")
        self.assertEqual(st["pid"], 4242)
        self.assertEqual(self.calls[0][0], str(self.exe))
        self.assertIn("--port", self.calls[0])
        info = json.loads(self.eng.pid_file.read_text())
        self.assertEqual(info["model"], str(self.model))

    def test_refuses_when_port_busy_or_files_missing(self):
        self.health[:] = ["ok"]
        with self.assertRaises(le.EngineRefused):
            self.eng.start(force=True)
        self.health[:] = ["down"]
        with self.assertRaises(le.EngineRefused):
            self.eng.start(str(self.model) + ".nope", force=True)
        self.eng.s.exe = str(self.exe) + ".nope"
        with self.assertRaises(le.EngineRefused):
            self.eng.start(force=True)
        self.assertEqual(self.calls, [])

    def test_crash_during_load_is_reported(self):
        self.health[:] = ["down"]
        self.proc.returncode = 1
        with self.assertRaises(RuntimeError):
            self.eng.start(force=True, sleep=lambda _: None)

    def test_stop_only_kills_our_process(self):
        self.assertFalse(self.eng.stop())
        self.health[:] = ["down", "ok"]
        self.eng.start(force=True, sleep=lambda _: None)
        killed = []
        self.assertTrue(self.eng.stop(kill=killed.append, is_ours=lambda pid, exe: False))
        self.assertEqual(killed, [])  # a recycled pid is never killed
        self.health[:] = ["down", "ok"]
        self.eng.start(force=True, sleep=lambda _: None)
        self.assertTrue(self.eng.stop(kill=killed.append, is_ours=lambda pid, exe: exe == str(self.exe)))
        self.assertEqual(killed, [4242])
        self.assertFalse(self.eng.pid_file.exists())


if __name__ == "__main__":
    unittest.main()
