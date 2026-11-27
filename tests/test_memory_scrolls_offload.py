"""Memory Scrolls offload utility (`scripts/offload_rag_to_scrolls.py`): dry-run is GET-only, Booking-free
and writes only the preview; `--apply` needs the matching token, snapshots + verifies before any write,
embeds scrolls before un-embedding raw documents, and removes nothing when an earlier step fails.

All against stub servers and temp roots. Run with: python3 tests/run_all.py
"""

from __future__ import annotations

import json
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
sys.path.insert(0, str(REPO))
sys.path.insert(0, str(HERE))

from memory_scrolls import archive, offload  # noqa: E402
from memory_scrolls import scroll as sc  # noqa: E402
from memory_scrolls.errors import ArchiveError  # noqa: E402
from memory_scrolls_stubs import StubAllm, StubGateway, StubLMStudio, auto_reply  # noqa: E402
from test_memory_scrolls import SENTINEL_KEY, FakeLLM, Sandbox, noisy_threads, setUpModule, tearDownModule  # noqa: E402,F401

OS_JSON = {"anythingllm": {"workspaces": {"librarian": "librarian", "coder": "coder", "general": "my-workspace", "booking": "booking", "prompter": "prompter-dispatcher"}}}


def distill_set_pending(body: str) -> str:
    from memory_scrolls import distill

    return distill.set_notes(body, True)


def doc(name: str, title: str, words: int = 200) -> dict:
    return {"docpath": f"custom-documents/{name}", "filename": name, "metadata": json.dumps({"title": title, "wordCount": words})}


def stub_allm() -> StubAllm:
    return StubAllm(
        workspaces={
            "librarian": {"slug": "librarian", "documents": [doc("notes-a.json", "Agentic OS notes"), doc("booking-templates.json", "booking-templates.md")]},
            "coder": {"slug": "coder", "documents": [doc("build-log.json", "Coder build log")]},
            "prompter-dispatcher": {"slug": "prompter-dispatcher", "documents": []},
            "my-workspace": {"slug": "my-workspace", "documents": [doc("client.json", "BOOKING CLIENT LIST")]},
            "booking": {"slug": "booking", "documents": [doc("gig.json", "BOOKING GIG")]},
        },
        documents={
            "notes-a.json": "Locked: Whisper STT runs on port 8178\nNic prefers ultra-short acks\nNic always wants voice replies kept to one sentence\n" + "filler line\n" * 50,
            "build-log.json": "the coder build failed with an error in vite config; fix: pin vite 5\n" + "INFO step\n" * 40,
            "client.json": "BOOKING CLIENT LIST",
        },
        chats={"coder": [{"role": "user", "content": "make the status card blue", "sentAt": 1}]},
    )


