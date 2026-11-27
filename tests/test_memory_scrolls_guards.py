"""Memory Scrolls content guards (the 4-lens review that blocked preview 20261119-190907).

- Stale claims: a versioned policy (built-in defaults + `<state_dir>/stale-claims.json` add/remove,
  `--show-stale-claims`, version + sha in the manifest, checked by `--apply`) drops stale claims
  from source lines before distillation and from every reply bullet / fact / KG observation after;
  contested claims leave the locked sections as "(unconfirmed)"; an existing locked bullet only
  goes when its rule says `existing: true`, and then it is logged under ## Superseded Decisions.
- Never-lock hardening: a NEW locked bullet needs a POSITIVE durable marker; a model name alone,
  status / state phrasing, schema-field bullets and persona names never lock; a project batch with
  no authoritative (hub / task-system) source locks nothing new.
- Schema echo: the dispatcher / planner envelope is stripped from chat sources and from outputs.
- Identity: the Command Center roster (mirrored, checked against the TS source here) is never the
  user; person entities other than the operator go; relabel bullets / facts go; KG near-duplicates
  merge.
- Privacy gaps: diet / body-metric terms are health, temperament judgements are personality, and
  the DENIED sections of the hub MASTER_IDENTITY yield automatic deny terms (hashed, never printed).
- Prompt + cosmetics: rules 14-16, H1 titles from a slug map, malformed Superseded lines, ASCII
  ellipsis and ASCII CLI output.
- A synthetic replay of the blocked reply shapes, end to end through the offload dry-run and the
  `--apply` validation.

All synthetic data, temp roots and stub servers. Run with: python3 tests/run_all.py
"""

from __future__ import annotations

import io
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

from memory_scrolls import cli, compact, distill, guards, offload, privacy, privacy_policy, stale_claims  # noqa: E402
from memory_scrolls import scroll as sc  # noqa: E402
from memory_scrolls_stubs import StubGateway  # noqa: E402
from test_memory_scrolls import NOW, NOW_ISO, FakeLLM, Sandbox, section_reply, turn  # noqa: E402
from test_memory_scrolls import setUpModule, tearDownModule  # noqa: E402,F401
from test_memory_scrolls_offload import OS_JSON, stub_allm  # noqa: E402

ARCH = sc.target_info("core/architecture_decisions.md")
PROJ = sc.target_info("projects/agentic-os.md")
IDENT = sc.target_info("core/identity_and_preferences.md")
CC = REPO / "command center" / "src" / "features"

# One synthetic line per default drop rule (generic product names and paths, no personal values).
STALE = {
    "platform-linux": "- Platform: Linux environment (Ubuntu/WSL).",
    "legacy-agent-roster": "- Architecture: 3 agents (opencode, Hermes, Gemini CLI) + FastAPI dashboard.",
    "stale-model": "- Model: deepseek-v4-flash-free (free-tier first).",
    "cloudmart-project": "- Active project: CloudMart multi-region store",
    "hub-kg-path": "- Memory graph: C:\\ai-hub\\memory\\knowledge-graph.json.",
    "mutating-default": "- Mutating: True for any external communication or state change.",
    "legacy-free-tier-list": "- Budget: only GCP Free Tier, GitHub Student Developer Pack, Colab, Kaggle.",
    "legacy-runtime": "- Technical: Python 3.10+ (FastAPI), Node.js 18+ (opencode).",
}
MORE_STALE = {
    "stale-model": "- Preferred model: Owl Alpha via OpenRouter",
    "mutating-default": "- Default mutating=true for message forwarding",
    "legacy-runtime": "- Hermes needs Python 3.11+ and Node.js",
    "legacy-agent-roster": "- Agents: opencode first, then Hermes for memory",
}
CONTESTED = {
    "contested-escalation-ladder": "- Escalation: local agents \u2192 Gemini (heavy) \u2192 Claude (polish).",
    "contested-librarian-sole-writer": "- Librarian is the ONLY agent that writes rules.",
}
CURRENT = [
    "- CLI: agy CLI (Antigravity) replaces deprecated gemini CLI.",
    "- OS: Windows 11 on the desktop",
    "- LM Studio serves Qwen 3.5 9B on :1235",
    "- Gemini CLI and the Gemini API stay second-opinion engines",
    "- Memory graph: D:\\ai-hub-memory\\knowledge-graph.json",
    "- Free-tier first; never recommend paid services without warning",
    "- Docker builds the gateway image",
    "- Root: C:\\ai-hub (read-only source)",
]


def run_target(t, replies, old=None, policy=None, text="Concept: x", lock_new=True, stale=None):
    llm = FakeLLM(replies)
    events, warnings, stats = [], [], {}
    budget = {"used": 0, "max": 6, "save": lambda: None}
    reasons, merged, ents, _ = compact.distill_target(llm, t, old, text, "arch-2026-11-19-01", NOW_ISO, [], {}, budget, warnings, [], events.append, policy, stats,
                                                      lock_new=lock_new, stale=stale)
    return reasons, merged, ents, warnings, events, stats, llm


def old_scroll(t, sections, log=()):
    body = section_reply(t.rel, sections)["updated_markdown"]
    if log:
        body = body.rstrip() + "\n\n" + "\n".join(log) + "\n"
    return sc.Scroll(t.scroll_id, t.category, NOW_ISO, 1, ["arch-2026-11-18-01"], [], body)


def body_outside_log(body: str) -> str:
    return "\n".join(line for sec, lvl, line in sc._outline(body) if sec != sc.SUPERSEDED)


# ── stale claims ────────────────────────────────────────────────────────────


