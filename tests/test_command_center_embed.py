"""Vault embeddings on the CPU embedder (B5 VRAM placement): command_center_api.embed() sends
them to a CPU-only llama-server (llm.embeddingBaseUrl, :1237 by default) and never JIT-loads an
embedding model onto the GPU in LM Studio (Bionic), where Tony's model lives.

No real model server is contacted: stdlib stubs stand in for llama-server and for LM Studio.

Run with: python -m pytest tests/test_command_center_embed.py -q  (or: python tests/test_command_center_embed.py)
"""
import base64
import json
import os
import queue
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
from test_os_inbox import IsolatedCC, until  # noqa: E402

import command_center_api as cc  # noqa: E402

NOMIC = "text-embedding-nomic-embed-text-v1.5"
CPU_VEC = [1.0, 0.0, 0.0]
GPU_VEC = [0.0, 1.0, 0.0]


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class _Stub:
    """A tiny JSON server on a free port (or `port`); subclasses fill in get()/post()."""

    def __init__(self, port=None):
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

        self.port = port or _free_port()
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


def even_tokens(t):
    """The default stub tokenizer: a token = 2 characters, everywhere."""
    return len(t) // 2


def dense_tokens(t):
    """An uneven tokenizer, like WordPiece on real notes: [CLS] + [SEP], then one token per CJK
    character, digit, capital or symbol (a base64 / hash / key block), but four lowercase letters
    or spaces (prose) to a token."""
    sparse = sum(1 for c in t if c == " " or "a" <= c <= "z")
    return 2 + (len(t) - sparse) + (sparse + 3) // 4


class StubEmbedder(_Stub):
    """llama-server --embedding -a <alias>: lists only its alias and, like the real one, answers
    500 "input (N tokens) is too large" past its batch, by the same count its /tokenize gives
    (`tokens`, a token = 2 characters by default). `tokenize=False` = a server without /tokenize.
    `ms_per_token` > 0 makes it slow, with one slot (one embedding at a time), like the CPU one."""

    def __init__(self, alias=NOMIC, batch=100, fail_with=None, tokens=even_tokens, tokenize=True, ms_per_token=0.0, port=None):
        self.alias, self.batch, self.fail_with = alias, batch, fail_with
        self.tokens, self.tokenize, self.ms_per_token = tokens, tokenize, ms_per_token
        self.tokenize_count = None  # a /tokenize that disagrees with /embeddings, when set
        self.slot = threading.Lock()
        self.log = []  # (start, end, first 12 chars) of every embedding processed, in slot order
        super().__init__(port=port)

    def get(self, path):
        if path == "/v1/models":
            return 200, {"object": "list", "data": [{"id": self.alias, "object": "model"}] if self.alias else []}
        return 404, {"error": "nope"}

    def tokenize_calls(self):
        return [b for p, b in self.calls if p == "/tokenize"]

    def post(self, path, body):
        if path == "/tokenize" and self.tokenize:
            return 200, {"tokens": [7] * (self.tokenize_count or self.tokens)(body["content"])}
        if path != "/v1/embeddings":
            return 404, {}
        if self.fail_with:
            return 500, {"error": {"code": 500, "message": self.fail_with, "type": "server_error"}}
        for t in body["input"]:
            tokens = self.tokens(t)
            if tokens > self.batch:
                return 500, {"error": {"code": 500, "type": "server_error", "message":
                             f"input ({tokens} tokens) is too large to process. increase the physical batch size (current batch size: {self.batch})"}}
        with self.slot:
            t0 = time.monotonic()
            if self.ms_per_token:
                time.sleep(sum(self.tokens(t) for t in body["input"]) * self.ms_per_token / 1000)
            self.log.append((t0, time.monotonic(), body["input"][0][:12]))
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
        self.cpu.tokens, self.cpu.tokenize, self.cpu.tokenize_count, self.cpu.ms_per_token = even_tokens, True, None, 0.0
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


