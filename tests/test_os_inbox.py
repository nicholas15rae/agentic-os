"""Phone → desktop queue (os_api inbox): claim/lease, running state, per-kind TTL with an
explicit `expired` status, kind `task` validation and old-desktop compatibility; the speed
protocol: liveness in the POST answer, long-polls (GET /inbox?wait=, GET /inbox/{id}?wait=&after=)
and Tony's streamed answer (POST /inbox/{id}/delta).

Every test runs against a temp cc.db (command_center_api paths are redirected), never the
real data/command-center store.

Run with: python3 tests/run_all.py  (or: python3 tests/test_os_inbox.py)
"""
import ast
import importlib.util
import json
import logging
import math
import re
import shutil
import socket
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import Harness, get_free_port  # noqa: E402

import command_center_api as cc  # noqa: E402
import os_api  # noqa: E402
import server  # noqa: E402

# Client constants the gateway's restart grace has to cover (checked against the sources by
# RestartGraceContractTests): the phone's "desktop alive" window (dispatch.ts desktopAlive) and the
# desktop's retry interval while the gateway is down (pipeline.rs INBOX_DOWN).
PHONE_ALIVE_SECS = 15
DESKTOP_DOWN_RETRY_SECS = 15
# The desktop's first poll after a restart: its down-retry, plus a refused connect (~2 s on
# Windows) and the gateway's own import → listening time (up to ~10 s), after the module import.
LATEST_FIRST_POLL_SECS = DESKTOP_DOWN_RETRY_SECS + 12


def fresh_os_api():
    """os_api as a just-restarted gateway has it: the module's code run again from scratch into a
    new module object (the live one the harness serves is untouched)."""
    spec = importlib.util.spec_from_file_location("os_api_after_restart", os_api.__file__)
    mod = importlib.util.module_from_spec(spec)
    access = logging.getLogger("uvicorn.access")
    filters = list(access.filters)
    try:
        spec.loader.exec_module(mod)
    finally:
        access.filters[:] = filters  # its import adds a second Spotify-redaction filter
    return mod


def phone_sees_desktop_alive(poll, now):
    """dispatch.ts desktopAlive, mirrored: busy, or polled in the last 15 s."""
    seen = poll.get("desktopSeenAt")
    return bool(poll.get("desktopBusy")) or (bool(seen) and now - seen < PHONE_ALIVE_SECS)


class IsolatedCC:
    """Point command_center_api's store (cc.db, config.json, files) at a temp dir."""

    _NAMES = ("CC_DIR", "FILES_DIR", "DB_PATH", "CONFIG_PATH")

    def __init__(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="agentic-os-cc-"))
        self._saved = {}

    def __enter__(self):
        self._saved = {n: getattr(cc, n) for n in self._NAMES}
        # Importing server.py starts the real vault indexer (cc.start()), which keeps retrying a
        # previous test's rows on whatever cc.DB_PATH is now. Two first connections switching a
        # brand-new file to WAL at once fail at once ("database is locked", no busy wait), so the
        # file is already WAL before any of them can see it.
        with sqlite3.connect(self.tmp / "cc.db") as pre:
            pre.execute("PRAGMA journal_mode=WAL")
        pre.close()
        cc.CC_DIR = self.tmp
        cc.FILES_DIR = self.tmp / "files"
        cc.DB_PATH = self.tmp / "cc.db"
        cc.CONFIG_PATH = self.tmp / "config.json"
        cc._models_cache.clear()
        cc._loaded_cache.clear()
        cc.init_db()
        os_api.init()
        return self

    def __exit__(self, *exc):
        for n, v in self._saved.items():
            setattr(cc, n, v)
        os_api._schema_ready.discard(str(self.tmp / "cc.db"))
        cc._models_cache.clear()
        cc._loaded_cache.clear()
        shutil.rmtree(self.tmp, ignore_errors=True)
        return False

    def sql(self, query, args=()):
        with cc._db_lock, cc.db() as c:
            return [dict(r) for r in c.execute(query, args).fetchall()]


class GatewayCase(unittest.TestCase):
    """One in-process gateway + an isolated cc store for the whole class."""

    @classmethod
    def setUpClass(cls):
        cls.iso = IsolatedCC().__enter__()
        cls.h = Harness()
        cls.h.start()

    @classmethod
    def tearDownClass(cls):
        cls.h.stop()
        cls.iso.__exit__(None, None, None)

    def api(self, method, path, body=None, timeout=15.0):
        return self.h.api(method, path, body, timeout=timeout)


class Bg(threading.Thread):
    """One request in the background (a long-poll), timed."""

    def __init__(self, fn):
        super().__init__(daemon=True)
        self.fn, self.out, self.err, self.done_at = fn, None, None, None
        self.started_at = time.monotonic()
        self.start()

    def run(self):
        try:
            self.out = self.fn()
        except BaseException as e:  # surfaced by result()
            self.err = e
        self.done_at = time.monotonic()

    def result(self, timeout=40.0):
        self.join(timeout)
        if self.is_alive():
            raise AssertionError("background request never returned")
        if self.err:
            raise self.err
        return self.out


def until(pred, timeout=5.0, what="condition"):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if pred():
            return
        time.sleep(0.01)
    raise AssertionError(f"timed out waiting for {what}")


class QueueCase(GatewayCase):
    def setUp(self):
        self.iso.sql("DELETE FROM os_queue")
        os_api._DESKTOP_SEEN.update(at=0.0, resultAt=0.0)  # an earlier test's result must not read "busy"

    def post(self, kind="turn", payload=None):
        s, d = self.api("POST", "/api/os/inbox", {"kind": kind, "payload": payload if payload is not None else {"text": "hi", "noDelegate": True}})
        self.assertEqual(s, 200, d)
        return d["id"]

    def pending_ids(self):
        s, d = self.api("GET", "/api/os/inbox")
        self.assertEqual(s, 200, d)
        return [i["id"] for i in d["items"]]

    def claim(self, qid, lease_secs=120, token=None):
        body = {"lease_secs": lease_secs, **({"claim_token": token} if token else {})}
        s, c = self.api("POST", f"/api/os/inbox/{qid}/claim", body)
        self.assertEqual(s, 200, c)
        return c["claim_token"]

    def delta(self, qid, token, seq, text):
        return self.api("POST", f"/api/os/inbox/{qid}/delta", {"claim_token": token, "seq": seq, "text": text})

    def bg_get(self, path, timeout=40.0):
        return Bg(lambda: self.api("GET", path, timeout=timeout))

    @staticmethod
    def waiters():
        return len(os_api._waiters)


