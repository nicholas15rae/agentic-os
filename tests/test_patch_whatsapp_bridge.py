"""scripts/patch-whatsapp-bridge.ps1, checked WITHOUT running it (it only runs on Nic's OK).

The edit patterns are read out of the script and matched against the real bridge source
(G:\\ai-hub\\whatsapp-mcp, read-only; skipped when it isn't there): each must match exactly once,
the patched text must pass start-command-center.ps1's "is it patched" check, and a second pass
over the patched text must change nothing. Plus: the script is ASCII, has a confirmation prompt
and no bypass switch, and cc-common.ps1's port is not one the Command Center already uses.

Run with: python -m pytest tests/test_patch_whatsapp_bridge.py -q -p no:cacheprovider
"""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "patch-whatsapp-bridge.ps1"
START = ROOT / "scripts" / "start-command-center.ps1"
COMMON = ROOT / "scripts" / "cc-common.ps1"
BRIDGE = Path(r"G:\ai-hub\whatsapp-mcp")
PORT = 8097


def _patterns():
    """(label, pattern) of every Set-Edit call in the script."""
    text = SCRIPT.read_text(encoding="ascii")
    found = re.findall(r"^Set-Edit \$\w+ '([^']+)' '([^']+)'", text, re.M)
    return dict(found)


def _patch(go: str, py: str) -> tuple[str, str]:
    """What the script's three edits produce (the replacements, written out)."""
    p = _patterns()
    go = re.sub(p["REST port"], f"startRESTServer(client, messageStore, {PORT})", go, flags=re.M)
    go = re.sub(p["bind address"], 'serverAddr := fmt.Sprintf("127.0.0.1:%d", port)', go, flags=re.M)
    py = re.sub(p["MCP server URL"], f'WHATSAPP_API_BASE_URL = "http://127.0.0.1:{PORT}/api"', py, flags=re.M)
    return go, py


class ScriptTextTests(unittest.TestCase):
    def test_ascii_confirmation_and_no_bypass(self):
        raw = SCRIPT.read_bytes()
        self.assertTrue(all(b < 128 for b in raw), "PowerShell 5.1 reads a BOM-less file as ANSI")
        text = raw.decode("ascii")
        self.assertIn("Read-Host 'Write these changes? Type yes to apply'", text)
        self.assertIn("if ($answer -ne 'yes')", text)
        params = re.search(r"param\((.*?)\)\s*\$ErrorActionPreference", text, re.S).group(1)
        self.assertNotRegex(params, r"(?i)\$(yes|force|confirm|apply)\b")
        self.assertEqual(set(_patterns()), {"REST port", "bind address", "MCP server URL"})
        # The port check runs before the prompt and again right before writing.
        self.assertEqual(text.count("Get-PortListeners $Port"), 2)
        self.assertLess(text.index("Get-PortListeners $Port"), text.index("Read-Host"))

    def test_the_port_is_free_of_the_command_center_s_own(self):
        common = COMMON.read_text(encoding="ascii")
        self.assertRegex(common, rf"\$WA_BRIDGE_PORT\s+=\s+{PORT}\b")
        self.assertRegex(common, r"\$WA_AUTOSTART\s+=\s+\$false")
        taken = {int(m) for m in re.findall(r"^\$\w+PORT\s+=\s+(\d+)", common, re.M) if int(m) != PORT}
        self.assertTrue({8080, 8091, 8443} <= taken)
        self.assertNotIn(PORT, taken)

    def test_the_start_script_starts_it_only_when_asked(self):
        start = START.read_text(encoding="ascii")
        self.assertIn("[switch]$WithWhatsApp", start)
        self.assertIn("$script:WaWanted = [bool]($WA_AUTOSTART -or $WithWhatsApp)", start)
        self.assertIn("if (-not $script:WaWanted) { throw $WA_OFF }", start)


@unittest.skipUnless((BRIDGE / "whatsapp-bridge" / "main.go").is_file(), "the WhatsApp bridge checkout isn't on this PC")
class BridgeSourceTests(unittest.TestCase):
    def setUp(self):
        self.go = (BRIDGE / "whatsapp-bridge" / "main.go").read_text(encoding="utf-8")
        self.py = (BRIDGE / "whatsapp-mcp-server" / "whatsapp.py").read_text(encoding="utf-8")

    def test_each_edit_matches_exactly_once(self):
        p = _patterns()
        for label, text in (("REST port", self.go), ("bind address", self.go), ("MCP server URL", self.py)):
            self.assertEqual(len(re.findall(p[label], text, re.M)), 1, label)

    def test_the_patched_source_is_loopback_on_the_new_port_and_a_second_pass_is_a_no_op(self):
        go, py = _patch(self.go, self.py)
        self.assertNotEqual(go, self.go)
        self.assertIn(f"startRESTServer(client, messageStore, {PORT})", go)
        self.assertIn('serverAddr := fmt.Sprintf("127.0.0.1:%d", port)', go)
        self.assertNotIn("8080", go)
        self.assertIn(f'WHATSAPP_API_BASE_URL = "http://127.0.0.1:{PORT}/api"', py)
        # start-command-center.ps1's patched check (Get-Content -Raw; -match is case-insensitive).
        self.assertIn('fmt.Sprintf("127.0.0.1:%d", port)', go)
        self.assertRegex(go, rf"startRESTServer\(client, messageStore, {PORT}\)")
        # Only those lines changed; line endings untouched.
        changed = [(a, b) for a, b in zip(self.go.splitlines(True), go.splitlines(True)) if a != b]
        self.assertEqual(len(changed), 2)
        self.assertTrue(all(a.endswith("\r\n") == b.endswith("\r\n") for a, b in changed))
        self.assertEqual(_patch(go, py), (go, py))


if __name__ == "__main__":
    unittest.main()