CJK = "".join(chr(0x4E00 + i % 2000) for i in range(3000))
PROSE = "the deck stain was picked on the north side after three samples " * 200


class _OwnStubs(unittest.TestCase):
    """An isolated store with its own CPU embedder stub (kwargs) and LM Studio stub per test."""

    stub_kwargs: dict = {}

    def setUp(self):
        self.iso = IsolatedCC().__enter__()
        cc._embedder_cache.clear()
        self.cpu = StubEmbedder(**self.stub_kwargs)
        self.gpu = StubBionic()
        cc.save_config({"llm": {"baseUrl": self.gpu.base, "embeddingBaseUrl": self.cpu.base, "embeddingModel": NOMIC}})
        cc._loaded_cache.clear()
        cc._models_cache.clear()

    def tearDown(self):
        cc._embedder_cache.clear()
        self.cpu.close()
        self.gpu.close()
        self.iso.__exit__(None, None, None)

    def sent(self):
        return [b["input"][0] for b in self.cpu.embedding_calls()]


class TokenDenseCutTests(_OwnStubs):
    """B5 review: the cut assumed even token density (keep = chars x batch / tokens), so a
    token-dense start used up its 3 tries and the row never embedded. The cut now goes by the
    embedder's own count (/tokenize), with a hard cut that always fits as the last resort."""

    stub_kwargs = {"batch": 512, "tokens": dense_tokens}

    def assert_fitting_start(self, text):
        kept = self.sent()[-1]
        self.assertTrue(text.startswith(kept))
        self.assertLessEqual(dense_tokens(kept), self.cpu.batch)
        self.assertEqual(self.gpu.calls, [])
        return kept

    def test_a_cjk_block_before_prose_still_embeds(self):
        text = CJK[:1000] + PROSE[:5000]
        self.assertGreater(dense_tokens(text), 4 * self.cpu.batch)
        vecs, _ = cc.embed([text])  # the old cut: 6000 -> 1227 -> 534 chars, each too large, then HTTPError
        self.assertEqual(vecs, [CPU_VEC])
        kept = self.assert_fitting_start(text)
        self.assertGreaterEqual(dense_tokens(kept), 0.9 * self.cpu.batch)  # cut near the limit, not far under it
        self.assertEqual(len(self.cpu.embedding_calls()), 2)  # one cut, and it fits
        self.assertLessEqual(len(self.cpu.tokenize_calls()), 1 + cc.EMBED_FIT_PROBES)

    def test_a_base64_block_before_prose_still_embeds(self):
        text = base64.b64encode(bytes(range(256)) * 12).decode()[:3000] + PROSE[:3000]
        vecs, _ = cc.embed([text])
        self.assertEqual(vecs, [CPU_VEC])
        self.assert_fitting_start(text)

    def test_without_tokenize_the_hard_cut_still_fits(self):
        self.cpu.tokenize = False
        vecs, _ = cc.embed([CJK])
        self.assertEqual(vecs, [CPU_VEC])
        self.assertGreater(len(self.assert_fitting_start(CJK)), 100)

    def test_a_tokenize_that_undercounts_ends_in_the_hard_cut(self):
        self.cpu.tokenize_count = lambda t: dense_tokens(t) // 3  # its cut is still too large
        vecs, _ = cc.embed([CJK])
        self.assertEqual(vecs, [CPU_VEC])
        self.assert_fitting_start(CJK)
        self.assertEqual(len(self.cpu.embedding_calls()), 3)

    def test_index_pieces_cover_the_whole_text_and_each_fits(self):
        text = CJK[:800] + PROSE[:4000]
        pieces = cc._split_tokens(self.cpu.base, text, 128)
        self.assertEqual("".join(pieces), text)
        self.assertGreater(len(pieces), 5)
        self.assertTrue(all(dense_tokens(p) <= 128 for p in pieces), [dense_tokens(p) for p in pieces])
        self.assertTrue(all(p.endswith(" ") for p in pieces[-3:-1]))  # prose pieces end after a space
        self.cpu.tokenize = False  # no /tokenize: hard-cut pieces, still all of it
        pieces = cc._split_tokens(self.cpu.base, text, 128)
        self.assertEqual("".join(pieces), text)
        self.assertTrue(all(dense_tokens(p) <= 128 for p in pieces))

    def test_background_embeds_every_piece_and_averages_them(self):
        text = CJK[:1500] + PROSE[:4500]  # ~2,600 tokens: more than the whole batch
        (vec,), model = cc.embed([text], background=True)
        self.assertEqual(model, NOMIC)
        self.assertAlmostEqual(sum(x * x for x in vec), 1.0, places=6)
        sent = self.sent()
        self.assertEqual("".join(sent), text)  # the whole text, not just its start
        self.assertTrue(all(dense_tokens(p) <= cc.EMBED_CHUNK_TOKENS for p in sent))
        short = "stain colour for the deck"
        self.assertEqual(cc.embed([short], background=True)[0], [CPU_VEC])  # one piece: the query-path vector
        self.assertEqual(self.sent()[-1], short)

    def test_mean_vector_is_weighted_and_unit_length(self):
        v = cc._mean_vector([[1.0, 0.0], [0.0, 1.0]], [3, 1])
        self.assertAlmostEqual(v[0], 3 / 10 ** 0.5)
        self.assertAlmostEqual(v[1], 1 / 10 ** 0.5)