class InboxTests(QueueCase):
    def test_claim_running_result(self):
        qid = self.post()
        self.assertIn(qid, self.pending_ids())
        s, c = self.api("POST", f"/api/os/inbox/{qid}/claim", {"lease_secs": 120})
        self.assertEqual(s, 200, c)
        self.assertEqual(c["status"], "running")
        self.assertEqual(c["payload"]["text"], "hi")
        self.assertTrue(c["claim_token"])
        self.assertAlmostEqual(c["lease_until"], time.time() + 120, delta=5)
        # Running under a live lease: not offered again, and the phone sees "running".
        self.assertNotIn(qid, self.pending_ids())
        s, g = self.api("GET", f"/api/os/inbox/{qid}")
        self.assertEqual(g["status"], "running")
        self.assertNotIn("claim_token", g)  # the token only goes to the claimer
        s, d = self.api("POST", f"/api/os/inbox/{qid}/result", {"ok": True, "result": {"answer": "hello"}, "claim_token": c["claim_token"]})
        self.assertEqual(s, 200, d)
        s, g = self.api("GET", f"/api/os/inbox/{qid}")
        self.assertEqual(g["status"], "done")
        self.assertEqual(g["result"], {"ok": True, "result": {"answer": "hello"}})

    def test_item_reports_desktop_liveness(self):
        """A queued phone turn says whether the desktop is alive and busy (so the phone keeps
        waiting for Tony instead of falling back while an earlier turn is still running)."""
        first, second = self.post(), self.post()
        s, g = self.api("GET", f"/api/os/inbox/{second}")
        self.assertEqual((g["status"], g["desktopSeenAt"], g["desktopBusy"]), ("pending", 0.0, False))
        self.pending_ids()  # the desktop polls
        s, c = self.api("POST", f"/api/os/inbox/{first}/claim", {"lease_secs": 120})
        s, g = self.api("GET", f"/api/os/inbox/{second}")
        self.assertEqual(g["status"], "pending")
        self.assertAlmostEqual(g["desktopSeenAt"], time.time(), delta=5)
        self.assertTrue(g["desktopBusy"])  # the first turn is running under a live lease
        self.api("POST", f"/api/os/inbox/{first}/result", {"ok": True, "result": {"answer": "a"}, "claim_token": c["claim_token"]})
        s, g = self.api("GET", f"/api/os/inbox/{second}")
        # Just finished one: its next poll is on the way, so the queued turn keeps waiting for Tony.
        self.assertTrue(g["desktopBusy"])
        os_api._DESKTOP_SEEN["resultAt"] = time.time() - os_api.DESKTOP_BUSY_GRACE_SECS - 1
        s, g = self.api("GET", f"/api/os/inbox/{second}")
        self.assertFalse(g["desktopBusy"])  # grace over, nothing running

    def test_restarted_gateway_counts_an_unheard_desktop_alive_through_its_grace(self):
        """A restart forgets when the desktop last polled. An item pending across it must not read
        "no desktop" to the phone before the desktop's next poll can land, or the phone cancels it
        and answers from the CLI a few seconds before the desktop would have claimed it."""
        before = time.time()
        fresh = fresh_os_api()
        after = time.time()
        start = fresh.GATEWAY_STARTED
        self.assertTrue(before <= start <= after)
        self.assertEqual(fresh._DESKTOP_SEEN["resultAt"], 0.0)  # nothing finished: never "busy"
        os_api._DESKTOP_SEEN.update(fresh._DESKTOP_SEEN)  # the live gateway, just restarted
        qid = self.post()
        s, g = self.api("GET", f"/api/os/inbox/{qid}")
        self.assertEqual((s, g["status"], g["desktopBusy"]), (200, "pending", False))
        # The phone's 12 s pickup check and every poll after it until the desktop's first poll.
        for t in (12, 16, 20, LATEST_FIRST_POLL_SECS):
            self.assertTrue(phone_sees_desktop_alive(g, start + t), f"{t} s after the restart")
        # No desktop app at all: the phone still falls back once the grace is over.
        self.assertFalse(phone_sees_desktop_alive(g, start + fresh.DESKTOP_RESTART_GRACE_SECS + 1))
        # The desktop's first poll replaces the placeholder with the real time.
        self.pending_ids()
        s, g = self.api("GET", f"/api/os/inbox/{qid}")
        self.assertAlmostEqual(g["desktopSeenAt"], time.time(), delta=5)
        self.assertLessEqual(g["desktopSeenAt"], time.time())

    def test_claim_and_result_refresh_desktop_seen(self):
        """A long turn keeps the desktop off GET /inbox; its claim (and lease renewals) and its
        result still count as "seen", so the phone never reads a working desktop as gone."""
        first, second = self.post(), self.post()
        s, c = self.api("POST", f"/api/os/inbox/{first}/claim", {"lease_secs": 120})
        self.assertEqual(s, 200, c)
        self.assertAlmostEqual(os_api._DESKTOP_SEEN["at"], time.time(), delta=5)
        os_api._DESKTOP_SEEN["at"] = 0.0
        s, r = self.api("POST", f"/api/os/inbox/{first}/claim", {"claim_token": c["claim_token"], "lease_secs": 120})
        self.assertEqual(s, 200, r)
        self.assertAlmostEqual(os_api._DESKTOP_SEEN["at"], time.time(), delta=5)  # renewal
        os_api._DESKTOP_SEEN["at"] = 0.0
        s, d = self.api("POST", f"/api/os/inbox/{first}/result", {"ok": True, "result": {"answer": "a"}, "claim_token": c["claim_token"]})
        self.assertEqual(s, 200, d)
        s, g = self.api("GET", f"/api/os/inbox/{second}")
        self.assertAlmostEqual(g["desktopSeenAt"], time.time(), delta=5)
        self.assertAlmostEqual(os_api._DESKTOP_SEEN["resultAt"], time.time(), delta=5)
        self.assertEqual(g["status"], "pending")
        self.assertTrue(g["desktopBusy"])

    def test_rejected_result_is_seen_but_not_a_finished_item(self):
        qid = self.post()
        s, first = self.api("POST", f"/api/os/inbox/{qid}/claim", {"lease_secs": 60})
        self.iso.sql("UPDATE os_queue SET lease_until=? WHERE id=?", (time.time() - 1, qid))
        s, second = self.api("POST", f"/api/os/inbox/{qid}/claim", {"lease_secs": 60})
        self.assertEqual(s, 200, second)
        os_api._DESKTOP_SEEN.update(at=0.0, resultAt=0.0)
        s, d = self.api("POST", f"/api/os/inbox/{qid}/result", {"ok": True, "result": {}, "claim_token": first["claim_token"]})
        self.assertEqual(s, 409, d)
        self.assertAlmostEqual(os_api._DESKTOP_SEEN["at"], time.time(), delta=5)
        self.assertEqual(os_api._DESKTOP_SEEN["resultAt"], 0.0)

    def test_cancel_pending_item_is_terminal(self):
        """The phone takes back an unclaimed turn before running it on the CLI: a desktop that
        starts later never sees or claims it (no double run)."""
        qid, other = self.post(), self.post()
        s, d = self.api("POST", f"/api/os/inbox/{qid}/cancel")
        self.assertEqual(s, 200, d)
        self.assertEqual(d, {"id": qid, "status": "cancelled"})
        s, g = self.api("GET", f"/api/os/inbox/{qid}")
        self.assertEqual(s, 200, g)
        self.assertEqual(g["status"], "cancelled")
        self.assertEqual(g["result"], {"ok": False, "error": os_api.CANCELLED_ERROR})
        ids = self.pending_ids()
        self.assertNotIn(qid, ids)
        self.assertIn(other, ids)  # only that item
        s, d = self.api("POST", f"/api/os/inbox/{qid}/claim", {"lease_secs": 120})
        self.assertEqual(s, 409, d)
        # A repeat (the first answer was lost) is not an error.
        s, d = self.api("POST", f"/api/os/inbox/{qid}/cancel")
        self.assertEqual((s, d["status"]), (200, "cancelled"))
        # Expiry never rewrites a cancelled item.
        self.iso.sql("UPDATE os_queue SET created=? WHERE id=?", (time.time() - 700, qid))
        s, g = self.api("GET", f"/api/os/inbox/{qid}")
        self.assertEqual(g["status"], "cancelled")

    def test_cancel_refused_while_claimed_or_finished(self):
        qid = self.post()
        s, c = self.api("POST", f"/api/os/inbox/{qid}/claim", {"lease_secs": 120})
        self.assertEqual(s, 200, c)
        s, d = self.api("POST", f"/api/os/inbox/{qid}/cancel")
        self.assertEqual(s, 409, d)  # the desktop has it under a live lease: the phone keeps waiting
        s, g = self.api("GET", f"/api/os/inbox/{qid}")
        self.assertEqual(g["status"], "running")
        # The holder still renews and answers as usual.
        s, r = self.api("POST", f"/api/os/inbox/{qid}/claim", {"claim_token": c["claim_token"], "lease_secs": 120})
        self.assertEqual(s, 200, r)
        s, d = self.api("POST", f"/api/os/inbox/{qid}/result", {"ok": True, "result": {"answer": "a"}, "claim_token": c["claim_token"]})
        self.assertEqual(s, 200, d)
        s, d = self.api("POST", f"/api/os/inbox/{qid}/cancel")
        self.assertEqual(s, 409, d)  # done
        s, g = self.api("GET", f"/api/os/inbox/{qid}")
        self.assertEqual(g["status"], "done")
        self.assertEqual(self.api("POST", "/api/os/inbox/nope/cancel")[0], 404)
        # An expired item is finished too (the phone's next poll explains it).
        old = self.post()
        self.iso.sql("UPDATE os_queue SET created=? WHERE id=?", (time.time() - 700, old))
        s, d = self.api("POST", f"/api/os/inbox/{old}/cancel")
        self.assertEqual(s, 409, d)
        self.assertEqual(self.api("GET", f"/api/os/inbox/{old}")[1]["status"], "expired")

    def test_cancel_refuses_a_claimed_item_even_after_its_lease_lapsed(self):
        # A lapsed lease doesn't prove the desktop stopped: cancelling it would let the phone run
        # the turn elsewhere while the desktop's late result still lands.
        qid = self.post()
        s, c = self.api("POST", f"/api/os/inbox/{qid}/claim", {"lease_secs": 60})
        self.assertEqual(s, 200, c)
        self.iso.sql("UPDATE os_queue SET lease_until=? WHERE id=?", (time.time() - 1, qid))
        s, d = self.api("POST", f"/api/os/inbox/{qid}/cancel")
        self.assertEqual(s, 409, d)
        s, g = self.api("GET", f"/api/os/inbox/{qid}")
        self.assertEqual(g["status"], "running")

    def test_a_late_result_never_revives_a_cancelled_item(self):
        qid = self.post()
        self.assertEqual(self.api("POST", f"/api/os/inbox/{qid}/cancel")[0], 200)
        s, d = self.api("POST", f"/api/os/inbox/{qid}/result", {"ok": True, "result": {"answer": "late"}})
        self.assertEqual(s, 409, d)
        s, g = self.api("GET", f"/api/os/inbox/{qid}")
        self.assertEqual(g["status"], "cancelled")

    def test_get_keeps_its_response_fields(self):
        qid = self.post()
        s, g = self.api("GET", f"/api/os/inbox/{qid}")
        self.assertEqual(s, 200, g)
        for k in ("id", "kind", "payload", "status", "result", "desktopSeenAt", "desktopBusy"):
            self.assertIn(k, g)
        self.assertIsInstance(g["desktopBusy"], bool)

    def test_double_claim_is_409(self):
        qid = self.post()
        s, c = self.api("POST", f"/api/os/inbox/{qid}/claim", {})
        self.assertEqual(s, 200, c)
        s, d = self.api("POST", f"/api/os/inbox/{qid}/claim", {})
        self.assertEqual(s, 409, d)
        # The holder renews with its token.
        s, r = self.api("POST", f"/api/os/inbox/{qid}/claim", {"claim_token": c["claim_token"], "lease_secs": 600})
        self.assertEqual(s, 200, r)
        self.assertEqual(r["claim_token"], c["claim_token"])
        self.assertGreater(r["lease_until"], c["lease_until"])

    def test_claim_rejects_bad_lease_and_unknown_and_finished(self):
        qid = self.post()
        self.assertEqual(self.api("POST", f"/api/os/inbox/{qid}/claim", {"lease_secs": 901})[0], 400)
        self.assertEqual(self.api("POST", f"/api/os/inbox/{qid}/claim", {"lease_secs": 0})[0], 400)
        self.assertEqual(self.api("POST", "/api/os/inbox/nope/claim", {})[0], 404)
        self.api("POST", f"/api/os/inbox/{qid}/result", {"ok": True, "result": {}})
        self.assertEqual(self.api("POST", f"/api/os/inbox/{qid}/claim", {})[0], 409)

    def test_expired_lease_is_reoffered_and_old_claimer_is_superseded(self):
        qid = self.post()
        s, first = self.api("POST", f"/api/os/inbox/{qid}/claim", {"lease_secs": 60})
        self.assertEqual(s, 200)
        self.iso.sql("UPDATE os_queue SET lease_until=? WHERE id=?", (time.time() - 1, qid))
        self.assertIn(qid, self.pending_ids())
        s, second = self.api("POST", f"/api/os/inbox/{qid}/claim", {})
        self.assertEqual(s, 200, second)
        self.assertNotEqual(first["claim_token"], second["claim_token"])
        s, d = self.api("POST", f"/api/os/inbox/{qid}/result", {"ok": True, "result": {}, "claim_token": first["claim_token"]})
        self.assertEqual(s, 409, d)
        s, d = self.api("POST", f"/api/os/inbox/{qid}/result", {"ok": False, "error": "boom", "claim_token": second["claim_token"]})
        self.assertEqual(s, 200, d)
        s, g = self.api("GET", f"/api/os/inbox/{qid}")
        self.assertEqual(g["status"], "error")
        self.assertEqual(g["result"]["error"], "boom")

    def test_old_pending_item_expires_with_a_result_not_dropped(self):
        turn = self.post()
        pipe = self.post("pipeline", {"ideaId": "i1"})
        old = time.time() - 700
        self.iso.sql("UPDATE os_queue SET created=? WHERE id IN (?,?)", (old, turn, pipe))
        ids = self.pending_ids()
        self.assertNotIn(turn, ids)  # turn TTL is 600 s
        self.assertIn(pipe, ids)  # pipeline/task TTL is 24 h
        s, g = self.api("GET", f"/api/os/inbox/{turn}")
        self.assertEqual(s, 200)  # the row is kept
        self.assertEqual(g["status"], "expired")
        self.assertEqual(g["result"], {"ok": False, "error": os_api.EXPIRED_ERROR})
        self.assertEqual(self.api("POST", f"/api/os/inbox/{turn}/claim", {})[0], 409)

    def test_running_item_with_live_lease_never_expires(self):
        qid = self.post()
        self.api("POST", f"/api/os/inbox/{qid}/claim", {"lease_secs": 600})
        self.iso.sql("UPDATE os_queue SET created=? WHERE id=?", (time.time() - 700, qid))
        s, g = self.api("GET", f"/api/os/inbox/{qid}")
        self.assertEqual(g["status"], "running")
        # ...but once the lease is gone too, it does.
        self.iso.sql("UPDATE os_queue SET lease_until=? WHERE id=?", (time.time() - 1, qid))
        s, g = self.api("GET", f"/api/os/inbox/{qid}")
        self.assertEqual(g["status"], "expired")

    def test_per_kind_ttls(self):
        self.assertEqual(os_api.QUEUE_TTL["turn"], 600)
        self.assertEqual(os_api.QUEUE_TTL["command"], 600)
        self.assertEqual(os_api.QUEUE_TTL["playplace"], 3600)
        self.assertEqual(os_api.QUEUE_TTL["pipeline"], 86400)
        self.assertEqual(os_api.QUEUE_TTL["task"], 86400)

    def test_task_kind_accepted_and_validated(self):
        qid = self.post("task", {"raw_intent": "Build a minimal status card", "title": "Status card", "thread": "general", "source": "phone"})
        self.assertIn(qid, self.pending_ids())
        self.post("task", {"raw_intent": {"text": "x" * 8000, "timestamp": 1, "memory_ref": "m"}, "title": "t" * 120})
        for payload, code in (
            ({"raw_intent": "x" * 8001}, 413),
            ({"raw_intent": {"text": "x" * 8001}}, 413),
            ({"raw_intent": "ok", "title": "t" * 121}, 413),
            ({"raw_intent": "  "}, 400),
            ({"title": "no intent"}, 400),
            ({"raw_intent": "ok", "title": 5}, 400),
        ):
            s, d = self.api("POST", "/api/os/inbox", {"kind": "task", "payload": payload})
            self.assertEqual(s, code, (payload if len(str(payload)) < 80 else "big", d))

    def test_command_kind_accepts_mic_and_mode_keys(self):
        # Phase 2 fix: the phone locks/unlocks the desktop mic and switches Tony's mode through
        # `command`; the gateway used to 400 everything but killSwitch/computeMode.
        for payload in (
            {"micEnabled": False},
            {"micEnabled": True},
            {"modeId": "builder"},
            {"overrides": {"curiosity": "low", "dispatch": None}},
            {"resetOverrides": True},
            {"killSwitch": True, "computeMode": "local"},
        ):
            qid = self.post("command", payload)
            self.assertIn(qid, self.pending_ids())
        for payload in (
            {"micEnabled": "off"},
            {"modeId": ""},
            {"modeId": 3},
            {"modeId": "m" * 65},
            {"overrides": ["low"]},
            {"overrides": {"curiosity": 1}},
            {"resetOverrides": "yes"},
            {"killSwitch": 1},
            {"shell": "rm -rf"},
        ):
            s, d = self.api("POST", "/api/os/inbox", {"kind": "command", "payload": payload})
            self.assertEqual(s, 400, (payload, d))

    def test_command_kind_accepts_memory_proposal_answers(self):
        # Decision 5: the phone's card under a Learning reply answers a pending core-memory proposal.
        for payload in ({"memoryApprove": "mem-1764100000000-12"}, {"memoryDiscard": "mem-1764100000000-13"}, {"memoryApprove": "a_b-C9"}):
            qid = self.post("command", payload)
            self.assertIn(qid, self.pending_ids())
        for payload in (
            {"memoryApprove": ""},
            {"memoryApprove": 12},
            {"memoryApprove": "../etc/passwd"},
            {"memoryApprove": "mem 1"},
            {"memoryApprove": "m" * 65},
            {"memoryDiscard": ["mem-1"]},
            {"memoryApprove": "mem-1\n"},
            {"memoryApprove": "mem-1", "memoryDiscard": "mem-1"},
            {"memorySave": "mem-1"},
        ):
            s, d = self.api("POST", "/api/os/inbox", {"kind": "command", "payload": payload})
            self.assertEqual(s, 400, (payload, d))

    def test_bad_kind_and_oversize_payload(self):
        self.assertEqual(self.api("POST", "/api/os/inbox", {"kind": "nope", "payload": {}})[0], 400)
        self.assertEqual(self.api("POST", "/api/os/inbox", {"kind": "turn", "payload": ["x"]})[0], 400)
        s, d = self.api("POST", "/api/os/inbox", {"kind": "turn", "payload": {"text": "x" * (os_api._PAYLOAD_MAX + 10)}})
        self.assertEqual(s, 413, d)
        self.assertEqual(self.iso.sql("SELECT COUNT(*) n FROM os_queue")[0]["n"], 0)

    def test_unclaimed_result_still_works_for_old_desktop(self):
        qid = self.post()
        s, d = self.api("POST", f"/api/os/inbox/{qid}/result", {"ok": True, "result": {"answer": "from an old build"}})
        self.assertEqual(s, 200, d)
        s, g = self.api("GET", f"/api/os/inbox/{qid}")
        self.assertEqual(g["status"], "done")
        self.assertEqual(g["result"]["result"]["answer"], "from an old build")
        self.assertEqual(self.api("POST", "/api/os/inbox/missing/result", {"ok": True})[0], 404)

    def test_corrupt_legacy_row_does_not_poison_the_inbox(self):
        now = time.time()
        self.iso.sql("INSERT INTO os_queue(id,kind,payload,status,result,created,updated) VALUES('legacy','turn','{\"text\": \"cut',  'pending', NULL, ?, ?)", (now, now))
        s, d = self.api("GET", "/api/os/inbox")
        self.assertEqual(s, 200, d)
        self.assertEqual([i for i in d["items"] if i["id"] == "legacy"][0]["payload"], {})

    def test_schema_migration_is_additive_and_idempotent(self):
        cols = {r["name"] for r in self.iso.sql("PRAGMA table_info(os_queue)")}
        self.assertTrue({"claimed_at", "lease_until", "claim_token", "partial", "partial_seq", "partial_token"} <= cols)
        os_api._schema_ready.discard(str(cc.DB_PATH))
        os_api._ensure_schema()  # second run: no duplicate-column error
        tables = {r["name"] for r in self.iso.sql("SELECT name FROM sqlite_master WHERE type='table'")}
        self.assertIn("task_mirror", tables)


