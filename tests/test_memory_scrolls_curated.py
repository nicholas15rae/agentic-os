"""Memory Scrolls round 7: the curated first seed and the content guards v3 (synthetic data only).

- Curated seed (`--sources curated`, the default): only the read-only hub and the repo-doc allow-list
  are distilled; brain/ and every chat-like source (gateway chat, os-threads, training logs, Tony's
  notes, AnythingLLM chats / documents) never reach the model, are archived losslessly by `--apply`
  (Step A: gz + sha256, verified) and their compaction watermarks advance, so a later compaction
  distills only NEW records. The mode and the allow-list hash are bound into the manifest (v5).
- Plans: ROADMAP lines are tagged "Planned:" and may only land in Open Threads; a dated status wins.
- Privacy v6: multi-word deny terms match spacing / case / punctuation-insensitively ("Foo Bar" =
  "FooBar", "foo-bar", "foo_bar", "foobar") without matching ordinary words; the hub STATUS MCP
  filesystem-root line case.
- Imperatives (delete / download / export / send / change config / outside services) are never
  standing instructions; contested #6 and the widened #4; Superseded hygiene; Key Paths / transient
  status; a synthetic replay of the round-6 blocked shapes through dry-run and `--apply`.

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

from memory_scrolls import archive, compact, distill, guards, offload, privacy, privacy_policy, sources, stale_claims  # noqa: E402
from memory_scrolls import scroll as sc  # noqa: E402
from memory_scrolls.errors import ArchiveError  # noqa: E402
from memory_scrolls_stubs import StubGateway, auto_reply, user_text  # noqa: E402
from test_memory_scrolls import NOW, NOW_ISO, FakeLLM, Sandbox, noisy_threads, section_reply, turn  # noqa: E402
from test_memory_scrolls import setUpModule, tearDownModule  # noqa: E402,F401
from test_memory_scrolls_offload import OS_JSON, stub_allm  # noqa: E402

PROJ = sc.target_info("projects/agentic-os.md")
HUBP = sc.target_info("projects/ai-hub.md")
ARCH = sc.target_info("core/architecture_decisions.md")
IDENT = sc.target_info("core/identity_and_preferences.md")
LESS = sc.target_info("patterns/lessons_and_fixes.md")

# ── synthetic sources ───────────────────────────────────────────────────────

MI = """# MASTER_IDENTITY - v1 (draft)
Rule: ask when unsure.

## VOICE
- No fluff, practical answers.

## SIDE VENTURES
- Planning the Zentrova Labs launch with a friend; Zentrova Labs sells prints.
- The Green Leaf stall opens on Sundays; Green Leaf takes card orders.
"""
STATUS = """# STATUS

## Working
- MCP servers: filesystem roots D:\\Projects\\ZentrovaLabs and D:\\Projects\\Scene reader
- Qwen 3.5 9B is the main agent model in LM Studio on :1235
- MASTER_IDENTITY v1 and AGENTS_NEVER need final review before lock
- One backup exists; second backup pending (external drive or Google Drive)

## Broken / open
- Qwen 2.5 Coder emits text instead of tool calls; fix: build in small stages
"""
ROADMAP = """# ROADMAP

## Phase 1 - Foundation
- Hub backed up twice
- MASTER_IDENTITY v1 and AGENTS_NEVER reviewed

## Phase 7 - Personal app
- Desktop app over the overlay network, later
"""
HUB = {
    "master/MASTER_IDENTITY.md": MI,
    "master/STATUS.md": STATUS,
    "master/ROADMAP.md": ROADMAP,
    "master/SYSTEM.md": "# SYSTEM\n\n## AI stack\n- LM Studio serves models on :1235 only\n- Gateway binds to 127.0.0.1 only\n",
    "master/AGENTS_NEVER.md": "# AGENTS_NEVER\n\n## NEVER\n- Never delete files; move them to review instead.\n",
}
OVERNIGHT = """# Overnight Build Report

## TL;DR
- REPO-UNSELECTED-TLDR status line, PID 4242

## Invariants verified
- [x] **No mutating plan without approve():** the Tier-3 offer gates dispatch.
  - nested detail: the ledger Run click also needs approve()
- [x] **WhatsApp stays read-only** in every mode.
- **Observed tonight:** REPO-RUN-NOTE the smoke pulled a prompt backup.
- [x] **The Booking workspaces were never written:**
  - REPO-BOOKING-CHILD Part 7 refuses those slugs before any request.

```bash
REPO-FENCE-SENTINEL npm run desktop:dev
```

## Collective memory & Librarian

| Store | Where | Notes |
|---|---|---|
| tasks.db | %APPDATA%\\os.agentic.commandcenter\\ | TaskEnvelope + handoff_log |

## Needs your attention
- REPO-UNSELECTED-ATTENTION restart the gateway tonight
"""
STEERING = """# Tony Steering Spec

## 1. Modes: schema and storage
- modes.json holds six presets plus custom modes.

## 3. Dispatch policies, and how auto_dispatch interacts with approve()
- auto_dispatch skips only the spoken offer; every mutating plan still goes through approve().

## 4. Hard mic mute: the layers, and the tests that prove it
- Mute is a dead line at every layer; it persists in os.json voice.micEnabled.

## 8. Decisions taken on Nic's behalf (all reversible)
- REPO-UNSELECTED-DECISION default chosen overnight

## 10. How to try it in the morning
- REPO-UNSELECTED-MORNING run the app
"""
TIERING = """# Memory Tiering

## 1. Architecture as built
- Scrolls live in D:\\ai-hub-memory\\scrolls; the cold archive is D:\\ai-hub-archive.

