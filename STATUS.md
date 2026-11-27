# STATUS

Updated 2026-11-27 17:20. One page for every Claude Code session and branch.
**Rule for every session:** after each commit or merge, update the sections below and run `python scripts/update_status.py` (refreshes the branch table at the bottom).

## HANDOFF: Section 26 engine (branch `section-26-engine`, worktree `G:\agentic-os-engine`), updated 11-27 17:07

For the next session (Claude Ultra, Monday). Nothing here is merged, pushed, switched on or rebuilt; Tony is on LM Studio (restored exactly after the 11:13 benchmark). Read `docs/section-26-plan.md`, `docs/section-26-allm-inventory.md`, `docs/section-26-bizops-prompt.md`.

**Built (all off, all tested):** engine (llama.cpp b12317, :1238, thinking off by default), model manager + calibrated fit check, watchdog, GPU baton yield/reclaim, gateway `/api/engine/*` (loopback only), Settings card (needs rebuild), doc store + ingest (Tony-only notes, memory scrolls; 7 AnythingLLM docs + 5 scrolls in), AnythingLLM export (secrets scrubbed; Drive sync can never take it), agent table with Nic's tool owners + built-in prompts, **gateway agents running their MCP-registry tools under that policy** (`engine/agent_runner.py`, switch `route_agents`), **thread store** (227 AnythingLLM chats archived as 32 threads), **gateway Tony's switch to the engine** (`gateway_tony.engine_route`, switch `route_tony`), Biz Ops prompt draft + builder (unused until Nic approves).

**Switches (engine.json beside providers.json), all false:** `enabled`, `route_agents`, `route_tony`. Turning any on is Nic's call.

**Benchmark (11:13, GPU idle):** engine first token 0.38 s median (p90 1.61), total 1.93 s, 6.2 GB VRAM; LM Studio right after 0.25 s / 1.45 s, 7.3 GB. Engine tail = cache misses across slots (tuning question below).

**Connection check (17:20, `python -m engine.connections`, read-only):** 22 pass, 3 warn, 0 fail. Engine exe + pins, Tony's GGUF, VRAM fit, LM Studio with Tony loaded, CPU nomic embedder round-trip, gateway + baton, all `/api/engine/*` routes (and 403 for the phone), gateway Tony on LM Studio while off, AnythingLLM originals untouched, export verified with 0 secrets, doc store hybrid search, 32 threads, scrolls + knowledge graph, agent policy (director refused outside its folder, no money tools, coder owns fetch). CPU engine smoke run: 3/3 live checks, first token 0.89 s, stopped after. Warnings, expected: no mmproj (vision is plan-only); desktop providers.json has no `llamacpp` until the rebuild; **the desktop chat-chain switch is not built**, so with `route_tony` on only gateway Tony (phone) would move, not desktop Tony.

**Before merging:** main has moved on (kill switch shipped, cf44451); merge main into this branch and re-run the tests first, since `agent_runner` checks the kill switch.

