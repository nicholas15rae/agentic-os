"""Gateway local-LLM link: the :1235 default (env override), loaded-model pinning, health
against a stub LM Studio on a free port, and the cooperative GPU lease (/api/os/gpu).

No real model server is contacted: a stdlib stub stands in for LM Studio.

Run with: python3 tests/run_all.py  (or: python3 tests/test_command_center_llm.py)
"""
import json
import re
import socket
import sys
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_os_inbox import GatewayCase, IsolatedCC  # noqa: E402

import command_center_api as cc  # noqa: E402

LOADED = "qwen/qwen3.5-9b"


class StubLMStudio:
    """/v1/models lists a big unloaded model first; /api/v0/models says which one is loaded;
    /v1/chat/completions records the model it was asked for and answers with JSON."""

    def __init__(self, v0=True):
        self.calls = []
        self.v0 = v0
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
                if self.path == "/v1/models":
                    return self._send(200, {"data": [{"id": "qwen2.5-coder-14b-instruct"}, {"id": LOADED}, {"id": "text-embedding-nomic-embed-text-v1.5"}]})
                if self.path == "/api/v0/models" and stub.v0:
                    return self._send(200, {"data": [
                        {"id": "qwen2.5-coder-14b-instruct", "type": "llm", "state": "not-loaded"},
                        {"id": LOADED, "type": "vlm", "state": "loaded"},
                        {"id": "text-embedding-nomic-embed-text-v1.5", "type": "embeddings", "state": "not-loaded"},
                    ]})
                return self._send(404, {"error": "nope"})

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                stub.calls.append(body)
                if self.path == "/v1/chat/completions":
                    return self._send(200, {"choices": [{"message": {"content": '{"title": "Stubbed"}'}}]})
                return self._send(404, {})

        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            self.port = s.getsockname()[1]
        self.srv = ThreadingHTTPServer(("127.0.0.1", self.port), H)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    @property
    def base(self):
        return f"http://127.0.0.1:{self.port}/v1"

    def close(self):
        self.srv.shutdown()
        self.srv.server_close()


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class DefaultsTests(unittest.TestCase):
    def test_default_base_url_is_the_lm_studio_port(self):
        self.assertEqual(cc.DEFAULT_LLM_BASE_URL, "http://127.0.0.1:1235/v1")
        self.assertEqual(cc._default_llm_base({}), "http://127.0.0.1:1235/v1")
        self.assertEqual(cc._default_llm_base({"CC_LLM_BASE_URL": "http://127.0.0.1:9999/v1"}), "http://127.0.0.1:9999/v1")
        self.assertEqual(cc._default_llm_base({"CC_LLM_BASE_URL": "not a url"}), "http://127.0.0.1:1235/v1")

    def test_cc_data_dir_env_is_honoured_in_a_fresh_process(self):
        import os
        import subprocess
        import tempfile
        d = tempfile.mkdtemp(prefix="agentic-os-ccdir-")
        root = Path(__file__).resolve().parent.parent
        out = subprocess.run(
            [sys.executable, "-c", "import command_center_api as cc; print(cc.CC_DIR); print(cc.DB_PATH)"],
            cwd=str(root), env={**os.environ, "CC_DATA_DIR": d, "CC_LLM_BASE_URL": ""}, capture_output=True, text=True, timeout=60,
        )
        import shutil
        shutil.rmtree(d, ignore_errors=True)
        self.assertEqual(out.returncode, 0, out.stderr)
        cc_dir, db_path = out.stdout.strip().splitlines()[-2:]
        self.assertEqual(Path(cc_dir), Path(d).resolve())
        self.assertEqual(Path(db_path), Path(d).resolve() / "cc.db")


class GpuLeaseTests(unittest.TestCase):
    def tearDown(self):
        cc.gpu_set(False)

    def test_flag_without_until_goes_stale_after_30s(self):
        cc.gpu_set(True, "pipeline", None, now=1000.0)
        self.assertTrue(cc.gpu_busy(now=1000.0))
        self.assertTrue(cc.gpu_busy(now=1029.9))
        self.assertFalse(cc.gpu_busy(now=1030.1))

    def test_until_is_honoured_but_capped(self):
        cc.gpu_set(True, "coder", 1600.0, now=1000.0)
        self.assertTrue(cc.gpu_busy(now=1500.0))
        self.assertFalse(cc.gpu_busy(now=1600.1))
        cc.gpu_set(True, "coder", 1_000_000.0, now=1000.0)  # crashed desktop with a silly lease
        self.assertTrue(cc.gpu_busy(now=1899.0))
        self.assertFalse(cc.gpu_busy(now=1900.1))
        cc.gpu_set(True, "coder", 1_600_000.0, now=1000.0)  # epoch milliseconds are accepted
        self.assertTrue(cc.gpu_busy(now=1500.0))

    def test_release_clears(self):
        cc.gpu_set(True, "x", None, now=time.time())
        self.assertTrue(cc.gpu_busy())
        cc.gpu_set(False)
        self.assertFalse(cc.gpu_busy())

    def test_wait_gpu_times_out_then_frees(self):
        cc.gpu_set(True, "x", time.time() + 60)
        t0 = time.time()
        self.assertFalse(cc.wait_gpu(0.3, poll=0.05))
        self.assertGreaterEqual(time.time() - t0, 0.25)
        cc.gpu_set(False)
        self.assertTrue(cc.wait_gpu(0.3, poll=0.05))

    def test_loopback_rule(self):
        req = lambda host, headers=None: SimpleNamespace(client=SimpleNamespace(host=host), headers=headers or {})  # noqa: E731
        self.assertTrue(cc.is_loopback_request(req("127.0.0.1")))
        self.assertTrue(cc.is_loopback_request(req("::1")))
        self.assertFalse(cc.is_loopback_request(req("100.64.3.4")))
        self.assertFalse(cc.is_loopback_request(req("127.0.0.1", {"x-forwarded-for": "1.2.3.4"})))
        self.assertFalse(cc.is_loopback_request(SimpleNamespace(client=None, headers={})))


