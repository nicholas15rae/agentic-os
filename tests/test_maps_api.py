"""Maps gateway routes (maps_api.py /api/maps/*), build plan Sections 8-10, Maps step 7.

- auth: the global ZeroTrustMiddleware asks the phone (a mesh peer) for the gateway token on every
  /api/maps route, and the module's own WebSocket checks it too (middleware never sees upgrades).
- PC-only writes: PUT /trips and POST /handoff need a direct loopback peer; a mesh device holding
  the token, or a tunnel arriving on loopback with forwarding headers, gets 403.
- cross-site writes: a page in a browser on the PC (loopback) can't queue a hand-off, PUT trips or
  fire a refresh with a text/plain / form POST (415) or from a foreign Origin (403).
- the socket admits only loopback and the 100.64.0.0/10 mesh, never a tunnel, even with the
  network lock off (no token file); "testclient" is not an IP, so tests use a mesh address.
- the 64 KB snapshot cap (Content-Length and streamed), shape checks, the snapshot on disk under
  CC_DIR as maps-trips.json (git-ignored), its age, and the refresh request the PUT clears.
- hand-offs: strict NavHandoff validation, 30 min TTL → expired, ack (404 / 410 / 409 / repeat),
  kill switch (423, nothing handed out), de-duplication, the pending cap.
- separation: hand-offs go out on /api/maps/ws only; comms_outbox, the comms socket and the
  vault (search) never see trips or hand-offs; "routes" stays out of VAULT_FIELDS.

Every test runs against a temp cc.db / CC_DIR and a temp os-state.json, never data/.

Run with: python -m pytest tests/test_maps_api.py -q -p no:cacheprovider
"""
import os
import sys
import tempfile

# Isolation before any gateway import (server imports run os_api.init() and cc.start()): point the
# store at a temp dir when this module is the first to import it.
if "command_center_api" not in sys.modules:
    os.environ["CC_DATA_DIR"] = tempfile.mkdtemp(prefix="agentic-os-cc-import-")

import json  # noqa: E402
import shutil  # noqa: E402
import subprocess  # noqa: E402
import time  # noqa: E402
import types  # noqa: E402
import unittest  # noqa: E402
from pathlib import Path  # noqa: E402
from unittest import mock  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_os_inbox import IsolatedCC  # noqa: E402

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from starlette.websockets import WebSocketDisconnect  # noqa: E402

import command_center_api as cc  # noqa: E402
import maps_api  # noqa: E402
import os_api  # noqa: E402

os.environ.pop("CC_DATA_DIR", None)

REPO = Path(__file__).resolve().parent.parent
PC = ("127.0.0.1", 50000)
PHONE = ("100.72.14.3", 51000)  # a NetBird mesh (100.64.0.0/10) peer
STRANGER = ("203.0.113.9", 4000)  # neither loopback nor the mesh
APP_ORIGIN = "http://tauri.localhost"
TOKEN = "t0k3n-for-tests"
QUEEN = {"lat": 43.6525, "lng": -79.3839, "label": "100 Queen St W, Toronto", "mode": "navigate"}


def view(trips=None, fetched_ms=None, **extra):
    """A TripsView in the contract's camelCase shape."""
    trips = trips if trips is not None else [trip()]
    return {
        "trips": trips,
        "origin": {"lat": 43.65, "lng": -79.38, "label": "Home", "source": "home"},
        "horizonHours": 48,
        "fetchedAtMs": fetched_ms if fetched_ms is not None else int(time.time() * 1000),
        "calendar": "ok",
        "detail": "",
        "trafficProvider": None,
        **extra,
    }


def trip(title="Audition - test", loc="100 Queen St W, Toronto"):
    start = int(time.time() * 1000) + 3 * 3600_000
    return {
        "event": {"id": "ev1", "title": title, "kind": "audition", "startMs": start, "endMs": None, "locationText": loc, "source": "gcal"},
        "place": {"lat": 43.6525, "lng": -79.3839, "label": loc},
        "placeStatus": "resolved",
        "eta": {"durationS": 1200, "distanceM": 9000, "trafficAware": False, "typicalDurationS": None, "trafficDelayS": None, "provider": "osm", "computedAtMs": start - 4 * 3600_000},
        "leaveByMs": start - 35 * 60_000,
        "openInMaps": None,
        "error": None,
    }


