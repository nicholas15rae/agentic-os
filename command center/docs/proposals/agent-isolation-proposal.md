# Proposal: Agent Isolation, Unified Model Routing, Hybrid Escalation, Deterministic Ops

Status: **DRAFT for Nic's review. No production code has been changed.**
Base: `feat/thoughtform-pipeline` @ `b01835f`. Implementation will happen in a fresh worktree off that commit, so the uncommitted buildhub/lifecycle/voice work in the main checkout stays untouched.
Companion file: [`agent_topology.proposed.yaml`](agent_topology.proposed.yaml), your draft with the audit's corrections inline.

Paths: `R/` = `command center/src-tauri/src/commands/`, `T/` = `command center/src/`, `PY/` = repo root, `CFG` = `%APPDATA%\os.agentic.commandcenter`.

---

## 0. Findings that change the plan

| # | Finding | Evidence | Consequence |
|---|---|---|---|
| F1 | **The live backend is LM Studio on :1235, not Ollama.** Ollama is running, but its store (`D:\ollama-models`) is empty and no code calls the Ollama API: no `keep_alive`, no `/api/ps`, no `/api/generate`. | `CFG\providers.json`: `lmstudio` and `verifier` both point to `http://127.0.0.1:1235/v1`. `R/dispatch.rs:337,343` default to `:1234`. | VRAM lifecycle has to build on LM Studio's native `/api/v1/models/load|unload` (already used by `R/modellab.rs:115,154` and `R/services.rs:332-348`). Ollama `keep_alive` becomes one backend adapter. |
| F2 | **Port defaults disagree.** Rust defaults use :1234; the taskworker fallback, `command_center_api.py:55`, `memory_scrolls/config.py:27` and the live install use :1235. | See §1. | A fresh install silently routes to the wrong port. |
| F3 | **Models live on `D:`, a SATA HDD (ST2000DM008).** | Swap benchmark below. | Cold loads take 50–60 s; loads from the RAM page cache take 9–10 s. Prewarming is required, not optional. |
| F4 | **Finance data reaches the internet-enabled Librarian today.** Librarian turns get `cc.search(utterance, [])` across **all** vault collections, including `receipts` (vendor, total, HST, OCR text), `invoices` and `checks`. | `T/features/voice/voice-controller.ts:1336-1338`; `PY/command_center_api.py:93-108, 554`. | This is a live isolation breach. I recommend fixing it first, as a P0 in Phase 2. |
| F5 | **Raw turn logs are not scrubbed and are uploaded to Google Drive by default.** `bridge.log` writes upstream/downstream text verbatim to `training_logs/`, and that folder is on the default Drive-sync list. | `R/bridge.rs:153-168`; `R/agents.rs:1723-1735`; `R/dispatch.rs:213-219`; `R/pipelines.rs:583-600`. | Finance and Booking turns leave the machine. Also a P0. |
| F6 | **Agent identity is self-asserted by the webview.** `mcp_call` takes `agent` from the UI and defaults to `"tony"` (unrestricted). `os_turn` takes `role` from the UI. `write_artifact` takes `Role` from its caller. | `R/mcp.rs:966-968`; `R/agents.rs:1165`; `R/staging.rs:288`. | No allowlist can hold until Rust assigns the identity itself (§4). |
| F7 | **The live verifier is already cloud.** `policy.verifier = "ext:claude-cli"`. | `CFG\providers.json`. | This conflicts with "Auditor strictly offline". You need to decide (Q2 in §6). |
| F8 | **Loop counts today:** `MAX_LOOP_ITERATIONS = 3` (`R/envelope.rs:52`; `worker.max_iterations` clamped 1–3, `R/os_core.rs:672`), plus one gate repair per iteration (`GATE_REPAIR_LEAD`), plus verify retries. A hub build fails into the Repair Queue after `AUTO_REPAIR_AFTER = 2` smoke failures (`R/buildhub.rs:46`). | — | This is the "up to 4 passes" you have been seeing. The escalation counter must count Coder passes, including the gate repair. |
| F9 | **There is no Finance agent in code.** Finance phrases route to `ops` (`R/os_core.rs:140-143`). Finance data sits in the shared gateway `cc.db`. OCR runs in the Python gateway (`/api/cc/ocr`, `PY/command_center_api.py:832`). | — | Finance is greenfield. OCR's natural home is the Finance Librarian. |
| F10 | **The Memory Vault default is refused by its own guard.** The default is `C:\ai-hub\vault\locked-archives` (`R/os_core.rs:456`), and `R/memory.rs:77` refuses any vault under `C:\ai-hub`. | — | This is a small existing bug. It also matters here: the cold vault in §4 must not repeat it. |

