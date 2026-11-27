"""Comms step 2 (build plan Sections 8-10): the transport self-test.

- DELETE /api/comms/selftest (os_api.py) removes only rows whose id starts with `selftest:`
  (optionally one run: `selftest:<run>:`), from comms_messages, comms_calls AND their vault
  copies (`comms:selftest:...`). The prefix is matched literally, never as a LIKE pattern.
- It is NOT loopback-only: a token holder over NetBird (the phone) may call it; without the token
  a mesh peer gets 401, and tunnel traffic gets 404 (server.ZeroTrustMiddleware).
- scripts/comms-bridge-smoke.ps1 runs end to end against an in-process gateway (server.app) on
  plain HTTP and on HTTPS with a throwaway local CA, where the HTTPS listener sees every client
  as a NetBird peer so the token is really checked. It must pass, never print the token, refuse a
  wrong CA / wrong token, and leave no selftest rows or vault entries behind.

Everything runs against a temp cc.db, a temp token file and a temp security dir.

Run with: python -m pytest tests/test_comms_selftest.py -q -p no:cacheprovider
(The end-to-end class needs Windows PowerShell and openssl; it is skipped without them.)
"""
import os
import sys
import tempfile
from pathlib import Path

# Isolation before any gateway import: importing server.py runs os_api.init() on cc.db, so point
# the store at a temp dir when this module is the first to import it.
if "command_center_api" not in sys.modules:
    os.environ["CC_DATA_DIR"] = tempfile.mkdtemp(prefix="agentic-os-cc-import-")
os.environ.setdefault("AGENTIC_OS_SECURITY_DIR", tempfile.mkdtemp(prefix="agentic-os-sec-"))

import asyncio  # noqa: E402
import shutil  # noqa: E402
import socket  # noqa: E402
import subprocess  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402
import unittest  # noqa: E402
import urllib.request  # noqa: E402
from unittest import mock  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_os_inbox import IsolatedCC  # noqa: E402

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import os_api  # noqa: E402
import server  # noqa: E402

os.environ.pop("CC_DATA_DIR", None)  # read once at import; don't leak it to subprocesses

ROOT = Path(__file__).resolve().parent.parent
SMOKE = ROOT / "scripts" / "comms-bridge-smoke.ps1"
TOKEN = "t0ken-for-the-selftest-suite-9f8e7d6c"
MESH_IP = "100.84.91.149"


class MeshPeer:
    """ASGI wrapper: every request looks like it came from a NetBird peer (not loopback)."""

    def __init__(self, app, host=MESH_IP):
        self.app, self.host = app, host

    async def __call__(self, scope, receive, send):
        if scope["type"] in ("http", "websocket"):
            scope = {**scope, "client": (self.host, 50123)}
        await self.app(scope, receive, send)


def _sms(c, mid, address="selftest", body="bridge self-test"):
    r = c.post("/api/comms/sms", json={"messages": [{"id": mid, "address": address, "body": body, "ts": 1_790_000_000, "direction": "in"}]})
    assert r.status_code == 200, r.text
    return r.json()


def _call(c, cid, address="selftest"):
    r = c.post("/api/comms/call-log", json={"calls": [{"id": cid, "address": address, "direction": "missed", "ts": 1_790_000_000}]})
    assert r.status_code == 200, r.text


