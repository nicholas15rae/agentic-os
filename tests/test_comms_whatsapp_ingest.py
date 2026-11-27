"""PC WhatsApp ingester (comms_whatsapp_ingest.py, Comms step 5).

A fixture messages.db with the lharries bridge's exact schema (whatsapp-bridge/main.go) is read
and posted through the real gateway routes (os_api.comms_router on a temp cc.db):
- new rows land as WhatsApp threads keyed on the JID; rowid watermark + seen-set (a REPLACEd row
  with a new rowid isn't posted again; a lost state file is absorbed by the gateway's id dedupe);
- timestamps are parsed to epoch across both 2026 DST changes (string order != time order);
- no media key, URL, hash, length or file name reaches cc.db (vault included);
- whatsapp.db is never opened, and messages.db only read-only;
- a missing column disables ingest; a gateway failure keeps the watermark;
- a "from me" row matching a recent desktop send (as pipeline.rs records it) is skipped once;
- the gateway URL must be loopback; the state file holds no JID or text.

Run with: python -m pytest tests/test_comms_whatsapp_ingest.py -q -p no:cacheprovider
"""
import os
import sys
import tempfile

if "command_center_api" not in sys.modules:
    os.environ["CC_DATA_DIR"] = tempfile.mkdtemp(prefix="agentic-os-cc-import-")

import json  # noqa: E402
import socket  # noqa: E402
import sqlite3  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402
import unittest  # noqa: E402
from datetime import datetime, timedelta, timezone  # noqa: E402
from pathlib import Path  # noqa: E402
from unittest import mock  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from test_os_inbox import IsolatedCC  # noqa: E402

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import command_center_api as cc  # noqa: E402
import comms_whatsapp_ingest as wa  # noqa: E402
import os_api  # noqa: E402

os.environ.pop("CC_DATA_DIR", None)

# whatsapp-bridge/main.go NewMessageStore, verbatim.
BRIDGE_SCHEMA = """
CREATE TABLE IF NOT EXISTS chats (
    jid TEXT PRIMARY KEY,
    name TEXT,
    last_message_time TIMESTAMP
);
CREATE TABLE IF NOT EXISTS messages (
    id TEXT,
    chat_jid TEXT,
    sender TEXT,
    content TEXT,
    timestamp TIMESTAMP,
    is_from_me BOOLEAN,
    media_type TEXT,
    filename TEXT,
    url TEXT,
    media_key BLOB,
    file_sha256 BLOB,
    file_enc_sha256 BLOB,
    file_length INTEGER,
    PRIMARY KEY (id, chat_jid),
    FOREIGN KEY (chat_jid) REFERENCES chats(jid)
);
"""
SAM = "14165551234@s.whatsapp.net"
CREW = "120363000000000001@g.us"
LID = "98765432101234@lid"
EST, EDT = timezone(timedelta(hours=-5)), timezone(timedelta(hours=-4))


def go_ts(epoch, tz=EST):
    """A timestamp the way Go's sqlite driver stores it: '2026-11-26 14:05:00-05:00'."""
    return datetime.fromtimestamp(epoch, tz).isoformat(sep=" ")


class FixtureDB:
    def __init__(self, store: Path, schema: str = BRIDGE_SCHEMA):
        store.mkdir(parents=True, exist_ok=True)
        self.path = store / "messages.db"
        with sqlite3.connect(self.path) as c:
            c.executescript(schema)

    def chat(self, jid, name):
        with sqlite3.connect(self.path) as c:
            c.execute("INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)", (jid, name, go_ts(time.time())))

    def msg(self, mid, jid, content, ts, *, from_me=False, media_type="", filename="", url="", media_key=None, sha=None, enc_sha=None, length=0, sender="16475550000"):
        """main.go StoreMessage: INSERT OR REPLACE (a re-delivered message gets a new rowid)."""
        ts = ts if isinstance(ts, str) else go_ts(ts)
        with sqlite3.connect(self.path) as c:
            c.execute(
                "INSERT OR REPLACE INTO messages (id, chat_jid, sender, content, timestamp, is_from_me, media_type, filename, url, media_key, file_sha256, file_enc_sha256, file_length) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (mid, jid, sender, content, ts, from_me, media_type, filename, url, media_key, sha, enc_sha, length),
            )

    def rowid(self, mid, jid):
        with sqlite3.connect(self.path) as c:
            return c.execute("SELECT rowid FROM messages WHERE id=? AND chat_jid=?", (mid, jid)).fetchone()[0]


