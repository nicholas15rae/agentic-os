"""Backup mirrors: a verified second copy on another drive (Section 16.2).

- After a backup verifies, the zip is copied to each backup.mirrorDirs folder and the copy is
  checked (size, a readable zip, the same sha256); per-mirror status is kept in kv and shown by
  /backups with an alert when a mirror failed or can't be reached.
- A failed backup is never mirrored; a mirror's trouble never fails the backup.
- Mirror retention is off by default (keep every copy). mirrorKeep > 0 only ever removes cc-*.zip
  copies this gateway wrote and verified there; nothing else in the folder is touched.
- Nothing already in a mirror folder is overwritten.
- Search coverage (16.6): brainstorm summaries / tags are indexed; finance stays out of an
  unscoped (agent) search.

Run with: python3 tests/run_all.py  (or: python3 tests/test_backup_mirror.py)
"""
import os
import shutil
import string
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_os_inbox import IsolatedCC  # noqa: E402

import command_center_api as cc  # noqa: E402


def _missing_drive() -> str:
    """A drive letter that isn't there (an unplugged USB drive), or '' off Windows."""
    if os.name != "nt":
        return ""
    for L in reversed(string.ascii_uppercase):
        if not Path(f"{L}:\\").exists():
            return f"{L}:\\Backups\\cc-mirror"
    return ""


