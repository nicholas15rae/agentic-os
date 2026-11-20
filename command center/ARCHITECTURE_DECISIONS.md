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
