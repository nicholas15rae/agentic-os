"""Memory Scrolls Tier-2 guards: the never-lock rule and the personal-data filter.

- Never-lock: NEW one-off / idea bullets under a locked heading are moved (never deleted) to a
  non-locked heading with a warning + NDJSON event; existing locked bullets and durable decisions
  stay locked; the distiller prompt carries the rule.
- Privacy: every default-excluded category is removed from scroll bodies, the Superseded log,
  superseded facts and KG entities; allowed categories stay; the override file can allow / deny
  categories and add deny terms; `--show-privacy-policy` prints the effective policy; counts are
  category-only in NDJSON / report / manifest; the cold archive stays lossless; locked bullets are
  only ever removed as an explicit privacy removal; sync embeds the filtered text; `--apply`
  refuses a preview made under another (or no) privacy policy or still holding personal data.

All synthetic data, temp roots and stub servers. Run with: python3 tests/run_all.py
"""

from __future__ import annotations

import json
import re
import sys
import unittest
from collections import Counter
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
sys.path.insert(0, str(REPO))
sys.path.insert(0, str(HERE))

from memory_scrolls import archive, compact, distill, graph, offload, privacy, privacy_policy, sources, sync  # noqa: E402
from memory_scrolls import scroll as sc  # noqa: E402
from memory_scrolls.allm import Conn, ScrollWriter  # noqa: E402
from memory_scrolls.scroll_store import write_scroll  # noqa: E402
from memory_scrolls_stubs import StubAllm, StubGateway  # noqa: E402
from test_memory_scrolls import NOW, NOW_ISO, SENTINEL_KEY, FakeLLM, Sandbox, noisy_threads, section_reply, turn  # noqa: E402
from test_memory_scrolls import setUpModule, tearDownModule  # noqa: E402,F401
from test_memory_scrolls_offload import OS_JSON, stub_allm  # noqa: E402

ARCH = sc.target_info("core/architecture_decisions.md")
PROJ = sc.target_info("projects/agentic-os.md")
IDENT = sc.target_info("core/identity_and_preferences.md")

# Synthetic personal values: none of these may reach Tier 2, a report, a warning or an event.
PERSONAL = {
    "contact": ["- Owner email: jane.doe@example.com", "- Phone: call 416-555-0199", "- Mail goes to 42 Maple Leaf Avenue", "- Postal code M5V 2T6"],
    "location": ["- Commute: 25-minute drive from home to the studio", "- Pin: 43.6532, -79.3832", "- Nearest stop is Kipling Station"],
    "finance": ["- Client quote: $1,250 for the shoot", "- Salary target set for next year", "- Day trading: on hold"],
    "dob_age": ["- Born 1990, turning 36", "- Birthday is in June"],
    "health": ["- Takes medication for migraines", "- Physio twice a week for a back injury"],
    "family": ["- My sister visits on Sundays", "- Girlfriend works nights"],
    "third_party": ["- Emails from Priya about the gig", "- Follow up with Marco T. next week", "- Inbox: watch for specific senders like Acme"],
    "life_plans": ["- Plans: buying land for a cottage", "- Bus build: diesel camper idea", "- Owns a Honda wagon, does brake jobs"],
    "personality": ["- Personality: introverted perfectionist", "- Philosopher at heart and a public speaker"],
    "creative_gear": ["- Records guitar through a Shure SM7B", "- Edits photos in Lightroom", "- Hobby: handmade jewellery and sewing"],
    "consumer_services": ["- Music Service: Spotify.", "- News Source: CBC.", "- Casting Call Platform: Groundglass."],
}
SENTINELS = ("jane.doe@example.com", "416-555-0199", "Maple Leaf", "M5V 2T6", "Kipling", "1,250", "Priya", "Marco T.", "Acme", "migraines", "Shure", "Groundglass", "43.6532")

ALLOWED = [
    "- LM Studio serves Qwen 3.5 9B on :1235",
    "- GPU: RTX 3060 12 GB VRAM; OS: Windows 11",
    "- Communication: ultra-short acks, voice replies one sentence",
    "- Never commit .env or model files to Git",
    "- Scene Reader is a Tauri app; CloudMart runs on the GCP free tier",
    "- Error handling: route to alternative agent if one fails",
    "- WhatsApp bridge stays read-only (n8n workflow)",
    "- Strictly $0 budget: free tiers only",
    "- Fine-tuning runs on the RTX 3060",
    "- Link parent/child tasks in the kanban",
    "- Email: never send without approval",
    "- Spotify OAuth callback lives on the gateway API",
    "- Run diagnostics before a rebuild",
]


def run_target(t, replies, old=None, policy=None, text="Concept: x", budget_max=6):
    """distill_target with captured warnings, events and stats."""
    llm = FakeLLM(replies)
    events, warnings, stats = [], [], {}
    budget = {"used": 0, "max": budget_max, "save": lambda: None}
    reasons, merged, ents, _ = compact.distill_target(llm, t, old, text, "arch-2026-11-19-01", NOW_ISO, [], {}, budget, warnings, [], events.append, policy, stats)
    return reasons, merged, ents, warnings, events, stats, llm


def old_scroll(t, sections):
    body = section_reply(t.rel, sections)["updated_markdown"]
    return sc.Scroll(t.scroll_id, t.category, NOW_ISO, 1, [], [], body)


def no_values(testcase, blob: str):
    for v in SENTINELS:
        testcase.assertNotIn(v, blob)


# ── never-lock ──────────────────────────────────────────────────────────────