### Swap benchmark (measured 2026-11-21: RTX 3060 12 GB, LM Studio :1235, flash attention, parallel 1)

| Model | ctx | Cold load (HDD) | Warm load (page cache) | Unload | VRAM | Gen speed* |
|---|---|---|---|---|---|---|
| qwen/qwen3.5-9b Q4_K_M | 16384 | 60.1 s | 9.6 s | 1.3 s | 7.5 GB | ~41 tok/s |
| qwen2.5-coder-14b-instruct Q4_K_M | 16384 | 49.5 s | 8.5 s | 1.7–2.8 s | **12.0 GB (full card)** | ~23 tok/s |

\*Short code prompt; the figure includes prefill. Script: scratchpad `swapbench.ps1`. Phase 1 will turn it into a Model Lab job that persists its results.

**What the numbers mean:**
- A warm swap costs about **11 s each way**.
- Per-call `keep_alive: 0` on `coder_verifier`, as in the draft, would add about 22 s to every Coder → support → Coder handoff. Over a build that is several minutes.
- If a Tony voice turn during a build forces a swap, it waits about 11 s before its first token, and the build pays another 11 s afterwards.

---

## 1. Deliverable 1: hardcoded endpoints, model names and communication paths

### 1a. Endpoint and model literals that need to move behind the gateway

**Provider registry defaults (already overridable through `providers.json`, but the defaults are wrong or duplicated):**
- `R/dispatch.rs:337` `lmstudio` → `:1234/v1`, `local-model`
- `R/dispatch.rs:343` `verifier` → `:1234/v1`, `local-model`
- `R/dispatch.rs:338` `anythingllm` → `:3001`
- `R/dispatch.rs:340` droplet → `100.64.0.10:8000`, `deepseek-r1-distill`
- `R/dispatch.rs:344` agentic-os → `:8080`, `opencode`
- `R/dispatch.rs:356-358`: chain and `primary_local`
- `R/os_core.rs:67-71`: droplet URLs
- `R/os_core.rs:86-90`: AnythingLLM role → workspace map
- `R/os_core.rs:419-421`: overseer models

**Literal `"lmstudio"` provider-id lookups that bypass `policy.chain`.** Each one becomes `gateway.route(agent_id)`:
- `R/taskworker.rs:3336-3340`. Also has a literal fallback `http://127.0.0.1:1235/v1` with an empty model.
- `R/buildhub.rs:2333-2343`: intake questions.
- `R/modellab.rs:23,68,256`.
- `R/allm_audit.rs:242`.
- `R/introspect.rs:319`.
- `R/services.rs:154,332`: fit guard.
- `R/compaction.rs:324` (`AOS_LMSTUDIO_BASE` env pass-through).
- `T/features/os/os-intents.ts:173`.

**Fixed constants:**
- `R/services.rs:141` `LMSTUDIO_DEFAULT_PORT = 1234`.
- `R/services.rs:326` `FIT_CTX = 32768`.
- `R/modellab.rs:19` `VRAM_RESERVED_GB = 3.3`.
- `R/taskworker.rs:3294-3299` (temp 0.3, `reasoning_effort none`).
- `R/taskworker.rs:56-66` (stage timeouts).
- `R/agents.rs:1955,1964-1967` (Anthropic endpoint, `max_tokens`).
- `R/agents.rs:2003` (Gemini endpoint).
- `R/agent_prompts.rs:277-281`: the `qwen3*` thinking-model name heuristic. This should become a tier attribute.

