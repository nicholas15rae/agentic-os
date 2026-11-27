"""Memory Scrolls (Phase 3, Part A): config, scrub, sources, archive, scroll schema/merge, distill,
LM Studio transport, knowledge graph, AnythingLLM sync, static confinement, end-to-end compaction.

Every test runs on temp roots with stub servers. The module guard checks that the real
C:\\ai-hub\\memory, the live D:\\ai-hub-memory root (never created by tests), both knowledge-graph
locations, the repo .env and the real archive/state dirs are untouched by the whole module.

Run with: python3 tests/run_all.py  (or: python3 tests/test_memory_scrolls.py)
"""

from __future__ import annotations

import datetime as dt
import gzip
import io
import json
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
sys.path.insert(0, str(REPO))
sys.path.insert(0, str(HERE))

from memory_scrolls import archive, cli, compact, config, distill, graph, keys, lmstudio, scrub, sources, state, sync  # noqa: E402
from memory_scrolls import scroll as sc  # noqa: E402
from memory_scrolls.allm import AllmReader, Conn, RequestTrace, ScrollWriter  # noqa: E402
from memory_scrolls.errors import ArchiveError, BookingRefused, ConfigError, Deferred, ScrollError  # noqa: E402
from memory_scrolls.fsutil import ProcessLock, is_reparse  # noqa: E402
from memory_scrolls.scroll_store import write_scroll  # noqa: E402
from memory_scrolls_stubs import StubAllm, StubGateway, StubLMStudio, auto_reply  # noqa: E402

PKG = REPO / "memory_scrolls"
SENTINEL_KEY = "ALLMsentinel-Key-0042-zzzz"
FAKE_SECRET = "sk-test-ABCDEFGHIJKLMNOP1234"
NOW = dt.datetime(2026, 11, 19, 9, 0, 0, tzinfo=dt.timezone(dt.timedelta(hours=-5)))
NOW_ISO = NOW.isoformat(timespec="seconds")

_GUARD: dict = {}


REAL_HUB_MEMORY = Path(r"C:\ai-hub\memory")
REAL_D_MEMORY = Path(r"D:\ai-hub-memory")


def _tree_snapshot(root: Path):
    """(exists, sorted (rel, size, mtime) of every file, sorted dirs) — never creates `root`."""
    if not root.exists():
        return (False, (), ())
    files, dirs = [], []
    for p in root.rglob("*"):
        try:
            st = p.stat()
        except OSError:
            continue
        (dirs if p.is_dir() else files).append(p.relative_to(root).as_posix() if p.is_dir() else (p.relative_to(root).as_posix(), st.st_size, st.st_mtime))
    return (True, tuple(sorted(files)), tuple(sorted(dirs)))


def _snapshot_real() -> dict:
    snap = {}
    hub = REAL_HUB_MEMORY
    if hub.is_dir():
        snap["hub"] = sorted((p.name, p.stat().st_size, p.stat().st_mtime) for p in hub.iterdir() if p.is_file())
        snap["hub_dirs"] = sorted(p.name for p in hub.iterdir() if p.is_dir())
    snap["hub_exists"] = hub.exists()
    # The live D: memory root (Nic's decision): tests must neither create it nor touch anything in it.
    snap["d_memory"] = _tree_snapshot(REAL_D_MEMORY)
    for kg in (Path(config.DEFAULT_KG_PATH), REAL_HUB_MEMORY / "knowledge-graph.json"):
        snap[f"kg:{kg}"] = (kg.exists(), kg.stat().st_mtime if kg.exists() else None)
    env = REPO / ".env"
    snap["env"] = env.stat().st_mtime if env.exists() else None
    for p in (REPO / "archive", REPO / "data" / "memory-scrolls", Path(config.D_ARCHIVE), REPO / "staging" / "memory-scrolls-preview"):
        snap[str(p)] = p.exists()
    return snap


def setUpModule():
    _GUARD["before"] = _snapshot_real()


def tearDownModule():
    after = _snapshot_real()
    assert after == _GUARD["before"], f"real memory locations changed: {_GUARD['before']} -> {after}"


class Sandbox:
    """Temp roots + an env that points every path at them."""

    def __init__(self, lm_url: str = "http://127.0.0.1:9/v1", gateway_url: str = "http://127.0.0.1:9", allm_url: str = "http://127.0.0.1:9", key: str | None = SENTINEL_KEY, os_json: dict | None = None):
        self.td = tempfile.TemporaryDirectory()
        self.root = Path(self.td.name)
        for d in ("repo", "scrolls", "kg", "archive", "state", "data/command-center", "staging", "notes/ideas", "appdata", "hub/master"):
            (self.root / d).mkdir(parents=True, exist_ok=True)
        (self.root / "os.json").write_text(json.dumps(os_json or {"anythingllm": {"workspaces": {"librarian": "librarian"}}}), encoding="utf-8")
        self.env = {
            "AOS_REPO_ROOT": str(self.root / "repo"),
            "MEMORY_SCROLLS_DIR": str(self.root / "scrolls"),
            "MEMORY_KG_PATH": str(self.root / "kg" / "knowledge-graph.json"),
            "MEMORY_ARCHIVE_DIR": str(self.root / "archive"),
            "MEMORY_STATE_DIR": str(self.root / "state"),
            "AOS_TASKS_DB": str(self.root / "tasks.db"),
            "CC_DATA_DIR": str(self.root / "data" / "command-center"),
            "AOS_STAGING_DIR": str(self.root / "staging"),
            "AOS_NOTES_DIR": str(self.root / "notes"),
            "AOS_OS_JSON": str(self.root / "os.json"),
            "AOS_PROVIDERS_JSON": str(self.root / "providers.json"),
            "AOS_LMSTUDIO_BASE": lm_url,
            "AOS_GATEWAY_BASE": gateway_url,
            "ANYTHINGLLM_BASE": allm_url,
            "AOS_NO_KEYCHAIN": "1",
            "APPDATA": str(self.root / "appdata"),
            "AOS_HUB_MASTER": str(self.root / "hub" / "master"),
        }
        if key:
            self.env["ANYTHINGLLM_API_KEY"] = key

    def paths(self, **flags):
        return config.resolve(flags, self.env, probes=config.DriveProbes(lambda r: False, lambda r: 0))

    def threads(self, threads: dict):
        (self.root / "data" / "command-center" / "os-threads.json").write_text(json.dumps({"threads": threads, "updatedAt": 1}), encoding="utf-8")

    def tree(self) -> list:
        out = []
        for p in sorted(self.root.rglob("*")):
            if p.is_file():
                out.append((p.relative_to(self.root).as_posix(), p.stat().st_size, p.read_bytes()))
        return out

    def cli(self, *argv, extra_env: dict | None = None):
        buf = io.StringIO()
        code = cli.main(list(argv), env={**self.env, **(extra_env or {})}, out=buf)
        lines = [json.loads(x) for x in buf.getvalue().splitlines() if x.strip()] if "--json" in argv else [json.loads(buf.getvalue())]
        return code, lines

    def close(self):
        self.td.cleanup()


def turn(at: int, who: str, text: str, tid: str | None = None) -> dict:
    return {"at": at, "id": tid or f"t{at}", "text": text, "thread": "general", "who": who}


def noisy_threads() -> dict:
    base = 1794939000000
    general = [
        turn(base + 1, "user", "hey tony"),
        turn(base + 2, "agent", "Hello!"),
        turn(base + 3, "agent", "retrying..."),
        turn(base + 4, "user", "Locked: Whisper STT runs on port 8178"),
        turn(base + 5, "agent", "Traceback (most recent call last):\n" + "\n".join(f'  File "x{i}.py", line {i}, in f' for i in range(60))),
        turn(base + 6, "user", f"my key is {FAKE_SECRET} do not store it"),
        turn(base + 7, "user", "Scrolls live under C:\\ai-hub\\memory\\scrolls"),
        turn(base + 8, "user", "LM Studio moved from 1234 to 1235"),
        turn(base + 9, "system", "system bookkeeping line"),
        turn(base + 10, "user", "thanks"),
    ]
    return {"general": general, "booking": [turn(base + 1, "user", "BOOKING-SECRET client list")]}


def make_tasks_db(path: Path):
    c = sqlite3.connect(path)
    c.executescript(
        """CREATE TABLE task_envelope (task_id TEXT PRIMARY KEY, created_at INTEGER, updated_at INTEGER, status TEXT,
           raw_intent TEXT, title TEXT, project_slug TEXT, prompt_spec TEXT, librarian_notes TEXT, voice_summaries TEXT);
           CREATE TABLE handoff_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, timestamp INTEGER, from_agent TEXT,
           to_agent TEXT, event_type TEXT, severity TEXT, short_summary TEXT, voice_summary TEXT);"""
    )
    c.execute("INSERT INTO task_envelope VALUES ('t-1', 1, 1794939000, 'review_ready', 'build a status card', 'Status card', 'status-card', '{\"summary\":\"card\"}', '', '{}')")
    c.execute("INSERT INTO task_envelope VALUES ('t-2', 1, 1794939000, 'coding', 'in flight', 'x', 'status-card', '', '', '{}')")
    c.execute("INSERT INTO handoff_log (task_id, timestamp, from_agent, to_agent, event_type, severity, short_summary) VALUES ('t-1', 1794939000, 'coder', 'staging', 'stage_done', 'info', 'Concept: status card shipped to staging')")
    c.commit()
    c.close()


def valid_reply(rel: str, bullets=("- Concept: memory scrolls are the only embedded layer",), facts=(), entities=()) -> dict:
    t = sc.target_info(rel)
    parts = [f"# {t.title}", ""]
    for i, h in enumerate(sc.headings_for(t)):
        parts += [f"## {h}", ""]
        if i == 0:
            parts += list(bullets) + [""]
    return {"target_scroll": rel, "updated_markdown": "\n".join(parts), "graph_entities_to_upsert": list(entities), "superseded_facts": list(facts)}


def section_reply(rel: str, sections: dict, facts=(), entities=()) -> dict:
    """A reply whose body has `sections[heading]` bullets under each template heading."""
    t = sc.target_info(rel)
    parts = [f"# {t.title}", ""]
    for h in sc.headings_for(t):
        parts += [f"## {h}", ""] + list(sections.get(h, [])) + ([""] if sections.get(h) else [])
    return {"target_scroll": rel, "updated_markdown": "\n".join(parts), "graph_entities_to_upsert": list(entities), "superseded_facts": list(facts)}


class FakeLLM:
    """Scripted distiller replies (dict -> JSON) with an optional finish_reason per call."""

    model = "qwen/qwen3.5-9b"
    mode = "live"

    def __init__(self, replies, finishes=()):
        self.replies = list(replies)
        self.finishes = list(finishes)
        self.calls: list = []
        self.last_finish = None

    def chat(self, messages):
        self.calls.append(messages)
        self.last_finish = self.finishes.pop(0) if self.finishes else "stop"
        r = self.replies.pop(0) if self.replies else ""
        return r(messages) if callable(r) else r if isinstance(r, str) else json.dumps(r)


def distill_once(llm, rel: str, old=None, text: str = "Concept: x", budget: dict | None = None, known=()):
    budget = budget if budget is not None else {"used": 0, "max": 4, "save": lambda: None}
    return compact.distill_target(llm, sc.target_info(rel), old, text, "arch-2026-11-19-01", NOW_ISO, list(known), {}, budget)


# ── 1. config ───────────────────────────────────────────────────────────────


class ConfigTests(unittest.TestCase):
    def probes(self, fixed=True, free=10 * 1024 ** 3):
        return config.DriveProbes(lambda r: fixed, lambda r: free)

    def test_archive_root_precedence(self):
        repo = Path(tempfile.gettempdir()) / "repo-x"
        cfg = {"memory": {"scrolls": {"archiveDir": r"C:\from-osjson"}}}
        r = config.resolve_archive_root({"MEMORY_ARCHIVE_DIR": r"C:\from-env"}, {"MEMORY_ARCHIVE_DIR": r"C:\from-dotenv"}, cfg, self.probes(), repo)
        self.assertEqual(r, (Path(r"C:\from-env"), "env"))
        r = config.resolve_archive_root({}, {"MEMORY_ARCHIVE_DIR": r"C:\from-dotenv"}, cfg, self.probes(), repo)
        self.assertEqual(r, (Path(r"C:\from-dotenv"), ".env"))
        r = config.resolve_archive_root({}, {}, cfg, self.probes(), repo)
        self.assertEqual(r, (Path(r"C:\from-osjson"), "os.json"))
        self.assertEqual(config.resolve_archive_root({}, {}, {}, self.probes(), repo), (Path(config.D_ARCHIVE), "D:"))
        # Removable / missing D: and a small D: are never chosen.
        self.assertEqual(config.resolve_archive_root({}, {}, {}, self.probes(fixed=False), repo)[1], "fallback")
        self.assertEqual(config.resolve_archive_root({}, {}, {}, self.probes(free=4 * 1024 ** 3), repo), (repo / "archive" / "memory", "fallback"))

    def test_relative_archive_root_is_an_error(self):
        with self.assertRaises(ConfigError):
            config.resolve_archive_root({"MEMORY_ARCHIVE_DIR": "relative/dir"}, {}, {}, self.probes(), Path("C:/r"))

    def test_pinned_root_reused_and_missing_pin_exits_2(self):
        sb = Sandbox()
        try:
            pin = sb.root / "pinned-archive"
            pin.mkdir()
            env = dict(sb.env)
            env.pop("MEMORY_ARCHIVE_DIR")
            (sb.root / "state" / "state.json").write_text(json.dumps({"archive_root": {"pinned": str(pin)}}), encoding="utf-8")
            sb.env = env
            code, lines = sb.cli("status", "--json")
            self.assertEqual(code, 0, lines)
            self.assertEqual(lines[-1]["archive_root"], str(pin))
            self.assertEqual(lines[-1]["archive_root_source"], "pinned")
            pin.rmdir()
            code, lines = sb.cli("status", "--json")
            self.assertEqual(code, 2)
            self.assertIn("pinned archive root is missing", lines[-1]["error"])
        finally:
            sb.close()

    def test_dotenv_is_read_never_written(self):
        sb = Sandbox()
        try:
            env_file = sb.root / "repo" / ".env"
            env_file.write_text("MEMORY_ARCHIVE_DIR=" + str(sb.root / "dotenv-archive") + "\nSOME_API_KEY=abcdefgh123\n", encoding="utf-8")
            before = (env_file.stat().st_mtime, env_file.read_bytes())
            env = dict(sb.env)
            env.pop("MEMORY_ARCHIVE_DIR")
            p = config.resolve({}, env, probes=self.probes(fixed=False))
            self.assertEqual(p.archive_root_source, ".env")
            self.assertIn("abcdefgh123", scrub.known_values(p.dotenv, {}))
            self.assertEqual((env_file.stat().st_mtime, env_file.read_bytes()), before)
        finally:
            sb.close()

    def test_booking_workspace_sanitised(self):
        for bad in ("my-workspace", "booking", "Bad Slug", ""):
            self.assertEqual(config.sanitize_workspace(bad), "librarian")
        self.assertEqual(config.sanitize_workspace("librarian"), "librarian")
        sb = Sandbox(os_json={"anythingllm": {"workspaces": {"librarian": "my-workspace", "general": "my-workspace", "booking": "booking", "coder": "coder"}}})
        try:
            p = sb.paths()
            self.assertEqual(p.allm_workspace, "librarian")
            self.assertEqual(config.offload_workspaces(p), ["coder"])
        finally:
            sb.close()


# ── 2. scrub ────────────────────────────────────────────────────────────────


class ScrubTests(unittest.TestCase):
    def test_parity_fixture(self):
        cases = json.loads((HERE / "fixtures" / "scrub_parity.json").read_text(encoding="utf-8"))
        self.assertGreaterEqual(len(cases), 10)
        for c in cases:
            self.assertEqual(scrub.scrub(c["input"], c["known"]), c["expected"], c["input"])

    def test_known_values_and_sha_survive(self):
        sha = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
        out = scrub.scrub(f"k={SENTINEL_KEY}x {sha} {SENTINEL_KEY}", [SENTINEL_KEY])
        self.assertNotIn(SENTINEL_KEY, out)
        self.assertIn(sha, out)
        self.assertEqual(scrub.scrub_obj({"a": [FAKE_SECRET]}), {"a": ["[redacted]"]})

    def test_env_name_filter_skips_path(self):
        vals = scrub.known_values({}, {"PATH": "C:\\Windows\\system32", "BRAVE_API_KEY": "brave-12345", "GITHUB_PAT": "ghpat-123456"})
        self.assertIn("brave-12345", vals)
        self.assertIn("ghpat-123456", vals)
        self.assertNotIn("C:\\Windows\\system32", vals)


# ── 3. sources ──────────────────────────────────────────────────────────────


