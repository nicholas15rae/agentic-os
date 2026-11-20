"""Memory Scrolls round 8: guards v5 (fidelity), synthetic data only.

The booking-scope review of preview 20261119-233821 blocked it on guardrail fidelity. Each fix has a
unit test here and the whole set is replayed end to end (dry-run + `--apply`) in `R7ShapesV5Tests`:

1. approver fidelity: an install / config rule names Nic as the approver ("without Librarian
   approval" -> "without Nic's approval (proposed through the Librarian)"), or it is demoted;
2. host-owned settled guardrails: the NEVER items of the hub AGENTS_NEVER.md are standalone
   ## Guardrails bullets, never swallowed by a contested demotion;
3. rule-file edits ("fix MASTER_IDENTITY / AGENTS_NEVER, then lock v1") need Nic's approval;
4. safety-critical terms carry their qualifiers (auto_dispatch: live brainstorm + pipeline target,
   staging/ only, approve() still gates);
5. KG: conflicting entities of two targets stay apart; contested companions are "(unconfirmed)";
6. a NEW prohibition / obligation needs a supporting source sentence ("do not use external MCPs");
7. a storage path that does not exist is "(planned, not created yet)";
8. the Command Center overview joins the curated repo-doc allow-list (manifest v6);
9. hygiene: near-duplicates, stale counts ("same 7" over 4 items), one-night measurements.

Run with: python3 tests/run_all.py
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

from memory_scrolls import guards, offload  # noqa: E402
from memory_scrolls import scroll as sc  # noqa: E402
from memory_scrolls import stale_claims as stc  # noqa: E402
from memory_scrolls_stubs import user_text  # noqa: E402
from test_memory_scrolls import FakeLLM, Sandbox, section_reply  # noqa: E402
from test_memory_scrolls import setUpModule, tearDownModule  # noqa: E402,F401
from test_memory_scrolls_curated import ARCH, HUBP, IDENT, LESS, PROJ, CuratedBase  # noqa: E402

AGENTS_NEVER = """# AGENTS_NEVER - hard rules for every agent

## NEVER
1. Never send anything. No emails or posts. Drafts only.
2. Never change rules or identity files. Only the Librarian, with Nic's approval.
3. Never install a new skill, MCP or package without approval. Propose it through the Librarian.
4. Never take acting roles that break his boundaries.
5. Never move to the next step before the current one is tested.