**Python:**
- `PY/command_center_api.py:55` `DEFAULT_LLM_BASE_URL` :1235, `:73-76` (embedding model), `:389`, `:490`.
- `PY/memory_scrolls/config.py:27-29`.
- `PY/memory_scrolls/lmstudio.py:53,66-67`.
- `PY/server.py:301,1019-1057`: CLI agents.

**TypeScript (UI defaults only):**
- `T/sections/settings/ServicesSettings.tsx:194` (`:11434` placeholder).
- `T/sections/settings/HubSettings.tsx:149-150,316-320`.
- `T/stores/settings.ts:111` (gateway `:8080`).

**Dead config:** `agents/opencode/opencode.json:8` (`deepseek-v4-flash-free`) and `agents/agy/agy-extension.json` have no reader. Hermes was removed and migrated to opencode (`R/dispatch.rs:1066-1079`). AGENTS.md's 3-agent engine no longer matches the code.

**HTTP call sites.** There are 15 distinct call sites:
- `dispatch::call` / `run_chat_streamed`
- `agents::claude_api` / `gemini_api` / `cli`
- `LiveModel::lm_direct` / `ask`
- `AllmReader::chat` / `stream_chat`
- `build_intake_questions`
- Model Lab `bench`
- `services::local_fit_once`
- `allm_audit`
- `droplet_probe`
- Python `llm_chat` / `embed` and `LiveLLM.chat`

TypeScript never calls an LLM directly. Everything goes through `dispatch_chat` / `overseer_ask` or the gateway.

### 1b. Communication-path map, summarized

There are 41 edges in total; I have the full `file:line` list and can add it as an appendix. Almost none are direct agent-to-agent calls. They go through **five brokers**, and those brokers are where policy has to be enforced:

| Broker | Edges | Where |
|---|---|---|
| **Tony delegation** (HTTP to AnythingLLM workspace per role) | Tony → Booking / Prompter / Designer / Coder / Librarian / Ops, and back | `R/agents.rs:1420-1487` → `R/allm.rs` |
| **TaskEnvelope worker** (`tasks.db` stage transitions) | Prompter → Librarian(preflight) → Prompter → Designer → Prompter → Coder → system gate → Librarian(audit) → Prompter(verify) → Tony | `R/taskworker.rs:1446-2481`; `stage_agent` :72-82 |
| **Build hub** | webview → hub → worker lane / Claude lane | `R/buildhub.rs:1237-1279, 1877` |
| **MCP tool router** | every role → tools (web, fs, kg, gmail, whatsapp …) | `R/mcp.rs:483-558, 991-1090` |
| **Python gateway :8080** | phone inbox, `/api/chat` CLIs, cc collections, OCR, vault search | `PY/server.py`, `PY/command_center_api.py`, `PY/os_api.py` |

**Shared stores that the draft YAML doesn't assign:**
- `tasks.db`: the "collective memory"; the Librarian reads it.
- AnythingLLM workspaces: Tony's documenter writes the `librarian` workspace.
- `C:\ai-hub`: readable by every role with a `filesystem` grant, including Booking.
- `D:\ai-hub-memory\scrolls` and `knowledge-graph.json`: `kg.search` is granted to booking, librarian, prompter, ops and Tony.
- `cc.db`: finance tables plus every UI collection.
- `training_logs/`
- `transcripts.db`
- `os-threads.json`: every agent tab's turns, synced to the phone.

**Un-diffused egress hole:** the `agentic-os` chain hop is loopback, so the privacy diffuser and the kill switch skip it. It forwards the user message to `server.py`, which can spawn the claude, gemini and opencode cloud CLIs (`R/dispatch.rs:959-963`, `PY/server.py:1054-1057`).

---

## 2. Deliverable 2: gateway pattern. Recommendation: native Rust, by extending `dispatch.rs`

**Recommended: native Rust `model_gateway` module inside the Command Center.**