class FakeGateway:
    """comms_whatsapp_ingest.Gateway's interface over a TestClient (non-2xx -> GatewayError)."""

    def __init__(self, client):
        self.c = client
        self.posts = []
        self.fail_posts = False

    def post(self, path, body):
        if self.fail_posts:
            raise wa.GatewayError(f"POST {path} -> ConnectionRefusedError")
        self.posts.append((path, body))
        r = self.c.post(path, json=body)
        if r.status_code >= 300:
            raise wa.GatewayError(f"POST {path} -> HTTP {r.status_code}: {r.text}")
        return r.json()

    def get(self, path):
        r = self.c.get(path)
        if r.status_code >= 300:
            raise wa.GatewayError(f"GET {path} -> HTTP {r.status_code}")
        return r.json()


class IngestCase(unittest.TestCase):
    def setUp(self):
        self.iso = IsolatedCC().__enter__()
        self.addCleanup(self.iso.__exit__, None, None, None)
        b = mock.patch.object(os_api, "_broadcast")
        b.start()
        self.addCleanup(b.stop)
        app = FastAPI()
        app.include_router(os_api.comms_router)
        self.client = TestClient(app)
        self.gw = FakeGateway(self.client)
        self.tmp = Path(tempfile.mkdtemp(prefix="agentic-os-wa-"))
        self.store = self.tmp / "whatsapp-bridge" / "store"
        self.db = FixtureDB(self.store)
        self.state_path = self.tmp / "wa-ingest-state.json"
        self.now = time.time()

    def run_once(self, **kw):
        kw.setdefault("backfill_days", 3650)
        return wa.run_once(self.db.path, wa.State(self.state_path), self.gw, device="mortadella", **kw)

    def rows(self, where="1=1", args=()):
        return self.iso.sql(f"SELECT * FROM comms_messages WHERE {where} ORDER BY ts", args)

    def thread(self, key):
        r = self.client.get(f"/api/comms/threads/{key}/messages")
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["messages"]


