# Overnight Build Report: TaskEnvelope + Sequential Worker

Date: 2026-11-19 (build ran overnight, smoke finished about 06:56 EST)
Branch: `feat/thoughtform-pipeline`, base `49ca520`. Per your override (D20), I made no new branch, commits, stash, reset or push. Everything is uncommitted in the working tree for you to review and commit.

## TL;DR

- **Status:** all 7 parts plus the review/fix pass are built, and every gate is green. The live smoke passed every step it ran: 5 live worker runs, all `review_ready`, and 0 Librarian write violations.
- **Try first:** open `D:\Art Apps\agentic os\staging\minimal-status-card\index.html`. It is the "minimal status card component" the worker built tonight through Tony → Prompter → Librarian → Prompter → Designer → Prompter → Coder → gate → Librarian audit → Prompter verify. It passed on the first iteration with no blockers.
- **Needs your attention:** 9 items, listed under "Needs your attention". The most important:
  - After you rebuild, the **code stage offloads to `claude-cli` by default** (your `offloadPct` is 60).
  - The gateway and desktop changes only go live after a gateway restart and an app rebuild.
- **Nothing is live in the installed app yet.** The installed desktop app and the running gateway (PID 37292, `python server.py --port 8080`) still run the old code.

## Gates (final state, run at 06:34–06:37 and after my one test-harness edit)

| Gate | Result |
|---|---|
| `cargo test --lib` (src-tauri) | **653 passed, 0 failed, 28 ignored** (the ignored ones are the live tests) |
| `cargo check --lib` / `--lib --tests` | clean, 0 warnings |
| `npm run typecheck` | clean |
| `npx vitest run` | 64 files, **1310 passed** |
| `npm run test:scripts` | 6 passed, 0 failed |
| `python tests/run_all.py` | **139 tests OK** |

Windows Smart App Control blocked the test binary during the fix pass (os error 4551), so the fix pass's Rust tests had not run. The binary rebuilt after my harness edit was allowed, and the full Rust suite then ran green, including the 11 fix-pass tests. I changed no security settings.

## Parts

| Part | Tests added | Gate at end of part | Notes |
|---|---|---|---|
| 1 Gateway & phone queue (Python + `dispatch.ts`) | 40 py + 5 vitest | py 137 OK, vitest 1174 | os_queue claim/lease, per-kind TTL and `expired` status, `task_mirror` + `/api/tasks`, LLM default :1235 + loaded-model pin, cooperative `/api/os/gpu` lease, `_progress` eviction |
| 2 Store, events, staging, documenter, config | Rust unit tests | cargo green | `tasks.db` (TaskEnvelope + append-only `handoff_log`), event bus with severity, staging path guard, Tony's documenter, `feedback`/`worker` config |
| 3 AnythingLLM / LM Studio hardening | +31 Rust | cargo 574 | `allm.rs` is the only AnythingLLM client, read/write split; persisted thread map (no more duplicate threads); GpuSlot settle + maintenance slot; read-only workspace audit |
| 4 Permissions | +12 Rust, 5 vitest | cargo 586 | role policies by agent id; Librarian exact read allowlist; call-time role gate; Librarian `chatMode` guard; `node_modules` write hole closed |
| 5 Worker + pipeline refactor | 30 worker tests + librarian tests | cargo 627 | sequential stage worker per the addendum loop; deterministic gate then one advisory Prompter verify; read-only Librarian gatherer; legacy shims |
| 6 UX, narration, status | vitest 1287 | cargo 631 | thin Tony; status on demand; narrator queue (never interrupts you or Tony); roster voices per agent (Kokoro fallback per agent) |
| 7 Your five prompts | +11 Rust + vitest | all green | prompts in the app and in 4 AnythingLLM workspaces after verbatim backups; `/no_think` for qwen3.5 |
| Review + fix pass | +11 Rust, +10 vitest, +2 py | Rust not runnable then (SAC) | all 14 confirmed/split review findings fixed; Rust confirmed green tonight |

## Fixed (was broken)

- [x] Gateway LLM port 1234 → **1235** (`CC_LLM_BASE_URL` overrides it). Pinned to the *loaded* model, so it never JIT-loads a second one. Live after the next gateway restart.
- [x] Phone builds were falsely reported as failed: os_queue now has claim/lease and a `running` state, and `dispatch.ts` waits while an item is running.
- [x] Inbox head-of-line blocking and silent expiry: task/pipeline kinds only enqueue. Per-kind TTL leads to an explicit `expired` status with a result.
- [x] Idempotency: items are claimed before they run; `dedupe_key UNIQUE`; partial unique index on an open `idea_id`.
- [x] Duplicate AnythingLLM threads: creation is fixed (a persisted thread map, verified live). The existing duplicates were left in place (D19).
- [x] A Coder failure was masked by the Designer's HTML: only the Coder produces HTML now.
- [x] Work lost on a gateway hiccup: the envelope is persisted first, and gateway writes are best-effort mirrors (the smoke proved this against a closed port).
- [x] Ideas stuck in `prototyping`: the worker owns status and PATCHes the idea `failed`; the ledger offers Retry.
- [x] Phone pipeline stuck forever: `_progress` now evicts entries, and the `task_mirror` replaces it.
- [x] Dead BUILD_YES path, duplicate failure turn, stream double-generation: removed or fixed.
- [x] Safety fixes:
  - `valid_month` is checked on mount and unmount.
  - The mutating-verb list now catches merge_/fork_/… .
  - Grants are enforced at call time.
  - The `node_modules` junction write hole is closed.
  - `.gitignore` now covers `staging/` and `memory/tony/`.
- [x] Review findings (14), including:
  - an SSRF through redirects in `fetch.url`
  - the Comms WebSocket trusting proxied loopback
  - a stale stage result committing after cancel + retry
  - DB CHECKs hard-listing roles (now pattern-checked agent ids, per the forward-compat rule)

## Live smoke results (local only, $0)

