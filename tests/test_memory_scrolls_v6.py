"""Memory Scrolls round 9 review fixes: guards v6, stale claims v4 (synthetic data only).

The booking-scope lens blocked preview 20261120-011216 on one item, and the other lenses confirmed four
majors. Each fix has unit tests (with a fixed-point check) here, and the shapes are replayed end to end
(dry-run + `--apply`) in `R8ShapesV6Tests`:

1. passive / modal orders ("... must be repointed manually") are agent imperatives; a Planned: line about
   curating / pruning / deleting files or testing all MCPs needs Nic's approval;
2. a NEW bullet restating a settled AGENTS_NEVER guardrail goes, always when it adds an exception;
3. contested #4 in a model bullet ("...; only Librarian with Nic's approval") is "(unconfirmed)";
4. the absolute Tier-3 gate carries the auto_dispatch (Builder) exception;
5. KG: the planned marker is only a prefix, the name probe needs a path-like name, a bare "path" name is a
   "concept", and "... for <another tool>" goes unless a source line ties both.

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
from test_memory_scrolls_curated import ARCH, HUBP, IDENT, LESS, PROJ  # noqa: E402
import test_memory_scrolls_fidelity as fid  # noqa: E402  (module import: its TestCases are not collected twice)

# Synthetic hard rules in the shape of the hub AGENTS_NEVER.md.
NEVER_V6 = """# AGENTS_NEVER - hard rules (synthetic)

