"""engine/docstore.py: chunking, add / unchanged / update, folder re-index (source files untouched),
lexical fallback with the embedder down, re-embed later, hybrid ranking. Fake embedder; no server."""
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine import docstore as ds  # noqa: E402

WORDS = ("receipt", "invoice", "tony", "engine", "llama", "script", "scene", "vault")


def fake_embed(texts):
    return [[float(t.lower().count(w)) for w in WORDS] for t in texts], "fake-nomic"


def down(texts):
    raise ConnectionError("embedder down")


class ChunkTests(unittest.TestCase):
    def test_paragraphs_pack_and_long_ones_split_with_overlap(self):
        self.assertEqual(ds.chunk_text("  "), [])
        self.assertEqual(ds.chunk_text("a\n\nb", size=100), ["a\n\nb"])
        long = "x" * 250
        out = ds.chunk_text(f"intro\n\n{long}\n\ntail", size=100, overlap=20)
        self.assertEqual(out[0], "intro")
        self.assertEqual(out[-1], "tail")
        pieces = out[1:-1]
        self.assertTrue(all(len(p) <= 100 for p in pieces))
        self.assertEqual(sum(len(p) for p in pieces) - 20 * (len(pieces) - 1), 250)


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = Path(self.tmp.name)
        self.store = ds.DocStore(self.d / "s.db", embedder=fake_embed)

    def tearDown(self):
        self.tmp.cleanup()

    def test_add_unchanged_update_remove(self):
        self.assertEqual(self.store.add_text("t", "k1", "tony runs the engine"), "added")
        self.assertEqual(self.store.add_text("t", "k1", "tony runs the engine"), "unchanged")
        self.assertEqual(self.store.add_text("t", "k1", "tony runs llama"), "updated")
        self.assertEqual(self.store.add_text("t", "k2", ""), "empty")
        st = self.store.stats()
        self.assertEqual((st["docs"], st["chunks"], st["embedded"]), ({"t": 1}, 1, 1))
        self.assertTrue(self.store.remove("t", "k1"))
        self.assertEqual(self.store.stats()["chunks"], 0)  # chunks go with their doc

    def test_hybrid_search_ranks_semantic_match(self):
        self.store.add_text("t", "a", "the receipt from the hardware store, receipt total 40")
        self.store.add_text("t", "b", "scene script notes for the scene reader")
        r = self.store.search("receipt")
        self.assertEqual(r["mode"], "hybrid")
        self.assertEqual(r["results"][0]["key"], "a")
        self.assertEqual(self.store.search("receipt", sources=["other"])["results"], [])

    def test_lexical_while_embedder_down_then_reembed(self):
        s = ds.DocStore(self.d / "down.db", embedder=down)
        s.add_text("t", "a", "invoice for the vault script")
        self.assertEqual(s.stats()["embedded"], 0)
        r = s.search("invoice")
        self.assertEqual((r["mode"], r["results"][0]["key"]), ("lexical", "a"))
        s.embedder = fake_embed
        self.assertEqual(s.reembed(), 1)
        self.assertEqual(s.stats()["embedded"], 1)
        self.assertEqual(s.search("invoice")["mode"], "hybrid")

    def test_index_folder_reindexes_changes_and_never_touches_sources(self):
        src = self.d / "docs"
        (src / "sub").mkdir(parents=True)
        (src / "a.md").write_text("tony engine notes")
        (src / "sub" / "b.py").write_text("print('llama')")
        (src / "c.bin").write_bytes(b"\0\1")
        r = self.store.index_folder(src)
        self.assertEqual((r["added"], r["unchanged"]), (2, 0))
        (src / "a.md").write_text("tony engine notes, edited")
        (src / "sub" / "b.py").unlink()
        r = self.store.index_folder(src)
        self.assertEqual((r["updated"], r["removed"], r["added"]), (1, 1, 0))
        self.assertTrue((src / "a.md").exists() and (src / "c.bin").exists())
        r = self.store.index_folder(src)
        self.assertEqual(r["unchanged"], 1)

    def test_extract_refuses_unknown_and_huge(self):
        p = self.d / "x.exe"
        p.write_bytes(b"MZ")
        with self.assertRaises(ValueError):
            ds.extract_text(p)
        old = ds.MAX_FILE_BYTES
        ds.MAX_FILE_BYTES = 1
        try:
            q = self.d / "y.txt"
            q.write_text("too big")
            with self.assertRaises(ValueError):
                ds.extract_text(q)
        finally:
            ds.MAX_FILE_BYTES = old


if __name__ == "__main__":
    unittest.main()
