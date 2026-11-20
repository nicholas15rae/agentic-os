# Architecture Decisions: Thought-to-Product Pipeline

Scope: the Thought-to-Product build spec (Phases 1–5) in the Command Center app.
Related docs: `HANDOFF.md` §9 covers the voice reflexes, `docs/TONY_STEERING_SPEC.md` covers modes and the mic mute, and `OVERNIGHT_BUILD_REPORT.md` covers the TaskEnvelope worker.

## AD-1: The hub orchestrates the existing engines; it doesn't add a new one

The Play Place staging hub (`src-tauri/src/commands/buildhub.rs`) holds the spec's `TaskEnvelope` for every staged build. It hands each build to an engine that already exists:

| `assigned_worker` | Lane | Engine |
|---|---|---|
| `coder`, `designer` | worker | The sequential TaskEnvelope worker (`taskworker.rs`, `tasks.db`): Prompter → Librarian → Designer → Coder → staging. `designer` marks a design-led build; both go through the same pipeline. |
| `claude` | claude | The Dev Fix · Claude Queue (`devqueue.rs`, `.agenticos/claude-fix-queue.json`). Running Claude Code still asks first: `dev_fix_dispatch` needs `approved: true`. |

- **One build per lane at a time.** Each lane takes the head of the hub queue first, so the hub's order (FIFO plus manual bumps) is the build order.
- **The worker's own order doesn't decide anything.** The worker is FIFO by `created_at`, but it never holds more than one hub build at a time.

## AD-2: The TaskEnvelope contract

The envelope is strict JSON with snake_case keys, as the spec writes them. In Rust it is `#[serde(deny_unknown_fields)]`.

```json
{ "build_id": "b-<base36 ms>-<rand>", "project_slug": "a-z0-9-, ≤48", "title": "≤120",
  "target_runtime": "internal_widget" | "external_os",
  "output_directory": "<staging root>\\<slug>  |  <external base>\\<slug>",
  "spec_summary": "≤2000", "milestones": ["1–12"], "acceptance_criteria": ["1–12"],
  "assigned_worker": "claude" | "coder" | "designer", "preview_url": null | "http://127.0.0.1:<port>/",
  "status": "queued" | "building" | "paused" | "repair_queue" | "smoke_testing" | "ready_for_merge" | "deployed",
  "human_override": [{ "directive", "priority": "high", "at", "applied_at", "applied_stage", "auto" }] }
```

**How an envelope is compiled.** The webview compiles it (`src/features/buildhub/compile.ts`) from:
- the selected brainstorm notes, ordered oldest first, so selection order never matters;
- the intake interview's answers.

The compile is deterministic.

**What Rust re-checks.** Rust validates every field (`validate_new`):
- `output_directory` must be the one directory this runtime allows for this slug;
- strings are secret-scrubbed;
- overrides can't be smuggled in at enqueue;
- `status` must be `queued`.

**How dispatch is gated.** Dispatch only happens behind the confirmation card:
- `approve()` runs the plan, which is the only caller that sends `build_enqueue approved: true`. Rust refuses anything else with `PERMISSION_REQUIRED:build-dispatch`.
- Solo mode (`surface_only`) queues nothing, and the worker's own mode gate (`create_task_gated`) applies as well.

**`human_override`** is the Phase 4 extension (Steer). The worker puts these directives into every following stage prompt; see AD-6.

## AD-3: Dual runtime routing (on the `C:\ai-hub` baseline, no D: migration)

### Path A: `internal_widget`

- **Output location:** the worker writes `index.html` into the existing staging root, `memory.stagingDir` in os.json (default: `staging/` in the repo, gitignored).
- **Sandbox View:** the Play Place card renders the build in a Sandbox View.
  - The view is loaded with `React.lazy` (dynamic component loading).
  - It sits inside a React Error Boundary.
  - The widget's code runs in an opaque-origin iframe with `sandbox="allow-scripts allow-forms"`, so a crash stays inside its box.
- **Promote to Live Dashboard:** enabled only once the smoke test has passed (`ready_for_merge`).
  - Promotion freezes a copy at `%APPDATA%\os.agentic.commandcenter\promoted\<build_id>\index.html`.
  - It then adds a `staged-build` dashboard widget that renders that copy, so later rebuilds never change the live widget.

### Path B: `external_os`

- **Never in AgentOS's bundle or registry:**
  - artifacts live under the external base, default `C:\ai-hub\external-builds\<slug>\` (configurable through `build_set_external_base`);
  - that path must be absolute, must not be a drive root, and must be outside the repo.
- **At enqueue:** the hub scaffolds `README.md` and `task-envelope.json`.
- **After the worker finishes:** the staged files are copied to `<slug>\app\`.
- **Local Bridge on the card:**
  - an embedded Read-In view;
  - "Open Dedicated Preview Window", a separate webview window with no IPC capabilities;
  - "Pop Out in Browser";
  - the live log.

**What stays where it was.** No path, vault or memory store moved:
- shared memory stays in `C:\ai-hub` (for example `C:\ai-hub\memory\agentic-os.sqlite`);
- `tasks.db`, `devqueue.db` and `build-hub.json` stay in the app config dir;
- the repo stays at `D:\Art Apps\agentic os`.

The only new external path is the build output under `C:\ai-hub\external-builds`.

## AD-4: Live Read-In / Peek View isolation

**The preview server.** Each build gets a tiny static-file server that is part of the app's own process (`buildhub/preview.rs`):
- it binds `127.0.0.1:0` (loopback, random port);
- it allows GET/HEAD only;
- it rejects any request path with a backslash, a drive colon, `.`/`..` or a rooted / UNC form *before* touching the filesystem (no outbound SMB or WebDAV hop);
- it does no directory listing;
- it uses canonicalised paths with escape checks;
- it sends `Cache-Control: no-store`.

It only *reads* the output folder the agents write. A build with its own dev server can set `preview_url` instead; that must be a loopback http URL with a port.

**Opening, refreshing or closing a preview can't affect the build:**
- the build never knows a preview exists;
- the server dies with the app (Exit stops every preview server).

**Reachability is checked in Rust, not the webview:**
- the Rust hub loop probes every preview a Peek View is watching (2 s timeout) and sends `build-hub` events;
- the webview never polls.

**What the Peek View shows:**
- While the preview is down, or the build is recompiling, a non-blocking "Building / Reconnecting Preview…" overlay sits over the last loaded page (the last snapshot).
- The frame re-attaches by itself when the preview answers again or `preview_version` changes (new output, a passing smoke test).

**CSP:** `frame-src` allows `http://127.0.0.1:*` and `http://localhost:*` for these frames. A `srcdoc` frame would inherit the app's CSP and lose its inline scripts, which is why the views use URLs.

