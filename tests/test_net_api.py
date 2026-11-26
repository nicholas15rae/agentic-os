"""NetBird path router (GET /api/net/path): direct vs relayed for the calling peer.

Runs on canned `netbird status --json` output: the CLI is never called.
Run with: python tests/test_net_api.py
"""
import json
import subprocess
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import net_api  # noqa: E402

PHONE_IP = "100.84.84.190"
DROPLET_IP = "100.84.235.228"
# Shape of NetBird 0.83 `status --json`; keys, endpoints and public IPs are fake but realistic.
SECRET_KEY = "PHONEPUBKEYdoNotLeak0123456789abcdefghijk="
PUBLIC_EP = "203.0.113.77:51820"
STATUS = {
    "peers": {
        "total": 3,
        "connected": 2,
        "details": [
            {
                "fqdn": "r0qcsx.netbird.cloud",
                "netbirdIp": PHONE_IP,
                "netbirdIpv6": "fdad:757b:eacc:9c39:4fcf:5ef8:5060:a309",
                "publicKey": SECRET_KEY,
                "status": "Connected",
                "lastStatusUpdate": "2026-11-26T09:00:00-05:00",
                "connectionType": "Relayed",
                "iceCandidateType": {"local": "relay", "remote": "relay"},
                "iceCandidateEndpoint": {"local": PUBLIC_EP, "remote": "198.51.100.9:40123"},
                "relayAddress": "rels://streamline-us-chi1-4.relay.netbird.io:443",
                "lastWireguardHandshake": "2026-11-26T09:00:05-05:00",
                "transferReceived": 1234,
                "transferSent": 5678,
                "latency": 92_400_000,
                "quantumResistance": False,
                "networks": None,
            },
            {
                "fqdn": "ubuntu-s-1vcpu-2gb-70gb-intel-tor1.netbird.cloud",
                "netbirdIp": DROPLET_IP,
                "publicKey": "DROPLETKEYdoNotLeak=",
                "status": "Connected",
                "connectionType": "P2P",
                "iceCandidateType": {"local": "srflx", "remote": "host"},
                "iceCandidateEndpoint": {"local": PUBLIC_EP, "remote": "192.0.2.10:51820"},
                "relayAddress": "rels://streamline-us-chi1-4.relay.netbird.io:443",
                "lastWireguardHandshake": "2026-11-26T09:07:52-05:00",
                "latency": 30_612_345,
            },
            {
                "fqdn": "ubuntu-s-1vcpu-512mb-10gb-tor1.netbird.cloud",
                "netbirdIp": "100.84.1.36",
                "publicKey": "STALEKEY=",
                "status": "Idle",
                "connectionType": "-",
                "iceCandidateType": {"local": "", "remote": ""},
                "iceCandidateEndpoint": {"local": "", "remote": ""},
                "relayAddress": "",
                "lastWireguardHandshake": "0001-01-01T00:00:00Z",
                "latency": 0,
            },
        ],
    },
    "netbirdIp": "100.84.91.149/16",
    "publicKey": "SELFKEYdoNotLeak=",
    "lazyConnectionEnabled": True,
    "wireguardPort": 51820,
    "relays": {"details": [{"uri": "rels://streamline-us-chi1-3.relay.netbird.io:443", "available": True}]},
}
FORBIDDEN = (SECRET_KEY, "DROPLETKEY", "STALEKEY", "SELFKEY", "203.0.113.77", "198.51.100.9", "192.0.2.10", "publicKey", "iceCandidateEndpoint", "transfer")


def client(host: str, data=STATUS) -> TestClient:
    net_api.clear_cache()
    app = FastAPI()
    app.include_router(net_api.router)
    c = TestClient(app, client=(host, 50000))
    c._patch = mock.patch.object(net_api, "_run_status", return_value=json.loads(json.dumps(data)))
    c._patch.start()
    return c


