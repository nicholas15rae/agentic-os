"""engine/gguf_meta.py + engine/models.py: GGUF header parsing, KV sizing (incl. hybrid attention),
library listing, VRAM parsing, the fit check and refused loads. Synthetic GGUF files; no GPU."""
import os
import struct
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine import gguf_meta as g  # noqa: E402
from engine import models as m  # noqa: E402
from engine.llama_engine import EngineRefused, EngineSettings  # noqa: E402


def _s(x: str) -> bytes:
    b = x.encode()
    return struct.pack("<Q", len(b)) + b


def write_gguf(path: Path, kv: dict, pad: int = 0) -> None:
    body = b""
    for k, v in kv.items():
        body += _s(k)
        if isinstance(v, bool):
            body += struct.pack("<I?", 7, v)
        elif isinstance(v, int):
            body += struct.pack("<IQ", 10, v)  # uint64
        elif isinstance(v, float):
            body += struct.pack("<If", 6, v)
        elif isinstance(v, str):
            body += struct.pack("<I", 8) + _s(v)
        elif isinstance(v, list) and v and isinstance(v[0], str):
            body += struct.pack("<IIQ", 9, 8, len(v)) + b"".join(_s(x) for x in v)
        elif isinstance(v, list):
            body += struct.pack("<IIQ", 9, 4, len(v)) + b"".join(struct.pack("<I", x) for x in v)
    path.write_bytes(b"GGUF" + struct.pack("<IQQ", 3, 0, len(kv)) + body + b"\0" * pad)


QWEN35 = {"general.architecture": "qwen35", "general.name": "Q", "qwen35.block_count": 32,
          "qwen35.context_length": 262144, "qwen35.embedding_length": 4096, "qwen35.attention.head_count": 16,
          "qwen35.attention.head_count_kv": 4, "qwen35.attention.key_length": 256,
          "qwen35.attention.value_length": 256, "qwen35.full_attention_interval": 4,
          "qwen35.ssm.inner_size": 4096, "qwen35.ssm.state_size": 128, "qwen35.ssm.conv_kernel": 4,
          "tokenizer.ggml.tokens": ["a", "b", "c"] * 500, "tokenizer.chat_template": "{{x}}"}
LLAMA = {"general.architecture": "llama", "llama.block_count": 32, "llama.embedding_length": 4096,
         "llama.attention.head_count": 32, "llama.attention.head_count_kv": 8}


class MetaTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_reads_keys_and_skips_vocab(self):
        p = self.d / "q.gguf"
        write_gguf(p, QWEN35)
        meta = g.read_meta(p)
        self.assertEqual(meta["qwen35.block_count"], 32)
        self.assertEqual(meta["tokenizer.ggml.tokens"], {"array_len": 1500})
        sm = g.summary(meta)
        self.assertEqual((sm["arch"], sm["attentionLayers"], sm["hasChatTemplate"]), ("qwen35", 8, True))

    def test_kv_sizes(self):
        # Qwen3.5 9B: 8 full-attention layers x 4 kv heads x (256+256) x 2 bytes x 32768 = 1 GiB
        self.assertEqual(g.kv_cache_bytes(QWEN35, 32768), 1 << 30)
        self.assertEqual(g.kv_cache_bytes(QWEN35, 32768, "q8_0", "q8_0"), int((1 << 30) * 34 / 64))
        # plain llama: all 32 layers, head_dim 128: 32 x 8 x 256 x 2 x 4096 = 512 MiB
        self.assertEqual(g.kv_cache_bytes(LLAMA, 4096), 512 << 20)
        per_layer = {**LLAMA, "llama.attention.head_count_kv": [8, 0] * 16}
        self.assertEqual(g.attention_layers(per_layer), 16)

    def test_rejects_garbage(self):
        p = self.d / "x.gguf"
        p.write_bytes(b"GGML1234")
        with self.assertRaises(g.GGUFError):
            g.read_meta(p)
        p.write_bytes(b"GGUF" + struct.pack("<IQQ", 3, 0, 5))  # promises 5 keys, has none
        with self.assertRaises(g.GGUFError):
            g.read_meta(p)