## NEVER
1. Never send anything. No emails or posts. Drafts only.
2. Never change rules or identity files. Only the Librarian, with Nic's approval.
3. Never spend money, sign up for anything, or accept terms.
4. Never install a new skill, MCP or package without Nic's approval. Propose it through the Librarian.
"""

TIER3_Q = "(except auto_dispatch in Builder: pipeline build from a live brainstorm, writes to staging/ only; approve() still gates every mutating plan)"


def body_of(t: sc.Target, sections: dict) -> str:
    return section_reply(t.rel, sections)["updated_markdown"]


def bullets(body: str, head: str) -> list:
    return sc.section_bullets(body, [head])


def settled_idx(sources=None, plans=(), status=()) -> guards.PlanIndex:
    return guards.PlanIndex(list(plans), list(status), sources, guards.settled_items(NEVER_V6))


# ── 1. passive / modal orders and approval-gated plans ───────────────────────


class PassiveImperativeTests(unittest.TestCase):
    def test_detection(self):
        for s in ("- **Index path update:** The helper MCP entry still names the old `C:\\old\\store` file; must be repointed manually.",
                  "- The helper MCP entry must be repointed by hand", "- The old cache needs to be deleted", "- Exports have to be uploaded to the drive",
                  "- The sample config should be reconfigured for port 9999", "- Legacy notes are to be backed up to the spare disk","- The bridge has to be re-downloaded"):
            self.assertEqual(guards.imperative_kind(s), "agent_action", s)
        for s in ("- The entry must never be repointed", "- Must be repointed only with Nic's approval", "- Config must be updated atomically (tmp + rename)",
                  "- Settings must be changed via approve()", "- Nothing needs to be deleted", "- Messages are never sent", "- Corrupt files renamed to `.bad`",
                  "- Files are moved to a review folder", "- Every rule change must be approved by Nic", "- Notes must be backed up first, then pruned"):
            self.assertIsNone(guards.imperative_kind(s), s)

    def test_body_marks_moves_or_drops(self):
        line = "- **Index path update:** The helper MCP entry still names the old store file; must be repointed manually."
        body = body_of(PROJ, {"Active State": ["- Gateway on :8080"], "Open Threads": [line]})
        out, c = guards.imperatives_body(PROJ, body)
        self.assertEqual(bullets(out, "Open Threads"), ["- (needs Nic's approval) " + line[2:]])
        self.assertEqual(c, Counter({"imperative_marked": 1}))
        self.assertEqual(guards.imperatives_body(PROJ, out), (out, Counter()), "a fixed point")
        body = body_of(PROJ, {"Active State": [line]})
        out, c = guards.imperatives_body(PROJ, body)
        self.assertEqual(bullets(out, "Active State"), [])
        self.assertEqual(c, Counter({"imperative_moved": 1}))
        body = body_of(ARCH, {"Guardrails": [line, "- Never send anything"]})
        out, c = guards.imperatives_body(ARCH, body)
        self.assertEqual(bullets(out, "Guardrails"), ["- Never send anything"])
        self.assertEqual(c, Counter({"imperative_dropped": 1}))
        # check_preview uses the same detector: an unmarked passive order is never a fixed point.
        left = guards.check_preview(PROJ, body_of(PROJ, {"Open Threads": [line]}), [], "")
        self.assertEqual(left.get("content_imperative_marked"), 1)
        # ... and a KG observation that is one goes.
        ents, c = guards.content_entities([{"name": "Helper MCP", "entityType": "tool", "observations": ["Entry must be repointed manually.", "Reads the index"]}])
        self.assertEqual(ents[0]["observations"], ["Reads the index"])
        self.assertEqual(c, Counter({"imperative_kg": 1}))

    def test_plans_about_curating_or_testing_all_mcps_need_approval(self):
        for s in ("- Planned: Local model folder curation (E drive).", "- Planned: Prune the old skill folders", "- Planned: Clean up the drafts folder",
                  "- Planned: Testing day: test all MCPs with the local model.", "- Planned: test every MCP in the desktop client"):
            self.assertTrue(guards.plan_needs_approval(s), s)
        self.assertFalse(guards.plan_needs_approval("- Planned: Write the overview doc"))
        self.assertFalse(guards.plan_needs_approval("- Planned: Test the voice loop on the phone"))
        body = body_of(HUBP, {"Open Threads": ["- Planned: Local model folder curation (E drive).", "- Planned: Testing day: test all MCPs with the local model.",
                                               "- Planned: Write the overview doc."]})
        out, c = guards.imperatives_body(HUBP, body)
        self.assertEqual(bullets(out, "Open Threads"), ["- (needs Nic's approval) Planned: Local model folder curation (E drive).",
                                                        "- (needs Nic's approval) Planned: Testing day: test all MCPs with the local model.",
                                                        "- Planned: Write the overview doc."])
        self.assertEqual(c, Counter({"imperative_marked": 2}))
        # A restated roadmap line without the "Planned:" prefix: both marks, and the full guard set is a fixed point.
        idx = guards.PlanIndex(["Local model folder curation on the E drive"], ["LM Studio serves on port 1235"])
        body = body_of(HUBP, {"Active State": ["- Local model folder curation (E drive)."]})
        out, _ = guards.content_body(HUBP, body, "", idx)
        self.assertEqual(len(bullets(out, "Open Threads")), 1)
        moved = bullets(out, "Open Threads")[0]
        self.assertEqual(guards._marks(guards._split_bullet(moved)[1])[0], {"planned", "approval"}, moved)
        self.assertEqual(guards.content_body(HUBP, out, "", idx)[1], Counter(), "a fixed point")
        # A non-project scroll drops it.
        out, c = guards.imperatives_body(ARCH, body_of(ARCH, {"Guardrails": ["- Planned: Local model folder curation (E drive)."]}))
        self.assertEqual(c, Counter({"imperative_dropped": 1}))


# ── 2. restatements of a settled guardrail ──────────────────────────────────


class SettledRestatementTests(unittest.TestCase):
    def test_detector(self):
        rule = "Never spend money, sign up for anything, or accept terms."
        self.assertTrue(guards.settled_restatement(rule, "NEVER spend money, sign up, or accept terms without explicit approval."), "an added exception")
        self.assertTrue(guards.settled_restatement(rule, "Never spend money or sign up unless Nic approves."), "an added exception, partial")
        self.assertTrue(guards.settled_restatement(rule, "NEVER spend money, sign up, or accept terms."), "the same words")
        self.assertFalse(guards.settled_restatement(rule, "Always spend money, sign up, or accept terms."), "another polarity")
        self.assertTrue(guards.settled_restatement("Never present a guess as a fact. Label assumptions.", "NEVER present a guess as a fact; always label assumptions."),
                        "'always X' restates the rule's imperative")
        self.assertFalse(guards.settled_restatement(rule, "Spend money only with a receipt."), "no NEVER polarity")
        self.assertFalse(guards.settled_restatement(rule, "Never spend money; the budget sheet lives in the finance tracker folder."), "an extra clause")
        rules = "Never change rules or identity files."
        self.assertFalse(guards.settled_restatement(rules, "Never change config files."), "a different object is a different rule")
        self.assertFalse(guards.settled_restatement(rules, "Never change files."), "a broader rule is not a restatement")
        self.assertTrue(guards.settled_restatement("Never send anything. No emails or posts. Drafts only.", "NEVER send emails or posts; drafts only."))
        self.assertFalse(guards.settled_restatement(rules, "Never change rules or identity files, and never write to the hub folder."), "an extra rule")
        install = "Never install a new skill, MCP or package without Nic's approval. Propose it through the Librarian."
        self.assertFalse(guards.settled_restatement(install, "Never install a new skill without Nic's approval; prefer official MCPs from the vendor list."),
                         "the rule's own exception is not added; an extra clause keeps it")

    def test_body_drops_restatements_keeps_the_rest(self):
        idx = settled_idx()
        model = ["- NEVER spend money, sign up, or accept terms without explicit approval.", "- NEVER send emails or posts unless Nic approves.",
                 "- Never change config files.", "- Never change rules or identity files, and never write to the hub folder."]
        body = body_of(ARCH, {"Locked Design Decisions": ["- Never spend money, sign up for anything or accept any terms.", "- Every rule change is one Git commit."],
                              "Guardrails": model})
        out, c = guards.content_body(ARCH, body, "", idx)
        g = bullets(out, "Guardrails")
        self.assertIn("- Never spend money, sign up for anything, or accept terms.", g)
        self.assertIn("- Never send anything. No emails or posts. Drafts only.", g)
        self.assertNotIn(model[0], g)
        self.assertNotIn(model[1], g)
        self.assertIn(model[2], g)
        self.assertIn(model[3], g)
        self.assertEqual(bullets(out, "Locked Design Decisions"), ["- Every rule change is one Git commit."], "a NEW locked restatement goes")
        self.assertEqual(c["settled_restatement_dropped"], 3)
        self.assertEqual(guards.content_body(ARCH, out, "", idx)[1], Counter(), "a fixed point")
        left = guards.check_preview(ARCH, body, [], "", plans=idx)
        self.assertTrue(left.get("content_settled_restatement_dropped"))
        # An existing (current-scroll) locked restatement is never dropped.
        cur = body_of(ARCH, {"Locked Design Decisions": ["- Never spend money, sign up for anything or accept any terms."]})
        out, c = guards.content_body(ARCH, cur, cur, idx)
        self.assertEqual(bullets(out, "Locked Design Decisions"), ["- Never spend money, sign up for anything or accept any terms."])
        self.assertNotIn("settled_restatement_dropped", c)

    def test_only_when_the_host_copy_is_present(self):
        body = body_of(ARCH, {"Guardrails": ["- NEVER spend money without explicit approval."]})
        self.assertEqual(guards.settled_restatements_body(ARCH, body, "", guards.PlanIndex([], []))[1], Counter(), "no settled source")
        self.assertEqual(guards.settled_restatements_body(PROJ, body, "", settled_idx())[1], Counter(), "the architecture scroll only")
        self.assertEqual(guards.settled_restatements_body(ARCH, body, "", settled_idx())[1], Counter(), "the host copy is not placed yet")


# ── 3. contested #4 in model bullets ────────────────────────────────────────


class ContestedVariantTests(unittest.TestCase):
    def test_policy_v4(self):
        pol = stc.default_policy()
        self.assertEqual(pol.version, stc.STALE_CLAIMS_VERSION)
        self.assertEqual(stc.STALE_CLAIMS_VERSION, 4)
        for s in ("- NEVER change rules or identity files; only Librarian with Nic's approval.", "- Edit identity files only the Librarian may",
                  "- Rule updates: only the Librarian, with approval"):
            self.assertEqual(getattr(pol.match(s), "id", None), "contested-librarian-sole-writer", s)
        for s in ("- Coder edits code; read-only Librarian gathers context", "- Writes go to staging only; the Librarian reads", "- Never change rules or identity files."):
            self.assertIsNone(pol.match(s), s)

    def test_demote_pass_uses_the_contested_sentence(self):
        pol = stc.default_policy()
        line = "- Librarian is the sole agent for rules."
        self.assertIsNone(pol.match(line), "the policy regex alone misses it")
        body = body_of(ARCH, {"Locked Design Decisions": [line], "Guardrails": [
            "- Never install a new skill, MCP or package without Nic's approval. Propose it through the Librarian. Official MCPs only for anything touching his accounts."]})
        out, dropped, demoted, _ = guards.stale_body(ARCH, body, "", pol)
        self.assertEqual(demoted, Counter({"contested-librarian-sole-writer": 1}))
        self.assertIn("- (unconfirmed) Librarian is the sole agent for rules.", bullets(out, "Guardrails"))
        self.assertIn("Official MCPs only for anything touching his accounts.", out, "a host settled bullet is never demoted")
        self.assertEqual(guards.stale_body(ARCH, out, "", pol)[2], Counter(), "a fixed point")
        self.assertEqual(guards.stale_body(ARCH, body, body, pol)[2], Counter(), "a current-scroll line is never touched")
        removed = stc.Policy(stc.STALE_CLAIMS_VERSION, tuple(r for r in pol.rules if r.id != "contested-librarian-sole-writer"))
        self.assertEqual(guards.stale_body(ARCH, body, "", removed)[2], Counter(), "an override that removes the rule turns it off")

    def test_settled_half_plus_contested_half_goes_when_the_claim_is_kept_elsewhere(self):
        idx = settled_idx()
        mixed = "- NEVER change rules or identity files; only Librarian with Nic's approval."
        other = "- Librarian is the ONLY agent authorized to write rules; requires Nic's approval."
        pol = stc.default_policy()
        body = body_of(ARCH, {"Guardrails": [mixed, other]})
        body, _, demoted, _ = guards.stale_body(ARCH, body, "", pol)
        self.assertEqual(demoted["contested-librarian-sole-writer"], 2)
        out, c = guards.content_body(ARCH, body, "", idx, policy=pol)
        g = bullets(out, "Guardrails")
        self.assertIn("- Never change rules or identity files.", g)
        self.assertIn("- (unconfirmed) " + other[2:], g)
        self.assertNotIn("- (unconfirmed) " + mixed[2:], g)
        self.assertEqual(c["settled_contested_dropped"], 1)
        self.assertEqual(guards.content_body(ARCH, out, "", idx, policy=pol)[1], Counter(), "a fixed point")
        self.assertEqual(guards.check_preview(ARCH, out, [], "", pol, idx), Counter())
        # The only bullet carrying the contested claim stays "(unconfirmed)".
        alone, _, _, _ = guards.stale_body(ARCH, body_of(ARCH, {"Guardrails": [mixed]}), "", pol)
        out, c = guards.content_body(ARCH, alone, "", idx, policy=pol)
        self.assertIn("- (unconfirmed) " + mixed[2:], bullets(out, "Guardrails"))


# ── 4. the Tier-3 gate qualifier ────────────────────────────────────────────


class Tier3QualifierTests(unittest.TestCase):
    def test_absolute_gate_gets_the_builder_exception(self):
        line = "- **Tier-3 gates dispatch:** Envelope created only after approved Tier-3 yes or ledger Run click."
        new, act = guards.qualify(line)
        self.assertEqual((new, act), (f"{line} {TIER3_Q}", "append"))
        self.assertEqual(guards.qualify(new), (None, ""), "a fixed point (the auto_dispatch qualifier is satisfied too)")
        self.assertEqual(guards.qualify("- **Invariants:** Tier-3 gates dispatch; read-only messaging.")[1], "append")
        self.assertEqual(guards.qualify("- Dispatch is not gated only after a Tier-3 yes."), (None, ""), "negated")
        self.assertEqual(guards.qualify("- Tier-3 offer card shows a summary."), (None, ""), "no gate claim")
        ents, c = guards.content_entities([{"name": "Dispatch", "entityType": "concept", "observations": ["Envelope created only after a Tier-3 yes"]}])
        self.assertTrue(ents[0]["observations"][0].endswith(TIER3_Q))
        self.assertEqual(c, Counter({"qualifier_kg_appended": 1}))


# ── 5. knowledge graph ──────────────────────────────────────────────────────


def missing_probe(token: str):
    t = token.lower()
    if t.endswith(("cfg.json", "store.db")):
        return False
    return None


class KnowledgeGraphV6Tests(unittest.TestCase):
    def test_marker_is_only_a_prefix(self):
        self.assertEqual(guards._path_tokens("Corrupt files renamed to cfg.json.bad"), [])
        self.assertEqual([t for t, _ in guards._path_tokens("Kept in cfg.json.")], ["cfg.json"])
        idx = guards.PlanIndex([], [])
        idx.probe = missing_probe
        ents = [{"name": "cfg.json", "entityType": "path", "observations": ["Corrupt files renamed to cfg.json.bad", "Atomic writes"]},
                {"name": "Store", "entityType": "concept", "observations": ["Rows live in store.db beside the app"]}]
        out, c = guards.content_entities(ents, idx)
        self.assertEqual(out[0]["observations"], ["(planned, not created yet) Corrupt files renamed to cfg.json.bad", "(planned, not created yet) Atomic writes"])
        self.assertEqual(out[1]["observations"], ["(planned, not created yet) Rows live in store.db beside the app"])
        self.assertEqual(c, Counter({"path_planned_kg": 3}))
        self.assertEqual(guards.content_entities(out, idx)[1], Counter(), "a fixed point")

    def test_name_probe_and_retype(self):
        seen: list = []
        idx = guards.PlanIndex([], [])
        idx.probe = lambda tok: seen.append(tok) or False
        ents = [{"name": "preview-dir", "entityType": "path", "observations": ["Holds the dry-run previews"]},
                {"name": "Hostbox", "entityType": "path", "observations": ["Machine that runs the model server"]},
                {"name": "data/app/store.db", "entityType": "path", "observations": ["Task rows"]}]
        out, c = guards.content_entities(ents, idx)
        self.assertEqual([e["entityType"] for e in out], ["concept", "concept", "path"])
        self.assertEqual(out[0]["observations"], ["Holds the dry-run previews"], "a label is never probed")
        self.assertEqual(out[2]["observations"], ["(planned, not created yet) Task rows"])
        self.assertNotIn("preview-dir", seen)
        self.assertNotIn("Hostbox", seen)
        self.assertEqual(c, Counter({"path_type_retyped": 2, "path_planned_kg": 1}))
        self.assertEqual(guards.content_entities(out, idx)[1], Counter(), "a fixed point")
        for name in ("tasks.db", "C:\\x\\y", "%APPDATA%\\app", "notes.md", "a/b"):
            self.assertTrue(guards.path_like_name(name), name)
        for name in ("Hostbox", "preview-dir", "Model 3.5 9B", "scroll-history"):
            self.assertFalse(guards.path_like_name(name), name)

    def test_own_output_dirs_probe_as_none(self):
        sb = Sandbox(key=None)
        try:
            probe = offload.path_probe(sb.paths(), sb.env, offload.REPO_TARGET)
            for tok in ("scroll-history", "data/memory-scrolls/scroll-history/<scroll_id>/v<n>.md", "memory-scrolls-preview/<stamp>/",
                        "staging/memory-scrolls-preview/<stamp>/kg-preview.jsonl", "memory-scrolls/state.json"):
                self.assertIsNone(probe(tok), tok)
            self.assertIs(probe("tasks.db"), False, "any other missing name is still planned")
        finally:
            sb.close()

    def test_cross_tool_attribution(self):
        idx = guards.PlanIndex([], ["Code Agent: skills in the hub + Browser MCP", "Desktop client -> LM Studio (localhost:1235), Local Model 9B"])
        ents = [{"name": "AnythingLLM", "entityType": "tool", "observations": ["Desktop client for the local model", "Has Browser MCP for Claude Code."]},
                {"name": "Local Model 9B", "entityType": "tool", "observations": ["Main model for LM Studio"]},
                {"name": "Notes", "entityType": "concept", "observations": ["Written for Claude Code sessions"]}]
        out, c = guards.content_entities(ents, guards.PlanIndex([], ["Desktop client -> LM Studio (localhost:1235), Local Model 9B"]))
        self.assertEqual(out[0]["observations"], ["Desktop client for the local model"])
        self.assertEqual(out[1]["observations"], ["Main model for LM Studio"], "a source line ties both")
        self.assertEqual(out[2]["observations"], ["Written for Claude Code sessions"], "not a tool entity")
        self.assertEqual(c, Counter({"foreign_tool_kg": 1}))
        self.assertEqual(guards.content_entities(out, idx)[1], Counter(), "a fixed point")
        tied = guards.PlanIndex([], ["AnythingLLM and Claude Code both load the Browser MCP"])
        self.assertEqual(guards.content_entities(ents[:1], tied)[0][0]["observations"], ents[0]["observations"], "tied by a source line")
        self.assertEqual(guards.content_entities(ents[:1], None)[1], Counter({"foreign_tool_kg": 1}), "no sources: nothing ties them")


# ── end to end: the r8 shapes through dry-run and --apply ────────────────────


PASSIVE = "- **Index path update:** The helper MCP entry still names the old store file; must be repointed manually."
GATE = "- **Tier-3 gates dispatch:** Envelope created only after approved Tier-3 yes or ledger Run click."


def r8_shape_reply(messages):
    """The shapes the r8 reviews of 20261120-011216 flagged (synthetic), on top of the r7 shapes."""
    out = json.loads(fid.r7_shape_reply(messages))
    rel = re.search(r"^TARGET: (\S+)", user_text(messages), re.M).group(1)
    body = out["updated_markdown"]
    if rel == ARCH.rel:
        body = body.replace("## Guardrails\n", "## Guardrails\n- NEVER send anything, emails or posts without explicit approval.\n"
                            "- NEVER change rules or identity files; only Librarian with Nic's approval.\n")
    elif rel == PROJ.rel:
        body = body.replace("## Open Threads\n", f"## Open Threads\n{PASSIVE}\n").replace("## Active State\n", f"## Active State\n{GATE}\n")
        out["graph_entities_to_upsert"] = list(out.get("graph_entities_to_upsert") or []) + [
            {"name": "modes.json", "entityType": "path", "observations": ["Corrupt files renamed to modes.json.bad"]},
            {"name": "preview-dir", "entityType": "path", "observations": ["Holds the dry-run previews"]}]
    elif rel == HUBP.rel:
        body = body.replace("## Open Threads\n", "## Open Threads\n- Planned: Local model folder curation (E drive).\n"
                            "- Planned: Testing day: test all MCPs with the local model.\n")
        out["graph_entities_to_upsert"] = [{"name": "AnythingLLM", "entityType": "tool", "observations": ["Has Browser MCP for Claude Code."]},
                                           {"name": "Hostbox", "entityType": "path", "observations": ["Machine that runs the model server"]}]
    out["updated_markdown"] = body
    return json.dumps(out)


class R8ShapesV6Tests(fid.R7ShapesV5Tests):
    def test_preview_is_faithful_and_apply_validates(self):
        pass  # covered by R7ShapesV5Tests

    def test_apply_refuses_merged_conflicting_entities_and_v5_previews(self):
        pass  # covered by R7ShapesV5Tests

    def test_overview_section_is_kept_with_section_one_cut(self):
        pass  # covered by R7ShapesV5Tests

    def test_r8_shapes_are_fixed_and_apply_validates(self):
        res, _, _ = self.dry(FakeLLM([r8_shape_reply] * 64))
        prev = Path(res["preview_dir"])
        scrolls = {r["rel"]: sc.parse((prev / "scrolls" / r["rel"]).read_text(encoding="utf-8")).body for r in res["proposed"]["targets"]}
        g = bullets(scrolls[ARCH.rel], "Guardrails")
        self.assertIn("- Never send anything. No emails or posts. Drafts only.", g)
        self.assertNotIn("without explicit approval", scrolls[ARCH.rel], "the weakened restatement is gone")
        self.assertNotIn("only Librarian with", scrolls[ARCH.rel], "the settled half is a host bullet, the claim is kept elsewhere")
        self.assertIn("- Never change rules or identity files.", g)
        proj = scrolls[PROJ.rel]
        self.assertIn("- (needs Nic's approval) " + PASSIVE[2:], bullets(proj, "Open Threads"))
        self.assertIn(f"{GATE[2:]} {TIER3_Q}", proj)
        hub = scrolls[HUBP.rel]
        self.assertIn("- (needs Nic's approval) Planned: Local model folder curation (E drive).", bullets(hub, "Open Threads"))
        self.assertIn("- (needs Nic's approval) Planned: Testing day: test all MCPs with the local model.", bullets(hub, "Open Threads"))
        kg = {e["name"]: e for e in (json.loads(x) for x in (prev / "kg-preview.jsonl").read_text(encoding="utf-8").splitlines() if x.strip())}
        self.assertEqual(kg["modes.json"]["observations"], ["(planned, not created yet) Corrupt files renamed to modes.json.bad"])
        self.assertEqual((kg["preview-dir"]["entityType"], kg["preview-dir"]["observations"]), ("concept", ["Holds the dry-run previews"]))
        self.assertEqual(kg["Hostbox"]["entityType"], "concept")
        self.assertNotIn("AnythingLLM", kg, "its only observation attributed a tool to another tool")
        report = json.loads((prev / "report.json").read_text(encoding="utf-8"))
        self.assertEqual(report["guards"]["version"], guards.GUARDS_VERSION)
        self.assertEqual(report["guards"]["stale_claims"]["version"], 4)
        code, lines = self.apply(res["token"])
        self.assertEqual(code, 0, lines[-1])

    def test_a_guards_v5_preview_is_refused(self):
        with mock.patch.object(guards, "GUARDS_VERSION", 5):
            res, _, _ = self.dry(FakeLLM([r8_shape_reply] * 64))
        tree = self.sb.tree()
        code, lines = self.apply(res["token"])
        self.assertEqual(code, 2)
        self.assertIn("content-guard version", lines[-1]["error"])
        self.assertEqual(self.sb.tree(), tree, "nothing written")


# ── round 10: the v6 detectors stay narrow (review of guards v6, synthetic data) ──


# True read-only / routing facts that only mention "only" near "Librarian" (never contested #4).
R10_LIBRARIAN_FACTS = (
    "- Memory Scrolls are the only layer synced into the librarian workspace.",
    "- The Librarian model only condenses retrieved context into `librarian_brief`.",
    "- Scrolls sync into the `librarian` workspace only.",
    "- Agents propose skills, the Librarian checks them and only Nic approves.",
    "- Ask the Librarian only for context lookups.",
    "- Librarian only reads; it never writes, embeds, uploads or deletes.",
    "- Coder writes code to staging/ and only the Librarian reads the hub.",
    "- Rules change by Nic approval, not only the Librarian proposing.",
)
R10_CONTESTED = (
    "- NEVER change rules or identity files; only Librarian with Nic's approval.",
    "- Only the Librarian, with Nic's approval.",
    "- Librarian is the sole agent for rules.",
    "- Only the Librarian edits rules.",
    "- Rules can be changed only by the Librarian.",
    "- Edit identity files only the Librarian may",
)


class R10ContestedBoundTests(unittest.TestCase):
    def test_read_only_facts_are_never_contested(self):
        pol = stc.default_policy()
        for s in R10_LIBRARIAN_FACTS:
            self.assertIsNone(pol.match(s), s)
            self.assertIsNone(guards._contested_rule(pol, s), s)
        for s in R10_CONTESTED:
            self.assertIsNotNone(guards._contested_rule(pol, s) or pol.match(s), s)
        body = body_of(ARCH, {"Locked Design Decisions": list(R10_LIBRARIAN_FACTS)})
        out, dropped, demoted, _ = guards.stale_body(ARCH, body, "", pol)
        self.assertEqual((dropped, demoted), (Counter(), Counter()))
        self.assertEqual(bullets(out, "Locked Design Decisions"), list(R10_LIBRARIAN_FACTS), "they stay locked, unmarked")
        # The same lines in a current scroll (existing: true rules) are never touched either.
        self.assertEqual(guards.stale_body(ARCH, body, "", pol, existing_only=True)[2], Counter())

    def test_the_only_contested_bullet_is_never_dropped_for_a_fact(self):
        idx = settled_idx()
        pol = stc.default_policy()
        mixed = "- NEVER change rules or identity files; only Librarian with Nic's approval."
        body = body_of(ARCH, {"Locked Design Decisions": [R10_LIBRARIAN_FACTS[0]], "Guardrails": [mixed]})
        body, _, demoted, _ = guards.stale_body(ARCH, body, "", pol)
        self.assertEqual(demoted, Counter({"contested-librarian-sole-writer": 1}))
        out, c = guards.content_body(ARCH, body, "", idx, policy=pol)
        self.assertIn("- (unconfirmed) " + mixed[2:], bullets(out, "Guardrails"), "the claim Nic must confirm stays")
        self.assertIn(R10_LIBRARIAN_FACTS[0], bullets(out, "Locked Design Decisions"))
        self.assertNotIn("settled_contested_dropped", c)
        self.assertEqual(guards.check_preview(ARCH, out, [], "", pol, idx), Counter())
        # A fact that was demoted elsewhere ("(unconfirmed)", e.g. by an older run) never counts as the claim kept.
        fake = "- (unconfirmed) Memory Scrolls are the only layer synced into the librarian workspace."
        body = body_of(ARCH, {"Guardrails": ["- (unconfirmed) " + mixed[2:], fake]})
        out, c = guards.settled_restatements_body(ARCH, guards.settled_body(ARCH, body, "", idx)[0], "", idx, pol)
        self.assertIn("- (unconfirmed) " + mixed[2:], bullets(out, "Guardrails"))
        self.assertNotIn("settled_contested_dropped", c)


class R10PassiveOrderTests(unittest.TestCase):
    def test_facts_schedules_and_orders_to_nic_are_not_agent_orders(self):
        for s in ("- The bridge turned out to be installed twice", "- The runner used to be installed on the C drive before the move",
                  "- The model server appears to be installed on the D drive", "- The speech engine seems to be installed twice",
                  "- Notes were found to be synced to the old drive", "- The voice engine is expected to be installed with the app",
                  "- The index is scheduled to be updated nightly", "- The models are known to be moved to the E drive",
                  "- Index needs to be updated each night", "- Scrolls should be synced daily",
                  "- Trashed mail should be moved to a review label for Nic.", "- Drafts are to be sent by Nic."):
            self.assertIsNone(guards.imperative_kind(s), s)
        for s in ("- The helper MCP entry must be repointed by hand", "- The old cache needs to be deleted", "- Legacy notes are to be backed up to the spare disk",
                  "- **Index path update:** The helper MCP entry still names the old store file; must be repointed manually."):
            self.assertEqual(guards.imperative_kind(s), "agent_action", s)
        # A standing rule addressed to Nic stays where it is (no "(needs Nic's approval)" to-do).
        rule = "- Drafts are to be sent by Nic."
        body = body_of(PROJ, {"Locked Decisions": [rule]})
        self.assertEqual(guards.imperatives_body(PROJ, body), (body, Counter()))
        fact = "- The bridge turned out to be renamed by the updater."
        body = body_of(ARCH, {"Guardrails": [fact]})
        self.assertEqual(guards.imperatives_body(ARCH, body), (body, Counter()), "a lesson / fact is never dropped")

    def test_plan_rules_and_adjectives_need_no_approval(self):
        for s in ("- Planned: archive every source; nothing is ever deleted", "- Planned: curated seed sources only",
                  "- Planned: prune old folders only after Nic approves"):
            self.assertFalse(guards.plan_needs_approval(s), s)
        for s in ("- Planned: Local model folder curation (E drive).", "- Planned: curate the model folder", "- Planned: Prune the old skill folders"):
            self.assertTrue(guards.plan_needs_approval(s), s)


class R10RestatementTests(unittest.TestCase):
    def test_an_exception_on_another_object_or_an_extra_fact_is_kept(self):
        rules = "Never change rules or identity files."
        self.assertFalse(guards.settled_restatement(rules, "Never change MCP config files without Nic's approval."))
        self.assertFalse(guards.settled_restatement("Never send anything. No emails or posts. Drafts only.", "Never send emails to clients without approval."))
        install = "Never install a new skill, MCP or package without Nic's approval. Propose it through the Librarian."
        self.assertFalse(guards.settled_restatement(install, "Never install MCP servers from unofficial sources unless Nic approves."))
        self.assertFalse(guards.settled_restatement("Never send anything. No emails or posts. Drafts only.",
                                                    "Never send emails or posts without Nic's approval; the chat bridge is read-only and the notifier posts to a private chat only."))
        models = "Never commit model files (.gguf, .safetensors) to Git."
        self.assertFalse(guards.settled_restatement(models, "Never commit model files (.gguf, .safetensors) to Git; models live on E:\\models."))
        self.assertTrue(guards.settled_restatement(models, "NEVER commit model files (.gguf, .safetensors) to Git."))
        # The weakened restatements of round 8 still go.
        self.assertTrue(guards.settled_restatement("Never spend money, sign up for anything, or accept terms.",
                                                   "NEVER spend money, sign up, or accept terms without explicit approval."))
        self.assertTrue(guards.settled_restatement("Never send anything. No emails or posts. Drafts only.", "NEVER send emails or posts unless Nic approves."))
        self.assertTrue(guards.settled_restatement(install, "- NEVER install new skills/MCPs/packages without Librarian approval."[2:]))

    def test_body_keeps_them_and_is_a_fixed_point(self):
        never = NEVER_V6 + "5. Never commit model files (.gguf, .safetensors) to Git.\n"
        idx = guards.PlanIndex([], [], None, guards.settled_items(never))
        pol = stc.default_policy()
        keep = ["- Never change MCP config files without Nic's approval.", "- Never send emails to clients without approval.",
                "- Never commit model files (.gguf, .safetensors) to Git; models live on E:\\models."]
        weak = "- NEVER spend money, sign up, or accept terms without explicit approval."
        out, c = guards.content_body(ARCH, body_of(ARCH, {"Guardrails": keep + [weak]}), "", idx, policy=pol)
        g = bullets(out, "Guardrails")
        for k in keep:
            self.assertIn(k, g)
        self.assertNotIn(weak, g)
        self.assertEqual(c["settled_restatement_dropped"], 1)
        self.assertNotIn("duplicate_dropped", c, "dedupe keeps a bullet naming a path the other does not")
        self.assertEqual(guards.content_body(ARCH, out, "", idx, policy=pol)[1], Counter(), "a fixed point")
        self.assertEqual(guards.check_preview(ARCH, out, [], "", pol, idx), Counter())


class R10KgScopeSuffixTests(unittest.TestCase):
    def test_a_scope_renamed_path_entity_is_typed_and_probed_like_before(self):
        idx = guards.PlanIndex([], [])
        idx.probe = lambda tok: False  # every path is missing (a scope label probed as part of it would be too)
        for name in ("cfg.json", "data\\cache"):
            ents, c = guards.content_entities([{"name": name, "entityType": "path", "observations": ["Holds the mode list"]}], idx)
            self.assertEqual(ents[0]["observations"], ["(planned, not created yet) Holds the mode list"], name)
            renamed = [{**ents[0], "name": f"{name} (Agentic OS)"}]
            self.assertEqual(guards.content_entities(renamed, idx), (renamed, Counter()), "the cross-target rename is still a fixed point")
        # A name the target's probe cannot answer (None) is not "planned" with its scope label either.
        idx.probe = lambda tok: None if tok == "data\\cache" else False
        ents, c = guards.content_entities([{"name": "data\\cache", "entityType": "path", "observations": ["Holds the mode list"]}], idx)
        self.assertEqual((ents[0]["observations"], c), (["Holds the mode list"], Counter()))
        renamed = [{**ents[0], "name": "data\\cache (Agentic OS)"}]
        self.assertEqual(guards.content_entities(renamed, idx), (renamed, Counter()))
        self.assertEqual(guards.kg_base_name("cfg.json (Agentic OS)"), "cfg.json")
        self.assertEqual(guards.kg_base_name("Hostbox (Agentic OS)"), "Hostbox (Agentic OS)", "not path-like: unchanged")
        ents, c = guards.content_entities([{"name": "Hostbox (Agentic OS)", "entityType": "path", "observations": ["Runs the model server"]}], idx)
        self.assertEqual((ents[0]["entityType"], c), ("concept", Counter({"path_type_retyped": 1})))


if __name__ == "__main__":
    unittest.main()