Scratch root: `C:\Users\nicho\AppData\Local\Temp\claude\5c24697b0373cc22\9d6851da-3c2b-4105-8776-21872b819875\scratchpad\smoke-final\`. It holds one sub-folder per run (tasks.db, staging, notes) and a full log per step.

**Preflight (06:33), all passed:**
- AnythingLLM `:3001` reported `online`.
- LM Studio `:1235` responded, and `/api/v0/models` showed **only `qwen/qwen3.5-9b` loaded** (ctx 16384).
- VRAM was 8023 / 12288 MiB used (4.2 GB free) at 0 % utilisation.
- Gateway `/api/pipeline/progress` returned `{"items":[]}`.
- The kill switch is **off** (read only; the smoke does not depend on it).

| Step | Result |
|---|---|
| 4.1 Offline suites | All green (table above) |
| 4.2 Read-only AnythingLLM audit (`live_allm_audit`, GET only) | OK. Findings are under "Needs your attention". All three worker workspaces chat with the loaded 9B, so 4.4 was safe to run |
| 4.3 LM Studio direct, tip calculator | **review_ready**, iteration 0/2, 21 handoff rows, 8 model calls, **124 s**, peak VRAM 8023 MiB, GpuSlot active ≤ 1, 9 expected mirror failures (closed port) |
| Status card, scratch ("Build a minimal status card component") | **review_ready** after 3 Coder iterations (2/2), 41 rows, 209 s. The loops came from a smoke-harness artifact (see below), not a model problem |
| 4.4 AnythingLLM session path | **review_ready**, iteration 0, 269 s. Routes: Prompter → `prompter-dispatcher`, Designer → `designer`, Coder → `coder` (all `sessionId` task sessions); the Librarian went LM Studio direct both times. **Thread counts unchanged** in prompter-dispatcher/designer/coder/librarian. No `my-workspace` or `booking` traffic |
| 4.5 Restart resume | **Pass.** It stopped at `code`, reopened the DB and ran `recover_interrupted`, then finished `review_ready`. triage/preflight/spec/design/merge were each called exactly once |
| Real run → `D:\Art Apps\agentic os\staging\` | **review_ready**, iteration 0, no blockers, 19 rows, 104 s, peak VRAM 8023 MiB. The Librarian read the **real** sources (`memory\tony`, `C:\ai-hub`, the scratch tasks.db read-only) and returned 4 context items |
| 4.6 Gateway end-to-end on :8099 | **Skipped** (default skip in the plan). The Python suite covers claim, task kind and mirror PUT/GET against a temp cc.db |

**The AnythingLLM session id left by 4.4 is `task-t-1795088621350-lhs5dc`.** Its chats are additive history in `prompter-dispatcher`, `designer` and `coder`. Find or delete them in the AnythingLLM UI if you like.

**Why the scratch status-card run looped (smoke harness, now understood):**
- I passed the scratch root with forward slashes. The secret scrubber's "random-looking run" rule then redacted part of the stored `memoryDoc` path (`C:[redacted]\…`).
- As a result, the Librarian read-report said "Tony's task note is missing from memory". The Prompter's advisory verify then sent the Coder back twice to "fix" a file that isn't the Coder's.
- With a backslash root (the real run) the note resolved: no discrepancy, no loops. 4.3 and 4.4 show the same false "1 known blocker" for the same reason.
- This is unlikely in the app, where paths use backslashes with spaces. It is still listed as a follow-up below.

**Librarian zero-write assertion:**
- Every live run snapshotted (size, mtime) all of the Librarian's read sources before and after the run: the scratch root, the notes source, the hub roots and the staging root. For the real run that was 9668 files, including all of `C:\ai-hub` and `memory\tony`.
- The run then asserted that nothing changed outside the worker's own writes: tasks.db, the Coder's `staging/<slug>/`, and Tony's scratch note.
- Result: **0 violations in all 5 runs.**
- The Librarian's model calls (preflight + audit) were all LM Studio direct; it never chatted in a workspace.
- AnythingLLM writes: none. The direct runs made no AnythingLLM calls at all, and 4.4's thread counts were unchanged.

**Secret scan of all smoke outputs, DBs and staged files:**
- 0 hits for 8 known `.env` secret values.
- 0 real key-shape hits. The one regex hit was the `task-…` id matching `sk-` inside "ta**sk-**".

## Invariants verified

- [x] **No mutating plan without approve():**
  - vitest `offer-flow.test.ts`: "no approve → zero task_create (decline, timeout, park, unrelated text)" and "only approve() queues ONE task".
  - `dev-queue.test.ts`: "always raises the confirmation card before any approved:true call".
- [x] **The Tier-3 spoken offer still gates dispatch.** An envelope is created only after an approved Tier-3 yes or a ledger Run click. "Park it" stays ledger-only (`package.test.ts`).
- [x] **No secrets in TS, logs, events or envelopes.** Everything stored is scrubbed (devqueue scrub + known values). Smoke scan: 0 hits.
- [x] **WhatsApp stays read-only:** `whatsapp_send_is_refused_by_default`, `whatsapp_writes_stay_refused_for_everyone`.
- [x] **$0:**
  - No `*-api` engine is reachable from the worker (`offload_rules`: claude-api/gemini-api/droplet are never chosen).
  - The smoke ran local-only, with no research, no verifier and no ingest.
- [x] **The kill switch blocks offload, the verifier and research:** `kill_switch_blocks_offload_the_verifier_and_research`, `kill_switch_blocks_remote_listing_and_warmup`.
- [x] **The Booking workspaces (`my-workspace`, `booking`) were never written:**
  - Part 7 refuses those slugs before sending any request (tested).
  - The smoke sent no traffic to them.

## Collective memory & Librarian

- **Storage:**
  - One shared collective store: `tasks.db` in `%APPDATA%\os.agentic.commandcenter\` (not created yet; the installed app predates it). It holds specs, handoff logs, staging paths and outcomes as structured, size-capped rows.
  - Plus `memory\tony\` (Tony's notes, gitignored) and `C:\ai-hub` (read-only).
  - No per-agent RAG and no envelope embeds. Prompter, Designer and Coder are stateless between tasks; the only history they get is the per-task `sessionId`.
- **Disk footprint:**
  - A fresh `tasks.db` with one task is 80 KB, which is mostly fixed SQLite page overhead. A 3-iteration task with 41 rows is 100 KB.
  - Caps: JSON columns ≤ 64 KB, `summary_payload` ≤ 4 KB, `short_summary` ≤ 140, `voice_summary` ≤ 240. Past 400 rows per task, only critical/milestone rows are logged.
  - `memory\tony` is 7 KB today. `C:\ai-hub` is 246 MB / 9657 files, read only and never written.
- **How the Librarian reads:**
  - The worker code gathers context for the Librarian through a read-only allowlist:
    - tasks.db over a `READ_ONLY` + `query_only` connection (SELECT only);
    - text files only from `memory\`, `C:\ai-hub` and `staging\`, with caps, canonicalisation, and links and secret-looking files skipped.
  - The Librarian model only condenses that into `librarian_brief` (`value_add_brief`, `retrieved_context`, `discrepancies_flagged`), which is stored in `librarian_notes`.
  - A source-scan test enforces that `librarian.rs` has no write, embed, upload or delete path.
- **External research:**
  - Wired in the app: `web.search` through the Brave Search MCP (enabled in os.json, `BRAVE_API_KEY` present in `.env`) and `fetch.url` (public GET, redirect-checked SSRF guard). Caps: ≤ 3 searches and ≤ 3 fetches per task.
  - Off under the kill switch, `compute=Local` or `localOnly`.
  - **Not exercised live tonight:** the smoke stubs research to "unavailable" so it stays local and $0. The skip path was exercised and recorded.
- **Observed tonight:** on the real run the Librarian pulled `C:\ai-hub\master\STATUS.md`, `C:\ai-hub\master\AGENTS.md` and a Part 7 prompt backup from `memory\tony\anythingllm-prompt-backups\`. The backups probably shouldn't be agent context (see follow-ups).

## Workspace prompts (Part 7)

Your Prompter, Designer, Coder and updated Librarian (active researcher) prompts were applied:
- as the worker's built-in prompts, verbatim plus small app-contract notes;
- to the AnythingLLM workspaces, after each workspace's old prompt was backed up verbatim.

Tony's prompt went into the app only (`agents.rs` + the TS persona mirror), merged with the P5 persona rules. It does not contain the word "json". The dispatch format is a separate app-built hand-off record.

`/no_think` was added to Tony and to the Prompter (app + `prompter-dispatcher`) because qwen3.5-9b is a thinking model.

| Workspace | Backup file (`D:\Art Apps\agentic os\memory\tony\anythingllm-prompt-backups\`) | Prompt length (chars, before → after) |
|---|---|---|
| prompter-dispatcher | `prompter-dispatcher-20261119-060535.txt` | 1299 → 3450 |
| designer | `designer-20261119-060535.txt` | 608 → 2867 |
| coder | `coder-20261119-060535.txt` | 481 → 2709 |
| librarian | `librarian-20261119-060535.txt` | 307 → 3803 |

Each prompt was read back after the write and matched. No other workspace setting was changed. `my-workspace` and `booking` were not touched at all.

## Decisions taken on your behalf (all reversible)

| # | Default applied | How to change it |
|---|---|---|
| D1 | Store and worker live in Rust (`tasks.db`, separate file); the gateway is a mirror | Architecture choice |
| D2 | Staging root is `D:\Art Apps\agentic os\staging` (gitignored) | `memory.stagingDir` in os.json |
| D3 | Tony's notes go to `D:\Art Apps\agentic os\memory\tony` (gitignored); Play Place commit goes there too | `memory.notesDir` |
| D4 | The Designer returns a spec only; the Coder is the sole HTML producer | One prompt constant |
| D5 (override) | Deterministic gate first, then ONE advisory Prompter verify; code owns the loop; max 3 iterations | `worker.maxIterations` (1–3) |
| D6 | The code stage may offload to a CLI engine only (never `*-api`, kill switch, Local or localOnly) | `worker.offloadCode:false` or `scheduler.offloadPct < 50` |
| D7 | Verifier off in the worker | `worker.verify` |
| D8 | Per-task AnythingLLM `sessionId:"task-<id>"`; LM Studio direct fallback; no run_chat chain | — |
| D9 | LM Studio `parallel:2`/16k and the AnythingLLM 32768 token limit left as they are | See "Needs your attention" |
| D10 | No config or AnythingLLM changes for the duplicate/unused workspaces (report only) | Your call |
| D11 | Librarian MCP grants enforced by a code-level allowlist; no os.json migration | — |
| D12 | `claude_fix` is the "fixer" lane (not the Coder); only the node_modules denials were added | — |
| D13 | The app uses `query` mode for the Librarian; AnythingLLM `chatMode` left as is | AnythingLLM UI |
| D14 | Play Place phone actions run inline under a claim lease | — |
| D15 | Tier-4 "park it" stays ledger-only | — |
| D16 (override) | Narration uses each agent's existing roster voice (Kokoro defaults for gaps); `feedback.sensitivity` 1; never interrupts you or Tony | `feedback.sensitivity` 0–3, or say "narration off" / "narrate everything" |
| D17 | Cooperative `/api/os/gpu` lease between the desktop and the gateway | — |
| D18 | Tony's documenter ingests his own note after `review_ready`, best-effort | Per-task `noIngest` |
| D19 | Existing duplicate Tony threads left alone | AnythingLLM UI |
| D20 (override) | Stayed on `feat/thoughtform-pipeline`; nothing committed | You commit |
| Fix pass | `tasks.db` migration v1 edited in place (it never shipped; no tasks.db exists anywhere) | — |
| Final | Smoke harness (`taskworker/tests/live.rs`) gained env overrides and the Librarian write-snapshot assertion; test code only | — |

## Needs your attention (nothing below was changed for you)

1. **Code-stage offload is on by default after the rebuild.**
   - `worker.offloadCode` defaults to `true`, and your `scheduler.offloadPct` is 60 with `offloadEngine: claude-cli`, `compute.mode: hybrid` and the kill switch off.
   - So real builds will send the Coder stage to `claude-cli`, a CLI engine, never a paid API.
   - For local-only builds, set `worker.offloadCode:false` or `offloadPct` below 50.
2. **To activate anything:** restart the gateway (Python changes) and rebuild the desktop app (Rust/TS changes). The worker starts automatically (`worker.enabled` defaults to `true`).
3. **AnythingLLM workspace audit:**
   - Two workspaces are named "Booking": `my-workspace` is mapped to Tony's `general` role and is in chatMode `automatic`; `booking` is a duplicate with 12 threads.
   - `ops` (0 threads) and `designer` (0 threads before tonight's smoke) are unused, and `ops`/`designer`/`librarian` have no pinned provider (they inherit the LM Studio 9B).
   - `librarian` is in chatMode **automatic** and its name has a trailing space ("Librarian "). The app uses `query` mode and the new `librarian_preflight` guard flags it.
   - Suggest: rename `my-workspace`'s display name and set the Librarian to `query`/`chat` in the AnythingLLM UI.
4. **`coder` agentModel is `qwen2.5-coder-14b-instruct`.** This only matters in `@agent` mode, which the app strips, but it cannot co-reside with the resident 9B.
5. **Token budget mismatch:** AnythingLLM budgets 32768 tokens for LM Studio, but the loaded 9B has a 16384 context with `parallel:2`. Suggest reloading with `parallel:1` and aligning the token limit.
6. **AnythingLLM listens on 0.0.0.0:3001** (LAN-exposed). Its global agent skills and write-capable MCPs are reachable from any automatic/agent-mode workspace.
7. **Security precaution (from earlier):** a read-only audit once echoed the Gmail/Calendar Apps Script deploymentId/apiKey from anythingllm.db into a local agent transcript (not sent anywhere). Consider rotating them; AnythingLLM stores them in plaintext.
8. **Windows Smart App Control** sometimes blocks freshly built Rust test binaries (os error 4551). A rebuild usually yields an allowed binary. If `cargo test` refuses to start, that is why; no code is wrong.
9. **Smoke leftovers you may want to look at or delete:**
   - `D:\Art Apps\agentic os\staging\minimal-status-card\` (gitignored)
   - the AnythingLLM session `task-t-1795088621350-lhs5dc` in prompter-dispatcher/designer/coder

## Morning launch commands

```powershell
# 1. Gateway (stop the old one first: Ctrl+C in its window, it is PID 37292 "python server.py --port 8080")
cd "D:\Art Apps\agentic os"
python server.py --port 8080