1. **The registry already exists.** `dispatch.rs` holds `Provider` and `Policy`, persists them in `providers.json`, and handles the `verifier` alias, `ext:` engines and `shape_chain`. The job is to put *tiers* above providers and remove the bypasses, not to build a new router.
2. **The hard part is lifecycle, and LiteLLM doesn't do it.** LiteLLM proxies requests. It doesn't load or unload LM Studio models and knows nothing about the GPU baton (`R/scheduler.rs` `GpuSlot`, mirrored at `/api/os/gpu`), page-cache prewarming or phase leases. All of that would still be needed in Rust, and LiteLLM would sit beside it as a second source of truth.
3. **Policy has to run in-process.** The allowlist, principals and egress rules (§4) must run where the calls start, in Rust. Adding a proxy is one more loopback hop that, like `server.py`, would bypass the diffuser.
4. **Operations cost.** LiteLLM means another Python process, another port and another supervisor in a stack that already runs LM Studio, AnythingLLM, the gateway, whisper, kokoro and n8n.

**Shape:**
- `topology.rs` loads `config/agent_topology.yaml` with `deny_unknown_fields`, versioning and validation at startup. A bad file fails closed to `single_model_fallback`.
- `gateway::route(principal) -> Route { tier, backend, base_url, model, ctx, sampling }`.
- `trait Backend { loaded(), load(model, opts), unload(model), chat(), embed() }`, implemented by `LmStudio` (native API) and `Ollama` (`/api/ps`, `keep_alive`).
- Every call site in §1a calls `route()`.

**Python's share:** the gateway (`command_center_api.py`, `memory_scrolls`) has to keep working while the desktop app is closed, because it is the phone's sync hub. So it can't depend on Rust being up. Rust writes a resolved, secret-free `routes.resolved.json` next to `os-state.json`, and Python reads that instead of `providers.json`. Python already honours the cooperative GPU lease.

**LiteLLM remains an option later** as one more backend behind the gateway, if you ever want many cloud providers. It's not needed for Phase 1.

---

## 3. Deliverable 3: model pairings for 12 GB VRAM and 64 GB RAM

| Tier | Recommended (on disk now) | VRAM | Notes |
|---|---|---|---|
| `router_uncensored` (Tony) | **Qwen3.5-9B Defiant Fable Uncensored Q4_K_M** (6.4 GB file, `D:\Ai Uncensored Models`) | ≈8.5 GB @16k (estimate) | Same base as today's 9B. It has to be imported into LM Studio. The IQ3_M (5.3 GB) is the co-residency variant. |
| `coder_verifier` | **Qwen2.5-Coder-14B-Instruct Q4_K_M** (8.4 GB) | 12.0 GB @16k measured; ≈10.3 GB @12k with q8_0 KV (estimate) | About 23 tok/s. Context must drop to 12k. Our pages plus the verify excerpt fit in 12k (the probe prompt caps the excerpt). |
| `support_json` | **qwen/qwen3.5-9b Q4_K_M** (current) | 7.5 GB @16k measured | Loads as a **vlm** (mmproj present), so it also covers Finance Librarian OCR. About 41 tok/s. |
| `embedding` | **nomic-embed-text-v1.5** (current) | ≈0.15 GB | Pinned, and counted outside `max_concurrent_vram_models`. |
| **Single-model fallback** | **qwen/qwen3.5-9b** for every tier | 7.5 GB | This is today's measured baseline: zero swaps, and Tony's persona comes from the prompt. `single_model_fallback: true` switches to it immediately. |

**Phase 1 bake-off (decides the coder tier; nothing is committed in advance):**
- Re-run the protein-calculator intent plus four other saved intents.
- Metric: Coder passes to a `works: true` verdict, plus wall time including swaps.
- Contestants:
  - (a) qwen3.5-9b (baseline);
  - (b) Qwen2.5-Coder-14B @12k;
  - (c) a MoE coder such as **Qwen3-Coder-30B-A3B-Instruct Q4_K_M** (about an 18.6 GB download, not on disk). Its experts are offloaded to the 64 GB of system RAM and attention stays on the GPU (≈3–5 GB VRAM), so only ~3B parameters are active per token. If LM Studio's MoE expert-offload option holds up on this card, (c) is both stronger *and* small enough in VRAM to sit alongside Tony.
