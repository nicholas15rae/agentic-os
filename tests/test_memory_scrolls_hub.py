"""Memory Scrolls offload: the C:\\ai-hub source (read-only), against a temp hub only.

Deny-list enforced before any open (booking templates, tasks/ email, the messaging bridge, .git,
memory/, tool folders), the hub tree byte-identical after a run, MASTER_IDENTITY first and hinted,
section allow-list, routing, the privacy filter on hub INPUT, never-lock on hub-derived content,
keep-the-accepted-body on a later chunk failure, and provenance in report.json / manifest.json.

Run with: python3 tests/run_all.py
"""

from __future__ import annotations

import builtins
import hashlib
import io
import json
import re
import sys
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
sys.path.insert(0, str(REPO))
sys.path.insert(0, str(HERE))

from memory_scrolls import compact, distill, offload, privacy, privacy_policy  # noqa: E402
from memory_scrolls import scroll as sc  # noqa: E402
from memory_scrolls_stubs import auto_reply, user_text  # noqa: E402
from test_memory_scrolls import NOW_ISO, FakeLLM, Sandbox, setUpModule, tearDownModule  # noqa: E402,F401

# Each excluded category, in a section the allow-list KEEPS: only the input privacy filter stops it.
PERSONAL_LINES = {
    "contact": "- Reach him at zq.sentinel.contact@example.org for scripts",
    "location": "- Nic lives in Sentinelville near the old mill",
    "location_tz": "- Working hours follow America/Sentinel_City time",
    "finance": "- Income target is $9,999 a month from gigs",
    "dob_age": "- Born in 1990 and 36 years old",
    "health": "- Diagnosed with asthma, takes medication daily",
    "family": "- His sister helps out on the weekends",
    "third_party": "- My friend Zed Sentinelson reviews the scripts",
    "life_plans": "- Planning to buy land and build a cabin",
    "personality": "- Personality: introvert who loves structure",
    "creative_gear": "- Records guitar through a Focusrite audio interface",
    "consumer_services": "- Music service: Spotify premium every day",
}
# The value each line must never leak (a word unique to it).
PERSONAL_VALUES = ("zq.sentinel.contact", "Sentinelville", "Sentinel_City", "9,999", "1990", "asthma", "sister", "Sentinelson", "cabin", "introvert", "Focusrite", "Spotify")

IDENTITY = f"""# MASTER_IDENTITY — v1 (draft, lock after Nic reviews)
Rule: if something about Nic isn't written here, ASK. Never guess.

## CORE
- SENTINEL-CORE trait line

## HOW HE DECIDES (worth-it filter)
- Every project gets a finish line.

## VOICE
- No fluff, practical, transparent answers.
{chr(10).join(PERSONAL_LINES.values())}

## VALUES & MONEY
- SENTINEL-MONEY rule

## MODULE: ACTING
### Booking agent rules
- SENTINEL-BOOKRULE line
### Boundaries
- SENTINEL-BOUNDARY line

## MODULE: MUSIC, MEDIA & TECH
### Music, e.g. — not the full list
- SENTINEL-MUSIC line
### Tech, e.g. — not the full list
- Runs local AI on his own machines.
### How agents use this
- Agents are role-specialised versions of him.

## MODULE: EMERGING
### How this works
- New ideas land here first; never nag.
### Current entries, e.g. — will change over time
- SENTINEL-EMERGING entry
"""

CLAUDE_MD = """# Start here

Before doing anything in this repo:
1. Read master/INDEX.md
2. Follow master/AGENTS_NEVER.md at all times
3. Load other files only when the task needs them

When the session ends, update the "Last session" section in master/STATUS.md.
"""