class SourcesTests(unittest.TestCase):
    def setUp(self):
        self.sb = Sandbox()

    def tearDown(self):
        self.sb.close()

    def test_training_logs_skip_booking_desk_lines(self):
        logs = self.sb.root / "repo" / "training_logs"
        logs.mkdir()
        lines = [
            {"type": "os-turn", "role": "general", "delegatedTo": None, "upstream": "switch me to booking", "downstream": "Switched you over to the booking agent"},
            {"type": "os-turn", "role": "booking", "delegatedTo": "booking", "upstream": "Oh, he got it", "downstream": "BOOKING-DESK contact name, dates, rate"},
            {"type": "os-turn", "role": "general", "delegatedTo": "booking", "downstream": "BOOKING-DESK relayed by Tony"},
            {"type": "os-turn", "role": "general", "thread": "my-workspace", "downstream": "BOOKING-DESK via thread"},
            {"type": "os-turn", "role": "coder", "downstream": "built the status card"},
        ]
        (logs / "pipelines-2026-11-19.jsonl").write_text("\n".join(json.dumps(x) for x in lines) + '\n{"role": "booking", truncated BOOKING-DESK\n', encoding="utf-8")
        recs, wm, note = sources.training_logs(logs, {}, [])
        text = "\n".join(r["text"] for r in recs)
        self.assertNotIn("BOOKING-DESK", text)
        self.assertNotIn("booking", text.lower(), "a line that names Booking anywhere is dropped whole")
        self.assertIn("built the status card", text)
        self.assertEqual(len(recs), 1)
        self.assertEqual(note["booking_lines_skipped"], 5)
        self.assertGreater(wm["pipelines-2026-11-19.jsonl"], 0, "skipped lines still advance the watermark")
        # Both consumers: compact (--include-training-logs) and the offload local sources.
        paths = self.sb.paths()
        recs, _, _ = sources.collect(paths, state.default()["watermarks"], [], include_training_logs=True)
        self.assertNotIn("BOOKING-DESK", json.dumps(recs))
        from memory_scrolls import offload

        local, _ = offload.gather_local(paths, self.sb.env, [])
        self.assertNotIn("BOOKING-DESK", json.dumps(local))
        self.assertIn("built the status card", json.dumps(local))

    def test_gateway_chat_skips_booking_messages_and_lines(self):
        """Baseline-report gap: the Tony gateway chat is filtered for Booking like threads and logs."""
        chat = self.sb.root / "repo" / "data" / "chat-history.json"
        chat.parent.mkdir(parents=True, exist_ok=True)
        msgs = [
            {"role": "user", "content": "switch me to the booking agent\nalso the status card is green", "timestamp": 1794939000},
            {"role": "assistant", "agent": "booking", "content": "BOOKING-DESK client rates"},
            {"role": "user", "thread": "my-workspace", "content": "BOOKING-DESK via thread"},
            {"role": "assistant", "delegatedTo": "Booking Desk", "content": "BOOKING-DESK relayed"},
            {"role": "assistant", "content": "Pending: forward messages to the Booking agent"},
            {"role": "user", "content": "use my-workspace for that\r\nWhisper STT runs on port 8178"},
            {"role": "assistant", "content": "Done."},
        ]
        chat.write_text(json.dumps({"messages": msgs}), encoding="utf-8")
        recs, wm, note = sources.gateway_chat(chat, 0, [])
        text = "\n".join(r["text"] for r in recs)
        self.assertNotIn("booking", text.lower())
        self.assertNotIn("my-workspace", text)
        self.assertIn("status card is green", text)
        self.assertIn("Whisper STT runs on port 8178", text)
        self.assertEqual(len(recs), 3, text)
        self.assertEqual(note, {"booking_messages_skipped": 3, "booking_lines_skipped": 3})
        self.assertEqual(wm["n"], len(msgs), "skipped messages still advance the watermark")
        # Incremental: only newer messages are read, and they are filtered too.
        msgs.append({"role": "user", "content": "book the booking desk call"})
        chat.write_text(json.dumps({"messages": msgs}), encoding="utf-8")
        recs2, wm2, note2 = sources.gateway_chat(chat, wm, [])
        self.assertEqual((recs2, wm2["n"], note2), ([], len(msgs), {"booking_lines_skipped": 1}))
        # Both consumers: compact (--include-gateway-chat) and the offload local sources.
        paths = self.sb.paths()
        recs, _, notes = sources.collect(paths, state.default()["watermarks"], [], include_gateway_chat=True)
        self.assertNotIn("booking", json.dumps(recs).lower())
        self.assertEqual(notes["gateway_chat"]["booking_messages_skipped"], 3)
        from memory_scrolls import offload

        local, lnotes = offload.gather_local(paths, self.sb.env, [])
        chat_recs = [r for r in local if r["kind"] == "gateway_chat"]
        self.assertTrue(chat_recs)
        self.assertNotIn("booking", json.dumps(chat_recs).lower())
        self.assertEqual(lnotes["gateway_chat"]["booking_lines_skipped"], 4)

    def test_booking_line_rule_covers_every_spelling_and_envelopes(self):
        """BOOKING_LINE is a substring rule like booking_thread / booking_record (not word-bounded)."""
        for line in ("Bookings next week", "Handed to booking_desk: confirm the Friday gig fee", "BookingDesk said ok", "rebooking the venue", "use my-workspace", "BOOKING"):
            self.assertTrue(sources.BOOKING_LINE.search(line), line)
        self.assertIsNone(sources.BOOKING_LINE.search("Whisper STT runs on port 8178; the book club is Friday"))
        self.assertTrue(sources.booking_envelope("[Booking Desk — action APPROVED by the user]\nDetails: {}"))
        self.assertTrue(sources.booking_envelope("  [booking_desk relay] x"))
        self.assertFalse(sources.booking_envelope("[Coder] built it\nthe booking agent is idle"))
        self.assertFalse(sources.booking_envelope("plain text that names booking later"))

    def test_gateway_chat_drops_booking_variants_and_desk_envelopes(self):
        chat = self.sb.root / "repo" / "data" / "chat-history.json"
        chat.parent.mkdir(parents=True, exist_ok=True)
        msgs = [
            {"role": "assistant", "content": "Handed to booking_desk: confirm the Friday gig fee\nThe status card is green"},
            {"role": "assistant", "content": "BookingDesk replied\nBookings are open\nrebooking the venue"},
            {"role": "user", "agent": "hermes", "content": "[Booking Desk — action APPROVED by the user]\nDetails: {\"to\": \"VENUE-CONTACT\", \"msg\": \"GIG-FEE\"}\nCarry out exactly this action."},
            {"role": "assistant", "content": "Done."},
        ]
        chat.write_text(json.dumps(msgs), encoding="utf-8")
        recs, wm, note = sources.gateway_chat(chat, 0, [])
        text = "\n".join(r["text"] for r in recs)
        for bad in ("booking", "venue-contact", "gig-fee", "carry out exactly"):
            self.assertNotIn(bad, text.lower())
        self.assertIn("The status card is green", text)
        self.assertEqual(len(recs), 2, text)
        self.assertEqual(note, {"booking_messages_skipped": 1, "booking_lines_skipped": 4})
        self.assertEqual(wm["n"], len(msgs))

    def test_threads_drop_booking_lines_inside_other_threads(self):
        """Booking lines in a non-Booking thread (e.g. "talk to my booking agent", a relay to the
        Booking Desk, a Booking Desk envelope) never reach the distiller."""
        self.sb.threads({
            "prompter": [
                turn(1794939000001, "user", "Hey Tony, can you please talk to my booking agent and ask it for the last five messages?"),
                turn(1794939000002, "tony", "Sure, asking your booking agent now.\nAlso: Whisper STT runs on port 8178"),
                turn(1794939000003, "relay", "Routing what's up? to Booking Desk…"),
                turn(1794939000004, "user", "[Booking Desk — action APPROVED by the user]\nDetails: {\"msg\": \"GIG-FEE\"}"),
                turn(1794939000005, "booking", "BOOKING-SPEAKER reply"),
                turn(1794939000006, "user", "Handed to booking_desk: confirm\nthe status card is green"),
            ],
        })
        recs, wm, note = sources.threads(self.sb.paths().threads_json, {}, [])
        text = "\n".join(r["text"] for r in recs)
        for bad in ("booking", "gig-fee", "booking-speaker"):
            self.assertNotIn(bad, text.lower())
        self.assertIn("Whisper STT runs on port 8178", text)
        self.assertIn("the status card is green", text)
        self.assertEqual(len(recs), 2, text)
        self.assertEqual(note, {"booking_turns_skipped": 2, "booking_lines_skipped": 4})
        self.assertEqual(wm["prompter"][0], 1794939000006, "skipped turns still advance the watermark")
        # Both consumers (compact and the offload local sources) read threads through this filter.
        recs, _, _ = sources.collect(self.sb.paths(), state.default()["watermarks"], [])
        self.assertNotIn("booking", json.dumps(recs).lower())
        from memory_scrolls import offload

        local, _ = offload.gather_local(self.sb.paths(), self.sb.env, [])
        self.assertNotIn("booking", json.dumps([r for r in local if r["kind"] == "turn"]).lower())

    def test_tasks_db_is_read_only(self):
        db = self.sb.root / "tasks.db"
        make_tasks_db(db)
        conn = sources.open_ro(db)
        with self.assertRaises(sqlite3.OperationalError):
            conn.execute("INSERT INTO handoff_log (task_id) VALUES ('x')")
        conn.close()
        recs, env_wm, seq, note = sources.tasks_db(db, {}, 0, [])
        self.assertEqual([r["kind"] for r in recs], ["envelope", "handoff"])
        self.assertEqual(env_wm, {"t-1": 1794939000})
        self.assertEqual(seq, 1)
        self.assertEqual(recs[1]["meta"]["project_slug"], "status-card")
        recs, _, _, _ = sources.tasks_db(db, env_wm, seq, [])
        self.assertEqual(recs, [])

    def test_missing_tasks_db_is_a_note(self):
        recs, _, _, note = sources.tasks_db(self.sb.root / "absent.db", {}, 0, [])
        self.assertEqual(recs, [])
        self.assertEqual(note["skipped"], "tasks.db missing")
        self.assertFalse((self.sb.root / "absent.db").exists())

    def test_threads_skip_booking_and_system_with_watermarks(self):
        self.sb.threads(noisy_threads())
        p = self.sb.paths()
        recs, wm, note = sources.threads(p.threads_json, {}, [])
        self.assertTrue(all(r["meta"]["thread"] == "general" for r in recs))
        self.assertFalse(any("BOOKING-SECRET" in r["text"] for r in recs))
        self.assertFalse(any(r["meta"]["who"] == "system" for r in recs))
        self.assertEqual(note["booking_threads_skipped"], 1)
        self.assertFalse(any(FAKE_SECRET in r["text"] for r in recs))
        self.assertEqual(wm["general"][0], 1794939000010)
        recs2, wm2, _ = sources.threads(p.threads_json, wm, [])
        self.assertEqual(recs2, [])
        self.assertEqual(wm2, wm)

    def test_staging_skips_preview_and_notes_skip_backups(self):
        st = self.sb.root / "staging"
        (st / "status-card").mkdir()
        (st / "status-card" / ".status.json").write_text('{"status":"review_ready"}', encoding="utf-8")
        (st / "status-card" / "index.html").write_text("<html></html>", encoding="utf-8")
        (st / "memory-scrolls-preview" / "x").mkdir(parents=True)
        (st / "memory-scrolls-preview" / ".status.json").write_text("{}", encoding="utf-8")
        recs, wm, _ = sources.staging(st, {}, [])
        self.assertEqual([r["meta"]["project_slug"] for r in recs], ["status-card"])
        self.assertNotIn("<html>", recs[0]["text"])
        self.assertEqual(sources.staging(st, wm, [])[0], [])
        notes = self.sb.root / "notes"
        (notes / "ideas" / "2026-11-19-card.md").write_text("idea", encoding="utf-8")
        (notes / "anythingllm-prompt-backups").mkdir()
        (notes / "anythingllm-prompt-backups" / "coder.md").write_text("prompt", encoding="utf-8")
        recs, _, _ = sources.notes(notes, {}, [])
        self.assertEqual([r["meta"]["rel"] for r in recs], ["ideas/2026-11-19-card.md"])

    def test_distill_input_cap(self):
        big = "a" * 40000
        out = sources.distill_text(big, "arch-2026-11-19-01")
        self.assertLess(len(out), 11000)
        self.assertIn("[... 40000 bytes in arch-2026-11-19-01]", out)


# ── 4. archive ──────────────────────────────────────────────────────────────


def recs(n=3, text="hello world"):
    return [{"kind": "turn", "ts": "", "source": "thread:general", "text": f"{text} {i}", "meta": {"thread": "general"}} for i in range(n)]


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.root = Path(self.td.name) / "archive"

    def tearDown(self):
        self.td.cleanup()

    def test_roundtrip_ids_and_manifest(self):
        refs = archive.write_archive(self.root, recs(3), {"kind": "buffer"}, NOW)
        self.assertEqual(refs[0].archive_id, "arch-2026-11-19-01")
        self.assertTrue((self.root / "2026" / "11" / "arch-2026-11-19-01.jsonl.gz").is_file())
        header, rows = archive.read_entry(self.root, "arch-2026-11-19-01")
        self.assertEqual(header["schema"], archive.SCHEMA)
        self.assertEqual(header["records"], 3)
        self.assertEqual([r["seq"] for r in rows], [1, 2, 3])
        m = archive.read_manifest(self.root)[0]
        data = refs[0].path.read_bytes()
        import hashlib

        self.assertEqual(m["sha256_gz"], hashlib.sha256(data).hexdigest())
        self.assertEqual(m["sha256_raw"], hashlib.sha256(gzip.decompress(data)).hexdigest())
        refs2 = archive.write_archive(self.root, recs(1), {"kind": "buffer"}, NOW)
        self.assertEqual(refs2[0].archive_id, "arch-2026-11-19-02")

    def test_existing_id_is_never_overwritten(self):
        refs = archive.write_archive(self.root, recs(2), {"kind": "buffer"}, NOW)
        original = refs[0].path.read_bytes()
        with mock.patch.object(archive, "next_id", return_value="arch-2026-11-19-01"):
            with self.assertRaises(ArchiveError):
                archive.write_archive(self.root, recs(5, "other"), {"kind": "buffer"}, NOW)
        self.assertEqual(refs[0].path.read_bytes(), original)
        self.assertEqual(len(archive.read_manifest(self.root)), 1)

    def test_flipped_byte_fails_verify_and_prune(self):
        refs = archive.write_archive(self.root, recs(2), {"kind": "buffer"}, NOW)
        self.assertTrue(archive.prune_allowed(self.root, refs[0].archive_id))
        data = bytearray(refs[0].path.read_bytes())
        data[len(data) // 2] ^= 0xFF
        refs[0].path.write_bytes(bytes(data))
        self.assertFalse(archive.prune_allowed(self.root, refs[0].archive_id))

    def test_deterministic_gzip_and_cap(self):
        raw = b"x" * 1000
        self.assertEqual(archive._gz(raw), archive._gz(raw))
        with self.assertRaises(ArchiveError):
            archive._gunzip_capped(archive._gz(b"y" * 5000), cap=1000)

    def test_split_at_256kb(self):
        big = [{"kind": "turn", "ts": "", "source": "s", "text": "z" * 100_000, "meta": {}} for _ in range(4)]
        refs = archive.write_archive(self.root, big, {"kind": "buffer"}, NOW)
        self.assertGreaterEqual(len(refs), 2)
        self.assertEqual(sum(r.records for r in refs), 4)

    def test_secrets_scrubbed_before_hashing(self):
        r = recs(1, f"token {FAKE_SECRET}")
        refs = archive.write_archive(self.root, r, {"kind": "buffer"}, NOW)
        raw = gzip.decompress(refs[0].path.read_bytes()).decode()
        self.assertNotIn(FAKE_SECRET, raw)
        self.assertEqual(json.loads(raw.splitlines()[0])["redactions"], 1)


# ── 5. scroll schema / paths ────────────────────────────────────────────────

SPEC_EXAMPLE = """---
scroll_id: "proj-agentic-os"
category: "project" # core | project | pattern
last_updated: "2026-11-19T09:00:00-05:00"
version: 3
source_archive_ids: ["arch-2026-11-18-01", "arch-2026-11-19-02"]
supersedes: ["legacy-note-v1"]
---
# Agentic Os
"""


class ScrollSchemaTests(unittest.TestCase):
    def test_spec_example_parses_and_roundtrips(self):
        s = sc.parse(SPEC_EXAMPLE)
        self.assertEqual((s.scroll_id, s.category, s.version), ("proj-agentic-os", "project", 3))
        self.assertEqual(s.source_archive_ids, ["arch-2026-11-18-01", "arch-2026-11-19-02"])
        self.assertEqual(sc.parse(sc.render(s)).__dict__, s.__dict__)

    def test_bad_frontmatter_rejected(self):
        bad = [
            SPEC_EXAMPLE.replace('supersedes: ["legacy-note-v1"]\n', ""),
            SPEC_EXAMPLE.replace("version: 3", "version: 3\nextra: 1"),
            SPEC_EXAMPLE.replace("version: 3", 'version: "3"'),
            SPEC_EXAMPLE.replace('["legacy-note-v1"]', "[legacy-note-v1]"),
            SPEC_EXAMPLE.replace('"proj-agentic-os"', '"Proj_Bad"'),
            SPEC_EXAMPLE.replace('"arch-2026-11-18-01"', '"arch-x"'),
        ]
        for text in bad:
            with self.assertRaises(ScrollError, msg=text[:120]):
                sc.parse(text)
        s = sc.parse(SPEC_EXAMPLE)
        with self.assertRaises(ScrollError):
            sc.check_matches(sc.target_info("core/architecture_decisions.md"), s)

    def test_path_validation(self):
        td = tempfile.TemporaryDirectory()
        try:
            root = Path(td.name)
            for ok in ("core/identity_and_preferences.md", "core/architecture_decisions.md", "projects/agentic-os.md", "patterns/lessons_and_fixes.md", "projects/agentic-os--voice.md"):
                self.assertTrue(str(sc.resolve_in_root(root, ok)).startswith(str(root)))
            for bad in ("../x.md", "core/other.md", "projects/Bad_Slug.md", "projects/a/b.md", "C:\\x.md", "core/a.md:ads", "projects/booking.md", "projects/my-workspace.md", "projects/con.md"):
                with self.assertRaises(ScrollError, msg=bad):
                    sc.resolve_in_root(root, bad)
        finally:
            td.cleanup()

    def test_link_in_path_rejected(self):
        td = tempfile.TemporaryDirectory()
        try:
            root = Path(td.name) / "scrolls"
            root.mkdir()
            elsewhere = Path(td.name) / "elsewhere"
            elsewhere.mkdir()
            link = root / "projects"
            made = False
            try:
                os.symlink(elsewhere, link, target_is_directory=True)
                made = True
            except OSError:
                if os.name == "nt":
                    made = subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(elsewhere)], capture_output=True).returncode == 0
            if not made:
                self.skipTest("could not create a symlink or junction here")
            self.assertTrue(is_reparse(link))
            with self.assertRaises(ScrollError):
                sc.resolve_in_root(root, "projects/agentic-os.md")
        finally:
            td.cleanup()


# ── 6. merge / validate ─────────────────────────────────────────────────────


class MergeTests(unittest.TestCase):
    T = sc.target_info("projects/agentic-os.md")

    def old_scroll(self) -> sc.Scroll:
        r = valid_reply("projects/agentic-os.md")
        body = r["updated_markdown"].replace("## Locked Decisions\n", "## Locked Decisions\n\n- LM Studio serves on port 1234\n- Booking is never touched\n")
        return sc.Scroll(self.T.scroll_id, "project", NOW_ISO, 2, ["arch-2026-11-18-01"], ["legacy-note-v1"], body)

    def test_new_scroll_version_1(self):
        reasons, merged, _ = sc.validate(self.T, None, valid_reply(self.T.rel), [self.T.rel], "arch-2026-11-19-01", NOW_ISO)
        self.assertEqual(reasons, [])
        self.assertEqual((merged.version, merged.source_archive_ids), (1, ["arch-2026-11-19-01"]))

    def test_supersede_and_version_bump(self):
        old = self.old_scroll()
        body = old.body.replace("- LM Studio serves on port 1234\n", "- LM Studio serves on port 1235\n")
        reply = {**valid_reply(self.T.rel), "updated_markdown": body, "superseded_facts": [{"old": "LM Studio serves on port 1234", "new": "LM Studio serves on port 1235", "reason": "moved"}]}
        reasons, merged, _ = sc.validate(self.T, old, reply, [self.T.rel], "arch-2026-11-19-01", NOW_ISO)
        self.assertEqual(reasons, [])
        self.assertEqual(merged.version, 3)
        self.assertEqual(merged.source_archive_ids, ["arch-2026-11-18-01", "arch-2026-11-19-01"])
        self.assertEqual(merged.supersedes, ["legacy-note-v1"])
        sup = sc.section_bullets(merged.body, [sc.SUPERSEDED])
        self.assertEqual(sup, ["- 2026-11-19: LM Studio serves on port 1234 -> LM Studio serves on port 1235 (arch-2026-11-19-01)"])
        again, changed = sc.merge(self.T, merged, merged.body, [], "arch-2026-11-19-01", NOW_ISO)
        self.assertFalse(changed)
        self.assertIs(again, merged)

    def test_superseded_fact_left_in_body_rejected(self):
        old = self.old_scroll()
        reply = {**valid_reply(self.T.rel), "updated_markdown": old.body, "superseded_facts": [{"old": "LM Studio serves on port 1234", "new": "1235", "reason": ""}]}
        reasons, _, _ = sc.validate(self.T, old, reply, [self.T.rel], "arch-2026-11-19-01", NOW_ISO)
        self.assertTrue(any("still stated" in r for r in reasons), reasons)

    def test_dropped_locked_bullet_rejected(self):
        old = self.old_scroll()
        reply = valid_reply(self.T.rel)
        reasons, _, _ = sc.validate(self.T, old, reply, [self.T.rel], "arch-2026-11-19-01", NOW_ISO)
        self.assertTrue(any("locked decision was dropped" in r for r in reasons), reasons)

    def test_short_or_generic_superseded_old_does_not_excuse_dropped_locked_bullets(self):
        old = self.old_scroll()
        body = valid_reply(self.T.rel)["updated_markdown"].replace("## Locked Decisions\n", "## Locked Decisions\n\n- nothing\n")
        for generic in ("on", "port", "port 1234"):
            reply = {**valid_reply(self.T.rel), "updated_markdown": body, "superseded_facts": [{"old": generic, "new": "x"}]}
            reasons, merged, _ = sc.validate(self.T, old, reply, [self.T.rel], "arch-2026-11-19-01", NOW_ISO)
            self.assertIsNone(merged, generic)
            self.assertTrue(any("locked decision was dropped" in r for r in reasons), (generic, reasons))
        # A specific part of the bullet (>= 12 chars) still counts as superseding it.
        keep = body.replace("- nothing\n", "- Booking is never touched\n- LM Studio serves on port 1235\n")
        reply = {**valid_reply(self.T.rel), "updated_markdown": keep, "superseded_facts": [{"old": "serves on port 1234", "new": "serves on port 1235"}]}
        reasons, merged, _ = sc.validate(self.T, old, reply, [self.T.rel], "arch-2026-11-19-01", NOW_ISO)
        self.assertEqual(reasons, [])

    def test_superseded_section_keeps_8(self):
        body = valid_reply(self.T.rel)["updated_markdown"]
        facts = [{"old": f"fact number {i:02d}", "new": f"new {i}", "reason": ""} for i in range(10)]
        out = sc.enforce_superseded(body, facts, "arch-2026-11-19-01", "2026-11-19")
        self.assertEqual(len(sc.section_bullets(out, [sc.SUPERSEDED])), 8)
        self.assertEqual(sc.h2_list(out)[-1], sc.SUPERSEDED)

    def test_size_warn_and_reject(self):
        warn_bullets = [f"- bullet {i:03d} " + "w" * 40 for i in range(60)]
        reasons, merged, warnings = sc.validate(self.T, None, valid_reply(self.T.rel, warn_bullets), [self.T.rel], "arch-2026-11-19-01", NOW_ISO)
        self.assertEqual(reasons, [])
        self.assertTrue(3072 < sc.size_of(merged) <= 5120)
        self.assertTrue(warnings)
        big = [f"- bullet {i:03d} " + "w" * 40 for i in range(120)]
        reasons, merged, _ = sc.validate(self.T, None, valid_reply(self.T.rel, big), [self.T.rel], "arch-2026-11-19-01", NOW_ISO)
        self.assertIsNone(merged)
        self.assertTrue(reasons[0].startswith(sc.TOO_LARGE))

    def test_too_large_retried_once_then_pending(self):
        class Big:
            model = "qwen/qwen3.5-9b"
            mode = "live"

            def __init__(self):
                self.calls = []

            def chat(self, messages):
                self.calls.append(messages)
                return json.dumps(valid_reply("projects/agentic-os.md", [f"- bullet {i:03d} " + "w" * 40 for i in range(120)]))

        llm = Big()
        budget = {"used": 0, "max": 4, "save": lambda: None}
        reasons, merged, _, _ = compact.distill_target(llm, self.T, None, "Concept: x", "arch-2026-11-19-01", NOW_ISO, [], {}, budget)
        self.assertIsNone(merged)
        self.assertTrue(reasons[0].startswith(sc.TOO_LARGE))
        self.assertEqual(len(llm.calls), 2)
        self.assertIn("Compress under 3 KB", llm.calls[1][1]["content"])
        # Budget exhausted mid-target -> BudgetSpent (the target stays pending).
        with self.assertRaises(compact.BudgetSpent):
            compact.distill_target(llm, self.T, None, "Concept: x", "arch-2026-11-19-01", NOW_ISO, [], {}, {"used": 4, "max": 4, "save": lambda: None})

    def test_history_keeps_5_versions(self):
        td = tempfile.TemporaryDirectory()
        try:
            root, hist = Path(td.name) / "scrolls", Path(td.name) / "history"
            s = None
            for i in range(8):
                reply = valid_reply(self.T.rel, [f"- Concept: version {i}"])
                _, s, _ = sc.validate(self.T, s, {**reply, "updated_markdown": reply["updated_markdown"]}, [self.T.rel], f"arch-2026-11-19-{i + 1:02d}", NOW_ISO)
                write_scroll(root, self.T.rel, s, hist)
            self.assertEqual(sc.read_scroll(root, self.T.rel).version, 8)
            kept = sorted(p.name for p in (hist / self.T.scroll_id).iterdir())
            self.assertEqual(kept, ["v3.md", "v4.md", "v5.md", "v6.md", "v7.md"])
        finally:
            td.cleanup()