## AD-5: Queue integrity (FIFO, no races, no silent drops)

**The hub's state:**
- it is one JSON file behind one `Mutex`;
- every mutation is validated, and a failed save rolls the in-memory state back;
- it is written with a unique tmp name and an atomic rename;
- the rename is retried with backoff (about 1.5 s) on Windows sharing violations (os errors 5, 32 and 33).

**Every refusal returns an error the UI shows:** duplicate ids, duplicate in-flight slugs, wrong state transitions, and mode refusals (the build waits, with the reason logged on its card).

**Dev Fix Queue hardening:**
- ties between items with the same `created_at` break by `rowid`, which gives deterministic FIFO;
- the queue file is written through a unique tmp file with the same retried rename, so an editor or Claude Code holding it open no longer makes a write fail;
- the priority badge has a one-click bump.

**All hub commands are async** and do their file I/O, state saves and smoke runs on the blocking pool; none runs on Tauri's main thread.

**Recovery:** a build left in `smoke_testing` (an exit or crash mid-check, or a resume at that checkpoint) gets its check re-run by the hub loop, so a lane never stays blocked. A smoke result that arrives after the build moved on is kept for the card and changes nothing else. A crashed check sends the build to the Repair Queue.

**External folders:** an existing `<base>\<slug>` is refused before anything is written; the build is enqueued (duplicate check) before scaffolding, and a failed scaffold takes it back out.

**Smoke tests** (`buildhub/smoke.rs`) run on the blocking pool. They check:
- the entry file and its size;
- the HTML structure, with balanced `<script>` and `<style>` tags;
- portability: no local paths or gateway calls;
- credential-shaped strings;
- sandbox escape attempts (internal widgets only);
- inline scripts with `node --check` when Node is on PATH; otherwise this check is skipped, never failed.

Remote assets are advisory only.

**When a smoke test fails:**
- **First failure:** one automatic repair pass. The failure becomes a high-priority override, and the build stays at the head of its lane.
- **Second failure:** the build goes to the **Repair Queue** with the exact failed assertions and the trace.
- **A failed worker run** goes straight to the Repair Queue with its error.
- **From the Repair Queue:** "Re-run check" (after editing by hand) or "Re-queue" with a fix note (back at the tail of the queue, with a fresh smoke budget).

## AD-6: Human in the loop

**Pause.** The hub keeps a process-local pause set that it re-seeds from `build-hub.json` at startup. `envelope::claim_next` skips paused tasks, so:
- the stage in flight finishes and commits (that commit is the checkpoint);
- nothing new starts;
- state and logs are kept.

A paused build frees its lane. On Resume, the worker picks the build up again from its committed stage; a build paused at the smoke checkpoint resumes there and only its check re-runs. A Claude-lane build is paused by moving a *waiting* queue item to `Pending` (after the hub accepted the pause); a finished (Done) item is left alone, so Resume never re-runs Claude. Pausing a Claude run that is already live is refused, because it can only be stopped from the Dev Fix Queue.

**Remove / Repair** cancel the build's live worker task (its finished stages and log stay in tasks.db), so nothing keeps running for a build the hub no longer owns; while a build is in the Repair Queue its task stays held.

**Steer:**
- appends a `human_override` to the envelope;
- `envelope::set_overrides` puts all of a task's directives into every following stage prompt (`taskworker::header`, under "HUMAN OVERRIDE from Nic");
- the card marks a directive "injected at <stage>" once a stage starts after it;
- nothing is restarted.

## AD-7: Vocal handoff routing

**When the exchange plays.** When Tony delegates to one of his crew (Coder, Designer, Prompter, Librarian, Booking Desk, Ops), `startHandoffCue(role)` in `voice-controller.ts` plays three short beats over the existing TTS pipeline:
- Tony, in the `general` voice;
- the agent, in its roster voice;
- Tony again.

It is triggered in two places: `osRun`'s routing notice, and an approved Play Place dispatch.

**The pool:**
- it lives at `%APPDATA%\os.agentic.commandcenter\handoff-cues.json` and is seeded from the bundled `src/features/voice/handoff-cues.json` the first time it is read;
- it holds nicknames plus open, reply and close lines;
- lines are templated, so a beat never recaps the task.

