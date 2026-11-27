"""The phone's read-only view of the desktop's settings (/api/os/desktop-config)."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import command_center_api as cc  # noqa: E402


class DesktopConfigView(unittest.TestCase):
    PROVIDERS = {
        "providers": [
            {"id": "lmstudio", "kind": "local", "baseUrl": "http://127.0.0.1:1234/v1", "model": "qwen", "needsKey": False},
            {"id": "anythingllm", "kind": "agentic-os", "baseUrl": "http://127.0.0.1:3001/api/v1", "model": "my-workspace", "needsKey": True},
            {"id": "droplet", "kind": "cloud", "baseUrl": "http://100.84.235.228:8000/v1", "model": "qwen2.5-0.5b-instruct", "needsKey": True},
            {"id": "openrouter", "kind": "cloud", "baseUrl": "https://openrouter.ai/api/v1", "model": "x", "needsKey": True},
        ],
        "policy": {"chain": ["lmstudio", "droplet"]},
        "agentVoices": {"general": {"engine": "elevenlabs", "voice": "QhEKgDl6KUJsO1FPiuSD"}},
        "gateway": {"url": "http://127.0.0.1:8080", "workdir": "G:\\agentic os"},
        "pipelines": {"gdriveSyncWebhookUrl": "https://example.invalid/hook"},
    }

    def test_has_key_comes_from_credential_names(self):
        names = {"anythingllm@127.0.0.1:3001", "droplet@100.84.235.228:8000", "droplet@100.84.1.36:8000"}
        v = cc.desktop_config_view(self.PROVIDERS, None, names)
        keys = {p["id"]: p["hasKey"] for p in v["providers"]["providers"]}
        # needsKey false -> never "has key"; a key for an OLD droplet host doesn't count; no port in URL -> host only.
        self.assertEqual(keys, {"lmstudio": False, "anythingllm": True, "droplet": True, "openrouter": False})
        self.assertTrue(cc.desktop_config_view(self.PROVIDERS, None, {"openrouter@openrouter.ai"})["providers"]["providers"][3]["hasKey"])

    def test_only_settings_sections_leave_and_env_is_masked(self):
        osc = {"osName": "Tony", "droplet": {"host": "100.84.235.228"}, "mcps": [{"id": "x", "env": {"API_TOKEN": "s3cret", "ROOT": "C:\\x"}}, {"id": "y"}]}
        v = cc.desktop_config_view(self.PROVIDERS, osc, set())
        self.assertEqual(set(v["providers"]), {"providers", "policy", "agentVoices"})  # no gateway / pipelines webhooks
        self.assertEqual(v["os"]["mcps"][0]["env"], {"API_TOKEN": "•••", "ROOT": "•••"})
        self.assertNotIn("s3cret", str(v))
        self.assertEqual(osc["mcps"][0]["env"]["API_TOKEN"], "s3cret")  # the source dict isn't modified
        self.assertIsNone(cc.desktop_config_view(self.PROVIDERS, None, set())["os"])

    def test_provider_host_matches_the_desktop(self):
        self.assertEqual(cc._provider_host("http://127.0.0.1:3001/api/v1"), "127.0.0.1:3001")
        self.assertEqual(cc._provider_host("https://openrouter.ai/api/v1"), "openrouter.ai")
        self.assertEqual(cc._provider_host("not a url"), "")


if __name__ == "__main__":
    unittest.main()