class HardCutTests(unittest.TestCase):
    def test_hard_cost_covers_bytes_and_decompositions(self):
        self.assertEqual(cc._hard_cost("a"), 1)
        self.assertEqual(cc._hard_cost("é"), 3)  # 2 UTF-8 bytes; WordPiece sees e + U+0301 (3 bytes)
        self.assertEqual(cc._hard_cost("中"), 3)
        self.assertEqual(cc._hard_cost("\U0001F600"), 4)
        self.assertGreater(cc._hard_cost("ﷺ"), 10)  # one ligature, 18 letters once decomposed

    def test_hard_cut_keeps_the_longest_start_within_budget(self):
        for text in ("x" * 5000, CJK, "é" * 3000, "a\U0001F600" * 2000):
            kept = cc._hard_cut(text, 2032)
            self.assertTrue(text.startswith(kept))
            self.assertLessEqual(sum(cc._hard_cost(c) for c in kept), 2032)
            self.assertGreater(sum(cc._hard_cost(c) for c in text[: len(kept) + 1]), 2032)
        self.assertEqual(cc._hard_cut("short", 2032), "short")
        self.assertEqual(len(cc._hard_cut("x" * 5000, 2032)), 2032)


class QueryPriorityTests(_OwnStubs):
    """B5 review: the CPU embedder has one slot, so a vault search waited ~2 s behind a long note
    being indexed. The indexer now embeds in ~512-token pieces and lets queries go first."""

    # 1 ms per token, one slot: a 2,000-token note is ~2 s in one request, ~0.5 s per piece.
    stub_kwargs = {"batch": 2048, "tokens": dense_tokens, "ms_per_token": 1.0}

    def setUp(self):
        super().setUp()
        self.saved = (cc.EMBED_QUERY_GRACE_SECS, cc.EMBED_BG_MAX_DEFER_SECS)
        cc.EMBED_QUERY_GRACE_SECS = 0.2

    def tearDown(self):
        cc.EMBED_QUERY_GRACE_SECS, cc.EMBED_BG_MAX_DEFER_SECS = self.saved
        super().tearDown()

    def test_a_query_waits_for_one_piece_not_the_whole_note(self):
        note = PROSE[:8000]
        self.assertGreater(dense_tokens(note), 1900)
        out = {}
        bg = threading.Thread(target=lambda: out.setdefault("bg", cc.embed([note], background=True)))
        bg.start()
        # The note is being indexed: its first piece holds the stub's one slot. (A fixed sleep here
        # lost the race on a loaded machine: the query went in before the first piece.)
        until(self.cpu.slot.locked, timeout=10, what="the note's first piece in the CPU slot")
        t0 = time.monotonic()
        vecs, _ = cc.embed(["deck stain"])
        waited = time.monotonic() - t0
        bg.join(15)
        self.assertEqual(vecs, [CPU_VEC])
        self.assertLess(waited, 0.9, f"the query waited {waited:.2f} s")  # one ~0.5 s piece at most (whole note ~2 s)
        (vec,), _ = out["bg"]
        self.assertAlmostEqual(sum(x * x for x in vec), 1.0, places=6)
        order = [s for _, _, s in self.cpu.log]
        i = order.index("deck stain")
        self.assertTrue(0 < i < len(order) - 1, order)  # it went in between the note's pieces

    def test_indexing_holds_off_while_a_query_runs_and_just_after(self):
        gate = cc._EmbedGate()
        release, res = threading.Event(), {}

        def query():
            with gate.query():
                release.wait(5)

        q = threading.Thread(target=query)
        q.start()
        time.sleep(0.05)
        bg = threading.Thread(target=lambda: res.update(ok=gate.wait_background(), at=time.monotonic()))
        bg.start()
        time.sleep(0.3)
        self.assertNotIn("ok", res)  # held while the query runs
        ended = time.monotonic()
        release.set()
        q.join(5)
        bg.join(5)
        self.assertTrue(res["ok"])
        self.assertGreaterEqual(res["at"] - ended, cc.EMBED_QUERY_GRACE_SECS - 0.05)  # and for the grace after it
        t0 = time.monotonic()
        self.assertTrue(cc._EmbedGate().wait_background())  # no query: straight through
        self.assertLess(time.monotonic() - t0, 0.05)

    def test_indexing_never_starves(self):
        cc.EMBED_BG_MAX_DEFER_SECS = 0.3
        gate = cc._EmbedGate()
        release = threading.Event()

        def query():
            with gate.query():
                release.wait(5)

        q = threading.Thread(target=query)
        q.start()
        time.sleep(0.05)
        t0 = time.monotonic()
        self.assertFalse(gate.wait_background())  # gave up waiting: goes ahead anyway
        self.assertLess(time.monotonic() - t0, 1.0)
        release.set()
        q.join(5)


