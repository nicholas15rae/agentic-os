"""Language Hub gateway router (the phone's path to the phrase library).

Runs against a temp library.db (DB_PATH redirected), never data/language-hub.
Run with: python tests/test_language_hub.py
"""
import asyncio
import json
import shutil
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "stt"))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from starlette.websockets import WebSocketDisconnect  # noqa: E402

import language_hub_api as lh  # noqa: E402


class LanguageHubApi(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="lang-hub-"))
        self._db = lh.DB_PATH
        lh.DB_PATH = self.tmp / "library.db"
        app = FastAPI()
        app.include_router(lh.router)
        self.c = TestClient(app)

    def tearDown(self):
        lh.DB_PATH = self._db
        shutil.rmtree(self.tmp, ignore_errors=True)

    def entry(self, **kw):
        e = {"source_lang": "it", "target_lang": "en", "source_text": "Buongiorno", "translated_text": "Good morning", "phonetic_guide": "bwon JOR-no", "context_note": " Heard at coffee shop ", "category": "public_capture"}
        e.update(kw)
        return e

    def test_roundtrip(self):
        r = self.c.post("/api/cc/lang/entries", json=self.entry())
        self.assertEqual(r.status_code, 200, r.text)
        a = r.json()
        self.assertEqual((a["context_note"], a["mastery_status"], a["favorite"]), ("Heard at coffee shop", "new", False))
        self.c.post("/api/cc/lang/entries", json=self.entry(source_text="Ciao"))
        entries = self.c.get("/api/cc/lang/entries").json()["entries"]
        self.assertEqual(len(entries), 2)
        u = self.c.patch(f"/api/cc/lang/entries/{a['id']}", json={"favorite": True, "mastery_status": "learning", "context_note": ""}).json()
        self.assertEqual((u["favorite"], u["mastery_status"], u["context_note"]), (True, "learning", None))
        self.assertEqual(self.c.patch(f"/api/cc/lang/entries/{a['id']}", json={"mastery_status": "expert"}).status_code, 400)
        self.assertEqual(self.c.post("/api/cc/lang/entries/delete", json={"ids": [a["id"], "nope"]}).json()["deleted"], 1)
        self.assertEqual(len(self.c.get("/api/cc/lang/entries").json()["entries"]), 1)
        self.assertEqual(self.c.get("/api/cc/lang/status").json()["entries"], 1)

    def test_validation(self):
        self.assertEqual(self.c.post("/api/cc/lang/entries", json=self.entry(category="vault")).status_code, 400)
        self.assertEqual(self.c.post("/api/cc/lang/entries", json=self.entry(target_lang="auto")).status_code, 400)
        self.assertEqual(self.c.post("/api/cc/lang/entries", json=self.entry(source_text="  ")).status_code, 400)
        self.assertEqual(self.c.post("/api/cc/lang/entries", json=self.entry(source_lang="auto")).status_code, 200)

    def test_tracks(self):
        r = self.c.put("/api/cc/lang/tracks/la", json={"level": "beginner", "got": 3, "again": -2, "lessons": 1})
        self.assertEqual(r.json()["again"], 0)
        self.c.put("/api/cc/lang/tracks/la", json={"level": "intermediate", "got": 5})
        t = self.c.get("/api/cc/lang/tracks").json()["tracks"]
        self.assertEqual((len(t), t[0]["level"], t[0]["got"]), (1, "intermediate", 5))
        self.assertEqual(self.c.put("/api/cc/lang/tracks/la", json={"level": "fluent"}).status_code, 400)

    def test_srs_schedule_roundtrip_and_cleanup(self):
        a = self.c.post("/api/cc/lang/entries", json=self.entry()).json()
        self.assertIsNone(a["srs"])
        listed = self.c.get("/api/cc/lang/entries").json()["entries"][0]
        self.assertIsNone(listed["srs"])  # new card: due since it was saved
        self.assertFalse(any(k.startswith("srs_") for k in listed))
        s = {"ease": 2.5, "interval_days": 1, "due_at": 1_800_000_000_000, "reps": 1, "lapses": 0, "last_review": 1_799_913_600_000}
        u = self.c.patch(f"/api/cc/lang/entries/{a['id']}", json={"srs": s, "mastery_status": "learning"})
        self.assertEqual(u.status_code, 200, u.text)
        self.assertEqual((u.json()["srs"]["reps"], u.json()["mastery_status"]), (1, "learning"))
        self.c.patch(f"/api/cc/lang/entries/{a['id']}", json={"srs": {**s, "reps": 2, "interval_days": 6}})
        got = self.c.get("/api/cc/lang/entries").json()["entries"][0]["srs"]
        self.assertEqual((got["reps"], got["interval_days"], got["due_at"]), (2, 6, 1_800_000_000_000))
        # A patch without srs keeps the schedule.
        self.assertEqual(self.c.patch(f"/api/cc/lang/entries/{a['id']}", json={"favorite": True}).json()["srs"]["reps"], 2)
        with lh.db() as c:
            self.assertEqual(c.execute("SELECT COUNT(*) FROM srs").fetchone()[0], 1)
        self.c.post("/api/cc/lang/entries/delete", json={"ids": [a["id"]]})
        with lh.db() as c:
            self.assertEqual(c.execute("SELECT COUNT(*) FROM srs").fetchone()[0], 0)

    def test_srs_validation(self):
        a = self.c.post("/api/cc/lang/entries", json=self.entry()).json()
        url = f"/api/cc/lang/entries/{a['id']}"
        clamped = self.c.patch(url, json={"srs": {"ease": 0.4, "interval_days": 99999, "due_at": 5, "reps": -3, "lapses": 2}}).json()["srs"]
        self.assertEqual(clamped, {"ease": 1.3, "interval_days": 3650.0, "due_at": 5.0, "reps": 0, "lapses": 2, "last_review": None})
        for bad in ({"ease": 2.5}, {"due_at": "soon"}, {"due_at": -1}, "x", {"due_at": 1, "ease": "nan"}):
            self.assertEqual(self.c.patch(url, json={"srs": bad}).status_code, 400, bad)

    def test_srs_migration_is_additive_on_an_old_library(self):
        import sqlite3
        old = lh.SCHEMA.split("CREATE TABLE IF NOT EXISTS srs(")[0]
        conn = sqlite3.connect(lh.DB_PATH)
        conn.executescript(old)
        conn.execute("INSERT INTO phrases(id,timestamp,source_lang,target_lang,source_text,translated_text,category) VALUES('old',1,'it','en','Ciao','Hi','public_capture')")
        conn.commit()
        conn.close()
        entries = self.c.get("/api/cc/lang/entries").json()["entries"]
        self.assertEqual([(e["id"], e["srs"]) for e in entries], [("old", None)])
        self.assertEqual(self.c.patch("/api/cc/lang/entries/old", json={"srs": {"due_at": 9}}).json()["srs"]["due_at"], 9.0)

    def test_srs_ddl_matches_rust(self):
        # Same file, two writers: the srs DDL must be byte-identical on both sides.
        rs = (Path(__file__).resolve().parent.parent / "command center" / "src-tauri" / "src" / "commands" / "language_hub.rs").read_text(encoding="utf-8").replace("\r\n", "\n")
        py = lh.SCHEMA[lh.SCHEMA.index("CREATE TABLE IF NOT EXISTS srs("):].strip()
        self.assertIn(py, rs)

    def test_tts_unsupported_language_falls_back(self):
        r = self.c.post("/api/cc/lang/tts", json={"text": "Salve", "lang": "la"})
        self.assertEqual((r.status_code, r.json()["detail"]), (422, "UNSUPPORTED_LANG"))

    def test_stt_rejects_bad_input(self):
        self.assertEqual(self.c.post("/api/cc/lang/stt?lang=../x", content=b"x" * 2048).status_code, 400)
        self.assertEqual(self.c.post("/api/cc/lang/stt?lang=en", content=b"short").status_code, 400)

    def test_voice_settings_roundtrip(self):
        self.assertIsNone(self.c.get("/api/cc/lang/settings/voice").json()["value"])
        v = {"engine": "kokoro", "model": None, "voices": {"kokoro": {"it": "im_nicola"}}}
        self.assertEqual(self.c.put("/api/cc/lang/settings/voice", json={"value": v}).status_code, 200)
        self.assertEqual(self.c.get("/api/cc/lang/settings/voice").json()["value"], v)
        self.assertEqual(self.c.put("/api/cc/lang/settings/..x", json={"value": 1}).status_code, 400)
        self.assertEqual(self.c.put("/api/cc/lang/settings/big", json={"value": "x" * 70_000}).status_code, 413)

    PROVIDERS = {
        "providers": [
            {"id": "kokoro", "kind": "tts", "engine": "kokoro", "baseUrl": "http://127.0.0.1:1/v1", "model": "kokoro", "voice": "am_michael"},
            {"id": "elevenlabs", "kind": "tts", "engine": "elevenlabs", "baseUrl": "https://api.elevenlabs.io/v1", "model": "eleven_v4_turbo", "voice": "QhEKgDl6KUJsO1FPiuSD"},
        ],
        "agentVoices": {
            "general": {"engine": "elevenlabs", "voice": "QhEKgDl6KUJsO1FPiuSD"},
            "coder": {"engine": "elevenlabs", "voice": "FGY2WhTYpPnrIDTdsKH5", "model": "eleven_flash_v2_5"},
            "librarian": {"engine": "kokoro", "voice": "bm_george"},
        },
    }

    def patched(self, **kw):
        """Swap gateway helpers for the test; returns a restore function."""
        saved = {k: getattr(lh, k) for k in kw}
        for k, v in kw.items():
            setattr(lh, k, v)
        return lambda: [setattr(lh, k, v) for k, v in saved.items()]

    def test_resolve_agent_voice_follows_the_desktop_roster(self):
        cfg = self.PROVIDERS
        self.assertEqual(lh.resolve_agent_voice(cfg, "general", None), {"engine": "elevenlabs", "voice": "QhEKgDl6KUJsO1FPiuSD", "model": "eleven_v4_turbo"})
        self.assertEqual(lh.resolve_agent_voice(cfg, "coder", None)["model"], "eleven_flash_v2_5")
        self.assertEqual(lh.resolve_agent_voice(cfg, "librarian", None), {"engine": "kokoro", "voice": "bm_george", "model": "kokoro"})
        # Unknown agent -> Tony's voice; an explicit Kokoro id -> Kokoro; an explicit other id -> ElevenLabs.
        self.assertEqual(lh.resolve_agent_voice(cfg, "nobody", None)["voice"], "QhEKgDl6KUJsO1FPiuSD")
        self.assertEqual(lh.resolve_agent_voice(cfg, "general", "af_heart")["engine"], "kokoro")
        self.assertEqual(lh.resolve_agent_voice(cfg, "librarian", "CwhRBWXzGAHq8TQ4Fs17")["engine"], "elevenlabs")
        # No roster at all -> Kokoro with the provider's voice.
        self.assertEqual(lh.resolve_agent_voice({"providers": cfg["providers"]}, "general", None), {"engine": "kokoro", "voice": "am_michael", "model": "kokoro"})

    def test_agent_line_uses_elevenlabs_with_the_pcs_key(self):
        calls = []
        restore = self.patched(_providers=lambda: self.PROVIDERS,
                               _eleven_tts=lambda t, v, m: calls.append((t, v, m)) or b"MP3-ELEVEN",
                               _kokoro_tts=lambda p, t, v: b"MP3-KOKORO")
        try:
            r = self.c.post("/api/cc/lang/tts", json={"text": "Hey Nic", "lang": "en", "agent": "general"})
            self.assertEqual((r.status_code, r.content, r.headers["x-tts-engine"]), (200, b"MP3-ELEVEN", "elevenlabs"))
            self.assertEqual(calls, [("Hey Nic", "QhEKgDl6KUJsO1FPiuSD", "eleven_v4_turbo")])
        finally:
            restore()

    def test_agent_line_falls_back_to_kokoro(self):
        def blocked(t, v, m):
            raise lh.HTTPException(422, "KILL_SWITCH")
        used = []
        restore = self.patched(_providers=lambda: self.PROVIDERS, _eleven_tts=blocked,
                               _kokoro_tts=lambda p, t, v: used.append(v) or b"MP3-KOKORO")
        try:
            r = self.c.post("/api/cc/lang/tts", json={"text": "Hey Nic", "lang": "en", "agent": "general"})
            self.assertEqual((r.status_code, r.content, r.headers["x-tts-engine"], r.headers["x-tts-fallback"]), (200, b"MP3-KOKORO", "kokoro", "KILL_SWITCH"))
            self.assertEqual(used, ["am_michael"])  # Tony's Kokoro voice, never the ElevenLabs id
            r = self.c.post("/api/cc/lang/tts", json={"text": "Hi", "lang": "en", "agent": "librarian"})
            self.assertEqual((r.headers["x-tts-engine"], used[-1]), ("kokoro", "bm_george"))
        finally:
            restore()

    def test_eleven_tts_guards(self):
        restore = self.patched(_kill_switch=lambda: True, _eleven_key=lambda: "k" * 32)
        try:
            with self.assertRaises(lh.HTTPException) as e:
                lh._eleven_tts("hi", "QhEKgDl6KUJsO1FPiuSD", "eleven_v4_turbo")
            self.assertEqual(e.exception.detail, "KILL_SWITCH")
        finally:
            restore()
        restore = self.patched(_kill_switch=lambda: False, _eleven_key=lambda: None)
        try:
            with self.assertRaises(lh.HTTPException) as e:
                lh._eleven_tts("hi", "QhEKgDl6KUJsO1FPiuSD", "eleven_v4_turbo")
            self.assertEqual(e.exception.detail, "ELEVENLABS_NO_KEY")
        finally:
            restore()
        restore = self.patched(_kill_switch=lambda: False, _eleven_key=lambda: "k" * 32)
        try:
            with self.assertRaises(lh.HTTPException) as e:
                lh._eleven_tts("hi", "../../etc", "eleven_v4_turbo")
            self.assertEqual(e.exception.detail, "ELEVENLABS_BAD_VOICE")
        finally:
            restore()

    def test_kill_switch_reads_the_desktop_mirror_and_fails_closed(self):
        saved = lh.OS_STATE_JSON
        try:
            lh.OS_STATE_JSON = self.tmp / "missing.json"
            self.assertTrue(lh._kill_switch())
            lh.OS_STATE_JSON = self.tmp / "os-state.json"
            lh.OS_STATE_JSON.write_text('{"privacy": {"killSwitch": false}}', encoding="utf-8")
            self.assertFalse(lh._kill_switch())
            lh.OS_STATE_JSON.write_text('{"privacy": {"killSwitch": true}}', encoding="utf-8")
            self.assertTrue(lh._kill_switch())
        finally:
            lh.OS_STATE_JSON = saved

    def test_explicit_elevenlabs_engine_returns_its_error(self):
        def no_key(t, v, m):
            raise lh.HTTPException(422, "ELEVENLABS_NO_KEY")
        restore = self.patched(_providers=lambda: self.PROVIDERS, _eleven_tts=no_key)
        try:
            engines = self.c.get("/api/cc/lang/voice/engines").json()["engines"]
            self.assertEqual([(e["id"], e["local"]) for e in engines], [("kokoro", True), ("elevenlabs", False)])
            r = self.c.post("/api/cc/lang/tts", json={"text": "Ciao", "lang": "it", "engine": "elevenlabs"})
            self.assertEqual((r.status_code, r.json()["detail"]), (422, "ELEVENLABS_NO_KEY"))
            self.assertEqual(self.c.get("/api/cc/lang/voice/voices?engine=elevenlabs").status_code, 422)
            self.assertEqual(self.c.post("/api/cc/lang/tts", json={"text": "Ciao", "lang": "it", "engine": "nope"}).status_code, 422)
        finally:
            restore()

    def test_pick_ml_model(self):
        (self.tmp / "ggml-base.en.bin").write_bytes(b"x")
        self.assertIsNone(lh.pick_ml_model(self.tmp))
        (self.tmp / "ggml-small.bin").write_bytes(b"x")
        self.assertEqual(lh.pick_ml_model(self.tmp).name, "ggml-small.bin")