class NeverLockTests(unittest.TestCase):
    def test_new_one_off_and_idea_bullets_demoted_with_warning_and_event(self):
        reply = section_reply(ARCH.rel, {
            "Ports & Services": ["- LM Studio on :1235"],
            "Locked Design Decisions": [
                "- Coder model: Qwen 3.5 9B via LM Studio, tests must pass before reporting done",
                "- Weather Tool: weather.current used for local conditions",
                "- App Idea: a recipe scaler app concept saved for later",
                "- Lookup: travel planner used to check opening hours",
                "- Escalation always goes local agents first, then cloud",
            ],
        })
        reasons, merged, _, warnings, events, stats, _ = run_target(ARCH, [reply])
        self.assertEqual(reasons, [])
        locked = sc.section_bullets(merged.body, ["Locked Design Decisions"])
        ports = sc.section_bullets(merged.body, ["Ports & Services"])
        self.assertEqual(locked, ["- Coder model: Qwen 3.5 9B via LM Studio, tests must pass before reporting done", "- Escalation always goes local agents first, then cloud"])
        for b in ("- Weather Tool: weather.current used for local conditions", "- App Idea: a recipe scaler app concept saved for later", "- Lookup: travel planner used to check opening hours"):
            self.assertIn(b, ports, "moved, never deleted")
        self.assertTrue(any("never-lock moved 3" in w for w in warnings), warnings)
        ev = [e for e in events if e.get("event") == "never_lock"]
        self.assertEqual(ev, [{"event": "never_lock", "target": ARCH.rel, "chunk": 1, "demoted": 3, "to": {"Ports & Services": 3}}])
        self.assertEqual(stats["demoted"], 3)

    def test_project_ideas_go_to_open_threads_actions_to_active_state(self):
        reply = section_reply(PROJ.rel, {"Locked Decisions": ["- Idea: maybe add a dark mode toggle", "- Searched the docs for the vite config thread", "- Dashboard binds to localhost only"]})
        reasons, merged, *_ = run_target(PROJ, [reply])
        self.assertEqual(reasons, [])
        self.assertEqual(sc.section_bullets(merged.body, ["Locked Decisions"]), ["- Dashboard binds to localhost only"])
        self.assertEqual(sc.section_bullets(merged.body, ["Open Threads"]), ["- Idea: maybe add a dark mode toggle"])
        self.assertEqual(sc.section_bullets(merged.body, ["Active State"]), ["- Searched the docs for the vite config thread"])

    def test_existing_locked_bullets_never_demoted(self):
        one_off = "- Weather Tool: weather.current used for local conditions"
        old = old_scroll(ARCH, {"Locked Design Decisions": [one_off, "- Whisper STT runs on port 8178"]})
        reply = section_reply(ARCH.rel, {"Locked Design Decisions": [one_off, "- Whisper STT runs on port 8178"]})
        reasons, merged, _, warnings, events, stats, _ = run_target(ARCH, [reply], old=old)
        self.assertEqual(reasons, [])
        self.assertIn(one_off, sc.section_bullets(merged.body, ["Locked Design Decisions"]))
        self.assertEqual(stats["demoted"], 0)
        self.assertFalse([e for e in events if e.get("event") == "never_lock"])

    def test_demotion_never_breaks_no_silent_loss(self):
        # An existing locked bullet the model drops is still rejected; demotion only moves new ones.
        old = old_scroll(ARCH, {"Locked Design Decisions": ["- Whisper STT runs on port 8178"]})
        reply = section_reply(ARCH.rel, {"Locked Design Decisions": ["- Weather Tool: weather.current used for local conditions"]})
        reasons, merged, *_ = run_target(ARCH, [reply, reply], old=old)
        self.assertIsNone(merged)
        self.assertTrue(any("locked decision was dropped" in r for r in reasons), reasons)

    def test_durable_markers_keep_a_bullet_locked(self):
        durable = [
            "- Whisper STT runs on port 8178", "- Scrolls live under C:\\ai-hub\\memory\\scrolls", "- Always use LM Studio for local models",
            "- Never send messages without approval", "- Default model: Qwen 3.5 9B", "- Locked: search uses Brave via MCP",
            "- Use maps.route for travel-time lookups", "- Only the Librarian writes rules", "- Checked: the gateway must stay on 127.0.0.1",
        ]
        for b in durable:
            self.assertIsNone(distill.one_off_kind(b), b)
        self.assertEqual(distill.one_off_kind("- App Idea: protein counter concept"), "idea")
        self.assertEqual(distill.one_off_kind("- Route Tool: maps.route used for a trip"), "action")
        self.assertEqual(distill.one_off_kind("- Casting Eligibility Check: validates a profile against requirements"), "action")
        self.assertEqual(distill.one_off_kind("- Email Search: scans inbox for a newsletter"), "action")

    def test_extractive_never_locks(self):
        body = distill.extractive_body(ARCH, [{"kind": "doc", "ts": "", "text": "Locked: Whisper STT runs on port 8178\nAlways use LM Studio on :1235 for local models", "meta": {}}], "arch-pending")
        self.assertEqual(sc.section_bullets(body, sc.LOCKED_HEADINGS), [])

    def test_prompt_carries_never_lock_and_privacy_rules(self):
        self.assertIn("12 Locked Decisions, Locked Design Decisions and Standing Rules hold only durable decisions", distill.DISTILL_SYSTEM)
        self.assertIn("Never lock a one-off action", distill.DISTILL_SYSTEM)
        msgs = distill.build_messages(ARCH, [ARCH.rel], "arch-2026-11-19-01", "2026-11-19", "cur", "batch", "qwen/qwen3.5-9b")
        sys_p = msgs[0]["content"]
        self.assertIn("Never lock a one-off action", sys_p)
        self.assertIn("13 Never record personal data", sys_p)
        self.assertIn("money (prices", sys_p)
        self.assertTrue(sys_p.endswith("/no_think"))
        pol = privacy.Policy(1, frozenset(privacy.default_policy().excluded - {"finance"}), ("secret word",))
        sys_p2 = distill.build_messages(ARCH, [ARCH.rel], "a", "2026-11-19", "cur", "b", "mistral-7b-instruct", policy=pol)[0]["content"]
        self.assertNotIn("money (prices", sys_p2)
        self.assertNotIn("secret word", sys_p2, "deny_terms never go into a prompt")