class PostLivenessTests(QueueCase):
    """G1: POST /api/os/inbox answers with desktopSeenAt / desktopBusy, so the phone needs no
    extra round trip to see that no desktop app is running."""

    def test_post_reports_the_same_liveness_as_get(self):
        s, d = self.api("POST", "/api/os/inbox", {"kind": "turn", "payload": {"text": "hi"}})
        self.assertEqual(s, 200, d)
        self.assertEqual((d["status"], d["desktopSeenAt"], d["desktopBusy"]), ("pending", 0.0, False))
        s, g = self.api("GET", f"/api/os/inbox/{d['id']}")
        self.assertEqual((g["desktopSeenAt"], g["desktopBusy"]), (d["desktopSeenAt"], d["desktopBusy"]))
        self.pending_ids()  # the desktop polls...
        self.claim(d["id"])  # ...and runs the first turn
        s, d2 = self.api("POST", "/api/os/inbox", {"kind": "turn", "payload": {"text": "again"}})
        self.assertEqual(s, 200, d2)
        self.assertAlmostEqual(d2["desktopSeenAt"], time.time(), delta=5)
        self.assertIs(d2["desktopBusy"], True)
        s, g = self.api("GET", f"/api/os/inbox/{d2['id']}")
        self.assertIs(g["desktopBusy"], True)
        self.assertAlmostEqual(g["desktopSeenAt"], d2["desktopSeenAt"], delta=5)


