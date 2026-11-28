"""engine/ingest.py: Tony-only note ingest with documenter.rs's limits; memory-scroll folder sync
(.md only, re-index on change, vanished files dropped from the store only)."""
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine import ingest  # noqa: E402
from engine.docstore import DocStore  # noqa: E402


def fake(texts):
    return [[1.0, float(len(t))] for t in texts], "fake"


class IngestTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = DocStore(Path(self.tmp.name) / "d.db", embedder=fake)

    def tearDown(self):
        self.tmp.cleanup()

    def test_tony_only_and_limits(self):
        for actor in ("coder", "librarian", "", "TonyX"):
            with self.assertRaises(ingest.IngestRefused):
                ingest.ingest_note(actor, "t", "x", self.store)
        with self.assertRaises(ingest.IngestRefused):
            ingest.ingest_note("tony", "  ", "x", self.store)
        with self.assertRaises(ingest.IngestRefused):
            ingest.ingest_note("tony", "t", "   ", self.store)
        with self.assertRaises(ingest.IngestRefused):
            ingest.ingest_note("tony", "t", "a" * (ingest.NOTE_MAX + 1), self.store)
        self.assertEqual(ingest.ingest_note("Tony", "Deck stain", "Picked the cedar stain.", self.store), "added")
        self.assertEqual(ingest.ingest_note("general", "Deck stain", "Picked the walnut stain.", self.store), "updated")
        self.assertEqual(self.store.stats()["docs"], {"notes": 1})

    def test_scrolls_sync(self):
        root = Path(self.tmp.name) / "scrolls"
        (root / "core").mkdir(parents=True)
        (root / "core" / "identity.md").write_text("Nic prefers short answers.")
        (root / "core" / "draft.txt").write_text("not a scroll")
        r = ingest.sync_scrolls(root, self.store)
        self.assertEqual((r["added"], self.store.stats()["docs"]), (1, {"scrolls": 1}))
        (root / "core" / "identity.md").unlink()
        self.assertEqual(ingest.sync_scrolls(root, self.store)["removed"], 1)
        with self.assertRaises(ingest.IngestRefused):
            ingest.sync_scrolls(root / "missing", self.store)


if __name__ == "__main__":
    unittest.main()
