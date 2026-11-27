"""Memory Scrolls round 11: review of the guards-v7 detectors, guards v8 (synthetic data only).

The review of the v7 code (round 10, part 2) found that the new detectors were both too broad and too narrow:

1. `rule_file_pending` flagged any sentence with a rule / identity / prompt file and a change word anywhere
   (role descriptions, governance and process rules, settled recipes and descriptive KG facts were dropped or
   turned into to-dos), yet missed negated completions, approval-gated pending and draft / create orders. v8
   asks for a PENDING marker next to a LIFECYCLE word in any slot, so the to-do is caught in any grammatical
   form and a fact is not; a plan line about such a file is approval-gated in one pass (`rule_file_plan`).
2. `built_plans_body` turned real planned work into Active State facts whenever the verb's object started with
   an existing repo path or a store name; v8 moves only a plan whose whole object is a store the code creates.
3. `path_probe` called any missing store file "(created on first use)" when its base name was quoted anywhere in
   repo code; v8 counts only a bare name or an app-config-dir file the Command Center joins onto its own dir.
4. `pending_fixes_body` moved applied preventive fixes ("Check ... before ...; avoids ...") to Failure Modes.

Run with: python3 tests/run_all.py
"""

from __future__ import annotations

import re
import sys
import unittest
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
sys.path.insert(0, str(REPO))
sys.path.insert(0, str(HERE))

from memory_scrolls import guards, offload  # noqa: E402
from memory_scrolls import scroll as sc  # noqa: E402
from test_memory_scrolls import Sandbox, section_reply  # noqa: E402
from test_memory_scrolls import setUpModule, tearDownModule  # noqa: E402,F401
from test_memory_scrolls_curated import ARCH, HUBP, IDENT, LESS, PROJ  # noqa: E402

APPROVAL = guards.NEEDS_APPROVAL


def body_of(t: sc.Target, sections: dict) -> str:
    return section_reply(t.rel, sections)["updated_markdown"]


def bullets(body: str, head: str) -> list:
    return sc.section_bullets(body, [head])


# ── 1. rule / identity / prompt file to-dos: pending + lifecycle, in any slot ──

# Wordings the v7 detector missed (negated completions, approval-gated pending, draft / create orders, states).
MISSED_BY_V7 = (
    "- MASTER_IDENTITY v1 and AGENTS_NEVER not reviewed or locked yet.",
    "- MASTER_IDENTITY.md is not locked; AGENTS_NEVER.md is not final.",
    "- Conceptualizer and Dispatcher prompts not written yet.",
    "- MASTER_IDENTITY v1 lock waits for the operator's approval.",
    "- AGENTS_NEVER.md final review: the operator can do it this week.",
    "- Conceptualizer and Dispatcher prompts are missing.",
    "- Conceptualizer and Dispatcher prompts pending.",
    "- Draft the Dispatcher and Conceptualizer prompts in the studio.",
    "- Create Conceptualizer and Dispatcher prompt.md files.",
    "- MASTER_IDENTITY v1 hasn't been locked.",
    "- MASTER_IDENTITY v1 is unreviewed.",
    "- MASTER_IDENTITY v1 is being reviewed.",
    "- Ratify constitution.md.",
    "- Polish CLAUDE.md.",
    "- Add a rule to AGENTS_NEVER.md.",
    "- Fill in the Dispatcher prompt.",
    "- Finish the Dispatcher prompt.",
    "- Dispatcher system prompt is a stub.",
    "- MASTER_IDENTITY still marked draft.",
    "- Final review of MASTER_IDENTITY.md is the next step.",
    "- Dispatcher and Conceptualizer prompts: not started.",
)
KG_MISSED_BY_V7 = (("Dispatcher", "Prompt not written yet"), ("Dispatcher", "Prompt missing"),
                   ("MASTER_IDENTITY", "Not reviewed yet"), ("MASTER_IDENTITY", "Still not locked"))