- **Caveat:** Qwen2.5-Coder-14B is a late-2024 model. I can't promise it beats Qwen3.5-9B on HTML/JS. That's why this is a benchmark, not a recommendation.

**Staging strategy (driven by the numbers in §0):**
1. **Prewarm:** at app start and when idle, read each tier's GGUF sequentially into the Windows standby cache. Roughly 30 GB of models fits easily in 64 GB, which turns a 60 s cold load into ~10 s.
2. **Phase leases instead of per-call `keep_alive: 0`.** When the build hub claims a build, it takes a `build` phase lease. `coder_verifier` loads **once** and serves the Coder and Auditor. Support stages inside the build (Prompter / Designer / Librarian preflight) **ride the hot coder model** (`build_phase_substitute`). The lease releases with an explicit unload at the end of the build. That is one swap in and one out per build, instead of two per iteration.
3. **Tony preempts only at call boundaries**, through the existing GPU baton, with `swap_hysteresis_secs: 60` and Tony requests coalesced. If the benchmark shows (c) co-resides, Tony never waits for a swap.
4. **Unload before load:** before loading tier X, the controller reads `/api/v0/models` and `nvidia-smi`. If `loaded + need > vram_gb - reserved_vram_gb`, it unloads the least-recently-used non-pinned model. Each swap is logged as `{from, to, unload_ms, load_ms, warm}` to telemetry.

---

## 4. Deliverable 4: topology schema validation (your `config/agent_topology.yaml`)

The corrected copy is [`agent_topology.proposed.yaml`](agent_topology.proposed.yaml). Findings:

| # | Issue in the draft | Fix |
|---|---|---|
| T1 | Edges are written as direct agent→agent calls, but the code routes everything through five brokers (§1b). | Enforce at the brokers. Add the non-LLM principals (`build_broker`, `escalation`, `archive_job`, `observer`, `security_garbage`). |
| T2 | **Prompter can't reach the Librarian**, but preflight is Prompter → Librarian. **Tony can't reach Coder or Designer**, but delegation and the hub dispatch to both (AD-7). Auditor → Tony exists but Tony → Auditor doesn't. | Edges added. |
| T3 | Roles that exist in code are missing: `ops` (finance phrases route there today), the deterministic gate (`system`), the `verifier` provider, the Claude lane, the Overseer, the `memory_scrolls` compaction job, the documenter, the droplet, and the `server.py` CLIs (opencode / agy / claude / gemini / llm). | `ops` and the principals are added. The CLIs need a decision (Q4). |
| T4 | `internet_access: true/false` is too coarse. Booking is `false` but uses gmail and whatsapp. The Librarian needs exactly two tools. | Replaced with per-agent `egress` (hosts or tools) plus `tools`. |
| T5 | No `reads`/`writes` per agent for non-RAG stores. "Auditor: read-only artifacts" can't be expressed. | Added `reads` / `writes`, plus `shared_stores` for tasks.db, staging, transcripts, telemetry and training_logs. |
| T6 | Paths are relative (`./data/rag/*`, `./vault/cold_archive`), and **neither is gitignored** (`git check-ignore` returns nothing). Finance receipts would land in the repo and its commits. | `data_root: D:\ai-hub-memory\rag`, cold vault at `D:\ai-hub-archive\cold` (outside every live root; avoids F10). |
| T7 | Shared stores aren't assigned at all (§1b), which includes Booking's `filesystem` grant on `C:\ai-hub` and its `kg.search`. | Assigned in `shared_stores`. Booking's grants are reduced to its MCP tools. |
| T8 | Coder and Auditor share weights, so the model grades its own work. | Acceptable *only because* the deterministic gate and probes stay primary (AD-11..13). The Auditor gets a distinct system prompt and temperature 0. Option: keep an Auditor that is a different model family (Q2). |
| T9 | `keep_alive: "0"` on `coder_verifier` reloads every call (~11 s). `keep_alive` is Ollama-only syntax. | `residency: {mode: phase \| ttl \| pinned}`, which is backend-neutral. |
| T10 | No embedding tier, no vision tier (Finance Librarian needs OCR), and no VRAM reserve for whisper / kokoro / the desktop. | `embedding` tier, `vision: true` on support, `reserved_vram_gb`. |
| T11 | `cloud_model: "claude-sonnet"` isn't a model id, and `cloud_provider: anthropic` is the paid API. | `engine: claude-cli` (your decision), `model: claude-opus-5-5` from `overseer.claudeModel`. |
| T12 | `tls_or_nacl_per_channel`: all agents run in one Rust process and share handles. AEAD between in-process modules protects against no threat that can't also read the keys. The real gaps are F6 (forged identity), F5 (plaintext logs leaving the machine) and plaintext finance at rest. | Replaced with three measures: (1) Rust-minted principals with HMAC-signed bus envelopes, for unforgeable identity and a tamper-evident audit; (2) AES-256-GCM at rest for finance, booking and the vault, with the key in the existing OS keychain (`R/secrets.rs`); (3) bearer-token auth on the cross-process loopback (gateway, sidecars). If you still want transport AEAD, it goes on the cross-process finance routes only. |
| T13 | No `schema_version`, no default-deny statement, no limits on escalation cost or count. | Added. |
| T14 | `security_and_garbage.enforce_allowlist: true` in a container. A container can't block in-process calls, and under Docker Desktop (WSL2) it can't see host ports or paths. | Enforcement happens in-process at the brokers. The sidecar audits the denial log and the host collector's facts (§5, Phase 3). |