HUB_FILES = {
    "CLAUDE.md": CLAUDE_MD,
    ".clinerules": CLAUDE_MD,  # byte-identical: a duplicate, read once
    "GEMINI.md": "# GEMINI.md — start here\n\nHow Nic works: short plain answers, one step at a time, test each step before the next.\n\nWhen the session ends: update the \"Last session\" section in master/STATUS.md.\n",
    "README.md": "# SENTINEL-README\n",
    "master/MASTER_IDENTITY.md": IDENTITY,
    "master/AGENTS_NEVER.md": "# AGENTS_NEVER — hard rules\n\n## NEVER\n- Never delete files; move them to review instead.\n\n## ALWAYS\n- Update STATUS.md 'Last session' before you stop.\n- End every session by updating \"Last session\" in STATUS.md.\n",
    "master/AGENTS.md": "# AGENTS — the team\n\n## Escalation ladder\n- Local agents first, then Gemini, then Claude for polish.\n\n### Librarian\n- Librarian model: Gemini to start.\n\n### Booking (next to build)\n- SENTINEL-BOOKAGENT line\n",
    "master/SYSTEM.md": "# SYSTEM — machines, tools, layout\n\n## AI stack\n- LM Studio serves models on :1235 only\n",
    "master/INDEX.md": "# MASTER INDEX — read this first\n\n## Rules\n- Read INDEX and STATUS first, load only what you need.\n- protocols/booking-templates.md holds SENTINEL-INDEXBOOK templates\n",
    "master/STATUS.md": "# STATUS — where we left off\n\n## Working\n- Qwen 3.5 9B is the main agent model in LM Studio.\n\n## Config file locations (Mortadella)\n- SENTINEL-CONFIGLOC pointer\n\n## Broken / open\n- Qwen 2.5 Coder emits text instead of tool calls; fix: build in small stages.\n\n## Decisions locked\n- Keys and secrets stay outside the repo.\n\n## Last session\n- SENTINEL-LASTSESSION note\n",
    "master/ROADMAP.md": "# ROADMAP\n\n## Phase 7 — Personal app\n- A Tauri desktop app over the overlay network, later.\n",
    "master/SKILLS.md": "# SKILLS\n- SENTINEL-SKILLS catalog\n",
    "master/handoffs/CURATION_PROMPT.md": "# CURATION\nWHO I AM: SENTINEL-CURATION prose\n",
    "master/handoffs/HANDOFF_CODING.md": "# CODING HANDOFF — paste this\nFill in the brackets, then paste.\n\nPROJECT: [name]\nSENTINEL-TEMPLATE preamble line\n\nHOW NIC WORKS:\n- One step at a time. Small stages. Test each step before the next.\n- Give full-file replacements, never partial line edits.\n\nAT THE END, give me:\n1. What changed (file list)\n2. How to test it\n3. A filled-in \"Last session\" block for STATUS.md\n---\n",
    "protocols/app-build.md": "# App build\n- Build apps in small stages and test each stage.\n",
    # Denied decoys: never opened, never traversed.
    "protocols/booking-templates.md": "SENTINEL-BOOKTPL client list\n",
    "protocols/sentinel-booking-rates.md": "SENTINEL-BOOKRATES\n",
    "tasks/Sentinel-Subject-Line.eml": "SENTINEL-EML body\n",
    "tasks/inbox/a.md": "SENTINEL-TASK\n",
    "whatsapp-mcp/README.md": "SENTINEL-WA\n",
    ".git/notes.md": "SENTINEL-GIT\n",
    "memory/x.md": "SENTINEL-MEM\n",
    "parking-lot/x.md": "SENTINEL-PARK\n",
    "skills-lock.json": "{\"x\": \"SENTINEL-LOCK\"}\n",
    "agents/coder/card.md": "SENTINEL-AGENTCARD\n",
    ".claude/skills/x/SKILL.md": "SENTINEL-CLAUDE\n",
    ".agents/skills/y/SKILL.md": "SENTINEL-AGENTS\n",
    ".impeccable/config.local.json": "{\"SENTINEL-IMP\": 1}\n",
}
DENIED = [rel for rel in HUB_FILES if rel.startswith(("protocols/booking", "protocols/sentinel-booking", "tasks/", "whatsapp-mcp/", ".git/", "memory/", "parking-lot/", "skills-lock", "agents/", ".claude/", ".agents/", ".impeccable/"))]
READ = {"CLAUDE.md", "GEMINI.md", "master/MASTER_IDENTITY.md", "master/AGENTS_NEVER.md", "master/AGENTS.md", "master/SYSTEM.md", "master/INDEX.md", "master/STATUS.md", "master/ROADMAP.md", "master/handoffs/HANDOFF_CODING.md", "protocols/app-build.md"}
SENTINEL = re.compile(r"SENTINEL|Sentinel-Subject", re.I)


def hub_snapshot(root: Path) -> list:
    out = []
    for p in sorted(root.rglob("*")):
        st = p.stat()
        out.append((p.relative_to(root).as_posix(), p.is_dir(), st.st_size, st.st_mtime_ns, hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else None))
    return out


class OpenRecorder:
    """Records every open() of a path under `root` (all modes), via builtins.open and io.open."""

    def __init__(self, root: Path):
        self.root = str(root.resolve()).lower()
        self.opened: list = []
        self._real = builtins.open

    def __call__(self, file, mode="r", *a, **kw):
        try:
            p = str(Path(file).resolve()) if isinstance(file, (str, Path)) else ""
        except (OSError, TypeError, ValueError):
            p = ""
        if p.lower().startswith(self.root):
            self.opened.append((Path(p[len(self.root):].lstrip("\\/")).as_posix(), mode))
        return self._real(file, mode, *a, **kw)

    def patches(self):
        return [mock.patch.object(builtins, "open", self), mock.patch.object(io, "open", self)]