## 2. Gates
- REPO-UNSELECTED-GATES 376 OK
"""
REPO_FILES = {"OVERNIGHT_BUILD_REPORT.md": OVERNIGHT, "docs/TONY_STEERING_SPEC.md": STEERING, "docs/MEMORY_TIERING_REPORT.md": TIERING}
BRAIN = {"active-projects.md": "# Active Projects\n\n## CloudMart\n- BRAIN-SENTINEL GCP multi-region e-commerce stack (GKE, Cloud SQL)\n"}
GATEWAY = [{"role": "user", "content": "GATEWAY-SENTINEL set the TTS voice"}, {"role": "assistant", "content": "GATEWAY-SENTINEL done"}]
TRAINING = '{"role": "coder", "text": "TRAINING-SENTINEL built the card"}\n{"role": "coder", "text": "TRAINING-SENTINEL second line"}\n'
ARCHIVE_ONLY_SENTINELS = ("BRAIN-SENTINEL", "JOURNAL-SENTINEL", "GATEWAY-SENTINEL", "TRAINING-SENTINEL", "NOTE-SENTINEL", "Whisper STT runs on port 8178", "make the status card blue",
                          "Agentic OS notes", "Locked: Whisper")


class CuratedBase(unittest.TestCase):
    def setUp(self):
        self.allm = stub_allm().start()
        self.gw = StubGateway(active=False).start()
        self.sb = Sandbox(allm_url=self.allm.url, gateway_url=self.gw.url, os_json=OS_JSON)
        root = self.sb.root
        for rel, text in HUB.items():
            p = root / "hub" / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(text, encoding="utf-8")
        for rel, text in REPO_FILES.items():
            p = root / "repo" / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(text, encoding="utf-8")
        (root / "repo" / "brain").mkdir()
        for name, text in BRAIN.items():
            (root / "repo" / "brain" / name).write_text(text, encoding="utf-8")
        (root / "repo" / "brain" / "journal").mkdir()
        (root / "repo" / "brain" / "journal" / "2026-06-05.md").write_text("# Journal\nJOURNAL-SENTINEL wired the HUD\n", encoding="utf-8")
        (root / "repo" / "data").mkdir()
        (root / "repo" / "data" / "chat-history.json").write_text(json.dumps(GATEWAY), encoding="utf-8")
        (root / "repo" / "training_logs").mkdir()
        (root / "repo" / "training_logs" / "a.jsonl").write_text(TRAINING, encoding="utf-8")
        (root / "notes" / "ideas" / "idea.md").write_text("# Idea\nNOTE-SENTINEL a recipe scaler\n", encoding="utf-8")
        self.sb.threads(noisy_threads())
        self.preview = root / "preview"

    def tearDown(self):
        self.sb.close()
        self.allm.stop()
        self.gw.stop()

    def dry(self, llm=None, **kw):
        events: list = []
        llm = llm or FakeLLM([auto_reply] * 64)
        res = offload.dry_run(self.sb.paths(), offload.OffloadOptions(preview_dir=self.preview, llm=llm, now=NOW, **kw), self.sb.env, events.append)
        return res, events, llm

    def apply(self, token, *extra):
        return self.sb.cli("offload", "--json", "--apply", "--preview-dir", str(self.preview), "--confirm", token, *extra)

    def state(self) -> dict:
        return json.loads((self.sb.root / "state" / "state.json").read_text(encoding="utf-8"))


# ── 1. the curated seed ─────────────────────────────────────────────────────


class CuratedSeedTests(CuratedBase):
    def test_default_mode_distills_only_hub_and_repo_docs(self):
        res, events, llm = self.dry()
        prompts = json.dumps([user_text(m) for m in llm.calls])
        for v in ARCHIVE_ONLY_SENTINELS:
            self.assertNotIn(v, prompts, f"archive-only source reached the model: {v}")
        self.assertIn("repo:OVERNIGHT_BUILD_REPORT.md", prompts)
        self.assertIn("modes.json holds six presets", prompts)
        self.assertIn("tasks.db: %APPDATA%", prompts, "a table row becomes a bullet")
        self.assertIn("ledger Run click also needs approve()", prompts, "nested bullets are dedented, not dropped")
        for v in ("REPO-UNSELECTED", "REPO-FENCE-SENTINEL", "REPO-BOOKING-CHILD", "Booking workspaces", "REPO-RUN-NOTE"):
            self.assertNotIn(v, prompts, v)
        self.assertIn(offload.REPO_HINT, prompts)
        targets = {re.search(r"^TARGET: (\S+)", user_text(m), re.M).group(1) for m in llm.calls}
        self.assertLessEqual(targets, {PROJ.rel, HUBP.rel, ARCH.rel, IDENT.rel, LESS.rel})
        self.assertIn(PROJ.rel, targets, "the repo docs feed the Agentic OS project scroll")
        # Per-source counts: distilled vs archive-only, in the report, the manifest and NDJSON.
        prev = Path(res["preview_dir"])
        report = json.loads((prev / "report.json").read_text(encoding="utf-8"))
        manifest = json.loads((prev / "manifest.json").read_text(encoding="utf-8"))
        srcs = report["sources"]
        self.assertEqual(srcs["mode"], "curated")
        self.assertEqual(set(srcs["distilled"]), {"hub", "repo_docs"})
        self.assertEqual(set(srcs["archive_only"]), {"anythingllm_chats", "anythingllm_docs", "brain", "gateway_chat", "notes", "threads", "training_logs"})
        self.assertEqual(srcs["archive_only"]["gateway_chat"]["records"], 2)
        self.assertEqual(srcs["archive_only"]["anythingllm_docs"]["records"], 2)
        self.assertEqual(srcs["watermarks_advanced_by_apply"], list(offload.ARCHIVE_ONLY_WATERMARKS))
        rd = {r["file"]: r for r in srcs["repo_docs"]}
        self.assertEqual((rd["OVERNIGHT_BUILD_REPORT.md"]["sections_kept"], rd["docs/TONY_STEERING_SPEC.md"]["sections_kept"]), (2, 3))
        self.assertEqual(manifest["schema"], "agentic-os.offload-preview.v6")
        self.assertEqual(manifest["sources"]["mode"], "curated")
        self.assertEqual(manifest["sources"]["allowlist_sha"], offload.curated_allowlist_sha())
        self.assertEqual(manifest["sources"]["archive_only"], srcs["archive_only"])
        self.assertEqual(set(manifest["sources"]["repo_docs"]), set(REPO_FILES))
        self.assertTrue(all(d["archive_only"] and d["target"] is None for d in manifest["allm_docs"]))
        self.assertEqual(manifest["local_sources"], sorted({f"hub:{r}" for r in HUB} | {f"repo:{r}" for r in REPO_FILES}))
        ev = [e for e in events if e.get("event") == "sources"]
        self.assertEqual(len(ev), 1)
        self.assertEqual(ev[0]["archive_only"], srcs["archive_only"])
        self.assertEqual(report["estimates"]["vector_chunks_removed"], 0, "a curated seed un-embeds nothing")
        rows = {r["rel"]: r for r in report["proposed"]["targets"]}
        self.assertFalse(rows[PROJ.rel]["never_lock_lock_new"], "repo docs alone lock nothing new")
        self.assertEqual([x["file"] for x in rows[PROJ.rel]["provenance"]["repo"]], list(REPO_FILES))
        self.assertNotIn("BRAIN-SENTINEL", "".join(p.read_text(encoding="utf-8") for p in prev.rglob("*.md")))

    def test_all_mode_keeps_the_earlier_behaviour(self):
        res, _, llm = self.dry(sources="all")
        prompts = json.dumps([user_text(m) for m in llm.calls])
        self.assertIn("BRAIN-SENTINEL", prompts)
        self.assertIn("make the status card blue", prompts)
        self.assertNotIn("repo:OVERNIGHT_BUILD_REPORT.md", prompts)
        self.assertEqual(res["sources"]["mode"], "all")
        self.assertEqual(res["sources"]["archive_only"], {})
        self.assertIsNone(res["sources"]["allowlist_sha"])

    def test_repo_docs_size_caps_and_allowlist_hash(self):
        big = "# Overnight\n\n## Invariants verified\n" + "\n".join(f"- invariant {i:04d}: " + "x" * 60 for i in range(200)) + "\n\n## Collective memory & Librarian\n- second section\n"
        (self.sb.root / "repo" / "OVERNIGHT_BUILD_REPORT.md").write_text(big, encoding="utf-8")
        recs, notes = offload.gather_repo_docs(self.sb.paths(), [])
        row = next(r for r in notes["files"] if r["file"] == "OVERNIGHT_BUILD_REPORT.md")
        self.assertEqual((row["truncated"], row["sections_over_cap"]), (1, 1), "the first section is cut at a line, the second skipped")
        self.assertLessEqual(row["bytes"], 4 * 1024 + 2)
        self.assertTrue(all(len(r["text"].encode("utf-8")) <= offload.REPO_DOCS_MAX_BYTES for r in recs))
        self.assertTrue(all(r["meta"]["target"] == PROJ.rel for r in recs))
        sha = offload.curated_allowlist_sha()
        with mock.patch.object(offload, "REPO_DOCS", offload.REPO_DOCS[:1]):
            self.assertNotEqual(offload.curated_allowlist_sha(), sha)
        with mock.patch.object(offload, "REPO_DOCS_MAX_BYTES", 1):
            self.assertNotEqual(offload.curated_allowlist_sha(), sha)

    def test_apply_archives_archive_only_sources_and_advances_watermarks(self):
        res, _, _ = self.dry()
        before_threads = (self.sb.root / "data" / "command-center" / "os-threads.json").read_bytes()
        self.allm.bodies.clear()
        code, lines = self.apply(res["token"])
        self.assertEqual(code, 0, lines[-1])
        out = lines[-1]
        self.assertEqual(out["sources"], "curated")
        self.assertEqual(len(out["archive_only_ids"]), 1)
        root = self.sb.root / "archive"
        aid = out["archive_only_ids"][0]
        self.assertTrue(archive.prune_allowed(root, aid), "the archive-only archive re-reads and verifies")
        header, rows = archive.read_entry(root, aid)
        self.assertEqual(header["source"], {"kind": "offload_archive_only", "mode": "curated"})
        kinds = Counter(offload.source_key(r) for r in rows)
        self.assertEqual(set(kinds), {"anythingllm_chats", "brain", "gateway_chat", "notes", "threads", "training_logs"})
        text = json.dumps(rows)
        # Lossless (secrets scrubbed only): every archive-only record is in it, verbatim (bytes as on
        # disk), brain/journal/ included, system turns included.
        for rel in ("active-projects.md", "journal/2026-06-05.md"):
            disk = (self.sb.root / "repo" / "brain" / rel).read_bytes().decode("utf-8")
            self.assertEqual([r["text"] for r in rows if r["source"] == f"brain:{rel}"], [disk], rel)
        self.assertIn("system: system bookkeeping line", [r["text"] for r in rows if r["kind"] == "turn"])
        for v in ("GATEWAY-SENTINEL set the TTS voice", "TRAINING-SENTINEL second line", "NOTE-SENTINEL a recipe scaler", "make the status card blue", "Whisper STT runs on port 8178"):
            self.assertIn(v, text, v)
        self.assertNotIn("BOOKING-SECRET", text, "the Booking filter still applies")
        # Watermarks advanced past everything archived.
        wm = self.state()["watermarks"]
        self.assertEqual(wm["gateway_chat"], {"id": "", "ts": "", "n": 2}, "no id / time in these messages: the count is the last resort")
        self.assertEqual(wm["training_logs"], {"a.jsonl": (self.sb.root / "repo" / "training_logs" / "a.jsonl").stat().st_size})
        self.assertIn("general", wm["threads"])
        self.assertEqual(list(wm["notes"]), ["ideas/idea.md"])
        self.assertEqual(self.state()["offload_seed"]["archive_only_ids"], [aid])
        # Nothing un-embedded (the AnythingLLM documents are archive-only); scrolls cite the local-source archive.
        self.assertFalse([p for m, p, b in self.allm.bodies if p.endswith("/update-embeddings") and b.get("deletes") and "custom-documents/notes-a.json" in b["deletes"]])
        self.assertEqual(out["kept_embedded"], 2)
        self.assertTrue(any("archive-only (curated seed" in a for a in out["actions"]), out["actions"])
        snap = out["snapshot_ids"][-1]
        for rel, s, _ in sc.list_scrolls(self.sb.root / "scrolls"):
            self.assertEqual(s.source_archive_ids, [snap], rel)
        self.assertEqual((self.sb.root / "data" / "command-center" / "os-threads.json").read_bytes(), before_threads, "sources are never changed")
        # A later compaction sees only NEW records.
        st = self.state()
        recs, _, _ = sources.collect(self.sb.paths(), st["watermarks"], [], include_training_logs=True, include_gateway_chat=True)
        self.assertEqual([r for r in recs if offload.source_key(r) in ("threads", "gateway_chat", "training_logs", "notes")], [])
        threads = json.loads((self.sb.root / "data" / "command-center" / "os-threads.json").read_text(encoding="utf-8"))
        threads["threads"]["general"].append(turn(1794939999999, "user", "NEW-TURN-SENTINEL the HUD shows the mode pill"))
        self.sb.threads(threads["threads"])
        recs, _, _ = sources.collect(self.sb.paths(), st["watermarks"], [])
        self.assertEqual([r["text"] for r in recs if r["kind"] == "turn"], ["user: NEW-TURN-SENTINEL the HUD shows the mode pill"])
        # End to end: compaction archives and distills just that new turn (today's behaviour).
        llm = FakeLLM([auto_reply] * 8)
        cres = compact.run(self.sb.paths(), compact.CompactOptions(llm=llm, max_batches=4, now=NOW), self.sb.env, lambda e: None)
        _, crows = archive.read_entry(root, cres["archive_ids"][0])
        self.assertEqual([r["text"] for r in crows if r["kind"] == "turn"], ["user: NEW-TURN-SENTINEL the HUD shows the mode pill"])
        self.assertIn("NEW-TURN-SENTINEL", json.dumps([user_text(m) for m in llm.calls]))
        self.assertNotIn("BRAIN-SENTINEL", json.dumps([user_text(m) for m in llm.calls]))

    def test_archive_only_failure_promotes_nothing_and_keeps_watermarks(self):
        res, _, _ = self.dry()
        real = archive.write_archive

        def fail_ao(root, records, desc, now, known=()):
            if desc.get("kind") == "offload_archive_only":
                raise ArchiveError("injected verify failure")
            return real(root, records, desc, now, known)

        with mock.patch.object(offload.archive, "write_archive", fail_ao):
            code, lines = self.apply(res["token"])
        self.assertEqual(code, 1, lines[-1])
        self.assertIn("injected", lines[-1]["error"])
        self.assertFalse(any((self.sb.root / "scrolls").rglob("*.md")), "nothing promoted")
        st = self.state()
        self.assertEqual((st["watermarks"]["threads"], st["watermarks"]["gateway_chat"]), ({}, 0), "watermarks only advance after a verified archive")
        self.assertNotIn("offload_seed", st)

    def test_apply_refuses_older_previews_other_modes_and_allowlists(self):
        with mock.patch.object(offload, "MANIFEST_SCHEMA", "agentic-os.offload-preview.v4"):
            res, _, _ = self.dry()
        code, lines = self.apply(res["token"])
        self.assertEqual(code, 2)
        self.assertIn("predates the curated-seed source mode", lines[-1]["error"])
        res, _, _ = self.dry()
        tree = self.sb.tree()
        code, lines = self.apply(res["token"], "--sources", "all")
        self.assertEqual(code, 2)
        self.assertIn("made with --sources curated", lines[-1]["error"])
        with mock.patch.object(offload, "REPO_DOCS", offload.REPO_DOCS[1:]):
            code, lines = self.apply(res["token"])
        self.assertEqual(code, 2)
        self.assertIn("another curated source allow-list", lines[-1]["error"])
        self.assertEqual(self.sb.tree(), tree, "nothing written by a refused apply")
        # A manifest with no source mode at all (hand-made) is refused too.
        self.assertRaises(offload.ConfigError, offload.source_mode_of, {"schema": offload.MANIFEST_SCHEMA})


# ── 2. the round-6 blocked shapes, replayed (synthetic) ─────────────────────


def r6_shape_reply(messages):
    """Every shape the round-6 review blocked, for whichever TARGET the prompt names."""
    u = user_text(messages)
    rel = re.search(r"^TARGET: (\S+)", u, re.M).group(1)
    t = sc.target_info(rel)
    ents: list = []
    if rel == HUBP.rel:
        sections = {
            "Current Milestone": ["- Hub backed up twice; MASTER_IDENTITY v1 and AGENTS_NEVER reviewed"],
            "Key Paths": ["- Root: C:\\ai-hub", "- Models: D:\\Projects\\Scene reader\\scene-reader-v3.0.0 (latest UI pushed)",
                          "- MCP Servers: filesystem roots D:\\Projects\\ZentrovaLabs and D:\\Projects\\Scene reader"],
            "Active State": ["- MASTER_IDENTITY v1 and AGENTS_NEVER need final review before lock", "- Catalog: Needs export to Google Sheets, fix two rows, delete clutter skills",
                             "- One backup exists; second backup pending (external drive or Google Drive)", "- System Status: Online (2026-11-19T07:43)"],
            "Open Threads": ["- Phase 7: desktop app over the overlay network, later"],
        }
        ents = [{"name": "MASTER_IDENTITY v1", "entityType": "decision", "observations": ["MASTER_IDENTITY v1 and AGENTS_NEVER reviewed", "Kept in master/"]}]
    elif rel == ARCH.rel:
        sections = {"Ports & Services": ["- LM Studio serves Qwen 3.5 9B on :1235"],
                    "Locked Design Decisions": ["- ai-hub is the single source of truth", "- Identity changes only through the Librarian", "- Gateway binds to 127.0.0.1 only"],
                    "Guardrails": ["- Never delete files; move them to review instead", "- Repoint the AnythingLLM knowledge-graph MCP entry by hand"]}
    elif rel == LESS.rel:
        sections = {"Fixes": ["- multi-account-gmail-mcp failed at drafting; remove it", "- Qwen 2.5 Coder emits text instead of tool calls; fix: build in small stages"],
                    "Failure Modes": ["- Pixtral load failed; re-download and check"]}
    elif rel == IDENT.rel:
        sections = {"Identity": ["- Decision Style: changes only through the Librarian", "- Runs local AI on his own machines"],
                    "Communication Preferences": ["- No fluff, practical answers"],
                    sc.SUPERSEDED: ["- 2026-11-19: Standing Rules: Audit Trail, Resilience -> Standing Rules: Same (merged budget/tech constraints) (arch-pending)"]}
    else:
        sections = {"Key Paths": ["- Repo: D:\\Art Apps\\agentic os", "- GCP DevOps multi-region e-commerce platform stack (GKE Autopilot, Cloud SQL)"],
                    "Active State": ["- Agent: Tony (Online, responsive)", "- Modes: six presets in modes.json"],
                    sc.SUPERSEDED: ["- 2026-11-19: Web dashboard only (no CLI dashboard) -> vanilla JS SPA frontend (arch-pending)"]}
    reply = section_reply(rel, sections, entities=ents)
    reply["superseded_facts"] = [{"old": "Web dashboard only", "new": "vanilla JS SPA frontend", "reason": "x"}] if t.kind == "project" else []
    return json.dumps(reply)


class BlockedShapesV3ReplayTests(CuratedBase):
    def test_r6_shapes_never_reach_the_preview_and_apply_validates(self):
        res, events, llm = self.dry(FakeLLM([r6_shape_reply] * 64))
        prev = Path(res["preview_dir"])
        prompts = json.dumps([user_text(m) for m in llm.calls])
        self.assertIn("Planned: Hub backed up twice", prompts, "ROADMAP lines reach the model tagged as plans")
        self.assertIn(offload.PLAN_HINT, prompts)
        self.assertNotIn("ZentrovaLabs", prompts, "the STATUS MCP-root line is a private name: filtered from the hub input")
        scrolls = {r["rel"]: sc.parse((prev / "scrolls" / r["rel"]).read_text(encoding="utf-8")).body for r in res["proposed"]["targets"]}
        kg = (prev / "kg-preview.jsonl").read_text(encoding="utf-8")
        hub = scrolls[HUBP.rel]
        self.assertEqual(sc.section_bullets(hub, ["Current Milestone"]), [], "a roadmap goal is never the milestone")
        ot = sc.section_bullets(hub, ["Open Threads"])
        self.assertIn("- Planned: Hub backed up twice; MASTER_IDENTITY v1 and AGENTS_NEVER reviewed", ot)
        self.assertIn("- Planned: Phase 7: desktop app over the overlay network, later", ot)
        self.assertIn("- (needs Nic's approval) Catalog: Needs export to Google Sheets, fix two rows, delete clutter skills", ot)
        self.assertIn("- (needs Nic's approval) One backup exists; second backup pending (external drive or Google Drive)", ot)
        self.assertIn("- MASTER_IDENTITY v1 and AGENTS_NEVER need final review before lock", sc.section_bullets(hub, ["Active State"]), "the dated status wins")
        self.assertEqual(sc.section_bullets(hub, ["Key Paths"]), ["- Root: C:\\ai-hub"])
        for v in ("Online", "2026-11-19T07:43", "ZentrovaLabs", "Scene reader\\scene-reader", "Same (merged", "vanilla JS SPA", "remove it", "re-download"):
            self.assertNotIn(v, "\n".join(scrolls.values()) + kg, v)
        self.assertNotIn("AGENTS_NEVER reviewed", kg, "a plan is never a KG observation")
        arch = scrolls[ARCH.rel]
        self.assertEqual(sc.section_bullets(arch, ["Locked Design Decisions"]), ["- Gateway binds to 127.0.0.1 only"])
        g = sc.section_bullets(arch, ["Guardrails"])
        self.assertIn("- (unconfirmed) ai-hub is the single source of truth", g)
        self.assertIn("- (unconfirmed) Identity changes only through the Librarian", g)
        self.assertIn("- Never delete files; move them to review instead", g)
        self.assertFalse([x for x in g if "Repoint" in x], "an imperative is never a guardrail")
        less = scrolls[LESS.rel]
        self.assertEqual(sc.section_bullets(less, ["Fixes", "Failure Modes"]), ["- Qwen 2.5 Coder emits text instead of tool calls; fix: build in small stages"])
        ident = scrolls[IDENT.rel]
        self.assertEqual(sc.section_bullets(ident, [sc.SUPERSEDED]), [], "a brand-new scroll supersedes nothing")
        self.assertIn("- (unconfirmed) Decision Style: changes only through the Librarian", sc.section_bullets(ident, ["Identity"]))
        proj = scrolls[PROJ.rel]
        self.assertEqual(sc.section_bullets(proj, ["Key Paths"]), ["- Repo: D:\\Art Apps\\agentic os"])
        self.assertIn("- GCP DevOps multi-region e-commerce platform stack (GKE Autopilot, Cloud SQL)", sc.section_bullets(proj, ["Active State"]), "not a path: out of Key Paths")
        self.assertEqual(sc.section_bullets(proj, [sc.SUPERSEDED]), [])
        report = json.loads((prev / "report.json").read_text(encoding="utf-8"))
        content = report["guards"]["removed"]["content"]
        for k in ("plan_moved", "imperative_moved", "imperative_dropped", "transient_dropped", "path_label_dropped", "superseded_fact_new_scroll"):
            self.assertGreaterEqual(content.get(k, 0), 1, (k, content))
        self.assertIn("hub_denied", json.dumps(report["privacy"]))
        code, lines = self.apply(res["token"])
        self.assertEqual(code, 0, lines[-1])

    def test_apply_refuses_a_preview_that_skipped_the_v3_guards(self):
        keep = lambda t, body, cur="", idx=None, new=False, policy=None: (body, Counter())  # noqa: E731
        with mock.patch.object(guards, "content_body", keep), mock.patch.object(guards, "content_entities", lambda e, idx=None: (list(e), Counter())):
            res, _, _ = self.dry(FakeLLM([r6_shape_reply] * 64))
        prev = Path(res["preview_dir"])
        self.assertIn("Hub backed up twice", (prev / "scrolls" / HUBP.rel).read_text(encoding="utf-8"))
        tree = self.sb.tree()
        code, lines = self.apply(res["token"])
        self.assertEqual(code, 2)
        self.assertIn("holds content the content guards remove", lines[-1]["error"])
        self.assertNotIn("backed up", lines[-1]["error"], "kinds and counts only")
        self.assertEqual(self.sb.tree(), tree)


# ── 3. guards v3 units ──────────────────────────────────────────────────────


class ContentGuardTests(unittest.TestCase):
    def test_imperatives(self):
        for s in ("- Catalog: Needs export to Google Sheets, fix two rows, delete clutter skills", "- multi-account-gmail-mcp failed at drafting; remove it",
                  "- Pixtral load failed; re-download and check", "- Back up the hub to Google Drive", "- Send the weekly digest to the group",
                  "- Change the MCP config to use port 1235", "- second backup pending (external drive or Google Drive)", "- Upload the build to GitHub"):
            self.assertIsNotNone(guards.imperative_kind(s), s)
        for s in ("- Never delete files; move them to review instead", "- Ask before deleting anything", "- Sync: scrolls are the only layer synced to librarian",
                  "- Post-processing runs after the build", "- Send button is disabled while muted", "- Download speeds are slow on the hotspot",
                  "- Exports go through approve()", "- WhatsApp stays read-only; never send", "- Build apps in small stages and test each stage",
                  "- Restart LM Studio after loading a model", "- Removed the old MCP server", "- Backups are written to D:\\ai-hub-archive",
                  "- Mutating actions forward messages only after a readBack confirmation",
                  "- **Librarian read-only allowlist:** Reads from `tasks.db` (SELECT only), `memory`. No write, embed, upload, or delete path.",
                  "- **No mutating plan without approve():** `approve()` gates all writes (email, messages, calendar, ledger Run).",
                  "- **State (gitignored):** `state.json` holds watermarks, archive pin, sync ledger and `last_run`.",
                  "- Gmail skill (Apps Script bridge): drafts work. Send, reply and trash are OFF.", "- Email triage runs via the Gmail bridge"):
            self.assertIsNone(guards.imperative_kind(s), s)

    def test_imperatives_body_by_kind(self):
        line = "- Catalog: delete clutter skills"
        body = section_reply(PROJ.rel, {"Locked Decisions": [line], "Active State": ["- Modes: six presets"]})["updated_markdown"]
        out, c = guards.imperatives_body(PROJ, body)
        self.assertEqual(sc.section_bullets(out, ["Locked Decisions"]), [])
        self.assertEqual(sc.section_bullets(out, ["Open Threads"]), ["- (needs Nic's approval) Catalog: delete clutter skills"])
        self.assertEqual(c, Counter({"imperative_moved": 1}))
        self.assertEqual(guards.imperatives_body(PROJ, out), (out, Counter()), "a fixed point")
        for t, sec in ((LESS, "Fixes"), (ARCH, "Guardrails"), (IDENT, "Standing Rules")):
            body = section_reply(t.rel, {sec: [line, "- Never delete files"]})["updated_markdown"]
            out, c = guards.imperatives_body(t, body)
            self.assertEqual(sc.section_bullets(out, [sec]), ["- Never delete files"], t.rel)
            self.assertEqual(c, Counter({"imperative_dropped": 1}))
        # An existing scroll's line is never touched.
        body = section_reply(LESS.rel, {"Fixes": [line]})["updated_markdown"]
        self.assertEqual(guards.imperatives_body(LESS, body, body)[1], Counter())

    def test_contested_6_and_widened_4(self):
        pol = stale_claims.default_policy()
        self.assertEqual(pol.version, 4)
        for s in ("- ai-hub is the single source of truth", "- Single source of truth: C:\\ai-hub", "- The hub is the single source of truth for everything"):
            self.assertEqual(getattr(pol.match(s), "id", None), "contested-hub-single-source", s)
        for s in ("- ai-hub is the single source of truth for operator rules and hub layout", "- The hub is the single source of truth (rules, identity)",
                  "- AGENTS.md is the single source of truth for the codebase"):
            self.assertIsNone(pol.match(s), s)
        for s in ("- Identity changes only through the Librarian", "- Only the Librarian edits rules", "- Only the Librarian changes identity files",
                  "- Librarian is the ONLY agent that writes rules.", "- Decision Style: changes only through the Librarian", "- Rule edits go only via the Librarian"):
            self.assertEqual(getattr(pol.match(s), "id", None), "contested-librarian-sole-writer", s)
        for s in ("- Librarian is read-only; it never writes", "- The Librarian reads the hub only", "- Scrolls are the only layer synced to the librarian workspace"):
            self.assertIsNone(pol.match(s), s)
        r = next(x for x in pol.rules if x.id == "contested-hub-single-source")
        self.assertEqual((r.action, r.ref, r.existing), ("demote", "#6", True))

    def test_superseded_hygiene(self):
        self.assertTrue(guards.noop_change("Standing Rules: Audit Trail, Resilience", "Standing Rules: Same (merged budget/tech constraints)"))
        self.assertTrue(guards.noop_change("Port 1235", "port  1235"))
        self.assertTrue(guards.noop_change("Voice: Kokoro", "unchanged"))
        for o, n in (("Port 1234", "Port 1235"), ("Web dashboard only", "vanilla JS SPA"), ("Port 8080", "none"), ("Model: X", "Same model family, 9B")):
            self.assertFalse(guards.noop_change(o, n), (o, n))
        log = ["- 2026-11-19: Port 1234 -> Port 1235 (arch-pending)", "- 2026-11-19: Standing Rules: a -> Standing Rules: Same (arch-pending)",
               f"- 2026-11-19: Old rule -> {guards.STALE_LOG_MARK} x #1) (arch-pending)"]
        body = section_reply(ARCH.rel, {"Ports & Services": ["- LM Studio on :1235"], sc.SUPERSEDED: log})["updated_markdown"]
        out, c = guards.superseded_body(body, "", new_scroll=True)
        self.assertEqual(sc.section_bullets(out, [sc.SUPERSEDED]), [log[2]], "only a host stale-filter line in a brand-new scroll")
        self.assertEqual(c, Counter({"new_scroll": 2}))
        old = section_reply(ARCH.rel, {"Ports & Services": ["- LM Studio on :1234"]})["updated_markdown"]
        out, c = guards.superseded_body(body, old, new_scroll=False)
        self.assertEqual(sc.section_bullets(out, [sc.SUPERSEDED]), [log[0], log[2]])
        self.assertEqual(c, Counter({"noop": 1}))
        facts = [{"old": "Port 1234", "new": "Port 1235"}, {"old": "X: a", "new": "X: same"}, {"old": "same", "new": "same"}]
        self.assertEqual(guards.superseded_facts(facts, False), ([facts[0]], Counter({"noop": 2})))
        self.assertEqual(guards.superseded_facts(facts, True), ([], Counter({"new_scroll": 3})))

    def test_transient_status_and_key_paths(self):
        for s in ("- Agent: Tony (Online, responsive)", "- System Status: Online (2026-11-19T07:43)", "- Gateway is online now", "- Last checked 2026-11-19 07:43",
                  "- Last updated: 2026-11-15 by Claude.", "- Planned: Rewritten fresh 2026-11-14.", "- Notes folder is 7 KB today"):
            self.assertTrue(guards.transient_kind(s), s)
        for s in ("- Offline-first maps with cached tiles", "- Works offline when the hotspot drops", "- Kill switch blocks online research", "- 2026-11-19: Port 1234 -> 1235"):
            self.assertFalse(guards.transient_kind(s), s)
        self.assertTrue(guards.wrong_path_label("- Models: D:\\Projects\\Scene reader\\scene-reader-v3.0.0"))
        for s in ("- Models: C:\\Users\\x\\.lmstudio\\models", "- Models: D:\\ai\\models", "- Model store: D:\\llm\\gguf\\qwen.gguf", "- Repo: D:\\Art Apps\\agentic os"):
            self.assertFalse(guards.wrong_path_label(s), s)
        body = section_reply(PROJ.rel, {"Key Paths": ["- Repo: D:\\Art Apps\\agentic os", "- LM Studio on :1235", "- GKE stack for the store", "- Models: D:\\Projects\\app"],
                                        "Active State": ["- Agent: Tony (Online, responsive)", "- Modes: six presets"]})["updated_markdown"]
        out, c = guards.status_paths_body(PROJ, body)
        self.assertEqual(sc.section_bullets(out, ["Key Paths"]), ["- Repo: D:\\Art Apps\\agentic os", "- LM Studio on :1235"])
        self.assertEqual(sc.section_bullets(out, ["Active State"]), ["- Modes: six presets", "- GKE stack for the store"])
        self.assertEqual(c, Counter({"transient_dropped": 1, "no_path_moved": 1, "path_label_dropped": 1}))
        self.assertEqual(guards.status_paths_body(PROJ, out), (out, Counter()))

    def test_plans_and_status_wins(self):
        idx = guards.PlanIndex(["- Planned: Hub backed up twice", "- Planned: MASTER_IDENTITY v1 and AGENTS_NEVER reviewed", "- Planned: Gemini curation of the skills catalog"],
                               ["- MASTER_IDENTITY v1 and AGENTS_NEVER need final review", "- Gemini curation of the skills catalog done"])
        self.assertTrue(idx.from_plan("- Hub backed up twice"))
        self.assertTrue(idx.from_plan("- MASTER_IDENTITY v1 and AGENTS_NEVER reviewed"))
        self.assertFalse(idx.from_plan("- MASTER_IDENTITY v1 and AGENTS_NEVER need final review"), "the status line says it better")
        self.assertFalse(idx.from_plan("- Gemini curation of the skills catalog done"), "STATUS wins over ROADMAP")
        self.assertFalse(idx.from_plan("- LM Studio serves Qwen on :1235"))
        body = section_reply(HUBP.rel, {"Current Milestone": ["- Hub backed up twice"], "Active State": ["- Planned: Phase 7 app"]})["updated_markdown"]
        out, c = guards.plans_body(HUBP, body, "", idx)
        self.assertEqual(sc.section_bullets(out, ["Open Threads"]), ["- Planned: Hub backed up twice", "- Planned: Phase 7 app"])
        self.assertEqual(c, Counter({"plan_moved": 2}))
        ents, c = guards.content_entities([{"name": "Hub", "entityType": "project", "observations": ["Hub backed up twice", "Root is C:\\ai-hub"]}], idx)
        self.assertEqual((ents[0]["observations"], c), (["Root is C:\\ai-hub"], Counter({"plan_kg": 1})))
        self.assertEqual(offload.tag_plan_lines("## Phase 1\n- Hub backed up twice\n1. Review\nPlain goal\n\n- Planned: kept"),
                         "## Phase 1\n- Planned: Hub backed up twice\n1. Planned: Review\nPlanned: Plain goal\n\n- Planned: kept")

    def test_prompt_rules_17_to_19(self):
        p = distill.system_prompt("qwen/qwen3.5-9b")
        self.assertIn("17 Key Paths and Repo Paths hold only real filesystem paths", p)
        self.assertIn("a path labelled Models must be a model store", p)
        self.assertIn("18 A roadmap, plan or goal line", p)
        self.assertIn("the status file wins", p)
        self.assertIn("19 A line telling an agent to delete, remove, download, upload, export, send, change config", p)
        self.assertNotIn("Nic", p, "the prompt never names the user")

    def test_missing_superseded_heading_repaired_only_when_nothing_can_be_lost(self):
        reply = section_reply(HUBP.rel, {"Key Paths": ["- Root: C:\\ai-hub"]})
        reply["updated_markdown"] = reply["updated_markdown"].split(f"## {sc.SUPERSEDED}")[0].rstrip() + "\n"
        llm = FakeLLM([reply])
        reasons, merged, *_ = compact.distill_target(llm, HUBP, None, "Concept: x", "arch-2026-11-19-01", NOW_ISO, [], {}, {"used": 0, "max": 4, "save": lambda: None})
        self.assertEqual(reasons, [])
        self.assertEqual(sc.h2_list(merged.body)[-1], sc.SUPERSEDED)
        log = "- 2026-11-18: Port 1234 -> Port 1235 (arch-2026-11-18-01)"
        old = sc.Scroll(HUBP.scroll_id, HUBP.category, NOW_ISO, 1, ["arch-2026-11-18-01"], [], section_reply(HUBP.rel, {sc.SUPERSEDED: [log]})["updated_markdown"])
        self.assertEqual(guards.ensure_superseded_heading(HUBP, reply["updated_markdown"], old.body), (reply["updated_markdown"], False))
        reasons, merged, *_ = compact.distill_target(FakeLLM([reply, reply]), HUBP, old, "Concept: x", "arch-2026-11-19-01", NOW_ISO, [], {}, {"used": 0, "max": 4, "save": lambda: None})
        self.assertIsNone(merged, "a log that could be lost: still rejected")
        self.assertTrue(any("missing heading ## Superseded Decisions" in r for r in reasons), reasons)

    def test_demoted_kg_observation_is_a_fixed_point(self):
        # Live preview 20261119-225111: the KG "Librarian" observation, already "(unconfirmed)", was
        # counted as demoted again by --apply's re-check, so the whole preview was refused.
        ents = [{"name": "Librarian", "entityType": "tool", "observations": ["Only agent authorized to write rules", "Uses Gemini initially"]}]
        once, _, dem = guards.stale_entities(ents)
        self.assertEqual((dict(dem), once[0]["observations"][0]), ({"contested-librarian-sole-writer": 1}, "(unconfirmed) Only agent authorized to write rules"))
        again, _, dem = guards.stale_entities(once)
        self.assertEqual((again, dict(dem)), (once, {}))
        self.assertEqual(guards.check_preview(ARCH, section_reply(ARCH.rel, {"Guardrails": ["- Never send"]})["updated_markdown"], once, ""), Counter())

    def test_stacked_host_marks_are_a_fixed_point(self):
        # A contested claim that is also an agent to-do: demoted out of Locked as "(unconfirmed)", then
        # marked "(needs Nic's approval)"; --apply's re-check must not mark it again.
        line = "- Only the Librarian edits rules; delete stale rule files"
        body = section_reply(PROJ.rel, {"Locked Decisions": [line], "Key Paths": ["- Repo: D:\\Art Apps\\agentic os"]})["updated_markdown"]
        body, _, dem, _ = guards.stale_body(PROJ, body, "")
        self.assertEqual(sum(dem.values()), 1)
        body, c = guards.content_body(PROJ, body, "", None, True)
        self.assertEqual(sc.section_bullets(body, ["Open Threads"]), ["- (needs Nic's approval) (unconfirmed) Only the Librarian edits rules; delete stale rule files"])
        self.assertEqual(guards.check_preview(PROJ, body, [], ""), Counter())
        self.assertEqual(stale_claims.unconfirmed("- Planned: (unconfirmed) x"), "- Planned: (unconfirmed) x")
        self.assertEqual(stale_claims.unconfirmed("- Planned: x"), "- (unconfirmed) Planned: x")

    def test_host_marks_are_not_prompt_echoes(self):
        line = "- (needs Nic's approval) multi-account-gmail-mcp failed at drafting; remove it"
        body = section_reply(PROJ.rel, {"Open Threads": [line, "- Planned: Phase 7 app"]})["updated_markdown"]
        out, removed = distill.strip_prompt_echo(body, ["multi-account-gmail-mcp failed at drafting; remove it", "Planned: Phase 7 app"], "")
        self.assertEqual(removed, [])


# ── 4. privacy v6: multi-word deny terms ────────────────────────────────────


class MultiWordDenyTermTests(unittest.TestCase):
    def setUp(self):
        self.sb = Sandbox(key=None)
        for rel, text in (("master/MASTER_IDENTITY.md", MI), ("master/STATUS.md", STATUS), ("master/SYSTEM.md", HUB["master/SYSTEM.md"])):
            (self.sb.root / "hub" / rel).write_text(text, encoding="utf-8")

    def tearDown(self):
        self.sb.close()

    def test_status_mcp_root_line_and_variants(self):
        self.assertEqual(privacy_policy.POLICY_VERSION, 7)
        terms, _ = offload.hub_auto_terms(self.sb.env)
        self.assertIn("zentrova labs", terms)
        self.assertIn("Green Leaf", terms, "a phrase of ordinary words stays a name-only term")
        pol, _ = offload.effective_privacy(self.sb.paths(), self.sb.env)
        status_line = STATUS.split("\n")[3]
        self.assertIn("ZentrovaLabs", status_line)
        self.assertEqual(privacy.check_line(status_line, pol)[0], privacy_policy.HUB_DENIED, "the hub STATUS MCP filesystem-root line")
        for s in ("- Site lives in D:\\Sites\\zentrova-labs\\", "- Store: zentrova_labs bucket", "- Folder: zentrovalabs", "- Planning the Zentrova Labs launch",
                  "- Sells through ZENTROVA LABS", "- Store: Zentrova.Labs", "- Sync to D:\\Sites\\MyZentrovaLabsSite", "- Orders through GreenLeaf",
                  "- Orders through Green-Leaf.example", "- Sells via Green Leaf on weekends"):
            self.assertEqual(privacy.check_line(s, pol)[0], privacy_policy.HUB_DENIED, s)
        for s in ("- A green leaf icon marks synced scrolls", "- Fresh green-leaf salad mix", "- Keep the leaf nodes green", "- Labs page lists experiments",
                  "- Zentrovan is not the name"):
            self.assertIsNone(privacy.check_line(s, pol)[0], s)
        self.assertNotIn("zentrova", json.dumps(privacy.describe(pol)).lower())

    def test_paid_plan_tier_is_finance(self):
        pol = privacy.default_policy()
        for s in ("- Chat app: Ultra plan (Premium being considered).", "- On the Pro plan for the chat app", "- Upgrading to Premium next month", "- Paid tier for the API"):
            self.assertEqual(privacy.check_line(s, pol)[0], "finance", s)
        for s in ("- Free-tier first; never recommend paid services without warning", "- Free tier only for the API", "- Brave search: free monthly credit",
                  "- Project plan: Phase 2 protocols", "- Pro Tools session template"):
            self.assertNotEqual(privacy.check_line(s, pol)[0], "finance", s)

    def test_override_multi_word_terms_are_spacing_insensitive(self):
        (self.sb.root / "state" / "privacy-policy.json").write_text(json.dumps({"deny_terms": ["quill moth"]}), encoding="utf-8")
        pol = privacy.load(self.sb.root / "state")
        for s in ("- QuillMoth sells prints", "- path D:\\x\\quill-moth\\", "- quill_moth", "- Quill Moth"):
            self.assertEqual(privacy.check_line(s, pol)[0], privacy_policy.CUSTOM, s)
        self.assertIsNone(privacy.check_line("- A quilted moth pattern", pol)[0])


# ── 5. round-6 review fixes (synthetic data only) ───────────────────────────


def _chat_msgs(start: int, n: int) -> list:
    return [{"id": f"m{i:05d}", "role": "user" if i % 2 else "assistant", "agent": "hermes", "content": f"MSG-{i} the HUD pill",
             "timestamp": f"2026-11-19T10:{(i // 60) % 60:02d}:{i % 60:02d}.000001+00:00"} for i in range(start, start + n)]


class GatewayWatermarkTests(unittest.TestCase):
    """server.py keeps only the last 200 chat messages: the watermark is the last message's id."""

    def setUp(self):
        import tempfile
        self.td = tempfile.TemporaryDirectory()
        self.chat = Path(self.td.name) / "chat-history.json"

    def tearDown(self):
        self.td.cleanup()

    def write(self, msgs):
        self.chat.write_text(json.dumps({"messages": msgs[-200:]}), encoding="utf-8")  # the server's trim

    def texts(self, recs):
        return [r["text"].split(": ", 1)[1] for r in recs]

    def test_trim_never_skips_new_messages(self):
        msgs = _chat_msgs(0, 150)
        self.write(msgs)
        recs, wm, note = sources.gateway_chat(self.chat, 0, [])
        self.assertEqual((len(recs), note), (150, {}))
        self.assertEqual(wm["id"], "m00149")
        # 60 new messages: the file is trimmed to 200 and the new ones sit at 140..199.
        msgs += _chat_msgs(150, 60)
        self.write(msgs)
        recs, wm, note = sources.gateway_chat(self.chat, wm, [])
        self.assertEqual(self.texts(recs), [f"MSG-{i} the HUD pill" for i in range(150, 210)], "no new message skipped")
        self.assertEqual((wm["id"], note), ("m00209", {}))
        # At the cap: every new message lands at index 199 and is still read.
        for i in range(210, 213):
            msgs += _chat_msgs(i, 1)
            self.write(msgs)
            recs, wm, note = sources.gateway_chat(self.chat, wm, [])
            self.assertEqual(self.texts(recs), [f"MSG-{i} the HUD pill"])
        recs, wm2, _ = sources.gateway_chat(self.chat, wm, [])
        self.assertEqual((recs, wm2), ([], wm), "nothing new: nothing read, the mark stays")
        # Records keep who spoke and the message id.
        self.assertEqual(sources.gateway_chat(self.chat, 0, [])[0][-1]["meta"], {"role": "assistant", "agent": "hermes", "id": "m00212"})

    def test_mark_trimmed_away_reads_everything_newer_and_says_so(self):
        msgs = _chat_msgs(0, 10)
        self.write(msgs)
        _, wm, _ = sources.gateway_chat(self.chat, 0, [])
        msgs += _chat_msgs(10, 300)  # the last archived message is long gone from the file
        self.write(msgs)
        recs, wm, note = sources.gateway_chat(self.chat, wm, [])
        self.assertEqual(len(recs), 200)
        self.assertEqual(note, {"watermark_trimmed": True})
        self.assertEqual(wm["id"], "m00309")

    def test_legacy_count_watermark(self):
        self.write(_chat_msgs(0, 5))
        recs, wm, note = sources.gateway_chat(self.chat, 3, [])
        self.assertEqual((self.texts(recs), note), (["MSG-3 the HUD pill", "MSG-4 the HUD pill"], {}))
        self.assertEqual(wm["id"], "m00004")
        recs, _, note = sources.gateway_chat(self.chat, 70, [])
        self.assertEqual((len(recs), note), (5, {"watermark_trimmed": True}), "a count past the end: every message is new")