class BackupMirrorTests(unittest.TestCase):
    def setUp(self):
        self.iso = IsolatedCC().__enter__()
        with cc._mirror_probe_lock:
            cc._mirror_probe_cache.clear()
            cc._mirror_probe_inflight.clear()
        cc.kv_set("probe", {"x": 1})
        cc.FILES_DIR.mkdir(parents=True, exist_ok=True)
        (cc.FILES_DIR / "scan.txt").write_text("receipt " * 50, encoding="utf-8")
        self.mirror_root = Path(tempfile.mkdtemp(prefix="agentic-os-mirror-"))
        self.m1 = self.mirror_root / "drive-d" / "cc-mirror"
        self.m2 = self.mirror_root / "usb" / "copies"

    def tearDown(self):
        t = cc._mirror_bg_thread
        if t is not None:
            t.join(10)
        self.iso.__exit__(None, None, None)
        shutil.rmtree(self.mirror_root, ignore_errors=True)

    def set_backup(self, **kw):
        # Through the real PUT handler, so its validation runs.
        return cc.put_config({"backup": kw})["backup"]

    def test_defaults_keep_everything_and_mirror_nothing(self):
        b = cc.load_config()["backup"]
        self.assertEqual(b["mirrorDirs"], [])
        self.assertEqual(b["mirrorKeep"], 0)
        info = cc.run_backup("test")
        self.assertTrue(info["ok"])
        self.assertNotIn("mirrors", info)
        self.assertEqual(cc.list_backups()["mirrors"], [])

    def test_a_verified_backup_is_copied_and_verified_in_every_mirror(self):
        self.set_backup(mirrorDirs=[str(self.m1), str(self.m2)])
        info = cc.run_backup("test")
        self.assertTrue(info["ok"], info["verified"]["problems"])
        name = Path(info["file"]).name
        for m in (self.m1, self.m2):
            copy = m / name
            self.assertTrue(copy.is_file(), m)
            self.assertEqual(cc._sha256(copy), cc._sha256(Path(info["file"])))
            st = info["mirrors"][str(m)]
            self.assertTrue(st["ok"], st)
            self.assertEqual(st["lastOkFile"], str(copy))
            self.assertEqual([p.name for p in m.iterdir()], [name], "no partial / temp files left")
        rows = cc.list_backups()["mirrors"]
        self.assertEqual([r["dir"] for r in rows], [str(self.m1), str(self.m2)])
        self.assertTrue(all(r["ok"] and r["reachable"] and "alert" not in r for r in rows), rows)

    def test_mirror_retention_is_off_by_default_so_every_copy_stays(self):
        self.set_backup(mirrorDirs=[str(self.m1)], keep=1)
        for _ in range(3):
            self.assertTrue(cc.run_backup("test")["ok"])
        self.assertEqual(len(list(self.m1.glob("cc-*.zip"))), 3, "mirrorKeep 0 keeps every copy")
        self.assertEqual(len(list(Path(cc.load_config()["backup"]["dir"]).glob("cc-*.zip"))), 1, "the primary folder keeps its own retention")

    def test_a_new_backup_never_reuses_a_name_a_mirror_still_holds(self):
        # Primary retention removed cc-<stamp>.zip here, but the mirror kept its copy: a second
        # backup in the same second must take the next name, not collide with the mirror's copy.
        d = Path(cc.load_config()["backup"]["dir"])
        d.mkdir(parents=True, exist_ok=True)
        self.m1.mkdir(parents=True)
        (self.m1 / "cc-20261126-101440.zip").write_bytes(b"x")
        self.assertEqual(cc._free_backup_path(d, "20261126-101440", [str(self.m1)]).name, "cc-20261126-101440b.zip")
        self.assertEqual(cc._free_backup_path(d, "20261126-101440").name, "cc-20261126-101440.zip")

    def test_mirror_keep_only_removes_our_own_verified_copies(self):
        self.set_backup(mirrorDirs=[str(self.m1)], mirrorKeep=1)
        self.m1.mkdir(parents=True)
        # Things that are not ours: a stranger's cc-*.zip, an older backup copied by hand, notes.
        (self.m1 / "cc-20200101-000000.zip").write_bytes(b"someone else's zip")
        (self.m1 / "readme.txt").write_text("mine", encoding="utf-8")
        (self.m1 / "failed-cc-20200101-000001.zip").write_bytes(b"x")
        names = []
        for _ in range(3):
            info = cc.run_backup("test")
            self.assertTrue(info["ok"])
            names.append(Path(info["file"]).name)
        left = sorted(p.name for p in self.m1.iterdir())
        self.assertEqual(left, sorted(["cc-20200101-000000.zip", "readme.txt", "failed-cc-20200101-000001.zip", names[-1]]))
        # A copy of ours that was changed afterwards is not ours any more: never removed.
        self.set_backup(mirrorKeep=0)
        info = cc.run_backup("test")
        (self.m1 / Path(info["file"]).name).write_bytes(b"edited by hand")
        self.set_backup(mirrorKeep=1)
        self.assertTrue(cc.run_backup("test")["ok"])
        self.assertTrue((self.m1 / Path(info["file"]).name).exists())

    def test_an_unreachable_mirror_alerts_and_the_backup_still_succeeds(self):
        gone = _missing_drive()
        if not gone:
            self.skipTest("needs a missing drive letter (Windows)")
        self.set_backup(mirrorDirs=[gone, str(self.m1)])
        info = cc.run_backup("test")
        self.assertTrue(info["ok"], "a mirror never fails the backup")
        self.assertFalse(info["mirrors"][gone]["ok"])
        self.assertTrue(info["mirrors"][gone]["unreachable"])
        self.assertTrue(info["mirrors"][str(self.m1)]["ok"])
        rows = {r["dir"]: r for r in cc.list_backups()["mirrors"]}
        self.assertFalse(rows[gone]["reachable"])
        self.assertIn("not reachable", rows[gone]["alert"])
        self.assertNotIn("alert", rows[str(self.m1)])

    def test_a_failed_copy_is_kept_aside_and_reported(self):
        self.set_backup(mirrorDirs=[str(self.m1)])
        real_copy = cc.shutil.copyfile

        def truncating_copy(src, dst):
            real_copy(src, dst)
            with open(dst, "r+b") as f:
                f.truncate(100)

        cc.shutil.copyfile = truncating_copy
        try:
            info = cc.run_backup("test")
        finally:
            cc.shutil.copyfile = real_copy
        self.assertTrue(info["ok"])
        st = info["mirrors"][str(self.m1)]
        self.assertFalse(st["ok"])
        self.assertIn("failed its check", st["reason"])
        name = Path(info["file"]).name
        self.assertFalse((self.m1 / name).exists())
        self.assertTrue((self.m1 / f"failed-{name}").exists(), "kept for inspection, never removed")
        row = cc.list_backups()["mirrors"][0]
        self.assertIn("failed its check", row["alert"])
        # The retry copies the newest good backup and clears the alert (lastOkAt set).
        out = cc.mirror_latest()[str(self.m1)]
        self.assertTrue(out["ok"], out)
        self.assertNotIn("alert", cc.list_backups()["mirrors"][0])

    def test_a_different_file_under_our_name_is_never_overwritten(self):
        self.set_backup(mirrorDirs=[str(self.m1)])
        info = cc.run_backup("test")
        copy = self.m1 / Path(info["file"]).name
        copy.write_bytes(b"not the backup")
        out = cc.mirror_latest()[str(self.m1)]
        self.assertFalse(out["ok"])
        self.assertIn("already in the mirror", out["reason"])
        self.assertEqual(copy.read_bytes(), b"not the backup")

    def test_a_failed_backup_is_never_mirrored(self):
        self.set_backup(mirrorDirs=[str(self.m1)])
        (cc.FILES_DIR / "big-scan.bin").write_bytes(os.urandom(400_000))
        self.assertTrue(cc.run_backup("test")["ok"])
        (cc.FILES_DIR / "big-scan.bin").unlink()
        bad = cc.run_backup("test")
        self.assertFalse(bad["ok"])
        self.assertNotIn("mirrors", bad)
        self.assertEqual(len(list(self.m1.glob("*.zip"))), 1)
        # Accepting it makes it good, and then it is mirrored, in the background (the POST
        # doesn't wait on the mirror drives).
        ok = cc.accept_failed_backup(Path(bad["file"]).name)
        self.assertTrue(ok["ok"])
        self.assertTrue(ok.get("mirrorsPending"))
        self.assertNotIn("mirrors", ok)
        cc._mirror_bg_thread.join(10)
        self.assertFalse(cc._mirror_bg_thread.is_alive())
        self.assertEqual(len(list(self.m1.glob("cc-*.zip"))), 2)
        row = cc.list_backups()["mirrors"][0]
        self.assertTrue(row["ok"], row)
        self.assertEqual(Path(row["lastOkFile"]).name, Path(ok["file"]).name)

    def test_retention_never_deletes_the_copy_it_just_wrote(self):
        # mirrorKeep 1, then an OLDER-named good backup is mirrored (e.g. an accepted old failed
        # one): the newest by name stays AND the copy just written stays.
        self.set_backup(mirrorDirs=[str(self.m1)], mirrorKeep=1)
        newest = Path(cc.run_backup("test")["file"])
        old = newest.with_name("cc-20200101-000000.zip")
        shutil.copyfile(newest, old)
        res = cc.mirror_backup(old)[str(self.m1)]
        self.assertTrue(res["ok"], res)
        self.assertTrue((self.m1 / old.name).is_file(), "the copy written in this run is never removed")
        self.assertTrue((self.m1 / newest.name).is_file(), "the newest by name is kept")
        # The next newer backup rotates the old one out as usual (both are ours).
        nxt = Path(cc.run_backup("test")["file"])
        self.assertEqual(sorted(p.name for p in self.m1.glob("cc-*.zip")), [nxt.name])

    def test_rotate_mirror_keeps_current_and_newest(self):
        man = [{"name": f"cc-2026010{i}-000000.zip", "size": 1, "sha256": "x"} for i in range(1, 5)]
        self.m1.mkdir(parents=True)
        # None of the files exist: every name is just forgotten, except the kept ones.
        left = cc._rotate_mirror(self.m1, 1, man, current="cc-20260101-000000.zip")
        self.assertEqual(sorted(m["name"] for m in left), ["cc-20260101-000000.zip", "cc-20260104-000000.zip"])

    def test_a_stale_partial_this_code_started_is_cleared_and_the_copy_retried(self):
        self.set_backup(mirrorDirs=[str(self.m1)])
        info = cc.run_backup("test")
        name = Path(info["file"]).name
        (self.m1 / name).unlink()  # pretend the earlier copy died partway
        part = self.m1 / f".partial-{name}"
        part.write_bytes(b"half a zip")
        past = time.time() - 120
        os.utime(part, (past, past))
        cc._note_partial(self.m1, part.name, past - 1)
        out = cc.mirror_latest()[str(self.m1)]
        self.assertTrue(out["ok"], out)
        self.assertFalse(part.exists())
        self.assertTrue((self.m1 / name).is_file())
        self.assertEqual(cc._partials(), {}, "the record is forgotten once the copy finished")

    def test_a_partial_this_code_did_not_record_is_left_alone(self):
        self.set_backup(mirrorDirs=[str(self.m1)])
        name = Path(cc.run_backup("test")["file"]).name
        (self.m1 / name).unlink()
        part = self.m1 / f".partial-{name}"
        part.write_bytes(b"someone's file")
        past = time.time() - 120
        os.utime(part, (past, past))
        out = cc.mirror_latest()[str(self.m1)]
        self.assertFalse(out["ok"])
        self.assertIn("remove it by hand", out["reason"])
        self.assertEqual(part.read_bytes(), b"someone's file")
        # Recorded, but modified after this attempt started (not older than the attempt): kept.
        cc._note_partial(self.m1, part.name, past - 1)
        future = time.time() + 3600
        os.utime(part, (future, future))
        self.assertFalse(cc.mirror_latest()[str(self.m1)]["ok"])
        self.assertEqual(part.read_bytes(), b"someone's file")
        # Recorded, but bigger than the backup: not our partial copy of it.
        os.utime(part, (past, past))
        part.write_bytes(b"x" * (Path(cc.load_config()["backup"]["dir"], name).stat().st_size + 10))
        os.utime(part, (past, past))
        self.assertFalse(cc.mirror_latest()[str(self.m1)]["ok"])
        self.assertTrue(part.exists())

    def test_a_copy_that_fails_partway_cleans_up_its_own_partial(self):
        self.set_backup(mirrorDirs=[str(self.m1)])
        real_copy = cc.shutil.copyfile

        def dying_copy(src, dst):
            with open(dst, "wb") as f:
                f.write(b"half")
            raise OSError("the network name is no longer available")

        cc.shutil.copyfile = dying_copy
        try:
            info = cc.run_backup("test")
        finally:
            cc.shutil.copyfile = real_copy
        st = info["mirrors"][str(self.m1)]
        self.assertFalse(st["ok"])
        self.assertIn("copy failed", st["reason"])
        self.assertEqual([p.name for p in self.m1.iterdir()], [], "no partial left behind")
        self.assertTrue(cc.mirror_latest()[str(self.m1)]["ok"])


    def test_mirror_settings_are_validated(self):
        primary = cc.load_config()["backup"]["dir"]
        for bad in (["relative\\folder"], [primary], [str(Path(primary) / "sub")], [str(Path(primary).parent)], "x" * 300, [1], [str(self.mirror_root / f"m{i}") for i in range(6)]):
            with self.assertRaises(cc.HTTPException, msg=str(bad)[:60]):
                cc.put_config({"backup": {"mirrorDirs": bad}})
        with self.assertRaises(cc.HTTPException):
            cc.put_config({"backup": {"mirrorKeep": "lots"}})
        b = self.set_backup(mirrorDirs=[f" {self.m1} ", str(self.m1), "", str(self.m2)], mirrorKeep=-4)
        self.assertEqual(b["mirrorDirs"], [str(self.m1), str(self.m2)])
        self.assertEqual(b["mirrorKeep"], 0)
        self.assertEqual(self.set_backup(mirrorDirs=f"{self.m1}\n{self.m2}")["mirrorDirs"], [str(self.m1), str(self.m2)])
        self.assertEqual(self.set_backup(mirrorDirs=[])["mirrorDirs"], [])
        with self.assertRaises(ValueError):
            cc.mirror_latest()

    def test_clients_cannot_write_mirror_status(self):
        with self.assertRaises(cc.HTTPException):
            cc.put_kv("backup.mirrors", {"value": {}})