**The time cap:**
- an exchange is picked only if its speech estimate (2.8 words/s plus 0.2 s per beat) fits `maxSeconds`, which is clamped to 5 s;
- at runtime, a beat that can't start before the deadline is skipped.

**Toggle:** "Agent Chatter" in the Agents header, stored in settings as `routing.vocalHandoffs` (default on).
- **On:** the exchange plays and the routing chip ("TONY → CODER", with a speaker icon) shows.
- **Off:** the same delegation happens silently and only the chip shows. With the toggle on, the exchange also replaces Tony's one-line ack / "Here's X" intro, so there is no double intro.

**Concurrency:** `withHandoff` (Play Place) and `osRun` dispatch first and start the cue next to the dispatch. Neither ever awaits it. The only thing that waits is playback order: every spoken line of the turn (streamed chunks, the full answer, a typed auto-speak reply) queues behind the cue, so the beats and the reply never cut each other off.

**Barge-in:** a new command said over the cue cuts the beat in flight and drops the rest, but the delegated agent's job keeps running server-side (its stream is excluded from `cancelStreams`). "Cut it" and a stand-down still stop everything, as specified.

**Intake model call:** takes the GPU baton (background priority) like every other local generation; if it isn't free within 4 s the interview uses the standard questions.

## AD-8: Audio / media thread isolation guarantee

- **Spotify:** none of the new code calls Spotify, the media duck or hold, the cue player or the mic. The heartbeat, hub loop, preview servers, smoke tests and the build-hub file all run in Rust on the async runtime or blocking pool; the webview only renders events.
- **Refresh (soft):**
  - re-syncs the cached collections and the OS config;
  - re-mounts only `<main>`, using `key={epoch}`.

  The voice HUD, the TTS engine, the cue player, the Spotify duck / hold and the mic all live outside `<main>`, as module singletons and the always-mounted `VoiceHUD`, so a soft refresh can't interrupt playback.
- **Hard Reload (Shift-click or right-click):** a full `location.reload()`, which would cut in-webview audio. It only runs once voice is idle and no cue is playing. If audio stays busy for 15 s, it falls back to a soft refresh. Spotify plays in its own app and is never paused, skipped or reset either way.
- **Vocal cues:** they go through the same `say()` as any Tony line, so they:
  - duck cue audio the same way;
  - respect the Spotify duck;
  - stop on barge-in, stand-down and hard stop (`micGen`);
  - never start while the hard mic shutoff is on, and drop their remaining beats the moment it turns on.
- **Gateway heartbeat:** `GET /api/ping` every 10 s (5 s while failing), 3 s timeout, in Rust. The phone runs the same probe in a Web Worker.

## AD-9: Exit

The Exit button sits at the bottom of the left rail.

**Before quitting, it calls `app_exit_check`.** That lists what is mid-commit:
- a worker stage holding a live lease (and not paused);
- a Claude Code fix run;
- a hub file operation or smoke test.

**A confirmation appears only when that list isn't empty.**

**Quitting.** `app_exit` stops the preview servers and calls `AppHandle::exit`, which runs the usual RunEvent::Exit cleanup: the Spotify duck restore and the Drive sync. MCP servers and Claude fix runs live in kill-on-close Job Objects, so nothing is orphaned.

**The gateway is left running on purpose:** it is the phone's sync hub.

## AD-10: The Agent Conversation feed (a reviewable Tony ↔ agent record)

Every build and delegation gets a chat thread you can review: what Tony and the agents actually said to each other. That covers the brief, each agent's prompt and full reply, hand-offs, the intake interview, steers, smoke verdicts, repairs and Claude Code's run.

- **Where it lives.** A separate Rust-owned SQLite file, `<app config dir>/transcripts.db` (`transcript.rs`). It uses the tasks.db pattern: a `user_version` ladder, WAL, `busy_timeout 3000`, a lazy reopen and `in_memory()` for tests. It is not a tasks.db table, for two reasons: the Librarian reads tasks.db as compact rows, never raw logs, and a migration there would lock an older binary out. The Librarian never opens transcripts.db, and nothing in it is fed back into a prompt.
- **Who writes.** Only Rust:
  - every handoff_log row is mirrored right after `publish_entry`, and backfilled from tasks.db on read (keyed by `handoff_seq`, so it is idempotent);
  - the worker records each model call's prompt and reply (`WorkerEnv::transcript`);
  - the hub records the interview, Tony's hand-off, steers, smoke tests and repairs;
  - Claude Code's runs record their progress;
  - a delegated Tony turn records its steps.

  The only webview input is the intake interview, passed with the approved `build_enqueue`. Rust scrubs it again.
- **Hygiene.**
  - Every summary and body goes through `devqueue::scrub` (known values and key patterns).
  - Summaries are one line of up to 160 chars. Bodies keep up to 16 K chars; for a longer one, the first 12 K and the last 4 K are kept, with a marker between them.
  - `message` is append-only (an UPDATE aborts).
  - A conversation keeps 800 messages. After that it keeps only hand-offs, errors, smoke tests, repairs and overrides, and counts the rest as dropped.
  - Past 400 conversations, the oldest finished or 30-day-idle ones are pruned.
- **Best-effort.** A recording error is logged once. It never fails or delays a stage, a turn or an enqueue. If the file can't be opened, the feed is off and the app runs normally.
- **The chat.**
  - Each root conversation (`task:`, `hub:`, `turn:`, `dev:`) gets one card, in the thread that started it. A hub build's worker task and Claude item nest inside its card.
  - Live updates come over `agent-transcript`, which carries only the head and the summary. A message body loads when its row is opened.
  - After a restart or reload, the cards are rebuilt from `transcript_conversations` / `transcript_get`, never from bus delivery.