class SlowWhisper:
    """A stdlib stand-in for whisper-server: /v1/audio/transcriptions answers after `delay` s.
    `bodies` keeps every request body; `status` lets it play a 503 (loading / no GPU)."""

    def __init__(self, delay=0.0, reply=None, status=200, headers=None):
        self.delay, self.reply, self.hits, self.status, self.bodies = delay, reply or {"text": " Ciao a tutti ", "language": "it"}, 0, status, []
        self.headers = headers or {}
        stub = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                stub.bodies.append(self.rfile.read(int(self.headers.get("Content-Length") or 0)))
                stub.hits += 1
                time.sleep(stub.delay)
                raw = json.dumps(stub.reply).encode()
                self.send_response(stub.status)
                self.send_header("Content-Type", "application/json")
                for k, v in stub.headers.items():
                    self.send_header(k, v)
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.base = f"http://127.0.0.1:{self.srv.server_address[1]}/v1"
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def close(self):
        self.srv.shutdown()
        self.srv.server_close()


async def asgi(app, method, path, body=b""):
    """One request straight into the ASGI app on the CURRENT event loop (TestClient gives each
    request its own loop, so it can't show one request stalling another). -> (status, json)."""
    route, _, qs = path.partition("?")
    scope = {
        "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": method, "scheme": "http",
        "path": route, "raw_path": route.encode(), "query_string": qs.encode(), "root_path": "",
        "headers": [(b"host", b"gw"), (b"content-length", str(len(body)).encode())],
        "client": ("127.0.0.1", 50000), "server": ("gw", 80),
    }
    delivered, status, chunks = False, None, []

    async def receive():
        nonlocal delivered
        if not delivered:
            delivered = True
            return {"type": "http.request", "body": body, "more_body": False}
        return {"type": "http.disconnect"}

    async def send(msg):
        nonlocal status
        if msg["type"] == "http.response.start":
            status = msg["status"]
        elif msg["type"] == "http.response.body":
            chunks.append(msg.get("body", b""))

    await app(scope, receive, send)
    return status, json.loads(b"".join(chunks) or b"null")