---

## 5. Deliverable 5: 3-phase implementation plan

Each phase is its own branch off `b01835f` in its own worktree, with its own tests and review gate. The `cargo` and `vitest` suites run in PowerShell, not the Bash sandbox.

### Phase 1: unified gateway, VRAM staging, escalation gate
1. `topology.rs`: YAML loader and validator (unknown keys, dangling tiers/stores/targets, relative paths, paths inside the repo, and duplicate owners are all errors). `config/agent_topology.yaml` is committed (no secrets). Fails closed to `single_model_fallback`.
2. `model_gateway.rs`: `route()`, the `LmStudio` and `Ollama` backends, and `routes.resolved.json` for Python. Migrate every call site in §1a. Fix the :1234/:1235 defaults.
3. VRAM controller in `GpuSlot`: tier-aware `acquire`, phase leases, unload-before-load against the budget, hysteresis, prewarm, and swap telemetry. Model Lab bench results get persisted.
4. Pass counter: `last_eval.local_passes` counts every Coder pass, including the gate repair. It is durable, in the same way `gate_repair_done` is. Restarts and `retry_task` reset it.
5. Escalation: at `max_local_repair_passes` with the gate or verify still failing on a build-loop task, the broker builds the bundle:
   - acceptance criteria and pinned checks;
   - failing gate items;
   - failing probe lines;
   - `known_blockers`;
   - a unified diff of `.iterations/<n-1>` → current;
   - `code_for` excerpts, capped at 24 KB.

   Then, in order:
   - The bundle goes through `devqueue::scrub` and the privacy diffuser.
   - Finance, Booking, librarian notes, RAG and transcripts are refused by construction.
   - The bundle is sent as one forced `claude-cli` code pass via `external_chat_in` (the existing offload path, cwd = a temp dir holding only the bundle). `require_approval` gives you a card first.
   - The result goes back through the same local gate.
   - A failure there is final: needs-fixes, or the Repair Queue for hub builds. There is never a second escalation.
