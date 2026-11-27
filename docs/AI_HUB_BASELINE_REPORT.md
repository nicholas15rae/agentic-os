# C:\ai-hub as a read-only baseline for Memory Scrolls (2026-11-19)

> **Review before commit.** This file is in public `docs/`. It holds categories, counts, file paths,
> line numbers, hashes and short technical paraphrases only. It holds no personal values: no names other
> than the operator's first name, no places, money, dates of birth, body, family, business or contact
> details. Check it again before committing.

**Preview:** `staging/memory-scrolls-preview/20261119-151225/` (gitignored). **Token:** `04a502a35827`.
Nothing was applied. `--apply` was not run. Nothing under `C:\ai-hub` was written.

> **Update (2026-11-19 18:44): this preview and its token are superseded.**
> - Nic decided that the live scrolls and KG live in `D:\ai-hub-memory` (`scrolls\` and
>   `knowledge-graph.json`), and that `C:\ai-hub` stays read-only. The defaults moved (Python, Rust,
>   Settings), and every Memory Scrolls writer now refuses any target under `C:\ai-hub`. The "apply target
>   inside the hub" blocker is **resolved** (conflict 15, issue 10.1).
> - The gateway-chat Booking gap is **fixed** (issue 10.2).
> - `--apply` now refuses `04a502a35827` (manifest schema v2).
> - The new preview is `staging/memory-scrolls-preview/20261119-184425/`, token `fe63a4abe283`. It is
>   extractive, because no model was loaded. Details are in `docs/MEMORY_TIERING_REPORT.md` section 7.

## 1. Verdict

- **Read-only rule: held.** `C:\ai-hub` is byte-identical, with identical mtimes, before and after both
  dry-runs (9,657 files and 1,258 directories compared; see section 3).
- **Privacy: held for everything that came from `C:\ai-hub`.** No contact details, places, money, ages,
  body, family, health, third parties, life plans or business names from the hub reached a scroll
  body, the KG preview or anything that would be embedded. One business-name abbreviation is the only
  hub-derived item that is borderline (section 6, item 1).
- **Never-lock: held.** 12 locked bullets come from the hub (6 architecture, 6 identity). All are
  standing rules or core preferences; none is a one-off, a status or an idea. The ai-hub project scroll
  locks nothing (9 bullets moved out by the transient-target rule).
- **Not ready for `--apply` as it stands.**
  1. ~~The default apply targets are `C:\ai-hub\memory\scrolls` and `C:\ai-hub\memory\knowledge-graph.json`,
     inside the read-only hub.~~ **Resolved:** the defaults are now `D:\ai-hub-memory\scrolls` and
     `D:\ai-hub-memory\knowledge-graph.json`, and any target under `C:\ai-hub` is refused.
  2. `projects/agentic-os.md` (fed by chats, not by the hub) has three new locked bullets: one is a wrong
     "mutation default" policy, and one Booking hand-off task sits in Active State. Review them first.
  3. Four architecture conflicts between the hub and Agentic OS need a decision from Nic before they
     should be locked (section 5, items 1-5).

## 2. Gates and preflight

- `python tests/run_all.py`: **327 OK** before any change. **328 OK** after the one fix in this pass
  (section 4). No Rust or TypeScript was touched, so the npm and cargo gates were not needed.
- **Preflight (both runs).**
  - LM Studio :1235 had exactly one loaded model (`qwen/qwen3.5-9b`); 13 models are downloaded.
  - The `llama-server` process used 0 s of CPU over 2.5 s, and GPU use was 0 % on repeated samples.
  - The desktop app was not running.
  - The gateway did not answer `/api/os/gpu` (old or stopped), so the run used `--assume-idle`.
- **No-write baseline** (`p3-smoke/baseline.py`): identical before run 1, after run 1 and after run 2:
  - `C:\ai-hub\memory` (1 file, 0 B); no knowledge graph; no `C:\ai-hub\memory\scrolls`.
  - `D:\ai-hub-archive`, repo `archive/` and `data/memory-scrolls/` are all absent.
  - `.env`, `os.json` and `providers.json` have the same size and mtime.
  - The AnythingLLM document lists are unchanged (0 documents in each of the 5 allowlisted workspaces).
- **AnythingLLM saw GET only.** Each run made 10 requests: workspace and chats for `coder`, `designer`,
  `librarian`, `ops` and `prompter-dispatcher`. `my-workspace` and `booking` were never requested.
- **Secret scan of the new preview:** 0 hits for the 12 known secret values, and 0 token-shaped strings,
  emails or IP addresses. The only digit runs are timestamps and hashes.
- **Read-only `_promote_plan` check** (the `--apply` preamble without writes):
  - `20261119-151225` **passes** with no warnings.
  - `103034`, `120122` and `125553` are **refused**: they predate the privacy filter.
  - `141404` is **refused**: it was made under privacy policy v2, and the policy is now v3.
  - `150608` (run 1 of this pass) still passes, because the policy did not change, but it is
    **superseded**. Do not apply it: it carries the status-file write rule fixed below.
- **Older previews:** all 36 files of the five older previews were hash-checked before and after both
  runs, and none changed. Two new folders were added: `20261119-150608` and `20261119-151225`.

## 3. C:\ai-hub unchanged: proof

Method: a read-only walk of `C:\ai-hub` (no symlinks followed) recorded size and mtime for every file
and mtime for every directory. It also recorded sha256 for every file outside the denied areas.
Denied areas (booking, `tasks/`, the messaging-bridge folder and `.git/`) were stat'ed only, never
opened. No git command ran in the hub.

| Snapshot | Files | Dirs | sha256-hashed | Differences vs before |
|---|---|---|---|---|
| Before run 1 | 9,657 | 1,258 | 5,098 | n/a |
| After run 1 | 9,657 | 1,258 | 5,098 | **0** |
| After run 2 | 9,657 | 1,258 | 5,098 | **0** |

The top-level and `master/` files (sha256 shown as the first 12 hex characters):

| Path | Bytes | mtime | sha256 | Used as a source? |
|---|---|---|---|---|
| CLAUDE.md | 274 | 2026-11-14 20:56 | b9f9f38ecf89 | yes |
| .clinerules | 274 | 2026-11-14 20:56 | b9f9f38ecf89 | byte-identical duplicate of CLAUDE.md, read once |
| GEMINI.md | 728 | 2026-11-14 20:56 | 2c3271c5c1cd | yes |
| README.md | 29 | 2026-11-13 09:46 | ab6ad80fc9a2 | no (not on the allow-list) |
| master/AGENTS.md | 2,148 | 2026-11-14 20:56 | 9760fcd531fe | yes |
| master/AGENTS_NEVER.md | 1,731 | 2026-11-14 20:56 | 5b9c3abc1722 | yes |
| master/INDEX.md | 1,731 | 2026-11-15 11:57 | c4254e324c19 | yes |
| master/MASTER_IDENTITY.md | 14,337 | 2026-11-15 12:26 | 0dae4727df05 | 6 allow-listed sections only |
| master/ROADMAP.md | 1,879 | 2026-11-14 20:56 | a2d9915d79f7 | yes |
| master/SKILLS.md | 4,462 | 2026-11-13 23:07 | 51116b6eef37 | no (stale inventory, skipped) |
| master/STATUS.md | 4,784 | 2026-11-15 12:26 | 74e28f430840 | 5 sections |
| master/SYSTEM.md | 1,842 | 2026-11-14 20:56 | 1b792dfd52f5 | yes |
| master/handoffs/CURATION_PROMPT.md | 2,827 | 2026-11-14 20:56 | fd502f7f0e8e | no (one-off job, skipped) |
| master/handoffs/HANDOFF_CODING.md | 1,063 | 2026-11-14 20:56 | 42e24f4d9e1a | 2 blocks |
| master/handoffs/HANDOFF_DELEGATION.md | 954 | 2026-11-14 20:56 | 56b56cb79a2c | 2 blocks |
| memory/agentic-os.sqlite | 0 | 2026-11-18 08:37 | (empty) | no (denied) |
| protocols/booking-templates.md | 1,978 | 2026-11-15 11:57 | not opened | **no (denied: booking)** |
| skills-lock.json | 23,154 | 2026-11-13 11:49 | c3af0e8ca1a2 | no (denied) |

The per-run hashes of every hub file read are also in the preview's `manifest.json` (`hub_sources`).

## 4. Runs in this pass, and the one fix

1. **Run 1** (`20261119-150608`, token `211e1ce1d9ed`, now superseded):
   - 12 LLM calls (11 planned plus 1 accepted size repair, budget 16).
   - 5 model-written scrolls, 10,483 B in total, with 0 extractive targets.
   - Reading it found a defect: the hub's "end every session by updating the status file" rule
     (`AGENTS_NEVER.md:27`) reached the architecture Guardrails. The input filter caught "update",
     "updates" and "updated", but not "updating".
2. **Fix** (Python only):
   - `memory_scrolls/offload.py` `_HUB_STATUS_WRITE` now also matches "updating", "filling in",
     "writing" and "editing", and a "last session ... STATUS" phrasing.
   - `TRANSIENT_HINT` now says roadmap lines are planned work, never done, reviewed or locked. Run 1
     had stated a roadmap to-do (reviewing and locking the identity and hard-rules files) as done.
   - Tests: the fixture `AGENTS_NEVER.md` gained the "updating" phrasing, and a new test,
     `test_status_write_rule_phrasings`, covers 5 drop and 4 keep lines. Gate: 328 OK.
   - The privacy policy and manifest schema did not change.
3. **Run 2** (`20261119-151225`, token `04a502a35827`, **current**):
   - 11 of 11 planned LLM calls (budget 16), with 0 repairs.
   - 5 model-written scrolls, with 0 extractive, 0 pending and 0 partial targets. No larger-budget
     re-run was needed.
   - 6 status-write lines dropped (5 in run 1). The rule is gone from every scroll.

## 5. Per-scroll result (run 2)

| Scroll | Mode, size | Locked bullets (durable / one-off) | Fed by the hub? |
|---|---|---|---|
| core/architecture_decisions.md | model, 1,665 B | Locked Design Decisions: **6 / 0**. Guardrails (not a locked heading): 9 | CLAUDE.md, GEMINI.md, AGENTS.md, AGENTS_NEVER.md, INDEX.md, SYSTEM.md, STATUS "Decisions locked" |
| core/identity_and_preferences.md | model, 2,296 B | Standing Rules: **6 / 0** | MASTER_IDENTITY (6 sections), GEMINI "How Nic works", both handoff working-style blocks; also brain/constitution, constraints and identity |
| patterns/lessons_and_fixes.md | model, 938 B | no locked heading | STATUS "Broken / open", handoff end-of-job lists; also chats and logs |
| projects/agentic-os.md | model, 1,433 B | Locked Decisions: **3 new**. 1 durable, 1 architecture fact in Booking scope, 1 wrong (see section 9) | **no** (brain, chats, threads, logs) |
| projects/ai-hub.md | model, 1,756 B | **0** (never-lock moved 9 new bullets to Active State) | ROADMAP (8 sections), STATUS "Working" and "Next steps" |

Total: 8,088 B (run 1: 10,483 B). The KG preview has 22 entities:
- 8 identity: the operator (role and working style only), the "Jarvis" persona, three work projects,
  the personal agent app, the settings path and the audit trail
- 2 lessons
- 4 Agentic OS project
- 8 ai-hub project

No entity holds an excluded personal category. One entity is named with a business abbreviation (see
section 6, item 1).
Never-lock moved 10 bullets in all (1 architecture, 9 ai-hub). Nothing was re-locked.

**Locked bullets from the hub, all durable:**
- Architecture:
  - the escalation ladder (local, then Gemini, then Claude)
  - the Librarian as the only rule writer, with Nic's approval
  - one Git commit per approved rule change
  - keys outside the repo, in a keys folder
  - no model files in Git
  - the small-model load budget (index, status, hard rules, own card, plus one or two files)
- Identity:
  - identity changes go only through the Librarian, with Nic's approval
  - the worth-it decision filter (pay, help someone, or lead somewhere)
  - low-pay work can be worth it for other value
  - no projects that go nowhere
  - every project needs a finish line
  - flag all-eggs-in-one-basket risk

## 6. What was pulled in from C:\ai-hub

Short technical paraphrases; no personal values.

| Hub file | Scroll(s) | Kept |
|---|---|---|
| CLAUDE.md (= .clinerules) | architecture | Hub read order (index, then status, then hard rules; load only what the task needs). The status-file write line was dropped. |
| GEMINI.md | architecture, identity | The backup-coder role of Gemini, and the "How Nic works" line: short plain answers, one step at a time, full-file replacements, test each step. The status-file write line was dropped. |
| master/AGENTS.md | architecture | Escalation ladder; hub agent roster (Conceptualizer, Dispatcher, Coder, Reviewer, Librarian); Librarian rule-writing loop; training loop. The Booking agent section was dropped. |
| master/AGENTS_NEVER.md | architecture | All NEVER rules: no fabrication about the operator, never send (drafts only), never delete (move to review), never spend or sign up, no secrets in the repo or prompts, no unapproved installs, the messaging bridge stays read-only, targeted fixes, test before the next step, label assumptions. ALWAYS: ask when unsure, short and plain, cite sources. The status-file write rule was dropped. |
| master/INDEX.md | architecture | One fact per file, flag disagreements, Librarian-only edits with one commit per change, the small-model load budget. 2 booking lines and the status-write exception were dropped. |
| master/SYSTEM.md | architecture | Model server on port 1235, the agent hub, the local coder, the web-search choice, repo layout, Git and backup policy. 2 booking lines were dropped. Machine hardware is allowed as system hardware; the scroll keeps only the model-server line. |
| master/STATUS.md | architecture, lessons, ai-hub | "Decisions locked" goes to architecture. "Broken / open" goes to lessons (a coder model that ignores tool calls, local custom MCPs that do not connect, a failed one-shot build, a TTS quality issue, failed downloads). "Working" and "Next steps" go to the ai-hub project scroll (MCP list, model and bridge wiring, the next-step list). |
| master/ROADMAP.md | ai-hub | Phases 1-4, 6 and 7 as open threads. The Booking phase heading was dropped. |
| master/MASTER_IDENTITY.md | identity | Only the preamble ("ask, never guess"), the worth-it decision filter, voice and communication style, the Tech part of the tech module (work projects, local AI, delegating well), how agents use the gear list, and how the ideas list works. |
| master/handoffs/HANDOFF_CODING.md | identity, lessons | Working style (small stages, full-file replacements, plain language, targeted fixes, no keys or models in Git). End-of-job list (changed files, how to test, commit message). The status-block item was dropped. |
| master/handoffs/HANDOFF_DELEGATION.md | identity, lessons | Rules (no fabrication, flag uncertainty, short and plain, stop at the finish line). End-of-job list. The status-block item was dropped. |

**Hub-derived items worth a second look:**
1. Identity `## Identity` (scroll line 14), and one KG entity, name one of the operator's own projects
   by a business abbreviation. It comes from the MASTER_IDENTITY Tech section (:201), an allowed
   section, and there is no generic detector for business names. Nic can add the abbreviation to
   `deny_terms`. The same KG entity, and two others, add an invented "Status: active" observation.
2. Identity `## Communication Preferences` keeps the VOICE section, including two lines that border on
   personality ("quirky or nerdy when pushed", "open book, but people have to ask"). VOICE was kept on
   purpose as communication style.
3. Identity `## Identity` carries a nickname and an agent-persona line (from chats, not the hub). The
   persona line maps "Jarvis" to the Prompter. In the Command Center, Jarvis is an alias for Tony.

## 7. What was filtered out (counts and categories only)

**Before anything was read.**
- Denied and never opened or traversed: booking (1 file), `tasks/` (it holds a personal .eml), the
  messaging-bridge folder, `.git/`, `memory/`, `parking-lot/`, `skills-lock.json`, `agents/` and the tool
  folders (`.agents/`, `.claude/`, `.impeccable/`).
- Skipped with a reason: 1 stale inventory (`SKILLS.md`) and 1 one-off job (`CURATION_PROMPT.md`).
- Duplicate: 1 (`.clinerules`).

**Section and line guards (before the model).**

| Hub file | Sections kept / skipped | Booking lines dropped | Status-write lines dropped | Privacy (input) removed |
|---|---|---|---|---|
| CLAUDE.md | 1 / 0 | 0 | 1 | none |
| GEMINI.md | 2 / 0 | 0 | 1 | none |
| master/AGENTS.md | 8 / 3 | 0 | 0 | none |
| master/AGENTS_NEVER.md | 3 / 0 | 0 | 1 | none |
| master/INDEX.md | 4 / 0 | 2 | 1 | none |
| master/MASTER_IDENTITY.md | 6 / **28** (default-deny) | 0 | 0 | none (the denied sections never reach the filter) |
| master/ROADMAP.md | 8 / 1 | 1 | 0 | finance 1, life plans 1 |
| master/STATUS.md | 5 / 4 | 1 | 0 | finance 1, location 1 (time zone) |
| master/SYSTEM.md | 5 / 1 | 2 | 0 | none |
| master/handoffs/HANDOFF_CODING.md | 2 / 2 | 0 | 1 | none |
| master/handoffs/HANDOFF_DELEGATION.md | 2 / 1 | 0 | 1 | none |
| **Total** | **46 / 40** | **6** | **6** | **finance 2, life plans 1, location 1** |

**MASTER_IDENTITY default-deny.** 28 of 34 sections were never sent to the model; about 171 of 199
non-empty lines. By heading, the categories dropped are:
- location, date of birth / age, family, personality and schedule (the core profile, goals and stall
  pattern)
- finance (income goals, money values, minimum pay, a percentage fee, pricing, trading)
- life plans and possessions (land, vehicle, home hub)
- the whole acting module: body attributes, intimacy boundaries, licence and firearms handling,
  casting platforms, a talent rep, booking rules, employment history
- the nutrition and business module: credentials, health-adjacent training, business and corporation
  names, a business partner
- the contracting module: family trade, region, pricing
- creative gear and plugins, lesser-known skills and hobbies, and the current ideas list

**Output filter (after the model).** Run 2: 0 removals; all five replies were clean. Run 1 removed 1
location line from a chat-fed project reply.

## 8. Conflicts between C:\ai-hub and Agentic OS

Each item was checked again against the files on disk. "hub:" is `C:\ai-hub\`. "aos:" is the repo.

| # | Conflict | Evidence | Recommended resolution |
|---|---|---|---|
| 1 | Agent roster | hub master/AGENTS.md:10-39, SYSTEM.md:25, ROADMAP.md:19 (Conceptualizer, Dispatcher, Coder, Reviewer, Librarian, Booking) vs aos AGENTS.md:62-68 and data/agent-routes.json (opencode, Hermes, agy) vs Command Center agent_prompts.rs:9-14 (Tony, Prompter, Designer, Coder, Librarian, Booking Desk). The hub `agents/*` folders hold only `.gitkeep`. | The Command Center roster is the live one. Have the Librarian record aliases in the hub: Conceptualizer to Tony, Dispatcher to Prompter, Reviewer to the Prompter review loop plus the Librarian audit, Booking to Booking Desk. Mark aos AGENTS.md routing as legacy. |
| 2 | "Dispatcher" and "Jarvis" names | routing.rs:56,59 and roles.rs:205 make "dispatcher" and "jarvis" aliases of Tony. agent_prompts.rs:14 and hub AGENTS.md:17-21 make the dispatcher the Prompter. **New:** preview identity:9 calls Jarvis the Prompter. | Nic picks one meaning per name. Until then, keep persona names out of locked bullets. |
| 3 | Gemini vs agy | The hub uses the Gemini app and AI Studio (AGENTS.md:4,35; GEMINI.md:11; SYSTEM.md:14; STATUS.md:45). aos AGENTS.md:446 replaced Gemini CLI with agy, but brain/identity.md:4, business-brain.md:4,8,21, memory.md:4 and recent-decisions.md:5 still say Gemini CLI. The Command Center keeps gemini-cli and gemini-api as second-opinion engines (agents.rs:1689,1692). | Name products exactly: the Gemini app (hub backup coder), Gemini CLI or API (Command Center second opinion), agy (legacy aos routing). Update brain/ (Nic's call; brain/ was not edited). |
| 4 | Librarian authority | Hub: sole rule writer, commits with approval (AGENTS.md:33-35, INDEX.md:8, AGENTS_NEVER.md:11, STATUS.md:46). Agent prompt: strictly read-only researcher (agent_prompts.rs:213-224). The preview locks "Librarian is the ONLY agent that writes rules" (architecture) and "changes only through the Librarian" (identity). | Read the hub rule as being about hub rule files, with the human approving, and the AOS Librarian as read-only inside AOS. Ask Nic before `--apply` whether these two locked bullets should say "ai-hub rules". |
| 5 | Escalation and routing | Hub ladder: local, then Gemini, then Claude (AGENTS.md:4, STATUS.md:45), locked in the preview. aos AGENTS.md:62-68: opencode-first. Command Center: Tony, then Tier-3 workers, then second-opinion engines. | Lock only after Nic confirms. Suggested reading: the hub ladder is for the human's own escalation of whole jobs; AOS routing is per task inside the app. |
| 6 | Single source of truth | Hub STATUS.md:44, INDEX.md:7 vs aos AGENTS.md:341,450 | Scoped: the hub for operator, rules and hub layout; aos AGENTS.md for the codebase. |
| 7 | Models | aos AGENTS.md:317, brain/memory.md:17 and business-brain.md:21 (an OpenRouter model and a free opencode model) vs hub SYSTEM.md:9-10, STATUS.md:5 and memory_scrolls/config.py:24 (local LM Studio :1235, Qwen 3.5 9B). Run 1 locked the stale models in the Agentic OS project scroll. Run 2 did not, but the brain/ sources will bring them back. | Local Qwen is current. Fix brain/memory.md and business-brain.md, and the aos AGENTS.md user profile. |
| 8 | Operating system | aos brain/constraints.md:14 (Linux/WSL) vs the real Windows host (hub paths, Store installs). | The run 2 identity scroll no longer states Linux, but the source is unchanged. Fix brain/constraints.md:14. |
| 9 | Budget | aos brain/constraints.md:4-6, constitution.md and AGENTS.md:314 ("zero paid services", a free-tier list) vs hub notes on a paid AI plan and a cloud droplet (finance; values withheld). | $0 applies to agent actions (hub AGENTS_NEVER.md:4). The scrolls keep "free-tier first; never recommend paid services without warning" and no plan details. Correct. |
| 10 | Active projects | aos brain/active-projects.md:3-12, business-brain.md:22 and memory.md:14 name a GCP e-commerce project that the hub never mentions. The hub's projects are Scene Reader, the Estimator, the personal agent app and Booking. | Nic confirms whether that project is still active. If not, archive it in brain/. |
| 11 | Communication style | aos brain/identity.md:14 ("complete context, not summaries; first-principles") vs hub GEMINI.md:13, AGENTS_NEVER.md:22-23, HANDOFF_CODING.md:20-25 and MASTER_IDENTITY VOICE (short, plain, one step and one question at a time). | **Resolved in the preview:** the identity scroll keeps the hub style. Mark brain/identity.md:14 as the agent's own style, or change it. |
| 12 | Code delivery | Hub: full-file replacements (GEMINI.md:13, HANDOFF_CODING.md:22, AGENTS_NEVER.md:14) vs AOS agents applying targeted edits | Scope it to code handed to Nic to paste. It is kept unlocked in the preview (identity Communication Preferences; architecture Guardrails). |
| 13 | Commit policy | aos AGENTS.md:338 and brain/constitution.md:26 ("git commit after every change") vs hub INDEX.md:8, STATUS.md:46 and SYSTEM.md:34 (one approved commit per change), and the current practice that agents do not commit | The preview locks the hub version. Fix aos AGENTS.md:338 and constitution.md:26. |
| 14 | Session-end write rule | Hub CLAUDE.md:9, .clinerules:9, GEMINI.md:15, AGENTS_NEVER.md:27, INDEX.md:9 and both handoffs | Hub protocol, never an AOS step, and it conflicts with the read-only rule. Fixed in this pass: all 6 instances are dropped before the model, and none is in the preview. |
| 15 | Apply target inside the hub | memory_scrolls/config.py:20-21 default the scrolls and KG to `C:\ai-hub\memory`. Hub STATUS.md:9 names a KG file there that does not exist. | **Resolved (Nic's decision).** The defaults are now `D:\ai-hub-memory\scrolls` and `D:\ai-hub-memory\knowledge-graph.json` in `memory_scrolls/config.py`, `os_core.rs` (`DEFAULT_SCROLLS_DIR`, `DEFAULT_KG_PATH`; the app's `kg.search` MCP reads the same file) and the Settings placeholder. Every writer, and the app's `scrollsDir`, refuses any target under `C:\ai-hub` (case-insensitive, junction-safe). Previews now record their hashed write targets. The AnythingLLM `knowledge-graph` MCP entry outside the repo still names the old hub file; Nic repoints it by hand. |
| 16 | Repo location | aos AGENTS.md:16,180 (`~/Desktop/Agentic OS Project/`) vs the real `D:\Art Apps\agentic os` | Fix aos AGENTS.md. |
| 17 | SQLite MCP | Hub STATUS.md:40 ("archived, don't use") vs the read-only sqlite MCP pinned in Nic's own setup | Nic decides; record it in the hub through the Librarian. |
| 18 | Roadmap vs reality | Hub ROADMAP.md:37-39 puts the personal desktop and Android app at Phase 7 "later", but the Command Center exists. ROADMAP.md:19-21 lists core-agent prompts "to write", but they exist in agent_prompts.rs. STATUS.md was last updated 2026-11-15. | Have the hub status refreshed by its owner (not by AOS). |
| 19 | Draft status | MASTER_IDENTITY.md:1 is a v1 draft. STATUS.md:55 and ROADMAP.md:6 say it and AGENTS_NEVER are to be reviewed before lock. | The preview locks only rules already settled in the hub ("Decisions locked", AGENTS_NEVER, the working-style blocks) plus the decision filter. Run 2 states the lock as pending, correctly. |
| 20 | **New:** auto-install | aos scheduler/scheduler.py:154-157 pip-installs APScheduler on its own. aos AGENTS.md lists a one-command installer. Both conflict with hub AGENTS_NEVER.md:8 (no package installs without approval). | Make the scheduler fail with an install hint instead of installing. |
| 21 | **New:** sending channels | aos AGENTS.md:59,121 (Telegram, Discord, email and webhook channels) vs hub AGENTS_NEVER.md:2,9 (never send; the bridge stays read-only) | Treat outbound channels as draft-only or off, unless Nic approves each send. |
| 22 | **New (preview, chat-fed):** "mutation default" and message forwarding | Preview projects/agentic-os.md Locked Decisions: "default mutating=true for external changes or message forwarding". Active State: a pending "forward messages to the booking agent" task. | Conflicts with hub never-send and with the Booking isolation rule. Do not apply this scroll as is (see section 10). |

**Stale claims inside the hub** (flagged only, not edited):
- SYSTEM.md:24-27 and AGENTS.md:7-8 describe per-agent files that do not exist (`agents/*` hold only `.gitkeep`). The preview architecture scroll repeats this (Repo Paths).
- SYSTEM.md:27 and ROADMAP.md:15 list three protocol files; only the booking templates exist.
- SYSTEM.md:10 says "Loaded" where it means downloaded.
- SKILLS.md claims 13 skills and lists 12. Installed: 83 under `.agents/skills` and 89 under `.claude/skills`; `skills-lock.json` has 82 entries.
- STATUS.md:39 asks to remove the AWS skills and one dataset skill; they are still installed.
- INDEX.md:18: "move SKILLS.md here" is already done.
- STATUS.md:9 names a knowledge-graph file that does not exist; `memory/` holds only an empty sqlite file.
- AGENTS.md:8: one AnythingLLM workspace per hub agent. The live workspaces are coder, designer, librarian, ops, prompter-dispatcher and the Booking workspace.
- CLAUDE.md and .clinerules are byte-identical.
- The SYSTEM.md layout puts `handoffs\` under `master\`. The preview writes it as a root folder (a model slip, unlocked).

## 9. Sensitive data inside C:\ai-hub (categories and file:line only)

Nothing was changed. These are for Nic to protect later. The hub is pushed to a private GitHub repo
(SYSTEM.md:33).

- **master/MASTER_IDENTITY.md** (mostly personal; suggest splitting it into an agent-safe preferences
  file and a private profile):
  - location: :6, :89, :167, :183
  - date of birth / age: :6, :59, :93
  - finance (income targets, minimum pay, fees, pricing, trading): :15, :45, :107-108, :149, :182, :236
  - life plans and possessions: :16, :212-213, :232-235
  - personal schedule: :17
  - body attributes and body photos: :59, :94, :96, :113
  - intimacy and role boundaries (highest sensitivity; no detector): :61, :65-66, :102-103
  - licence and firearms handling: :72-73
  - named third parties (a talent rep, a business partner, a repeat client): :84, :104, :111, :147
  - casting platforms and groups: :84, :89, :104
  - credentials and health-adjacent training: :126-127
  - employment history: :81, :127-130
  - business and corporation names: :137, :145-151, :201
  - family trade: :11, :155, :162
  - creative gear: :24, :75, :189-198, :213-214
  - personality: :8-10, :35, :38-42, :45-51, :211
- **master/handoffs/CURATION_PROMPT.md:6**: location, a business name and personal pillars in one line. :9-10 machine hardware.
- **master/STATUS.md**:
  - :7 a folder path carrying a business name
  - :12 a time zone that reveals the city
  - :23-26 pointers to app configs that hold an API key and account IDs (no values in the hub)
  - :58 money figures (a test fixture)
  - :66 a paid plan tier
- **master/ROADMAP.md**: :25 money figures (the same test fixture); :39 third-party testers (no names).
- **master/SYSTEM.md**: :14 paid plan tier; :4-6 machine names and hardware (system hardware, allowed).
- **master/AGENTS.md:38**: a messaging-group casting source (Booking scope).
- **master/INDEX.md:22**: describes the booking templates and a repeat-client list (pointer only).
- **tasks/**: one personal .eml (identifiers in the file name) inside the git-tracked repo. Not opened.
  Suggest moving it out of the repo or ignoring it in git.
- **protocols/booking-templates.md** and the **messaging-bridge folder**: Booking content and the bridge
  inside the git repo. Not opened.
- **Detector gaps.** Nic's channel is `deny_terms` in `data/memory-scrolls/privacy-policy.json`; changing
  it invalidates every preview. No detector exists for:
  - bare city or region names
  - business or corporation names
  - body attributes and intimacy boundaries
  - talent-rep wording
  - percentage fees and plan tiers
- **Agentic OS side:** command center `src-tauri/src/commands/os_core.rs:71` holds a private
  overlay-network IP as the default AnythingLLM URL. Infrastructure; never seed it into scrolls or docs.

## 10. Remaining issues

1. ~~**Apply target is inside the read-only hub** (conflict 15).~~ **Resolved:** the targets are now under
   `D:\ai-hub-memory`, and `C:\ai-hub` is refused by every writer.
2. **projects/agentic-os.md (chat-fed) quality.** It is not fed by the hub, so the hub input guards do not
   apply to it.
   - Locked "Mutation Policy" (default mutating for message forwarding): wrong, and against never-send.
   - Locked "Agent Roles" names the booking role: a fact, but in Booking scope.
   - Active State and Open Threads hold a Booking hand-off task and a one-off app idea.
   - Key Paths invents a booking-agent path.
   - The KG has two duplicate entities for the same app idea, and a "Booking Agent Integration" entity.
   - Cause: the Tony gateway chat source was not filtered for Booking lines the way threads and training
     logs were. **Fixed:** gateway chat now skips a message whose routing fields name Booking or that
     opens with a Booking Desk envelope, and drops any other line that names Booking. Two tests cover it.
     The 18:44 preview skipped 2 messages and 1 line, and no scroll or KG line names Booking.
   - Still open: no new locked bullets from chat-only batches. Review `projects/agentic-os.md` in the next
     model-written preview.
3. **Model variance.** The two runs gave different Agentic OS project scrolls. Run 1 locked stale model
   names from brain/; run 2 did not. Fixing brain/memory.md, business-brain.md and constraints.md:14
   is the durable fix.
4. **Content slips (unlocked):**
   - architecture Repo Paths repeats the hub's non-existent per-agent files and puts handoffs at the root
   - ai-hub Current Milestone says the identity file is locked, while Active State, correctly, says the
     lock is pending
   - ai-hub Key Paths names a KG file that does not exist
   - identity Superseded logs the "never hardcode keys" rule as superseded by "use placeholders"; it is
     one rule, not a change
   - identity carries a nickname and the persona line from chats
5. **Contested locked bullets** (conflicts 4 and 5): the Gemini escalation ladder and the Librarian as
   the only rule writer. They are durable hub decisions, but they clash with Agentic OS. Nic should
   confirm or narrow them.
6. **Not verified:** `--apply` itself, compaction after apply, and Librarian retrieval over these scrolls.
   By design, nothing was written.

## 11. What `--apply --confirm 04a502a35827` would have done (not run; token now refused)

> Superseded: `--apply` refuses this token. For the D: targets and the current token (`fe63a4abe283`),
> see `docs/MEMORY_TIERING_REPORT.md` section 7.

1. Re-check the token, schema v2, policy v3 (hash `c11cf121d548`, no override), every preview file hash,
   that the target scrolls are still absent, and the privacy filter on every body and entity.
2. Snapshot 0 AnythingLLM documents plus the local-source record into the cold archive
   (`D:\ai-hub-archive`), pinning that root in the state dir.
3. Write 5 scrolls (8,088 B) to the scrolls root, which defaults to **`C:\ai-hub\memory\scrolls`, inside
   the read-only hub**.
4. Upsert 22 model entities, plus 5 `scroll` entities and their `documented_in` relations, into the KG
   path, which defaults to **`C:\ai-hub\memory\knowledge-graph.json`**.
5. Embed the 5 scrolls into `librarian` (about 10 chunks). Un-embed nothing: the allowlisted workspaces
   hold 0 raw documents.
6. Never touch `my-workspace` or `booking`, brain/, chats, threads, training logs or any hub file other
   than those two default targets.

**Recommended order:**
1. ~~Pick a scrolls and KG location outside `C:\ai-hub`.~~ Done: `D:\ai-hub-memory`.
2. Fix the brain/ stale lines (models, OS, active project, Gemini CLI).
3. Decide conflicts 2, 4 and 5.
4. Optionally add `deny_terms` for the detector gaps.
5. Re-run the dry-run with the new target.
6. Review projects/agentic-os.md.
7. Apply.