class DownBackoffTests(unittest.TestCase):
    """B5 review: with :1237 down, every call paid a ~2 s refused connect, remembered for 30 s only."""

    def setUp(self):
        cc._embedder_cache.clear()
        self.port = _free_port()  # nothing listens here
        self.base = f"http://127.0.0.1:{self.port}/v1"

    def tearDown(self):
        cc._embedder_cache.clear()
        cc._embedder_fails.clear()

    def age(self, secs):
        ts, ids = cc._embedder_cache[self.base]
        cc._embedder_cache[self.base] = (ts - secs, ids)

    def test_a_down_probe_costs_a_short_connect(self):
        self.assertLessEqual(cc.EMBED_CONNECT_SECS, 0.5)
        t0 = time.monotonic()
        self.assertIsNone(cc._embedder_models(self.base))
        self.assertLess(time.monotonic() - t0, 1.0)  # a refused loopback connect alone is ~2 s on Windows
        self.assertFalse(cc._connect_ok(self.base))

    def test_back_off_grows_while_down_and_resets_once_up(self):
        ttls = []
        for _ in range(6):
            self.assertIsNone(cc._embedder_models(self.base))
            ttls.append(cc._down_ttl(self.base))
            fails = cc._embedder_fails[self.base]
            self.age(ttls[-1] - 1)
            self.assertIsNone(cc._embedder_models(self.base))  # inside the back-off: no new probe
            self.assertEqual(cc._embedder_fails[self.base], fails)
            self.age(2)
        self.assertEqual(ttls, [30, 60, 120, 240, 300, 300])
        up = StubEmbedder(port=self.port)
        try:
            self.assertEqual(cc._embedder_models(self.base), [NOMIC])  # back: found on the next probe
            self.assertNotIn(self.base, cc._embedder_fails)
        finally:
            up.close()
        self.age(cc.EMBED_UP_SECS + 1)
        self.assertIsNone(cc._embedder_models(self.base))
        self.assertEqual(cc._down_ttl(self.base), cc.EMBED_DOWN_SECS)  # down again: starts over at 30 s

    def test_a_config_change_starts_the_back_off_over(self):
        for _ in range(3):
            cc._embedder_models(self.base)
            self.age(cc._down_ttl(self.base) + 1)
        self.assertEqual(cc._embedder_fails[self.base], 3)
        cc._embedder_cache.clear()  # what put_config does
        cc._embedder_models(self.base)
        self.assertEqual(cc._down_ttl(self.base), cc.EMBED_DOWN_SECS)


