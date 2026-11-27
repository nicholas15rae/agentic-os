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