- **Additive.** The relay and system lines are unchanged. So are the spoken Agent Chatter (`routing.vocalHandoffs`), the narrator and verbosity 0–3. The **Agent Log** switch in the Agents header (`chat.showAgentConversation`, default on) only shows or hides the cards. The approve() / Tier-3 / dispatch gates and the staging-only writes are untouched: the feed only reads and never dispatches.

## AD-11: Behavioural probes in verify (the build gate checks what the page does, not only what it contains)

**Why.** After the first quality gate (offline only, Nic's exact values, quoted-code evidence, a storage-blocked runtime smoke), a protein-tracker re-run with the 9B verifier still passed real behavioural bugs: the lb/kg toggle set the unit before comparing it, so it never converted; the meal split read 3, 5, 4; kg was marked active while the unit was lbs; saved state was merged after the first render and never shown. Quoted code proves an element exists, not that it behaves. The verifier also never saw that code: the excerpt kept the head (CSS and markup) and the tail of the page and cut the middle of the script.

**What the verifier reads.** `quality::verify_view` puts every inline script first, whole when it fits, then the markup with the scripts pulled out and the CSS bodies dropped. The markup's middle is cut first and the middle of a script only when the scripts alone do not fit; either cut is reported, the prompt then says so, and a criterion the model leaves undecided (`met: null`) is recorded as "not shown", never counted as unmet.

**Probes: a tiny DSL, never model JavaScript.** Each criterion in the verify reply may carry a `probe`: up to 8 steps, at most 6 probes per pass (14 since AD-12: `MAX_PROBES` = 10 acceptance criteria + 4 intent checks, where a behavioural criterion needs one that ran and passed).

- Actions: `set` (types like a person: focus, keydown, the value, input, keyup, change, blur; a checkbox or radio is clicked when its state must change), `select`, `click` (first match or `nth`), `reload` (storage kept). Each action is followed by a 500 ms settle wait (virtual time), and each expectation is polled for about a second before it fails, so debounced and keyup / blur handlers count.
- Expectations: `expect_text` / `expect_value` with `contains`, `equals` or `approx` + `tol` (ANY number in the text: a range "120 - 165 g", "165 lbs (74.8 kg)", a decimal comma), `expect_class` (`present`), `expect_count`, `expect_order` (an attribute, or the text when no element carries it, e.g. `data-meals` 3, 4, 5; labels match case-insensitively, by leading number or contained; values naming fewer than two expected labels are a broken probe). Form controls are read by state: an input's value, a select's value and its selected label, a checkbox's checked state.
- Rust validates the reply first (`quality::parse_probe`): known ops only, a selector charset with no `<`, `{`, `;`, `/` or backslash, capped strings and numbers, at least one expectation. The steps reach the page as inert JSON (`<`, `>` and `&` escaped), never as code.

**How they run.** The same isolation as the runtime smoke: a temp copy of the page, its own throwaway Edge profile with downloads pointed into the temp folder, the network unreachable, a kill-on-close Job Object (Edge dies with the app), a timeout. One headless Edge run per probe (20 s each, 120 s in all), so every probe starts on a fresh load with storage cleared, and a probe that hangs the page fails alone: it is that probe's failure (naming the step in flight when Edge still printed the page), never a reason to drop the other probes' results. Leaving the page (a link, `location.href = …`) is cancelled through the Navigation API; reloads still work, and the runner keeps its place in `window.name` across them, mirrored onto `<html>` as `data-tf-probe-partial`. Storage works for probes (only the smoke blocks it), so `set → reload → expect` checks that saved state is shown. Dialogs, form submits, `window.open` and downloads are stubbed. The results are written to `data-tf-probe` on `<html>` and read back from `--dump-dom`.

**How they are judged** (`quality::judge`).

- A failing expectation makes its criterion unmet, whatever the model said. The fix line names the steps and both values, what the page produced first (a line is clipped from its end), e.g. `probe failed for <criterion>: got 165; expected #weight-input value ≈74.8 (±0.5) after set #weight-input=165, click #kg-toggle`. Probe failures go first in the Coder's fixes, and first after the gate's own items in the known blockers at the iteration limit.
- A probe whose selector matches nothing (or whose option does not exist) is a broken probe. It is recorded but counts against the build only when the criterion also has no code evidence.
- Evidence is still required: every non-trivial quoted line must be in the page (a bare `render();` or a single word proves nothing).
- A criterion the verifier left out, or left undecided although its code was shown, gets one retry of the stage, then becomes a named blocker. It never loops the Coder, and it is never passed silently.
- No Edge or runtime checks off: the probes are skipped and recorded (`last_eval.verify.probes`, `criteria[].probe`), and the evidence-only rule decides.
- A probe that failed is kept in `last_eval.open_probes` (the evaluate pass carries it over) and runs again on the next verify alongside whatever the verifier writes then (`criteria[].probe.rechecked`). Failing again, or now matching nothing while no new probe for that criterion passed, keeps the criterion unmet; it closes only when it passes.
- A Play Place hub build whose criteria are still unmet on the last pass fails into its Repair Queue, as for the gate.

**Related gate changes.**

- The runtime smoke now returns three outcomes. *Skipped* (no Edge) falls back to the static checks. *Failed* (the page hung, kept reloading or navigated away) fails the gate. *Ran* records the page lines where a blocked storage access happened. A clean smoke clears only the scanned storage uses it actually reached and saw caught.
- The smoke skips buttons an earlier click removed or disabled, and ignores the harmless ResizeObserver notice.
- Nic's values are checked as a number with a unit word near it, with CSS and comments stripped. Ranges ("3-5 meals") and thousands ("10,000 steps") are kept whole.
- A Play Place hub build that still fails the gate on the last pass fails into its Repair Queue instead of being handed on as review_ready.
- The Coder reads the latest loop's fixes before the brief's older ones, and Nic's own words with head and tail kept.

## AD-12: Required probes and pinned intent checks (the verifier cannot pass behaviour it did not run)

**Why.** A review of AD-11 on the protein-calculator run ("I'm 165 lbs … default 165 lb, with lb/kg toggle … per-meal split (3-5 meals)") found the probes optional: a criterion that was met with real quoted code still passed when its probe was missing, rejected, matched nothing, or was past the 6-probe cap. The same 9B model also wrote expectations it copied from the page's own code (a kg → lb round trip back to 165, the page's own formula output), and the prompt's examples were literally the protein answers (`#weight`, `#kg`, 74.8, `.split-btn` / `data-meals`, 3, 4, 5). A numeric `contains` was a substring match ("0" matched "40 g"). The page that shipped had a kg toggle that never converted, splits ordered 3, 5, 4, and implausible targets.

