"""engine/threads.py: history caps and ordering, AnythingLLM import (idempotent, Finance never,
reset chats in their own thread, think blocks stripped), and the runner using history."""
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine import agent_runner as ar  # noqa: E402
from engine.threads import ThreadStore, _response_text  # noqa: E402


class HistoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.s = ThreadStore(Path(self.tmp.name) / "t.db")

    def tearDown(self):
        self.tmp.cleanup()

    def test_order_caps_and_user_first(self):
        t = self.s.new_thread("coder", "x")
        for i in range(10):
            self.s.append(t, "user", f"q{i}")
            self.s.append(t, "assistant", f"a{i}")
        h = self.s.history(t, max_messages=5)
        self.assertEqual(h[0], {"role": "user", "content": "q8"})  # cut to start on a user turn
        self.assertEqual([m["content"] for m in h], ["q8", "a8", "q9", "a9"])
        self.assertEqual(len(self.s.history(t, max_messages=20, max_chars=6)), 2)  # chars cap keeps the newest pair
        self.assertEqual(self.s.threads("coder")[0]["n"], 20)
        self.assertEqual(self.s.threads("other"), [])

    def test_runner_puts_history_between_system_and_turn(self):
        seen = []
        table = {"agents": {"coder": {"prompt": "P", "toolAccess": []}}}
        ar.run("coder", "now", table=table, os_cfg={"mcps": []}, chat=lambda m, t: (seen.append(m), {"content": "ok"})[1],
               enabled=True, audit=lambda r: None,
               history=[{"role": "user", "content": "before"}, {"role": "assistant", "content": "earlier"}, {"role": "tool", "content": "x"}])
        self.assertEqual([(m["role"], m["content"]) for m in seen[0]],
                         [("system", "P"), ("user", "before"), ("assistant", "earlier"), ("user", "now")])


class ImportTests(unittest.TestCase):
    def test_import(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            c = sqlite3.connect(d / "anythingllm.db")
            c.executescript("""
                CREATE TABLE workspaces(id INTEGER PRIMARY KEY, slug TEXT);
                CREATE TABLE workspace_threads(id INTEGER PRIMARY KEY, name TEXT);
                CREATE TABLE workspace_chats(id INTEGER PRIMARY KEY, workspaceId INT, thread_id INT, prompt TEXT, response TEXT, createdAt INT, include BOOLEAN);
                INSERT INTO workspaces VALUES(1,'coder'),(2,'finance'),(3,'stray');
                INSERT INTO workspace_threads VALUES(7,'Widget build');
            """)
            c.executemany("INSERT INTO workspace_chats VALUES(?,?,?,?,?,?,?)", [
                (1, 1, 7, "build it", json.dumps({"text": "<think>hmm</think>Done, staged."}), 1795000000000, 1),
                (2, 1, None, "old", json.dumps({"text": "old answer"}), 1795000001000, 0),
                (3, 2, None, "what did I spend", json.dumps({"text": "$40"}), 1795000002000, 1),
                (4, 3, None, "x", "y", 1795000003000, 1),
            ])
            c.commit()
            c.close()
            s = ThreadStore(d / "t.db")
            r = s.import_allm(d, {"coder": "coder", "finance": "finance"})
            self.assertEqual((r["threads"], r["messages"]), (2, 4))
            self.assertEqual(r["skippedWorkspaces"], ["finance", "stray"])
            titles = sorted(t["title"] for t in s.threads("coder"))
            self.assertEqual(titles, ["Widget build", "coder (AnythingLLM) (reset in AnythingLLM)"])
            live = next(t for t in s.threads("coder") if t["title"] == "Widget build")
            self.assertEqual(s.history(live["id"])[-1]["content"], "Done, staged.")
            self.assertEqual(s.threads("finance"), [])
            self.assertEqual(s.import_allm(d, {"coder": "coder"})["threads"], 0)  # idempotent

    def test_response_text(self):
        self.assertEqual(_response_text('{"text": "<think>x\\ny</think>\\n\\nHi Nic"}'), "Hi Nic")
        self.assertEqual(_response_text("plain"), "plain")
        self.assertEqual(_response_text("<think>never closed"), "")


if __name__ == "__main__":
    unittest.main()
