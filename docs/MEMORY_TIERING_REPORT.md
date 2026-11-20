# Memory Tiering ("Memory Scrolls"): Phase 3 report

> **Review before commit.** `docs/` is the public GitHub Pages folder. This report is scrubbed: it has no
> secrets, no user-profile paths and no ids beyond archive ids. Scratch locations are written as `<scratch>`.

Branch `feat/thoughtform-pipeline`. Nothing was committed, stashed or reset. `--apply` was never run.
Live AnythingLLM was only read with GET requests, and the Booking workspaces (`my-workspace`, `booking`)
were never read. Nothing was written to the real `C:\ai-hub\memory`, the real knowledge graph, `.env`,
the cold archive or AnythingLLM.

## 0. The Command Center at a glance

The live system in one screen, each line checked against the code. The curated memory seed uses this
section as the overview of the `projects/agentic-os.md` scroll.

- **App:** the Agentic OS Command Center, a Tauri v2 + Rust desktop app with a React 19 front end. The phone runs the same UI as a PWA.
- **Front agent:** Tony, the voice front agent. He answers directly or delegates to the roster: Prompter, Designer, Coder, Librarian (read-only) and Ops.
- **Gateway:** `server.py` on :8080 is the shared store. The phone reads the desktop's non-secret settings through the `/api/os/state` mirror.
- **Voice:** Whisper STT on :8178. TTS per agent voice: Kokoro on :8880 or ElevenLabs, and an ElevenLabs failure falls back to Kokoro.
- **Models:** LM Studio on :1235 serves the loaded local model. The AnythingLLM workspaces hold the agent prompts.
- **Build pipeline:** ideas go through the Play Place / Build Hub staging queue and the sequential TaskEnvelope worker. Builds land in `staging/`, and `approve()` still gates every mutating plan.
- **Modes:** Tony's work modes (surface, brainstorm, builder, executive, coach) set curiosity, verbosity and the dispatch policy. Gabagool is a novelty overlay, never a work mode.

## 1. Architecture as built

### Tiers

