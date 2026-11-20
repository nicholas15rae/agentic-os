# Tony Steering Spec (Phase 2, as implemented)

Status: implemented on `feat/thoughtform-pipeline`, uncommitted, 2026-11-19. This file describes what the code does now. The original request is Nic's "Phase 2: front-end steering, Tony Mode Panel and hard mic sovereignty". The working plan is `tf-p2-plan.md` in the build scratchpad.

Covered here: modes, curiosity, dispatch policy, hard mic mute, activation threshold and meter, registry prep, the decisions taken, what is not verified, and how to try it.

---

## 1. Modes: schema and storage

**Storage.** `modes.json` sits beside `os.json` in the app config dir and is about 3 KB. It holds `{ version: 1, active_mode_id, modes: [...] }`. Writes are atomic (tmp file, then rename).
- On every load the six presets are re-seeded from code. Custom modes are kept.
- A corrupt file is renamed to `modes.json.bad` and the presets are used. It never panics.
- An unknown or novelty `active_mode_id` falls back to `brainstorm`.
- Code: `command center/src-tauri/src/commands/modes.rs` (tests in `modes/tests.rs`). The TS mirror is `command center/src/features/modes/modes.ts`, which is pure and holds the prompt constants verbatim.

Mode schema (spec snake_case keys, no camelCase rename):

```json
{
  "id": "string (^[a-z][a-z0-9_-]{0,31}$)",
  "name": "string, 1-32 chars",
  "icon": "string, 1-32 chars (lucide name or an emoji)",
  "curiosity_level": "low | medium | high",
  "verbosity": "terse | balanced | conversational",
  "agent_dispatch_policy": "surface_only | ask_before_dispatch | auto_dispatch",
  "tts_interrupt_level": "silent | milestones_only | full",
  "prompt_modifier": "<= 280 chars, single line, no control chars, must not contain 'json' or '/no_think'",
  "is_novelty": false
}
```

### Presets

Presets are read-only and can't be deleted. Duplicate one to customise it.

| id | name | curiosity | verbosity | dispatch | tts | icon | prompt_modifier |
|---|---|---|---|---|---|---|---|
| `surface` | Surface / Solo | medium | balanced | surface_only | silent | message-circle | (none) |
| `brainstorm` (**default**) | Brainstorming | high | conversational | ask_before_dispatch | milestones_only | lightbulb | "Refine raw ideas with sharp follow-ups; when one firms up, offer to park it in the Brainstorm list or hand it off." |
| `builder` | Builder | medium | balanced | auto_dispatch | full | hammer | (none) |
| `executive` | Executive | low | terse | ask_before_dispatch | milestones_only | briefcase | (none) |
| `coach` | Motivation / Coach | medium | balanced | surface_only | milestones_only | flame | "Be a grounded, high-energy accountability partner: name the next concrete step and push Nic to take it." |
| `gabagool` | Gabagool Mode | medium | balanced | surface_only | silent | spaghetti emoji | (none), `is_novelty: true` |

**Gabagool is a novelty overlay.**
- Selecting it toggles the cue system with `toggleGabagoolMode()`. If Gabagool is playing, that stops it. Otherwise it stops any other cue and starts Gabagool.
- It never becomes `active_mode_id`, never injects prompt text, and never appears in the work-mode radiogroup.

### Commands and events

- **Tauri commands:** `tony_modes_get`, `tony_mode_set_active`, `tony_mode_override`, `tony_mode_reset`, `tony_mode_upsert`, `tony_mode_duplicate`, `tony_mode_delete`. Each one emits `tony-mode-changed`.
- **Phone mirror:** `/api/os/state` carries a `mode` block: `{id, name, icon, curiosity, verbosity, dispatch, feedbackLevel, overridden, list}`.
- **Phone writes:** they go through the inbox `command` kind with `modeId`, `overrides` or `resetOverrides`. The gateway's `os_api.py` `_validate_command_payload` type-checks those keys, plus `micEnabled`, `killSwitch` and `computeMode`.
- **Switching timing:** a switch takes effect on Tony's next turn. LM Studio and AnythingLLM are not restarted, and no model or VRAM is added.

### Overrides