# ── privacy filter ──────────────────────────────────────────────────────────


class PrivacyFilterTests(unittest.TestCase):
    def test_every_default_excluded_category_detected_allowed_kept(self):
        pol = privacy.default_policy()
        self.assertEqual(set(PERSONAL), {cid for cid, ex in privacy_policy.defaults().items() if ex})
        for cat, lines in PERSONAL.items():
            for line in lines:
                body = "\n".join(["# T", "", "## Identity", "", line, "- Whisper STT runs on port 8178", ""])
                out, c = privacy.filter_body(body, pol)
                self.assertEqual(dict(c), {cat: 1}, line)
                self.assertNotIn(line, out)
                self.assertIn("- Whisper STT runs on port 8178", out)
        body = "\n".join(["# T", "", "## Identity", ""] + ALLOWED)
        out, c = privacy.filter_body(body, pol)
        self.assertEqual(c, Counter(), [x for x in ALLOWED if x not in out])
        self.assertEqual(out, body)

    def test_identifier_redacted_when_the_line_still_says_something(self):
        out, c = privacy.filter_body("## Guardrails\n- Never email jane.doe@example.com without approval from Nic\n", privacy.default_policy())
        self.assertEqual(c, Counter({"contact": 1}))
        self.assertIn("- Never email [contact removed] without approval from Nic", out)
        again, c2 = privacy.filter_body(out, privacy.default_policy())
        self.assertEqual((again, c2), (out, Counter()), "idempotent")

    def test_superseded_log_and_facts_filtered(self):
        body = "# T\n\n## Active State\n\n- Quote engine live\n\n## Superseded Decisions\n\n- 2026-11-18: rate $500 -> $650 (arch-2026-11-18-01)\n- 2026-11-18: port 1234 -> 1235 (arch-2026-11-18-01)\n"
        out, c = privacy.filter_body(body, privacy.default_policy())
        self.assertEqual(c, Counter({"finance": 1}))
        self.assertNotIn("$500", out)
        self.assertIn("port 1234 -> 1235", out)
        facts = [{"old": "rate $500", "new": "rate $650", "reason": "raise"}, {"old": "port 1234", "new": "port 1235", "reason": "moved"}, {"old": "a", "new": "b", "reason": "texted by Marco T."}]
        kept, fc = privacy.filter_facts(facts, privacy.default_policy())
        self.assertEqual(kept, [facts[1]])
        self.assertEqual(fc, Counter({"finance": 1, "third_party": 1}))

    def test_kg_entities_and_observations_filtered(self):
        ents = [
            {"name": "Toronto to Kipling Station Route", "entityType": "path", "observations": ["40-minute ride"]},
            {"name": "Music_Gear_Setup", "entityType": "tool", "observations": ["Instruments: guitar, piano", "Recording gear: Shure SM7B", "Plugins: Kontakt", "Portable rig: laptop"]},
            {"name": "Skills_Car_Enthusiast", "entityType": "person", "observations": ["Owns a wagon"]},
            {"name": "Priya", "entityType": "person", "observations": ["friend who sends gig emails"]},
            {"name": "Spotify", "entityType": "service", "observations": ["Music service used for listening"]},
            {"name": "Mortadella", "entityType": "concept", "observations": ["RTX 3060 12 GB, 64 GB RAM", "Runs LM Studio on port 1235", "Owner email jane.doe@example.com"]},
            {"name": "Tony", "entityType": "person", "observations": ["Background agent persona (chill, loyal)"]},
            {"name": "Whisper STT", "entityType": "service", "observations": ["runs on port 8178"]},
        ]
        kept, c = privacy.filter_entities(ents, privacy.default_policy())
        self.assertEqual([e["name"] for e in kept], ["Mortadella", "Tony", "Whisper STT"])
        self.assertEqual(kept[0]["observations"], ["RTX 3060 12 GB, 64 GB RAM", "Runs LM Studio on port 1235"])
        self.assertEqual(c, Counter({"location": 1, "creative_gear": 1, "life_plans": 1, "third_party": 1, "consumer_services": 1, "contact": 1}))
        no_values(self, json.dumps(kept))

    def test_override_allows_denies_and_adds_terms(self):
        sb = Sandbox()
        try:
            st = sb.root / "state"
            self.assertEqual(privacy.load(st).sha, privacy.default_policy().sha, "no override file: defaults")
            (st / "privacy-policy.json").write_text(json.dumps({"allow": ["finance"], "deny": ["system_hardware", "standing_rules", "bogus-id"], "deny_terms": ["Blue Falcon", 7]}), encoding="utf-8")
            pol = privacy.load(st)
            self.assertNotIn("finance", pol.excluded)
            self.assertIn("system_hardware", pol.excluded)
            self.assertNotEqual(pol.sha, privacy.default_policy().sha)
            body = "## Identity\n- Client quote: $1,250 for the shoot\n- GPU: RTX 3060 12 GB VRAM\n- The blue falcon project ships Friday\n- Whisper STT runs on port 8178\n"
            out, c = privacy.filter_body(body, pol)
            self.assertEqual(c, Counter({"system_hardware": 1, privacy_policy.CUSTOM: 1}))
            self.assertIn("$1,250", out, "finance allowed by the override")
            desc = json.dumps(privacy.describe(pol))
            self.assertNotIn("falcon", desc.lower())
            self.assertNotIn("bogus", desc)
            self.assertEqual(privacy.describe(pol)["deny_terms"], 1)
            self.assertTrue(any("standing_rules has no detector" in w for w in pol.warnings))
            # A broken override never weakens the defaults.
            (st / "privacy-policy.json").write_text("{not json", encoding="utf-8")
            bad = privacy.load(st)
            self.assertEqual(bad.excluded, privacy.default_policy().excluded)
            self.assertTrue(bad.warnings)
        finally:
            sb.close()

    def test_cli_shows_effective_policy(self):
        sb = Sandbox()
        try:
            code, lines = sb.cli("status", "--show-privacy-policy")
            self.assertEqual(code, 0, lines)
            pol = lines[-1]["privacy_policy"]
            self.assertEqual(pol["version"], privacy_policy.POLICY_VERSION)
            self.assertFalse(pol["override_present"])
            cats = {c["id"]: c for c in pol["categories"]}
            self.assertEqual(cats["finance"]["status"], "excluded")
            self.assertEqual(cats["work_projects"]["status"], "allowed")
            (sb.root / "state" / "privacy-policy.json").write_text(json.dumps({"allow": ["creative_gear"], "deny_terms": ["Blue Falcon"]}), encoding="utf-8")
            code, lines = sb.cli("offload", "--json", "--show-privacy-policy")
            self.assertEqual(code, 0, lines)
            pol = lines[-1]["privacy_policy"]
            self.assertTrue(pol["override_present"])
            self.assertEqual({c["id"]: (c["status"], c["source"]) for c in pol["categories"]}["creative_gear"], ("allowed", "override"))
            self.assertEqual(pol["deny_terms"], 1)
            self.assertNotIn("falcon", json.dumps(lines).lower())
        finally:
            sb.close()

    def test_locked_bullets_only_leave_as_explicit_privacy_removals(self):
        old = old_scroll(IDENT, {"Standing Rules": [
            "- Owner email: jane.doe@example.com",
            "- Never email jane.doe@example.com without approval from Nic",
            "- Whisper STT runs on port 8178",
        ]})
        # The model sees the filtered scroll, so it echoes the redacted rule; the personal bullet is gone.
        seen = []

        def reply(messages):
            seen.append(messages[1]["content"])
            return json.dumps(section_reply(IDENT.rel, {"Standing Rules": ["- Never email [contact removed] without approval from Nic", "- Whisper STT runs on port 8178"]}))

        reasons, merged, _, warnings, events, stats, _ = run_target(IDENT, [reply], old=old)
        self.assertEqual(reasons, [])
        self.assertNotIn("jane.doe", seen[0], "the model never sees the personal value")
        self.assertNotIn("jane.doe", sc.render(merged))
        self.assertIn("- Whisper STT runs on port 8178", merged.body)
        self.assertEqual(dict(stats["privacy"]["current_scroll"]), {"contact": 2})
        self.assertTrue(any("explicit privacy removal" in w for w in warnings), warnings)
        self.assertIn({"event": "privacy", "target": IDENT.rel, "where": "current_scroll", "removed": {"contact": 2}}, events)
        # A non-personal locked bullet is still protected.
        bad = section_reply(IDENT.rel, {"Standing Rules": ["- Never email [contact removed] without approval from Nic"]})
        reasons, merged, *_ = run_target(IDENT, [bad, bad], old=old)
        self.assertIsNone(merged)
        self.assertTrue(any("locked decision was dropped" in r for r in reasons), reasons)

    def test_reply_filtered_before_validation_and_counted(self):
        reply = section_reply(IDENT.rel, {
            "Identity": PERSONAL["contact"][:1] + PERSONAL["finance"][:1] + ["- Name: Tony, the background agent"],
            "Standing Rules": ["- Never commit .env files"],
        }, facts=[], entities=[{"name": "Priya", "entityType": "person", "observations": ["friend who sends gig emails"]}, {"name": "Whisper STT", "entityType": "service", "observations": ["port 8178"]}])
        reasons, merged, ents, warnings, events, stats, _ = run_target(IDENT, [reply])
        self.assertEqual(reasons, [])
        no_values(self, sc.render(merged) + json.dumps(ents) + json.dumps(warnings) + json.dumps(events))
        self.assertEqual([e["name"] for e in ents], ["Whisper STT"])
        self.assertEqual(privacy.tally_json(stats["privacy"]), {"body": {"contact": 1, "finance": 1}, "entities": {"third_party": 1}})
        ev = [e for e in events if e.get("event") == "privacy"]
        self.assertEqual(ev, [{"event": "privacy", "target": IDENT.rel, "chunk": 1, "where": "reply", "removed": {"body": {"contact": 1, "finance": 1}, "entities": {"third_party": 1}}}])

    def test_sync_embeds_the_filtered_scroll(self):
        srv = StubAllm(workspaces={"librarian": {"slug": "librarian", "documents": []}}).start()
        sb = Sandbox()
        try:
            root = sb.root / "scrolls"
            # A scroll written before the filter existed (or edited by hand).
            body = section_reply(PROJ.rel, {"Active State": ["- Owner email: jane.doe@example.com", "- Status card ships blue"]})["updated_markdown"]
            write_scroll(root, PROJ.rel, sc.Scroll(PROJ.scroll_id, PROJ.category, NOW_ISO, 1, [], [], body), sb.root / "state" / "h")
            st = {}
            out = sync.sync_changed(ScrollWriter(Conn(srv.url, SENTINEL_KEY), "librarian"), st, root, [PROJ.rel], lambda: None)
            self.assertEqual(out["synced"], [PROJ.scroll_id])
            self.assertEqual(out["privacy"], {"contact": 1})
            sent = json.dumps(srv.bodies)
            self.assertNotIn("jane.doe", sent)
            self.assertIn("Status card ships blue", sent)
            self.assertIn("jane.doe", (root / PROJ.rel).read_text(encoding="utf-8"), "the file on disk is not rewritten by sync")
        finally:
            sb.close()
            srv.stop()