# ── 7. distill validation ───────────────────────────────────────────────────


class DistillTests(unittest.TestCase):
    T = sc.target_info("projects/agentic-os.md")

    def check(self, reply) -> list:
        return sc.validate(self.T, None, reply, [self.T.rel], "arch-2026-11-19-01", NOW_ISO, [SENTINEL_KEY])[0]

    def test_think_wrapped_and_fenced_reply_accepted(self):
        r = valid_reply(self.T.rel)
        text = "<think>I should {not} answer</think>\n```json\n" + json.dumps(r) + "\n```"
        self.assertEqual(distill.parse_reply(text), r)
        self.assertEqual(self.check(distill.parse_reply(text)), [])

    def test_rejections(self):
        r = valid_reply(self.T.rel)
        ent = {"name": "x", "entityType": "tool", "observations": ["o"]}
        cases = {
            "extra key": {**r, "extra": 1},
            "wrong type": {**r, "superseded_facts": "none"},
            "13 entities": {**r, "graph_entities_to_upsert": [dict(ent, name=f"e{i}") for i in range(13)]},
            "201-char observation": {**r, "graph_entities_to_upsert": [dict(ent, observations=["o" * 201])]},
            "bad entityType": {**r, "graph_entities_to_upsert": [dict(ent, entityType="weapon")]},
            "script": {**r, "updated_markdown": r["updated_markdown"] + "\n<script>alert(1)</script>"},
            "13-line fence": {**r, "updated_markdown": r["updated_markdown"].replace("## Key Paths", "```\n" + "x\n" * 13 + "```\n## Key Paths")},
            "missing heading": {**r, "updated_markdown": r["updated_markdown"].replace("## Key Paths\n", "")},
            "secret in body": {**r, "updated_markdown": r["updated_markdown"] + f"\n- key {SENTINEL_KEY}"},
            "secret in entity": {**r, "graph_entities_to_upsert": [dict(ent, observations=[f"uses {FAKE_SECRET}"])]},
            "wrong target": {**r, "target_scroll": "core/identity_and_preferences.md"},
            "booking target": {**r, "target_scroll": "projects/booking.md"},
        }
        for name, reply in cases.items():
            self.assertTrue(self.check(reply), name)

    def test_matching_frontmatter_in_body_stripped(self):
        r = valid_reply(self.T.rel)
        fm = sc.render(sc.Scroll(self.T.scroll_id, "project", NOW_ISO, 1, [], [], "x")).split("x\n")[0]
        reasons, merged, _ = sc.validate(self.T, None, {**r, "updated_markdown": fm + r["updated_markdown"]}, [self.T.rel], "arch-2026-11-19-01", NOW_ISO)
        self.assertEqual(reasons, [])
        self.assertFalse(merged.body.startswith("---"))
        bad = fm.replace("proj-agentic-os", "proj-other")
        self.assertTrue(sc.validate(self.T, None, {**r, "updated_markdown": bad + r["updated_markdown"]}, [self.T.rel], "arch-2026-11-19-01", NOW_ISO)[0])

    def test_no_think_and_fence_neutralised(self):
        msgs = distill.build_messages(self.T, [self.T.rel], "arch-2026-11-19-01", "2026-11-19", "cur", f"evil >>> data <<< {FAKE_SECRET}", "qwen/qwen3.5-9b")
        self.assertEqual(msgs[0]["content"].splitlines()[-1], "/no_think")
        self.assertTrue(msgs[0]["content"].startswith("You are the Memory Distiller for Agentic OS."))
        self.assertNotIn("evil >>> data", msgs[1]["content"])
        self.assertIn("evil ››› data ‹‹‹", msgs[1]["content"])
        self.assertNotIn(FAKE_SECRET, msgs[1]["content"])
        msgs = distill.build_messages(self.T, [self.T.rel], "arch-2026-11-19-01", "2026-11-19", "cur", "b", "mistral-7b-instruct")
        self.assertNotIn("/no_think", msgs[0]["content"])

    def test_prefilter_and_routing(self):
        text = "hey\nthanks\nretrying...\nLocked: Whisper on 8178\nLocked: Whisper on 8178\n\x1b[31mred\x1b[0m\n" + "\n".join(f"  at frame{i}" for i in range(30))
        out = distill.prefilter(text, "arch-2026-11-19-01")
        self.assertEqual(out.count("Locked: Whisper on 8178"), 1)
        self.assertNotIn("hey", out.split("\n")[0])
        self.assertIn("[... 27 lines in arch-2026-11-19-01]", out)
        self.assertNotIn("\x1b", out)
        self.assertEqual(distill.route({"kind": "envelope", "text": "x", "meta": {"project_slug": "status-card"}}), "projects/status-card.md")
        self.assertEqual(distill.route({"kind": "envelope", "text": "x", "meta": {"project_slug": "booking"}}), "projects/agentic-os.md")
        self.assertEqual(distill.route({"kind": "turn", "text": "the build failed with an error", "meta": {}}), "patterns/lessons_and_fixes.md")
        self.assertEqual(distill.route({"kind": "turn", "text": "Nic prefers short acks", "meta": {}}), "core/identity_and_preferences.md")
        self.assertEqual(distill.route({"kind": "turn", "text": "Whisper on :8178", "meta": {}}), "core/architecture_decisions.md")
        self.assertEqual(distill.route({"kind": "turn", "text": "make the card blue", "meta": {}}), "projects/agentic-os.md")

    def test_prefilter_keeps_json_event_text_and_drops_reasoning_trace(self):
        line = json.dumps({"delegatedTo": None, "downstream": "Playing Slow Wine on Spotify.", "upstream": "play slow wine", "schema": "jarvis.synapse.v1", "latencyMs": 2373})
        out = distill.prefilter(f"{line}\n" + json.dumps({"schema": "jarvis.synapse.v1", "latencyMs": 1}) + "\nLocked: Whisper on 8178", "arch-2026-11-19-01")
        self.assertIn("upstream: play slow wine | downstream: Playing Slow Wine on Spotify.", out)
        self.assertNotIn("jarvis.synapse", out)
        self.assertNotIn("latencyMs", out)
        self.assertIn("Locked: Whisper on 8178", out)
        self.assertEqual(distill.prefilter("assistant: Thinking Process:\n1. **Analyze the Request:** weather\n2. Draft", "arch-2026-11-19-01"), "")
        # Not a JSON object / reasoning marker mid-record: kept as text.
        self.assertIn("{not json}", distill.prefilter("{not json}", "a"))
        self.assertIn("Thinking Process:", distill.prefilter("Notes on the build\nThinking Process:\nstep one", "a"))

    # ── harmless model variance is repaired; data-protecting checks stay strict ──

    def test_entity_type_synonyms_normalised_with_warning(self):
        r = valid_reply(self.T.rel)
        raw = ["Agent", "pattern", "model", "Folder", "owner", "rule", "weird", "Tools", "service"]
        want = ["tool", "lesson", "tool", "path", "person", "decision", "concept", "tool", "service"]
        reply = {**r, "graph_entities_to_upsert": [{"name": f"e{i}", "entityType": x, "observations": ["o"]} for i, x in enumerate(raw)]}
        self.assertTrue(self.check(reply), "validate itself stays strict")
        fixed, warnings = distill.normalize_reply(reply)
        self.assertEqual([e["entityType"] for e in fixed["graph_entities_to_upsert"]], want)
        self.assertIn("entityType 'Agent'->'tool' x1", warnings)
        self.assertIn("entityType 'weird'->'concept' x1", warnings)
        self.assertFalse(any("'service'" in w for w in warnings), warnings)
        self.assertEqual(self.check(fixed), [])
        six = {**r, "graph_entities_to_upsert": [{"name": f"a{i}", "entityType": "agent", "observations": []} for i in range(6)]}
        self.assertIn("entityType 'agent'->'tool' x6", distill.normalize_reply(six)[1])

    def test_malformed_entity_dropped_scroll_kept(self):
        r = valid_reply(self.T.rel)
        ents = [
            "not an object",
            {"name": "", "entityType": "tool", "observations": []},
            {"name": "n" * 81, "entityType": "tool", "observations": []},
            {"name": "Str", "entityType": "tool", "observations": "a single observation"},
            {"name": "Int", "entityType": "tool", "observations": ["ok", 7]},
            {"name": "Nine", "entityType": "tool", "observations": [f"o{i}" for i in range(9)]},
            {"name": "Long", "entityType": "tool", "observations": ["x" * 201]},
            {"name": "Extra", "entityType": "tool", "observations": ["o"], "relations": [{"to": "y"}]},
        ]
        reply = {**r, "graph_entities_to_upsert": ents, "superseded_facts": "none", "notes": "chatter"}
        self.assertTrue(self.check(reply))
        fixed, warnings = distill.normalize_reply(reply)
        out = {e["name"]: e for e in fixed["graph_entities_to_upsert"]}
        self.assertEqual(sorted(out), ["Extra", "Int", "Long", "Nine", "Str"])
        self.assertEqual(out["Str"]["observations"], ["a single observation"])
        self.assertEqual(out["Int"]["observations"], ["ok"])
        self.assertEqual(len(out["Nine"]["observations"]), 8)
        self.assertEqual(len(out["Long"]["observations"][0]), 200)
        self.assertEqual(set(out["Extra"]), {"name", "entityType", "observations"})
        self.assertEqual(fixed["superseded_facts"], [])
        self.assertNotIn("notes", fixed)
        for w in ("entity dropped (not an object) x1", "entity dropped (name not 1..80 chars) x2", "unknown reply keys dropped: notes", "superseded_facts not a list: treated as []"):
            self.assertIn(w, warnings)
        self.assertEqual(self.check(fixed), [])
        thirteen = {**r, "graph_entities_to_upsert": [{"name": f"e{i}", "entityType": "tool", "observations": []} for i in range(13)]}
        self.assertEqual(len(distill.normalize_reply(thirteen)[0]["graph_entities_to_upsert"]), 12)
        # Through the pipeline: the scroll is accepted, the warnings reported.
        reasons, merged, entities, warnings = distill_once(FakeLLM([reply]), self.T.rel)
        self.assertEqual(reasons, [])
        self.assertEqual(len(entities), 5)
        self.assertTrue(any("entity dropped" in w for w in warnings), warnings)

    def test_secret_in_entity_still_rejected_after_normalise(self):
        r = valid_reply(self.T.rel)
        for ents in (
            [{"name": "Vault", "entityType": "Agent", "observations": f"key is {FAKE_SECRET}"}],
            [{"name": f"uses {SENTINEL_KEY}", "entityType": "tool", "observations": []}],
            [{"name": "Vault", "entityType": "tool", "observations": ["ok", f"token {SENTINEL_KEY}"], "extra": 1}],
        ):
            fixed, _ = distill.normalize_reply({**r, "graph_entities_to_upsert": ents})
            self.assertTrue(any("secret" in x for x in self.check(fixed)), ents)
            reasons, merged, _, _ = distill_once(FakeLLM([{**r, "graph_entities_to_upsert": ents}]), self.T.rel, known=[SENTINEL_KEY])
            self.assertIsNone(merged)
            self.assertTrue(any("secret" in x for x in reasons), reasons)

    def test_distill_target_accepts_live_agent_entity_reply(self):
        # Modelled on the live qwen/qwen3.5-9b reply (LM Studio log line 352375): six "agent" entities,
        # a superseded fact whose old line was left in Locked Design Decisions, a changelog Superseded log.
        rel = "core/architecture_decisions.md"
        old_line = "Coder Agent: Dedicated agent responsible for drafting app foundations and executing build tasks."
        reply = section_reply(rel, {
            "Ports & Services": ["- **lmstudio**: Local LLM inference provider (Jarvis Synapse v1)."],
            "Repo Paths": ["- `C:\\ai-hub\\master\\`: Master index, status, identity, agents."],
            "Locked Design Decisions": ["- **Jarvis Synapse v1**: The active OS-agent schema.", f"- **{old_line[:11]}**{old_line[11:]}", "- **Coder (Cline)**: Builds tasks one-by-one using Qwen 3.5 9B (LM Studio)."],
            "Guardrails": ["- Read INDEX + STATUS + AGENTS_NEVER first every session.", "- Compress older detail; never drop locked decisions."],
            sc.SUPERSEDED: ["- 2026-11-19: Consolidated agent roles and model strategy into Locked Design Decisions to replace fragmented batch notes."],
        }, facts=[{"old": old_line, "new": "Coder (Cline): Builds tasks one-by-one using Qwen 3.5 9B (LM Studio).", "reason": "specific"}],
            entities=[{"name": n, "entityType": "agent", "observations": [f"{n} role"]} for n in ("Conceptualizer", "Dispatcher", "Coder", "Reviewer", "Librarian", "Booking")])
        self.assertTrue(sc.validate(sc.target_info(rel), None, reply, [rel], "arch-2026-11-19-01", NOW_ISO)[0], "as logged, validate rejects it")
        llm = FakeLLM([reply])
        # An existing (v1, still empty) scroll: a brand-new one supersedes nothing (guards v3, below).
        base = sc.Scroll(sc.target_info(rel).scroll_id, "core", NOW_ISO, 1, ["arch-2026-11-18-01"], [], sc.template_body(sc.target_info(rel)))
        reasons, merged, entities, warnings = distill_once(llm, rel, old=base, text="Coder (Cline) builds tasks one-by-one with Qwen 3.5 9B")
        self.assertEqual(reasons, [])
        self.assertIsNotNone(merged)
        self.assertEqual(len(llm.calls), 1)
        self.assertEqual({e["entityType"] for e in entities}, {"tool"})
        self.assertTrue(any("entityType 'agent'->'tool' x6" in w for w in warnings), warnings)
        self.assertTrue(any("superseded line(s) removed from the body" in w for w in warnings), warnings)
        self.assertNotIn("Dedicated agent responsible", merged.body.split(f"## {sc.SUPERSEDED}")[0])
        self.assertNotIn("Compress older detail", merged.body)
        sup = sc.section_bullets(merged.body, [sc.SUPERSEDED])
        self.assertEqual(len(sup), 1, sup)
        self.assertIn("Coder Agent: Dedicated agent", sup[0])
        self.assertIn(" -> ", sup[0])
        # Brand-new scroll: no model-written Superseded entry at all; the restated old line still goes.
        reasons, merged, _, warnings = distill_once(FakeLLM([reply]), rel, text="Coder (Cline) builds tasks one-by-one with Qwen 3.5 9B")
        self.assertEqual(reasons, [])
        self.assertEqual(sc.section_bullets(merged.body, [sc.SUPERSEDED]), [])
        self.assertNotIn("Dedicated agent responsible", merged.body)

    def test_stale_superseded_line_removed_exact_only(self):
        fact = {"old": "LM Studio serves on port 1234", "new": "LM Studio serves on port 1235", "reason": "moved"}
        exact = section_reply(self.T.rel, {"Locked Decisions": ["- **LM Studio serves on port 1234**.", "- LM Studio serves on port 1235"]}, facts=[fact])
        body, removed = sc.drop_stated_superseded(exact["updated_markdown"], [fact])
        self.assertEqual(removed, ["- **LM Studio serves on port 1234**."])
        base = sc.Scroll(self.T.scroll_id, "project", NOW_ISO, 1, ["arch-2026-11-18-01"], [], sc.template_body(self.T))
        reasons, merged, _, warnings = distill_once(FakeLLM([exact]), self.T.rel, old=base)
        self.assertEqual(reasons, [])
        sup = sc.section_bullets(merged.body, [sc.SUPERSEDED])
        self.assertEqual(sup, ["- 2026-11-19: LM Studio serves on port 1234 -> LM Studio serves on port 1235 (arch-2026-11-19-01)"])
        self.assertNotIn("port 1234", merged.body.split(f"## {sc.SUPERSEDED}")[0])
        # A later chunk that restates the superseded line verbatim: removed too (the whole-target
        # check runs against every chunk's facts).
        again = section_reply(self.T.rel, {"Locked Decisions": ["- LM Studio serves on port 1234", "- LM Studio serves on port 1235"]})
        reasons, merged, _, _ = distill_once(FakeLLM([exact, again]), self.T.rel, old=base, text="y" * 11000 + "\n" + "z" * 11000)
        self.assertEqual(reasons, [])
        self.assertNotIn("port 1234", merged.body.split(f"## {sc.SUPERSEDED}")[0])
        self.assertEqual(len(sc.section_bullets(merged.body, [sc.SUPERSEDED])), 1)
        # A line that only CONTAINS the old fact is ambiguous: still a rejection, nothing removed.
        sub = section_reply(self.T.rel, {"Locked Decisions": ["- LM Studio serves on port 1234 for chat and embeddings", "- LM Studio serves on port 1235"]}, facts=[fact])
        self.assertEqual(sc.drop_stated_superseded(sub["updated_markdown"], [fact])[1], [])
        reasons, merged, _, _ = distill_once(FakeLLM([sub]), self.T.rel, old=base)
        self.assertIsNone(merged)
        self.assertTrue(any("still stated" in r for r in reasons), reasons)

    def test_prompt_echo_lines_stripped(self):
        echoes = [
            "- **Data Hygiene**: Drop greetings, filler, retries, apologies, stack traces, tool dumps, code >3 lines.",
            "- **Security Policy**: Never write secrets, keys, tokens, passwords or .env values (e.g., `api_key`, raw keys).",
            "- **Scroll ID Format**: `proj-{project-name}`",
            "- **Archive ID Format**: `arch-{YYYY}-{MM}-{DD}-{NN}`",
            "- Compress older detail; never drop locked decisions.",
        ]
        in_batch = "- Drop greetings, filler and retries from transcripts"
        in_old = "- Drop greetings, filler, retries and apologies from every transcript"
        keeps = [
            "- Never commit secrets to git",
            "- Never hardcode API keys in brain/ or skills/ (use data/settings.json with placeholders)",
            "- Whisper STT: port 8178 (locked)",
            "- Scrolls live in `C:\\ai-hub\\memory\\scrolls`",
            in_batch,
            in_old,
        ]
        old = sc.Scroll(self.T.scroll_id, "project", NOW_ISO, 1, [], [], section_reply(self.T.rel, {"Locked Decisions": [in_old]})["updated_markdown"])
        chunk = "user: Rule from Nic: drop greetings, filler and retries from transcripts"
        reply = section_reply(self.T.rel, {"Locked Decisions": echoes + keeps}, entities=[
            {"name": "Security Policy", "entityType": "decision", "observations": ["Never write secrets, keys, tokens, passwords or .env values"]},
            {"name": "Whisper STT", "entityType": "service", "observations": ["Runs on port 8178", "Compress older detail; never drop locked decisions."]},
        ])
        body, removed = distill.strip_prompt_echo(reply["updated_markdown"], [chunk, old.body], old.body)
        self.assertEqual(removed, echoes)
        for k in keeps:
            self.assertIn(k, body)
        ents, removed_obs = distill.strip_echo_observations(reply["graph_entities_to_upsert"], [chunk, old.body], old.body)
        self.assertEqual(ents, [{"name": "Whisper STT", "entityType": "service", "observations": ["Runs on port 8178"]}])
        self.assertEqual(len(removed_obs), 2)
        # End to end: the echo-like locked bullet of the old scroll survives, so no-silent-loss holds.
        reasons, merged, entities, warnings = distill_once(FakeLLM([reply]), self.T.rel, old=old, text=chunk)
        self.assertEqual(reasons, [])
        for e in echoes:
            self.assertNotIn(e, merged.body)
        self.assertIn(in_old, merged.body)
        self.assertEqual([e["name"] for e in entities], ["Whisper STT"])
        self.assertTrue(any("5 prompt-echo line(s) removed" in w for w in warnings), warnings)

    def test_move_recorded_as_supersede_never_removes_a_locked_bullet(self):
        # Review finding: qwen moves a locked bullet to another section and records the move as a
        # superseded fact. The bullet must stay in the body, not become a (trimmed) log line.
        rel = "core/architecture_decisions.md"
        t = sc.target_info(rel)
        rule = "- Gateway binds 127.0.0.1 only, never 0.0.0.0"
        old = sc.Scroll(t.scroll_id, "core", NOW_ISO, 1, ["arch-2026-11-18-01"], [], section_reply(rel, {"Locked Design Decisions": [rule]})["updated_markdown"])
        move = {"old": rule[2:], "new": "moved to Guardrails", "reason": "moved"}
        moved = section_reply(rel, {"Guardrails": [rule]}, facts=[move])
        reasons, merged, _, warnings = distill_once(FakeLLM([moved]), rel, old=old, text="Gateway binds 127.0.0.1 only")
        self.assertEqual(reasons, [])
        self.assertIn(rule, merged.body.split(f"## {sc.SUPERSEDED}")[0])
        self.assertEqual(sc.section_bullets(merged.body, [sc.SUPERSEDED]), [])
        self.assertTrue(any("a move, not a value change" in w for w in warnings), warnings)
        # The move fact never excuses a bullet the reply actually dropped.
        gone = section_reply(rel, {}, facts=[move])
        reasons, merged, _, _ = distill_once(FakeLLM([gone]), rel, old=old)
        self.assertIsNone(merged)
        self.assertTrue(any("locked decision was dropped" in r for r in reasons), reasons)
        # A fact whose `new` the body never states removes nothing (strict validate then rejects).
        unapplied = {"old": rule[2:], "new": "Gateway binds 0.0.0.0 behind the tunnel"}
        r = section_reply(rel, {"Guardrails": [rule]}, facts=[unapplied])
        self.assertEqual(sc.drop_stated_superseded(r["updated_markdown"], [unapplied])[1], [])
        reasons, merged, _, _ = distill_once(FakeLLM([r]), rel, old=old)
        self.assertIsNone(merged)
        self.assertTrue(any("still stated" in x for x in reasons), reasons)
        # A real value change that mentions a move is not a move-only fact.
        for new in ("moved to port 1235", "Gateway moved to C:\\gw"):
            self.assertEqual(len(distill.normalize_reply({**r, "superseded_facts": [{"old": "x port", "new": new}]})[0]["superseded_facts"]), 1, new)

    def test_reverted_value_across_chunks_stays_in_the_body(self):
        # Review finding: chunk 1 supersedes :1234 -> :1235, chunk 2 reverts it. The current value
        # (:1234) must not be deleted by chunk 1's (stale) fact.
        c1 = section_reply(self.T.rel, {"Key Paths": ["- LM Studio on :1235"]}, facts=[{"old": "LM Studio on :1234", "new": "LM Studio on :1235"}])
        c2 = section_reply(self.T.rel, {"Key Paths": ["- LM Studio on :1234"]}, facts=[{"old": "LM Studio on :1235", "new": "LM Studio on :1234"}])
        base = sc.Scroll(self.T.scroll_id, "project", NOW_ISO, 1, ["arch-2026-11-18-01"], [], sc.template_body(self.T))
        reasons, merged, _, _ = distill_once(FakeLLM([c1, c2]), self.T.rel, old=base, text="y" * 11000 + "\n" + "z" * 11000)
        self.assertEqual(reasons, [])
        self.assertEqual(sc.section_bullets(merged.body, ["Key Paths"]), ["- LM Studio on :1234"])
        self.assertEqual(len(sc.section_bullets(merged.body, [sc.SUPERSEDED])), 2)
        self.assertEqual(sc.unreverted_facts([{"old": "a1234", "new": "b1235"}, {"old": "b1235", "new": "a1234"}]), [{"old": "b1235", "new": "a1234"}])
        # A reverted fact never excuses dropping the (current again) locked bullet.
        old = sc.Scroll(self.T.scroll_id, "project", NOW_ISO, 1, [], [], section_reply(self.T.rel, {"Locked Decisions": ["- LM Studio on :1234"]})["updated_markdown"])
        facts = [{"old": "LM Studio on :1234", "new": "LM Studio on :1235"}, {"old": "LM Studio on :1235", "new": "LM Studio on :1234"}]
        self.assertTrue(any("locked decision was dropped" in e for e in sc.body_errors(self.T, old, section_reply(self.T.rel, {})["updated_markdown"], facts, [], [])))

    def test_prompt_echo_keeps_paraphrased_user_rules_paths_and_edited_bullets(self):
        # Review findings: a paraphrased user rule that overlaps a distiller rule, a meta-worded
        # fact the batch states, a path-bearing fact with a meta term, and an old locked bullet the
        # model edited in place are all kept; real echoes are still stripped.
        echoes = [
            "- **Security Policy**: Never write secrets, keys, tokens, passwords or .env values (e.g., `api_key`, raw keys).",
            "- Compress older detail; never drop locked decisions.",
            "- **Scroll ID Format**: `proj-{project-name}`",
        ]
        chunk = "\n".join([
            "tony: don't ever put my API keys or secrets into the memory files",
            "tony: and never lose decisions when you compress the scrolls",
            "user: archive ids look like arch-YYYY-MM-DD-NN and the host assigns them",
            "user: after we write a scroll, push its entities to the knowledge graph json in ai-hub memory",
        ])
        keeps = [
            "- Never write secrets or API keys to memory",
            "- Never drop decisions when compressing scrolls",
            "- Archive ID format: arch-YYYY-MM-DD-NN (host-assigned)",
            "- Memory Scrolls upsert graph entities into C:\\ai-hub\\memory\\knowledge-graph.json after each write",
        ]
        md = section_reply(self.T.rel, {"Locked Decisions": echoes + keeps})["updated_markdown"]
        body, removed = distill.strip_prompt_echo(md, [chunk, ""], "")
        self.assertEqual(removed, echoes)
        for k in keeps:
            self.assertIn(k, body)
        # A path line is kept even with no source support; the observation stripper agrees.
        self.assertEqual(distill.strip_prompt_echo(section_reply(self.T.rel, {"Locked Decisions": [keeps[3]]})["updated_markdown"], [], "")[1], [])
        ents, gone = distill.strip_echo_observations([{"name": "KG", "entityType": "path", "observations": [keeps[3][2:]]}], [], "")
        self.assertEqual((len(ents), gone), (1, []))
        # An old locked bullet edited in place (rule 1) is not stripped, so the reply is accepted.
        old_line = "- Superseded facts go under ## Superseded Decisions with the archive id"
        old = sc.Scroll(self.T.scroll_id, "project", NOW_ISO, 1, ["arch-2026-11-18-01"], [], section_reply(self.T.rel, {"Locked Decisions": [old_line]})["updated_markdown"])
        edited = section_reply(self.T.rel, {"Locked Decisions": [old_line + " (locked)"]})
        reasons, merged, _, _ = distill_once(FakeLLM([edited]), self.T.rel, old=old)
        self.assertEqual(reasons, [])
        self.assertIn(old_line + " (locked)", merged.body)

    def test_soft_compress_budget_tracks_frontmatter(self):
        # Review finding: on a mature scroll (many source_archive_ids) the fixed BUDGET let a reply
        # that met it still merge over TARGET_BYTES, and the retry hint asked for a size it met.
        rel = "core/identity_and_preferences.md"
        t = sc.target_info(rel)
        ids = [f"arch-2026-10-{d:02d}-01" for d in range(1, 21)]
        bb = distill.body_budget(t, sc.Scroll(t.scroll_id, "core", NOW_ISO, 20, ids, [], "x"), "arch-2026-11-19-01", NOW_ISO)
        self.assertLess(bb, distill.BUDGET)
        self.assertEqual(distill.body_budget(t, None, "arch-2026-11-19-01", NOW_ISO), distill.BUDGET)
        fits = section_reply(rel, {"Identity": [f"- fact {i:03d} " + "w" * 40 for i in range(38)]})
        self.assertLess(len(fits["updated_markdown"].encode("utf-8")), bb)
        old = sc.Scroll(t.scroll_id, "core", NOW_ISO, 20, ids, [], fits["updated_markdown"])
        llm = FakeLLM([fits, fits])
        reasons, merged, _, _ = distill_once(llm, rel, old=old)
        self.assertEqual(reasons, [])
        self.assertEqual(len(llm.calls), 1, "a reply under the per-target budget fits: no soft retry")
        self.assertLessEqual(sc.size_of(merged), sc.TARGET_BYTES)
        self.assertIn(f"BUDGET: {bb} bytes", llm.calls[0][1]["content"])
        # Over it: the retry hint asks for less than the reply's own size.
        over = section_reply(rel, {"Identity": [f"- fact {i:03d} " + "w" * 40 for i in range(50)]})
        md = len(over["updated_markdown"].encode("utf-8"))
        llm = FakeLLM([over, over])
        distill_once(llm, rel, old=old)
        self.assertEqual(len(llm.calls), 2)
        hint = next(x for x in llm.calls[1][1]["content"].split("\n") if "rewrite it under" in x)
        want = int(re.search(r"rewrite it under (\d+) bytes", hint).group(1))
        self.assertIn(f"was {md} bytes", hint)
        self.assertLess(want, md)

    def test_warnings_survive_budget_spent_and_cut_off_retry(self):
        # Review finding: chunk 0's normalisation warnings were lost when chunk 1 raised.
        c1 = section_reply(self.T.rel, {"Key Paths": ["- Repo: D:\\x"]}, entities=[{"name": "A", "entityType": "agent", "observations": []}])
        tw: list = []
        with self.assertRaises(compact.BudgetSpent):
            compact.distill_target(FakeLLM([c1]), self.T, None, "y" * 11000 + "\n" + "z" * 11000, "arch-2026-11-19-01", NOW_ISO, [], {}, {"used": 0, "max": 1, "save": lambda: None}, tw)
        self.assertEqual(tw, ["proj-agentic-os: entityType 'agent'->'tool' x1"])

        def boom(messages):
            raise OSError("connection reset")

        tw = []
        with self.assertRaises(OSError):
            compact.distill_target(FakeLLM([c1, boom]), self.T, None, "y" * 11000 + "\n" + "z" * 11000, "arch-2026-11-19-01", NOW_ISO, [], {}, {"used": 0, "max": 4, "save": lambda: None}, tw)
        self.assertTrue(any("'agent'->'tool'" in w for w in tw), tw)
        # A soft compress retry cut off at the token limit says so.
        big = valid_reply(self.T.rel, [f"- bullet {i:03d} " + "w" * 40 for i in range(66)])
        reasons, merged, _, warnings = distill_once(FakeLLM([big, "{"], finishes=["stop", "length"]), self.T.rel)
        self.assertEqual(reasons, [])
        self.assertTrue(any("compress retry cut off at the token limit" in w for w in warnings), warnings)

    def test_unlogged_superseded_lines_pruned(self):
        rel = "core/architecture_decisions.md"
        t = sc.target_info(rel)
        kept_log = "- 2026-11-18: Whisper on 8177 -> Whisper on 8178 (arch-2026-11-18-01)"
        old = sc.Scroll(t.scroll_id, "core", NOW_ISO, 1, ["arch-2026-11-18-01"], [], section_reply(rel, {"Ports & Services": ["- LM Studio: port 1234", "- Whisper STT: port 8178"], sc.SUPERSEDED: [kept_log]})["updated_markdown"])
        fact = {"old": "LM Studio: port 1234", "new": "LM Studio: port 1235", "reason": "moved"}
        reply = section_reply(rel, {
            "Ports & Services": ["- LM Studio: port 1235", "- Whisper STT: port 8178"],
            sc.SUPERSEDED: [
                kept_log,
                "- 2026-11-19: LM Studio port changed from 1234 to 1235 (arch-2026-11-19-01)",
                "- 2026-11-19: Consolidated agent roles into Locked Design Decisions.",
                "- `- 2026-11-19: Empty scroll -> Populated with infrastructure decisions (arch-2026-11-19-01)`",
            ],
        }, facts=[fact])
        body, pruned = sc.prune_superseded_log(reply["updated_markdown"], [fact], old.body)
        self.assertEqual(len(pruned), 3, pruned)
        self.assertIn(kept_log, body)
        reasons, merged, _, warnings = distill_once(FakeLLM([reply]), rel, old=old)
        self.assertEqual(reasons, [])
        self.assertEqual(sc.section_bullets(merged.body, [sc.SUPERSEDED]), [kept_log, "- 2026-11-19: LM Studio: port 1234 -> LM Studio: port 1235 (arch-2026-11-19-01)"])
        # A model-written line for a real fact is kept (and not duplicated).
        good = section_reply(rel, {"Ports & Services": ["- LM Studio: port 1235"], sc.SUPERSEDED: ["- 2026-11-19: LM Studio: port 1234 -> LM Studio: port 1235 (arch-2026-11-19-01)"]}, facts=[fact])
        self.assertEqual(sc.prune_superseded_log(good["updated_markdown"], [fact], "")[1], [])

    def test_data_protecting_rejections_still_reject(self):
        # Every check that protects data survives normalisation, echo stripping and pruning.
        r = valid_reply(self.T.rel)
        for target in ("projects/../core/identity_and_preferences.md", "../../outside.md", "projects/booking.md", "C:/ai-hub/memory/scrolls/projects/x.md"):
            reasons, merged, _, _ = distill_once(FakeLLM([{**r, "target_scroll": target}]), self.T.rel)
            self.assertIsNone(merged, target)
            self.assertTrue(any("not an allowed target" in x for x in reasons), (target, reasons))
        # Missing target / body keys are not "repaired".
        for k in ("target_scroll", "updated_markdown"):
            reasons, merged, _, _ = distill_once(FakeLLM([{x: v for x, v in r.items() if x != k}]), self.T.rel)
            self.assertIsNone(merged, k)
        # Frontmatter: a disagreeing block in the body is rejected; a scroll missing keys does not parse.
        fm = sc.render(sc.Scroll("proj-other", "project", NOW_ISO, 1, [], [], "x")).split("x\n")[0]
        reasons, merged, _, _ = distill_once(FakeLLM([{**r, "updated_markdown": fm + r["updated_markdown"]}]), self.T.rel)
        self.assertIsNone(merged)
        self.assertTrue(any("frontmatter" in x for x in reasons), reasons)
        with self.assertRaises(ScrollError):
            sc.parse(sc.render(sc.Scroll(self.T.scroll_id, "project", NOW_ISO, 1, [], [], "# x\n")).replace("version: 1\n", ""))
        # A dropped locked bullet is rejected, even when the fact that names it is malformed (dropped).
        old = MergeTests().old_scroll()
        keeps_booking = valid_reply(self.T.rel, ["- Booking is never touched"])
        ok = valid_reply(self.T.rel, ["- Booking is never touched", "- LM Studio serves on port 1235"])
        good_fact = [{"old": "LM Studio serves on port 1234", "new": "LM Studio serves on port 1235"}]
        self.assertEqual(distill_once(FakeLLM([{**ok, "superseded_facts": good_fact}]), self.T.rel, old=old)[0], [], "control: a valid fact is accepted")
        for facts in ([], ["LM Studio serves on port 1234"], [{"old": "LM Studio serves on port 1234", "new": "x" * 301}], [{"old": "LM Studio serves on port 1234", "new": "LM Studio serves on port 1234"}]):
            reasons, merged, _, _ = distill_once(FakeLLM([{**keeps_booking, "superseded_facts": facts}]), self.T.rel, old=old)
            self.assertIsNone(merged, facts)
            self.assertTrue(any("locked decision was dropped" in x for x in reasons), (facts, reasons))
        # Secrets in the body.
        reasons, merged, _, _ = distill_once(FakeLLM([{**r, "updated_markdown": r["updated_markdown"] + f"\n- key {SENTINEL_KEY}"}]), self.T.rel, known=[SENTINEL_KEY])
        self.assertIsNone(merged)
        self.assertTrue(any("secret" in x for x in reasons), reasons)
        # Hard size cap (after the one compress retry).
        big = valid_reply(self.T.rel, [f"- bullet {i:03d} " + "w" * 40 for i in range(120)])
        llm = FakeLLM([big, big])
        reasons, merged, _, _ = distill_once(llm, self.T.rel)
        self.assertIsNone(merged)
        self.assertTrue(reasons[0].startswith(sc.TOO_LARGE))
        self.assertEqual(len(llm.calls), 2)

    def test_prompt_budget_below_target(self):
        fm = len(sc.render(sc.Scroll(self.T.scroll_id, "project", NOW_ISO, 99, [f"arch-2026-11-{d:02d}-01" for d in range(1, 4)], [], "")).encode("utf-8"))
        self.assertLess(distill.BUDGET + fm + 120, sc.TARGET_BYTES)
        msgs = distill.build_messages(self.T, [self.T.rel], "arch-2026-11-19-01", "2026-11-19", "cur", "batch", "qwen/qwen3.5-9b")
        self.assertIn(f"BUDGET: {distill.BUDGET} bytes", msgs[1]["content"])
        self.assertIn("SECTION LIMITS: at most 6 bullets per section", msgs[1]["content"])
        self.assertIn("never a changelog", msgs[0]["content"])
        self.assertIn("do not restate them", msgs[0]["content"])
        self.assertEqual(msgs[0]["content"].splitlines()[-1], "/no_think")

    def test_soft_compress_retry_over_target(self):
        big = valid_reply(self.T.rel, [f"- bullet {i:03d} " + "w" * 40 for i in range(66)])
        small = valid_reply(self.T.rel, [f"- bullet {i:03d} " + "w" * 40 for i in range(40)])
        self.assertTrue(3500 < len(big["updated_markdown"]) < 4400 and len(small["updated_markdown"]) < 2700)
        llm = FakeLLM([big, small])
        reasons, merged, _, warnings = distill_once(llm, self.T.rel)
        self.assertEqual(reasons, [])
        self.assertEqual(len(llm.calls), 2)
        self.assertLess(sc.size_of(merged), sc.TARGET_BYTES)
        self.assertIn("rewrite it under", llm.calls[1][1]["content"])
        self.assertTrue(any("compress retry accepted" in w for w in warnings), warnings)
        # An invalid retry (or a not-smaller one) never loses the first valid result.
        for second in ({**small, "updated_markdown": small["updated_markdown"].replace("## Key Paths\n", "")}, "not json", big):
            llm = FakeLLM([big, second])
            reasons, merged, _, warnings = distill_once(llm, self.T.rel)
            self.assertEqual(reasons, [], second if isinstance(second, str) else "")
            self.assertEqual(len(llm.calls), 2)
            self.assertGreater(sc.size_of(merged), sc.TARGET_BYTES)
            self.assertTrue(any("kept the first reply" in w for w in warnings), warnings)
            self.assertTrue(any("bytes (target" in w for w in warnings), warnings)
        # No spare call (budget, later chunks or calls reserved for later targets): no retry.
        for budget in ({"used": 0, "max": 1, "save": lambda: None}, {"used": 0, "max": 3, "reserve": 2, "save": lambda: None}):
            llm = FakeLLM([big, small])
            reasons, merged, _, warnings = distill_once(llm, self.T.rel, budget=budget)
            self.assertEqual(reasons, [])
            self.assertEqual(len(llm.calls), 1)
            self.assertGreater(sc.size_of(merged), sc.TARGET_BYTES)

    def test_length_finish_reason_retried_once(self):
        r = valid_reply(self.T.rel)
        truncated = json.dumps(r)[:120]
        llm = FakeLLM([truncated, r], finishes=["length", "stop"])
        reasons, merged, _, _ = distill_once(llm, self.T.rel)
        self.assertEqual(reasons, [])
        self.assertIsNotNone(merged)
        self.assertEqual(len(llm.calls), 2)
        self.assertIn("cut off at the token limit", llm.calls[1][1]["content"])
        llm = FakeLLM([truncated, truncated], finishes=["length", "length"])
        reasons, merged, _, _ = distill_once(llm, self.T.rel)
        self.assertIsNone(merged)
        self.assertEqual(len(llm.calls), 2)
        self.assertIn("token limit", reasons[0])

    def test_shape_errors_list_every_entity_error(self):
        r = valid_reply(self.T.rel)
        ents = [{"name": "A", "entityType": "agent", "observations": []}, {"name": "B", "entityType": "tool", "observations": []}, {"name": "C", "entityType": "pattern", "observations": ["x" * 201]}, "junk"]
        errs = sc.shape_errors({**r, "graph_entities_to_upsert": ents})
        self.assertEqual(len(errs), 4, errs)
        self.assertIn("entity 1 (A): bad entityType agent", errs)
        self.assertIn("entity 3 (C): bad entityType pattern", errs)
        self.assertTrue(any(e.startswith("entity 3 (C): observations") for e in errs))
        self.assertTrue(any(e.startswith("entity 4:") for e in errs))