class StaleClaimsPolicyTests(unittest.TestCase):
    def test_defaults_catch_every_conflict_and_keep_current_facts(self):
        pol = stale_claims.default_policy()
        self.assertEqual(pol.version, stale_claims.STALE_CLAIMS_VERSION)
        for rid, line in list(STALE.items()) + list(MORE_STALE.items()):
            r = pol.match(line)
            self.assertIsNotNone(r, line)
            self.assertEqual((r.id, r.action), (rid, "drop"), line)
        for rid, line in CONTESTED.items():
            r = pol.match(line)
            self.assertEqual((r.id, r.action), (rid, "demote"), line)
        for line in CURRENT:
            self.assertIsNone(pol.match(line), line)
        refs = {r.id: r.ref for r in pol.rules}
        self.assertEqual((refs["platform-linux"], refs["stale-model"], refs["hub-kg-path"], refs["mutating-default"]), ("#8", "#7", "#15", "#22"))
        self.assertEqual((refs["contested-librarian-sole-writer"], refs["contested-escalation-ladder"]), ("#4", "#5"))

    def test_override_add_remove_bad_entries_and_hash(self):
        sb = Sandbox(key=None)
        try:
            (sb.root / "state" / "stale-claims.json").write_text(json.dumps({
                "add": [
                    {"id": "zq-old-port", "pattern": r"\bport 4321\b", "action": "drop", "reason": "moved", "ref": "#x"},
                    {"id": "bad-regex", "pattern": "([", "action": "drop"},
                    {"id": "bad-action", "pattern": "x+", "action": "explode"},
                    {"id": "platform-linux", "pattern": "dup", "action": "drop"},
                    "not an object",
                ],
                "remove": ["contested-escalation-ladder", "no-such-rule"],
                "extra": 1,
            }), encoding="utf-8")
            pol = stale_claims.load(sb.root / "state")
            ids = [r.id for r in pol.rules]
            self.assertIn("zq-old-port", ids)
            self.assertNotIn("contested-escalation-ladder", ids)
            self.assertNotIn("bad-regex", ids)
            self.assertTrue(pol.override_present)
            self.assertNotEqual(pol.sha, stale_claims.default_policy().sha)
            self.assertEqual(pol.match("- Gateway listens on port 4321").id, "zq-old-port")
            blob = json.dumps(pol.warnings)
            self.assertIn("4 add entr", blob)
            self.assertIn("1 unknown remove", blob)
            self.assertNotIn("4321", blob, "patterns are never echoed")
            d = stale_claims.describe(pol)
            row = next(r for r in d["rules"] if r["id"] == "zq-old-port")
            self.assertNotIn("pattern", row)
            self.assertEqual(len(row["pattern_sha"]), 12)
            self.assertIn("pattern", next(r for r in d["rules"] if r["id"] == "platform-linux"))
            code, lines = sb.cli("status", "--show-stale-claims")
            self.assertEqual(code, 0)
            shown = lines[0]["stale_claims"]
            self.assertEqual((shown["version"], shown["sha"], shown["override_present"]), (pol.version, pol.sha, True))
            self.assertNotIn("4321", json.dumps(lines))
            (sb.root / "state" / "stale-claims.json").write_text("{not json", encoding="utf-8")
            bad = stale_claims.load(sb.root / "state")
            self.assertEqual([r.id for r in bad.rules], [r.id for r in stale_claims.DEFAULT_RULES], "a bad file never weakens the defaults")
        finally:
            sb.close()

    def test_source_lines_never_reach_the_model(self):
        recs = [
            {"kind": "doc", "ts": "", "source": "brain:constraints.md", "text": "\n".join([STALE["platform-linux"], STALE["stale-model"], "- LM Studio serves Qwen 3.5 9B on :1235", CONTESTED["contested-escalation-ladder"]]), "meta": {"hint": "brain"}},
            {"kind": "turn", "ts": "", "source": "thread:general", "text": "user: we run on CloudMart now? no, Scene Reader is the focus", "meta": {}},
        ]
        sg = guards.SourceGuard()
        text = distill.batch_text(recs, "arch-x", (), guard=sg)
        for v in ("Ubuntu", "deepseek-v4", "CloudMart"):
            self.assertNotIn(v, text)
        self.assertIn("LM Studio serves Qwen 3.5 9B on :1235", text)
        self.assertIn("Escalation", text, "a contested (demote) claim may reach the model; the host keeps it unlocked")
        self.assertEqual(dict(sg.stale), {"platform-linux": 1, "stale-model": 1, "cloudmart-project": 1})

    def test_new_stale_bullets_dropped_contested_demoted_unconfirmed(self):
        reply = section_reply(ARCH.rel, {
            "Ports & Services": ["- LM Studio on :1235", STALE["hub-kg-path"]],
            "Locked Design Decisions": [STALE["stale-model"], STALE["legacy-agent-roster"], CONTESTED["contested-escalation-ladder"], CONTESTED["contested-librarian-sole-writer"],
                                        "- Gateway binds to 127.0.0.1 only"],
            "Guardrails": [STALE["mutating-default"], "- Never send without approval"],
        }, facts=[{"old": "- OS: Windows 11", "new": STALE["platform-linux"], "reason": "stale source"}])
        reasons, merged, _, warnings, events, stats, _ = run_target(ARCH, [reply])
        self.assertEqual(reasons, [])
        out = merged.body
        for v in ("deepseek", "opencode", "ai-hub\\memory", "Mutating", "Ubuntu"):
            self.assertNotIn(v, out, v)
        self.assertEqual(sc.section_bullets(out, ["Locked Design Decisions"]), ["- Gateway binds to 127.0.0.1 only"])
        guard = sc.section_bullets(out, ["Guardrails"])
        self.assertIn("- (unconfirmed) Escalation: local agents \u2192 Gemini (heavy) \u2192 Claude (polish).", guard)
        self.assertIn("- (unconfirmed) Librarian is the ONLY agent that writes rules.", guard)
        g = stats["guards"]
        self.assertEqual(dict(g["stale_output"]), {"hub-kg-path": 1, "stale-model": 1, "legacy-agent-roster": 1, "platform-linux": 1})
        self.assertEqual(g["schema_output"]["body"], 1, "the Mutating: True envelope field goes as a schema echo first")
        self.assertEqual(dict(g["stale_demoted"]), {"contested-escalation-ladder": 1, "contested-librarian-sole-writer": 1})
        ev = [e for e in events if e.get("event") == "guards"]
        self.assertTrue(ev and ev[0]["removed"]["stale_output"]["stale-model"] == 1, events)
        self.assertTrue(any("content guards removed or demoted" in w for w in warnings))

    def test_existing_locked_stale_bullet_logged_never_silent(self):
        durable = "- Keys and secrets never go in Git"
        old = old_scroll(ARCH, {"Locked Design Decisions": [STALE["stale-model"], CONTESTED["contested-librarian-sole-writer"], durable]})
        # The model echoes the current scroll verbatim, stale bullet included.
        reply = section_reply(ARCH.rel, {"Locked Design Decisions": [STALE["stale-model"], CONTESTED["contested-librarian-sole-writer"], durable]})
        reasons, merged, _, warnings, events, stats, llm = run_target(ARCH, [reply], old=old)
        self.assertEqual(reasons, [])
        self.assertNotIn("deepseek", body_outside_log(merged.body))
        log = sc.section_bullets(merged.body, [sc.SUPERSEDED])
        self.assertTrue(any("deepseek-v4-flash-free" in x and "(dropped: stale claim stale-model #7)" in x for x in log), log)
        self.assertEqual(sc.section_bullets(merged.body, ["Locked Design Decisions"]), [durable])
        self.assertIn("- (unconfirmed) Librarian is the ONLY agent that writes rules.", sc.section_bullets(merged.body, ["Guardrails"]))
        self.assertNotIn("deepseek-v4-flash-free (free-tier first).\n", json.dumps(llm.calls[0][1]["content"]).replace("\\n", "\n").split("## Superseded Decisions")[0],
                         "the model's CURRENT SCROLL no longer states it as current")
        self.assertEqual(dict(stats["guards"]["stale_current"]), {"stale-model": 1, "contested-librarian-sole-writer": 1})
        self.assertTrue([e for e in events if e.get("event") == "stale_claims" and e["where"] == "current_scroll"])
        self.assertTrue(any("logged under ## Superseded Decisions" in w for w in warnings))

    def test_existing_bullet_untouched_when_rule_is_not_existing(self):
        pol = stale_claims.Policy(1, (stale_claims.Rule("only-new", r"deepseek", "drop", "test", "", False),))
        old = old_scroll(ARCH, {"Locked Design Decisions": [STALE["stale-model"]]})
        reply = section_reply(ARCH.rel, {"Locked Design Decisions": [STALE["stale-model"], "- Model: deepseek-v4 mini on :1235"]})
        reasons, merged, *_ = run_target(ARCH, [reply], old=old, stale=pol)
        self.assertEqual(reasons, [])
        self.assertEqual(sc.section_bullets(merged.body, ["Locked Design Decisions"]), [STALE["stale-model"]], "existing kept, new dropped")

    def test_kg_observations_entities_and_facts(self):
        ents = [
            {"name": "Hermes Agent", "entityType": "service", "observations": ["Requires Python 3.11+ and Node.js"]},
            {"name": "CloudMart", "entityType": "project", "observations": ["e-commerce on GCP"]},
            {"name": "Librarian", "entityType": "tool", "observations": ["Only agent that writes rules", "Read-only researcher in Agentic OS"]},
            {"name": "LM Studio", "entityType": "tool", "observations": ["Serves Qwen 3.5 9B on :1235", "Graph lives at C:\\ai-hub\\memory\\knowledge-graph.json"]},
        ]
        out, dropped, demoted = guards.stale_entities(ents)
        names = [e["name"] for e in out]
        self.assertEqual(names, ["Librarian", "LM Studio"])
        self.assertEqual(out[0]["observations"][0], "(unconfirmed) Only agent that writes rules")
        self.assertEqual(out[1]["observations"], ["Serves Qwen 3.5 9B on :1235"])
        self.assertEqual(dict(dropped), {"legacy-runtime": 1, "cloudmart-project": 1, "hub-kg-path": 1})
        self.assertEqual(dict(demoted), {"contested-librarian-sole-writer": 1})
        facts, c = guards.stale_facts([{"old": "OS: Windows 11", "new": "Platform: Linux (WSL)"}, {"old": "Platform: Linux (WSL)", "new": "OS: Windows 11"}])
        self.assertEqual(facts, [{"old": "Platform: Linux (WSL)", "new": "OS: Windows 11"}], "a correction of a stale claim is kept")
        self.assertEqual(dict(c), {"platform-linux": 1})


