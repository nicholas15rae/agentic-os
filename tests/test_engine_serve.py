"""engine/serve.py: the sidecar serves the engine routes (loopback only) and nothing else."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402

from engine import serve  # noqa: E402


class SidecarTests(unittest.TestCase):
    def test_engine_routes_only_and_loopback_only(self):
        a = serve.app()
        local, remote = TestClient(a, client=("127.0.0.1", 5000)), TestClient(a, client=("100.84.1.20", 5000))
        self.assertTrue(local.get("/api/engine/sidecar").json()["sidecar"])
        self.assertEqual(local.get("/api/engine/settings").status_code, 200)
        self.assertEqual(remote.get("/api/engine/settings").status_code, 403)
        self.assertEqual(local.get("/api/os/inbox").status_code, 404, "no gateway routes here")
        paths = {getattr(r, "path", "") for r in a.routes}
        self.assertTrue(all(p.startswith("/api/engine") for p in paths if p.startswith("/api")), paths)

    def test_reserved_ports_refused(self):
        for port in (8080, 1235, 1238):
            self.assertEqual(serve.main(["--port", str(port)]), 2)


if __name__ == "__main__":
    unittest.main()
