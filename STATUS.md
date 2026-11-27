# STATUS

Updated 2026-11-27 00:10. One page for every Claude Code session and branch.
**Rule for every session:** after each commit or merge, update the sections below and run `python scripts/update_status.py` (refreshes the branch table at the bottom).

## 1. Done

| What | Branch | Commit | In main? |
|---|---|---|---|
| Tony latency: byte-stable system msg, TURN CONTEXT block | feat/language-hub | 35e30e5 | Yes (4073bd9) |
| App crash hardening: panic.log, restarts wait for WebView2 to exit, scripts\restart-desktop-app.ps1 | feat/language-hub | 1cd5333 | Yes (4bc4e2d), pushed to origin; live since the 22:26 restart |
| Engine R stops reporting refused orders as trades | claude/practical-elbakyan | 8bd7990 | Yes (3fe4835) |
| Tony stops parroting old replies from recall (skips the re-asked turn, stopwords, no mid-list replies) | claude/vibrant-davinci-742cf7 | fa69ab2 | Yes (8278f76), pushed to origin; live since the 23:19 rebuild + restart (built from 66df342, so without the section-pass merges) |
| Gateway: launcher refusal shown as "unsafe" | main | ae86c7b | Yes |
| Command Center GPU idle fix (hidden window 25-33% to 0%) | claude/gifted-pascal | 44856ca | Yes (5ee2580) |
| Sections 8-10 milestone 1: trust fix, live weather, top-bar clock, effects popover, findable Maps | claude/sections-8-10-m1 | 2a2a040 (PR #7) | Yes (bcd8c35) |
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
| Director chat system message kept byte-stable for prefix caching (STUDIO STATE moved to the last user message) | director-suite | this commit | No |
| SDXL Turbo live test passed; harness runs with Command Center open (own crash marker) | director-suite | e0f4410, 6d3f9f5 | No |
| Director sees timed transcript lines; clips open on the sentence; a fit-only revision no longer resolves a timing note | director-suite | 116fbb2 | No |
| Part 3 UI: ComfyUI Generate panel, render queue, GPU pill, Re-roll/Tweak; note markers on the timeline; projects board; bin filters; Versions tab with restore and A/B Compare (contract in docs/proposals/director-suite-part3-contract.md). Phone review not built | director-suite | 202ae7c, 386203d | No |
| A revision may move the cut only ±30% off the brief's length (run 10 halved a Reel); its summary now starts with the real length change | director-suite | see log | No |
| 11.10 Tony reads Finance (one read-only tool, finance summary endpoint) | section-pass-batch3 | 7166d26 | Yes (eefaf0a), pushed |
| Merge main (a0e730c) into director-suite, no conflicts | director-suite | 4e986f1 | Yes (with this merge) |

## 2. In progress

| Session | Working on | Current step |
|---|---|---|
| Gabagoul functional pass (section-pass) | Section 5 Staging hub | Committed work is in main. Next: merge main into section-pass before more commits |
| Gabagoul functional pass (section-pass-batch3) | Section 12 Phone book | 11.10 done and in main |
| Director suite build | OVERNIGHT AUTOPILOT: Part 3 UI landed (386203d) and the revision length fix. Next: live E2E run 11, then Parts 4-5 planning | Clean |
| Communications page and brainstorming | Sections 8-10 milestone 2 | Building brainstorm wrap-up endpoint. Maps/trips/calendar/WhatsApp ingest done but uncommitted. Then merge main, tests, PR |
| Stop the UI burning GPU | Reviewing 5751989 | Then merge to main, push main, rebuild + restart app |
| Remove the duplicate Ops agent | Reroute Ops (incl. job desk quotes) to Tony and the Business pipeline | Started 11-26 22:15. Lists what Ops does that nothing else covers, asks you before deleting |
| Make run_all.py run every trading test | Trading test gate | Finding why the gate takes 9 min (550 s). Uncommitted |

## 3. Waiting on you
- Director Part 3 contract questions (defaults picked, change any): (1) ComfyUI policy select sits on the Queue card and applies to every project; (2) Re-roll of a style-transfer whose job was pruned from the queue is disabled; (3) Restore is offered only from the Versions tab.
- Director Part 3 phone review needs a gateway (server.py) /api/media proxy behind the security gate: shared core, so not built. OK to build it?

**Decisions**
- The running app (23:19) is built from 66df342: recall fix and crash hardening, but not main's 26 newer commits (section-pass, batch3). Rebuild from main? `feat/language-hub` in the base checkout would need main merged in first.
- Check after the next app rebuild: pair a phone by QR then approve with the 2-digit code; phone captions with Live captions on; a wrong-token phone gets 401 and an unknown-device alert.
- Security card now limits idle lock to 5-120 min and re-verify to 30-720 min.
- Tony's Tier-1 memory holds dozens of copies of the six latency-test lines. They're harmless now, but prune them?
- `hermes-output-cleanup` (15f2ceb, Nov 18): rebase and merge, or drop?
- Approve the run_all.py commit once the 9-min answer is in.
- OK to run the WhatsApp bridge port patch script.
- Director: Instagram public hosting approach; ElevenLabs voice for the Director (later).
- Is `D:\Art Apps\agentic os\brain` still real? The old D: copy looks stale.

**Manual steps**
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
- 10.4 Maps: saved routes, phone "Open in Maps", widget UI and phone hand-off
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
| main after section-pass + batch3 merge | tsc clean; vitest 2,697/2,697; cargo 1,462 (+2 known CRLF; browser tests pass unloaded); pytest 1,566 (embed flake passes alone); cc-app-restart 18/18 | 11-26 23:15 |
| main (35e30e5) | cargo 1,410 (+2 known CRLF), vitest 2,475, pytest 1,473 (+1 flake) | 11-26 |
| feat/language-hub (1cd5333) | cargo 1,414 (+2 known CRLF); PowerShell cc-app-restart 18/18, ai-startup 6 + 11 + 20 + 7 | 11-26 22:00 |
| claude/vibrant-davinci-742cf7 (recall fix) | cargo 1,419 (+2 known CRLF; 1 Edge timeout under load passes alone) on the 4073bd9 base; memtier + turn_context 24/24 after the rebase onto e0f7ee7 | 11-26 22:20 |
| Tony recall parrot probe (Bionic, 4 reps) | parroted 21/60 -> **0/60** (six test lines 10/24 -> 0/24); planted facts recalled 24/28 -> 28/28 | 11-26 22:10 |
| Live app after the 23:19 restart | 3 phone turns: fresh greeting and dinner answers (no stored reply copied), Joelle Bandits -> Chris recalled; first words 4.5 s cold, then 1.6 s and 1.0 s | 11-26 23:21 |
| section-pass | Rust 1,433, vitest 2,499, gateway pytest pass | 11-27 02:09 UTC |
| section-pass-batch3 | Python 756 pass | 11-27 00:44 UTC |
| main after director-suite + finance merge | tsc clean; vitest 2,887/2,887; cargo 1,595 (+2 known CRLF); pytest 1,568 (embed flake); media-forge 115; semantic review of the merge: 0 clashes | 11-27 00:05 |
| director-suite (4e986f1, after merging main) | vitest 2,863; Rust 1,583 (+2 known CRLF; 7 browser tests flaky under load, 67/67 alone) | 11-26 23:20 |
| director-suite (116fbb2) | tsc clean; vitest 2,904/2,904; cargo 1,611 (+2 known CRLF); taskworker::quality 67/67 | 11-27 02:30 |
| director-suite (Part 3 + revision fix) | tsc clean; vitest 3,005/3,005; cargo 1,613 (+2 known CRLF; taskworker::quality 67/67 alone); media 68; Playwright director specs 5/5 desktop | 11-27 03:30 |
| ComfyUI SDXL Turbo live test (comfy_live.rs) | PASS: 1 image, ingested with provenance; boot 77 s, render 80 s (checkpoint read from HDD), peak VRAM 10,193 MiB, Qwen reload 212 s (builds running alongside), only Tony loaded after at 32768 ctx x 2; total 6.3 min | 11-27 01:23 |
| Director live E2E run 10 | 15/15 steps. Captions now whole sentences; idea verbatim; round 1 14.0 s. FAIL: the round-2 revision cut it to 7.4 s (revisions only warn on length) and its summary claimed it was extended. 4 auto-fixes + 3 re-asks to hit length (Qwen arithmetic) | 11-27 02:15 |
| Director live E2E | run 9: 15/15 steps, 13.8 s Reel, frame filled, idea verbatim; audit 9/12 pass. Open: fit-only revision resolved a timing note | 11-26 22:40 |
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
_Refreshed 2026-11-27 03:20 by `python scripts/update_status.py`._

**Not merged into main yet**

| Branch | Commits ahead | Last commit | Uncommitted |
|---|---|---|---|
| `director-suite` | 9 | `386203d` 2026-11-27 feat(director): Part 3 UI: ComfyUI Generate panel, render queue, GP... | 4 files |
| `section-pass-batch3` | 6 | `5c9d089` 2026-11-27 docs(status): overnight batch on section-pass-batch3 (15, 14.6-14.7... | clean |
| `claude/tony-live-test-fixes-5d85d5` | 2 | `2ff21d9` 2026-11-27 docs(status): Tony live-test fixes landed on claude/tony-live-test-... | clean |
| `claude/sections-8-10-m3` | 3 | `14ad8bf` 2026-11-27 docs(status): Sections 8-10 overnight results, defaults chosen, par... | clean |
| `section-pass` | 21 | `74f9e0d` 2026-11-27 feat(section-pass): phone sync of layouts and themes (layout step 6) | clean |
| `claude/practical-elbakyan-0f96f1` | 11 | `a5dc7d9` 2026-11-27 docs(status): kill switch round 4 parked overnight; what landed, te... | clean |
| `claude/gifted-pascal-abdde6` | 1 | `6da6551` 2026-11-27 docs(status): kill-switch review round 4, merge parked overnight | clean |
| `claude/unruffled-mayer-1247f9` | 3 | `efca40d` 2026-11-27 docs(status): system.status In progress row, waiting on Nic (overni... | clean |
| `claude/upbeat-wing-e87be0` | 10 | `fa79cc3` 2026-11-27 docs(status): test gate PR #9 overnight state; inbox timing follow-... | clean |
| `claude/status-md-tracking-472ac5` | 1 | `6ee8587` 2026-11-27 docs(status): 11.10 and section 12 done, Director and Ops pushes re... | clean |
| `feat/ibkr-paper-trading` | 1 | `46778f9` 2026-11-24 fix(trading): fixes from the live paper rehearsal; 3-press kill switch | no worktree |
| `hermes-output-cleanup` | 1 | `15f2ceb` 2026-11-18 fix: parse Hermes v0.23 chat replies and strip ANSI colour codes | no worktree |

**Latest on main**

- `77993c2` 2026-11-27 docs(status): app rebuilt from main dffdb71, Ops migration ran at the 00:31 restart
- `dffdb71` 2026-11-27 docs(status): Ops removal merged into main (9c57359), combined main tested
- `9c57359` 2026-11-27 Merge 90ac158: remove the Ops agent; its work is Tony's
- `b68cd1b` 2026-11-27 Merge origin/main (PR #8, Sections 8-10 m2) into main
- `d69d0df` 2026-11-26 docs(status): app rebuilt from main 0c4341f and restarted 23:40
- `e46d0c7` 2026-11-26 Merge branch 'director-suite' into merge/director-suite-into-main
<!-- /AUTO:BRANCHES -->