6. Tests:
   - (a) tier routing resolves to LM Studio and Ollama URLs and models, and fallback mode resolves every tier to one model;
   - (b) a mock backend records `unload` before `load` when the budget is exceeded, and no unload happens inside hysteresis;
   - (c) the worker test harness stops at N local passes, emits exactly one escalation with a bundle that contains no finance or booking strings, and never loops after a failed escalation;
   - plus the full existing suites, and a timed sample build pass (swap and stage timings from telemetry).

### Phase 2: principals, allowlist, store isolation, Finance
1. **P0 first:**
   - (F4) the Librarian's vault search excludes `receipts`, `invoices`, `checks` and `income`;
   - (F5) `bridge.log` gets `devqueue::scrub`, and booking/finance turns are excluded from `training_logs` and Drive sync.
2. Principals minted in Rust: the webview passes a *route request*, never an identity. `mcp_call`'s `"tony"` default goes away. `write_artifact` takes the principal from the broker.
3. Allowlist checks at the five brokers. Denials fail closed and go to `security-audit.jsonl` (HMAC-chained).
4. Per-agent RAG roots under `data_root`. The build loop shares `build_loop_rag`. The Auditor gets an `http` handle of `None` and its Edge runs with the network off. `h_audit` and `h_verify` move from Librarian and Prompter to the `auditor` principal, because the Librarian has internet.
5. Finance:
   - move finance tables out of `cc.db` into an encrypted `finance.db`;
   - a Finance Librarian intake endpoint (receipt or invoice image → support-tier vlm OCR → JSON → `finance_librarian_rag`);
   - the Finance agent does bookkeeping in `finance_rag`;
   - finance phrases route to `finance`, not `ops`.
6. A one-way `archive_job` writes to `D:\ai-hub-archive\cold` (AES-GCM, manifest). Restore is a human-only command.
7. Integration tests: designer → finance, coder → finance_rag and auditor → external URL all fail closed with audit entries; the existing build-loop suites stay green.

### Phase 3: deterministic ops
1. Telemetry JSONL (`D:\ai-hub-memory\ops\telemetry`), written by the gateway and brokers: `ts, agent_id, tier, latency_ms, vram_swap_ms, repair_pass_count, escalated, cache_bytes, policy_denials`. It carries no payloads.
2. A **host collector** in the app records facts a WSL2 container can't see: listening ports per process, cache directory sizes, denial counts, and its own heartbeat.
3. **Observer** container: a read-only mount of the telemetry directory, rolling baselines, and Markdown proposals in `ops/observer_proposals/`. It has no write access to source, config or models.
4. **Security & Garbage** container:
   - audits denials and collector facts against the topology;
   - garbage-collects **only** mounted cache volumes (`.iterations/*`, temp probe profiles, `.agenticos/runs/*.jsonl`) to `cache_quota_mb`;
   - writes a heartbeat;
   - emits `SILENT_FAILURE_FLAG` when expected telemetry stops.
5. A **host watchdog** in the app raises the flag in the status bar when the sidecar's own heartbeat stops, which also covers Docker being down.
6. `docker-compose.ops.yml`: read-only telemetry mount, read-write only on the cache volumes and the proposals directory, `network_mode: none`, non-root, `read_only: true` rootfs.
7. Tests: quota exceeded → cleanup; missing heartbeat → flag; degraded pass metrics → a proposal file.

---

## 6. Decisions I need from you

- **Q1. P0 hotfixes (F4, F5).** Ship them ahead of Phase 1 as a small separate fix, or keep them at the head of Phase 2?
- **Q2. Auditor model and F7.** Should the Auditor share the coder weights (as in your draft) or use a different local family? And should the live `policy.verifier = ext:claude-cli` be switched to the local auditor tier? That is required for "strictly offline".
- **Q3. Escalation approval.** Keep `require_approval: true` (a card for every escalation) as the default?
- **Q4. `server.py` CLI hop.** The `agentic-os` hop forwards turns to the opencode / agy / claude / gemini CLIs without the diffuser. Should it be brought under the diffuser and the kill switch, or dropped from Tony's chain?
- **Q5. MoE candidate download.** May the bake-off download Qwen3-Coder-30B-A3B (about 18.6 GB to `D:`)?