**Required probes.**

- A criterion is *behavioural* when it describes something that changes, computes, converts, toggles, totals, adds / removes, resets, orders, saves / restores, or shows a default or initial value, or when it carries one of Nic's literal values (`quality::need_of`).
- Where probes can run (runtime checks on, a staged page, a local Edge), a behavioural criterion counts as met only when a probe for it ran and passed. A passing probe also stands in for quoted evidence; a failing one is a Coder fix as in AD-11.
- No working probe (missing, rejected by `parse_probe` or the rules below, matching nothing, or skipped by the cap or the time budget) is a *probe gap*, not an unmet criterion. The verify stage is retried once with the exact reasons fed back into its prompt: which criteria, the parse error text, the selector that matched nothing, the pinned value to use. If the last attempt still has gaps, each becomes a known blocker `no working probe for: <criterion> (<why>)`. It never loops the Coder, because the page may be fine.
- Where probes cannot run, the evidence-only rule of AD-11 still decides.
- The cap is now 14 new probes per pass (plus up to 6 carried), with the behavioural criteria's probes first. That covers 10 acceptance criteria plus up to 4 intent checks. Edge time stays bounded by the existing caps: 20 s per probe and 120 s for the whole run, and probes past the budget are "not run" (a gap).
- A behavioural probe must act (`set` / `select` / `click`) before its first expectation, unless the criterion is an on-load default or order check. A probe that only reads the page is rejected with that reason.
- `parse_probe` normalises the usual small-model variations instead of rejecting them. Keys `action` / `type` / `step` become `op`, `selector` / `target` / `css` become `sel`, and `text` / `val` become `value`. The op aliases are `fill` / `type` / `input` → `set`, `choose` → `select`, `press` / `tap` → `click`, and `assert_text` / `expect` → `expect_text`. Numeric strings are accepted. The selector charset, caps and inert JSON are unchanged.

**Pinned intent checks** (`quality::intent_checks`; the model supplies selectors and actions only).

- (a) A literal stated as a default ("default 165 lb", "I'm …", "I am …", "my … is …") means that number shows on a fresh load, before any action.
- (b) A unit pair named in the request ("lb/kg", "miles or km"; also mi/km, °F/°C, oz/g, in/cm and ft/m) plus such a default in one of its units means that, after switching, the value reads the converted number. Rust computes it (165 lb → 74.84 kg), with a tolerance of 0.6 % or 0.5, whichever is larger. The probe must act before its final expectation, and that expectation must not be the starting value (a round trip is rejected).
- (c) An integer range offered as choices ("3-5 meals" near split / choose / pick / options / buttons …, with 1 ≤ M-N ≤ 6, and never a measured range such as minutes or reps) means the options read N..M ascending (`expect_order`).
- The checks are added to the verifier's numbered criteria with the pinned value stated. A probe for a check passes only with the pinned expectation, and Rust rewrites the step to that value. A probe expecting another number is rejected with "use the pinned value X". The checks stay generic and conservative: when the request does not clearly yield one (no stated default, two conflicting defaults, no choice word), none is derived.

**Prompt.** The probe examples come from another domain (a tip calculator: `#bill`, `#tip-15`, `.row`) so the model is not primed with the answers. The prompt also says that expected values come from Nic's request and well-known real-world facts the model computes itself, never from the page's own code or formula. A computed recommendation that is implausible in the real world is marked unmet, with the reason.

**Numbers in `contains`.** A numeric `contains` (optionally with a currency sign and a unit word: "40 g", "$39.33 per person") matches its number as a whole number token followed by the unit, so "0" does not match "40 g" and "40" does not match "140 g". Other text stays a case-insensitive substring.

**Review fixes (after e16cdea).** A skeptic review of AD-12 found ways a broken page could still pass or a correct one be blocked:

