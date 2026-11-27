"""Windows-specific behaviour: cmd.exe-safe CLI argv (safe_argv) and UTF-8 file handling."""
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
class TestSafeArgv(unittest.TestCase):
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
        argv = server.safe_argv(["fakecli", "run", "a & b | %PATH%"])
        self.assertTrue(argv[0].lower().endswith("node.exe"))
        self.assertEqual(Path(argv[1]), script)
        self.assertEqual(argv[2:], ["run", "a & b | %PATH%"])

    def test_unknown_batch_file_refused(self):
        (self.tmp / "otherbat.cmd").write_text("@echo %*\n", encoding="utf-8")
        with self.assertRaises(FileNotFoundError):
            server.safe_argv(["otherbat", "x"])

    def test_missing_cli_raises(self):
        with self.assertRaises(FileNotFoundError):
            server.safe_argv(["definitely-not-a-real-cli-xyz"])


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
