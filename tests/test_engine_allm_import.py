"""engine/allm_import.py on a fake AnythingLLM storage folder: the source is never changed, the
export is complete and checksummed, comkey / models are left out, only documents are imported,
re-import is a no-op, and the report shows live-vs-export drift."""
import hashlib
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine import allm_import as ai  # noqa: E402
from engine.docstore import DocStore  # noqa: E402


def tree_hash(root: Path) -> str:
    h = hashlib.sha256()
    for p in sorted(root.rglob("*")):
        if p.is_file():
            h.update(p.relative_to(root).as_posix().encode())
            h.update(p.read_bytes())
    return h.hexdigest()


def make_storage(d: Path) -> Path:
    s = d / "storage"
    (s / "documents" / "custom-documents").mkdir(parents=True)
    (s / "plugins").mkdir()
    (s / "models" / "big").mkdir(parents=True)
    (s / "lancedb" / "librarian.lance").mkdir(parents=True)
    (s / "lancedb" / "librarian.lance" / "x").write_text("vec")
    (s / "comkey").write_text("SECRET-KEY")
    (s / "models" / "big" / "w.bin").write_bytes(b"\0" * 64)
    (s / "plugins" / "anythingllm_mcp_servers.json").write_text('{"mcpServers": {}}')
    (s / "plugins" / "anythingllm_mcp_servers.json.123.bak").write_text("old")
    for name, body in (("raw-core-a.json", "Nic prefers short answers"), ("raw-proj-b.json", "the engine runs on 1238")):
        (s / "documents" / "custom-documents" / name).write_text(json.dumps({"id": name, "title": name, "pageContent": body}))
    (s / "documents" / "custom-documents" / "broken.json").write_text("{nope")
    c = sqlite3.connect(s / "anythingllm.db")
    c.executescript("""
        CREATE TABLE workspaces(id INTEGER PRIMARY KEY, name TEXT, slug TEXT, openAiPrompt TEXT, chatModel TEXT);
        CREATE TABLE workspace_documents(id INTEGER PRIMARY KEY, docpath TEXT, workspaceId INT);
        CREATE TABLE workspace_chats(id INTEGER PRIMARY KEY, workspaceId INT, prompt TEXT, response TEXT, thread_id INT);
        CREATE TABLE workspace_threads(id INTEGER PRIMARY KEY, name TEXT, slug TEXT, workspace_id INT);
        CREATE TABLE prompt_history(id INTEGER PRIMARY KEY, workspaceId INT, prompt TEXT);
        CREATE TABLE system_settings(id INTEGER PRIMARY KEY, label TEXT, value TEXT);
        INSERT INTO workspaces VALUES(1,'Librarian','librarian','You are the librarian','qwen/qwen3.5-9b');
        INSERT INTO workspaces VALUES(2,'Finance','finance','money','qwen/qwen3.5-9b');
        INSERT INTO workspace_documents VALUES(1,'custom-documents/raw-core-a.json',1);
        INSERT INTO workspace_chats VALUES(1,2,'what did I spend','$40 at the store',NULL);
        INSERT INTO workspace_threads VALUES(1,'t','t',1);
        INSERT INTO system_settings VALUES(1,'gmail_agent_config','{"apiKey":"shh"}');
    """)
    c.commit()
    c.close()
    return s


class ExportImportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = Path(self.tmp.name)
        self.storage = make_storage(self.d)
        self.before = tree_hash(self.storage)
        self.store = DocStore(self.d / "ds.db", embedder=lambda t: ([[1.0, 0.0]] * len(t), "fake"))

    def tearDown(self):
        self.tmp.cleanup()

    def test_export_is_complete_checksummed_and_leaves_source_alone(self):
        out = ai.export(self.storage, self.d / "exp", stamp="s1")
        self.assertEqual(tree_hash(self.storage), self.before)  # AnythingLLM untouched
        m = json.loads((out / "manifest.json").read_text())
        self.assertEqual(m["counts"]["workspaces"], 2)
        self.assertEqual(m["counts"]["workspace_chats"], 1)
        self.assertEqual(m["documents"], 3)
        self.assertIn("gmail_agent_config", m["systemSettingLabels"])
        self.assertNotIn("shh", json.dumps(m))  # labels only, never values, in the manifest
        self.assertFalse((out / "comkey").exists())
        self.assertFalse((out / "models").exists())
        self.assertFalse(any(p.name.endswith(".bak") for p in out.rglob("*")))
        self.assertTrue((out / "plugins" / "anythingllm_mcp_servers.json").exists())
        self.assertTrue((out / "lancedb" / "librarian.lance" / "x").exists())
        fin = json.loads((out / "workspaces" / "finance.json").read_text())
        self.assertEqual(fin["chats"][0]["response"], "$40 at the store")
        self.assertEqual(ai.verify(out), [])
        with self.assertRaises(FileExistsError):
            ai.export(self.storage, self.d / "exp", stamp="s1")
        (out / "workspaces" / "finance.json").write_text("tampered")
        self.assertEqual(ai.verify(out), ["workspaces/finance.json"])

    def test_import_documents_only_and_rerun_is_noop(self):
        out = ai.export(self.storage, self.d / "exp", stamp="s2")
        r = ai.import_documents(out, self.store)
        self.assertEqual((r["added"], r["unreadable"]), (2, 1))
        self.assertEqual(ai.import_documents(out, self.store)["unchanged"], 2)
        hits = self.store.search("short answers")["results"]
        self.assertEqual(hits[0]["key"], "custom-documents/raw-core-a.json")
        self.assertFalse(any("$40" in h["text"] for h in self.store.search("spend at the store")["results"]))  # chats not indexed
        self.assertEqual(self.store.stats()["docs"], {"anythingllm": 2})
        self.assertEqual(tree_hash(self.storage), self.before)

    def test_report_shows_drift(self):
        out = ai.export(self.storage, self.d / "exp", stamp="s3")
        ai.import_documents(out, self.store)
        rep = ai.report(out, self.storage, self.store)
        self.assertEqual(rep["tablesLiveVsExport"], "all equal")
        self.assertEqual(rep["documents"], {"live": 3, "exported": 3, "inDocStore": 2})
        self.assertEqual(rep["integrity"], "ok")
        c = sqlite3.connect(self.storage / "anythingllm.db")
        c.execute("INSERT INTO workspace_chats VALUES(2,1,'new','chat',NULL)")
        c.commit()
        c.close()
        self.assertEqual(ai.report(out, self.storage, self.store)["tablesLiveVsExport"], {"workspace_chats": (2, 1)})


if __name__ == "__main__":
    unittest.main()