class SelftestDeleteCase(unittest.TestCase):
    def setUp(self):
        self.iso = IsolatedCC().__enter__()
        self.addCleanup(self.iso.__exit__, None, None, None)
        app = FastAPI()
        app.include_router(os_api.comms_router)
        self.c = TestClient(app)

    def ids(self, table):
        return sorted(r["id"] for r in self.iso.sql(f"SELECT id FROM {table}"))

    def vault_ids(self):
        return sorted(r["item_id"] for r in self.iso.sql("SELECT item_id FROM vault WHERE collection='comms'"))

    def test_deletes_selftest_rows_and_their_vault_copies_only(self):
        _sms(self.c, "selftest:runA:sms")
        _call(self.c, "selftest:runA:call")
        _sms(self.c, "sms:real-1", address="+1 416 555 1234", body="dinner at 7")
        _call(self.c, "call:real-1", address="+1 416 555 1234")
        self.iso.sql("INSERT INTO comms_outbox(id,kind,address,body,status) VALUES('o1','sms','4165551234','hi','pending')")
        self.iso.sql("INSERT INTO comms_contacts(address,name,trusted) VALUES('4165551234','Mom',1)")
        self.assertEqual(self.vault_ids(), ["comms:selftest:runA:sms", "comms:sms:real-1"])

        r = self.c.delete("/api/comms/selftest")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json(), {"ok": True, "prefix": "selftest:", "messages": 1, "calls": 1, "vault": 1})
        self.assertEqual(self.ids("comms_messages"), ["sms:real-1"])
        self.assertEqual(self.ids("comms_calls"), ["call:real-1"])
        self.assertEqual(self.vault_ids(), ["comms:sms:real-1"])
        self.assertEqual(self.ids("comms_outbox"), ["o1"])
        self.assertEqual(self.iso.sql("SELECT address, trusted FROM comms_contacts"), [{"address": "4165551234", "trusted": 1}])
        # The test text never wrote a contact (no contact name is sent).
        self.assertEqual(self.c.get("/api/comms/threads").json()["threads"][0]["thread"], "4165551234")

        # Nothing left: a second call is a no-op.
        self.assertEqual(self.c.delete("/api/comms/selftest").json()["messages"], 0)

    def test_run_limits_the_delete_to_that_run(self):
        _sms(self.c, "selftest:runA:sms")
        _sms(self.c, "selftest:runB:sms")
        _call(self.c, "selftest:runA:call")
        _call(self.c, "selftest:runAB:call")  # a longer run name with the same start
        r = self.c.delete("/api/comms/selftest", params={"run": "runA"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json(), {"ok": True, "prefix": "selftest:runA:", "messages": 1, "calls": 1, "vault": 1})
        self.assertEqual(self.ids("comms_messages"), ["selftest:runB:sms"])
        self.assertEqual(self.ids("comms_calls"), ["selftest:runAB:call"])
        self.assertEqual(self.vault_ids(), ["comms:selftest:runB:sms"])

    def test_the_prefix_is_literal_not_a_like_pattern(self):
        for mid in ("selftest:a_b:sms", "selftest:aXb:sms", "selftestX:sms", "SELFTEST:sms", "real:selftest:sms", "selftest"):
            _sms(self.c, mid)
        r = self.c.delete("/api/comms/selftest", params={"run": "a_b"})
        self.assertEqual(r.json()["messages"], 1)
        self.assertNotIn("selftest:a_b:sms", self.ids("comms_messages"))
        self.assertIn("selftest:aXb:sms", self.ids("comms_messages"))  # LIKE 'selftest:a_b:%' would match it
        r = self.c.delete("/api/comms/selftest")
        self.assertEqual(r.json()["messages"], 1)  # only selftest:aXb:sms
        self.assertEqual(self.ids("comms_messages"), sorted(["selftestX:sms", "SELFTEST:sms", "real:selftest:sms", "selftest"]))
        self.assertEqual(self.vault_ids(), sorted(f"comms:{m}" for m in ["selftestX:sms", "SELFTEST:sms", "real:selftest:sms", "selftest"]))

    def test_a_bad_run_is_refused_and_deletes_nothing(self):
        _sms(self.c, "selftest:runA:sms")
        for run in ("a%", "../x", "a:b", "a b", "x" * 65, "%"):
            r = self.c.delete("/api/comms/selftest", params={"run": run})
            self.assertEqual(r.status_code, 400, f"{run!r}: {r.text}")
        self.assertEqual(self.ids("comms_messages"), ["selftest:runA:sms"])
        self.assertEqual(self.vault_ids(), ["comms:selftest:runA:sms"])


class SelftestDeleteAuthCase(unittest.TestCase):
    """Through the real server.app middleware: token holders over NetBird may delete."""

    def setUp(self):
        self.iso = IsolatedCC().__enter__()
        self.addCleanup(self.iso.__exit__, None, None, None)
        tok = self.iso.tmp / "gateway.token"
        tok.write_text(TOKEN, encoding="utf-8")
        for target in (mock.patch.object(server.ZeroTrustMiddleware, "TOKEN_FILE", tok), mock.patch.object(os_api, "TOKEN_FILE", tok)):
            target.start()
            self.addCleanup(target.stop)
        self.mesh = TestClient(MeshPeer(server.app))
        self.local = TestClient(MeshPeer(server.app, host="127.0.0.1"))
        _sms(self.local, "selftest:r1:sms")

    def count(self):
        return self.iso.sql("SELECT COUNT(*) n FROM comms_messages")[0]["n"]

    def test_mesh_peer_needs_the_token(self):
        self.assertEqual(self.mesh.delete("/api/comms/selftest?run=r1").status_code, 401)
        self.assertEqual(self.mesh.delete("/api/comms/selftest?run=r1", headers={"Authorization": "Bearer nope"}).status_code, 401)
        self.assertEqual(self.count(), 1)
        r = self.mesh.delete("/api/comms/selftest?run=r1", headers={"Authorization": f"Bearer {TOKEN}"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["messages"], 1)
        self.assertEqual(self.count(), 0)

    def test_loopback_may_delete_but_a_tunnel_may_not(self):
        r = self.local.delete("/api/comms/selftest?run=r1", headers={"X-Forwarded-For": "203.0.113.7"})
        self.assertEqual(r.status_code, 404, r.text)
        self.assertEqual(self.count(), 1)
        r = self.local.delete("/api/comms/selftest?run=r1")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.count(), 0)


# ── end to end: the PowerShell smoke script against an in-process gateway ───

def _openssl():
    found = shutil.which("openssl")
    if found:
        return found
    for p in (r"C:\Program Files\Git\usr\bin\openssl.exe", r"C:\Program Files\Git\ucrt64\bin\openssl.exe", r"C:\Program Files\Git\mingw64\bin\openssl.exe"):
        if Path(p).is_file():
            return p
    return None


def _powershell():
    return shutil.which("powershell") if os.name == "nt" else None


def _make_ca(ossl, d: Path, name: str) -> tuple[Path, Path]:
    key, crt = d / f"{name}.key", d / f"{name}.crt"
    subprocess.run([ossl, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(key), "-out", str(crt), "-days", "2",
                    "-subj", f"/CN={name}", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"],
                   check=True, capture_output=True)
    return key, crt


def _make_server_cert(ossl, d: Path, ca_key: Path, ca_crt: Path) -> tuple[Path, Path]:
    key, csr, crt, ext = d / "gateway.key", d / "gateway.csr", d / "gateway.crt", d / "gateway.ext"
    ext.write_text("subjectAltName=IP:127.0.0.1\nbasicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n", encoding="ascii")
    subprocess.run([ossl, "req", "-newkey", "rsa:2048", "-nodes", "-keyout", str(key), "-out", str(csr), "-subj", "/CN=127.0.0.1"], check=True, capture_output=True)
    subprocess.run([ossl, "x509", "-req", "-in", str(csr), "-CA", str(ca_crt), "-CAkey", str(ca_key), "-CAcreateserial", "-out", str(crt), "-days", "2", "-extfile", str(ext)],
                   check=True, capture_output=True)
    return key, crt


def _bound_socket() -> socket.socket:
    sk = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sk.bind(("127.0.0.1", 0))
    return sk


@unittest.skipUnless(_powershell() and _openssl(), "needs Windows PowerShell and openssl")
class SmokeScriptEndToEnd(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import uvicorn

        cls.iso = IsolatedCC().__enter__()
        cls.addClassCleanup(cls.iso.__exit__, None, None, None)
        d = Path(tempfile.mkdtemp(prefix="agentic-os-smoke-"))
        cls.addClassCleanup(shutil.rmtree, d, True)
        ossl = _openssl()
        ca_key, cls.ca = _make_ca(ossl, d, "Agentic OS Test CA")
        _, cls.other_ca = _make_ca(ossl, d, "Some Other CA")
        srv_key, srv_crt = _make_server_cert(ossl, d, ca_key, cls.ca)
        cls.token_file = d / "gateway.token"
        cls.token_file.write_text(TOKEN, encoding="utf-8")
        cls.bad_token_file = d / "wrong.token"
        cls.bad_token_file.write_text("not-the-gateway-token-1234567", encoding="utf-8")
        for target in (mock.patch.object(server.ZeroTrustMiddleware, "TOKEN_FILE", cls.token_file), mock.patch.object(os_api, "TOKEN_FILE", cls.token_file)):
            target.start()
            cls.addClassCleanup(target.stop)

        http_sk, tls_sk = _bound_socket(), _bound_socket()
        cls.http_url = f"http://127.0.0.1:{http_sk.getsockname()[1]}"
        cls.https_url = f"https://127.0.0.1:{tls_sk.getsockname()[1]}"
        http = uvicorn.Server(uvicorn.Config(server.app, lifespan="off", log_level="warning"))
        # The HTTPS listener plays the phone over NetBird: every client is a mesh peer.
        tls = uvicorn.Server(uvicorn.Config(MeshPeer(server.app), lifespan="off", log_level="warning", ssl_certfile=str(srv_crt), ssl_keyfile=str(srv_key)))

        async def both():
            await asyncio.gather(http.serve(sockets=[http_sk]), tls.serve(sockets=[tls_sk]))

        t = threading.Thread(target=lambda: asyncio.run(both()), daemon=True)
        t.start()

        def stop():
            http.should_exit = tls.should_exit = True
            t.join(timeout=15)

        cls.addClassCleanup(stop)
        deadline = time.time() + 20
        while not (http.started and tls.started):
            if time.time() > deadline:
                raise RuntimeError("the test gateway did not start")
            time.sleep(0.1)
        # A real message that must survive every run.
        req = urllib.request.Request(f"{cls.http_url}/api/comms/sms", data=b'{"id":"sms:keep-me","address":"+14165551234","body":"real text","ts":1790000000}',
                                     headers={"Content-Type": "application/json"}, method="POST")
        urllib.request.urlopen(req, timeout=10).read()

    def run_smoke(self, *extra):
        urls = ["-HttpUrl", self.http_url] + ([] if "-HttpsUrl" in extra else ["-HttpsUrl", self.https_url])
        args = [_powershell(), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(SMOKE),
                *urls, "-TimeoutSec", "5", *extra]
        p = subprocess.run(args, capture_output=True, text=True, timeout=180)
        out = p.stdout + p.stderr
        self.assertNotIn(TOKEN, out, "the gateway token must never be printed")
        self.assertNotIn("not-the-gateway-token", out)
        return p.returncode, out

    def assert_no_selftest_left(self):
        self.assertEqual(self.iso.sql("SELECT id FROM comms_messages WHERE substr(id,1,9)='selftest:'"), [])
        self.assertEqual(self.iso.sql("SELECT id FROM comms_calls WHERE substr(id,1,9)='selftest:'"), [])
        self.assertEqual(self.iso.sql("SELECT item_id FROM vault WHERE substr(item_id,1,15)='comms:selftest:'"), [])
        self.assertEqual([r["id"] for r in self.iso.sql("SELECT id FROM comms_messages")], ["sms:keep-me"])
        self.assertEqual(len(self.iso.sql("SELECT item_id FROM vault WHERE item_id='comms:sms:keep-me'")), 1)

    def test_both_transports_pass_and_clean_up(self):
        code, out = self.run_smoke("-CaFile", str(self.ca), "-TokenFile", str(self.token_file))
        self.assertEqual(code, 0, out)
        self.assertNotIn("[FAIL]", out)
        for leg in ("http ", "https"):
            for check in ("open the live socket", "post a test text", "post a test call", 'pushed the "sms" event',
                          '"selftest" thread is listed', "test text is in its thread", "test call is listed",
                          "delete the test rows", "test text is gone"):
                self.assertTrue(any(l.startswith(f"[PASS] {leg}") and check in l for l in out.splitlines()), f"{leg} {check}:\n{out}")
        self.assertIn("Result: 18 passed, 0 failed", out)
        self.assertIn("Gateway token: found", out)
        self.assert_no_selftest_left()

    def test_a_wrong_token_fails_the_phone_path_only(self):
        code, out = self.run_smoke("-CaFile", str(self.ca), "-TokenFile", str(self.bad_token_file))
        self.assertEqual(code, 1, out)
        self.assertTrue(any(l.startswith("[FAIL] https") and "401" in l for l in out.splitlines()), out)
        self.assertTrue(any(l.startswith("[FAIL] https") and "live socket" in l for l in out.splitlines()), out)
        self.assertFalse(any(l.startswith("[FAIL] http ") for l in out.splitlines()), out)
        self.assert_no_selftest_left()

    def test_a_certificate_from_another_ca_is_refused(self):
        code, out = self.run_smoke("-CaFile", str(self.other_ca), "-TokenFile", str(self.token_file))
        self.assertEqual(code, 1, out)
        self.assertTrue(any(l.startswith("[FAIL] https") and "post a test text" in l for l in out.splitlines()), out)
        self.assertFalse(any(l.startswith("[PASS] https") for l in out.splitlines()), out)
        self.assert_no_selftest_left()

    def test_a_certificate_for_another_host_name_is_refused(self):
        # The test certificate names IP 127.0.0.1 only; "localhost" is a different name.
        port = self.https_url.rsplit(":", 1)[1]
        code, out = self.run_smoke("-SkipHttp", "-HttpsUrl", f"https://localhost:{port}", "-CaFile", str(self.ca), "-TokenFile", str(self.token_file))
        self.assertEqual(code, 1, out)
        self.assertIn("does not match the host name", out)
        self.assertFalse(any(l.startswith("[PASS] https") for l in out.splitlines()), out)
        self.assert_no_selftest_left()

    def test_missing_ca_file_is_a_clear_failure(self):
        code, out = self.run_smoke("-CaFile", str(self.ca) + ".missing", "-TokenFile", str(self.token_file))
        self.assertEqual(code, 1, out)
        self.assertIn("[FAIL] https load the local CA", out)
        self.assert_no_selftest_left()


if __name__ == "__main__":
    unittest.main()