# ── review regressions (synthetic values only) ──────────────────────────────

# Lines each detector must catch (dropped, or redacted in place), per review finding.
LEAKS = {
    "phone": ["- Call the client at 416-555-0199.", "- Call (416) 555-0199.", "- Phone 4165550199", "- Cell +14165550199", "- UK office +44 20 7946 0958", "- tel:416-555-0199 for bookings"],
    "third_party": ["- Priya Shah emailed about the audition", "- Priya Shah, casting director, sends weekly notices", "- newsletter from Priya Shah every Monday"],
    "exemptions": [
        "- User personality: perfectionist, wants the AI to double-check work", "- Nic is an introvert and night owl; prefers async updates from agents",
        "- Home thermostat and smart TV controlled through the Home Assistant integration", "- Planning a cabin build off-grid; tracks it in cabin.md",
        "- Guitar rig: Neural DSP plugins synced to the studio server",
    ],
    "finance": [
        "- Price for the shoot was 500$ plus travel", "- estimate: 2.5k plus materials", "- Paid 1.2k for the new lens", "- Charged 85/hr", "- estimate came to 1200",
        "- Interested in stock trading on the side", "- Forex trading on weekends",
    ],
    "address": ["- Lives at 123 main street, apartment 4", "- Mail to 45 St. Clair Ave W", "- Office at 12 O'Connor Dr", "- Springfield, IL 62704 is the mailing address"],
    "age": ["- Nic is a 34-year-old developer who works nights", "- Age 34, works as a developer and actor"],
    "life_plans": ["- Planning to buy a plot of land up north next year", "- Side projects: a protein counter and a budget tracker"],
    "coords": ["- Location 43.6532° N, 79.3832° W is the meetup spot", "- lat 43.65 lon -79.38 meetup"],
}
LEAK_VALUES = ("555-0199", "555 0199", "5550199", "7946", "Priya", "Shah", "500$", "2.5k", "1.2k", "85/hr", "1200", "123 main", "St. Clair", "O'Connor", "62704", "34", "43.6532", "43.65")

