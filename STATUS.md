# STATUS

Updated 2026-11-27 10:27. One page for every Claude Code session and branch.
**Rule for every session:** after each commit or merge, update the sections below and run `python scripts/update_status.py` (refreshes the branch table at the bottom).

## 1. Done

| What | Branch | Commit | In main? |
|---|---|---|---|
| Tony latency: byte-stable system msg, TURN CONTEXT block | feat/language-hub | 35e30e5 | Yes (4073bd9) |
| App crash hardening: panic.log, restarts wait for WebView2 to exit, scripts\restart-desktop-app.ps1 | feat/language-hub | 1cd5333 | Yes (4bc4e2d), pushed to origin; live since the 22:26 restart |
| Engine R stops reporting refused orders as trades | claude/practical-elbakyan | 8bd7990 | Yes (3fe4835) |
| Tony stops parroting old replies from recall (skips the re-asked turn, stopwords, no mid-list replies) | claude/vibrant-davinci-742cf7 | fa69ab2 | Yes (8278f76), pushed to origin; live since the 23:19 restart; the 23:40 rebuild is main at 0c4341f |
| Gateway: launcher refusal shown as "unsafe" | main | ae86c7b | Yes |
| Command Center GPU idle fix (hidden window 25-33% to 0%) | claude/gifted-pascal | 44856ca | Yes (5ee2580) |
| Sections 8-10 milestone 1: trust fix, live weather, top-bar clock, effects popover, findable Maps | claude/sections-8-10-m1 | 2a2a040 (PR #7) | Yes (bcd8c35) |
| Sections 8-10 milestone 2: comms ingest core, echo fold, leased outbox, bridge smoke, WhatsApp ingester, wrap-up endpoint, calendar locations, trips/ETAs, maps socket, saved routes | claude/sections-8-10-m2 | c90924b (PR #8) | Yes (9a46031) |
| Overnight: Maps widget front end (Map / Upcoming / Saved tabs, trips with leave-by, saved routes with Delete? Yes/No, safe Google Maps links, phone hand-off logic) | claude/sections-8-10-m3 | 6acc15f (PR #10) | Yes (c134f9c); not in the running app until the next rebuild |
| Overnight: Brainstorm Talk pure helpers (talk intent, digest, wrap-up walk, destinations; no bulk approve, memory by reference only) | claude/sections-8-10-m3 | 0d72190 (PR #10) | Yes (c134f9c) |
| STATUS.md + scripts/update_status.py + AGENTS.md upkeep rule | claude/status-md-tracking | 691e280 | Yes, pushed to origin |
| Kill-switch follow-ups (auto-repeat, held Enter, ack wait, bracket cancel) | claude/practical-elbakyan | 5751989 | **No**, in review |
| Sections 1-2 Comms + MCP registry | section-pass, section-pass-batch3 | f672898 | Yes (76e04da) |
| Section 3 Ops frozen | section-pass | 06e958c | Yes (76e04da) |
| Section 4 logins: survive restarts, phone approval, per-device sign-out | section-pass | 9c07592, aa6966a | Yes (76e04da) |
| 30-day Trash with Undo, E46 clock recovered | section-pass | 78e61b0 | Yes (76e04da) |
| Section 5 part: build pipeline cleanup (no Librarian, one status, archive) | section-pass | d94c6cd | Yes (76e04da) |
| Section 11 Finance (all but 11.10) | section-pass-batch3 | 5b59996 | Yes (6d1084b) |
| Sections 13 + 22 business profiles | section-pass-batch3 | 04b3201 | Yes (6d1084b) |
| Section 14.1-14.4 trading status, NYSE calendar; TWS opens at launch | section-pass-batch3 | c685250, 0a38444 | Yes (6d1084b) |
| Section 16 part: self-checking backups, hourly hygiene | section-pass-batch3 | 5a93471 | Yes (6d1084b) |
| Sections 19 + 24 power, standby, security | section-pass-batch3 | 0a59105 | Yes (6d1084b) |
| Sections 20-21 safe defaults, routing ownership | section-pass-batch3 | af2d427, 7f151c2 | Yes (6d1084b) |
| Review fixes: profiles sync safely, PIN step-up for business + finance | section-pass-batch3 | cebcdbf | Yes (6d1084b) |
| Merge fixes: Ops' contracting phrases go to Tony (Ops stays frozen); settings migrations v8-v10; TS router starts with Ops frozen | merge/section-pass-into-main | 6d1084b | Yes, pushed to origin |
| Director Part 1 (real Director, brief, shot list, intake, edit v2, review loop, hand-off UI) | director-suite | 0a315e1 to 74efc88 | Yes (76df04f) |
| Director Part 2 ComfyUI (GPU baton, templates, provenance); models downloaded | director-suite | a454ee3 | Yes (76df04f) |
| Director Part 1 quality fixes: per-clip framing, plan check before apply, one-page auto-fix, idea kept in Nic's words | director-suite | 45f715c, eeb2509, eff4f43 | Yes (76df04f) |
| Director chat system message kept byte-stable for prefix caching (STUDIO STATE moved to the last user message) | director-suite | this commit | Yes (5098ca3) |
| SDXL Turbo live test passed; harness runs with Command Center open (own crash marker) | director-suite | e0f4410, 6d3f9f5 | Yes (5098ca3) |
| Director sees timed transcript lines; clips open on the sentence; a fit-only revision no longer resolves a timing note | director-suite | 116fbb2 | Yes (5098ca3) |
| Part 3 UI: ComfyUI Generate panel, render queue, GPU pill, Re-roll/Tweak; note markers on the timeline; projects board; bin filters; Versions tab with restore and A/B Compare (contract in docs/proposals/director-suite-part3-contract.md). Phone review not built | director-suite | 202ae7c, 386203d | Yes (5098ca3) |
| A revision may move the cut only ±30% off the brief's length (run 10 halved a Reel); its summary now starts with the real length change | director-suite | see log | Yes (5098ca3) |
| Part 4: Scene Reader audition import (read-only, from a temp copy of its db; takes copied, never moved), sides drop, slate card, self-tape output. Part 5: Director reports to the inbox (brief ready, footage gaps, ComfyUI batch, review rounds) via publish_note, no voice/comms edits | director-suite | bd403c8 | Yes (5098ca3) |
| Director's LENGTH line states the plan band and, with a note open, the revision band | director-suite | 6575cc7 | Yes (5098ca3) |
| Part 6 small items: launcher presets, more versions from one cut, phone shot list, style memory (STYLE line), fill the gaps | director-suite | see log | Yes (5098ca3) |
| Length refusals name a concrete whole-line fix; live E2E retries a busy LM Studio turn once | director-suite | 74655ad, f900096 | Yes (5098ca3) |
| 11.10 Tony reads Finance (one read-only tool, finance summary endpoint) | section-pass-batch3 | 7166d26 | Yes (eefaf0a), pushed |
| Merge main (a0e730c) into director-suite, no conflicts | director-suite | 4e986f1 | Yes (with this merge) |
| Tony live-test fixes (11-27), 6 of 7: Gmail reads/searches Primary only (`category:primary in:inbox`) unless you name a tab; saved in Settings → Comms (new tab, default Primary only); each email line names sender, subject and inbox; prompt rule: never claim a read with no tool run; Gmail tab names in the Whisper hint list (one-time migration moves an unedited old default); internal labels like "Spoken reply" stripped before TTS; to-do adds ask "Add “…”?" with your exact words and save only on yes | claude/tony-live-test-fixes-5d85d5 | 1318759 | Yes (9d37071), pushed to origin; in the 0418649 rebuild the parroting session is restarting |
| Tony live-test fix 6, barge-in (you said build it): "hold on" is a hard stop like "stop" (start of a line only; "hold on a sec" too; a passive room listen still needs the wake word); talking over Tony while he's audible stops him at speech onset and drops the rest of the reply (never resumed or repeated; the bubble keeps what was written). Over a turn still thinking, he only ducks, as before | claude/tony-live-test-fixes-5d85d5 | e802ad3 | Yes (9d37071), pushed to origin; in the 0418649 rebuild the parroting session is restarting |
| Ops agent removed: its infra topics and Maps are Tony's, quotes / estimates stay Tony's (your call 11-26), frozen-Ops placeholder gone; one-time `ops-removed` os.json migration (backup first; dry run on the live 23:40 os.json: 5 sections change, roster 8) | claude/elated-kare-67e4c4 | 90ac158 | Yes (9c57359), not pushed; live since the 00:31 restart, os.json migrated (backup `os.json.bak-20261127-003126-ops-removed`) |
| Tony's read-only `system.status` tool: droplet (over NetBird), gateway, Bionic, STT, Kokoro, Docker, n8n, up/down + latency; status questions run it with no router call (phone turns included); never starts or changes anything | claude/unruffled-mayer-1247f9 | 6eae983 | Yes (87b6527), not pushed; built into the usual exe 10:22, not running yet (see Waiting on you) |

## 2. In progress

| Session | Working on | Current step |
|---|---|---|
| Tony live-test fixes | All 7 fixes | Merged into main (9d37071). The "Stop Tony parroting" session is rebuilding from main 0418649 and restarting the app; it will check Tony afterwards. Pushed to origin |
| Gabagoul functional pass (section-pass) | Section 5 Staging hub | Committed work is in main. Next: merge main into section-pass before more commits |
| Gabagoul functional pass (section-pass-batch3) | Section 12 Phone book | 11.10 done and in main |
| Director suite build | Merged into main (5098ca3) and pushed to origin | Next: your decisions in section 3 (voice, phone review, Scene Reader, face check, Part 6/7 go-ahead) |
| Communications page and brainstorming | Sections 8-10 overnight (branch claude/sections-8-10-m3) | Merged to main as PR #10 (c134f9c). Done: Maps 3, 9, 10, 11 (pure part); Brainstorm 8. The rest is parked (see Waiting on you) |
| Stop the UI burning GPU | Reviewing 5751989 | Then merge to main, push main, rebuild + restart app |
| Make run_all.py run every trading test | Trading test gate | Finding why the gate takes 9 min (550 s). Uncommitted |
| Tony's droplet status tool (claude/unruffled-mayer-1247f9) | `system.status` in main (87b6527), tested | Built from main 87b6527 into the usual exe (10:22). Restart + live phone check wait on you: another session's build is running |

## 3. Waiting on you
- Director length hint may suggest moving a clip's START earlier (run 14 had no out point free, so it suggested opening clip 1 on the line before). Keep, or out points only?
- Director picks moments from the transcript alone, so a cut can miss Nic's face (run 15 was one acted scene under narration). Want a face/person check in media-forge (local, CPU) feeding the context?
- Director Part 6 larger items need your call before building: talk-to-edit (new incremental actions), three speeds incl. Full AI, storyboard first, performance-aware comping (needs Scene Reader data), NetBird private link (gateway), Instagram posting (hosting), tool pill (agents.rs). Part 7 boosters not started.
- Director voice (Part 5): pick an ElevenLabs voice for the Director (agentVoices.director); voice settings are shared core, so not set.
- Scene Reader link (Part 4): its app has no HTTP endpoint; the card shows when Studio TTS (:5123) answers. Import reads %APPDATA%\com.scenereader.dev (copy only). OK, or want a real export endpoint in Scene Reader (its repo)?
- Director Part 3 contract questions (defaults picked, change any): (1) ComfyUI policy select sits on the Queue card and applies to every project; (2) Re-roll of a style-transfer whose job was pruned from the queue is disabled; (3) Restore is offered only from the Versions tab.
- Director Part 3 phone review needs a gateway (server.py) /api/media proxy behind the security gate: shared core, so not built. OK to build it?

**Decisions**
- Tony live-test fixes (all 7, merged into main 11-27 on your go). Choices I made overnight (safest option each time):
  - Barge-in (fix 6) is built (your go, 11-27). Trade-off to watch on speakers: a cough, or Tony's own voice leaking into the mic, now cuts him off too. The barge-in listen's stricter trigger is unchanged. A hold ("whoa") over his voice now holds your thought, but there's no paused reply left to resume.
  - The booking-mail scan keeps its own query from your instruction file (it already excludes Promotions and Social); only reads and searches got the Primary scope.
  - To-dos had no store, so a confirmed to-do goes to the Ideas & Tasks ledger (Play Place) as a parked item tagged `todo`. Parked items start nothing. In Learning mode a to-do line still goes to Tony's model (Learning skips local intents).
  - The to-do prompt rule rides only on a turn that mentions a to-do, because Tony's system prompt is at its 3,500-char budget. I didn't raise the budget.
  - "Promotions" in the Whisper hints: added as "Inbox: Primary tab, Promotions tab, Social tab, Updates tab, Forums tab." The paired "X tab" wording keeps a spoken list of tab names from being dropped as a prompt echo. The hint cap went from 220 to 280 chars. The live faster-whisper entry still holds the old default, so a one-time migration swaps it on the next app start. An edited prompt is kept.
  - A Gmail query that names another mailbox (`in:sent`, `in:drafts`, `label:Clients`…) runs as given, not Primary-scoped. "My primary inbox" wins over a saved "All inboxes".
  - After a spoken local reply (to-do question, timer, reminder), the normal follow-up listen now opens, so a plain "yes" answers the to-do without the wake word. It's the same as every other spoken reply.
  - A 4-agent review plus a skeptic pass found 9 real issues in my first cut. All are fixed and tested.
- Sections 8-10: after the next app rebuild, look at the Maps widget Upcoming and Saved tabs (not yet checked in a running app).
- Sections 8-10 contract `features/maps/contract.ts` is a DRAFT: approve to lock it.
- Sections 8-10 parked because they touch safety controls (your call): confirmation-card options (Brainstorm 9, `gate.ts` / ConfirmCard) and the auto-dispatch taint rule (Comms 4, `tony_dispatch.rs`).
- Sections 8-10 parked because another session owns the code: Comms screens (Comms 9; the phone-book session is in CommsSection) and the Director Ideas board (Brainstorm 14, Director page).
- Sections 8-10 parked for the app or the phone: wire the Maps hand-off listener into `App.tsx`; add `maps_trips` + trip-words to `platform.ts` NativeCommands; Android work (Comms 6-8, Maps 4 + 12, Brainstorm 12, one APK); voice Talk (Brainstorm 2, 3, 7, 10, 11, 13).
- Sections 8-10 overnight defaults I picked (safest each time): phone and narrow widgets open on Upcoming, the PC on Map; location only on a tap of "Use my location" (desktop); hand-offs refused unless every link is an https Google Maps link, and the opened link is rebuilt from coordinates; hand-off TTL 30 min (2 min clock skew); trips and seen hand-offs kept in memory only (addresses); refresh 5 min desktop / 2 min gateway / 10 min after an error; wrap phrases count only as a whole line; in Talk only cut / hold / "Tony, end talk" act; memory items only from Nic's lines and only by reference; "later" in the walk leaves an item pending; talk digest never labels Tony's words as Nic's.
- Ops removal: the AnythingLLM `ops` workspace (0 threads) is left in place, unmapped. Delete it in AnythingLLM?
- Which build should run? Since 09:52 the app runs section-pass's unmerged branch build (`F:\claude-scratch\section-pass-target`), started by another session. The usual exe was rebuilt at 10:22 from main 87b6527 (PR #10 + system.status), but main has 30 newer commits since (Tony live-test fixes incl. barge-in, Director Parts 1-5). Rebuild from current main and restart once section-pass is done testing?
- Check in the running app (00:31 build): pair a phone by QR then approve with the 2-digit code; phone captions with Live captions on; a wrong-token phone gets 401 and an unknown-device alert.
- Security card now limits idle lock to 5-120 min and re-verify to 30-720 min.
- Tony's Tier-1 memory holds dozens of copies of the six latency-test lines. They're harmless now, but prune them?
- `hermes-output-cleanup` (15f2ceb, Nov 18): rebase and merge, or drop?
- Approve the run_all.py commit once the 9-min answer is in.
- OK to run the WhatsApp bridge port patch script.
- Director: Instagram public hosting approach; ElevenLabs voice for the Director (later).
- Is `D:\Art Apps\agentic os\brain` still real? The old D: copy looks stale.

**Manual steps**
- Ops removal: done live. The Ops lines are out of handoff-cues.json and the STT hint (backups `*.20261126-231018-before-ops-removal`), and os.json was migrated at the 00:31 restart (backup `os.json.bak-20261127-003126-ops-removed`).
- Phone: connect it to install the APK (built from 4073bd9). Later rebuild with camera permission for QR pairing.
- S22: turn off RCS "Chat features"; set up a device session on the S22 and the PC.
- TWS: log in by hand after each reboot and at IBKR's weekly re-login. Keep "Read-Only API" unticked.
- Director/ComfyUI: copy the SDXL Turbo checkpoint (6.5 GB) from D: (HDD) to an SSD folder? Its read from D: is most of the 80 s render; on SSD a still should take seconds. Parked: moving model files is your call.
- Restart the gateway (new Finance records won't save until then). Bionic runs elevated, so only you can quit it.
- Queue the E46 rebuild in Play Place (steps in `docs/e46-clock-spec-note.md`).
- Before the next "Sync to AnythingLLM": grant the MCP servers you use directly, or it turns their auto-start off.

**Keys, accounts, settings**
- Renew Instagram token. Create n8n API key. Meta business verification (for 8.3). Firebase only if you want phone push.
- Real HST number, home address, vault password (print the recovery copy), "Finish setup" on the Acting business card.

## 4. Not started

**Section-by-Section Pass**
- 5 rest: builder checklist, fortune-cookie test, style kit, Play Place redesign
- 6 Home + widget edit mode
- 7 Phone quick access to Tony (needs Android build)
- 8: native Android bridge, notification capture, tabs UI, official Meta API, taint/injection guards
- 9: Talk-it-through mode, send-to after wrap-up, one-tap mode switch, E46 clock build
- 10.4 Maps: phone "Open in Maps" (Android NavPlugin), hand-off listener wiring, location permission (widget UI done overnight, local branch)
- 11.10 Tony reads Finance
- 12 Phone book
- 14.5-14.9 Trading (needs IBKR connected)
- 15 Language
- 16.2, 16.3, 16.6: off-machine copy, vault password, vault search
- 17 Wallpapers, 18 Flowchart/Blueprint/Orbital, 23 Appearance (held until Section 6)
- S20.10 instant-cue fast path

Several were held for the latency work, which is now in main: 15, 16.6, 11.10, S20.10, and the Tony-Rust parts of 8 and 9.

**Director Suite**
- 1.6 public hosting for Instagram
- B-roll template (no video model yet)
- Part 3: Projects board, Generate panel and render queue, Versions with A/B compare, phone review
- Part 4 Scene Reader link
- Part 5 Voice/comms
- Part 6 Studio features (tool pill and darker panels already done)
- Part 7 Creative boosters

**Scene Reader** (`C:\Scene-Reader\docs\roadmap.md`, idle since 11-22)
- Reader: speed, pauses, per-character voices, better prep
- Voiceover: record takes, sync to script, save/reuse
- Sound design: ambient soundscapes
- Improv: environment sound triggers, local LLM partner
- Models plan
- Note: the "+ Beat" control from 11-22 doesn't appear as its own commit. Check that it landed.

## 5. Test results

| Suite | Latest | Where / when |
|---|---|---|
| claude/tony-live-test-fixes-5d85d5 (+ barge-in) | tsc clean; vitest 2,931/2,931; cargo 1,624 (+2 known CRLF: allm, buildhub; 2 Edge browser tests timed out under load, pass alone); pytest not re-run (no Python changed since the 1,733 run below) | 11-27 02:50 |
| claude/tony-live-test-fixes-5d85d5 (Tony live-test fixes) | tsc clean; vitest 2,925/2,925; cargo 1,625 (+2 known CRLF: allm, buildhub; 1 Edge browser test timed out under load, passes alone); pytest 1,733 (embed flake + 1 socket abort under load, both pass alone; language hub 41/41 after the last prompt change). Not checked in the running app (no rebuild) | 11-27 02:20 |
| claude/unruffled-mayer-1247f9 (system.status, on main 77993c2) | tsc clean; vitest 2,906/2,906; cargo 1,634 (+2 known CRLF; browser tests passed). Rerun 01:25 before the STATUS commit: the same, but 1 Edge test timed out under load and passed alone. Real report on this PC: 8/8 up, droplet 59 ms, whole check 0.5 s. Bionic, real phone-turn messages: "is the droplet up?" 3/3 right; doctored droplet-down 5/5 right, no fix offers or dispatches (without the answer note: 2/3 offered a restart, 1 dispatched a Coder ssh restart) | 11-27 01:05 |
| main 87b6527 (PR #10 + system.status) | tsc clean; vitest 3,021/3,021; cargo 1,628 (+2 known CRLF; 6 Edge tests timed out under load, all 67 quality tests pass alone) | 11-27 10:05 |
| main after section-pass + batch3 merge | tsc clean; vitest 2,697/2,697; cargo 1,462 (+2 known CRLF; browser tests pass unloaded); pytest 1,566 (embed flake passes alone); cc-app-restart 18/18 | 11-26 23:15 |
| main (35e30e5) | cargo 1,410 (+2 known CRLF), vitest 2,475, pytest 1,473 (+1 flake) | 11-26 |
| feat/language-hub (1cd5333) | cargo 1,414 (+2 known CRLF); PowerShell cc-app-restart 18/18, ai-startup 6 + 11 + 20 + 7 | 11-26 22:00 |
| claude/vibrant-davinci-742cf7 (recall fix) | cargo 1,419 (+2 known CRLF; 1 Edge timeout under load passes alone) on the 4073bd9 base; memtier + turn_context 24/24 after the rebase onto e0f7ee7 | 11-26 22:20 |
| Tony recall parrot probe (Bionic, 4 reps) | parroted 21/60 -> **0/60** (six test lines 10/24 -> 0/24); planted facts recalled 24/28 -> 28/28 | 11-26 22:10 |
| Live app after the 23:19 restart | 3 phone turns: fresh greeting and dinner answers (no stored reply copied), Joelle Bandits -> Chris recalled; first words 4.5 s cold, then 1.6 s and 1.0 s | 11-26 23:21 |
| Live app after the 23:40 restart (main 0c4341f) | Up, no panic.log lines; 2 phone turns answered by the desktop: live weather (not the stored reply), Chris recalled; first words 3.4 s cold, then 0.8 s | 11-26 23:42 |
| Live app after the 00:31 restart (main dffdb71) | Up, no panic.log lines; Ops migration ran (0 `"ops"` entries left); 2 phone turns answered by the desktop. "Is the droplet up?" now goes to Tony but gets a vague reply, since a phone turn has no live dashboard. First words 3.4 s cold, then 0.6 s | 11-27 00:33 |
| section-pass | Rust 1,433, vitest 2,499, gateway pytest pass | 11-27 02:09 UTC |
| section-pass-batch3 | Python 756 pass | 11-27 00:44 UTC |
| claude/elated-kare-67e4c4 (Ops removal, on e46d0c7; main since changed STATUS.md only) | tsc clean; vitest 2,887/2,887; cargo 1,596 (+2 known CRLF; browser tests passed); pytest language hub + memory scrolls + gateway + fw_server 253/253 | 11-26 23:45 |
| main 9c57359 (Ops removal + PR #8 + director-suite) | tsc clean; vitest 2,906/2,906; cargo 1,621 (+2 known CRLF; 3 Edge tests timed out under load, pass alone) | 11-27 00:30 |
| main after director-suite + finance merge | tsc clean; vitest 2,887/2,887; cargo 1,595 (+2 known CRLF); pytest 1,568 (embed flake); media-forge 115; semantic review of the merge: 0 clashes | 11-27 00:05 |
| director-suite (4e986f1, after merging main) | vitest 2,863; Rust 1,583 (+2 known CRLF; 7 browser tests flaky under load, 67/67 alone) | 11-26 23:20 |
| director-suite (116fbb2) | tsc clean; vitest 2,904/2,904; cargo 1,611 (+2 known CRLF); taskworker::quality 67/67 | 11-27 02:30 |
| director-suite merged into main (5098ca3; gate on e2411fe) | tsc clean; vitest 3,211; cargo 1,617 (+2 known CRLF; taskworker::quality 67/67 alone); Python 863 OK; media-forge 116; Playwright director 9/9. Latency probe (stress MEDIUM, running app): per-probe exec in line with earlier runs (Tony 1.39 s), wall 48 s from a queued Librarian probe | 11-27 10:30 |
| director-suite (Part 6) | tsc clean; vitest 3,052/3,052; cargo 1,637 (+2 known CRLF); Playwright director 9/9 | 11-27 04:45 |
| director-suite (6575cc7, Parts 4-5 + bands) | tsc clean; vitest 3,022/3,022; cargo 1,628 (+2 known CRLF; taskworker::quality 67/67 alone); Playwright director 7/7 | 11-27 04:10 |
| director-suite (Part 3 + revision fix) | tsc clean; vitest 3,005/3,005; cargo 1,613 (+2 known CRLF; taskworker::quality 67/67 alone); media 68; Playwright director specs 5/5 desktop | 11-27 03:30 |
| ComfyUI SDXL Turbo live test (comfy_live.rs) | PASS: 1 image, ingested with provenance; boot 77 s, render 80 s (checkpoint read from HDD), peak VRAM 10,193 MiB, Qwen reload 212 s (builds running alongside), only Tony loaded after at 32768 ctx x 2; total 6.3 min | 11-27 01:23 |
| Director live E2E run 15 | PASS 15/15 in 196 s, no auto-fixes or re-asks; idea verbatim; round 1 15.8 s, round 2 11.8 s (inside the revision band, summary states the real length change); captions whole sentences; -14.2 LUFS. Weak spot: the cut is ONE 15.8 s clip (an acted period scene under narration), the Director picks by transcript only and can't see faces | 11-27 05:55 |
| Director live E2E runs 13-14 | 13: LM Studio turn timeout (replayed fine in 15 s, busy server). 14: six revisions at 9 / 8.4 s vs 10.5-19.5 s, led to the length hint | 11-27 05:00 |
| Director live E2E run 12 | INCONCLUSIVE: stopped at step 3c when an LM Studio turn hit the 120 s cap (builds were loading the CPU; LM Studio stayed up, Tony at production settings). Length bands not yet tested live; re-run when the machine is quiet | 11-27 04:10 |
| Director live E2E run 11 | FAIL at step 5b (12/13 steps): the new ±30% revision guard refused 6 revisions (22.7, 19.6, 28.1, 3.9, 25.7, 3.9 s vs 10.5–19.5 s); Qwen never landed in the band. Next: show the band in the Director's LENGTH line before it revises | 11-27 03:45 |
| Director live E2E run 10 | 15/15 steps. Captions now whole sentences; idea verbatim; round 1 14.0 s. FAIL: the round-2 revision cut it to 7.4 s (revisions only warn on length) and its summary claimed it was extended. 4 auto-fixes + 3 re-asks to hit length (Qwen arithmetic) | 11-27 02:15 |
| Director live E2E | run 9: 15/15 steps, 13.8 s Reel, frame filled, idea verbatim; audit 9/12 pass. Open: fit-only revision resolved a timing note | 11-26 22:40 |
| sections-8-10 m3 overnight (0d72190) | pytest 1,735; vitest 3,021 (211 files; 132 new maps + brainstorm tests); tsc clean; cargo 1,612 (+2 known CRLF in allm/buildhub, not mine, left alone). Not checked by eye: no dev server allowed overnight, MapLibre needs WebGL | 11-27 02:00 |
| sections-8-10 m2 after main merge | pytest 1,721 (comms lock flake fixed in IsolatedCC), vitest 2,716, tsc clean, cargo all but 2 known CRLF | 11-27 00:05 |
| sections-8-10 m1 | vitest 2,563, Rust 50/50, Python comms 10/10 | 11-26 20:13 |
| Trading (5751989) | run_all 766 OK; vitest trading 340/340; engines 39/39 | 11-26 |
| Playwright | not run (`@playwright/test` not installed in one worktree) | |
| Stress (Heavy probe) | Tony 13.8 s, 35.9 tok/s; VRAM peak 74.6%, no spill | 11-25 21:51 |

**Tony, time to first word (11-26)**
- Phone, desktop answering: **1.33 s** median (was 2.7 s); done 2.17 s
- Phone, app closed, gateway answers: 0.66-1.29 s
- Gateway warm: 0.48-0.93 s
- Phone speech-to-text (faster-whisper): 0.33-0.59 s
- 4073bd9 build (main): **1.14 s** median first words, done 2.13 s (6 phone turns, 21:22)

## Branches

<!-- AUTO:BRANCHES (scripts/update_status.py rewrites this block) -->
_Refreshed 2026-11-27 10:39 by `python scripts/update_status.py`._

**Not merged into main yet**

| Branch | Commits ahead | Last commit | Uncommitted |
|---|---|---|---|
| `section-26-engine` | 14 | `1569272` 2026-11-27 docs(engine): Section 26 handoff, CPU smoke test, item 15 + vision ... | clean |
| `claude/practical-elbakyan-0f96f1` | 13 | `8c3b02a` 2026-11-27 docs(status): kill switch round 4 fixed (5a55ebc), tests, what's left | no worktree |
| `section-pass` | 22 | `96829e3` 2026-11-27 fix(section-pass): click probes work on SVG shapes | 2 files |
| `section-pass-batch3` | 9 | `4ca35ee` 2026-11-27 Merge main (9d37071: Tony live-test fixes, barge-in) into section-p... | 71 files |
| `claude/upbeat-wing-e87be0` | 11 | `5ca67c0` 2026-11-27 Merge main (196b2f8: Sections 8-10 PR #10) into claude/upbeat-wing-... | no worktree |
| `claude/gifted-pascal-abdde6` | 1 | `6da6551` 2026-11-27 docs(status): kill-switch review round 4, merge parked overnight | clean |
| `claude/status-md-tracking-472ac5` | 1 | `6ee8587` 2026-11-27 docs(status): 11.10 and section 12 done, Director and Ops pushes re... | no worktree |
| `feat/ibkr-paper-trading` | 1 | `46778f9` 2026-11-24 fix(trading): fixes from the live paper rehearsal; 3-press kill switch | no worktree |
| `hermes-output-cleanup` | 1 | `15f2ceb` 2026-11-18 fix: parse Hermes v0.23 chat replies and strip ANSI colour codes | no worktree |

**Latest on main**

- `e547863` 2026-11-27 docs(status): Tony live-test fixes merged into main (9d37071); restart handed to the parroting session's 0418649 build
- `e6260c0` 2026-11-27 docs(status): director-suite pushed to origin
- `0418649` 2026-11-27 docs(status): system.status in main and built; which build runs waits on Nic
- `0b336c7` 2026-11-27 docs(status): director-suite merged into main (5098ca3)
- `5098ca3` 2026-11-27 Merge director-suite into main: Director Suite Parts 1-5 and Part 6 small items
- `9d37071` 2026-11-27 Merge main (87b6527: Tony's read-only system.status tool) into claude/tony-live-test-fixes-5d85d5
<!-- /AUTO:BRANCHES -->