class HubTests(unittest.TestCase):
    def setUp(self):
        self.sb = Sandbox(key=None)
        self.hub = self.sb.root / "hub"
        for rel, text in HUB_FILES.items():
            p = self.hub / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(text.encode("utf-8"))
        brain = self.sb.root / "repo" / "brain"
        brain.mkdir(parents=True, exist_ok=True)
        (brain / "identity.md").write_text("# Identity\n- Gives complete context, not summaries; Nic prefers long first-principles answers\n", encoding="utf-8")
        self.preview = self.sb.root / "preview"

    def tearDown(self):
        self.sb.close()

    def dry(self, llm=None, **kw):
        kw.setdefault("sources", "all")  # brain/ is distilled too (the curated default: test_memory_scrolls_curated.py)
        opts = offload.OffloadOptions(preview_dir=self.preview, llm=llm, no_llm=llm is None, **kw)
        events: list = []
        res = offload.dry_run(self.sb.paths(), opts, self.sb.env, events.append)
        return res, events

    def preview_text(self, res) -> str:
        prev = Path(res["preview_dir"])
        return "\n".join(p.read_text(encoding="utf-8") for p in sorted(prev.rglob("*")) if p.is_file())

    @staticmethod
    def calls_for(llm, rel):
        return [user_text(m) for m in llm.calls if f"TARGET: {rel}" in user_text(m)]

    # ── (a) deny-list + read-only ──

    def test_hub_deny_list_enforced(self):
        for rel in DENIED:
            self.assertIsNotNone(offload.hub_denied(rel), rel)
        for rel in READ:
            self.assertIsNone(offload.hub_denied(rel), rel)
        rec = OpenRecorder(self.hub)
        real_read = offload._hub_read
        via_hub_read: list = []

        def spy(p):
            via_hub_read.append(Path(p).relative_to(self.hub).as_posix())
            return real_read(p)

        llm = FakeLLM([auto_reply] * 64)
        p1, p2 = rec.patches()
        with p1, p2, mock.patch.object(offload, "_hub_read", spy):
            res, events = self.dry(llm)
        self.assertEqual(set(via_hub_read), READ | {".clinerules"}, "only allow-listed files are read (.clinerules is read, then deduped by hash)")
        opened = {rel for rel, _ in rec.opened}
        self.assertEqual(opened, READ | {".clinerules"}, "nothing else under the hub is ever opened")
        for rel in DENIED + ["master/SKILLS.md", "master/handoffs/CURATION_PROMPT.md", "README.md"]:
            self.assertNotIn(rel, opened)
        msgs = json.dumps(llm.calls)
        out = json.dumps(res) + json.dumps(events) + self.preview_text(res)
        self.assertIsNone(SENTINEL.search(msgs), SENTINEL.search(msgs) and msgs[SENTINEL.search(msgs).start() - 80:SENTINEL.search(msgs).end() + 20])
        self.assertIsNone(SENTINEL.search(out))
        hub = res["hub"]
        self.assertEqual(hub["files_read"], len(READ))
        self.assertEqual(hub["duplicates"], 1)
        self.assertEqual(hub["skipped"], {"stale_inventory": 1, "one_off_job": 1})
        self.assertEqual(hub["denied_files"], 2, "the two booking files the protocols/ glob listed")
        for rule in ("booking", "tasks", "messaging_bridge", "git", "memory", "parking_lot", "skills_lock", "agent_folders", "tool_config"):
            self.assertEqual(hub["denied"][rule], "present", rule)
        self.assertNotIn(".eml", json.dumps(hub))
        self.assertGreaterEqual(hub["booking_lines_dropped"], 1)

    def test_hub_is_read_only(self):
        before = hub_snapshot(self.hub)
        rec = OpenRecorder(self.hub)
        p1, p2 = rec.patches()
        with p1, p2:
            self.dry(FakeLLM([auto_reply] * 64))
            self.dry(None)
        self.assertEqual(hub_snapshot(self.hub), before, "hub tree byte-identical, same mtimes, no new paths")
        self.assertTrue(rec.opened)
        for rel, mode in rec.opened:
            self.assertNotRegex(mode, r"[wax+]", rel)

    def test_no_hub_is_fine(self):
        import shutil

        shutil.rmtree(self.hub)
        res, _ = self.dry(None)
        self.assertTrue(res["hub"]["absent"])
        self.assertEqual(res["hub"]["files_read"], 0)

    # ── (c) routing, handoffs and root rule files ──

    def test_handoffs_root_rule_files_and_routing_table(self):
        recs, notes = offload.gather_hub(self.sb.env, [])
        routes = {}
        for r in recs:
            routes.setdefault(r["meta"]["file"], set()).add(offload.offload_route(r))
        self.assertEqual(routes, {
            "CLAUDE.md": {offload.HUB_ARCH},
            "GEMINI.md": {offload.HUB_IDENTITY},
            "master/MASTER_IDENTITY.md": {offload.HUB_IDENTITY},
            "master/AGENTS_NEVER.md": {offload.HUB_ARCH},
            "master/AGENTS.md": {offload.HUB_ARCH},
            "master/SYSTEM.md": {offload.HUB_ARCH},
            "master/INDEX.md": {offload.HUB_ARCH},
            "master/STATUS.md": {offload.HUB_ARCH, offload.HUB_PATTERNS, offload.HUB_PROJECT},
            "master/ROADMAP.md": {offload.HUB_PROJECT},
            "master/handoffs/HANDOFF_CODING.md": {offload.HUB_IDENTITY, offload.HUB_PATTERNS},
            "protocols/app-build.md": {offload.HUB_PATTERNS},
        })
        self.assertNotIn("hub:.clinerules", {r["source"] for r in recs})
        by = {(r["meta"]["file"], r["meta"]["target"]): r["text"] for r in recs}
        self.assertIn("Keys and secrets stay outside the repo", by[("master/STATUS.md", offload.HUB_ARCH)])
        self.assertNotIn("Keys and secrets", by[("master/STATUS.md", offload.HUB_PROJECT)])
        self.assertIn("build in small stages", by[("master/STATUS.md", offload.HUB_PATTERNS)])
        self.assertIn("full-file replacements", by[("master/handoffs/HANDOFF_CODING.md", offload.HUB_IDENTITY)])
        self.assertIn("How to test it", by[("master/handoffs/HANDOFF_CODING.md", offload.HUB_PATTERNS)])
        self.assertTrue(all(r["meta"]["transient"] == (r["meta"]["target"] == offload.HUB_PROJECT) for r in recs))
        # The hub's "update STATUS.md at session end" rule is never fed to the model.
        everything = "\n".join(r["text"] for r in recs)
        self.assertNotRegex(everything, r"(?i)last session")
        self.assertGreaterEqual(notes["status_write_rules_dropped"], 4)
        self.assertNotIn("Fill in the brackets", everything)

    # ── (b) MASTER_IDENTITY first and hinted ──

    def test_master_identity_first_and_hinted(self):
        llm = FakeLLM([auto_reply] * 64)
        res, _ = self.dry(llm)
        msgs = self.calls_for(llm, offload.HUB_IDENTITY)
        self.assertTrue(msgs)
        first = msgs[0]
        batch = re.search(r"<<<DATA BATCH\n(.*?)\n>>>", first, re.S).group(1)
        self.assertTrue(batch.startswith("[doc ") and "hub:master/MASTER_IDENTITY.md" in batch.split("\n", 1)[0], batch[:120])
        self.assertLess(batch.index("hub:master/MASTER_IDENTITY.md"), batch.index("brain:identity.md"))
        self.assertIn(offload.AUTHORITATIVE_HINT, first)
        self.assertIn(offload.HUB_DATA_HINT, first)
        self.assertNotIn(offload.TRANSIENT_HINT, first)
        proj = self.calls_for(llm, offload.HUB_PROJECT)[0]
        self.assertIn(offload.TRANSIENT_HINT, proj)
        self.assertNotIn(offload.AUTHORITATIVE_HINT, proj)

    def test_status_write_rule_phrasings(self):
        drop = [
            'When the session ends, update the "Last session" section in master/STATUS.md.',
            '- End every session by updating "Last session" in STATUS.md.',
            '  Exception: whoever ends a session updates "Last session" in STATUS.md.',
            '4. A filled-in "Last session" block for STATUS.md',
            "- Writing the STATUS.md handover is the last step.",
        ]
        keep = [
            "- Read INDEX + STATUS first, every session.",
            "- STATUS.md: where everything stands, next steps, last session. WHO: everyone, every time.",
            "- Only the Librarian edits these files, with Nic's approval, one Git commit per change.",
            "5. Write Conceptualizer and Dispatcher prompts.",
        ]
        for s in drop:
            self.assertRegex(s, offload._HUB_STATUS_WRITE, s)
        for s in keep:
            self.assertNotRegex(s, offload._HUB_STATUS_WRITE, s)

    def test_hint_echo_is_stripped(self):
        body = "# Identity & Preferences\n\n## Identity\n\n- When brain, chat or other sources disagree with that profile, keep the hub version\n- Runs local AI on his own machines\n"
        out, removed = distill.strip_prompt_echo(body, ["- Runs local AI on his own machines"], "", [offload.AUTHORITATIVE_HINT])
        self.assertEqual(len(removed), 1, removed)
        self.assertIn("Runs local AI", out)
        out2, removed2 = distill.strip_prompt_echo(body, ["- Runs local AI on his own machines"], "")
        self.assertEqual(removed2, [], "without the hint it is not a rule echo")

    # ── section allow-list + input privacy ──

    def test_master_identity_section_allowlist(self):
        llm = FakeLLM([auto_reply] * 64)
        res, _ = self.dry(llm)
        msgs = "\n".join(self.calls_for(llm, offload.HUB_IDENTITY))
        for gone in ("SENTINEL-CORE", "SENTINEL-MONEY", "SENTINEL-BOOKRULE", "SENTINEL-BOUNDARY", "SENTINEL-MUSIC", "SENTINEL-EMERGING", "v1 (draft"):
            self.assertNotIn(gone, msgs)
        for kept in ("No fluff, practical", "Every project gets a finish line", "Runs local AI on his own machines", "role-specialised versions", "New ideas land here first", "ASK. Never guess"):
            self.assertIn(kept, msgs)
        f = next(x for x in res["hub"]["files"] if x["file"] == "master/MASTER_IDENTITY.md")
        self.assertEqual(f["sections_kept"], 6)
        self.assertGreaterEqual(f["sections_skipped"], 7)

    def test_hub_input_privacy_every_category(self):
        llm = FakeLLM([auto_reply] * 64)
        res, events = self.dry(llm)
        msgs = json.dumps(llm.calls)
        for v in PERSONAL_VALUES:
            self.assertNotIn(v, msgs, v)
        out = json.dumps(res) + json.dumps(events) + self.preview_text(res)
        for v in PERSONAL_VALUES:
            self.assertNotIn(v, out, v)
        removed = res["hub"]["input_privacy_removed"]
        want = {k.split("_tz")[0] for k in PERSONAL_LINES}
        self.assertEqual(set(removed), want)
        self.assertEqual(removed["location"], 2, "home phrasing + IANA time zone")
        f = next(x for x in res["hub"]["files"] if x["file"] == "master/MASTER_IDENTITY.md")
        self.assertEqual(sum(f["input_privacy_removed"].values()), len(PERSONAL_LINES))
        self.assertTrue(any(w.startswith("ai-hub: privacy filter removed") for w in res["warnings"]))

    def test_iana_time_zone_is_location(self):
        pol = privacy.default_policy()
        self.assertEqual(privacy.check_line("- Working hours follow Europe/Sentinel time", pol)[0], "location")
        self.assertIsNone(privacy.check_line("- The repo path is src/Components/App", pol)[0])
        self.assertGreaterEqual(privacy_policy.POLICY_VERSION, 3, "v3 added IANA time zones")

    # ── never-lock on hub-derived content ──

    def test_never_lock_transient_project_and_tentative_wording(self):
        def reply(messages):
            r = json.loads(auto_reply(messages))
            u = user_text(messages)
            tgt = re.search(r"^TARGET: (\S+)", u, re.M).group(1)
            md = r["updated_markdown"]
            if tgt == offload.HUB_PROJECT:
                md = md.replace("## Locked Decisions\n", "## Locked Decisions\n\n- LM Studio always serves on port 1235\n", 1)
            if tgt == offload.HUB_ARCH:
                md = md.replace("## Locked Design Decisions\n", "## Locked Design Decisions\n\n- Librarian model: Gemini to start\n- Keys and secrets always stay outside the repo\n", 1)
            r["updated_markdown"] = md
            return json.dumps(r)

        res, events = self.dry(FakeLLM([reply] * 64))
        rows = {t["rel"]: t for t in res["proposed"]["targets"]}
        prev = Path(res["preview_dir"]) / "scrolls"
        proj = (prev / offload.HUB_PROJECT).read_text(encoding="utf-8")
        locked = proj.split("## Locked Decisions", 1)[1].split("\n## ", 1)[0]
        active = proj.split("## Active State", 1)[1].split("\n## ", 1)[0]
        self.assertNotIn("port 1235", locked)
        self.assertIn("LM Studio always serves on port 1235", active)
        self.assertGreaterEqual(rows[offload.HUB_PROJECT]["never_lock_demoted"], 1)
        arch = (prev / offload.HUB_ARCH).read_text(encoding="utf-8")
        locked = arch.split("## Locked Design Decisions", 1)[1].split("\n## ", 1)[0]
        self.assertNotIn("Gemini to start", locked)
        self.assertIn("Keys and secrets always stay outside the repo", locked, "a lasting rule stays locked")
        self.assertIn("Librarian model: Gemini to start", arch.split("## Ports & Services", 1)[1].split("\n## ", 1)[0])
        self.assertGreaterEqual(rows[offload.HUB_ARCH]["never_lock_demoted"], 1)
        self.assertTrue(any(e.get("event") == "never_lock" and e["target"] == offload.HUB_PROJECT for e in events))

    def test_one_off_kind_tentative(self):
        for s in ("- Librarian model: Gemini to start", "- Brave search for now", "- Booking agent next to build", "- Paid plan being considered", "- Identity file is a v1 draft"):
            self.assertEqual(distill.one_off_kind(s), "idea", s)
        for s in ("- Never delete files, for now or later", "- LM Studio on :1235 to start"):
            self.assertIsNone(distill.one_off_kind(s), s)

    def test_tentative_beats_use_default_and_rule_markers(self):
        for s in ("- Use Gemini as librarian for now", "- Librarian: use Gemini to start", "- Defaults to Gemini for now",
                  "- Rule for now: Gemini is librarian", "- Pending review: use Qwen for tool calls"):
            self.assertEqual(distill.one_off_kind(s), "idea", s)
        for s in ("- Use maps.route for travel-time lookups", "- Default model: Qwen 3.5 9B", "- Rules: test each step before the next",
                  "- Use LM Studio on :1235 for now", "- Always use Qwen, for now and always"):
            self.assertIsNone(distill.one_off_kind(s), s)

    # ── H1 handling, deny checks, junctions, GEMINI.md line routing ──

    def test_later_h1_in_master_identity_opens_a_denied_section(self):
        for h1 in ("Family and health", "Part two"):
            text = f"# Draft\n## VOICE\n- short answers\n# {h1}\n- SENTINEL-H1 private line\n## VOICE\n- SENTINEL-H1B under it\n## CORE\n- x\n"
            out, c = offload.hub_sections(offload.HUB_AUTHORITATIVE, text)
            self.assertEqual(out, {offload.HUB_IDENTITY: ["## VOICE\n- short answers"]}, h1)
            self.assertNotIn("SENTINEL", json.dumps(out))
            self.assertEqual(c["sections_kept"], 1)
        out, _ = offload.hub_sections(offload.HUB_AUTHORITATIVE, "# Draft\nPreamble line\n## VOICE\n- short\n")
        self.assertEqual(out[offload.HUB_IDENTITY][0], "Preamble line", "the leading H1 still opens the preamble")
        out, c = offload.hub_sections(offload.HUB_AUTHORITATIVE, "# Who I am\nSENTINEL preamble\n## VOICE\n- short\n")
        self.assertEqual(out, {}, "a denied leading H1 drops everything under it")

    def test_h1_titles_are_deny_checked_in_every_file(self):
        out, c = offload.hub_sections("protocols/client-replies.md", "# Casting rates and contacts\n- reply within a day, quote the day rate\n")
        self.assertEqual(out, {})
        self.assertEqual(c["sections_skipped"], 1)
        for rel in ("GEMINI.md", "CLAUDE.md", "master/SYSTEM.md"):
            out, _ = offload.hub_sections(rel, "# Family\n- SENTINEL-FAM line\n")
            self.assertEqual(out, {}, rel)
        out, _ = offload.hub_sections("protocols/app-build.md", "# App build\n- build in small stages\n")
        self.assertEqual(list(out), [offload.HUB_PATTERNS])

    def test_junctioned_parent_dir_is_not_traversed(self):
        real = offload.fsutil.is_reparse
        master = self.hub / "master"
        with mock.patch.object(offload.fsutil, "is_reparse", lambda p: Path(p) == master or real(p)):
            recs, _ = offload.gather_hub(self.sb.env, [])
        files = {r["meta"]["file"] for r in recs}
        self.assertFalse(any(f.startswith("master/") for f in files), files)
        self.assertIn("CLAUDE.md", files)
        self.assertFalse(offload._hub_dir_ok(self.hub, "nope"))
        self.assertTrue(offload._hub_dir_ok(self.hub, "master/handoffs"))

    def test_gemini_rules_go_to_architecture_and_only_how_nic_works_to_identity(self):
        text = ("# GEMINI.md\n\nBefore doing anything:\n1. Read master/INDEX.md\n\nYour role: backup coder; escalate hard problems to Claude.\n\n"
                "How Nic works: short plain answers, one step at a time.\n")
        out, c = offload.hub_sections("GEMINI.md", text)
        self.assertEqual(set(out), {offload.HUB_ARCH, offload.HUB_IDENTITY})
        self.assertEqual(out[offload.HUB_IDENTITY], ["How Nic works: short plain answers, one step at a time."])
        self.assertIn("Your role: backup coder", out[offload.HUB_ARCH][0])
        self.assertIn("Read master/INDEX.md", out[offload.HUB_ARCH][0])
        self.assertNotIn("How Nic works", out[offload.HUB_ARCH][0])
        self.assertEqual(c["sections_kept"], 2)

    def test_lock_new_false_moves_every_new_locked_bullet_never_an_existing_one(self):
        t = sc.target_info(offload.HUB_PROJECT)
        cur = sc.template_body(t).replace("## Locked Decisions\n", "## Locked Decisions\n\n- Existing rule: always test each step\n", 1)
        body = cur.replace("## Locked Decisions\n", "## Locked Decisions\n\n- Port 1235 is the LM Studio default\n", 1)
        out, moved = distill.demote_one_off_locked(t, body, cur, lock_new=False)
        locked = out.split("## Locked Decisions", 1)[1].split("\n## ", 1)[0]
        self.assertIn("Existing rule: always test each step", locked)
        self.assertNotIn("Port 1235", locked)
        self.assertEqual(moved, [("transient", "Active State")])
        same, none = distill.demote_one_off_locked(t, body, cur)
        self.assertEqual(none, [], "lock_new=True keeps a durable new bullet")

    # ── (e) provenance ──

    def test_provenance_report_and_manifest(self):
        res, _ = self.dry(FakeLLM([auto_reply] * 64))
        prev = Path(res["preview_dir"])
        manifest = json.loads((prev / "manifest.json").read_text(encoding="utf-8"))
        report = json.loads((prev / "report.json").read_text(encoding="utf-8"))
        want = {rel: hashlib.sha256((self.hub / rel).read_bytes()).hexdigest() for rel in READ}
        self.assertEqual(manifest["hub_sources"], want)
        self.assertEqual(report["hub"]["files_read"], len(READ))
        rows = {t["rel"]: t for t in res["proposed"]["targets"]}
        seen = set()
        for rel, row in rows.items():
            prov = row["provenance"]
            self.assertEqual(manifest["distill"][rel]["sources"], prov)
            self.assertIsNone(manifest["distill"][rel]["partial_distillation"])
            for h in prov["hub"]:
                self.assertEqual(set(h), {"file", "sha12", "sections", "chunks", "used"})
                self.assertEqual(h["sha12"], want[h["file"]][:12])
                self.assertEqual(h["chunks"], [1])
                self.assertEqual(h["used"], "model")
                seen.add(h["file"])
        self.assertEqual(seen, READ)
        ident = rows[offload.HUB_IDENTITY]["provenance"]
        self.assertEqual(ident["hub"][0]["file"], "master/MASTER_IDENTITY.md", "authoritative first")
        self.assertEqual([b["file"] for b in ident["brain"]], ["identity.md"])
        # Extractive: a hub file is "extractive" only when one of its lines made a bullet.
        res2, _ = self.dry(None)
        for row in res2["proposed"]["targets"]:
            for h in row["provenance"]["hub"]:
                self.assertIn(h["used"], ("extractive", "no_signal"))

    def test_provenance_used_states(self):
        part = {"accepted": 2, "chunks": 4, "failed_chunk": 3}
        self.assertEqual(offload._used([1, 2], "live", part, "", ()), "model")
        self.assertEqual(offload._used([3], "live", part, "", ()), "failed_chunk")
        self.assertEqual(offload._used([2, 3], "live", part, "", ()), "failed_chunk")
        self.assertEqual(offload._used([4], "live", part, "", ()), "not_reached")
        self.assertEqual(offload._used([], "live", None, "", ()), "no_signal")
        self.assertEqual(offload._used([1], "extractive", None, "hub:x", {"hub:x"}), "extractive")