class SlowMirrorTests(unittest.TestCase):
    """An offline SMB share / mapped drive: Path(anchor).exists() hangs (fake: until released)."""

    SLOW = r"\\offline-nas\share\cc-mirror"

    def setUp(self):
        if os.name != "nt":
            self.skipTest("UNC paths (Windows)")
        self.iso = IsolatedCC().__enter__()
        with cc._mirror_probe_lock:
            cc._mirror_probe_cache.clear()
            cc._mirror_probe_inflight.clear()
        cc.kv_set("probe", {"x": 1})
        self.mirror_root = Path(tempfile.mkdtemp(prefix="agentic-os-mirror-"))
        self.m1 = self.mirror_root / "drive-d" / "cc-mirror"
        self.release = threading.Event()
        self.calls: list[str] = []
        self._exists = cc._mirror_exists
        slow_anchor = Path(self.SLOW).anchor

        def fake_exists(p):
            self.calls.append(str(p))
            if str(p) == slow_anchor:
                self.release.wait(30)  # an SMB redirector that doesn't answer
                return False
            return self._exists(p)

        cc._mirror_exists = fake_exists
        cc.put_config({"backup": {"mirrorDirs": [self.SLOW, str(self.m1)]}})

    def tearDown(self):
        self.release.set()
        cc._mirror_exists = self._exists
        self.iso.__exit__(None, None, None)
        shutil.rmtree(self.mirror_root, ignore_errors=True)

    def test_backups_list_answers_within_the_probe_timeout_and_caches(self):
        t0 = time.monotonic()
        rows = {r["dir"]: r for r in cc.list_backups()["mirrors"]}
        took = time.monotonic() - t0
        self.assertLess(took, cc.MIRROR_PROBE_TIMEOUT + 1.5, "bounded, not the 15 s client timeout")
        slow = rows[self.SLOW]
        self.assertFalse(slow["reachable"])
        self.assertTrue(slow["notAnswering"])
        self.assertIn("not answering", slow["alert"])
        self.assertTrue(rows[str(self.m1)]["reachable"])
        # Cached for ~60 s: the next load doesn't wait again, and no second probe is started.
        n = len([c for c in self.calls if c == Path(self.SLOW).anchor])
        t0 = time.monotonic()
        cc.list_backups()
        self.assertLess(time.monotonic() - t0, 1.0)
        self.assertEqual(len([c for c in self.calls if c == Path(self.SLOW).anchor]), n)

    def test_a_backup_waits_only_seconds_on_mirrors_and_skips_the_dead_one(self):
        t0 = time.monotonic()
        info = cc.run_backup("test")
        took = time.monotonic() - t0
        self.assertTrue(info["ok"], info.get("verified"))
        # Name choice (bounded) + the mirror probe (bounded), not the share's own timeout.
        self.assertLess(took, 3 * cc.MIRROR_PROBE_TIMEOUT + 3)
        self.assertTrue(Path(info["file"]).is_file(), "the primary zip is written")
        dead = info["mirrors"][self.SLOW]
        self.assertFalse(dead["ok"])
        self.assertTrue(dead["unreachable"])
        self.assertIn("not answering", dead["reason"])
        self.assertTrue(info["mirrors"][str(self.m1)]["ok"])
        self.assertFalse(cc.kv_get("backup.mirrors")[self.SLOW]["ok"], "the skip is recorded")
        # Only one probe of the hung share is ever in flight.
        self.assertEqual(len([c for c in self.calls if c == Path(self.SLOW).anchor]), 1)

    def test_free_backup_path_never_probes_mirrors_synchronously(self):
        d = Path(cc.load_config()["backup"]["dir"])
        d.mkdir(parents=True, exist_ok=True)
        cc.kv_set("backup.mirrorManifest", {self.SLOW: [{"name": "cc-20261126-101440.zip", "size": 1, "sha256": "x"}]})
        t0 = time.monotonic()
        z = cc._free_backup_path(d, "20261126-101440", [self.SLOW, str(self.m1)])
        self.assertLess(time.monotonic() - t0, 2 * cc.MIRROR_PROBE_TIMEOUT + 1.5)
        self.assertEqual(z.name, "cc-20261126-101440b.zip", "a name the manifest says the dead mirror holds is skipped")

    def test_a_late_answer_replaces_the_timeout_in_the_cache(self):
        r = cc._mirror_reach([self.SLOW], timeout=0.2)[self.SLOW]
        self.assertTrue(r["timeout"])
        self.release.set()
        for _ in range(50):
            with cc._mirror_probe_lock:
                if not cc._mirror_probe_inflight:
                    break
            time.sleep(0.05)
        r = cc._mirror_reach([self.SLOW], timeout=0.2)[self.SLOW]
        self.assertNotIn("timeout", r)
        self.assertFalse(r["reachable"])


