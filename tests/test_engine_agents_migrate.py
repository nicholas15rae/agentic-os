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
    "my-workspace": {"prompt": "", "model": "qwen/qwen3.5-9b", "threads": 3, "chats": 40, "documents": 0},
    "coder": {"prompt": "copy of the coder prompt", "model": "qwen/qwen3.5-9b", "threads": 2, "chats": 9, "documents": 0},
    "booking": {"prompt": "You book gigs for Nic.", "model": "qwen/qwen3.5-9b", "temperature": 0.4, "threads": 1, "chats": 5, "documents": 0},
    "ops": {"prompt": "ops", "model": "m"},
    "finance": {"prompt": "", "model": "m"},
    "director": {"prompt": "x", "model": "m"},
}


class ProposeTests(unittest.TestCase):
    def setUp(self):
        self.r = propose(OS, EXPORT)
        self.a = self.r["agents"]

    def test_prompt_sources(self):
        self.assertIn("built in", self.a["coder"]["promptSource"])
        self.assertIsNone(self.a["coder"]["prompt"])
        self.assertTrue(self.a["coder"]["notes"])  # the AnythingLLM copy is noted, not used
        self.assertEqual((self.a["booking"]["promptSource"], self.a["booking"]["prompt"]), ("anythingllm:booking", "You book gigs for Nic."))
        self.assertIn("Tony", self.a["general"]["promptSource"])
        self.assertEqual(self.a["finance"]["promptSource"], "none")

    def test_tools_only_from_grants_with_read_only(self):
        self.assertEqual(self.a["coder"]["tools"], ["git", "filesystem"])  # the disabled tool is left out
        self.assertEqual(self.a["general"]["readOnlyTools"], ["whatsapp"])
        self.assertEqual(self.a["coder"]["skills"], ["impeccable"])

    def test_frozen_removed_and_memory(self):
        self.assertTrue(self.a["booking"]["frozen"])
        self.assertFalse(self.a["ops"]["migrate"])
        self.assertEqual(self.a["general"]["memory"], {"workspace": "my-workspace", "threads": 3, "chats": 40, "documents": 0})

    def test_questions(self):
        q = " | ".join(self.r["questions"])
        self.assertIn("'filesystem' is granted to 2 agents", q)
        self.assertNotIn("'ops-only'", q)  # Ops is removed, so general is the only owner
        self.assertIn("agent 'finance' has no prompt", q)
        self.assertIn("director", q)  # a workspace no agent maps to


if __name__ == "__main__":
    unittest.main()