class LlmGatewayTests(GatewayCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.stub = StubLMStudio()

    @classmethod
    def tearDownClass(cls):
        cls.stub.close()
        super().tearDownClass()

    def setUp(self):
        cc.gpu_set(False)
        cc._models_cache.clear()
        cc._loaded_cache.clear()
        self.stub.calls.clear()
        cc.save_config({"llm": {"baseUrl": self.stub.base}})

    def tearDown(self):
        cc.gpu_set(False)

    def test_health_ok_against_stub_port(self):
        s, d = self.api("GET", "/api/cc/health")
        self.assertEqual(s, 200, d)
        self.assertTrue(d["llm"]["ok"], d["llm"])
        self.assertEqual(d["llm"]["baseUrl"], self.stub.base)
        self.assertEqual(d["llm"]["loaded"], [LOADED])

    def test_health_reports_a_dead_port(self):
        cc.save_config({"llm": {"baseUrl": f"http://127.0.0.1:{_free_port()}/v1"}})
        s, d = self.api("GET", "/api/cc/health")
        self.assertEqual(s, 200)
        self.assertFalse(d["llm"]["ok"])
        self.assertTrue(d["llm"]["error"])

    def test_pick_model_prefers_the_loaded_one(self):
        self.assertEqual(cc._pick_model(""), LOADED)  # not the first listed (would JIT-load 14B)
        self.assertEqual(cc._pick_model("explicit-model"), "explicit-model")

    def test_pick_model_falls_back_without_v0(self):
        self.stub.v0 = False
        try:
            self.assertEqual(cc._pick_model(""), "qwen2.5-coder-14b-instruct")
            self.assertEqual(cc._pick_model("", "embed"), "text-embedding-nomic-embed-text-v1.5")
        finally:
            self.stub.v0 = True

    def test_llm_json_uses_the_loaded_model(self):
        s, d = self.api("POST", "/api/cc/llm/json", {"system": "Return JSON", "prompt": "hello"})
        self.assertEqual(s, 200, d)
        self.assertEqual(d, {"title": "Stubbed"})
        self.assertEqual(self.stub.calls[-1]["model"], LOADED)

    def test_llm_json_falls_back_immediately_when_gpu_busy(self):
        s, d = self.api("PUT", "/api/os/gpu", {"busy": True, "holder": "pipeline:coder", "until": time.time() + 60})
        self.assertEqual(s, 200, d)
        self.assertTrue(d["active"])
        t0 = time.time()
        s, d = self.api("POST", "/api/cc/llm/json", {"system": "Return JSON", "prompt": "hello"})
        self.assertEqual(s, 503, d)
        self.assertLess(time.time() - t0, 3.0)
        self.assertEqual(self.stub.calls, [])  # the model was never asked
        s, d = self.api("GET", "/api/cc/health")
        self.assertTrue(d["llm"]["gpuBusy"])
        s, d = self.api("PUT", "/api/os/gpu", {"busy": False})
        self.assertFalse(d["active"])
        s, d = self.api("POST", "/api/cc/llm/json", {"system": "Return JSON", "prompt": "hello"})
        self.assertEqual(s, 200, d)

    def test_gpu_put_validates(self):
        self.assertEqual(self.api("PUT", "/api/os/gpu", {"busy": "yes"})[0], 400)
        self.assertEqual(self.api("GET", "/api/os/gpu")[0], 200)

    def test_llm_chat_turns_thinking_off_by_default(self):
        # Qwen3.5 on this server honours only reasoning_effort; other servers read enable_thinking.
        out = cc.llm_chat([{"role": "user", "content": "hi"}], gpu_wait=0)
        self.assertIn("Stubbed", out)
        body = self.stub.calls[-1]
        self.assertEqual(body["reasoning_effort"], "none")
        self.assertEqual(body["chat_template_kwargs"], {"enable_thinking": False})
        self.assertFalse(body["stream"])

    def test_llm_chat_think_opt_in_sends_no_flags(self):
        cc.llm_chat([{"role": "user", "content": "hi"}], gpu_wait=0, think=True)
        body = self.stub.calls[-1]
        self.assertNotIn("reasoning_effort", body)
        self.assertNotIn("chat_template_kwargs", body)

    def test_llm_routes_send_thinking_off(self):
        s, d = self.api("POST", "/api/cc/llm/json", {"system": "Return JSON", "prompt": "hello"})
        self.assertEqual(s, 200, d)
        s, note = self.api("POST", "/api/cc/c/notes", {"title": "dump", "rawText": "call the vet tomorrow"})
        self.assertEqual(s, 200, note)
        s, d = self.api("POST", "/api/cc/brainstorm/organize", {"id": note["id"]})
        self.assertEqual(s, 200, d)
        self.assertEqual(d["organized"]["title"], "Stubbed")
        chats = [b for b in self.stub.calls if "messages" in b]
        self.assertEqual(len(chats), 2)
        for b in chats:
            self.assertEqual((b.get("reasoning_effort"), b.get("chat_template_kwargs")), ("none", {"enable_thinking": False}))

    def _upload(self, filename, mime, content):
        boundary = "----cctestboundary"
        body = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\n'
                f"Content-Type: {mime}\r\n\r\n").encode() + content + f"\r\n--{boundary}--\r\n".encode()
        req = urllib.request.Request(self.h.base_url + "/api/cc/files", data=body, method="POST",
                                     headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"null")

    def test_upload_then_ocr_sends_thinking_off(self):
        png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
        s, f = self._upload("receipt.png", "image/png", png)
        self.assertEqual(s, 200, f)
        self.assertEqual((f["name"], f["mime"], f["size"]), ("receipt.png", "image/png", len(png)))
        self.assertEqual(self.iso.sql("SELECT size FROM files WHERE id=?", (f["id"],)), [{"size": len(png)}])
        self.assertEqual(self.api("GET", f"/api/cc/files/{f['id']}")[0], 200)
        s, d = self.api("POST", "/api/cc/ocr", {"fileId": f["id"], "kind": "receipt"})
        self.assertEqual(s, 200, d)
        self.assertEqual((d["engine"], d["fields"]), ("vision-llm", {"title": "Stubbed"}))
        body = [b for b in self.stub.calls if "messages" in b][-1]
        self.assertEqual((body["reasoning_effort"], body["chat_template_kwargs"]), ("none", {"enable_thinking": False}))
        self.assertEqual(self._upload("x.exe", "application/x-msdownload", b"MZ")[0], 415)

    def test_llm_chat_waits_then_proceeds(self):
        cc.gpu_set(True, "x", time.time() + 60)
        t0 = time.time()
        out = cc.llm_chat([{"role": "user", "content": "hi"}], gpu_wait=0.6)
        self.assertGreaterEqual(time.time() - t0, 0.5)
        self.assertIn("Stubbed", out)

    def test_wrapup_route_sends_thinking_off_and_falls_back_on_bad_json(self):
        # The stub answers {"title": "Stubbed"}: no summary, no items, so strict validation
        # fails twice (the retry) and the no-model fallback is stored.
        s, note = self.api("POST", "/api/cc/c/notes", {"title": "dump", "rawText": "Nic: we should build a clock widget"})
        self.assertEqual(s, 200, note)
        s, d = self.api("POST", "/api/cc/brainstorm/wrapup", {"id": note["id"]})
        self.assertEqual(s, 503, d)
        self.assertEqual(d["reason"], "invalid")
        chats = [b for b in self.stub.calls if "messages" in b]
        self.assertEqual(len(chats), 2)
        for b in chats:
            self.assertEqual((b.get("reasoning_effort"), b.get("chat_template_kwargs")), ("none", {"enable_thinking": False}))
            self.assertEqual(b["model"], LOADED)
        self.assertEqual(d["note"]["wrapup"]["engine"], "fallback")
        self.assertEqual([i["text"] for i in d["note"]["wrapup"]["items"]], ["we should build a clock widget"])


