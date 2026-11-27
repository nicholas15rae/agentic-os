"""Memory Scrolls round 10, part 2: review fixes of preview 20261120-021616, guards v7 (synthetic data only).

The booking-scope lens blocked 20261120-021616 because the local model reworded a hub to-do about the rule /
identity files as a noun phrase ("need review/fix before final lock", "prompts pending write") that the
grammar-based detector missed. Fixes, each with unit tests (and a fixed-point check) here and an end-to-end
dry-run + `--apply` replay of the r9 shapes in `R9ShapesV7Tests`:

1. `rule_file_pending`: a rule / identity / prompt file plus any change or pending word, in any wording, is a
   "(needs Nic's approval)" to-do; a KG observation is read with its entity name;
2. a store file the repo code creates on first use is "(created on first use)", a plan to build one is a fact,
   and the planned marker is never doubled;
3. a deictic ("from here") tool / service KG observation that the source gives to another entity goes;
4. a pending to-do under Lessons ## Fixes moves to ## Failure Modes.

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
import test_memory_scrolls_fidelity as fid  # noqa: E402  (module imports: their TestCases are not collected twice)
import test_memory_scrolls_v6 as v6  # noqa: E402

APPROVAL = guards.NEEDS_APPROVAL


def body_of(t: sc.Target, sections: dict) -> str:
    return section_reply(t.rel, sections)["updated_markdown"]


def bullets(body: str, head: str) -> list:
    return sc.section_bullets(body, [head])


# ── 1. rule / identity / prompt file to-dos in any wording ───────────────────

# The exact r9 lines (20261120-021616), the r7 imperative and r8 passive forms of the same hub to-do, and
# paraphrases the model has not produced yet.
R9_LINES = ("- MASTER_IDENTITY.md and AGENTS_NEVER.md need review/fix before final lock.",
            "- Planned: Conceptualizer and Dispatcher prompts pending write.")
R7_R8_LINES = ("- Planned: Read MASTER_IDENTITY.md and AGENTS_NEVER.md, fix anything wrong, then lock v1.",
               "- Planned: Write Conceptualizer and Dispatcher prompts.",
               "- Planned: MASTER_IDENTITY v1 and AGENTS_NEVER reviewed and locked.",
               "- MASTER_IDENTITY.md must be reviewed and locked.",
               "- AGENTS_NEVER.md needs to be fixed before v1.")
PARAPHRASES = ("- AGENTS_NEVER: awaiting fixes", "- identity file lock still open", "- prompt drafts outstanding",
               "- System prompts: rewrite pending for the Dispatcher", "- Next step: finalize the persona file",
               "- CLAUDE.md to be updated after review", "- SYSTEM.md revision TBD", "- Constitution v1 not yet locked",
               "- GEMINI.md edits queued", "- Dispatcher prompt needs an update", "- Prompt pending write for each agent",
               "- Rules: changes pending", "- MASTER_IDENTITY (needs review)", "- Identity docs: final lock is the next step")
# Rules ABOUT changing such files, settled host copies, and plain or completed facts: never to-dos.
NOT_TODOS = ("- Never change rules or identity files.", "- Never change rules or identity files. Only the Librarian, with Nic's approval.",
             "- Never make anything up about Nic. If it isn't in MASTER_IDENTITY.md, ask.", "- Agents must not edit AGENTS.md.",
             "- NEVER put keys or tokens in prompts.", "- MASTER_IDENTITY v1 was locked on 2026-11-02.", "- MASTER_IDENTITY v1 is locked.",
             "- Prompts written for all five agents.", "- Identity files can only be changed by Nic.",
             "- (unconfirmed) Librarian is the ONLY agent authorized to write rules; requires Nic's approval per change.",
             "- (unconfirmed) Commits one change per rule", "- Every approved rule change results in exactly one Git commit.",
             "- Models: the local server serves the model; desktop workspaces hold agent prompts.",
             "- The local model needs a system prompt with tool schemas.", "- Rules file needed an update to stop the looping.",
             "- Fixed the coder looping by editing the rules file.", "- Identity file was updated and still works.",
             "- Routing rules: changes mirror to the gateway.", "- Config must be updated atomically (tmp + rename).",
             "- Prompt updates go through the Librarian.", "- Overlay never injects prompt text.",
             "- Planned: Agents queue questions, Nic answers, Librarian files rules.", "- Agents: `agents/<name>/` (prompt.md, rules.md, card.md).",
             # Role and behaviour descriptions that use the same words.
             "- The Prompter rewrites rough ideas into a structured prompt.", "- Identity: practical; changes his mind when shown data.",
             "- Core persona: direct, edits ruthlessly.", "- The front agent rewrites the prompt for the coder.")


class RuleFilePendingTests(unittest.TestCase):
    def test_any_wording_is_a_rule_file_todo(self):
        for s in R9_LINES + R7_R8_LINES + PARAPHRASES:
            self.assertEqual(guards.imperative_kind(s), "rule_file_edit", s)
        for s in NOT_TODOS:
            self.assertIsNone(guards.imperative_kind(s), s)
        for s in R9_LINES + PARAPHRASES:
            self.assertTrue(guards.rule_file_pending(s), s)
        self.assertFalse(guards.rule_file_pending("- MASTER_IDENTITY v1 was locked on 2026-11-02."), "a pure completion fact")

    def test_kg_observations_are_read_with_their_entity_name(self):
        obs = "Needs review/fix before final lock."
        self.assertIsNone(guards.imperative_kind(obs), "alone it names no file")
        self.assertEqual(guards.imperative_kind(obs, "MASTER_IDENTITY"), "rule_file_edit")
        ents = [{"name": "MASTER_IDENTITY", "entityType": "project", "observations": ["Part of the foundation goal.", obs]},
                {"name": "AGENTS_NEVER", "entityType": "project", "observations": ["Part of the foundation goal.", obs, "Version 1 locked on 2026-11-02."]},
                {"name": "Conceptualizer", "entityType": "project", "observations": ["Prompt pending write (core agents phase).", "Part of the voice-to-idea pipeline."]},
                {"name": "Dispatcher", "entityType": "project", "observations": ["Prompt pending write (core agents phase)."]},
                {"name": "Viewer app", "entityType": "project", "observations": ["Needs review/fix before final lock."]}]
        out, c = guards.content_entities(ents)
        got = {e["name"]: e["observations"] for e in out}
        self.assertEqual(got["MASTER_IDENTITY"], ["Part of the foundation goal."])
        self.assertEqual(got["AGENTS_NEVER"], ["Part of the foundation goal.", "Version 1 locked on 2026-11-02."], "a completion fact stays")
        self.assertEqual(got["Conceptualizer"], ["Part of the voice-to-idea pipeline."])
        self.assertNotIn("Dispatcher", got, "its only observation was the to-do")
        self.assertEqual(got["Viewer app"], ["Needs review/fix before final lock."], "not a rule / identity / prompt file")
        self.assertEqual(c, Counter({"imperative_kg": 4}))
        self.assertEqual(guards.content_entities(out), (out, Counter()), "a fixed point")
        # check_preview uses the same detector: the unmarked observations refuse --apply.
        self.assertEqual(guards.check_preview(HUBP, body_of(HUBP, {}), ents, "").get("content_imperative_kg"), 4)

    def test_project_marks_and_moves_never_locks(self):
        body = body_of(HUBP, {"Locked Decisions": ["- Identity file lock still open."], "Active State": [R9_LINES[0], "- Gateway on :8080."],
                              "Open Threads": [R9_LINES[1], f"- {APPROVAL} Planned: MASTER_IDENTITY v1 and AGENTS_NEVER reviewed and locked."]})
        out, c = guards.imperatives_body(HUBP, body)
        self.assertEqual(bullets(out, "Locked Decisions"), [])
        self.assertEqual(bullets(out, "Active State"), ["- Gateway on :8080."])
        self.assertEqual(bullets(out, "Open Threads"), [
            f"- {APPROVAL} Planned: Conceptualizer and Dispatcher prompts pending write.",
            f"- {APPROVAL} Planned: MASTER_IDENTITY v1 and AGENTS_NEVER reviewed and locked.",
            f"- {APPROVAL} Identity file lock still open.",
            f"- {APPROVAL} MASTER_IDENTITY.md and AGENTS_NEVER.md need review/fix before final lock."])
        self.assertEqual(c, Counter({"imperative_moved": 2, "imperative_marked": 1}))
        self.assertEqual(guards.imperatives_body(HUBP, out), (out, Counter()), "marked lines are fixed points")
        self.assertEqual(guards.content_body(HUBP, out, "")[1], Counter(), "the whole guard set agrees")
        self.assertEqual(guards.check_preview(HUBP, out, [], ""), Counter())
        left = guards.check_preview(HUBP, body, [], "")
        self.assertEqual((left["content_imperative_moved"], left["content_imperative_marked"]), (2, 1), "an unmarked to-do refuses --apply")

    def test_other_scrolls_drop_it(self):
        for t, head in ((ARCH, "Guardrails"), (IDENT, "Identity"), (LESS, "Fixes")):
            body = body_of(t, {head: [R9_LINES[0], "- Prompt drafts outstanding.", "- Never change rules or identity files."]})
            out, c = guards.imperatives_body(t, body)
            self.assertEqual(bullets(out, head), ["- Never change rules or identity files."], t.rel)
            self.assertEqual(c, Counter({"imperative_dropped": 2}), t.rel)
        # A current scroll line is never touched.
        body = body_of(ARCH, {"Guardrails": [R9_LINES[0]]})
        self.assertEqual(guards.imperatives_body(ARCH, body, body), (body, Counter()))

    def test_settled_host_copies_are_rules(self):
        never = v6.NEVER_V6 + "5. Never edit agent prompts yourself. Prompt changes are pending Nic's review.\n"
        idx = guards.PlanIndex([], [], None, guards.settled_items(never))
        pol = stc.default_policy()
        out, c = guards.content_body(ARCH, body_of(ARCH, {"Guardrails": ["- Gateway binds to localhost only."]}), "", idx, policy=pol)
        host = "- Never edit agent prompts yourself. Prompt changes are pending Nic's review."
        self.assertIn(host, bullets(out, "Guardrails"))
        self.assertNotIn("imperative_dropped", c)
        self.assertEqual(guards.content_body(ARCH, out, "", idx, policy=pol)[1], Counter(), "a fixed point")
        self.assertEqual(guards.check_preview(ARCH, out, [], "", pol, idx), Counter())


# ── 2. store files created on first use, built plans, one marker ─────────────


def store_probe(tok: str):
    """Synthetic probe: cards.db is created by the repo code on first use, plan.db is missing, the rest exist."""
    name = re.split(r"[\\/]", tok.strip("`"))[-1].lower()
    if name == "cards.db":
        return guards.FIRST_USE
    if name == "plan.db":
        return False
    return True


def probe_idx(plans=(), status=()) -> guards.PlanIndex:
    idx = guards.PlanIndex(list(plans), list(status))
    idx.probe = store_probe
    return idx


class FirstUseStoreTests(unittest.TestCase):
    def test_probe_reads_the_repo_code_read_only(self):
        sb = Sandbox(key=None)
        try:
            rs = sb.root / "repo" / "command center" / "src-tauri" / "src" / "commands"
            rs.mkdir(parents=True)
            (rs / "cards.rs").write_text('let path = dir.join("cards.db");\n#[cfg(test)]\nmod tests { const F: &str = "fixture.db"; }\n', encoding="utf-8")
            (rs / "tests.rs").write_text('const X: &str = "other-fixture.json";\n', encoding="utf-8")
            pkg = sb.root / "repo" / "memory_scrolls"
            pkg.mkdir()
            (pkg / "ledger.py").write_text('LEDGER = "ledger.json"\n', encoding="utf-8")
            before = sorted(str(p) for p in sb.root.rglob("*"))
            probe = offload.path_probe(sb.paths(), sb.env, offload.REPO_TARGET)
            self.assertEqual(probe("cards.db"), guards.FIRST_USE)
            self.assertEqual(probe("%APPDATA%\\os.agentic.commandcenter\\cards.db"), guards.FIRST_USE)
            # v8: the Memory Scrolls package is no store source, and a repo path with folders is planned
            # whatever its base name.
            self.assertIs(probe("ledger.json"), False)
            self.assertIs(probe("agents/hermes/cards.db"), False)
            for tok in ("fixture.db", "other-fixture.json", "plan.db"):
                self.assertIs(probe(tok), False, tok)
            self.assertIsNone(probe("staging/memory-scrolls-preview/<stamp>/report.json"), "own outputs stay None")
            self.assertEqual(sorted(str(p) for p in sb.root.rglob("*")), before, "read-only")
            store = sb.root / "appdata" / "os.agentic.commandcenter"
            store.mkdir(parents=True)
            (store / "cards.db").write_bytes(b"")
            self.assertIs(offload.path_probe(sb.paths(), sb.env, offload.REPO_TARGET)("cards.db"), True, "once created it exists")
        finally:
            sb.close()

    def test_annotation_never_doubles(self):
        cases = {
            "- Shared store (`cards.db` planned).": "- Shared store (`cards.db` (created on first use)).",
            "- **Storage:** `cards.db` (planned) in the app dir.": "- **Storage:** `cards.db` (created on first use) in the app dir.",
            "- Reads `cards.db` (planned, not created yet) (SELECT only).": "- Reads `cards.db` (created on first use) (SELECT only).",
            "- Shared store (`plan.db` planned).": "- Shared store (`plan.db` (planned, not created yet)).",
            "- `plan.db` (planned) in the app dir.": "- `plan.db` (planned, not created yet) in the app dir.",
            "- `plan.db` (planned, not created yet) (planned) in the app dir.": "- `plan.db` (planned, not created yet) in the app dir.",
            "- Store (`plan.db` (planned, not created yet) planned).": "- Store (`plan.db` (planned, not created yet)).",
            "- `plan.db` holds rows.": "- `plan.db` (planned, not created yet) holds rows.",
            "- `cards.db` holds rows.": "- `cards.db` (created on first use) holds rows.",
            "- `plan.db` planned for the next phase.": "- `plan.db` (planned, not created yet) planned for the next phase.",
        }
        for src, want in cases.items():
            got = guards.annotate_paths(src, store_probe, False)
            self.assertEqual(got, want, src)
            self.assertIsNone(guards.annotate_paths(got, store_probe, False), f"a fixed point: {got}")
            self.assertNotRegex(got, r"\(planned, not created yet\)\)? \(?planned\)?(?!\s+for)", src)
        self.assertIsNone(guards.annotate_paths("- `cards.db` (created on first use) holds rows.", lambda t: False, False), "never removed")
        self.assertIsNone(guards.annotate_paths("- `os.json` holds settings.", store_probe, False))

    def test_kg_first_use(self):
        idx = probe_idx()
        ents = [{"name": "cards.db", "entityType": "path", "observations": ["Shared store of task cards", "(planned, not created yet) Rows are size-capped"]},
                {"name": "plan.db", "entityType": "path", "observations": ["Planned archive store"]},
                {"name": "Store", "entityType": "concept", "observations": ["Rows live in cards.db beside the app"]}]
        out, c = guards.content_entities(ents, idx)
        self.assertEqual(out[0]["observations"], ["(created on first use) Shared store of task cards", "(created on first use) Rows are size-capped"])
        self.assertEqual(out[1]["observations"], ["(planned, not created yet) Planned archive store"])
        self.assertEqual(out[2]["observations"], ["(created on first use) Rows live in cards.db beside the app"])
        self.assertEqual(c, Counter({"path_first_use_kg": 3, "path_planned_kg": 1}))
        self.assertEqual(guards.content_entities(out, idx), (out, Counter()), "a fixed point")

    def test_a_plan_to_build_a_built_store_or_module_is_a_fact(self):
        idx = probe_idx()
        plan = "- Planned: Implement `cards.db` (planned) schema storage beside `os.json` with atomic writes."
        module = "- Planned: Build `src/app.py` gateway routes."
        keep = ["- Planned: Implement `plan.db` archive storage.", "- Planned: Migrate `cards.db` to the new schema.",
                f"- {APPROVAL} Planned: Write `cards.db` rows for the first agent."]
        body = body_of(PROJ, {"Active State": ["- Gateway on :8080."], "Open Threads": [plan, module] + keep})
        out, c = guards.content_body(PROJ, body, "", idx)
        self.assertEqual(bullets(out, "Active State"), ["- Gateway on :8080.", "- `cards.db` (created on first use) schema storage beside `os.json` with atomic writes."])
        # v8 (round 11): an existing module is no proof that the planned work on it is done: it stays a plan.
        self.assertEqual(bullets(out, "Open Threads"), [module, "- Planned: Implement `plan.db` (planned, not created yet) archive storage.",
                                                        "- Planned: Migrate `cards.db` (created on first use) to the new schema.",
                                                        f"- {APPROVAL} Planned: Write `cards.db` (created on first use) rows for the first agent."])
        self.assertEqual(c["built_plan_moved"], 1)
        self.assertEqual(guards.content_body(PROJ, out, "", idx)[1], Counter(), "a fixed point")
        self.assertEqual(guards.check_preview(PROJ, out, [], "", None, idx), Counter())
        # v8: a scroll without ## Active State keeps the plan (never dropped); no probe (chat compaction): untouched.
        bare = "# Agentic OS\n\n## Open Threads\n" + plan + "\n"
        self.assertEqual(guards.built_plans_body(PROJ, bare, "", idx), (bare, Counter()))
        self.assertEqual(guards.built_plans_body(PROJ, body, "", guards.PlanIndex([], [])), (body, Counter()))
        # A restated plan line about a store the code creates is not moved back to the plans.
        idx = probe_idx(plans=["cards.db schema storage beside os.json with atomic writes"])
        fact = "- `cards.db` schema storage beside `os.json` with atomic writes."
        out, c = guards.plans_body(PROJ, body_of(PROJ, {"Active State": [fact]}), "", idx)
        self.assertEqual((bullets(out, "Active State"), c), ([fact], Counter()))


# ── 3. deictic KG observations ───────────────────────────────────────────────


class DeicticKgTests(unittest.TestCase):
    def test_a_place_word_on_the_wrong_entity_goes(self):
        idx = guards.PlanIndex([], ["Viewer: latest UI pushed from Hostbox, running on Laptopbox", "Model server on Hostbox, port 9999"])
        ents = [{"name": "Model Server", "entityType": "tool", "observations": ["Serves the local model on port 9999", "Viewer UI pushed from here."]},
                {"name": "Hostbox", "entityType": "service", "observations": ["Viewer UI pushed from here.", "Runs the model server"]},
                {"name": "Viewer notes", "entityType": "concept", "observations": ["Viewer UI pushed from here."]},
                {"name": "Laptopbox", "entityType": "service", "observations": ["Runs on this machine only"]}]
        out, c = guards.content_entities(ents, idx)
        got = {e["name"]: e["observations"] for e in out}
        self.assertEqual(got["Model Server"], ["Serves the local model on port 9999"], "the source gives the push to Hostbox")
        self.assertEqual(got["Hostbox"], ents[1]["observations"], "the source line names it")
        self.assertEqual(got["Viewer notes"], ents[2]["observations"], "not a tool / service")
        self.assertNotIn("Laptopbox", got, "nothing but the place word")
        self.assertEqual(c, Counter({"deictic_kg": 2}))
        self.assertEqual(guards.content_entities(out, idx), (out, Counter()), "a fixed point")
        self.assertEqual(guards.content_entities(ents[:1], None), (ents[:1], Counter()), "no source lines (chat compaction): never judged")
        self.assertEqual(guards.check_preview(ARCH, body_of(ARCH, {}), ents[:1], "", None, idx).get("content_deictic_kg"), 1)


# ── 4. pending to-dos under Lessons ## Fixes ─────────────────────────────────


class PendingFixesTests(unittest.TestCase):
    def test_todos_move_to_failure_modes(self):
        todo = ["- Rebuild the estimator in small stages after the one-shot build failed (looped).",
                "- Test the voice engine with the coder first to verify the sample rate or model file."]
        fixes = ["- Lowered the sample rate to 24 kHz; voice no longer muffled.", "- Retest after the update: the patch fixed the crash.",
                 "- Use port 9999 for the model server."]
        body = body_of(LESS, {"Fixes": todo + fixes, "Failure Modes": ["- The coder model writes text instead of calling tools."],
                              "Proven Recipes": ["- Test each step before the next."]})
        out, c = guards.content_body(LESS, body, "")
        self.assertEqual(bullets(out, "Fixes"), fixes)
        self.assertEqual(bullets(out, "Failure Modes"), ["- The coder model writes text instead of calling tools."] + todo)
        self.assertEqual(bullets(out, "Proven Recipes"), ["- Test each step before the next."], "never touched")
        self.assertEqual(c["pending_fix_moved"], 2)
        self.assertEqual(guards.content_body(LESS, out, "")[1], Counter(), "a fixed point")
        self.assertEqual(guards.check_preview(LESS, out, [], ""), Counter())
        self.assertEqual(guards.check_preview(LESS, body, [], "").get("content_pending_fix_moved"), 2)
        # v8: no Failure Modes heading: the bullet stays (never dropped); a current scroll line or another
        # scroll: untouched.
        bare = "# Lessons and Fixes\n\n## Fixes\n" + todo[0] + "\n"
        self.assertEqual(guards.pending_fixes_body(LESS, bare), (bare, Counter()))
        self.assertEqual(guards.pending_fixes_body(LESS, body, body), (body, Counter()))
        proj = body_of(PROJ, {"Active State": [todo[1]]})
        self.assertEqual(guards.pending_fixes_body(PROJ, proj), (proj, Counter()))


# ── end to end: the r9 shapes through dry-run and --apply ────────────────────


MODES_RS = 'pub fn load(dir: &Path) { let path = dir.join("modes.json"); }\npub fn open(dir: &Path) { let db = dir.join("tasks.db"); }\n'
R9_PLAN = "- Planned: Implement `modes.json` (planned) schema storage beside `os.json` with atomic writes."


def r9_shape_reply(messages):
    """The shapes the r9 reviews of 20261120-021616 flagged (synthetic), on top of the r8 and r7 shapes."""
    out = json.loads(v6.r8_shape_reply(messages))
    rel = re.search(r"^TARGET: (\S+)", user_text(messages), re.M).group(1)
    body = out["updated_markdown"]
    ents = list(out.get("graph_entities_to_upsert") or [])
    if rel == HUBP.rel:
        body = body.replace("## Active State\n", f"## Active State\n{R9_LINES[0]}\n").replace("## Open Threads\n", f"## Open Threads\n{R9_LINES[1]}\n")
        ents += [{"name": "MASTER_IDENTITY", "entityType": "project", "observations": ["Part of the foundation goal.", "Needs review/fix before final lock."]},
                 {"name": "Conceptualizer", "entityType": "project", "observations": ["Prompt pending write (core agents phase)."]},
                 {"name": "LM Studio", "entityType": "tool", "observations": ["Viewer UI pushed from here."]}]
    elif rel == PROJ.rel:
        body = body.replace("## Open Threads\n", f"## Open Threads\n{R9_PLAN}\n")
    elif rel == LESS.rel:
        body = body.replace("## Fixes\n", "## Fixes\n- Rebuild the estimator in small stages after the one-shot build failed.\n")
    out["updated_markdown"] = body
    out["graph_entities_to_upsert"] = ents
    return json.dumps(out)


class R9ShapesV7Tests(fid.R7ShapesV5Tests):
    def setUp(self):
        super().setUp()
        rs = self.sb.root / "repo" / "command center" / "src-tauri" / "src" / "commands"
        rs.mkdir(parents=True)
        (rs / "modes.rs").write_text(MODES_RS, encoding="utf-8")
        store = self.sb.root / "appdata" / "os.agentic.commandcenter"
        store.mkdir(parents=True, exist_ok=True)
        (store / "os.json").write_text("{}", encoding="utf-8")  # the app settings file exists; modes.json and tasks.db do not

    def test_preview_is_faithful_and_apply_validates(self):
        pass  # covered by R7ShapesV5Tests (it expects tasks.db planned: no repo code here)

    def test_apply_refuses_merged_conflicting_entities_and_v5_previews(self):
        pass  # covered by R7ShapesV5Tests

    def test_overview_section_is_kept_with_section_one_cut(self):
        pass  # covered by R7ShapesV5Tests

    def _scrolls(self, res):
        prev = Path(res["preview_dir"])
        scrolls = {r["rel"]: sc.parse((prev / "scrolls" / r["rel"]).read_text(encoding="utf-8")).body for r in res["proposed"]["targets"]}
        kg = {e["name"]: e for e in (json.loads(x) for x in (prev / "kg-preview.jsonl").read_text(encoding="utf-8").splitlines() if x.strip())}
        return prev, scrolls, kg

    def test_r9_shapes_are_fixed_and_apply_validates(self):
        res, _, _ = self.dry(FakeLLM([r9_shape_reply] * 64))
        prev, scrolls, kg = self._scrolls(res)
        hub = scrolls[HUBP.rel]
        ot = bullets(hub, "Open Threads")
        self.assertIn(f"- {APPROVAL} " + R9_LINES[0][2:], ot)
        self.assertIn(f"- {APPROVAL} " + R9_LINES[1][2:], ot)
        self.assertFalse([x for x in bullets(hub, "Active State") if "MASTER_IDENTITY" in x], "never an unmarked state")
        self.assertEqual(kg["MASTER_IDENTITY"]["observations"], ["Part of the foundation goal."])
        self.assertNotIn("Conceptualizer", kg)
        self.assertFalse([o for e in kg.values() for o in e["observations"] if "from here" in o], "the deictic observation is gone")
        proj = scrolls[PROJ.rel]
        self.assertIn("- `modes.json` (created on first use) schema storage beside `os.json` with atomic writes.", bullets(proj, "Active State"))
        self.assertNotIn("Implement `modes.json`", proj)
        self.assertIn("tasks.db` (created on first use)", proj)
        self.assertNotIn("planned, not created yet", proj, "both stores are created by the repo code")
        self.assertNotRegex("\n".join(scrolls.values()), r"not created yet\)\)? \(?planned")
        less = scrolls[LESS.rel]
        self.assertIn("- Rebuild the estimator in small stages after the one-shot build failed.", bullets(less, "Failure Modes"))
        self.assertEqual(bullets(less, "Fixes"), [])
        # The r8 shapes stay fixed.
        self.assertIn("- (needs Nic's approval) " + v6.PASSIVE[2:], bullets(proj, "Open Threads"))
        report = json.loads((prev / "report.json").read_text(encoding="utf-8"))
        self.assertEqual(report["guards"]["version"], guards.GUARDS_VERSION)
        code, lines = self.apply(res["token"])
        self.assertEqual(code, 0, lines[-1])

    def test_a_guards_v6_preview_is_refused(self):
        with mock.patch.object(guards, "GUARDS_VERSION", 6):
            res, _, _ = self.dry(FakeLLM([r9_shape_reply] * 64))
        tree = self.sb.tree()
        code, lines = self.apply(res["token"])
        self.assertEqual(code, 2)
        self.assertIn("content-guard version", lines[-1]["error"])
        self.assertEqual(self.sb.tree(), tree, "nothing written")

    def test_an_unmarked_rule_file_todo_is_never_a_fixed_point(self):
        # A preview made without the v7 detector (as the 20261120-021616 dry-run was) but labelled v7: the
        # --apply re-check runs the same function and refuses it.
        with mock.patch.object(guards, "rule_file_pending", lambda text, context="": False):
            res, _, _ = self.dry(FakeLLM([r9_shape_reply] * 64))
        _, scrolls, _ = self._scrolls(res)
        self.assertIn(R9_LINES[0], bullets(scrolls[HUBP.rel], "Active State"), "the r9 shape, unmarked")
        tree = self.sb.tree()
        code, lines = self.apply(res["token"])
        self.assertEqual(code, 2)
        self.assertIn("content_imperative_moved", lines[-1]["error"])
        self.assertEqual(self.sb.tree(), tree, "nothing written")


if __name__ == "__main__":
    unittest.main()
