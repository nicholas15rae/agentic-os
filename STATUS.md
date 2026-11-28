# STATUS

Updated 2026-11-27 20:05. One page for every Claude Code session and branch.
**Rule for every session:** after each commit or merge, update the sections below and run `python scripts/update_status.py` (refreshes the branch table at the bottom).

## HANDOFF: Section 26 engine (branch `section-26-engine`, worktree `G:\agentic-os-engine`), updated 11-27 20:05

**Ready to merge into main** (another session merges; Nic: don't merge here). Clean at the last commit; origin/main 3d2e38d is already merged in. Read `docs/section-26-plan.md` too.

**Live right now (Nic switched these on 19:31-19:40):** `engine.json` enabled + **route_tony ON** (route_agents off); `fastpath.json` smallTalkSkipsTools, instantCues, statsCache all ON. Both files sit beside providers.json and are read fresh every turn, so an app restart keeps them. Tony's `D:\LM Studio\lmstudio-community\Qwen3.5-9B-GGUF\Qwen3.5-9B-Q4_K_M.gguf` runs on the engine (:1238, llama-server pid 39608) under the **engine sidecar** (`python -m engine.serve`, 127.0.0.1:8081, pid 50796, from this worktree). App: pid 4032 from this worktree's release build (19:23). Bionic is up with no model.

**The 19:23 "restart on its own" (Nic, 11-27):** that was this session restarting the app to load the new build; the startup cue then played its greeting into the hidden window. No crash (no panic.log, no WebView2 crash dumps, the process has run since 19:23:52), not the watchdog, not a switch (switches only write engine.json). Lesson: never restart the app while Nic may be talking; ask first.

**Merging session, in this order:**
1. Merge, run the suites, rebuild from main.
2. **Copy `G:\agentic-os-engine\data\engine\` to `G:\agentic os\data\engine\`** (gitignored, so a merge doesn't bring it): the agent table, doc store (7 AnythingLLM docs + 5 scrolls), threads (227 chats), bench results, and the AnythingLLM export (secrets scrubbed; keep it local, never in Drive; never delete it without Nic's OK).
3. Hand the engine to the gateway: `POST http://127.0.0.1:8081/api/engine/unload`, stop the sidecar (pid 50796), then restart the gateway on main. Its `boot()` starts Tony's model on the engine, because enabled is on. Until then the sidecar owns the llama-server process, and only it can unload it.
4. Restart the app on the main build **only when Nic says**. The app's new engine keeper starts the sidecar again after a reboot when nothing serves `/api/engine/*`. With the gateway on main it stays idle.
5. Phone Tony moves to the engine once the gateway runs main (gateway_tony reads route_tony).

**Voice turn, end of speech → first audio (Nic's stopwatch 1.7-3 s), measured 11-27 19:50:**

| Stage | Before (LM Studio, fast path off) | After (engine + fast path) | Notes |
|---|---|---|---|
| End-of-turn silence wait | 0.70 s | 0.70 s | `vad.endSilenceMs` 700 (Settings → Voice) |
| Whisper (faster-whisper large-v3-turbo, GPU) | 0.28-0.34 s | 0.28-0.34 s | 1.5-4 s lines; 0.41 s cold |
| Tony to first word (inbox, desktop answering) | 0.59 small talk / 1.80 greeting / 1.01 time / 1.16 weather | 0.53 / 0.69 / **0.09 / 0.10** | median of all 0.78 → 0.52 s |
| ElevenLabs, first sentence (eleven_v4_turbo) | 0.47-0.73 s | 0.47-0.73 s | first byte 0.21-0.27 s, but the app waits for the whole sentence's MP3 |
| Total, small talk | about 2.3-2.6 s | about 2.2-2.5 s | plus the first sentence finishing (~0.3 s) |
| Total, time / weather | about 2.5-2.9 s | about 1.5-1.8 s | |

Biggest remaining wins (not built, Nic's call): play ElevenLabs on its first byte instead of the whole sentence (-0.25 to -0.45 s); `eleven_flash_v2_5` (whole sentence 0.25-0.32 s, -0.2 to -0.4 s, a different voice quality); end-of-turn 700 → 500 ms (-0.2 s, risks cutting Nic off); streaming STT partials (`vad.partialMs`) so Whisper overlaps speech (-0.2 to -0.3 s); the desktop turn pipeline adds about 0.4 s over the raw engine (0.11 s Test reply vs 0.53 s small talk): recall, routing and the inbox hop are worth profiling.

**Left:** desktop bridge so gateway agents run desktop-only tools; engine tuning run (needs Nic's OK); Biz Ops review; vault join (Nic); vision via Tony's mmproj (plan only).

**Commands:** `python -m engine.connections`, `python -m engine.bench_turns --label <x>`, `scripts\start-engine-sidecar.ps1`, `python -m engine.bench_swap`, `python -m engine.template_check --live engine`, `python -m engine.smoke_cpu`, `python -m engine.models fit|list|vram`, `python -m engine.allm_import report|redact <export>`, `python -m engine.ingest scrolls`.

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
| Kill switch + options guard hardening (port of 46778f9 and 4 review rounds): held keys and held Enter can't trip it; the hotkey works in text fields; the ack wait never strips a filled entry's stop; options exits wait for TWS's ack; guard retries back off and never double an exit; the guard waits for the kill's own flatten; one live kill at a time. Round 4 (you said fix them, 11-27): another client's resting order never counts as cover (no naked short; the order is named); a failed halt is retried and reset always lands in ADVISORY; dry runs use their own client id (26); a second press waits for the running kill | claude/practical-elbakyan-0f96f1 | 5751989, e055457, ea09c98, 0330e8f, 5a1ce1a, 3215d66, 6fcd6cd, 5a55ebc (+ merge b0451af) | Yes (8647df7), pushed to origin; review round 5 confirmed all round-4 MEDIUMs fixed (1 new MEDIUM left, see Waiting on you). App UI live since the 16:25 restart; trading bridge restarted 17:17 on it (main checkout fast-forwarded to cf44451) |
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
| Section 12 Phone book (grouped by area, linked across Finance, invoices, agencies, auditions, messages; .vcf import) | section-pass-batch3 | 3fe3468 | Yes (6d1084b) |
| Section 15 part: spaced-repetition flashcards, Today's lesson, curveball setting (off, not wired to Tony) | section-pass-batch3 | 763dab0, 4520f35 | Yes (with this merge), not pushed |
| Section 14.6 + 14.7: Discord rankings need 30 calls (Wilson bands); paper track record beside the backtest + SPY (display only) | section-pass-batch3 | 55030dd | Yes (with this merge), not pushed |
| Section 16.2 + 16.3 + 16.6: backup mirrors to a second drive (verified, keep-all), vault password banner + checklist, Tony's read-only `vault.search` | section-pass-batch3 | f138a9b, 4520f35 | Yes (with this merge), not pushed |
| S20.10 instant cues: time / date / weather / reminders with no model call; your own fast cues in Voice & Triggers | section-pass-batch3 | 5c80888 | Yes (with this merge), not pushed |
| Merge main (a0e730c) into director-suite, no conflicts | director-suite | 4e986f1 | Yes (with this merge) |
| Tony live-test fixes (11-27), 6 of 7: Gmail reads/searches Primary only (`category:primary in:inbox`) unless you name a tab; saved in Settings → Comms (new tab, default Primary only); each email line names sender, subject and inbox; prompt rule: never claim a read with no tool run; Gmail tab names in the Whisper hint list (one-time migration moves an unedited old default); internal labels like "Spoken reply" stripped before TTS; to-do adds ask "Add “…”?" with your exact words and save only on yes | claude/tony-live-test-fixes-5d85d5 | 1318759 | Yes (9d37071), pushed to origin; in the 0418649 rebuild the parroting session is restarting |
| Tony live-test fix 6, barge-in (you said build it): "hold on" is a hard stop like "stop" (start of a line only; "hold on a sec" too; a passive room listen still needs the wake word); talking over Tony while he's audible stops him at speech onset and drops the rest of the reply (never resumed or repeated; the bubble keeps what was written). Over a turn still thinking, he only ducks, as before | claude/tony-live-test-fixes-5d85d5 | e802ad3 | Yes (9d37071), pushed to origin; in the 0418649 rebuild the parroting session is restarting |
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
| S26: **desktop Tony's chat switch** behind `route_tony` (OFF): chat chain, streaming, director, status tool, Language Hub, compaction, builder intake; ComfyUI GPU hand-off yields / reclaims the engine | section-26-engine | cff8257 | No |
| S26: **Settings → Engine / Models** tab: Engine on / Route Tony / Gateway agents switches, where chat and memory run, Test reply (first word + total), last benchmark, Set as Tony's model, load blocked when it won't fit | section-26-engine | aee7208 | No |
| S26: **Tony's fast path** (`fastpath.json`, all OFF): small talk skips tools, instant time / date / weather / PC-stats answers with no model run, stats cache (CPU, RAM, GPU, VRAM, GPU temp every 5 s; weather every 10 min) | section-26-engine | 2b44e0f | No |
| S26: engine keeper: the app starts the engine sidecar again after a reboot when the engine is on and nothing serves `/api/engine/*`; voice latency measured per stage (handoff table) | section-26-engine | (this commit) | No |
| S26: app rebuilt and restarted from the worktree (origin/main 3d2e38d merged first); connection check 24 pass, 1 expected warn | section-26-engine | 2b44e0f | No |
| Section 5 cleanup: no Librarian in the build chain, one true build status, archive | section-pass | d94c6cd | Yes (f555484), pushed |
| Section 6 home grid: push-aside, widget drawer, page presets, widget looks, tap to focus, icons + windows | section-pass | b5b98ee, 604c334 | Yes (f555484), pushed |
| Everything-is-customizable rule (AGENTS.md) + shared layout plan (docs/shared-layout-plan.md) | section-pass | 76eb094 | Yes (f555484), pushed |
| Layout step 1: shared layout engine for every page, Reset this page / all pages / Undo, per-mode layouts, safety controls locked (kill switches, Tony's stop, confirmations) | section-pass | b51b7a7 (+ main merged in af74985) | Yes (f555484), pushed |
| Layout step 2: Settings → Appearance: design tokens, Reset to default first (Undo), page overrides, 4 + saved themes, live preview, export / import of layouts + themes | section-pass | 7f69d01 | Yes (f555484), pushed |
| Layout step 3: widget builder: brief checklist, interactive widgets built by the Play Place pipeline, every point verified in a real browser, style kit; fortune cookie tested on the checking side | section-pass | 9d02fa4 | Yes (f555484), pushed |
| Layout step 4, page 1: Play Place on the shared layout (panels, per mode, Reset, deep links reveal their panel) | section-pass | 675571e | Yes (f555484), pushed |
| Layout step 4, page 2: Agents on the shared layout (threads, conversation, reports, library) | section-pass | 9364ec3 | Yes (f555484), pushed |
| Layout step 4, pages 3-6: Comms, Operations, Finance, Trading on the shared layout (Trading's execution desk / kill switch locked); icon windows open full size, charts fill their panel | section-pass | 5825204, 8430a52, 68e1c2b, cbc9d7f, e757697 | Yes (f555484), pushed |
| Layout step 4, page 7: Settings on the shared layout (your pick: tab bar + one content panel) | section-pass | d445421 | Yes (f555484), pushed |
| Layout step 4, pages 8-11: Language Hub, Vault, Wallpapers, System Map (Blueprint) on the shared layout | section-pass | 5488588, de2a4bd, c0b088f, a597bb0 | Yes (f555484), pushed |
| Layout step 5: window options: float, pin on top, click-through (safety controls always on top, on the board, never click-through); native pop-out parked | section-pass | 52938a5 | Yes (f555484), pushed |
| Layout step 6: phone sync of layouts and themes through the gateway (desktop shares on change; phone follows, keeps its page, never mid-edit; 'Follow the desktop' switch) | section-pass | 74f9e0d | Yes (f555484), pushed |
| Fortune-cookie live build (section-pass app, 11-27 10:06-10:25): every brief point reached the verifier and the widget used the style kit; it went to Repair because click probes on its SVG cookie misfired (checker bug, fixed) and the local verifier quoted code not in the page | section-pass | 96829e3 | Yes (f555484), pushed |
| Build checks catch an animation that never shows (style values the browser rejects, e.g. the cookie's clip-path; elements with click handlers are clicked in the smoke) | section-pass | febc6e9 | Yes (f555484), pushed |

## 2. In progress

| Session | Working on | Current step |
|---|---|---|
| Tony live-test fixes | All 7 fixes | Merged into main (9d37071). The "Stop Tony parroting" session is rebuilding from main 0418649 and restarting the app; it will check Tony afterwards. Pushed to origin |
| Gabagoul functional pass (section-pass) | Merged into main (f555484) and pushed, 11-27 | Done. Open items are under Waiting on you (fortune-cookie rerun, pop-out windows, hold-to-switch, Play Place redesign, Brainstorm and Director pages). Clean |
| Gabagoul functional pass (section-pass-batch3) | Overnight 11-27 batch (15, 14.6-14.7, 16.2/16.3/16.6, S20.10) | Merged into main, not pushed. Left: 21 setup walkthroughs; parked items below |
| Director suite build | Merged into main (5098ca3) and pushed to origin | Next: your decisions in section 3 (voice, phone review, Scene Reader, face check, Part 6/7 go-ahead) |
| Communications page and brainstorming | Sections 8-10 overnight (branch claude/sections-8-10-m3) | Merged to main as PR #10 (c134f9c). Done: Maps 3, 9, 10, 11 (pure part); Brainstorm 8. The rest is parked (see Waiting on you) |
| Stop the UI burning GPU | Done | Kill switch merged (8647df7), pushed, app restarted 16:25 on 8647df7 (hidden: GPU 0.00%), bridge restarted 17:17 on the new code. Nothing in flight |
| Make run_all.py run every trading test | Trading test gate | Finding why the gate takes 9 min (550 s). Uncommitted |
| Port 46778f9 / kill switch (practical-elbakyan) | Done; session closed | Round 4 fixed in 5a55ebc; merged into main by the GPU session. Round-5 follow-ups listed under Waiting on you |
| Section 26 engine (section-26-engine, worktree G:\agentic-os-engine) | Built-in llama.cpp engine beside LM Studio / AnythingLLM, off | Stopped at a clean commit with a handoff (top of this page). Waiting on you: GPU bench, rebuild, questions |

## 3. Waiting on you
- Director length hint may suggest moving a clip's START earlier (run 14 had no out point free, so it suggested opening clip 1 on the line before). Keep, or out points only?
- Director picks moments from the transcript alone, so a cut can miss Nic's face (run 15 was one acted scene under narration). Want a face/person check in media-forge (local, CPU) feeding the context?
- Director Part 6 larger items need your call before building: talk-to-edit (new incremental actions), three speeds incl. Full AI, storyboard first, performance-aware comping (needs Scene Reader data), NetBird private link (gateway), Instagram posting (hosting), tool pill (agents.rs). Part 7 boosters not started.
- Director voice (Part 5): pick an ElevenLabs voice for the Director (agentVoices.director); voice settings are shared core, so not set.
- Scene Reader link (Part 4): its app has no HTTP endpoint; the card shows when Studio TTS (:5123) answers. Import reads %APPDATA%\com.scenereader.dev (copy only). OK, or want a real export endpoint in Scene Reader (its repo)?
- Director Part 3 contract questions (defaults picked, change any): (1) ComfyUI policy select sits on the Queue card and applies to every project; (2) Re-roll of a style-transfer whose job was pruned from the queue is disabled; (3) Restore is offered only from the Versions tab.
- Director Part 3 phone review needs a gateway (server.py) /api/media proxy behind the security gate: shared core, so not built. OK to build it?

**Questions for Nic (Section 26, section-26-engine)** (answers through your 2nd 11-27 message are applied; these are my calls for you to review)
- S26 fast path: you asked for "what's pending" as an instant answer, but on 11-27 you decided it stays Tony's live Finance read, and money code is off limits for me. I left it as is. Say if you want it changed.
- S26: to use the Engine / Models model list, Test reply and turning the engine on, the gateway has to run this branch. Merge it, or restart the gateway from `G:\agentic-os-engine`?
- **Biz Ops draft, my calls on its 4 questions (kept UNUSED until you approve):** (1) Name "Biz Ops" and the old workspaces' tone: kept, because the scope rules are already proven in the two live workspaces and one name across businesses keeps routing simple. (2) Acting: casting posts and Gmail drafts stay with the **Booking Desk**, so Biz Ops points there. Booking already owns that flow and its templates, and two agents drafting the same emails would double up. (3) Section title **"BF Supplements"**, since that's what you call it; the registry name stays "Supplements & E-Commerce" for matching. (4) `instagram`: Biz Ops keeps it **read-only / draft posts only**, never posts; same pattern as Booking's draft-only Gmail.
- Play Place has no assets folder in the repo (its items live in the gateway's shared store, next to the vault), so Designer gets only `command center\src\widgets` and `recovered-widgets`. Name a Play Place folder if you want one added.
- Engine tuning (optional): the engine's first-token tail is worse than LM Studio's (p90 1.61 s vs 0.27 s back to back), most likely prompt-cache misses across its 2 slots. Each tuning run unloads Tony for ~3 min (Bionic's reload took 100 s). OK to try `--cache-ram` / one unified KV slot set in one more run when the GPU is idle?


**Decisions**
- section-pass converted Comms and Operations to the shared layout. The Communications/brainstorming and Remove-Ops sessions also touch those pages: expect merge conflicts in `CommsSection.tsx` / `OperationsSection.tsx`; Brainstorm and Director were left alone for them.
- section-pass (now in main): fortune-cookie rerun wanted LATER (Nic, 11-27): when you say go, rebuild main, restart the app on it, then you send Fix on the Fortune cookie tile (Tony in Builder).
- section-pass, parked for you: (1) native pop-out windows for panels (need a section-pass app build to test); (2) Section 7 hold-to-switch on Tony's button (that button is also Tony's stop, a safety control: your call how it should work); (3) Play Place redesign (Section 5: you asked to see the plan first); (4) Brainstorm and Director pages on the shared layout (other sessions own them).
- Push main (overnight batch merged, not pushed)?
- Parked overnight (safety or hardware): 14.5 Full auto gate (PIN + phone approval, live-trading control), 14.8 IBKR data everywhere, 14.9; 15.2 camera translate (phone), 15.3 pronunciation (GPU Whisper), 15.4 accents (Scene Reader), 15.7 vocabulary images (ComfyUI); 16.3 recovery key (would change the vault encryption); wiring language curveballs into Tony's turn.
- Instant cues: "what's pending" deliberately stays Tony's Finance read (live data); only reminders / to-do are instant.
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
- **Kill switch / options guard** (`claude/practical-elbakyan-0f96f1`): round 4 is fixed in 5a55ebc (you said "fix them now"). Review round 5 (GPU session) confirmed all 3 round-4 MEDIUMs fixed and merged it into main. **The trading bridge needs a restart to load it** (not done: your call). Things to know:
  - A manual order in TWS on an expiring option leg is now named in the guard's report (and audited). If it sits on a short leg, the guard keeps the long legs until you cancel or replace it.
  - Dry runs (09:00 health check, the UI button) now connect as client id 26. Set `IBKR_CLIENT_ID_KILL_DRY` if 26 is taken on your TWS.
  - A second E-stop press during a kill waits for it. It runs again only if the first never connected. If the first connected but failed, the press reports that and sends nothing; then run `python trading/kill_switch.py`.
  Not fixed:
  - Normal guard passes still net against an open-order list the bridge hasn't confirmed (openOrdersAt missing).
  - Unlock-disabled-mid-kill has no render test; the server's refusal is tested.
  - The hotkey doesn't read the in-flight count; the desk serializes kills, and the toast says "already running".
  - An unfilled closed_stop LMT exit is never re-armed (predates this work).
  - TWS's take-profit handling when a partly filled entry is cancelled is unconfirmed.
  - Real Windows key-repeat inside WebView2 is untested (only CDP key events).
  Round-5 follow-ups (port session closed; full findings `kill-switch-review-round5-5a55ebc.json` in the GPU session's notes folder):
  - MEDIUM: a premium stop partly held back by a manual resting SELL (e.g. GTC SELL 1 of 2 at 9.50) sells only the rest, is marked closed_stop and reports nothing; the held-back contract is never re-checked. Still safer than before (no over-sell).
  - Low: a kill that raises after its network steps (audit or incident write) counts as "never connected", so a waiting second press re-runs it; the rerun rule should be "placed no KILL- order".
  - Low: the stand-down doesn't stop Engine A's auto scan; reset() unlinks the lock before its ADVISORY write lands.
  - Low: untested: closes_now side-only / size-only checks, Unlock-disabled-mid-kill, red-button toast titles.
- System Python: `ib_async` 2.1.0 is installed (you asked). pip downgraded `tzdata` from 2026.6 to 2025.3 (ib_async pins <2026). The gateway runs on system Python and uses the 2025.3 time-zone rules after its next restart.
- Ops removal: the AnythingLLM `ops` workspace (0 threads) is left in place, unmapped. Delete it in AnythingLLM?
- The running app (restarted 11-27 16:25 by the GPU session) is main 8647df7: everything on main up to 4e69152 (section-pass-batch3 overnight batch included) plus the kill switch + options guard hardening. The earlier checks still apply: Settings has a Comms tab set to "Primary only"; "check my email" reads Primary only; "add Melissa Lee invoice to my to-do list" asks before it saves; saying "hold on" while Tony talks stops him.
- Trading bridge restarted 11-27 17:17 (your OK) on the new kill-switch / options-guard code: the main checkout (G:gentic os, feat/language-hub) was fast-forwarded to main cf44451 first; reconnected to TWS paper as client 11 in 3 s and publishes openOrdersAt. The gateway was not restarted: it still runs its older loaded code until its next restart (already pending above for Finance records).
- Check in the running app (00:31 build): pair a phone by QR then approve with the 2-digit code; phone captions with Live captions on; a wrong-token phone gets 401 and an unknown-device alert.
- Security card now limits idle lock to 5-120 min and re-verify to 30-720 min.
- Tony's Tier-1 memory holds dozens of copies of the six latency-test lines. They're harmless now, but prune them?
- `hermes-output-cleanup` (15f2ceb, Nov 18): rebase and merge, or drop?
- Approve the run_all.py commit once the 9-min answer is in.
- OK to run the WhatsApp bridge port patch script.
- Director: Instagram public hosting approach; ElevenLabs voice for the Director (later).
- Is `D:\Art Apps\agentic os\brain` still real? The old D: copy looks stale.

**Manual steps**
- After the next rebuild + restart: set a mirror folder on another drive (Vault, Second copies), press Re-index vault, re-run the Engine R evaluation (fills the track record's spread).
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
- 14.5, 14.8, 14.9 Trading (parked: safety / needs IBKR)
- 15.2, 15.3, 15.4, 15.7 Language (parked: phone, GPU, Scene Reader)
- 17 Wallpapers, 18 Flowchart/Blueprint/Orbital, 23 Appearance (held until Section 6)
- 21 setup walkthroughs: Instagram reconnect + expiry, n8n key and webhooks, Maps home in settings, Calendar route pick

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
| section-26-engine (keeper, 20:00) | cargo lib 1,716 pass; 5 failed under load = 1 known CRLF scan (allm) + 4 real-browser tests that pass alone (re-run 4/4 ok); engine_route 9/9; pytest + vitest unchanged since 2b44e0f (1,975 / 3,498 pass) | 11-27 20:00 |
| section-26-engine (2b44e0f, origin/main 3d2e38d merged) | pytest 1,975 pass, 1 skip; cargo lib 1,715 pass, 3 known (2 real-browser under load, 1 CRLF scan: allm); vitest 3,498/3,498; tsc clean; release build OK (11 m 51 s) | 11-27 18:15 |
| section-26-engine (756feda) | full pytest 1,841 pass, 1 skip; engine tests 101 + switch 5; test_gateway_tony 80/80; vitest engine 6/6, tsc clean; cargo lib 1,630 pass, 7 fail = 5 load-sensitive real-browser + 2 known CRLF (none in code I changed); pipelines 4/4; GPU bench + CPU smoke 3/3 | 11-27 12:40 |
| main 8647df7 (kill switch merge) | tsc clean; vitest 3,352/3,352; pytest run_all 988 OK; all test_trading_* 748 OK; cargo 1,693 (+2 known CRLF; 1 real-browser test failed under load, passes alone) | 11-27 11:05 |
| Live app (10:41 build, main 0418649), the system.status session's own check | 2 phone-style inbox turns, both answered by the desktop: "Tony, is the droplet up?" -> "Yeah, the Droplet is up and running, Nic..." (system.status 382 ms; droplet 61 ms, from the app's own 15-second check 2 s earlier); "is Docker running?" -> "Yeah, Docker is running good." First words 1.8 s and 1.2 s | 11-27 11:01 |
| main 8647df7 (+ kill switch / options guard hardening) | tsc clean; vitest 3,352/3,352; cargo 1,694 (+2 known CRLF; Edge tests passed) | 11-27 11:30 |
| main 4e69152 (+ section-pass-batch3 overnight batch) | tsc clean; vitest 3,321/3,321; cargo 1,693 (+2 known CRLF; 1 Edge test timed out under load, passes alone) | 11-27 11:20 |
| main e547863 (Director Parts 1-5 + Tony live-test fixes + system.status) | tsc clean; vitest 3,211/3,211; cargo 1,682 (+2 known CRLF; 2 Edge tests timed out under load, pass alone) | 11-27 10:50 |
| claude/tony-live-test-fixes-5d85d5 (+ barge-in) | tsc clean; vitest 2,931/2,931; cargo 1,624 (+2 known CRLF: allm, buildhub; 2 Edge browser tests timed out under load, pass alone); pytest not re-run (no Python changed since the 1,733 run below) | 11-27 02:50 |
| claude/tony-live-test-fixes-5d85d5 (Tony live-test fixes) | tsc clean; vitest 2,925/2,925; cargo 1,625 (+2 known CRLF: allm, buildhub; 1 Edge browser test timed out under load, passes alone); pytest 1,733 (embed flake + 1 socket abort under load, both pass alone; language hub 41/41 after the last prompt change). Not checked in the running app (no rebuild) | 11-27 02:20 |
| claude/unruffled-mayer-1247f9 (system.status, on main 77993c2) | tsc clean; vitest 2,906/2,906; cargo 1,634 (+2 known CRLF; browser tests passed). Rerun 01:25 before the STATUS commit: the same, but 1 Edge test timed out under load and passed alone. Real report on this PC: 8/8 up, droplet 59 ms, whole check 0.5 s. Bionic, real phone-turn messages: "is the droplet up?" 3/3 right; doctored droplet-down 5/5 right, no fix offers or dispatches (without the answer note: 2/3 offered a restart, 1 dispatched a Coder ssh restart) | 11-27 01:05 |
| main 87b6527 (PR #10 + system.status) | tsc clean; vitest 3,021/3,021; cargo 1,628 (+2 known CRLF; 6 Edge tests timed out under load, all 67 quality tests pass alone) | 11-27 10:05 |
| Live app after the 10:41 restart (main 0418649) | Up, no panic.log lines; providers.json STT-hint migration ran (backup `providers.json.20261127-100740-before-stt-gmail-tabs`); 3 phone turns answered by the desktop: droplet "up, 62 ms" (system.status), fresh greeting, Chris recalled; first words 3.6 s cold, then 0.7-0.8 s | 11-27 10:43 |
| main after section-pass + batch3 merge | tsc clean; vitest 2,697/2,697; cargo 1,462 (+2 known CRLF; browser tests pass unloaded); pytest 1,566 (embed flake passes alone); cc-app-restart 18/18 | 11-26 23:15 |
| main (35e30e5) | cargo 1,410 (+2 known CRLF), vitest 2,475, pytest 1,473 (+1 flake) | 11-26 |
| feat/language-hub (1cd5333) | cargo 1,414 (+2 known CRLF); PowerShell cc-app-restart 18/18, ai-startup 6 + 11 + 20 + 7 | 11-26 22:00 |
| claude/vibrant-davinci-742cf7 (recall fix) | cargo 1,419 (+2 known CRLF; 1 Edge timeout under load passes alone) on the 4073bd9 base; memtier + turn_context 24/24 after the rebase onto e0f7ee7 | 11-26 22:20 |
| Tony recall parrot probe (Bionic, 4 reps) | parroted 21/60 -> **0/60** (six test lines 10/24 -> 0/24); planted facts recalled 24/28 -> 28/28 | 11-26 22:10 |
| Live app after the 23:19 restart | 3 phone turns: fresh greeting and dinner answers (no stored reply copied), Joelle Bandits -> Chris recalled; first words 4.5 s cold, then 1.6 s and 1.0 s | 11-26 23:21 |
| Live app after the 23:40 restart (main 0c4341f) | Up, no panic.log lines; 2 phone turns answered by the desktop: live weather (not the stored reply), Chris recalled; first words 3.4 s cold, then 0.8 s | 11-26 23:42 |
| Live app after the 00:31 restart (main dffdb71) | Up, no panic.log lines; Ops migration ran (0 `"ops"` entries left); 2 phone turns answered by the desktop. "Is the droplet up?" now goes to Tony but gets a vague reply, since a phone turn has no live dashboard. First words 3.4 s cold, then 0.6 s | 11-27 00:33 |
| main f555484 (section-pass merged, = section-pass f8ce963 tree) | tsc clean; vitest 3,488/3,488; cargo 1,700 (+1 known CRLF test that fails on main too) | 11-27 UTC |
| section-pass-batch3 (overnight, before merging main) | tsc clean; vitest 2,831/2,831; Python 870 OK; Rust 1,491 (+2 known CRLF; real-browser tests pass alone) | 11-27 |
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
| claude/practical-elbakyan-0f96f1 (5a55ebc, round 4) | tsc clean; vitest 2,937/2,937; test:scripts 12/12; test_trading_* 731/731 (system Python), venv 727/731 (3 known python-multipart, 1 temp-dir cleanup race, now tolerated and 5/5 alone); run_all 950 OK; cargo --lib 1,614 (+2 known CRLF; 7 real-browser tests failed under parallel load, all pass alone); 27 Python + 1 UI mutations all caught | 11-27 10:30 |
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
_Refreshed 2026-11-27 19:50 by `python scripts/update_status.py`._

**Not merged into main yet**

| Branch | Commits ahead | Last commit | Uncommitted |
|---|---|---|---|
| `claude/login-widget-navigation-8ae672` | 31 | `101b292` 2026-11-27 feat(shell): hold-to-switch on the phone's bottom bar + navigation ... | 2 files |
| `claude/gabagoul-section-status-225cdd` | 72 | `33841f2` 2026-11-27 Merge section-26-engine: built-in engine, Engine / Models screen, T... | 1 files |
| `section-26-engine` | 69 | `6e69095` 2026-11-27 docs(status): sidecar, engine live with route_tony off, Test reply ... | 3 files |
| `claude/phone-apk-agentic-os-764f34` | 28 | `bedc23c` 2026-11-27 docs(status): phone APK rebuilt from main 4866634 and installed on ... | clean |
| `feat/language-hub` | 27 | `4866634` 2026-11-27 docs(status): section-pass merged into main (f555484) and pushed | clean |
| `section-pass` | 25 | `f8ce963` 2026-11-27 Merge main (8bb443a: kill switch + options guard) into section-pass | no worktree |
| `claude/upbeat-wing-e87be0` | 11 | `5ca67c0` 2026-11-27 Merge main (196b2f8: Sections 8-10 PR #10) into claude/upbeat-wing-... | no worktree |
| `claude/status-md-tracking-472ac5` | 1 | `6ee8587` 2026-11-27 docs(status): 11.10 and section 12 done, Director and Ops pushes re... | no worktree |
| `feat/ibkr-paper-trading` | 1 | `46778f9` 2026-11-24 fix(trading): fixes from the live paper rehearsal; 3-press kill switch | no worktree |
| `hermes-output-cleanup` | 1 | `15f2ceb` 2026-11-18 fix: parse Hermes v0.23 chat replies and strip ANSI colour codes | no worktree |

**Latest on main**

- `3d2e38d` 2026-11-27 Merge claude/gifted-pascal-abdde6 (GPU session) into main, keeping main's STATUS.md
- `8bb443a` 2026-11-27 docs(status): trading bridge restarted 17:17 on the kill-switch code
- `cf44451` 2026-11-27 docs(status): kill switch shipped (8647df7), app restarted 16:25; bridge restart waits on Nic
- `73ed487` 2026-11-27 docs(status): system.status live check on the 10:41 app, combined main tests
- `8647df7` 2026-11-27 Merge the kill switch + options guard hardening (claude/practical-elbakyan-0f96f1) into main
- `4e69152` 2026-11-27 docs(status): app restarted on main 0418649, system.status live and checked
<!-- /AUTO:BRANCHES -->