class VaultCoverageTests(unittest.TestCase):
    def setUp(self):
        self.iso = IsolatedCC().__enter__()
        self._embed = cc.embed
        cc.embed = lambda texts: (_ for _ in ()).throw(RuntimeError("no embedder in tests"))

    def tearDown(self):
        cc.embed = self._embed
        self.iso.__exit__(None, None, None)

    def index(self, collection, data):
        item_id = cc.uuid.uuid4().hex
        with cc._db_lock, cc.db() as c:
            c.execute("INSERT INTO items(id,collection,data,created,updated,deleted) VALUES(?,?,?,?,?,0)", (item_id, collection, cc.json.dumps(data), cc.time.time(), cc.time.time()))
        cc._upsert_vault_text(item_id, collection, data, False)
        return item_id

    def test_brainstorm_summaries_and_tags_are_searchable_and_finance_stays_out(self):
        self.assertIn("summary", cc.VAULT_FIELDS["notes"])
        self.assertIn("tags", cc.VAULT_FIELDS["notes"])
        n = self.index("notes", {"title": "Walk", "rawText": "um so", "summary": "a zebra mural for the studio wall", "tags": ["murals"]})
        self.index("receipts", {"vendor": "Zebra Paints", "notes": "zebra mural paint"})
        self.index("pipeline", {"title": "Zebra Crossing", "kind": "audition", "script": "INT. zebra crossing"})
        res = cc.vault_search("zebra mural")
        cols = [r["collection"] for r in res["results"]]
        self.assertIn("notes", cols)
        self.assertIn("pipeline", cols)
        self.assertNotIn("receipts", cols, "an unscoped (agent) search never returns finance")
        self.assertEqual(res["results"][0]["id"], n)
        self.assertIn("receipts", [r["collection"] for r in cc.vault_search("zebra mural", include_finance=True)["results"]])


if __name__ == "__main__":
    unittest.main(verbosity=2)