class LosslessArchiveOnlyTests(unittest.TestCase):
    """Step A archives whole source objects (no field, system turn or byte lost); Booking stays out."""

    def setUp(self):
        import tempfile
        self.td = tempfile.TemporaryDirectory()
        self.root = Path(self.td.name)

    def tearDown(self):
        self.td.cleanup()

    def test_threads_raw_keeps_every_field_and_system_turns(self):
        base = 1794939000000
        relay = {**turn(base + 1, "agent", "Relaying to the coder"), "from": "os", "to": "coder", "role": "relay", "meta": {"lane": "build"}, "tone": "calm"}
        system = turn(base + 2, "system", "system bookkeeping line")
        to_booking = {**turn(base + 3, "agent", "Relaying the client list"), "from": "os", "to": "booking"}
        mixed = turn(base + 4, "user", "keep the HUD pill\nask the booking desk later")
        p = self.root / "os-threads.json"
        p.write_text(json.dumps({"threads": {"general": [relay, system, to_booking, mixed]}}), encoding="utf-8")
        recs, wm, note = sources.threads(p, {}, [], raw=True)
        self.assertEqual(wm["general"], [base + 4, f"t{base + 4}"])
        raws = [json.loads(r["meta"]["raw"]) for r in recs]
        self.assertEqual([r["id"] for r in raws], [relay["id"], system["id"], mixed["id"]], "the Booking relay is skipped whole")
        self.assertEqual({k: raws[0][k] for k in ("from", "to", "role", "meta", "tone")}, {"from": "os", "to": "coder", "role": "relay", "meta": {"lane": "build"}, "tone": "calm"})
        self.assertTrue(recs[1]["meta"]["system"])
        self.assertNotIn("booking", json.dumps(recs).lower())
        # Compaction (not raw) is unchanged: no system turn, no raw copy.
        recs2, wm2, _ = sources.threads(p, {}, [])
        self.assertEqual(([r["meta"]["id"] for r in recs2], wm2), ([relay["id"], to_booking["id"], mixed["id"]], wm))
        self.assertFalse(any("raw" in r["meta"] for r in recs2))

    def test_gateway_and_training_logs_raw(self):
        chat = self.root / "chat-history.json"
        chat.write_text(json.dumps({"messages": [{"id": "a1b2c3d4", "role": "assistant", "agent": "opencode", "content": "built it\nthe booking desk said hi",
                                                  "timestamp": "2026-11-19T10:00:00+00:00", "extra": {"model": "local"}}]}), encoding="utf-8")
        recs, _, _ = sources.gateway_chat(chat, 0, [], raw=True)
        raw = json.loads(recs[0]["meta"]["raw"])
        self.assertEqual((raw["agent"], raw["id"], raw["extra"]), ("opencode", "a1b2c3d4", {"model": "local"}))
        self.assertNotIn("booking", recs[0]["meta"]["raw"].lower())
        logs = self.root / "training_logs"
        logs.mkdir()
        long_line = json.dumps({"role": "coder", "text": "x" * (40 * 1024)})
        (logs / "a.jsonl").write_bytes(long_line.encode("utf-8") + b"\n" + b'{"role": "coder", "text": "bad \xff\xfe byte"}\r\n')
        recs, wm, _ = sources.training_logs(logs, {}, [], raw=True)
        self.assertEqual(recs[0]["text"], long_line, "never clipped")
        self.assertEqual(recs[1]["text"], '{"role": "coder", "text": "bad \\xff\\xfe byte"}')
        self.assertEqual((recs[1]["meta"].get("utf8_invalid"), recs[0]["meta"].get("utf8_invalid")), (True, None))
        self.assertEqual(wm["a.jsonl"], (logs / "a.jsonl").stat().st_size)
        clipped, _, _ = sources.training_logs(logs, {}, [])
        self.assertLess(len(clipped[0]["text"]), len(long_line), "compaction still clips its distill copy")