# Work content the filter must leave exactly as written (each was dropped or mangled before).
WORK = [
    "- Never book anything over $50 without asking first", "- Never give medical diagnoses or dosage advice",
    "- IPC calls from React go through Tauri invoke only", "- Use the HTTP client Reqwest for LM Studio calls", "- Chose Approach B. for the dispatcher queue",
    "- Never take on tech debt in the dispatcher", "- CloudMart invoice-service runs on Cloud Run", "- Use the systematic-debug skill for diagnosis before any fix",
    "- UI must stay usable for people with disabilities (WCAG AA)", "- Store the archive under my home folder on D drive",
    "- Frontend imports invoke from @tauri-apps/api/core", "- Mark handlers with @staticmethod in the bridge", "- FastAPI routes are declared with @app.get decorators.",
    "- Use @dataclass for state objects.", "- SDK is @anthropic-ai/sdk",
    "- Instagram webhook: DMs from Instagram arrive via the tunnel guard.", "- Messages from Booking Desk route to Tony.",
    "- Kanban: subtasks inherit their parent's status; decompose links child tasks to their parent.",
    "- CloudMart order events flow through Pub/Sub subscriptions.", "- Hermes posts heartbeat alerts to the Telegram group chat.",
    "- Maps: OpenStreetMap + OSRM for routing and travel time (no Google Maps key).", "- Charging Station widget shows battery for the laptop.",
    "- Paying down tech debt in server.py comes before new features.", "- CloudMart generates invoices for each order.", "- Cost guardian alerts when monthly spend passes $5",
    "- Phase 2 Audit Trail logs every skill run.", "- Sync 2 Google Drive folders nightly", "- Image sizes 512 768 1024 are supported", "- Router weights 0.125, 0.875 for cost vs speed",
    "- Go with Approach B.", "- The HTTP client Timeout is 30s.", "- Retirement of Gemini CLI: agy replaces it everywhere.", "- accessibility tool for people with visual disabilities",
    "- Token budget 4096 for chunk prompts", "- max-age 3600 on static assets", "- Whisper STT runs on port 8178",
]


