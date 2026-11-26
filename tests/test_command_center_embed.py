"""Vault embeddings on the CPU embedder (B5 VRAM placement): command_center_api.embed() sends
them to a CPU-only llama-server (llm.embeddingBaseUrl, :1237 by default) and never JIT-loads an
embedding model onto the GPU in LM Studio (Bionic), where Tony's model lives.

No real model server is contacted: stdlib stubs stand in for llama-server and for LM Studio.

Run with: python -m pytest tests/test_command_center_embed.py -q  (or: python tests/test_command_center_embed.py)
"""
import json
import socket
import sys
import threading
import time
import unittest
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_os_inbox import IsolatedCC  # noqa: E402

import command_center_api as cc  # noqa: E402

NOMIC = "text-embedding-nomic-embed-text-v1.5"
CPU_VEC = [1.0, 0.0, 0.0]
GPU_VEC = [0.0, 1.0, 0.0]


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class _Stub:
    """A tiny JSON server on a free port; subclasses fill in get()/post()."""

    def __init__(self):
        self.calls = []  # (path, body) of every POST
        self.gets = []
        stub = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, code, obj):
                raw = json.dumps(obj).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_GET(self):
                stub.gets.append(self.path)
                self._send(*stub.get(self.path))

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                stub.calls.append((self.path, body))
                self._send(*stub.post(self.path, body))

        self.port = _free_port()
        self.srv = ThreadingHTTPServer(("127.0.0.1", self.port), H)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    @property
    def base(self):
        return f"http://127.0.0.1:{self.port}/v1"

    def embedding_calls(self):
        return [b for p, b in self.calls if p == "/v1/embeddings"]

    def close(self):
        self.srv.shutdown()
        self.srv.server_close()


class StubEmbedder(_Stub):
    """llama-server --embedding -a <alias>: lists only its alias and, like the real one, answers
    500 "input (N tokens) is too large" past its batch (a token here = 2 characters)."""

    def __init__(self, alias=NOMIC, batch=100, fail_with=None):
        self.alias, self.batch, self.fail_with = alias, batch, fail_with
        super().__init__()

    def get(self, path):
        if path == "/v1/models":
            return 200, {"object": "list", "data": [{"id": self.alias, "object": "model"}] if self.alias else []}
        return 404, {"error": "nope"}

    def post(self, path, body):
        if path != "/v1/embeddings":
            return 404, {}
        if self.fail_with:
            return 500, {"error": {"code": 500, "message": self.fail_with, "type": "server_error"}}
        for t in body["input"]:
            tokens = len(t) // 2
            if tokens > self.batch:
                return 500, {"error": {"code": 500, "type": "server_error", "message":
                             f"input ({tokens} tokens) is too large to process. increase the physical batch size (current batch size: {self.batch})"}}
        return 200, {"model": body.get("model"), "object": "list",
                     "data": [{"index": i, "object": "embedding", "embedding": CPU_VEC} for i, _ in enumerate(body["input"])]}


class StubBionic(_Stub):
    """LM Studio: Tony's Qwen loaded; nomic loaded only when `nomic_loaded`. Any /v1/embeddings
    call here is what would JIT-load nomic onto the GPU on the real server."""

    def __init__(self, nomic_loaded=False):
        self.nomic_loaded = nomic_loaded
        super().__init__()

    def get(self, path):
        if path == "/v1/models":
            return 200, {"data": [{"id": "qwen/qwen3.5-9b"}, {"id": NOMIC}, {"id": "other-embed"}]}
        if path == "/api/v0/models":
            return 200, {"data": [
                {"id": "qwen/qwen3.5-9b", "type": "vlm", "state": "loaded"},
                {"id": NOMIC, "type": "embeddings", "state": "loaded" if self.nomic_loaded else "not-loaded"},
                {"id": "other-embed", "type": "embeddings", "state": "not-loaded"},
            ]}
        return 404, {"error": "nope"}

    def post(self, path, body):
        if path == "/v1/embeddings":
            return 200, {"data": [{"index": i, "embedding": GPU_VEC} for i, _ in enumerate(body["input"])]}
        return 404, {}