class FakeAllmReader:
    def __init__(self, chats=0, fail_chats=False, fail_ws=False):
        self.chats, self.fail_chats, self.fail_ws = chats, fail_chats, fail_ws

    def workspace(self, ws):
        if self.fail_ws:
            raise OSError("synthetic outage")
        return {"documents": []}

    def workspace_chats(self, ws):
        if self.fail_chats:
            raise OSError("synthetic outage")
        return [{"role": "user", "content": f"chat {i}", "sentAt": i, "attachments": []} for i in range(self.chats)]


class AllmArchiveOnlyTests(CuratedBase):
    def test_truncation_and_errors_are_reported(self):
        from memory_scrolls.allm import CHATS_LIMIT
        _, chats, notes = offload.gather_allm(FakeAllmReader(chats=CHATS_LIMIT), ["coder"], [], with_content=False, raw_chats=True)
        self.assertEqual(len(chats), CHATS_LIMIT)
        self.assertEqual(json.loads(chats[0]["meta"]["raw"])["attachments"], [])
        self.assertTrue(notes["workspaces"]["coder"]["chats_truncated"])
        self.assertIn("cut at", offload.allm_incomplete(notes)[0])
        for reader in (FakeAllmReader(fail_chats=True), FakeAllmReader(fail_ws=True)):
            _, _, notes = offload.gather_allm(reader, ["coder"], [], with_content=False)
            self.assertIn("unreadable", offload.allm_incomplete(notes)[0])
        self.assertEqual(offload.allm_incomplete(offload.gather_allm(FakeAllmReader(chats=3), ["coder"], [], with_content=False)[2]), [])

    def test_apply_stops_when_chats_cannot_be_read(self):
        res, _, _ = self.dry()
        with mock.patch.object(offload.AllmReader, "workspace_chats", side_effect=OSError("synthetic outage")):
            code, lines = self.apply(res["token"])
        self.assertEqual(code, 1, lines[-1])
        self.assertIn("AnythingLLM chats could not be read", lines[-1]["error"])
        self.assertFalse(any((self.sb.root / "scrolls").rglob("*.md")), "nothing promoted")
        st = self.state()
        self.assertEqual((st["watermarks"]["threads"], st["watermarks"]["gateway_chat"]), ({}, 0))
        self.assertNotIn("offload_seed", st)

    def test_apply_records_a_truncated_chat_history(self):
        from memory_scrolls.allm import CHATS_LIMIT
        res, _, _ = self.dry()
        rows = [{"role": "user", "content": f"chat {i}", "sentAt": i} for i in range(CHATS_LIMIT)]
        with mock.patch.object(offload.AllmReader, "workspace_chats", return_value=rows):
            code, lines = self.apply(res["token"])
        self.assertEqual(code, 0, lines[-1])
        self.assertTrue(any("cut at" in w for w in lines[-1]["warnings"]), lines[-1]["warnings"])
        self.assertTrue(any("cut at" in x for x in self.state()["offload_seed"]["incomplete"]))