- Changing Curiosity, Dispatch, Verbosity or narration by hand creates a temporary override. Overrides live in memory and are cleared by a mode switch, by "Reset to mode default", or by a restart.
- A manual NarrationControl change is recorded as an override and also emits `tony-mode-changed`.
- If you edit the active mode, a manual narration override survives the edit. It is dropped only when it equals the edited mode's own level.

## 2. Curiosity, verbosity and dispatch blocks (prompt injection)

**Where the block goes.** Tony's own turns (role `general` only) get a MODE block. It is appended after the Tier-2 hint and before `/no_think`, so `/no_think` stays on the last line. Sub-agents and the Booking workspaces never get it.

**Tier-2 hint split.** The old `TIER2_HINT` is now `TIER2_SAFETY` + `TIER2_STYLE`. When a MODE block is present, only the safety half is used, so the mode's length rule wins.

The block is deterministic: the same effective state always produces the same text. Empty lines are skipped. The whole block is at most 700 chars, and the mode notes are clipped to fit.

```
MODE: {name}. These MODE rules override the STYLE length rule.
{curiosity line}
{verbosity line, omitted for balanced}
{dispatch line, omitted for ask_before_dispatch}
MODE NOTES: {prompt_modifier}
```

| Constant | Text |
|---|---|
| CURIOSITY_LOW | CURIOSITY LOW: answer directly in 1–2 sentences; no follow-up questions unless you are blocked. |
| CURIOSITY_MEDIUM | CURIOSITY MEDIUM: natural pace; at most 1 focused clarifying question, only if it helps. |
| CURIOSITY_HIGH | CURIOSITY HIGH: be an active brainstorming partner: probe edge cases, offer 1–2 creative angles, stay curious. |
| VERBOSITY_TERSE | VERBOSITY TERSE: shortest useful answer; short confirmations; zero filler. |
| VERBOSITY_CONVERSATIONAL | VERBOSITY CONVERSATIONAL: up to 4 short sentences when it helps the conversation. |
| DISPATCH_SOLO | SOLO MODE: nothing is handed to the Prompter, Designer or Coder now. If Nic wants something built, offer to park it, or say it can be queued once he switches modes. |
| DISPATCH_AUTO | BUILDER MODE: the app queues a clear build for the Prompter as soon as Nic commits; never say it was queued unless the app confirms it. |

- A novelty mode injects nothing.
- A test asserts that no preset or block contains a banned word (`json`, `/no_think`, `gabagool`).
- The gateway fallback (`dispatcher/agents.ts`, `general.systemPrompt`) appends the same block through `modeBlock()`.

## 3. Dispatch policies, and how auto_dispatch interacts with approve()

There is one truth table: `dispatch_allowed(policy, kind)` in Rust. `tier3Action(effective, target)` in TS is its twin.

| Policy | Build pipeline (`auto:false`) | Build pipeline (`auto:true`) | Agent hand-off |
|---|---|---|---|
| `surface_only` | refused `MODE_SURFACE_ONLY` | refused `MODE_SURFACE_ONLY` | refused |
| `ask_before_dispatch` | allowed (after the Tier-3 yes, as before) | refused `MODE_NOT_AUTO` | allowed |
| `auto_dispatch` | allowed | allowed | allowed |

### Where the gate is enforced in Rust

- `task_create`, which gains `auto: Option<bool>`. An auto build records `autoDispatched: true` in the envelope options. `OPTION_KEYS` was widened so that flag is kept.
- `capture_task`, `task_from_idea`, and the inbox `task` kind, all through `create_task_gated`. The inbox `task` takes `auto` from its payload.
- **Unchanged:** `task_retry`, `task_cancel` and the worker loop are not gated. Tasks already queued keep running.

### What each policy means for Tony's Tier-3 turn

This lives in `voice-controller.ts`.

- **ask_before_dispatch.** This is today's behaviour. The spoken "delegate or park?" offer card appears, and a yes goes through `approve()`.
- **auto_dispatch (Builder).**
  - When does Tier-3 skip the offer card? Only when Tony's thread is in a live brainstorm and the offer target resolves to the **pipeline**. Tony then makes one `task_create{auto:true}` call, says `BUILD_QUEUED_LINE` and ends the dialogue.
  - A `MODE_NOT_AUTO` refusal (for example a stale mode) falls back to the normal offer card.
  - On the phone, Tony waits for the desktop's answer, with a 30 s cap once the build is claimed.
    - A `MODE_*` refusal runs the park-card or offer-card fallback and reloads the modes.
    - If the desktop hasn't picked the build up yet, Tony says `BUILD_SENT_LINE` instead of "Queued".