class BusyNeedsALiveDesktopTests(QueueCase):
    """A running item reads "desktop busy" only while the desktop running it is still there (seen
    in the last DESKTOP_RUN_SEEN_SECS, or holding GET /inbox?wait= open), not for its whole lease:
    a crashed or closed desktop must not keep the phone waiting up to 300 s instead of falling back."""

    def running_turn(self):
        """A turn claimed under the desktop's default lease, and a phone turn queued behind it."""
        first, queued = self.post(), self.post()
        token = self.claim(first, lease_secs=os_api.LEASE_DEFAULT_SECS)
        return first, queued, token

    def view(self, qid):
        s, g = self.api("GET", f"/api/os/inbox/{qid}")
        self.assertEqual(s, 200, g)
        return g

    def lease_live(self, qid):
        rows = self.iso.sql("SELECT status, lease_until FROM os_queue WHERE id=?", (qid,))
        return rows[0]["status"] == "running" and rows[0]["lease_until"] > time.time()

    def test_the_window_is_shorter_than_a_lease_and_covers_claim_renewals(self):
        self.assertEqual(os_api.DESKTOP_RUN_SEEN_SECS, 90.0)
        self.assertLess(os_api.DESKTOP_RUN_SEEN_SECS, os_api.LEASE_DEFAULT_SECS)
        self.assertGreater(os_api.DESKTOP_RUN_SEEN_SECS, 2 * 30)  # the desktop renews every 30 s mid-run

    def test_a_desktop_last_seen_120_s_ago_is_not_busy(self):
        first, queued, _ = self.running_turn()
        os_api._DESKTOP_SEEN["at"] = time.time() - 120  # crashed mid-turn, its lease still running
        self.assertTrue(self.lease_live(first))
        g = self.view(queued)
        self.assertIs(g["desktopBusy"], False)
        self.assertFalse(phone_sees_desktop_alive(g, time.time()))  # the phone falls back
        self.assertIs(self.view(first)["desktopBusy"], False)  # the running item reads the same
        s, d = self.api("POST", "/api/os/inbox", {"kind": "turn", "payload": {"text": "again"}})
        self.assertEqual(s, 200, d)
        self.assertIs(d["desktopBusy"], False)  # POST /inbox reports it too

    def test_a_desktop_last_seen_20_s_ago_is_busy(self):
        first, queued, _ = self.running_turn()
        os_api._DESKTOP_SEEN["at"] = time.time() - 20  # past the phone's 15 s window, mid-turn
        g = self.view(queued)
        self.assertIs(g["desktopBusy"], True)
        self.assertTrue(phone_sees_desktop_alive(g, time.time()))  # the phone keeps waiting for Tony
        s, d = self.api("POST", "/api/os/inbox", {"kind": "turn", "payload": {"text": "again"}})
        self.assertIs(d["desktopBusy"], True)

    def test_a_claim_renewal_with_the_token_makes_it_busy_again(self):
        first, queued, token = self.running_turn()
        os_api._DESKTOP_SEEN["at"] = time.time() - 120
        self.assertIs(self.view(queued)["desktopBusy"], False)
        before = time.time()
        self.assertEqual(self.claim(first, lease_secs=os_api.LEASE_DEFAULT_SECS, token=token), token)  # renewal
        g = self.view(queued)
        self.assertGreaterEqual(g["desktopSeenAt"], before - 0.05)
        self.assertIs(g["desktopBusy"], True)

    def test_an_open_list_wait_counts_as_a_live_desktop(self):
        first = self.post()
        self.claim(first)  # running under a live lease: not listable, so the list waits
        bg = self.bg_get("/api/os/inbox?wait=3")
        until(lambda: os_api._desktop_list_waits == 1, what="the desktop's long-poll")
        os_api._DESKTOP_SEEN["at"] = time.time() - 120  # stale stored time, but connected right now
        self.assertIs(self.view(first)["desktopBusy"], True)
        self.assertEqual(bg.result()[1]["items"], [])

    def test_the_result_grace_does_not_depend_on_the_run_window(self):
        first, queued, token = self.running_turn()
        s, d = self.api("POST", f"/api/os/inbox/{first}/result", {"ok": True, "result": {"answer": "a"}, "claim_token": token})
        self.assertEqual(s, 200, d)
        os_api._DESKTOP_SEEN["at"] = time.time() - 120
        self.assertIs(self.view(queued)["desktopBusy"], True)  # just finished one: its next poll is on the way
        os_api._DESKTOP_SEEN["resultAt"] = time.time() - os_api.DESKTOP_BUSY_GRACE_SECS - 1
        self.assertIs(self.view(queued)["desktopBusy"], False)