class Clock:
    """A stand-in for maps_api's `time` module (only time.time is used there)."""

    def __init__(self):
        self.t = time.time()

    def time(self):
        return self.t


class MapsCase(unittest.TestCase):
    kill_switch = False
    record_maps_events = True  # False: the real maps broadcast (a socket test)

    def setUp(self):
        self.iso = IsolatedCC().__enter__()
        self.addCleanup(self.iso.__exit__, None, None, None)
        self.addCleanup(maps_api._schema_ready.discard, str(self.iso.tmp / "cc.db"))
        maps_api._refresh["requestedAtMs"] = None
        self.set_kill_switch(self.kill_switch)
        # Anything reaching the comms socket is a bug: record it.
        self.comms_events = []
        p = mock.patch.object(os_api, "_broadcast", side_effect=self.comms_events.append)
        p.start()
        self.addCleanup(p.stop)
        self.events = []
        if self.record_maps_events:
            p = mock.patch.object(maps_api, "_broadcast", side_effect=self.events.append)
            p.start()
            self.addCleanup(p.stop)
        app = FastAPI()
        app.include_router(maps_api.router)
        app.include_router(os_api.comms_router)
        self.app = app
        self.pc = TestClient(app, client=PC)
        self.phone = TestClient(app, client=PHONE)
        self.stranger = TestClient(app, client=STRANGER)

    def set_kill_switch(self, on):
        (self.iso.tmp / "os-state.json").write_text(json.dumps({"osName": "Tony", "privacy": {"killSwitch": on}}), encoding="utf-8")

    def put(self, body=None, client=None, **kw):
        data = json.dumps(body if body is not None else view())
        return (client or self.pc).put("/api/maps/trips", content=data, headers={"content-type": "application/json", **kw.pop("headers", {})}, **kw)

    def handoff(self, body=None, client=None, **kw):
        return (client or self.pc).post("/api/maps/handoff", json=body if body is not None else QUEEN, **kw)

    def refresh(self, client=None, **kw):
        return (client or self.phone).post("/api/maps/refresh", json={}, **kw)

    def pending(self):
        r = self.phone.get("/api/maps/handoff")
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["items"]