- *The gap retry never discards a probe failure.* The verify stage is retried for probe gaps only when nothing else is unmet: a pass where a probe really failed goes to the Coder (its probe is recorded in `open_probes` and carried), because the retry's fresh answer could swap in a weaker probe that passes. The retry is spent only on gaps the verifier can fix (no probe, a rejected one, a selector matching nothing), never on probes skipped by the cap or the time budget. The retry's reasons are keyed by the claim (iteration and lease), so a later claim never inherits a retry that never ran.
- *The cap covers every criterion.* `MAX_PROBES` = `MAX_CRITERIA` (10) + `MAX_CHECKS` (4) = 14, with the pinned intent checks' probes first.
- *On-load checks expect first.* A default / initial-state / order criterion stays an on-load check even when it names a state ("selected") or a thing ("the toggle"); only an action verb or phrase ("switching to", "after clicking", "converts") makes it need an action. Its probe must expect BEFORE any action: one that clicks "lb" and then sees "lb" active proves nothing about the default. A criterion that is behavioural only through Nic's literal needs an action only when it names one.
- *Computed values are read.* A criterion that computes or converts (calculate, convert, divide, per-meal …) is not proven by a probe that only checks a class or a count.
- *Evidence.* A passing probe stands in only for evidence the verifier did not give. Quoted code that is not in the page is reported whatever a probe did, and a criterion that is not behavioural still needs real evidence. A behavioural criterion with no quote and no working probe is a gap, not a Coder fix.
- *Pinned steps by number.* `pin` holds the read whose number matches (Default: before any action; Convert: after the switch), so extra reads ("kg" shown as the unit) and a return toggle are kept. A Convert probe is a round trip only when every number it expects after the switch is the starting value.
- *Personal stats and ranges.* "I'm …" / "my … is …" is pinned as a default only when the request also asks for that quantity (its unit pair is named, or another sentence asks for a field / default / toggle in its unit): "I'm 28 years old" in a protein-calculator request pins nothing. A range is a choice only when a choice word governs it ("split (3-5 meals)", "pick 2 to 4 laps", "3-5 meal options"); a "button" or "toggle" elsewhere no longer makes "5-10 questions" a pinned order.
- *Numbers in `contains`.* An all-zero fraction may follow either side ("$92" matches "$92.00", "92.50" matches "92.5"); any other fraction still may not.
- *Small-model shapes.* `parse_probe` also reads one step given as an object, the list given as a JSON string, a numeric `"step"` next to the `"type"` op, and drops wait / sleep / pause steps (the harness already settles and polls).
- *Prompt.* The verifier's line for Nic's values says a unit toggle may show them converted (the build stages keep "never convert"), on-load checks expect first, and the cap it states is the code's.
- *Play Place hub builds.* A hub build with a probe gap after the retry loops to the Coder like an unmet criterion and fails into the Repair Queue at the limit, instead of reaching review_ready, which the hub smoke-tests and marks mergeable without reading its blockers (`last_eval.verify.gaps`).

## AD-13: Honest staging (numbers as text, stuck pages, one gate repair, verdicts that say what is still broken)

**Why.** Live run 3 (qwen3.5-9b, commit 225247b, the protein calculator: "I'm 165 lbs … default 165 lb, with lb/kg toggle … grams-per-pound ranges … a per-meal split (3-5 meals) … a running tally") reached review_ready with a page that never rendered on startup ("Loading..." in `#targetDisplay`, "0g" per meal until a control changed) and an add-food form missing its `#proteinGrams` input, so adding food threw. The gate caught both, but only on the last pass, so they were handed on as known blockers, and the verifier's voice line still said "Build passes all functional criteria". The 9B also wrote `approx` as text ("132 - 165 g", "26 g"), and 4 of 5 probes were rejected. A critic review of AD-12 (HEAD 3722b28) found nine more gaps; each is closed below.

**Numbers written as text** (`quality::parse_probe`, `numbers_in`).

- An `approx`, `equals` or `contains` string with numbers in it is read as numbers. One number becomes `approx` that number (the given `tol`, else 1 % of it and at least 0.5 for `approx`, or two decimals for `equals`).
- Several numbers ("132 - 165 g") become an all-of check, `all: [132, 165]`: it passes only when every listed number appears in the element. The check is number-aware, so "132-165g" on the page passes.
- A dash after a digit or a letter is a range dash, not a minus sign. A single number in `contains` keeps its whole-number token match with its unit ("40 g", "$39.33"), and plain text is still a substring.
- A stored all-of step validates again when it is carried to the next verify.

**Stuck placeholders** (the runtime smoke, `SMOKE_JS`; `quality::stuck_line`).

- After load and 800 ms of virtual time, and before any interaction, the smoke records output-like elements that still show a placeholder. An element counts as output-like when it is an `<output>`, or when its id or class names a display, result, total, target, output, summary, amount, readout, answer or tally. Form controls never count.
- A placeholder is visible text of up to 60 chars that does one of these:
  - ends in "Loading" or "Calculating";
  - holds NaN, undefined, null, Infinity or [object Object] as a token;
  - is only dashes or an ellipsis (an optional unit may follow). This one counts only when the page has a filled-in input or a select, so there is something to compute from.
- Empty-state copy ("No foods yet"), hidden elements and an empty calculator's "--" are not flagged. Of nested matches, the innermost is kept.
- The gate then fails with `the page still shows 'Loading...' in #targetDisplay after it loaded (render on startup)` (`checks.runtime.stuck`). It is skipped when the page crashes on load, because the crash is the cause.

**One gate repair pass** (`h_evaluate`, `gate_repair_done`, `GATE_REPAIR_LEAD`).

