"""Phone → desktop queue (os_api inbox): claim/lease, running state, per-kind TTL with an
explicit `expired` status, kind `task` validation and old-desktop compatibility.

Every test runs against a temp cc.db (command_center_api paths are redirected), never the
real data/command-center store.

Run with: python3 tests/run_all.py  (or: python3 tests/test_os_inbox.py)
"""
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import Harness  # noqa: E402

import command_center_api as cc  # noqa: E402
import os_api  # noqa: E402


class IsolatedCC:
    """Point command_center_api's store (cc.db, config.json, files) at a temp dir."""

    _NAMES = ("CC_DIR", "FILES_DIR", "DB_PATH", "CONFIG_PATH")

    def __init__(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="agentic-os-cc-"))
        self._saved = {}

    def __enter__(self):
        self._saved = {n: getattr(cc, n) for n in self._NAMES}
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

    def api(self, method, path, body=None):
        return self.h.api(method, path, body)


class InboxTests(GatewayCase):
    def setUp(self):
        self.iso.sql("DELETE FROM os_queue")

    def post(self, kind="turn", payload=None):
        s, d = self.api("POST", "/api/os/inbox", {"kind": kind, "payload": payload if payload is not None else {"text": "hi", "noDelegate": True}})
        self.assertEqual(s, 200, d)
        return d["id"]

    def pending_ids(self):
        s, d = self.api("GET", "/api/os/inbox")
        self.assertEqual(s, 200, d)
        return [i["id"] for i in d["items"]]

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
        os_api._DESKTOP_SEEN["at"] = 0.0
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
        self.assertFalse(g["desktopBusy"])

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
        self.assertTrue({"claimed_at", "lease_until", "claim_token"} <= cols)
        os_api._schema_ready.discard(str(cc.DB_PATH))
        os_api._ensure_schema()  # second run: no duplicate-column error
        tables = {r["name"] for r in self.iso.sql("SELECT name FROM sqlite_master WHERE type='table'")}
        self.assertIn("task_mirror", tables)


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
            self.assertIn("claim_token", rows[0])


if __name__ == "__main__":
    unittest.main(verbosity=2)