---

## 7. Proposed `ARCHITECTURE_DECISIONS.md` additions (AD-14 … AD-19)

> Not applied: the main checkout has uncommitted edits to that file. These go in the Phase 1 and Phase 2 branches once approved.

**AD-14: One model gateway, routed by principal and tier.**
- Every local or cloud model call resolves through `model_gateway::route(principal)` against `config/agent_topology.yaml` (versioned, `deny_unknown_fields`, validated at startup).
- No module names a provider id, port or model.
- `providers.json` keeps the endpoint and key registry. The topology maps principals to tiers and tiers to providers and models.
- Python reads the Rust-written `routes.resolved.json`.
- An invalid topology fails closed to `single_model_fallback`.
- LiteLLM was considered and rejected: it proxies but doesn't manage LM Studio lifecycle or the GPU baton, and it would add a loopback hop outside the diffuser.

**AD-15: VRAM phase staging.**
- One chat or coder model is hot at a time (`max_concurrent_vram_models: 1`, embeddings pinned separately).
- Before a load, the controller unloads least-recently-used non-pinned models while `loaded + need > vram_gb - reserved_vram_gb`.
- A build holds a `build` phase lease. `coder_verifier` loads once per build, support stages ride it, and an explicit unload follows the build.
- Tony preempts only at call boundaries, through the GPU baton, with `swap_hysteresis_secs`.
- Tier GGUFs are prewarmed into the page cache (`D:` is an HDD: 50–60 s cold vs 9–10 s warm, measured).
- Every swap is logged with its unload and load timings.
- `single_model_fallback: true` collapses every tier to `fallback_model`.

**AD-16: Hybrid escalation gate.**
- `last_eval.local_passes` counts every Coder pass, gate repair included, durably.
- After `max_local_repair_passes` repair passes, a still-failing build-loop task escalates **once** via the approval-gated `claude-cli` lane.
- The bundle holds the criteria, failing gate and probe lines, blockers, the last iteration diff and capped code excerpts. It is scrubbed and diffused. Finance, Booking, RAG, librarian notes and transcripts are refused by construction.
- The result is gated locally. A failure is final (needs-fixes or the Repair Queue). Never a second escalation, never an unbounded loop.

**AD-17: Principals and allowlists at the brokers.**
- Agent identity is minted in Rust; the webview requests routes, never identities.
- The five brokers (Tony delegation, the TaskEnvelope worker, the build hub, the MCP router, the gateway) check `(source, target)`, store access, tools and egress against the topology.
- Default is deny. Denials fail closed and are appended to an HMAC-chained `security-audit.jsonl`.
- Per-channel AEAD between in-process modules was rejected as security theatre. Integrity comes from signed principals. Confidentiality comes from at-rest encryption and authenticated cross-process loopback.

**AD-18: Store isolation, Finance sandbox, cold vault.**
- Each isolated agent binds only to its RAG root under `data_root` (outside the repo). The build loop shares `build_loop_rag`.
- Finance data leaves `cc.db` for an encrypted `finance.db`.
- The Finance Librarian (local vlm OCR, no egress) is Finance's only peer.
- The Auditor has no network handle and reads only staging and tasks.db.
- `archive_job` writes one way to an AES-GCM vault at `D:\ai-hub-archive\cold`. No live agent can read it, and restore is human-only.
- `training_logs` are scrubbed, and booking and finance turns never reach them or Drive sync.

**AD-19: Deterministic ops sidecars.**
- Telemetry is metadata-only JSONL.
- A host collector records ports, cache sizes and denials, which a WSL2 container can't observe.
- The Observer and Security & Garbage containers mount telemetry read-only, run with no network and as non-root, and write only proposals, mounted caches and their heartbeat.
- The Observer proposes and never applies.
- Allowlist enforcement stays in-process. The sidecar audits it.
- A host watchdog raises `SILENT_FAILURE_FLAG` when sidecar heartbeats or expected telemetry stop.