- When the last allowed pass of a usable page still fails gate items that one targeted pass can fix, the Coder gets exactly ONE more code pass, at the same iteration, carrying only those items. They are listed in `last_eval.fixable`: ids the script looks up that no element has, throws when the controls are used, stuck placeholders, external scripts or stylesheets, Nic's lost values and unguarded storage.
- The repair pass starts with "LAST-PASS REPAIR: fix ONLY the build-check items below", and the brief's older fixes are left out. The gate then runs again. Only after that is the build handed on with blockers, or for a hub build failed into its Repair Queue.
- It is recorded as a `loop_iteration` row to the Coder with `gate_repair: true`, and as `last_eval.gate_repair`.
- There is never a second repair in one iteration. It is never given for a page that crashes on load or hangs: that page fails as before.

**Honest verdicts** (`h_verify`, `review_voice`).

- A build staged review_ready with gate items, a failing probe or a probe gap records `last_eval.works = false` and `last_eval.verdict = "needs_fixes"`. A build with only notes from the model records `pass_with_notes`, and a clean one records `pass`. The status stays review_ready (the frontend reads `known_blockers` and shows the ready turn in its warning tone). `.status.json` and the review_ready row carry `works` and `verdict` too.
- Whenever blockers exist, the voice line is deterministic, e.g. "Built, but 2 things still don't work: …". It never says "passes" then.
- A Play Place hub build now also counts criteria the verifier did not judge, and a missing per-criterion list, as unmet: at the limit it fails into the Repair Queue (`last_eval.verify.not_judged` / `absent`).
- Nic's pinned checks still unproven after the verifier's retry, on a pass that is not the last, send the Coder another pass ("Nic's pinned check is still unproven in a browser …") instead of a "pass". On the last pass the build is staged with `works: false`.

**Correct, don't reject** (`quality::pin`).

- An Order probe always gets the pinned list; a probe that expected 3, 5, 4 already looked at the right buttons.
- A Convert probe whose one-number read follows the switch gets the pinned number in its place when it expected the starting value or a plausible wrong factor (within 25 %). Example: "click kg, expect 165" runs as "click kg, expect 74.84".
- Both record `criteria[].probe_note: "pinned value substituted: …"`.
- These are still rejected: a round trip, a read that expects a range (another element), a Default read of another number, and a read of the whole page.

**A switch must change something** (`quality::shows_change`, `round_trip`).

- A criterion that mentions a toggle, switch, conversion or unit (`Need::toggle`) needs a probe with at least one read after an action that does both of these:
  - it does not follow a round trip: one control clicked an even number of times, or a switch to a unit and back (by the unit words in the selectors and values, against Nic's home unit when it is known);
  - it does not expect only the value the probe itself typed into that element, or the element's value on load (Nic's pinned default, on the element its default probe reads).
- A reversible probe (switch, read the converted value, switch back, read the start) passes on its first read.

**Nic's unit on load** (`CheckKind::Unit`, `expect_unit`).

- A default stated in one unit of a named pair adds a pinned on-load check: the unit control has that unit selected, not the other one. It comes after the order checks, so the 4-check cap cuts it first.
- The verifier's first read on the unit control becomes `expect_unit` with unit keys only. Stored steps are validated against the unit table, and the harness gets the spellings from Rust, with non-ASCII escaped.
- The harness looks for the selected unit in this order:
  - a select's selected option;
  - the checked radio, or a checked checkbox;
  - an unchecked checkbox labelled with the other unit (it means this unit);
  - elements marked active, selected or on, or with aria-pressed, aria-checked, aria-selected or aria-current. It searches the matched elements first, then inside the first match, then that element's siblings of the same tag.
- A label that names both units decides nothing. A control that shows no selected unit is a broken probe (`nounit`), so it is a gap, never a failure.

**Intent recall** (`quality::stated_default`, `range_checks`).

- These now pin Nic's values:
  - "I weigh 165 lbs";
  - "my weight (165 pounds)" and "my weight is about …";
  - a back-reference right after the value with no other number between: "use that as the default", "that's the default";
  - "pounds/kilograms";
  - "3 to 5 meals per day" / "a day";
  - "split it across 3-5 meals" ("it", "across", "over", "among" and similar words may sit between the choice word and the range).
- Ages, kids' ages, "3-5 business days", price ranges, dates and times of day still pin nothing.

**Evidence and weak reads** (`quality::judge`, `ProbeResult::specific` / `value_specific`, `weak_sel`).

- A passing probe that read an element of its own proves a behavioural criterion even when the quoted code is stale or paraphrased. The row records `evidence_found: false` with an `evidence_note`, and the Coder is not looped.
- A read of `body`, `html`, `main`, `:root` or `*` (static), or of an element with more than 200 chars of text, does not prove a value criterion or a pinned number. The harness reports such reads as `w`. The rules reject the static case up front with a reason, and the runtime case becomes a gap the verifier is asked to fix.

**Nothing dropped silently.**

- Probe gaps are sorted with Nic's pinned checks first: in the retry feedback, the verifier's blockers and `known_blockers`.
- The retry feedback keeps whole lines, then "… and N more" (`fit_lines`).
- Gap and not-judged lines are no longer capped at 8. `known_blockers` keeps 16, and past that its last line says "… and N more (see the verify record)" (`last_eval.blockers_dropped`).
- Probes carried from an earlier failure run BEFORE the verifier's new ones, so the 120 s budget never skips a bug that was already caught.

**AD-13 review fixes.** Twenty review findings on the commit above are fixed:

- **The repair never makes it worse.**
  - Before the repair pass, `h_evaluate` keeps the page as `.iterations/<n>-pre-repair.html`, with its gate result in `last_eval.gate_repair_pre`.
  - If the repaired page crashes on load, hangs, or misses more items than before, the old page is put back and staged with its own gate items as blockers (`last_eval.restored`).
  - If the repair Coder fails for good (no HTML, a timeout), the gate runs again on the old page instead of failing the build (`gate_repair_fallback`). This applies to non-hub builds only.