class AuthTests(MapsCase):
    """The real ZeroTrustMiddleware in front of the maps router (token file = network lock on)."""

    def setUp(self):
        super().setUp()
        import server  # noqa: F401  (heavy import: only this class needs it)

        self.server = server
        tok = self.iso.tmp / "gateway.token"
        tok.write_text(TOKEN, encoding="utf-8")
        p = mock.patch.object(server.ZeroTrustMiddleware, "TOKEN_FILE", tok)
        p.start()
        self.addCleanup(p.stop)
        app = FastAPI()
        app.add_middleware(server.ZeroTrustMiddleware)
        app.include_router(maps_api.router)
        self.pc = TestClient(app, client=PC)
        self.phone = TestClient(app, client=PHONE)
        self.stranger = TestClient(app, client=STRANGER)

    def test_the_gateway_mounts_the_maps_router(self):
        app = self.server.app
        # Newer FastAPI keeps an included router as one entry; older ones copy its routes.
        mounted = any(getattr(r, "original_router", None) is maps_api.router for r in app.routes) or any(
            getattr(r, "path", "") == "/api/maps/ws" for r in app.routes
        )
        self.assertTrue(mounted, "maps_api.router is not included in server.app")
        paths = set(app.openapi()["paths"])
        for p in ("/api/maps/trips", "/api/maps/refresh", "/api/maps/handoff", "/api/maps/handoff/{hid}/ack"):
            self.assertIn(p, paths)

    def test_the_phone_needs_the_token(self):
        for method, path in (("GET", "/api/maps/trips"), ("GET", "/api/maps/handoff"), ("POST", "/api/maps/refresh"), ("GET", "/api/maps/refresh"), ("POST", "/api/maps/handoff/x/ack")):
            r = self.phone.request(method, path, json={"status": "opened"})
            self.assertEqual(r.status_code, 401, (method, path, r.text))
            r = self.phone.request(method, path, json={"status": "opened"}, headers={"authorization": "Bearer wrong"})
            self.assertEqual(r.status_code, 401, (method, path, r.text))
        auth = {"authorization": f"Bearer {TOKEN}"}
        self.assertEqual(self.phone.get("/api/maps/trips", headers=auth).status_code, 404)  # past auth: no snapshot yet
        self.assertEqual(self.phone.get("/api/maps/handoff", headers=auth).status_code, 200)
        self.assertEqual(self.phone.get("/api/maps/refresh", headers=auth).json(), {"pending": False, "requestedAtMs": None})

    def test_off_mesh_peers_are_refused_and_the_pc_needs_no_token(self):
        self.assertEqual(self.stranger.get("/api/maps/trips").status_code, 403)
        self.assertEqual(self.put().status_code, 200)
        self.assertEqual(self.pc.get("/api/maps/trips").status_code, 200)

    def test_the_token_does_not_make_the_phone_a_writer(self):
        auth = {"authorization": f"Bearer {TOKEN}"}
        self.assertEqual(self.put(client=self.phone, headers=auth).status_code, 403)
        self.assertEqual(self.handoff(client=self.phone, headers=auth).status_code, 403)
        self.assertFalse(maps_api._snapshot_path().exists())

    def test_the_socket_checks_the_token_itself(self):
        with self.assertRaises(WebSocketDisconnect) as e:
            with self.phone.websocket_connect("/api/maps/ws") as ws:
                ws.receive_text()
        self.assertEqual(e.exception.code, 4401)
        with self.assertRaises(WebSocketDisconnect):
            with self.phone.websocket_connect("/api/maps/ws?token=wrong") as ws:
                ws.receive_text()
        with self.phone.websocket_connect(f"/api/maps/ws?token={TOKEN}"):
            pass
        with self.phone.websocket_connect("/api/maps/ws", headers={"authorization": f"Bearer {TOKEN}"}):
            pass
        # A tunnel on loopback (forwarding headers) is not the PC.
        with self.assertRaises(WebSocketDisconnect) as e:
            with self.pc.websocket_connect("/api/maps/ws", headers={"x-forwarded-for": "198.51.100.4"}) as ws:
                ws.receive_text()
        self.assertEqual(e.exception.code, 4403)
        # An off-mesh peer is refused even holding the token.
        with self.assertRaises(WebSocketDisconnect) as e:
            with self.stranger.websocket_connect(f"/api/maps/ws?token={TOKEN}") as ws:
                ws.receive_text()
        self.assertEqual(e.exception.code, 4403)
        with self.pc.websocket_connect("/api/maps/ws"):
            pass


class SocketGateTests(MapsCase):
    """No token file (network lock off): the socket still admits only loopback and the mesh."""

    def refused(self, client, path="/api/maps/ws", **kw):
        with self.assertRaises(WebSocketDisconnect) as e:
            with client.websocket_connect(path, **kw) as ws:
                ws.receive_text()
        return e.exception.code

    def test_lock_off_still_refuses_tunnels_and_off_mesh_peers(self):
        self.assertFalse((self.iso.tmp / "gateway.token").exists())
        for h in ("x-forwarded-for", "x-forwarded-host", "forwarded", "x-real-ip"):
            self.assertEqual(self.refused(self.pc, headers={h: "8.8.8.8"}), 4403, h)
            self.assertEqual(self.refused(self.phone, headers={h: "8.8.8.8"}), 4403, h)
        self.assertEqual(self.refused(self.stranger), 4403)
        self.assertEqual(self.refused(TestClient(self.app)), 4403)  # host "testclient": not an IP
        self.assertEqual(self.refused(TestClient(self.app, client=("100.128.0.1", 1))), 4403)  # just past the /10
        self.assertEqual(maps_api._ws_clients, set())

    def test_lock_off_admits_the_pc_and_the_phone(self):
        with self.pc.websocket_connect("/api/maps/ws"):
            pass
        with self.phone.websocket_connect("/api/maps/ws"):
            pass
        with TestClient(self.app, client=("::1", 1)).websocket_connect("/api/maps/ws"):
            pass


