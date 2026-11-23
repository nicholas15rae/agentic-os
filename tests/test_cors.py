"""CORS: every Command Center window origin may reach the gateway; nothing else may.

Regression: a dev window on http://localhost:1422 (a second worktree's Vite server) was refused
by the CORS preflight, so every view said "Gateway unreachable" while the Rust heartbeat, which
isn't subject to CORS, said Connected.
"""
import sys
import unittest
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import Harness  # noqa: E402


class CorsOriginsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.h = Harness()
        cls.h.start()

    @classmethod
    def tearDownClass(cls):
        cls.h.stop()

    def preflight(self, origin: str):
        req = urllib.request.Request(
            self.h.base_url + "/api/status",
            method="OPTIONS",
            headers={"Origin": origin, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "content-type"},
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, r.headers.get("Access-Control-Allow-Origin")
        except urllib.error.HTTPError as e:
            return e.code, e.headers.get("Access-Control-Allow-Origin")

    def test_app_and_dev_origins_are_allowed(self):
        for origin in ["http://tauri.localhost", "tauri://localhost", "http://localhost:1420", "http://localhost:1422", "http://127.0.0.1:1430", "http://localhost:1439", "http://localhost:4173"]:
            status, acao = self.preflight(origin)
            self.assertEqual((status, acao), (200, origin), origin)

    def test_other_origins_are_refused(self):
        for origin in ["http://localhost:1440", "http://localhost:3000", "http://localhost:14220", "https://localhost:1422", "http://evil.example:1422", "http://localhost.evil.example:1422", "http://192.168.1.5:1422"]:
            status, acao = self.preflight(origin)
            self.assertNotEqual(acao, origin, origin)


if __name__ == "__main__":
    unittest.main()
