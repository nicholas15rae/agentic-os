# Plan: Multi-Business Operations Manager + Zero-Trust Hardening

Status: **decisions taken 2026-11-22, awaiting go-ahead**. No code changed yet.
Base: new branch `feat/ops-multi-business` off `feat/thoughtform-pipeline` @ 0b67b03, **with `feat/director-media-mcp` merged in first**. Paths below are relative to `command center/src-tauri/src/commands/` unless rooted.

## Decisions (these override the sections below where they conflict)

- **D1 — new id `bizops`.** `ops` stays the infra role, with its prompt, workspace and MCP grants unchanged. Business triggers (`business`, `bf supplements`, `contracting`, plus each registered business's display name and id) move off `ops` and onto `bizops`; `ops` keeps `droplet`, `schedule` and `calendar`. Everywhere below that says "Ops" as the role id, read `bizops`. Per-business workspaces become `bizops_<business_id>`.
- **D2 — build `finance` + `finance_librarian`.**
  - `finance` is a chat role with ALLM workspace `finance` and **no embedded documents, ever**. Each turn, Rust injects only the ledger rows for the requested `ledgerTag` (from the sealed vault, which must be unlocked) as context. It never receives ops RAG chunks.
  - `finance_librarian` is deterministic Rust retrieval over the vault (it extends `finance_search`) with a **mandatory** `ledgerTag` filter. No ledger data is embedded into AnythingLLM's plaintext vector store, so there's no cross-tag retrieval path at all.
  - The handoff target is the vault (§3) via the delegated open-write-reseal path. The `finance` agent reads from it.
  - Observer's "no `financ` workspace" anomaly is narrowed: exactly slug `finance` is allowed, it must have zero documents (verified via `GET /v1/workspace/finance`), and any other finance-named key is still an anomaly.
  - Routing: `finance`, `ledger`, `bookkeeping`, `expenses` and `receipt` go to `finance`. `invoice` and `quote` inside a business context go to `bizops`, which hands off.
  - The existing `financer` packet target and the arbiter `finance` node are kept; the node now fronts both the vault and the agent.
- **D3 — business data only.** Quarantine plus approval covers everything under a business scope (memory, RAG docs, ledger-linked attachments). Existing scratch TTL purges in `garbage.rs` are unchanged.

## 0. Audit findings that change the spec

| Spec assumes | Repo reality | Plan response |
|---|---|---|
| `ops` is free for the Operations Manager | `ops` exists: infra role (Docker/n8n/droplet/GPU), read-only, wired in ~10 places. Its live routing triggers already include `business`, `finance`, `invoice`, `bf supplements`, `contracting`. | **Decision D1** |
| `director` routing/MCP configs exist | Only on unmerged `feat/director-media-mcp` (e503c5a). Not in HEAD. | Touch the same files additively (append-only edits to role lists) so the later merge is a trivial conflict. Re-run director tests after merge. |
| `finance` + `finance_librarian` agents | Neither exists. Finance today = `finance_vault.rs`: an AES-256-GCM sealed ledger (`financer`), not a chat role. Observer flags any workspace key containing "financ". | **Decision D2** |
| Security/Garbage have system prompts to checksum | Both are deterministic Rust with **no LLM and no prompts** (`security_gate.rs`, `downtime.rs`, `garbage.rs`). | Checksum their *rule files* (new) and the Ops prompt template. See §4. |
| Garbage never hard-deletes | `garbage.rs` hard-deletes TTL/quota scratch under `<config>/packets`, `security/dumps`, `memory-tiers`. | **Decision D3** |
| Per-workspace "RAG namespace" control | Only isolation AnythingLLM gives us is one workspace = one vector namespace. No production workspace-create path exists (only an ignored live test). | `rag_namespace` := workspace slug. Add a narrow production `AllmWriter::for_ops_provision`. |
| `qwen/qwen3.5-9b` default | Not hardcoded; set at runtime by Model Lab and pushed to every lmstudio workspace's `chatModel`. | New ops workspaces get `chatModel` from the current provider model at provision time. GPU queue: Ops turns use the existing foreground `GpuSlot` path in `agents.rs`, so Tony-first is inherited, no new lock. |

## 1. Business Registry

New `business_registry.rs` → `<config>/businesses.json` (one `Mutex`, `deny_unknown_fields`, atomic tmp+rename with the AD-5 retry, rollback on failed save).

```jsonc
{ "version": 1, "businesses": [{
  "businessId": "trades_contracting",        // ^[a-z][a-z0-9_]{1,31}$, immutable
  "displayName": "Trades & Contracting",
  "category": "construction", "description": "GC, masonry, self-performed + subcontracted",
  "workspaceSlug": "ops_trades_contracting",  // derived, never user-supplied
  "ragNamespace": "ops_trades_contracting",   // == slug (AnythingLLM per-workspace vectors)
  "memoryPath": "<config>/memory/ops/trades_contracting",  // derived, canonicalised
  "librarianScope": "ops_trades_contracting", // librarian may read only this scope
  "financeLedgerTag": "trades_contracting",
  "crossDomainBlocklist": ["<client/vendor names>"],
  "status": "active" | "archived", "createdAt": "…" }]}
```

Seeds: `trades_contracting`, `supplements_ecom`. Derived fields are computed in Rust, so the UI can't point a business at another's slug/path. Removal = `archived` + quarantine of its data (never a hard delete; see §4).

Commands: `business_list`, `business_create`, `business_update` (displayName/description/blocklist only), `business_archive` (approved:true), `business_provision_status`.

**Provisioning** on create (idempotent, resumable, each step recorded): mkdir memory path → `POST /v1/workspace/new` (ops prompt template, `chatMode: chat`, temp 0.4, model from provider) → verify via `GET /v1/workspace/{slug}` → register. Provision failure leaves the record `provisioning` with a Retry button; nothing half-bound is routable.

## 2. Context lock + routing

- New type `BusinessScope` (`ops_scope.rs`): only constructible from a registry lookup of an `active` business. Every ops fs/RAG/memory/finance function takes `&BusinessScope`; no function takes a raw `business_id` string. This makes "forgot to scope" a compile error.
- Active business comes from: explicit UI selection (Business Switcher) **or** an unambiguous mention in the utterance (display name / id). Zero or multiple matches → Ops does not run; Tony replies with a clarification ("Which business — Trades & Contracting or Supplements & E-Commerce?"). Covered by tests.
- Ops chat delegates through the existing `os_turn_traced` path with the slug resolved from the scope instead of `anythingllm.workspaces`. Same foreground GPU acquire, so Tony-first is unchanged.
- Rust + TS router: add triggers per D1, update `router.fixtures.json` (shared by both test suites), `DOMAIN_TIEBREAK`, `sub_agent_roster`, `tony_dispatch::AGENTS`, `packet_queue` executor (`ops` on the GPU relay lane).
- `roles.rs`: `RolePolicy::OPS` = read-only MCPs + writes only via the jailed ops store (no generic fs write).
- Ops librarian = AnythingLLM `query` mode on the scope's workspace + the Rust librarian `gather` restricted to `scope.memory_path` (new `Sources::for_business`). It never sees other roots.

## 3. Finance handoff

`FinanceHandoff` (Rust, `deny_unknown_fields`; TS mirror):
`{ businessId, financeLedgerTag, transactionType: invoice|receipt|expense|quote|subcontractor_payout|ecom_order, amountCents, currency, date, counterparty, category, attachmentRef? }`

- Rust checks `financeLedgerTag == scope.financeLedgerTag` (mismatch → reject + audit), validates amounts/currency/date with the existing `finance_vault` validators, scrubs secrets.
- Writes go into the existing vault via the delegated open-write-reseal path. `LedgerInput` gains `ledgerTag: Option<String>` (old entries read as `personal`, versioned migration in the sealed file).
- `finance_ledger_list` / `finance_search` require a `ledgerTag` filter for any ops caller. Finance never receives RAG chunks, only the payload.
- `attachmentRef` must resolve inside `scope.memory_path` (jailed); it is a reference, not content.

## 4. Zero-trust layer

**4A. Deterministic enforcement (new `ops_guard.rs`)**
- Path jail: every ops path goes through `staging::safe_join` + `verify_inside` + reparse/ADS/device-name refusal against `scope.memory_path`. Reuses the strongest helper already in the repo.
- Cross-domain scrub, before every memory write, RAG upload and finance handoff: (a) tag == scope, (b) Aho-Corasick-style match of the text against *every other* business's `displayName`, `businessId`, `crossDomainBlocklist` and known counterparties. A hit doesn't write: the payload goes to quarantine as a Security flag.
- Strict schemas: `deny_unknown_fields` on every inter-agent payload (Ops→Finance, Ops→Garbage, Security→Staging), with mirrored TS types and a shared JSON fixture tested by both sides.

**4B. Protecting Security & Garbage**
- Rules move to data files: `src-tauri/rules/security.rules.json`, `garbage.rules.json`, plus `ops.prompt.md`. They ship as read-only Tauri resources. `build.rs` computes their SHA-256 and **compiles the expected hashes into the binary**, so an attacker would have to rebuild the app, not just edit a file.
- Verification runs at startup and before every Security/Garbage/Ops action. A mismatch sets a process-wide `FailClosed` latch: automated purge/flag/ops-write actions refuse, the arbiter node shows `TAMPERED`, and a sticky banner appears. Only a restart with valid files clears it.
- Least privilege: Security/Garbage get no MCP access and no shell. They act only through the typed quarantine API. Network: only the webhook dispatcher (4D), which runs in its own module, not theirs.

**4C. Append-only audit**
- `<config>/security/ops-audit.db`: SQLite with `BEFORE UPDATE/DELETE` abort triggers (the `envelope.rs` handoff_log pattern) plus a hash chain column (`prev_hash`, `row_hash`), so tampering with the file outside the app is detectable. `audit_verify_chain` runs at startup and is shown on the Observer node. No command exposes update/delete.

**4D. Quarantine (Garbage never hard-deletes business data)**
- `quarantine.rs`, `<config>/staging/quarantine/<item_id>/`: `snapshot.bin` (a versioned copy) + `meta.json` `{itemId, businessId, sourceAgent, reason, timestamp, backupPath, sha256, kind: file|memory|rag_doc, restoreHint}`. Order: snapshot → fsync → verify hash → move/remove original.
- RAG docs: snapshot the raw text + doc location, then `remove-documents`. Restore re-uploads to the **same** scope's workspace only.
- **Approve Purge** (`approved:true` from the UI only, `PERMISSION_REQUIRED:purge` otherwise) is the *only* hard delete. **Reject & Restore** re-verifies the sha256, restores and audits.

**4E. HITL digest + webhook**
- `review_queue` commands: `review_list` (grouped by business, then by reason), `review_approve(ids, approved)`, `review_reject(ids)`, `review_inspect(id)`.
- Digest trigger: daily at a configured hour **or** when the pending count reaches N (os.json `review: {digestHour, threshold, webhookEnabled, webhookUrl}`). There are no per-item popups; one badge on the sidebar item is the only signal.
- Webhook (off by default): Rust-only POST, http(s) URL validated, 10 s timeout, no retries storm. Payload has counts only: `{pending, byBusiness:{id:count}, reasons:{cross_domain:2, ttl:5}, since}`. No amounts, names, paths or contents (asserted by a test).

## 5. UI (React)

- `src/features/ops/`: `BusinessSwitcher.tsx` (top bar, persistent active business, colour-tagged), `AddBusinessModal.tsx` (shows provisioning steps live), `ops-store.ts`, `types.ts`.
- `src/features/review/ReviewQueue.tsx`: a digest panel with per-batch and per-item Approve Purge / Reject & Restore / Inspect. It reuses `ConfirmCard` (Approve never auto-focused).
- Settings: a Review & Webhook section.
- Sysmap/arbiter: `ops` node per D1, plus the `TAMPERED` state.

## 6. Files

**New (Rust):** `business_registry.rs`, `ops_scope.rs`, `ops_guard.rs`, `ops_agent.rs` (turn entry, clarification), `finance_handoff.rs`, `quarantine.rs`, `review_queue.rs`, `ops_audit.rs`, `integrity.rs`, `webhook.rs`, `rules/*.json|md`, `build.rs` (hash embedding).
**Modified (Rust):** `mod.rs`/`lib.rs` (register), `os_core.rs` (review config, routing defaults, migration), `roles.rs` (OPS policy), `agents.rs` (scope-resolved slug, roster), `routing.rs`, `tony_dispatch.rs`, `packet_queue.rs`, `allm.rs` (`for_ops_provision`), `finance_vault.rs` (ledgerTag + filter), `garbage.rs`/`downtime.rs` (route business data through quarantine + integrity check), `librarian.rs` (`Sources::for_business`), `arbiter.rs` (node states).
**New/modified (TS):** `features/ops/*`, `features/review/*`, `dispatcher/{roles,router,tony-dispatch,agents}.ts` + `router.fixtures.json`, `sysmap/model.ts`, `sections/settings/*`, shell nav.
**Not touched:** existing workspaces/slugs, `NEVER_TOUCH`, director files beyond append-only list edits, the Python gateway (phone routing picks up the new triggers via `DEFAULT_ROUTING_CONFIG` only).

## 7. Tests (Phase 4 acceptance)

1. **Isolation:** a write in `supplements_ecom` that names a `trades_contracting` client is quarantined, not stored. Reads/queries with scope A never return B's memory, files, RAG slug or ledger rows. A path-traversal / junction / ADS attempt out of `memoryPath` is refused. Missing/ambiguous business leads to clarification with no ALLM call (mock server request count = 0).
2. **Tamper:** mutate a rules file → `FailClosed` latch set, purge/flag/ops-write refuse, audit row written.
3. **Garbage:** flagged item → quarantine with a valid snapshot (hash verified). The original is gone but no hard delete happens until `review_approve(approved:true)`. Reject restores byte-identical. Purge without approval → `PERMISSION_REQUIRED:purge`.
4. **No regressions:** full `cargo test --lib`, `npm test`, `npm run typecheck`, `python tests/run_all.py`. The router fixtures still resolve every existing role identically, and the GPU-slot tests show ops turns acquire as foreground through the same semaphore.
5. **Audit chain:** UPDATE/DELETE abort, and a hand-edited row breaks `audit_verify_chain`.

## 8. Phasing / commits

P2 registry + scope + provisioning + routing + finance handoff → P3 guard, integrity, audit, quarantine, review, webhook → P4 UI + acceptance tests. One commit per phase on a new branch `feat/ops-multi-business`. Live AnythingLLM provisioning of the two seed workspaces is a separate, explicit step (it writes to your running ALLM).
