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
import os
import sys
import unittest
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
        # A saved config without a backup dir must not leak the resolved dir into the defaults.
        cc.save_config({"llm": {"timeoutSecs": 60}})
        cc.load_config()
        self.assertEqual(cc.DEFAULT_CONFIG["backup"]["dir"], "")
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

    def big_scan(self):
        # Incompressible, so the zip really shrinks when it goes (the baseline must be >= 64 KB).
        (cc.FILES_DIR / "big-scan.bin").write_bytes(os.urandom(400_000))

    def test_a_shrunken_backup_is_kept_aside_good_ones_survive_and_it_can_be_accepted(self):
        cfg = cc.load_config()
        cfg["backup"]["keep"] = 1
        cc.save_config(cfg)
        self.big_scan()
        good = cc.run_backup("test")
        self.assertTrue(good["ok"], good["verified"]["problems"])
        # The scan goes: the next backup is under 25% of the newest good one ON DISK.
        (cc.FILES_DIR / "big-scan.bin").unlink()
        bad = cc.run_backup("test")
        self.assertFalse(bad["ok"])
        self.assertTrue(Path(bad["file"]).name.startswith("failed-cc-"), bad["file"])
        self.assertTrue(Path(good["file"]).exists(), "retention must not rotate the good backup out")
        lst = cc.list_backups()
        self.assertEqual(lst["failure"]["file"], bad["file"])
        self.assertEqual([b["name"] for b in lst["backups"]], [Path(good["file"]).name])
        self.assertEqual(len(lst["failed"]), 1)
        # Nic confirms he really removed it: it becomes the good backup (and the baseline).
        ok = cc.accept_failed_backup(Path(bad["file"]).name)
        self.assertTrue(ok["ok"])
        lst = cc.list_backups()
        self.assertIsNone(lst["failure"])
        self.assertEqual([b["name"] for b in lst["backups"]], [Path(bad["file"]).name[len("failed-"):]], "keep=1 now keeps the accepted one")
        nxt = cc.run_backup("test")
        self.assertTrue(nxt["ok"], nxt["verified"]["problems"])
        with self.assertRaises(ValueError):
            cc.accept_failed_backup("../cc.db")

    def test_a_wiped_store_fails_against_the_folder_even_with_no_record_of_its_own(self):
        self.big_scan()
        self.assertTrue(cc.run_backup("test")["ok"])
        # cc.db wiped / swapped for an empty one: no rows, no backup.* keys, no files.
        with cc._db_lock, cc.db() as c:
            for t in ("kv", "items", "files", "vault", "os_queue"):
                try:
                    c.execute(f"DELETE FROM {t}")
                except Exception:
                    pass
        (cc.FILES_DIR / "big-scan.bin").unlink()
        (cc.FILES_DIR / "scan.txt").unlink()
        bad = cc.run_backup("test")
        self.assertFalse(bad["ok"])
        self.assertTrue(any("live store is empty" in p for p in bad["verified"]["problems"]), bad["verified"]["problems"])

    def test_a_new_install_is_fine_and_failed_zips_are_capped(self):
        with cc._db_lock, cc.db() as c:
            c.execute("DELETE FROM kv")
        (cc.FILES_DIR / "scan.txt").unlink()
        first = cc.run_backup("test")
        self.assertTrue(first["ok"], first["verified"]["problems"])
        self.assertIn("note", first["verified"])
        d = self.backups_dir()
        for i in range(6):
            (d / f"failed-cc-20200101-00000{i}.zip").write_bytes(b"x")
        cc._rotate(d, 14)
        self.assertEqual(len(list(d.glob("failed-cc-*.zip"))), cc.FAILED_BACKUPS_KEEP)
        # No -wal / -shm litter from the verify / snapshot opens.
        self.assertEqual([p.name for p in list(d.glob("*.db*")) + list(cc.CC_DIR.glob(".backup-*"))], [])

    def test_same_second_backups_sort_after_the_first(self):
        d = self.backups_dir()
        d.mkdir(parents=True, exist_ok=True)
        (d / "cc-20261126-101440.zip").write_bytes(b"x")
        z = cc._free_backup_path(d, "20261126-101440")
        self.assertEqual(z.name, "cc-20261126-101440b.zip")
        self.assertEqual(sorted([z.name, "cc-20261126-101440.zip"])[-1], z.name)


if __name__ == "__main__":
    unittest.main()