- **surface_only (Solo, Coach).**
  - No build card. Tony offers a park-only card: "Solo mode — want me to park that for later?". A yes, through `approve()`, saves to the Brainstorm list.
  - A phone Capture is parked in the Ideas Ledger with "Solo mode is on: saved it to your Ideas Ledger; tap Run there once you switch modes."
  - `route_for_turn` keeps Domain/Default promotions to the prompter, designer and coder with Tony.
  - A Named route to those three is kept only when Rust's own router rates it high-confidence Named for the same agent. "tell the coder to …" and "coder, write …" are kept; "hey Coder, …" is held with Tony.
  - Explicit agent tabs, Direct live-tool reads, and Librarian/Ops/Booking routing are unchanged.
  - Play Place disables Build prototype, Run pipeline, Rebuild and Retry build.

### Unchanged in every mode

- **approve() still gates every mutating plan:** email, messages, calendar, `requestBuild` (Play Place) and `requestPipeline` (ledger Run). `auto_dispatch` skips only the Tier-3 build offer, whose writes go to `staging/` only.
- **Not built:** the optional imperative "build X" with no brainstorm.
- **Other invariants still hold:** WhatsApp stays read-only and the kill switch still blocks cloud calls.
- **Limit:** Rust cannot prove that a webview approval happened. The mode gate plus the `auto` flag are defence in depth, the same as before Phase 2.

### Narration mapping (`tts_interrupt_level`)

- **Mapping:** `feedback_for` gives silent = 0, milestones_only = 1, full = 2. Verbose (3) is reachable only as a manual override.
- **On a mode switch:** the switch writes `os.feedback.sensitivity`. `modes-store.syncFeedbackLevel()` also updates the webview's `useOs.cfg.feedback.sensitivity` on every apply.
- **First launch:** seeding never rewrites narration. If the saved level differs from the mode's level, it shows as an override.

## 4. Hard mic mute: the layers, and the tests that prove it

A mute is a dead line at every layer that exists. Whisper (`whisper-server.exe` on :8178) has exactly one client, Rust `transcribe_bytes`. The server process keeps running, and with no client it hears nothing.

| # | Layer | Mechanism |
|---|---|---|
| 1 | Rust flag | `voice::MIC_ENABLED` (AtomicBool, SeqCst). It is seeded at startup from `os.json voice.micEnabled`. A mute persists across restarts. |
| 2 | Rust STT client | `transcribe_bytes` returns `Err("mic disabled")` before any provider lookup, validation or HTTP call. A transcript that arrives after a mid-request mute is dropped (empty result). |
| 3 | Rust audio engine | `audio_engine_start` is refused while muted. An engine that finishes opening after a mute is dropped. `set_mic_enabled(false)` calls `stop_now`. |
| 4 | Rust hotkey | While muted, the global hotkey emits `mic-locked` instead of `voice-toggle`. `lockedToggleStops` still lets it stop Tony speaking. |
| 5 | IPC | `nativeRaw("stt_transcribe")` throws `MicLockedError` in the webview while muted. |
| 6 | Webview gate | `mic-gate.ts` starts locked and un-hydrated (fail closed). A mute synchronously stops every registered capture before any listener runs. An unmute on desktop waits for Rust's `mic-state` ack, and a failed IPC leaves the mic muted. |
| 7 | Capture | `MicCapture` checks the gate before the AudioContext, before `getUserMedia`, and again after it resolves; late tracks are stopped. `WhisperStt` and `WebSpeechStt` refuse to start. Web Speech uses `abort()` and drops late results. |
| 8 | Controller | `lockDown` on mute. Gates on barge-in, the follow-up listen, `startListening`, `rearmWake` (both entry and timer), `holdListen` and `setWakeMode`. Hands-free is suspended and its preference kept. A mute during a hold cancels the paused TTS. |
| 9 | No unsolicited TTS | While muted, these are dropped: narration, reminder speech (the toast and the Windows notification remain), startup and time-of-day cues, the ack flavour line, and the confirm-timeout "Cancelled.". A typed turn's reply and an explicit cue tap are still spoken. |
| 10 | Other mic users | Gates in brainstorm capture (new `abort()`), memmap dictation, cue runtime, the reminders scheduler, and the device probe in VoiceSettings. |
| 11 | Phone | The phone has its own local lock, applied at once. The phone can lock the desktop mic through the inbox `command {micEnabled}`. A desktop lock reaches the phone through the 10 s `/api/os/state` poll, and that poll can only lock, never unlock. |