# ── never-lock hardening ────────────────────────────────────────────────────


class NeverLockHardeningTests(unittest.TestCase):
    def test_positive_durable_marker_required(self):
        cases = {
            "unmarked": ["- Model: deepseek-v4-flash-free (free-tier first).", "- Storage: Markdown vaults for cross-agent compatibility.",
                         "- Coder model: Qwen 3.5 9B via LM Studio", "- Escalation goes local agents first, then cloud"],
            "status": ["- Audio Engine: ElevenLabs active; Spotify integration pending toggle.", "- Voice channel online, listening for commands",
                       "- Gateway restarted and recovered", "- Whisper currently enabled", "- LM Studio active on :1235", "- Sync pending upload"],
            "schema": ["- Mutating: true", "- Payload: Structured fields only", "- Missing: unknown values"],
            "persona": ["- Tony never sends without approval", "- Jarvis handles greetings on :8080"],
        }
        for kind, lines in cases.items():
            for b in lines:
                self.assertEqual(distill.one_off_kind(b), kind, b)
        # A generic envelope label is a schema field only in an envelope-shaped body.
        for b in ("- Role: General (Jarvis) for greetings", "- Intent: Confirm connection or propose next action", "- **Target**: Agent kind for all dispatches"):
            self.assertEqual(distill.one_off_kind(b, True), "schema", b)
            self.assertNotEqual(distill.one_off_kind(b), "schema", b)
        for b in ("- Whisper STT runs on port 8178", "- Never send messages without approval", "- Default model: Qwen 3.5 9B", "- Keys and secrets stay outside the repo",
                  "- Every project gets a finish line", "- Gmail skill: drafts only", "- Response Style: terse answers", "- Status words must never be enabled by default"):
            self.assertIsNone(distill.one_off_kind(b), b)

    def test_lock_sources(self):
        chat = [{"kind": "turn"}, {"kind": "rag_chat"}, {"kind": "training_log"}, {"kind": "gateway_chat"}, {"kind": "doc", "meta": {"hint": "brain"}}, {"kind": "doc", "source": "notes:x"}]
        self.assertFalse(distill.lock_sources_ok(chat))
        self.assertTrue(distill.lock_sources_ok(chat + [{"kind": "doc", "meta": {"hint": "hub"}}]))
        self.assertTrue(distill.lock_sources_ok(chat + [{"kind": "envelope"}]))

    def test_chat_only_project_target_locks_nothing_new_but_keeps_existing(self):
        old = old_scroll(PROJ, {"Locked Decisions": ["- Whisper STT runs on port 8178"]})
        reply = section_reply(PROJ.rel, {"Locked Decisions": ["- Whisper STT runs on port 8178", "- Always use LM Studio on :1235"]})
        reasons, merged, *_ = run_target(PROJ, [reply], old=old, lock_new=False)
        self.assertEqual(reasons, [])
        self.assertEqual(sc.section_bullets(merged.body, ["Locked Decisions"]), ["- Whisper STT runs on port 8178"])
        self.assertIn("- Always use LM Studio on :1235", sc.section_bullets(merged.body, ["Active State"]))


# ── schema echo ─────────────────────────────────────────────────────────────


class SchemaEchoTests(unittest.TestCase):
    def test_source_envelope_json_and_field_lines_stripped(self):
        text = "\n".join([
            "assistant: Here is the plan:",
            "{",
            '  "role": "general",',
            '  "intent": "confirm the connection",',
            '  "mutating": false,',
            '  "target": {"kind": "agent"},',
            '  "payload": {},',
            '  "missing": []',
            "}",
            "Role: general",
            "Intent: greet the user",
            "The gateway restarts nightly at 3am.",
            '{"task_id": "t1", "current_owner": "coder", "status": "queued"}',
        ])
        out, n = guards.strip_schema_text(text)
        self.assertEqual(out, "assistant: Here is the plan:\nThe gateway restarts nightly at 3am.")
        self.assertEqual(n, 4, "two envelope objects and two field lines")
        self.assertEqual(guards.strip_schema_text("Summary: the gateway restarts nightly")[0], "Summary: the gateway restarts nightly", "one generic label alone is prose")
        self.assertEqual(guards.strip_schema_text("Mutating: true")[0], "", "a strong envelope key is never prose")

    def test_reply_schema_bullets_and_observations_dropped(self):
        reply = section_reply(PROJ.rel, {
            "Locked Decisions": ["- Role: General (Jarvis) for greetings/status checks.", "- Intent: Confirm connection or propose next action.", "- Target: Agent kind for all dispatches.",
                                 "- Payload: Structured fields only; omit if none exist.", "- Missing: Capture unknown values in missing array.", "- Always use LM Studio on :1235"],
            "Active State": ['- {"role": "coder", "intent": "draft"}'],
        }, entities=[{"name": "Dispatcher plan", "entityType": "concept", "observations": ["Mutating: true", "Role: general", "Plans are JSON"]}])
        reasons, merged, ents, _, _, stats, _ = run_target(PROJ, [reply])
        self.assertEqual(reasons, [])
        self.assertEqual(sc.section_bullets(merged.body, ["Locked Decisions"]), ["- Always use LM Studio on :1235"])
        self.assertNotIn("role", sc.section_bullets(merged.body, ["Active State"])[0] if sc.section_bullets(merged.body, ["Active State"]) else "")
        for v in ("Intent:", "Payload:", "Missing:", "Jarvis"):
            self.assertNotIn(v, merged.body)
        self.assertEqual(ents[0]["observations"], ["Plans are JSON"])
        self.assertEqual(dict(stats["guards"]["schema_output"]), {"body": 6, "kg": 2})


# ── identity ────────────────────────────────────────────────────────────────


def _ts_list(path: Path, const: str) -> list:
    m = re.search(r"export const " + re.escape(const) + r"\s*=\s*\[([^\]]*)\]", path.read_text(encoding="utf-8"))
    return re.findall(r'"([^"]+)"', m.group(1)) if m else []


