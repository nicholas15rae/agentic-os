# Morning summary, 2026-11-20

This replaces `docs/MEMORY_SCROLLS_MORNING_SUMMARY.md`, which was written before the memory apply and the pipeline work.

## Your memory is now live

`D:\ai-hub-memory` now holds the round-10 preview (token `e55760e550d8`). It went in after a clean four-reviewer check. Both of the booking-scope reviewer's "blocking" items were refuted by both skeptics.

**How it was checked:**
- The 5 scroll bodies are identical to the reviewed preview.
- The archive checksums match (`D:\ai-hub-archive\2026\11\`).
- `C:\ai-hub` is unchanged.
- The `librarian` workspace has exactly the 5 scrolls, and vector search returns them.

Committed as `293153e` (507 Python tests pass).

**Fix in the next memory round:**
- `core/architecture_decisions.md` line 41, "without Librarian + Nic approval", is an unmarked variant of contested rule #4.
- Line 17 of the same file still describes the old `agents/` layout.
- `projects/ai-hub.md` line 28 mixes up Mortadella and Droplet.
- `projects/agentic-os.md` lines 45–49 list features that are already built under Open Threads.
- `projects/agentic-os.md` is over its size target (3995 B against 3072).

## The voice → Tony → build pipeline

I started this one at your request: "make sure the voice to prompt to create pipeline is solid", plus "documentation between ai agents and tony is documented in the app chat".

**1. Audit and hardening** (`bf5f869`).
- I audited 29 parts of the pipeline, from mic capture through Tony's turn, brainstorm, offer and park, Build Hub intake, Play Place, worker, staging and events.
- Each finding was checked by two independent skeptics. 134 were confirmed and fixed, each with a regression test.
- What you'll notice:
  - hands-free listening comes back after an error;
  - long continuous sessions no longer lose audio;
  - "cut it" only cuts a bare command;
  - a delegated task keeps your exact words;
  - a long brainstorm's later refinements reach the build;
  - cancel shows as "Stopped";
  - a missing LM Studio makes builds wait instead of failing;
  - hub repair passes stay in the same folder.

**2. Agent conversation feed in the chat** (`82c8184`, review fixes `c2aa27c`).
- Every build or delegation now gets one teal card in the chat: Agent pipeline, Play Place build, Delegation or Claude Code run.
- Click the card to see every message, in order: who sent it to whom, the stage, and the time. **Show full message** opens the whole prompt or reply.
- To find it: left rail → Agents → Auto-route tab, or the tab the build was asked in. Cards are also in the Voice Console and the HUD.
- The new **Agent Log: On/Off** switch sits next to Agent Chatter. Spoken cues are unchanged.
- Messages are stored scrubbed in `transcripts.db` and rebuilt after a restart.
- A review pass then found and fixed 9 more issues, including:
  - hub cards that could vanish;
  - a delegation card that wrongly pre-approved tool use;
  - "cut it, …" heard without the wake word running the rest of the line.

**3. Quality gate, probes and honest verdicts** (`d4da98f` → `2005af9`), all driven by the protein test below.

**Merged** into `feat/thoughtform-pipeline` as `d1b9a0e`. Gates at the merge:
- `cargo test --lib`: 930 passed, 29 ignored.
- `tsc`: clean.
- vitest: 1613 passed.
- Python: 507 passed.

The merge also fixed one test (`review6_23`) that broke on Windows line endings.

## Opening the Command Center

```powershell
cd "D:\Art Apps\agentic os\command center"; npm run tauri dev
```

To find a build's agent conversation, go to the left rail → **Agents** → **Auto-route**, then click the teal card. Every prompt and reply between Tony and the agents is there, in order. **Show full message** opens the whole text. A build that still has open problems now reads *"is staged but needs fixes: N known blockers"* instead of a neutral "ready".

## The protein app test

I told the pipeline what you'd have told Tony: *"make me an app just for calculating my protein intake. I'm 165 lbs…"* (default 165 lb with a lb/kg toggle, activity presets, a daily target range, a 3–5 meal split, and a running food tally, working offline). Everything ran on your local qwen3.5-9b through LM Studio, with no paid APIs. Each run went through all the agent stages and was then checked by hand in a browser.

| Run | Pipeline version | Time | Crashes | What the app actually did |
|---|---|---|---|---|
| 1 (03:59) | before tonight's gate | 165 s, 0 loops | none | **Looked fine, didn't work.** Defaulted to 75 kg (not 165 lb). No lb/kg toggle. Grams never saved, so progress never moved. Loaded Tailwind from the internet. The verifier said "pass" in 2 s without checking anything. |
| 2 (05:45) | `d4da98f` quality gate | 456 s, 2 loops | none | **Much closer.** Default 165, the target shows, and adding foods moves the progress bar. Still broken: the kg toggle didn't convert, the meal buttons read 3, 5, 4, and "muscle gain" gave 264–363 g/day. |
| 3 (07:04) | `225247b` behavioural probes | 537 s, 2 loops | none | **Toggle and order fixed.** 165 lb → 74.8 kg, meals 3/4/5, realistic g/lb presets (active = 132–165 g). Still broken: the target shows "Loading..." until you touch a control, and the grams input is missing from the add-food form, so adding food throws. The gate caught both, but only on the last allowed pass. |
| 4 (09:31) | `e52c677` honest verdicts | 494 s, 2 loops | none | **Honest result.** It was staged as *works = false, needs fixes, 8 known blockers*, and Tony's line said so ("Built, but 8 things still don't work…"). The food tally works. Still broken: the weight box is empty on load (the target is still computed from 165), the kg toggle multiplies instead of dividing ("363.8 kg"), and the presets are off (muscle gain 264–363 g). The probes caught the toggle and the empty default, but only on the last pass. |

**What I changed in the pipeline because of these runs** (each change was adversarially reviewed and fixed, with Rust tests going from 862 to 930, all green):
- **Quality gate** (`d4da98f`). Covers offline-only builds (no CDNs), your exact values carried through every stage and checked in the page, missing element ids, unguarded storage, and a headless-Edge runtime smoke that catches crashes.
- **Behavioural probes** (`af2bc62`, `225247b`). The verifier can no longer just quote code. It must write small click/type/expect tests, which actually run in a sandboxed headless Edge with no network. A failing probe sends the build back to the Coder with an exact line, for example *"expected #weight ≈74.8, got 165"*.
- **Required probes and pinned values** (`e16cdea`, `3722b28`).
  - Anything that changes, converts or totals must be proven by a probe that ran.
  - The expected numbers come from your words, computed in Rust, not from the model's guess: 165 lb shown on load, 165 lb → 74.84 kg, and options 3/4/5 in order.
  - The prompt examples no longer give away the protein answers.
- **Honest verdicts and the run-3 fixes** (AD-13, `9e6976c` → `2005af9`):
  - The 9B's string-style probe values (`"132 - 165 g"`) are read correctly.
  - A stuck "Loading..." after load fails the gate.
  - The Coder gets one extra repair pass when the gate still fails on the last loop.
  - A build that still has open problems is recorded as **works = false / needs fixes**, and its summary says so instead of "passes".
- **Critic rounds 2–3** (`ed8cbd2`, `2005af9`). A replay harness ran the real run-2 and run-3 pages, plus hand-corrected copies, in real Edge against 9B-shaped verifier replies. The rule:
  - every broken page must stay *needs fixes*;
  - a corrected page with valid probes must pass with zero wasted Coder loops.

  Fixes from these rounds:
  - a read before an action is allowed;
  - value checks need a real number;
  - an action has to change something;
  - "NaN"/"undefined" written by a script is caught anywhere on the page;
  - the Coder loops only for problems the page itself causes;
  - a missing probe is reported as "couldn't be checked", not sent to the Coder.

The run artifacts are in `staging/`: `protein-tracker` (run 1), `protein-tracker-2` (run 2), `protein-intake-tracker` (run 3), `protein-tracker-3` (run 4).

### How the pipeline performed, in short
- **Stability:** 4 overnight runs with no crashes, hangs or lost tasks. Every stage handed off, and every run reached staging (about 8 minutes each on the 9B).
- **Honesty:** after the fixes, the pipeline no longer calls a broken app finished. Run 1 said "pass" on a broken page; run 4 said "8 things still don't work" and named them.
- **Quality:** each run got closer (75 kg default → 165 → toggle/order fixed → tally works). A 9B model still won't land a multi-feature app in 2 loops on its own. The weak spot was timing: the behaviour tests ran only on the last pass, so the Coder never got the chance to fix what they found. That is now fixed (see the follow-up rounds below).


## Follow-up rounds (done, merged)

Rounds 4–7 of AD-13 (`32aacbe` → `3848522`) fixed the problems that run 4 and the critic exposed. Each round was reviewed by two skeptics per finding and re-run against the replay harness in real Edge:
- 32 scenarios, built from the real run-2/run-3 pages plus corrected copies.

**What changed:**
1. **The behaviour tests run on every pass that loads.** Before, they ran only on the last one. The Coder now gets the gate items and the behaviour bugs together, while it still has passes left to fix them.
2. **The Librarian labels earlier builds honestly.** It used to say "three ready-to-use modules" about broken earlier runs. Now builds read *ready*, *needs fixes (N known blockers), not reusable*, or *unverified*. Only *ready* may be suggested for reuse, and the Librarian says it sees names only, not code.
3. **A probe with a wrong expected number goes back to the verifier once** before the Coder is asked to "fix" a correct page.
   - If the verifier keeps the number, it becomes a known blocker.
   - If the verifier switches to whatever the page shows, the build can't pass on that. It is marked unverified, and the line says what changed.
4. **New *unverified* verdict** (amber, "N things couldn't be checked"). It is used when nothing failed but something couldn't be proven.
   - A fix the verifier still asks for at the limit counts as **needs fixes**.
   - A bare "loop" with no fix named does not.
5. **A zero you ask for is accepted** ("no tip", reset), but a zero the verifier copies is rejected. Running tallies have to change when you add food.
6. **Tony's spoken summary drops the internal labels.** It says "N things still don't work" or "N things couldn't be checked".

**Replay results:**
- Every broken page stays *needs fixes*.
- Correct pages with valid checks pass with **zero** extra Coder loops.
- A correct page where the verifier insists on a wrong number now costs 1 Coder loop instead of 2.

**Merged** into `feat/thoughtform-pipeline`. Gates:
- `cargo test --lib`: 950 passed.
- `tsc`: clean.
- vitest: 1614 passed.
- Python: unchanged since the first merge (507 passed).

**Not re-tested live yet.** A fresh protein run (run 5) through the real 9B is the next real check. The replay harness uses scripted verifier replies.

## What's left / for you to decide

**Gaps the completeness critic found, not done yet:**
- A delegated turn that you cut off isn't recorded as a card.
- Approved gateway CLI agent actions don't show Tony's outgoing prompt.
- Your Play Place actions (pause, requeue note, promote, remove) don't land on the build's card.
- There's no screen for browsing older agent conversations: cards only cover the newest 50.
- Cards always land in Tony's thread, not the thread that started them.
- Voice Tier-3 builds skip the Build Hub, so they get no smoke test, repair or Live Peek. Is that intended?

**Memory decisions (unchanged):**
- **Contested rules.** #4: is the Librarian the only rule writer? #5: the escalation ladder. #6: is "ai-hub is the single source of truth" meant unscoped?
- **Identity scroll.** Two borderline "Standing Rules" lines.
- **AI Hub roadmap.** The friend-testers line.
- **Repoint by hand.** The AnythingLLM KG MCP `MEMORY_FILE_PATH` should now point to `D:\ai-hub-memory\knowledge-graph.json`. The sqlite MCP still points into `C:\ai-hub\memory`.
- **Memory Vault folder.** Pick a new one.
- **Stale `brain/` lines.** These are yours to edit.

**Design choice I made:**
- Worker builds may no longer use CDNs (Tailwind and others).
- Everything is inline, so the app works offline and in a sandboxed preview.
- The older `pipeline.rs` prototype path still allows the CDN. Tell me if you want CDN builds back for online-only projects.
