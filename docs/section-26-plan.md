# Section 26: built-in llama.cpp engine (replaces AnythingLLM, takes LM Studio out of Tony's path)

Branch `section-26-engine`, worktree `G:\agentic-os-engine`. Planning doc name was "remove-anythingllm";
the branch keeps the name `section-26-engine` on purpose.

Goal: Gabagoul talks straight to the model with no AnythingLLM layer. Fewer hops, fewer things to break,
one place to control everything. Nothing is ripped out: the new path runs beside the old one behind a
switch that is **off by default**, and nothing cuts over without Nic.

## Ground rules (from Nic)

- Engine setting off by default. LM Studio (Bionic) and AnythingLLM keep working the whole time.
- No cutover, no deletes, no uninstall without Nic. Ask before touching trading or money code, the
  vault, safety controls, or switching Tony.
- Small commits; tests before each; STATUS.md after each.
- Running low on usage: stop at a clean commit, handoff note at the top of STATUS.md.

## What already exists (found 11-27)

| Piece | Where | Notes |
|---|---|---|
| Tony's model | Bionic (LM Studio) `127.0.0.1:1235/v1`, `qwen/qwen3.5-9b` Q4_K_M, 32k x 2, flash attn | GGUF is on C: in `~/.lmstudio/models/lmstudio-community/Qwen3.5-9B-GGUF/` (5.24 GB) |
| Provider config | `<app-config>/providers.json`, provider `lmstudio` | `dispatch.rs`; gateway reads it in `gateway_tony.tony_model()` |
| Gateway Tony | `gateway_tony.py` `build_messages` + `command_center_api.llm_stream` | Phone turns when the desktop is away |
| GPU baton | gateway `PUT /api/os/gpu` (15 min cap), `model_swap.rs` unload/load/verify | ComfyUI borrows the GPU through it |
| CPU embedder | `llama-server` on **:1237**, nomic-embed-text v1.5 Q4_K_M (Bionic's bundled copy), started by `G:\ai-startup\start-ai-stack.ps1` step 1a | 0 VRAM. Reused, not re-downloaded |
| Gateway vault | `command_center_api.py` `vault` table, hybrid BM25 + nomic vectors | Holds finance + private collections: **ask before changing** |
| Local model scan | `os_api.py` `/api/models/local-scan` (Section 20.14) | Model manager builds on it |
| Port 1236 | reserved by `start-ai-stack.ps1` for a CPU Tony instance (off) | So the new engine uses **:1238** |

## Approved now (11-27): steps 1-4, 6, 7

1. **Baseline benchmark** `engine/bench_tony.py`: Tony's real messages (`gateway_tony.build_messages`)
   streamed to Bionic; time to first token + total, medians over repeats. Refuses to run unless Tony's
   model is already loaded (a request to an unloaded model JIT-loads it at bad defaults) and the GPU
   baton is free. Results in STATUS.md.
2. **Engine runner** `engine/llama_engine.py`: supervises a pinned official CUDA `llama-server`
   (`D:\llama.cpp\<version>`) on `127.0.0.1:1238`. OpenAI-compatible, streaming, `--cache-reuse`,
   `--slot-save-path`, flash attention, no idle unload (keep warm). Context length, GPU layers, KV cache
   type, parallel slots, prompt cache, keep-warm all from settings. `engine.enabled` = **false** by
   default. Tests use a fake server.
3. **Model manager** `engine/models.py`: lists GGUFs in the model roots (D: + `~/.lmstudio/models`),
   load / unload one model at a time, VRAM from `nvidia-smi`, a fit check (weights + KV cache + margin)
   that **refuses** a load that would not fit next to what is already on the card (Bionic, STT).
4. **Provider entry**: a `llamacpp` provider (`http://127.0.0.1:1238/v1`), disabled. Tony and the
   gateway stay on `lmstudio`; a test pins that.
6. **Document store** `engine/docstore.py`: its own SQLite (not the vault), chunks + nomic vectors via
   the existing CPU embedder (:1237, `command_center_api.embed`). Add / re-index on change (content hash)
   / search. Wiring it into the gateway vault waits for Nic.
7. **AnythingLLM import** `engine/allm_import.py`: read-only copy of AnythingLLM workspaces, documents
   and chats into a dated export folder, then into the document store. Originals untouched; a count
   report shows nothing is missing. Export kept until Nic confirms.

## Held for Nic's OK

5. **Benchmark the new engine.** Nic unloads the model in Bionic when asked; engine loads the 9B; same
   bench + stress probe; then Bionic is restored. After Nic's merge / rebuild / live Tony checks.
8. **App rebuild** to show the engine switch / model screen in Settings.

## Must also cover (Section 26), in order

9. **Inventory of everything AnythingLLM does** (workspaces + prompts, skills, MCP servers, Gmail and
   Calendar Apps Script agents, RAG + embeddings incl. memory scrolls, chat history, phone endpoints),
   each mapped to its new home in the gateway. ~25 Rust files reference it today (`mcp.rs`, `agents.rs`,
   `os_core.rs`, `memory.rs`, `allm.rs`, `allm_audit.rs`, `gmail.rs`, `calendar.rs`, `documenter.rs`,
   `taskworker.rs`, `modellab.rs` ...) plus `memory_scrolls/`.
10. **Migrate the AnythingLLM agents into the gateway config**: each agent = prompt + tool list + memory
    section in Gabagoul's own config, calling the shared model directly. Tools only from Tony's MCP
    registry (one owner per tool, read-only rules kept). Gmail / Calendar agents included.
11. **Chat template + tool-call check for Qwen** (`--jinja`, the GGUF's own template; per-family
    overrides), tested against the Model Lab test set **before any cutover**.
12. **Watchdog**: health-check the engine; on a crash restart `llama-server`, reload Tony's model, log
    it; a start limit so it can never crash-loop.
13. **GPU baton**: the engine unloads / reloads for ComfyUI and training through the existing baton,
    keeping `model_swap.rs`'s "only Tony's model, at production settings" check.
14. **Document intake for the vault**: PDFs, docs and scripts extracted, chunked, embedded, re-indexed on
    change (builds on step 6).
15. **Switchboard toggle** per path (LM Studio / AnythingLLM vs built-in engine), off by default; prove
    the new path with the test set + stress tests; then ask Nic to switch.
16. **Phone**: talks only to the gateway; no AnythingLLM endpoint anywhere in the app.
17. **Standard API**: the engine's OpenAI-compatible endpoint, so Scene Reader, n8n, the phone and other
    tools work unchanged.

## Optional (last; plan only if usage is short)

18. **Vision model for receipt / document OCR** through the GPU baton (`--mmproj` on the engine) or CPU.
19. **Model screen in the app**: browse, resumable single-file Hugging Face download, swap, test,
    delete (always asks), size and VRAM fit.

## Later, not now

Per-agent LoRA adapters hot-swapped on one base model. Kept compatible: one base model per slot, the
request shape leaves room for llama-server's `lora` field (`--lora` + per-request scales). Not built.

## Progress (11-27, autonomous session)

| Item | State | Where |
|---|---|---|
| 1 Baseline bench | Done 10:31: LM Studio first token 0.37 s median, total 1.71 s (STATUS.md) | `engine/bench_tony.py` |
| 2 Engine runner | Done, off. llama.cpp b12317 CUDA 12.4 installed + sha256-verified in `D:\llama.cpp\b12317` | `engine/install_llama.py`, `engine/llama_engine.py` |
| 3 Model manager | Done. Fit check from GGUF metadata (Qwen3.5 9B @ 32k x 2: 7.3 GB) | `engine/gguf_meta.py`, `engine/models.py` |
| 4 Provider entry | Done (`llamacpp`, not in any chain) | `dispatch.rs` |
| 5 New-engine bench | **Waiting for Nic** (needs Bionic's model unloaded) | |
| 6 Doc store | Done (separate from the vault) | `engine/docstore.py` |
| 7 AnythingLLM export/import | Done; export 20261127-101548 | `engine/allm_import.py` |
| 9 Inventory | Done | `docs/section-26-allm-inventory.md` |
| 11 Template / tool calls | Static checks done; live on Bionic 3/3 OK (reference for the engine) | `engine/template_check.py` |
| 12 Watchdog | Done | `engine/watchdog.py` |
| 13 GPU baton | Engine side done (`/api/engine/yield`, `/reclaim`); `model_swap.rs` calls them at cutover | `engine/baton.py` |
| 17 Standard API | llama-server's own OpenAI endpoint on :1238; gateway control routes `/api/engine/*` (loopback only) | `engine/api.py`, `server.py` |
| 19 Model screen | Settings → Services → "Built-in engine" (needs an app rebuild to see) | `EngineCard.tsx`, `features/engine/engine.ts` |
| 8 App rebuild | **Waiting for Nic** | |
| 10 Agent migration | Proposal generator done (read-only; not wired). 3 questions for Nic (tool owners, bizops prompt, Tony's workspace prompt) | `engine/agents_migrate.py` |
| 14, 15, 16 | Not started (vault intake, switchboard, phone check) | see inventory |

### Findings that matter at cutover

1. **Thinking control.** Qwen3.5's template reads only `enable_thinking`. LM Studio maps
   `reasoning_effort: "none"`, llama-server does not. The gateway sends both (fine); `dispatch.rs`
   sends only `reasoning_effort`, so the engine now defaults thinking OFF
   (`--chat-template-kwargs {"enable_thinking":false}`); a request can still turn it on.
2. **Prompt cache.** The template drops the empty think block from earlier assistant turns, so the
   last exchange is re-read each turn (system prompt and older history stay cached). Same in LM Studio.
3. **VRAM.** Engine and Bionic can't both hold the 9B (10.5 GB used by Bionic now). Cutover = unload in
   Bionic, load in the engine; the fit check refuses anything else.
4. **Tool calls.** The app never sends native `tools`; Tony uses the JSON router prompt. Native
   Qwen XML tool calls work only with `--jinja` (on), for outside clients (n8n).

## Item 18: vision / OCR plan (plan only)

Today: `command_center_api.ocr` sends receipt / document images as `image_url` to LM Studio with
`llm.visionModel` (empty = whatever is loaded). Tony's Qwen3.5 9B GGUF ships a vision projector
(`mmproj-Qwen3.5-9B-BF16.gguf`, 0.86 GB), so the cheapest path needs **no second model**:

1. Engine setting `mmproj` = that projector. The fit check already counts it (`projectorMiB`):
   7.3 + 0.9 = 8.2 GB, still under the card with Bionic gone.
2. OCR posts to the engine's `/v1/chat/completions` with `image_url` (llama-server's multimodal
   input), model = Tony's alias: one model serves chat and OCR, no swap, no baton round trip.
3. Fallback for heavy batches (a box of receipts): the baton. `yield_gpu("ocr batch")`, run a
   dedicated VL model (Qwen2-VL 7B is on D:) through the model manager, `reclaim_gpu()`.
4. CPU fallback when the GPU is lent out (ComfyUI): a small VL GGUF with `-ngl 0` on another port;
   slow (tens of seconds per receipt) but it never blocks Tony.
5. Test set: 10 real receipts from the vault's scans (Nic picks; finance data stays local), compare
   totals / dates / vendors against LM Studio's current answers before switching.

## Item 15: switchboard toggle, design (not built: it is Tony's request path)

Switching Tony is more than a `providers.json` base_url change, because gateway Tony and
`model_swap.rs` talk to **Bionic's own API**, which llama-server does not serve:

| Today (Bionic) | Call | Engine equivalent |
|---|---|---|
| `gateway_tony.model_state` | `GET /api/v0/models` (state per model) | `GET /health` (200 / 503 loading) + `GET /v1/models` (the alias) |
| `gateway_tony._cold_load` | `POST /api/v1/models/load` with `load_body` | `POST /api/engine/load` (gateway) or `ModelManager.load` |
| `model_swap.rs` unload_all / load_tony / verify_only_tony | LM Studio REST | `POST /api/engine/yield` / `reclaim` + `GET /api/engine/status` |
| `allm_audit.loaded_lmstudio_model` | `GET /api/v1/models` | `GET /api/engine/status` |
| Chat | `POST /v1/chat/completions` | same (OpenAI-compatible), thinking off by default |

Proposed switch: one setting `engine.json routeTony` (default false) read per turn, plus a per-path
switchboard row (gateway Tony, desktop Tony chain, workers, Model Lab). With it on:
1. `tony_model()` returns the engine base; `model_state` / `_cold_load` take an engine branch.
2. `dispatch.rs`: `llamacpp` replaces `lmstudio` at the head of `policy.chain` (one migration,
   reversible); `is_allm_shim` unchanged.
3. `model_swap.rs`: an engine branch using yield / reclaim.
4. Rollback = the same switch off (Bionic must reload Tony's model: `model_swap::restore_tony`).
Proof before switching: Model Lab compare (`modellab/compare.rs`, engine as side B), the live
template checks (3/3 on Bionic today), `bench_tony --target engine`, the Heavy stress probe.