class IdentityTests(unittest.TestCase):
    def test_roster_mirrors_command_center(self):
        """guards.py mirrors the Command Center roster: this fails when roles.ts / router.ts /
        agents.ts change, so the mirror is updated with them."""
        roles = CC / "dispatcher" / "roles.ts"
        router = CC / "dispatcher" / "router.ts"
        agents = CC / "dispatcher" / "agents.ts"
        if not roles.is_file():
            self.skipTest("command center sources not present")
        self.assertEqual(tuple(_ts_list(roles, "ROLE_IDS")), guards.ROLE_IDS)
        self.assertEqual(tuple(_ts_list(router, "SELF_ROLE_IDS")), guards.SELF_ROLE_IDS)
        labels = re.findall(r'^\s*label:\s*"([^"]+)"', agents.read_text(encoding="utf-8"), re.M)
        self.assertEqual(set(labels) | {"Tony"}, set(guards.ROLE_LABELS))
        self.assertIn('"Booking Desk"', roles.read_text(encoding="utf-8"))
        for placeholder in ("Security Patrol", "Finance"):
            self.assertIn(placeholder, agents.read_text(encoding="utf-8"))
        for n in ("tony", "jarvis", "prompter", "designer", "coder", "librarian", "booking desk", "ops", "security patrol", "dispatcher", "conceptualizer"):
            self.assertIn(n, guards.AGENT_NAMES)
        self.assertNotIn("nic", guards.AGENT_NAMES)

    def test_person_entities_are_the_operator_or_nothing(self):
        ents = [
            {"name": "Nic", "entityType": "person", "observations": ["Operator of Agentic OS", "User: Tony (developer)"]},
            {"name": "Tony", "entityType": "person", "observations": ["User of Agentic OS system."]},
            {"name": "Jarvis persona", "entityType": "person", "observations": ["greets"]},
            {"name": "Zed Quorvath", "entityType": "person", "observations": ["reviews scripts"]},
            {"name": "Tony", "entityType": "tool", "observations": ["Command Center general agent"]},
        ]
        out, c = guards.identity_entities(ents)
        self.assertEqual([(e["name"], e["entityType"]) for e in out], [("Nic", "person"), ("Tony", "tool")])
        self.assertEqual(out[0]["observations"], ["Operator of Agentic OS"])
        self.assertEqual(dict(c), {"persona_person": 2, "third_party_person": 1, "user_relabel": 1})

    def test_user_relabel_lines_and_facts_dropped(self):
        for s in ("- User: Tony (Developer)", "- Building a calculator app for user (Tony).", "- The operator is Jarvis", "- Tony is the user"):
            self.assertTrue(guards.relabels_user(s), s)
        for s in ("- Tony is the user's assistant", "- Coder: user-facing fixes first", "- Name: Nic. Operator of Agentic OS.", "- Tony greets the user"):
            self.assertFalse(guards.relabels_user(s), s)
        reply = section_reply(PROJ.rel, {"Current Milestone": ["- Building a calculator app for user (Tony).", "- Scene Reader v3 ships"],
                                         "Active State": ["- Developer: AI/ML and DevOps"]},
                              facts=[{"old": "- User: Developer", "new": "- User: Tony (Developer) (arch-pending)", "reason": "relabel"}],
                              entities=[{"name": "Tony", "entityType": "person", "observations": ["User of Agentic OS system."]}])
        reply["updated_markdown"] = reply["updated_markdown"].rstrip() + "\n- 2026-11-19: - User: Developer -> - User: Tony (Developer) (arch-pending)\n"
        reasons, merged, ents, _, _, stats, _ = run_target(PROJ, [reply])
        self.assertEqual(reasons, [])
        self.assertNotIn("Tony", merged.body)
        self.assertEqual(sc.section_bullets(merged.body, [sc.SUPERSEDED]), [])
        self.assertEqual(ents, [])
        g = stats["guards"]["identity"]
        self.assertEqual((g["user_relabel"], g["user_relabel_fact"], g["persona_person"]), (2, 1, 1), "the bullet and the model's own log line")

    def test_near_duplicate_entities_merged(self):
        ents = [
            {"name": "Recipe Scaler App", "entityType": "project", "observations": ["Idea from chat", "Scales recipes"]},
            {"name": "Recipe Calculator App", "entityType": "project", "observations": ["Scales recipes", "Drafted by Coder"]},
            {"name": "LM Studio", "entityType": "tool", "observations": ["port 1235"]},
            {"name": "LM Studio server", "entityType": "tool", "observations": ["runs Qwen"]},
            {"name": "Gemini", "entityType": "tool", "observations": ["app"]},
            {"name": "Gemini CLI", "entityType": "tool", "observations": ["second opinion"]},
            {"name": "Qwen 3.5 9B", "entityType": "tool", "observations": ["main"]},
            {"name": "Qwen 2.5 Coder 14B", "entityType": "tool", "observations": ["no tools"]},
        ]
        out, n = guards.dedupe_entities(ents)
        self.assertEqual(n, 2)
        self.assertEqual([e["name"] for e in out], ["Recipe Scaler App", "LM Studio", "Gemini", "Gemini CLI", "Qwen 3.5 9B", "Qwen 2.5 Coder 14B"])
        self.assertEqual(out[0]["observations"], ["Idea from chat", "Scales recipes", "Drafted by Coder"])


# ── privacy gaps ────────────────────────────────────────────────────────────

IDENTITY_MD = """# MASTER_IDENTITY — v1 (draft)
Rule: ask when unsure.

## HOW HE DECIDES (worth-it filter)
- Builds apps: Scene Reader, the ZQX site, Estimator.

## VOICE
- No fluff, practical answers.

## SIDE VENTURES
- Runs ZQX with Quorvath Ltd on weekends; Mortadella hosts the shop.
- The ZQX menu tracks the daily protein plan.
- ZQX orders close on Sundays.

## PEOPLE
- Works with Bellwyn Ostrander on scripts.
"""
SYSTEM_MD = "# SYSTEM\n\n## Machines\n- Mortadella runs LM Studio on :1235\n- Mortadella also hosts the gateway\n"
STATUS_MD = "# STATUS\n\n## Working\n- ZQX site draft exists\n"