class BasicIngestTests(IngestCase):
    def test_new_rows_land_as_whatsapp_threads_keyed_on_the_jid(self):
        self.db.chat(SAM, "Sam")
        self.db.chat(CREW, "Shoot crew")
        self.db.chat(LID, "Alex")
        self.db.msg("A1", SAM, "dinner friday?", self.now - 300)
        self.db.msg("A2", SAM, "yes, 7", self.now - 200, from_me=True)
        self.db.msg("G1", CREW, "call time is 9", self.now - 100)
        self.db.msg("L1", LID, "hey", self.now - 50)
        c = self.run_once()
        self.assertEqual((c["read"], c["posted"], c["added"], c["dup"], c["rejected"]), (4, 4, 4, 0, 0), c)
        sam = self.thread(SAM)
        self.assertEqual([(m["id"], m["direction"], m["body"], m["contact"], m["source"]) for m in sam], [
            (f"wa:{SAM}:A1", "in", "dinner friday?", "Sam", "wa-mcp"),
            (f"wa:{SAM}:A2", "out", "yes, 7", "Sam", "wa-mcp"),
        ])
        self.assertAlmostEqual(sam[0]["ts"], int(self.now - 300), delta=1)
        threads = {t["thread"]: t for t in self.client.get("/api/comms/threads", params={"channel": "whatsapp"}).json()["threads"]}
        self.assertEqual(set(threads), {SAM, CREW, LID})
        self.assertEqual((threads[SAM]["unread"], threads[SAM]["readOnly"], threads[SAM]["trusted"]), (1, False, False))
        crew = self.thread(CREW)[0]
        self.assertEqual((crew["contact"], crew["meta"]), ("Shoot crew", {"isGroup": True, "conversationTitle": "Shoot crew", "kind": "text"}))
        # The chat names are WhatsApp contacts keyed on the JID; no SMS contact is touched.
        self.assertEqual({r["address"]: r["name"] for r in self.iso.sql("SELECT address, name FROM comms_contacts")}, {SAM: "Sam", CREW: "Shoot crew", LID: "Alex"})
        src = self.client.get("/api/comms/sources").json()["sources"]
        self.assertEqual([(s["source"], s["device"], s["counts"]) for s in src], [("wa-mcp", "mortadella", {"whatsapp": 4})])

    def test_the_ingester_key_is_the_gateway_key(self):
        for jid in (SAM, CREW, LID, "14165551234@S.WHATSAPP.NET"):
            self.assertEqual(wa.wa_thread_key(jid), os_api._thread_key(jid, "whatsapp"))

    def test_a_second_pass_posts_only_new_rows(self):
        self.db.msg("A1", SAM, "one", self.now - 60)
        self.assertEqual(self.run_once()["posted"], 1)
        c = self.run_once()
        self.assertEqual((c["read"], c["posted"]), (0, 0))
        self.assertEqual(len(self.gw.posts), 1, "nothing to post means no call")
        self.db.msg("A2", SAM, "two", self.now - 30)
        c = self.run_once()
        self.assertEqual((c["read"], c["posted"], c["added"]), (1, 1, 1))
        self.assertEqual([m["body"] for m in self.thread(SAM)], ["one", "two"])

    def test_a_replaced_row_with_a_new_rowid_is_not_posted_again(self):
        self.db.msg("A1", SAM, "hi", self.now - 60)
        first = self.db.rowid("A1", SAM)
        self.run_once()
        self.db.msg("A1", SAM, "hi", self.now - 60)  # history sync re-delivers it: REPLACE = new rowid
        self.assertGreater(self.db.rowid("A1", SAM), first)
        c = self.run_once()
        self.assertEqual((c["read"], c["seen"], c["posted"]), (1, 1, 0))
        self.assertEqual(len(self.rows()), 1)

    def test_a_lost_state_file_is_absorbed_by_the_gateway_dedupe(self):
        for i in range(3):
            self.db.msg(f"A{i}", SAM, f"m{i}", self.now - 100 + i)
        self.run_once()
        self.state_path.unlink()
        c = self.run_once()
        self.assertEqual((c["posted"], c["added"], c["dup"]), (3, 0, 3))
        self.assertEqual(len(self.rows()), 3)

    def test_rowids_going_back_restart_the_scan(self):
        self.db.msg("A1", SAM, "old db", self.now - 60)
        self.run_once()
        st = json.loads(self.state_path.read_text(encoding="utf-8"))
        st["watermark"] = 9999  # e.g. a re-pair made a brand-new messages.db
        self.state_path.write_text(json.dumps(st), encoding="utf-8")
        self.db.msg("A2", SAM, "new db", self.now - 30)
        c = self.run_once()
        self.assertEqual((c["seen"], c["added"]), (1, 1), c)
        self.assertEqual(json.loads(self.state_path.read_text(encoding="utf-8"))["watermark"], self.db.rowid("A2", SAM))

    def test_first_run_skips_history_older_than_the_backfill(self):
        self.db.msg("OLD", SAM, "from august", self.now - 40 * 86400)
        self.db.msg("NEW", SAM, "from yesterday", self.now - 86400)
        c = self.run_once(backfill_days=30)
        self.assertEqual((c["old"], c["added"]), (1, 1))
        self.assertEqual([m["body"] for m in self.thread(SAM)], ["from yesterday"])
        # The limit only applies to the first pass: a late-arriving old message later is kept.
        self.db.msg("SYNC", SAM, "history sync after the first pass", self.now - 50 * 86400)
        self.assertEqual(self.run_once(backfill_days=30)["added"], 1)

    def test_broadcasts_empty_rows_and_bad_timestamps_are_skipped(self):
        self.db.msg("S1", "status@broadcast", "my status", self.now - 60)
        self.db.msg("N1", "1203630000@newsletter", "channel post", self.now - 60)
        self.db.msg("E1", SAM, "", self.now - 60)
        self.db.msg("T1", SAM, "no time", "0001-01-01 00:00:00+00:00")
        self.db.msg("T2", SAM, "junk time", "yesterday-ish")
        self.db.msg("OK", SAM, "fine", self.now - 60)
        c = self.run_once()
        self.assertEqual((c["read"], c["skipped"], c["added"]), (6, 5, 1))
        self.assertEqual([r["body"] for r in self.rows()], ["fine"])

    def test_dry_run_posts_nothing_and_saves_nothing(self):
        self.db.msg("A1", SAM, "hi", self.now - 60)
        c = self.run_once(dry_run=True)
        self.assertEqual((c["read"], c["posted"], c["added"]), (1, 1, 0))
        self.assertEqual(self.gw.posts, [])
        self.assertFalse(self.state_path.exists())
        self.assertEqual(self.rows(), [])


