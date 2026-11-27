"""engine/agents_migrate.py: prompts from the right source, tools only from MCP grants (readOnly
kept), removed agents not migrated, and undecidable things become questions."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine.agents_migrate import propose  # noqa: E402

OS = {
    "routing": {"agents": {"general": {"names": ["Tony"], "domains": []}, "coder": {"names": ["Coder"], "domains": ["code"]},
                           "booking": {"names": ["Booking"], "domains": []}, "ops": {"names": ["Ops"], "domains": []},
                           "finance": {"names": [], "domains": []}}},
    "anythingllm": {"workspaces": {"general": "my-workspace", "coder": "coder", "booking": "booking", "ops": "ops", "finance": "finance"}},
    "mcps": [
        {"id": "weather", "enabled": True, "agents": ["general"]},
        {"id": "git", "enabled": True, "agents": ["coder"]},
        {"id": "filesystem", "enabled": True, "agents": ["coder", "booking"]},
        {"id": "whatsapp", "enabled": True, "readOnly": True, "agents": ["general"]},
        {"id": "off-tool", "enabled": False, "agents": ["coder"]},
        {"id": "ops-only", "enabled": True, "agents": ["ops", "general"]},
    ],
    "skills": {"grants": {"impeccable": ["coder"]}},
    "switchboard": {"frozenAgents": ["booking"]},
}
EXPORT = {
    "my-workspace": {"prompt": "You are Nic's Booking Agent. Never send.", "model": "qwen/qwen3.5-9b", "threads": 3, "chats": 40, "documents": 0},
    "coder": {"prompt": "copy of the coder prompt", "model": "qwen/qwen3.5-9b", "threads": 2, "chats": 9, "documents": 0},
    "booking": {"prompt": "You book gigs for Nic.", "model": "qwen/qwen3.5-9b", "temperature": 0.4, "threads": 1, "chats": 5, "documents": 0},
    "ops": {"prompt": "ops", "model": "m"},
    "finance": {"prompt": "", "model": "m"},
    "director": {"prompt": "x", "model": "m"},
    "bizops_trades_contracting": {"prompt": "ops for contracting", "model": "m"},
}


class ProposeTests(unittest.TestCase):
    def setUp(self):
        self.r = propose(OS, EXPORT)
        self.a = self.r["agents"]

    def test_prompt_sources(self):
        self.assertIn("built in", self.a["coder"]["promptSource"])
        self.assertIsNone(self.a["coder"]["prompt"])
        self.assertTrue(self.a["coder"]["notes"])  # the AnythingLLM copy is noted, not used
        self.assertEqual((self.a["booking"]["promptSource"], self.a["booking"]["prompt"]), ("anythingllm:my-workspace", "You are Nic's Booking Agent. Never send."))
        self.assertTrue(any("Nic to confirm" in n for n in self.a["booking"]["notes"]))
        self.assertTrue(any("not merged into Tony's" in n for n in self.a["general"]["notes"]))
        self.assertIn("only Tony prompt", self.a["general"]["promptSource"])
        self.assertIsNone(self.a["general"]["prompt"])
        self.assertEqual(self.a["finance"]["promptSource"], "none")

    def test_tools_only_from_grants_with_read_only(self):
        self.assertEqual(self.a["coder"]["tools"], ["git", "filesystem"])  # the disabled tool is left out
        self.assertEqual(self.a["general"]["readOnlyTools"], ["whatsapp"])
        self.assertEqual(self.a["coder"]["skills"], ["impeccable"])

    def test_frozen_removed_and_memory(self):
        self.assertTrue(self.a["booking"]["frozen"])
        # frozen: no tools now, its future access recorded (Tony keeps ownership of both)
        self.assertEqual(self.a["booking"]["whenUnfrozen"], [{"tool": "whatsapp", "access": "read"}, {"tool": "gmail", "access": "draft"}])
        self.assertNotIn("gmail", self.a["booking"]["tools"])
        self.assertFalse(self.a["ops"]["migrate"])
        self.assertEqual(self.a["general"]["memory"], {"workspace": "my-workspace", "threads": 3, "chats": 40, "documents": 0})

    def test_questions(self):
        q = " | ".join(self.r["questions"])
        self.assertNotIn("'filesystem' is granted", q)  # decided by TOOL_POLICY
        self.assertNotIn("which project folder", q)  # Designer's folders are decided
        self.assertNotIn("'ops-only'", q)  # Ops is removed, so general is the only owner
        self.assertIn("agent 'finance' has no prompt", q)
        self.assertIn("director", q)  # a workspace no agent maps to
        self.assertNotIn("bizops_", q)  # business workspaces map to the shared Biz Ops prompt



class ToolPolicyTests(unittest.TestCase):
    """Nic 11-27: filesystem + fetch owned by Coder, knowledge-graph by Tony; readers read-only."""
    OS = {
        "routing": {"agents": {a: {} for a in ("general", "coder", "designer", "director", "librarian", "prompter")}},
        "anythingllm": {"workspaces": {}},
        "mcps": [
            {"id": "filesystem", "agents": ["coder", "designer", "director", "librarian", "prompter"]},
            {"id": "fetch", "agents": ["coder", "prompter"]},
            {"id": "knowledge-graph", "agents": ["general", "librarian", "prompter"]},
            {"id": "brave-search", "agents": ["general"]},
        ],
    }

    def access(self, agent):
        return {x["tool"]: x for x in propose(self.OS, {})["agents"][agent]["toolAccess"]}

    def test_owners_write_readers_read_rest_removed(self):
        self.assertEqual({t: x["access"] for t, x in self.access("coder").items()}, {"filesystem": "write", "fetch": "write"})
        d = self.access("director")
        self.assertEqual(d["filesystem"], {"tool": "filesystem", "access": "read", "roots": [r"G:\ai-hub\media\projects"]})
        self.assertTrue(os.path.isabs(d["filesystem"]["roots"][0]) and all(ord(c) >= 32 for c in d["filesystem"]["roots"][0]))
        roots = self.access("designer")["filesystem"]["roots"]
        self.assertEqual([os.path.basename(r) for r in roots], ["widgets", "recovered-widgets"])  # repo widget folders only
        self.assertTrue(all(os.path.isabs(r) for r in roots))
        self.assertEqual({t: x["access"] for t, x in self.access("general").items()}, {"knowledge-graph": "write", "brave-search": "write"})
        self.assertNotIn("fetch", self.access("general"))  # Tony uses Brave Search
        self.assertEqual({t: x["access"] for t, x in self.access("prompter").items()}, {"knowledge-graph": "read"})
        self.assertEqual({t: x["access"] for t, x in self.access("librarian").items()}, {"knowledge-graph": "read"})
        self.assertNotIn("roots", self.access("librarian")["knowledge-graph"])

    def test_every_tool_has_exactly_one_writer(self):
        agents = propose(self.OS, {})["agents"]
        for tool in ("filesystem", "fetch", "knowledge-graph", "brave-search"):
            writers = [a for a, ag in agents.items() for x in ag["toolAccess"] if x["tool"] == tool and x["access"] == "write"]
            self.assertEqual(len(writers), 1, (tool, writers))


class UnfrozenBookingTests(unittest.TestCase):
    def test_unfrozen_booking_gets_read_and_draft_only(self):
        cfg = {**OS, "switchboard": {"frozenAgents": []}, "mcps": OS["mcps"] + [{"id": "gmail", "agents": ["general"]}]}
        a = propose(cfg, EXPORT)["agents"]
        acc = {x["tool"]: x["access"] for x in a["booking"]["toolAccess"]}
        self.assertEqual((acc.get("whatsapp"), acc.get("gmail")), ("read", "draft"))
        self.assertEqual({x["tool"]: x["access"] for x in a["general"]["toolAccess"]}.get("gmail"), "write")  # Tony owns it


if __name__ == "__main__":
    unittest.main()