class PrivacyGapTests(unittest.TestCase):
    def test_diet_and_body_metrics_are_health(self):
        pol = privacy.default_policy()
        for s in ("- Daily calorie target and activity level for the app", "- Protein intake based on body weight", "- Diet: high protein, low carb", "- BMI tracked weekly",
                  "- Nutrition plan with macros"):
            self.assertEqual(privacy.check_line(s, pol)[0], "health", s)
        for s in ("- Model weights: 4-bit quant", "- Activity log rotates nightly", "- Never give medical or diet advice"):
            self.assertNotEqual(privacy.check_line(s, pol)[0], "health", s)

    def test_personality_judgements_but_not_style_rules(self):
        pol = privacy.default_policy()
        for s in ("- Tone: Gets quirky or nerdy when pushed.", "- Access: Open book, but people have to ask.", "- He is pretty stubborn about tooling", "- Gets defensive when challenged"):
            self.assertEqual(privacy.check_line(s, pol)[0], "personality", s)
        for s in ("- Voice: No fluff, practical, transparent answers.", "- Format: short plain answers, one step at a time", "- Persona: Tony gets sarcastic when pushed",
                  "- Agent tone: quirky and nerdy for the brand"):
            self.assertIsNone(privacy.check_line(s, pol)[0], s)

    def test_policy_version_and_prompt(self):
        self.assertEqual(privacy_policy.POLICY_VERSION, 7)
        rule = privacy.prompt_rule()
        self.assertIn("diet", rule)
        self.assertIn("temperament", rule)

    def test_auto_deny_terms_from_denied_sections(self):
        sb = Sandbox(key=None)
        try:
            for rel, text in (("master/MASTER_IDENTITY.md", IDENTITY_MD), ("master/SYSTEM.md", SYSTEM_MD), ("master/STATUS.md", STATUS_MD)):
                (sb.root / "hub" / rel).write_text(text, encoding="utf-8")
            terms, notes = offload.hub_auto_terms(sb.env)
            self.assertIn("zqx", terms, "named more in the denied sections than anywhere else")
            self.assertIn("quorvath", terms)
            self.assertIn("ostrander", terms)
            self.assertNotIn("mortadella", terms, "shared hub vocabulary")
            for common in ("ltd", "runs", "works", "side", "ventures", "people", "scene", "estimator"):
                self.assertNotIn(common, terms)
            self.assertEqual(notes["auto_deny_terms"], len(terms))
            base = privacy.default_policy()
            pol, _ = offload.effective_privacy(sb.paths(), sb.env)
            self.assertNotEqual(pol.sha, base.sha)
            self.assertEqual(privacy.check_line("- Builds apps: Scene Reader, the ZQX site, Estimator.", pol)[0], privacy_policy.HUB_DENIED)
            self.assertIsNone(privacy.check_line("- Mortadella runs LM Studio on :1235", pol)[0])
            d = privacy.describe(pol)
            self.assertEqual(d["auto_deny_terms"], len(terms))
            self.assertNotIn("zqx", json.dumps(d).lower())
            code, lines = sb.cli("status", "--show-privacy-policy")
            self.assertEqual(lines[0]["privacy_policy"]["auto_deny_terms"], len(terms))
            self.assertNotIn("quorvath", json.dumps(lines).lower())
        finally:
            sb.close()


# ── prompt + cosmetics ──────────────────────────────────────────────────────


class PromptAndCosmeticTests(unittest.TestCase):
    def test_prompt_rules(self):
        p = distill.system_prompt("qwen/qwen3.5-9b")
        self.assertIn("14 A request or idea from a single chat turn", p)
        self.assertIn("never Current Milestone", p)
        self.assertIn("15 Lessons hold causes", p)
        self.assertIn("16 Agent and persona names are never the user", p)
        self.assertIn("prefer the most recent dated source (for a count, a backup state", p)

    def test_titles_from_slug_map(self):
        self.assertEqual(sc.target_info("projects/agentic-os.md").title, "Agentic OS")
        self.assertEqual(sc.target_info("projects/ai-hub.md").title, "AI Hub")
        self.assertEqual(sc.target_info("projects/scene-reader.md").title, "Scene Reader")
        self.assertEqual(sc.target_info("projects/my-api-tool--gpu-notes.md").title, "My API Tool \u2014 GPU Notes")
        reply = section_reply(PROJ.rel, {"Key Paths": ["- Repo: D:\\Art Apps\\agentic os"]})
        reply["updated_markdown"] = reply["updated_markdown"].replace("# Agentic OS", "# Agentic Os")
        reasons, merged, *_ = run_target(PROJ, [reply])
        self.assertEqual(reasons, [])
        self.assertTrue(merged.body.startswith("# Agentic OS\n"), merged.body[:40])

    def test_malformed_superseded_lines(self):
        facts, w = distill.normalize_reply({"target_scroll": PROJ.rel, "updated_markdown": "x", "graph_entities_to_upsert": [],
                                            "superseded_facts": [{"old": "- Port: 1234", "new": "- Port: 1235 (arch-pending)", "reason": "moved"}]})
        self.assertEqual(facts["superseded_facts"], [{"old": "Port: 1234", "new": "Port: 1235", "reason": "moved"}])
        self.assertTrue(any("list marker" in x for x in w), w)
        self.assertEqual(sc._superseded_line("2026-11-19", {"old": "- a", "new": "- b"}, "arch-1"), "- 2026-11-19: a -> b (arch-1)")
        body = section_reply(PROJ.rel, {"Key Paths": ["- Port: 1235"]})["updated_markdown"].rstrip() + "\n- 2026-11-19: - Port: 1234 -> - Port: 1235 (arch-pending)\n"
        errs = sc.body_errors(PROJ, None, body, [], [], [])
        self.assertTrue(any("malformed ## Superseded Decisions" in e for e in errs), errs)
        legacy = old_scroll(PROJ, {"Key Paths": ["- Port: 1235"]}, log=["- 2026-11-01: - x -> - y (arch-2026-11-01-01)"])
        self.assertFalse(any("malformed" in e for e in sc.body_errors(PROJ, legacy, legacy.body, [], [], [])), "an existing line is never a new error")
        reply = section_reply(PROJ.rel, {"Key Paths": ["- Port: 1235"]}, facts=[{"old": "- Port: 1234", "new": "- Port: 1235", "reason": "moved"}])
        reply["updated_markdown"] = body.replace("- Port: 1235\n", "- Port: 1235\n", 1)
        base = sc.Scroll(PROJ.scroll_id, PROJ.category, NOW_ISO, 1, ["arch-2026-11-18-01"], [], sc.template_body(PROJ))  # an existing scroll
        reasons, merged, *_ = run_target(PROJ, [reply], old=base)
        self.assertEqual(reasons, [])
        self.assertEqual(sc.section_bullets(merged.body, [sc.SUPERSEDED]), ["- 2026-11-19: Port: 1234 -> Port: 1235 (arch-2026-11-19-01)"])

    def test_ascii_ellipsis_and_cli_output(self):
        s = sc.one_line("x" * 400, 50)
        self.assertEqual((len(s), s[-3:], s.isascii()), (50, "...", True))
        sb = Sandbox(key=None)
        try:
            reason = "moved \u2192 elsewhere \u2026"
            (sb.root / "state" / "stale-claims.json").write_text(json.dumps({"add": [{"id": "zq", "pattern": "zq", "action": "drop", "reason": reason}]}), encoding="utf-8")
            buf = io.StringIO()
            code = cli.main(["status", "--show-stale-claims", "--json"], env=sb.env, out=buf)
            self.assertEqual(code, 0)
            self.assertTrue(buf.getvalue().isascii(), "non-ASCII is escaped, never written raw to a console")
            rules = json.loads(buf.getvalue().splitlines()[-1])["stale_claims"]["rules"]
            self.assertEqual(next(r for r in rules if r["id"] == "zq")["reason"], reason, "and decodes back")
        finally:
            sb.close()


# ── end to end: the blocked shapes, replayed ────────────────────────────────

BRAIN = {
    "constraints.md": "# Constraints\n" + "\n".join([STALE["platform-linux"], STALE["legacy-free-tier-list"], STALE["legacy-runtime"], "- Free-tier first; never recommend paid services without warning"]) + "\n",
    "memory.md": "# Memory\n" + "\n".join([STALE["stale-model"], STALE["legacy-agent-roster"], STALE["cloudmart-project"], "- Scene Reader is the active app"]) + "\n",
}
HUB = {
    "master/MASTER_IDENTITY.md": IDENTITY_MD,
    "master/SYSTEM.md": SYSTEM_MD,
    "master/STATUS.md": STATUS_MD + "- Memory graph: C:\\ai-hub\\memory\\knowledge-graph.json\n",
    "master/AGENTS.md": "# AGENTS\n\n## Escalation ladder\n- Local agents first, then Gemini, then Claude for polish.\n\n## Librarian\n- Librarian is the only agent that writes rules.\n",
}
ENVELOPE_CHAT = 'assistant: {"role": "general", "intent": "Confirm connection", "summary": "hi", "mutating": true, "target": {"kind": "agent"}, "payload": {}, "missing": []}'