class LibraryTests(unittest.TestCase):
    def test_lists_and_sorts_by_kind(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            (d / "a" / "blobs").mkdir(parents=True)
            for rel in ("a/Qwen-9B.gguf", "a/mmproj-Qwen.gguf", "a/nomic-embed-text.gguf", "a/readme.txt",
                        "a/blobs/sha.gguf"):
                (d / rel).write_bytes(b"x" * 10)
            r = m.list_models([str(d), str(d), str(d / "missing")])
            self.assertEqual([x["name"] for x in r["chat"]], ["Qwen-9B.gguf"])  # listed once, blobs skipped
            self.assertEqual([x["name"] for x in r["projectors"]], ["mmproj-Qwen.gguf"])
            self.assertEqual([x["name"] for x in r["embedders"]], ["nomic-embed-text.gguf"])


class VramTests(unittest.TestCase):
    def test_parses_nvidia_smi(self):
        def run(args, **kw):
            if "--query-gpu=name,memory.total,memory.used,memory.free" in args:
                return SimpleNamespace(returncode=0, stdout="NVIDIA GeForce RTX 3060, 12288, 10574, 1714\n", stderr="")
            return SimpleNamespace(returncode=0, stdout="4128, C:\\x\\lms.exe, [N/A]\n77, D:\\llama-server.exe, 7000\n", stderr="")
        v = m.vram(run)
        self.assertEqual((v["totalMiB"], v["freeMiB"]), (12288, 1714))
        self.assertEqual(v["processes"][0], {"pid": 4128, "name": "lms.exe", "usedMiB": None})
        self.assertEqual(v["processes"][1]["usedMiB"], 7000)


class FitTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.p = Path(self.tmp.name) / "q.gguf"
        write_gguf(self.p, QWEN35, pad=5000 << 10)  # ~5 MiB of "weights"

    def tearDown(self):
        self.tmp.cleanup()

    def test_fit_counts_kv_and_credits_our_engine(self):
        s = EngineSettings()
        need = m.estimate(str(self.p), s)["totalMiB"]
        self.assertGreaterEqual(need, 1024 + m.COMPUTE_MIB)
        v = {"totalMiB": 12288, "freeMiB": 1655, "processes": [{"pid": 9, "usedMiB": 6000}]}
        self.assertFalse(m.fit(str(self.p), s, v)["fits"])  # Bionic holds the card
        self.assertTrue(m.fit(str(self.p), s, v, engine_pid=9)["fits"])  # replacing our own model
        f = m.fit(str(self.p), s, {"totalMiB": 12288, "freeMiB": 1000, "processes": []})
        self.assertTrue(f["fitsEmptyCard"])
        self.assertEqual(f["shortMiB"], need - (1000 - m.MARGIN_MIB))


class FakeEngine:
    def __init__(self, enabled=False):
        self.s = EngineSettings(enabled=enabled)
        self.events = []

    def _pid_info(self):
        return None

    def status(self):
        return {}

    def stop(self):
        self.events.append("stop")
        return True

    def start(self, path, alias=None, force=False):
        self.events.append(("start", path, alias, force))
        return {"health": "ok"}


class ManagerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.p = Path(self.tmp.name) / "Some-Model.gguf"
        write_gguf(self.p, QWEN35)

    def tearDown(self):
        self.tmp.cleanup()

    def test_refuses_when_off_or_not_fitting(self):
        eng = FakeEngine(enabled=False)
        mm = m.ModelManager(eng, vram_fn=lambda: {"totalMiB": 12288, "freeMiB": 12000, "processes": []})
        with self.assertRaises(EngineRefused):
            mm.load(str(self.p))
        eng.s.enabled = True
        mm._vram = lambda: {"totalMiB": 12288, "freeMiB": 1500, "processes": []}
        with self.assertRaises(EngineRefused) as c:
            mm.load(str(self.p))
        self.assertIn("won't fit", str(c.exception))
        self.assertEqual(eng.events, [])  # nothing stopped, nothing started

    def test_swap_stops_then_starts(self):
        eng = FakeEngine(enabled=True)
        mm = m.ModelManager(eng, vram_fn=lambda: {"totalMiB": 12288, "freeMiB": 11000, "processes": []})
        r = mm.load(str(self.p))
        self.assertTrue(r["fit"]["fits"])
        self.assertEqual(eng.events, ["stop", ("start", str(self.p), "some-model", False)])


if __name__ == "__main__":
    unittest.main()
