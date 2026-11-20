# Memory Scrolls: overnight summary (2026-11-20)

**Bottom line:** I did **not** run `--apply`. Nothing was written to `D:\ai-hub-memory` or `D:\ai-hub-archive`. `C:\ai-hub` is byte-for-byte unchanged. The Librarian workspace is untouched.

The overnight rule was: apply only if all four reviewers clear the preview, with at most two extra fix rounds. Round 9 was the last of those two. Three reviewers cleared it and one still blocks.

## What happened overnight

| Round | Preview | Privacy | Booking & scope | Truth & locks | Quality | Tests |
|---|---|---|---|---|---|---|
| 7 | 20261119-233821 | clear | **BLOCKED**: installs said "Librarian approval"; unmarked "fix rule files, then lock" | clear | clear | 412 OK |
| 8 | 20261120-011216 | clear | **BLOCKED**: passive "MCP entry must be repointed manually", unmarked | clear | clear | 453 OK |
| 9 | 20261120-021616 (token `e13e446ac6c5`) | clear | **BLOCKED**: noun form "MASTER_IDENTITY.md and AGENTS_NEVER.md need review/fix before final lock", unmarked | clear | clear | 479 OK |

Every round fixed what the round before it found. Fixed overnight:
- the installs approver now names Nic;
- settled AGENTS_NEVER rules are copied word for word;
- contested rules #4, #5 and #6 are marked "(unconfirmed)";
- the auto_dispatch and Tier-3 qualifiers are back;
- the two Librarians are kept as separate KG entities;
- the invented "no external MCPs" rule is gone;
- planned paths are marked as planned;
- the agentic-os overview is in place;
- the approval loophole ("without explicit approval") is gone;
- KG garbling and misattributions are cleaned up.

## Why it keeps blocking: the same problem in new wording

The local model (qwen3.5-9b) rewords the hub's to-do *"Read MASTER_IDENTITY.md and AGENTS_NEVER.md, fix anything wrong, then lock v1"* differently on every run:
- round 7: a plain order;
- round 8: the passive voice;
- round 9: a noun phrase ("need review/fix", "prompts pending write").

The guard detects the instruction by grammar, so each new phrasing slips past. I chased it two rounds in a row. A third grammar patch would just be more whack-a-mole.

**The proper fix doesn't depend on grammar.** Any NEW scroll line or KG observation that names a rule or identity file gets "(needs Nic's approval)" if it also contains a change or pending word. Rule and identity files: MASTER_IDENTITY, AGENTS_NEVER, SYSTEM.md, rules, prompts. Change and pending words: fix, review, lock, write, edit, update, rewrite, pending, need. KG observations are checked together with their entity's name. That is a small, deterministic change and I expect it to close this class for good.

## Your options (pick one)

1. **Recommended: one more round with the grammar-independent rule above.** Then a fresh preview, the 4-reviewer check, and `--apply` if clean. About 1.5 hours, unattended.
2. **Accept preview `20261120-021616` as it is.** The blocking line is a status note, and the scroll's own locked guardrail already says "Never change rules or identity files". You would tell me "apply e13e446ac6c5" and I'd run `--apply --confirm e13e446ac6c5` and verify. The other two items:
   - **Unmarked "prompts pending write" line:** majority-confirmed, not blocking.
   - **"Implement modes.json" Open Thread:** majority-confirmed, not blocking. It is stale: `modes.rs` already exists, only the on-disk file doesn't.
3. Leave memory unapplied for now.

## Decisions only you can make (unchanged from before)
- **Contested rules.** #4: is the Librarian the only rule writer? #5: the local → Gemini → Claude escalation ladder. #6: is "ai-hub is the single source of truth" meant unscoped? All three stay "(unconfirmed)" until you decide.
- **Identity scroll.** The locked "Standing Rules" come from MASTER_IDENTITY "HOW HE DECIDES". Two of those lines are borderline (pay-level wording and personal history). Keep them locked, unlock them, or drop that section from the allowlist?
- **AI Hub roadmap.** It has a productisation line that mentions friend testers. Keep it or drop it?
- **Repoint by hand.**
  - The AnythingLLM knowledge-graph MCP: `MEMORY_FILE_PATH` in `%APPDATA%\anythingllm-desktop\storage\plugins\anythingllm_mcp_servers.json`. Point it at `D:\ai-hub-memory\knowledge-graph.json` once apply has run.
  - The sqlite MCP, which points at `C:\ai-hub\memory\agentic-os.sqlite`.
- **Memory Vault.** Pick a new vault folder. Harvest and export now fail closed while it still points inside `C:\ai-hub`.
- **Stale lines in `brain/`.** I never edit `brain/`, so these are listed in docs/AI_HUB_BASELINE_REPORT.md for you to handle.

## Where things are
- **Code:** `memory_scrolls/` (guards v6, stale-claims v4, manifest v6) and `tests/test_memory_scrolls*.py`, with 479 tests passing. Nothing is committed. Branch: `feat/thoughtform-pipeline`.
- **Round details:** docs/MEMORY_TIERING_REPORT.md section 8, with a subsection per round.
- **Latest preview:** `staging/memory-scrolls-preview/20261120-021616/`.
- **Other sessions:** "Play Place staging hub" and "MCP role pools / SKILL.md" are both idle. The role-pools session wrote its own summary of the Play Place review.