class OffloadTests(unittest.TestCase):
    def setUp(self):
        self.allm = stub_allm().start()
        self.gw = StubGateway(active=False).start()
        self.sb = Sandbox(allm_url=self.allm.url, gateway_url=self.gw.url, os_json=OS_JSON)
        self.sb.threads(noisy_threads())
        (self.sb.root / "repo" / "brain").mkdir()
        (self.sb.root / "repo" / "brain" / "identity.md").write_text("# Identity\nNic prefers ultra-short acks\n", encoding="utf-8")
        (self.sb.root / "hub" / "master" / "SYSTEM.md").write_text("# System\nLM Studio on :1235 only\n", encoding="utf-8")
        (self.sb.root / "notes" / "anythingllm-prompt-backups").mkdir()
        (self.sb.root / "notes" / "anythingllm-prompt-backups" / "coder.md").write_text("PROMPT BACKUP", encoding="utf-8")
        self.preview = self.sb.root / "preview"

    def tearDown(self):
        self.sb.close()
        self.allm.stop()
        self.gw.stop()

    def dry(self, *extra):
        # These tests cover the full ("all") source mode: AnythingLLM documents distilled and un-embedded.
        # The curated seed (the default) has its own tests (test_memory_scrolls_curated.py).
        extra = extra if "--sources" in extra else (*extra, "--sources", "all")
        return self.sb.cli("offload", "--json", "--trace-requests", "--preview-dir", str(self.preview), *extra)

    def booking_free(self, reqs):
        for m, p in reqs:
            self.assertNotIn("my-workspace", p)
            self.assertNotIn("booking", p)
            self.assertNotIn("remove-documents", p)
            self.assertNotRegex(p, r"/v1/(documents|workspaces)\b")

    def test_dry_run_get_only_booking_free_preview_only(self):
        before = {p for p in self.sb.root.rglob("*")}
        code, lines = self.dry("--no-llm")
        self.assertEqual(code, 0, lines)
        res = lines[-1]
        self.assertEqual({m for m, _ in self.allm.requests}, {"GET"})
        self.booking_free(self.allm.requests)
        self.assertEqual([t["method"] for t in res["trace"]], ["GET"] * len(res["trace"]))
        self.assertEqual(res["workspaces_read"], ["coder", "librarian", "prompter-dispatcher"])
        self.assertEqual(res["raw"]["anythingllm_docs"]["count"], 2, "booking-templates doc skipped")
        self.assertEqual(res["raw"]["anythingllm_chats"]["count"], 1)
        self.assertGreater(res["raw"]["local"]["records"], 0)
        self.assertGreater(res["proposed"]["scrolls"], 0)
        self.assertRegex(res["token"], r"^[0-9a-f]{12}$")
        self.assertIn("--apply --confirm " + res["token"], res["apply_command"])
        self.assertEqual(res["llm"], "extractive")
        new = {p for p in self.sb.root.rglob("*")} - before
        self.assertTrue(new)
        for p in new:
            self.assertTrue(str(p).startswith(str(self.preview)), p)
        prev = Path(res["preview_dir"])
        md = list((prev / "scrolls").rglob("*.md"))
        self.assertTrue(md)
        text = "\n".join(p.read_text(encoding="utf-8") for p in md)
        self.assertIn("preview: extractive", text)
        self.assertNotIn("BOOKING", text)
        self.assertNotIn("PROMPT BACKUP", text)
        self.assertNotIn(SENTINEL_KEY, json.dumps(lines))
        for p in md:
            sc.parse(p.read_text(encoding="utf-8"))
        self.assertFalse((self.sb.root / "scrolls" / "core").exists())
        self.assertEqual(list((self.sb.root / "archive").iterdir()), [])
        self.assertFalse((self.sb.root / "state" / "state.json").exists())

    def test_dry_run_with_loaded_model(self):
        lm = StubLMStudio(replies=auto_reply).start()
        try:
            self.sb.env["AOS_LMSTUDIO_BASE"] = lm.url + "/v1"
            code, lines = self.dry()
            self.assertEqual(code, 0, lines)
            self.assertEqual(lines[-1]["llm"], "live")
            self.assertGreater(lm.count("POST", "/v1/chat/completions"), 0)
            self.assertEqual(lm.max_concurrency, 1)
            self.assertTrue(any(t["mode"] == "live" for t in lines[-1]["proposed"]["targets"]))
        finally:
            lm.stop()

    def test_no_key_skips_anythingllm(self):
        self.sb.env.pop("ANYTHINGLLM_API_KEY")
        code, lines = self.dry("--no-llm")
        self.assertEqual(code, 0, lines)
        self.assertEqual(self.allm.requests, [])
        self.assertIn("no AnythingLLM API key", lines[-1]["anythingllm"]["skipped"])

    def _apply(self, token, *extra):
        return self.sb.cli("offload", "--json", "--trace-requests", "--apply", "--preview-dir", str(self.preview), *(["--confirm", token] if token else []), *extra)

    def test_apply_token_checks(self):
        code, lines = self.dry("--no-llm")
        token = lines[-1]["token"]
        self.allm.requests.clear()
        tree = self.sb.tree()
        for bad in (None, "000000000000"):
            code, lines = self._apply(bad)
            self.assertEqual(code, 2, lines)
            self.assertEqual(self.allm.requests, [])
            self.assertEqual(self.sb.tree(), tree)
        # An edited preview is refused even with the right token.
        prev = Path(sorted(self.preview.iterdir())[-1])
        f = next((prev / "scrolls").rglob("*.md"))
        f.write_text(f.read_text(encoding="utf-8") + "\n- sneaky\n", encoding="utf-8")
        code, lines = self._apply(token)
        self.assertEqual(code, 2)
        self.assertIn("changed since the dry-run", lines[-1]["error"])
        self.assertEqual(self.allm.requests, [])

    def test_apply_order_and_scope(self):
        code, lines = self.dry("--no-llm")
        token = lines[-1]["token"]
        self.allm.requests.clear()
        self.allm.bodies.clear()
        real_write = offload.write_scroll
        root = self.sb.root / "archive"

        def checked_write(*a, **k):
            rows = archive.read_manifest(root)
            assert rows and all(archive.prune_allowed(root, r["archive_id"]) for r in rows), "snapshot verified before the first scroll write"
            assert not any(p.endswith("/update-embeddings") for _, p in self.allm.requests), "no un-embed before promotion"
            return real_write(*a, **k)

        with mock.patch.object(offload, "write_scroll", side_effect=checked_write):
            code, lines = self._apply(token)
        self.assertEqual(code, 0, lines)
        res = lines[-1]
        self.assertTrue(res["applied"])
        self.booking_free(self.allm.requests)
        posts = [p for m, p in self.allm.requests if m == "POST"]
        first_unembed = next(i for i, p in enumerate(posts) if p.endswith("/update-embeddings"))
        last_ingest = max(i for i, p in enumerate(posts) if p == "/api/v1/document/raw-text")
        self.assertLess(last_ingest, first_unembed, "embed scrolls before un-embedding raw docs")
        unembeds = {p: b for m, p, b in self.allm.bodies if p.endswith("/update-embeddings")}
        self.assertEqual(unembeds["/api/v1/workspace/coder/update-embeddings"], {"adds": [], "deletes": ["custom-documents/build-log.json"]})
        self.assertEqual(unembeds["/api/v1/workspace/librarian/update-embeddings"], {"adds": [], "deletes": ["custom-documents/notes-a.json"]})
        self.assertEqual({m for m, _ in self.allm.requests}, {"GET", "POST"})
        # Scrolls promoted under the temp root with the snapshot id; KG written; nothing local removed.
        snap = res["snapshot_ids"][0]
        scrolls = sc.list_scrolls(self.sb.root / "scrolls")
        self.assertTrue(scrolls)
        for rel, s, _ in scrolls:
            self.assertIsNotNone(s, rel)
            self.assertEqual(s.source_archive_ids, [snap])
            self.assertNotIn("preview: extractive", s.body)
        self.assertTrue((self.sb.root / "kg" / "knowledge-graph.json").exists())
        _, rows = archive.read_entry(root, snap)
        self.assertEqual(sorted(r["meta"].get("name") for r in rows if r["kind"] == "rag_doc"), ["build-log.json", "notes-a.json"])
        self.assertTrue((self.sb.root / "data" / "command-center" / "os-threads.json").exists())
        self.assertTrue((self.sb.root / "notes" / "anythingllm-prompt-backups" / "coder.md").exists())

    def test_snapshot_verify_failure_removes_nothing(self):
        code, lines = self.dry("--no-llm")
        token = lines[-1]["token"]
        self.allm.requests.clear()
        with mock.patch.object(archive, "verify", side_effect=ArchiveError("injected")):
            code, lines = self._apply(token)
        self.assertEqual(code, 1, lines)
        self.assertEqual([p for m, p in self.allm.requests if m == "POST"], [])
        self.assertFalse(any((self.sb.root / "scrolls").rglob("*.md")))

    def test_reverify_failure_before_unembed_removes_nothing(self):
        code, lines = self.dry("--no-llm")
        token = lines[-1]["token"]
        self.allm.requests.clear()
        with mock.patch.object(archive, "prune_allowed", return_value=False):
            code, lines = self._apply(token)
        self.assertEqual(code, 1, lines)
        self.assertFalse(any(p.endswith("/update-embeddings") for _, p in self.allm.requests))

    def test_scroll_changed_since_dry_run_refused(self):
        code, lines = self.dry("--no-llm")
        token = lines[-1]["token"]
        rel = lines[-1]["proposed"]["targets"][0]["rel"]
        t = sc.target_info(rel)
        p = self.sb.root / "scrolls" / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(sc.render(sc.Scroll(t.scroll_id, t.category, "2026-11-19T09:00:00-05:00", 1, [], [], sc.template_body(t))), encoding="utf-8")
        self.allm.requests.clear()
        code, lines = self._apply(token)
        self.assertEqual(code, 2)
        self.assertIn("changed since the dry-run", lines[-1]["error"])
        self.assertEqual(self.allm.requests, [])

    # ── fix pass: Memory Scroll documents, all-or-nothing promotion, partial un-embed, multi-archive ──

    def _ledger(self, entries: dict):
        from memory_scrolls import state as st_mod

        st = st_mod.default()
        st["sync"] = entries
        st_mod.save(self.sb.root / "state", st)

    def apply_spying(self, token):
        """Apply, recording which un-embeds came from offload's raw-document step (`_apply`)
        rather than the scroll sync's own replace flow."""
        from memory_scrolls.allm import ScrollWriter

        real = ScrollWriter.unembed
        raw: list = []

        def spy(self_, locs):
            if sys._getframe(1).f_code.co_name == "_apply":
                raw.extend(locs)
            return real(self_, locs)

        with mock.patch.object(ScrollWriter, "unembed", spy):
            code, lines = self._apply(token)
        return code, lines, raw

    def assert_ledger_embedded(self):
        """The finding's failure mode: a ledger entry says synced at a location that is no longer embedded."""
        st = json.loads((self.sb.root / "state" / "state.json").read_text(encoding="utf-8"))
        embedded = {d["docpath"] for d in self.allm.workspaces["librarian"]["documents"]}
        for sid, e in st["sync"].items():
            if e["state"] == "synced":
                self.assertIn(e["location"], embedded, sid)

    def test_synced_scroll_documents_are_never_raw_input_or_unembedded(self):
        lib = self.allm.workspaces["librarian"]["documents"]
        lib.append({"docpath": "custom-documents/scroll-old-a.json", "filename": "scroll-old-a.json", "metadata": json.dumps({"title": "core-architecture-decisions", "docSource": "agentic-os-scroll"})})
        lib.append({"docpath": "custom-documents/raw-proj.json", "filename": "raw-proj.json", "metadata": json.dumps({"title": "proj-agentic-os"})})  # ledger-only
        self.allm.documents["scroll-old-a.json"] = "Guardrails: never fix the error SCROLL-TEXT"
        self.allm.documents["raw-proj.json"] = "Locked: SCROLL-TEXT-2 failed fix"
        ledger = {
            "core-architecture-decisions": {"state": "synced", "sha256": "a" * 64, "version": 1, "location": "custom-documents/scroll-old-a.json", "orphaned": [], "rel": "core/architecture_decisions.md"},
            "proj-agentic-os": {"state": "synced", "sha256": "b" * 64, "version": 1, "location": "custom-documents/raw-proj.json", "orphaned": [], "rel": "projects/agentic-os.md"},
        }
        self._ledger(ledger)
        code, lines = self.dry("--no-llm")
        self.assertEqual(code, 0, lines)
        res = lines[-1]
        self.assertEqual(res["raw"]["anythingllm_docs"]["count"], 2)
        self.assertEqual(res["anythingllm"]["scroll_docs_skipped"], 2)
        prev = Path(res["preview_dir"])
        manifest = json.loads((prev / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(sorted(d["name"] for d in manifest["allm_docs"]), ["build-log.json", "notes-a.json"])
        self.assertNotIn("SCROLL-TEXT", "\n".join(p.read_text(encoding="utf-8") for p in (prev / "scrolls").rglob("*.md")))
        self.allm.bodies.clear()
        code, lines, deletes = self.apply_spying(res["token"])
        self.assertEqual(code, 0, lines)
        self.assertNotIn("custom-documents/scroll-old-a.json", deletes)
        self.assertNotIn("custom-documents/raw-proj.json", deletes)
        self.assertIn("custom-documents/notes-a.json", deletes)
        self.assert_ledger_embedded()

    def test_apply_leaves_documents_that_became_scrolls_after_the_dry_run(self):
        # Listed as raw at dry-run time (no ledger yet, no docSource in the listing) ...
        self.allm.workspaces["librarian"]["documents"].append({"docpath": "custom-documents/scroll-old-7.json", "filename": "scroll-old-7.json", "metadata": json.dumps({"title": "x"})})
        self.allm.workspaces["coder"]["documents"].append({"docpath": "custom-documents/tagged.json", "filename": "tagged.json", "metadata": json.dumps({"title": "y"})})
        self.allm.documents["scroll-old-7.json"] = "scroll body"
        self.allm.documents["tagged.json"] = {"pageContent": "scroll body 2", "docSource": "agentic-os-scroll"}
        code, lines = self.dry("--no-llm")
        token = lines[-1]["token"]
        # ... then a compaction synced a scroll at that location.
        self._ledger({"proj-agentic-os": {"state": "synced", "sha256": "c" * 64, "version": 1, "location": "custom-documents/scroll-old-7.json", "orphaned": [], "rel": "projects/agentic-os.md"}})
        self.allm.bodies.clear()
        code, lines, deletes = self.apply_spying(token)
        self.assertEqual(code, 0, lines)
        self.assertNotIn("custom-documents/scroll-old-7.json", deletes)
        all_deletes = [x for m, p, b in self.allm.bodies if p.endswith("/update-embeddings") for x in b["deletes"]]
        self.assertNotIn("custom-documents/tagged.json", all_deletes)
        self.assert_ledger_embedded()
        self.assertTrue(any("left embedded" in w for w in lines[-1]["warnings"]))
        _, rows = archive.read_entry(self.sb.root / "archive", lines[-1]["snapshot_ids"][0])
        self.assertNotIn("scroll-old-7.json", [r["meta"].get("name") for r in rows])

    def test_one_invalid_preview_promotes_nothing(self):
        code, lines = self.dry("--no-llm")
        token = lines[-1]["token"]
        rels = sorted(t["rel"] for t in lines[-1]["proposed"]["targets"])
        self.assertGreater(len(rels), 1)
        real = sc.validate

        def bad_last(t, *a, **k):
            if t.rel == rels[-1]:
                return ["injected: over the hard cap"], None, []
            return real(t, *a, **k)

        self.allm.requests.clear()
        with mock.patch.object(offload.sc, "validate", side_effect=bad_last):
            code, lines = self._apply(token)
        self.assertEqual(code, 2, lines)
        self.assertIn(rels[-1], lines[-1]["error"])
        self.assertFalse(any((self.sb.root / "scrolls").rglob("*.md")), "no scroll promoted")
        self.assertEqual(archive.read_manifest(self.sb.root / "archive"), [])
        self.assertEqual([p for m, p in self.allm.requests if m == "POST"], [])

    def test_partial_unembed_failure_reports_every_action(self):
        code, lines = self.dry("--no-llm")
        token = lines[-1]["token"]
        from memory_scrolls.allm import ScrollWriter

        real = ScrollWriter.unembed

        def fail_librarian(self_, locs):
            if self_.workspace == "librarian" and any("notes-a" in x for x in locs):
                raise RuntimeError("HTTP 500")
            return real(self_, locs)

        with mock.patch.object(ScrollWriter, "unembed", fail_librarian):
            code, lines = self._apply(token)
        self.assertEqual(code, 1, lines)
        res = lines[-1]
        self.assertFalse(res["applied"])
        self.assertIn("un-embed failed for librarian", res["error"])
        self.assertIn("un-embedded 1 raw document(s) from coder", res["actions"])
        self.assertTrue(any(a.startswith("promoted ") for a in res["actions"]))
        st = json.loads((self.sb.root / "state" / "state.json").read_text(encoding="utf-8"))
        self.assertIn("un-embed failed", st["last_run"]["incomplete"])
        self.assertIn("un-embedded 1 raw document(s) from coder", st["last_run"]["actions"])

    def test_sync_failure_after_promotion_leaves_scrolls_marked_for_sync(self):
        code, lines = self.dry("--no-llm")
        token = lines[-1]["token"]
        self.allm.fail_ingest = True
        code, lines = self._apply(token)
        self.assertEqual(code, 2, lines)
        self.assertFalse(any(p.endswith("/update-embeddings") for _, p in self.allm.requests))
        st = json.loads((self.sb.root / "state" / "state.json").read_text(encoding="utf-8"))
        promoted = [s.scroll_id for _, s, _ in sc.list_scrolls(self.sb.root / "scrolls")]
        self.assertTrue(promoted)
        for sid in promoted:
            self.assertTrue(st["sync"][sid].get("dirty") or st["sync"][sid]["state"] != "synced", sid)
        self.assertTrue(st["last_run"]["incomplete"])

    def test_every_snapshot_archive_is_cited_by_the_scroll_it_feeds(self):
        big = "".join(f"filler {i:06d} " + "z" * 60 + "\n" for i in range(2600))  # ~190 KB each
        self.allm.documents["notes-a.json"] = "Locked: Whisper STT runs on port 8178\n" + big
        self.allm.documents["build-log.json"] = "the coder build failed with an error in vite config; fix: pin vite 5\n" + big
        code, lines = self.dry("--no-llm")
        self.assertEqual(code, 0, lines)
        prev = Path(lines[-1]["preview_dir"])
        manifest = json.loads((prev / "manifest.json").read_text(encoding="utf-8"))
        target = {d["name"]: d["target"] for d in manifest["allm_docs"]}
        code, lines = self._apply(lines[-1]["token"])
        self.assertEqual(code, 0, lines)
        ids = lines[-1]["snapshot_ids"]
        self.assertGreater(len(ids), 1, "the raw documents span several snapshot archives")
        scrolls = {rel: s for rel, s, _ in sc.list_scrolls(self.sb.root / "scrolls")}
        root = self.sb.root / "archive"
        for aid in ids:
            _, rows = archive.read_entry(root, aid)
            for r in rows:
                if r["kind"] == "rag_doc":
                    rel = target[r["meta"]["name"]]
                    self.assertIn(aid, scrolls[rel].source_archive_ids, (r["meta"]["name"], rel))

    # ── LLM call budget (auto default, pre-check) and the problems split ──

    def _big_project_doc(self):
        # ~34 KB of distinct project notes in four documents (each under the 32 KB distill cap): the
        # project target needs several 12k-char chunks.
        for d in range(4):
            name = f"design-notes-{d}.json"
            self.allm.workspaces["coder"]["documents"].append(doc(name, f"Design notes {d}"))
            self.allm.documents[name] = "\n".join(f"design note {d}-{i:04d}: the status card uses layout variant {i} of the grid" for i in range(120))

    def _dry_direct(self, llm, **kw):
        kw.setdefault("sources", "all")
        opts = offload.OffloadOptions(preview_dir=self.preview, llm=llm, now=None, **kw)
        return offload.dry_run(self.sb.paths(), opts, self.sb.env, lambda e: None)

    def test_dry_run_auto_budget_models_every_target(self):
        self._big_project_doc()
        llm = FakeLLM([auto_reply] * 64)
        res = self._dry_direct(llm)
        rows = {t["rel"]: t for t in res["proposed"]["targets"]}
        self.assertGreaterEqual(rows["projects/agentic-os.md"]["llm_chunks"], 3)
        self.assertGreaterEqual(len(rows), 4)
        self.assertEqual({t["mode"] for t in rows.values()}, {"live"}, res["warnings"])
        self.assertEqual(res["llm_calls_planned"], sum(t["llm_chunks"] for t in rows.values()))
        self.assertEqual(res["llm_calls"], res["llm_calls_planned"])
        self.assertEqual(res["llm_calls_max"], offload.auto_llm_calls(res["llm_calls_planned"], len(rows)))
        self.assertEqual(len(llm.calls), res["llm_calls"])
        for t in rows.values():
            self.assertTrue(t["valid"], t)
            self.assertEqual(t["llm_problems"], [])

    def test_budget_precheck_skips_target_without_burning_calls(self):
        self._big_project_doc()
        first = self._dry_direct(FakeLLM([auto_reply] * 64))
        rows = {t["rel"]: t for t in first["proposed"]["targets"]}
        need = rows["projects/agentic-os.md"]["llm_chunks"]
        others = sum(t["llm_chunks"] for rel, t in rows.items() if rel != "projects/agentic-os.md")
        llm = FakeLLM([auto_reply] * 64)
        res = self._dry_direct(llm, max_llm_calls=others + 1)
        rows = {t["rel"]: t for t in res["proposed"]["targets"]}
        self.assertEqual(rows["projects/agentic-os.md"]["mode"], "extractive")
        self.assertTrue(rows["projects/agentic-os.md"]["valid"])
        self.assertEqual(res["llm_calls"], others, "no call spent on the target that could not finish")
        self.assertFalse(any("TARGET: projects/agentic-os.md" in m[1]["content"] for m in llm.calls))
        self.assertIn(f"projects/agentic-os.md: needs {need} LLM calls, 1 left; extractive preview", res["warnings"])
        self.assertEqual({t["mode"] for rel, t in rows.items() if rel != "projects/agentic-os.md"}, {"live"})

    def test_normalisation_warnings_kept_when_a_later_chunk_fails(self):
        # Review finding: chunk 0's warnings (what the model got wrong) were lost when chunk 1 of
        # the same target failed, leaving only "LLM failed; extractive preview".
        self._big_project_doc()
        seen = {"n": 0}

        def reply(messages):
            r = json.loads(auto_reply(messages))
            if "TARGET: projects/agentic-os.md" not in messages[1]["content"]:
                return json.dumps(r)
            seen["n"] += 1
            if seen["n"] > 1:
                raise OSError("connection reset")
            r["graph_entities_to_upsert"] = [{"name": "Coder", "entityType": "agent", "observations": ["builds tasks"]}]
            return json.dumps(r)

        res = self._dry_direct(FakeLLM([reply] * 64))
        rows = {t["rel"]: t for t in res["proposed"]["targets"]}
        # Wiring (d): a later chunk's failure now keeps the model body of the accepted chunk(s).
        row = rows["projects/agentic-os.md"]
        self.assertEqual(row["mode"], "live")
        self.assertTrue(row["valid"], row["problems"])
        self.assertEqual({k: row["partial_distillation"][k] for k in ("accepted", "failed_chunk")}, {"accepted": 1, "failed_chunk": 2})
        self.assertGreaterEqual(row["partial_distillation"]["chunks"], 2)
        self.assertEqual(res["partial_distillation"], ["projects/agentic-os.md"])
        w = res["warnings"]
        self.assertIn("proj-agentic-os: entityType 'agent'->'tool' x1", w)
        self.assertTrue(any(x.startswith("proj-agentic-os: chunk 2/") and "kept the model body of chunk(s) 1..1" in x for x in w), w)
        self.assertFalse(any(x.startswith("projects/agentic-os.md: LLM failed") for x in w), w)
        manifest = json.loads((Path(res["preview_dir"]) / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["distill"]["projects/agentic-os.md"]["partial_distillation"]["failed_chunk"], 2)
        self.assertEqual(offload.partial_marks(manifest), ["projects/agentic-os.md"])

    def test_problems_list_every_entity_error_and_separate_llm_problems(self):
        def bad(messages):
            # A reply that drops a heading: the model's reply is unusable, the extractive preview is fine.
            r = json.loads(auto_reply(messages))
            r["updated_markdown"] = "\n".join(x for x in r["updated_markdown"].split("\n") if not x.startswith("## ") or x == "## " + sc.SUPERSEDED)
            return json.dumps(r)

        res = self._dry_direct(FakeLLM([bad] * 64))
        rows = res["proposed"]["targets"]
        self.assertTrue(rows)
        for t in rows:
            self.assertEqual(t["mode"], "extractive")
            self.assertTrue(t["valid"], t)
            self.assertEqual(t["problems"], [])
            self.assertGreater(len(t["llm_problems"]), 1, "every missing heading is listed")
            self.assertTrue(all(p.startswith("missing heading") or "out of order" in p or "title" in p for p in t["llm_problems"]), t["llm_problems"])

    @staticmethod
    def _swap_first(state):
        """A reply fn whose first reply puts the body under target_scroll (live 2026-11-19)."""

        def reply(messages):
            state["n"] = state.get("n", 0) + 1
            r = json.loads(auto_reply(messages))
            if state["n"] == 1:
                state["rel"] = r["target_scroll"]
                return json.dumps({"target_scroll": r["updated_markdown"], "graph_entities_to_upsert": [], "superseded_facts": []})
            return json.dumps(r)

        return reply

    def test_repair_retry_in_preview_report_and_manifest(self):
        st, events = {}, []
        llm = FakeLLM([self._swap_first(st)] * 64)
        res = offload.dry_run(self.sb.paths(), offload.OffloadOptions(preview_dir=self.preview, llm=llm, sources="all"), self.sb.env, events.append)
        rows = {t["rel"]: t for t in res["proposed"]["targets"]}
        rel = st["rel"]
        self.assertEqual({t["mode"] for t in rows.values()}, {"live"}, res["warnings"])
        self.assertEqual([(r["chunk"], r["kind"], r["outcome"]) for r in rows[rel]["repairs"]], [(1, "repair", "accepted")])
        self.assertIn("missing updated_markdown", rows[rel]["repairs"][0]["errors"][0])
        self.assertEqual(res["repairs"], {"attempted": 1, "accepted": 1, "skipped_no_budget": 0})
        self.assertEqual(res["llm_calls"], res["llm_calls_planned"] + 1, "the repair counts against the budget")
        self.assertEqual(res["extractive_targets"], [])
        self.assertIn("REPAIR: the host validator", llm.calls[1][1]["content"])
        self.assertEqual([e["outcome"] for e in events if e.get("event") == "repair"], ["accepted"])
        manifest = json.loads((Path(res["preview_dir"]) / "manifest.json").read_text(encoding="utf-8"))
        meta = dict(manifest["distill"][rel])
        self.assertEqual(set(meta.pop("sources")), {"hub", "brain", "other"})
        self.assertEqual(meta, {"mode": "live", "extractive": False, "pending_distillation": False, "repairs": [{"chunk": 1, "kind": "repair", "outcome": "accepted"}], "privacy_removed": {}, "privacy_locked_removed": [], "never_lock_demoted": 0, "never_lock_relocked": 0, "never_lock_lock_new": True, "guards": {}, "partial_distillation": None})
        report = json.loads((Path(res["preview_dir"]) / "report.json").read_text(encoding="utf-8"))
        self.assertEqual(report["repairs"]["accepted"], 1)

    def test_repair_never_starves_later_targets(self):
        base = self._dry_direct(FakeLLM([auto_reply] * 64))
        planned, n = base["llm_calls_planned"], len(base["proposed"]["targets"])
        self.assertGreaterEqual(n, 3)
        self.assertEqual(base["llm_calls_max"], planned + n, "auto budget: one repair per target")
        # One spare call is not enough: it is reserved for the later targets' own repairs.
        st = {}
        res = self._dry_direct(FakeLLM([self._swap_first(st)] * 64), max_llm_calls=planned + 1)
        rows = {t["rel"]: t for t in res["proposed"]["targets"]}
        self.assertEqual([r["outcome"] for r in rows[st["rel"]]["repairs"]], ["skipped_no_budget"])
        self.assertEqual(rows[st["rel"]]["mode"], "extractive")
        self.assertTrue(rows[st["rel"]]["extractive"])
        self.assertEqual({t["mode"] for rel, t in rows.items() if rel != st["rel"]}, {"live"})
        self.assertLessEqual(res["llm_calls"], planned)
        self.assertEqual(res["repairs"]["skipped_no_budget"], 1)
        self.assertEqual(res["extractive_targets"], [st["rel"]])

    def test_extractive_preview_marked_in_apply_output(self):
        code, lines = self.dry("--no-llm")
        self.assertEqual(code, 0, lines)
        res = lines[-1]
        self.assertTrue(res["extractive_targets"])
        manifest = json.loads((Path(res["preview_dir"]) / "manifest.json").read_text(encoding="utf-8"))
        self.assertTrue(all(m["extractive"] for m in manifest["distill"].values()))
        code, lines = self._apply(res["token"])
        self.assertEqual(code, 0, lines)
        out = lines[-1]
        self.assertEqual(out["extractive"], sorted(res["extractive_targets"]))
        promoted = [a for a in out["actions"] if a.startswith("promoted ")]
        self.assertTrue(promoted)
        self.assertTrue(all("(extractive" in a for a in promoted), promoted)
        self.assertTrue(any("are extractive (no model)" in w for w in out["warnings"]), out["warnings"])

    def test_pending_target_documents_stay_embedded_on_apply(self):
        # Review finding: a "Pending distillation" scroll holds almost none of its raw documents'
        # content and nothing re-distills a snapshot archive, so those documents must stay embedded.
        self.allm.documents["notes-a.json"] = "Nic prefers ultra-short acks\n" + "filler line\n" * 50
        code, lines = self.dry("--no-llm")
        self.assertEqual(code, 0, lines)
        res = lines[-1]
        manifest = json.loads((Path(res["preview_dir"]) / "manifest.json").read_text(encoding="utf-8"))
        target = {d["name"]: d["target"] for d in manifest["allm_docs"]}
        self.assertIn(target["notes-a.json"], res["pending_distillation"])
        self.assertNotIn(target["build-log.json"], res["pending_distillation"])
        self.allm.bodies.clear()
        code, lines, deletes = self.apply_spying(res["token"])
        self.assertEqual(code, 0, lines)
        out = lines[-1]
        self.assertNotIn("custom-documents/notes-a.json", deletes)
        self.assertIn("custom-documents/build-log.json", deletes)
        self.assertEqual(out["kept_embedded"], 1)
        self.assertTrue(any(a.startswith("kept 1 raw document(s) embedded: pending distillation") for a in out["actions"]), out["actions"])
        self.assertTrue(any("left embedded because their scroll is pending distillation" in w for w in out["warnings"]), out["warnings"])
        # Still archived (the snapshot is complete), only the un-embed is held back.
        _, rows = archive.read_entry(self.sb.root / "archive", out["snapshot_ids"][0])
        self.assertIn("notes-a.json", [r["meta"].get("name") for r in rows])

    def test_partial_target_documents_stay_embedded_on_apply(self):
        # Wiring (d): a partially distilled target (a later chunk failed, the accepted model body
        # kept) lacks the failed chunk's content, so its raw documents stay embedded like pending.
        self._big_project_doc()
        seen = {"n": 0}

        def reply(messages):
            if "TARGET: projects/agentic-os.md" in messages[1]["content"]:
                seen["n"] += 1
                if seen["n"] > 1:
                    raise OSError("connection reset")
            return auto_reply(messages)

        res = self._dry_direct(FakeLLM([reply] * 64))
        self.assertEqual(res["partial_distillation"], ["projects/agentic-os.md"])
        self.assertNotIn("projects/agentic-os.md", res["pending_distillation"])
        manifest = json.loads((Path(res["preview_dir"]) / "manifest.json").read_text(encoding="utf-8"))
        target = {d["name"]: d["target"] for d in manifest["allm_docs"]}
        self.assertEqual(target["design-notes-0.json"], "projects/agentic-os.md")
        self.assertNotEqual(target["build-log.json"], "projects/agentic-os.md")
        self.allm.bodies.clear()
        code, lines, deletes = self.apply_spying(res["token"])
        self.assertEqual(code, 0, lines)
        out = lines[-1]
        self.assertEqual(out["partial_distillation"], ["projects/agentic-os.md"])
        for d in range(4):
            self.assertNotIn(f"custom-documents/design-notes-{d}.json", deletes)
        self.assertIn("custom-documents/build-log.json", deletes)
        self.assertTrue(any(a.startswith("kept ") and "pending or partial distillation" in a for a in out["actions"]), out["actions"])
        self.assertTrue(any(a.startswith("promoted projects/agentic-os.md") and a.endswith("(partial distillation)") for a in out["actions"]), out["actions"])

    def test_pending_note_matches_the_flag_when_a_scroll_exists(self):
        # Review finding: fold_bullets dropped the new body's notes and kept an old one.
        rel = "core/identity_and_preferences.md"
        t = sc.target_info(rel)
        p = self.sb.root / "scrolls" / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        self.allm.documents["notes-a.json"] = "Nic prefers ultra-short acks\n" + "filler line\n" * 50
        for old_body, rich, want_pending in (
            (sc.template_body(t), False, True),  # (a) no note in the old scroll, too little signal now
            (distill_set_pending(sc.template_body(t)), True, False),  # (b) old note, enough signal now
        ):
            p.write_text(sc.render(sc.Scroll(t.scroll_id, t.category, "2026-11-18T09:00:00-05:00", 1, ["arch-2026-11-18-01"], [], old_body)), encoding="utf-8")
            if rich:
                self.allm.documents["notes-a.json"] = "Nic prefers ultra-short acks\nNic always wants voice replies kept to one sentence\nNever call Nic by a nickname\n" + "filler line\n" * 50
            res = self._dry_direct(None, no_llm=True)
            row = next(r for r in res["proposed"]["targets"] if r["rel"] == rel)
            self.assertEqual(row["pending_distillation"], want_pending, row)
            self.assertTrue(row["valid"], row["problems"])
            text = (Path(res["preview_dir"]) / "scrolls" / rel).read_text(encoding="utf-8")
            self.assertEqual("Pending distillation" in text, want_pending, text)
            self.assertEqual(rel in res["pending_distillation"], want_pending)

    def test_script_wrappers_help(self):
        for script, word in (("offload_rag_to_scrolls.py", "--apply"), ("compact_memory.py", "--max-batches")):
            r = subprocess.run([sys.executable, str(REPO / "scripts" / script), "--help"], capture_output=True, text=True, timeout=60)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn(word, r.stdout)
        r = subprocess.run([sys.executable, "-m", "memory_scrolls", "--help"], capture_output=True, text=True, cwd=str(REPO), timeout=60)
        for cmd in ("compact", "status", "offload"):
            self.assertIn(cmd, r.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