**Left:** desktop side of the switch (dispatch.rs chain head + model_swap.rs engine branch, design in the plan); a desktop bridge so gateway agents can run desktop-only tools (gmail, whatsapp, fetch, web.search...: today they answer "needs the desktop app"); engine tuning run (needs Nic's OK); Nic's review of the Biz Ops calls; vault join (Nic); rebuild (Nic); vision via Tony's mmproj (plan only).

**Commands:** `python -m engine.bench_swap` (GPU bench, restores Tony), `python -m engine.bench_tony --target lmstudio|engine`, `python -m engine.template_check --live engine`, `python -m engine.smoke_cpu`, `python -m engine.models fit|list|vram`, `python -m engine.allm_import report|redact <export>`, `python -m engine.agents_migrate <export>`, `python -m engine.ingest scrolls`, `python -m engine.bizops <tag>`.

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
| 11.10 Tony reads Finance (one read-only tool, finance summary endpoint) | section-pass-batch3 | 7166d26 | Yes (eefaf0a), pushed |
| Merge main (a0e730c) into director-suite, no conflicts | director-suite | 4e986f1 | Yes (with this merge) |
| Ops agent removed: its infra topics and Maps are Tony's, quotes / estimates stay Tony's (your call 11-26), frozen-Ops placeholder gone; one-time `ops-removed` os.json migration (backup first; dry run on the live 23:40 os.json: 5 sections change, roster 8) | claude/elated-kare-67e4c4 | 90ac158 | Yes (9c57359), not pushed; live since the 00:31 restart, os.json migrated (backup `os.json.bak-20261127-003126-ops-removed`) |
| Tony's read-only `system.status` tool: droplet (over NetBird), gateway, Bionic, STT, Kokoro, Docker, n8n, up/down + latency; status questions run it with no router call (phone turns included); never starts or changes anything | claude/unruffled-mayer-1247f9 | 6eae983 | Yes (merged 11-27 09:50 on top of PR #10), not pushed; app rebuild + live check in progress |
| S26: plan + Tony latency bench (`engine/bench_tony.py`; refuses unless Tony's model is loaded and the baton is free) | section-26-engine | 686860b | No |
| S26: pinned official llama.cpp b12317 CUDA 12.4 in `D:\llama.cpp\b12317` (sha256-pinned) + llama-server runner on :1238, off by default (`engine.json` enabled=false) | section-26-engine | 5a45469 | No |
| S26: model manager: lists the library, VRAM from nvidia-smi, GGUF-based fit check (Tony's 9B needs ~7.3 GB at 32k: 5.2 weights + 1.0 KV + 0.8 compute), refuses loads that don't fit | section-26-engine | 406619d | No |
| S26: document store (own SQLite, CPU nomic via the vault's `embed()`, hybrid search; the vault itself untouched) | section-26-engine | 92528ab | No |
| S26: AnythingLLM export + import, read-only on AnythingLLM. Export `G:\agentic-os-engine\data\engine\allm-export\20261127-101548` (11 workspaces, 227 chats, 7 docs, integrity ok); 7 docs -> 22 chunks, all embedded | section-26-engine | 101fd2a | No |
| S26: AnythingLLM inventory: 14 functions mapped to their gateway home (docs/section-26-allm-inventory.md); Gmail/Calendar already call Apps Script directly; phone has no AnythingLLM endpoint | section-26-engine | e1fe0c1 | No |
| S26: watchdog (restart a crashed llama-server with the same model, 3 restarts / 5 min limit, waits for the baton, never acts while off) | section-26-engine | d3d1993 | No |
| S26: Qwen template + tool-call checks; engine defaults thinking OFF (Qwen3.5's template ignores reasoning_effort) | section-26-engine | 08c0d0d | No |
| S26: `llamacpp` provider listed in dispatch.rs, never in any chain (test pins it) | section-26-engine | b05c691 | No |
| S26: resumable Hugging Face GGUF download + Recycle-Bin delete (typed confirm) | section-26-engine | 285d583 | No |
| S26: Settings -> Services -> Built-in engine card (status, VRAM, models + fit, load/unload, settings, download, delete); needs a rebuild to see | section-26-engine | 0162a7d | No |
| S26: gateway `/api/engine/*` (loopback only), boot hook, GPU baton yield/reclaim | section-26-engine | 24dbfe8 | No |
| S26: agent-table proposal from os.json + the export (read-only, not wired) | section-26-engine | 840aadc | No |
| S26: CPU-only smoke test of the real llama-server (no GPU): 3/3 live checks, first token 1.0 s on CPU | section-26-engine | 1569272 | No |
| S26: AnythingLLM export holds no API key or token in plain text (6/6 live secrets scrubbed, VACUUMed; new exports scrub automatically); gitignored; no Drive sync on this PC | section-26-engine | 47ae063 | No |
| S26: your tool owners in the agent proposal (Coder owns filesystem + fetch, Tony owns knowledge-graph writes, readers read-only; one writer per tool, tested) | section-26-engine | 145949e | No |
| S26: Tony's gateway prompt is the only Tony prompt; Booking takes the detailed Booking Desk prompt (to confirm) | section-26-engine | 95e021a | No |
| S26: Biz Ops shared prompt DRAFT (Acting, Contracting, BF Supplements sections by business tag); both business workspaces map to it | section-26-engine | 5a66c07 | No |
| S26: Biz Ops prompt builder (only the tagged business's section; refuses scope bleed) | section-26-engine | 5a6df42 | No |
| S26: **step 5 GPU benchmark** (engine vs LM Studio) with Tony restored exactly (same 6 load settings, answered in 1.7 s); VRAM estimate calibrated | section-26-engine | 7d08994 | No |
| S26: Designer reads the repo widget folders only; Booking's future access recorded (read-only WhatsApp, draft-only Gmail, Tony owns both; stays frozen) | section-26-engine | f2e8545 | No |
| S26: Drive sync never uploads the AnythingLLM export, `data/engine` or backup archives (`never_syncs`, tested); OneDrive covers only your user folders, not G: | section-26-engine | acbad0b | No |
| S26: agent table carries the 4 built-in role prompts verbatim (from agent_prompts.rs) | section-26-engine | 96a13a6 | No |
| S26: **gateway agents run their MCP-registry tools** under Nic's policy (owner / read / draft, registry read-only, permissions, kill switch, folders, no money tools); live CPU check: Director listed its projects, a read outside was refused; switch `route_agents` OFF | section-26-engine | f63a78b | No |
| S26: **thread store** for gateway agents; 227 AnythingLLM chats archived as 32 threads (history only, Finance never imported) | section-26-engine | 6d73548 | No |
| S26: **document ingest**: Tony-only notes + memory-scroll sync into the doc store (5 scrolls in) | section-26-engine | b3d31e5 | No |
| S26: **gateway Tony's switch to the engine**, built and tested behind `route_tony` (OFF; with it off Tony's path is unchanged) | section-26-engine | 756feda | No |

## 2. In progress

| Session | Working on | Current step |
|---|---|---|
| Gabagoul functional pass (section-pass) | Section 5 Staging hub | Committed work is in main. Next: merge main into section-pass before more commits |
| Gabagoul functional pass (section-pass-batch3) | Section 12 Phone book | 11.10 done and in main |
| Director suite build | Live SDXL Turbo test (ComfyUI via the GPU baton) | Part 1 fixes and committed work are in main. Next: SDXL test, then Part 3 UI; merge main into director-suite before more commits |
| Communications page and brainstorming | Sections 8-10 overnight (branch claude/sections-8-10-m3) | Merged to main as PR #10 (c134f9c). Done: Maps 3, 9, 10, 11 (pure part); Brainstorm 8. The rest is parked (see Waiting on you) |
| Stop the UI burning GPU | Reviewing 5751989 | Then merge to main, push main, rebuild + restart app |
| Make run_all.py run every trading test | Trading test gate | Finding why the gate takes 9 min (550 s). Uncommitted |
| Tony's droplet status tool (claude/unruffled-mayer-1247f9) | `system.status` merged into main | Testing the combined main, then app rebuild + restart and a live phone inbox check (this session) |
| Section 26 engine (section-26-engine, worktree G:\agentic-os-engine) | Built-in llama.cpp engine beside LM Studio / AnythingLLM, off | Stopped at a clean commit with a handoff (top of this page). Waiting on you: GPU bench, rebuild, questions |

## 3. Waiting on you

**Questions for Nic (Section 26, section-26-engine)** (answers through your 2nd 11-27 message are applied; these are my calls for you to review)
- **Biz Ops draft, my calls on its 4 questions (kept UNUSED until you approve):** (1) Name "Biz Ops" and the old workspaces' tone: kept, because the scope rules are already proven in the two live workspaces and one name across businesses keeps routing simple. (2) Acting: casting posts and Gmail drafts stay with the **Booking Desk**, so Biz Ops points there. Booking already owns that flow and its templates, and two agents drafting the same emails would double up. (3) Section title **"BF Supplements"**, since that's what you call it; the registry name stays "Supplements & E-Commerce" for matching. (4) `instagram`: Biz Ops keeps it **read-only / draft posts only**, never posts; same pattern as Booking's draft-only Gmail.
- Play Place has no assets folder in the repo (its items live in the gateway's shared store, next to the vault), so Designer gets only `command center\src\widgets` and `recovered-widgets`. Name a Play Place folder if you want one added.
- Engine tuning (optional): the engine's first-token tail is worse than LM Studio's (p90 1.61 s vs 0.27 s back to back), most likely prompt-cache misses across its 2 slots. Each tuning run unloads Tony for ~3 min (Bionic's reload took 100 s). OK to try `--cache-ram` / one unified KV slot set in one more run when the GPU is idle?


**Decisions**
- Sections 8-10: after the next app rebuild, look at the Maps widget Upcoming and Saved tabs (not yet checked in a running app).
- Sections 8-10 contract `features/maps/contract.ts` is a DRAFT: approve to lock it.
- Sections 8-10 parked because they touch safety controls (your call): confirmation-card options (Brainstorm 9, `gate.ts` / ConfirmCard) and the auto-dispatch taint rule (Comms 4, `tony_dispatch.rs`).
- Sections 8-10 parked because another session owns the code: Comms screens (Comms 9; the phone-book session is in CommsSection) and the Director Ideas board (Brainstorm 14, Director page).
- Sections 8-10 parked for the app or the phone: wire the Maps hand-off listener into `App.tsx`; add `maps_trips` + trip-words to `platform.ts` NativeCommands; Android work (Comms 6-8, Maps 4 + 12, Brainstorm 12, one APK); voice Talk (Brainstorm 2, 3, 7, 10, 11, 13).
- Sections 8-10 overnight defaults I picked (safest each time): phone and narrow widgets open on Upcoming, the PC on Map; location only on a tap of "Use my location" (desktop); hand-offs refused unless every link is an https Google Maps link, and the opened link is rebuilt from coordinates; hand-off TTL 30 min (2 min clock skew); trips and seen hand-offs kept in memory only (addresses); refresh 5 min desktop / 2 min gateway / 10 min after an error; wrap phrases count only as a whole line; in Talk only cut / hold / "Tony, end talk" act; memory items only from Nic's lines and only by reference; "later" in the walk leaves an item pending; talk digest never labels Tony's words as Nic's.
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
| section-26-engine (756feda) | full pytest 1,841 pass, 1 skip; engine tests 101 + switch 5; test_gateway_tony 80/80; vitest engine 6/6, tsc clean; cargo lib 1,630 pass, 7 fail = 5 load-sensitive real-browser + 2 known CRLF (none in code I changed); pipelines 4/4; GPU bench + CPU smoke 3/3 | 11-27 12:40 |
| claude/unruffled-mayer-1247f9 (system.status, on main 77993c2) | tsc clean; vitest 2,906/2,906; cargo 1,634 (+2 known CRLF; browser tests passed). Rerun 01:25 before the STATUS commit: the same, but 1 Edge test timed out under load and passed alone. Real report on this PC: 8/8 up, droplet 59 ms, whole check 0.5 s. Bionic, real phone-turn messages: "is the droplet up?" 3/3 right; doctored droplet-down 5/5 right, no fix offers or dispatches (without the answer note: 2/3 offered a restart, 1 dispatched a Coder ssh restart) | 11-27 01:05 |
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
| sections-8-10 m3 overnight (0d72190) | pytest 1,735; vitest 3,021 (211 files; 132 new maps + brainstorm tests); tsc clean; cargo 1,612 (+2 known CRLF in allm/buildhub, not mine, left alone). Not checked by eye: no dev server allowed overnight, MapLibre needs WebGL | 11-27 02:00 |
| sections-8-10 m2 after main merge | pytest 1,721 (comms lock flake fixed in IsolatedCC), vitest 2,716, tsc clean, cargo all but 2 known CRLF | 11-27 00:05 |
| sections-8-10 m1 | vitest 2,563, Rust 50/50, Python comms 10/10 | 11-26 20:13 |
| Trading (5751989) | run_all 766 OK; vitest trading 340/340; engines 39/39 | 11-26 |
| Playwright | not run (`@playwright/test` not installed in one worktree) | |
| Stress (Heavy probe) | Tony 13.8 s, 35.9 tok/s; VRAM peak 74.6%, no spill | 11-25 21:51 |

**Section 26 bench: Tony at the model server, real phone-turn messages, 4 prompts x 3 (11-27 10:31)**
- LM Studio / Bionic (today): first token **0.37 s** median (p90 1.11, min 0.22; first turn of each prompt 0.83); total **1.71 s** median (p90 3.53); 11/12 under 1.5 s
- **Built-in engine on GPU (11:13, Tony's 9B, 32k x 2, same prompts): first token 0.38 s median** (p90 1.61, min 0.23; first turn of each prompt 0.56); **total 1.93 s** median (p90 3.50); 10/12 under 1.5 s; live checks 3/3; **6.2 GB VRAM vs LM Studio's 7.3 GB**; loads in 19 s
- LM Studio again right after (11:15, warm): first token **0.25 s** median (p90 0.27); total **1.45 s** (p90 2.02); 12/12 under 1.5 s
- Verdict: about level on a typical turn, better on cold turns, worse tail (cache misses across slots, tuneable); uses 1.1 GB less VRAM. Tony restored exactly after the run.
- CPU-only smoke test: first token 1.0 s, total 3.4 s for a short reply; live checks 3/3
- Live template checks on Bionic: thinking off, native tool call, JSON router: 3/3 OK

**Tony, time to first word (11-26)**
- Phone, desktop answering: **1.33 s** median (was 2.7 s); done 2.17 s
- Phone, app closed, gateway answers: 0.66-1.29 s
- Gateway warm: 0.48-0.93 s
- Phone speech-to-text (faster-whisper): 0.33-0.59 s
- 4073bd9 build (main): **1.14 s** median first words, done 2.13 s (6 phone turns, 21:22)

## Branches

<!-- AUTO:BRANCHES (scripts/update_status.py rewrites this block) -->
_Refreshed 2026-11-27 17:12 by `python scripts/update_status.py`._

**Not merged into main yet**

| Branch | Commits ahead | Last commit | Uncommitted |
|---|---|---|---|
| `section-26-engine` | 32 | `630ceb8` 2026-11-27 docs(status): refresh branch block; note main moved (kill switch) b... | 2 files |
| `section-pass` | 24 | `a0ad5f7` 2026-11-27 Merge main (4e69152) into section-pass | clean |
| `claude/upbeat-wing-e87be0` | 11 | `5ca67c0` 2026-11-27 Merge main (196b2f8: Sections 8-10 PR #10) into claude/upbeat-wing-... | no worktree |
| `claude/gifted-pascal-abdde6` | 1 | `6da6551` 2026-11-27 docs(status): kill-switch review round 4, merge parked overnight | no worktree |
| `claude/status-md-tracking-472ac5` | 1 | `6ee8587` 2026-11-27 docs(status): 11.10 and section 12 done, Director and Ops pushes re... | no worktree |
| `feat/ibkr-paper-trading` | 1 | `46778f9` 2026-11-24 fix(trading): fixes from the live paper rehearsal; 3-press kill switch | no worktree |
| `hermes-output-cleanup` | 1 | `15f2ceb` 2026-11-18 fix: parse Hermes v0.23 chat replies and strip ANSI colour codes | no worktree |

**Latest on main**

- `cf44451` 2026-11-27 docs(status): kill switch shipped (8647df7), app restarted 16:25; bridge restart waits on Nic
- `73ed487` 2026-11-27 docs(status): system.status live check on the 10:41 app, combined main tests
- `8647df7` 2026-11-27 Merge the kill switch + options guard hardening (claude/practical-elbakyan-0f96f1) into main
- `4e69152` 2026-11-27 docs(status): app restarted on main 0418649, system.status live and checked
- `766dbf1` 2026-11-27 Merge section-pass-batch3: overnight batch (15 Language SRS, 14.6-14.7 track record + rankings, 16.2/16.3/16.6 mirrors + vault password + vault.search, S20.10 instant cues)
- `d06baeb` 2026-11-27 docs(status): Tony live-test fixes pushed to origin (main e547863)
<!-- /AUTO:BRANCHES -->