def blocked_shape_reply(messages):
    """A reply with every shape the review blocked, for whichever TARGET the prompt names."""
    u = messages[1]["content"]
    rel = re.search(r"^TARGET: (\S+)", u, re.M).group(1)
    t = sc.target_info(rel)
    title = t.title.replace("OS", "Os").replace("AI", "Ai")
    if t.kind == "project":
        md = "\n".join([
            f"# {title}", "", "## Current Milestone", "- Building a recipe scaler app for user (Tony).", "", "## Locked Decisions",
            "- Role: General (Jarvis) for greetings/status checks.", "- Intent: Confirm connection or propose next action.", STALE["mutating-default"],
            "- Target: Agent kind for all dispatches.", "- Payload: Structured fields only.", "- Missing: Capture unknown values.",
            "- Audio Engine: ElevenLabs active; Spotify integration pending toggle.", STALE["stale-model"], STALE["legacy-agent-roster"],
            "- Storage: Markdown vaults for cross-agent compatibility.", "", "## Key Paths", STALE["hub-kg-path"], "", "## Active State", "- Listening for commands.",
            "", "## Open Threads", "", "## Superseded Decisions", "- 2026-11-19: - User: Developer -> - User: Tony (Developer) (arch-pending)",
        ])
        ents = [
            {"name": "Tony", "entityType": "person", "observations": ["User of Agentic OS system.", "Daily calorie target and activity level relevant for the app."]},
            {"name": "Recipe Scaler App", "entityType": "project", "observations": ["Custom app being built by Coder agent."]},
            {"name": "Recipe Calculator App", "entityType": "project", "observations": ["Scales recipes."]},
            {"name": "Hermes Agent", "entityType": "service", "observations": ["Requires Python 3.11+ and Node.js"]},
        ]
        facts = [{"old": "- User: Developer", "new": "- User: Tony (Developer)", "reason": "relabel"}]
    elif t.kind == "identity":
        md = "\n".join([
            f"# {title}", "", "## Identity", "- Name: Nic. Operator of Agentic OS.", "- Tech stack: builds own apps (Scene Reader, the ZQX site, Estimator).", "",
            "## Communication Preferences", "- Tone: Gets quirky or nerdy when pushed.", "- Access: Open book, but people have to ask.", "- Format: Short plain answers.", "",
            "## Hardware & Constraints", STALE["platform-linux"], STALE["legacy-free-tier-list"], STALE["legacy-runtime"], "- OS: Windows 11", "",
            "## Standing Rules", "- Never hardcode API keys", "- Idempotency: Skills produce consistent outputs given same inputs.", "", "## Superseded Decisions",
        ])
        ents = [{"name": "Nic", "entityType": "person", "observations": ["Operator of Agentic OS", "Tech stack: builds the ZQX site"]}]
        facts = []
    else:
        hs = sc.headings_for(t)
        sections = {h: [] for h in hs}
        locked = next((h for h in hs if h in sc.LOCKED_HEADINGS), None)
        if locked:
            sections[locked] = [CONTESTED["contested-escalation-ladder"], CONTESTED["contested-librarian-sole-writer"], "- Gateway binds to 127.0.0.1 only"]
        sections[hs[0]] = sections[hs[0]] + ["- LM Studio serves Qwen 3.5 9B on :1235"]
        md = section_reply(rel, sections)["updated_markdown"]
        ents, facts = [], []
    return json.dumps({"target_scroll": rel, "updated_markdown": md, "graph_entities_to_upsert": ents, "superseded_facts": facts})