- **The one-repair bound uses state that cannot be dropped.**
  - `gate_repair_done` reads `last_eval.gate_repair` ("pending" / true) for this iteration first.
  - The repair row is a milestone, which a full handoff log always writes.
  - Rows count only after the latest `retry`. `retry_task` clears the stored repair state, so a retried build gets its own repair.
- **Verdicts.**
  - `works` is false when the verifier did not judge a criterion or gave no list.
  - A pinned check the verifier left out or left undecided loops the Coder like a pinned gap (`verify.pinned_unjudged`).
  - A unit control the harness cannot read (`ProbeGap::unreadable`) is a known note (`verify.note_gaps`): no Coder loop, no hub failure, and the build can still "work".
- **The true blocker count.** `last_eval.known_blockers_total` (also in `.status.json`) holds the true count. The app's ready line uses it, not the length of a list that ends in "… and N more".
- **Recall.**
  - A back-reference must sit in the value's own clause, or be the whole next clause. It must end at "default" (or "default value / weight …" or a preposition). "This is the default page", "make it the default tab" and "It's the default tool" pin nothing.
  - "my <adjective> 10 lbs" is not a personal stat. Only "my (current) weight …" and "my … is …" are.
  - "N-M <noun> a/per day" is a choice only when a choice word is in its sentence, or for meals in a request that asks for a per-meal split. "I drink 6-8 glasses a day" pins nothing.
  - When Nic names the other unit as the default ("default unit kg", "default to kg", "kg / metric by default", "start in kg"), no Unit check is pinned.
- **Pinning.**
  - The Unit pin rewrites the step on the unit control: one naming a unit or "unit", else one that does not read a number. It never rewrites the weight read before it.
  - A Convert value is substituted only on the weight element: one named for weight, mass or a unit, an input read not named as an output, or the element the Default probe read. A read of the target (its upper bound is 165 g with Nic's numbers) stays a gap.
- **Round trips.**
  - Only a toggle-like control (one that names a toggle, switch, unit, mode or a unit of a pair) clicked an even number of times counts.
  - A `set` between the two switches makes it a real conversion. A "+" stepper or "Add" clicked twice is fine.
- **Stuck placeholders.**
  - A dash or ellipsis counts only when every visible text or number input is filled. A select alone, or an empty bill or grams field, leaves "--" as an empty state.
  - "Loading" / "Calculating" counts only as the whole text, with an optional "Label:" before it. "Carb loading" is a value.
  - The page is sampled again 1.5 s later, and only a placeholder still showing then counts.
- **Reading the unit control (`expect_unit`).** These designs are read:
  - any class token such as "unit-active" or "btn-selected" ("inactive" never counts);
  - a checkbox slider with the unit texts beside it (unchecked means the one before it);
  - a lone toggle button showing its unit as text ("Switch to kg" means lb);
  - colour-only buttons (the one coloured button among grey ones);
  - Imperial / US / Metric / SI labels.

  A control naming no unit of the pair is `nounit`, never a failure.

**AD-13 critic fixes (round 2).** The run-3 critic harness (real Edge, the run-3 intent) found a correct page staged as broken and a broken one hidden behind copied numbers:

- **Reads before the action are fine (P1-1).** An acting criterion's probe needs an action with at least one expectation after it ("expect 165, click the toggle, expect the result" is accepted); the value and must-show-a-change rules are held on the reads after the first action (`own_rules`).
- **On-load criteria are decided before any action (P2-4).** Only the reads before the first action run (the rest are dropped, noted on the criterion): an action can trigger the first render and hide a page that never renders on load.
- **Values need numbers (P1-3).** A value criterion needs a numeric read (approx, all-of, or a number-aware contains); a text contains such as "Loading" proves nothing. A probe that expects a placeholder (Loading, Calculating, NaN, undefined, null, --, …, [object Object]) is rejected.
- **Something must change (P1-3).** An acting value criterion's probe is marked `Probe::change`: the harness records each later read's text before the first action, and a probe whose every passing read still shows it fails as "nothing changed after …", a page failure. A zero expected after a typed non-zero number fails on its own when it was already there (`zero_reads`). A read that keeps its value next to one that changes is fine (the protein target after a unit switch).
- **The Coder loops only for what the page can cause (P1-2).** A pinned gap loops the Coder only when its probe ran and an element is missing (`ProbeGap::page`). No probe, a rejected or weak one, or a criterion left out is the verifier's: one retry, then a blocker that reads "couldn't be checked in a browser: …".
- **Stale quotes are the verifier's (P1-4).** A passing probe that reads an element of its own proves any criterion over a stale quote. A criterion that needs no probe, quoted with code that is not in the page, gets one verifier retry ("copy it verbatim"), then a note (`Judged::stale`, "couldn't confirm in the code"). It never loops the Coder and never blocks `works`.
- **Broken values anywhere (P2-3).** The smoke flags NaN, undefined and [object Object] in any visible leaf element, not only output-like names ("NaN%" in a progress label). The gate line names it as a broken value.
- **Wording (P3, P2-1).** The voice tells "N things still don't work" (gate items, failed or unmet criteria) from "N things couldn't be checked" (gaps, not judged). It never ends in "….". A loop the checks forced never carries the verifier's "passes" line. The app's ready line reads `last_eval.works` / `verdict`: "staged but needs fixes", "ready for review, with N notes", or the old neutral line when neither is there.
