# STATUS

Updated 2026-11-27 01:17. One page for every Claude Code session and branch.
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
| STATUS.md + scripts/update_status.py + AGENTS.md upkeep rule | claude/status-md-tracking | 691e280 | Yes, pushed to origin |
| Kill-switch follow-ups (auto-repeat, held Enter, ack wait, bracket cancel, options guard, kill stand-down) | claude/practical-elbakyan-0f96f1 | 5751989 → e055457 → ea09c98 → 0330e8f → 5a1ce1a → 3215d66 → 6fcd6cd | **No**. 4 review rounds; round 4 left 3 confirmed MEDIUMs (see Waiting on you). Merge, push and rebuild parked overnight (rule 4: safety controls) |
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
| 11.10 Tony reads Finance (one read-only tool, finance summary endpoint) | section-pass-batch3 | 7166d26 | Yes (eefaf0a), pushed |
| Merge main (a0e730c) into director-suite, no conflicts | director-suite | 4e986f1 | Yes (with this merge) |
| Ops agent removed: its infra topics and Maps are Tony's, quotes / estimates stay Tony's (your call 11-26), frozen-Ops placeholder gone; one-time `ops-removed` os.json migration (backup first; dry run on the live 23:40 os.json: 5 sections change, roster 8) | claude/elated-kare-67e4c4 | 90ac158 | Yes (9c57359), not pushed; live since the 00:31 restart, os.json migrated (backup `os.json.bak-20261127-003126-ops-removed`) |

## 2. In progress

| Session | Working on | Current step |
|---|---|---|
| Gabagoul functional pass (section-pass) | Section 5 Staging hub | Committed work is in main. Next: merge main into section-pass before more commits |
| Gabagoul functional pass (section-pass-batch3) | Section 12 Phone book | 11.10 done and in main |
| Director suite build | Live SDXL Turbo test (ComfyUI via the GPU baton) | Part 1 fixes and committed work are in main. Next: SDXL test, then Part 3 UI; merge main into director-suite before more commits |
| Communications page and brainstorming | Sections 8-10 milestone 2 | Merged to main (9a46031). Next: Tony-Rust track (Comms 4, Brainstorm 2/4/6), then M3 |
| Stop the UI burning GPU (claude/gifted-pascal-abdde6) | Reviewing the kill-switch branch for merge into main | Round 4 of 6fcd6cd done. **Parked overnight** (rule 4: the kill switch is a safety control): no merge, push, rebuild or restart until Nic decides |
| Make run_all.py run every trading test | Trading test gate | Finding why the gate takes 9 min (550 s). Uncommitted |

## 3. Waiting on you

