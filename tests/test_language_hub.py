"""Language Hub gateway router (the phone's path to the phrase library).

Runs against a temp library.db (DB_PATH redirected), never data/language-hub.
Run with: python tests/test_language_hub.py
"""
import shutil
import sys
import tempfile
import unittest
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

    def test_cloud_engine_is_desktop_only(self):
        saved = lh._providers
        lh._providers = lambda: {"providers": [
            {"id": "kokoro", "kind": "tts", "engine": "kokoro", "baseUrl": "http://127.0.0.1:1/v1", "model": "kokoro", "voice": "am_michael"},
            {"id": "elevenlabs", "kind": "tts", "engine": "elevenlabs", "baseUrl": "https://api.elevenlabs.io/v1", "model": "eleven_v4_turbo", "voice": "abc"},
        ]}
        try:
            engines = self.c.get("/api/cc/lang/voice/engines").json()["engines"]
            self.assertEqual([(e["id"], e["local"]) for e in engines], [("kokoro", True), ("elevenlabs", False)])
            r = self.c.post("/api/cc/lang/tts", json={"text": "Ciao", "lang": "it", "engine": "elevenlabs"})
            self.assertEqual((r.status_code, r.json()["detail"]), (422, "ENGINE_DESKTOP_ONLY"))
            self.assertEqual(self.c.get("/api/cc/lang/voice/voices?engine=elevenlabs").status_code, 422)
            self.assertEqual(self.c.post("/api/cc/lang/tts", json={"text": "Ciao", "lang": "it", "engine": "nope"}).status_code, 422)
        finally:
            lh._providers = saved

    def test_pick_ml_model(self):
        (self.tmp / "ggml-base.en.bin").write_bytes(b"x")
        self.assertIsNone(lh.pick_ml_model(self.tmp))
        (self.tmp / "ggml-small.bin").write_bytes(b"x")
        self.assertEqual(lh.pick_ml_model(self.tmp).name, "ggml-small.bin")


if __name__ == "__main__":
    unittest.main()