# ── 7b. repair retry, extractive noise filter, prompt guidance ──────────────


class RepairRetryTests(unittest.TestCase):
    T = sc.target_info("projects/agentic-os.md")

    def run_target(self, llm, old=None, budget=None, known=(), text="Concept: x"):
        repairs, events = [], []
        budget = budget if budget is not None else {"used": 0, "max": 4, "save": lambda: None}
        reasons, merged, ents, warnings = compact.distill_target(llm, self.T, old, text, "arch-2026-11-19-01", NOW_ISO, list(known), {}, budget, [], repairs, events.append)
        return reasons, merged, warnings, repairs, events

    def test_missing_key_repaired_once(self):
        # Live 2026-11-19 (project, last chunk): the body came back under target_scroll.
        good = valid_reply(self.T.rel, ["- Gateway restarts after a cache clear"])
        swapped = {"target_scroll": good["updated_markdown"], "graph_entities_to_upsert": [], "superseded_facts": []}
        llm = FakeLLM([swapped, good])
        reasons, merged, warnings, repairs, events = self.run_target(llm)
        self.assertEqual(reasons, [])
        self.assertIn("Gateway restarts after a cache clear", merged.body)
        self.assertEqual(len(llm.calls), 2)
        prompt = llm.calls[1][1]["content"]
        self.assertIn("REPAIR: the host validator rejected your last reply", prompt)
        self.assertIn("missing updated_markdown", prompt)
        self.assertIn("exactly the TARGET path", prompt)
        self.assertIn("<<<DATA YOUR REJECTED REPLY", prompt)
        self.assertEqual(llm.calls[1][0], llm.calls[0][0], "same system prompt")
        self.assertEqual([(r["chunk"], r["kind"], r["outcome"]) for r in repairs], [(1, "repair", "accepted")])
        self.assertEqual(events, [{"event": "repair", **repairs[0]}])
        self.assertTrue(any("repair retry of chunk 1/1 accepted" in w for w in warnings), warnings)

    def test_repair_validated_as_strictly_as_the_first_reply(self):
        old = MergeTests().old_scroll()
        fact = [{"old": "LM Studio serves on port 1234", "new": "LM Studio serves on port 1235"}]
        # Live 2026-11-19 (architecture): a superseded value restated in a longer line.
        stated = {**valid_reply(self.T.rel, ["- Booking is never touched", "- LM Studio serves on port 1235", "- note: LM Studio serves on port 1234 for legacy tools"]), "superseded_facts": fact}
        fixed = {**valid_reply(self.T.rel, ["- Booking is never touched", "- LM Studio serves on port 1235"]), "superseded_facts": fact}
        reasons, merged, _, repairs, _ = self.run_target(FakeLLM([stated, fixed]), old=old)
        self.assertEqual(reasons, [])
        self.assertIn("port 1234 -> LM Studio serves on port 1235", merged.body)
        self.assertEqual(repairs[0]["errors"], ["a superseded fact is still stated outside ## Superseded Decisions"])
        # The same problem again: rejected, first reply's reasons returned, nothing merged.
        llm = FakeLLM([stated, stated])
        reasons, merged, warnings, repairs, _ = self.run_target(llm, old=old)
        self.assertIsNone(merged)
        self.assertEqual(reasons, ["a superseded fact is still stated outside ## Superseded Decisions"])
        self.assertEqual(len(llm.calls), 2, "one repair per chunk, never more")
        self.assertEqual(repairs[0]["outcome"], "rejected")
        self.assertIn("Delete every line outside ## Superseded Decisions", llm.calls[1][1]["content"])
        # A repair that drops a locked bullet is rejected too (no loosening on the retry).
        dropped = {**valid_reply(self.T.rel, ["- LM Studio serves on port 1235"]), "superseded_facts": []}
        reasons, merged, _, repairs, _ = self.run_target(FakeLLM([stated, dropped]), old=old)
        self.assertIsNone(merged)
        self.assertEqual(repairs[0]["outcome"], "rejected")
        self.assertTrue(any("locked decision was dropped" in x for x in repairs[0]["result_errors"]), repairs)

    def test_each_model_fixable_reason_gets_one_repair(self):
        old = MergeTests().old_scroll()
        good = valid_reply(self.T.rel, ["- Booking is never touched", "- LM Studio serves on port 1234"])
        cases = {
            "not json": ("Sure! Here is the scroll.", "one JSON object and nothing else"),
            "locked dropped": (valid_reply(self.T.rel, ["- LM Studio serves on port 1234"]), "Keep every Locked/Standing bullet"),
            "bad target": ({**good, "target_scroll": "projects/other.md"}, "exactly the TARGET path"),
            "missing heading": ({**good, "updated_markdown": good["updated_markdown"].replace("## Key Paths\n", "")}, "Use exactly the HEADINGS"),
            "too large": (valid_reply(self.T.rel, ["- Booking is never touched", "- LM Studio serves on port 1234"] + [f"- bullet {i:03d} " + "w" * 40 for i in range(120)]), "Compress under 3 KB"),
        }
        for name, (first, advice) in cases.items():
            llm = FakeLLM([first, good])
            reasons, merged, _, repairs, _ = self.run_target(llm, old=old)
            self.assertEqual(reasons, [], name)
            self.assertIsNotNone(merged, name)
            self.assertEqual(len(llm.calls), 2, name)
            self.assertIn(advice, llm.calls[1][1]["content"], name)
            self.assertEqual(repairs[0]["outcome"], "accepted", name)

    def test_secret_reply_never_repaired_or_echoed(self):
        r = valid_reply(self.T.rel)
        llm = FakeLLM([{**r, "updated_markdown": r["updated_markdown"] + f"\n- key {SENTINEL_KEY}"}, r])
        reasons, merged, _, repairs, _ = self.run_target(llm, known=[SENTINEL_KEY])
        self.assertIsNone(merged)
        self.assertEqual(reasons, [compact.SECRET_IN_REPLY])
        self.assertEqual(len(llm.calls), 1)
        self.assertEqual(repairs, [])
        # Errors and the rejected reply are scrubbed and capped in a repair prompt.
        reasons = [f"reason {i} {SENTINEL_KEY} " + "x" * 300 for i in range(9)]
        hint = distill.repair_hint(reasons, [SENTINEL_KEY], "y" * 9000 + SENTINEL_KEY)
        self.assertNotIn(SENTINEL_KEY, hint)
        errs = distill.repair_errors(reasons, [SENTINEL_KEY])
        self.assertEqual(len(errs), distill.REPAIR_MAX_ERRORS + 1)
        self.assertEqual(errs[-1], "(+3 more)")
        self.assertTrue(all(len(e) <= distill.REPAIR_ERROR_CHARS for e in errs))
        self.assertIn("[... cut]", hint)
        self.assertLess(len(hint), distill.REPAIR_ECHO_CHARS + 2500)
        self.assertFalse(distill.repairable([compact.SECRET_IN_REPLY]))

    def test_repair_needs_a_spare_call(self):
        swapped = {"target_scroll": valid_reply(self.T.rel)["updated_markdown"], "graph_entities_to_upsert": [], "superseded_facts": []}
        # Calls reserved for later targets (or later chunks of this one) are never spent on a repair.
        for budget in ({"used": 0, "max": 1, "save": lambda: None}, {"used": 0, "max": 2, "reserve": 1, "save": lambda: None}):
            llm = FakeLLM([swapped, valid_reply(self.T.rel)])
            reasons, merged, warnings, repairs, events = self.run_target(llm, budget=budget)
            self.assertIsNone(merged)
            self.assertEqual(len(llm.calls), 1)
            self.assertEqual([r["outcome"] for r in repairs], ["skipped_no_budget"])
            self.assertEqual(events[0]["outcome"], "skipped_no_budget")
            self.assertTrue(any("no spare LLM call to repair" in w for w in warnings), warnings)
        budget = {"used": 0, "max": 3, "reserve": 1, "save": lambda: None}
        reasons, merged, _, _, _ = self.run_target(FakeLLM([swapped, valid_reply(self.T.rel)]), budget=budget)
        self.assertEqual(reasons, [])
        self.assertEqual(budget["used"], 2, "the repair counts against the call budget")

    def test_archive_tag_only_fact_is_a_no_op(self):
        # Live 2026-11-19 (architecture): {"old": X, "new": X + " (arch-pending)"} kept X in the body.
        rel = "core/architecture_decisions.md"
        line = "No sending, no money, no keys/tokens in prompts, no Git model files."
        reply = section_reply(rel, {"Guardrails": [f"- **NEVER Rules**: {line}"], sc.SUPERSEDED: [f"- 2026-11-19: {line} -> {line[:-1]} (arch-pending)"]}, facts=[{"old": line, "new": line[:-1] + " (arch-pending)", "reason": "moved"}])
        llm = FakeLLM([reply])
        reasons, merged, _, warnings = distill_once(llm, rel)
        self.assertEqual(reasons, [])
        self.assertEqual(len(llm.calls), 1)
        self.assertEqual(sc.section_bullets(merged.body, [sc.SUPERSEDED]), [])
        self.assertIn(line, merged.body)
        self.assertTrue(any("old == new" in w for w in warnings), warnings)
        # A real change next to an archive tag is still a change.
        _, facts_w = distill.normalize_reply({**reply, "superseded_facts": [{"old": "LM Studio on 1234", "new": "LM Studio on 1235 (arch-pending)"}]})
        self.assertFalse(any("old == new" in w for w in facts_w), facts_w)

    def test_shape_error_names_the_missing_key(self):
        r = valid_reply(self.T.rel)
        errs = sc.shape_errors({k: v for k, v in r.items() if k != "updated_markdown"})
        self.assertEqual(len(errs), 1)
        self.assertIn("(missing updated_markdown)", errs[0])
        self.assertTrue(errs[0].startswith("reply keys must be exactly"))

    def test_pending_note_never_survives_a_model_reply(self):
        r = valid_reply(self.T.rel)
        body = r["updated_markdown"].replace("## Current Milestone", distill.PENDING_NOTE + "\n\n## Current Milestone")
        reasons, merged, _, _ = distill_once(FakeLLM([{**r, "updated_markdown": body}]), self.T.rel)
        self.assertEqual(reasons, [])
        self.assertNotIn("Pending distillation", merged.body)