class DefaultsTests(unittest.TestCase):
    def test_default_embedder_is_the_cpu_port(self):
        self.assertEqual(cc.DEFAULT_EMBED_BASE_URL, "http://127.0.0.1:1237/v1")
        self.assertEqual(cc._default_embed_base({}), "http://127.0.0.1:1237/v1")
        self.assertEqual(cc._default_embed_base({"CC_EMBED_BASE_URL": "http://127.0.0.1:9999/v1"}), "http://127.0.0.1:9999/v1")
        self.assertEqual(cc._default_embed_base({"CC_EMBED_BASE_URL": "not a url"}), "http://127.0.0.1:1237/v1")
        llm = cc.DEFAULT_CONFIG["llm"]
        self.assertEqual(llm["embeddingModel"], NOMIC)
        self.assertNotEqual(llm["embeddingBaseUrl"].rstrip("/"), llm["baseUrl"].rstrip("/"))


class EmbedPlacementTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cpu = StubEmbedder()
        cls.gpu = StubBionic()

    @classmethod
    def tearDownClass(cls):
        cls.cpu.close()
        cls.gpu.close()

    def setUp(self):
        self.iso = IsolatedCC().__enter__()
        cc._embedder_cache.clear()
        for s in (self.cpu, self.gpu):
            s.calls.clear()
            s.gets.clear()
        self.cpu.batch, self.cpu.fail_with, self.gpu.nomic_loaded = 100, None, False
        self.configure(self.cpu.base)

    def tearDown(self):
        cc._embedder_cache.clear()
        self.iso.__exit__(None, None, None)

    def configure(self, embed_base, model=NOMIC):
        cc.save_config({"llm": {"baseUrl": self.gpu.base, "embeddingBaseUrl": embed_base, "embeddingModel": model}})
        cc._loaded_cache.clear()
        cc._models_cache.clear()

    def test_embeds_on_the_cpu_and_never_asks_lm_studio(self):
        vecs, model = cc.embed(["callback for the self-tape"])
        self.assertEqual((vecs, model), ([CPU_VEC], NOMIC))
        self.assertEqual(self.cpu.embedding_calls(), [{"model": NOMIC, "input": ["callback for the self-tape"]}])
        self.assertEqual(self.gpu.calls, [])
        cc.embed(["again"])
        self.assertEqual(self.cpu.gets.count("/v1/models"), 1)  # the served list is cached

    def test_cpu_down_and_nothing_loaded_raises_without_a_jit_load(self):
        self.configure(f"http://127.0.0.1:{_free_port()}/v1")
        with self.assertRaises(RuntimeError) as ctx:
            cc.embed(["q"])
        self.assertIn("not loaded in LM Studio", str(ctx.exception))
        self.assertEqual(self.gpu.embedding_calls(), [])  # the JIT path was never taken
        t0 = time.time()
        with self.assertRaises(RuntimeError):
            cc.embed(["q"])
        self.assertLess(time.time() - t0, 1.0)  # remembered as down: no second ~2 s refused connect

    def test_an_embedder_listing_no_model_counts_as_down(self):
        empty = StubEmbedder(alias=None)
        try:
            self.configure(empty.base)
            with self.assertRaises(RuntimeError):
                cc.embed(["q"])
            self.assertEqual(empty.embedding_calls(), [])
            self.assertEqual(self.gpu.embedding_calls(), [])  # not the old JIT path either
        finally:
            empty.close()

    def test_cpu_down_uses_lm_studio_only_when_nomic_is_already_loaded(self):
        self.gpu.nomic_loaded = True
        self.configure(f"http://127.0.0.1:{_free_port()}/v1")
        vecs, model = cc.embed(["q"])
        self.assertEqual((vecs, model), ([GPU_VEC], NOMIC))
        self.assertEqual(self.gpu.embedding_calls(), [{"model": NOMIC, "input": ["q"]}])

    def test_down_cache_expires_and_the_embedder_is_used_again(self):
        cc._embedder_cache[self.cpu.base.rstrip("/")] = (time.time() - cc.EMBED_DOWN_SECS - 1, None)
        vecs, _ = cc.embed(["q"])
        self.assertEqual(vecs, [CPU_VEC])
        cc._embedder_cache[self.cpu.base.rstrip("/")] = (time.time(), None)  # fresh "down" is honoured
        with self.assertRaises(RuntimeError):
            cc.embed(["q"])
        self.assertEqual(len(self.cpu.embedding_calls()), 1)

    def test_embedder_dying_after_its_check_is_marked_down(self):
        dying = StubEmbedder()
        base = dying.base
        self.configure(base)
        self.assertEqual(cc.embed(["q"])[0], [CPU_VEC])
        dying.close()
        self.gpu.nomic_loaded = True
        vecs, _ = cc.embed(["q"])  # the POST fails; nomic is resident in LM Studio, so it answers
        self.assertEqual(vecs, [GPU_VEC])
        self.assertIsNone(cc._embedder_cache[base][1])

    def test_long_input_is_cut_to_the_embedders_batch(self):
        long_text = "word " * 400  # 1000 "tokens" against a 100-token batch
        vecs, _ = cc.embed([long_text])
        self.assertEqual(vecs, [CPU_VEC])
        sent = [b["input"][0] for b in self.cpu.embedding_calls()]
        self.assertGreater(len(sent), 1)
        self.assertEqual(sent[0], long_text)
        self.assertLessEqual(len(sent[-1]) // 2, self.cpu.batch)
        self.assertTrue(long_text.startswith(sent[-1]))  # the start is kept
        self.assertEqual(self.gpu.calls, [])

    def test_other_server_errors_are_not_retried_or_rerouted(self):
        self.cpu.fail_with = "boom"
        self.gpu.nomic_loaded = True
        with self.assertRaises(urllib.error.HTTPError):
            cc.embed(["q"])
        self.assertEqual(len(self.cpu.embedding_calls()), 1)
        self.assertEqual(self.gpu.calls, [])

    def test_a_model_the_cpu_embedder_does_not_serve_goes_to_lm_studio(self):
        self.configure(self.cpu.base, model="other-embed")  # Nic picked an LM Studio embedder
        vecs, model = cc.embed(["q"])
        self.assertEqual((vecs, model), ([GPU_VEC], "other-embed"))
        self.assertEqual(self.cpu.embedding_calls(), [])

    def test_empty_embedding_base_is_the_old_lm_studio_path(self):
        self.configure("")
        vecs, model = cc.embed(["q"])
        self.assertEqual((vecs, model), ([GPU_VEC], NOMIC))
        self.assertEqual(self.cpu.gets, [])

    def test_vault_indexes_and_searches_on_the_cpu(self):
        cc._upsert_vault_text("n1", "notes", {"title": "deck job", "rawText": "stain colour for the deck"}, False)
        deadline = time.time() + 10
        row = None
        while time.time() < deadline:
            row = self.iso.sql("SELECT vector, model FROM vault WHERE item_id='n1'")
            if row and row[0]["vector"]:
                break
            if not cc._started:  # no background indexer in this process: index the row here
                (vec,), model = cc.embed([cc._vault_text("notes", {"title": "deck job", "rawText": "stain colour for the deck"})])
                with cc._db_lock, cc.db() as c:
                    c.execute("UPDATE vault SET vector=?, model=? WHERE item_id='n1'", (cc.array.array("f", vec).tobytes(), model))
            time.sleep(0.1)
        self.assertTrue(row and row[0]["vector"], row)
        self.assertEqual(row[0]["model"], NOMIC)
        res = cc.vault_search("deck stain", ["notes"], 5)
        self.assertEqual(res["mode"], "hybrid")  # the query was embedded too, on the CPU
        self.assertIn(["deck stain"], [b["input"] for b in self.cpu.embedding_calls()])
        self.assertEqual(self.gpu.embedding_calls(), [])


class ConfigValidationTests(unittest.TestCase):
    def setUp(self):
        self.iso = IsolatedCC().__enter__()

    def tearDown(self):
        self.iso.__exit__(None, None, None)

    def test_embedding_base_must_be_a_url_or_empty(self):
        with self.assertRaises(HTTPException) as ctx:
            cc.put_config({"llm": {"embeddingBaseUrl": "not a url"}})
        self.assertEqual(ctx.exception.status_code, 400)
        with self.assertRaises(HTTPException):
            cc.put_config({"llm": {"embeddingBaseUrl": 1237}})
        cc._embedder_cache["x"] = (time.time(), None)
        self.assertEqual(cc.put_config({"llm": {"embeddingBaseUrl": ""}})["llm"]["embeddingBaseUrl"], "")
        self.assertEqual(cc._embedder_cache, {})  # a config change re-probes the embedder
        out = cc.put_config({"llm": {"embeddingBaseUrl": "http://127.0.0.1:1237/v1"}})
        self.assertEqual(out["llm"]["embeddingBaseUrl"], "http://127.0.0.1:1237/v1")
        self.assertEqual(cc.load_config()["llm"]["embeddingBaseUrl"], "http://127.0.0.1:1237/v1")


if __name__ == "__main__":
    unittest.main(verbosity=2)