class TimestampTests(IngestCase):
    def test_parse_ts_formats(self):
        base = datetime(2026, 11, 26, 19, 5, 0, tzinfo=timezone.utc).timestamp()
        for s in ("2026-11-26 14:05:00-05:00", "2026-11-26T14:05:00-05:00", "2026-11-26 19:05:00Z", "2026-11-26 19:05:00+00:00",
                  "2026-11-26 19:05:00", "2026-11-26 14:05:00-0500", "2026-11-26 15:05:00-04", str(int(base)), int(base), int(base * 1000)):
            self.assertEqual(wa.parse_ts(s), base, repr(s))
        self.assertAlmostEqual(wa.parse_ts("2026-11-26 14:05:00.123456789-05:00"), base + 0.123456, places=5)
        self.assertAlmostEqual(wa.parse_ts(b"2026-11-26 14:05:00-05:00"), base)
        for bad in (None, True, "", "yesterday", "0001-01-01 00:00:00+00:00", "2026-13-01 00:00:00", "2026-11-26 14:05:00-25:00", 0, -5):
            self.assertIsNone(wa.parse_ts(bad), repr(bad))

    def test_fall_back_2026_11_01_string_order_is_not_time_order(self):
        # 01:30 EDT (05:30Z) happens BEFORE 01:15 EST (06:15Z), though it sorts after it as text.
        self.db.msg("D1", SAM, "before the change", "2026-11-01 01:30:00-04:00")
        self.run_once()
        self.db.msg("D2", SAM, "after the change", "2026-11-01 01:15:00-05:00")
        c = self.run_once()
        self.assertEqual(c["added"], 1, "a text-timestamp watermark would have skipped this row")
        msgs = self.thread(SAM)
        self.assertEqual([m["body"] for m in msgs], ["before the change", "after the change"])
        self.assertEqual([m["ts"] for m in msgs], [
            datetime(2026, 11, 1, 5, 30, tzinfo=timezone.utc).timestamp(),
            datetime(2026, 11, 1, 6, 15, tzinfo=timezone.utc).timestamp(),
        ])

    def test_spring_forward_2026_03_08_is_one_second(self):
        self.db.msg("S1", SAM, "01:59:59 EST", "2026-03-08 01:59:59-05:00")
        self.db.msg("S2", SAM, "03:00:00 EDT", "2026-03-08 03:00:00-04:00")
        self.run_once()
        a, b = (m["ts"] for m in self.thread(SAM))
        self.assertEqual(b - a, 1.0)