class BatchAndPartialTests(unittest.TestCase):
    """distill.batch_text / chunk_spans and compact.distill_target(keep_partial=...)."""

    def test_chunk_spans_match_chunks(self):
        import random

        rnd = random.Random(7)
        for limit in (50, 200, 12000):
            for _ in range(40):
                lines = ["x" * rnd.choice([0, 1, 5, 30, 49, 50, 51, 120, 260]) for _ in range(rnd.randint(1, 30))]
                text = "\n".join(lines)
                want = distill.chunks(text, limit)
                got = [text[s:e] for s, e in distill.chunk_spans(text, limit)]
                self.assertEqual(got, want, (limit, [len(x) for x in lines]))

    def test_batch_text_defaults_unchanged_and_labels(self):
        recs = [
            {"kind": "doc", "ts": "2026-11-19T09:00:00", "source": "hub:master/MASTER_IDENTITY.md", "text": "- One step at a time, test each step\n- shared line that repeats"},
            {"kind": "doc", "ts": "2026-11-18T09:00:00", "source": "brain:identity.md", "text": "- shared line that repeats\n- brain only line here"},
            {"kind": "turn", "ts": "", "source": "chat", "text": "user: hello there friend, keep it short"},
        ]
        plain = distill.batch_text(recs, "arch-x")
        self.assertEqual(plain, "\n".join(f"[{r['kind']} {r['ts']}] {distill.prefilter(distill.distill_text(r['text'], 'arch-x'), 'arch-x')}" for r in recs))
        text, spans = distill.batch_text_spans(recs, "arch-x", label_sources=True, dedupe_lines=True)
        self.assertTrue(text.startswith("[doc 2026-11-19T09:00:00 hub:master/MASTER_IDENTITY.md] "))
        self.assertEqual(text.count("shared line that repeats"), 1, "the first (priority) copy wins")
        self.assertIn("[turn ] ", text)
        for idx, s, e in spans:
            self.assertTrue(text[s:e].startswith("["), (idx, text[s:e][:30]))

    def _llm(self, bad_after: int, mode: str):
        n = {"i": 0}

        def reply(messages):
            n["i"] += 1
            r = json.loads(auto_reply(messages))
            batch = re.search(r"<<<DATA BATCH\n(.*?)\n>>>", user_text(messages), re.S).group(1)
            if "MARK-B" in batch:
                if mode == "raise":
                    raise OSError("connection reset")
                return "not json at all"
            return json.dumps(r)

        return FakeLLM([reply] * 16)

    def _text(self):
        a = "\n".join(f"Locked: rule A{i} stays on port 1235" for i in range(3)) + "\n" + "\n".join(f"note a {i} " + "x" * 80 for i in range(140))
        b = "MARK-B\n" + "\n".join(f"note b {i} " + "y" * 80 for i in range(140))
        return a + "\n" + b

    def test_keep_partial_keeps_accepted_body_when_last_chunk_rejected(self):
        t = sc.target_info("core/architecture_decisions.md")
        text = self._text()
        n = len(distill.chunks(text))
        self.assertGreaterEqual(n, 2)
        for mode in ("reject", "raise"):
            stats, warnings = {}, []
            budget = {"used": 0, "max": 16, "save": lambda: None}
            reasons, merged, _, _ = compact.distill_target(self._llm(1, mode), t, None, text, "arch-2026-11-19-01", NOW_ISO, [], {}, budget, warnings, stats=stats, keep_partial=True)
            self.assertEqual(reasons, [], (mode, reasons))
            self.assertIsNotNone(merged)
            self.assertIn("rule A0 stays on port 1235", merged.body)
            p = stats["partial"]
            self.assertEqual((p["accepted"], p["chunks"]), (p["failed_chunk"] - 1, n))
            self.assertTrue(any("kept the model body of chunk(s) 1.." in w for w in warnings), warnings)
            # Default (compact): unchanged, the target fails / raises.
            budget = {"used": 0, "max": 16, "save": lambda: None}
            if mode == "reject":
                reasons, merged, _, _ = compact.distill_target(self._llm(1, mode), t, None, text, "arch-2026-11-19-01", NOW_ISO, [], {}, budget)
                self.assertTrue(reasons)
                self.assertIsNone(merged)
            else:
                with self.assertRaises(OSError):
                    compact.distill_target(self._llm(1, mode), t, None, text, "arch-2026-11-19-01", NOW_ISO, [], {}, budget)

    def test_first_chunk_failure_still_fails_with_keep_partial(self):
        t = sc.target_info("core/architecture_decisions.md")
        stats = {}
        budget = {"used": 0, "max": 8, "save": lambda: None}
        reasons, merged, _, _ = compact.distill_target(FakeLLM(["nope"] * 8), t, None, "MARK-B\n" + "z" * 50, "arch-2026-11-19-01", NOW_ISO, [], {}, budget, stats=stats, keep_partial=True)
        self.assertTrue(reasons)
        self.assertIsNone(merged)
        self.assertNotIn("partial", stats)


if __name__ == "__main__":
    unittest.main(verbosity=2)