class ItemLongPollTests(QueueCase):
    """G2: GET /api/os/inbox/{id}?wait=W&after=S."""

    def test_no_wait_answers_at_once_with_the_partial_fields(self):
        qid = self.post()
        for path in (f"/api/os/inbox/{qid}", f"/api/os/inbox/{qid}?wait=0&after=0"):
            t0 = time.monotonic()
            s, g = self.api("GET", path)
            self.assertLess(time.monotonic() - t0, 1.0)
            self.assertEqual((s, g["partial"], g["partialSeq"]), (200, "", 0))
            for private in ("claim_token", "partial_token", "partial_seq"):
                self.assertNotIn(private, g)
        self.assertEqual(self.api("GET", "/api/os/inbox/nope?wait=2&after=0")[0], 404)

    def test_wait_returns_when_the_desktop_claims(self):
        qid = self.post()
        bg = self.bg_get(f"/api/os/inbox/{qid}?wait=10&after=0")
        until(lambda: self.waiters() == 1, what="the long-poll")
        time.sleep(0.3)
        self.assertTrue(bg.is_alive())  # still pending: it waits
        t = time.monotonic()
        self.claim(qid)
        s, g = bg.result()
        self.assertEqual((s, g["status"]), (200, "running"))
        self.assertLess(bg.done_at - t, 0.5)
        self.assertEqual(self.waiters(), 0)

    def test_wait_returns_on_each_streamed_delta(self):
        qid = self.post()
        token = self.claim(qid)
        bg = self.bg_get(f"/api/os/inbox/{qid}?wait=10&after=0")
        until(lambda: self.waiters() == 1, what="the long-poll")
        t = time.monotonic()
        self.assertEqual(self.delta(qid, token, 1, "Hello there. ")[0], 200)
        s, g = bg.result()
        self.assertEqual((g["status"], g["partial"], g["partialSeq"]), ("running", "Hello there. ", 1))
        self.assertLess(bg.done_at - t, 0.5)
        bg = self.bg_get(f"/api/os/inbox/{qid}?wait=10&after=1")
        until(lambda: self.waiters() == 1, what="the second long-poll")
        self.assertEqual(self.delta(qid, token, 2, "How are you?")[0], 200)
        s, g = bg.result()
        self.assertEqual((g["partial"], g["partialSeq"]), ("Hello there. How are you?", 2))

    def test_wait_returns_on_the_result(self):
        qid = self.post()
        token = self.claim(qid)
        bg = self.bg_get(f"/api/os/inbox/{qid}?wait=10&after=0")
        until(lambda: self.waiters() == 1, what="the long-poll")
        t = time.monotonic()
        self.api("POST", f"/api/os/inbox/{qid}/result", {"ok": True, "result": {"answer": "done"}, "claim_token": token})
        s, g = bg.result()
        self.assertEqual((g["status"], g["result"]["result"]["answer"]), ("done", "done"))
        self.assertLess(bg.done_at - t, 0.5)

    def test_wait_times_out_unchanged(self):
        qid = self.post()
        t0 = time.monotonic()
        s, g = self.api("GET", f"/api/os/inbox/{qid}?wait=1&after=0")
        took = time.monotonic() - t0
        self.assertEqual((s, g["status"], g["partialSeq"]), (200, "pending", 0))
        self.assertGreaterEqual(took, 0.9)
        self.assertLess(took, 3.0)

    def test_wait_answers_at_once_when_there_is_nothing_to_wait_for(self):
        done = self.post()
        self.api("POST", f"/api/os/inbox/{done}/result", {"ok": True, "result": {"answer": "x"}})
        cancelled = self.post()
        self.api("POST", f"/api/os/inbox/{cancelled}/cancel")
        ahead = self.post()
        token = self.claim(ahead)
        self.delta(ahead, token, 1, "a")
        self.delta(ahead, token, 2, "b")
        pending = self.post()
        for path in (
            f"/api/os/inbox/{done}?wait=10&after=0",  # finished
            f"/api/os/inbox/{cancelled}?wait=10&after=0",
            f"/api/os/inbox/{ahead}?wait=10&after=1",  # partialSeq 2 > 1
            f"/api/os/inbox/{pending}?wait=10",  # after defaults to -1: partialSeq 0 > -1
            f"/api/os/inbox/{pending}?wait=-5&after=0",  # clamped to 0
        ):
            t0 = time.monotonic()
            s, g = self.api("GET", path)
            self.assertEqual(s, 200, (path, g))
            self.assertLess(time.monotonic() - t0, 1.0, path)

    def test_wait_clamp(self):
        self.assertEqual(os_api._wait_secs(-1), 0.0)
        self.assertEqual(os_api._wait_secs(math.nan), 0.0)
        self.assertEqual(os_api._wait_secs(0), 0.0)
        self.assertEqual(os_api._wait_secs(3.5), 3.5)
        self.assertEqual(os_api._wait_secs(100), os_api.WAIT_MAX_SECS)
        self.assertEqual(os_api.WAIT_MAX_SECS, 25.0)

    def test_wait_sees_the_item_expire(self):
        qid = self.post()
        self.iso.sql("UPDATE os_queue SET created=? WHERE id=?", (time.time() - os_api.QUEUE_TTL["turn"] + 0.5, qid))
        t0 = time.monotonic()
        s, g = self.api("GET", f"/api/os/inbox/{qid}?wait=8&after=0")
        self.assertEqual((s, g["status"]), (200, "expired"))
        self.assertLess(time.monotonic() - t0, 2.5)

    def test_a_change_behind_the_gateways_back_is_seen_within_a_tick(self):
        # Nothing notifies the waiter here: only the periodic re-check (<= 250 ms) can see it.
        qid = self.post()
        bg = self.bg_get(f"/api/os/inbox/{qid}?wait=10&after=0")
        until(lambda: self.waiters() == 1, what="the long-poll")
        t = time.monotonic()
        self.iso.sql("UPDATE os_queue SET status='done', result=? WHERE id=?", (json.dumps({"ok": True}), qid))
        s, g = bg.result()
        self.assertEqual(g["status"], "done")
        self.assertLess(bg.done_at - t, 0.75)

    def test_a_gateway_change_wakes_the_waiter_without_the_tick(self):
        saved = os_api._WAIT_TICK_SECS
        os_api._WAIT_TICK_SECS = 30.0  # only the wake-up can end this wait early
        try:
            qid = self.post()
            bg = self.bg_get(f"/api/os/inbox/{qid}?wait=10&after=0")
            until(lambda: self.waiters() == 1, what="the long-poll")
            time.sleep(0.2)  # past its first check: now asleep on the wake-up event
            t = time.monotonic()
            self.claim(qid)
            s, g = bg.result()
            self.assertEqual(g["status"], "running")
            self.assertLess(bg.done_at - t, 0.5)
        finally:
            os_api._WAIT_TICK_SECS = saved

    def test_desktop_state_is_computed_when_it_answers(self):
        qid = self.post()
        self.assertEqual(os_api._DESKTOP_SEEN["at"], 0.0)
        bg = self.bg_get(f"/api/os/inbox/{qid}?wait=1.5&after=0")
        until(lambda: self.waiters() == 1, what="the long-poll")
        time.sleep(0.3)
        polled = time.time()
        self.pending_ids()  # the desktop polls while the phone waits
        s, g = bg.result()
        self.assertEqual(g["status"], "pending")  # listing doesn't claim
        self.assertGreaterEqual(g["desktopSeenAt"], polled - 0.1)


