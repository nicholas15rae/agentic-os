"""engine/agent_runner.py: the policy every tool call passes (Nic's owners, read / draft limits,
registry read-only, permissions, kill switch, folders, no money tools), the refusals, the tool
loop with a fake model, and the read-only executors. No server, no GPU."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine import agent_runner as ar  # noqa: E402

TMP = tempfile.mkdtemp()
PROJECTS = os.path.join(TMP, "projects")
os.makedirs(PROJECTS, exist_ok=True)
Path(PROJECTS, "brief.md").write_text("Shot list: 3 scenes.", encoding="utf-8")

OS = {
    "privacy": {"killSwitch": False},
    "permissions": {"filesystem": "allow", "mcp": "allow"},
    "fsRoots": [TMP],
    "mcps": [{"id": i, "enabled": True} for i in ("filesystem", "fetch", "knowledge-graph", "time", "gmail", "brave-search", "finance")]
            + [{"id": "whatsapp", "enabled": True, "readOnly": True}],
}
TABLE = {"agents": {
    "coder": {"prompt": "You are the Coder.", "toolAccess": [{"tool": "filesystem", "access": "write"}, {"tool": "fetch", "access": "write"}]},
    "director": {"prompt": "You are the Director.", "toolAccess": [{"tool": "filesystem", "access": "read", "roots": [PROJECTS]}, {"tool": "time", "access": "write"}]},
    "prompter": {"prompt": "You are the Prompter.", "toolAccess": [{"tool": "knowledge-graph", "access": "read"}]},
    "general": {"prompt": "Tony", "toolAccess": [{"tool": "knowledge-graph", "access": "write"}, {"tool": "whatsapp", "access": "write"},
                                                  {"tool": "finance", "access": "write"}]},
    "booking": {"prompt": "Booking", "frozen": True, "toolAccess": []},
    "unfrozen_booking": {"prompt": "Booking", "toolAccess": [{"tool": "gmail", "access": "draft"}]},
    "ops": {"prompt": "x", "migrate": False, "toolAccess": []},
    "bizops": {"prompt": None, "toolAccess": []},
    "finance": {"prompt": None, "promptSource": "none", "toolAccess": []},
}}


class PolicyTests(unittest.TestCase):
    def ok(self, agent, tool, args=None, cfg=OS):
        return ar.decide(TABLE["agents"][agent], tool, args or {}, cfg).ok

    def test_owner_vs_reader_vs_none(self):
        self.assertTrue(self.ok("coder", "fetch.url", {"url": "https://example.com"}))
        self.assertFalse(self.ok("prompter", "fetch.url"))  # fetch is Coder's alone
        self.assertTrue(self.ok("prompter", "kg.search", {"query": "x"}))
        self.assertFalse(self.ok("prompter", "kg.create_entities"))  # unknown here anyway, and a write

    def test_folders(self):
        self.assertTrue(self.ok("director", "fs.read", {"path": os.path.join(PROJECTS, "brief.md")}))
        self.assertFalse(self.ok("director", "fs.read", {"path": os.path.join(TMP, "other.txt")}))
        self.assertFalse(self.ok("director", "fs.read", {"path": os.path.join(PROJECTS, "..", "x")}))
        self.assertFalse(self.ok("director", "fs.read", {}))
        self.assertTrue(self.ok("coder", "fs.read", {"path": os.path.join(TMP, "any.txt")}))  # owner: fsRoots

    def test_registry_read_only_and_draft_limits(self):
        self.assertTrue(self.ok("general", "whatsapp.list_messages", {"chat_jid": "x"}))
        self.assertFalse(self.ok("general", "whatsapp.send_message"))  # read-only server, even for the owner
        self.assertTrue(self.ok("unfrozen_booking", "gmail.create_draft"))
        self.assertTrue(self.ok("unfrozen_booking", "gmail.search", {"query": "x"}))
        self.assertFalse(ar.decide({"toolAccess": [{"tool": "instagram", "access": "draft"}]}, "instagram.publish_post", {},
                                   {**OS, "mcps": OS["mcps"] + [{"id": "instagram", "enabled": True}]}).ok)

    def test_permissions_kill_switch_and_money(self):
        self.assertFalse(self.ok("coder", "fetch.url", cfg={**OS, "permissions": {"mcp": "ask", "filesystem": "allow"}}))
        self.assertFalse(self.ok("director", "fs.read", {"path": os.path.join(PROJECTS, "brief.md")},
                                 cfg={**OS, "permissions": {"filesystem": "deny", "mcp": "allow"}}))
        self.assertFalse(self.ok("prompter", "kg.search", cfg={**OS, "privacy": {"killSwitch": True}}))
        self.assertFalse(self.ok("general", "finance.summary"))  # unknown + never offered
        names = [t["function"]["name"] for t in ar.tool_schemas(TABLE["agents"]["general"], OS)]
        self.assertFalse(any(n.startswith("finance") for n in names))
        self.assertNotIn("whatsapp__send_message", [t["function"]["name"] for t in ar.tool_schemas(TABLE["agents"]["unfrozen_booking"], OS)])

    def test_mutating_port(self):
        for t in ("whatsapp.send_message", "fs.write_file", "kg.delete_entities", "gmail.create_draft", "instagram.publish_post", "git.git_commit"):
            self.assertTrue(ar.is_mutating(t), t)
        for t in ("whatsapp.list_messages", "fs.read", "kg.search", "gmail.recent", "time.now"):
            self.assertFalse(ar.is_mutating(t), t)


class RunTests(unittest.TestCase):
    def test_refusals(self):
        for agent, why in (("booking", "frozen"), ("ops", "removed"), ("bizops", "awaiting"), ("finance", "no prompt"), ("nobody", "unknown")):
            with self.assertRaises(ar.AgentRefused) as c:
                ar.run(agent, "hi", table=TABLE, os_cfg=OS, chat=lambda m, t: {}, enabled=True)
            self.assertIn(why, str(c.exception))
        with self.assertRaises(ar.AgentRefused):
            ar.run("coder", "hi", table=TABLE, os_cfg=OS, chat=lambda m, t: {}, enabled=False)

    def test_tool_loop_runs_allowed_refuses_rest_and_audits(self):
        script = [
            {"content": "", "tool_calls": [
                {"id": "1", "function": {"name": "fs__read", "arguments": json.dumps({"path": os.path.join(PROJECTS, "brief.md")})}},
                {"id": "2", "function": {"name": "fs__read", "arguments": json.dumps({"path": "C:/Windows/win.ini"})}},
                {"id": "3", "function": {"name": "time__now", "arguments": "{}"}}]},
            {"content": "The brief has 3 scenes."},
        ]
        seen, audited = [], []

        def chat(messages, tools):
            seen.append((list(messages), tools))
            return script[len(seen) - 1]

        r = ar.run("director", "what's in the brief?", table=TABLE, os_cfg=OS, chat=chat, enabled=True, audit=audited.append)
        self.assertEqual(r.answer, "The brief has 3 scenes.")
        self.assertEqual([c["status"] for c in r.calls], ["ok", "refused", "ok"])
        self.assertEqual(len(audited), 3)
        tool_msgs = [m for m in seen[1][0] if m["role"] == "tool"]
        self.assertTrue(all(m["content"].startswith(ar.UNTRUSTED) for m in tool_msgs))
        self.assertIn("Shot list", tool_msgs[0]["content"])
        self.assertIn("outside this agent's folders", tool_msgs[1]["content"])
        offered = {t["function"]["name"] for t in seen[0][1]}
        self.assertEqual(offered, {"fs__list", "fs__read", "time__now"})

    def test_desktop_only_tools_say_so(self):
        script = [{"content": "", "tool_calls": [{"id": "1", "function": {"name": "fetch__url", "arguments": '{"url": "https://example.com"}'}}]},
                  {"content": "Fetching needs the desktop app."}]
        n = []
        r = ar.run("coder", "fetch it", table=TABLE, os_cfg=OS, chat=lambda m, t: (n.append(1), script[len(n) - 1])[1],
                   enabled=True, audit=lambda rec: None)
        self.assertEqual(r.calls[0]["status"], "desktop")

    def test_round_limit(self):
        loop = {"content": "", "tool_calls": [{"id": "1", "function": {"name": "time__now", "arguments": "{}"}}]}
        r = ar.run("director", "x", table=TABLE, os_cfg=OS, chat=lambda m, t: loop, enabled=True, audit=lambda rec: None, max_rounds=2)
        self.assertIn("ran out", r.answer)
        self.assertEqual(len(r.calls), 3)


class ExecutorTests(unittest.TestCase):
    def test_kg_search_json_and_jsonl(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "kg.json"
            p.write_text(json.dumps({"entities": [{"name": "Bionic", "entityType": "service", "observations": ["serves on port 1235"]}]}))
            self.assertIn("Bionic", ar.kg_search("port", p))
            p.write_text('{"type":"entity","name":"Engine","entityType":"service","observations":["port 1238"]}\n{"type":"relation"}\n')
            self.assertIn("Engine", ar.kg_search("port", p))
            self.assertIn("no entries", ar.kg_search("zebra", p))
            self.assertIn("no knowledge graph", ar.kg_search("x", Path(d) / "missing.json"))

    def test_fs_read_caps_and_refuses_binary(self):
        with tempfile.TemporaryDirectory() as d:
            b = Path(d) / "x.bin"
            b.write_bytes(b"\0\1\2")
            self.assertIn("not a text file", ar.execute("fs.read", {"path": str(b)}))
            t = Path(d) / "big.txt"
            t.write_text("a" * (ar.MAX_READ_BYTES + 10))
            self.assertEqual(len(ar.execute("fs.read", {"path": str(t)})), ar.MAX_READ_BYTES)
            with self.assertRaises(ar.NeedsDesktop):
                ar.execute("gmail.recent", {})


if __name__ == "__main__":
    unittest.main()