# Facts and rules the v7 detector dropped or turned into to-dos.
SETTLED_RECIPES = ("- Agents must check MASTER_IDENTITY.md before writing anything about the operator.",
                   "- Before writing anything about the operator, check MASTER_IDENTITY.md first.",
                   "- Model drift: re-read GEMINI.md before writing code.",
                   "- Tool-call looping: the system prompt must include the tool schemas and nothing else.",
                   "- Coder looping: keep the system prompt short and review it when the model changes.")
ROLE_DESCRIPTIONS = ("- The Librarian reviews system prompts.", "- The Prompter writes system prompts.", "- Prompter writes agent prompts.",
                     "- The gateway rewrites system prompts at dispatch.", "- The Librarian locks AGENTS_NEVER after review.")
GOVERNANCE = ("- Rule changes need the operator's sign-off.", "- Identity file changes must be reviewed by the operator.",
              "- AGENTS.md edits require the operator's OK.", "- System prompt changes should be logged in the audit trail.",
              "- Config changes must be reviewed before merge.", "- Prompt changes should be small and reversible.",
              "- Edits to MASTER_IDENTITY.md need a version bump.", "- Open questions go to the Prompter, who rewrites prompts.",
              "- The rules engine is in progress.", "- Decision rule: if something isn't written here, ask.")
KG_FACTS = (("AGENTS_NEVER.md", "Hard rules every agent follows; forbids writing outside the repo"),
            ("AGENTS_NEVER.md", "Agents must review diffs before writing"),
            ("MASTER_IDENTITY.md", "Defines the operator's voice and the review workflow"),
            ("MASTER_IDENTITY.md", "Agents must check it before writing anything about the operator"),
            ("Prompter", "Writes system prompts"), ("Prompter", "Drafts agent prompts"),
            ("Librarian", "Reviews system prompts and locks them"), ("Gateway", "Rewrites system prompts at dispatch"))