# ── brainstorm wrap-up (POST /api/cc/brainstorm/wrapup), model mocked ─────────

T0 = 1_764_000_000_000  # epoch ms

SESSION = [
    {"t": T0, "text": "Okay so I want a clock widget with five faces, one like an E46 BMW dash.", "device": "desktop", "speaker": "nic", "mode": "talk"},
    {"t": T0 + 4000, "text": "Love it. Should the E46 face use the classic orange glow?", "device": "desktop", "speaker": "tony", "mode": "talk"},
    {"t": T0 + 9000, "text": "Yes, orange it is. I always prefer twelve hour time on clocks.", "device": "android", "speaker": "nic", "mode": "talk"},
    {"t": T0 + 15000, "text": "Next step: write the spec note tonight. Also a short film about the drive home.", "device": "android", "mode": "listen"},
    {"t": T0 + 20000, "text": "You could also remember that you like dark themes.", "device": "desktop", "speaker": "tony", "mode": "talk"},
    {"t": T0 + 22000, "text": "ok", "device": "desktop", "speaker": "nic", "mode": "talk"},
]


def _answer(items, title="E46 clock faces", summary="Nic wants a clock widget with an E46 face in orange."):
    return json.dumps({"title": title, "summary": summary, "items": items})


GOOD_ITEMS = [
    {"kind": "idea", "text": "A clock widget with five faces, one like an E46 BMW dash", "quote": "I want a clock widget with five faces, one like an E46 BMW dash", "suggested_destination": "play_place"},
    {"kind": "decision", "text": "The E46 face uses orange", "quote": "Yes, orange it is", "suggested_destination": None},
    {"kind": "idea", "text": "Nic prefers twelve hour time on clocks", "quote": "Nic: I always prefer twelve hour time on clocks", "suggested_destination": "memory", "memory_category": "preference"},
    {"kind": "next step", "text": "Write the spec note tonight", "quote": "write the spec note tonight", "suggested_destination": "ledger"},
]


class ScriptedModel:
    """Stands in for cc.llm_chat: answers (or raises) from a script, records every call."""

    def __init__(self, *script, during=None):
        self.script = list(script)
        self.calls = []
        self.during = during

    def __call__(self, messages, **kw):
        self.calls.append({"messages": messages, **kw})
        if self.during:
            self.during(len(self.calls))
        out = self.script.pop(0) if len(self.script) > 1 else self.script[0]
        if isinstance(out, BaseException):
            raise out
        return out


