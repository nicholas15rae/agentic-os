# STATUS

Updated 2026-11-26 23:20. One page for every Claude Code session and branch.
**Rule for every session:** after each commit or merge, update the sections below and run `python scripts/update_status.py` (refreshes the branch table at the bottom).

## 1. Done

| What | Branch | Commit | In main? |
|---|---|---|---|
| Tony latency: byte-stable system msg, TURN CONTEXT block | feat/language-hub | 35e30e5 | Yes (4073bd9) |
| App crash hardening: panic.log, restarts wait for WebView2 to exit, scripts\restart-desktop-app.ps1 | feat/language-hub | 1cd5333 | Yes (4bc4e2d), pushed to origin; live since the 22:26 restart |
| Engine R stops reporting refused orders as trades | claude/practical-elbakyan | 8bd7990 | Yes (3fe4835) |
| Tony stops parroting old replies from recall (skips the re-asked turn, stopwords, no mid-list replies) | claude/vibrant-davinci-742cf7 | fa69ab2 | Yes (8278f76), pushed to origin; live after the next app rebuild + restart |
| Gateway: launcher refusal shown as "unsafe" | main | ae86c7b | Yes |
| Command Center GPU idle fix (hidden window 25-33% to 0%) | claude/gifted-pascal | 44856ca | Yes (5ee2580) |
| Sections 8-10 milestone 1: trust fix, live weather, top-bar clock, effects popover, findable Maps | claude/sections-8-10-m1 | 2a2a040 (PR #7) | Yes (bcd8c35) |
| STATUS.md + scripts/update_status.py + AGENTS.md upkeep rule | claude/status-md-tracking | 691e280 | Yes, pushed to origin |
| Kill-switch follow-ups (auto-repeat, held Enter, ack wait, bracket cancel) | claude/practical-elbakyan | 5751989 | **No**, in review |
| Test gate: run_all.py finds every test module itself and runs them in parallel (550 s -> 80-145 s), solo rerun for load flakes | claude/upbeat-wing-e87be0 | b1abe56 | No, PR open |
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
| Director Part 1 (real Director, brief, shot list, intake, edit v2, review loop, hand-off UI) | director-suite | 0a315e1 to 74efc88 | No |
| Director Part 2 ComfyUI (GPU baton, templates, provenance); models downloaded | director-suite | a454ee3 | No |

## 2. In progress

| Session | Working on | Current step |
|---|---|---|
| Gabagoul functional pass (section-pass) | Section 5 Staging hub | Committed work is in main. Next: merge main into section-pass before more commits |
| Gabagoul functional pass (section-pass-batch3) | Next: 11.10 Tony reads Finance, Section 12 | All committed work is in main (conflicts resolved there). Next: merge main into the branch |
| Director suite build | Part 1 quality fixes (clip length, framing, no-op revisions) | Reviewers running. Next: live E2E rerun, merge main, live SDXL test. Uncommitted |
| Communications page and brainstorming | Sections 8-10 milestone 2 | Building brainstorm wrap-up endpoint. Maps/trips/calendar/WhatsApp ingest done but uncommitted. Then merge main, tests, PR |
| Stop the UI burning GPU | Reviewing 5751989 | Then merge to main, push main, rebuild + restart app |
| Remove the duplicate Ops agent | Reroute Ops (incl. job desk quotes) to Tony and the Business pipeline | Started 11-26 22:15. Lists what Ops does that nothing else covers, asks you before deleting |

## 3. Waiting on you

**Decisions**
- OK to merge `director-suite` into main? (section-pass and batch3 are merged.)
- Check after the next app rebuild: pair a phone by QR then approve with the 2-digit code; phone captions with Live captions on; a wrong-token phone gets 401 and an unknown-device alert.
- Security card now limits idle lock to 5-120 min and re-verify to 30-720 min.
- Tony's Tier-1 memory holds dozens of copies of the six latency-test lines. They're harmless now, but prune them?
- `hermes-output-cleanup` (15f2ceb, Nov 18): rebase and merge, or drop?
- Test gate (`claude/upbeat-wing-e87be0`): review and merge its PR.
- OK to run the WhatsApp bridge port patch script.
- Director: Instagram public hosting approach; ElevenLabs voice for the Director (later).
- Is `D:\Art Apps\agentic os\brain` still real? The old D: copy looks stale.

**Manual steps**
- Phone: connect it to install the APK (built from 4073bd9). Later rebuild with camera permission for QR pairing.
- S22: turn off RCS "Chat features"; set up a device session on the S22 and the PC.
- TWS: log in by hand after each reboot and at IBKR's weekly re-login. Keep "Read-Only API" unticked.
- Keep Tony quiet for ~3 min when the Director runs the live SDXL test (it will message first).
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
- Part 2 live SDXL Turbo test; B-roll template (no video model yet)
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
| section-pass | Rust 1,433, vitest 2,499, gateway pytest pass | 11-27 02:09 UTC |
| section-pass-batch3 | Python 756 pass | 11-27 00:44 UTC |
| director-suite | vitest 2,595, Rust 1,445 + 67 browser, media-forge 116 | 11-26 20:47 |
| Director live E2E | 15/15 steps (run 5, 388 s), but output quality failed (9.6 s cut, double letterbox, round 2 unchanged) | 11-26 19:43 |
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
_Refreshed 2026-11-26 22:46 by `python scripts/update_status.py`._

**Not merged into main yet**

| Branch | Commits ahead | Last commit | Uncommitted |
|---|---|---|---|
| `claude/upbeat-wing-e87be0` | 2 | `3fdea38` 2026-11-26 docs(status): test gate 28c60f3 (every module, parallel), its test ... | clean |
| `merge/section-pass-into-main` | 21 | `37ba367` 2026-11-26 Merge branch 'main' into merge/section-pass-into-main | 1 files |
| `section-pass` | 10 | `76eb094` 2026-11-26 docs(section-pass): everything-is-customizable rule + shared layout... | clean |
| `claude/sections-8-10-m2` | 4 | `004c129` 2026-11-26 Merge remote-tracking branch 'origin/main' into claude/sections-8-1... | clean |
| `section-pass-batch3` | 15 | `e0419ee` 2026-11-26 Merge main (recall fix fa69ab2) into section-pass-batch3 | 69 files |
| `claude/practical-elbakyan-0f96f1` | 4 | `0330e8f` 2026-11-26 fix(trading): trim a stopless partial fill; scan table shows desk-r... | 12 files |
| `director-suite` | 14 | `edcbeff` 2026-11-26 perf(director): voiceover level meter on frameLoop (GPU budget rule) | 18 files |
| `feat/ibkr-paper-trading` | 1 | `46778f9` 2026-11-24 fix(trading): fixes from the live paper rehearsal; 3-press kill switch | no worktree |
| `hermes-output-cleanup` | 1 | `15f2ceb` 2026-11-18 fix: parse Hermes v0.23 chat replies and strip ANSI colour codes | no worktree |

**Latest on main**

- `66df342` 2026-11-26 docs(status): main pushed to origin (3ee3dd6): crash hardening and recall fix
- `3ee3dd6` 2026-11-26 docs(status): record the recall fix merge into main (8278f76)
- `8278f76` 2026-11-26 Merge fa69ab2: Tony recall stops parroting old replies
- `e0f7ee7` 2026-11-26 docs(status): crash hardening 1cd5333, 4073bd9 timing, sessions
- `4bc4e2d` 2026-11-26 Merge main (STATUS.md + update_status.py) into feat/language-hub
- `1cd5333` 2026-11-26 fix(command-center): log panics to a file, never start the app over a dying WebView2
<!-- /AUTO:BRANCHES -->
