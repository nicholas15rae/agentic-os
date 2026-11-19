"""Windows-specific behaviour: CLI resolution and UTF-8 file handling."""
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

import server  # noqa: E402

NPM_SHIM = r'''@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\node.exe" (
  SET "_prog=%dp0%\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\node_modules\fake-cli\bin\fakecli" %*
'''


@unittest.skipUnless(os.name == "nt", "Windows-only")
class TestResolveCli(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="aos-win-"))
        self.old_path = os.environ["PATH"]
        os.environ["PATH"] = str(self.tmp) + os.pathsep + self.old_path

    def tearDown(self):
        os.environ["PATH"] = self.old_path
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_npm_shim_unwrapped_to_node(self):
        script = self.tmp / "node_modules" / "fake-cli" / "bin" / "fakecli"
        script.parent.mkdir(parents=True)
        script.write_text("// js", encoding="utf-8")
        (self.tmp / "fakecli.cmd").write_text(NPM_SHIM, encoding="utf-8")
        argv = server.resolve_cli(["fakecli", "run", "a & b | %PATH%"])
        self.assertTrue(argv[0].lower().endswith("node.exe"))
        self.assertEqual(Path(argv[1]), script)
        self.assertEqual(argv[2:], ["run", "a & b | %PATH%"])

    def test_unknown_batch_file_refused(self):
        (self.tmp / "otherbat.cmd").write_text("@echo %*\n", encoding="utf-8")
        with self.assertRaises(FileNotFoundError):
            server.resolve_cli(["otherbat", "x"])

    def test_missing_cli_raises(self):
        with self.assertRaises(FileNotFoundError):
            server.resolve_cli(["definitely-not-a-real-cli-xyz"])


class TestHermesHome(unittest.TestCase):
    def setUp(self):
        self.saved = {k: os.environ.get(k) for k in ("HERMES_HOME", "LOCALAPPDATA")}
        self.tmp = Path(tempfile.mkdtemp(prefix="aos-hermes-"))

    def tearDown(self):
        for k, v in self.saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_env_override_wins(self):
        os.environ["HERMES_HOME"] = str(self.tmp / "custom")
        self.assertEqual(server.hermes_home(), self.tmp / "custom")

    @unittest.skipUnless(os.name == "nt", "Windows-only")
    def test_native_windows_location(self):
        os.environ.pop("HERMES_HOME", None)
        os.environ["LOCALAPPDATA"] = str(self.tmp)
        (self.tmp / "hermes").mkdir()
        self.assertEqual(server.hermes_home(), self.tmp / "hermes")

    def test_falls_back_to_dot_hermes(self):
        os.environ.pop("HERMES_HOME", None)
        os.environ["LOCALAPPDATA"] = str(self.tmp)  # no hermes\ inside
        self.assertEqual(server.hermes_home(), Path.home() / ".hermes")


class TestCleanHermesOutput(unittest.TestCase):
    # Captured from Hermes v0.23.2 `hermes chat -q` on Windows (colours included).
    V023 = ("\x1b[38;2;255;191;0m" + "─" * 40 + "\x1b[0m\n"
            "\x1b[1;38;2;255;191;0m☤ Hermes\x1b[0m\n"
            "\x1b[38;2;255;248;220mHermes online\x1b[0m\n"
            "\x1b[38;2;255;191;0m" + "─" * 40 + "\x1b[0m\n"
            "hermes --resume local-dcc5c3a6d1cda55a\n")

    def test_v023_framed_reply_without_ansi(self):
        self.assertEqual(server.clean_hermes_output(self.V023), "Hermes online")

    def test_multiline_reply_kept(self):
        raw = self.V023.replace("Hermes online", "line one\n\nline two")
        self.assertEqual(server.clean_hermes_output(raw), "line one\n\nline two")

    def test_legacy_box_format_still_works(self):
        raw = "Query: hi\n╭─ Hermes ─╮\n  hello there  \n╰──────────╯\nSession: x\n"
        self.assertEqual(server.clean_hermes_output(raw), "hello there")


class TestUtf8Files(unittest.TestCase):
    def test_read_file_round_trips_non_ascii(self):
        tmp = Path(tempfile.mkdtemp(prefix="aos-utf8-"))
        try:
            p = tmp / "note.md"
            text = "Status ✅ — café → 🚀"
            server.write_file(p, text)
            self.assertEqual(server.read_file(p), text)
            self.assertEqual(p.read_bytes(), text.encode("utf-8"))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
