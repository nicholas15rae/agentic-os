"""Local model library (os_api /api/models/local-scan, Section 20.14): configurable roots (env
vars, defaults that include the C: / D: / G: folders), HF caches scanned through their snapshots,
duplicates through junctions listed once, and a weights index without shards marked incomplete.

Every test builds its own temp tree; nothing real is scanned, moved or deleted.

Run with: python3 tests/test_model_library.py
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import os_api  # noqa: E402

ENV_KEYS = ("CC_MODEL_DIRS", "CC_LMSTUDIO_DIRS", "CC_LMSTUDIO_DIR", "CC_HF_CACHES", "HF_HUB_CACHE", "HF_HOME")


def write(p: Path, size: int = 10) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "wb") as f:
        f.truncate(size)


class ModelLibraryTests(unittest.TestCase):
    def setUp(self):
        self.saved = {k: os.environ.get(k) for k in ENV_KEYS}
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        for k, v in self.saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self.tmp.cleanup()

    def test_defaults_cover_c_d_and_g(self):
        for k in ENV_KEYS:
            os.environ.pop(k, None)
        drives = {r["drive"] for r in os_api.model_roots()}
        self.assertTrue({"C:", "D:", "G:"} <= drives, drives)
        self.assertIn(r"D:\AI Models Productivity", os_api.model_dirs())
        self.assertIn(r"D:\LM Studio", os_api.lmstudio_dirs())
        self.assertEqual(os_api.lmstudio_dir(), Path.home() / ".lmstudio" / "models")
        self.assertIn(r"D:\HuggingFace\hub", os_api.hf_caches())

    def test_env_overrides_and_hf_home(self):
        os.environ["CC_MODEL_DIRS"] = os.pathsep.join([str(self.root / "a"), str(self.root / "b"), str(self.root / "a")])
        os.environ["CC_LMSTUDIO_DIR"] = str(self.root / "lms")
        os.environ["HF_HOME"] = str(self.root / "hf")
        self.assertEqual(os_api.model_dirs(), [str(self.root / "a"), str(self.root / "b")], "deduped, in order")
        self.assertEqual(os_api.lmstudio_dir(), self.root / "lms")
        self.assertIn(str(self.root / "hf" / "hub"), os_api.hf_caches())

    def test_scan_marks_index_without_shards_incomplete_and_reads_hf_snapshots(self):
        models, lms, hf = self.root / "models", self.root / "lms", self.root / "hf"
        # Hermes-like: config + tokenizer + a safetensors index, no shards (a git-lfs clone).
        hermes = models / "Hermes-3-Llama-3.1-8B"
        for n in ("config.json", "tokenizer.json", "model.safetensors.index.json"):
            write(hermes / n, 9_000_000 if n == "tokenizer.json" else 100)
        write(hermes / ".git" / "objects" / "pack" / ("a" * 64), 6_000_000)
        write(models / "Qwen-GGUF" / "qwen.Q4_K_M.gguf", 6_000_000)
        write(lms / "lmstudio-community" / "Phi" / "phi.gguf", 6_000_000)
        snap = hf / "models--Systran--faster-whisper-tiny"
        write(snap / "blobs" / ("b" * 64), 6_000_000)
        write(snap / "snapshots" / "abc" / "model.safetensors", 6_000_000)
        os.environ["CC_MODEL_DIRS"] = str(models)
        os.environ["CC_LMSTUDIO_DIRS"] = str(lms)
        os.environ["CC_HF_CACHES"] = str(hf)
        os.environ.pop("CC_LMSTUDIO_DIR", None)
        os.environ.pop("HF_HUB_CACHE", None)
        os.environ.pop("HF_HOME", None)
        r = os_api.scan_models()
        rows = {m["name"]: m for g in r["groups"].values() for m in g}
        self.assertEqual(rows["Hermes-3-Llama-3.1-8B"]["status"], "incomplete")
        self.assertIn("shards are missing", rows["Hermes-3-Llama-3.1-8B"]["note"])
        self.assertEqual(rows["Qwen-GGUF"]["status"], "gguf")
        self.assertTrue(rows["Phi"]["registered"])
        self.assertEqual(rows["Systran/faster-whisper-tiny"]["status"], "needs-conversion", "snapshots, not hash-named blobs")
        self.assertEqual(r["count"], 4)
        self.assertTrue(all(x["exists"] for x in r["roots"] if x["path"] in (str(models), str(lms), str(hf))))

    def test_one_unreadable_root_is_skipped_with_a_note(self):
        from unittest import mock
        good, bad, lms, hf = self.root / "good", self.root / "bad", self.root / "lms", self.root / "hf"
        write(good / "Qwen-GGUF" / "qwen.Q4_K_M.gguf", 6_000_000)
        write(bad / "Other" / "other.gguf", 6_000_000)
        lms.mkdir()
        hf.mkdir()
        os.environ["CC_MODEL_DIRS"] = os.pathsep.join([str(bad), str(good)])
        os.environ["CC_LMSTUDIO_DIRS"] = str(lms)
        os.environ["CC_HF_CACHES"] = str(hf)
        for k in ("CC_LMSTUDIO_DIR", "HF_HUB_CACHE", "HF_HOME"):
            os.environ.pop(k, None)
        real_iterdir = Path.iterdir

        def iterdir(p):
            if p == bad:
                raise PermissionError(13, "Access is denied", str(p))
            return real_iterdir(p)

        with mock.patch.object(Path, "iterdir", iterdir):
            r = os_api.scan_models()
        rows = {m["name"]: m for g in r["groups"].values() for m in g}
        self.assertIn("Qwen-GGUF", rows, "the readable root is still scanned")
        self.assertNotIn("Other", rows)
        self.assertEqual(r["count"], 1)
        self.assertEqual([(e["root"], e["kind"]) for e in r["errors"]], [(str(bad), "models")])
        self.assertIn("PermissionError", r["errors"][0]["error"])
        bad_row = next(x for x in r["roots"] if x["path"] == str(bad))
        self.assertIn("Access is denied", bad_row["error"])
        self.assertNotIn("error", next(x for x in r["roots"] if x["path"] == str(good)))
        # Through the endpoint function too.
        with mock.patch.object(Path, "iterdir", iterdir):
            self.assertEqual(os_api.local_scan()["count"], 1)

    def test_real_hermes_folder_is_incomplete_if_present(self):
        d = Path(r"D:\AI Models Productivity\Hermes-3-Llama-3.1-8B")
        if not d.is_dir():
            self.skipTest("no Hermes folder on this machine")
        row = os_api._scan_folder(d)
        if row["formats"]:
            self.skipTest("Hermes weights present now")
        self.assertEqual(row["status"], "incomplete")


if __name__ == "__main__":
    unittest.main(verbosity=2)