**Decisions**
- **Kill-switch branch** `claude/practical-elbakyan-0f96f1` (tip 6fcd6cd, not in main). The round-4 adversarial review confirmed that the queued-KILL fix works: the bridge refreshes open orders every ~6 s, so the guard can't stay off after a kill. It also confirmed 3 MEDIUMs, none fixed overnight (rule 4):
  1. The expiry guard treats any other client's resting order as cover. A manual TWS "buy back the short for 0.05" order makes it skip the short leg but still sell the long, leaving a naked short into expiry with nothing reported.
  2. If a kill's halt write fails, a later RESET leaves the desk in FULL_AUTO, so entries resume at once.
  3. A dry-run kill uses the same IBKR client id (19) as a live kill, so a live E-stop pressed during a dry run fails to connect (TWS 326), and the one-live-kill rule then ignores the retry.

  There are also several low-severity test gaps. Full findings with fixes: `side-session-notes\...\kill-switch-review-round4-6fcd6cd.json` (the GPU session's notes folder). **Fix these, then merge into main, push, rebuild and restart?** Until then the app keeps the old kill switch: a held Ctrl+Shift+X can trip it, and an ack timeout can strip a filled entry's stop.
- Ops removal: the AnythingLLM `ops` workspace (0 threads) is left in place, unmapped. Delete it in AnythingLLM?
- The running app (restarted 11-27 00:31) is main at dffdb71: section-pass, batch3, director-suite, PR #8 (Sections 8-10 m2), Ops removal, crash hardening, recall fix.
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
- 10.4 Maps: widget UI for trips/saved routes, phone "Open in Maps" hand-off (backend done in m2)
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
| Live app after the 23:19 restart | 3 phone turns: fresh greeting and dinner answers (no stored reply copied), Joelle Bandits -> Chris recalled; first words 4.5 s cold, then 1.6 s and 1.0 s | 11-26 23:21 |
| Live app after the 23:40 restart (main 0c4341f) | Up, no panic.log lines; 2 phone turns answered by the desktop: live weather (not the stored reply), Chris recalled; first words 3.4 s cold, then 0.8 s | 11-26 23:42 |
| Live app after the 00:31 restart (main dffdb71) | Up, no panic.log lines; Ops migration ran (0 `"ops"` entries left); 2 phone turns answered by the desktop. "Is the droplet up?" now goes to Tony but gets a vague reply, since a phone turn has no live dashboard. First words 3.4 s cold, then 0.6 s | 11-27 00:33 |
| section-pass | Rust 1,433, vitest 2,499, gateway pytest pass | 11-27 02:09 UTC |
| section-pass-batch3 | Python 756 pass | 11-27 00:44 UTC |
| claude/elated-kare-67e4c4 (Ops removal, on e46d0c7; main since changed STATUS.md only) | tsc clean; vitest 2,887/2,887; cargo 1,596 (+2 known CRLF; browser tests passed); pytest language hub + memory scrolls + gateway + fw_server 253/253 | 11-26 23:45 |
| main 9c57359 (Ops removal + PR #8 + director-suite) | tsc clean; vitest 2,906/2,906; cargo 1,621 (+2 known CRLF; 3 Edge tests timed out under load, pass alone) | 11-27 00:30 |
| main after director-suite + finance merge | tsc clean; vitest 2,887/2,887; cargo 1,595 (+2 known CRLF); pytest 1,568 (embed flake); media-forge 115; semantic review of the merge: 0 clashes | 11-27 00:05 |
| director-suite (4e986f1, after merging main) | vitest 2,863; Rust 1,583 (+2 known CRLF; 7 browser tests flaky under load, 67/67 alone) | 11-26 23:20 |
| Director live E2E | run 9: 15/15 steps, 13.8 s Reel, frame filled, idea verbatim; audit 9/12 pass. Open: fit-only revision resolved a timing note | 11-26 22:40 |
| sections-8-10 m2 after main merge | pytest 1,721 (comms lock flake fixed in IsolatedCC), vitest 2,716, tsc clean, cargo all but 2 known CRLF | 11-27 00:05 |
| sections-8-10 m1 | vitest 2,563, Rust 50/50, Python comms 10/10 | 11-26 20:13 |
| Trading (5751989) | run_all 766 OK; vitest trading 340/340; engines 39/39 | 11-26 |
| claude/gifted-pascal-abdde6 (= main 77993c2 + this STATUS.md update) | tsc clean; vitest 2,906/2,906; pytest run_all 863 OK; cargo 1,619 + 2 browser tests that failed under load and passed alone (+2 known CRLF) | 11-27 01:40 |
| Kill-switch branch (6fcd6cd), port session's run | tsc clean; vitest 2,746/2,746; test_trading_* 705/705 (system Python), 702/705 (venv: 3 known python-multipart gateway tests); run_all 893 OK | 11-27 00:50 |
| Kill-switch adversarial review (GPU session), rounds 1-4 on 5751989, e055457, 5a1ce1a, 3215d66 and 6fcd6cd | each round: isolated checkouts, offline ib_async probes, mutation checks. Round 4 (6fcd6cd): the earlier HIGH is fixed; 3 MEDIUMs confirmed (see Waiting on you); ~25 Python mutations and all UI mutations caught | 11-27 01:15 |
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
_Refreshed 2026-11-27 01:17 by `python scripts/update_status.py`._

**Not merged into main yet**

| Branch | Commits ahead | Last commit | Uncommitted |
|---|---|---|---|
| `claude/unruffled-mayer-1247f9` | 2 | `9019f4c` 2026-11-27 docs(status): system.status tool committed (6eae983), waiting on me... | 1 files |
| `claude/upbeat-wing-e87be0` | 10 | `fa79cc3` 2026-11-27 docs(status): test gate PR #9 overnight state; inbox timing follow-... | clean |
| `claude/status-md-tracking-472ac5` | 1 | `6ee8587` 2026-11-27 docs(status): 11.10 and section 12 done, Director and Ops pushes re... | clean |
| `section-pass` | 15 | `d445421` 2026-11-27 feat(section-pass): Settings on the shared layout (layout step 4, p... | 13 files |
| `claude/practical-elbakyan-0f96f1` | 9 | `6fcd6cd` 2026-11-27 fix(trading): guard waits for the kill's flatten; nets every closin... | 173 files |
| `director-suite` | 3 | `e0f4410` 2026-11-27 test(comfy): opt-in live SDXL Turbo smoke through run_batch, outsid... | 1 files |
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