class BlockedShapesReplayTests(unittest.TestCase):
    def setUp(self):
        self.allm = stub_allm().start()
        self.gw = StubGateway(active=False).start()
        self.sb = Sandbox(allm_url=self.allm.url, gateway_url=self.gw.url, os_json=OS_JSON)
        brain = self.sb.root / "repo" / "brain"
        brain.mkdir(parents=True, exist_ok=True)
        for name, text in BRAIN.items():
            (brain / name).write_text(text, encoding="utf-8")
        for rel, text in HUB.items():
            p = self.sb.root / "hub" / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(text, encoding="utf-8")
        self.sb.threads({"general": [turn(1794939000100, "user", "make me a recipe scaler app"), turn(1794939000101, "agent", ENVELOPE_CHAT)]})
        self.preview = self.sb.root / "preview"

    def tearDown(self):
        self.sb.close()
        self.allm.stop()
        self.gw.stop()

    def dry(self, llm=None):
        events = []
        llm = llm or FakeLLM([blocked_shape_reply] * 64)
        res = offload.dry_run(self.sb.paths(), offload.OffloadOptions(preview_dir=self.preview, llm=llm, now=NOW, sources="all"), self.sb.env, events.append)
        return res, events, llm

    def apply(self, token):
        return self.sb.cli("offload", "--json", "--apply", "--preview-dir", str(self.preview), "--confirm", token)

    def test_blocked_shapes_never_reach_the_preview(self):
        res, events, llm = self.dry()
        prev = Path(res["preview_dir"])
        prompts = json.dumps([m[1]["content"] for m in llm.calls])
        for v in ("Ubuntu/WSL", "deepseek-v4", "CloudMart", "Student Developer Pack", "ai-hub\\\\memory\\\\knowledge-graph", '\\"mutating\\": true', "opencode, Hermes"):
            self.assertNotIn(v, prompts, f"source line reached the model: {v}")
        self.assertNotIn("zqx", prompts.lower(), "hub deny term filtered from the hub input too")
        scrolls = {rel: sc.parse((prev / "scrolls" / rel).read_text(encoding="utf-8")) for rel in res["proposed"] and [r["rel"] for r in res["proposed"]["targets"]]}
        text = "\n".join(s.body for s in scrolls.values())
        kg = (prev / "kg-preview.jsonl").read_text(encoding="utf-8")
        for line in body_outside_log(text).split("\n"):
            r = stale_claims.default_policy().match(line)
            self.assertTrue(r is None or (r.action == "demote" and "(unconfirmed)" in line), line)
        for v in ("Jarvis", "Tony", "Intent:", "Payload:", "Missing:", "calorie", "quirky", "Open book", "ZQX", "Hermes", "- - ", "# Agentic Os", "# Ai Hub"):
            self.assertNotIn(v, text + kg, v)
        proj = scrolls[PROJ.rel].body
        self.assertTrue(proj.startswith("# Agentic OS\n"))
        self.assertEqual(sc.section_bullets(proj, ["Locked Decisions"]), [], "a chat / brain-only project batch locks nothing new")
        self.assertIn("- Audio Engine: ElevenLabs active; Spotify integration pending toggle.", sc.section_bullets(proj, ["Active State"]))
        arch = scrolls[ARCH.rel].body
        self.assertEqual(sc.section_bullets(arch, ["Locked Design Decisions"]), ["- Gateway binds to 127.0.0.1 only"])
        self.assertIn("- (unconfirmed) Librarian is the ONLY agent that writes rules.", sc.section_bullets(arch, ["Guardrails"]))
        ents = [json.loads(x) for x in kg.splitlines() if x.strip()]
        self.assertEqual([e["name"] for e in ents if e["entityType"] == "person"], ["Nic"])
        self.assertEqual(len([e for e in ents if "Recipe" in e["name"]]), 1, "near-duplicates merged")
        report = json.loads((prev / "report.json").read_text(encoding="utf-8"))
        manifest = json.loads((prev / "manifest.json").read_text(encoding="utf-8"))
        rows = {r["rel"]: r for r in report["proposed"]["targets"]}
        self.assertFalse(rows[PROJ.rel]["never_lock_lock_new"])
        self.assertTrue(rows[ARCH.rel]["never_lock_lock_new"])
        g = rows[PROJ.rel]["guards"]
        self.assertGreaterEqual(g["stale_source"]["stale-model"], 1)
        self.assertGreaterEqual(g["schema_source"]["lines"], 1)
        self.assertIn("persona_person", g["identity"])
        self.assertIn("stale_output", g)
        self.assertEqual(manifest["schema"], offload.MANIFEST_SCHEMA)
        st = stale_claims.load(self.sb.root / "state")
        self.assertEqual(manifest["stale_claims"], {"version": st.version, "sha": st.sha, "override_present": False})
        self.assertEqual(manifest["guards"]["version"], guards.GUARDS_VERSION)
        self.assertEqual(report["guards"]["removed"], manifest["guards"]["removed"])
        self.assertIn("hub_denied", report["privacy"]["removed_total"])
        self.assertGreaterEqual(report["hub"]["auto_deny_terms"], 2)
        self.assertNotIn("quorvath", json.dumps(report).lower() + json.dumps(manifest).lower() + json.dumps(events).lower())
        self.assertTrue([e for e in events if e.get("event") == "source_guard"])
        code, lines = self.apply(res["token"])
        self.assertEqual(code, 0, lines[-1])

    def test_apply_refuses_v3_and_other_stale_policies_and_unguarded_previews(self):
        with mock.patch.object(offload, "MANIFEST_SCHEMA", "agentic-os.offload-preview.v3"):
            res, _, _ = self.dry()
        code, lines = self.apply(res["token"])
        self.assertEqual(code, 2)
        self.assertIn("predates the stale-claims policy", lines[-1]["error"])

        res, _, _ = self.dry()
        (self.sb.root / "state" / "stale-claims.json").write_text(json.dumps({"remove": ["cloudmart-project"]}), encoding="utf-8")
        code, lines = self.apply(res["token"])
        self.assertEqual(code, 2)
        self.assertIn("another stale-claims policy", lines[-1]["error"])
        (self.sb.root / "state" / "stale-claims.json").unlink()

        with mock.patch.object(guards, "GUARDS_VERSION", 0):
            res, _, _ = self.dry()
        code, lines = self.apply(res["token"])
        self.assertIn("another content-guard version", lines[-1]["error"])

        # A preview written while the guards were bypassed (an older build) with a current manifest.
        keep = lambda t, body, cur="", policy=None, existing_only=False, archive_id="", today="": (body, Counter(), Counter(), [])  # noqa: E731
        with mock.patch.object(guards, "stale_body", keep), mock.patch.object(guards.SourceGuard, "__call__", lambda self, r, b: b):
            res, _, _ = self.dry()
        self.assertIn("deepseek", "".join(p.read_text(encoding="utf-8") for p in Path(res["preview_dir"]).rglob("*.md")))
        tree = self.sb.tree()
        code, lines = self.apply(res["token"])
        self.assertEqual(code, 2)
        self.assertIn("holds content the content guards remove", lines[-1]["error"])
        self.assertNotIn("deepseek", lines[-1]["error"], "kinds and counts only")
        self.assertEqual(self.sb.tree(), tree, "nothing written")


# ── review round: false positives of the guards (synthetic values only) ─────

FP_IDENTITY_MD = """# MASTER_IDENTITY — v1 (draft)
Rule: ask when unsure.

## VOICE
- No fluff, practical answers.

## SIDE VENTURES
- Runs Quillmoth with a PR group on weekends; the Anchor shop sells PIXEL prints.
- Quillmoth uses Orbit art for the menu.
"""