**Unlocking** is done only from the UI: the Mic switch, the locked MicButton, or the phone toggle. There is no voice intent to unlock, because nothing can hear one.

**HUD.**
- When locked, the HUD shows a static red MIC OFF chip, a flat waveform with no animation loop, and a red badge on the orb.
- In the top bar, the callsign dot becomes a red MicOff badge.
- The MicButton face is `aria-disabled`.
- If any capture is still open while locked, the HUD shows a pulsing "MIC STILL OPEN" (leak) instead of MIC OFF.

### Tests that prove it

- **Rust, `commands/voice.rs`:**
  - `muted_mic_sends_zero_stt_requests`: a local fake Whisper server, muted, gets **0 requests**, and even an empty clip returns "mic disabled".
  - `live_mic_sends_exactly_one_request`: the control case.
  - `muting_mid_request_drops_the_transcript`.
- **Rust, `audio/commands.rs`:** `muted_mic_never_claims_the_engine`, `live_mic_claims_and_stop_now_cancels_the_claim`.
- **TS, `src/features/voice/mic-capture-gate.test.ts`** ("zero capture, zero STT"):
  1. A muted `WhisperStt` start never touches `getUserMedia` or Whisper.
  2. Muting mid-utterance stops every track and nothing reaches Whisper. 2b is the control: live, it reaches Whisper exactly once.
  3. A mute while `getUserMedia` is pending stops the late tracks and builds no worklet.
  4. Web Speech abort, mute and late-result drop.
- **TS, also:** `mic-gate.test.ts` (fail closed, synchronous sweep, ack-only unlock), `mic-lock.test.ts` (controller: no listen, no unsolicited speech, mute aborts a live listen, mute during a hold, stop vs cut), `platform.mic-gate.test.ts`, `capture.mic-lock.test.ts`.
- **Python:** `tests/test_os_inbox.py::test_command_kind_accepts_mic_and_mode_keys`.

## 5. Activation threshold and live meter

- **Unit.** The threshold is an absolute dBFS gate: `activationDb`, default -44, range -70..-10. `bargeMarginDb` defaults to 6 (range 0..20) and raises the gate while Tony speaks.
- **Where it lives.** On desktop, `os.json voice.activationDb` is authoritative, and `settings.vad.activationDb` mirrors it. On the PWA, the settings copy is the only one.
- **Gate rules** (`vad-gate.ts`, pure):
  - A frame is speech when level ≥ threshold AND (Silero is not loaded OR its probability ≥ 0.5).
  - A frame is quiet when the level is more than 6 dB under the threshold, or the probability is < 0.35.
  - Speech must last 60 ms before an utterance starts.
  - Frames just under the gate (`isBelowGateFrame`) end the utterance after `endSilenceMs + 1 s` (about 1.7 s by default) instead of the 15 s cap.
  - The threshold is read on every frame, so moving the slider changes the very next decision (test 5).
- **Migration.** Settings v7 converts the old sensitivity with `round(-20 - 0.4 * sensitivity)`. `activationDbSet` (Rust `activation_db_set`) marks a user-set gate. On startup, `syncThresholdFromOs` adopts os.json only when that flag is set; otherwise it pushes the migrated local value up once.
- **Meter.** `ThresholdMeter.tsx` shows the slider and the live meter in one control on one dBFS scale (`meter-scale.ts`), in full and compact versions. `meterClearsGate` uses the capture's own effective threshold (including the barge margin) and the Silero probability, so "clears the gate" on the meter matches the real decision.
- **Saving.** Slider moves apply locally at once and are saved 250 ms after the last move.
- **Where to find it.** The Settings Activation threshold card (`VadSettings.tsx`), with the compact version in ListenControls.

## 6. UI surfaces