class PendingLifecycleTests(unittest.TestCase):
    def test_missed_wordings_are_todos(self):
        for s in MISSED_BY_V7:
            self.assertEqual(guards.imperative_kind(s), "rule_file_edit", s)
        for name, o in KG_MISSED_BY_V7:
            self.assertEqual(guards.imperative_kind(o, name), "rule_file_edit", (name, o))

    def test_facts_rules_and_roles_are_not_todos(self):
        for s in SETTLED_RECIPES + ROLE_DESCRIPTIONS + GOVERNANCE:
            self.assertIsNone(guards.imperative_kind(s), s)
        for name, o in KG_FACTS:
            self.assertIsNone(guards.imperative_kind(o, name), (name, o))

    def test_project_marks_the_missed_wordings(self):
        lines = list(MISSED_BY_V7[:4])
        body = body_of(HUBP, {"Current Milestone": [lines[0]], "Active State": lines[1:] + ["- Gateway on :8080."]})
        out, c = guards.imperatives_body(HUBP, body)
        self.assertEqual(bullets(out, "Active State"), ["- Gateway on :8080."])
        self.assertEqual(bullets(out, "Open Threads"), [f"- {APPROVAL} {x[2:]}" for x in lines])
        self.assertEqual(c, Counter({"imperative_moved": 4}))
        self.assertEqual(guards.content_body(HUBP, out, "")[1], Counter(), "a fixed point")
        self.assertEqual(guards.check_preview(HUBP, body, [], "").get("content_imperative_moved"), 4, "unmarked: --apply refuses")

    def test_kg_drops_the_missed_wordings_and_keeps_facts(self):
        ents = [{"name": n, "entityType": "concept", "observations": [o, "Part of the foundation goal."]} for n, o in KG_MISSED_BY_V7 + KG_FACTS]
        out, c = guards.content_entities(ents)
        kept = [o for e in out for o in e["observations"]]
        self.assertEqual(c, Counter({"imperative_kg": len(KG_MISSED_BY_V7)}))
        for _, o in KG_FACTS:
            self.assertIn(o, kept)
        self.assertEqual(guards.content_entities(out), (out, Counter()), "a fixed point")

    def test_settled_recipes_and_rules_stay_in_every_scroll(self):
        cases = ((LESS, {"Proven Recipes": list(SETTLED_RECIPES[:2]), "Fixes": list(SETTLED_RECIPES[2:])}),
                 (IDENT, {"Standing Rules": list(SETTLED_RECIPES[:2]) + list(GOVERNANCE[:2])}),
                 (ARCH, {"Guardrails": list(ROLE_DESCRIPTIONS) + list(GOVERNANCE[2:7])}),
                 (PROJ, {"Locked Decisions": [SETTLED_RECIPES[0], ROLE_DESCRIPTIONS[0]], "Active State": [GOVERNANCE[0]]}))
        for t, sections in cases:
            body = body_of(t, sections)
            out, c = guards.imperatives_body(t, body)
            self.assertEqual((out, c), (body, Counter()), t.rel)
            for head, lines in sections.items():
                self.assertEqual(bullets(out, head), lines, (t.rel, head))

    def test_a_roadmap_line_about_the_rule_files_is_gated_in_one_pass(self):
        # The model states a roadmap goal under the milestone; imperatives_body gates it before plans_body
        # adds "Planned:", so the result is a fixed point (v7 needed a second pass: --apply refused it).
        idx = guards.PlanIndex(["- Planned: Hub backed up twice", "- Planned: MASTER_IDENTITY v1 and AGENTS_NEVER reviewed"], ["- Gateway on :8080"])
        body = body_of(HUBP, {"Current Milestone": ["- MASTER_IDENTITY v1 and AGENTS_NEVER reviewed"], "Active State": ["- Gateway on :8080."]})
        out, c = guards.content_body(HUBP, body, "", idx)
        self.assertEqual(bullets(out, "Current Milestone"), [])
        self.assertEqual(bullets(out, "Open Threads"), [f"- Planned: {APPROVAL} MASTER_IDENTITY v1 and AGENTS_NEVER reviewed"])
        self.assertEqual(guards.content_body(HUBP, out, "", idx)[1], Counter(), "a fixed point")
        self.assertEqual(guards.check_preview(HUBP, out, [], "", None, idx), Counter())
        self.assertTrue(guards.rule_file_plan("- Planned: Conceptualizer and Dispatcher prompts written but not yet tested."))
        self.assertFalse(guards.rule_file_plan("- Planned: Agents queue questions, the operator answers, Librarian files rules."))
        self.assertFalse(guards.rule_file_plan("- Planned: Never change rules or identity files."))


# ── 2. built plans: only the store itself ────────────────────────────────────


def probe(tok: str):
    """Synthetic probe: cards.db is created on first use, plan.db is missing, everything else exists."""
    name = re.split(r"[\\/]", tok.strip("`"))[-1].lower()
    return guards.FIRST_USE if name == "cards.db" else False if name == "plan.db" else True


def probe_idx() -> guards.PlanIndex:
    idx = guards.PlanIndex([], [])
    idx.probe = probe
    return idx


class BuiltPlansTests(unittest.TestCase):
    def test_work_on_an_existing_path_or_a_store_feature_stays_a_plan(self):
        idx = probe_idx()
        plans = ["- Planned: Build `pkg/guards.py` v8 rule-file detector.", "- Write `docs/REPORT.md` section 9 for the next round.",
                 "- Add `src/tasks` retry queue.", "- Planned: Add `server.py` auth middleware for the dashboard.",
                 "- Implement `cards.db` (created on first use) schema validation and migration to v2.",
                 "- Planned: Add `cards.db` (created on first use) retry queue column.",
                 "- Planned: Create `cards.db` (created on first use) for the channel settings."]
        body = body_of(PROJ, {"Active State": ["- Gateway on :8080."], "Open Threads": plans})
        out, c = guards.content_body(PROJ, body, "", idx)
        self.assertEqual(bullets(out, "Open Threads"), plans)
        self.assertEqual(bullets(out, "Active State"), ["- Gateway on :8080."])
        self.assertNotIn("built_plan_moved", c)
        self.assertEqual(guards.check_preview(PROJ, out, [], "", None, idx), Counter())

    def test_the_store_itself_still_moves(self):
        idx = probe_idx()
        body = body_of(PROJ, {"Active State": ["- Gateway on :8080."], "Open Threads": ["- Planned: Implement `cards.db` store in the app dir."]})
        out, c = guards.content_body(PROJ, body, "", idx)
        self.assertEqual(bullets(out, "Active State"), ["- Gateway on :8080.", "- `cards.db` (created on first use) store in the app dir."])
        self.assertEqual(c["built_plan_moved"], 1)
        self.assertEqual(guards.content_body(PROJ, out, "", idx)[1], Counter(), "a fixed point")