class DeltaTests(QueueCase):
    """G3: POST /api/os/inbox/{id}/delta {claim_token, seq, text}."""

    def test_deltas_append_in_order_and_retries_are_noops(self):
        qid = self.post()
        token = self.claim(qid)
        s, d = self.delta(qid, token, 1, "Hello there. ")
        self.assertEqual((s, d["ok"], d["partialSeq"]), (200, True, 1), d)
        s, d = self.delta(qid, token, 1, "Hello there. ")  # a retry of a delta that landed
        self.assertEqual((s, d["partialSeq"], d.get("duplicate")), (200, 1, True), d)
        s, d = self.delta(qid, token, 2, "How are you?")
        self.assertEqual((s, d["partialSeq"]), (200, 2), d)
        self.assertEqual(self.delta(qid, token, 1, "again")[0], 200)
        s, g = self.api("GET", f"/api/os/inbox/{qid}")
        self.assertEqual((g["partial"], g["partialSeq"]), ("Hello there. How are you?", 2))
        rows = self.iso.sql("SELECT partial, partial_seq FROM os_queue WHERE id=?", (qid,))
        self.assertEqual(rows, [{"partial": "Hello there. How are you?", "partial_seq": 2}])  # persisted

    def test_a_gap_is_409_and_changes_nothing(self):
        qid = self.post()
        token = self.claim(qid)
        self.delta(qid, token, 1, "One. ")
        s, d = self.delta(qid, token, 3, "Three.")
        self.assertEqual(s, 409, d)
        s, g = self.api("GET", f"/api/os/inbox/{qid}")
        self.assertEqual((g["partial"], g["partialSeq"]), ("One. ", 1))
        self.assertEqual(self.delta(qid, token, 2, "Two. ")[0], 200)

    def test_only_the_current_claim_of_a_running_item_streams(self):
        pending = self.post()
        self.assertEqual(self.delta(pending, "whatever", 1, "x")[0], 409)  # never claimed
        self.assertEqual(self.api("POST", "/api/os/inbox/nope/delta", {"claim_token": "t", "seq": 1, "text": "x"})[0], 404)
        qid = self.post()
        token = self.claim(qid)
        self.assertEqual(self.delta(qid, "wrong", 1, "x")[0], 409)
        self.assertEqual(self.api("POST", f"/api/os/inbox/{qid}/delta", {"seq": 1, "text": "x"})[0], 409)  # no token
        self.assertEqual(self.delta(qid, token, 1, "ok ")[0], 200)
        self.api("POST", f"/api/os/inbox/{qid}/result", {"ok": True, "result": {"answer": "ok"}, "claim_token": token})
        self.assertEqual(self.delta(qid, token, 2, "late")[0], 409)  # done
        cancelled = self.post()
        self.api("POST", f"/api/os/inbox/{cancelled}/cancel")
        self.assertEqual(self.delta(cancelled, token, 1, "x")[0], 409)
        s, g = self.api("GET", f"/api/os/inbox/{qid}")
        self.assertEqual((g["status"], g["partial"], g["partialSeq"]), ("done", "ok ", 1))  # kept after the result
        self.assertEqual(g["result"]["result"]["answer"], "ok")
        self.assertEqual(self.iso.sql("SELECT partial_seq FROM os_queue WHERE id=?", (pending,))[0]["partial_seq"], None)

    def test_malformed_deltas_are_400(self):
        qid = self.post()
        token = self.claim(qid)
        for body in (
            {"claim_token": token, "seq": 0, "text": "x"},
            {"claim_token": token, "seq": "1", "text": "x"},
            {"claim_token": token, "seq": True, "text": "x"},
            {"claim_token": token, "seq": 1.5, "text": "x"},
            {"claim_token": token, "text": "x"},
            {"claim_token": token, "seq": 1, "text": 5},
        ):
            s, d = self.api("POST", f"/api/os/inbox/{qid}/delta", body)
            self.assertEqual(s, 400, (body, d))
        self.assertEqual(self.api("GET", f"/api/os/inbox/{qid}")[1]["partialSeq"], 0)

    def test_partial_is_capped_without_gaps(self):
        cap = os_api.PARTIAL_MAX_BYTES
        self.assertEqual(cap, 64 * 1024)
        qid = self.post()
        token = self.claim(qid)
        s, d = self.delta(qid, token, 1, "a" * (cap - 11))
        self.assertEqual((s, d.get("truncated")), (200, None), d)
        # 20 bytes into 11 bytes of room: 5 whole "é" fit, the 6th is cut, the rest dropped.
        s, d = self.delta(qid, token, 2, "é" * 10)
        self.assertEqual((s, d["partialSeq"], d.get("truncated")), (200, 2, True), d)
        # 1 byte of room left would fit "b", but nothing may follow a cut (no gap in the text).
        s, d = self.delta(qid, token, 3, "b")
        self.assertEqual((s, d["partialSeq"], d.get("truncated")), (200, 3, True), d)
        self.assertEqual(self.delta(qid, token, 4, "more")[0], 200)  # the seq keeps counting
        s, g = self.api("GET", f"/api/os/inbox/{qid}")
        self.assertEqual(g["partialSeq"], 4)
        self.assertEqual(g["partial"], "a" * (cap - 11) + "é" * 5)
        self.assertLessEqual(len(g["partial"].encode("utf-8")), cap)

    def test_a_lone_surrogate_is_stored_not_a_500(self):
        qid = self.post()
        token = self.claim(qid)
        s, d = self.delta(qid, token, 1, "ok \ud800 ok")
        self.assertEqual(s, 200, d)
        self.assertEqual(self.api("GET", f"/api/os/inbox/{qid}")[1]["partial"], "ok ? ok")

    def test_a_delta_refreshes_desktop_seen(self):
        qid = self.post()
        token = self.claim(qid)
        os_api._DESKTOP_SEEN["at"] = 0.0
        self.assertEqual(self.delta(qid, token, 1, "x")[0], 200)
        self.assertAlmostEqual(os_api._DESKTOP_SEEN["at"], time.time(), delta=5)

    def test_a_renewed_claim_keeps_streaming(self):
        qid = self.post()
        token = self.claim(qid)
        self.delta(qid, token, 1, "a")
        self.assertEqual(self.claim(qid, token=token), token)
        self.assertEqual(self.delta(qid, token, 2, "b")[0], 200)
        self.assertEqual(self.api("GET", f"/api/os/inbox/{qid}")[1]["partial"], "ab")

    def test_a_later_claim_never_splices_into_an_earlier_stream(self):
        qid = self.post()
        first = self.claim(qid, lease_secs=60)
        self.delta(qid, first, 1, "First try. ")
        self.iso.sql("UPDATE os_queue SET lease_until=? WHERE id=?", (time.time() - 1, qid))
        second = self.claim(qid)
        self.assertNotEqual(first, second)
        self.assertEqual(self.delta(qid, first, 2, "stale")[0], 409)  # superseded
        self.assertEqual(self.delta(qid, second, 1, "Second try. ")[0], 409)
        self.assertEqual(self.delta(qid, second, 2, "Second try. ")[0], 409)
        s, g = self.api("GET", f"/api/os/inbox/{qid}")
        self.assertEqual((g["partial"], g["partialSeq"]), ("First try. ", 1))
        s, d = self.api("POST", f"/api/os/inbox/{qid}/result", {"ok": True, "result": {"answer": "Second try."}, "claim_token": second})
        self.assertEqual(s, 200, d)
        # An earlier claim that never streamed leaves the stream to the next one.
        other = self.post()
        early = self.claim(other, lease_secs=60)
        self.iso.sql("UPDATE os_queue SET lease_until=? WHERE id=?", (time.time() - 1, other))
        late = self.claim(other)
        self.assertNotEqual(early, late)
        self.assertEqual(self.delta(other, late, 1, "Fresh. ")[0], 200)

    def test_listing_and_item_views_never_leak_tokens_or_ship_partials_to_the_desktop(self):
        qid = self.post()
        token = self.claim(qid, lease_secs=60)
        self.delta(qid, token, 1, "streamed")
        self.iso.sql("UPDATE os_queue SET lease_until=? WHERE id=?", (time.time() - 1, qid))  # re-offered
        s, d = self.api("GET", "/api/os/inbox")
        listed = [i for i in d["items"] if i["id"] == qid]
        self.assertEqual(len(listed), 1)
        for k in ("claim_token", "partial_token", "partial", "partial_seq", "partialSeq"):
            self.assertNotIn(k, listed[0])
        s, g = self.api("GET", f"/api/os/inbox/{qid}")
        self.assertNotIn(token, json.dumps(g))