| Surface | What it does |
|---|---|
| Top bar `ModePill` | Mode trigger plus a Gabagool segment. Its popover is portaled to the body, opaque, and closes on Esc, a click outside, or a selection. |
| `tony-mode` widget | "Tony Mode": default 3x2, min 2x2, max 6x4. It has a radiogroup of work modes and a Gabagool switch outside it. At height 3+ it adds the Curiosity and Dispatch dials and "Reset to mode default"; at height 4 it adds a Narration line and "Manage modes…". |
| Settings, **Tony Modes** tab (after Voice) | `ModesManagerCard`: new, duplicate ("X copy", "X copy 2"), delete with confirm, the 4 dials, an icon picker or emoji, and a 280-char behaviour-rules field. Presets show a disabled fieldset. Editing is desktop-only. |
| Phone HUD | A `MODE <NAME>` chip, a mode strip (work modes, compact Curiosity, Reset when overridden), MIC LOCKED / DESK MIC OFF chips, a mic lock button, and "Lock desktop mic". Phone switches are optimistic; the mode view refreshes on focus, when the page becomes visible, and every 15 s while visible. |
| NarrationControl | "Set by X on switch; your change holds until the next mode switch". |

## 7. Registry prep (no new agents built)

- **TS agent table.** `dispatcher/agents.ts` declares `AgentRole = KnownRole | (string & {})` and builds agents from an `AGENT_DEFS` array. `agentFor(id)` returns a generic read-only "reports to Tony" agent for unknown ids, and `SUB_AGENTS` is a Proxy over it.
- **TS role ids.** `dispatcher/roles.ts` derives `roleIds()` and `subAgentIds()` at runtime from the `os.json routing.agents` keys, with the static list as the fallback.
- **Rust roster sentence.** It is built from the `routing.agents` keys, and the default text is byte-identical. `role_label` title-cases unknown ids (`security-patrol` becomes "Security Patrol").
- **Rust policy.** `roles::policy_for` already falls back to READ_ONLY for unknown ids. Agent ids are validated strings, not a closed enum.
- **Next step.** A future Security Patrol or Finance agent needs only a `routing.agents` entry, plus a policy if it should be more than read-only. Neither agent was built.

## 8. Decisions taken on Nic's behalf (all reversible)

These are numbered P2-D1 to P2-D25 to avoid clashing with the earlier backend D-numbers.

| # | Decision |
|---|---|
| P2-D1 | Whisper is gated in Rust `transcribe_bytes` plus the webview layers. `whisper-server.exe` is not killed on mute. |
| P2-D2 | Mic state persists in `os.json voice.micEnabled`, so a muted mic stays muted after a relaunch. |
| P2-D3 | The webview starts locked until Rust's state is read (fail closed). |
| P2-D4 | A mute is local and synchronous first. An unmute waits for Rust's ack. |
| P2-D5 | There is no voice unlock. |
| P2-D6 | Unsolicited TTS is suppressed while muted. Typed replies and tapped cues still speak. |
| P2-D7 | Hands-free is suspended while muted and its preference is kept. |
| P2-D8 | `hardStopMic({rearm})`. Changed in the fix pass: **`stopVoice` (Esc / HUD close) now turns hands-free off** (preference set to false). A "cut it" still re-arms. |
| P2-D9/10 | Absolute dBFS gate (default -44, barge margin 6) with Silero AND-gating. os.json is authoritative on desktop. |
| P2-D11 | Default mode `brainstorm`. Seeding does not rewrite narration. |
| P2-D12 | Presets are read-only and re-seeded. Duplicate one to customise. |
| P2-D13 | No hide-from-switcher field. |
| P2-D14 | Modifier ≤ 280 chars, single line. `json` and `/no_think` are rejected, not stripped. The UI also rejects `gabagool`. |
| P2-D15 | The Solo scope is listed in section 3. Queued tasks keep running. |
| P2-D16 | `auto_dispatch` skips only the Tier-3 pipeline offer. The imperative-build auto path is not built. |
| P2-D17 | silent 0, milestones 1, full 2. A manual change is an override. |
| P2-D18 | Overrides live in memory and are cleared by a switch, Reset or a restart. |
| P2-D19 | Gabagool is a novelty overlay. |
| P2-D20 | Modes Manager is its own Settings tab. Editing is desktop-only. |
| P2-D21 | Memory/Librarian bookkeeping verify fixes are dropped with a narrow regex. The bare word "memory" is not dropped. |
| P2-D22 | `anythingllm-prompt-backups` is excluded from the Librarian gather. The files were not moved. |
| P2-D23 | `checks.externalDeps` is advisory only. |
| P2-D24 | Reminder speech counts as unsolicited (silent while muted). The alternative is to gate it by `tts_interrupt_level`. |
| P2-D25 | The phone mic gate is client-side. Rust can't gate the phone's cloud Web Speech recognizer. |