class PromptGuidanceTests(unittest.TestCase):
    def test_superseded_status_and_recency_rules(self):
        p = distill.DISTILL_SYSTEM
        self.assertIn("never a status change", p)
        self.assertIn("no transient status lines", p)
        self.assertIn("prefer the most recent dated source", p)
        self.assertIn("mark stale, outdated, deprecated or replaced", p)
        # No hard-coded facts about the user's environment.
        for word in ("Windows", "Linux", "WSL", "Ubuntu", "Nic"):
            self.assertNotIn(word, p)
        # The new rules are prompt-echo clauses too.
        self.assertTrue(any(distill._content_words("status change transient") <= c for c in distill._CLAUSE_WORDS), "rule 10 is its own clause")


class ExtractiveNoiseTests(unittest.TestCase):
    PROJ = sc.target_info("projects/agentic-os.md")
    ARCH = sc.target_info("core/architecture_decisions.md")

    NOISE = [
        {"kind": "training_log", "ts": "", "text": json.dumps({"upstream": "Yo, what's going on, Tony?", "downstream": "What's good? Just chilling, ready to handle whatever on port 1235."})},
        {"kind": "training_log", "ts": "", "text": json.dumps({"upstream": "can you check my last email on Gmail?", "downstream": "You got it, your latest unread email from a vendor about their new file request tool."})},
        {"kind": "gateway_chat", "ts": "", "text": "assistant: Got it. Switched you over so we can get that show on the road. What's up with the docs?"},
        {"kind": "gateway_chat", "ts": "", "text": "assistant: It's from the vendor; they're rolling out a new tool and ask you to check your settings by Monday."},
        {"kind": "rag_chat", "ts": "", "text": "\n".join([
            "assistant: The user is asking if I can hear them, which is a simple greeting without any actionable request.",
            "No need to propose an action here, but I must adhere to the rule about not acting without confirmation in C:\\x.",
            '"role": "general",',
            "- mutating = false (this is just a conversation check)",
            "Thinking Process:",
            "1. **Analyze the Request:**",
            "Constraints: One to three sentences max. Always propose exact action on port 8178.",
        ])},
        {"kind": "rag_chat", "ts": "", "text": "assistant: <think>Let me decide. The rule says never use port 9999.</think>Hey, can you hear me?"},
        {"kind": "turn", "ts": "", "text": "user: Hey, can you hear me?"},
        {"kind": "turn", "ts": "", "text": "relay: Okay, this model sucks though."},
        {"kind": "doc", "ts": "", "text": "Status: system stability restored after the reboot\n```\nconst x = {a: 1};\n```\n| LM Studio | :1235 |"},
    ]
    SIGNAL = [
        {"kind": "doc", "ts": "2026-11-18T10:00:00", "text": "# System\n- LM Studio serves the distiller on port 1235 only\n- Scrolls live in C:\\ai-hub\\memory\\scrolls\n- Never commit keys or tokens to the repo"},
        {"kind": "turn", "ts": "2026-11-19T10:00:00", "text": "user: the vite build broke again; fix: pin vite 5 in package.json"},
    ]

    def body(self, t, records, **kw):
        stats = {}
        return distill.extractive_body(t, records, "arch-pending", [], stats=stats, **kw), stats

    def test_noise_dropped_signal_kept_nothing_locked(self):
        body, stats = self.body(self.PROJ, self.NOISE + self.SIGNAL)
        for bad in ("chilling", "email", "vendor", "user is asking", "Thinking Process", "Analyze the Request", '"role"', "mutating", "can you hear",
                    "Constraints", "Let me", "9999", "8178", "model sucks", "show on the road", "stability restored", "const x", "| LM Studio"):
            self.assertNotIn(bad, body, bad)
        self.assertIn("LM Studio serves the distiller on port 1235 only", body)
        self.assertIn("C:\\ai-hub\\memory\\scrolls", body)
        self.assertIn("Never commit keys or tokens to the repo", body)
        self.assertIn("pin vite 5", body)
        self.assertEqual(sc.section_bullets(body, sc.LOCKED_HEADINGS), [], "extractive mode never locks a decision")
        self.assertIn(distill.EXTRACTIVE_NOTE, body)
        self.assertNotIn(distill.PENDING_NOTE, body)
        self.assertEqual(stats["kept"], 4)
        self.assertFalse(stats["pending"])
        reply = {"target_scroll": self.PROJ.rel, "updated_markdown": body, "graph_entities_to_upsert": [], "superseded_facts": []}
        self.assertEqual(sc.validate(self.PROJ, None, reply, [self.PROJ.rel], "arch-2026-11-19-01", NOW_ISO)[0], [])
        # Architecture: a rule goes to Guardrails, never to Locked Design Decisions.
        body, _ = self.body(self.ARCH, self.SIGNAL)
        self.assertIn("Never commit keys", "\n".join(sc.section_bullets(body, ["Guardrails"])))
        self.assertEqual(sc.section_bullets(body, sc.LOCKED_HEADINGS), [])

    def test_too_little_signal_is_pending_not_noise(self):
        body, stats = self.body(self.PROJ, self.NOISE)
        self.assertTrue(stats["pending"])
        self.assertIn(distill.PENDING_NOTE, body)
        self.assertEqual([b for h in sc.headings_for(self.PROJ) for b in sc.section_bullets(body, [h])], [])
        reply = {"target_scroll": self.PROJ.rel, "updated_markdown": body, "graph_entities_to_upsert": [], "superseded_facts": []}
        self.assertEqual(sc.validate(self.PROJ, None, reply, [self.PROJ.rel], "arch-2026-11-19-01", NOW_ISO)[0], [])

    def test_highest_signal_and_most_recent_first(self):
        recs = [{"kind": "doc", "ts": f"2026-11-{d:02d}T00:00:00", "text": f"- Never run tool number {d:02d} without a review"} for d in range(1, 21)]
        body, stats = self.body(self.ARCH, recs, max_bullets=5)
        kept = sc.section_bullets(body, ["Guardrails"])
        self.assertEqual(len(kept), 5)
        self.assertIn("tool number 20", kept[0])
        self.assertTrue(stats["dropped"] >= 15)

    def test_noise_helpers(self):
        for s in ("upstream: hi | downstream: hello", "The user wants a short answer", "Let me check the config", "I should respond appropriately",
                  '"intent": "confirm",', "target: {\"kind\":\"agent\"}", "Got it, ready when you are", "What port does it use?",
                  "Your latest unread email from a vendor", "Status: all green", "Exit code 1"):
            self.assertTrue(distill.extractive_noise(s), s)
        for s in ("LM Studio serves on port 1235", "Gmail MCP runs on :3005 behind the gateway", "Never commit keys to the repo"):
            self.assertFalse(distill.extractive_noise(s), s)
        self.assertEqual(distill.extractive_signal("GKE Autopilot, Cloud CDN, Next.js")[0], 0)
        self.assertEqual(distill.extractive_signal("broke app.js; fixed by pinning vite")[1], "path")
        # Slash-joined words are not paths (live 2026-11-19: a casting-range line scored as a path).
        for s in ("Wide range, e.g. blue collar, angry/aggressive/psychotic, dramatic/theatrical", "Ubuntu/WSL or npx/uvx"):
            self.assertEqual(distill.extractive_signal(s)[0], 0, s)
        for s in ("Skills follow the _template/ structure", "see docs/MEMORY.md", "edit ~/.config/app"):
            self.assertEqual(distill.extractive_signal(s)[1], "path", s)


# ── 8. LM Studio transport ──────────────────────────────────────────────────


