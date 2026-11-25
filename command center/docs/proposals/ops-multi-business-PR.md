## Multi-business Operations Manager + zero-trust Security/Garbage layer

Adds an Operations Manager (`bizops`) that serves N isolated businesses, a single Finance agent with per-business ledger partitions, and a deterministic, fail-closed Security / Garbage layer with a human-in-the-loop review queue. Plan and decisions: `command center/docs/proposals/ops-multi-business-plan.md`.

Stacked on `feat/thoughtform-pipeline`. It also carries that branch's two unpushed fixes (5b414f8, 0b67b03) and the Director media branch (eeae89a, e503c5a), merged in first by fast-forward.

### What changes

**Business isolation (Phase 2)**
- **Business Registry** (`<config>/businesses.json`), seeded with `trades_contracting` and `supplements_ecom`, extensible from the UI.
  - The workspace slug, RAG namespace, memory path, librarian scope and ledger tag are all derived from the immutable `businessId`.
  - They're re-validated on every load, so a hand-edited file can't re-point one business at another.
- **`BusinessScope`** is the only handle ops code gets:
  - Notes are jailed through `staging::safe_join` (traversal, ADS, device names and junctions are refused).
  - Search is scoped to one business.
  - A write that names another business is refused and held for review.
- **Routing:** new `bizops` and `finance` roles; `ops` is now infra-only (a one-time `bizops-split` migration of saved triggers).
  - Every `bizops` / `finance` turn is locked to exactly one business, from the Business Switcher or the request text.
  - Otherwise Tony asks which business, without calling AnythingLLM.
- **Finance:**
  - Ledger rows carry a `ledgerTag`; `finance_librarian` retrieval requires one.
  - The `finance` agent gets only that ledger's rows per turn, and its workspace must hold no documents (fail closed).
  - Ops → Finance goes only through a strict `FinanceHandoff` payload (`deny_unknown_fields`, tag must match, jailed attachments, needs approval).

**Zero-trust layer (Phase 3)**
- **Rules integrity:**
  - Security / Garbage rules and the agent prompts ship as read-only bundle resources, checked against copies compiled into the binary.
  - A mismatch latches fail-closed (purge, flag, ops writes, Garbage scratch purge and the Security pass all halt) until a restart.
- **Append-only audit:** SQLite with UPDATE/DELETE abort triggers plus a SHA-256 hash chain, verified at startup.
- **Quarantine:**
  - Garbage never hard-deletes business data: snapshot (fsynced, read back, hash-checked) → metadata → move.
  - Approve Purge needs `approved: true`; Reject & Restore re-verifies and restores into the same business only.
- **Review queue:**
  - One batched digest (threshold + daily), grouped by business and reason.
  - Optional webhook, counts only, with its URL in its own keychain entry.

**UI (Phase 4)**
- Operations section with Businesses, Review Queue, Audit, and Digest & alerts.
- Add Business modal with a live provisioning checklist.
- Business Switcher in the top bar, sent with every OS turn as `activeBusinessId`.
- Pending-review badge on the rail.

**Fixes found running the desktop app**
- **Gateway CORS (c89c1d9):**
  - A dev window on another Vite port (e.g. `http://localhost:1422` from a second worktree) was refused by the CORS preflight. Every panel said "Gateway unreachable" while the Rust heartbeat, which isn't subject to CORS, said Connected.
  - `server.py` now also allows `http://localhost|127.0.0.1:1420–1439` (regex), covered by `tests/test_cors.py`.
  - The heartbeat now reports what the webview can actually reach ("Blocked here"), not only the Rust check.
- **Biz Ops / Finance in the UI (d5cbf31):**
  - The backend had both roles, but the frontend never registered them.
  - Added to chat threads, voice, intent parsing, settings, handoff cues, the System Map, orbital and whiteboard views.
  - Also fixed `memory_scrolls/guards.py`, which was missing `director`.

**Also on this branch (from the parallel orbital work)**
- Deep-space backdrop engine with E46 flight events, a visible-by-default fix, two-way dogfights, steering flight physics and a far-background capital ship (b4652f1, 64f0da5, bb34f52, d53d405). These are UI-only and don't touch the ops/security code.

**Provisioning**
- `AllmWriter::for_ops_provision`, confined to `business_registry.rs` by the existing constructor test.
- Env-gated live runners: `live_provision_seed_businesses` and `live_provision_finance_workspace`.

### Tests
- [x] `cargo test --lib`: 1061 passed, 31 ignored (live / env-gated)
- [x] `npx vitest run`: 113 files, 1740 tests
- [x] `npm run typecheck`
- [x] Spec acceptance tests:
  - [x] Cross-business isolation, both directions: notes, search, paths, junctions, ledger tags, attachments, blocked writes.
  - [x] A tampered rules file → fail-closed latch, audited.
  - [x] Quarantine with a verified snapshot, no hard delete before approval, byte-identical restore.
  - [x] Existing agents intact: shared router fixtures, roster, GPU slot path unchanged.
- [x] UI checked in a browser preview against a mock backend. Purge goes through the confirmation card, and only the second call sends `approved: true`.
- [x] Live: `bizops_trades_contracting`, `bizops_supplements_ecom` and an empty `finance` workspace created in AnythingLLM and read back.
- [x] Desktop app built from this branch: gateway Online, Biz Ops / Finance tabs present, both businesses Active, audit chain intact
- [ ] End-to-end run in the desktop app built from this branch (Operations turn, Finance turn with the vault unlocked)

### Known follow-ups
- Quarantining AnythingLLM documents (needs the document-read endpoint verified live).
- `bizops` as a Tony packet target (packets need the same business lock).
- The audit chain doesn't detect truncation of its newest rows.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