| Tier | What | Where (live default) | Embedded in RAG? |
|---|---|---|---|
| 1. Hot buffer | Raw Tier-1 history: `os-threads.json` turns (Booking thread skipped), `tasks.db` envelopes and handoffs (read-only connection), staging status, Tony's notes. Optional: `training_logs/*.jsonl`, gateway `chat-history.json` | Unchanged: no source is ever pruned or rewritten (D5). Watermarks in `state.json` mark what has been archived. | Tony's notes only, as before (`embedOnly=false`) |
| 2. Cold archive | Lossless, scrubbed, gzip JSONL. Append-only. Never indexed. | `D:\ai-hub-archive` (D: is a fixed drive with at least 5 GB free). Resolution order: env `MEMORY_ARCHIVE_DIR`, then `.env`, then os.json `memory.scrolls.archiveDir`, then D:, then `repo/archive/memory`. The first root written is pinned in `data/memory-scrolls/state.json`. | No |
| 3. Memory Scrolls | A few living Markdown files distilled by the local model | `D:\ai-hub-memory\scrolls\{core,projects,patterns}\*.md` (moved off `C:\ai-hub`, which stays read-only) | Yes: the only layer synced into the `librarian` workspace |
| Graph | Entities and observations from each distillation | `D:\ai-hub-memory\knowledge-graph.json`, server-memory 2.1.1 JSONL (the same file the app's `kg.search` reads; the AnythingLLM `knowledge-graph` MCP entry still names the old `C:\ai-hub\memory` file and must be repointed by hand) | No |

> **Update (Nic's decision):** the live scrolls and knowledge graph live in `D:\ai-hub-memory`, not
> `C:\ai-hub\memory`. Every Memory Scrolls writer (scrolls, graph, archive, state, previews) and the
> app's `scrollsDir` / `archiveDir` settings refuse any target that resolves under `C:\ai-hub`
> (case-insensitive, junction-safe). Earlier sections that name `C:\ai-hub\memory` describe the runs
> made before this change.

### Paths and files

- **Python core:** `memory_scrolls/` (stdlib only), with entry points `scripts/compact_memory.py`,
  `compact-memory.cmd` and `scripts/offload_rag_to_scrolls.py`.
  - Exit codes: 0 ok, 75 deferred, 2 config error, 1 unexpected.
  - `--json` prints NDJSON phase events followed by one result line.
- **State (gitignored):** `data/memory-scrolls/state.json` holds watermarks, the archive pin, per-archive
  target status, the sync ledger, `kg_pending` and `last_run`. The last 5 versions of each scroll are kept in
  `data/memory-scrolls/scroll-history/<scroll_id>/v<n>.md`.
- **Preview (gitignored):** `staging/memory-scrolls-preview/<YYYYMMDD-HHMMSS>/` holds `scrolls/…`,
  `kg-preview.jsonl`, `report.json` and `manifest.json`.
- **Rust:**
  - `commands/compaction.rs`: host trigger and Tauri commands `memory_compact` / `memory_compaction_status`.
  - `commands/librarian.rs`: scroll read path and `archive_lookup`.
  - `commands/taskworker.rs`: forensic hook, `mark_dirty`, `embedOnly` gate.
  - `commands/os_core.rs`: `memory.scrolls` config.
- **UI:** Settings > Memory > "Memory Scrolls" card, with the "Compact & Sync Memory" button and the
  Auto-compact and Embed-only toggles.

### Archive format (D4)

- Path: `<root>/YYYY/MM/arch-YYYY-MM-DD-NN.jsonl.gz`.
- Line 1 is a header: schema `agentic-os.archive.v1`, archive id, source, record count, redaction count.
- Each following line is one record.
- The gzip header mtime is 0, so hashes are reproducible.
- Every archive gets a row in `<root>/manifest.jsonl` with `sha256_gz`, `sha256_raw`, the record count and
  `verified_at`.
- Archives are written with link-or-fail, so they are never overwritten. Batches are split at 256 KB.
- Secrets are scrubbed before hashing. `prune_allowed` is true only for a verified archive.

### Scroll schema (D9)

- Frontmatter has 6 keys, in this order: `scroll_id`, `category`, `last_updated`, `version`,
  `source_archive_ids`, `supersedes`. The host owns it; the model returns only the body.
- The body uses fixed H2 templates per category:
  - project: Current Milestone, Locked Decisions, Key Paths, Active State, Open Threads
  - identity: Identity, Communication Preferences, Hardware & Constraints, Standing Rules
  - architecture: Ports & Services, Repo Paths, Locked Design Decisions, Guardrails
  - pattern: Fixes, Failure Modes, Tool Quirks, Proven Recipes
  - All categories also have `## Superseded Decisions`.
- Size: 3072 B target (warning), 5120 B hard cap (rejected after one compress retry).
- Up to 4 sub-scrolls are allowed, as `projects/<slug>--<topic>.md`.

### Merge and supersede rules

- The model reply must be strict JSON: `target_scroll`, `updated_markdown`, `graph_entities_to_upsert`,
  `superseded_facts`. It is validated by 9 rules: shape, target path allowlist, required headings, no HTML or
  think tags, no secrets, entity types from a fixed list, size, locked bullets kept, and fence neutralised.
- A dropped bullet under a Locked heading is rejected unless a `superseded_facts.old` covers it. That `old`
  must be at least 4 characters and equal the bullet, contain it, or be a part of it of at least 12 characters.
- Superseded facts are written as `- YYYY-MM-DD: old -> new (arch-…)`. Only the newest 8 lines are kept.
- Repairs made before strict validation, each reported as a warning (also when a later chunk of the same
  target fails or runs out of calls):
  - A fact that only records a move ("-> moved to Guardrails") is dropped. It never removes the line and
    never excuses a dropped locked bullet.
  - A body line equal to a fact's `old` is removed only when the fact's `new` is stated elsewhere in the
    body. A fact reverted by a later chunk (a later `new` equals its `old`) removes nothing.
  - A bullet that echoes the distiller's own rules is removed, unless it has a path or port, was already
    in the scroll, or is explained by a batch line at least as well as by a rule.
- The prompt `BUDGET` is set per target. It is 3,072 B minus the merged frontmatter (which grows with
  `source_archive_ids`) and 270 B for the log, capped at 2,622 B. The soft-compress hint asks for the size
  that would actually fit.
- On a successful merge, `version` goes up by one and the archive id is appended to `source_archive_ids`.
  Re-merging the same archive id is a no-op.
- A rejected reply leaves the target pending. After 3 attempts the target is marked failed. Nothing is
  written in either case.
- Write order: archive and verify, then distill, then mark the sync ledger dirty and queue the KG upsert,
  then write the scroll atomically, then upsert the KG, then sync the changed scrolls. This order survives a
  crash or kill at any point.
- AnythingLLM sync (D6):
  - The scroll is posted with `POST /v1/document/raw-text` (docSource `agentic-os-scroll`, title = scroll id)
    into `librarian` only.
  - The old copy is then un-embedded with a workspace-scoped `update-embeddings`.
  - It never calls `remove-documents`, `GET /v1/documents` or `GET /v1/workspaces`.

### Triggers

- **Manual CLI:** `compact-memory` (D8 idle check: a loaded chat model is required, and the GPU must be
  free per the gateway lease or the host token. `--assume-idle` is only for when the gateway cannot answer).
- **Settings button:** "Compact & Sync Memory" calls `memory_compact`. The Rust host checks idle, takes a
  background GPU slot, sets `AOS_GPU_SLOT_HELD`, passes the AnythingLLM key in the env only, runs the Python
  CLI with a 15-minute timeout, and emits `memory-compaction`.
- **Auto (OFF by default, D13):** `memory.scrolls.autoCompact`.
  - It checks every 300 s and needs 10 min of quiet, plus a threshold of 50 KB or 25 turns.
  - Each run makes at most 1 LM call.
  - The host kills the child only while it is in the `distill` phase and foreground work is queued (D19).

### Librarian read path (strictly read-only)

- `gather_local` reads scrolls first: only `core/`, `projects/` and `patterns/` `*.md`. It skips links and
  bad frontmatter and returns at most 3 items. Each item is prefixed with
  `[scroll <id> v<n> · archives: <ids>]`.
- The scrolls and archive roots are excluded from the ordinary file walk, and the preview folder is excluded
  from staging outputs.
- Forensic lookup (D15): when the Librarian's reply cites an `arch-…` id that appears in a packet scroll
  header, the worker (not the model) runs `archive_lookup`. It does this for at most 2 ids per task.
  - The id is validated, the path is built from it, links are refused, and gz files over 8 MB are refused.
  - At most 4 MB is decompressed, and at most 5 excerpts of 400 characters are returned, scrubbed.
  - The results are added to `librarian_notes.forensic[]` (1600 characters in total). There is no extra
    model call.
- A source-level ban test forbids every write primitive in `librarian.rs`.

## 2. Gates

The gates were run at the start of this pass and again after the report was written.

| Gate | Result |
|---|---|
| `command center/`: `npm run typecheck` | clean |
| `npx vitest run` | 84 files, 1482 passed |
| `npm run test:scripts` | 6 passed |
| `src-tauri/`: `cargo test --lib` | 721 passed, 29 ignored (Smart App Control did not block it) |
| `cargo check --lib` | clean, 0 warnings |
| repo root: `python tests/run_all.py` | 223 tests OK |
| Latest run (2026-11-19 18:40, D: memory root) | typecheck clean; vitest 84 files / 1,484; test:scripts 6; `cargo test --lib` 725 passed / 29 ignored; `cargo check --lib` clean; `python tests/run_all.py` 343 OK |
| `git check-ignore` of `archive/memory/x.jsonl.gz`, `data/memory-scrolls/state.json`, `staging/memory-scrolls-preview/x` | all three ignored |

## 3. Smoke

### S0 preflight

- **Branch:** `feat/thoughtform-pipeline`; `command center/package.json` exists.
- **LM Studio :1235:**
  - `/api/v0/models` showed exactly one loaded model, `qwen/qwen3.5-9b` (vlm). Nothing else was loaded.
  - `/v1/models` listed only installed models; no load was triggered.
  - `nvidia-smi` showed 0 % GPU utilisation before each live step.
- **Gateway :8080:** up (`/api/status` healthy), but `GET /api/os/gpu` returns 404.
  - The running gateway process predates the lease endpoint and was not restarted.
  - The desktop app was not running, so no GpuSlot lease could exist.
  - So the CLI ran with `--assume-idle`, and the **live model** was used (not the recorded fake).
- **AnythingLLM :3001:** `/api/ping` returned online.
  - The key was read from Windows Credential Manager (not from env) and never printed.
- **Baseline snapshot** (`baseline.py` in the scratch folder):
  - Files: the `C:\ai-hub\memory` listing with sizes and mtimes (1 file, `agentic-os.sqlite`).
    `knowledge-graph.json`, `C:\ai-hub\memory\scrolls`, `D:\ai-hub-archive`, `repo/archive` and
    `repo/data/memory-scrolls` were all absent.
  - Mtimes recorded for `.env`, os.json and providers.json.
  - AnythingLLM: docpath list per allowlisted workspace (`coder`, `designer`, `librarian`, `ops`,
    `prompter-dispatcher`). All 5 had 0 documents.

### S1 full live dry-run (read-only)

Command: `python scripts/offload_rag_to_scrolls.py --json --trace-requests --assume-idle`.
Preview: `staging/memory-scrolls-preview/20261119-103034/`.

| | Count | Size |
|---|---|---|
| Raw local files on disk | 18 files: `chat-history.json`, `os-threads.json`, 1 training log, 7 `brain/*.md`, 8 `C:\ai-hub\master\*.md`, 0 Tony notes | 144,438 B |
| Raw local records extracted | 350 records: gateway chat 70, threads 152 (1 Booking thread skipped), training logs 113 (1 Booking line skipped), 15 docs | 104,228 B |
| AnythingLLM documents (allowlisted workspaces) | 0 | 0 B |
| AnythingLLM chats | 12, all from `prompter-dispatcher` | 38,449 B |
| **Total raw input** | 362 records | **142,677 B** |
| **Proposed scrolls** | **4**: `core/architecture_decisions` 2,862 B, `core/identity_and_preferences` 4,725 B, `patterns/lessons_and_fixes` 2,804 B, `projects/agentic-os` 2,216 B | **12,607 B** |
| Proposed KG entities | 12 (identity target only) | `kg-preview.jsonl` 3,236 B |

**Estimated reduction**
- Text: 142,677 B down to 12,607 B, about **91 %** smaller (11.3:1).
- Vector chunks: 0 now, 14 after. The allowlisted workspaces hold no embedded documents today, so `--apply`
  frees nothing on C:; the C: freed estimate is 0 B. The reduction is in what the Librarian has to read,
  not in disk space.

**LLM use**
- Live, 8 calls (the `--max-llm-calls` default at the time; the default is now automatic), made one at a time.
- Only `core/identity_and_preferences` came out as a model-distilled preview (4,725 B, over the 3 KB
  target and under the 5 KB cap).
- `architecture_decisions` and `lessons_and_fixes` fell back to the extractive preview, because the model
  used entity types outside the allowed list (`agent`, `pattern`) and the reply was rejected.
- `projects/agentic-os` was extractive because the call budget ran out.

**Confirm token:** `f62f056d7db3`. `manifest.json` lists 0 AnythingLLM documents and 23 local sources.

**Assertions**
- **Request trace:** 10 requests, all `GET`.
  - The paths were `/api/v1/workspace/{slug}` and `/api/v1/workspace/{slug}/chats` for the 5 allowlisted
    slugs only.
  - No path contained `my-workspace` or `booking`, and there was no `/v1/documents` or `/v1/workspaces`.
- **What `--apply` would validate:** I re-ran `_promote_plan`, the step `--apply` runs before it writes
  anything, read-only against this preview. All 4 previews pass.
- **Secrets:** 0 key-shaped strings and 0 known secret values (12 checked) appear anywhere in the preview.
- **Baseline:** unchanged after S1.

### S2 synthetic noisy batch: archive, distilled scroll, sync (scratch roots only)

- **Inputs:**
  - Fixture: `<scratch>/p3-smoke/s2/data/command-center/os-threads.json`.
    - 40 turns in thread `tony`: greetings, "retrying…", a 60-line stack trace, a 40-line tool dump, durable
      facts, the 1234-to-1235 contradiction, a fake `sk-test-…` secret and a system turn.
    - Plus a `booking` thread holding a canary string.
  - Every env path pointed at scratch: `CC_DATA_DIR`, `MEMORY_SCROLLS_DIR`, `MEMORY_KG_PATH`,
    `MEMORY_ARCHIVE_DIR`, `MEMORY_STATE_DIR`, `AOS_TASKS_DB` (absent), `AOS_STAGING_DIR`, `AOS_NOTES_DIR`.
  - `ANYTHINGLLM_BASE` pointed at an in-process `StubAllm`, with a fake key and `AOS_NO_KEYCHAIN=1`.
- **Command:** `python -m memory_scrolls compact --json --max-batches 4 --assume-idle`, run in-process by
  `run_s2.py`.
- **LLM:** live `qwen/qwen3.5-9b`, 4 calls, one at a time.

**Trace**
1. Collect: 39 records. The Booking thread was skipped and the system turn dropped; `tasks.db` was missing,
   which exercised the skip path.
2. Archive:
   - `archive/2026/11/arch-2026-11-19-01.jsonl.gz` was written: 1,787 B gz, 11,713 B raw, 39 records,
     2 redactions.
   - The manifest `sha256_gz` and `sha256_raw` match the recomputed hashes, `archive.verify` passes,
     `prune_allowed` is true, and the gzip header mtime is 0.
   - Neither the canary nor the system turn is in the archive.
3. Distill: 4 targets, 4 scrolls at `version: 1`, each with
   `source_archive_ids: ["arch-2026-11-19-01"]` and valid 6-key frontmatter. Sizes from the run output:
   architecture 557 B, identity 465 B, lessons 514 B, project 1,010 B (all well under 5,120 B).
   - `core/architecture_decisions.md` holds `Whisper STT: port 8178 (locked)` and
     `LM Studio: port 1235 (moved from 1234; port 1234 retired)`.
   - Its `## Superseded Decisions` holds
     `2026-11-19: LM Studio: port 1234 -> LM Studio: port 1235 (arch-2026-11-19-01)` (plus a near-duplicate
     line the model wrote itself).
   - `patterns/lessons_and_fixes.md` records the 8177 `ConnectionError` and its fix. The stack trace itself
     was collapsed by the pre-filter.
4. KG: the scratch `knowledge-graph.json` was created as JSONL with 20 lines, all of which parse. It has
   entity lines such as `Whisper STT` (service, "Runs on port 8178") and `LM Studio`, plus one entity per
   scroll.
5. Sync: `StubAllm` saw exactly 4 `POST /api/v1/document/raw-text`, all with `addToWorkspaces: librarian`
   and docSource `agentic-os-scroll`. There was no remove-documents and no other workspace.
6. Fake secret: it appears only in the fixture. It was scrubbed from the archive, scrolls, KG, state and
   stdout (0 hits).
7. Second run: a no-op. It found 0 new records, wrote 0 archives, made 0 LLM calls and sent 0 AnythingLLM
   requests.

**Quality notes on live distillation (worth a look):**
- The `projects/agentic-os` scroll repeated two of the distiller's own rules as "Locked Decisions": the
  data-hygiene rule and the "never write secrets" rule. It also noted the tool dump as "placeholder data".
  Nothing secret leaked, but the system prompt can leak into the scroll body.
- The fixture's `C:\ai-hub` path contained a BEL character from a typo in my fixture script. The pipeline
  stripped the control character, and the model then wrote `C:\i-hub`. This is a fixture error, not a
  product bug, and the scroll-root fact was not asserted.

### S3 Librarian retrieval over the scratch roots (read-only)

Command: `cargo test --lib commands::librarian::tests::smoke_scrolls_retrieval -- --ignored --exact --nocapture`,
with `SMOKE_SCROLLS_ROOT` and `SMOKE_ARCHIVE_ROOT` set to scratch and `SMOKE_QUERY="whisper port"`.
**Passed** (Smart App Control did not block it).

- The first item was `[scroll core-architecture-decisions v1 · archives: arch-2026-11-19-01] … Whisper STT: port 8178 (locked) …`.
  The lessons and identity scrolls followed, for 3 items in total.
- `archive_lookup(arch-2026-11-19-01, [whisper, port])` returned 5 excerpts, among them record #24,
  `user: Locked: Whisper STT runs on port 8178.`, and record #28 with the 1234-to-1235 decision.
- The before and after snapshots of the scratch tree were identical, so the read path did not write.

### No-write assertions (before S1 vs after S3)

All of these were identical:
- the `C:\ai-hub\memory` listing, sizes and mtimes
- `knowledge-graph.json` (still absent)
- `C:\ai-hub\memory\scrolls` (still absent)
- `D:\ai-hub-archive`, `repo/archive` and `repo/data/memory-scrolls` (all still absent)
- the `.env`, os.json and providers.json mtimes
- the docpath list of every allowlisted AnythingLLM workspace

The only new files in the repo are the preview folder (gitignored `staging/`) and this report.

## 4. Decisions taken on Nic's behalf (all reversible)

- D1 to D19 are as planned. The main ones:
  - Python core with Rust integration.
  - Archive on `D:\ai-hub-archive`, pinned at first write.
  - Sources are never pruned.
  - Scroll sync goes only to `librarian`, with workspace-scoped un-embed.
  - The key comes from Credential Manager.
  - Auto-compact is OFF.
  - `embedOnly` is OFF.
  - `--apply` requires `--confirm <token>`.
  - Previews are kept.
  - The `my-workspace` `mountWorkspace` is now refused (D16).
- Smoke-time decisions:
  - **`--assume-idle`:** the running gateway predates `/api/os/gpu` (404), the desktop app was not running,
    the GPU was at 0 % and exactly one chat model was loaded. So the live model was used, not the
    recorded fake.
  - **S2 used `--max-batches 4` instead of 2,** so all 4 targets finished and the second run could prove a
    no-op.
  - **The dry-run preview is left in place** under `staging/memory-scrolls-preview/20261119-103034/` for
    review.
  - **`MEMORY_ARCHIVE_DIR` is not in `.env`.** The code default (D: fixed drive) applies.

## 5. NOT verified

- `--apply` against live AnythingLLM and the real `C:\ai-hub` (by design: Nic runs it).
- The Rust host trigger, the Settings card and button, and auto-compaction in a running app. There was no
  `tauri dev` or `tauri build`; these are covered by Rust unit tests and vitest only.
- The worker-path forensic hook end to end (it needs the app); it is covered by B unit tests.
- The gateway lease check (`GET /api/os/gpu`) live. The running gateway must be restarted to serve it;
  until then a standalone `compact-memory` defers (exit 75) unless `--assume-idle` is passed.
- Scroll sync into the real `librarian` workspace (stub only).
- The real KG file being read by the AnythingLLM server-memory MCP. The format is unit-tested against 2.1.1.
  The two Claude.exe-spawned server-memory instances use a different, unknown file, which was not touched.
- The extractive previews' fitness as long-term scrolls. Three of the four in S1 are extractive and contain
  raw-line noise, for example a JSON training-log line.

## 6. Known gaps and risks

- **Rejected replies fall back to extractive.** Unknown entity types are now mapped onto the allowed list
  instead of rejecting the reply, and a fixable rejection gets one repair call. In the 12:55 re-preview
  (section 7), architecture is now model-written, but the project target still fell back: its last chunk's
  reply put the markdown in `target_scroll`, and the repaired reply dropped a locked bullet. A failed last
  chunk discards the target's earlier model chunks too, so the whole target goes extractive.
- **Noise under Locked is sticky.** A locked bullet can only be removed later through a `superseded_facts`
  entry. Anything the first `--apply` promotes under a Locked heading stays until a later run supersedes it.
- **The system prompt can leak into scrolls.** The project scroll repeated the distiller's own rules (see S2).
- **The preview contains personal profile details.** The S1 identity preview carries personal profile
  details from `brain/` and `C:\ai-hub\master`. It is gitignored, but it would be embedded in `librarian`
  on `--apply`.
- **"booking agent" mentions.** Three preview scrolls carry incidental "booking agent" text from Tony's own
  thread, training log and prompter chats. This is not Booking-workspace data, but review it.
- **Orphaned document files.** Un-embedded old scroll document JSON files stay in AnythingLLM
  `custom-documents`. Their locations are listed in the ledger `orphaned`.
- **Turns can be lost before the first compaction.** `os-threads.json` is a 60-turn rolling window, and the
  120-turn localStorage store is not readable from Python.
- **`tasks.db`** is not created yet by the installed app; the source is skipped until it exists.
- **Untracked files in `C:\ai-hub`.** If `C:\ai-hub` is a git repo, the scrolls and KG will appear there as
  untracked files after `--apply`.

## 7. Commands for Nic

Run these from the repo root (`D:\Art Apps\agentic os`) with LM Studio idle and its chat model already loaded.

**Where everything lives now (Nic's decision).** The live scrolls and knowledge graph are on D:, and
`C:\ai-hub` stays read-only:

| What | Default | Override (use the same value for the CLI and the app) |
|---|---|---|
| Scrolls root | `D:\ai-hub-memory\scrolls` (`memory_scrolls/config.py` `DEFAULT_SCROLLS_ROOT`; `os_core.rs` `DEFAULT_SCROLLS_DIR`; Settings placeholder in `memory-scrolls-format.ts`) | env `MEMORY_SCROLLS_DIR`, `--scrolls-root`, or os.json `memory.scrolls.scrollsDir` |
| Knowledge graph | `D:\ai-hub-memory\knowledge-graph.json` (`config.py` `DEFAULT_KG_PATH`; `os_core.rs` `DEFAULT_KG_PATH`, which the app's built-in `kg.search` MCP reads through `mcp.rs` `KG_PATH`, so both share one graph) | env `MEMORY_KG_PATH` or `--kg-path` |
| Cold archive | `D:\ai-hub-archive` (unchanged) | env / `.env` `MEMORY_ARCHIVE_DIR`, os.json `archiveDir`, `--archive-root` |
| State, scroll history | `data\memory-scrolls\` (unchanged, gitignored) | env `MEMORY_STATE_DIR`, `--state-dir` |

- **Hard guard.** Config resolution and every writer refuse any target under `C:\ai-hub`: the scroll
  store, scroll history, the graph and its lock, the archive and its manifest, state, offload previews
  and the compaction lock.
  - The check is case-insensitive. It runs after `..`, `\\?\` and admin-share (`\\localhost\C$`)
    normalisation, and it also compares file identity, so a junction or alias into the hub is caught.
  - A flag or env value under the hub is refused with exit 2.
  - An os.json `scrollsDir` / `archiveDir` under the hub is ignored with a warning, and the default is
    used. The app's `ScrollsConfig::sanitized()` does the same.
- **Nothing creates `D:\ai-hub-memory` except `--apply` (or a later compaction run).** The tests use temp
  roots and assert that the real folder is never created.
- **Out-of-repo configs that still name `C:\ai-hub\memory`.** These were not edited; Nic repoints them by
  hand:
  - The AnythingLLM `knowledge-graph` MCP server entry (`MEMORY_FILE_PATH` in AnythingLLM's
    `anythingllm_mcp_servers.json`). Point it at `D:\ai-hub-memory\knowledge-graph.json` to share the graph.
  - The app's os.json, in two places:
    - the stored description of the built-in `knowledge-graph` MCP (text only; the app reads the path from
      code)
    - the read-only `sqlite` MCP's `--db-path` (`agentic-os.sqlite`, a 0 B file in the hub). This is a
      read source, not a Memory Scrolls target.

1. **Review the newest preview:** `20261119-184425`, token `fe63a4abe283`. It is the first preview
   made for the D: targets.
   - LM Studio had **no model loaded** at preflight, so the preview was made with `--no-llm`, and every
     scroll is **extractive**. See "Re-preview for the D: memory root" below.
   ```
   type staging\memory-scrolls-preview\20261119-184425\report.json
   dir /s staging\memory-scrolls-preview\20261119-184425\scrolls
   python -m memory_scrolls status --show-privacy-policy
   ```
   Do not edit the files: any edit invalidates the token.

   **Older previews: none can be applied.** The manifest (schema v3) now records the hashed write targets
   (scrolls root and KG path) and the Booking source-filter version. `--apply` refuses:
   - `103034`, `120122` and `125553` (schema v1, made before the privacy filter)
   - `141404`, `150608` and `151225` (schema v2: "preview predates the Booking source filter and the D:
     memory-root targets"). So tokens `04a502a35827` and `211e1ce1d9ed` are no longer valid.

   A preview is also refused if the scrolls root or KG path resolves to a different place at apply time
   than at dry-run time.
2. **Prefer a model-written preview.** Load the chat model in LM Studio, then run:
   ```
   python scripts/offload_rag_to_scrolls.py --assume-idle
   ```
   - The model budget is automatic: one call per 12k-char chunk plus one retry per target, at most 32.
     `--max-llm-calls N` overrides it.
   - `--assume-idle` is needed only while the old gateway is running.
   - Changing `data\memory-scrolls\privacy-policy.json` (for example adding `deny_terms`) invalidates
     every earlier preview.
3. Apply, with the token of the preview you reviewed:
   ```
   python scripts/offload_rag_to_scrolls.py --apply --confirm <token>
   ```
   **What `--apply --confirm fe63a4abe283` would do.** It has not been run.
   1. Check:
      - the token, schema v3 and Booking source filter v2
      - the hashed write targets: `D:\ai-hub-memory\scrolls` and `D:\ai-hub-memory\knowledge-graph.json`
      - the privacy policy (v3, hash `c11cf121d548`, no override file)
      - the preview file hashes
      - that the 5 target scrolls are still absent
      - the workspace allowlist
      - the privacy filter, re-run on every body and entity

      If any check fails, nothing is done. A read-only run of the same checks, `_promote_plan` included,
      passes with no warnings.
   2. Create `data\memory-scrolls\state.json`, plus `compact.lock` while it runs.
   3. Snapshot into the cold archive, which creates `D:\ai-hub-archive`, and pin that root in
      `state.json`. The snapshot holds 0 AnythingLLM documents plus a record listing the local and hub
      sources.
   4. **Create `D:\ai-hub-memory\scrolls\`** with 5 extractive scrolls (v1, about 5 KB):
      - `core\architecture_decisions.md` and `core\identity_and_preferences.md`
      - `patterns\lessons_and_fixes.md`
      - `projects\agentic-os.md` and `projects\ai-hub.md`
   5. **Create `D:\ai-hub-memory\knowledge-graph.json`** with 5 `scroll` entities only. The extractive
      preview has 0 model entities.
   6. Embed the 5 scrolls into `librarian`. Un-embed nothing: the allowlisted workspaces hold 0 raw
      documents.

   **What it will not do:**
   - Write anything under `C:\ai-hub`.
   - Delete chats, threads, Tony's notes, `brain/`, training logs or any other local file.
   - Touch `my-workspace` or `booking`.
   - Use system-wide document removal.
4. Afterwards:
   ```
   compact-memory --dry-run
   compact-memory --json
   ```
   The first is a read-only plan. The second needs the GPU idle; add `--assume-idle` while the old gateway
   is still running. Use `python -m memory_scrolls status --json` for status.
5. Settings > Memory > Memory Scrolls:
   - The scrolls folder field shows `D:\ai-hub-memory\scrolls` when it is empty. A folder under
     `C:\ai-hub` is refused, and the default is used.
   - "Compact & Sync Memory" runs one compaction.
   - Turn on Auto-compact when you are happy with it.
   - Turn on Embed-only after the first `--apply`, so scrolls are the only embedded layer. Tony's notes are
     still written to disk and still archived.
6. Restart the gateway when convenient, so `/api/os/gpu` exists and standalone runs no longer need
   `--assume-idle`.

### Curated first seed (round 7, Nic's decision)

**The first seed distills curated sources only.** `--sources curated` is the default of
`scripts/offload_rag_to_scrolls.py`; `--sources all` is the earlier behaviour.

| Source | Curated seed | What `--apply` does with it |
|---|---|---|
| `C:\ai-hub` (read-only): `master/*.md`, `master/handoffs/*.md`, `protocols/*.md`, root `CLAUDE.md` / `GEMINI.md` / `.clinerules` | **Distilled**, with the same deny-lists, section deny-list and MASTER_IDENTITY section allow-list as before | Never written; listed in the local-source record |
| Repo docs allow-list (`offload.REPO_DOCS`, below) | **Distilled** into `projects/agentic-os.md` (locks nothing new) | Never written |
| `brain/` (legacy aos notes) | Archive-only | Archived whole (Step A) |
| Gateway chat, `os-threads.json`, `training_logs/*.jsonl`, Tony's notes | Archive-only | Archived after their compaction watermarks (Step A), then the watermarks advance |
| AnythingLLM chats (allowlisted workspaces, GET only) | Archive-only | Archived (Step A) |
| AnythingLLM documents (allowlisted workspaces) | Archive-only | Snapshotted as before, then **kept embedded** (not distilled, so never un-embedded) |

**Repo docs allow-list** (each section cleaned: code fences dropped, table rows turned into bullets,
nested bullets dedented, run notes dropped ("today", "tonight", "smoke", "observed", "not exercised", a PID), a
Booking line dropped together with its nested lines, privacy-filtered,
scrubbed; capped per doc and at 14 KB in total; a section that does not fit is skipped and counted, a
doc's first section is cut at a line instead):

| Doc | Sections | Cap | Why |
|---|---|---|---|
| `OVERNIGHT_BUILD_REPORT.md` | "Invariants verified", "Collective memory & Librarian" | 4 KB | approve(), $0, read-only WhatsApp, Booking never written; the tasks.db store and the read-only Librarian |
| `docs/TONY_STEERING_SPEC.md` | 1 (modes), 3 (dispatch policies vs approve()), 4 (hard mic mute) | 7 KB | the live steering design (1 and 3 fit, 4 is skipped); not 8 (decisions on Nic's behalf), 9 (not verified), 10 (morning steps) |
| `docs/MEMORY_TIERING_REPORT.md` | 1 (architecture as built) | 3 KB | cut at a line after the tiers and the paths and files; not 2-3 (gate counts, smoke runs), 4-6 (decisions, not verified, gaps later fixed), 7+ (run logs) |

Not used: `AGENTS.md` and `brain/` (they describe the legacy aos), `command center/HANDOFF.md` (a Cline
build handoff with legacy names, a stale LM Studio port and a backlog of to-dos). There is no
`command center/README.md`. With the live repo the three docs give 12,224 B of input. A first live run
with 24 KB caps (18,239 B of input) made a 5,072 B project scroll (over the 3,072 B target, 48 B under
the hard cap), so the caps were cut and the repo hint now says the docs are never locked decisions.

**Step A for archive-only sources (`--apply`, curated only).** After the token, schema and policy checks
and the all-previews validation, and after the AnythingLLM snapshot:
1. Read the archive-only local sources from the CURRENT `state.json` watermarks (the same collectors and
   Booking filters as compaction), `brain/` whole, other note files whole, and the AnythingLLM chats
   (GET, allowlisted workspaces).
2. Write them to the cold archive (`agentic-os.archive.v1`, source kind `offload_archive_only`, split at
   256 KB, gz with mtime 0, sha256 of gz and raw), re-read and verify each, append the manifest row.
3. Only then advance the watermarks `gateway_chat`, `notes`, `threads`, `training_logs` in `state.json`
   and record `offload_seed` (archive ids, per-source counts).
4. Promote as before. Every scroll cites the archive that holds the local-source list.

A Step A failure raises before anything is promoted and leaves the watermarks unchanged. A later
`compact-memory` run archives and distills only records newer than the seed (today's Tier-1 -> Tier-2
behaviour, with every guard). Nothing is deleted: chats, threads, notes, `brain/`, training logs and the
AnythingLLM documents all stay where they are.

**Manifest v5.** It binds `sources.mode`, `sources.allowlist_sha` (`offload.curated_allowlist_sha()`:
the repo-doc allow-list, caps, the hub allow / deny / section lists, the plan-file rule, the archive-only
source list and watermark list), the per-source counts (`distilled` and `archive_only`, records and
bytes), the watermarks `--apply` advances and the sha256 of each repo doc read. `report.json` carries the
same block plus per-doc section counts; NDJSON emits one `sources` event (dry-run) and one
`archive_only` event (apply). `--apply` refuses a v4 or older preview ("predates the curated-seed source
mode ..."), a preview with no known mode, a curated preview whose allow-list hash differs from this build,
and an explicit `--sources` that differs from the preview's mode.

```
python scripts/offload_rag_to_scrolls.py --assume-idle             # curated dry-run (default)
python scripts/offload_rag_to_scrolls.py --assume-idle --sources all   # the earlier, full mode
python scripts/offload_rag_to_scrolls.py --apply --confirm <token>  # uses the preview's own mode
```

**Live curated dry-run (2026-11-19 22:51, `--assume-idle`, loaded `qwen/qwen3.5-9b` only, sequential).**
Preview `staging/memory-scrolls-preview/20261119-225111`, token `3ccdfcb3c764`. Not applied.

- **Sources.** Distilled: hub 16 records (13,817 B), repo docs 3 records (12,224 B). Archive-only (what
  `--apply` Step A would archive): AnythingLLM chats 12 (38,449 B), `brain/` 7 (5,664 B), gateway chat 68
  (8,924 B), os-threads 149 (23,534 B), training logs 112 (31,431 B); Tony's notes 0. AnythingLLM
  documents 0 (nothing to keep embedded or un-embed).
- **Calls.** 6 of 6 planned (budget 11), no repair needed. All 5 scrolls model-written and under the
  3,072 B target: architecture 1,758 B, identity 1,540 B, lessons 612 B, agentic-os 2,005 B, ai-hub
  2,565 B. None of the archive-only sources reached the model (the dry-run never reads them into a batch).
- **Guards v3 fired:** 2 agent to-dos dropped from Lessons ("remove it", "re-download"), 1 moved to
  ai-hub Open Threads as "(needs Nic's approval)" (the catalog export / delete), 1 roadmap goal moved to
  Open Threads as "Planned:", 2 transient lines dropped ("Last updated: <date>", a dated rewrite note),
  1 non-path Key Paths bullet moved to Active State, 1 brand-new-scroll superseded fact and its log line
  dropped (agentic-os), 1 missing `## Superseded Decisions` heading added (ai-hub, empty log). Stale
  claims: the hub KG path line never reached the model; contested #4 demoted 4 times (incl. "Changes only
  through the Librarian" in identity), #5 once.
- **Privacy v6:** hub input removals finance 3 (the AI plan tier line is now one), hub_denied 2 (the
  STATUS.md:7 MCP root line is now one), life_plans 1, location 1, personality 2. The previews needed no
  output removal.
- **Checks.** The read-only `--apply` replica (`promote_check.py`, updated for schema v5, the source
  mode, the allow-list hash and the plan index) PASSES for `20261119-225111` (5 targets). It REFUSES
  `20261119-211424` ("predates the curated-seed source mode"), the two earliest round-7 previews
  (`222308` extractive, `222328`: another allow-list) and three intermediate ones (`223022`, `223626`,
  `224119`: content made before the final guard fixes). `224645` also passes but its ai-hub scroll is
  extractive (the model left out the Superseded heading; that run is why the heading repair exists).
  Secret scan of `225111`: clean (12 known values). The C:\ai-hub fingerprint (1,258 dirs, 9,657 files)
  is identical before and after; `D:\ai-hub-memory`, `D:\ai-hub-archive`, repo `archive/` and
  `data/memory-scrolls/` still do not exist; the only new paths are the round-7 preview folders.
- **Residual (minor, for review):** the architecture Repo Paths still list the hub's `agents/<name>/`
  layout and `handoffs/` at the root (the hub INDEX describes them that way); identity keeps one
  personal-history line from an allowed MASTER_IDENTITY section (borderline, as in round 6); ai-hub Open Threads
  hold 12 "Planned:" lines (over the 6-bullet section limit, still under the size target).

### Re-preview for the D: memory root (2026-11-19 18:44)

This was a live, read-only dry-run on the code with the D: defaults, the `C:\ai-hub` write guard and the
gateway-chat Booking filter. The command was
`python scripts/offload_rag_to_scrolls.py --json --trace-requests --assume-idle --no-llm`, with
`PYTHONIOENCODING=utf-8`. It wrote only `staging/memory-scrolls-preview/20261119-184425/` (token
`fe63a4abe283`, gitignored).

- **Gates before the run:**
  - `python tests/run_all.py`: 343 OK
  - `npm run typecheck`: clean
  - `npx vitest run`: 84 files, 1,484 passed
  - `npm run test:scripts`: 6 passed
  - `cargo test --lib`: 725 passed, 29 ignored
  - `cargo check --lib`: clean
- **Preflight failed for the model.** LM Studio :1235 answered, but it had **0 loaded models** (16
  downloaded, all `not-loaded`).
  - So the model was not called. The run used `--no-llm`, which makes an extractive preview and sends no
    request to LM Studio.
  - The desktop app was not running.
  - The gateway returned 404 for `/api/os/gpu` (old gateway), hence `--assume-idle`.
- **Safety.**
  - AnythingLLM saw GET only: 10 requests, for the workspace and chats of the 5 allowlisted slugs.
  - `C:\ai-hub` was byte-identical, with identical mtimes: 9,657 files and 1,258 directories (5,098 files
    hashed), 0 differences.
  - The no-write baseline, now extended to record `D:\ai-hub-memory`, was identical before and after:
    - `C:\ai-hub\memory` (1 file); no KG; no hub scrolls folder
    - `D:\ai-hub-memory` **absent**
    - `D:\ai-hub-archive`, repo `archive/` and `data/memory-scrolls/` absent
    - `.env`, os.json and providers.json sizes and mtimes unchanged
    - 0 documents in each allowlisted workspace
  - All 6 older previews were hash-checked before and after; none changed.
  - Secret scan: 0 of 12 known values, and 0 token-shaped strings, emails or IP addresses. The only digit
    runs are timestamps and hashes.
  - Read-only `_promote_plan` check: `184425` passes (5 targets, 0 warnings). Its manifest's write-target
    hashes match `D:\ai-hub-memory\scrolls` and `D:\ai-hub-memory\knowledge-graph.json`. All 6 older
    previews are refused.
- **Booking.** The gateway chat source now drops Booking content: 2 whole messages and 1 line were
  skipped.
  - The other sources: threads 1 thread and 8 lines, training logs 2 lines, hub 6 lines.
  - No scroll or KG line names Booking. In `151225`, `projects/agentic-os.md` had 4 Booking lines, and the
    KG had a "Booking Agent Integration" entity.

| Scroll | Mode, size | Locked bullets (durable / one-off) | Compared with `151225` |
|---|---|---|---|
| core/architecture_decisions | extractive, 1,378 B | 0 (extractive mode never locks). Guardrails: 6, all standing rules | model, 1,665 B, 6 locked |
| core/identity_and_preferences | extractive, 1,044 B | 0; Standing Rules is empty | model, 2,296 B, 6 locked |
| patterns/lessons_and_fixes | extractive, 634 B | no locked heading | model, 938 B |
| projects/agentic-os | extractive, 737 B | 0 | model, 1,433 B, 3 locked (1 wrong, 1 in Booking scope). Now it has no Booking line and no forwarding policy |
| projects/ai-hub | extractive, 1,240 B | 0 | model, 1,756 B, 0 locked |

The total is 5,033 B (`151225`: 8,088 B). `kg-preview.jsonl` is empty: 0 entities (`151225`: 22).

- **Personal categories.** None of the excluded categories reached a scroll.
  - One business name appears as a folder name inside an MCP filesystem-roots line in
    `projects/ai-hub.md`. This is the same borderline item as before.
  - The input filter removed 4 hub lines: finance 2, life plans 1, location 1.
- **Quality: why a model run is better before applying.** Extractive bodies are verbatim source lines.
  For example:
  - The identity scroll's Hardware & Constraints holds brain/ procedure lines.
  - Lessons has two generic "change something" / "run something" lines.
  - ai-hub Key Paths holds a roadmap to-do. It also repeats the old KG path
    (`C:\ai-hub\memory\knowledge-graph.json`) from the hub's own STATUS file, which is now stale.
  - Active State holds one-off status and to-do lines.

  None of these is locked.
- **Verdict.** It is safe to apply: the targets are on D:, the hub is untouched, there is no Booking
  content and no personal category, and nothing is locked. But it is **not recommended as it stands**,
  because it is a low-quality extractive preview. Load the model, make a model-written preview, review
  `projects/agentic-os.md`, then apply.

### Re-preview seeded from C:\ai-hub (2026-11-19 15:06 and 15:12)

Two live, read-only dry-runs used the hub wiring of section 9. The gate before them was
`python tests/run_all.py`: 327 OK. The command was
`python scripts/offload_rag_to_scrolls.py --json --trace-requests --assume-idle`, with
`PYTHONIOENCODING=utf-8`.

- **Preflight.** LM Studio :1235 had exactly one loaded model (`qwen/qwen3.5-9b`). The server process
  showed no CPU and the GPU sat at 0 %. The desktop app was not running. The gateway did not answer,
  so the run used `--assume-idle`.
- **Safety.**
  - AnythingLLM saw GET only: 10 requests, to the 5 allowlisted workspaces.
  - The no-write baseline was identical before and after both runs.
  - `C:\ai-hub` was byte-identical, with identical mtimes, across 9,657 files and 1,258 directories
    (sha256 for every file outside the denied areas).
  - The older previews are unchanged.
  - The secret scan found 0 hits.
- **Run 1** (`150608`): 12 calls, 5 model scrolls, 10,483 B. One defect: the hub's session-end
  status-file rule, phrased with "updating", got past the input filter into the architecture
  Guardrails.
- **Fix.**
  - `_HUB_STATUS_WRITE` now covers "updating", "filling in", "writing" and "editing".
  - `TRANSIENT_HINT` now says roadmap lines are planned work, never done or locked.
  - A new test was added. Gate: 328 OK.
- **Run 2** (`151225`, current):
  - 11 of 11 planned calls, 0 repairs.
  - 5 model-written scrolls, 8,088 B, with no extractive target.
  - 22 KG entities.
  - Never-lock moved 10 bullets (9 in the ai-hub project scroll, which locks nothing).
  - 0 privacy removals in the replies. The input filter removed 4 hub lines: finance 2, life plans 1
    and location 1.

### Re-preview after distill fixes (2026-11-19 12:01)

A second live, read-only dry-run ran after the distiller fixes: entity-type normalisation, prompt-echo
stripping, a per-target size budget, and an automatic call budget. The command was
`python scripts/offload_rag_to_scrolls.py --json --trace-requests --assume-idle`. It wrote only
`staging/memory-scrolls-preview/20261119-120122/` (token `02867a396056`).

- **Preflight.** LM Studio :1235 had exactly one loaded model (`qwen/qwen3.5-9b`) and `llama-server` was
  idle. The desktop app was not running, and the old gateway (no `/api/os/gpu`) needed `--assume-idle`.
- **Safety.** AnythingLLM saw GET only (10 requests, 5 allowlisted workspaces). `C:\ai-hub\memory`,
  `D:\ai-hub-archive`, repo `archive/`, `data/memory-scrolls/`, the `.env` / `os.json` / `providers.json`
  mtimes and the AnythingLLM doc lists were identical before and after. The old preview was untouched.
  The secret scan was clean.
- **Calls.** 13 LLM calls were made out of 13 planned (budget 17), so no target ran out of calls.
- **Total.** The 4 scrolls are 8,795 B, down from 12,607 B in the first preview.

| Scroll | First preview (`103034`) | Re-preview (`120122`) |
|---|---|---|
| core/architecture_decisions | extractive, 2,862 B (reply rejected: entityType `agent`) | extractive, 2,844 B. Types were normalised (`agent`->`tool` x5, `machine`->`concept` x2) and 1 prompt-echo line was removed. The reply was still rejected: "a superseded fact is still stated outside ## Superseded Decisions". |
| core/identity_and_preferences | model, 4,725 B (over 3 KB) | model, 2,753 B (under 3 KB) |
| patterns/lessons_and_fixes | extractive, 2,804 B (reply rejected: entityType `pattern`) | model, 982 B |
| projects/agentic-os | extractive, 2,216 B (call budget ran out) | extractive, 2,216 B. The final reply was missing a required key (`target_scroll` or `updated_markdown`). |

Quality, read in full:
- **Identity.** It is clean and on-topic: persona, communication preferences, runtime constraints and
  standing rules. The personal-profile paragraph from the first preview is gone from the scroll body.
  Two weak spots:
  - Its two Superseded entries are status changes, not decision changes.
  - It repeats the stale `brain/` claim that the environment is Linux/WSL.
- **Lessons.** Short, specific and usable. Tool Quirks is empty.
- **Architecture and project (extractive).** Still raw noise, not fit as long-term scrolls:
  - Architecture holds casual voice-chat turns, including an email summary.
  - Project holds a dispatcher model's thinking trace, with one fragment of it under Locked Decisions.
- **Knowledge graph.** The personal profile details moved there. The 12 identity entities in
  `kg-preview.jsonl` carry personal profile categories: birth year and city, hobbies and gear, vehicle,
  side projects, finances and life plans. On `--apply` they go into the knowledge graph, not into
  `librarian`. Review or trim them before applying.

### Repair retry and extractive noise filter (2026-11-19, replay only)

No new live run. The 13 logged distiller replies of the 12:01 run (LM Studio server log) were replayed
through the current code with a FakeLLM. Sources were read the same way as the dry-run, so AnythingLLM saw
GET only. Previews went to a scratch dir, not `staging/`.

What changed:
- **Repair retry.** A reply rejected for a reason the model can fix gets one repair prompt for that chunk.
  Those reasons are: bad or missing reply key, a superseded fact still stated, a dropped locked bullet,
  too large, not JSON, and heading or entity shape. The prompt carries the exact validation errors
  (scrubbed, at most 6 of 160 chars), targeted advice, and the rejected reply as fenced data (scrubbed,
  cut at 6,000 chars). The repaired reply goes through the same strict `sc.validate`. A secret-like reply
  is never repaired or echoed.
- **Budget.** Each repair counts against the call budget. The automatic budget is one call per chunk plus
  one per target. A repair runs only on a spare call: the calls left after this target's later chunks and
  after a reserve for every later target (its chunks plus one repair). A repair can never starve a later
  target.
- **Where outcomes show.** Every repair or retry is an NDJSON `repair` event. It shows per target in
  `report.json` and in `manifest.json` (`distill` block, covered by the token). The result has a
  `repairs` summary (attempted, accepted, skipped_no_budget).
- **No-op facts.** A superseded fact whose old and new differ only by an archive tag is dropped as
  `old == new`. The live architecture reply had one, which caused its "superseded fact still stated"
  rejection. The locked no-silent-loss check still applies.
- **Extractive filter.** The extractive fallback now keeps only high-signal lines: ports, paths, rules or
  decisions, and fixes. It drops:
  - chat turns, greetings and small talk
  - thinking traces (`<think>`, "Thinking Process", "Let me", "The user wants", numbered analysis)
  - JSON and code fragments, email or message summaries, tool dumps, transient status lines
- **Extractive limits.** Extractive mode never writes under a Locked heading. Only an existing scroll's
  locked section is carried over. With fewer than 3 kept lines, the scroll says "Pending distillation"
  instead of noise. The manifest marks each target extractive or pending, and `--apply` labels promoted
  scrolls `(extractive)` or `(extractive, pending distillation)`.
- **Prompt rules 10 and 11.** Superseded Decisions is only for a changed decision or value, never a status
  change. Transient status lines are not kept. When sources conflict, prefer the most recent dated source
  and never restate a claim the sources mark stale. Nothing about Nic's environment is hard-coded.

| Scroll | 12:01 preview | Replay, model fails the repair | Replay, model fixes the repair | Replay, `--no-llm` |
|---|---|---|---|---|
| core/architecture_decisions | extractive, 2,844 B, chat and email noise | model, 1,871 B, no repair needed (no-op fact dropped) | model, 1,871 B | extractive, 1,474 B, rules and paths only |
| core/identity_and_preferences | model, 2,753 B | model, 2,753 B | model, 2,753 B | extractive, 1,183 B |
| patterns/lessons_and_fixes | model, 982 B | model, 982 B | model, 982 B | extractive, 579 B, Pending distillation |
| projects/agentic-os | extractive, 2,216 B, thinking trace (one under Locked) | extractive, 1,348 B, no noise, Locked empty; repair `rejected` | model, 2,166 B; repair `accepted` | extractive, 1,348 B |

The calls were 14 out of a budget of 17 (13 planned, plus 1 repair).

Still open:
- **Identity.** The identity reply is the logged 12:01 reply, written under the old prompt. It still has
  the stale `brain/constraints.md` line "Linux environment (Ubuntu/WSL)" (Nic is on Windows 11), a
  "Status" line, and two status-change Superseded entries. Rules 10 and 11 only take effect on the next
  live run. `brain/constraints.md` is the stale source. It was not edited, because scrolls are derived.
- **Architecture.** The architecture reply (model) lists an email address under Ports & Services. Review
  it before `--apply`.
- **Next step.** A fresh live dry-run is the next step to confirm the prompt rules and a real repair.
  It ran at 12:55; see the next note.

### Re-preview after repair retry and noise filter (2026-11-19 12:55)

A third live, read-only dry-run ran on the round-2 code (repair retry, extractive noise filter, prompt rules
10 and 11). `python tests/run_all.py` before it: 272 OK. The command was
`python scripts/offload_rag_to_scrolls.py --json --trace-requests --assume-idle`. It wrote only
`staging/memory-scrolls-preview/20261119-125553/` (token `5e27f1341e06`). The two older previews were
hash-checked before and after and are unchanged.

- **Preflight.** LM Studio :1235 had exactly one loaded model (`qwen/qwen3.5-9b`). `llama-server` used 0 s
  of CPU over 4 s, and the server log showed no prediction since 12:04. The desktop app was not running.
  The old gateway still needed `--assume-idle`.
- **Safety.** AnythingLLM saw GET only (10 requests, the 5 allowlisted workspaces). These were identical
  before and after: `C:\ai-hub\memory`, `D:\ai-hub-archive` (absent), repo `archive/` and
  `data/memory-scrolls/` (absent), the `.env` / `os.json` / `providers.json` mtimes, and the AnythingLLM doc
  lists (0 documents in each). The secret scan of the preview found 0 hits (11 known values plus token
  shapes). The read-only `_promote_plan` check passes for all 4 scrolls with no warnings. The preview is
  gitignored.
- **Calls.** 14 LLM calls were made: 13 planned plus 1 repair, out of a budget of 17.
- **Total.** The 4 scrolls are 7,261 B, down from 8,795 B at 12:01.

| Scroll | 12:01 preview (`120122`) | 12:55 preview (`125553`) |
|---|---|---|
| core/architecture_decisions | extractive, 2,844 B, chat and email noise | **model**, 2,261 B, no repair needed. 5 prompt-echo lines removed; entity types normalised (`agent`->`tool` x6, `machine`->`concept` x2). |
| core/identity_and_preferences | model, 2,753 B | model, 2,505 B. 1 prompt-echo line removed; 1 unlogged Superseded line dropped. |
| patterns/lessons_and_fixes | model, 982 B | model, 1,147 B |
| projects/agentic-os | extractive, 2,216 B, thinking trace (one fragment under Locked) | extractive, 1,348 B, filtered. The last chunk's reply put the markdown in `target_scroll`. The repair was **rejected**: the repaired reply dropped a locked bullet without a `superseded_facts` entry. |

Quality, read in full:
- **Better than 12:01.**
  - Three of four scrolls are model-written (two at 12:01).
  - There are no thinking traces, JSON fragments, email summaries or chat turns in any scroll.
  - Nothing extractive sits under a Locked heading.
  - Identity has no "Status" line and no status-change Superseded entries; its Superseded section is empty.
  - Lessons is short, dated and usable, and Tool Quirks now has entries.
  - Project is short: rules, paths and fixes only. Its Current Milestone, Locked Decisions and Open
    Threads are empty.
- **Architecture: Locked Design Decisions is mixed.**
  - About 7 of its 12 bullets are real decisions: agent escalation, coder model, Librarian role, NEVER
    rules, commit policy and backup strategy.
  - About 5 are one-off voice-chat tool uses or ideas: a route lookup, a weather lookup, an inbox search,
    a casting-eligibility check and an app idea.
  - Locked bullets can only be removed later through a superseded entry, so promoting these makes them
    sticky.
  - Ports & Services lists personal consumer services next to the real services. Port 1235 is correct.
  - "Gemini (heavy/backup)" in the escalation chain may be stale; `AGENTS.md` v4.0 says agy replaced the
    Gemini CLI. The KG entity "Agentic OS Kernel" also still names the Gemini CLI.
- **Identity: rule 11 did not take.** It still says "Environment: Linux (Ubuntu/WSL)". Nic is on Windows 11,
  and the stale source is `brain/constraints.md` (not edited; scrolls are derived). The scroll body also
  carries a personal contact detail (an email address) as "User Address". On `--apply` that is embedded
  into `librarian`.
- **Project: still extractive**, and the line-to-heading placement is rough. For example, "Key Paths" holds
  rules and a client job estimate. "Active State" holds a "preferred model" line that conflicts with the
  coder model in architecture.
- **Personal-detail categories (no values).**
  - Scrolls:
    - Identity: a contact email address.
    - Architecture: personal consumer services, home hardware, a home-to-transit route (location), and a
      third-party email sender's name.
    - Project: a client job price estimate.
  - `kg-preview.jsonl` (27 entities; 16 at 12:01):
    - Music and recording gear, and video/photo tools.
    - Personal side projects, and life plans and ideas, including land, a vehicle build and trading.
    - Personality traits, and vehicle ownership.
    - Home hardware, a route between two places, and personal consumer services.
  - The 12:01 birth-year and city entity is gone.
  - All of the KG categories go into the knowledge graph on `--apply`, not into `librarian`.

**Verdict: not ready for `--apply` as it stands.** The safety side is ready: validation, token, no-write and
Booking checks all hold, and nothing is lost, because the raw sources are never pruned and the archive is
lossless. What blocks it is content that would become sticky or be embedded:
- the voice-chat tool uses under architecture Locked
- the stale Linux/WSL claim and the contact email in identity
- the personal-profile KG entities
- an extractive project scroll

Suggested before the next preview (not done in this pass):
- Fix `brain/constraints.md` at the source (Nic's call).
- Filter one-off tool-use and chat lines from Locked candidates.
- Add a contact-detail scrub for scroll bodies, and decide which personal KG categories Nic wants kept.
- When a target's last chunk fails, keep the last accepted model body instead of discarding the earlier
  chunks.
- Repair a `target_scroll` / `updated_markdown` key swap deterministically.

Minor: with `--json` and stdout redirected to a file on Windows, the NDJSON is written in cp1252, not UTF-8,
because `ensure_ascii=False` follows the console code page. A character outside cp1252 would raise at write
time. The Rust host trigger sets `PYTHONIOENCODING=utf-8` and `PYTHONUTF8=1`, so the app path is not
affected. Standalone runs that redirect output should set `PYTHONUTF8=1`.

### Never-lock rule and Tier-2 privacy filter (2026-11-19, replay only)

Two guards added for the two blockers above. No live dry-run and no `--apply` were run.

- **Never-lock rule.**
  - Prompt rule 12: Locked Decisions, Locked Design Decisions and Standing Rules hold only durable
    decisions. That means ports, paths, models and engines, architecture choices, guardrails, and
    standing preferences and rules. They never hold one-off actions, requests, lookups, searches,
    messages sent, tasks done, ideas, brainstorms or status.
  - Host gate (`distill.demote_one_off_locked`, run in `compact._prepare_reply`). A NEW locked bullet that
    reads like a one-off action or an idea is **moved, never deleted**:
    - project: actions go to Active State, ideas to Open Threads
    - architecture: to Ports & Services
    - identity: to Identity
  - The gate never touches a bullet that is already locked in the current scroll, so locked no-silent-loss
    stays strict. A durable marker keeps a bullet locked: a port, a path, a model or engine name, or
    always / never / must / default / locked / only / "use X for Y".
  - Each move is a warning and an NDJSON `never_lock` event. The counts go in `report.json` and
    `manifest.json` (`never_lock_demoted`). Extractive mode still never locks anything.
- **Tier-2 personal-data filter.**
  - Code: `memory_scrolls/privacy.py`. Defaults: `memory_scrolls/privacy_policy.py` (repo-tracked).
  - It covers everything that is embedded or reused: scroll bodies including the Superseded log,
    superseded facts, knowledge-graph entities (`kg-preview.jsonl`), and the scroll text sent to
    AnythingLLM. The cold archive is not filtered: it stays lossless, with secrets scrubbed only.
  - Excluded by default:
    - contact identifiers
    - precise location
    - finance
    - date of birth and age
    - health
    - family and relationships
    - private third parties
    - life plans and personal possessions
    - personality traits
    - personal hobbies and creative gear
    - personal consumer services
  - Allowed by default:
    - work projects
    - work tools and the software stack
    - system hardware (GPU, VRAM, OS)
    - communication preferences
    - standing rules
    - services and APIs the system uses
  - Mechanism:
    - Identifiers (email, phone, street or postal address, handle, coordinates) are redacted in place. A
      line left with fewer than 3 content words is dropped.
    - Keyword categories drop the line.
    - A KG entity goes whole when its name is personal or most of its observations are. Otherwise only its
      personal observations go.
    - Prompt rule 13 asks the distiller not to record any excluded category.
  - Every removal is counted by category, never by value. The counts go in warnings, NDJSON `privacy`
    events, `report.json` and `manifest.json` (`privacy` block), and the compact result.
  - Optional per-machine override: `data/memory-scrolls/privacy-policy.json` (gitignored, read only). It
    supports `allow` and `deny` category ids, plus `deny_terms`, which are never printed.
    `python -m memory_scrolls status --show-privacy-policy` prints the effective policy.
- **Locked bullets.** The current scroll is filtered before the model sees it and before the locked check.
  A personal locked bullet therefore leaves only as an explicit, counted privacy removal, while a
  non-personal locked bullet is still protected.
- **`--apply`.**
  - The manifest schema is now `offload-preview.v2` and records the policy version and hash.
  - `--apply` refuses a v1 preview (made before the filter) and a preview made under another policy or
    override.
  - It also re-runs the filter on every preview body and entity, and refuses a preview that still holds
    excluded content.
  - The token, file-hash, base-scroll, Booking and strict-validation checks are unchanged.

Replay of the 12:55 run: the 14 logged replies were fed to a FakeLLM over the same sources (AnythingLLM
GET-only), writing to a scratch folder only. With both guards disabled, the replay reproduces the live
`125553` scrolls and `kg-preview.jsonl` byte for byte. With the guards on:

| Target | 12:55 live (categories found) | Replay with the guards |
|---|---|---|
| architecture | 12 locked bullets, 5 one-off or idea; personal lines: consumer services x4, location x1, third party x1 | 7 locked, 0 one-off; 3 moved to Ports & Services, 2 removed (location, third party); 0 personal lines |
| identity | personal lines: contact x1 | 5 locked kept; 0 personal lines |
| lessons | none | unchanged |
| project (extractive) | personal lines: finance x1 | 0 personal lines |
| KG | 27 entities; personal by category: consumer services 5, location 1, hobby gear 2, life plans 2, personality 1 | 21 entities, 0 personal by the same classifier |

Judgement calls:
- The machines that run the system (the AI server and the laptop: CPU, RAM, GPU) are kept as system
  hardware. Nic can exclude them with `"deny": ["system_hardware"]`.
- A bare "Messaging: <app>" service line is kept, because the system bridges that app. Lines labelled as a
  music service, news source, email provider or casting platform are removed.

Gates: `python tests/run_all.py` 295 OK (272 + 23 new in `tests/test_memory_scrolls_privacy.py`).

### Review fixes to the two guards (2026-11-19, tests and re-filter only)

A review of the guards found leaks, false positives on work content, and gaps in the never-lock gate.
All were reproduced first. No dry-run and no `--apply` were run.

- **Locked bullets.** A locked bullet that the filter drops or redacts in the current scroll is no
  longer reported only inside a category count. It gets its own warning and an NDJSON `privacy_locked`
  event, listing locked heading, action (dropped or redacted) and category, with no value. The same list
  is in the compact result (`privacy.locked_removed`), `report.json`, `manifest.json` and each target row
  (`privacy_locked_removed`). `--apply` warns again when promotion removes one.
- **False positives fixed.** The following are no longer removed or redacted: spending guardrails ("never
  book over $N without asking"), advice guardrails ("never give medical diagnoses"), tech debt, invoices
  as an e-commerce feature, "for diagnosis", accessibility, "home folder", decorators and npm scopes
  (`@staticmethod`, `@app.get`, `@tauri-apps/...`), messages from a system (Instagram, Booking, React),
  "HTTP client X", "Approach B.", kanban parent/child tasks, Pub/Sub subscriptions, a Telegram group
  chat, OSM travel time, "Charging Station", "Audit Trail", "Google Drive", image-size triples, weight
  pairs, and "retirement of" a tool.
- **Leaks fixed.**
  - Phone numbers: a number at the end of a sentence, a bare run next to a phone word, E.164 and
    international groupings, and `tel:` numbers.
  - Addresses: lower-case addresses, "St."-prefixed names, apostrophe names, and US city/state/ZIP.
  - Coordinates written with degrees or N/S/E/W letters, and lat/lon pairs.
  - Age written as "N-year-old" or "Age N".
  - Finance: trailing-$ amounts, k-amounts and bare amounts after a price word, hourly rates, and
    stock or forex trading.
  - Land plans, cabin builds and side projects.
  - Private people: "<Name> emailed", "<Name>, <role>" and "newsletter from <Name>". A `person` entity
    that is neither the user nor an agent is now dropped as a third party.
  - The user's own traits on a line that also mentions agents.
  - Home hardware, hobby gear and cabin plans that a system word ("integration", "server", "*.md") used
    to exempt. Only personal consumer services keep a system exemption, and only for strong markers
    (API, MCP, webhook, OAuth, port, channel).
  - Headings other than the title and the template headings are filtered too. A personal heading
    becomes `[<category> removed]`, so it stays a heading.
- **Never-lock.**
  - Strong durable markers always keep a bullet locked: a port, a path, always / never / must / default /
    locked / required / unless / rule / policy, or an imperative "Use X".
  - Weak markers keep a bullet locked only when nothing strong marks it as a one-off: only / prefer,
    "uses X for", "is the provider", a cadence, a model name.
  - One-offs are: past actions (used for, looked up, searched, sent, created, added, ran, booked), dated
    moments, tool-call ids, and "X Check: / Search: / Lookup:" labels. Present-tense capability verbs and
    topic nouns are no longer one-offs on their own.
  - A demoted bullet takes its indented sub-bullets and continuation lines with it.
  - An existing locked bullet that a reply moved to another section is put back under its locked
    heading (`distill.relock_existing`). This is reported as a warning, an NDJSON `never_lock_relock`
    event, and `never_lock_relocked` counts.
  - Prompt rule 12 now says that a bullet already locked in the current scroll stays there verbatim.
- **Policy version.** It is now 2 because the detectors changed. `--apply` refuses a preview filtered
  under version 1, so the dry-run has to be run again.

The `125553` preview was re-filtered with the new code (counts only), with these results:
- architecture: consumer services x4, location x1 and third party x1 removed, two of them reported as
  locked removals
- identity: contact x1
- project: finance x1
- KG: 27 entities, 15 kept

That preview was written before the gate changes, so its 3 one-off locked bullets stay. A new dry-run
would demote them only if they are new compared with the current scroll.

Gates: `python tests/run_all.py` 303 OK (295 + 8 new review-regression tests).

### Re-preview with the never-lock rule and privacy filter (2026-11-19 14:14)

A fourth live, read-only dry-run ran on the code with both guards (policy version 2).
`python tests/run_all.py` before it: 303 OK. The command was
`python scripts/offload_rag_to_scrolls.py --json --trace-requests --assume-idle` with
`PYTHONIOENCODING=utf-8`. It wrote only `staging/memory-scrolls-preview/20261119-141404/` (token
`0b7edfe7170d`, gitignored). The three older previews were hash-checked before and after and are unchanged.

- **Preflight.** LM Studio :1235 had exactly one loaded model (`qwen/qwen3.5-9b`). `llama-server` used
  about 0 s of CPU over 4 s, and the server log showed no generation for 13 minutes. The desktop app was
  not running. The old gateway (no `/api/os/gpu`) still needed `--assume-idle`.
- **Safety.** AnythingLLM saw GET only (10 requests, the 5 allowlisted workspaces). These were identical
  before and after: `C:\ai-hub\memory`, `D:\ai-hub-archive` (absent), repo `archive/` and
  `data/memory-scrolls/` (absent), the `.env` / `os.json` / `providers.json` mtimes, and the AnythingLLM doc
  lists (0 documents each). The secret scan of the preview found 0 hits (12 known values plus token shapes).
  The read-only `_promote_plan` check passes for the new preview with no warnings. It refuses `103034`,
  `120122` and `125553` ("preview predates the Tier-2 privacy filter").
- **Calls.** 14 LLM calls: 13 planned plus 1 repair (rejected), out of a budget of 17.
- **Total.** The 4 scrolls are 6,357 B, down from 7,261 B at 12:55.

| Scroll | Mode, size | Locked bullets (durable / one-off) | Guards in this run |
|---|---|---|---|
| core/architecture_decisions | model, 2,257 B | 9 / 0 (Guardrails has 7 more, all durable; it is not a locked heading) | never-lock moved 1 new bullet to Ports & Services; 3 prompt-echo lines removed |
| core/identity_and_preferences | model, 2,073 B | Standing Rules: 6 / 0 | privacy removed 1 body line and 1 entity (creative gear) |
| patterns/lessons_and_fixes | model, 808 B | no locked heading | none |
| projects/agentic-os | extractive, 1,219 B | 0 (extractive mode never locks) | privacy removed 1 line (finance) from the extractive preview. In the rejected model reply, privacy removed 2 lines and 1 entity (consumer services, location) and never-lock moved 1 bullet |

- **Locked.** There are 15 locked bullets in all. All 15 are durable: models, escalation, the NEVER rules,
  commit policy, and the user-sovereignty and transparency rules. None is a one-off action, lookup or idea.
- **Personal categories remaining.** Every line was read, not only checked by the classifier.
  - No scroll and no entity in `kg-preview.jsonl` (8 entities, down from 27) holds an excluded default
    category: no contact details, locations, money, age, health, family, private third parties, life
    plans, personality traits, hobby gear or consumer services.
  - What is kept is allowed by default: the machines that run the system (system hardware), the
    system's own bridge host, and communication preferences.
  - Borderline, but not an excluded category: a guardrail that refers to the user's acting boundaries,
    and one line about when the project is built (free time and weekends).
- **Content quality (not blocking).**
  - Identity still says the environment is Linux (Ubuntu/WSL); the source is `brain/constraints.md`. Its
    Identity section also has two status-like lines (a restore event and a mode switch), and a
    localhost-binding rule sits under Communication Preferences.
  - Architecture: Ports & Services holds a GPU-throttling observation, which is a status, not a service.
    The escalation ladder and the Librarian model still name Gemini; check whether that is still intended.
  - Project is still extractive. The final chunk's reply was missing `updated_markdown`, and its repair
    stated a superseded fact outside the Superseded section, so the earlier accepted chunks were
    discarded. Its "preferred model" line conflicts with the coder model in architecture.
  - KG: one `agy CLI` observation ("required for Hermes Agent") looks inaccurate.

**Verdict: ready for `--apply` on safety, privacy and the never-lock rule.** Nothing personal and nothing
one-off would become sticky or be embedded. What remains is content quality in unlocked sections, which
later compactions can correct. The exception is the stale OS line, which will keep coming back until
`brain/constraints.md` is fixed. Recommended order: fix that source line, re-preview, then apply.

## 8. Content guards: never-lock, stale claims, schema echo, identity, privacy (reference)

The 4-lens review of the model-written preview `20261119-190907` (token `c61b56c64338`) blocked it.
The causes were in code, not in the preview files:

- the never-lock gate kept any new locked bullet that nothing flagged as a one-off, and counted a
  model name as a durable marker;
- nothing filtered stale claims, so `brain/` and hub lines brought them back;
- the dispatcher envelope from chat sources was distilled as decisions;
- an agent persona was recorded as the user;
- the privacy detectors missed diet terms, temperament judgements and a side-venture name.

The guards below close each gap deterministically. All of them run on every preview and every
compaction. `--apply` then checks that each preview is a fixed point of these guards.

### Never-lock rule

- **Locked headings** (`scroll.LOCKED_HEADINGS`): Locked Decisions, Locked Design Decisions, Standing Rules.
  They may hold durable decisions only.
- **Prompt.** Distiller rule 12 forbids locking one-offs.
- **Host gate.** In `compact._prepare_reply`, `distill.demote_one_off_locked` runs first, then
  `distill.relock_existing`.
  - A NEW locked bullet is MOVED, never deleted. Actions and status lines go to Active State
    (project), Ports & Services (architecture) or Identity (identity). Ideas go to Open Threads.
  - A bullet already locked in the current scroll is never demoted. If a reply moves one, the host
    puts it back.
- **A NEW locked bullet needs a POSITIVE durable marker** (`distill.one_off_kind`). The default is
  now inverted: a bullet with no marker reports `unmarked` and moves. **This applies to project
  scrolls only** (chat / `brain/`-fed). In the hub-fed identity and architecture scrolls an
  `unmarked` bullet stays locked, because plain hub imperatives ("Keep answers short and plain.")
  are standing rules.
  - Strong markers: a port, a path, `127.0.0.1` / localhost, or a rule word (always, never, must,
    required, forbidden, policy, guardrail, do not, unless).
  - Soft markers: "defaults to", "Default <x>:", "rule", or an imperative "Use X". A tentative
    qualifier ("for now", "to start", "pending review") beats them.
  - Weak markers: only, prefer, standard, stays, read-only, every, each, at most / max, "no X in /
    outside / without", "uses X for", "is the provider / engine / default", a cadence, or a
    standing-preference label (Style:, Tone:, Format:, Budget:, Security:, Privacy:, ...).
    Also an imperative rule (Ask / Keep / Give / Avoid / Prefer / Cite / Confirm / ... at the start),
    "one X per Y" / "one X at a time", "<x> first" and a short "No <x>" prohibition.
  - **A model or tool name alone is not a marker.** It used to be one (`distill.py`, the old weak
    list).
  - Always demoted, whatever the markers:
    - `schema`: a dispatcher field bullet. A strong key (Mutating / Payload / Missing / readBack /
      routeKind / utterance) always counts. A generic label (Role / Intent / Summary / Target /
      Workflow) counts only when the locked sections are envelope-shaped (a strong key, or 3+
      distinct envelope labels; `distill.schema_shape`). A lone "Target: Windows 11" is classified
      like any other bullet.
    - `persona`: a bullet that names the Tony or Jarvis persona (baseline conflict 2)
    - `status`: state phrasing such as active, pending <anything>, toggle, enabled, online,
      listening, restarted, recovered, currently. An explicit rule word overrides this (a port
      does not), and so does a scope or invariance word: only, every, each, stays / remains, at
      most, at a time, `<x>-only`, or an imperative "Use X". So "C:i-hub is read-only; writes are
      disabled" and "Only one active voice pipeline at a time" stay locked, while "ElevenLabs
      active; Spotify integration pending toggle" still moves.
- **Chat-only project batches lock nothing new.** A project target locks new bullets only when its
  batch holds an authoritative source (`distill.lock_sources_ok`): a read-only hub file, or a task
  envelope, handoff or build log. Chats, threads, training logs, gateway chat, `brain/` and notes do
  not count. Otherwise the target runs with `lock_new=False`, in both the offload preview and
  compaction.
  - Each target row reports `never_lock_lock_new`.
  - `projects/ai-hub.md` stays transient (`lock_new=False`).
  - Existing locked bullets keep the relock protection.
- **Reporting.** Warnings; NDJSON `never_lock` / `never_lock_relock` events; `never_lock_demoted` /
  `never_lock_relocked` / `never_lock_lock_new` per target. Extractive mode never locks.

### Stale-claims policy

- **Module:** `memory_scrolls/stale_claims.py` (`STALE_CLAIMS_VERSION = 2`; 3 since round 7, see "Round 7" below).
- **Negation (v2).** `platform-linux` and `mutating-default` are `negatable`: a match whose clause
  has a negation in the 3 words before it ("no WSL", "never the Linux machine", "not a Linux
  environment", "non-mutating") states the opposite and does not count. `mutating-default` also
  matches only the positive shapes: "Mutating: true", "mutating by default" with no false / no /
  never in between, "default mutating", and "mutating ... forwards" with no negation in between and
  no confirmation / approval / readBack right after. An override rule may set `"negatable": true`.
- **Rules.** Each rule has an id, a regex, an action (`drop` | `demote`), a reason, a conflict ref
  and an `existing` flag. The defaults (all `existing: true`) use the conflict numbers of
  `AI_HUB_BASELINE_REPORT.md` section 8:

| Rule id | Action | Catches | Ref |
|---|---|---|---|
| `platform-linux` | drop | Linux / Ubuntu / WSL as the platform | #8 |
| `legacy-agent-roster` | drop | the opencode + Hermes + Gemini CLI roster, "3 agents (...)", Gemini CLI as an agent | #1 / #3 |
| `stale-model` | drop | the retired OpenRouter model and the free opencode model as the current model | #7 |
| `cloudmart-project` | drop | CloudMart as a project | #10 |
| `hub-kg-path` | drop | the `ai-hub\memory\knowledge-graph.json` path | #15 |
| `mutating-default` | drop | "Mutating: true", "default mutating", mutating with forwarding | #22 |
| `legacy-free-tier-list` | drop | the legacy free-tier account list | #9 |
| `legacy-runtime` | drop | legacy Hermes / opencode / FastAPI dashboard runtime lines | #9 |
| `contested-librarian-sole-writer` | demote | "Librarian is the only agent that writes rules" | #4 |
| `contested-escalation-ladder` | demote | the local, then Gemini, then Claude escalation ladder | #5 |

- **Where it runs.**
  1. **Before distillation** (`guards.SourceGuard`, the new `guard=` hook of
     `distill.batch_text_spans` / `batch_text`): a source line that matches a drop rule never
     reaches the model. Demote rules leave source lines alone.
  2. **On the current scroll** (`guards.stale_current`): only rules with `existing: true` apply.
     - A dropped LOCKED bullet is logged under ## Superseded Decisions as
       `old -> (dropped: stale claim <rule> <ref>)`, never as a silent loss. The host re-adds that
       log line if a reply leaves it out (`scroll.keep_log_lines`).
     - A contested bullet leaves the locked section and becomes unlocked, prefixed `(unconfirmed)`.
  3. **On every reply** (`guards.stale_body`, `stale_entities`, `stale_facts`): a NEW matching
     bullet, KG observation or entity name is dropped. The entity name counts as the subject of
     its observations. A superseded fact whose `new` is stale is dropped; one that corrects a stale
     claim is kept.
     - A NEW contested bullet moves out of the locked sections with the `(unconfirmed)` prefix: to
       Open Threads (project), Guardrails (architecture) or Identity (identity).
     - Lines of the current scroll are never touched here. The exemption is section-aware: a line
       of the current scroll stays under a locked heading only if it was locked there. A demoted
       `(unconfirmed)` bullet that a reply moves back under a locked heading is demoted again
       (rule id `unconfirmed-relock` when no rule matches its wording), and `check_preview` counts
       it, so `--apply` refuses such a preview.
- **Override** (optional, per machine, only ever read): `<state-dir>/stale-claims.json`.

  ```json
  {"add": [{"id": "my-rule", "pattern": "regex", "action": "drop", "reason": "why", "ref": "#n", "existing": false}],
   "remove": ["contested-escalation-ladder"]}
  ```

  A bad file or a bad entry is reported by count or id and ignored. A bad file never weakens the
  defaults.
- **Inspect it:** `python -m memory_scrolls status --show-stale-claims`. It prints the version, the
  hash, the override path, and every rule. Default patterns print in full; an override pattern
  prints only as a hash.
- **Reporting.** Counts by rule id only:
  - NDJSON events: `source_guard`, `stale_claims` (`where: current_scroll`) and `guards`
    (`where: reply`)
  - per target: a `guards` block with `stale_source`, `stale_current`, `stale_output` and
    `stale_demoted`
  - `report.json` and `manifest.json`: a `guards` block

### Schema echo (dispatcher / planner envelope)

- **What counts as the envelope:** the plan fields in `command center/src/features/orchestrator/plan.ts`
  (role, intent, summary, mutating, target, payload, missing, readBack, routeKind, utterance,
  workflow) and the TaskEnvelope JSON keys. They are a message format, never a fact.
- **Sources** (chat-like records: AnythingLLM chats, gateway chat, threads, training logs):
  `guards.strip_schema_text` removes, before distillation:
  - envelope JSON objects, inline or multi-line
  - JSON field lines that name an envelope key
  - leftover brace lines
  - field label lines. A strong key (Mutating, Payload, Missing, ...) always goes. Generic keys
    (Role, Summary, Target, ...) go when a record has two or more of them.
- **Outputs:** `guards.strip_schema_body` and `strip_schema_observations` drop matching bullets and
  KG observations, using the same shape rule.
- **Log lines:** a malformed ## Superseded Decisions line ("- DATE: - old -> - new") is dropped from
  the reply, and the host writes the clean line. `scroll.body_errors` rejects a NEW malformed line.
  `distill.normalize_reply` strips list markers and archive-id tags from fact values.

### Identity

- **Roster.** `guards.py` mirrors the Command Center roster:
  - `roles.ts` `ROLE_IDS`
  - `router.ts` `SELF_ROLE_IDS` (tony, jarvis, dispatcher, orchestrator)
  - the `agents.ts` labels (Tony, Prompter, Designer, Coder, Librarian, Booking Desk, Ops)
  - the prep-only Security Patrol / Finance ids
  - the hub aliases (Conceptualizer, Dispatcher, Reviewer)

  No repo data file holds this roster. `tests/test_memory_scrolls_guards.py` parses the TypeScript
  sources and fails when they change.
- **Rules.**
  - A KG `person` entity is the operator or nothing. A person named as an agent persona is dropped
    (`persona_person`). Any other person is a private third party and is dropped
    (`third_party_person`).
  - A bullet, log line, superseded fact or observation that relabels the user as an agent ("User:
    <persona>", "for user (<persona>)", "<persona> is the user") is dropped. Role ids that are
    ordinary nouns (designer, coder, ops, booking, librarian, prompter, dispatcher, orchestrator,
    reviewer, finance) count only with "the" (never "a / an") and when the name ends the clause:
    "The user is a designer and 3D artist" is kept. "<Agent>: user / owner / operator ..." counts
    only when the user word ends the clause: "Librarian: user approves every rule change" is kept.
  - Persona names stay out of NEW locked bullets (see the never-lock rule).
  - Near-duplicate KG entities are merged, within a target and across the run
    (`guards.dedupe_entities`). They merge when they have the same type and either the same name, a
    two-word-or-longer name plus only a generic qualifier ("LM Studio" ~ "LM Studio server"), or
    same-length names with the same first word and generic head that differ in one word ("Recipe
    Scaler App" ~ "Recipe Calculator App"). "Agentic OS" vs "Agentic OS Command Center", "AI Hub"
    vs "AI Hub Memory" and "Command Center HUD" vs "Command Center Voice" stay separate.

### Tier-2 privacy filter

- **Scope.** Unchanged: scroll bodies (the Superseded log included), superseded facts, KG
  entities and every scroll synced to AnythingLLM. The cold archive is never filtered.
- **Defaults** live in `memory_scrolls/privacy_policy.py`. **`POLICY_VERSION = 5`** (6 since round 7: multi-word deny terms, see "Round 7" below), so a preview
  filtered under v4 is refused. v5 only removes false positives (see below).

| Category id | Covers | Default |
|---|---|---|
| `contact` | emails, phone numbers, street or postal addresses, handles of private people | excluded |
| `location` | home or neighbourhood, routes and commutes, stations, coordinates, IANA time zones | excluded |
| `finance` | prices, quotes, estimates, rates, income, banking, budgets in money, trading | excluded |
| `dob_age` | birthdays, dates of birth, birth year, age | excluded |
| `health` | conditions, diagnoses, medication, therapy, injuries; **v4:** diet, nutrition, calorie and protein intake, macros, body weight, BMI, body fat, activity level, meal plans, fasting; **v5:** "macros", "fasting" and "cutting / bulking phase" only in a diet context ("tracking macros", "fasting window"), never "Rust macros", "Fasting mode", "cutting phase of the video edit" | excluded |
| `family` | relatives, partners, dating, marriage | excluded |
| `third_party` | names of non-public people (email senders, friends, clients, coworkers) | excluded |
| `life_plans` | land or property plans, vehicles owned or built, home hardware, side ventures | excluded |
| `personality` | the user's own traits; **v4:** judgements of his temperament (how he reacts when pushed or challenged, "open book", stubborn / guarded / closed-off) | excluded |
| `creative_gear` | instruments, recording gear, photo or video gear, other hobbies | excluded |
| `consumer_services` | personal music, news, video, casting, shopping, email or messaging accounts | excluded |
| `work_projects` / `work_tools` / `system_hardware` / `communication_prefs` / `standing_rules` / `system_services` | system content | allowed |

- **Agent personas and output styles stay allowed.** A line with an agent word and no user subject
  ("Persona: Tony gets sarcastic when pushed", "Agent tone: quirky") is not personality data.
- **Automatic deny terms (v4).** Built at run time by `offload.hub_auto_terms` and
  `derive_auto_terms`, from the DENIED sections of the read-only hub `MASTER_IDENTITY.md` (every
  section the allow-list skips).
  - Candidates are proper nouns written mid-sentence and abbreviations.
  - A candidate is dropped when it is a common word (its lower-case form appears in the hub),
    system / roster / work vocabulary, a heading or block label, a legal suffix, or (v5) a chat /
    tech abbreviation (PR, BTW, GPT, SSD, ...).
  - **v5:** a candidate that is an ordinary English word (`memory_scrolls/common_words.py`, about
    1,300 words plus simple inflections; given names and place-like words left out on purpose) is
    kept in its capitalised form and matches only that way, in mid-sentence, as a name: "Ships with
    the Anchor shop" is removed (synthetic example), "an anchor for roles.ts", "a fixed orbit" and
    "Anchor: ..." at the start of a line are not. Against the real hub this keeps 12 of the 52 terms
    case-sensitive (the four the review named among them); the other 40 still match in any
    case.
  - A candidate is kept only when the denied sections name it more often than the rest of the hub
    does. A side-venture name mentioned once in a status line still counts as private. A machine
    or tool name used across the hub does not.
  - Lines and entities that name a term are removed under category `hub_denied`. Built-in
    categories are checked first, so a line keeps its more specific category.
  - The terms live in memory only: never stored, printed or logged. They are hashed into the
    policy `sha`, so `--apply` refuses a preview when the hub changes. Only their count is
    reported: `report.hub.auto_deny_terms` and `--show-privacy-policy` → `auto_deny_terms`.
  - Hub input lines are filtered with the same terms before the model sees them.
- **Mechanism and locked-bullet handling:** unchanged. Identifiers are redacted;
  keyword categories drop the line; a personal LOCKED bullet leaves only as an explicit, separately
  reported privacy removal.
- **Override file:** unchanged. `<state-dir>/privacy-policy.json` holds `allow`, `deny` and
  `deny_terms`.

### Prompt and cosmetics

- **Distiller rule 11** now reads: "prefer the most recent dated source (for a count, a backup
  state or a status keep only its value)".
- **New rules:**
  - 14: a request or idea from a single chat turn goes under Open Threads at most. It never goes
    under Current Milestone or into a project KG entity, unless several records repeat it.
  - 15: Lessons hold causes, symptoms and workarounds, never to-dos aimed at an outside system.
  - 16: agent and persona names are never the user, and dispatcher JSON fields are a format, not
    a fact.
- **H1 titles** come from a slug map plus an acronym map (`scroll.TITLE_SLUGS` / `TITLE_WORDS`):
  Agentic OS, AI Hub, Scene Reader. A reply's H1 is normalised when only the case, spacing or
  hyphens differ.
- **Ellipsis and CLI output.**
  - `scroll.one_line` cuts with ASCII `...`.
  - The CLI writes ASCII JSON (`ensure_ascii=True`), so a console that is not UTF-8 no longer
    shows a double-encoded ellipsis in warnings.
  - JSON readers, such as the Rust `serde_json` parser in `compaction.rs`, decode the escapes
    unchanged.

### `--apply` and the guards

- **`MANIFEST_SCHEMA = agentic-os.offload-preview.v4`.** The manifest records:
  - `stale_claims` (version, sha, override_present)
  - `guards` (`GUARDS_VERSION`, counts)
  - the v4 privacy policy (version, sha including the hashed auto terms)
- **`--apply` refuses:**
  - a v3 preview ("predates the stale-claims policy and the never-lock / identity / schema-echo
    guards"). This covers `20261119-190907` and every older preview.
  - a preview made under another stale-claims policy, guard version or privacy policy (an
    override change or a hub change)
  - a preview that is not a fixed point of the guards (`guards.check_preview`): a stale claim, a
    contested bullet still locked, a schema echo, a user relabel or a non-operator person entity
- **On promotion,** the current scroll is filtered with the same `existing: true` rules before
  the locked check.

### Replay of the blocked run (logged live replies, FakeLLM)

- **Method.** The 11 raw replies of run 190907 were taken from the LM Studio server log and
  replayed per target, with the same chunk count, through the full offload dry-run. The run used
  read-only sources and a scratch preview dir; no LM Studio call was made.
- **Before:** the pre-change package reproduces `20261119-190907` byte for byte, scrolls and
  kg-preview.
- **After:** the new package gives the counts below (rule ids and kinds only).
  - Source counts are lines kept from the model.
  - Output counts are per accepted reply, so a line repeated across chunks counts once per chunk.

| Target | Locked bullets before → after | Stale (source / output / demoted) | Schema echo (source / output) | Identity | Privacy (new) | Never-lock demoted | lock_new |
|---|---|---|---|---|---|---|---|
| core/architecture_decisions.md | 5 → 3 | 0 / 0 / 4 (contested #4, #5) | 0 / 0 | – | – | 1 | true |
| core/identity_and_preferences.md | 6 → 4 | 4 / 4 / 0 (#8, #1/#3, #9 x2) | 0 / 0 | – | personality 4, hub_denied 3 | 4 | true |
| patterns/lessons_and_fixes.md | 0 → 0 | – | – | – | – | 0 | true |
| projects/agentic-os.md | 10 → 0 | 14 / 2 / 0 (#7, #1/#3, #10, #22, #9) | 15 / 24 | persona person 1, relabel fact 1 | health 6 (3 body, 3 KG) | 4 | false |
| projects/ai-hub.md | 0 → 0 | 1 / 1 / 0 (#15) | 0 / 0 | – | – | 5 | false (transient) |

- **Result.** The after preview holds none of the blocked items:
  - no Linux/WSL, retired model, legacy roster, CloudMart, hub KG path or mutating default
  - no schema-field bullets, no persona as the user, no malformed log line
  - no diet observation, no temperament judgement, no side-venture name
  - the contested #4 / #5 bullets are unlocked and `(unconfirmed)`
  - KG: 11 → 7 entities, with one person (the operator)
  - titles are "Agentic OS" and "AI Hub"
- **Validation.** A read-only replica of the `--apply` preamble plus `_promote_plan` passes the
  after preview and refuses `20261119-190907`.
- **Still model-dependent (unlocked, minor):**
  - transient status lines in the agentic-os Current Milestone / Active State, and a "currently
    active" KG observation
  - the ai-hub milestone vs backup contradiction
  - imperative to-dos in Lessons and ai-hub Open Threads

  The new prompt rules 11, 14 and 15 address these. A fresh live dry-run is needed to see their
  effect, because the replay reuses the old replies.

### Review of the guards: false positives (2026-11-19, tests and replay only)

A 4-lens review of the guards above found 8 false-positive paths; each was reproduced first, then
fixed with a regression test (`tests/test_memory_scrolls_guards.py::FalsePositiveTests`). Versions
bumped: privacy policy 5, stale claims 2, guards 2, so every older preview is refused.

| # | Finding | Fix |
|---|---|---|
| 1 | Automatic hub deny terms included 4 ordinary English words and 1 chat abbreviation (values not recorded): any line using them was dropped as `hub_denied` | ordinary words match only capitalised in mid-sentence; chat / tech abbreviations are never terms |
| 2 | `mutating-default` dropped correct never-send rules ("Default: non-mutating", "mutating is false by default", "never forward") | negation-aware, positive shapes only |
| 3 | `platform-linux` dropped correct Windows 11 lines ("no WSL", "not a Linux environment") | negation-aware |
| 4 | user relabel fired on role words used as nouns ("Librarian: user approves ...", "The user is a designer") | generic role words need "the" and a clause end; "Agent: user ..." needs the user word to end the clause |
| 5 | KG near-duplicate merge joined distinct systems (Agentic OS / Command Center, AI Hub / AI Hub Memory, HUD / Voice) | subset merge only for generic qualifiers; swap merge only for one word between same-shape names |
| 6 | a demoted `(unconfirmed)` bullet moved back under a locked heading was re-locked and passed `check_preview` | section-aware exemption plus an `unconfirmed-relock` demote |
| 7 | status words beat rule words ("read-only; writes are disabled", "Only one active ..."), and plain hub imperatives were demoted as `unmarked` in identity / architecture | scope words beat status words; imperative markers; `unmarked` demotes in project scrolls only; generic envelope labels are schema only in an envelope-shaped body |
| 8 | health matched "Rust macros", "Fasting mode", "cutting phase of the video edit" | diet context required |

- **Replay** (the 11 logged replies of `20261119-190907`, FakeLLM, read-only sources, scratch
  preview): every blocked item stays out (no Linux/WSL, retired model, legacy roster, CloudMart,
  hub KG path, mutating default, schema bullets or persona-as-user). Counts match the previous
  replay except the identity scroll, which now keeps its 6 Standing Rules locked (4 were demoted
  as `unmarked` before; the stale ones were already dropped at the source). Privacy removals are
  unchanged on this replay: health 6, personality 4, hub_denied 3. KG: 7 entities, one person.
- **Validation.** The read-only replica of the `--apply` preamble plus `_promote_plan` passes the
  replay preview and still refuses `20261119-190907`.
- **Not fixed (by design).** A `hub_denied` removal still reports only a category count, never the
  term, so the terms stay out of every log. To check a suspected false positive, Nic can grep the
  DENIED sections of the hub MASTER_IDENTITY for the word himself.

### Source fixes for Nic (read-only sources; not edited by agents)

The filters above keep these claims out of the scrolls. The sources still state them:

- `brain/constraints.md:14`: Linux/WSL (#8); the free-tier list and runtime lines (#9)
- `brain/memory.md` and `business-brain.md`: the retired models (#7), the Gemini CLI roster
  (#1/#3) and CloudMart (#10)
- `brain/identity.md` and `recent-decisions.md`: Gemini CLI (#3)
- hub `master/STATUS.md:9`: the old KG path (#15)
- hub ROADMAP vs STATUS: the backup state

Conflicts #4 and #5 need Nic's decision. Removing a `contested-*` rule through the override file
locks them again.

### Round 7: guards v3, stale claims v3, privacy v6 (reference)

The 4-lens review of preview `20261119-211424` (token `34db7156fa6a`) blocked it: CloudMart content
without the word, a side-venture name written as one word in a hub STATUS path, chat noise and legacy
`brain/` state as project facts, roadmap goals stated as done, agent to-dos as standing lines, and junk
Superseded entries. The curated seed (section 7) removes the `brain/` and chat inputs. The guards below
are deterministic, run on every model reply (`compact._prepare_reply`, so compaction too), on every
offload preview (model or extractive), and again in `--apply`, which refuses a preview that is not a
fixed point (`guards.check_preview`, kinds and counts only). `GUARDS_VERSION = 3`; tallies land in the
`content` key of the guards block (report, manifest, NDJSON).

- **Plans never state achievements** (`guards.PLAN_FILE`, `plans_body`, `PlanIndex`). Hub files named
  roadmap / plan / goal / backlog / todo (today `master/ROADMAP.md`) are tagged line by line
  `Planned: ...` before the model sees them (`offload.tag_plan_lines`), with prompt hint `PLAN_HINT` and
  distiller rule 18. On output, a NEW bullet that carries `Planned:` or restates plan lines (at least 60 %
  of its content words, 2+ per line) better than the status lines do moves to `## Open Threads` as
  `Planned: ...`, from any section (Current Milestone, Active State, Key Paths, a locked heading); where a
  template has no Open Threads it is dropped. When STATUS and ROADMAP disagree the status line wins: a
  bullet the status lines cover as well stays where it is. A KG observation that restates a plan is
  dropped (`plan_kg`). `--apply` re-reads the hub (read-only) to rebuild the same index.
- **Agent imperatives are never standing instructions** (`imperative_kind`, `imperatives_body`). A clause
  that tells an agent to delete, remove, uninstall, (re-)download, (re-)upload, export, send, forward,
  publish, post, back up, sync, push, repoint or reconfigure, to change / edit / update config, settings,
  a `.json` / `.env` or an MCP entry, or a pending backup / upload / export to an outside service (Google
  Drive / Sheets, Dropbox, OneDrive, an external drive, GitHub, ...) is a to-do. A clause gated on a rule
  (never, don't, no, not, without, only after, ask first, approval, confirm, readBack, refused; a gate
  covers its whole sentence, so "No write, embed, upload, or delete path." is a rule) is kept, as is a
  state ("Send, reply and trash are OFF"), a parenthesised list ("(email, messages, calendar)"), a noun
  ("Send button", "Post-processing", "Download speeds are slow", "sync ledger": the verbs that are also
  nouns count only with an object after them) and a label ("Sync: ..."). In a project a NEW to-do moves to `## Open Threads` as `(needs Nic's approval) ...`; in
  Lessons, identity and architecture it is dropped; it is never locked. KG observations: dropped. Prompt
  rule 19 says the same without naming the user.
- **Superseded hygiene** (`superseded_facts`, `superseded_body`). A brand-new scroll (no prior version)
  supersedes nothing: every model-written superseded fact and `## Superseded Decisions` line is dropped
  (the facts still remove a restated old value from the body first); only a host stale-filter log line
  may appear. A no-op entry is always dropped: identical sides after normalising, the same side after a
  shared `Label:`, or a new side of "Same", "unchanged", "no change", "as before", "kept". A reply that
  leaves out the whole `## Superseded Decisions` heading (every other heading present) gets an empty one
  appended only when the current body has no Superseded line to lose; otherwise it is rejected as before
  (a live ai-hub reply did this once and fell back to the extractive preview).
- **Transient status and Key Paths** (`status_paths_body`, prompt rule 17). A NEW bullet with transient
  status (`(Online`, `Status: online / offline / running / responsive`, "is online now", a timestamp with
  a time of day, "as of / last checked <date>", "last updated: <date>", "rewritten fresh <date>",
  "today", "tonight", "right now") is dropped. Under Key Paths / Repo Paths a "Models:" label
  whose path is not a model store (models, `.lmstudio`, LM Studio, huggingface, ollama, gguf,
  safetensors, whisper, kokoro, piper, voices) is dropped; a bullet with no path at all (drive path,
  slash path, file name, URL, port, localhost) moves to Active State (project) or is dropped.
- **Host marks are not prompt echoes.** The echo check strips `Planned:`, `(needs Nic's approval)` and
  `(unconfirmed)` before comparing a bullet with the distiller rules.
- **Stale claims v3** (`STALE_CLAIMS_VERSION = 3`). New demote rule `contested-hub-single-source` (#6):
  "ai-hub / the hub is the single source of truth" with no scope; "... for operator rules and hub
  layout" or "(rules, identity)" is kept, "for everything" is no scope. `contested-librarian-sole-writer`
  (#4) now also catches "changes only through the Librarian", "only the Librarian edits / changes / updates
  rules or identity" and "edits go only via the Librarian"; "read-only" is never its "only" ("the
  Librarian is read-only; it never writes" is the AOS rule and is kept).
- **Privacy v6** (`POLICY_VERSION = 6`). Multi-word deny terms match spacing / case /
  punctuation-insensitively: "Foo Bar" also matches "FooBar", "foo-bar", "foo_bar", "foo.bar", "foobar"
  and a camel-case join in a path ("D:\Sites\MyFooBarSite"). Automatic hub terms now include the
  two- and three-word capitalised names of the DENIED MASTER_IDENTITY sections (not when every word is
  system / work vocabulary, not an ordinary lower-case phrase of the hub, and only when named more often
  in the denied sections). A phrase of ordinary words ("Green Leaf") stays a name: joined ("GreenLeaf")
  anywhere, separated only capitalised in mid-sentence, never "a green leaf". A one-word lower-case term
  also matches a camel-case join ("FooLabs"). Override `deny_terms` with a space match the same way.
  Live effect: 78 automatic terms (was 52; 26 multi-word), and the hub `master/STATUS.md:7` MCP
  filesystem-root line is now removed from the hub input (`hub_denied` 2, was 1). Also in v6: a paid
  plan or subscription tier ("<Plus / Pro / Premium / paid> plan or tier", "upgrading to <tier>", "<tier> being
  considered") is finance (baseline conflict #9); "free tier" / "free-tier first" never is. A live
  model run had put the hub's AI plan tier into a KG observation.
- **Prompt rules 17-19** (`distill.DISTILL_SYSTEM`): real, correctly labelled paths and no transient
  status; plans only as `Planned:` Open Threads, the status file wins; agent to-dos only as approval
  items. The prompt still never names the user.
- **Tests:** `tests/test_memory_scrolls_curated.py` (20 tests): the curated dry-run (no archive-only
  source reaches the model; per-source counts in report, manifest and NDJSON), repo-doc caps and the
  allow-list hash, `--apply` Step A (lossless archive, watermarks, nothing un-embedded, a later
  compaction distills only a new turn), a Step A failure (nothing promoted, watermarks kept), refusals
  (v4 preview, `--sources` mismatch, allow-list change), a synthetic replay of the round-6 blocked shapes
  through dry-run and `--apply`, a preview made without the v3 guards refused, and unit tests for each
  guard, the rules and privacy v6. Older tests that cover the full mode now pass `--sources all`; tests
  that checked a supersede log on a brand-new scroll now use an existing (v1, empty) scroll.

### Round 8: guards v5 (fidelity) (reference)

The 4-lens review of preview `20261119-233821` (token `591beba73973`) passed three lenses. The
booking-scope lens blocked it: a guardrail named the Librarian, not Nic, as the approver for installs,
and an unmarked plan told agents to fix and lock MASTER_IDENTITY / AGENTS_NEVER. The other lenses added
majors: the settled rule "Never change rules or identity files" survived only inside an "(unconfirmed)"
bullet, the KG merged two different Librarians, `auto_dispatch` lost its limits, a lesson invented "do not
use external MCPs", and `tasks.db` / `modes.json` were stated as existing. `GUARDS_VERSION = 5`, manifest
`agentic-os.offload-preview.v6`: `--apply` refuses `233821` and every older preview. All guards are
deterministic. They run on every model reply, on every preview and again in `--apply` (fixed point,
`guards.check_preview`). They only touch NEW lines, never a current-scroll line. Tallies (kinds and counts)
land in the `content` key.

1. **Approver fidelity** (`approver_fix`, `approver_body`). An install / skill / MCP / package / plugin /
   config / settings rule names Nic as the approver (hub AGENTS_NEVER and AGENTS.md: agents propose, the
   Librarian checks, Nic approves). "without (the) Librarian('s) approval" becomes "without Nic's approval
   (proposed through the Librarian)", "approved by the X agent" becomes "approved by Nic (proposed through
   the X)", and a bare "without approval" becomes "without Nic's approval". "The Librarian approves ..."
   has no safe rewrite: it is demoted "(unconfirmed)" out of a locked section, and dropped from Lessons.
   KG observations are corrected the same way.
2. **Host-owned settled guardrails** (`settled_items`, `settled_bullets`, `settled_body`). The NEVER items
   of the hub `master/AGENTS_NEVER.md`, after the hub's Booking, privacy and scrub filters, are copied by
   the host into `## Guardrails` of `core/architecture_decisions.md`. Each one is a standalone bullet: its
   NEVER sentence plus what fits in 180 characters, capped at 15 bullets and 1.8 KB. A sentence holding a
   stale or contested claim is left out ("Only the Librarian, with Nic's approval." stays in its own
   "(unconfirmed)" bullet). An item in Booking, acting or personal scope is never copied (live: "roles that
   break his acting boundaries"). The approver is fixed as in (1). A NEW model bullet under Guardrails
   that restates a settled rule is replaced by the host copy, and the copies are written in source order.
   A bullet stands for a settled rule only when it is unmarked, has the same modal (a NEVER rule needs a
   negated bullet), covers at least 50 % of the NEVER sentence's words and 40 % of the whole rule, and has
   its head verb. An unmarked bullet elsewhere that states the rule counts (the locked "Model files ...
   NEVER committed to Git" stands for item 6). A contested, unverified or planned bullet never counts, so a
   contested demotion never swallows a settled rule. The settled bullets are protected from the
   near-duplicate rule (9).
3. **Rule-file edits** (`rule_file_edit`, `imperative_kind` kind `rule_file_edit`). An order to edit, fix,
   lock, unlock, rewrite, write, change, update, modify, amend, revise, correct, patch, replace or finalise
   counts as an agent imperative when the target is a rule, identity, prompt or config file
   (MASTER_IDENTITY, AGENTS_NEVER, AGENTS.md, CLAUDE.md, rules, identity file, (system) prompts, configs,
   personas). So does a `Planned:` line stating such an edit as done ("... reviewed and locked"). As
   before: in a project it moves to Open Threads as `(needs Nic's approval) ...`; elsewhere it is dropped,
   and it is never locked. A rule about such edits ("Never change rules or identity files", "... with
   Nic's approval") is not an order. The v4 kinds win (a config edit stays `config_change`).
4. **Qualifiers** (`QUALIFIERS`, `qualify`, `qualifier_body`). This is a small table of safety-critical
   terms and the qualifier each one must carry:
   - `auto_dispatch` / "skips Tier-3": live brainstorm + pipeline target, staging/ only, and approve() still
     gates every mutating plan (TONY_STEERING_SPEC section 3);
   - `--apply`: Nic runs it with `--confirm <token>`;
   - un-embed: per workspace, after a verified snapshot.

   A NEW bullet or KG observation that names the term without its qualifier gets the host qualifier
   appended in brackets, or is dropped when that would make it longer than 480 characters.
5. **KG** (`observations_conflict`, `kg_conflicts`, `kg_scope`, `KG_COMPANIONS`). The dry-run never merges
   near-duplicate entities of two targets whose observations conflict: one side read-only or never
   writing while the other is a writer, or a contested "(unconfirmed)" claim on one side only. Both
   entities stay, named after where their batch came from: "Librarian (ai-hub)" and "Librarian (Command
   Center)" (a hub batch, a repo batch, else the scroll title). `--apply` refuses a kg-preview that still
   holds two such entities under one name. In an entity with a contested observation, the sibling
   observations that restate the rest of the claim are "(unconfirmed)" too: approval, commit, writing or
   rules for #4; Gemini, Claude or escalation for #5. A read-only observation never is.
6. **Unsupported rules** (`SupportIndex`, `support_body`). A NEW unmarked bullet that states a prohibition
   or obligation ("never", "not", "no", "without", n't; "must", "always", "required"; "only", but never
   "read-only" or `surface_only`) needs a supporting source sentence or source line of its batch. The
   source must have the same modal families, at least 2 of the bullet's content words (all of them when it
   has fewer) and its head word (the first content word after the modal). "Always X" is also supported by a
   source imperative that starts with X ("Label assumptions."). Bracketed text (host qualifiers,
   annotations, asides) is ignored. An unsupported bullet is marked `(unverified)` and moved out of a
   locked section (project: Open Threads, architecture: Guardrails, identity: Identity); in Lessons and
   Fixes it is dropped. A demoted `(unverified)` bullet is never re-locked. The index is built from the
   hub and repo-doc lines (`plan_lines`), only for a curated seed, so `--apply` re-reads exactly the same
   sources. A `--sources all` batch with chats has the check off.
7. **Storage paths that do not exist** (`annotate_paths`, `paths_body`; `offload.path_probe`). A
   read-only `exists` check runs in the known roots only: the repo and `%APPDATA%\os.agentic.commandcenter`.
   Some paths answer "unknown":
   - the Memory Scrolls write targets that `--apply` / the dry-run create (scrolls root, knowledge graph
     and their `D:\ai-hub-memory` root, archive root, state dir, staging);
   - any other absolute path, UNC, `..` or `%VAR%` other than APPDATA;
   - an unquoted path with spaces (its pieces cannot be delimited).

   Relative paths and bare storage file names are checked only for `projects/agentic-os.md`. A hub scroll's
   relative paths are hub paths. Every path token is checked under Key Paths / Repo Paths; elsewhere only
   `.db / .sqlite / .json / .jsonl` files are. A missing one gets "(planned, not created yet)" after its
   first mention, and in the KG a missing path entity gets it on its observations. An annotation is never
   removed again, so a file created later never makes a preview refuse.
8. **Command Center overview** (curated allow-list). There was no current overview section in any doc:
   - `command center/HANDOFF.md` sections 1-2 still name LM Studio :1234, the legacy chat chain and a
     private host;
   - `ARCHITECTURE_DECISIONS.md` covers only the build pipeline and is being edited by another session;
   - the OVERNIGHT TL;DR is a run log.

   So section 0 of this report ("The Command Center at a glance") was written from the code. It covers
   the app, Tony and the roster, gateway :8080 + `/api/os/state`, Whisper :8178, Kokoro :8880 /
   ElevenLabs, LM Studio :1235, Play Place / Build Hub and modes. It is selected before section 1, which
   is now cut at a line within the doc's 4 KB (`REPO_SECTION_CUT_MIN = 1024`; total repo cap 15 KB). The
   allow-list hash changes (`curated_allowlist_sha` includes the cut minimum). `REPO_HINT` asks for a 2-4
   bullet Current Milestone from it.
9. **Hygiene** (`dedupe_body`, `count_fix`, `measure_fix`, `hygiene_body`):
   - Of two near-duplicate top-level bullets of one section, the later NEW one goes. They count as
     duplicates when they share the same numbers, at least 80 % of the shorter one's words and 50 % of
     the longer one's, so "port 1234" vs "port 1235" is a change, never a duplicate.
   - A bullet introducing a list with ":" loses the one count that disagrees with its sub-items ("same 7"
     over 4 items becomes "same").
   - One-night measurements go. These are "~80 KB", "41 rows ~100 KB", and size numbers under a "Disk
     footprint" label. Caps and thresholds stay ("≤64 KB", "past 400 rows log only ...").

**Replay** of the 6 logged live replies of `233821` (LM Studio server log) through a per-target FakeLLM.
Sources were read-only, and the previews were written to `<scratch>`.

| Shape (r7 review) | before (v4 code) | after (v5 code) |
|---|---|---|
| "without Librarian approval" | architecture Guardrails | gone; "without Nic's approval. Propose it through the Librarian." |
| "Never change rules or identity files" standalone | missing (only inside the "(unconfirmed)" bullet) | Guardrails bullet; the contested bullet stays "(unconfirmed)" |
| settled AGENTS_NEVER items in Guardrails | 9 model paraphrases | 13 host copies (9 replaced, 4 added: keys, rules / identity, labels, finish line); acting item never copied; model-file rule kept as the locked bullet |
| "fix anything wrong, then lock v1" / "reviewed and locked" / "Write ... prompts" | plain `Planned:` | `(needs Nic's approval) Planned: ...` |
| `auto_dispatch skips Tier-3 offer card` | no limits | qualifier appended |
| KG Librarian | 1 merged entity, 2 unmarked #4 variants | "Librarian (ai-hub)" (3 observations, all "(unconfirmed)") and "Librarian (Command Center)" (read-only) |
| "do not use external MCPs" | Tool Quirks | dropped (no source sentence) |
| "Agents load only necessary context ..." (LOCKED) | locked | `(unverified)`, moved to Guardrails |
| `tasks.db` / `modes.json` | stated as existing (scroll x4, KG x3) | "(planned, not created yet)" |
| "same 7" over 4 items / duplicate "D drive" plan / disk footprint | present | "same" / dropped / measurements dropped, caps kept |

The identity scroll is unchanged and every Standing Rules bullet is supported. The replay preview passes
the read-only `--apply` replica (`promote_check.py`: PASS, 5 targets). The same replica refuses `233821`
("predates the v5 fidelity guards"). C:\ai-hub fingerprint IDENTICAL. D:\ai-hub-memory, D:\ai-hub-archive,
repo `archive/` and `data/memory-scrolls/` are still absent.

**Tests:** `tests/test_memory_scrolls_fidelity.py` (26 tests, synthetic): unit tests for each guard, each
with a fixed-point check, plus `R7ShapesV5Tests`. That class replays the r7 shapes through dry-run and
`--apply` (code 0), refuses a kg-preview whose conflicting entities were merged back and a v5 preview,
and keeps the overview with section 1 cut. Existing tests adjusted:
- the curated fixture's SYSTEM.md now states "Gateway binds to 127.0.0.1 only", so its locked bullet is
  supported;
- the manifest schema assert is v6;
- a patched `content_body` lambda takes the new `policy` argument.

Gate: `python tests/run_all.py`, 438 tests OK.

### Round 9: polarity and fidelity fixes to guards v5 (reference)

The booking-scope lens blocked preview `20261119-233821` on 13 confirmed findings. All 13 are fixed, each
with a regression test (`R9*` classes in `tests/test_memory_scrolls_fidelity.py`). The guards version
stays 5: `--apply` already refuses any preview that is not a fixed point of the current guards, so
`233821` needs a fresh dry-run.
- **Rule support** (`SupportIndex`):
  - "always X" on a source imperative counts only when the source sentence has no modal family the
    bullet lacks, so "Never commit X" no longer supports "Always commit X".
  - A multi-sentence source line is merged only across a run of sentences with the same families.
  - A rule the bullet puts on Nic, the user or the operator needs a source sentence that names him.
  - Bracketed source text is indexed as its own sentences.
  - Stems fold a final "e" and irregular past forms (sent/send, written/write, chosen/choose).
- **Near-duplicates:** they need the same modal families, and "un-" / "non-" prefixes stay part of
  the word. `dedupe_body` drops a bullet only when the other one holds nearly all of its words.
- **Settled guardrails:**
  - The host copy is always written under ## Guardrails. A restatement elsewhere never stands for
    it.
  - A NEW Guardrails bullet is replaced only when the host text holds nearly all of its words, so an
    extra clause is kept.
- **approver_fix:** an agent approval the text itself denies ("... is not enough", "... alone",
  "not the Coder's ...") is left as written. Any other negation after it demotes the line.
- **qualify:** no qualifier is appended when every sentence that names the term is negated or says
  the feature is off.
- **count_fix:** a number after an ordinal word or a name ("Phase 5", "React 19", "v2") is not
  treated as a count.
- **Offload:**
  - A KG observation is merged into another target's entity only when that target's guards leave it
    unchanged; otherwise the two entities stay apart (`kg_merged.target_guards_kept_apart`).
  - The path probe answers None for Memory Scrolls' own output names: report.json, manifest.json,
    kg-preview.jsonl, manifest.jsonl and arch-*.jsonl.

One existing test changed on purpose: a restatement elsewhere no longer stops the host copy from being
added. Gate: `python tests/run_all.py`, 453 tests OK.

### Round 9, part 2: review of 20261120-011216, guards v6 and stale claims v4 (reference)

The 4-lens review of preview `20261120-011216` (token `20179373f44b`) passed the privacy, truth-and-locks
and quality lenses. The booking-scope lens blocked it on one item: an Open Threads bullet told agents
that the AnythingLLM MCP entry "must be repointed manually", with no approval marker, because
`imperative_kind` missed passive forms. Four majors were confirmed (2 votes each): a weakened restatement
of a settled guardrail, an unmarked contested #4 variant, an absolute Tier-3 gate, and a KG
misattribution. `GUARDS_VERSION = 6` and `STALE_CLAIMS_VERSION = 4`, so `--apply` refuses `20261120-011216`
and every older preview. It refuses on the stale-claims policy first and would refuse on the guard version
too. All changes are deterministic and only touch NEW lines. `check_preview` re-runs the same code.

1. **Passive and modal orders** (`_PASSIVE_ORDER` in `imperative_kind`). These count as `agent_action`:
   "(must | should | need(s) to | has/have to | is/are to | to) be [manually | by hand] repointed /
   reconfigured / changed / edited / updated / deleted / removed / uploaded / exported / sent / synced /
   pushed / backed up / re-downloaded / moved / renamed / installed".
   - As before, a gated sentence is not an order: never, not, without, approval, "only after / with".
   - Neither is a rule about how it happens: "must be updated atomically / via approve() / only ... /
     before ... / first".
   - A project to-do becomes `(needs Nic's approval) ...` in Open Threads. It is dropped anywhere else, and
     it is dropped from KG observations.
   - **Approval-gated plans** (`plan_needs_approval`). A `Planned:` line, or one that restates a roadmap
     line, also needs the marker when it is about curating, pruning, cleaning up, decluttering, deleting,
     purging, wiping or trashing files, or about testing all or every MCP (that covers the messaging and
     account MCPs). `imperatives_body` now takes the batch's PlanIndex.
2. **Restatements of a settled guardrail** (`settled_restatement`, `settled_restatements_body`, run right
   after `settled_body`). Once a host AGENTS_NEVER copy is under ## Guardrails, a NEW unmarked model bullet
   anywhere in the architecture scroll that restates it is dropped. That includes a NEW Locked Design
   Decisions bullet; a current-scroll line is never dropped. A restatement has:
   - the same polarity: the rule's NEVER family and no modal family the rule lacks ("always X" may restate
     a rule's imperative sentence);
   - the rule's head verb;
   - at least 2 of the rule's words, and at least 60 % of its NEVER sentence's words or of all its words;
   - at most a fifth of its own words outside the rule. A genuinely extra clause or another object keeps
     it: "Never change config files" is not "Never change rules or identity files".

   A restatement that **adds** an exception the rule lacks is always dropped, because it weakens an absolute
   rule. The exceptions are "without (explicit / prior / Nic's) approval / permission / consent",
   "unless ...", "except ...", "only with / after / when / if ..." and "until / before X approves". For that
   test the exception is cut and the head verb plus 2 of the rule's words are enough. A Guardrails bullet is
   now *replaced* by the host copy only when it is such a restatement (round 8 also replaced a 50 %-cover
   with one extra word). Both stay otherwise.
3. **Contested #4 in model bullets.**
   - Stale claims v4: `contested-librarian-sole-writer` also matches a change / edit / write / update /
     modify / amend / rewrite verb followed in the same sentence by "only (the) Librarian" (never
     "read-only Librarian").
   - `stale_body` applies `_CONTESTED_SENTENCE` per sentence to every NEW bullet (`_contested_rule`) under
     that rule's id. A host settled bullet is built from sentences that pass this check, so it is never
     touched. An override that removes the rule turns this off.
   - An "(unconfirmed)" bullet made only of a settled half plus a contested sentence ("NEVER change rules
     or identity files; only Librarian with Nic's approval") is dropped, but only when another
     "(unconfirmed)" bullet still carries the contested claim.
4. **Tier-3 gate qualifier** (`QUALIFIERS` `tier3_gate`). "only after ... Tier-3 ..." and "Tier-3 gates
   dispatch" get "(except auto_dispatch in Builder: pipeline build from a live brainstorm, writes to
   staging/ only; approve() still gates every mutating plan)". The check is negation-aware, as in round 8.
   The appended text also satisfies the `auto_dispatch` qualifier, so the result is a fixed point.
5. **KG** (`content_entities`, `offload.path_probe`):
   - (a) "(planned, not created yet)" is only ever a prefix of the whole observation. The bare store-file
     token ends with `(?![\w-]|\.\w)`, so the `modes.json` of "modes.json.bad" is not a token.
   - (b) The entity-name probe runs only for a path-like name (`path_like_name`: a separator, a drive or
     %VAR% root, or a known extension). A label such as "preview-dir" is never probed. `path_probe` answers
     None for any path naming `scroll-history`, `memory-scrolls` or `memory-scrolls-preview`.
   - (c) `entityType` "path" for a name with no separator and no extension becomes "concept"
     (`path_type_retyped`).
   - (d) In a tool or service entity, an observation that attributes something "for <another known tool>"
     (a static `KNOWN_TOOLS` list, so the dry-run and `--apply` agree) is dropped (`foreign_tool_kg`). It
     stays if a source line of the batch names both tools.
6. **Prompt** (`REPO_HINT`, prompt-only). It asks the model to keep the $0 offload invariant, to collapse
   the memory_scrolls internals into one Memory Scrolls line, and to state TTS as "Kokoro or ElevenLabs;
   an ElevenLabs failure falls back to Kokoro". No size work beyond that.

**Replay** of the 7 logged live replies of `20261120-011216` (LM Studio server log 2026-11-20.1, 01:12-01:14)
through a per-target FakeLLM. Sources were read-only and the previews were written to `<scratch>`. The v5
replay reproduces the preview's five scrolls byte for byte.

| Shape (r8 review) | before (guards v5) | after (guards v6) |
|---|---|---|
| agentic-os Open Threads "AnythingLLM MCP entry ... must be repointed manually" (blocker) | unmarked | `(needs Nic's approval) ...` |
| architecture "NEVER spend money, sign up, or accept terms without explicit approval." | Guardrails, next to the host copy | dropped (added exception) |
| architecture "NEVER change rules or identity files; only Librarian with Nic's approval." | unmarked | "(unconfirmed)", then dropped: the settled half is a host bullet, and the claim stays in the other "(unconfirmed)" bullet |
| architecture Locked "Never rebuild whole projects; ..." | locked duplicate of the host rule | dropped (locked bullets 3 -> 2) |
| agentic-os "Tier-3 gates dispatch: Envelope created only after approved Tier-3 yes ..." and the "Invariants verified" line | absolute | Builder exception appended (x2) |
| ai-hub "Planned: ... models curation (D drive)" and "Planned: ... test all MCPs ..." | unmarked | `(needs Nic's approval) Planned: ...` |
| KG `modes.json` "... renamed to modes.json (planned, not created yet).bad" | spliced inside the file name | "(planned, not created yet) Corrupt files renamed to modes.json.bad" |
| KG "preview-dir", "scroll-history" | type path, marked planned | type concept, no marker |
| KG host machine entity | type path | type concept |
| KG AnythingLLM "Has Playwright MCP for Claude Code" | kept | dropped |

Collateral of (5d): the LM Studio observation "Used as OpenAI Compatible endpoint for Cline" is also
dropped, because no source line names both LM Studio and Cline (the source line names the port).

The replay cannot show (6), because its replies are fixed: the inverted TTS line and the missing $0
invariant need a fresh live dry-run.

Still present, not blocking:
- architecture "NEVER make up facts about Nic; query MASTER_IDENTITY.md if unsure" (extra words, kept);
- agentic-os at 4146 B against its 3072 B target.

The replay preview passes the read-only `--apply` replica (`promote_check.py`: PASS, 5 targets). The same
replica refuses `20261120-011216`. C:\ai-hub fingerprint is IDENTICAL. D:\ai-hub-memory, D:\ai-hub-archive,
repo `archive/` and `data/memory-scrolls/` are still absent.

**Tests:** `tests/test_memory_scrolls_v6.py` (19 tests, synthetic), registered in `tests/run_all.py`. It has
unit tests for each fix, each with a fixed-point check, plus `R8ShapesV6Tests`, which replays the r8
shapes through dry-run and `--apply` (code 0) and shows that a guards-v5 preview is refused. Two existing
asserts changed on purpose: the guard version in the r7 e2e report is 6, and the stale-claims version is 4.
Gate: `python tests/run_all.py`, 472 tests OK.

### Round 10: the v6 detectors made narrower (reference)

The code review of guards v6 confirmed that four v6 detectors were too broad. They demoted, dropped or
re-labelled true facts, and every result was a fixed point, so `--apply` would have accepted it. All fixes
only narrow a match; no data-protecting check was loosened. `GUARDS_VERSION` stays 6 and
`STALE_CLAIMS_VERSION` stays 4: no v6 preview was ever made, and the stale-claims sha changed anyway.

1. **Contested #4 binds to the Librarian's authority** (`contested_sentence`, `_CONTESTED_BOUND`). A NEW
   bullet is demoted by `_contested_rule` only when the "only / sole" belongs to the Librarian: "only
   (through / via / by) (the) Librarian" that ends the clause or is followed by its approval or by a write
   verb; "the Librarian is the only / sole <writer, agent for rules ...>"; "the Librarian alone / only
   <writes ...>". Facts such as "the only layer synced into the librarian workspace", "the Librarian
   model only condenses ...", "... and only Nic approves" and "Librarian only reads; it never writes" stay
   locked and unmarked. The same check decides which "(unconfirmed)" bullet still carries the claim, so a
   demoted fact never lets `settled_restatements_body` drop the only real contested bullet. The policy
   rule `contested-librarian-sole-writer` was narrowed the same way: in v4, "... only (the) Librarian"
   must be followed by the clause end, "with", or a write verb (not "... only the Librarian reads the
   hub"); the older alternatives no longer cross a sentence end or a negation.
2. **Passive orders.** The bare "to be <verb>" form was removed ("turned out / used / seems / is expected
   to be installed" are facts). A schedule ("nightly", "daily", "each night", "every week") is a how-rule,
   and an order addressed to Nic ("... sent by Nic", "... for Nic") is not an agent's to-do. "must / should
   / needs to / has to / is to / are to be repointed ..." is still `agent_action`, which keeps the r8
   blocker fixed. `plan_needs_approval` skips a sentence that states a rule ("nothing is ever deleted",
   "only after Nic approves") and the adjective "curated".
3. **Restatements.** An added-exception restatement is dropped only when its cut core adds at most a fifth
   of words outside the rule. "Never change MCP config files without Nic's approval", "Never send emails
   to clients without approval" and a bullet that adds a fact after the exception all stay. A bullet that
   names a path or drive the rule does not name (`_extra_paths`: "models live on <drive>\models") is never
   a restatement, and `dedupe_body` never drops it as a near-duplicate either.
4. **KG scope suffix.** `content_entities` types and probes an entity name without the scope label that
   the cross-target merge appends (`kg_base_name`: "modes.json (Agentic OS)" -> "modes.json"). A renamed
   path entity is therefore a fixed point at `--apply`.

**Replay** of the 7 logged replies of `20261120-011216` through the round-9 replay harness: the five
scrolls and the KG are byte-identical to the round-9 replay (the r8 shapes do not use the narrowed forms).
C:\ai-hub fingerprint IDENTICAL. D:\ai-hub-memory, D:\ai-hub-archive, repo `archive/` and
`data/memory-scrolls/` are still absent.

**Tests:** 7 new tests in `tests/test_memory_scrolls_v6.py` (`R10*`, synthetic), each with a fixed-point or
`check_preview` assert where it applies. Gate: `python tests/run_all.py`, 479 tests OK.

## 9. C:\ai-hub as a read-only source (2026-11-19, tests only; no live run)

The offload now reads the operator's ai-hub repo as a read-only source of truth. Everything below is
covered by `tests/test_memory_scrolls_hub.py` against a temp hub; no live dry-run was run for this step.

- **Read-only.** Hub files are listed, stat'ed and opened for reading only (`offload._hub_read`, the only
  read path). No write, rename, lock or git command runs under the hub root. A test asserts the temp hub
  tree is byte-identical, with the same mtimes and no new paths, after a model and an extractive run.
- **Explicit allow-list, deny-list first.** Opened: the root `CLAUDE.md`, `GEMINI.md`, `.clinerules`,
  `master/*.md`, `master/handoffs/*.md` and `protocols/*.md`. Never opened: anything matching booking or
  `.eml`, `tasks/`, the messaging bridge folder, `.git/`, `memory/`, `parking-lot/`, `skills-lock.json`,
  `agents/`, and the tool folders (`.agents/`, `.claude/`, `.impeccable/`). Skipped with a reason: the
  stale skill inventory and the one-off curation prompt. A byte-identical copy (`.clinerules`) is read once.
  The report names deny rules only, never file names under a denied folder.
- **Input guards before the model sees anything.** Files are split on headings and block labels. The
  operator profile is default-deny: only the preamble, the decision filter, voice, the tech and
  how-agents-use-this sections and the emerging-ideas process are kept. Sections whose headings are
  booking, casting, money, pricing, rates, income, finance, boundaries, family, health, contact or address
  are dropped in every file; top-level (H1) headings are checked too, and in the operator profile any H1
  after the first opens its own section, which the default-deny allow-list never matches. Directories are
  read only when no path component between the hub root and them is a symlink or junction and they resolve
  inside the hub. Booking lines and the hub's "update the status file at session end" rule are
  dropped and counted. Then the Tier-2 privacy filter and the secret scrub run on the input.
- **Policy v3.** An IANA time zone (Region/City) is now a precise location. Earlier previews are refused by
  `--apply` and need a new dry-run.
- **Routing.** The operator profile, the root `GEMINI.md` "How Nic works" line and the handoff
  working-style blocks go to `core/identity_and_preferences.md`. The system, team, hard-rules and index
  files, the root `CLAUDE.md`, the rest of `GEMINI.md` (hub read order, agent role) and the status file's "Decisions locked" section go to `core/architecture_decisions.md`. The status
  file's broken / open items, the handoff end-of-job lists and `protocols/` go to
  `patterns/lessons_and_fixes.md`. The rest of the status file and the roadmap go to a new
  `projects/ai-hub.md`, never to `projects/agentic-os.md`.
- **Priority.** Within each target the operator profile comes first, then the other hub files, then
  everything else. Batch lines name their source, and lines repeated from a higher-priority record are
  dropped. Prompts carry host hints that state file roles only: the profile is the authoritative
  baseline, hub data is ai-hub protocol and not an Agentic OS step, and `projects/ai-hub.md` is transient.
  A reply line that echoes a hint is removed like a rule echo.
- **Never-lock.** Nothing new is locked in `projects/ai-hub.md`. Tentative wording ("to start", "for now",
  "next to build", "being considered", "v1 draft") moves a new locked bullet out, as an idea would; it beats
  an imperative "use X", "defaults to" or "rule", but never a port, a path or always / never / must.
- **Partial distillation.** When a later chunk fails (rejected after its retry, budget spent, or a
  transport error), the offload keeps the model body of the accepted chunks instead of falling back to
  the extractive preview. The report and manifest mark the target `partial_distillation`
  (accepted / chunks / failed chunk). `--apply` keeps that target's raw AnythingLLM documents embedded,
  as it does for a pending target. `compact` is unchanged.
- **Provenance.** Each target's report row and manifest `distill` entry have `provenance` / `sources`.
  These list the hub and brain files that fed it, the chunks they were in, and whether the body holds
  them (`model`, `extractive`, `failed_chunk`, `not_reached`, `no_signal`). The manifest also gets
  `hub_sources` (sha256 per hub file read), and the report a top-level `hub` block. Both hold counts,
  rule names, paths and hashes only.
- **Resolved: the apply target.** The defaults are now `D:\ai-hub-memory\scrolls` and
  `D:\ai-hub-memory\knowledge-graph.json`, and every writer refuses `C:\ai-hub` (section 7).
- **Still open for Nic.** A bare city name has no generic detector: add it to `deny_terms` in the local
  `privacy-policy.json`.
- **Live run and one fix (later the same day).** Two live, read-only dry-runs used this wiring. The
  first found a session-end status-file rule phrased with "updating" that got past
  `_HUB_STATUS_WRITE`; that is now fixed and tested. The second is the current preview, `20261119-151225`.
  Results, conflicts and sensitive-data flags are in section 7 ("Re-preview seeded from C:\ai-hub") and
  in `docs/AI_HUB_BASELINE_REPORT.md`.