class SttOffTheEventLoop(unittest.TestCase):
    """POST /stt used to call urlopen (and the sidecar's start-up wait) on the event loop, which
    stalled every gateway request while Whisper ran. It now runs them on a worker thread."""

    def setUp(self):
        self.app = FastAPI()
        self.app.include_router(lh.router)

        @self.app.get("/ping")
        async def ping():
            return {"ok": True}

        self._saved = {k: getattr(lh, k) for k in ("_stt_main", "ensure_sidecar")}

    def tearDown(self):
        for k, v in self._saved.items():
            setattr(lh, k, v)

    def _run(self, coro):
        return asyncio.run(coro)

    def test_other_requests_are_served_while_whisper_runs(self):
        whisper = SlowWhisper(delay=1.5)
        lh._stt_main = lambda: {"baseUrl": whisper.base, "model": "base.en"}
        try:
            async def scenario():
                t0 = time.monotonic()
                stt = asyncio.create_task(asgi(self.app, "POST", "/api/cc/lang/stt?lang=en", b"x" * 2048))
                await asyncio.sleep(0.3)  # Whisper is now busy
                ping = await asgi(self.app, "GET", "/ping")
                ping_at = time.monotonic() - t0
                r = await stt
                return r, ping, ping_at, time.monotonic() - t0

            (status, data), ping, ping_at, total = self._run(scenario())
        finally:
            whisper.close()
        self.assertEqual(ping, (200, {"ok": True}))
        self.assertGreaterEqual(total, 1.4)
        self.assertLess(ping_at, 1.0, "the event loop was blocked by the Whisper call")
        self.assertEqual(status, 200, data)
        self.assertEqual(data, {"text": "Ciao a tutti", "language": "it", "engine": "whisper", "backend": "whispercpp"})

    def test_sidecar_start_and_whisper_call_run_on_a_worker_thread(self):
        whisper = SlowWhisper(reply={"text": "[BLANK_AUDIO]"})
        seen = {}

        def fake_sidecar():
            seen["sidecar"] = threading.get_ident()
            return whisper.base

        lh.ensure_sidecar = fake_sidecar
        try:
            async def scenario():
                seen["loop"] = threading.get_ident()
                return await asgi(self.app, "POST", "/api/cc/lang/stt?lang=auto", b"x" * 2048)

            status, data = self._run(scenario())
        finally:
            whisper.close()
        self.assertEqual(status, 200, data)
        self.assertEqual(data, {"text": "", "language": None, "engine": "whisper-multilingual", "backend": "whispercpp"})
        self.assertNotEqual(seen["sidecar"], seen["loop"])
        self.assertEqual(whisper.hits, 1)
        # Non-English keeps verbose_json (the detected language) and sends no English vocabulary prompt.
        self.assertIn(b'name="response_format"\r\n\r\nverbose_json', whisper.bodies[0])
        self.assertNotIn(b'name="prompt"', whisper.bodies[0])

    def test_whisper_errors_still_map_to_502(self):
        lh._stt_main = lambda: {"baseUrl": "http://127.0.0.1:1/v1"}
        r = TestClient(self.app).post("/api/cc/lang/stt?lang=en", content=b"x" * 2048)
        self.assertEqual(r.status_code, 502, r.text)
        self.assertIn("Whisper unavailable", r.json()["detail"])