## 9. NOT verified

- **The full Rust suite after the review-fix pass.** Windows Smart App Control blocked the rebuilt test binary (os error 4551) on every run in the fix pass and in the final gate run.
  - `cargo check --lib` and `cargo check --lib --tests` are clean, with 0 warnings.
  - The filtered runs `cargo test --lib modes` (14 pass) and `route_for_turn` (3 pass) did execute mid-fix-pass.
  - The changed `os_core.rs` test `voice_defaults_clamp_and_mirror` compiles but has never executed.
  - The last complete green Rust run was before the fix pass.
- **The app itself.** No `tauri dev` or `tauri build` was run, and nothing ran in the installed app. Every UI surface (ModePill, widget, Modes Manager, phone HUD, meter, MIC OFF visuals) is covered by vitest only.
- **The mic on real hardware.** Not exercised: a real mic, a real Whisper round trip, the global hotkey, or the Silero model in a browser. The threshold is not tuned to Nic's room: detection will shift from the old adaptive floor.
- **MODE block obedience with live model turns.** Whether the local 9B follows the MODE rules (for example "override the STYLE length rule") is untested.
- **The phone path end to end against a live gateway.** The running gateway still has the old `os_api.py`, which rejects `micEnabled` and the mode keys until it restarts.
- **Builder auto-dispatch end to end** (voice → `task_create{auto:true}` → worker).
- **Under Solo, "hey Coder, …":** the TS "Routing … to Coder" notice can still show while Rust keeps the turn with Tony.
- **A Whisper request already in flight at the instant of mute** can't be recalled. Its transcript is dropped.
- **The review.** It raised 22 findings, of which 17 reached the fix pass (14 distinct fixes, each with a regression test). The other 5 were not fixed in this pass.

## 10. How to try it in the morning

```powershell
# 1. Restart the gateway so the phone can send micEnabled / mode keys (Ctrl+C the old one first)
cd "D:\Art Apps\agentic os"
python server.py --port 8080

# 2. Re-run the Rust suite (SAC may block a fresh binary; a rebuild usually yields an allowed one; do not change security settings)
cd "D:\Art Apps\agentic os\command center\src-tauri"
cargo test --lib
cargo test --lib muted_mic_sends_zero_stt_requests
cargo test --lib voice_defaults_clamp_and_mirror

# 3. Desktop app in dev mode
cd "D:\Art Apps\agentic os\command center"
npm run desktop:dev
```

Then:

1. **Mic mute.** Flip the hard **Mic** switch in ListenControls off.
   - Expect a red MIC OFF chip, a flat waveform, and a red badge on the orb.
   - The hotkey flashes the chip and does not listen.
   - Narration goes silent.
   - Turn it back on and check that hands-free re-arms only if it was on before.
2. **Threshold.** In **Settings > Voice**, open the Activation threshold card. Speak and watch the meter cross the marker. Raise the slider until room noise stays under it.
3. **Modes.** Switch modes from the top-bar **ModePill**.
   - In Executive, ask something open-ended and expect 1–2 sentences.
   - In Brainstorming, expect follow-ups.
   - Under Surface / Solo, ask Tony to build something. Expect the "park it for later?" card and no build.
   - Under Builder, brainstorm an idea, then commit. Expect one queued build with no offer card, written to `staging/`.
4. **Widget.** Add the **Tony Mode** widget. Change Curiosity, then use "Reset to mode default".
5. **Modes Manager.** Open **Settings > Tony Modes**. Duplicate a preset, edit its rules, make it active, then delete a custom mode.
6. **Phone HUD.** Check the MODE chip and the mode strip. "Lock desktop mic" should lock the desktop within one poll.
7. **Gabagool.** Tap the Gabagool segment. The theme starts, and the work mode is unchanged.