class CrossSiteWriteTests(MapsCase):
    """A page open in a browser on the PC reaches the gateway from loopback: it must not be able to
    queue a hand-off, plant trips or fire a refresh with a preflight-free (simple) request."""

    def test_handoff_needs_json_and_the_apps_own_origin(self):
        raw = json.dumps({**QUEEN, "label": "Evil pickup point"})
        for headers in (
            {"content-type": "text/plain", "origin": "https://evil.example"},
            {"content-type": "text/plain"},
            {"content-type": "application/x-www-form-urlencoded"},
            {"content-type": "multipart/form-data; boundary=x"},
            {},
        ):
            r = self.pc.post("/api/maps/handoff", content=raw, headers=headers)
            self.assertIn(r.status_code, (403, 415), (headers, r.text))
        for origin in ("https://evil.example", "null", "http://localhost:1500", "http://localhost:1420.evil.example", "http://127.0.0.1:3000"):
            r = self.pc.post("/api/maps/handoff", content=raw, headers={"content-type": "application/json", "origin": origin})
            self.assertEqual(r.status_code, 403, (origin, r.text))
        self.assertEqual(self.pending(), [])
        self.assertEqual(self.events, [])
        self.assertEqual(self.iso.sql("SELECT id FROM maps_handoff"), [])
        # The app itself: its webview origins, a dev port, native code (no Origin), charset suffix.
        for i, origin in enumerate(("tauri://localhost", APP_ORIGIN, "http://localhost:1431", None)):
            headers = {"content-type": "application/json; charset=utf-8"}
            if origin:
                headers["origin"] = origin
            r = self.pc.post("/api/maps/handoff", content=json.dumps({**QUEEN, "lat": 43.0 + i / 10}), headers=headers)
            self.assertEqual(r.status_code, 200, (origin, r.text))
        self.assertEqual(len(self.pending()), 4)

    def test_trips_put_needs_json_and_the_apps_own_origin(self):
        raw = json.dumps(view())
        self.assertEqual(self.pc.put("/api/maps/trips", content=raw, headers={"content-type": "text/plain"}).status_code, 415)
        self.assertEqual(self.pc.put("/api/maps/trips", content=raw).status_code, 415)
        r = self.pc.put("/api/maps/trips", content=raw, headers={"content-type": "application/json", "origin": "https://evil.example"})
        self.assertEqual(r.status_code, 403, r.text)
        self.assertFalse(maps_api._snapshot_path().exists())
        self.assertEqual(self.put(headers={"origin": APP_ORIGIN}).status_code, 200)

    def test_refresh_needs_json(self):
        for headers in ({"content-type": "text/plain"}, {"content-type": "application/x-www-form-urlencoded"}, {}):
            r = self.phone.post("/api/maps/refresh", content="", headers=headers)
            self.assertEqual(r.status_code, 415, (headers, r.text))
        self.assertFalse(self.pc.get("/api/maps/refresh").json()["pending"])
        self.assertEqual(self.events, [])
        # The phone's PWA is served from the gateway's own (mesh) address: no Origin allow-list here.
        r = self.phone.post("/api/maps/refresh", content="", headers={"content-type": "application/json", "origin": "https://100.72.0.1:8443"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(self.pc.get("/api/maps/refresh").json()["pending"])


class SnapshotTests(MapsCase):
    def test_pc_only_writes(self):
        self.assertEqual(self.put(client=self.phone).status_code, 403)
        r = self.put(headers={"x-forwarded-for": "198.51.100.4"})  # a tunnel arriving on loopback
        self.assertEqual(r.status_code, 403, r.text)
        self.assertEqual(self.phone.get("/api/maps/trips").status_code, 404)
        self.assertEqual(self.phone.get("/api/maps/trips").json(), {"detail": "no snapshot"})

    def test_round_trip_age_and_file(self):
        v = view(fetched_ms=int(time.time() * 1000) - 125_000)
        r = self.put(v)
        self.assertEqual(r.status_code, 200, r.text)
        got = self.phone.get("/api/maps/trips").json()
        self.assertEqual(got["view"], v)
        self.assertIn(got["ageS"], (124, 125, 126))
        self.assertFalse(got["refreshPending"])
        self.assertFalse(got["killSwitch"])
        self.assertIsInstance(got["receivedAtMs"], int)
        # On disk under CC_DIR (data/command-center/ on the real gateway), read back after a restart.
        path = self.iso.tmp / "maps-trips.json"
        self.assertEqual(maps_api._snapshot_path(), path)
        self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["view"], v)
        self.assertEqual([p.name for p in self.iso.tmp.iterdir() if p.name.endswith(".tmp")], [])
        self.assertEqual(self.events[-1], {"type": "trips", "fetchedAtMs": v["fetchedAtMs"], "receivedAtMs": got["receivedAtMs"], "count": 1})
        # A future fetchedAtMs never shows a negative age.
        self.put(view(fetched_ms=int(time.time() * 1000) + 60_000))
        self.assertEqual(self.phone.get("/api/maps/trips").json()["ageS"], 0)

    def test_the_64_kb_cap(self):
        base = view()
        base["detail"] = ""
        overhead = len(json.dumps(base))
        fits = {**base, "detail": "x" * (maps_api.SNAPSHOT_MAX - overhead)}
        self.assertEqual(len(json.dumps(fits)), 64 * 1024)
        self.assertEqual(self.put(fits).status_code, 200)
        over = {**base, "detail": "x" * (maps_api.SNAPSHOT_MAX - overhead + 1)}
        r = self.put(over)
        self.assertEqual(r.status_code, 413, r.text)
        # Streamed without a Content-Length is capped as it arrives.
        raw = json.dumps(over).encode()
        r = self.pc.put("/api/maps/trips", content=iter([raw[:40_000], raw[40_000:]]), headers={"content-type": "application/json"})
        self.assertEqual(r.status_code, 413, r.text)
        self.assertEqual(self.phone.get("/api/maps/trips").json()["view"]["detail"], fits["detail"])

    def test_shape_checks(self):
        bad = [
            "not json",
            json.dumps([1, 2]),
            json.dumps({"fetchedAtMs": 1}),
            json.dumps(view(trips="x")),
            json.dumps(view(trips=[1])),
            json.dumps(view(trips=[trip()] * (maps_api.SNAPSHOT_MAX_TRIPS + 1))),
            json.dumps({**view(), "fetchedAtMs": "now"}),
            json.dumps({**view(), "fetchedAtMs": True}),
            json.dumps({**view(), "fetchedAtMs": -5}),
            '{"trips": [], "fetchedAtMs": NaN}',
            b"\xff\xfe".decode("latin-1"),
        ]
        for body in bad:
            r = self.pc.put("/api/maps/trips", content=body, headers={"content-type": "application/json"})
            self.assertEqual(r.status_code, 400, (body[:60], r.text))
        self.assertFalse(maps_api._snapshot_path().exists())

    def test_refresh_request_is_cleared_by_the_next_put(self):
        self.assertEqual(self.pc.get("/api/maps/refresh").json(), {"pending": False, "requestedAtMs": None})
        r = self.refresh()
        self.assertEqual(r.status_code, 200, r.text)
        at = r.json()["requestedAtMs"]
        self.assertEqual(self.pc.get("/api/maps/refresh").json(), {"pending": True, "requestedAtMs": at})
        self.assertEqual(self.events, [{"type": "trips-refresh", "requestedAtMs": at}])
        # A second tap right away keeps the first request (no second announcement).
        self.assertEqual(self.refresh().json()["requestedAtMs"], at)
        self.assertEqual(len(self.events), 1)
        self.put()
        self.assertTrue(self.phone.get("/api/maps/trips").status_code == 200)
        self.assertFalse(self.phone.get("/api/maps/trips").json()["refreshPending"])
        self.assertEqual(self.pc.get("/api/maps/refresh").json()["pending"], False)

    def test_refresh_request_lapses(self):
        clock = Clock()
        with mock.patch.object(maps_api, "time", clock):
            self.refresh()
            self.assertTrue(self.pc.get("/api/maps/refresh").json()["pending"])
            clock.t += maps_api.REFRESH_TTL_S + 1
            self.assertFalse(self.pc.get("/api/maps/refresh").json()["pending"])

    def test_kill_switch_refuses_refresh_but_the_pc_still_publishes(self):
        self.set_kill_switch(True)
        r = self.refresh()
        self.assertEqual(r.status_code, 423, r.text)
        self.assertIn("KILL_SWITCH", r.json()["detail"])
        self.assertFalse(self.pc.get("/api/maps/refresh").json()["pending"])
        # The PC's (blocked) view still lands, so the phone sees why nothing is fresh.
        self.assertEqual(self.put(view(trips=[], calendar="blocked")).status_code, 200)
        got = self.phone.get("/api/maps/trips").json()
        self.assertTrue(got["killSwitch"])
        self.assertEqual(got["view"]["calendar"], "blocked")
        # A missing mirror counts as on.
        (self.iso.tmp / "os-state.json").unlink()
        self.assertEqual(self.refresh().status_code, 423)


class HandoffTests(MapsCase):
    def test_pc_only_and_validation(self):
        self.assertEqual(self.handoff(client=self.phone).status_code, 403)
        self.assertEqual(self.handoff(headers={"x-forwarded-for": "198.51.100.4"}).status_code, 403)
        bad = [
            [1],
            {**QUEEN, "lat": 91},
            {**QUEEN, "lng": -181},
            {**QUEEN, "lat": True},
            {**QUEEN, "lat": "43.6"},
            {k: v for k, v in QUEEN.items() if k != "lng"},
            {**QUEEN, "label": "x" * (maps_api.LABEL_MAX + 1)},
            {**QUEEN, "label": 5},
            {**QUEEN, "mode": "sms"},
            {**QUEEN, "body": "on my way"},
            {**QUEEN, "address": "4165551234"},
            {**QUEEN, "stops": "x"},
            {**QUEEN, "stops": [{"lat": 1, "lng": 1}] * (maps_api.STOPS_MAX + 1)},
            {**QUEEN, "stops": [{"lat": 1, "lng": 1, "url": "http://x"}]},
            {**QUEEN, "stops": [{"lat": 100, "lng": 1}]},
        ]
        for b in bad:
            r = self.handoff(b)
            self.assertEqual(r.status_code, 400, (b, r.text))
        r = self.pc.post("/api/maps/handoff", content='{"lat": NaN, "lng": 1}', headers={"content-type": "application/json"})
        self.assertEqual(r.status_code, 400, r.text)
        r = self.pc.post("/api/maps/handoff", content=json.dumps({**QUEEN, "label": "x" * 5000}), headers={"content-type": "application/json"})
        self.assertEqual(r.status_code, 413, r.text)
        self.assertEqual(self.pending(), [])

    def test_queue_clean_and_list(self):
        r = self.handoff({"lat": 43.6525, "lng": -79.3839, "label": "  100 Queen\nSt W‮  ", "stops": [{"lat": 43.7, "lng": -79.4}]})
        self.assertEqual(r.status_code, 200, r.text)
        hid = r.json()["id"]
        self.assertFalse(r.json()["duplicate"])
        items = self.pending()
        self.assertEqual(len(items), 1)
        it = items[0]
        self.assertEqual((it["id"], it["label"], it["mode"], it["status"], it["from"]), (hid, "100 Queen St W", "navigate", "pending", "desktop"))
        self.assertEqual(it["stops"], [{"lat": 43.7, "lng": -79.4}])
        self.assertEqual(it["expiresMs"] - it["createdMs"], maps_api.HANDOFF_TTL_S * 1000)
        self.assertEqual(self.events[-1]["type"], "nav-handoff")
        self.assertEqual(self.events[-1]["id"], hid)
        # No label: the coordinates stand in.
        r = self.handoff({"lat": 43.0, "lng": -79.0})
        self.assertEqual(self.pending()[0]["label"], "43.00000, -79.00000")
        self.assertEqual(self.phone.get("/api/maps/handoff", params={"status": "sent"}).status_code, 400)

    def test_the_same_destination_is_not_queued_twice(self):
        a = self.handoff().json()
        b = self.handoff().json()
        self.assertEqual(a["id"], b["id"])
        self.assertTrue(b["duplicate"])
        self.assertEqual(len(self.pending()), 1)
        self.assertEqual(sum(e["type"] == "nav-handoff" for e in self.events), 1)
        self.handoff({**QUEEN, "mode": "pin"})
        self.assertEqual(len(self.pending()), 2)

    def test_ttl(self):
        clock = Clock()
        with mock.patch.object(maps_api, "time", clock):
            hid = self.handoff().json()["id"]
            clock.t += maps_api.HANDOFF_TTL_S - 5
            self.assertEqual([i["id"] for i in self.pending()], [hid])
            clock.t += 10
            self.assertEqual(self.pending(), [])
            self.assertIn({"type": "nav-handoff-ack", "id": hid, "status": "expired"}, self.events)
            gone = self.phone.get("/api/maps/handoff", params={"status": "expired"}).json()["items"]
            self.assertEqual([i["id"] for i in gone], [hid])
            r = self.phone.post(f"/api/maps/handoff/{hid}/ack", json={"status": "opened"})
            self.assertEqual(r.status_code, 410, r.text)
            # Finished rows (they hold an address) are purged after a day.
            clock.t += maps_api.HANDOFF_KEEP_S + 1
            self.pending()
            self.assertEqual(self.iso.sql("SELECT id FROM maps_handoff"), [])

    def test_ack(self):
        hid = self.handoff().json()["id"]
        self.assertEqual(self.phone.post(f"/api/maps/handoff/{hid}/ack", json={"status": "sent"}).status_code, 400)
        self.assertEqual(self.phone.post(f"/api/maps/handoff/{hid}/ack").status_code, 400)
        self.assertEqual(self.phone.post("/api/maps/handoff/nope/ack", json={"status": "opened"}).status_code, 404)
        r = self.phone.post(f"/api/maps/handoff/{hid}/ack", json={"status": "opened"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.events[-1], {"type": "nav-handoff-ack", "id": hid, "status": "opened"})
        self.assertEqual(self.pending(), [])
        n = len(self.events)
        self.assertEqual(self.phone.post(f"/api/maps/handoff/{hid}/ack", json={"status": "opened"}).status_code, 200)
        self.assertEqual(len(self.events), n)  # a repeat announces nothing
        self.assertEqual(self.phone.post(f"/api/maps/handoff/{hid}/ack", json={"status": "dismissed"}).status_code, 409)
        opened = self.phone.get("/api/maps/handoff", params={"status": "opened"}).json()["items"]
        self.assertEqual([i["id"] for i in opened], [hid])
        # Acked: the same destination can be sent again as a new item.
        self.assertNotEqual(self.handoff().json()["id"], hid)

    def test_pending_cap(self):
        ids = [self.handoff({"lat": 43.0 + i / 100, "lng": -79.0}).json()["id"] for i in range(maps_api.HANDOFF_MAX_PENDING + 3)]
        left = [i["id"] for i in self.pending()]
        self.assertEqual(len(left), maps_api.HANDOFF_MAX_PENDING)
        self.assertEqual(set(left), set(ids[3:]))

    def test_kill_switch(self):
        hid = self.handoff().json()["id"]
        self.set_kill_switch(True)
        r = self.handoff({**QUEEN, "mode": "pin"})
        self.assertEqual(r.status_code, 423, r.text)
        self.assertIn("KILL_SWITCH", r.json()["detail"])
        got = self.phone.get("/api/maps/handoff").json()
        self.assertEqual(got, {"items": [], "killSwitch": True})
        # Dismissing is still allowed; turning it off shows what is left.
        self.set_kill_switch(False)
        self.assertEqual([i["id"] for i in self.pending()], [hid])


class OwnSocketTests(MapsCase):
    record_maps_events = False

    def test_handoffs_use_their_own_socket_and_never_the_comms_outbox(self):
        rec = self.comms_events
        comms_clients = set(os_api._ws_clients)
        with self.phone.websocket_connect("/api/maps/ws") as ws:  # no token file: open, like the rest
            hid = self.handoff().json()["id"]
            ev = ws.receive_json()
            self.assertEqual((ev["type"], ev["id"], ev["label"]), ("nav-handoff", hid, QUEEN["label"]))
            self.phone.post(f"/api/maps/handoff/{hid}/ack", json={"status": "opened"})
            self.assertEqual(ws.receive_json(), {"type": "nav-handoff-ack", "id": hid, "status": "opened"})
            self.put()
            self.assertEqual(ws.receive_json()["type"], "trips")
        self.assertEqual(maps_api._ws_clients, set())
        self.assertEqual(rec, [])
        self.assertEqual(os_api._ws_clients, comms_clients)
        self.assertEqual(self.iso.sql("SELECT * FROM comms_outbox"), [])
        r = self.phone.get("/api/comms/outbox", params={"kinds": "sms,call,open"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["items"], [])


class SeparationTests(MapsCase):
    def test_trips_and_handoffs_stay_out_of_the_vault_and_search(self):
        self.put(view(trips=[trip(title="Zanzibarquux callback", loc="77 Zanzibarquux Ave")]))
        self.handoff({**QUEEN, "label": "Zanzibarquux studio"})
        self.assertEqual(self.iso.sql("SELECT COUNT(*) n FROM vault")[0]["n"], 0)
        self.assertEqual(self.iso.sql("SELECT COUNT(*) n FROM items")[0]["n"], 0)
        with mock.patch.object(cc, "embed", side_effect=RuntimeError("no embedder in tests")):
            self.assertEqual(cc.vault_search("Zanzibarquux")["results"], [])
        r = self.phone.get("/api/comms/search", params={"q": "Zanzibarquux"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["results"], [])
        # Saved routes (Maps step 8) are a synced collection but never embedded into the vault.
        self.assertNotIn("routes", cc.VAULT_FIELDS)
        self.assertNotIn("maps", cc.VAULT_FIELDS)

    def test_the_snapshot_and_handoff_store_are_git_ignored(self):
        if not shutil.which("git"):
            self.skipTest("git is not installed")
        real = Path(cc.BASE_DIR) / "data" / "command-center"
        for name in (maps_api.SNAPSHOT_FILE, "cc.db"):
            rel = (real / name).relative_to(REPO).as_posix()
            r = subprocess.run(["git", "check-ignore", "-q", rel], cwd=REPO, capture_output=True)
            self.assertEqual(r.returncode, 0, f"{rel} is not git-ignored")
        # The proposed data/maps/ folder is not ignored, which is why the snapshot isn't there.
        r = subprocess.run(["git", "check-ignore", "-q", "data/maps/trips.json"], cwd=REPO, capture_output=True)
        self.assertEqual(r.returncode, 1)


if __name__ == "__main__":
    unittest.main()