# 2. Desktop app in dev mode (uses the new Rust + TS)
cd "D:\Art Apps\agentic os\command center"
npm run desktop:dev        # = tauri dev

# Optional: re-run the gates
npm run typecheck; npx vitest run; npm run test:scripts
cd src-tauri; cargo test --lib; cd "D:\Art Apps\agentic os"; python tests/run_all.py

# Optional: re-run a live smoke (LM Studio :1235 with only the 9B loaded). Use a BACKSLASH root.
cd "D:\Art Apps\agentic os\command center\src-tauri"
$env:TF_SMOKE_ROOT = "$env:TEMP\tf-smoke"
cargo test --lib -- --ignored --exact commands::taskworker::tests::live::live_smoke_lmstudio_direct --nocapture
```

To build the installer instead of dev mode: `npm run desktop:build` in `command center` (I did not run it).

## Not verified

- The installed app, `tauri dev` and `tauri build`. No UI run: voice narration, status-on-demand by voice, the System Map and Play Place UI are covered by vitest only.
- The phone path end to end (inbox claim → kind `task` → mirror → `GET /api/tasks`) against a live gateway; this is the 4.6 skip. The running gateway still has the old code.
- Brave search and `fetch.url` research during a real task (stubbed in the smoke). The redirect/SSRF guard is unit-tested only.
- Code-stage offload to `claude-cli`, the verifier, and Tony's AnythingLLM ingest after `review_ready` (all off in the smoke by design).
- The Tony → Librarian backend relay for "what did we decide about …" questions, live.
- The cooperative GPU lease mirror between a running desktop and gateway; the AnythingLLM UI, Cline and LM Studio's own parallel slots still bypass the GpuSlot.
- Peak VRAM stayed flat at 8023 MiB because everything ran on the resident 9B. No JIT load was attempted or observed.

## Known limitations / follow-ups

- **`memoryDoc` passes through the secret scrubber.** A notes path containing a 32+ character mixed-case/digit run (for example a forward-slash path) gets redacted. That gives a false "Tony's task note is missing", which the advisory verify then turns into wasted Coder loops.
  - Fix: store file paths unscrubbed (they are ours), or make the read-report check the notes root.
  - Also: memory-only discrepancies should not send the Coder back.
- The Librarian can surface `memory\tony\anythingllm-prompt-backups\*.txt` as context. Consider excluding that folder from the gatherer.
- The deterministic gate does not require a fully self-contained file. All staged builds load Tailwind from `cdn.tailwindcss.com` (and one loaded Google Fonts), so they need internet to render as designed.
- Heavy-model serialisation does not cover the AnythingLLM UI, Cline or LM Studio parallel slots.
- Play Place actions still run inline on the phone inbox.
- Not done: stripping secrets from MCP child processes' environments; per-agent AnythingLLM MCP scoping (AnythingLLM only supports global scope).
- If the stale-stage check refuses a commit after a cancel + retry, that stage may already have written `staging/<slug>/index.html`. It is overwritten by the rerun.

## Files touched

Working-tree diff against `49ca520`: 42 modified files, +3745 / −992.

**Python and tests:**
- Modified: `command_center_api.py`, `os_api.py`, `server.py` (one line), `tests/run_all.py`.
- New: `tests/test_os_inbox.py`, `tests/test_command_center_llm.py`, `tests/test_task_mirror.py`.

**Rust (`command center/src-tauri/src/`):**
- New in `commands/`: `envelope.rs`, `events.rs`, `staging.rs`, `documenter.rs`, `roles.rs`, `allm.rs`, `allm_audit.rs`, `librarian.rs`, `taskworker.rs`, `taskworker/tests.rs`, `taskworker/tests/live.rs`, `agent_prompts.rs`.
- Modified in `commands/`: `agents.rs`, `claude_fix.rs`, `dispatch.rs`, `introspect.rs`, `mcp.rs`, `memory.rs`, `mod.rs`, `modellab.rs`, `os_core.rs`, `pipeline.rs`, `scheduler.rs`, `secrets.rs`, `services.rs`, `voice.rs`.
- Modified: `lib.rs`.

**TypeScript (`command center/src/`):**
- New: `features/voice/narrator.ts`, `lib/mcp-call.ts`.
- Modified:
  - `features/dispatcher/{agents,dispatch}.ts`
  - `features/memmap/{TraceStream.tsx,trace-store.ts}`
  - `features/os/{os-intent-parse,os-intents,pipeline-store}.ts`
  - `features/voice/{engines,persona,tts-text,tts-types,voice-controller}.ts`
  - `lib/platform.ts`
  - `sections/PlayPlaceSection.tsx`
  - `sections/settings/{LibrarySettings,RoutingSettings}.tsx`
- Tests: new `dispatch.test.ts`, `agent-trace.test.ts`, `agent-status.test.ts`, `pipeline-store.test.ts`, `narration-flow.test.ts`, `narrator.test.ts`, `mcp-call.test.ts`; several existing voice/dialogue tests updated.

**Other:** `.gitignore` (adds `staging/`, `memory/tony/`) and this report.

## Scratch artifacts

- Smoke root: `C:\Users\nicho\AppData\Local\Temp\claude\5c24697b0373cc22\9d6851da-3c2b-4105-8776-21872b819875\scratchpad\smoke-final\`
  - Logs: `allm_audit.txt`, `4.3-lmstudio-direct.txt`, `statuscard-scratch.txt`, `4.4-allm-session.txt`, `4.5-resume.txt`, `real-statuscard.txt`.
  - Per-run folders (`tasks.db`, `staging\<slug>\index.html`, `notes\ideas\…`):
    - `smoke-lmstudio-20261119-063756` (tip calculator)
    - `smoke-lmstudio-20261119-064010` (status card, scratch)
    - `smoke-allm-20261119-064341` (AnythingLLM session)
    - `smoke-resume-20261119-064810`
    - `smoke-lmstudio-20261119-065320` (the real run's tasks.db and notes)
- Real artifact: `D:\Art Apps\agentic os\staging\minimal-status-card\index.html` + `.status.json`.
- Plan inputs: `tf-decisions.md`, `tf-plan.md`, `tf-maps.json` in the same scratchpad folder.

## Phase 2: Front-end steering, modes & hard mic mute

Branch: `feat/thoughtform-pipeline`, still uncommitted. There were no commits, stash, reset or branch switches. No Booking workspaces, `.env`, memory files or `%APPDATA%` JSON were edited by hand. No `tauri dev` or `tauri build` was run, and no service was restarted. Cost: $0.

The full design is in `docs/TONY_STEERING_SPEC.md`: mode schema and presets, curiosity blocks, dispatch policies, mic-mute layers and their tests, threshold and meter, registry prep, decisions P2-D1..D25, what is not verified, and how to try it.

### TL;DR

- **Part A, backend follow-ups.** These close three of the "Known limitations" above:
  - The scrubber no longer redacts forward-slash paths, and `memoryDoc` is stored verbatim (known secrets are still removed).
  - Memory/Librarian bookkeeping discrepancies are scoped `memory` and never send the Coder back.
  - The prompt-backups folder is excluded from the Librarian gather.
  - A non-blocking `checks.externalDeps` list is added.
- **Part B, hard mic mute.** Mute is a dead line at every layer: Rust flag, Rust STT client (the only client of Whisper :8178), audio engine, hotkey, IPC, webview gate, capture, controller, unsolicited TTS and the phone. It persists in `os.json voice.micEnabled`.
  - Proof: `muted_mic_sends_zero_stt_requests` (Rust, fake Whisper server gets 0 requests) and `mic-capture-gate.test.ts` "zero capture, zero STT" (TS).
  - The sensitivity slider is replaced by an absolute dBFS activation threshold (default -44) with a live meter on the same scale.
- **Part C, Tony modes.** `modes.json` holds six presets (default `brainstorm`) plus custom modes.
  - A deterministic MODE block (curiosity/verbosity/dispatch/notes, at most 700 chars) goes into Tony's own turns only, before `/no_think`.
  - A dispatch gate enforces `surface_only` / `ask_before_dispatch` / `auto_dispatch` in Rust (`task_create`, `capture_task`, `task_from_idea`, inbox `task`).
  - `tts_interrupt_level` maps onto narration: silent 0, milestones 1, full 2.
  - Registry prep is data-driven; no new agents were built.
- **Part D, UI.** Adds the top-bar ModePill, the `tony-mode` widget, a Settings "Tony Modes" tab (Modes Manager), the phone HUD mode strip and mic lock, the HUD MIC OFF indicators, and Gabagool as a novelty overlay. Play Place build buttons are disabled under Solo.
- **Review.** 22 findings were raised and 17 reached the fix pass (three were duplicate pairs), giving 14 distinct fixes, each with a regression test. Notable fixes:
  - The gateway now accepts `micEnabled` and the mode keys (`os_api.py`).
  - The v7-migrated threshold is no longer overwritten at startup.
  - Muting during a hold no longer leaves Kokoro paused.
  - Mode switches now reach the narrator.
  - The phone no longer says "Queued" before the desktop has accepted the build.
  - Solo now holds medium-confidence Named routes with Tony.
  - Editing the active mode keeps a manual narration override.
  - The Gabagool switch starts Gabagool.
  - The hotkey can stop Tony while the mic is locked.
- **Approve() invariant.** `auto_dispatch` (Builder only) skips only the Tier-3 spoken offer for a pipeline build out of a live brainstorm, whose writes go to `staging/` only. Every mutating plan (email, messages, calendar, Play Place build, ledger Run) still goes through `approve()` in every mode. WhatsApp stays read-only and the kill switch is unchanged.

### Gates (final run, 2026-11-19 about 08:43)

| Gate | Result |
|---|---|
| `npm run typecheck` | clean |
| `npx vitest run` | **83 files, 1471 passed** (Phase 1 ended at 64 files / 1310) |
| `npm run test:scripts` | 6 passed, 0 failed |
| `python tests/run_all.py` | **140 tests OK** (adds the inbox mic/mode key test) |
| `cargo check --lib` / `cargo check --lib --tests` | clean, 0 warnings |
| `cargo test --lib` | Blocked by Smart App Control (os error 4551) in this agent's run. **Re-run afterwards on the final Phase 2 tree after a relink (`touch src/lib.rs`): 687 passed, 0 failed, 28 ignored**, including `voice_defaults_clamp_and_mirror` and `muted_mic_sends_zero_stt_requests`. After Phase 3: 721 passed, 0 failed, 29 ignored. |

**Rust test coverage, in detail:**
- Last complete green runs: Part A 663 passed and Part B 669 passed (0 failed, 28 ignored each). Parts C and D also reported full green runs. In Part D one timing-sensitive test failed once and passed on rerun.
- During the fix pass the filtered runs `cargo test --lib modes` (14 pass) and `route_for_turn` (3 pass) executed. After those, the only Rust change was a comment in `lib.rs`.
- One changed test, `os_core.rs::voice_defaults_clamp_and_mirror`, compiles but has **never executed**.
- No security settings were changed. Re-run `cargo test --lib` in the morning; a rebuild usually yields an allowed binary.

### Files (Phase 2)

All paths below are under `command center/` except the Python, tests and docs entries.

**Rust (`src-tauri/src/`)**
- New: `commands/modes.rs`, `commands/modes/tests.rs`.
- Modified (Part A): `commands/devqueue.rs`, `envelope.rs`, `librarian.rs`, `agent_prompts.rs`, `taskworker.rs` and its tests.
- Modified (Part B): `commands/voice.rs`, `audio/commands.rs`, `commands/os_core.rs`, `commands/pipeline.rs`, `lib.rs`.
- Modified (Part C): `commands/agents.rs`, `commands/mod.rs`.

**TypeScript (`src/`)**
- New in `features/voice/`: `mic-gate.ts`, `vad-gate.ts`, `meter-scale.ts`, `threshold.ts`, `ThresholdMeter.tsx`, `mic-indicator.ts`, `MicLockBadge.tsx`.
- New in `features/modes/`: `modes.ts`, `modes-store.ts`, `mode-ui.ts`, `ModeIcon.tsx`, `ModePill.tsx`, `ModeStrip.tsx`.
- New elsewhere: `widgets/tony-mode/{index.ts,ModePanel.tsx}`, `features/hud/hud-status.ts`, `components/segmented.tsx`, `sections/settings/{ModesManager.tsx,settings-tab.ts}`.
- Modified:
  - `features/voice/`: `engines.ts`, `voice-controller.ts`, `ListenControls.tsx`, `VoiceHUD.tsx`, `VoiceParts.tsx`, `Waveform.tsx`.
  - Other features: `cues/cue-runtime.ts`, `brainstorm/capture.ts`, `memmap/dictation.ts`, `reminders/scheduler.ts`, `dispatcher/{agents,roles,dispatch}.ts`, `orchestrator/plan.ts`, `hud/MobileHud.tsx`.
  - Sections, shell and libs: `lib/platform.ts`, `stores/settings.ts` (v7), `shell/TopBar.tsx`, `sections/settings/{VadSettings,VoiceSettings,RoutingSettings}.tsx`, `sections/{SettingsSection,PlayPlaceSection}.tsx`, `widgets/voice-console/VoiceConsole.tsx`.
- Tests: new `mic-gate`, `mic-capture-gate`, `mic-lock`, `vad-gate`, `meter-scale`, `threshold`, `mic-indicator`, `platform.mic-gate`, `capture.mic-lock`, `modes`, `modes-store`, `mode-ui`, `mode-pill`, `mode-panel`, `modes-manager`, `settings-tab`, `hud-status`, `registry`, `gabagool-toggle`, plus updates to `offer-flow`.

**Python:** `os_api.py` (`_validate_command_payload`), `tests/test_os_inbox.py`.

**Docs:** `docs/TONY_STEERING_SPEC.md` (new).

**Totals:** the whole working-tree diff against `49ca520` (backend plus Phase 2, tracked files only) is 73 files, +5706 / -1371.

### Behaviour changes to know about

- **Closing the HUD or pressing Esc now turns hands-free off** (the preference is set to false). Before this, hands-free either re-armed or went silently dead. "Cut it" still re-arms.
- **Mode switches rewrite the narration level** (silent / milestones / full). A manual Narration change holds only until the next switch.
- **The activation threshold is now absolute dBFS.** Your old sensitivity was migrated, but detection may shift in your room; tune it with the meter.
- **While the mic is locked, reminders show only a toast and a Windows notification**, with no speech. The startup and time-of-day cues and narration are silent too.
- **The phone gateway must be restarted.** The running gateway (old `os_api.py`) rejects `micEnabled` and the mode keys from the phone until it is.

### Not verified (Phase 2)

- `cargo test --lib` after the fix pass (blocked by Smart App Control, see Gates), and `voice_defaults_clamp_and_mirror` in particular.
- Any UI in a running app. There was no `tauri dev` or `tauri build`, so every surface is covered by vitest only.
- A real mic, a real Whisper round trip, the global hotkey, and Silero in the webview.
- Whether the local 9B actually obeys the MODE blocks.
- Builder auto-dispatch end to end.
- The phone path against a live, restarted gateway.
- Under Solo, the TS "Routing ... to Coder" notice can still appear for "hey Coder, ..." while Rust keeps the turn with Tony.
- A Whisper request already in flight at the moment of mute can't be recalled; its transcript is dropped.
- The phone's Web Speech audio goes to a cloud recognizer that Rust cannot gate. The phone's own lock is client-side.

### Morning: try Phase 2

Restart the gateway, run `cargo test --lib` in `command center/src-tauri`, then run `npm run desktop:dev` in `command center`. Then:
1. Flip the hard Mic switch off. Expect MIC OFF, a flat waveform, no listening and no narration.
2. In Settings > Voice, use the Activation threshold card and watch the meter.
3. Switch modes in the top-bar ModePill. Try Solo (the park card, no build) and Builder (a build is queued with no offer card).
4. Add the Tony Mode widget.
5. Open Settings > Tony Modes and duplicate a preset to edit it.

The step-by-step list is in `docs/TONY_STEERING_SPEC.md` section 10.

## Phase 3: Memory Scrolls

The full report is in `docs/MEMORY_TIERING_REPORT.md` (in public `docs/`, so review it before committing).

- **Built.** A tiered memory:
  - The raw Tier-1 history stays where it is and is never pruned.
  - A lossless, scrubbed, checksummed cold archive on `D:\ai-hub-archive`.
  - A few living Memory Scrolls in `D:\ai-hub-memory\scrolls` (moved off `C:\ai-hub`, which stays read-only), the only layer synced to the `librarian` workspace.
  - A JSONL knowledge graph at `D:\ai-hub-memory\knowledge-graph.json`, shared with the app's `kg.search` MCP.
  - The pieces: the Python package `memory_scrolls/` (with `compact-memory` and `scripts/offload_rag_to_scrolls.py`), a read-only Librarian scroll path with forensic archive lookup, a Rust host trigger, and a Settings "Compact & Sync Memory" card. Auto-compact and Embed-only are both OFF.
- **Gates (green).** typecheck clean; vitest 84 files / 1482; test:scripts 6; `cargo test --lib` 721 passed / 29 ignored; `cargo check --lib` clean; `python tests/run_all.py` 223 OK.
- **Smoke, live dry-run** (GET-only, Booking never read).
  - 362 raw records (142,677 B: 350 local records plus 12 prompter chats) become 4 proposed scrolls of 12,607 B, about 91 % less text.
  - The allowlisted AnythingLLM workspaces hold 0 embedded documents, so `--apply` frees ~0 B on C:.
  - First preview: token `f62f056d7db3`, `staging/memory-scrolls-preview/20261119-103034/`. It is superseded; do not apply it.
- **Re-preview after distill fixes** (12:01, same GET-only safety; the no-write baseline was identical before and after).
  - Preview: token `02867a396056`, `staging/memory-scrolls-preview/20261119-120122/`. It is superseded by the 12:55 preview; do not apply it. `python tests/run_all.py`: 247 OK.
  - **Size and calls.** 13 of 13 planned LLM calls ran (budget 17). The 4 scrolls total 8,795 B and all are under 3 KB.
  - **Identity:** model-written, 4,725 -> 2,753 B.
  - **Lessons:** now model-written, 982 B.
  - **Architecture and project:** still extractive raw noise. The architecture reply was rejected because a superseded fact was still stated; the project reply was missing a required key.
  - **Personal details** moved from the identity scroll body into the identity entities in `kg-preview.jsonl`.
  - Details are in report section 7, "Re-preview after distill fixes".
- **Smoke, synthetic.** A 40-turn noisy batch went to a scratch cold archive (checksums verified, fake secret scrubbed), then into 4 distilled scrolls via the **live** loaded `qwen/qwen3.5-9b`:
  - Whisper 8178 was kept, and the 1234 -> 1235 move went under Superseded with `arch-2026-11-19-01`.
  - It then synced to a stub `librarian`.
  - The Librarian retrieval test returned the scroll plus archive excerpts for that id.
  - Nothing real was written: `C:\ai-hub\memory`, the KG, `.env`, the archive roots and the AnythingLLM doc lists are identical before and after.
- **Round 2 (replay only).** Added a repair retry for fixable rejections, an extractive noise filter (no chat turns, thinking traces, JSON, email summaries or status lines; never under Locked; "Pending distillation" below 3 kept lines), and prompt rules 10 and 11 (no status changes under Superseded; prefer the newest source and never restate stale claims).
- **Re-preview after round 2** (12:55, same GET-only safety; the no-write baseline and both older previews were identical before and after; secret scan 0 hits; the read-only `_promote_plan` check passes for all 4).
  - **Current preview:** token `5e27f1341e06`, `staging/memory-scrolls-preview/20261119-125553/`. `python tests/run_all.py`: 272 OK.
  - **Size and calls.** 14 LLM calls ran (13 planned plus 1 repair, budget 17). The 4 scrolls total 7,261 B and all are under 3 KB.
  - **Architecture:** now model-written, 2,261 B, with no chat or email noise.
  - **Identity:** model-written, 2,505 B, with no Status line or status-change entries.
  - **Lessons:** model-written, 1,147 B.
  - **Project:** still extractive (filtered, 1,348 B). The last reply swapped keys and the repaired reply dropped a locked bullet.
  - **Verdict: not ready to apply as it stands.**
    - About 5 one-off voice-chat tool uses sit under the architecture Locked section, where they would become sticky.
    - Identity still states the stale Linux/WSL environment (source: `brain/constraints.md`, not edited) and carries a contact email.
    - The KG preview has 27 entities, many of them personal-profile categories.
  - Details and suggested fixes are in report section 7, "Re-preview after repair retry and noise filter".
- **Round 3: never-lock rule and Tier-2 privacy filter.** Details are in report section 8.
  - **Never-lock.** Locked Decisions, Locked Design Decisions and Standing Rules hold only durable decisions. Prompt rule 12 says so, and a host gate in `_prepare_reply` moves (never deletes) a NEW locked bullet that reads as a one-off action or idea to an unlocked section. Bullets already locked in the current scroll are never touched; if a reply moves one, it is put back.
  - **Privacy filter.** It covers scroll bodies, the Superseded log, superseded facts, KG entities and everything synced to AnythingLLM. The cold archive stays lossless (secrets scrubbed only).
    - Defaults are in the repo-tracked `memory_scrolls/privacy_policy.py` (policy version 2). Excluded: contact identifiers, precise location, finance, date of birth / age, health, family, private third parties, life plans and possessions, personality traits, hobby gear, personal consumer services. Allowed: work projects, work tools, system hardware, communication preferences, standing rules, services the system uses.
    - Optional override: `data/memory-scrolls/privacy-policy.json` (gitignored, read only) with `allow` / `deny` / `deny_terms`. `python -m memory_scrolls status --show-privacy-policy` prints the effective policy.
    - Every removal is counted by category only, in warnings, NDJSON, `report.json` and `manifest.json`. A personal locked bullet leaves only as an explicit, logged privacy removal.
  - **`--apply`** now refuses previews made before the filter or under another policy, so the 10:30, 12:01 and 12:55 previews can no longer be applied.
  - `python tests/run_all.py`: 303 OK.
- **Re-preview with both guards** (14:14, same GET-only safety; the no-write baseline and the three older previews were identical before and after; secret scan 0 hits; the read-only `_promote_plan` check passes for all 4 and refuses the three older previews).
  - **Current preview:** token `0b7edfe7170d`, `staging/memory-scrolls-preview/20261119-141404/`.
  - **Size and calls.** 14 LLM calls (13 planned plus 1 rejected repair, budget 17). The 4 scrolls total 6,357 B: architecture model 2,257 B, identity model 2,073 B, lessons model 808 B, project extractive 1,219 B.
  - **Locked:** 15 bullets, all durable, 0 one-off. Never-lock moved 1 new bullet in architecture.
  - **Privacy:** no excluded category is left in any scroll or in `kg-preview.jsonl` (8 entities, down from 27). Removed in this run: creative gear x2 and finance x1, plus consumer services and location lines in a rejected project reply.
  - **Verdict: ready to apply on safety, privacy and never-lock.** Content issues remain in unlocked sections:
    - Identity still states the stale Linux/WSL environment (source `brain/constraints.md`).
    - Project is still extractive.
    - A few status-like lines are left.
  - Details are in report section 7, "Re-preview with the never-lock rule and privacy filter".
  - Superseded since: privacy policy v3 makes `--apply` refuse token `0b7edfe7170d`.
- **Round 4: C:\ai-hub as a read-only source of truth.** The offload now seeds the scrolls from the hub's rule, system, status, roadmap and handoff files, plus 6 allow-listed sections of the operator profile. Full write-up: `docs/AI_HUB_BASELINE_REPORT.md` (public `docs/`, so review it before committing).
  - **Read-only proof.** The hub was byte-identical, with identical mtimes, before and after both live runs (9,657 files, 1,258 dirs, 0 differences). Booking templates, `tasks/` (a personal .eml), the messaging bridge and `.git/` were never opened.
  - **Fix found by the live run.** The hub's "update the status file at session end" rule, when written with "updating", got past the input filter. `_HUB_STATUS_WRITE` is fixed and tested, and the roadmap hint now says roadmap items are planned work. `python tests/run_all.py`: 328 OK.
  - **Current preview:** token `04a502a35827`, `staging/memory-scrolls-preview/20261119-151225/`.
    - 11 LLM calls, 0 repairs.
    - 5 model-written scrolls (architecture, identity, lessons, agentic-os and the new ai-hub project scroll), 8,088 B in total. 22 KG entities.
    - Same no-write baseline, GET-only AnythingLLM, 0 secret-scan hits. The read-only `_promote_plan` check passes.
    - The 15:06 preview (`211e1ce1d9ed`) is superseded; do not apply it.
  - **Filtered from the hub before the model:**
    - 28 of 34 operator-profile sections (default-deny)
    - 40 sections in all
    - 6 booking lines
    - 6 status-write rules
    - 4 lines by the privacy filter: finance 2, life plans 1, location 1
  - **Locked from the hub:** 12 bullets, all standing rules or core preferences, 0 one-off. The ai-hub project scroll locks nothing.
  - **Verdict: not ready to apply.**
    - The default apply target is inside the read-only hub (`C:\ai-hub\memory`).
    - The chat-fed `projects/agentic-os.md` locks a wrong "mutation default" for message forwarding and carries a Booking hand-off task.
    - Nic should decide four hub vs Agentic OS conflicts first: roster names, Librarian authority, the escalation ladder and Gemini vs agy.
- **Round 5: D:\ai-hub-memory as the live memory root (Nic's decision).**
  - **Defaults moved.**
    - The scrolls now default to `D:\ai-hub-memory\scrolls` and the KG to `D:\ai-hub-memory\knowledge-graph.json`.
    - This covers `memory_scrolls/config.py`, `os_core.rs` (`DEFAULT_SCROLLS_DIR`, `DEFAULT_KG_PATH`), `mcp.rs` `KG_PATH` (the app's `kg.search` now reads the same graph), the librarian doc comment, `platform.ts` and the Settings placeholder.
    - Nothing creates `D:\ai-hub-memory` except `--apply`.
  - **Hard guard.**
    - Config resolution and every writer refuse any target under `C:\ai-hub`. That covers the scroll store and history, the graph and its lock, the archive and its manifest, state, previews and the compaction lock.
    - The check is case-insensitive and junction-safe (file identity), and it also normalises `..`, `\\?\` and admin shares. It applies whether the target comes from a flag, env, `.env` or os.json.
    - An os.json dir under the hub falls back to the default, as the app's `sanitized()` does. That has a Rust test.
    - The test suite guards both `C:\ai-hub\memory` and `D:\ai-hub-memory` against writes.
  - **Booking gap fixed.** The Tony gateway chat source now drops Booking messages and lines, like threads and training logs. Two tests cover it.
  - **Gates:**
    - typecheck clean
    - vitest 84 files / 1,484
    - test:scripts 6
    - `cargo test --lib` 725 passed / 29 ignored
    - `cargo check --lib` clean
    - `python tests/run_all.py` 343 OK
  - **New preview:** token `fe63a4abe283`, `staging/memory-scrolls-preview/20261119-184425/`.
    - LM Studio had no model loaded, so the model was not called (`--no-llm`). All 5 scrolls are extractive, 5,033 B in total, with 0 KG entities and nothing locked.
    - The hub was byte-identical (9,657 files, 0 differences). The no-write baseline was identical, and `D:\ai-hub-memory` is still absent.
    - AnythingLLM saw GET only. The secret scan found 0 hits. No Booking line and no excluded personal category reached a scroll.
    - The read-only `_promote_plan` check passes and shows the write targets `D:\ai-hub-memory\scrolls` and `D:\ai-hub-memory\knowledge-graph.json`.
    - All 6 older previews, including `04a502a35827`, are now refused: their manifests do not record the D: targets or the Booking filter.
  - **Verdict.** It is safe to apply, but not recommended as it stands: it is an extractive, low-quality preview. Re-run with the model loaded first.
- **Round 6: guard false positives** (tests and a FakeLLM replay only; no live run, nothing applied).
  - A review of the content guards found 8 false-positive paths. All 8 were reproduced and fixed, each with a regression test. Details are in `docs/MEMORY_TIERING_REPORT.md` section 8, "Review of the guards: false positives".
    - Automatic hub deny terms that are ordinary English words now match only as a capitalised name. Chat and tech abbreviations are never terms.
    - The `platform-linux` and `mutating-default` stale-claim rules now respect negation, so "no WSL" and "non-mutating" lines are kept.
    - The user-relabel check no longer fires on role words used as nouns. The KG merge no longer joins distinct systems.
    - A demoted `(unconfirmed)` bullet can no longer be re-locked by a reply.
    - Rule words beat status words. Plain hub imperatives stay locked in the identity and architecture scrolls.
    - "Rust macros" and "Fasting mode" are no longer health.
  - Versions: privacy policy 5, stale claims 2, guards 2. Every older preview, `20261119-190907` included, is refused.
  - Gates: `python tests/run_all.py` 376 OK. No Rust or TS changes.
- **Your move.**
  1. Repoint the AnythingLLM `knowledge-graph` MCP (`MEMORY_FILE_PATH`, outside the repo) to `D:\ai-hub-memory\knowledge-graph.json`.
  2. Fix the stale brain/ lines (models, OS, active project, Gemini CLI).
  3. Decide the conflicts in sections 8 and 10 of the baseline report.
  4. Load the chat model, re-preview, review `projects/agentic-os.md`, then apply with the new token.
  - Section 7 of `docs/MEMORY_TIERING_REPORT.md` lists what `--apply` archives, writes, embeds and un-embeds.