class LMStudioTests(unittest.TestCase):
    def test_loaded_model_only(self):
        lm = StubLMStudio(models=[{"id": "nomic-embed", "type": "embeddings", "state": "loaded"}, {"id": "big", "type": "llm", "state": "not-loaded"}]).start()
        try:
            self.assertIsNone(lmstudio.loaded_chat_model(lm.url + "/v1"))
            lm.models.append({"id": "qwen/qwen3.5-9b", "type": "llm", "state": "loaded"})
            self.assertEqual(lmstudio.loaded_chat_model(lm.url + "/v1"), "qwen/qwen3.5-9b")
            self.assertEqual(lm.count("GET", "/v1/models"), 0)
        finally:
            lm.stop()

    def test_live_llm_records_finish_reason_and_token_cap(self):
        sent = []

        def fake_send(url, body, timeout=0):
            sent.append(body)
            return {"choices": [{"message": {"content": "<think>x</think>{\"a\": 1}"}, "finish_reason": "length"}]}

        llm = lmstudio.LiveLLM("http://127.0.0.1:9/v1", "qwen/qwen3.5-9b")
        with mock.patch.object(lmstudio.net, "send_json", side_effect=fake_send):
            self.assertEqual(llm.chat([{"role": "user", "content": "x"}]), '{"a": 1}')
            self.assertEqual(llm.last_finish, "length")
        self.assertEqual(sent[0]["max_tokens"], 3072)
        self.assertEqual(sent[0]["model"], "qwen/qwen3.5-9b")
        with mock.patch.object(lmstudio.net, "send_json", return_value={"choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}]}):
            llm.chat([])
        self.assertEqual(llm.last_finish, "stop")

    def test_offload_max_llm_calls_flag_defaults_to_auto(self):
        p = cli.build_parser()
        self.assertIsNone(p.parse_args(["offload"]).max_llm_calls)
        self.assertEqual(p.parse_args(["offload", "--max-llm-calls", "5"]).max_llm_calls, 5)
        from memory_scrolls import offload

        self.assertIsNone(offload.OffloadOptions().max_llm_calls)
        self.assertEqual(offload.auto_llm_calls(13, 4), 17)
        self.assertEqual(offload.auto_llm_calls(40, 4), offload.MAX_AUTO_LLM_CALLS)

    def test_no_loaded_model_defers_with_zero_posts(self):
        lm = StubLMStudio(models=[]).start()
        sb = Sandbox(lm_url=lm.url + "/v1")
        try:
            sb.threads(noisy_threads())
            code, lines = sb.cli("compact", "--json", "--assume-idle")
            self.assertEqual(code, 75)
            self.assertIn("no chat model", lines[-1]["deferred"])
            self.assertEqual(lm.count("POST"), 0)
            self.assertFalse(any((sb.root / "archive").iterdir()))
        finally:
            sb.close()
            lm.stop()

    def test_gateway_lease_and_host_token(self):
        gw = StubGateway(active=True, holder="pipeline:coder").start()
        try:
            self.assertEqual(lmstudio.busy_reason({}, gw.url), "gpu busy (pipeline:coder)")
            self.assertIsNone(lmstudio.busy_reason({"AOS_GPU_SLOT_HELD": "memory · compact"}, gw.url))
            gw.active = False
            self.assertIsNone(lmstudio.busy_reason({}, gw.url))
        finally:
            gw.stop()
        self.assertIn("gateway unreachable", lmstudio.busy_reason({}, "http://127.0.0.1:9"))
        self.assertIsNone(lmstudio.busy_reason({}, "http://127.0.0.1:9", assume_idle=True))

    def test_busy_gateway_defers_cli(self):
        gw = StubGateway(active=True, holder="voice").start()
        lm = StubLMStudio(replies=auto_reply).start()
        sb = Sandbox(lm_url=lm.url + "/v1", gateway_url=gw.url)
        try:
            sb.threads(noisy_threads())
            code, lines = sb.cli("compact", "--json")
            self.assertEqual(code, 75)
            self.assertIn("gpu busy", lines[-1]["deferred"])
            self.assertEqual(lm.count("POST"), 0)
        finally:
            sb.close()
            lm.stop()
            gw.stop()

    def test_process_lock_blocks_concurrent_run(self):
        td = tempfile.TemporaryDirectory()
        try:
            a = ProcessLock(Path(td.name) / "compact.lock").acquire()
            with self.assertRaises(Deferred):
                ProcessLock(Path(td.name) / "compact.lock").acquire()
            a.release()
            ProcessLock(Path(td.name) / "compact.lock").acquire().release()
            # A lock left by a dead process is broken.
            (Path(td.name) / "compact.lock").write_text(json.dumps({"pid": 999999, "hostname": __import__("socket").gethostname(), "token": "x"}), encoding="utf-8")
            ProcessLock(Path(td.name) / "compact.lock").acquire().release()
        finally:
            td.cleanup()

    def test_process_lock_live_holder_older_than_10_min_is_not_stale(self):
        td = tempfile.TemporaryDirectory()
        try:
            p = Path(td.name) / "compact.lock"
            a = ProcessLock(p).acquire()  # this (live) process holds it
            old = time.time() - 30 * 60
            os.utime(p, (old, old))  # a long manual run: never refreshed
            with self.assertRaises(Deferred):
                ProcessLock(p).acquire()
            self.assertTrue(p.exists(), "a live holder's lock is never deleted")
            a.release()
            # A dead owner on this host is broken whatever the age; another host's lock goes by age.
            p.write_text(json.dumps({"pid": 999999, "hostname": __import__("socket").gethostname(), "token": "x"}), encoding="utf-8")
            ProcessLock(p).acquire().release()
            p.write_text(json.dumps({"pid": os.getpid(), "hostname": "other-host", "token": "x"}), encoding="utf-8")
            with self.assertRaises(Deferred):
                ProcessLock(p).acquire()
            os.utime(p, (old, old))
            ProcessLock(p).acquire().release()
            # Past the pid-reuse ceiling even a "live" pid's lock is stale.
            p.write_text(json.dumps({"pid": os.getpid(), "hostname": __import__("socket").gethostname(), "token": "x"}), encoding="utf-8")
            ancient = time.time() - 7 * 3600
            os.utime(p, (ancient, ancient))
            ProcessLock(p).acquire().release()
        finally:
            td.cleanup()


# ── 9. knowledge graph ──────────────────────────────────────────────────────


class GraphTests(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.kg = Path(self.td.name) / "knowledge-graph.json"

    def tearDown(self):
        self.td.cleanup()

    def test_absent_creates_jsonl(self):
        ents, rels = graph.scroll_graph("proj-agentic-os", "projects/agentic-os.md", [{"name": "Whisper STT", "entityType": "service", "observations": ["port 8178"]}])
        stats = graph.kg_upsert(self.kg, ents, rels)
        self.assertEqual(stats["created"], 1)
        lines = [json.loads(x) for x in self.kg.read_text(encoding="utf-8").splitlines()]
        self.assertEqual([x["type"] for x in lines], ["entity", "entity", "relation"])
        self.assertEqual(lines[2], {"type": "relation", "from": "Whisper STT", "to": "proj-agentic-os", "relationType": "documented_in"})
        stats = graph.kg_upsert(self.kg, ents, rels)
        self.assertEqual((stats["entities_added"], stats["observations_added"], stats["relations_added"]), (0, 0, 0))

    def test_existing_jsonl_preserved(self):
        original = [
            json.dumps({"type": "entity", "name": "Nic", "entityType": "person", "observations": ["prefers short acks"], "createdBy": "claude"}),
            "this line is not json",
            json.dumps({"type": "relation", "from": "Nic", "to": "Tony", "relationType": "talks_to"}),
        ]
        self.kg.write_text("\n".join(original) + "\n", encoding="utf-8")
        graph.kg_upsert(self.kg, [{"name": "Nic", "entityType": "person", "observations": ["prefers short acks", "lives in EST"]}, {"name": "Tony", "entityType": "service", "observations": []}])
        lines = self.kg.read_text(encoding="utf-8").splitlines()
        nic = json.loads(lines[0])
        self.assertEqual(nic["observations"], ["prefers short acks", "lives in EST"])
        self.assertEqual(nic["createdBy"], "claude")
        self.assertEqual(json.loads(lines[1])["name"], "Tony")
        self.assertIn("this line is not json", lines)
        self.assertIn(original[2], lines)

    def test_single_line_jsonl_and_legacy(self):
        self.kg.write_text(json.dumps({"type": "entity", "name": "A", "entityType": "tool", "observations": []}) + "\n", encoding="utf-8")
        graph.kg_upsert(self.kg, [{"name": "B", "entityType": "tool", "observations": ["x"]}])
        self.assertEqual([e["name"] for e in graph.read_entities(self.kg)], ["A", "B"])
        self.kg.write_text(json.dumps({"entities": [{"name": "A", "entityType": "tool", "observations": []}], "relations": []}, indent=2), encoding="utf-8")
        graph.kg_upsert(self.kg, [{"name": "A", "entityType": "tool", "observations": ["new"]}])
        doc = json.loads(self.kg.read_text(encoding="utf-8"))
        self.assertEqual(doc["entities"][0]["observations"], ["new"])
        self.assertIn("relations", doc)

    def test_fresh_lock_defers_and_stale_lock_is_broken(self):
        lock = Path(str(self.kg) + ".lock")
        lock.write_text(json.dumps({"pid": os.getpid(), "hostname": "other-host", "token": "t"}), encoding="utf-8")
        t0 = time.monotonic()
        with self.assertRaises(Deferred):
            graph.kg_upsert(self.kg, [{"name": "A", "entityType": "tool", "observations": []}], wait_secs=0.3)
        self.assertGreaterEqual(time.monotonic() - t0, 0.25)
        self.assertFalse(self.kg.exists())
        old = time.time() - 60
        os.utime(lock, (old, old))
        graph.kg_upsert(self.kg, [{"name": "A", "entityType": "tool", "observations": []}], wait_secs=0.3)
        self.assertTrue(self.kg.exists())
        self.assertFalse(lock.exists())
        self.assertEqual([p.name for p in self.kg.parent.iterdir() if p.name.endswith(".tmp")], [])

    def test_stale_lock_break_uses_server_memory_break_guard(self):
        lock = Path(str(self.kg) + ".lock")
        guard = Path(str(lock) + ".break")
        old = time.time() - 60
        lock.write_text(json.dumps({"pid": os.getpid(), "hostname": "other-host", "token": "t"}), encoding="utf-8")
        os.utime(lock, (old, old))
        # Another breaker (a Node server-memory) holds a fresh guard: we never remove the lock.
        guard.write_text("", encoding="utf-8")
        with self.assertRaises(Deferred):
            graph.kg_upsert(self.kg, [{"name": "A", "entityType": "tool", "observations": []}], wait_secs=0.3)
        self.assertTrue(lock.exists())
        self.assertFalse(self.kg.exists())
        # The lock was broken and re-taken by Node between our check and the remove: the re-check
        # inside the guard sees a live lock and leaves it alone.
        guard.unlink()
        node_lock = json.dumps({"pid": os.getpid(), "hostname": "other-host", "token": "node"})
        real = graph.KGLock._is_stale
        calls = {"n": 0}

        def flip(self_):
            calls["n"] += 1
            if calls["n"] == 1:
                return real(self_)
            lock.write_text(node_lock, encoding="utf-8")  # fresh mtime: Node's live lock
            return real(self_)

        with mock.patch.object(graph.KGLock, "_is_stale", flip):
            with self.assertRaises(Deferred):
                graph.kg_upsert(self.kg, [{"name": "A", "entityType": "tool", "observations": []}], wait_secs=0.3)
        self.assertEqual(lock.read_text(encoding="utf-8"), node_lock)
        self.assertFalse(guard.exists(), "our guard is always released")
        # A guard left by a crash (older than the stale window) is cleared, then the stale lock breaks.
        os.utime(lock, (old, old))
        guard.write_text("", encoding="utf-8")
        os.utime(guard, (old, old))
        graph.kg_upsert(self.kg, [{"name": "A", "entityType": "tool", "observations": []}], wait_secs=0.5)
        self.assertTrue(self.kg.exists())
        self.assertFalse(lock.exists())
        self.assertFalse(guard.exists())


# ── 10. AnythingLLM client / sync ───────────────────────────────────────────


class AllmSyncTests(unittest.TestCase):
    def setUp(self):
        self.srv = StubAllm(workspaces={"librarian": {"slug": "librarian", "documents": []}}).start()
        self.trace = RequestTrace()
        self.conn = Conn(self.srv.url, SENTINEL_KEY, self.trace)
        self.td = tempfile.TemporaryDirectory()
        self.root = Path(self.td.name) / "scrolls"
        self.T = sc.target_info("projects/agentic-os.md")

    def tearDown(self):
        self.srv.stop()
        self.td.cleanup()

    def write(self, i: int):
        _, s, _ = sc.validate(self.T, sc.read_scroll(self.root, self.T.rel), valid_reply(self.T.rel, [f"- Concept: v{i}"]), [self.T.rel], f"arch-2026-11-19-{i:02d}", NOW_ISO)
        write_scroll(self.root, self.T.rel, s, Path(self.td.name) / "h")

    def test_booking_refused_before_io(self):
        for slug in ("my-workspace", "booking"):
            with self.assertRaises(BookingRefused):
                ScrollWriter(self.conn, slug)
            with self.assertRaises(BookingRefused):
                AllmReader(self.conn).workspace(slug)
            with self.assertRaises(BookingRefused):
                AllmReader(self.conn).workspace_chats(slug)
            with self.assertRaises(BookingRefused):
                self.conn.get(f"/v1/workspace/{slug}")
        w = ScrollWriter(self.conn, "librarian")
        w.workspace = "booking"  # even a tampered writer refuses
        with self.assertRaises(BookingRefused):
            w.ingest_scroll("x", "y")
        self.assertEqual(self.srv.requests, [])

    def test_replace_flow_and_unchanged(self):
        st = state.default()
        writer = ScrollWriter(self.conn, "librarian")
        self.write(1)
        out = sync.sync_changed(writer, st, self.root, [self.T.rel], lambda: None)
        self.assertEqual(out["synced"], ["proj-agentic-os"])
        self.assertEqual(self.srv.requests, [("POST", "/api/v1/document/raw-text")])
        self.assertEqual(self.srv.bodies[0][2]["metadata"], {"title": "proj-agentic-os", "docSource": "agentic-os-scroll"})
        self.assertEqual(self.srv.bodies[0][2]["addToWorkspaces"], "librarian")
        sync.sync_changed(writer, st, self.root, [self.T.rel], lambda: None)
        self.assertEqual(len(self.srv.requests), 1, "unchanged scroll -> no request")
        self.write(2)
        sync.sync_changed(writer, st, self.root, [self.T.rel], lambda: None)
        self.assertEqual(self.srv.requests[1:], [("POST", "/api/v1/document/raw-text"), ("POST", "/api/v1/workspace/librarian/update-embeddings")])
        self.assertEqual(self.srv.bodies[2][2], {"adds": [], "deletes": ["custom-documents/raw-scroll-1.json"]})
        e = st["sync"]["proj-agentic-os"]
        self.assertEqual((e["state"], e["location"], e["orphaned"]), ("synced", "custom-documents/raw-scroll-2.json", ["custom-documents/raw-scroll-1.json"]))
        for m, p in self.srv.requests:
            self.assertNotIn("remove-documents", p)
            self.assertNotRegex(p, r"/v1/(documents|workspaces)\b")

    def test_crash_after_ingest_reconciled(self):
        st = state.default()
        writer = ScrollWriter(self.conn, "librarian")
        self.write(1)
        sync.sync_changed(writer, st, self.root, [self.T.rel], lambda: None)
        self.write(2)
        with mock.patch.object(ScrollWriter, "unembed", side_effect=RuntimeError("crash")):
            out = sync.sync_changed(writer, st, self.root, [self.T.rel], lambda: None)
        self.assertTrue(out["failed"])
        self.assertEqual(st["sync"]["proj-agentic-os"]["state"], "unembedding")
        done = sync.reconcile(writer, st, lambda: None)
        self.assertEqual(done, ["proj-agentic-os"])
        self.assertEqual(self.srv.bodies[-1][2], {"adds": [], "deletes": ["custom-documents/raw-scroll-1.json"]})
        self.assertEqual(st["sync"]["proj-agentic-os"]["state"], "synced")

    def test_no_key_pending(self):
        st = state.default()
        self.write(1)
        out = sync.sync_changed(None, st, self.root, [self.T.rel], lambda: None)
        self.assertEqual(out["pending"], ["proj-agentic-os"])
        self.assertEqual(self.srv.requests, [])
        out = sync.sync_changed(ScrollWriter(self.conn, "librarian"), st, self.root, [], lambda: None)
        self.assertEqual(out["synced"], ["proj-agentic-os"], "pending entries sync once a key exists")

    def embedded(self) -> list:
        return [d["docpath"] for d in self.srv.workspaces["librarian"]["documents"]]

    def test_ingest_that_lands_after_a_client_failure_is_unembedded_next_time(self):
        st = state.default()
        writer = ScrollWriter(self.conn, "librarian")
        self.write(1)
        sync.sync_changed(writer, st, self.root, [self.T.rel], lambda: None)  # raw-scroll-1, synced
        self.write(2)
        self.srv.fail_after_land = True  # raw-scroll-2 lands, the client sees an error
        out = sync.sync_changed(writer, st, self.root, [self.T.rel], lambda: None)
        self.assertTrue(out["failed"])
        e = st["sync"]["proj-agentic-os"]
        self.assertTrue(e.get("stray_check"))
        self.assertEqual(self.embedded(), ["custom-documents/raw-scroll-1.json", "custom-documents/raw-scroll-2.json"])
        self.srv.fail_after_land = False
        # The next run: reconcile + a retry that also removes the untracked copy.
        sync.reconcile(writer, st, lambda: None)
        self.assertEqual(e["state"], "pending")
        out = sync.sync_changed(writer, st, self.root, [], lambda: None)
        self.assertEqual(out["synced"], ["proj-agentic-os"])
        self.assertEqual(self.embedded(), ["custom-documents/raw-scroll-3.json"], "exactly one copy of the scroll stays embedded")
        self.assertEqual(e["location"], "custom-documents/raw-scroll-3.json")
        self.assertIn("custom-documents/raw-scroll-2.json", e["orphaned"])
        self.assertNotIn("stray_check", e)
        # Only GETs of the scroll workspace itself; never a listing of every workspace / document.
        for m, p in self.srv.requests:
            if m == "GET":
                self.assertEqual(p, "/api/v1/workspace/librarian")
            self.assertNotRegex(p, r"/v1/(documents|workspaces)\b|remove-documents")
        # A crash while `ingesting` (process killed: no exception seen) is handled the same way.
        st2 = state.default()
        self.write(3)
        e2 = sync._entry(st2, "proj-agentic-os")
        e2.update({"state": "ingesting", "rel": self.T.rel, "location": "custom-documents/raw-scroll-3.json"})
        self.srv.workspaces["librarian"]["documents"].append({"docpath": "custom-documents/raw-scroll-99.json", "metadata": json.dumps({"title": "proj-agentic-os", "docSource": "agentic-os-scroll"})})
        self.srv.workspaces["librarian"]["documents"].append({"docpath": "custom-documents/other.json", "metadata": json.dumps({"title": "proj-agentic-os", "docSource": "upload"})})
        sync.reconcile(writer, st2, lambda: None)
        sync.sync_changed(writer, st2, self.root, [], lambda: None)
        self.assertEqual(sorted(self.embedded()), ["custom-documents/other.json", "custom-documents/raw-scroll-4.json"], "only our own scroll docs are un-embedded")

    def test_dirty_mark_syncs_a_scroll_written_by_a_killed_run(self):
        st = state.default()
        writer = ScrollWriter(self.conn, "librarian")
        self.write(1)
        sync.sync_changed(writer, st, self.root, [self.T.rel], lambda: None)
        # A run marks the scroll, writes v2, and is killed before its sync phase.
        sync.mark_dirty(st, "proj-agentic-os", self.T.rel)
        self.write(2)
        out = sync.sync_changed(writer, st, self.root, [], lambda: None)  # next run: nothing in `changed`
        self.assertEqual(out["synced"], ["proj-agentic-os"])
        self.assertNotIn("dirty", st["sync"]["proj-agentic-os"])
        # Marked but killed BEFORE the write: content unchanged -> no request, flag cleared.
        sync.mark_dirty(st, "proj-agentic-os", self.T.rel)
        n = len(self.srv.requests)
        out = sync.sync_changed(writer, st, self.root, [], lambda: None)
        self.assertEqual(out["unchanged"], ["proj-agentic-os"])
        self.assertEqual(len(self.srv.requests), n)
        self.assertNotIn("dirty", st["sync"]["proj-agentic-os"])


# ── 11. static confinement ──────────────────────────────────────────────────

WRITE_PATTERNS = [
    r"open\([^)]*['\"][wax]b?\+?['\"]", r"\bwrite_text\(", r"\bwrite_bytes\(", r"\.unlink\(", r"os\.remove\(", r"\.rename\(",
    r"os\.replace\(", r"rmtree", r"['\"]POST['\"]", r"atomic_write", r"\.mkdir\(", r"os\.link\(", r"os\.write\(", r"os\.open\(",
]


def _code_without_docstrings(text: str) -> str:
    return re.sub(r'"""[\s\S]*?"""', "", text)


class StaticConfinementTests(unittest.TestCase):
    def test_read_only_modules_have_no_write_paths(self):
        for name in ("sources.py", "distill.py", "lmstudio.py", "scroll.py", "keys.py", "config.py", "scrub.py"):
            code = _code_without_docstrings((PKG / name).read_text(encoding="utf-8"))
            for pat in WRITE_PATTERNS:
                self.assertIsNone(re.search(pat, code), f"{name} matches {pat}")

    def test_scroll_writer_confined(self):
        for p in PKG.glob("*.py"):
            text = p.read_text(encoding="utf-8")
            if "ScrollWriter(" in text:
                self.assertIn(p.name, ("sync.py", "offload.py"), p.name)
            for banned in ("remove-documents", "/v1/documents", '/v1/workspaces"', "/v1/system"):
                self.assertNotIn(banned, text, f"{p.name} mentions {banned}")
            self.assertNotRegex(text, r"open\([^)]*\.env[^)]*['\"][wax]", p.name)
        self.assertNotRegex(_code_without_docstrings((PKG / "allm.py").read_text(encoding="utf-8")), r"def (delete|remove)")

    def test_dotenv_only_read_in_config(self):
        for p in PKG.glob("*.py"):
            text = _code_without_docstrings(p.read_text(encoding="utf-8"))
            if '".env"' in text:
                self.assertIn(p.name, ("config.py",), p.name)


# ── 12. end-to-end compaction ───────────────────────────────────────────────


class EndToEndCompactTests(unittest.TestCase):
    def setUp(self):
        self.lm = StubLMStudio(replies=auto_reply).start()
        self.allm = StubAllm(workspaces={"librarian": {"slug": "librarian", "documents": []}}).start()
        self.gw = StubGateway(active=False).start()
        self.sb = Sandbox(lm_url=self.lm.url + "/v1", allm_url=self.allm.url, gateway_url=self.gw.url)
        threads = noisy_threads()
        threads["auto"] = [turn(1794939000100, "user", f"the anythingllm key is {SENTINEL_KEY} keep it secret", "k1")]
        self.sb.threads(threads)
        make_tasks_db(self.sb.root / "tasks.db")
        self.src_before = {p: (p.stat().st_mtime, p.read_bytes()) for p in (self.sb.root / "tasks.db", self.sb.root / "data" / "command-center" / "os-threads.json")}

    def tearDown(self):
        self.sb.close()
        self.lm.stop()
        self.allm.stop()
        self.gw.stop()

    def test_dry_run_writes_nothing(self):
        before = self.sb.tree()
        code, lines = self.sb.cli("compact", "--dry-run", "--json", "--assume-idle")
        self.assertEqual(code, 0, lines)
        res = lines[-1]
        self.assertTrue(res["dry_run"])
        self.assertGreater(res["pending"]["records"], 0)
        self.assertEqual(self.sb.tree(), before)
        self.assertEqual(self.lm.count("POST"), 0)
        self.assertEqual(self.allm.requests, [])

    def test_full_run_then_noop(self):
        code, lines = self.sb.cli("compact", "--json", "--assume-idle", "--max-batches", "8")
        self.assertEqual(code, 0, lines)
        res = lines[-1]
        phases = [x["phase"] for x in lines if x.get("event") == "phase"]
        self.assertEqual(phases[:3], ["preflight", "collect", "archive"])
        self.assertEqual(res["llm"], "live")
        self.assertEqual(res["archive_ids"], ["arch-" + time.strftime("%Y-%m-%d") + "-01"])
        aid = res["archive_ids"][0]
        root = self.sb.root / "archive"
        self.assertTrue(archive.prune_allowed(root, aid))
        header, rows = archive.read_entry(root, aid)
        raw = json.dumps(rows)
        self.assertNotIn(FAKE_SECRET, raw)
        self.assertNotIn(SENTINEL_KEY, gzip.decompress((root / archive.read_manifest(root)[0]["path"]).read_bytes()).decode())
        self.assertNotIn("BOOKING-SECRET", raw)
        self.assertNotIn("system bookkeeping", raw)
        # Scrolls: architecture (8178 port) + project status-card + patterns + preferences.
        scrolls = {rel: s for rel, s, _ in sc.list_scrolls(self.sb.root / "scrolls")}
        self.assertIn("projects/status-card.md", scrolls)
        arch = scrolls.get("core/architecture_decisions.md")
        self.assertIsNotNone(arch)
        self.assertEqual((arch.version, arch.source_archive_ids), (1, [aid]))
        self.assertIn("Whisper STT runs on port 8178", arch.body)
        for rel, s in scrolls.items():
            text = sc.render(s)
            self.assertNotIn(FAKE_SECRET, text)
            self.assertLessEqual(len(text.encode()), sc.HARD_CAP_BYTES)
        # Every scroll is brand new (no prior version): it supersedes nothing, so no model-written
        # Superseded entry is logged (guards v3).
        for s in scrolls.values():
            self.assertEqual(sc.section_bullets(s.body, [sc.SUPERSEDED]), [], s.scroll_id)
        # KG + AnythingLLM.
        names = [e["name"] for e in graph.read_entities(self.sb.root / "kg" / "knowledge-graph.json")]
        self.assertIn("Whisper STT", names)
        self.assertIn("core-architecture-decisions", names)
        self.assertGreaterEqual(self.allm.count("POST", "/api/v1/document/raw-text"), len(scrolls))
        self.assertTrue(all(p.startswith(("/api/v1/document/raw-text", "/api/v1/workspace/librarian/")) for _, p in self.allm.requests))
        self.assertEqual(self.lm.max_concurrency, 1)
        self.assertEqual(self.lm.count("GET", "/v1/models"), 0)
        self.assertEqual([b["model"] for b in self.lm.chat_bodies], ["qwen/qwen3.5-9b"] * len(self.lm.chat_bodies))
        out = json.dumps(lines)
        self.assertNotIn(SENTINEL_KEY, out)
        self.assertNotIn(SENTINEL_KEY, (self.sb.root / "state" / "state.json").read_text(encoding="utf-8"))
        # Sources untouched.
        for p, (m, b) in self.src_before.items():
            self.assertEqual((p.stat().st_mtime, p.read_bytes()), (m, b), p.name)
        # Second run: nothing new -> no LM call, no new archive.
        posts = self.lm.count("POST")
        code, lines = self.sb.cli("compact", "--json", "--assume-idle")
        self.assertEqual(code, 0, lines)
        self.assertEqual(lines[-1]["archive_ids"], [])
        self.assertEqual(self.lm.count("POST"), posts)
        code, lines = self.sb.cli("status", "--json")
        self.assertEqual(lines[-1]["pending"]["records"], 0)
        self.assertEqual(lines[-1]["undistilled"], [])
        self.assertEqual(lines[-1]["unsynced"], [])

    def test_repair_events_in_ndjson(self):
        # The first distiller reply puts the body under target_scroll (live 2026-11-19); the
        # repair prompt carries the exact error and the corrected reply is used.
        seen = {"n": 0}

        def reply(messages):
            seen["n"] += 1
            r = json.loads(auto_reply(messages))
            if seen["n"] == 1:
                return json.dumps({"target_scroll": r["updated_markdown"], "graph_entities_to_upsert": [], "superseded_facts": []})
            return json.dumps(r)

        self.lm.replies = reply
        code, lines = self.sb.cli("compact", "--json", "--assume-idle", "--max-batches", "12")
        self.assertEqual(code, 0, lines)
        reps = [x for x in lines if x.get("event") == "repair"]
        self.assertEqual(len(reps), 1, reps)
        self.assertEqual((reps[0]["kind"], reps[0]["outcome"], reps[0]["chunk"]), ("repair", "accepted", 1))
        self.assertIn("missing updated_markdown", reps[0]["errors"][0])
        self.assertIn("REPAIR: the host validator rejected your last reply", self.lm.chat_bodies[1]["messages"][1]["content"])
        self.assertEqual(lines[-1]["repairs"][0]["outcome"], "accepted")
        self.assertEqual(lines[-1]["pending_targets"], 0)
        self.assertNotIn(SENTINEL_KEY, json.dumps(lines))

    def test_max_batches_resumes_and_failed_archive_stops_everything(self):
        code, lines = self.sb.cli("compact", "--json", "--assume-idle", "--max-batches", "1")
        self.assertEqual(code, 0, lines)
        self.assertEqual(lines[-1]["llm_calls"], 1)
        self.assertGreater(lines[-1]["pending_targets"], 0)
        for _ in range(6):
            code, lines = self.sb.cli("compact", "--json", "--assume-idle", "--max-batches", "1")
            if lines[-1]["pending_targets"] == 0:
                break
        self.assertEqual(lines[-1]["pending_targets"], 0)

    def test_archive_failure_runs_nothing_downstream(self):
        before_lm = self.lm.count("POST")
        with mock.patch.object(archive, "verify", side_effect=ArchiveError("injected verify failure")):
            code, lines = self.sb.cli("compact", "--json", "--assume-idle")
        self.assertEqual(code, 1)
        self.assertIn("injected verify failure", lines[-1]["error"])
        self.assertEqual(self.lm.count("POST"), before_lm)
        self.assertEqual(self.allm.requests, [])
        self.assertFalse(any((self.sb.root / "scrolls").rglob("*.md")))
        self.assertFalse((self.sb.root / "kg" / "knowledge-graph.json").exists())
        self.assertEqual(archive.read_manifest(self.sb.root / "archive"), [])
        self.assertFalse((self.sb.root / "state" / "state.json").exists(), "watermarks unchanged")

    def test_replay_and_no_key(self):
        replies = self.sb.root / "replies.json"
        replies.write_text(json.dumps([]), encoding="utf-8")
        env = dict(self.sb.env)
        env.pop("ANYTHINGLLM_API_KEY")
        self.sb.env = env
        code, lines = self.sb.cli("compact", "--json", "--replay-llm", str(replies))
        self.assertEqual(code, 0, lines)
        self.assertEqual(lines[-1]["llm"], "replay")
        self.assertEqual(self.lm.count("POST"), 0)
        self.assertEqual(self.allm.requests, [])
        self.assertTrue(lines[-1]["archive_ids"])

    def test_kill_between_write_and_done_still_syncs_and_upserts_next_run(self):
        class Killed(BaseException):  # the host's kill / timeout: no Python handler runs
            pass

        with mock.patch.object(compact, "_kg", side_effect=Killed()):
            with self.assertRaises(Killed):
                self.sb.cli("compact", "--json", "--assume-idle", "--max-batches", "8")
        written = {rel: s for rel, s, _ in sc.list_scrolls(self.sb.root / "scrolls")}
        self.assertEqual(len(written), 1, "killed right after the first scroll write")
        (rel, s), = written.items()
        st = json.loads((self.sb.root / "state" / "state.json").read_text(encoding="utf-8"))
        self.assertTrue(st["sync"][s.scroll_id]["dirty"])
        self.assertEqual([x["scroll_id"] for x in st["kg_pending"]], [s.scroll_id])
        self.assertEqual(self.allm.count("POST", "/api/v1/document/raw-text"), 0)
        self.assertFalse((self.sb.root / "state" / "compact.lock").exists())
        code, lines = self.sb.cli("status", "--json")
        self.assertIn(s.scroll_id, lines[-1]["unsynced"])
        # Next run: the archive-id guard skips the written target, yet it is synced and upserted.
        code, lines = self.sb.cli("compact", "--json", "--assume-idle", "--max-batches", "8")
        self.assertEqual(code, 0, lines)
        self.assertIn(s.scroll_id, lines[-1]["synced"])
        names = [e["name"] for e in graph.read_entities(self.sb.root / "kg" / "knowledge-graph.json")]
        self.assertIn(s.scroll_id, names)
        st = json.loads((self.sb.root / "state" / "state.json").read_text(encoding="utf-8"))
        self.assertEqual(st["kg_pending"], [])
        self.assertTrue(all(e["state"] == "synced" and not e.get("dirty") for e in st["sync"].values()))
        code, lines = self.sb.cli("status", "--json")
        self.assertEqual(lines[-1]["unsynced"], [])

    def test_kg_error_keeps_upsert_queued_without_failing_the_run(self):
        with mock.patch.object(graph, "kg_upsert", side_effect=OSError("rename failed")):
            code, lines = self.sb.cli("compact", "--json", "--assume-idle", "--max-batches", "8")
        self.assertEqual(code, 0, lines)
        self.assertTrue(any("knowledge graph" in w for w in lines[-1]["warnings"]))
        st = json.loads((self.sb.root / "state" / "state.json").read_text(encoding="utf-8"))
        self.assertTrue(st["kg_pending"])
        code, lines = self.sb.cli("compact", "--json", "--assume-idle")
        self.assertEqual(code, 0, lines)
        st = json.loads((self.sb.root / "state" / "state.json").read_text(encoding="utf-8"))
        self.assertEqual(st["kg_pending"], [])

    def test_status_json(self):
        code, lines = self.sb.cli("status", "--json")
        self.assertEqual(code, 0, lines)
        res = lines[-1]
        for k in ("pending", "threshold_hit", "archive_root", "archive_root_source", "pinned", "scrolls", "undistilled", "unsynced", "last_run", "lm"):
            self.assertIn(k, res)
        self.assertEqual(res["lm"]["loaded_model"], "qwen/qwen3.5-9b")
        self.assertGreater(res["pending"]["turns"], 0)


# ── 14. keys ────────────────────────────────────────────────────────────────


class Round2ReviewTests(unittest.TestCase):
    """Phase 3 round-2 review findings (repair loop, extractive filter, soft compress budget)."""

    T = sc.target_info("projects/agentic-os.md")

    def run_target(self, llm, old=None, budget=None, known=(), text="Concept: x"):
        repairs = []
        budget = budget if budget is not None else {"used": 0, "max": 4, "save": lambda: None}
        reasons, merged, _, warnings = compact.distill_target(llm, self.T, old, text, "arch-2026-11-19-01", NOW_ISO, list(known), {}, budget, [], repairs)
        return reasons, merged, warnings, repairs

    def test_locked_bullet_never_superseded_by_an_empty_or_removal_new(self):
        old = MergeTests().old_scroll()
        dropped = valid_reply(self.T.rel, ["- LM Studio serves on port 1234"])
        for new in ("", "  ", "removed for brevity", "compressed", "n/a", "Booking is touched by the desk agent now"):
            fact = [{"old": "Booking is never touched", "new": new, "reason": "compressed"}]
            llm = FakeLLM([dropped, {**dropped, "superseded_facts": fact}])
            reasons, merged, _, repairs = self.run_target(llm, old=old)
            self.assertIsNone(merged, repr(new))
            self.assertTrue(any("locked decision was dropped" in r for r in reasons), (new, reasons))
            self.assertEqual(repairs[0]["outcome"], "rejected", new)
            self.assertTrue(any("locked decision was dropped" in r for r in repairs[0]["result_errors"]), (new, repairs))
        prompt = llm.calls[1][1]["content"]
        self.assertNotIn("or list it in superseded_facts", prompt)
        self.assertIn("never supersede a locked bullet to shorten the scroll", prompt)
        # Control: a real change whose new value the body states still accounts for the bullet.
        changed = valid_reply(self.T.rel, ["- LM Studio serves on port 1234", "- Booking is touched by the desk agent now"])
        fact = [{"old": "Booking is never touched", "new": "Booking is touched by the desk agent now", "reason": "changed"}]
        reasons, merged, _, _ = self.run_target(FakeLLM([{**changed, "superseded_facts": fact}]), old=old)
        self.assertEqual(reasons, [])
        self.assertIn("Booking is never touched -> Booking is touched by the desk agent now", merged.body)
        # An empty `new` is dropped at normalisation with a warning.
        _, w = distill.normalize_reply({**dropped, "superseded_facts": [{"old": "x port 1", "new": ""}]})
        self.assertTrue(any("empty new" in x for x in w), w)

    def test_soft_compress_never_spends_a_later_chunks_repair_call(self):
        big = valid_reply(self.T.rel, [f"- bullet {i:03d} " + "w" * 40 for i in range(66)])
        good = valid_reply(self.T.rel, ["- Gateway restarts after a cache clear"])
        swapped = {"target_scroll": good["updated_markdown"], "graph_entities_to_upsert": [], "superseded_facts": []}
        llm = FakeLLM([big, swapped, good])
        reasons, merged, _, repairs = self.run_target(llm, budget={"used": 0, "max": 3, "reserve": 0, "save": lambda: None}, text="y" * 11000 + "\n" + "z" * 11000)
        self.assertEqual(reasons, [])
        self.assertIsNotNone(merged)
        self.assertEqual([(r["chunk"], r["kind"], r["outcome"]) for r in repairs], [(2, "repair", "accepted")])
        self.assertEqual(len(llm.calls), 3)
        # The last chunk still gets its soft compress.
        small = valid_reply(self.T.rel, [f"- bullet {i:03d} " + "w" * 40 for i in range(40)])
        llm = FakeLLM([good, big, small])
        reasons, merged, _, repairs = self.run_target(llm, budget={"used": 0, "max": 3, "reserve": 0, "save": lambda: None}, text="y" * 11000 + "\n" + "z" * 11000)
        self.assertEqual(reasons, [])
        self.assertEqual([(r["chunk"], r["kind"], r["outcome"]) for r in repairs], [(2, "soft_compress", "accepted")])

    def test_non_json_reply_with_a_secret_is_never_repaired(self):
        llm = FakeLLM([f"Sure, the key is {SENTINEL_KEY} and here is no JSON.", valid_reply(self.T.rel)])
        reasons, merged, warnings, repairs = self.run_target(llm, known=[SENTINEL_KEY])
        self.assertIsNone(merged)
        self.assertEqual(reasons, [compact.SECRET_IN_REPLY])
        self.assertEqual(len(llm.calls), 1)
        self.assertEqual(repairs, [])
        # Prose holding a secret around an otherwise-invalid JSON object: not repaired either.
        bad = json.dumps({**valid_reply(self.T.rel), "target_scroll": "projects/other.md"})
        llm = FakeLLM([f"note {SENTINEL_KEY}\n{bad}", valid_reply(self.T.rel)])
        reasons, merged, _, repairs = self.run_target(llm, known=[SENTINEL_KEY])
        self.assertIsNone(merged)
        self.assertIn(compact.SECRET_IN_REPLY, reasons)
        self.assertEqual((len(llm.calls), repairs), (1, []))
        self.assertNotIn(SENTINEL_KEY, json.dumps([reasons, warnings]))

    def test_user_turn_opening_with_let_me_keeps_its_rules(self):
        rec = {"kind": "turn", "ts": "", "text": "user: Let me lay down the rules for the stack.\nThe gateway must only bind 127.0.0.1:8787\n"
               "Never expose LM Studio port 1234 to the LAN\nScrolls always live in C:/ai-hub/memory/scrolls"}
        lines = distill._record_lines(rec, "arch-pending", [])
        for want in ("127.0.0.1:8787", "port 1234", "C:/ai-hub/memory/scrolls"):
            self.assertTrue(any(want in x for x in lines), (want, lines))
        body = distill.extractive_body(sc.target_info("core/architecture_decisions.md"), [rec], "arch-pending", [])
        self.assertNotIn("Let me lay down", body)
        self.assertIn("127.0.0.1:8787", body)
        # A model's own reply that opens with monologue is still dropped whole.
        for r in ({"kind": "rag_chat", "ts": "", "text": "assistant: Let me think.\nNever expose LM Studio port 1234", "meta": {"role": "assistant"}},
                  {"kind": "gateway_chat", "ts": "", "text": "assistant: I should respond with JSON.\nport 1234 rule"}):
            self.assertEqual(distill._record_lines(r, "arch-pending", []), [], r)
        self.assertTrue(distill._record_lines({"kind": "rag_chat", "ts": "", "text": "Let me set the rule: never expose port 1234", "meta": {"role": "user"}}, "arch-pending", []))

    def test_markdown_analysis_heading_does_not_cut_a_document(self):
        rec = {"kind": "doc", "ts": "", "text": "# Design\n- gateway binds 127.0.0.1:8787\n## Analysis\n- Never expose LM Studio port 1234\n"
               "- Scrolls live in C:/ai-hub/memory/scrolls\n- dashboard defaults to port 8000\n### Reasoning\n- Never run --apply unattended"}
        lines = distill._record_lines(rec, "arch-pending", [])
        for want in ("port 1234", "C:/ai-hub", "port 8000", "--apply"):
            self.assertTrue(any(want in x for x in lines), (want, lines))
        stats = {}
        distill.extractive_body(sc.target_info("core/architecture_decisions.md"), [rec], "arch-pending", [], stats=stats)
        self.assertFalse(stats["pending"])
        self.assertGreaterEqual(stats["kept"], 4)
        # A document still stops at an unambiguous plain-text trace header; chat records at any.
        doc = {"kind": "doc", "ts": "", "text": "- gateway binds 127.0.0.1:8787\nThinking Process:\n- port 9999 guess"}
        self.assertFalse(any("9999" in x for x in distill._record_lines(doc, "arch-pending", [])))
        chat = {"kind": "rag_chat", "ts": "", "text": "assistant: gateway binds 127.0.0.1:8787\nAnalysis:\n- port 9999 guess"}
        self.assertFalse(any("9999" in x for x in distill._record_lines(chat, "arch-pending", [])))

    def test_set_notes_matches_the_pending_flag(self):
        body = sc.template_body(self.T)
        with_note = distill.set_notes(body, True)
        self.assertIn(distill.PENDING_NOTE, with_note)
        self.assertIn(distill.EXTRACTIVE_NOTE, with_note)
        legacy = with_note.replace(distill.PENDING_NOTE, "> Pending distillation: older wording; the next model run fills this in.")
        cleared = distill.set_notes(legacy, False)
        self.assertNotIn("Pending distillation", cleared)
        self.assertEqual(cleared.count(distill.EXTRACTIVE_NOTE), 1)
        self.assertEqual(sc.h2_list(cleared), sc.h2_list(body))
        self.assertTrue(cleared.startswith(f"# {self.T.title}\n\n{distill.EXTRACTIVE_NOTE}\n\n## "), cleared[:200])


# ── C:\ai-hub write guard + D:\ai-hub-memory defaults ───────────────────────


from memory_scrolls import fsutil as _fsutil  # noqa: E402
from memory_scrolls import offload as _offload  # noqa: E402
from memory_scrolls.errors import HubWriteRefused  # noqa: E402


def _no_fs_writes():
    """Patches that turn any filesystem write into an AssertionError (so a failed guard can never
    write under the real C:\\ai-hub: the test then fails with AssertionError, not HubWriteRefused)."""
    boom = AssertionError("a write was attempted past the hub guard")
    real_open = open

    def guarded_open(file, mode="r", *a, **k):
        if any(c in mode for c in "wax+"):
            raise boom
        return real_open(file, mode, *a, **k)

    return [
        mock.patch("builtins.open", guarded_open),
        mock.patch("os.open", side_effect=boom),
        mock.patch("os.replace", side_effect=boom),
        mock.patch("os.rename", side_effect=boom),
        mock.patch("os.link", side_effect=boom),
        mock.patch("os.makedirs", side_effect=boom),
        mock.patch("os.mkdir", side_effect=boom),
        mock.patch("pathlib.Path.mkdir", side_effect=boom),
    ]


class HubWriteGuardTests(unittest.TestCase):
    HUB = r"C:\ai-hub"

    def test_hub_on_g_and_its_old_c_path_are_both_protected(self):
        for p in (r"G:\ai-hub", "g:/AI-HUB/memory/scrolls", r"\\localhost\G$\ai-hub\m", r"C:\ai-hub\memory"):
            self.assertIsNotNone(_fsutil.protected_root(p), p)
        for p in (r"G:\ai-hub-memory\scrolls", r"G:\ai-hub2", r"G:\agentic os\memory"):
            self.assertIsNone(_fsutil.protected_root(p), p)

    def test_defaults_point_at_g_memory(self):
        self.assertEqual(config.DEFAULT_SCROLLS_ROOT, r"G:\ai-hub-memory\scrolls")
        self.assertEqual(config.DEFAULT_KG_PATH, r"G:\ai-hub-memory\knowledge-graph.json")
        self.assertIsNone(_fsutil.protected_root(config.DEFAULT_SCROLLS_ROOT))
        self.assertIsNone(_fsutil.protected_root(config.DEFAULT_KG_PATH))
        sb = Sandbox()
        try:
            env = {k: v for k, v in sb.env.items() if k not in ("MEMORY_SCROLLS_DIR", "MEMORY_KG_PATH")}
            p = config.resolve({}, env, probes=config.DriveProbes(lambda r: False, lambda r: 0))
            self.assertEqual(p.scrolls_root, Path(r"G:\ai-hub-memory\scrolls"))
            self.assertEqual(p.kg_path, Path(r"G:\ai-hub-memory\knowledge-graph.json"))
        finally:
            sb.close()
        # Resolving never creates the live root (the module guard also checks this).
        self.assertEqual(REAL_D_MEMORY.exists(), _GUARD["before"]["d_memory"][0])

    @unittest.skipUnless(os.name == "nt", "Windows paths")
    def test_protected_root_detection(self):
        refused = [
            r"C:\ai-hub", r"C:\ai-hub\memory\scrolls", r"c:/AI-HUB/memory/knowledge-graph.json", r"C:\AI-Hub\\memory\\",
            r"C:\x\..\ai-hub\memory", r"\\?\C:\ai-hub\memory", r"\\.\C:\ai-hub\memory", r"C:\ai-hub." + "\\memory",
            # Admin share of C: on any host (SMB loopback, IP, forward slashes, \\?\UNC\, `..`).
            r"\\localhost\C$\ai-hub\memory", r"\\127.0.0.1\c$\ai-hub\m", "//localhost/c$/ai-hub/m",
            r"\\?\UNC\localhost\c$\ai-hub\m", r"\\.\UNC\localhost\C$\ai-hub", r"\\Server\C$\AI-HUB",
            r"\\localhost\c$\x\..\ai-hub\memory",
        ]
        allowed = [
            r"C:\ai-hub2\memory", r"C:\ai-hubx", r"D:\ai-hub-memory\scrolls", r"D:\ai-hub\memory", r"C:\ai\hub", r"D:\ai-hub-archive",
            r"\\localhost\c$\ai-hub2", r"\\localhost\d$\ai-hub-memory\scrolls", r"\\localhost\c$",
        ]
        for p in refused:
            # C:\ai-hub may be a junction to G:\ai-hub (the 2026-11-23 move), in which case the
            # resolved form matches G:\ai-hub first. Either label is a refusal; what matters is
            # that the path maps to a protected root.
            self.assertIn(_fsutil.protected_root(p), _fsutil.PROTECTED_WRITE_ROOTS, p)
            with self.assertRaises(HubWriteRefused, msg=p):
                _fsutil.refuse_protected(p)
        for p in allowed:
            self.assertIsNone(_fsutil.protected_root(p), p)
        self.assertTrue(issubclass(HubWriteRefused, ConfigError), "maps to exit 2")

    @unittest.skipUnless(os.name == "nt", "Windows paths")
    def test_config_refuses_hub_from_every_source(self):
        hub = r"C:\AI-HUB\memory"
        sb = Sandbox()
        try:
            probes = config.DriveProbes(lambda r: False, lambda r: 0)
            cases = [
                ({"scrolls_root": hub + r"\scrolls"}, {}, None),
                ({"kg_path": hub + r"\knowledge-graph.json"}, {}, None),
                ({"archive_root": hub + r"\archive"}, {}, None),
                ({"state_dir": hub + r"\state"}, {}, None),
                ({}, {"MEMORY_SCROLLS_DIR": "c:/ai-hub/memory/scrolls"}, None),
                ({}, {"MEMORY_KG_PATH": hub + r"\knowledge-graph.json"}, None),
                ({}, {"MEMORY_ARCHIVE_DIR": hub + r"\archive"}, None),
                ({}, {"MEMORY_STATE_DIR": hub + r"\state"}, None),
                ({}, {"AOS_STAGING_DIR": r"C:\ai-hub\staging"}, None),
                # The admin share of C: (any host) and its extended-length form.
                ({}, {"MEMORY_SCROLLS_DIR": r"\\localhost\C$\ai-hub\memory\scrolls"}, None),
                ({}, {"MEMORY_KG_PATH": r"\\127.0.0.1\c$\ai-hub\memory\knowledge-graph.json"}, None),
                ({}, {"MEMORY_ARCHIVE_DIR": "//localhost/c$/ai-hub/archive"}, None),
                ({"archive_root": r"\\?\UNC\localhost\c$\ai-hub\archive"}, {}, None),
                ({}, {"AOS_STAGING_DIR": r"\\Server\C$\AI-HUB\staging"}, None),
            ]
            for flags, env_over, os_json in cases:
                env = {**sb.env, **env_over}
                if os_json is not None:
                    (sb.root / "os.json").write_text(json.dumps(os_json), encoding="utf-8")
                    env.pop("MEMORY_SCROLLS_DIR", None)  # let os.json win for scrollsDir
                with self.assertRaises(HubWriteRefused, msg=(flags, env_over, os_json)):
                    config.resolve(flags, env, probes=probes)
                (sb.root / "os.json").write_text("{}", encoding="utf-8")
            # A pinned archive root (state.json) under the hub is refused too.
            if Path(self.HUB).is_dir():
                env = {k: v for k, v in sb.env.items() if k != "MEMORY_ARCHIVE_DIR"}
                with self.assertRaises(HubWriteRefused):
                    config.resolve({}, env, probes=probes, pinned=self.HUB)
            # The CLI maps it to exit 2 with a plain error and writes nothing.
            before = sb.tree()
            code, lines = sb.cli("status", "--json", extra_env={"MEMORY_SCROLLS_DIR": hub + r"\scrolls"})
            self.assertEqual(code, 2, lines)
            self.assertIn("read-only ai-hub", lines[-1]["error"])
            code, lines = sb.cli("compact", "--json", "--scrolls-root", hub + r"\scrolls")
            self.assertEqual(code, 2, lines)
            self.assertEqual(sb.tree(), before)
        finally:
            sb.close()

    @unittest.skipUnless(os.name == "nt", "Windows paths")
    def test_os_json_hub_dirs_fall_back_like_the_app(self):
        """os_core.rs `sanitized()` drops an os.json scrollsDir / archiveDir under the hub and shows the
        default; the CLI does the same (a warning, the default applies) instead of refusing every run.
        Nothing is ever written under the hub either way."""
        sb = Sandbox()
        try:
            probes = config.DriveProbes(lambda r: False, lambda r: 0)
            env = {k: v for k, v in sb.env.items() if k not in ("MEMORY_SCROLLS_DIR", "MEMORY_ARCHIVE_DIR")}
            for hub in (r"C:\AI-HUB\memory", r"\\localhost\C$\ai-hub\memory"):
                (sb.root / "os.json").write_text(json.dumps({"memory": {"scrolls": {"scrollsDir": hub + r"\scrolls", "archiveDir": hub + r"\archive"}}}), encoding="utf-8")
                p = config.resolve({}, env, probes=probes)
                self.assertEqual(p.scrolls_root, Path(config.DEFAULT_SCROLLS_ROOT), hub)
                self.assertEqual(p.archive_root_source, "fallback", hub)
                self.assertIsNone(_fsutil.protected_root(p.archive_root))
                self.assertEqual(sum("read-only ai-hub" in w for w in p.warnings), 2, p.warnings)
                self.assertFalse(any(hub.lower() in w.lower() for w in p.warnings), "no path in the warning")
                # A flag / env value under the hub is still refused outright.
                with self.assertRaises(HubWriteRefused):
                    config.resolve({}, {**env, "MEMORY_SCROLLS_DIR": hub + r"\scrolls"}, probes=probes)
                with self.assertRaises(HubWriteRefused):
                    config.resolve({"archive_root": hub + r"\archive"}, env, probes=probes)
            # An os.json value elsewhere still wins over the default.
            (sb.root / "os.json").write_text(json.dumps({"memory": {"scrolls": {"scrollsDir": str(sb.root / "own-scrolls")}}}), encoding="utf-8")
            self.assertEqual(config.resolve({}, env, probes=probes).scrolls_root, sb.root / "own-scrolls")
            # The CLI `status` runs (exit 0) instead of exiting 2 on every call.
            (sb.root / "os.json").write_text(json.dumps({"memory": {"scrolls": {"scrollsDir": r"C:\ai-hub\memory\scrolls"}}}), encoding="utf-8")
            code, lines = sb.cli("status", "--json", extra_env={"MEMORY_SCROLLS_DIR": ""})
            self.assertEqual(code, 0, lines)
        finally:
            sb.close()

    @unittest.skipUnless(os.name == "nt", "Windows paths")
    def test_identity_check_catches_an_alias_no_lexical_rule_knows(self):
        """A junction whose name gives nothing away, with realpath disabled: only the file-identity
        check (target or an existing ancestor IS the protected root) can catch it, as it does a
        plain share, a mapped / SUBST drive or a volume GUID path to C:\\ai-hub."""
        import _winapi

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            hub = root / "fake-hub"
            (hub / "memory").mkdir(parents=True)
            link = root / "innocent"
            _winapi.CreateJunction(str(hub), str(link))
            try:
                with mock.patch.object(_fsutil, "PROTECTED_WRITE_ROOTS", _fsutil.PROTECTED_WRITE_ROOTS + (str(hub),)), mock.patch("os.path.realpath", lambda p, *a, **k: os.fspath(p)):
                    for t in (link, link / "memory", link / "memory" / "new" / "scrolls"):
                        self.assertEqual(_fsutil.protected_root(t), str(hub), str(t))
                    self.assertIsNone(_fsutil.protected_root(root / "elsewhere" / "scrolls"))
                    with self.assertRaises(HubWriteRefused):
                        _fsutil.atomic_write(link / "memory" / "x.txt", b"x")
                self.assertEqual(sorted(p.name for p in hub.rglob("*")), ["memory"])
            finally:
                os.rmdir(link)  # the junction only, never its target

    @unittest.skipUnless(os.name == "nt", "Windows paths")
    def test_admin_share_loopback_reaches_the_same_file_identity(self):
        """Over SMB loopback the admin share reports the local file id, so even a share name the lexical
        rule does not map would be caught. Read-only: stats only; skipped when the share is off."""
        with tempfile.TemporaryDirectory() as td:
            hub = Path(td).resolve() / "fake-hub"
            (hub / "memory").mkdir(parents=True)
            drive, rest = os.path.splitdrive(str(hub))
            unc = "\\\\localhost\\" + drive[0] + "$" + rest
            try:
                os.stat(unc)
            except OSError:
                self.skipTest("admin share not reachable over loopback here")
            with mock.patch.object(_fsutil, "PROTECTED_WRITE_ROOTS", (str(hub),)), mock.patch.object(_fsutil, "_ADMIN_SHARE", re.compile(r"(?!x)x")):
                self.assertEqual(_fsutil.protected_root(unc + "\\memory\\new"), str(hub))
                self.assertIsNone(_fsutil.protected_root("\\\\localhost\\" + drive[0] + "$" + str(Path(rest).parent / "other")))

    @unittest.skipUnless(os.name == "nt", "Windows paths")
    def test_writers_refuse_the_real_hub_without_touching_it(self):
        target = Path(r"C:\ai-hub\memory")
        # write_scroll refuses before it looks at the scroll, so None stands in for one.
        calls = [
            lambda: write_scroll(target / "scrolls", "projects/x.md", None, target / "history"),
            lambda: write_scroll(Path(tempfile.gettempdir()) / "never-used", "projects/x.md", None, target / "history"),
            lambda: graph.kg_upsert(target / "knowledge-graph.json", [{"name": "A", "entityType": "t", "observations": ["o"]}]),
            lambda: archive.write_archive(target / "archive", recs(1), {"kind": "buffer"}, NOW),
            lambda: state.save(target / "state", state.default()),
            lambda: _fsutil.atomic_write(target / "x.txt", b"x"),
            lambda: ProcessLock(target / "compact.lock").acquire(),
        ]
        patches = _no_fs_writes()
        for p in patches:
            p.start()
        try:
            for i, call in enumerate(calls):
                with self.assertRaises(HubWriteRefused, msg=f"writer #{i}"):
                    call()
        finally:
            for p in reversed(patches):
                p.stop()

    def test_writers_refuse_a_protected_root_and_a_junction_into_it(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            hub = root / "fake-hub"
            (hub / "memory").mkdir(parents=True)
            targets = [hub / "memory"]
            link = root / "link-to-hub"
            if os.name == "nt":
                import _winapi

                _winapi.CreateJunction(str(hub), str(link))
                self.assertTrue(is_reparse(link))
                targets.append(link / "memory")
                targets.append(Path(str(link).upper()) / "MEMORY")
            with mock.patch.object(_fsutil, "PROTECTED_WRITE_ROOTS", _fsutil.PROTECTED_WRITE_ROOTS + (str(hub),)):
                for t in targets:
                    before = sorted(p.as_posix() for p in hub.rglob("*"))
                    with self.assertRaises(HubWriteRefused, msg=str(t)):
                        write_scroll(t / "scrolls", "projects/x.md", None, root / "history")
                    with self.assertRaises(HubWriteRefused, msg=str(t)):
                        write_scroll(root / "scrolls", "projects/x.md", None, t / "history")
                    with self.assertRaises(HubWriteRefused):
                        graph.kg_upsert(t / "knowledge-graph.json", [{"name": "A", "entityType": "t", "observations": ["o"]}])
                    with self.assertRaises(HubWriteRefused):
                        archive.write_archive(t / "archive", recs(1), {"kind": "buffer"}, NOW)
                    with self.assertRaises(HubWriteRefused):
                        state.save(t / "state", state.default())
                    with self.assertRaises(HubWriteRefused):
                        ProcessLock(t / "compact.lock").acquire()
                    with self.assertRaises(HubWriteRefused):
                        _fsutil.atomic_write(t / "preview" / "manifest.json", b"{}")
                    self.assertEqual(sorted(p.as_posix() for p in hub.rglob("*")), before, f"{t}: nothing written")
                # Offload dry-run / apply and compaction refuse a hub target before reading anything.
                sb = Sandbox()
                try:
                    paths = sb.paths()
                    for field_name in ("scrolls_root", "kg_path", "archive_root", "state_dir", "staging_root"):
                        bad = config.Paths(**{**paths.__dict__, field_name: targets[-1] / field_name})
                        with self.assertRaises(HubWriteRefused, msg=field_name):
                            _offload.dry_run(bad, _offload.OffloadOptions(), sb.env, lambda e: None)
                        with self.assertRaises(HubWriteRefused, msg=field_name):
                            _offload.apply(bad, _offload.OffloadOptions(confirm="000000000000"), sb.env, lambda e: None)
                        with self.assertRaises(HubWriteRefused, msg=field_name):
                            compact.run(bad, compact.CompactOptions(), sb.env, lambda e: None)
                    with self.assertRaises(HubWriteRefused):
                        _offload.dry_run(paths, _offload.OffloadOptions(preview_dir=str(targets[-1] / "preview")), sb.env, lambda e: None)
                    with self.assertRaises(HubWriteRefused):
                        config.resolve({"scrolls_root": str(targets[-1] / "scrolls")}, sb.env, probes=config.DriveProbes(lambda r: False, lambda r: 0))
                finally:
                    sb.close()
                self.assertEqual(sorted(p.name for p in hub.rglob("*")), ["memory"])
            if os.name == "nt":
                os.rmdir(link)  # removes the junction only, never its target


class KeyTests(unittest.TestCase):
    def test_env_then_keychain(self):
        self.assertEqual(keys.allm_key({"ANYTHINGLLM_API_KEY": " k-123456 "}), "k-123456")
        self.assertIsNone(keys.allm_key({"AOS_NO_KEYCHAIN": "1"}))
        seen = []
        blob = "secret-key-abc".encode("utf-16-le")
        self.assertEqual(keys.allm_key({}, None, reader=lambda t: seen.append(t) or blob), "secret-key-abc")
        self.assertEqual(seen, ["anythingllm@127.0.0.1:3001.agentic-os-command-center"])
        self.assertIsNone(keys.allm_key({}, None, reader=lambda t: None))

    def test_decode_and_host(self):
        self.assertEqual(keys.decode_blob("abc123".encode("utf-16-le")), "abc123")
        self.assertEqual(keys.decode_blob(b"plain-utf8"), "plain-utf8")
        self.assertIsNone(keys.decode_blob(b""))
        self.assertEqual(keys.host_of("http://LOCALHOST:3001/api/v1/openai"), "localhost:3001")


if __name__ == "__main__":
    unittest.main(verbosity=2)