def closed_port() -> int:
    import socket

    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class EnglishStt(unittest.TestCase):
    """The phone's English STT: plain json + the desktop's vocabulary prompt and echo guard;
    faster-whisper :8177 first, whisper.cpp :8178 when it is down / not ready, re-spawn with backoff."""

    def setUp(self):
        self._saved = {k: getattr(lh, k) for k in ("_providers", "FW_PYTHON", "subprocess")}
        self._fw = dict(lh._fw)
        lh._fw.update(down_until=0.0, next_spawn=0.0, backoff=0.0, spawns=0)
        self.servers, self.spawned = [], []

        class FakePopen:
            def __init__(fake, args, **kw):
                self.spawned.append((args, kw))

        class FakeSubprocess:
            Popen = FakePopen
            DEVNULL = -3

        lh.subprocess = FakeSubprocess
        lh.FW_PYTHON = Path(__file__)  # any existing file stands in for the venv python

    def tearDown(self):
        for k, v in self._saved.items():
            setattr(lh, k, v)
        lh._fw.clear()
        lh._fw.update(self._fw)
        for s in self.servers:
            s.close()

    def stub(self, **kw):
        s = SlowWhisper(**kw)
        self.servers.append(s)
        return s

    def config(self, fw_base, wc_base, policy="faster-whisper", stt_prompt=None):
        fw = {"id": "faster-whisper", "label": "faster-whisper", "kind": "stt", "baseUrl": fw_base, "model": "large-v3-turbo", "needsKey": False, "engine": "fasterwhisper", "language": "en"}
        if stt_prompt is not None:
            fw["sttPrompt"] = stt_prompt
        cfg = {"policy": {"stt": policy}, "providers": [
            {"id": "whisper", "label": "Whisper STT", "kind": "stt", "baseUrl": wc_base, "model": "base.en", "needsKey": False, "engine": "whispercpp", "modelsDir": "G:\\whisper\\models"},
            fw,
        ]}
        lh._providers = lambda: cfg

    def test_prefers_faster_whisper_with_json_and_the_vocabulary_prompt(self):
        fw, wc = self.stub(reply={"text": " Tony, cut it. "}), self.stub(reply={"text": "wrong"})
        self.config(fw.base, wc.base)
        out = lh._transcribe(b"x" * 2048, "en")
        self.assertEqual(out, {"text": "Tony, cut it.", "language": "en", "engine": "whisper", "backend": "faster-whisper"})
        self.assertEqual((fw.hits, wc.hits), (1, 0))
        body = fw.bodies[0]
        self.assertIn(b'name="response_format"\r\n\r\njson\r\n', body)
        self.assertIn(b'name="model"\r\n\r\nlarge-v3-turbo\r\n', body)
        self.assertIn(f'name="prompt"\r\n\r\n{lh.DEFAULT_STT_PROMPT}\r\n'.encode(), body)
        self.assertNotIn(b"verbose_json", body)

    def test_falls_back_to_whisper_cpp_on_503_without_respawning(self):
        fw, wc = self.stub(status=503, reply={"error": {"type": "not_ready"}}), self.stub(reply={"text": "Play Bilmuri."})
        self.config(fw.base, wc.base)
        out = lh._transcribe(b"x" * 2048, "en")
        self.assertEqual((out["text"], out["backend"]), ("Play Bilmuri.", "whispercpp"))
        self.assertIn(b'name="model"\r\n\r\nbase.en\r\n', wc.bodies[0])
        self.assertIn(b'name="response_format"\r\n\r\njson\r\n', wc.bodies[0])
        self.assertEqual(self.spawned, [])
        # Marked down: the next turn goes straight to whisper.cpp (no 503 round trip).
        lh._transcribe(b"x" * 2048, "en")
        self.assertEqual((fw.hits, wc.hits), (1, 2))

    def test_dead_server_is_respawned_once_per_backoff_window(self):
        wc = self.stub(reply={"text": "Cut it."})
        port = closed_port()
        self.config(f"http://127.0.0.1:{port}/v1", wc.base)
        t0 = time.monotonic()
        self.assertEqual(lh._transcribe(b"x" * 2048, "en")["backend"], "whispercpp")
        # A refused localhost connect costs ~2 s on Windows; the port check keeps the fallback quick.
        self.assertLess(time.monotonic() - t0, 1.0)
        self.assertEqual(len(self.spawned), 1)
        args, kw = self.spawned[0]
        self.assertEqual(args[1:], [str(lh.FW_SCRIPT), "--port", str(port), "--model", "large-v3-turbo"])
        self.assertTrue(kw["creationflags"] & 0x8, "detached, so it outlives the gateway")
        for _ in range(3):
            lh._transcribe(b"x" * 2048, "en")
            lh._fw["down_until"] = 0.0  # force the retry path too
        self.assertEqual(len(self.spawned), 1, "re-spawned inside the backoff window")
        self.assertEqual(lh._fw["backoff"], lh.FW_BACKOFF[0])
        lh._fw["next_spawn"] = 0.0  # window over: the next failure spawns again, with a longer backoff
        lh._transcribe(b"x" * 2048, "en")
        self.assertEqual((len(self.spawned), lh._fw["backoff"]), (2, lh.FW_BACKOFF[0] * 2))
        self.assertEqual(wc.hits, 5)

    def test_a_model_argparse_would_read_as_an_option_is_not_passed(self):
        # `--model -h` makes fw_server's argparse exit (code 2) before it binds the port.
        wc = self.stub(reply={"text": "Cut it."})
        for bad in ("-h", "--port", ".."):
            lh._fw.update(next_spawn=0.0, down_until=0.0)
            self.spawned.clear()
            port = closed_port()
            self.config(f"http://127.0.0.1:{port}/v1", wc.base)
            lh._providers()["providers"][1]["model"] = bad
            lh._transcribe(b"x" * 2048, "en")
            self.assertEqual(self.spawned[0][0][1:], [str(lh.FW_SCRIPT), "--port", str(port)], bad)

    def test_a_turn_fw_server_forwarded_to_whisper_cpp_is_labelled_so(self):
        # :8177 up without a GPU model answers through its own whisper.cpp fallback: one round trip.
        fw, wc = self.stub(reply={"text": "Cut it."}, headers={"X-STT-Backend": "whispercpp", "X-Fallback-Reason": "not_ready"}), self.stub()
        self.config(fw.base, wc.base)
        out = lh._transcribe(b"x" * 2048, "en")
        self.assertEqual(out, {"text": "Cut it.", "language": "en", "engine": "whisper", "backend": "whispercpp"})
        self.assertEqual((fw.hits, wc.hits), (1, 0))
        self.assertEqual(self.spawned, [])

    def test_success_resets_the_backoff(self):
        fw, wc = self.stub(reply={"text": "Whoa."}), self.stub()
        self.config(fw.base, wc.base)
        lh._fw.update(backoff=120.0, next_spawn=time.time() + 100)
        lh._transcribe(b"x" * 2048, "en")
        self.assertEqual((lh._fw["backoff"], lh._fw["next_spawn"]), (0.0, 0.0))

    def test_whisper_cpp_policy_keeps_one_endpoint(self):
        wc = self.stub(reply={"text": "Take it easy."})
        self.config("http://127.0.0.1:1/v1", wc.base, policy="whisper")
        self.assertEqual(lh._transcribe(b"x" * 2048, "en")["backend"], "whispercpp")
        self.assertEqual(self.spawned, [])

    def test_prompt_echo_and_junk_are_dropped(self):
        fw, wc = self.stub(reply={"text": "Tony, Gabagool mode. Take it easy. Cut it. Whoa."}), self.stub()
        self.config(fw.base, wc.base)
        self.assertEqual(lh._transcribe(b"x" * 2048, "en")["text"], "")
        fw.reply = {"text": "[BLANK_AUDIO]"}
        self.assertEqual(lh._transcribe(b"x" * 2048, "en")["text"], "")

    def test_provider_prompt_override_and_blank_prompt(self):
        fw, wc = self.stub(reply={"text": "ok"}), self.stub()
        self.config(fw.base, wc.base, stt_prompt="  ")
        lh._transcribe(b"x" * 2048, "en")
        self.assertNotIn(b'name="prompt"', fw.bodies[-1])
        self.config(fw.base, wc.base, stt_prompt=" Custom words. ")
        lh._transcribe(b"x" * 2048, "en")
        self.assertIn(b'name="prompt"\r\n\r\nCustom words.\r\n', fw.bodies[-1])