class ReviewRegressionTests(unittest.TestCase):
    pol = privacy.default_policy()

    def test_leaks_are_caught(self):
        for group, lines in LEAKS.items():
            for line in lines:
                cat, red = privacy.check_line(line, self.pol)
                self.assertTrue(cat or red != line, f"{group}: {line}")
                if not cat:
                    self.assertTrue(re.search(r"\[(?:contact|location) removed\]", red), red)

    def test_work_content_untouched(self):
        for line in WORK:
            self.assertEqual(privacy.check_line(line, self.pol), (None, line), line)
        body = "\n".join(["# T", "", "## Locked Design Decisions", ""] + WORK)
        out, c = privacy.filter_body(body, self.pol)
        self.assertEqual((out, c), (body, Counter()))

    def test_person_entities_side_projects_age_and_traits(self):
        ents = [
            {"name": "Priya Shah", "entityType": "person", "observations": ["Sends weekly audition notices by email", "Works at a talent agency"]},
            {"name": "Land Plan", "entityType": "concept", "observations": ["Plans to get a plot of land up north", "Wants to build a cabin"]},
            {"name": "Stock Trading", "entityType": "concept", "observations": ["wants to learn stock trading"]},
            {"name": "Personal_Apps_Built", "entityType": "project", "observations": ["protein counter", "budget tracker"]},
            {"name": "Nic", "entityType": "person", "observations": ["Introvert who prefers async updates from AI agents", "Is a 34-year-old developer", "Prefers terse replies"]},
            {"name": "Tony", "entityType": "person", "observations": ["Background agent persona (chill, loyal)"]},
            {"name": "Librarian", "entityType": "person", "observations": ["Writes the memory scrolls"]},
        ]
        kept, c = privacy.filter_entities(ents, self.pol)
        self.assertEqual([e["name"] for e in kept], ["Nic", "Tony", "Librarian"])
        self.assertEqual(kept[0]["observations"], ["Prefers terse replies"])
        self.assertEqual(c, Counter({"third_party": 1, "life_plans": 2, "finance": 1, "personality": 1, "dob_age": 1}))
        no_values(self, json.dumps(kept))

    def test_personal_headings_filtered_template_headings_kept(self):
        body = "# Agentic OS\n\n## Active State\n\n### Client Priya - 416-555-0199 - $1,200 quote\n- Whisper STT runs on port 8178\n\n### Mail to jane.doe@example.com weekly digest summary\n- Kept\n"
        out, c = privacy.filter_body(body, self.pol)
        self.assertNotIn("416", out)
        self.assertNotIn("jane.doe", out)
        self.assertIn("## Active State", out)
        self.assertIn("# Agentic OS", out)
        self.assertIn("### [finance removed]", out, "a dropped heading stays a heading")
        self.assertIn("### Mail to [contact removed] weekly digest summary", out)
        self.assertEqual(c, Counter({"finance": 1, "contact": 1}))
        self.assertEqual(privacy.filter_body(out, self.pol), (out, Counter()), "idempotent")

    def test_filtered_locked_bullet_reported_on_its_own(self):
        # A personal locked bullet is an explicit privacy removal with its own warning and event
        # (section + action + category, never the value); non-personal locked rules all survive.
        rules = ["- Never book anything over $50 without asking first", "- Never give medical diagnoses or dosage advice", "- Whisper STT runs on port 8178"]
        old = old_scroll(IDENT, {"Standing Rules": rules + ["- Never share the client quote of $1,250", "- Ping jane.doe@example.com before any release"]})
        reply = section_reply(IDENT.rel, {"Standing Rules": rules + ["- Ping [contact removed] before any release"]})
        reasons, merged, _, warnings, events, stats, _ = run_target(IDENT, [reply], old=old)
        self.assertEqual(reasons, [])
        for r in rules:
            self.assertIn(r, sc.section_bullets(merged.body, ["Standing Rules"]))
        lk = [e for e in events if e.get("event") == "privacy_locked"]
        self.assertEqual(lk, [{"event": "privacy_locked", "target": IDENT.rel, "where": "current_scroll", "removed": [
            {"section": "Standing Rules", "action": "dropped", "category": "finance", "count": 1},
            {"section": "Standing Rules", "action": "redacted", "category": "contact", "count": 1},
        ]}])
        self.assertTrue(any("LOCKED bullet(s)" in w and "## Standing Rules: finance dropped x1, contact redacted x1" in w for w in warnings), warnings)
        self.assertEqual(sorted(stats["privacy_locked"]), [("Standing Rules", "dropped", "finance"), ("Standing Rules", "redacted", "contact")])
        no_values(self, json.dumps(events) + json.dumps(warnings) + sc.render(merged))

    def test_never_lock_breadth(self):
        durable = [
            "- Weather: Open-Meteo is the weather provider (no key needed).", "- Heartbeat skill scans agent health every 5 minutes.",
            "- Gmail inbox triage runs nightly through the n8n workflow.", "- Data Sovereignty: No data leaves machine unless explicitly requested",
            "- Response Style: terse; plain refusal if action cannot be completed", "- Dispatcher validates every plan against the role schema",
        ]
        for b in durable:
            self.assertIsNone(distill.one_off_kind(b), b)
        for b in ["- Weather Tool: uses weather.current for local conditions.", "- Email Search: scans only the inbox for newsletter senders.",
                  "- Sent a WhatsApp message to the group.", "- Calendar: created an event for Friday's audition."]:
            self.assertEqual(distill.one_off_kind(b), "action", b)

    def test_existing_locked_bullet_moved_out_is_put_back(self):
        old = old_scroll(ARCH, {"Locked Design Decisions": ["- Dispatcher validates every plan against the role schema", "- LM Studio serves chat on :1235"]})
        reply = section_reply(ARCH.rel, {
            "Ports & Services": ["- Whisper on :8178", "- Dispatcher validates every plan against the role schema"],
            "Locked Design Decisions": ["- LM Studio serves chat on :1235"],
        })
        reasons, merged, _, warnings, events, stats, _ = run_target(ARCH, [reply], old=old)
        self.assertEqual(reasons, [])
        self.assertEqual(sc.section_bullets(merged.body, ["Locked Design Decisions"]), ["- LM Studio serves chat on :1235", "- Dispatcher validates every plan against the role schema"])
        self.assertEqual(sc.section_bullets(merged.body, ["Ports & Services"]), ["- Whisper on :8178"])
        self.assertEqual(stats["relocked"], 1)
        self.assertIn({"event": "never_lock_relock", "target": ARCH.rel, "chunk": 1, "relocked": 1, "to": {"Locked Design Decisions": 1}}, events)
        self.assertTrue(any("existing locked bullet(s)" in w for w in warnings), warnings)
        self.assertIn("A bullet already under a locked heading in CURRENT SCROLL stays there verbatim", distill.DISTILL_SYSTEM)

    def test_demoted_bullet_takes_its_sub_bullets(self):
        cur = section_reply(ARCH.rel, {"Locked Design Decisions": ["- LM Studio serves chat on :1235"]})["updated_markdown"]
        body = section_reply(ARCH.rel, {"Locked Design Decisions": ["- LM Studio serves chat on :1235", "- Idea: maybe a plugin market", "  - plugin manifests must be signed", "  continued note"]})["updated_markdown"]
        out, moved = distill.demote_one_off_locked(ARCH, body, cur)
        self.assertEqual(moved, [("idea", "Ports & Services")])
        locked = [ln for s, lvl, ln in sc._outline(out) if s == "Locked Design Decisions" and lvl == 0 and ln.strip()]
        self.assertEqual(locked, ["- LM Studio serves chat on :1235"])
        ports = [ln for s, lvl, ln in sc._outline(out) if s == "Ports & Services" and lvl == 0 and ln.strip()]
        self.assertEqual(ports[-3:], ["- Idea: maybe a plugin market", "  - plugin manifests must be signed", "  continued note"])