# ── 3. the first-use probe: a bare name or the app dir, a direct join only ───


class FirstUseProbeTests(unittest.TestCase):
    def test_only_a_direct_join_and_a_bare_or_app_dir_path(self):
        sb = Sandbox(key=None)
        try:
            rs = sb.root / "repo" / "command center" / "src-tauri" / "src" / "commands"
            rs.mkdir(parents=True)
            (rs / "store.rs").write_text(
                'let a = dir.join("cards.db");\nlet b = config_dir.join("config.json");\n'
                'let c = repo.join("data").join("settings.json");\n'
                'let d = base.join("other-app").join("storage").join("otherapp.db");\n'
                'out.push(("label".into(), "listed.json"));\n', encoding="utf-8")
            before = sorted(str(p) for p in sb.root.rglob("*"))
            pr = offload.path_probe(sb.paths(), sb.env, offload.REPO_TARGET)
            self.assertEqual(pr("cards.db"), guards.FIRST_USE)
            self.assertEqual(pr("config.json"), guards.FIRST_USE)
            self.assertEqual(pr("%APPDATA%\\os.agentic.commandcenter\\cards.db"), guards.FIRST_USE)
            for tok in ("settings.json", "otherapp.db", "listed.json", "agents/hermes/config.json", "scheduler/jobs/cards.db", "data/goals/config.json"):
                self.assertIs(pr(tok), False, tok)
            self.assertEqual(sorted(str(p) for p in sb.root.rglob("*")), before, "read-only")
            self.assertEqual(guards.annotate_paths("- Add `agents/hermes/config.json` for the channel settings.", pr, False),
                             "- Add `agents/hermes/config.json` (planned, not created yet) for the channel settings.")
        finally:
            sb.close()

    def test_a_first_use_relabel_is_counted_as_such(self):
        idx = probe_idx()
        body = body_of(PROJ, {"Active State": ["- Rows live in `cards.db`.", "- Archive in `plan.db`."]})
        out, c = guards.paths_body(PROJ, body, "", idx)
        self.assertEqual(c, Counter({"path_first_use": 1, "path_planned": 1}))
        self.assertEqual(guards.paths_body(PROJ, out, "", idx), (out, Counter()))


# ── 4. Lessons ## Fixes: applied preventive fixes stay ───────────────────────


class PreventiveFixesTests(unittest.TestCase):
    def test_applied_fixes_stay_under_fixes(self):
        fixes = ["- Check that the model server has the model loaded before dispatching; avoids empty replies.",
                 "- Verify the sample rate is 24 kHz before TTS.", "- Debug builds of the voice engine stutter; use --release.",
                 "- Try the 9B model with 32k context for tool calls (stable).", "- Test each tool call against the schema first; prevents loops."]
        todo = "- Rebuild the estimator in small stages after the one-shot build failed."
        body = body_of(LESS, {"Fixes": fixes + [todo], "Failure Modes": ["- The coder model writes text instead of calling tools."]})
        out, c = guards.pending_fixes_body(LESS, body)
        self.assertEqual(bullets(out, "Fixes"), fixes)
        self.assertEqual(bullets(out, "Failure Modes"), ["- The coder model writes text instead of calling tools.", todo])
        self.assertEqual(c, Counter({"pending_fix_moved": 1}))
        self.assertEqual(guards.pending_fixes_body(LESS, out), (out, Counter()), "a fixed point")


if __name__ == "__main__":
    unittest.main()