class WrapUpTests(GatewayCase):
    def setUp(self):
        cc.gpu_set(False)
        cc._wrapup_running.clear()

    def tearDown(self):
        cc.gpu_set(False)

    def note(self, segments=SESSION, **extra):
        s, n = self.api("POST", "/api/cc/c/notes", {"title": "Talk session", "rawText": "", "segments": segments, **extra})
        self.assertEqual(s, 200, n)
        return n["id"]

    def wrap(self, note_id, *script, during=None):
        model = ScriptedModel(*script, during=during)
        with mock.patch.object(cc, "llm_chat", model):
            s, d = self.api("POST", "/api/cc/brainstorm/wrapup", {"id": note_id})
        return s, d, model

    def stored(self, note_id):
        s, d = self.api("GET", "/api/cc/c/notes")
        self.assertEqual(s, 200)
        return next(i for i in d["items"] if i["id"] == note_id)

    def set_items(self, note_id, fn):
        n = self.stored(note_id)
        w = n["wrapup"]
        fn({i["text"]: i for i in w["items"]})
        s, d = self.api("PATCH", f"/api/cc/c/notes/{note_id}", {"wrapup": w})
        self.assertEqual(s, 200, d)

    # clean output

    def test_clean_answer_is_traced_and_stored(self):
        nid = self.note()
        s, d, model = self.wrap(nid, _answer(GOOD_ITEMS))
        self.assertEqual(s, 200, d)
        self.assertEqual(len(model.calls), 1)
        self.assertEqual(model.calls[0]["gpu_wait"], 0)
        self.assertIn("Tony: Love it.", model.calls[0]["messages"][1]["content"])
        self.assertIn("Nic: Okay so I want", model.calls[0]["messages"][1]["content"])
        w = d["wrapup"]
        self.assertEqual((w["engine"], w["dropped"], w["coveredSegments"]), ("llm", 0, len(SESSION)))
        self.assertNotIn("fallbackReason", w)
        self.assertEqual([i["kind"] for i in w["items"]], ["idea", "decision", "idea", "next_step"])
        self.assertEqual([i["suggested"] for i in w["items"]], ["play_place", None, "memory", "ledger"])
        self.assertEqual([i["dest"] for i in w["items"]], ["play_place", None, "memory", "ledger"])
        self.assertTrue(all(i["status"] == "pending" for i in w["items"]))
        self.assertTrue(all(re.fullmatch(r"w[0-9a-f]{12}", i["id"]) for i in w["items"]))
        mem = w["items"][2]
        self.assertEqual((mem["memoryCategory"], mem["speaker"], mem["t"]), ("preference", "nic", T0 + 9000))
        self.assertEqual(mem["quote"], "I always prefer twelve hour time on clocks")  # speaker label stripped
        self.assertNotIn("memoryCategory", w["items"][0])
        self.assertEqual(w["items"][3]["t"], T0 + 15000)
        # organized is rebuilt from the items and the title follows (not locked)
        self.assertEqual(d["title"], "E46 clock faces")
        org = d["organized"]
        self.assertEqual(org["actions"], [{"text": "Write the spec note tonight", "due": None}])
        self.assertEqual([c["name"] for c in org["categories"]], ["Ideas", "Decisions"])
        self.assertEqual(self.stored(nid)["wrapup"], w)

    def test_title_locked_is_kept(self):
        nid = self.note(titleLocked=True)
        s, d, _ = self.wrap(nid, _answer(GOOD_ITEMS))
        self.assertEqual(s, 200, d)
        self.assertEqual(d["title"], "Talk session")
        self.assertEqual(d["wrapup"]["title"], "E46 clock faces")

    # nothing invented

    def test_items_must_trace_to_the_transcript(self):
        nid = self.note()
        items = [
            {"kind": "idea", "text": "A podcast about cars", "quote": "let's start a podcast about cars", "suggested_destination": "director"},  # never said
            {"kind": "idea", "text": "Clock thing", "quote": "", "suggested_destination": "play_place"},  # no quote
            {"kind": "idea", "text": "Okay", "quote": "ok", "suggested_destination": None},  # too short to trace
            {"kind": "wish", "text": "Orange", "quote": "Yes, orange it is", "suggested_destination": None},  # bad kind
            "not an item",
            {"kind": "idea", "text": "Build a Ferrari configurator with VR support", "quote": "a short film about the drive home", "suggested_destination": "director"},  # drifted text
            {"kind": "idea", "text": "Nic likes dark themes", "quote": "remember that you like dark themes", "suggested_destination": "memory"},  # Tony's words
            {"kind": "decision", "text": "Orange", "quote": "YES ... ORANGE it is!!", "suggested_destination": "spaceship"},  # case/punct/ellipsis; bad dest
            {"kind": "decision", "text": "Orange again", "quote": "yes, orange it is", "suggested_destination": None},  # same item twice
        ]
        s, d, _ = self.wrap(nid, _answer(items))
        self.assertEqual(s, 200, d)
        w = d["wrapup"]
        self.assertEqual(w["dropped"], 5)
        self.assertEqual(len(w["items"]), 3)
        film, dark, orange = w["items"]
        self.assertEqual(film["text"], "a short film about the drive home")  # replaced by the quote
        self.assertEqual(film["suggested"], "director")
        self.assertEqual((dark["speaker"], dark["suggested"], dark["dest"]), ("tony", None, None))
        self.assertNotIn("memoryCategory", dark)
        self.assertEqual((orange["kind"], orange["suggested"], orange["text"]), ("decision", None, "Orange"))
        for i in w["items"]:
            self.assertIn(cc._wrap_norm(i["quote"]).split(" ... ")[0][:10], cc._wrap_norm(" ".join(x["text"] for x in SESSION)))

    def test_cross_segment_quote_and_caps(self):
        nid = self.note()
        long_text = "x" * 50
        items = [{"kind": "idea", "text": f"idea {k}", "quote": "write the spec note tonight", "suggested_destination": None} for k in range(3)]
        items[0]["quote"] = "glow? Yes, orange it is"  # spans Tony's line and Nic's: dropped
        items[1] = {"kind": "next_step", "text": "write the spec note tonight " + long_text * 10, "quote": "write the spec note tonight", "suggested_destination": "ledger"}
        items.append({"kind": "idea", "text": "The E46 face with an orange glow", "quote": "Should the E46 face use the classic orange glow", "suggested_destination": None})
        s, d, _ = self.wrap(nid, _answer(items, title="T" * 200, summary="S " * 1000))
        self.assertEqual(s, 200, d)
        w = d["wrapup"]
        self.assertEqual(w["dropped"], 1)
        self.assertEqual([i["quote"] for i in w["items"]], ["write the spec note tonight", "write the spec note tonight", "Should the E46 face use the classic orange glow"])
        self.assertEqual((w["items"][2]["speaker"], w["items"][2]["t"]), ("tony", T0 + 4000))
        self.assertLessEqual(len(w["items"][0]["text"]), cc.WRAPUP_TEXT_MAX)
        self.assertLessEqual(len(w["title"]), cc.WRAPUP_TITLE_MAX)
        self.assertLessEqual(len(w["summary"]), cc.WRAPUP_SUMMARY_MAX)

    def test_at_most_twenty_items(self):
        segs = [{"t": T0 + k, "text": f"idea number {k} is a widget for the dashboard", "device": "desktop"} for k in range(30)]
        nid = self.note(segs)
        items = [{"kind": "idea", "text": f"idea number {k}", "quote": f"idea number {k} is a widget", "suggested_destination": None} for k in range(30)]
        s, d, _ = self.wrap(nid, _answer(items))
        self.assertEqual(s, 200, d)
        self.assertEqual((len(d["wrapup"]["items"]), d["wrapup"]["dropped"]), (20, 10))

    # strict JSON + retry

    def test_bad_json_then_retry(self):
        nid = self.note()
        s, d, model = self.wrap(nid, "Sure! Here is your wrap-up: title E46", "<think>hm</think>```json\n" + _answer(GOOD_ITEMS) + "\n```")
        self.assertEqual(s, 200, d)
        self.assertEqual(len(model.calls), 2)
        self.assertEqual(len(model.calls[1]["messages"]), 3)
        self.assertIn("ONLY", model.calls[1]["messages"][-1]["content"])
        self.assertEqual(d["wrapup"]["engine"], "llm")

    def test_wrong_shape_counts_as_invalid(self):
        for bad in ('{"title": "x", "summary": "y", "items": {"a": 1}}', '{"title": 3, "summary": "y", "items": []}', '{"summary": "y", "items": []}', "[]"):
            with self.subTest(bad=bad):
                cc._wrapup_running.clear()
                nid = self.note()
                s, d, model = self.wrap(nid, bad)
                self.assertEqual(s, 503, d)
                self.assertEqual(d["reason"], "invalid")
                self.assertEqual(len(model.calls), 2)

    def test_empty_items_is_a_valid_answer(self):
        nid = self.note()
        s, d, _ = self.wrap(nid, _answer([]))
        self.assertEqual(s, 200, d)
        self.assertEqual((d["wrapup"]["engine"], d["wrapup"]["items"]), ("llm", []))

    def test_no_retry_when_the_desktop_takes_the_gpu(self):
        nid = self.note()
        s, d, model = self.wrap(nid, "not json", during=lambda n: cc.gpu_set(True, "pipeline", time.time() + 40))
        self.assertEqual(s, 503, d)
        self.assertEqual(d["reason"], "busy")
        self.assertEqual(len(model.calls), 1)
        self.assertGreaterEqual(d["retryAfter"], 30)

    # 503 + fallback + retry

    def test_gpu_busy_gives_503_fallback_without_asking_the_model(self):
        nid = self.note()
        cc.gpu_set(True, "pipeline:coder", time.time() + 60)
        with mock.patch.object(cc, "WRAPUP_GPU_WAIT_SECS", 0.2):
            t0 = time.time()
            model = ScriptedModel(_answer(GOOD_ITEMS))
            with mock.patch.object(cc, "llm_chat", model):
                status, raw = self.h.request("POST", "/api/cc/brainstorm/wrapup", {"id": nid})
            self.assertLess(time.time() - t0, 3.0)
        self.assertEqual(model.calls, [])
        self.assertEqual(status, 503)
        d = json.loads(raw)
        self.assertEqual(d["reason"], "busy")
        self.assertTrue(55 <= d["retryAfter"] <= 60, d["retryAfter"])
        req = urllib.request.Request(self.h.base_url + "/api/cc/brainstorm/wrapup", data=json.dumps({"id": nid}).encode(), method="POST", headers={"Content-Type": "application/json"})
        with mock.patch.object(cc, "WRAPUP_GPU_WAIT_SECS", 0.2):
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                urllib.request.urlopen(req, timeout=10)
        self.assertEqual(ctx.exception.code, 503)
        self.assertTrue(5 <= int(ctx.exception.headers["Retry-After"]) <= 60)
        ctx.exception.close()
        w = d["note"]["wrapup"]
        self.assertEqual((w["engine"], w["fallbackReason"]), ("fallback", "busy"))
        # Nic's own sentences (3+ words), never Tony's, never "ok"
        self.assertEqual([i["text"] for i in w["items"]], [
            "Okay so I want a clock widget with five faces, one like an E46 BMW dash.",
            "Yes, orange it is.",
            "I always prefer twelve hour time on clocks.",
            "Next step: write the spec note tonight.",
            "Also a short film about the drive home.",
        ])
        self.assertTrue(all(i["kind"] == "idea" and i["suggested"] is None and i["dest"] is None and i["speaker"] == "nic" for i in w["items"]))
        self.assertTrue(w["summary"].startswith("Okay so I want a clock widget"))
        self.assertEqual(self.stored(nid)["wrapup"]["engine"], "fallback")
        self.assertNotIn("organized", self.stored(nid))  # a fallback never rewrites organized
        # Retry once the GPU is free
        cc.gpu_set(False)
        s, d, _ = self.wrap(nid, _answer(GOOD_ITEMS))
        self.assertEqual(s, 200, d)
        self.assertEqual(d["wrapup"]["engine"], "llm")

    def test_gpu_released_during_the_short_wait_proceeds(self):
        nid = self.note()
        cc.gpu_set(True, "tony", time.time() + 60)
        threading.Timer(0.3, cc.gpu_set, args=(False,)).start()
        with mock.patch.object(cc, "WRAPUP_GPU_WAIT_SECS", 3.0):
            s, d, model = self.wrap(nid, _answer(GOOD_ITEMS))
        self.assertEqual(s, 200, d)
        self.assertEqual(len(model.calls), 1)

    def test_maintenance_window_is_busy(self):
        nid = self.note()
        cc.gpu_set(True, "maintenance: model swap", time.time() + 60)
        with mock.patch.object(cc, "WRAPUP_GPU_WAIT_SECS", 0.1), mock.patch.object(cc, "wait_gpu", lambda *a, **k: True):
            s, d, model = self.wrap(nid, _answer(GOOD_ITEMS))
        self.assertEqual((s, d["reason"]), (503, "busy"))
        self.assertEqual(model.calls, [])

    def test_model_unreachable_or_mid_call_maintenance(self):
        for exc, reason in ((urllib.error.URLError(ConnectionRefusedError(10061, "refused")), "unavailable"), (cc.GpuMaintenance("swapping"), "busy")):
            with self.subTest(reason=reason):
                nid = self.note()
                s, d, model = self.wrap(nid, exc)
                self.assertEqual(s, 503, d)
                self.assertEqual(d["reason"], reason)
                self.assertEqual(len(model.calls), 1)
                self.assertEqual(d["retryAfter"], cc.WRAPUP_RETRY_SECS)
                self.assertEqual(d["note"]["wrapup"]["fallbackReason"], reason)

    def test_fallback_never_replaces_a_model_wrapup(self):
        nid = self.note()
        s, first, _ = self.wrap(nid, _answer(GOOD_ITEMS))
        self.assertEqual(s, 200)
        s, d, _ = self.wrap(nid, urllib.error.URLError("down"))
        self.assertEqual(s, 503)
        self.assertEqual(d["note"]["wrapup"], first["wrapup"])
        self.assertEqual(self.stored(nid)["wrapup"], first["wrapup"])

    # statuses survive a re-run

    def test_rerun_keeps_statuses(self):
        nid = self.note()
        s, d, _ = self.wrap(nid, _answer(GOOD_ITEMS))
        self.assertEqual(s, 200, d)
        ids = {i["text"]: i["id"] for i in d["wrapup"]["items"]}

        def decide(items):
            items["A clock widget with five faces, one like an E46 BMW dash"].update(status="sent", sentTo={"dest": "play_place", "refId": "pp-1", "at": 1, "via": "tap"})
            items["The E46 face uses orange"]["status"] = "skipped"
            items["Write the spec note tonight"]["dest"] = "director"  # hand-picked, still pending
            items["Nic prefers twelve hour time on clocks"].update(status="failed", error="desktop closed")
        self.set_items(nid, decide)

        rerun = [
            {"kind": "idea", "text": "Five-face clock widget with an E46 face", "quote": "a clock widget with five faces, one like an E46 BMW dash", "suggested_destination": "play_place"},  # same item, new wording
            {"kind": "decision", "text": "Clock widget with E46 face", "quote": "I want a clock widget with five faces, one like an E46 BMW dash", "suggested_destination": "ledger"},  # same quote as a sent item, other kind
            {"kind": "next_step", "text": "Write the spec note tonight, before bed", "quote": "write the spec note tonight", "suggested_destination": "ledger"},
            {"kind": "idea", "text": "A short film about the drive home", "quote": "a short film about the drive home", "suggested_destination": "director"},
        ]  # orange (skipped) and twelve hour (failed) are gone from this run
        s, d, _ = self.wrap(nid, _answer(rerun))
        self.assertEqual(s, 200, d)
        items = d["wrapup"]["items"]
        by_id = {i["id"]: i for i in items}
        clock = by_id[ids["A clock widget with five faces, one like an E46 BMW dash"]]
        self.assertEqual((clock["status"], clock["sentTo"]["refId"], clock["text"]), ("sent", "pp-1", "A clock widget with five faces, one like an E46 BMW dash"))
        self.assertEqual(sum(1 for i in items if "clock widget" in i["text"].lower()), 1)  # never a second send
        self.assertEqual(by_id[ids["The E46 face uses orange"]]["status"], "skipped")
        self.assertEqual(by_id[ids["Nic prefers twelve hour time on clocks"]]["status"], "failed")
        spec = by_id[ids["Write the spec note tonight"]]
        self.assertEqual((spec["status"], spec["dest"], spec["suggested"], spec["text"]), ("pending", "director", "ledger", "Write the spec note tonight, before bed"))
        film = next(i for i in items if i["text"].startswith("A short film"))
        self.assertEqual((film["status"], film["dest"]), ("pending", "director"))
        self.assertEqual(len(items), 5)
        self.assertEqual(len({i["id"] for i in items}), 5)
        # skipped items stay out of organized
        self.assertNotIn("The E46 face uses orange", json.dumps(d["organized"]))

    def test_rerun_unchanged_is_stable(self):
        nid = self.note()
        s, a, _ = self.wrap(nid, _answer(GOOD_ITEMS))
        s, b, _ = self.wrap(nid, _answer(GOOD_ITEMS))
        self.assertEqual([i["id"] for i in a["wrapup"]["items"]], [i["id"] for i in b["wrapup"]["items"]])

    def test_fallback_decisions_survive_the_model_run(self):
        nid = self.note()
        s, d, _ = self.wrap(nid, urllib.error.URLError("down"))
        self.assertEqual(s, 503)
        self.set_items(nid, lambda items: items["Also a short film about the drive home."].update(status="sent", dest="director", sentTo={"dest": "director", "refId": "di-1", "at": 2, "via": "voice"}))
        s, d, _ = self.wrap(nid, _answer(GOOD_ITEMS + [{"kind": "idea", "text": "A short film about the drive home", "quote": "a short film about the drive home", "suggested_destination": "director"}]))
        self.assertEqual(s, 200, d)
        films = [i for i in d["wrapup"]["items"] if "film" in i["text"].lower()]
        self.assertEqual(len(films), 1)
        self.assertEqual((films[0]["status"], films[0]["sentTo"]["refId"]), ("sent", "di-1"))

    def test_status_written_while_the_model_runs_is_kept(self):
        nid = self.note()
        s, d, _ = self.wrap(nid, _answer(GOOD_ITEMS))
        self.assertEqual(s, 200)

        def phone_sends(n):
            # Another device taps Send while the model is still thinking.
            self.set_items(nid, lambda items: items["Write the spec note tonight"].update(status="sending"))
        s, d, _ = self.wrap(nid, _answer(GOOD_ITEMS), during=phone_sends)
        self.assertEqual(s, 200, d)
        spec = next(i for i in d["wrapup"]["items"] if i["text"] == "Write the spec note tonight")
        self.assertEqual(spec["status"], "sending")

    # errors and inputs

    def test_missing_empty_deleted_and_concurrent(self):
        self.assertEqual(self.wrap("no-such-note", _answer([]))[0], 404)
        nid = self.note(segments=[{"t": T0, "text": "   ", "device": "desktop"}])
        s, d, model = self.wrap(nid, _answer([]))
        self.assertEqual(s, 400, d)
        self.assertEqual(model.calls, [])
        nid = self.note()
        cc._wrapup_running.add(nid)
        s, d, model = self.wrap(nid, _answer([]))
        self.assertEqual(s, 409, d)
        self.assertEqual(model.calls, [])
        cc._wrapup_running.clear()
        self.assertEqual(self.api("DELETE", f"/api/cc/c/notes/{nid}")[0], 200)
        self.assertEqual(self.wrap(nid, _answer([]))[0], 404)
        s, d = self.api("POST", "/api/cc/c/reminders", {"title": "x", "rawText": "Nic: a note in the wrong collection"})
        self.assertEqual(self.wrap(d["id"], _answer([]))[0], 404)
        self.assertEqual(cc._wrapup_running, set())

    def test_legacy_raw_text_note_with_labels(self):
        s, n = self.api("POST", "/api/cc/c/notes", {"title": "old", "rawText": "Nic: call the vet tomorrow morning\nTony: Want me to remember your vet's name?\nbuy more dog food at the store"})
        self.assertEqual(s, 200, n)
        s, d, model = self.wrap(n["id"], _answer([
            {"kind": "next_step", "text": "Call the vet tomorrow morning", "quote": "call the vet tomorrow morning", "suggested_destination": "ledger"},
            {"kind": "next_step", "text": "Buy dog food", "quote": "buy more dog food", "suggested_destination": "ledger"},
        ]))
        self.assertEqual(s, 200, d)
        self.assertIn("Tony: Want me to remember", model.calls[0]["messages"][1]["content"])
        self.assertIn("Nic: buy more dog food", model.calls[0]["messages"][1]["content"])
        self.assertEqual([(i["speaker"], i["t"]) for i in d["wrapup"]["items"]], [("nic", None), ("nic", None)])

    def test_only_the_end_of_a_long_session_is_sent(self):
        segs = [{"t": T0 + k, "text": f"line {k} " + "word " * 40, "device": "desktop"} for k in range(200)]
        nid = self.note(segs)
        s, d, model = self.wrap(nid, _answer([]))
        self.assertEqual(s, 200, d)
        sent = model.calls[0]["messages"][1]["content"]
        self.assertLessEqual(len(sent), cc.WRAPUP_MAX_CHARS + 20)
        self.assertIn("line 199 ", sent)
        self.assertNotIn("line 0 ", sent)
        self.assertEqual(d["wrapup"]["coveredSegments"], sent.count("Nic: "))
        self.assertLess(d["wrapup"]["coveredSegments"], 200)

    def test_control_and_bidi_characters_are_stripped(self):
        nid = self.note([{"t": T0, "text": "build a timer widget for auditions", "device": "desktop"}])
        s, d, _ = self.wrap(nid, _answer([{"kind": "idea", "text": "Timer‮ widget​ for\x07 auditions", "quote": "build a timer widget for auditions", "suggested_destination": "play_place"}], title="Ti‮tle"))
        self.assertEqual(s, 200, d)
        self.assertEqual(d["wrapup"]["items"][0]["text"], "Timer widget for auditions")
        self.assertEqual(d["wrapup"]["title"], "Title")