# ── end to end: compact (archive lossless) and offload (preview / apply) ────


def personal_reply(messages):
    """A valid distiller reply for the prompt's TARGET with personal lines, a durable locked
    bullet, a one-off locked bullet and personal + allowed entities."""
    u = messages[1]["content"]
    rel = re.search(r"^TARGET: (\S+)", u, re.M).group(1)
    t = sc.target_info(rel)
    hs = sc.headings_for(t)
    locked = next((h for h in hs if h in sc.LOCKED_HEADINGS), None)
    sections = {hs[0]: ["- Owner email: jane.doe@example.com", "- Client quote: $1,250 for the shoot", "- Whisper STT runs on port 8178"]}
    if locked:
        sections[locked] = ["- Always use LM Studio on :1235", "- Weather Tool: weather.current used for local conditions"]
    ents = [{"name": "Priya", "entityType": "person", "observations": ["friend who sends gig emails"]}, {"name": "Whisper STT", "entityType": "service", "observations": ["runs on port 8178"]}]
    return json.dumps(section_reply(rel, sections, entities=ents))


class EndToEndPrivacyTests(unittest.TestCase):
    def setUp(self):
        self.allm = stub_allm().start()
        self.gw = StubGateway(active=False).start()
        self.sb = Sandbox(allm_url=self.allm.url, gateway_url=self.gw.url, os_json=OS_JSON)
        threads = noisy_threads()
        threads["p"] = [turn(1794939000200, "user", "Locked: Whisper STT runs on port 8178. My email is jane.doe@example.com and the client quote was $1,250", "p1")]
        self.sb.threads(threads)
        self.preview = self.sb.root / "preview"

    def tearDown(self):
        self.sb.close()
        self.allm.stop()
        self.gw.stop()

    def test_compact_archive_lossless_tier2_filtered(self):
        events = []
        llm = FakeLLM([personal_reply] * 32)
        res = compact.run(self.sb.paths(), compact.CompactOptions(llm=llm, max_batches=16, now=NOW), self.sb.env, events.append)
        self.assertTrue(res["scrolls_updated"], res)
        aid = res["archive_ids"][0]
        _, rows = archive.read_entry(self.sb.root / "archive", aid)
        self.assertIn("jane.doe@example.com", json.dumps(rows), "the cold archive stays lossless")
        tier2 = "\n".join(sc.render(s) for _, s, _ in sc.list_scrolls(self.sb.root / "scrolls"))
        tier2 += json.dumps(graph.read_entities(self.sb.root / "kg" / "knowledge-graph.json"))
        tier2 += json.dumps(self.allm.bodies)
        no_values(self, tier2)
        self.assertIn("Whisper STT runs on port 8178", tier2)
        self.assertIn("Weather Tool: weather.current", tier2, "a demoted bullet is moved, not deleted")
        for _, s, _ in sc.list_scrolls(self.sb.root / "scrolls"):
            for b in sc.section_bullets(s.body, sc.LOCKED_HEADINGS):
                self.assertIsNone(distill.one_off_kind(b), b)
        self.assertEqual(res["privacy"]["policy_sha"], privacy.default_policy().sha)
        self.assertEqual(set(privacy.tally_total({k: Counter(v) for k, v in res["privacy"]["removed"].items()})), {"contact", "finance", "third_party"})
        self.assertGreater(res["never_lock_demoted"], 0)
        no_values(self, json.dumps(res) + json.dumps(events))
        self.assertTrue([e for e in events if e.get("event") == "privacy"])
        self.assertTrue([e for e in events if e.get("event") == "never_lock"])

    def dry(self, llm=None):
        events = []
        res = offload.dry_run(self.sb.paths(), offload.OffloadOptions(preview_dir=self.preview, llm=llm or FakeLLM([personal_reply] * 64), now=NOW, sources="all"), self.sb.env, events.append)
        return res, events

    def apply(self, token):
        return self.sb.cli("offload", "--json", "--apply", "--preview-dir", str(self.preview), "--confirm", token)

    def test_offload_preview_report_manifest_counts_only(self):
        res, events = self.dry()
        prev = Path(res["preview_dir"])
        files = "".join(p.read_text(encoding="utf-8") for p in prev.rglob("*") if p.is_file())
        no_values(self, files + json.dumps(res) + json.dumps(events))
        report = json.loads((prev / "report.json").read_text(encoding="utf-8"))
        manifest = json.loads((prev / "manifest.json").read_text(encoding="utf-8"))
        pol = privacy.default_policy()
        self.assertEqual(manifest["schema"], offload.MANIFEST_SCHEMA)
        self.assertEqual((manifest["privacy"]["version"], manifest["privacy"]["sha"]), (pol.version, pol.sha))
        self.assertEqual(report["privacy"], manifest["privacy"])
        self.assertTrue({"contact", "finance"} <= set(report["privacy"]["removed_total"]), report["privacy"])
        self.assertGreater(report["never_lock_demoted"], 0)
        rows = [r for r in report["proposed"]["targets"] if r["mode"] == "live"]
        self.assertTrue(rows and all(r["privacy_removed"] for r in rows))
        for rel, m in manifest["distill"].items():
            self.assertIn("privacy_removed", m)
        self.assertTrue([e for e in events if e.get("event") == "privacy" and e.get("removed")])
        for w in report["warnings"]:
            if "privacy" in w:
                self.assertRegex(w, r"\((?:[a-z_]+ x\d+(?:, )?)+\)")

    def _no_writes(self, lines, tree, msg):
        self.assertEqual(lines[0], 2, lines)
        self.assertIn(msg, lines[1][-1]["error"])
        self.assertEqual([p for m, p in self.allm.requests if m == "POST"], [])
        self.assertEqual(self.sb.tree(), tree)

    def test_apply_refuses_a_preview_from_another_policy(self):
        with mock.patch.object(privacy_policy, "POLICY_VERSION", 0):
            res, _ = self.dry()
        self.allm.requests.clear()
        tree = self.sb.tree()
        self._no_writes(self.apply(res["token"]), tree, "another privacy policy")

    def test_apply_refuses_a_preview_after_the_override_changed(self):
        res, _ = self.dry()
        (self.sb.root / "state" / "privacy-policy.json").write_text(json.dumps({"allow": ["finance"]}), encoding="utf-8")
        self.allm.requests.clear()
        tree = self.sb.tree()
        self._no_writes(self.apply(res["token"]), tree, "another privacy policy")

    def test_apply_refuses_a_v2_preview_made_before_the_booking_filter_and_d_move(self):
        """A pre-filter v2 preview (e.g. token 04a502a35827) can never be promoted, even when every
        other check (token, policy, files, base versions) still passes."""
        with mock.patch.object(offload, "MANIFEST_SCHEMA", "agentic-os.offload-preview.v2"):
            res, _ = self.dry()
        self.assertIn("agentic-os.offload-preview.v2", offload.LEGACY_SCHEMAS)
        self.allm.requests.clear()
        tree = self.sb.tree()
        self._no_writes(self.apply(res["token"]), tree, "predates the Booking source filter")

    def test_apply_refuses_a_preview_read_under_another_source_filter(self):
        with mock.patch.object(sources, "SOURCE_FILTER_VERSION", sources.SOURCE_FILTER_VERSION - 1):
            res, _ = self.dry()
        self.allm.requests.clear()
        tree = self.sb.tree()
        self._no_writes(self.apply(res["token"]), tree, "another Booking source filter")

    def test_apply_refuses_a_preview_made_for_other_write_targets(self):
        res, _ = self.dry()
        manifest = json.loads((Path(res["preview_dir"]) / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(set(manifest["write_targets"]), {"scrolls_root", "kg_path"})
        self.assertNotIn(str(self.sb.root), json.dumps(manifest["write_targets"]), "hashes, never the paths")
        self.assertEqual(manifest["source_filter"], sources.SOURCE_FILTER_VERSION)
        self.allm.requests.clear()
        tree = self.sb.tree()
        for over in ({"MEMORY_SCROLLS_DIR": str(self.sb.root / "other-scrolls")}, {"MEMORY_KG_PATH": str(self.sb.root / "other-kg" / "knowledge-graph.json")}):
            code, lines = self.sb.cli("offload", "--json", "--apply", "--preview-dir", str(self.preview), "--confirm", res["token"], extra_env=over)
            self._no_writes((code, lines), tree, "another scrolls root or knowledge graph")

    def test_apply_refuses_a_legacy_v1_preview(self):
        with mock.patch.object(offload, "MANIFEST_SCHEMA", "agentic-os.offload-preview.v1"):
            res, _ = self.dry()
        self.allm.requests.clear()
        tree = self.sb.tree()
        self._no_writes(self.apply(res["token"]), tree, "predates the Tier-2 privacy filter")

    def test_apply_refuses_a_preview_still_holding_personal_data(self):
        # A preview written while the filter was bypassed (e.g. an older build) with a current manifest.
        identity = lambda x, p=None: (x, Counter())  # noqa: E731
        with mock.patch.object(privacy, "filter_body", identity), mock.patch.object(privacy, "filter_entities", lambda e, p=None: (list(e), Counter())), mock.patch.object(privacy, "filter_facts", lambda f, p=None: (list(f), Counter())):
            res, _ = self.dry()
        self.assertIn("jane.doe@example.com", "".join(p.read_text(encoding="utf-8") for p in Path(res["preview_dir"]).rglob("*.md")))
        self.allm.requests.clear()
        tree = self.sb.tree()
        code, lines = self.apply(res["token"])
        self._no_writes((code, lines), tree, "holds content the privacy filter removes")
        no_values(self, lines[-1]["error"])

    def test_apply_promotes_a_filtered_preview(self):
        res, _ = self.dry()
        code, lines = self.apply(res["token"])
        self.assertEqual(code, 0, lines)
        tier2 = "\n".join(sc.render(s) for _, s, _ in sc.list_scrolls(self.sb.root / "scrolls")) + json.dumps(self.allm.bodies)
        tier2 += json.dumps(graph.read_entities(self.sb.root / "kg" / "knowledge-graph.json"))
        no_values(self, tier2)


if __name__ == "__main__":
    unittest.main()