def pcm16(seconds: float) -> bytes:
    """Raw PCM16 16 kHz mono (a 220 Hz tone), what the phone streams."""
    import numpy as np

    n = int(seconds * 16000)
    return (np.sin(np.arange(n) * 2 * np.pi * 220 / 16000) * 0.1 * 32767).astype("<i2").tobytes()


class FwStub:
    """fw_server over plain HTTP, like the live :8177 whose venv has no `websockets` package:
    /v1/stream answers the upgrade with 404. `text(seconds, partial)` makes each reply."""

    def __init__(self, text=None, device="cuda", final_status=200):
        self.text = text or (lambda secs, partial: "Tony, cut it.")
        self.device, self.final_status, self.bodies, self.gets = device, final_status, [], []
        stub = self

        class H(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"  # like uvicorn, so the WebSocket client reads the 404 as a status

            def log_message(self, *a):
                pass

            def reply(self, code, obj):
                raw = json.dumps(obj).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_GET(self):
                stub.gets.append(self.path)
                if self.path == "/health":
                    return self.reply(200, {"ready": True, "device": stub.device})
                self.reply(404, {"detail": "Not Found"})

            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
                stub.bodies.append(body)
                partial = b'name="partial"\r\n\r\n1\r\n' in body
                wav = body.split(b"Content-Type: audio/wav\r\n\r\n", 1)[1].rsplit(b"\r\n--", 1)[0]
                if not partial and stub.final_status != 200:
                    return self.reply(stub.final_status, {"error": {"type": "not_ready"}})
                self.reply(200, {"text": stub.text((len(wav) - 44) / 32000, partial)})

        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.port = self.srv.server_address[1]
        self.base = f"http://127.0.0.1:{self.port}/v1"
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def finals(self):
        return [b for b in self.bodies if b'name="partial"' not in b]

    def partials(self):
        return [b for b in self.bodies if b'name="partial"\r\n\r\n1\r\n' in b]

    def close(self):
        self.srv.shutdown()
        self.srv.server_close()


def growing(secs, partial):
    if not partial:
        return "Tony, cut it."
    return "Tony" if secs < 0.9 else "Tony cut" if secs < 1.5 else "Tony, cut it"


class SttStream(unittest.TestCase):
    """WebSocket /api/cc/lang/stt/stream: the phone streams PCM while you speak, sees partials,
    and gets the final without uploading the clip at the end."""

    def setUp(self):
        self._saved = {k: getattr(lh, k) for k in ("_providers", "FW_PYTHON", "subprocess", "GATEWAY_TOKEN_FILE", "STREAM_MAX_BYTES")}
        self._fw, self._st = dict(lh._fw), dict(lh._stream_state)
        lh._fw.update(down_until=0.0, next_spawn=0.0, backoff=0.0, spawns=0)
        lh._stream_state.update(no_ws_until=0.0, health=(0.0, "", False))
        self.tmp = Path(tempfile.mkdtemp(prefix="lang-stream-"))
        lh.GATEWAY_TOKEN_FILE = self.tmp / "gateway.token"  # absent = network lock off
        self.servers = []

        class FakeSubprocess:  # a down :8177 is re-spawned by the upload path; never for real here
            DEVNULL = -3

            @staticmethod
            def Popen(*a, **kw):
                return None

        lh.subprocess = FakeSubprocess
        lh.FW_PYTHON = Path(__file__)
        self.app = FastAPI()
        self.app.include_router(lh.router)

    def tearDown(self):
        for k, v in self._saved.items():
            setattr(lh, k, v)
        lh._fw.clear()
        lh._fw.update(self._fw)
        lh._stream_state.clear()
        lh._stream_state.update(self._st)
        for s in self.servers:
            s.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def fw(self, **kw):
        s = FwStub(**kw)
        self.servers.append(s)
        return s

    def config(self, fw_base, wc_base="http://127.0.0.1:1/v1", policy="faster-whisper"):
        cfg = {"policy": {"stt": policy}, "providers": [
            {"id": "whisper", "kind": "stt", "baseUrl": wc_base, "model": "base.en", "needsKey": False, "engine": "whispercpp"},
            {"id": "faster-whisper", "kind": "stt", "baseUrl": fw_base, "model": "large-v3-turbo", "needsKey": False, "engine": "fasterwhisper", "language": "en"},
        ]}
        lh._providers = lambda: cfg

    def client(self, host="127.0.0.1", **kw):
        return TestClient(self.app, client=(host, 50000), **kw)

    @staticmethod
    def begin(ws, **start):
        ws.send_text(json.dumps({"type": "start", "lang": "en", "partials": True, "partial_ms": 600, **start}))
        return ws.receive_json()

    def test_http_mode_streams_partials_and_answers_with_the_upload_paths_final(self):
        fw = self.fw(text=growing)
        self.config(fw.base)
        with self.client().websocket_connect("/api/cc/lang/stt/stream") as ws:
            self.assertEqual(self.begin(ws), {"type": "ready", "partials": True, "mode": "http"})
            got = []
            for _ in range(3):
                ws.send_bytes(pcm16(0.6))
                got.append(ws.receive_json())
            ws.send_text(json.dumps({"type": "end"}))
            final = ws.receive_json()
            with self.assertRaises(WebSocketDisconnect) as closed:
                ws.receive_json()
        self.assertEqual(closed.exception.code, 1000)
        self.assertEqual([(g["partial"], g["stable"]) for g in got], [("Tony", ""), ("Tony cut", "Tony"), ("Tony cut it", "Tony cut")])
        self.assertEqual(final, {"type": "final", "final": "Tony, cut it.", "backend": "faster-whisper", "mode": "http"})
        self.assertIn("/v1/stream", fw.gets)  # it knocked first, got a 404, and remembers it
        self.assertGreater(lh._stream_state["no_ws_until"], time.time())
        for b in fw.partials():
            self.assertIn(f'name="prompt"\r\n\r\n{lh.DEFAULT_STT_PROMPT}\r\n'.encode(), b)
            self.assertIn(b'name="session"\r\n\r\ngw-', b)
        (body,) = fw.finals()
        # The final is the upload path's own request: json + the vocabulary prompt, the whole clip.
        self.assertIn(b'name="response_format"\r\n\r\njson\r\n', body)
        self.assertIn(f'name="prompt"\r\n\r\n{lh.DEFAULT_STT_PROMPT}\r\n'.encode(), body)
        self.assertIn(lh._pcm_wav(pcm16(0.6) * 3), body)

    def test_relay_mode_uses_fw_servers_own_websocket(self):
        import fw_server as fws
        import uvicorn

        models = self.tmp / "models"
        (models / "faster-whisper-large-v3-turbo").mkdir(parents=True)
        (models / "faster-whisper-large-v3-turbo" / "model.bin").write_bytes(b"x")
        calls = []

        class Backend:
            def transcribe(self, audio, opts):
                calls.append(opts)
                text = growing(audio.size / 16000, opts.partial) if opts.initial_prompt else "warm"
                return {"text": text, "segments": [{"no_speech_prob": 0.0, "avg_logprob": -0.1}], "language": "en"}

        worker = fws.Worker(lambda p, d, c: Backend(), models, gpu=lambda: (8400, 3700), retry_backoff=(0.0, 0.0))
        self.addCleanup(worker.stop)
        self.assertTrue(worker.load("large-v3-turbo", "cuda", "int8_float16").result(5)["ready"])
        sock = fws.bind_exclusive("127.0.0.1", 0)
        server = uvicorn.Server(uvicorn.Config(fws.create_app(worker), log_level="warning", lifespan="off"))
        t = threading.Thread(target=server.run, kwargs={"sockets": [sock]}, daemon=True)
        t.start()

        def stop():
            server.should_exit = True
            t.join(10)
            sock.close()

        self.addCleanup(stop)
        for _ in range(200):
            if server.started:
                break
            time.sleep(0.02)
        self.config(f"http://127.0.0.1:{sock.getsockname()[1]}/v1")
        with self.client().websocket_connect("/api/cc/lang/stt/stream") as ws:
            self.assertEqual(self.begin(ws), {"type": "ready", "partials": True, "mode": "relay"})
            got = []
            for _ in range(2):
                ws.send_bytes(pcm16(0.6))
                got.append(ws.receive_json())
            ws.send_text(json.dumps({"type": "end"}))
            final = ws.receive_json()
        self.assertEqual([(g["partial"], g["stable"]) for g in got], [("Tony", ""), ("Tony cut", "Tony")])
        self.assertEqual(final, {"type": "final", "final": "Tony, cut it.", "backend": "faster-whisper", "mode": "relay"})
        real = [o for o in calls if o.initial_prompt]
        self.assertEqual([o.partial for o in real], [True, True, False])
        self.assertEqual({o.initial_prompt for o in real}, {lh.DEFAULT_STT_PROMPT})

    def test_a_failed_final_goes_down_the_upload_chain_to_whisper_cpp(self):
        fw, wc = self.fw(final_status=503), SlowWhisper(reply={"text": "Play Bilmuri."})
        self.servers.append(wc)
        self.config(fw.base, wc.base)
        with self.client().websocket_connect("/api/cc/lang/stt/stream") as ws:
            self.begin(ws, partials=False)
            ws.send_bytes(pcm16(1.0))
            ws.send_text(json.dumps({"type": "end"}))
            final = ws.receive_json()
        self.assertEqual((final["final"], final["backend"]), ("Play Bilmuri.", "whispercpp"))
        self.assertEqual(fw.partials(), [])
        self.assertIn(lh._pcm_wav(pcm16(1.0)), wc.bodies[0])

    def test_no_stream_without_faster_whisper_up(self):
        # whisper.cpp policy, or :8177 closed: the phone uploads (that path knows the fallbacks).
        for base, policy in (("http://127.0.0.1:1/v1", "whisper"), (f"http://127.0.0.1:{closed_port()}/v1", "faster-whisper")):
            self.config(base, policy=policy)
            with self.client().websocket_connect("/api/cc/lang/stt/stream") as ws:
                self.assertEqual(self.begin(ws), {"type": "error", "error": "unavailable"})
                with self.assertRaises(WebSocketDisconnect) as closed:
                    ws.receive_json()
            self.assertEqual(closed.exception.code, 1013)

    def test_partials_only_on_the_gpu_and_never_a_read_back_prompt(self):
        fw = self.fw(device="cpu-unavailable")
        self.config(fw.base)
        with self.client().websocket_connect("/api/cc/lang/stt/stream") as ws:
            self.assertEqual(self.begin(ws)["partials"], False)
            ws.send_bytes(pcm16(1.5))
            ws.send_text(json.dumps({"type": "end"}))
            self.assertEqual(ws.receive_json()["type"], "final")
        self.assertEqual(fw.partials(), [])
        lh._stream_state["health"] = (0.0, "", False)
        echo = self.fw(text=lambda s, p: "Tony, Gabagool mode. Take it easy. Cut it. Whoa." if p else "Cut it.")
        self.config(echo.base)
        with self.client().websocket_connect("/api/cc/lang/stt/stream") as ws:
            self.begin(ws)
            ws.send_bytes(pcm16(0.6))
            self.wait_for(lambda: len(echo.partials()) == 1)
            ws.send_text(json.dumps({"type": "end"}))
            self.assertEqual(ws.receive_json(), {"type": "final", "final": "Cut it.", "backend": "faster-whisper", "mode": "http"})

    def test_partials_pause_and_resume(self):
        fw = self.fw(text=growing)
        self.config(fw.base)
        with self.client().websocket_connect("/api/cc/lang/stt/stream") as ws:
            self.assertEqual(self.begin(ws, partials=False)["partials"], False)  # Tony was still streaming
            ws.send_bytes(pcm16(0.6))
            ws.send_text(json.dumps({"type": "config", "partials": True}))
            ws.send_bytes(pcm16(0.6))
            self.assertEqual(ws.receive_json()["partial"], "Tony cut")
            ws.send_text(json.dumps({"type": "end"}))
            self.assertEqual(ws.receive_json()["type"], "final")
        self.assertEqual(len(fw.partials()), 1)

    def wait_for(self, cond, timeout=5.0):
        t0 = time.monotonic()
        while not cond():
            self.assertLess(time.monotonic() - t0, timeout, "timed out")
            time.sleep(0.01)

    def test_network_lock_token_mesh_and_origin_rules(self):
        fw = self.fw()
        self.config(fw.base)
        # The phone over NetBird with the lock off: allowed.
        with self.client("100.84.1.7").websocket_connect("/api/cc/lang/stt/stream") as ws:
            self.assertEqual(self.begin(ws)["type"], "ready")
        lh.GATEWAY_TOKEN_FILE.write_text("s3cret-token\n", encoding="utf-8")
        for start in ({}, {"token": "wrong"}, {"token": 7}):
            with self.client("100.84.1.7").websocket_connect("/api/cc/lang/stt/stream") as ws:
                self.assertEqual(self.begin(ws, **start)["error"], "Gateway token required (network lock is on).")
                with self.assertRaises(WebSocketDisconnect) as closed:
                    ws.receive_json()
            self.assertEqual(closed.exception.code, 4401)
        with self.client("100.84.1.7").websocket_connect("/api/cc/lang/stt/stream") as ws:
            self.assertEqual(self.begin(ws, token="s3cret-token")["type"], "ready")
        with self.client("100.84.1.7").websocket_connect("/api/cc/lang/stt/stream", headers={"authorization": "Bearer s3cret-token"}) as ws:
            self.assertEqual(self.begin(ws)["type"], "ready")
        # The desktop needs no token; a LAN peer, a tunnel and a web page in the desktop's browser are refused.
        with self.client().websocket_connect("/api/cc/lang/stt/stream", headers={"origin": "http://tauri.localhost"}) as ws:
            self.assertEqual(self.begin(ws)["type"], "ready")
        for host, headers in (("192.168.1.20", {}), ("127.0.0.1", {"x-forwarded-for": "1.2.3.4"}), ("127.0.0.1", {"origin": "https://evil.example"})):
            with self.assertRaises(WebSocketDisconnect, msg=f"{host} {headers}"):
                with self.client(host).websocket_connect("/api/cc/lang/stt/stream", headers=headers) as ws:
                    ws.receive_json()

    def test_bad_messages_and_payload_caps(self):
        fw = self.fw()
        self.config(fw.base)
        c = self.client()
        with c.websocket_connect("/api/cc/lang/stt/stream") as ws:
            ws.send_bytes(pcm16(0.1))
            self.assertEqual(ws.receive_json()["error"], "expected a start message")
        with c.websocket_connect("/api/cc/lang/stt/stream") as ws:
            self.assertEqual(self.begin(ws, lang="it")["error"], "only English streams")
        with c.websocket_connect("/api/cc/lang/stt/stream") as ws:
            self.begin(ws)
            ws.send_bytes(b"\x01\x02\x03")
            self.assertEqual(ws.receive_json()["error"], "audio too long or not PCM16")
        lh.STREAM_MAX_BYTES = 32000
        with c.websocket_connect("/api/cc/lang/stt/stream") as ws:
            self.begin(ws, partials=False)
            ws.send_bytes(pcm16(0.6))
            ws.send_bytes(pcm16(0.6))
            self.assertEqual(ws.receive_json()["error"], "audio too long or not PCM16")
        with c.websocket_connect("/api/cc/lang/stt/stream") as ws:
            self.begin(ws, partials=False)
            ws.send_text(json.dumps({"type": "cancel"}))
            with self.assertRaises(WebSocketDisconnect):
                ws.receive_json()
        self.assertEqual(fw.finals(), [])

    def test_the_full_gateway_serves_it_with_this_routes_own_auth(self):
        # server.app's BaseHTTPMiddleware layers (ZeroTrust, StepUp) never see a WebSocket and CORS
        # passes it through, so the route's own checks are what guard it there.
        import server

        fw = self.fw()
        self.config(fw.base)
        lh.GATEWAY_TOKEN_FILE.write_text("s3cret-token", encoding="utf-8")
        phone = TestClient(server.app, client=("100.84.1.7", 50000))
        with phone.websocket_connect("/api/cc/lang/stt/stream", headers={"origin": "http://tauri.localhost"}) as ws:
            self.assertEqual(self.begin(ws, token="s3cret-token")["type"], "ready")
            ws.send_bytes(pcm16(1.0))
            ws.send_text(json.dumps({"type": "end"}))
            self.assertEqual(ws.receive_json()["final"], "Tony, cut it.")
        with phone.websocket_connect("/api/cc/lang/stt/stream") as ws:
            self.assertEqual(self.begin(ws, token="nope")["type"], "error")
        with self.assertRaises(WebSocketDisconnect):
            with TestClient(server.app, client=("192.168.1.20", 50000)).websocket_connect("/api/cc/lang/stt/stream") as ws:
                ws.receive_json()

    def test_local_agreement_matches_fw_server(self):
        import fw_server as fws

        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from test_fw_server import LA_CASES, la_random_sequences  # the table stt-partials.test.ts has too

        for seq, want in LA_CASES:  # incl. revisions that change the word count
            a, b = lh.LocalAgreement(), fws.LocalAgreement()
            self.assertEqual([a.push(s) for s in seq], want, seq)
            self.assertEqual([b.push(s) for s in seq], want, seq)
        for seq in la_random_sequences():
            a, b = lh.LocalAgreement(), fws.LocalAgreement()
            for s in seq:
                self.assertEqual(a.push(s), b.push(s), seq)


class EchoGuardParity(unittest.TestCase):
    """The same cases as voice.rs stt_prompt_tests: the phone and the desktop drop the same lines."""

    P = lh.DEFAULT_STT_PROMPT

    def test_prompt_echo_is_dropped(self):
        for echo in ("Tony, Gabagool mode. Take it easy.", "prompter designer coder booking desk", "WhatsApp, Gmail, Spotify, Tauri",
                     "uh BOOKING-DESK and librarian!", "Tony, Gabagool mode. Take it easy. Cut it. Whoa."):
            self.assertTrue(lh.echoes_prompt(echo, self.P), echo)

    def test_real_lines_pass(self):
        for ok in ("Cut it.", "cut it", "Take it easy.", "take it easy", "Take it ease.", "take it ease", "Whoa.", "madone", "aspetta", "Tony, cut it",
                   "play Bilmuri on Spotify", "check my Gmail", "tell the Booking Desk to check WhatsApp", "take it easy on the bass",
                   "Hey, take it easy", "Tony, take it easy", "Hey Tony, take it easy man", "hey take it easy", "Spotify Gmail WhatsApp Tauri",
                   "Take it easy, cut it.", "take it easy cut it", "Hey Tony, take it easy, cut it", "Cut it, take it easy.",
                   "I want a landing page with a hero, a pricing table and a signup form, and then loop in the booking desk and librarian "
                   "so they know it's coming. Make the colors warm."):
            self.assertFalse(lh.echoes_prompt(ok, self.P), ok)
        self.assertFalse(lh.echoes_prompt("take it ease cut it", "cut it"))

    def test_fw_server_has_the_same_echo_guard(self):
        # fw_server (its own venv, can't import this module) keeps a copy for relay-mode partials.
        import fw_server as fws

        for line in ("Tony, Gabagool mode. Take it easy.", "prompter designer coder booking desk", "WhatsApp, Gmail, Spotify, Tauri",
                     "uh BOOKING-DESK and librarian!", "Tony, Gabagool mode. Take it easy. Cut it. Whoa.", "Cut it.", "take it easy",
                     "Tony, take it easy", "Hey Tony, take it easy, cut it", "play Bilmuri on Spotify", "tell the Booking Desk to check WhatsApp",
                     "take it ease cut it", "Spotify Gmail WhatsApp Tauri", "Nic, Gabagool mode", "it's Nic"):
            self.assertEqual(fws.echoes_prompt(line, self.P), lh.echoes_prompt(line, self.P), line)
        self.assertEqual(fws._REFLEX_PHRASES, lh.REFLEX_PHRASES)

    def test_the_vocabulary_has_nic_and_lines_about_nic_pass(self):
        # Whisper wrote "Nick" (4 of turbo's 9 benchmark word errors): "Nic" is in the prompt now,
        # kept short, and the benchmark sends the same prompt the phone path does.
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "stt" / "bench"))
        import bench

        self.assertIn("nic", lh._prompt_words(self.P))
        self.assertLessEqual(len(self.P), 220)
        self.assertEqual(bench.PROMPT, self.P)
        for ok in ("Tony, it's Nic", "Hey Tony, Nic here", "Tell Nic the booking desk called", "Nic, take it easy", "Tony, gabagool mode on"):
            self.assertFalse(lh.echoes_prompt(ok, self.P), ok)
        self.assertTrue(lh.echoes_prompt("Tony, Nic, Gabagool mode. Take it easy.", self.P))

    def test_the_desktop_default_prompt_is_the_same_text(self):
        # dispatch.rs DEFAULT_STT_PROMPT is the desktop's default (Settings shows it until edited);
        # the phone path, the benchmark and the desktop must bias Whisper with the same words.
        rs = (Path(__file__).resolve().parent.parent / "command center" / "src-tauri" / "src" / "commands" / "dispatch.rs").read_text(encoding="utf-8")
        self.assertIn(f'pub const DEFAULT_STT_PROMPT: &str = "{self.P}";', rs)

    def test_effective_prompt(self):
        self.assertEqual(lh.effective_stt_prompt({}), self.P)
        self.assertIsNone(lh.effective_stt_prompt({"sttPrompt": "   "}))
        self.assertEqual(lh.effective_stt_prompt({"sttPrompt": " Custom words. "}), "Custom words.")


if __name__ == "__main__":
    unittest.main()