class PrivacyTests(IngestCase):
    SECRETS = ("https://mmg.whatsapp.net/v/t62/SECRETPATH", "SECRETKEY", "SECRETSHA", "SECRETENC", "IMG-SECRETNAME.jpg", "31337421")

    def test_no_media_key_url_hash_or_file_name_is_copied(self):
        self.db.chat(SAM, "Sam")
        self.db.msg("M1", SAM, "look at this", self.now - 60, media_type="image", filename="IMG-SECRETNAME.jpg",
                    url="https://mmg.whatsapp.net/v/t62/SECRETPATH", media_key=b"SECRETKEY", sha=b"SECRETSHA", enc_sha=b"SECRETENC", length=31337421)
        self.db.msg("M2", SAM, "", self.now - 50, media_type="audio", url="https://mmg.whatsapp.net/v/t62/SECRETPATH", media_key=b"SECRETKEY")
        self.run_once()
        self.assertEqual([(r["body"], json.loads(r["meta"])["kind"]) for r in self.rows()], [("[photo] look at this", "media"), ("[voice message]", "media")])
        # Nothing of the media fields anywhere in cc.db (vault text included), or in what was posted.
        with sqlite3.connect(self.iso.tmp / "cc.db") as c:
            dump = "\n".join(c.iterdump())
        posted = json.dumps(self.gw.posts)
        for s in self.SECRETS:
            self.assertNotIn(s, dump, s)
            self.assertNotIn(s, posted, s)
        self.assertIn("[photo] look at this", dump)  # the dump really covers the rows (and the vault)
        # And the SELECT never names those columns.
        for col in ("url", "media_key", "file_sha256", "file_enc_sha256", "file_length", "filename", "sender"):
            self.assertNotRegex(wa._SELECT, rf"\b{col}\b")

    def test_whatsapp_db_is_never_opened_and_messages_db_is_read_only(self):
        (self.store / "whatsapp.db").write_bytes(b"session keys live here")
        self.db.msg("A1", SAM, "hi", self.now - 60)
        real = sqlite3.connect
        opened = []

        def spy(target, *a, **kw):
            opened.append((str(target), kw.get("uri")))
            return real(target, *a, **kw)

        with mock.patch.object(wa.sqlite3, "connect", side_effect=spy):
            self.assertEqual(self.run_once()["added"], 1)
        self.assertNotIn("whatsapp.db", " ".join(t for t, _ in opened).lower())
        # (the gateway's own cc.db connections go through the same sqlite3 module)
        bridge = [(t, u) for t, u in opened if Path(t) != Path(cc.DB_PATH)]
        self.assertEqual(len(bridge), 1, bridge)
        target, uri = bridge[0]
        self.assertTrue(uri)
        self.assertTrue(target.startswith("file:") and target.endswith("/messages.db?mode=ro"), target)
        with self.assertRaises(ValueError):
            wa.open_messages_db(self.store / "whatsapp.db")
        with self.assertRaises(ValueError):
            wa.open_messages_db(self.store / "WhatsApp.DB")
        conn = wa.open_messages_db(self.db.path)
        try:
            with self.assertRaises(sqlite3.OperationalError):
                conn.execute("DELETE FROM messages")
        finally:
            conn.close()
        self.assertEqual((self.store / "whatsapp.db").read_bytes(), b"session keys live here")

    def test_the_state_file_holds_no_jid_and_no_text(self):
        self.db.chat(SAM, "Sam")
        self.db.msg("A1", SAM, "the secret plan", self.now - 60)
        self.run_once()
        raw = self.state_path.read_text(encoding="utf-8")
        for s in ("whatsapp.net", "14165551234", "secret plan", "Sam", "A1"):
            self.assertNotIn(s, raw)
        self.assertEqual(len(json.loads(raw)["seen"]), 1)

    def test_the_gateway_url_must_be_loopback(self):
        for bad in ("http://100.84.91.149:8080", "https://127.0.0.1:8443", "http://example.com", "ftp://127.0.0.1", "http://0.0.0.0:8080"):
            with self.assertRaises(ValueError, msg=bad):
                wa.Gateway(bad)
        for ok in ("http://127.0.0.1:8080", "http://localhost:8080/", "http://[::1]:8080"):
            wa.Gateway(ok)

    def test_a_gateway_error_names_no_thread(self):
        g = wa.Gateway("http://127.0.0.1:9")  # discard port: nothing listens
        with self.assertRaises(wa.GatewayError) as e:
            g.get(f"/api/comms/threads/{SAM}/messages?limit=200")
        self.assertNotIn("14165551234", str(e.exception))


class SafetyTests(IngestCase):
    def test_a_missing_column_disables_ingest(self):
        self.db = FixtureDB(self.tmp / "old" / "store", BRIDGE_SCHEMA.replace("is_from_me BOOLEAN,", ""))
        with sqlite3.connect(self.db.path) as c:
            c.execute("INSERT INTO messages (id, chat_jid, content, timestamp) VALUES ('A1', ?, 'hi', ?)", (SAM, go_ts(self.now)))
        with self.assertRaises(wa.SchemaError) as e:
            self.run_once()
        self.assertIn("messages.is_from_me", str(e.exception))
        self.assertEqual(self.gw.posts, [])
        self.assertFalse(self.state_path.exists())

    def test_a_gateway_failure_keeps_the_watermark(self):
        self.db.msg("A1", SAM, "hi", self.now - 60)
        self.gw.fail_posts = True
        with self.assertRaises(wa.GatewayError):
            self.run_once()
        self.assertFalse(self.state_path.exists())
        self.gw.fail_posts = False
        self.assertEqual(self.run_once()["added"], 1)

    def test_heartbeat_reports_the_ingester(self):
        wa.heartbeat(self.gw, "mortadella", db_ok=True, schema_ok=False)
        s = self.client.get("/api/comms/sources").json()["sources"][0]
        self.assertEqual((s["source"], s["perms"], s["appVersion"], s["stale"]), ("wa-mcp", {"messagesDb": True, "schemaOk": False}, "wa-ingest/1", False))