class NetPathApi(unittest.TestCase):
    def tearDown(self):
        mock.patch.stopall()
        net_api.clear_cache()

    def assertNoLeak(self, body):
        text = json.dumps(body)
        for bad in FORBIDDEN:
            self.assertNotIn(bad, text)

    def test_phone_sees_its_own_relayed_path(self):
        r = client(PHONE_IP).get("/api/net/path")
        self.assertEqual(r.status_code, 200, r.text)
        b = r.json()
        self.assertEqual(b, {
            "peer": "r0qcsx", "ip": PHONE_IP, "status": "Connected", "path": "Relayed",
            "iceLocal": "relay", "iceRemote": "relay", "relayHost": "streamline-us-chi1-4.relay.netbird.io",
            "latencyMs": 92.4, "lastHandshake": "2026-11-26T09:00:05-05:00", "lazy": True,
        })
        self.assertNoLeak(b)

    def test_p2p_peer_has_no_relay_host(self):
        # relayAddress is the fallback and is filled in on P2P links too: never shown there.
        b = client(DROPLET_IP).get("/api/net/path").json()
        self.assertEqual((b["peer"], b["path"], b["iceLocal"], b["iceRemote"], b["relayHost"], b["latencyMs"]), ("ubuntu-s-1vcpu-2gb-70gb-intel-tor1", "P2P", "srflx", "host", None, 30.6))
        self.assertNoLeak(b)

    def test_ipv4_mapped_caller_matches(self):
        self.assertEqual(client("::ffff:" + PHONE_IP).get("/api/net/path").json()["peer"], "r0qcsx")

    def test_idle_peer_reads_as_nothing_yet(self):
        b = client("100.84.1.36").get("/api/net/path").json()
        self.assertEqual((b["status"], b["path"], b["latencyMs"], b["lastHandshake"], b["iceLocal"]), ("Idle", None, None, None, None))

    def test_unknown_caller_gets_no_peer(self):
        for host in ("100.84.66.145", "testclient", "10.0.0.5"):
            b = client(host).get("/api/net/path").json()
            self.assertEqual((b["peer"], b["path"], b["status"]), (None, None, "unknown"), host)
            self.assertEqual(b["lazy"], True)
            self.assertNoLeak(b)

    def test_loopback_gets_every_peer_without_secrets(self):
        b = client("127.0.0.1").get("/api/net/path").json()
        self.assertEqual(b["lazy"], True)
        self.assertEqual([p["peer"] for p in b["peers"]], ["r0qcsx", "ubuntu-s-1vcpu-2gb-70gb-intel-tor1", "ubuntu-s-1vcpu-512mb-10gb-tor1"])
        self.assertEqual([p["path"] for p in b["peers"]], ["Relayed", "P2P", None])
        self.assertNoLeak(b)

    def test_tunnelled_loopback_is_not_trusted_with_the_peer_list(self):
        b = client("127.0.0.1").get("/api/net/path", headers={"X-Forwarded-For": "198.51.100.1"}).json()
        self.assertNotIn("peers", b)
        self.assertIsNone(b["peer"])

    def test_relay_given_as_ip_is_withheld(self):
        data = json.loads(json.dumps(STATUS))
        data["peers"]["details"][0]["relayAddress"] = "rels://203.0.113.5:443"
        b = client(PHONE_IP, data).get("/api/net/path").json()
        self.assertEqual((b["path"], b["relayHost"]), ("Relayed", None))
        self.assertNotIn("203.0.113.5", json.dumps(b))
        self.assertIsNone(net_api._host_only("rels://[2001:db8::1]:443"))
        self.assertIsNone(net_api._host_only("2001:db8::1"))
        self.assertEqual(net_api._host_only("turns:relay.example.net:443?transport=tcp"), "relay.example.net")
        self.assertEqual(net_api._host_only("rels://streamline-us-chi1-4.relay.netbird.io"), "streamline-us-chi1-4.relay.netbird.io")
        self.assertIsNone(net_api._host_only(""))

    def test_unexpected_fields_never_pass_through(self):
        data = json.loads(json.dumps(STATUS))
        data["peers"]["details"][0]["newSecretField"] = "zzz-leak"
        b = client(PHONE_IP, data).get("/api/net/path").json()
        self.assertNotIn("zzz-leak", json.dumps(b))
        self.assertEqual(set(b), {"peer", "ip", "status", "path", "iceLocal", "iceRemote", "relayHost", "latencyMs", "lastHandshake", "lazy"})

    def test_cli_failure_is_a_quiet_503(self):
        net_api.clear_cache()
        app = FastAPI()
        app.include_router(net_api.router)
        c = TestClient(app, client=(PHONE_IP, 50000))
        with mock.patch.object(net_api.subprocess, "run", side_effect=FileNotFoundError()):
            r = c.get("/api/net/path")
        self.assertEqual(r.status_code, 503)
        self.assertIn("not found", r.json()["detail"])
        net_api.clear_cache()
        with mock.patch.object(net_api.subprocess, "run", side_effect=subprocess.TimeoutExpired("netbird", 3)):
            self.assertIn("timed out", c.get("/api/net/path").json()["detail"])
        net_api.clear_cache()
        bad = subprocess.CompletedProcess(["netbird"], 0, stdout=b"not json", stderr=b"")
        with mock.patch.object(net_api.subprocess, "run", return_value=bad):
            self.assertEqual(c.get("/api/net/path").status_code, 503)

    def test_runs_the_cli_with_a_3s_timeout_and_reads_a_bom(self):
        net_api.clear_cache()
        out = subprocess.CompletedProcess(["netbird"], 0, stdout=b"\xef\xbb\xbf" + json.dumps(STATUS).encode(), stderr=b"")
        with mock.patch.object(net_api.subprocess, "run", return_value=out) as run:
            data = net_api.status_snapshot(now=1000.0)
        self.assertEqual(data["wireguardPort"], 51820)
        args, kwargs = run.call_args
        self.assertEqual(args[0][1:], ["status", "--json"])
        self.assertEqual(kwargs["timeout"], 3.0)

    def test_snapshot_is_cached_for_5s_failures_included(self):
        calls = []

        def fake():
            calls.append(1)
            if len(calls) == 2:
                raise RuntimeError("netbird status timed out after 3 s")
            return STATUS

        net_api.clear_cache()
        with mock.patch.object(net_api, "_run_status", side_effect=fake):
            net_api.status_snapshot(now=100.0)
            net_api.status_snapshot(now=104.9)
            self.assertEqual(len(calls), 1)
            with self.assertRaises(RuntimeError):
                net_api.status_snapshot(now=105.1)
            with self.assertRaises(RuntimeError):  # the failure is cached too
                net_api.status_snapshot(now=108.0)
            self.assertEqual(len(calls), 2)
            self.assertIs(net_api.status_snapshot(now=110.2), STATUS)
            self.assertEqual(len(calls), 3)

    def test_concurrent_callers_share_one_cli_call(self):
        calls = []

        def slow():
            calls.append(1)
            time.sleep(0.2)
            return STATUS

        net_api.clear_cache()
        with mock.patch.object(net_api, "_run_status", side_effect=slow):
            ts = [threading.Thread(target=net_api.status_snapshot) for _ in range(5)]
            for t in ts:
                t.start()
            for t in ts:
                t.join()
        self.assertEqual(len(calls), 1)

    def test_runs_off_the_event_loop(self):
        seen = []
        real = net_api.run_in_threadpool

        async def spy(fn, *a, **kw):
            seen.append(fn)
            return await real(fn, *a, **kw)

        c = client(PHONE_IP)
        with mock.patch.object(net_api, "run_in_threadpool", spy):
            self.assertEqual(c.get("/api/net/path").status_code, 200)
        self.assertEqual(seen, [net_api.status_snapshot])

    def test_server_mounts_the_router(self):
        src = (Path(__file__).resolve().parent.parent / "server.py").read_text(encoding="utf-8")
        self.assertIn("app.include_router(net_api.router)", src)


class DirectPathDoc(unittest.TestCase):
    """docs/netbird-direct-path.md: commands Nic types into Windows PowerShell 5.1 against NetBird 0.83."""

    DOC = (Path(__file__).resolve().parent.parent / "docs" / "netbird-direct-path.md").read_text(encoding="utf-8")

    def test_no_netbird_up_with_the_ignored_lazy_flag(self):
        # 0.83 accepts --enable-lazy-connection but ignores it (server + NB_LAZY_CONN decide): the step only drops the mesh.
        self.assertNotRegex(self.DOC, r"netbird up[^\n`]*--enable-lazy-connection")
        self.assertIn("NB_LAZY_CONN", self.DOC)
        self.assertIn("netbird service restart", self.DOC)

    def test_external_ip_map_is_cleared_with_the_equals_form(self):
        # PowerShell 5.1 drops a bare "" argument, so `up` gets the flag with no value, fails, and the mesh stays down.
        self.assertNotRegex(self.DOC, r'netbird up[^\n`]*--external-ip-map\s+""')
        self.assertIn('netbird down; netbird up --external-ip-map=""', self.DOC)


if __name__ == "__main__":
    unittest.main()
