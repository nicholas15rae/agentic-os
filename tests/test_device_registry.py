"""Per-device gateway tokens (section pass): add, match, revoke, last seen, desktop-only routes."""
import tempfile
import unittest
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

import device_registry as dr


class RegistryTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = Path(self.dir.name) / "devices.json"
        dr._seen_at.clear()

    def tearDown(self):
        self.dir.cleanup()

    def test_a_device_token_works_until_it_is_signed_out(self):
        dev, token = dr.add("Galaxy S22", "phone", now=100.0, path=self.path)
        self.assertNotIn(token, self.path.read_text(encoding="utf-8"), "only the hash is stored")
        self.assertEqual(dr.match(token, path=self.path)["id"], dev["id"])
        self.assertIsNone(dr.match("wrong", path=self.path))
        self.assertIsNone(dr.match("", path=self.path))
        self.assertTrue(dr.revoke(dev["id"], now=200.0, path=self.path))
        self.assertIsNone(dr.match(token, path=self.path), "signed out: the token is dead")
        self.assertFalse(dr.revoke(dev["id"], path=self.path), "already signed out")

    def test_listing_never_shows_hashes_and_puts_signed_out_last(self):
        a, _ = dr.add("Laptop", "laptop", now=1.0, path=self.path)
        b, _ = dr.add("Phone", "phone", now=2.0, path=self.path)
        dr.revoke(a["id"], path=self.path)
        rows = dr.listing(path=self.path)
        self.assertEqual([r["id"] for r in rows], [b["id"], a["id"]])
        self.assertTrue(all("tokenHash" not in r for r in rows))

    def test_last_seen_is_throttled_and_shared_rows_cannot_be_revoked_one_by_one(self):
        dev, _ = dr.add("Phone", "phone", now=1.0, path=self.path)
        dr.seen(dev["id"], "100.84.0.5", "Android", now=1000.0, path=self.path)
        dr.seen(dev["id"], "100.84.0.6", "Android", now=1010.0, path=self.path)
        row = next(r for r in dr.listing(path=self.path) if r["id"] == dev["id"])
        self.assertEqual((row["lastSeen"], row["lastIp"]), (1000.0, "100.84.0.5"))
        dr.seen("shared-100.84.0.9", "100.84.0.9", "Android", now=1000.0, path=self.path, name="Shared token (100.84.0.9)", kind="shared")
        self.assertFalse(dr.revoke("shared-100.84.0.9", path=self.path))
        self.assertIsNone(dr.match("anything", path=self.path))

    def test_bad_kinds_and_names_are_cleaned(self):
        dev, _ = dr.add("  a   b  " + "x" * 80, "spaceship", path=self.path)
        self.assertEqual(dev["kind"], "other")
        self.assertTrue(dev["name"].startswith("a b") and len(dev["name"]) == 40)


class RouteTests(unittest.TestCase):
    def test_devices_are_managed_from_the_desktop_only(self):
        app = FastAPI()
        app.include_router(dr.router)
        c = TestClient(app)  # host "testclient": not loopback
        self.assertEqual(c.get("/api/devices").status_code, 403)
        self.assertEqual(c.post("/api/devices", json={"name": "x"}).status_code, 403)
        self.assertEqual(c.delete("/api/devices/dev-1").status_code, 403)


if __name__ == "__main__":
    unittest.main()
