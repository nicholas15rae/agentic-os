# Section 26: everything AnythingLLM does today, and where it moves

Read-only survey, 2026-11-27, of main at 87b6527 plus the live AnythingLLM Desktop store
(`%APPDATA%\anythingllm-desktop\storage`). Nothing in AnythingLLM was changed. A full export is in
`data/engine/allm-export/20261127-101548/` (gitignored, kept until Nic confirms nothing is missing).

**Shape of the dependency.** `command center/src-tauri/src/commands/allm.rs` is the only Rust module
that talks to AnythingLLM's HTTP API (`AllmConn`, with a read-only `AllmReader` and an `AllmWriter`
that only memory.rs, documenter.rs and modellab.rs can construct). So the migration is mostly
"give each caller a gateway-native path behind a switch, then retire allm.rs", not a hunt through
the codebase. On the Python side, `memory_scrolls/allm.py` is the one client.

## Live data (export manifest)

| Table / folder | Count | Notes |
|---|---|---|
| workspaces | 11 | my-workspace (Booking), coder, librarian, prompter-dispatcher, booking, ops (removed agent), designer, director, bizops_trades_contracting, bizops_supplements_ecom, finance |
| workspace_chats | 227 (228 live) | Tony's monthly threads + task sessions; Finance's included |
| workspace_threads | 21 | |
| workspace_documents / documents | 5 / 7 files | Tier-2 memory scrolls (core identity, architecture decisions, lessons, projects) in `librarian` |
| document_vectors / lancedb | 17 / `librarian.lance` | AnythingLLM's own embeddings of those scrolls |
| prompt_history | 15 | earlier workspace prompts |
| plugins/anythingllm_mcp_servers.json | 1 | MCP servers mirrored by "Sync to AnythingLLM" |
| system_settings | 15 | incl. `gmail_agent_config`, `google_calendar_agent_config`, disabled/whitelisted agent skills |
| agent-skills / agent-flows | empty | |

## Inventory → new home

| # | What AnythingLLM does | Where it is used today | New home (gateway / engine) | Status |
|---|---|---|---|---|
| A1 | **Agent workspaces** (prompt + model per role): Coder, Designer, Librarian, Prompter/Dispatcher, Director, Booking, business workspaces, Finance | `agents.rs` (delegation: "specialist roles go to their AnythingLLM workspace", `ChatTarget::TonyMonthly` / `TaskSession`), `taskworker.rs` (role workspace with `sessionId:"task-<id>"`), `pipeline.rs` | Each agent = `{prompt, tools, memory section, model}` in Gabagoul's own config (os.json `agents.<role>`), called on the shared model via the built-in engine's OpenAI endpoint. Prompts already live in `agent_prompts.rs` (`role_prompt`), AnythingLLM only carries copies | Plan; item 10 |
| A2 | **Workspace prompt sync** (pushes role prompts + model into workspaces) | `agent_prompts.rs` (`/v1/workspace/{slug}/update`), `allm.rs` `update-env` | Not needed once agents live in the gateway config; the prompt text is already in Rust | Retire after A1 |
| A3 | **Workspace audit** (duplicates, role/name mismatches, models) | `allm_audit.rs`, Settings | A config check over the gateway agent table | Retire after A1 |
| A4 | **Business workspaces provisioning** (one per business) | `business_registry.rs` (`/api/v1/workspace/new`) | A business = a memory section + prompt in the gateway config; provisioning writes config, not AnythingLLM | Plan; item 10 |
| A5 | **Chat history** (Tony's monthly thread per workspace, task sessions) | `allm.rs` thread map (tasks.db `allm_thread`), `memory.rs` harvest (`/chats`) | Gateway's own thread store (gateway Tony already keeps phone threads: `gateway_tony.thread_history`); harvest reads that | Plan |
| A6 | **RAG over memory scrolls** (Librarian, `mode:"query"`) | `memory_scrolls/` (Tier 2 is "the only layer embedded in AnythingLLM"), `librarian.rs`, `mcp.rs` (`/v1/workspace/librarian`) | The engine's doc store (`engine/docstore.py`, same CPU nomic as the vault). The 7 scroll documents are already imported (22 chunks, all embedded). Joining it to the vault waits for Nic | Store + import done; wiring = item 14 |
| A7 | **Document ingest / embeddings / removal** | `documenter.rs` (`/v1/document/raw-text`, Tony-only notes into Librarian), `memory.rs` (mount / unmount Memory Books), `memory_scrolls/allm.py` (upload, `update-embeddings`, `unembed`) | `DocStore.add_text / remove / reembed` behind the same Tony-only write rule | Plan; item 14 |
| A8 | **MCP servers for AnythingLLM's own agent sessions** | `mcp.rs` "AnythingLLM MCP sync" writes `anythingllm_mcp_servers.json` | Gone: tools come only from Tony's MCP registry (one owner per tool, read-only rules), offered to gateway agents directly | Plan; item 10 |
| A9 | **Gmail agent** (Apps Script `script.google.com/macros/s/{id}/exec`) | `gmail.rs` calls Apps Script **directly** already; AnythingLLM is only where the deployment id + key were first found (`gmail_import_anythingllm`) | Already in the app. Keep the keychain pair; the import button becomes a no-op once AnythingLLM is gone | Nothing to move |
| A10 | **Calendar agent** (Apps Script) | `calendar.rs`, same pattern (`gcal_import_anythingllm`, runs once on first use) | Already in the app, as A9 | Nothing to move |
| A11 | **Chat provider #2 in the failover chain** | `dispatch.rs` provider `anythingllm` (`:3001/api/v1/openai`), `policy.chain = [lmstudio, anythingllm, agentic-os, droplet]` | Drop from the chain at cutover; the built-in engine (`llamacpp`, :1238) takes lmstudio's slot | At cutover (Nic) |
| A12 | **Model settings** (LM Studio as AnythingLLM's LLM provider, token limit) | `allm.rs` `update-env`, `modellab.rs`, `model_swap.rs` | Engine settings (`engine.json`: ctx, GPU layers, KV, prompt cache, keep-warm) | Engine side done (off) |
| A13 | **Phone** | No AnythingLLM endpoint in the gateway or phone code (only `memory_scrolls/` and `scripts/offload_rag_to_scrolls.py` on the Python side). UI: every AnythingLLM call is a Rust command in desktop-only Settings cards; the phone's Desktop Mirror only displays the URL | Phone talks only to the gateway already | Checked 11-27; again at cutover |
| A14 | **Agent skills / flows** | Empty in the export | Nothing to move | — |

## Order of migration (each behind the switchboard toggle, old path kept)

1. Doc store wired as the Librarian's read path (A6), compared side by side with AnythingLLM's query mode.
2. Gateway agent table (A1, A4, A8): generated from `agent_prompts::role_prompt` + Tony's MCP registry.
3. Thread store (A5) and the ingest path (A7).
4. Cutover rehearsal: chain (A11), Model Lab test set, stress probe. Then Nic decides.
5. Only after Nic confirms nothing is missing: retire `allm.rs`, `allm_audit.rs`, `memory_scrolls/allm.py`;
   AnythingLLM uninstalled only with his approval.