class Round6GuardTests(unittest.TestCase):
    def test_noun_lists_label_gates_and_nothing_rules(self):
        for s in ("- **approve() still gates every mutating plan:** email, messages, calendar, `requestBuild`", "- Tony handles chat, email and calendar",
                  "- Lanes: chat, email, calendar", "- The worker supports backup, sync and export", "- Email, calendar and chat are wired",
                  "- Delete nothing outside staging/", "- Rule: delete nothing outside the staging dir", "- Remove none of the scrolls by hand"):
            self.assertIsNone(guards.imperative_kind(s), s)
        for s in ("- Back up and sync", "- Sync", "- Lanes: chat, email, delete the logs", "- Export, then delete the cache", "- **Next:** delete clutter skills",
                  "- Email the digest to the group, then archive it"):
            self.assertIsNotNone(guards.imperative_kind(s), s)
        body = section_reply(ARCH.rel, {"Guardrails": ["- **approve() still gates every mutating plan:** email, messages, calendar", "- Delete nothing outside staging/"]})["updated_markdown"]
        out, c = guards.imperatives_body(ARCH, body)
        self.assertEqual((out, c), (body, Counter()), "standing guardrails are kept")

    def test_superseded_real_changes_starting_same_or_kept(self):
        real = (("Gateway over HTTP", "Same port, HTTPS only"), ("Voice: Kokoro", "Same voice plus a Whisper fallback"),
                ("Librarian writes rules", "Same, but every change needs approve()"), ("Brave search", "Kept for now; SearXNG later"),
                ("Web search: Brave now, self-host SearXNG later", "Web search: Kept Brave, SearXNG plan dropped"), ("X", "Same (now HTTPS only)"))
        for o, n in real:
            self.assertFalse(guards.noop_change(o, n), (o, n))
        for o, n in (("a", "Same as before."), ("a", "(unchanged)"), ("a", "kept as is"), ("a", "No change"), ("X: a", "X: Same (merged notes)")):
            self.assertTrue(guards.noop_change(o, n), (o, n))
        facts = [{"old": o, "new": n} for o, n in real]
        self.assertEqual(guards.superseded_facts(facts, False), (facts, Counter()))

    def test_design_facts_are_not_transient(self):
        for s in ("- Maps are offline-first with cached OSM tiles", "- STT and TTS are offline (no cloud calls)", "- Voice stack is offline-only",
                  "- Agent: offline mode uses the local model", "- Kill switch: state = offline blocks all cloud calls"):
            self.assertFalse(guards.transient_kind(s), s)
        for s in ("- Gateway is offline", "- Status: offline since 07:43", "- Gateway is currently offline", "- Agent: offline", "- Server: down; restart pending"):
            self.assertTrue(guards.transient_kind(s), s)

    def test_status_next_steps_are_plans_not_the_status_that_wins(self):
        status = ("# STATUS\n\n## Working\n- Gemini curation of the skills catalog done\n\n"
                  "## Next steps (in order)\n1. Export catalog to Google Sheets, fix the two rows\n2. Second backup to the external drive\n")
        by_target, counts = offload.hub_sections("master/STATUS.md", status)
        self.assertEqual(counts["plan_sections"], 1)
        text = "\n\n".join(by_target[offload.HUB_PROJECT])
        self.assertIn("1. Planned: Export catalog to Google Sheets, fix the two rows", text)
        self.assertIn("- Gemini curation of the skills catalog done", text, "a status section is never tagged")
        roadmap = offload.tag_plan_lines("## Phase 2\n- Catalog in Google Sheets\n- Gemini curation of the skills catalog")
        idx = guards.plan_lines([{"meta": {"hint": "hub"}, "text": text}, {"meta": {"hint": "hub", "plan": True}, "text": roadmap}])
        self.assertTrue(idx.from_plan("- Catalog in Google Sheets"))
        self.assertTrue(idx.from_plan("- Catalog exported to Google Sheets and two rows fixed"), "a pending to-do stated as done")
        self.assertFalse(idx.from_plan("- Gemini curation of the skills catalog done"), "a dated status line still wins")
        recs = [{"kind": "doc", "meta": {"hint": "hub", "plan": False, "plan_sections": True}, "text": text}]
        self.assertIn(offload.PLAN_HINT, offload.target_hint(recs, offload.HUB_PROJECT)[0])
        sha = offload.curated_allowlist_sha()
        with mock.patch.object(offload, "HUB_PLAN_SECTION", re.compile("x")):
            self.assertNotEqual(offload.curated_allowlist_sha(), sha, "the to-do section rule is bound into the allow-list hash")


