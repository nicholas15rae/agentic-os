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

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

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
    """A stdlib stand-in for whisper-server: /v1/audio/transcriptions answers after `delay` s."""

    def __init__(self, delay=0.0, reply=None):
        self.delay, self.reply, self.hits = delay, reply or {"text": " Ciao a tutti ", "language": "it"}, 0
        stub = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length") or 0))
                stub.hits += 1
                time.sleep(stub.delay)
                raw = json.dumps(stub.reply).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
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
        self.assertEqual(data, {"text": "Ciao a tutti", "language": "it", "engine": "whisper"})

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
        self.assertEqual(data, {"text": "", "language": None, "engine": "whisper-multilingual"})
        self.assertNotEqual(seen["sidecar"], seen["loop"])
        self.assertEqual(whisper.hits, 1)

    def test_whisper_errors_still_map_to_502(self):
        lh._stt_main = lambda: {"baseUrl": "http://127.0.0.1:1/v1"}
        r = TestClient(self.app).post("/api/cc/lang/stt?lang=en", content=b"x" * 2048)
        self.assertEqual(r.status_code, 502, r.text)
        self.assertIn("Whisper unavailable", r.json()["detail"])


if __name__ == "__main__":
    unittest.main()
