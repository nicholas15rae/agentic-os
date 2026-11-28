"""engine/download.py: name validation, library-root fence, free-space pre-flight, resume with Range,
sha256 check, and the recoverable delete (typed confirm, never the loaded model). Fake HTTP."""
import hashlib
import io
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine import download as dl  # noqa: E402

BODY = b"GGUF" + bytes(range(256)) * 40
SHA = hashlib.sha256(BODY).hexdigest()


class Resp(io.BytesIO):
    def __init__(self, data=b"", status=200, headers=None):
        super().__init__(data)
        self.status = status
        self.headers = headers or {}

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def opener_for(body=BODY, sha=SHA, honour_range=True, log=None):
    def opener(req, timeout=60):
        if log is not None:
            log.append((req.get_method(), req.headers.get("Range")))
        if req.get_method() == "HEAD":
            return Resp(headers={"X-Linked-Size": str(len(body)), "X-Linked-Etag": f'"{sha}"'})
        rng = req.headers.get("Range")
        if rng and honour_range:
            start = int(rng.split("=")[1].rstrip("-"))
            return Resp(body[start:], status=206)
        return Resp(body)
    return opener


class PlanTests(unittest.TestCase):
    def test_validation(self):
        roots = [tempfile.gettempdir()]
        root = roots[0]
        for repo, fn in (("../x/y", "a.gguf"), ("owner", "a.gguf"), ("o/r", "../a.gguf"), ("o/r", "dir/a.gguf"),
                         ("o/r", "a.safetensors"), ("o/r", "")):
            with self.assertRaises(dl.DownloadRefused, msg=(repo, fn)):
                dl.plan(repo, fn, root, roots)
        with self.assertRaises(dl.DownloadRefused):
            dl.plan("o/r", "a.gguf", "C:\\Windows", roots)
        p = dl.plan("Qwen/Qwen3-8B-GGUF", "Qwen3-8B-Q4_K_M.gguf", root, roots)
        self.assertTrue(p["url"].startswith("https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/main/"))
        self.assertTrue(p["dest"].endswith(os.path.join("Qwen", "Qwen3-8B-GGUF", "Qwen3-8B-Q4_K_M.gguf")))


class DownloadTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        self.free = lambda p: 500 << 30

    def tearDown(self):
        self.tmp.cleanup()

    def test_fresh_download_verifies_sha(self):
        r = dl.download("o/r", "m.gguf", self.root, [self.root], opener=opener_for(), free_bytes=self.free)
        self.assertEqual((r["status"], r["sha256"]), ("done", SHA))
        self.assertEqual(Path(r["path"]).read_bytes(), BODY)
        self.assertEqual(dl.download("o/r", "m.gguf", self.root, [self.root], opener=opener_for(), free_bytes=self.free)["status"], "exists")

    def test_resume_uses_range(self):
        dest = Path(self.root) / "o" / "r"
        dest.mkdir(parents=True)
        (dest / "m.gguf.part").write_bytes(BODY[:1000])
        log = []
        r = dl.download("o/r", "m.gguf", self.root, [self.root], opener=opener_for(log=log), free_bytes=self.free)
        self.assertEqual(r["status"], "done")
        self.assertIn(("GET", "bytes=1000-"), log)
        self.assertEqual(Path(r["path"]).read_bytes(), BODY)

    def test_server_ignoring_range_restarts_cleanly(self):
        dest = Path(self.root) / "o" / "r"
        dest.mkdir(parents=True)
        (dest / "m.gguf.part").write_bytes(b"junk" * 10)
        r = dl.download("o/r", "m.gguf", self.root, [self.root], opener=opener_for(honour_range=False), free_bytes=self.free)
        self.assertEqual(Path(r["path"]).read_bytes(), BODY)

    def test_sha_mismatch_is_kept_aside(self):
        with self.assertRaises(dl.DownloadRefused):
            dl.download("o/r", "m.gguf", self.root, [self.root], opener=opener_for(sha="0" * 64), free_bytes=self.free)
        d = Path(self.root) / "o" / "r"
        self.assertTrue((d / "m.gguf.bad").exists())
        self.assertFalse((d / "m.gguf").exists())

    def test_low_disk_refused(self):
        with self.assertRaises(dl.DownloadRefused):
            dl.download("o/r", "m.gguf", self.root, [self.root], opener=opener_for(), free_bytes=lambda p: 5 << 30)


class TrashTests(unittest.TestCase):
    def test_typed_confirm_root_fence_and_loaded_model(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as other:
            m = Path(root) / "a.gguf"
            m.write_bytes(b"x")
            o = Path(other) / "b.gguf"
            o.write_bytes(b"x")
            gone = []
            rec = lambda p: gone.append(p)  # noqa: E731
            with self.assertRaises(dl.DownloadRefused):
                dl.trash(str(m), "yes", [root], recycle=rec)
            with self.assertRaises(dl.DownloadRefused):
                dl.trash(str(o), "b.gguf", [root], recycle=rec)
            with self.assertRaises(dl.DownloadRefused):
                dl.trash(str(m), "a.gguf", [root], loaded=[str(m)], recycle=rec)
            self.assertEqual(gone, [])
            self.assertEqual(dl.trash(str(m), "a.gguf", [root], loaded=[str(o)], recycle=rec)["status"], "recycled")
            self.assertEqual(gone, [m])


if __name__ == "__main__":
    unittest.main()