class WrapUpUnitTests(unittest.TestCase):
    def test_trace_prefers_nic_and_honours_word_boundaries(self):
        window = [
            {"t": 1, "text": "Let's plan the shoot.", "speaker": "tony"},
            {"t": 2, "text": "Let's plan the shoot, I agree.", "speaker": "nic"},
        ]
        tr = cc._WrapTrace(window)
        self.assertEqual(tr.find("let's plan the shoot"), [1])
        self.assertIsNone(tr.find("plan the shoo"))  # not a whole word
        self.assertIsNone(tr.find("the shoot I disagree"))
        self.assertEqual(tr.find("Nic: plan the shoot... agree"), [1])
        self.assertIsNone(tr.find("agree ... plan the shoot"))  # parts out of order

    VAULT = [
        {"t": 1, "text": "I want a clock widget on the board.", "speaker": "nic"},
        {"t": 2, "text": "Honestly the old notes are a mess.", "speaker": "nic"},
        {"t": 3, "text": "We could delete everything in the vault and start fresh.", "speaker": "tony"},
        {"t": 4, "text": "No, keep all of it.", "speaker": "nic"},
    ]

    def test_a_quote_stitched_across_nic_and_tony_is_not_found(self):
        tr = cc._WrapTrace(self.VAULT)
        self.assertIsNone(tr.find("I want ... delete everything in the vault"))
        self.assertIsNone(tr.find("the old notes ... delete everything"))
        self.assertIsNone(tr.find("a mess. We could delete everything"))  # verbatim, but two speakers
        self.assertEqual(tr.find("clock widget on the board ... the old notes"), [0, 1])  # adjacent, both Nic
        self.assertEqual(tr.find("delete everything ... start fresh"), [2])
        raw = {"title": "t", "summary": "s", "items": [
            {"kind": "decision", "text": "Delete everything in the vault", "quote": "I want ... delete everything in the vault"},
            {"kind": "decision", "text": "Delete the old notes", "quote": "the old notes ... delete everything"},
        ]}
        out = cc._wrap_validate(raw, tr)
        self.assertEqual((out["items"], out["dropped"]), ([], 2))

    def test_a_long_ellipsis_gap_is_not_found(self):
        words = " ".join(f"word{k}" for k in range(20))
        tr = cc._WrapTrace([{"t": 1, "text": f"start here {words} end there", "speaker": "nic"}])
        self.assertIsNone(tr.find("start here ... end there"))  # 20 words skipped
        self.assertEqual(tr.find("start here ... word12 word13"), [0])  # word0..word11 skipped: 12, allowed
        self.assertIsNone(tr.find("start here ... word13 word14"))  # 13 skipped

    def test_a_decision_from_tonys_words_alone_is_only_his_idea(self):
        tr = cc._WrapTrace(self.VAULT)
        raw = {"title": "t", "summary": "s", "items": [
            {"kind": "decision", "text": "Delete everything in the vault", "quote": "We could delete everything in the vault"},
            {"kind": "next_step", "text": "Start fresh", "quote": "delete everything in the vault and start fresh"},
            {"kind": "decision", "text": "Keep all the old notes", "quote": "No, keep all of it"},
        ]}
        out = cc._wrap_validate(raw, tr)
        self.assertEqual(out["dropped"], 0)
        self.assertEqual([(i["kind"], i["speaker"]) for i in out["items"]], [("idea", "tony"), ("idea", "tony"), ("decision", "nic")])

    def test_merge_without_old_and_with_junk(self):
        new = {"items": [{"id": "wa", "kind": "idea", "text": "x y z", "quote": "x y z", "status": "pending", "suggested": None, "dest": None}], "engine": "llm"}
        self.assertEqual(cc._wrap_merge(None, new)["items"], new["items"])
        self.assertEqual(cc._wrap_merge({"items": "junk"}, new)["items"], new["items"])
        self.assertEqual(cc._wrap_merge({"items": [None, {"id": 3}, {"id": "old", "status": "sent", "text": "a b c", "quote": "a b c"}]}, new)["items"][1]["id"], "old")


if __name__ == "__main__":
    unittest.main(verbosity=2)