class DesktopEchoTests(IngestCase):
    def desktop_send(self, recipient, body):
        """Exactly what pipeline.rs comms_whatsapp_send records after a send (no source, no ts)."""
        r = self.client.post("/api/comms/sms", json={"address": recipient, "body": body, "direction": "out", "channel": "whatsapp"})
        self.assertEqual(r.status_code, 200, r.text)
        return self.rows("channel='whatsapp' AND direction='out' AND id NOT LIKE 'wa:%'")[-1]

    def test_a_from_me_copy_of_a_desktop_send_is_skipped_once(self):
        sent = self.desktop_send("+1 416 555 1234", "see you at 6")
        self.assertEqual(sent["thread"], SAM, "the desktop send keys on the JID")
        t = sent["ts"]
        self.db.msg("E1", SAM, "see you at 6", t + 3, from_me=True)        # the bridge's copy of that send
        self.db.msg("E2", SAM, "see you at 6", t + 10, from_me=True)       # typed again on the phone
        self.db.msg("E3", SAM, "see you at 6", t + 600, from_me=True)      # much later: not that send
        self.db.msg("E4", SAM, "running late", t + 5, from_me=True)        # other text
        self.db.msg("E5", SAM, "see you at 6", t + 4)                      # incoming, never an echo
        c = self.run_once()
        self.assertEqual((c["echo"], c["added"]), (1, 4), c)
        bodies = [(m["id"], m["body"]) for m in self.thread(SAM)]
        self.assertEqual(len(bodies), 5)
        self.assertIn((sent["id"], "see you at 6"), bodies)
        self.assertNotIn((f"wa:{SAM}:E1", "see you at 6"), bodies)
        # The matched desktop row is remembered: a re-delivered E1 is not posted next time either.
        self.db.msg("E1", SAM, "see you at 6", t + 3, from_me=True)
        c = self.run_once()
        self.assertEqual((c["seen"], c["posted"]), (1, 0))

    def test_one_desktop_send_absorbs_only_one_copy_even_across_passes(self):
        sent = self.desktop_send("14165551234", "ok")
        self.db.msg("E1", SAM, "ok", sent["ts"] + 2, from_me=True)
        self.assertEqual(self.run_once()["echo"], 1)
        self.db.msg("E2", SAM, "ok", sent["ts"] + 4, from_me=True)
        c = self.run_once()
        self.assertEqual((c["echo"], c["added"]), (0, 1))

    def test_an_echo_in_a_failed_batch_is_not_used_up(self):
        sent = self.desktop_send("14165551234", "ok")
        self.db.msg("E1", SAM, "ok", sent["ts"] + 2, from_me=True)
        self.db.msg("X1", SAM, "other", sent["ts"] + 3)
        self.gw.fail_posts = True
        with self.assertRaises(wa.GatewayError):
            self.run_once()
        self.gw.fail_posts = False
        c = self.run_once()
        self.assertEqual((c["echo"], c["added"]), (1, 1))


class CommandLineTests(IngestCase):
    """main() over real HTTP: the gateway router served by uvicorn on 127.0.0.1."""

    def test_once_over_http(self):
        import uvicorn

        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        app = FastAPI()
        app.include_router(os_api.comms_router)
        server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", lifespan="off"))
        th = threading.Thread(target=server.run, daemon=True)
        th.start()
        self.addCleanup(th.join, 5)
        self.addCleanup(setattr, server, "should_exit", True)
        deadline = time.time() + 10
        while not server.started and time.time() < deadline:
            time.sleep(0.05)
        self.assertTrue(server.started)
        self.db.chat(SAM, "Sam")
        self.db.msg("A1", SAM, "over http", self.now - 60)
        args = ["--once", "--db", str(self.db.path), "--state", str(self.state_path), "--gateway", f"http://127.0.0.1:{port}", "--device", "mortadella"]
        with mock.patch("sys.stdout") as out:
            self.assertEqual(wa.main(args + ["--dry-run"]), 0)
            self.assertEqual(self.rows(), [])
            self.assertEqual(wa.main(args), 0)
        printed = json.loads(out.write.call_args_list[-2][0][0])
        self.assertEqual(printed["added"], 1)
        self.assertEqual([r["body"] for r in self.rows()], ["over http"])
        # A refused database is an error exit, not a crash.
        self.assertEqual(wa.main(["--once", "--db", str(self.store / "whatsapp.db"), "--state", str(self.state_path), "--gateway", f"http://127.0.0.1:{port}"]), 1)


if __name__ == "__main__":
    unittest.main()
