"""Gateway backups verify themselves (Section 16.1).

- An isolated / scratch store backs up inside itself, never into the real backups folder (the
  2 KB cc-20261126-101440.zip was a test's empty temp store backed up by the scheduler thread
  server.py starts on import).
- Every zip is opened and checked: readable, cc.db passes integrity_check with the snapshot's row
  counts, every stored file present, size in line with the last good backup.
- A backup that fails is kept aside as failed-cc-*.zip, never counts toward retention and never
  rotates a good backup out; /backups reports it until the next good one.

Run with: python3 tests/run_all.py  (or: python3 tests/test_backup_verify.py)
"""
import sys
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_os_inbox import IsolatedCC  # noqa: E402

import command_center_api as cc  # noqa: E402


class BackupVerifyTests(unittest.TestCase):
    def setUp(self):
        self.iso = IsolatedCC().__enter__()
        cc.kv_set("probe", {"x": 1})
        cc.FILES_DIR.mkdir(parents=True, exist_ok=True)
        (cc.FILES_DIR / "scan.txt").write_text("receipt " * 50, encoding="utf-8")

    def tearDown(self):
        self.iso.__exit__(None, None, None)

    def backups_dir(self):
        return Path(cc.load_config()["backup"]["dir"])

    def test_an_isolated_store_backs_up_inside_itself(self):
        d = self.backups_dir()
        self.assertEqual(d, cc.CC_DIR / "backups")
        self.assertNotEqual(d.resolve(), (cc.BASE_DIR / "backups" / "command-center").resolve())

    def test_a_good_backup_verifies_and_is_recorded(self):
        info = cc.run_backup("test")
        self.assertTrue(info["ok"], info["verified"]["problems"])
        self.assertTrue(Path(info["file"]).name.startswith("cc-"))
        self.assertEqual(info["verified"]["files"], 1)
        self.assertGreaterEqual(info["verified"]["rows"]["kv"], 1)
        lst = cc.list_backups()
        self.assertIsNone(lst["failure"])
        self.assertEqual(lst["lastGood"]["file"], info["file"])

    def test_verify_catches_a_corrupt_zip_and_missing_files(self):
        bad = cc.CC_DIR / "broken.zip"
        bad.write_bytes(b"PK\x03\x04 not really a zip")
        out = cc.verify_backup(bad, {"kv": 1}, 0)
        self.assertFalse(out["ok"])
        self.assertTrue(any("unreadable" in p for p in out["problems"]), out["problems"])

        info = cc.run_backup("test")
        zp = Path(info["file"])
        out = cc.verify_backup(zp, {"kv": 1}, live_files=5)
        self.assertFalse(out["ok"])
        self.assertTrue(any("stored files" in p for p in out["problems"]), out["problems"])

    def test_a_shrunken_backup_is_kept_aside_and_good_ones_survive_retention(self):
        cfg = cc.load_config()
        cfg["backup"]["keep"] = 1
        cc.save_config(cfg)
        good = cc.run_backup("test")
        self.assertTrue(good["ok"])
        # Pretend the last good backup was far bigger: this one now looks like a store gone empty.
        cc.kv_set("backup.lastGood", {**good, "size": good["size"] * 100})
        bad = cc.run_backup("test")
        self.assertFalse(bad["ok"])
        self.assertTrue(Path(bad["file"]).name.startswith("failed-cc-"), bad["file"])
        self.assertTrue(Path(good["file"]).exists(), "retention must not rotate the good backup out")
        lst = cc.list_backups()
        self.assertEqual(lst["failure"]["file"], bad["file"])
        self.assertEqual([b["name"] for b in lst["backups"]], [Path(good["file"]).name])
        self.assertEqual(len(lst["failed"]), 1)

    def test_an_emptied_store_fails_but_a_new_install_does_not(self):
        cc.kv_set("probe", None)
        with cc._db_lock, cc.db() as c:
            c.execute("DELETE FROM kv")
        (cc.FILES_DIR / "scan.txt").unlink()
        first = cc.run_backup("test")
        self.assertTrue(first["ok"], first["verified"]["problems"])
        # run_backup wrote backup.* keys; wipe them again so the store is empty, with a good backup on record.
        last_good = {"size": 5_000_000, "at": 1, "file": "x"}
        with cc._db_lock, cc.db() as c:
            c.execute("DELETE FROM kv")
        out = cc.verify_backup(Path(first["file"]), {t: 0 for t in cc._ROW_TABLES}, 0, last_good)
        self.assertFalse(out["ok"])
        self.assertTrue(any("live store is empty" in p for p in out["problems"]), out["problems"])


if __name__ == "__main__":
    unittest.main()