class FalsePositiveTests(unittest.TestCase):
    def test_auto_terms_keep_ordinary_words_as_names_only(self):
        sb = Sandbox(key=None)
        try:
            (sb.root / "hub" / "master" / "MASTER_IDENTITY.md").write_text(FP_IDENTITY_MD, encoding="utf-8")
            (sb.root / "hub" / "master" / "SYSTEM.md").write_text(SYSTEM_MD, encoding="utf-8")
            terms, _ = offload.hub_auto_terms(sb.env)
            self.assertIn("quillmoth", terms, "a private name is still a term, in any case")
            for cased in ("Anchor", "Orbit", "PIXEL"):
                self.assertIn(cased, terms, "an ordinary word stays a term only in its capitalised form")
            for t in ("pr", "anchor", "orbit", "pixel"):
                self.assertNotIn(t, terms)
            pol, _ = offload.effective_privacy(sb.paths(), sb.env)
            for s in ("- Satellites follow a fixed orbit", "- The guard roster is an anchor for roles.ts", "- Keep the pixel grid at 8 px",
                      "- Never merge a PR without review", "- Anchor: the guard roster copies roles.ts", "- Orbit store lives under the D: memory root"):
                self.assertIsNone(privacy.check_line(s, pol)[0], s)
            for s in ("- Ships prints with the Anchor shop", "- Menu art made in Orbit", "- quillmoth orders close on Sundays"):
                self.assertEqual(privacy.check_line(s, pol)[0], privacy_policy.HUB_DENIED, s)
            self.assertNotIn("quillmoth", json.dumps(privacy.describe(pol)).lower())
        finally:
            sb.close()

    def test_negated_platform_and_mutating_lines_are_kept(self):
        pol = stale_claims.default_policy()
        keep = ["- Platform: Windows 11 (no WSL; use PowerShell or Git Bash)", "- Never use WSL paths; the host is Windows 11",
                "- Windows 11 Pro host; Git Bash and PowerShell, no Ubuntu", "- Git Bash on Windows, not a Linux environment",
                "- Use the Windows host, never the Linux machine",
                "- Default: non-mutating; every mutating action needs a spoken readBack confirmation", "- Defaults to read-only; mutating tools need confirmation",
                "- Dispatcher: mutating is false by default; forward nothing without confirmation", "- Mutating actions never forward messages without confirmation",
                "- Mutating actions forward messages only after a readBack confirmation"]
        for line in keep:
            self.assertIsNone(pol.match(line), line)
        for line in ("- Runs in WSL2 Ubuntu", "- Messages are mutating by default", "- Mutating rule auto-forwards every message"):
            self.assertIsNotNone(pol.match(line), line)
        text, c = stale_claims.filter_text("\n".join(keep), pol)
        self.assertEqual((text, dict(c)), ("\n".join(keep), {}))
        # An existing locked rule that states the CURRENT platform / never-send this way is not touched.
        old = old_scroll(IDENT, {"Standing Rules": [keep[0], keep[5]]})
        new, dropped, demoted, facts = guards.stale_current(IDENT, old, pol, "arch-x", NOW_ISO[:10])
        self.assertIs(new, old)
        self.assertEqual((dict(dropped), dict(demoted), facts), ({}, {}, []))

    def test_role_words_as_nouns_are_not_user_relabels(self):
        for s in ("- Librarian: user approves every rule change before commit", "- Booking Desk: owner approval required for every send",
                  "- Ops: operator confirms every service restart", "- User: designer and illustrator", "- The user is a designer and 3D artist",
                  "- Librarian is the owner of rule files"):
            self.assertFalse(guards.relabels_user(s), s)
        for s in ("- User: Designer", "- The user is Tony", "- Tony is the user of Agentic OS", "- Jarvis = user"):
            self.assertTrue(guards.relabels_user(s), s)
        body = section_reply(IDENT.rel, {"Standing Rules": ["- Librarian: user approves every rule change before commit"],
                                         "Identity": ["- The user is a designer and 3D artist"]})["updated_markdown"]
        self.assertEqual(guards.identity_body(body), (body, 0))

    def test_distinct_entities_are_not_merged(self):
        def ent(n, o):
            return {"name": n, "entityType": "project", "observations": [o]}
        for a, b in (("Agentic OS", "Agentic OS Command Center"), ("AI Hub", "AI Hub Memory"), ("Command Center HUD", "Command Center Voice"),
                     ("Command Center", "Command Center Voice Pipeline"), ("Scene Reader", "Scene Reader Estimator")):
            out, n = guards.dedupe_entities([ent(a, "first"), ent(b, "second")])
            self.assertEqual((n, [e["name"] for e in out], out[0]["observations"]), (0, [a, b], ["first"]), (a, b))
        out, n = guards.dedupe_entities([ent("LM Studio", "port 1235"), ent("LM Studio server", "runs Qwen")])
        self.assertEqual((n, out[0]["observations"]), (1, ["port 1235", "runs Qwen"]))

    def test_unconfirmed_bullet_moved_back_into_locked_section_is_demoted_again(self):
        line = CONTESTED["contested-librarian-sole-writer"]
        old = old_scroll(ARCH, {"Locked Design Decisions": ["- LM Studio serves Qwen 3.5 9B on :1235", line], "Guardrails": ["- Never send without confirmation"]})
        cur, _, demoted, _ = guards.stale_current(ARCH, old, None, "arch-x", NOW_ISO[:10])
        self.assertEqual(dict(demoted), {"contested-librarian-sole-writer": 1})
        relocked = stale_claims.unconfirmed(line)
        bad = section_reply(ARCH.rel, {"Locked Design Decisions": ["- LM Studio serves Qwen 3.5 9B on :1235", relocked],
                                       "Guardrails": ["- Never send without confirmation"]})["updated_markdown"]
        self.assertEqual(guards.check_preview(ARCH, bad, [], cur.body)["stale_demote"], 1, "--apply refuses the re-locked preview")
        body, dropped, dem, _ = guards.stale_body(ARCH, bad, cur.body)
        self.assertEqual(dict(dem), {"contested-librarian-sole-writer": 1})
        self.assertNotIn(relocked, sc.section_bullets(body, list(sc.LOCKED_HEADINGS)))
        self.assertEqual(sc.section_bullets(body, ["Guardrails"]).count(relocked), 1)
        self.assertEqual(guards.check_preview(ARCH, body, [], cur.body), Counter())
        # Also when the reply lists it in both places, or no rule matches its wording any more.
        both = section_reply(ARCH.rel, {"Locked Design Decisions": [relocked], "Guardrails": [relocked]})["updated_markdown"]
        body, _, dem, _ = guards.stale_body(ARCH, both, cur.body)
        self.assertEqual((sum(dem.values()), sc.section_bullets(body, ["Guardrails"])), (1, [relocked]))
        other = "- (unconfirmed) Hub rules are written by one agent"
        body, _, dem, _ = guards.stale_body(ARCH, section_reply(ARCH.rel, {"Locked Design Decisions": [other]})["updated_markdown"], cur.body)
        self.assertEqual((dict(dem), sc.section_bullets(body, ["Guardrails"])), ({"unconfirmed-relock": 1}, [other]))
        # End to end: the merged scroll keeps it unlocked.
        reasons, merged, *_ = run_target(ARCH, [section_reply(ARCH.rel, {"Locked Design Decisions": ["- LM Studio serves Qwen 3.5 9B on :1235", relocked]})], old=old)
        self.assertEqual(reasons, [])
        self.assertNotIn(relocked, sc.section_bullets(merged.body, list(sc.LOCKED_HEADINGS)))
        self.assertIn(relocked, sc.section_bullets(merged.body, ["Guardrails"]))

    def test_rules_with_status_words_and_hub_imperatives_stay_locked(self):
        for s in ("- C:\\ai-hub is read-only; writes are disabled", "- Only one active voice pipeline at a time", "- Every active project gets its own scroll",
                  "- Use Kokoro for TTS; ElevenLabs stays disabled", "- LM Studio on :1235 is currently the only chat backend", "- Wake word listening stays local-only",
                  "- Ask when unsure. One question at a time.", "- Keep answers short and plain.", "- Give sources for research.",
                  "- One commit per approved change, with a clear message.", "- Free-tier first", "- No cloud spend"):
            self.assertIsNone(distill.one_off_kind(s), s)
        for s in ("- Audio Engine: ElevenLabs active; Spotify integration pending toggle.", "- Listening for commands", "- LM Studio active on :1235"):
            self.assertEqual(distill.one_off_kind(s), "status", s)
        self.assertNotEqual(distill.one_off_kind("- Target: Windows 11"), "schema")
        # Hub-fed identity / architecture: an unmarked NEW bullet stays locked; a project still needs a marker.
        ident = section_reply(IDENT.rel, {"Standing Rules": ["- Ship small, tidy diffs"]})["updated_markdown"]
        self.assertEqual(distill.demote_one_off_locked(IDENT, ident, ""), (ident, []))
        arch = section_reply(ARCH.rel, {"Locked Design Decisions": ["- Target: Windows 11"]})["updated_markdown"]
        self.assertEqual(distill.demote_one_off_locked(ARCH, arch, ""), (arch, []))
        proj = section_reply(PROJ.rel, {"Locked Decisions": ["- Storage: Markdown vaults for cross-agent compatibility."]})["updated_markdown"]
        self.assertEqual(distill.demote_one_off_locked(PROJ, proj, "")[1], [("unmarked", "Active State")])
        # An envelope-shaped locked section still loses every field, generic labels included.
        env = section_reply(PROJ.rel, {"Locked Decisions": ["- Role: General", "- Intent: Confirm connection", "- Mutating: true", "- Target: Windows 11"]})["updated_markdown"]
        _, moved = distill.demote_one_off_locked(PROJ, env, "")
        self.assertEqual([k for k, _ in moved], ["schema"] * 4)

    def test_technical_macros_and_fasting_are_not_health(self):
        pol = privacy.default_policy()
        for s in ("- Tauri command macros generate the IPC bindings", "- Use Rust macros for the IPC handlers", "- Stream Deck macros trigger Command Center widgets",
                  "- Cutting phase of the video edit", "- Fasting mode: the HUD skips idle animations"):
            self.assertIsNone(privacy.check_line(s, pol)[0], s)
        for s in ("- Tracking macros daily", "- Macros per day: high protein", "- Intermittent fasting 16:8", "- Fasting window ends at noon", "- Cutting phase diet: low carb"):
            self.assertEqual(privacy.check_line(s, pol)[0], "health", s)


if __name__ == "__main__":
    unittest.main()