def _drain(q):
    out = []
    while not q.empty():
        out.append(q.get_nowait())
    return out


def _wait_for(pred, secs=5.0):
    deadline = time.monotonic() + secs
    while time.monotonic() < deadline:
        if pred():
            return True
        time.sleep(0.05)
    return bool(pred())


class RecoveryTests(unittest.TestCase):
    """FX5 review: the back-off (up to 300 s) kept answering "down" after :1237 came back, and the
    indexer drops a row whose embed fails, so every vault write in that window kept vector NULL
    until a manual reindex (before the back-off the window was 30 s at most). Now the indexer
    re-checks with a short connect inside the back-off, keeps rows that found the embedder down,
    and watches a down embedder while idle; the query path still pays nothing inside the back-off."""

    def setUp(self):
        self.iso = IsolatedCC().__enter__()
        self.saved = (cc.EMBED_WATCH_SECS, cc.INDEX_FAIL_PAUSE_SECS)
        cc._embedder_cache.clear()
        cc._embedder_fails.clear()
        self.port = _free_port()  # the embedder is down: nothing listens here yet
        self.base = f"http://127.0.0.1:{self.port}/v1"
        self.gpu = StubBionic()  # nomic not loaded: no fallback
        cc.save_config({"llm": {"baseUrl": self.gpu.base, "embeddingBaseUrl": self.base, "embeddingModel": NOMIC}})
        cc._loaded_cache.clear()
        cc._models_cache.clear()
        self.up = None
        self.workers = []

    def tearDown(self):
        for q, stop, t in self.workers:
            stop.set()
            q.put("")  # wakes it from its quiet wait (no such row: a skip)
            t.join(5)
        cc.EMBED_WATCH_SECS, cc.INDEX_FAIL_PAUSE_SECS = self.saved
        cc._embedder_cache.clear()
        cc._embedder_fails.clear()
        if self.up:
            self.up.close()
        self.gpu.close()
        self.iso.__exit__(None, None, None)
        self.assertFalse(any(t.is_alive() for _, _, t in self.workers), "a test indexer did not stop")

    def age(self, secs):
        ts, ids = cc._embedder_cache[self.base]
        cc._embedder_cache[self.base] = (ts - secs, ids)

    def build_backoff(self):
        """Four failed probes, each once the previous TTL ran out (an ~8 min outage with traffic)."""
        for i in range(4):
            with self.assertRaises(cc.EmbedderDown):
                cc.embed(["q"])
            if i < 3:
                self.age(cc._down_ttl(self.base) + 1)
        self.assertEqual(cc._down_ttl(self.base), 240)

    def come_back(self):
        self.up = StubEmbedder(port=self.port)  # Nic re-ran start-ai-stack.ps1

    def add_row(self, item_id, text="booking: callback for the self-tape on Friday"):
        self.iso.sql("INSERT INTO vault(item_id,collection,text,vector,model,updated) VALUES(?,?,?,?,?,?)",
                     (item_id, "notes", text, None, None, time.time()))

    def vector(self, item_id):
        rows = self.iso.sql("SELECT vector FROM vault WHERE item_id=?", (item_id,))
        return rows[0]["vector"] if rows else None

    def start_worker(self):
        q, stop = queue.Queue(), threading.Event()
        t = threading.Thread(target=cc._index_worker, args=(q, stop), daemon=True)
        t.start()
        self.workers.append((q, stop, t))
        return q

    def test_the_indexer_sees_the_embedder_back_inside_the_back_off(self):
        self.build_backoff()
        self.come_back()
        self.age(60)  # back for a minute, 180 s of back-off left
        t0 = time.monotonic()
        with self.assertRaises(cc.EmbedderDown):
            cc.embed(["q"])  # the query path keeps the cached answer: no probe inside the back-off
        self.assertLess(time.monotonic() - t0, 0.25)
        self.assertEqual(self.up.gets, [])
        (vec,), model = cc.embed(["note text"], background=True)  # before: "is down", and the row was dropped
        self.assertEqual((vec, model), (CPU_VEC, NOMIC))
        self.assertNotIn(self.base, cc._embedder_fails)  # the back-off is over
        self.assertEqual(cc.embed(["q"])[0], [CPU_VEC])  # so searches are semantic again too
        self.assertEqual(self.gpu.embedding_calls(), [])

    def test_a_failed_recheck_is_cheap_and_does_not_grow_the_back_off(self):
        self.build_backoff()
        t0 = time.monotonic()
        with self.assertRaises(cc.EmbedderDown):
            cc.embed(["note text"], background=True)
        self.assertLess(time.monotonic() - t0, 1.0)
        self.assertEqual(cc._embedder_fails[self.base], 4)
        self.assertEqual(cc._down_ttl(self.base), 240)

    def test_a_row_written_after_recovery_gets_its_vector(self):
        self.build_backoff()
        self.come_back()
        self.age(60)
        q = self.start_worker()
        cc._upsert_vault_text("n1", "notes", {"title": "booking", "rawText": "callback Friday 10 am"}, False)
        q.put("n1")  # (the gateway's own indexer, when this process runs one, gets it from the vault queue)
        self.assertTrue(_wait_for(lambda: self.vector("n1"), 5), "the row kept vector NULL")
        self.assertEqual(cc.vault_search("callback friday", ["notes"], 5)["mode"], "hybrid")

    def test_rows_that_found_the_embedder_down_wait_and_embed_once_it_is_back(self):
        waiting, q = {}, queue.Queue()
        for i in ("n1", "n2", "n3"):
            self.add_row(i)
        self.assertEqual(cc._index_step("n1", waiting, q), "waiting")
        self.assertEqual(cc._index_step("n2", waiting, q), "waiting")
        self.assertEqual(list(waiting), ["n1", "n2"])
        self.assertEqual(cc._index_step("n1", waiting, q), "waiting")  # a retry that fails again goes to the back
        self.assertEqual(list(waiting), ["n2", "n1"])
        self.assertIsNone(self.vector("n1"))
        self.come_back()
        self.assertEqual(cc._index_step("n3", waiting, q), "done")
        self.assertEqual(waiting, {})
        self.assertEqual(sorted(_drain(q)), ["n1", "n2"])  # the outage's rows go back on the queue
        for i in ("n1", "n2"):
            self.assertEqual(cc._index_step(i, waiting, q), "done")
        self.assertTrue(all(self.vector(i) for i in ("n1", "n2", "n3")))
        self.assertEqual(cc._index_step("gone", waiting, q), "skip")
        self.up.fail_with = "boom"  # the embedder answers with an error: that row is not an outage's
        self.add_row("n4")
        self.assertEqual(cc._index_step("n4", waiting, q), "failed")
        self.assertEqual(waiting, {})

    def test_the_waiting_list_is_capped(self):
        saved = cc.INDEX_WAIT_MAX
        cc.INDEX_WAIT_MAX = 2
        try:
            waiting, q = {}, queue.Queue()
            for i in ("n1", "n2", "n3"):
                self.add_row(i)
                self.assertEqual(cc._index_step(i, waiting, q), "waiting")
            self.assertEqual(list(waiting), ["n1", "n2"])
            self.assertEqual(cc._index_step("n1", waiting, q), "waiting")  # a waiting row keeps its place
            self.assertEqual(list(waiting), ["n2", "n1"])
        finally:
            cc.INDEX_WAIT_MAX = saved

    def test_a_quiet_indexer_retries_a_waiting_row_once_the_embedder_is_back(self):
        cc.EMBED_WATCH_SECS, cc.INDEX_FAIL_PAUSE_SECS = 0.2, 0.05
        q = self.start_worker()
        self.add_row("n1")
        q.put("n1")
        self.assertTrue(_wait_for(lambda: self.base in cc._embedder_cache, 5))  # its embed found the embedder down
        time.sleep(0.5)
        self.assertIsNone(self.vector("n1"))
        self.come_back()  # and no new row arrives
        self.assertTrue(_wait_for(lambda: self.vector("n1"), 5), "the waiting row was never retried")

    def test_an_idle_indexer_brings_searches_back_inside_the_back_off(self):
        self.build_backoff()
        cc.EMBED_WATCH_SECS = 0.2
        self.start_worker()
        time.sleep(0.6)
        self.assertEqual(cc._embedder_fails[self.base], 4)  # still down: watching does not grow the back-off
        self.come_back()
        self.assertTrue(_wait_for(lambda: cc._embedder_cache.get(self.base, (0, None))[1] == [NOMIC], 5))
        self.assertEqual(cc.embed(["q"])[0], [CPU_VEC])

    def test_watching_leaves_an_up_or_unconfigured_embedder_alone(self):
        self.come_back()
        self.assertEqual(cc.embed(["q"])[0], [CPU_VEC])
        cc._watch_embedder()
        self.assertEqual(self.up.gets.count("/v1/models"), 1)  # remembered up: no probe
        cc.save_config({"llm": {"baseUrl": self.gpu.base, "embeddingBaseUrl": "", "embeddingModel": NOMIC}})
        cc._embedder_cache[self.base] = (time.time(), None)
        cc._watch_embedder()  # no CPU embedder configured: nothing to watch
        self.assertEqual(self.up.gets.count("/v1/models"), 1)


@unittest.skipUnless(os.environ.get("CC_EMBED_LIVE"), "set CC_EMBED_LIVE=1 to also embed on the running :1237")
class LiveEmbedderTests(unittest.TestCase):
    """Read-only checks against the real CPU embedder (no model load, no config change)."""

    BASE = "http://127.0.0.1:1237/v1"

    def setUp(self):
        if not cc._connect_ok(self.BASE):
            self.skipTest(":1237 is down")

    def test_a_token_dense_text_embeds_and_pieces_fit(self):
        dense = base64.b64encode(os.urandom(4500)).decode()  # 6,000 chars, ~4,200 tokens
        (v,) = cc._embed_fit(self.BASE, NOMIC, [dense])
        self.assertEqual(len(v), 768)
        mixed = dense[:3000] + PROSE[:3000]
        pieces = cc._split_tokens(self.BASE, mixed, cc.EMBED_CHUNK_TOKENS)
        self.assertEqual("".join(pieces), mixed)
        count = cc._token_counter(self.BASE)
        self.assertTrue(all(count(p) <= cc.EMBED_CHUNK_TOKENS for p in pieces))


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