class ListLongPollTests(QueueCase):
    """G4: GET /api/os/inbox?wait=W for the desktop."""

    def test_wait_returns_when_an_item_arrives(self):
        bg = self.bg_get("/api/os/inbox?wait=10")
        until(lambda: os_api._desktop_list_waits == 1, what="the desktop's long-poll")
        time.sleep(0.3)
        self.assertTrue(bg.is_alive())
        t = time.monotonic()
        qid = self.post()
        s, d = bg.result()
        self.assertEqual(s, 200, d)
        self.assertEqual([i["id"] for i in d["items"]], [qid])
        self.assertLess(bg.done_at - t, 0.5)
        self.assertGreater(d["waited"], 0.2)
        self.assertLess(d["waited"], 5)
        self.assertEqual(os_api._desktop_list_waits, 0)

    def test_wait_times_out_with_waited_and_refreshes_seen(self):
        t0, wall = time.monotonic(), time.time()
        s, d = self.api("GET", "/api/os/inbox?wait=1")
        took = time.monotonic() - t0
        self.assertEqual((s, d["items"]), (200, []))
        self.assertIsInstance(d["waited"], float)
        self.assertGreaterEqual(d["waited"], 0.9)
        self.assertLess(took, 3.0)
        self.assertGreaterEqual(os_api._DESKTOP_SEEN["at"], wall + 0.9)  # connected until it answered

    def test_no_wait_or_items_already_listed_answer_at_once(self):
        s, d = self.api("GET", "/api/os/inbox")
        self.assertEqual((d["items"], d["waited"]), ([], 0.0))
        qid = self.post()
        t0 = time.monotonic()
        s, d = self.api("GET", "/api/os/inbox?wait=10")
        self.assertLess(time.monotonic() - t0, 1.0)
        self.assertEqual(([i["id"] for i in d["items"]], d["waited"]), ([qid], 0.0))

    def test_an_open_wait_counts_the_desktop_as_seen_now(self):
        running = self.post()
        self.claim(running)  # running under a live lease: not listable, so the list waits
        os_api._DESKTOP_SEEN["at"] = 0.0
        started = time.time()
        bg = self.bg_get("/api/os/inbox?wait=5")
        until(lambda: os_api._desktop_list_waits == 1, what="the desktop's long-poll")
        time.sleep(1.0)
        before = time.time()
        s, g = self.api("GET", f"/api/os/inbox/{running}")
        self.assertGreaterEqual(g["desktopSeenAt"], before - 0.05)
        self.assertGreater(g["desktopSeenAt"], started + 0.9)  # not when the wait began
        before = time.time()
        s, d = self.api("POST", "/api/os/inbox", {"kind": "turn", "payload": {"text": "hi"}})
        self.assertGreaterEqual(d["desktopSeenAt"], before - 0.05)
        s, listed = bg.result()
        self.assertEqual([i["id"] for i in listed["items"]], [d["id"]])
        self.assertEqual(os_api._desktop_list_waits, 0)
        later = time.time() + 100
        self.assertLess(os_api._desktop_seen_at(later), later)  # no wait open: the stored time again

    def test_a_desktop_that_hangs_up_ends_its_wait(self):
        sock = socket.create_connection(("127.0.0.1", self.h.port), timeout=5)
        try:
            sock.sendall(b"GET /api/os/inbox?wait=15 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            until(lambda: os_api._desktop_list_waits == 1, what="the desktop's long-poll")
        finally:
            sock.close()
        t = time.monotonic()
        until(lambda: os_api._desktop_list_waits == 0 and self.waiters() == 0, timeout=3, what="the wait to end")
        self.assertLess(time.monotonic() - t, 2.0)

    def test_wait_picks_up_a_lapsed_lease(self):
        qid = self.post()
        self.claim(qid, lease_secs=1)
        self.assertEqual(self.pending_ids(), [])
        t0 = time.monotonic()
        s, d = self.api("GET", "/api/os/inbox?wait=6")
        self.assertEqual([i["id"] for i in d["items"]], [qid])
        self.assertLess(time.monotonic() - t0, 2.5)

    def test_an_item_past_its_ttl_does_not_end_the_wait(self):
        qid = self.post()
        self.iso.sql("UPDATE os_queue SET created=? WHERE id=?", (time.time() - 700, qid))
        s, d = self.api("GET", "/api/os/inbox?wait=1")
        self.assertEqual(d["items"], [])
        self.assertGreaterEqual(d["waited"], 0.9)
        self.assertEqual(self.api("GET", f"/api/os/inbox/{qid}")[1]["status"], "expired")


class LongPollConcurrencyTests(QueueCase):
    """G5: waiting requests never block the event loop, starve the threadpool or hold the lock."""

    def test_many_waiters_leave_the_gateway_responsive(self):
        qid = self.post()
        n = 45  # more than anyio's 40 worker threads
        bgs = [self.bg_get(f"/api/os/inbox/{qid}?wait=4&after=0") for _ in range(n)]
        try:
            # Setup, not the property: 45 threads connecting can take a while on a loaded machine.
            # The property is the < 1.0 s answers below while they're all parked.
            until(lambda: self.waiters() == n, timeout=30, what=f"{n} long-polls")
            for method, path, body in (
                ("POST", "/api/os/inbox", {"kind": "turn", "payload": {"text": "x"}}),  # sync route
                ("GET", f"/api/os/inbox/{qid}", None),
                ("GET", "/api/os/inbox", None),
                ("GET", "/api/status", None),
            ):
                t0 = time.monotonic()
                s, _ = self.api(method, path, body)
                self.assertEqual(s, 200, path)
                self.assertLess(time.monotonic() - t0, 1.0, path)
        finally:
            for b in bgs:
                self.assertEqual(b.result()[0], 200)

    def test_a_wait_never_holds_the_db_lock(self):
        bg = self.bg_get("/api/os/inbox?wait=2")
        until(lambda: os_api._desktop_list_waits == 1, what="the desktop's long-poll")
        for _ in range(5):
            self.assertTrue(cc._db_lock.acquire(timeout=0.5))
            cc._db_lock.release()
            time.sleep(0.1)
        self.assertEqual(bg.result()[1]["items"], [])


class GatewayShutdownTests(QueueCase):
    """A clean gateway stop doesn't sit out the open long-polls (up to WAIT_MAX_SECS each): both
    uvicorn servers in server.py's main block cap the graceful shutdown at GRACEFUL_SHUTDOWN_SECS."""

    def test_both_servers_in_main_cap_the_graceful_shutdown(self):
        tree = ast.parse(Path(server.__file__).read_text(encoding="utf-8"))
        configs = [
            n for n in ast.walk(tree)
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "Config"
            and isinstance(n.func.value, ast.Name) and n.func.value.id == "uvicorn"
        ]
        self.assertEqual(len(configs), 2, "server.py runs the HTTP gateway and the HTTPS listener")
        for call in configs:
            kw = {k.arg: k.value for k in call.keywords}
            self.assertIn("timeout_graceful_shutdown", kw, f"uvicorn.Config on line {call.lineno}")
            v = kw["timeout_graceful_shutdown"]
            self.assertTrue(isinstance(v, ast.Name) and v.id == "GRACEFUL_SHUTDOWN_SECS", f"line {call.lineno}")
        self.assertGreater(server.GRACEFUL_SHUTDOWN_SECS, 0)
        self.assertLessEqual(server.GRACEFUL_SHUTDOWN_SECS, os_api.WAIT_MAX_SECS / 5)

    def test_a_stop_cuts_an_open_long_poll_after_the_cap(self):
        import uvicorn

        port = get_free_port()
        srv = uvicorn.Server(uvicorn.Config(server.app, host="127.0.0.1", port=port, lifespan="off", log_level="warning",
                                            timeout_graceful_shutdown=server.GRACEFUL_SHUTDOWN_SECS))
        t = threading.Thread(target=srv.run, daemon=True)
        t.start()
        until(lambda: srv.started, timeout=10, what="the second server")
        sock = socket.create_connection(("127.0.0.1", port), timeout=30)
        try:
            sock.sendall(b"GET /api/os/inbox?wait=20 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            until(lambda: os_api._desktop_list_waits == 1, what="the desktop's long-poll")
            with self.assertLogs("uvicorn.error", level="ERROR") as logs:
                t0 = time.monotonic()
                srv.should_exit = True
                t.join(timeout=25)
                took = time.monotonic() - t0
        finally:
            sock.close()
        self.assertFalse(t.is_alive(), "the server never stopped")
        self.assertGreaterEqual(took, server.GRACEFUL_SHUTDOWN_SECS - 0.5)  # it did wait first
        self.assertLess(took, server.GRACEFUL_SHUTDOWN_SECS + 3)  # not the long-poll's 20 s
        self.assertTrue(any("graceful shutdown" in m for m in logs.output), logs.output)
        self.assertEqual(os_api._desktop_list_waits, 0)  # the cut wait cleaned up after itself
        self.assertEqual(self.waiters(), 0)


class RestartGraceContractTests(unittest.TestCase):
    """The restart grace is sized from two client constants; changing either must revisit it."""

    def test_grace_matches_the_phone_window_and_covers_the_desktop_retry(self):
        cc_src = Path(os_api.__file__).resolve().parent / "command center"
        ts = cc_src / "src" / "features" / "dispatcher" / "dispatch.ts"
        rs = cc_src / "src-tauri" / "src" / "commands" / "pipeline.rs"
        if not (ts.is_file() and rs.is_file()):
            self.skipTest("Command Center sources not present")
        src = ts.read_text(encoding="utf-8")
        # desktopAlive compares against a named constant now (DESKTOP_ALIVE_SECS); older builds used a literal.
        m = re.search(r"export const DESKTOP_ALIVE_SECS\s*=\s*(\d+)", src) or re.search(r"desktopSeenAt\s*<\s*(\d+)", src)
        self.assertIsNotNone(m, "dispatch.ts desktopAlive changed: re-check os_api's restart grace")
        self.assertEqual(int(m.group(1)), PHONE_ALIVE_SECS)
        if "DESKTOP_ALIVE_SECS" in src:
            self.assertIsNotNone(re.search(r"desktopSeenAt\s*<\s*DESKTOP_ALIVE_SECS", src), "desktopAlive no longer uses DESKTOP_ALIVE_SECS")
        self.assertEqual(os_api._PHONE_ALIVE_WINDOW_SECS, PHONE_ALIVE_SECS)
        m = re.search(r"INBOX_DOWN:\s*Duration\s*=\s*Duration::from_secs\((\d+)\)", rs.read_text(encoding="utf-8"))
        self.assertIsNotNone(m, "pipeline.rs INBOX_DOWN changed: re-check os_api's restart grace")
        self.assertEqual(int(m.group(1)), DESKTOP_DOWN_RETRY_SECS)
        self.assertGreater(os_api.DESKTOP_RESTART_GRACE_SECS, LATEST_FIRST_POLL_SECS)


class LegacyTableMigrationTests(unittest.TestCase):
    """An os_queue created by the previous gateway gains the claim columns, rows intact."""

    def test_old_table_gains_columns(self):
        with IsolatedCC() as iso:
            with cc._db_lock, cc.db() as c:
                c.execute("DROP TABLE os_queue")
                c.execute("CREATE TABLE os_queue(id TEXT PRIMARY KEY, kind TEXT, payload TEXT, status TEXT, result TEXT, created REAL, updated REAL)")
                c.execute("INSERT INTO os_queue VALUES('a','turn','{}','pending',NULL,?,?)", (time.time(), time.time()))
            os_api._schema_ready.discard(str(cc.DB_PATH))
            os_api._ensure_schema()
            rows = iso.sql("SELECT * FROM os_queue")
            self.assertEqual(len(rows), 1)
            for col in ("claim_token", "partial", "partial_seq", "partial_token"):
                self.assertIn(col, rows[0])
            # An old row (NULL partial columns) reads as "nothing streamed yet".
            with cc._db_lock, cc.db() as c:
                r = c.execute("SELECT * FROM os_queue WHERE id='a'").fetchone()
            view = os_api._queue_row(r, with_result=True)
            self.assertEqual((view["partial"], view["partialSeq"]), ("", 0))


class ModelLibraryPathTests(unittest.TestCase):
    """Bionic's models folder moved to C: (2026-11-25); the D: model dirs are still scanned."""

    def test_bionic_library_is_on_c_and_the_d_dirs_are_still_scanned(self):
        self.assertEqual(os_api.LMSTUDIO_DIR, Path(r"C:\Users\nicho\.lmstudio\models"))
        self.assertTrue(os_api.MODEL_DIRS and all(d.upper().startswith("D:\\") for d in os_api.MODEL_DIRS), os_api.MODEL_DIRS)
    def test_the_gateway_sources_compile_without_escape_warnings(self):
        # An invalid escape like "D:\ model dirs" in a plain docstring warns at every compile.
        import warnings
        root = Path(os_api.__file__).resolve().parent
        for name in ("os_api.py", "gateway_tony.py", "command_center_api.py"):
            src = (root / name).read_text(encoding="utf-8")
            with warnings.catch_warnings():
                warnings.simplefilter("error")
                compile(src, name, "exec")  # SyntaxError for a warning turned error


if __name__ == "__main__":
    unittest.main(verbosity=2)