R6_IDENTITY_MD = """# MASTER_IDENTITY - v1 (draft)
Rule: ask when unsure.

## VOICE
- No fluff.

## WEEKEND
- HARD STOP at six; Every Friday is the long walk.
- Dinner at the Light House cafe; the Light House has the view.
- Planning Quillmoth Prints with a friend; Quillmoth Prints sells cards.
"""
R6_SYSTEM_MD = "# SYSTEM\n\n## Voice\n- Esc is a stop key that is hard to miss\n- A lighthouse icon marks the scroll root\n"


class Round6AutoTermTests(unittest.TestCase):
    def test_ordinary_word_phrases_stay_name_only(self):
        sb = Sandbox(key=None)
        try:
            (sb.root / "hub" / "master" / "MASTER_IDENTITY.md").write_text(R6_IDENTITY_MD, encoding="utf-8")
            (sb.root / "hub" / "master" / "SYSTEM.md").write_text(R6_SYSTEM_MD, encoding="utf-8")
            terms, _ = offload.hub_auto_terms(sb.env)
            self.assertIn("Hard Stop", terms, "words the hub uses in lower case: a name-only phrase")
            self.assertIn("Light House", terms)
            self.assertIn("quillmoth prints", terms, "a private name still matches in every form")
            for t in ("hard stop", "light house", "every friday"):
                self.assertNotIn(t, terms)
            pol, _ = offload.effective_privacy(sb.paths(), sb.env)
            self.assertIn("Hard Stop", pol.auto_terms)
            for s in ("- Mic: Esc is a hard stop; voice re-arms only on click", "- `hardStopMic({rearm})` cuts every layer",
                      "- dictation.ts: hard-stop action calls hardStop()", "- Heartbeat runs every Friday at 9", "- A lighthouse icon marks the root",
                      "- Lighthouse audits run nightly"):
                self.assertIsNone(privacy.check_line(s, pol)[0], s)
            for s in ("- Dinner at the Light House on Fridays", "- Orders via LightHouse app", "- Site: D:\\Sites\\quillmoth-prints", "- QuillmothPrints shop"):
                self.assertEqual(privacy.check_line(s, pol)[0], privacy_policy.HUB_DENIED, s)
        finally:
            sb.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