## ALWAYS
- Ask when unsure.
"""


def body_of(t: sc.Target, sections: dict) -> str:
    return section_reply(t.rel, sections)["updated_markdown"]


def idx_with(settled=(), sources=None, probe=None) -> guards.PlanIndex:
    idx = guards.PlanIndex([], [], sources, settled)
    idx.probe = probe
    return idx


def bullets(body: str, head: str) -> list:
    return sc.section_bullets(body, [head])


# ── 1. approver fidelity ─────────────────────────────────────────────────────


class ApproverTests(unittest.TestCase):
    def test_agent_approver_rewritten_to_nic(self):
        new, act = guards.approver_fix("- NEVER install new skills/MCPs/packages without Librarian approval.")
        self.assertEqual(act, "rewrite")
        self.assertEqual(new, "- NEVER install new skills/MCPs/packages without Nic's approval (proposed through the Librarian).")
        new, act = guards.approver_fix("- Never add an MCP server without the Librarian's sign-off")
        self.assertEqual(new, "- Never add an MCP server without Nic's sign-off (proposed through the Librarian)")
        new, act = guards.approver_fix("- Config changes are approved by the Ops agent")
        self.assertIn("approved by Nic (proposed through the Ops)", new)
        # A bare "without approval" on an install rule names Nic.
        new, act = guards.approver_fix("Never install a new skill, MCP or package without approval. Propose it through the Librarian.")
        self.assertEqual(new, "Never install a new skill, MCP or package without Nic's approval. Propose it through the Librarian.")

    def test_fixed_points_and_out_of_scope(self):
        for line in ("- NEVER install new skills without Nic's approval (proposed through the Librarian).",
                     "- Never install a package without Nic's approval.",
                     "- Agents propose skills, the Librarian checks, Nic approves.",
                     "- (unconfirmed) Librarian is the ONLY agent authorized to write rules; requires Nic's approval per change.",
                     "- The Librarian approves every drawing style"):  # no install / config scope
            self.assertEqual(guards.approver_fix(line), (None, ""), line)

    def test_unfixable_wording_is_demoted_or_dropped(self):
        self.assertEqual(guards.approver_fix("- The Librarian approves new MCP servers.")[1], "demote")
        body = body_of(ARCH, {"Locked Design Decisions": ["- The Librarian approves new MCP servers."], "Guardrails": ["- NEVER install packages without Librarian approval."]})
        out, c = guards.approver_body(ARCH, body)
        self.assertEqual(bullets(out, "Locked Design Decisions"), [])
        g = bullets(out, "Guardrails")
        self.assertIn("- NEVER install packages without Nic's approval (proposed through the Librarian).", g)
        self.assertIn("- (unconfirmed) The Librarian approves new MCP servers.", g)
        self.assertEqual(c, Counter({"approver_rewritten": 1, "approver_demoted": 1}))
        self.assertEqual(guards.approver_body(ARCH, out), (out, Counter()), "a fixed point")
        lessons = body_of(LESS, {"Tool Quirks": ["- The Librarian approves new MCP servers."]})
        out, c = guards.approver_body(LESS, lessons)
        self.assertEqual(bullets(out, "Tool Quirks"), [])
        self.assertEqual(c, Counter({"approver_dropped": 1}))
        # A current-scroll line is never touched.
        self.assertEqual(guards.approver_body(ARCH, body, cur_body=body)[1], Counter())

    def test_kg_observation_corrected(self):
        ents = [{"name": "MCP policy", "entityType": "decision", "observations": ["New MCPs need Librarian approval"]}]
        out, c = guards.content_entities(ents)
        self.assertEqual(out[0]["observations"], ["New MCPs need Nic's approval (proposed through the Librarian)"])
        self.assertEqual(c["approver_kg_rewritten"], 1)
        self.assertEqual(guards.content_entities(out)[1], Counter())


# ── 2. host-owned settled guardrails ────────────────────────────────────────


class SettledGuardrailTests(unittest.TestCase):
    def setUp(self):
        self.items = guards.settled_items(AGENTS_NEVER)
        self.idx = idx_with(self.items)

    def test_items_and_compact_bullets(self):
        self.assertEqual(len(self.items), 5, "the NEVER list only (ALWAYS is not a hard rule)")
        b = guards.settled_bullets(self.items)
        self.assertEqual(b, [
            "Never send anything. No emails or posts. Drafts only.",
            "Never change rules or identity files.",  # the contested "Only the Librarian" sentence stays out
            "Never install a new skill, MCP or package without Nic's approval. Propose it through the Librarian.",
            "Never move to the next step before the current one is tested.",
        ])  # the acting-roles item (Booking / personal scope) is never copied
        long = ["Never do X. " + " ".join(f"Sentence {i} adds some more words here." for i in range(20))]
        self.assertLessEqual(len(guards.settled_bullets(long)[0]), guards.SETTLED_MAX_ITEM)
        many = [f"Never do thing number {i} again." for i in range(40)]
        self.assertEqual(len(guards.settled_bullets(many)), guards.SETTLED_MAX_BULLETS)
        # A stale-claim sentence never rides along.
        self.assertEqual(guards.settled_bullets(["Never send anything. Mutating: true for forwards."]), ["Never send anything."])

    def test_settled_rules_are_standalone_and_replace_model_restatements(self):
        body = body_of(ARCH, {
            "Locked Design Decisions": ["- Every approved rule change results in exactly one Git commit."],
            "Guardrails": ["- NEVER send emails or posts; drafts only.", "- NEVER install new skills/MCPs/packages without Librarian approval.",
                           "- (unconfirmed) Librarian is the ONLY agent authorized to write rules; requires Nic's approval per change.",
                           "- Never print secrets in logs."],
        })
        out, c = guards.settled_body(ARCH, body, "", self.idx)
        g = bullets(out, "Guardrails")
        self.assertEqual(g[:4], [
            "- Never send anything. No emails or posts. Drafts only.",
            "- Never change rules or identity files.",
            "- Never install a new skill, MCP or package without Nic's approval. Propose it through the Librarian.",
            "- Never move to the next step before the current one is tested.",
        ])
        self.assertIn("- (unconfirmed) Librarian is the ONLY agent authorized to write rules; requires Nic's approval per change.", g)
        self.assertIn("- Never print secrets in logs.", g, "an unrelated model guardrail stays")
        self.assertNotIn("- NEVER install new skills/MCPs/packages without Librarian approval.", g)
        self.assertEqual(c, Counter({"settled_replaced": 2, "settled_added": 2}))
        self.assertEqual(bullets(out, "Locked Design Decisions"), ["- Every approved rule change results in exactly one Git commit."],
                         "a non-negated bullet never stands for a NEVER rule")
        self.assertEqual(guards.settled_body(ARCH, out, "", self.idx), (out, Counter()), "a fixed point")

    def test_a_contested_demotion_never_swallows_a_settled_rule(self):
        body = body_of(ARCH, {"Guardrails": ["- (unconfirmed) Never change rules or identity files; only the Librarian writes them."]})
        out, _ = guards.settled_body(ARCH, body, "", self.idx)
        self.assertIn("- Never change rules or identity files.", bullets(out, "Guardrails"))

    def test_stated_elsewhere_or_current_scroll_is_never_replaced(self):
        # Round 9: a restatement elsewhere stays, and the host copy is still written under ## Guardrails
        # (a narrower or conditional restatement never stands for the settled rule).
        body = body_of(ARCH, {"Locked Design Decisions": ["- Never move to the next step before the current step is tested"]})
        out, _ = guards.settled_body(ARCH, body, "", self.idx)
        self.assertIn("- Never move to the next step before the current one is tested.", bullets(out, "Guardrails"))
        self.assertIn("- Never move to the next step before the current step is tested", bullets(out, "Locked Design Decisions"))
        cur = body_of(ARCH, {"Guardrails": ["- NEVER send emails; drafts only."]})
        out, _ = guards.settled_body(ARCH, cur, cur, self.idx)
        self.assertIn("- NEVER send emails; drafts only.", bullets(out, "Guardrails"), "a current-scroll line is never replaced")

    def test_only_the_architecture_scroll_and_only_with_the_source(self):
        body = body_of(PROJ, {"Active State": ["- x"]})
        self.assertEqual(guards.settled_body(PROJ, body, "", self.idx), (body, Counter()))
        arch = body_of(ARCH, {"Guardrails": ["- x"]})
        self.assertEqual(guards.settled_body(ARCH, arch, "", idx_with()), (arch, Counter()))
        self.assertEqual(guards.settled_body(ARCH, arch, "", None), (arch, Counter()))

    def test_plan_lines_reads_settled_items_from_the_hub_file_only(self):
        recs = [{"text": AGENTS_NEVER, "meta": {"hint": "hub", "file": guards.SETTLED_FILE}},
                {"text": "## NEVER\n- Never do the other thing.", "meta": {"hint": "hub", "file": "master/SYSTEM.md"}}]
        idx = guards.plan_lines(recs)
        self.assertEqual(idx.settled, tuple(self.items))
        self.assertIsNotNone(idx.support)
        self.assertIsNone(guards.plan_lines(recs, support=False).support)


# ── 3. rule / identity / prompt / config file edits ─────────────────────────


class RuleFileEditTests(unittest.TestCase):
    def test_detection(self):
        for line in ("- Planned: Read MASTER_IDENTITY.md and AGENTS_NEVER.md, fix anything wrong, then lock v1.",
                     "- Planned: MASTER_IDENTITY v1 and AGENTS_NEVER reviewed and locked.",
                     "- Planned: Write Conceptualizer and Dispatcher prompts.",
                     "- Rewrite the system prompt for the front agent.",
                     "- Update the identity file with the new pillar.",
                     # v7 (round 10, part 2): the status form of the same to-do is approval-gated too.
                     "- MASTER_IDENTITY v1 and AGENTS_NEVER need final review before lock"):
            self.assertEqual(guards.imperative_kind(line), "rule_file_edit", line)
        for line in ("- Never change rules or identity files.",
                     "- (unconfirmed) Changes only through the Librarian, with Nic's approval.",
                     "- Every approved rule change results in exactly one Git commit.",
                     "- Agents: `agents/<name>/` (prompt.md, rules.md, card.md).",
                     "- MASTER_IDENTITY v1 is locked.",
                     "- Planned: Hub backed up twice; MASTER_IDENTITY v1 and AGENTS_NEVER reviewed"):
            self.assertIsNone(guards.imperative_kind(line), line)
        self.assertEqual(guards.imperative_kind("- Change the AnythingLLM config to point at 1235"), "config_change", "the v4 kind wins")

    def test_needs_nic_approval_and_never_locked(self):
        body = body_of(HUBP, {"Locked Decisions": ["- Fix AGENTS_NEVER.md and lock it."],
                              "Open Threads": ["- Planned: Read MASTER_IDENTITY.md and AGENTS_NEVER.md, fix anything wrong, then lock v1."]})
        out, c = guards.imperatives_body(HUBP, body)
        self.assertEqual(bullets(out, "Locked Decisions"), [])
        self.assertEqual(bullets(out, "Open Threads"), [
            "- (needs Nic's approval) Planned: Read MASTER_IDENTITY.md and AGENTS_NEVER.md, fix anything wrong, then lock v1.",
            "- (needs Nic's approval) Fix AGENTS_NEVER.md and lock it.",
        ])
        self.assertEqual(guards.imperatives_body(HUBP, out)[1], Counter(), "a fixed point")
        ident = body_of(IDENT, {"Standing Rules": ["- Rewrite MASTER_IDENTITY.md when a fact changes."]})
        out, c = guards.imperatives_body(IDENT, ident)
        self.assertEqual(bullets(out, "Standing Rules"), [])
        self.assertEqual(c["imperative_dropped"], 1)
        out, c = guards.content_entities([{"name": "MASTER_IDENTITY", "entityType": "path", "observations": ["Fix anything wrong, then lock the identity file v1", "Operator profile"]}])
        self.assertEqual(out[0]["observations"], ["Operator profile"])


# ── 4. qualifiers ───────────────────────────────────────────────────────────


AUTO = "- **Dispatch policies:** `surface_only` refuses build; `auto_dispatch` skips Tier-3 offer card."


class QualifierTests(unittest.TestCase):
    def test_auto_dispatch_carries_its_limits(self):
        new, act = guards.qualify(AUTO)
        self.assertEqual(act, "append")
        for need in ("live brainstorm", "pipeline target", "staging/ only", "approve() still gates every mutating plan"):
            self.assertIn(need, new)
        self.assertEqual(guards.qualify(new), (None, ""), "a fixed point")
        ok = "- auto_dispatch skips the offer only in a live brainstorm with a pipeline target; writes go to staging/; approve() still gates."
        self.assertEqual(guards.qualify(ok), (None, ""))
        self.assertEqual(guards.qualify("- " + "x " * 200 + "auto_dispatch skips Tier-3"), (None, "drop"))
        self.assertIn("Nic runs it", guards.qualify("- Run --apply to promote the preview")[0])

    def test_body_and_kg(self):
        body = body_of(PROJ, {"Active State": [AUTO]})
        out, c = guards.qualifier_body(PROJ, body)
        self.assertIn("approve() still gates", bullets(out, "Active State")[0])
        self.assertEqual(c, Counter({"qualifier_appended": 1}))
        ents, c = guards.content_entities([{"name": "auto_dispatch", "entityType": "decision", "observations": ["Skips the Tier-3 offer card"]}])
        self.assertIn("staging/ only", ents[0]["observations"][0])
        self.assertEqual(c["qualifier_kg_appended"], 1)


# ── 5. knowledge graph ──────────────────────────────────────────────────────


HUB_LIB = {"name": "Librarian", "entityType": "tool", "observations": ["Sole agent authorized to write rules", "Requires Nic's approval for every change", "Commits one Git commit per approved rule"]}
CC_LIB = {"name": "Librarian", "entityType": "tool", "observations": ["Read-only allowlist reader; condenses context into a brief"]}


class KnowledgeGraphTests(unittest.TestCase):
    def test_contested_companions_are_unconfirmed(self):
        out, dropped, demoted = guards.stale_entities([HUB_LIB])
        self.assertEqual(out[0]["observations"], ["(unconfirmed) Sole agent authorized to write rules", "(unconfirmed) Requires Nic's approval for every change",
                                                   "(unconfirmed) Commits one Git commit per approved rule"])
        self.assertEqual(demoted["contested-librarian-sole-writer"], 3)
        self.assertEqual(guards.stale_entities(out)[2], Counter(), "a fixed point")
        # A read-only statement beside a contested one is never marked; an entity with no contested
        # observation is untouched.
        mixed = {**HUB_LIB, "observations": HUB_LIB["observations"][:1] + ["Read-only reader of tasks"]}
        self.assertEqual(guards.stale_entities([mixed])[0][0]["observations"][1], "Read-only reader of tasks")
        self.assertEqual(guards.stale_entities([CC_LIB])[0], [CC_LIB])

    def test_conflicting_entities_of_two_targets(self):
        self.assertTrue(guards.observations_conflict(HUB_LIB["observations"], CC_LIB["observations"]))
        self.assertTrue(guards.observations_conflict(["(unconfirmed) Sole rule writer"], ["Keeps master/ tidy"]))
        self.assertFalse(guards.observations_conflict(["Runs on :8178"], ["Whisper STT server"]))
        self.assertEqual(guards.kg_conflicts({ARCH.rel: [HUB_LIB], PROJ.rel: [CC_LIB]}), ["Librarian"])
        self.assertEqual(guards.kg_conflicts({ARCH.rel: [{**HUB_LIB, "name": "Librarian (ai-hub)"}], PROJ.rel: [{**CC_LIB, "name": "Librarian (Command Center)"}]}), [])
        self.assertEqual(guards.kg_conflicts({ARCH.rel: [HUB_LIB, CC_LIB]}), [], "within one target the merge stays as before")
        self.assertEqual(guards.kg_scope(PROJ.rel, [{"meta": {"hint": "repo"}}]), "Command Center")
        self.assertEqual(guards.kg_scope(ARCH.rel, [{"meta": {"hint": "hub"}}]), "ai-hub")
        self.assertEqual(guards.kg_scope(ARCH.rel, [{"meta": {"hint": "hub"}}, {"meta": {"hint": "brain"}}]), "Architecture Decisions")


# ── 6. unsupported rules ────────────────────────────────────────────────────


SOURCES = [
    "- LM Studio custom MCPs won't connect (npx/uvx). Not needed: agents run in AnythingLLM.",
    "1. Never present a guess as a fact. Label assumptions.",
    "- Drafts only. Nic sends.",
    "- WhatsApp stays read-only in every mode.",
]


class SupportTests(unittest.TestCase):
    def setUp(self):
        self.sup = guards.SupportIndex(SOURCES)

    def test_distorted_rule_is_unsupported(self):
        self.assertFalse(self.sup.supported("- Agents run in AnythingLLM; do not use external MCPs for connection."))
        self.assertTrue(self.sup.supported("- LM Studio custom MCPs won't connect via npx/uvx; not needed for AnythingLLM agents."))
        self.assertTrue(self.sup.supported("- NEVER present guesses as facts; always label assumptions."), "an obligation backed by a source imperative")
        self.assertTrue(self.sup.supported("- Drafts only."))
        merged = guards.SupportIndex(["1. Never send anything. No emails, messages, posts or submissions. Drafts only."])
        self.assertTrue(merged.supported("- NEVER send emails, messages, posts, or submissions; drafts only."), "two sentences of one source line")
        self.assertFalse(merged.supported("- Never send money."))
        self.assertFalse(self.sup.supported("- Always use external MCPs."))
        for no_modal in ("- WhatsApp bridge: read-only (24/7)", "- `surface_only` refuses build", "- Kokoro sounds muffled",
                         "- auto_dispatch skips the offer (only in a live brainstorm)"):
            self.assertTrue(self.sup.supported(no_modal), no_modal)

    def test_body_demotes_or_drops(self):
        idx = idx_with(sources=SOURCES)
        less = body_of(LESS, {"Tool Quirks": ["- Agents run in AnythingLLM; do not use external MCPs for connection."],
                              "Failure Modes": ["- LM Studio custom MCPs won't connect via npx/uvx; not needed for AnythingLLM agents."]})
        out, c = guards.support_body(LESS, less, "", idx)
        self.assertEqual(bullets(out, "Tool Quirks"), [])
        self.assertEqual(len(bullets(out, "Failure Modes")), 1)
        self.assertEqual(c, Counter({"unsupported_dropped": 1}))
        arch = body_of(ARCH, {"Locked Design Decisions": ["- Agents load only necessary context."], "Guardrails": ["- Never skip code review."]})
        out, c = guards.support_body(ARCH, arch, "", idx)
        self.assertEqual(bullets(out, "Locked Design Decisions"), [])
        self.assertEqual(bullets(out, "Guardrails"), ["- (unverified) Never skip code review.", "- (unverified) Agents load only necessary context."])
        self.assertEqual(guards.support_body(ARCH, out, "", idx)[1], Counter(), "a fixed point")
        self.assertEqual(guards.support_body(ARCH, arch, arch, idx)[1], Counter(), "a current-scroll line is never touched")
        self.assertEqual(guards.support_body(ARCH, arch, "", idx_with())[1], Counter(), "off without a support index")
        relocked = body_of(ARCH, {"Locked Design Decisions": ["- (unverified) Agents load only necessary context."]})
        out, d, m, _ = guards.stale_body(ARCH, relocked, cur_body=out)
        self.assertEqual(bullets(out, "Locked Design Decisions"), [], "an unverified bullet is never re-locked")


# ── 7. storage paths ────────────────────────────────────────────────────────


def fake_probe(token: str):
    t = token.replace("/", "\\").lower()
    if "ai-hub-memory" in t:
        return None
    if t.endswith(("tasks.db", "modes.json")):
        return False
    if t.endswith(("os.json", "devqueue.db")) or "staging" in t:
        return True
    return None


class PathTests(unittest.TestCase):
    def test_annotation(self):
        self.assertEqual(guards.annotate_paths("- `%APPDATA%\\os.agentic.commandcenter\\tasks.db`", fake_probe, True),
                         "- `%APPDATA%\\os.agentic.commandcenter\\tasks.db` (planned, not created yet)")
        line = "- **Storage:** Shared `tasks.db` beside `os.json`; the worker reads `tasks.db` read-only."
        new = guards.annotate_paths(line, fake_probe, False)
        self.assertEqual(new, "- **Storage:** Shared `tasks.db` (planned, not created yet) beside `os.json`; the worker reads `tasks.db` read-only.")
        self.assertIsNone(guards.annotate_paths(new, fake_probe, False), "a fixed point")
        self.assertIsNone(guards.annotate_paths("- offer-flow.test.ts confirms it", fake_probe, False), "not a storage file")
        self.assertIsNone(guards.annotate_paths("- `D:\\ai-hub-memory\\knowledge-graph.json`", fake_probe, True), "a write target --apply creates")
        # An unquoted path with spaces cannot be delimited: none of its pieces is probed.
        seen: list = []
        self.assertIsNone(guards.annotate_paths("- Repo: D:\\Art Apps\\agentic os", lambda tok: seen.append(tok) or False, True))
        self.assertEqual(seen, [])
        # In backticks the whole span is the path, spaces included.
        self.assertEqual(guards.annotate_paths("- Repo: `D:\\Art Apps\\gone dir\\x.db`", lambda tok: False if tok.endswith("x.db") else None, True),
                         "- Repo: `D:\\Art Apps\\gone dir\\x.db` (planned, not created yet)")

    def test_body_and_kg(self):
        idx = idx_with(probe=fake_probe)
        body = body_of(PROJ, {"Key Paths": ["- `%APPDATA%\\os.agentic.commandcenter\\tasks.db`", "- `staging/memory-scrolls-preview/<stamp>/`"],
                              "Active State": ["- **Modes storage:** `modes.json` beside `os.json`."]})
        out, c = guards.paths_body(PROJ, body, "", idx)
        self.assertIn("tasks.db` (planned, not created yet)", out)
        self.assertIn("`modes.json` (planned, not created yet) beside", out)
        self.assertNotIn("<stamp>/` (planned", out)
        self.assertEqual(c, Counter({"path_planned": 2}))
        self.assertEqual(guards.paths_body(PROJ, out, "", idx)[1], Counter())
        ents, c = guards.content_entities([{"name": "tasks.db", "entityType": "path", "observations": ["Shared store of task envelopes"]},
                                           {"name": "os.json", "entityType": "path", "observations": ["App config"]}], idx)
        self.assertEqual(ents[0]["observations"], ["(planned, not created yet) Shared store of task envelopes"])
        self.assertEqual(ents[1]["observations"], ["App config"])
        self.assertEqual(guards.content_entities(ents, idx)[1], Counter())

    def test_offload_probe_is_read_only_and_scoped(self):
        sb = Sandbox(key=None)
        try:
            app = Path(sb.env["APPDATA"]) / "os.agentic.commandcenter"
            app.mkdir(parents=True)
            (app / "os.json").write_text("{}", encoding="utf-8")
            paths = sb.paths()
            before = sb.tree()
            probe = offload.path_probe(paths, sb.env, offload.REPO_TARGET)
            self.assertIs(probe("%APPDATA%\\os.agentic.commandcenter\\tasks.db"), False)
            self.assertIs(probe("%APPDATA%\\os.agentic.commandcenter\\os.json"), True)
            self.assertIs(probe("tasks.db"), False)
            self.assertIs(probe("os.json"), True)
            self.assertIsNone(probe(str(paths.kg_path)))
            self.assertIsNone(probe(str(Path(paths.scrolls_root) / "core" / "x.md")))
            self.assertIsNone(probe("C:\\Windows\\System32"), "outside the known roots")
            self.assertIsNone(probe("..\\secrets.db"))
            self.assertIsNone(probe("%LOCALAPPDATA%\\x.db"))
            self.assertIsNone(probe("state.json"))
            hub = offload.path_probe(paths, sb.env, ARCH.rel)
            self.assertIsNone(hub("master/INDEX.md"), "a hub scroll's relative path is a hub path")
            self.assertIsNone(hub("tasks.db"))
            self.assertEqual(sb.tree(), before, "read-only")
        finally:
            sb.close()


# ── 9. hygiene ──────────────────────────────────────────────────────────────


class HygieneTests(unittest.TestCase):
    def test_near_duplicates(self):
        self.assertTrue(guards.near_duplicate("- Planned: Gemini models curation (D drive).", "- Planned: D drive (Gemini models curation location)"))
        self.assertFalse(guards.near_duplicate("- LM Studio serves on port 1234", "- LM Studio serves on port 1235"), "a changed number is a change")
        self.assertFalse(guards.near_duplicate("- Google Calendar skill (Apps Script bridge): works.",
                                               "- Gmail skill (Apps Script bridge): drafts work. Send, reply and trash are OFF."))
        body = body_of(HUBP, {"Open Threads": ["- Planned: Gemini models curation (D drive).", "- Planned: Write the prompts.", "- Planned: D drive (Gemini models curation location)"]})
        out, c = guards.dedupe_body(HUBP, body)
        self.assertEqual(bullets(out, "Open Threads"), ["- Planned: Gemini models curation (D drive).", "- Planned: Write the prompts."])
        self.assertEqual(c, Counter({"duplicate_dropped": 1}))
        self.assertEqual(guards.dedupe_body(HUBP, out), (out, Counter()))
        # A settled host bullet stays; the model's restatement goes.
        arch = body_of(ARCH, {"Guardrails": ["- Never send anything: no emails or posts", "- Never send anything. No emails or posts."]})
        out, _ = guards.dedupe_body(ARCH, arch, "", ["Never send anything. No emails or posts."])
        self.assertEqual(bullets(out, "Guardrails"), ["- Never send anything. No emails or posts."])

    def test_counts_and_measurements(self):
        body = body_of(HUBP, {"Active State": ["- MCP servers (same 7 in both apps):", "  - git", "  - fetch", "  - brave-search", "  - sequential-thinking",
                                               "- 2 machines on the overlay network:", "  - desk", "  - laptop"]})
        out, c = guards.hygiene_body(HUBP, body)
        self.assertIn("- MCP servers (same in both apps):", out)
        self.assertIn("- 2 machines on the overlay network:", out, "a count that matches stays")
        self.assertEqual(c, Counter({"count_claim_fixed": 1}))
        foot = "- **Disk footprint:** Fresh task ~80 KB; 3-iteration task with 41 rows ~100 KB. Caps: JSON <=64 KB, summary <=4 KB. Past 400 rows log only milestones."
        out, c = guards.hygiene_body(PROJ, body_of(PROJ, {"Active State": [foot, "- **Speed:** a call takes ~3 s on the GPU."]}))
        a = bullets(out, "Active State")
        self.assertEqual(a, ["- Caps: JSON <=64 KB, summary <=4 KB. Past 400 rows log only milestones."])
        self.assertEqual(c, Counter({"measurement_removed": 1, "measurement_dropped": 1}))
        self.assertEqual(guards.hygiene_body(PROJ, out), (out, Counter()))


# ── 8 + end to end: the r7 shapes through dry-run and --apply ────────────────


def r7_shape_reply(messages):
    """The shapes the r7 booking-scope / truth / privacy / quality reviews flagged (synthetic)."""
    u = user_text(messages)
    rel = re.search(r"^TARGET: (\S+)", u, re.M).group(1)
    ents: list = []
    if rel == ARCH.rel:
        sections = {"Locked Design Decisions": ["- Agents load only necessary context (INDEX + STATUS + own card)."],
                    "Guardrails": ["- NEVER send emails or posts; drafts only.", "- NEVER install new skills/MCPs/packages without Librarian approval.",
                                   "- Librarian is the ONLY agent authorized to write rules; requires Nic's approval per change."]}
        ents = [dict(HUB_LIB)]
    elif rel == LESS.rel:
        sections = {"Failure Modes": ["- LM Studio custom MCPs won't connect via npx/uvx; not needed for AnythingLLM agents."],
                    "Tool Quirks": ["- Agents run in AnythingLLM; do not use external MCPs for connection."]}
    elif rel == IDENT.rel:
        sections = {"Communication Preferences": ["- No fluff, practical answers."]}
    elif rel == HUBP.rel:
        sections = {"Active State": ["- MCP servers (same 7 in both apps):", "  - git", "  - fetch", "  - brave-search"],
                    "Open Threads": ["- Planned: Read MASTER_IDENTITY.md and AGENTS_NEVER.md, fix anything wrong, then lock v1."]}
    else:
        sections = {"Key Paths": ["- `%APPDATA%\\os.agentic.commandcenter\\tasks.db`"],
                    "Active State": [AUTO, "- **Disk footprint:** Fresh task ~80 KB; 41 rows ~100 KB."]}
        ents = [dict(CC_LIB), {"name": "tasks.db", "entityType": "path", "observations": ["Shared store of task envelopes"]}]
    return json.dumps(section_reply(rel, sections, entities=ents))


class R7ShapesV5Tests(CuratedBase):
    def setUp(self):
        super().setUp()
        hub = self.sb.root / "hub" / "master"
        (hub / "AGENTS_NEVER.md").write_text(AGENTS_NEVER, encoding="utf-8")
        (hub / "STATUS.md").write_text((hub / "STATUS.md").read_text(encoding="utf-8")
                                       + "- LM Studio custom MCPs won't connect (npx/uvx). Not needed: agents run in AnythingLLM.\n", encoding="utf-8")
        tiering = self.sb.root / "repo" / "docs" / "MEMORY_TIERING_REPORT.md"
        text = tiering.read_text(encoding="utf-8").replace(
            "## 1. Architecture as built", "## 0. The Command Center at a glance\n- OVERVIEW-SENTINEL a Tauri desktop app; Tony is the voice front agent.\n\n## 1. Architecture as built")
        tiering.write_text(text, encoding="utf-8")

    def test_preview_is_faithful_and_apply_validates(self):
        res, events, llm = self.dry(FakeLLM([r7_shape_reply] * 64))
        prompts = json.dumps([user_text(m) for m in llm.calls])
        self.assertIn("OVERVIEW-SENTINEL", prompts, "the Command Center overview is on the curated allow-list")
        prev = Path(res["preview_dir"])
        scrolls = {r["rel"]: sc.parse((prev / "scrolls" / r["rel"]).read_text(encoding="utf-8")).body for r in res["proposed"]["targets"]}
        g = bullets(scrolls[ARCH.rel], "Guardrails")
        # (1) + (2): the host copies, Nic as the approver, the settled rule standalone, no acting item.
        self.assertIn("- Never install a new skill, MCP or package without Nic's approval. Propose it through the Librarian.", g)
        self.assertIn("- Never change rules or identity files.", g)
        self.assertIn("- Never send anything. No emails or posts. Drafts only.", g)
        self.assertNotIn("Librarian approval", scrolls[ARCH.rel])
        self.assertNotIn("acting", scrolls[ARCH.rel])
        self.assertIn("- (unconfirmed) Librarian is the ONLY agent authorized to write rules; requires Nic's approval per change.", g)
        # (6): the scopeless locked bullet has no source: unverified, unlocked.
        self.assertEqual(bullets(scrolls[ARCH.rel], "Locked Design Decisions"), [])
        self.assertIn("- (unverified) Agents load only necessary context (INDEX + STATUS + own card).", g)
        less = scrolls[LESS.rel]
        self.assertEqual(bullets(less, "Tool Quirks"), [])
        self.assertNotIn("external MCPs", less)
        self.assertEqual(len(bullets(less, "Failure Modes")), 1)
        # (3) + (9) on the hub project.
        hub = scrolls[HUBP.rel]
        self.assertIn("- (needs Nic's approval) Planned: Read MASTER_IDENTITY.md and AGENTS_NEVER.md, fix anything wrong, then lock v1.", bullets(hub, "Open Threads"))
        self.assertIn("- MCP servers (same in both apps):", hub)
        # (4) + (7) + (9) on the Command Center project.
        proj = scrolls[PROJ.rel]
        self.assertIn("approve() still gates every mutating plan", proj)
        self.assertIn("tasks.db` (planned, not created yet)", proj)
        self.assertNotIn("~80 KB", proj)
        # (5): the two Librarians stay apart; the contested one is unconfirmed throughout.
        kg = [json.loads(x) for x in (prev / "kg-preview.jsonl").read_text(encoding="utf-8").splitlines() if x.strip()]
        names = {e["name"]: e for e in kg}
        self.assertIn("Librarian (ai-hub)", names)
        self.assertIn("Librarian (Command Center)", names)
        self.assertTrue(all(o.startswith("(unconfirmed)") for o in names["Librarian (ai-hub)"]["observations"]))
        self.assertEqual(names["Librarian (Command Center)"]["observations"], CC_LIB["observations"])
        self.assertEqual(names["tasks.db"]["observations"], ["(planned, not created yet) Shared store of task envelopes"])
        report = json.loads((prev / "report.json").read_text(encoding="utf-8"))
        self.assertEqual(report["guards"]["version"], guards.GUARDS_VERSION)
        self.assertEqual(report["guards"]["removed"]["kg_merged"]["conflict_kept_apart"], 1)
        manifest = json.loads((prev / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["schema"], "agentic-os.offload-preview.v6")
        # The preview is a fixed point of every guard: --apply validates and promotes it.
        code, lines = self.apply(res["token"])
        self.assertEqual(code, 0, lines[-1])

    def test_apply_refuses_merged_conflicting_entities_and_v5_previews(self):
        res, _, _ = self.dry(FakeLLM([r7_shape_reply] * 64))
        prev = Path(res["preview_dir"])
        kg_file = prev / "kg-preview.jsonl"
        rows = [json.loads(x) for x in kg_file.read_text(encoding="utf-8").splitlines() if x.strip()]
        for r in rows:
            r["name"] = re.sub(r" \((?:ai-hub|Command Center)\)$", "", r["name"])
        kg_file.write_text("\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8")
        ents_by_rel: dict = {}
        for r in rows:
            ents_by_rel.setdefault(r.pop("target"), []).append(r)
        self.assertEqual(guards.kg_conflicts(ents_by_rel), ["Librarian"])
        with self.assertRaises(offload.ConfigError) as ctx:
            offload._promote_plan(self.sb.paths(), prev, json.loads((prev / "manifest.json").read_text(encoding="utf-8")), ents_by_rel,
                                  lambda rel: ["arch-0000-00-00-00"], "2026-11-19T23:00:00-05:00", [], plans=offload.plan_indexes(self.sb.paths(), self.sb.env, [], None, "curated"))
        self.assertIn("conflicting observations under one name", str(ctx.exception))
        with mock.patch.object(offload, "MANIFEST_SCHEMA", "agentic-os.offload-preview.v5"):
            res, _, _ = self.dry(FakeLLM([r7_shape_reply] * 64))
        tree = self.sb.tree()
        code, lines = self.apply(res["token"])
        self.assertEqual(code, 2)
        self.assertIn("predates the v5 fidelity guards", lines[-1]["error"])
        self.assertEqual(self.sb.tree(), tree)

    def test_overview_section_is_kept_with_section_one_cut(self):
        big = "## 0. The Command Center at a glance\n- OVERVIEW-SENTINEL app.\n\n## 1. Architecture as built\n" + "".join(f"- tier line {i} with some words\n" for i in range(400))
        (self.sb.root / "repo" / "docs" / "MEMORY_TIERING_REPORT.md").write_text("# Memory Tiering\n\n" + big, encoding="utf-8")
        recs, notes = offload.gather_repo_docs(self.sb.paths(), [])
        row = next(r for r in notes["files"] if r["file"] == "docs/MEMORY_TIERING_REPORT.md")
        self.assertEqual((row["sections_kept"], row["truncated"]), (2, 1))
        rec = next(r for r in recs if r["source"] == "repo:docs/MEMORY_TIERING_REPORT.md")
        self.assertIn("OVERVIEW-SENTINEL", rec["text"])
        self.assertLessEqual(len(rec["text"].encode("utf-8")), 4 * 1024)
        sha = offload.curated_allowlist_sha()
        with mock.patch.object(offload, "REPO_SECTION_CUT_MIN", 2048):
            self.assertNotEqual(offload.curated_allowlist_sha(), sha)
        self.assertTrue(any(r[0] == "docs/MEMORY_TIERING_REPORT.md" and any("glance" in s for s in r[1]) for r in offload.REPO_DOCS))


# ── round 9: the r8 review findings (synthetic data only) ───────────────────


R9_SOURCES = [
    "1. Never commit model files (.gguf, .safetensors) to Git.",
    "2. Never delete. Move it to a review label.",
    "3. Never send anything. Drafts only. Nic sends.",
    "4. Label assumptions.",
    "5. Never send anything. No emails, messages or posts.",
    "- No source is ever pruned or rewritten.",
    "- Never store keys in the shared hub.",
    "- Never send anything on the owner's behalf.",
    "- The guarded workspaces are never written.",
    "- No remote engine is reachable from the worker (`offload_rules`: cloud-api/edge-api/droplet are never chosen).",
]


class R9SupportTests(unittest.TestCase):
    def setUp(self):
        self.sup = guards.SupportIndex(R9_SOURCES)

    def test_an_inverted_obligation_is_unsupported(self):
        self.assertFalse(self.sup.supported("- Always commit model files (.gguf, .safetensors) to Git."))
        self.assertFalse(self.sup.supported("- Always delete or trash old files."))
        self.assertTrue(self.sup.supported("- Never commit model files to Git."))
        self.assertTrue(self.sup.supported("- Always label assumptions."), "a source imperative still backs an obligation")

    def test_a_merged_line_never_lends_its_negation(self):
        for b in ("- Never move files to a review label or folder.", "- Nic never sends anything.", "- Never label assumptions."):
            self.assertFalse(self.sup.supported(b), b)
        self.assertTrue(self.sup.supported("- Never send emails, messages or posts."), "a run of negated sentences still merges")
        merged = guards.SupportIndex(["1. Never send anything. No emails, messages, posts or submissions. Drafts only."])
        self.assertTrue(merged.supported("- NEVER send emails, messages, posts, or submissions; drafts only."))

    def test_passive_and_irregular_restatements(self):
        for b in ("- Never prune or rewrite a source.", "- Keys are never stored in the shared hub.", "- Messages are never sent on the owner's behalf.",
                  "- Agents never write to the guarded workspaces."):
            self.assertTrue(self.sup.supported(b), b)
        self.assertEqual(guards._sstem("stored"), guards._sstem("store"))
        self.assertEqual(guards._sstem("approved"), guards._sstem("approve"))
        self.assertEqual(guards._sstem("written"), guards._sstem("write"))

    def test_a_rule_in_source_brackets_supports(self):
        self.assertTrue(self.sup.supported("- cloud-api, edge-api and droplet are never chosen by offload_rules."))
        self.assertFalse(self.sup.supported("- cloud-api is always chosen by offload_rules."), "the bracket's polarity stays its own")


class R9DedupeAndSettledTests(unittest.TestCase):
    def setUp(self):
        self.idx = idx_with(guards.settled_items(AGENTS_NEVER))
        self.protect = guards.settled_bullets(guards.settled_items(AGENTS_NEVER))

    def test_contradictions_are_never_duplicates(self):
        for a, b in (("- Coder commits to main branch directly", "- Coder never commits to main branch directly"),
                     ("- Agents may edit SYSTEM.md rules files", "- Agents must not edit SYSTEM.md rules files"),
                     ("- Agents may install skills with Nic's approval", "- Agents never install skills without Nic's approval"),
                     ("- The mic is muted during TTS playback", "- The mic is not muted during TTS playback"),
                     ("- Workspaces stay embedded until the snapshot is verified", "- Workspaces are un-embedded after the snapshot is verified")):
            self.assertFalse(guards.near_duplicate(a, b), (a, b))
        body = body_of(ARCH, {"Guardrails": ["- Coder commits to main branch directly.", "- Coder never commits to main branch directly."]})
        out, c = guards.dedupe_body(ARCH, body)
        self.assertEqual(len(bullets(out, "Guardrails")), 2)
        self.assertEqual(c, Counter())

    def test_a_narrower_restatement_elsewhere_never_stands_for_the_settled_rule(self):
        body = body_of(ARCH, {"Locked Design Decisions": ["- Never send emails or messages without Nic's approval."], "Guardrails": ["- Never print secrets in logs."]})
        out, c = guards.settled_body(ARCH, body, "", self.idx)
        self.assertIn("- Never send anything. No emails or posts. Drafts only.", bullets(out, "Guardrails"))
        self.assertEqual(guards.settled_body(ARCH, out, "", self.idx), (out, Counter()), "a fixed point")

    def test_a_covering_bullet_with_an_extra_clause_is_kept(self):
        extra = "- Never install a new skill, MCP or package without Nic's approval, and never write to the shared hub (it is read-only)."
        body = body_of(ARCH, {"Guardrails": [extra]})
        out, c = guards.settled_body(ARCH, body, "", self.idx)
        g = bullets(out, "Guardrails")
        self.assertIn(extra, g)
        self.assertIn("- Never install a new skill, MCP or package without Nic's approval. Propose it through the Librarian.", g)
        self.assertNotIn("settled_replaced", c)
        out2, c2 = guards.dedupe_body(ARCH, out, "", self.protect)
        self.assertIn(extra, bullets(out2, "Guardrails"), "dedupe never drops the extra clause")
        # A plain restatement is still replaced by the host copy.
        out, c = guards.settled_body(ARCH, body_of(ARCH, {"Guardrails": ["- NEVER install new skills/MCPs/packages without Librarian approval."]}), "", self.idx)
        self.assertEqual(c["settled_replaced"], 1)


class R9RewriteTests(unittest.TestCase):
    def test_a_denied_agent_approval_is_never_rewritten(self):
        for t in ("Skill installs need Nic's approval - the Librarian's approval is not enough.",
                  "Never install a skill or MCP on an agent's approval alone; Nic approves installs.",
                  "Config changes: Coder's sign-off is never sufficient.",
                  "Install packages with Nic's approval, not the Coder's approval."):
            self.assertEqual(guards.approver_fix(t), (None, ""), t)
        self.assertEqual(guards.approver_fix("Skill installs: the Librarian's approval is not required."), (None, "demote"))
        self.assertEqual(guards.approver_fix("Never install a skill without the Librarian's approval.")[1], "rewrite")
        ents, c = guards.content_entities([{"name": "Installs", "entityType": "concept", "observations": ["The Librarian's approval is not enough for installs"]}], None)
        self.assertEqual(ents[0]["observations"], ["The Librarian's approval is not enough for installs"])
        self.assertEqual(c, Counter())

    def test_a_negated_term_gets_no_qualifier(self):
        self.assertEqual(guards.qualify("- Never un-embed a workspace."), (None, ""))
        self.assertEqual(guards.qualify("- auto_dispatch is off and never used."), (None, ""))
        self.assertEqual(guards.qualify("- Un-embed old workspaces.")[1], "append")

    def test_versions_and_ordinals_are_not_counts(self):
        for line, n in (("- React 19 front end layers:", 3), ("- Phase 5 vocal handoff cues:", 2), ("- Tier 3 gates:", 2), ("- Round 8 guards:", 2), ("- v2 rules:", 3)):
            self.assertIsNone(guards.count_fix(line, n), line)
        self.assertEqual(guards.count_fix("- MCP servers (same 7 in both apps):", 4), "- MCP servers (same in both apps):")
        self.assertEqual(guards.count_fix("- The 5 roles:", 3), "- The roles:")


class R9ProbeTests(unittest.TestCase):
    def test_own_output_files_are_not_planned(self):
        sb = Sandbox(key=None)
        try:
            probe = offload.path_probe(sb.paths(), sb.env, offload.REPO_TARGET)
            for name in ("report.json", "manifest.json", "kg-preview.jsonl", "manifest.jsonl", "arch-2026-11-19-01.jsonl", "arch-YYYY-MM-DD-NN.jsonl"):
                self.assertIsNone(probe(name), name)
            self.assertIs(probe("tasks.db"), False, "any other missing bare name is still planned")
            self.assertIsNone(guards.annotate_paths("The preview holds `kg-preview.jsonl`, `report.json` and `manifest.json`.", probe, False))
        finally:
            sb.close()


def r9_merge_reply(messages):
    """r7 shapes plus one near-duplicate entity in two targets whose path probes differ."""
    out = json.loads(r7_shape_reply(messages))
    rel = re.search(r"^TARGET: (\S+)", user_text(messages), re.M).group(1)
    if rel == HUBP.rel:
        out["graph_entities_to_upsert"] = [{"name": "AnythingLLM", "entityType": "tool", "observations": ["MCP servers listed in r9_mcp_servers.json"]}]
    elif rel == PROJ.rel:
        out["graph_entities_to_upsert"] = list(out.get("graph_entities_to_upsert") or []) + [
            {"name": "AnythingLLM", "entityType": "tool", "observations": ["Workspaces hold the agent prompts"]}]
    return json.dumps(out)


class R9CrossTargetMergeTests(R7ShapesV5Tests):
    def test_preview_is_faithful_and_apply_validates(self):
        pass  # covered by R7ShapesV5Tests

    def test_apply_refuses_merged_conflicting_entities_and_v5_previews(self):
        pass  # covered by R7ShapesV5Tests

    def test_overview_section_is_kept_with_section_one_cut(self):
        pass  # covered by R7ShapesV5Tests

    def test_a_hub_observation_merged_into_the_repo_entity_stays_a_fixed_point(self):
        # Before round 9 the hub observation merged into the repo target's entity, where --apply's repo
        # probe marks the bare file name planned: a fresh dry-run refused forever.
        with mock.patch.object(offload, "_kg_fits_target", return_value=True):
            res, _, _ = self.dry(FakeLLM([r9_merge_reply] * 64))
        tree = self.sb.tree()
        code, lines = self.apply(res["token"])
        self.assertEqual(code, 2, "the unfixed merge is refused")
        self.assertEqual(self.sb.tree(), tree)
        res, _, _ = self.dry(FakeLLM([r9_merge_reply] * 64))
        prev = Path(res["preview_dir"])
        kg = [json.loads(x) for x in (prev / "kg-preview.jsonl").read_text(encoding="utf-8").splitlines() if x.strip()]
        allm = {e["name"]: e for e in kg if e["name"].startswith("AnythingLLM")}
        self.assertEqual(len(allm), 2, allm)
        hub = next(e for e in allm.values() if e["target"] == HUBP.rel)
        self.assertEqual(hub["observations"], ["MCP servers listed in r9_mcp_servers.json"])
        report = json.loads((prev / "report.json").read_text(encoding="utf-8"))
        self.assertEqual(report["guards"]["removed"]["kg_merged"]["target_guards_kept_apart"], 1)
        code, lines = self.apply(res["token"])
        self.assertEqual(code, 0, lines[-1])


if __name__ == "__main__":
    unittest.main()
