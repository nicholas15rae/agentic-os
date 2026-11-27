"""Command Center security layer, gateway side (security_api.py).

Boots a small FastAPI app with the real StepUpMiddleware + /api/security router (inside CORS, as
server.py wires it) on a free port. Every file goes to a temp dir (AGENTIC_OS_SECURITY_DIR,
TRADING_DATA_DIR): nothing touches the real data/security or data/trading, and no positions or
orders are involved. Standard library only (urllib), like the rest of tests/.
"""
import base64
import hashlib
import hmac
import json
import os
import shutil
import socket
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

TMP = Path(tempfile.mkdtemp(prefix="cc-sec-test-"))
os.environ["AGENTIC_OS_SECURITY_DIR"] = str(TMP / "security")
os.environ["TRADING_DATA_DIR"] = str(TMP / "trading")
os.environ["CC_REMOTE_KILL_SECRET"] = ""  # the file in the temp dir is the only secret

import security_api as sa  # noqa: E402

KEY = b"0123456789abcdef0123456789abcdef"
RK = "a" * 64


def mint(module: str, exp: float, ep: int, key: bytes = KEY) -> str:
    body = base64.urlsafe_b64encode(json.dumps({"m": module, "sid": "s1", "exp": int(exp), "ep": ep}, separators=(",", ":")).encode()).rstrip(b"=").decode()
    tag = base64.urlsafe_b64encode(hmac.new(key, f"v1.{body}".encode(), hashlib.sha256).digest()).rstrip(b"=").decode()
    return f"v1.{body}.{tag}"


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class SecurityLayerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import uvicorn
        from fastapi import FastAPI
        from fastapi.middleware.cors import CORSMiddleware

        d = sa.sec_dir()
        d.mkdir(parents=True, exist_ok=True)
        (d / "elevation.key").write_text(KEY.hex())
        (d / "remote_kill.key").write_text(RK)
        (d / "security.config.json").write_text(json.dumps({"alerts": {"enabled": False}}))
        app = FastAPI()
        app.add_middleware(sa.StepUpMiddleware)
        app.add_middleware(CORSMiddleware, allow_origins=["http://tauri.localhost"], allow_methods=["*"], allow_headers=["*"])
        app.include_router(sa.router)

        @app.post("/api/trading/mode")
        def mode():
            return {"ok": True}

        @app.post("/api/trading/kill-switch")
        def kill():
            return {"ok": True, "estop": True}

        @app.post("/api/cc/c/income")
        def income():
            return {"ok": True}

        @app.post("/api/cc/c/notes")
        def notes():
            return {"ok": True}

        cls.port = free_port()
        cls.server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=cls.port, log_level="error"))
        threading.Thread(target=cls.server.run, daemon=True).start()
        for _ in range(100):
            if cls.server.started:
                break
            time.sleep(0.05)

    @classmethod
    def tearDownClass(cls):
        cls.server.should_exit = True
        time.sleep(0.3)
        shutil.rmtree(TMP, ignore_errors=True)

    def setUp(self):
        (sa.sec_dir() / "state.json").unlink(missing_ok=True)
        (TMP / "trading" / "TRADING_LOCKED.json").unlink(missing_ok=True)
        sa._SEEN_SIGS.clear()
        sa._BAD.clear()

    def call(self, path, method="POST", body=b"{}", headers=None):
        h = {"Content-Type": "application/json", "Origin": "http://tauri.localhost", **(headers or {})}
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=body if method != "GET" else None, method=method, headers=h)
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, json.loads(r.read() or b"null"), dict(r.headers)
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"null"), dict(e.headers)

    # ── tokens ──────────────────────────────────────────────────────────────

    def test_cross_language_vectors(self):
        # Same vectors as Rust security::token::tests::cross_language_vectors.
        t = "v1.eyJtIjoidHJhZGluZyIsInNpZCI6InMxIiwiZXhwIjoxMDAwLCJlcCI6N30.QsAV98QFC2VYH9O6jLxaImj4hFqcf6DLSCkDwrXxGn4"
        self.assertEqual(mint("trading", 1000, 7), t)
        self.assertEqual(sa.webhook_signature(b"remote-secret", "1700000000", b'{"reason":"phone"}'), "sha256=338b3922e7e2848a8fc0e383180807fd869ca09d0a3b1a00fa98326b4c2e6731")

    def test_token_rules(self):
        ok = mint("trading", time.time() + 60, 0)
        self.assertIsNone(sa.verify_token(ok, "trading"))
        self.assertEqual(sa.verify_token(ok, "finance"), "wrong module")
        self.assertEqual(sa.verify_token(mint("trading", time.time() - 1, 0), "trading"), "expired")
        self.assertEqual(sa.verify_token(mint("trading", time.time() + 60, 0, key=b"x" * 32), "trading"), "bad signature")
        sa.hard_lock("t", "test")
        self.assertEqual(sa.verify_token(ok, "trading"), "hard locked")

    # ── step-up middleware ──────────────────────────────────────────────────

    def test_read_only_by_default_and_step_up(self):
        code, body, hdrs = self.call("/api/trading/mode", body=b'{"mode":"ADVISORY"}')
        self.assertEqual(code, 423)
        self.assertEqual(body["detail"]["code"], "STEP_UP_REQUIRED")
        self.assertEqual(body["detail"]["module"], "trading")
        self.assertEqual(hdrs.get("access-control-allow-origin") or hdrs.get("Access-Control-Allow-Origin"), "http://tauri.localhost", "423 keeps CORS headers")
        tok = mint("trading", time.time() + 60, 0)
        self.assertEqual(self.call("/api/trading/mode", headers={"X-CC-Elevation": tok})[0], 200)
        # A finance token doesn't open trading; several tokens may be sent at once.
        fin = mint("finance", time.time() + 60, 0)
        self.assertEqual(self.call("/api/trading/mode", headers={"X-CC-Elevation": fin})[0], 423)
        self.assertEqual(self.call("/api/trading/mode", headers={"X-CC-Elevation": f"{fin}, {tok}"})[0], 200)
        self.assertEqual(self.call("/api/cc/c/income")[0], 423)
        self.assertEqual(self.call("/api/cc/c/notes")[0], 200, "non-finance collections stay writable")

    def test_revocation_by_epoch(self):
        tok = mint("trading", time.time() + 60, 0)
        self.assertEqual(self.call("/api/trading/mode", headers={"X-CC-Elevation": tok})[0], 200)
        (sa.sec_dir() / "state.json").write_text(json.dumps({"epoch": 1, "hardLocked": False}))
        self.assertEqual(self.call("/api/trading/mode", headers={"X-CC-Elevation": tok})[0], 423, "an app lock bumps the epoch")

    def test_loopback_automation_exempt_but_not_from_hard_lock(self):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/api/trading/mode", data=b"{}", method="POST", headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=5) as r:
            self.assertEqual(r.status, 200, "local script without Origin passes the step-up")
        sa.hard_lock("t", "test")
        try:
            urllib.request.urlopen(urllib.request.Request(req.full_url, data=b"{}", method="POST", headers={"Content-Type": "application/json"}), timeout=5)
            self.fail("hard lock must refuse automation too")
        except urllib.error.HTTPError as e:
            self.assertEqual(e.code, 423)
            self.assertEqual(json.loads(e.read())["detail"]["code"], "HARD_LOCKED")

    def test_trading_estop_is_never_gated(self):
        sa.hard_lock("t", "test")
        code, body, _ = self.call("/api/trading/kill-switch", body=b'{"dryRun":true}')
        self.assertEqual((code, body["estop"]), (200, True))

    # ── remote failsafe webhook ─────────────────────────────────────────────

    def signed(self, body: bytes, ts: str | None = None, secret: str = RK):
        ts = ts or str(int(time.time()))
        return {"X-CC-Timestamp": ts, "X-CC-Signature": sa.webhook_signature(secret.encode(), ts, body)}

    def test_emergency_kill_webhook(self):
        body = b'{"reason":"phone shortcut"}'
        code, r, _ = self.call("/api/security/emergency-kill", body=body, headers=self.signed(body))
        self.assertEqual(code, 200, r)
        self.assertTrue(r["ok"])
        st = sa.read_state()
        self.assertTrue(st["hardLocked"])
        self.assertGreaterEqual(st["epoch"], 1)
        lock = json.loads((TMP / "trading" / "TRADING_LOCKED.json").read_text())
        self.assertEqual((lock["locked"], lock["incidentId"]), (True, r["incidentId"]))
        self.assertTrue(any(s["step"] == "positions" and "untouched" in s["detail"] for s in r["steps"]))
        last = json.loads((sa.sec_dir() / "security_audit.jsonl").read_text().splitlines()[-1])
        self.assertEqual((last["event"], last["severity"]), ("remote_kill", "critical"))

    def test_emergency_kill_rejects_bad_stale_and_replayed(self):
        body = b'{"reason":"x"}'
        self.assertEqual(self.call("/api/security/emergency-kill", body=body, headers=self.signed(body, secret="b" * 64))[0], 401)
        self.assertEqual(self.call("/api/security/emergency-kill", body=body, headers=self.signed(body, ts=str(int(time.time()) - 3600)))[0], 401)
        self.assertEqual(self.call("/api/security/emergency-kill", body=b'{"reason":"tampered"}', headers=self.signed(body))[0], 401)
        self.assertFalse(sa.read_state().get("hardLocked"))
        h = self.signed(body)
        self.assertEqual(self.call("/api/security/emergency-kill", body=body, headers=h)[0], 200)
        self.assertEqual(self.call("/api/security/emergency-kill", body=body, headers=h)[0], 401, "replay refused")
        rejected = [json.loads(ln) for ln in (sa.sec_dir() / "security_audit.jsonl").read_text().splitlines()]
        self.assertTrue(any(e["event"] == "remote_kill_rejected" for e in rejected))

    def test_emergency_kill_rate_limit(self):
        body = b"{}"
        for _ in range(5):
            self.call("/api/security/emergency-kill", body=body, headers=self.signed(body, secret="c" * 64))
        self.assertEqual(self.call("/api/security/emergency-kill", body=body, headers=self.signed(body))[0], 429)

    # ── audit chain + companion mailbox ─────────────────────────────────────

    def test_audit_chain(self):
        for i in range(3):
            sa.audit("test_event", "info", "info", None, "test", {"i": i})
        ok, n = sa.verify_chain()
        self.assertTrue(ok)
        p = sa.sec_dir() / "security_audit.jsonl"
        text = p.read_text()
        p.write_text(text.replace('"i":0', '"i":5', 1))
        self.assertFalse(sa.verify_chain()[0])
        p.write_text(text)

    def test_companion_mailbox(self):
        rid, nonce = "abcd1234ef", "n0nce1234567"
        self.assertEqual(self.call("/api/security/companion/request", body=json.dumps({"id": rid, "nonce": nonce, "device": "DESK", "purpose": "idle", "expiresAt": time.time() + 60}).encode())[0], 200)
        _, pend, _ = self.call("/api/security/companion/pending", method="GET")
        self.assertEqual([r["id"] for r in pend["requests"]], [rid])
        self.assertEqual(self.call(f"/api/security/companion/result/{rid}", method="GET")[1], {"state": "pending"})
        self.assertEqual(self.call("/api/security/companion/respond", body=json.dumps({"id": rid, "approve": True, "sig": "ab" * 32, "deviceId": "PHONE"}).encode())[0], 200)
        _, res, _ = self.call(f"/api/security/companion/result/{rid}", method="GET")
        self.assertEqual((res["state"], res["deviceId"]), ("approved", "PHONE"))
        self.assertEqual(self.call(f"/api/security/companion/result/{rid}", method="GET")[1], {"state": "expired"}, "one-shot")


    def test_alert_channels_skip_unconfigured_and_queue_for_the_phone(self):
        d = sa.sec_dir()
        (d / "companion.paired").unlink(missing_ok=True)
        (d / "companion_inbox.json").unlink(missing_ok=True)
        for k in ("CC_ALERT_WEBHOOK_URL", "CC_TWILIO_ACCOUNT_SID", "CC_SMTP_HOST"):
            os.environ.pop(k, None)
        out = sa.deliver("T", "B", "hard_lock", "critical", {"channels": ["companion", "webhook", "twilio", "email"]})
        self.assertTrue(all(r.startswith("skipped") for _, r in out), out)  # nothing configured: no errors
        (d / "companion.paired").write_text("1")
        out = sa.deliver("T", "B", "hard_lock", "critical", {"channels": ["companion", "webhook"]})
        self.assertEqual(out, [("companion", "sent")], "first channel that takes it wins")
        _, inbox, _ = self.call("/api/security/companion/alerts?since=0", method="GET")
        self.assertEqual([(a["event"], a["sig"]) for a in inbox["alerts"]], [("hard_lock", "")], "gateway alerts are unsigned")
        sig = "cd" * 32
        self.assertEqual(self.call("/api/security/companion/alert", body=json.dumps({"id": "alert12345", "ts": int(time.time()), "event": "login_failure", "severity": "warn", "title": "t", "body": "b", "sig": sig}).encode())[0], 200)
        _, inbox, _ = self.call(f"/api/security/companion/alerts?since={inbox['alerts'][0]['ts'] - 1}", method="GET")
        self.assertEqual(inbox["alerts"][-1]["sig"], sig)
        (d / "companion.paired").unlink()

    def test_unknown_device_is_audited_once_per_host(self):
        sa._UNKNOWN_SEEN.clear()
        p = sa.sec_dir() / "security_audit.jsonl"
        before = len(p.read_text().splitlines()) if p.exists() else 0
        e = sa.note_unknown_device("100.70.1.2", "on the mesh with no gateway token", "/api/cc/config?x=secret", now=1000.0)
        self.assertEqual((e["event"], e["severity"], e["outcome"], e["source"]), ("unknown_device", "warn", "failure", "gateway:100.70.1.2"))
        self.assertEqual(e["detail"]["path"], "/api/cc/config", "no query string in the trail")
        self.assertIsNone(sa.note_unknown_device("100.70.1.2", "again", "/api/x", now=1100.0), "throttled per host")
        self.assertIsNotNone(sa.note_unknown_device("192.168.1.9", "outside the NetBird mesh", "/", now=1100.0))
        self.assertIsNotNone(sa.note_unknown_device("100.70.1.2", "later", "/", now=1000.0 + sa.UNKNOWN_DEVICE_EVERY_S))
        self.assertEqual(len(p.read_text().splitlines()), before + 3)
        self.assertTrue(sa.verify_chain()[0])
        self.assertIn("unknown_device", sa._TITLES)


if __name__ == "__main__":
    unittest.main(verbosity=2)
