/**
 * Platform adapter — the ONLY place that knows whether we run inside the
 * Tauri desktop shell or as a plain PWA in a browser.
 *
 * Rule of thumb for feature code:
 *   - Anything needing secrets, the local filesystem, processes (docker,
 *     netbird, nvidia-smi) or outbound LLM calls goes through `native()`.
 *   - On the PWA those same features go through the Agentic OS gateway
 *     (the FastAPI backend on the desktop, reached over NetBird) — never
 *     by putting API keys in the browser.
 */

import { recordIpc } from "./ipc-ring";
import { MicLockedError, micEnabled } from "@/features/voice/mic-gate";
import type { Curiosity, DispatchPolicy, ModesView, TonyMode, Verbosity } from "@/features/modes/modes";

export type Platform = "desktop" | "pwa";

export const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const platform: Platform = isTauri() ? "desktop" : "pwa";

/** Invoke a Rust command. Throws on the PWA — guard with `isTauri()` or use a hook with a fallback.
 *  Every invoke passes the Rust security gate (src-tauri/src/security/gate.rs). A
 *  `STEP_UP_REQUIRED:<module>` refusal opens the PIN modal and, once unlocked, retries the
 *  command once; `LOCKED` / `HARD_LOCKED` refresh the security status (the lock screen takes over). */
export async function native<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error(`native command "${cmd}" is desktop-only`);
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    if (typeof e === "string" && /^(STEP_UP_REQUIRED|LOCKED|HARD_LOCKED):/.test(e) && !cmd.startsWith("security_")) {
      const { onSecurityRefusal } = await import("@/features/security/store");
      if (await onSecurityRefusal(e)) return invoke<T>(cmd, args);
    }
    throw e;
  }
}

/** Typed contract for every Rust command exposed in src-tauri/src/lib.rs. Keep in sync. */
export interface NativeCommands {
  system_stats: { args: undefined; result: SystemStats };
  // ── Language Hub (commands/language_hub.rs; types in features/language/contract.ts) ──
  lang_status: { args: undefined; result: import("@/features/language/contract").LangStatus };
  lang_library_list: { args: undefined; result: import("@/features/language/contract").LangEntry[] };
  lang_library_save: { args: { entry: import("@/features/language/contract").NewLangEntry }; result: import("@/features/language/contract").LangEntry };
  lang_library_update: { args: { id: string; patch: import("@/features/language/contract").LangEntryPatch }; result: import("@/features/language/contract").LangEntry };
  /** Permanent delete; returns how many rows went. */
  lang_library_delete: { args: { ids: string[] }; result: number };
  lang_tracks_list: { args: undefined; result: import("@/features/language/contract").LangTrack[] };
  lang_track_save: { args: { track: import("@/features/language/contract").LangTrack }; result: import("@/features/language/contract").LangTrack };
  /** Audio on the chosen TTS provider (default Kokoro); rejects with UNSUPPORTED_LANG / NO_LOCAL_TTS / KILL_SWITCH so the caller falls back. */
  lang_tts: { args: { text: string; lang: string; engine?: string; voice?: string; model?: string }; result: ArrayBuffer };
  /** TTS providers the Language Hub's Voice panel offers (no keys). */
  lang_voice_engines: { args: undefined; result: import("@/features/language/contract").VoiceEngineInfo[] };
  lang_settings_get: { args: { key: string }; result: unknown };
  lang_settings_set: { args: { key: string; value: unknown }; result: void };
  lang_llm_json: { args: { system: string; prompt: string }; result: unknown };
  /** Stops the on-demand multilingual Whisper sidecar; true if one was running. */
  lang_release: { args: undefined; result: boolean };
  secret_set: { args: { provider: string; value: string; slot?: "api" }; result: void };
  /** Android only: Keystore-encrypted phone secrets (allow-listed keys). */
  phone_secret_get: { args: { key: "gateway-token" }; result: string | null };
  phone_secret_set: { args: { key: "gateway-token"; value: string }; result: void };
  secret_status: { args: { providers: string[] }; result: Record<string, boolean> };
  secret_delete: { args: { provider: string; slot?: "api" }; result: void };
  bridge_get: { args: undefined; result: BridgeView };
  bridge_set: { args: { scope: BridgeScope; tier: BridgeTier }; result: BridgeView };
  pipelines_status: { args: undefined; result: PipelinesView };
  pipeline_run: { args: { instanceId: string; workflowId: string; approved?: boolean }; result: RunResult };
  pipeline_set_active: { args: { instanceId: string; workflowId: string; active: boolean; approved?: boolean }; result: boolean };
  pipelines_settings: { args: undefined; result: PipelinesSettings };
  pipelines_settings_update: { args: { patch: Partial<PipelinesConfig>; approved?: boolean }; result: PipelinesSettings };
  n8n_instance_add: { args: { label: string; baseUrl: string }; result: PipelinesSettings };
  trigger_gdrive_sync: { args: { approved?: boolean }; result: SyncResult };
  providers_list: { args: undefined; result: ProvidersView };
  providers_update: { args: { patch: ProviderPatch }; result: ProvidersView };
  provider_add: { args: { provider: NewProvider }; result: ProvidersView };
  provider_remove: { args: { id: string }; result: ProvidersView };
  policy_update: { args: { patch: PolicyPatch }; result: ProvidersView };
  /** Settings → Voice: edit one agent's roster row ("tony" is an alias of "general"). */
  agent_voice_update: { args: { role: string; patch: AgentVoicePatch }; result: ProvidersView };
  /** Settings → Voice: the roster's master "All Tony" switch (every agent report in Tony's voice). */
  agent_voices_all_tony: { args: { on: boolean }; result: ProvidersView };
  /** Telemetry (`events.jsonl`, kind `agent_speech`): one agent report played / queued / replayed. Ids only. */
  agent_speech_event: { args: { agent: string; voice: string; outcome: "spoke" | "queued" | "inbox_only" | "replayed" | "failed"; interrupted: boolean; waitedMs: number; urgent: boolean }; result: void };
  dispatch_chat: { args: { req: DispatchRequest }; result: DispatchResult };
  services_health: { args: undefined; result: ServiceHealth[] };
  provider_models: { args: { id: string }; result: string[] };
  gateway_ensure: { args: undefined; result: GatewayStatus };
  stt_configure: { args: { model?: string; language?: string }; result: string };
  /** Native full-duplex audio engine (src-tauri/src/audio). Events on "audio-engine". */
  audio_engine_devices: { args: undefined; result: AudioDevices };
  audio_engine_start: { args: { options?: AudioEngineStartOptions }; result: AudioEngineStatus };
  audio_engine_stop: { args: undefined; result: void };
  audio_engine_status: { args: undefined; result: AudioEngineStatus };
  /** Cut the assistant off now. False if it was already cut off. */
  audio_engine_barge_in: { args: undefined; result: boolean };
  /** Fake assistant turn (a tone) to test output and barge-in by talking over it. */
  audio_engine_test_tone: { args: { freqHz?: number; ms?: number }; result: void };
  /** Returns raw audio bytes (mp3 for Kokoro, wav for XTTS). `voice` overrides for previews;
   * `agent` (Part 3) picks a voice-roster entry when no explicit `voice` is given.
   * `previousText` (Part 6 §2) is the sentence spoken right before this one in the
   * same reply, for ElevenLabs prosody continuity; ignored by local engines.
   * `utteranceId` (P1) names the reply this sentence belongs to — the ElevenLabs circuit
   * breaker's scope: after one failure the rest of that reply goes straight to local TTS
   * with a single `tts-fallback` event. 1–64 chars of `[A-Za-z0-9-]`, else ignored.
   * `localOnly` (Part 6 narration, `feedback.narrationEngine: "kokoro"`): the local engine in
   * this agent's own local voice, sparing the ElevenLabs quota.
   * `model` (agent reports): the ElevenLabs model for this line ("eleven_turbo_v2_5"), over the roster row's. */
  tts_synthesize: { args: { text: string; voice?: string; agent?: string; previousText?: string; utteranceId?: string; pinId?: string; localOnly?: boolean; model?: string }; result: ArrayBuffer };
  /** `engine` previews an engine's voices even when it isn't the current `policy.tts`. */
  tts_voices: { args: { engine?: string }; result: VoicesView };
  n8n_workflows: { args: undefined; result: WorkflowInfo[] };
  n8n_workflows_set: { args: { workflows: WorkflowInfo[] }; result: WorkflowInfo[] };
  n8n_trigger: { args: { name: string; payload: Record<string, unknown> }; result: string };
  /** Read-only workflows only (mutating ones are refused in Rust). */
  n8n_fetch: { args: { name: string; payload?: Record<string, unknown> }; result: unknown };
  n8n_discover: { args: { adopt?: boolean }; result: N8nDiscovery };
  docker_ps: { args: undefined; result: DockerContainer[] };
  netbird_status: { args: undefined; result: NetbirdStatus };
  // ── Agentic OS core ("Tony") ──
  os_config_get: { args: undefined; result: OsConfig };
  /** Phase 2 Part B: the hard Mic switch. Returns the resulting state (an unmute is saved first). */
  mic_set_enabled: { args: { enabled: boolean }; result: boolean };
  /** The authoritative mic state (`voice::MIC_ENABLED`), for the webview's hydration. */
  mic_get: { args: undefined; result: boolean };
  os_config_update: { args: { patch: OsConfigPatch }; result: OsConfig };
  os_identity: { args: undefined; result: string };
  os_secret_set: { args: { name: OsSecret; value: string }; result: void };
  os_secret_status: { args: undefined; result: Record<OsSecret, boolean> };
  /** Where each OS secret is resolved from (env → repo .env → keychain). Presence and source names only, never values. */
  os_secret_sources: { args: undefined; result: OsKeySources };
  os_secret_delete: { args: { name: OsSecret }; result: void };
  privacy_last_payload: { args: undefined; result: RedactionRecord | null };
  privacy_preview: { args: { text: string }; result: { redacted: string; replacements: Replacement[] } };
  droplet_test: { args: undefined; result: EndpointProbe[] };
  network_audit: { args: undefined; result: ListenFinding[] };
  gateway_token_rotate: { args: undefined; result: string };
  anythingllm_workspaces: { args: undefined; result: WorkspaceInfo[] };
  /** Read-only AnythingLLM audit (GETs only): duplicate names, role/name mismatches, unused slugs, chat modes, models. */
  anythingllm_workspace_audit: { args: undefined; result: AllmAudit };
  os_turn: { args: { req: OsTurnRequest }; result: OsTurnResult };
  /** Phase 2 "cut it": drop an in-flight os_turn (its LLM / sub-agent streams) by streamId. */
  os_turn_cancel: { args: { streamId: string }; result: void };
  overseer_ask: { args: { req: { question: string; transcript: ChatMessage[]; context: string; engine?: string } }; result: { answer: string; engine: string; latencyMs: number; redacted: boolean } };
  mcp_list_tools: { args: { refresh?: boolean }; result: ServerTools[] };
  /** Tool NAMES Tony's next turn would see (every tool of his servers / those offered to his LLM router). No secrets. */
  tony_tools_preview: { args: undefined; result: TonyToolsPreview };
  /** `agent` is REQUIRED (Part 4): Rust gates every non-Tony agent by role
   * (`PERMISSION_ROLE:` / `PERMISSION_READ_ONLY_ROLE:`). Prefer `mcpCall` (lib/mcp-call.ts). */
  mcp_call: { args: { name: string; args: Record<string, unknown>; approved?: boolean; agent: string }; result: string };
  mcp_sync_anythingllm: { args: undefined; result: AllmSyncReport };
  /** Read-only check of the Librarian's AnythingLLM side (GETs + reading AnythingLLM's MCP file). */
  librarian_preflight: { args: undefined; result: LibrarianGuard };
  /** Which Gmail backend `gmail.*` tools use; credentials are set via `os_secret_set` (`gmail-script-id` / `gmail-script-key`). */
  gmail_status: { args: undefined; result: { configured: boolean; source: "script" | "n8n" | "none" } };
  /** Copies AnythingLLM Desktop's Gmail agent deployment into the keychain (values never reach the webview). */
  gmail_import_anythingllm: { args: undefined; result: { imported: boolean; detail: string } };
  /** Only after the confirmation card: returns `PERMISSION_REQUIRED:gmail-draft` unless `approved`. */
  gmail_create_draft: { args: { to: string; subject: string; body: string; approved?: boolean }; result: string };
  /** The booking-mail check's editable instruction file (os.json `gmail.bookingInstructionsPath`): path, a 4 KB preview (secrets scrubbed), what the scan uses.
   * `refused`: why the path isn't read (only a .md / .txt note under G:\ai-hub or an fsRoot, never .env); the built-in search is used then. */
  gmail_booking_instructions: { args: undefined; result: { path: string; exists: boolean; preview: string; spec: { query: string; read: number; rules: string; source: "file" | "default" }; refused?: string } };
  /** Opens that file in Notepad (only a path the check may read). */
  gmail_booking_instructions_open: { args: undefined; result: void };
  /** The last booking scan's threads (memory only, 2 h): the desktop's calendar-add card reads its fields from here. */
  gmail_last_bookings: { args: undefined; result: import("@/features/orchestrator/bookings").BookingRef[] };
  /** Which Google Calendar backend `calendar.*` tools use (names only; credentials `gcal-script-id` / `gcal-script-key` or GCAL_SCRIPT_ID / GCAL_SCRIPT_KEY). */
  gcal_status: { args: undefined; result: { configured: boolean; source: "env" | "keychain" | "none" } };
  /** Copies AnythingLLM Desktop's Google Calendar agent deployment into the keychain (values never reach the webview). */
  gcal_import_anythingllm: { args: undefined; result: { imported: boolean; detail: string } };
  /** Only after the confirmation card: returns `PERMISSION_REQUIRED:calendar-create` unless `approved`. Primary calendar, no invites, America/Toronto. */
  gcal_create_event: { args: { args: import("@/features/orchestrator/calendar-add").CalendarArgs; approved?: boolean }; result: string };
  /** OpenStreetMap routing (Rust: Nominatim + OSRM). Also emits `map-route` for the Route Map widget. */
  map_route: { args: { destination: string; origin?: string; stops?: string[] }; result: MapRoute };
  map_geocode: { args: { query: string }; result: MapPlace[] };
  map_reverse: { args: { lat: number; lng: number }; result: MapPlace };
  /** Opens Google Maps directions (built in Rust from coordinates) in the system browser. */
  map_open_in_maps: { args: { lat: number; lng: number; stops?: MapPlace[] }; result: string };
  /** Live maps health (tiny OSRM probe, cached 60 s; `force` re-probes). */
  maps_status: { args: { force?: boolean }; result: MapsStatus };
  /** Live Instagram status via `GET /me` (cached 60 s; `force` re-checks). Never returns the token. */
  instagram_status: { args: { force?: boolean }; result: InstagramStatus };
  instagram_refresh_token: { args: undefined; result: string };
  /** Only after the confirmation card: `PERMISSION_REQUIRED:instagram-reply` unless `approved`. */
  instagram_reply_comment: { args: { commentId: string; message: string; approved?: boolean }; result: string };
  /** Only after the confirmation card: `PERMISSION_REQUIRED:instagram-publish` unless `approved`. */
  instagram_publish_post: { args: { caption: string; imageUrl?: string; videoUrl?: string; approved?: boolean }; result: string };
  /** Opens Spotify's consent page in the system browser and returns its URL (fallback link);
   * the outcome arrives as the `spotify-auth` event. */
  spotify_auth_start: { args: undefined; result: { url: string } };
  /** `configured` = SPOTIFY_CLIENT_ID is in the env / repo .env; `connected` = a refresh token is stored. */
  spotify_status: { args: undefined; result: SpotifyStatus };
  spotify_disconnect: { args: undefined; result: void };
  spotify_now_playing: { args: undefined; result: SpotifyNowPlaying };
  /** `value`: volume → number (absolute %) or "+N" / "-N"; shuffle → boolean / "on" / "off" (omit to toggle).
   * `approved` only matters when the MCP permission tier is Ask. Resolves to a short reply ("Paused Spotify."). */
  spotify_control: { args: { action: SpotifyAction; value?: number | string | boolean; approved?: boolean }; result: string };
  spotify_play: { args: { query: string; kind?: "track" | "artist" | "album" | "playlist"; approved?: boolean }; result: string };
  spotify_play_uri: { args: { uri: string; approved?: boolean }; result: string };
  spotify_recent: { args: undefined; result: SpotifyItem[] };
  spotify_playlists: { args: undefined; result: SpotifyItem[] };
  /** The one Spotify grammar (Rust `spotify_intent::parse`): pure, no gate, no network. Null = not a Spotify line. */
  spotify_parse: { args: { text: string; osName?: string }; result: SpotifyIntent | null };
  /** Run one Spotify tool. Kill switch, server on/read-only, `may_read` (reads) or the MCP tier +
   * destructive gate (writes) apply in Rust. Resolves to a speakable reply (no IDs / URIs). */
  spotify_tool: { args: { name: SpotifyToolName; args?: Record<string, unknown>; approved?: boolean }; result: string };
  /** Speech ducking over the Web API — the P4 FALLBACK, used only when `media_duck` found no local
   * Spotify session: BY `reduction`% (0–50) with one PUT, no fade (legacy `level` = TO that %). Only
   * when it plays on this PC with volume control. False = not ducked; never throws for a refusal, never logged. */
  spotify_duck: { args: { level?: number; reduction?: number }; result: boolean };
  /** P4 local duck: the Spotify desktop app's own Windows audio session fades down BY `reductionPct`%
   * (0–50, default 15) over `fadeMs` (60–200, default 120). Kill switch = no new duck. `spotifyLocal`:
   * an active local Spotify session exists (then the Web API fallback must not run). Never throws. */
  media_duck: { args: { reductionPct?: number; fadeMs?: number }; result: MediaDuckReport };
  /** Ramp back over `fadeMs` (60–600, default 320); a session moved since is left alone. Never gated.
   * True = the ducker didn't answer (still ducked as far as Rust knows). */
  media_unduck: { args: { fadeMs?: number }; result: boolean };
  media_duck_status: { args: undefined; result: MediaDuckStatus };
  /** Undo `spotify_duck` unless the volume was changed since. Silent no-op when nothing is ducked; never
   * gated (it only undoes the app's own change). True = still ducked (restore failed / timed out): retry. */
  spotify_unduck: { args: undefined; result: boolean };
  /** Windows OS-alarm fallback (alarm.rs): a one-shot Scheduled Task under \AgenticOS\ that shows an alarm
   * toast at `dueAtMs` even when the app is closed. id: 1–64 [A-Za-z0-9-]; title: 1–120 chars; due: 5 s–366 days ahead. */
  alarm_os_schedule: { args: { id: string; title: string; dueAtMs: number }; result: void };
  /** Remove reminder `id`'s OS alarm (no error when there is none). */
  alarm_os_cancel: { args: { id: string }; result: void };
  /** Remove every OS alarm whose reminder id isn't in `liveIds` (startup cleanup). */
  alarm_os_prune: { args: { liveIds: string[] }; result: void };
  skills_scan: { args: undefined; result: SkillInfo[] };
  memory_harvest: { args: { req: { month?: string; period?: HarvestPeriodName } }; result: LedgerEntry };
  memory_flush: { args: { req: { month: string; includeLocal?: boolean; approved?: boolean } }; result: string[] };
  memory_ledger: { args: undefined; result: LedgerEntry[] };
  memory_mount: { args: { req: { month: string; target: "local" | "droplet"; approved?: boolean } }; result: LedgerEntry };
  memory_unmount: { args: { req: { month: string; target: "local" | "droplet" } }; result: LedgerEntry };
  memory_export: { args: { month: string; kind: "raw" | "summary" | "dataset" }; result: string };
  /** Phase 3 "Compact & Sync Memory": runs the host `memory_scrolls compact` now if the system is idle.
   * Never throws for a busy system: the outcome carries `deferred` instead. */
  memory_compact: { args: undefined; result: CompactOutcome };
  /** Phase 3: the CLI `status --json` (read-only) + auto-compaction settings, last outcome, running / idle. */
  memory_compaction_status: { args: undefined; result: CompactionStatus };
  /** The inline badge next to "Auto-compact when idle" (cheap; no CLI). */
  memory_idle_state: { args: undefined; result: IdleBadge };
  /** Distill pending notes, Embed-scrolls-only on, un-embed raw `Idea:` notes + duplicate scrolls. */
  memory_purge_raw_vectors: { args: { approved?: boolean }; result: { compaction: string; rawNotesRemoved: number; scrollDuplicatesRemoved: number; scrollsKept: number; embedOnly: boolean } };
  /** The "Hygiene & Buffer Pressure" bar. */
  hygiene_status: { args: undefined; result: HygieneStatus };
  /** "Quick Hygiene Sweep": Garbage pass + pending check (+ background compaction when over threshold). */
  hygiene_sweep: { args: undefined; result: { garbage: Record<string, number>; compaction: string; status: HygieneStatus } };
  memory_scrolls_preset: { args: { name: ScrollsPreset }; result: OsConfig };
  market_candles: { args: { symbol: string; interval: string; range: string }; result: import("./cc-api").MarketData };
  /** Legacy shim: an approved build → a queued task (returns at once). Prefer `task_create`. */
  idea_capture: { args: { text: string }; result: { idea: Idea & { id: string }; reply: string; steps: OsStep[]; taskId: string } };
  /** Ledger "Run" (behind the card) → a queued task for that idea (an open one is returned, not duplicated). Returns at once. */
  idea_pipeline_run: { args: { ideaId: string }; result: { taskId: string; created: boolean; cardId: string | null; hasHtml: boolean; steps: OsStep[] } };
  /** Queue a build (only after an approved Tier-3 yes / a ledger Run click). Returns at once; the worker does the rest. */
  /** `auto` (Phase 2 Part C): Builder mode's commit cue, queued without the spoken offer — Rust
   * refuses it (`MODE_NOT_AUTO`) unless the active mode is `auto_dispatch`, and refuses every build
   * under Solo (`MODE_SURFACE_ONLY`). */
  task_create: { args: { raw_intent: string; title?: string; thread?: string; source?: TaskSource; idea_id?: string; options?: Record<string, boolean>; dedupe_key?: string; auto?: boolean }; result: { task_id: string; created: boolean; status: TaskStatus; title: string } };
  // ── Tony modes (Phase 2 Part C; modes.rs) ──
  tony_modes_get: { args: undefined; result: ModesView };
  /** Switch the work mode (clears overrides, sets narration from the mode). The novelty overlay is refused. */
  tony_mode_set_active: { args: { id: string }; result: ModesView };
  /** Temporary manual dial changes (in memory until a switch / reset / restart). */
  tony_mode_override: { args: { patch: { curiosity?: Curiosity; dispatch?: DispatchPolicy; verbosity?: Verbosity } }; result: ModesView };
  tony_mode_reset: { args: undefined; result: ModesView };
  /** Create (`isNew`, default true) or edit a custom mode. Presets are read-only. */
  tony_mode_upsert: { args: { mode: TonyMode; isNew?: boolean }; result: ModesView };
  tony_mode_duplicate: { args: { id: string; newName?: string }; result: { mode: TonyMode; view: ModesView } };
  tony_mode_delete: { args: { id: string }; result: ModesView };
  task_get: { args: { task_id: string }; result: TaskEnvelope };
  task_list: { args: { status?: TaskStatus; limit?: number; include_log?: boolean }; result: TaskEnvelope[] };
  /** Status on demand: a templated answer from the store, no model call. */
  task_status: { args: { agent?: string; slug?: string }; result: TaskStatusAnswer };
  task_retry: { args: { task_id: string; offload?: string }; result: TaskEnvelope };
  task_cancel: { args: { task_id: string }; result: TaskEnvelope };
  agent_events_replay: { args: { afterSeq?: number }; result: { boot: number; events: AgentEvent[] } };
  playplace_iterate: { args: { cardId: string; notes: string; target: "designer" | "coder" }; result: PlayCard };
  playplace_approve: { args: { cardId: string }; result: PlayCard };
  playplace_commit: { args: { cardId: string }; result: PlayCard };
  comms_whatsapp: { args: { action: "chats" | "messages" | "contacts"; args: Record<string, unknown> }; result: string };
  comms_whatsapp_send: { args: { recipient: string; message: string; approved?: boolean }; result: string };
  cli_status: { args: undefined; result: CliStatus[] };
  cli_install: { args: { name: string; approved?: boolean }; result: string };
  /** Retry / Offload a failed task's step (`checkpoint` is the task id; an old checkpoint path errors clearly). */
  pipeline_resume: { args: { checkpoint: string; offload?: string }; result: { taskId: string; status: TaskStatus; stage: string | null; cardId: string | null } };
  droplet_link: { args: undefined; result: DropletLink };
  gpu_slot_view: { args: undefined; result: SlotView };
  model_lab_list: { args: undefined; result: LabModel[] };
  model_bench: { args: { model: string; context?: number }; result: BenchResult };
  model_use: { args: { model: string }; result: string[] };
  // ── System Map dev task queue (devqueue.db in the app config dir; works without the gateway) ──
  /** Category / priority are inferred from the text when omitted. `trace` (a failing step, for
   * `kind: "fix"`) and `ui` (whitelisted `DevUiState` keys) go into the Rust-built, secret-scrubbed snapshot. */
  dev_task_add: {
    args: { title: string; category?: DevTaskCategory; priority?: DevTaskPriority; body?: string; kind?: DevTaskKind; source?: DevTaskSource; trace?: DevTraceStep; ui?: DevUiState };
    result: DevTask;
  };
  dev_task_list: { args: { status?: DevTaskStatus; category?: DevTaskCategory }; result: DevTask[] };
  dev_task_update: { args: { id: string; status?: DevTaskStatus; priority?: DevTaskPriority; title?: string; category?: DevTaskCategory; body?: string }; result: DevTask };
  /** Resolves `false` when no such task existed. */
  dev_task_delete: { args: { id: string }; result: boolean };
  /** Writes `<repo>/memory/session_handoffs/YYYY-MM-DD-HHMM.md` and returns its Markdown (copy it to the clipboard). */
  dev_brief_export: { args: undefined; result: DevBriefExport };
  // ── P6 Claude Code fix queue (deterministic only: a phrase, a button or this command — never an LLM router tool) ──
  /** Queue a fix straight to `Queued` (kind fix, tags dev-fix + claude-queue) with a scrubbed snapshot that
   * adds `errors` (these + the gateway's /api/errors) and the UI route. Rewrites `<repo>/.agenticos/claude-fix-queue.json`. */
  dev_fix_queue: {
    args: { title: string; description?: string; priority?: DevTaskPriority; errors?: DevErrorItem[]; ui?: DevUiState; source?: DevTaskSource; trace?: DevTraceStep };
    result: DevTask;
  };
  /** Live run in its own worktree on `fix/<short>`. Rust refuses with `PERMISSION_REQUIRED:claude-dispatch` unless
   * `approved: true` — only ever call it from the confirmation card (`dispatchFix` in dev-queue.ts). */
  dev_fix_dispatch: { args: { id: string; approved?: boolean }; result: DevTask };
  /** Stop the live run of `id`; `false` when it isn't running. */
  dev_fix_cancel: { args: { id: string }; result: boolean };
  // ── System Map introspection (read-only, no LLM, secret-scrubbed in Rust) ──
  /** Cached 10 s in Rust; `deep: true` re-probes and re-lists every external MCP server. */
  system_introspect: { args: { deep?: boolean }; result: SystemSnapshot };
  app_uptime: { args: undefined; result: AppUptime };
}

/**
 * Send raw bytes to a Rust command that takes `tauri::ipc::Request`
 * (WAV → stt_transcribe, a voice file → tts_voice_upload).
 */
export async function nativeRaw<T>(cmdName: "stt_transcribe" | "tts_voice_upload" | "lang_stt", body: Uint8Array, headers?: Record<string, string>): Promise<T> {
  // Phase 2 Part B: no audio leaves the webview for Whisper while the mic is locked off.
  if ((cmdName === "stt_transcribe" || cmdName === "lang_stt") && !micEnabled()) throw new MicLockedError();
  if (!isTauri()) throw new Error(`native command "${cmdName}" is desktop-only`);
  const { invoke } = await import("@tauri-apps/api/core");
  return timed(cmdName, invoke<T>(cmdName, body, headers ? { headers } : undefined));
}

/** Dev X-Ray IPC ring: the command name, duration and outcome of each desktop invoke (never its args). */
function timed<T>(name: string, p: Promise<T>): Promise<T> {
  if (!isTauri()) return p;
  const t0 = performance.now();
  p.then(
    () => recordIpc(name, performance.now() - t0, true),
    () => recordIpc(name, performance.now() - t0, false),
  );
  return p;
}

/** Payload of the `tts-fallback` event (Rust `voice.rs` `fallback_payload`): a live line
 * fell back from ElevenLabs to a local engine. Rust emits at most one per reply
 * (`utteranceId`), per cooldown window (402 per voice / 429 global), or — with no id —
 * per `reason` per 10 s. `reason` is our own hint or ElevenLabs' clipped `detail`, never
 * key material. `scope`: "utterance" | "voice" | "global" | "call" (no utterance id). */
export interface TtsFallbackEvent {
  from: string;
  to: string;
  reason: string;
  status?: number | null;
  utteranceId?: string | null;
  cooldownSecs?: number | null;
  scope?: "utterance" | "voice" | "global" | "call" | null;
  /** Which cooldown a cooldown notice is about: "*" (global 429) or an opaque per-voice tag (402). */
  cooldownKey?: string | null;
}

/** `tts-unpin`: a `cache: true` line (sent with this `pinId`) was answered by a local engine. */
export interface TtsUnpinEvent {
  pinId: string;
}

/** Subscribe to a Rust → webview event. Returns an unsubscribe function. No-op on the PWA. */
export type NativeEventName =
  /** Lock state / elevation / hard lock changed (security/commands.rs `Status`). */
  | "security-state"
  | "voice-toggle"
  | "memory-progress"
  | "pipeline-step"
  | "gpu-slot"
  | "droplet-status"
  | "tony-token"
  | "os-step"
  | "tts-fallback"
  | "tts-unpin"
  | "spotify-auth"
  | "spotify-session"
  | "spotify-reauth"
  | "tools-changed"
  | "audio-engine"
  | "os-trace"
  | "dev-fix-progress"
  | "devqueue-changed"
  | "map-route"
  /** Part 6: the agent event bus (events.rs `AgentEvent`). */
  | "agent-event"
  /** A delegated agent's answer the moment it lands (agents.rs; announcer handoff). */
  | "os-agent-reply"
  /** Phase 2 Part B: `{ enabled }`, the authoritative mic state changed (voice.rs). */
  | "mic-state"
  /** The global hotkey was pressed while the mic is locked off. */
  | "mic-locked"
  /** Phase 2 Part C: Tony's mode / overrides changed (payload: `ModesView`). */
  | "tony-mode-changed"
  /** Phase 3: a memory compaction finished, was deferred or failed (payload: `CompactOutcome`). */
  | "memory-compaction"
  /** The memory hygiene bar changed (payload: `HygieneStatus`; hygiene.rs). */
  | "hygiene-status"
  /** The review queue's batched digest (review_queue.rs; payload: `ReviewDigestEvent`). */
  | "review-digest";

export async function onNativeEvent<P = unknown>(event: NativeEventName, handler: (payload: P) => void): Promise<() => void> {
  if (!isTauri()) return () => undefined;
  const { listen } = await import("@tauri-apps/api/event");
  return listen<P>(event, (e) => handler(e.payload));
}

export function cmd<K extends keyof NativeCommands>(
  name: K,
  ...args: NativeCommands[K]["args"] extends undefined ? [] : [NativeCommands[K]["args"]]
): Promise<NativeCommands[K]["result"]> {
  return timed(name, native<NativeCommands[K]["result"]>(name, args[0] as Record<string, unknown> | undefined));
}

// ── Shared types (mirrors of the Rust structs, camelCase via serde) ──────────

/** `media_duck` (audio/ducker.rs `DuckReport`). */
export interface MediaDuckReport {
  /** Local Spotify sessions now held down (0 = nothing ducked here). */
  ducked: number;
  /** An active Spotify desktop session exists on this PC (ducked or not). */
  spotifyLocal: boolean;
  /** Rust's worker didn't answer in time: whether Spotify plays here is UNKNOWN (no Web API fallback). */
  timedOut?: boolean;
}

/** `media_duck_status` (audio/ducker.rs `DuckStatus`). */
export interface MediaDuckStatus {
  ducked: number;
  /** Ducks a crash left behind, waiting for Spotify to come back. */
  pendingRecovery: number;
}

export interface GpuStats {
  name: string;
  utilPct: number;
  vramUsedMb: number;
  vramTotalMb: number;
}

export interface SystemStats {
  cpuPct: number;
  memUsedMb: number;
  memTotalMb: number;
  hostname: string | null;
  gpu: GpuStats | null;
}

export type ProviderKind = "local" | "cloud" | "agentic-os" | "stt" | "tts" | "n8n" | "integration";
export const CHAT_KINDS: ProviderKind[] = ["local", "cloud", "agentic-os"];

export interface ProviderInfo {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  needsKey: boolean;
  hasKey: boolean;
  voice?: string;
  engine?: string;
  language?: string;
  modelsDir?: string;
  voicesDir?: string;
  /** STT: Whisper vocabulary-biasing prompt in effect ("" = none). */
  sttPrompt?: string;
  custom: boolean;
}

export interface Policy {
  gpuUtilMax: number;
  vramMaxPct: number;
  primaryLocal: string;
  fallbackCloud: string;
  chain: string[];
  verifier: string;
  stt: string;
  tts: string;
}

/** Part 3: one agent's voice ("general" = Tony). `voice`/`model` unset =
 * use the matching provider's own `voice`/`model`. */
export interface AgentVoice {
  engine: "elevenlabs" | "kokoro";
  voice?: string;
  model?: string;
  autoSpeak: boolean;
  /** "Speak in own voice" for agent reports; missing = on. Off: Tony's voice reads the report. */
  ownVoice?: boolean;
}
export type AgentVoicePatch = Partial<Pick<AgentVoice, "engine" | "voice" | "model" | "autoSpeak" | "ownVoice">>;

export interface ProvidersView {
  providers: ProviderInfo[];
  policy: Policy;
  /** Part 3: the voice roster, by role id ("general" = Tony); missing role = no override. */
  agentVoices: Record<string, AgentVoice>;
  /** The roster's master "All Tony" switch: every agent report speaks in Tony's voice. */
  agentVoicesAllTony?: boolean;
}

export type ProviderPatch = { id: string } & Partial<Pick<ProviderInfo, "label" | "baseUrl" | "model" | "voice" | "language" | "engine" | "modelsDir" | "voicesDir" | "sttPrompt">>;
export type NewProvider = Pick<ProviderInfo, "id" | "label" | "kind" | "baseUrl" | "model" | "needsKey">;
export type PolicyPatch = Partial<Pick<Policy, "chain" | "verifier" | "stt" | "tts" | "gpuUtilMax" | "vramMaxPct">>;

export interface ServiceHealth {
  id: string;
  label: string;
  kind: string;
  up: boolean;
  latencyMs: number;
  detail: string;
  /** Switched off on purpose (droplet switch, kill switch, LOCAL ONLY) — not a fault. */
  manual?: boolean;
}

export interface GatewayStatus {
  up: boolean;
  started: boolean;
  url: string;
  detail: string;
}

export interface VoicesView {
  provider: string;
  engine: string;
  current: string | null;
  voicesDir: string | null;
  voices: { id: string; source: "server" | "custom"; file: string | null; label: string | null; category: string | null }[];
  serverError: string | null;
  /** Cloud engines: where the API key was found (never the key itself). */
  keySource: "env" | "env-file" | "keychain" | "missing" | null;
}

export interface WorkflowInfo {
  name: string;
  path: string;
  mutating: boolean;
  description?: string | null;
}

// ── Permission Bridge + n8n pipelines + Drive sync ──────────────────────────

export type BridgeScope = "read" | "write" | "execute" | "network";
export type BridgeTier = "allow" | "ask" | "deny";
export interface BridgeView {
  policy: Record<BridgeScope, BridgeTier>;
  logDir: string | null;
}

export type PipelineStatus = "success" | "error" | "running" | "idle";
export interface WorkflowStatus {
  workflowId: string;
  name: string;
  instanceId: string;
  instanceLabel: string;
  isActive: boolean;
  lastStatus: PipelineStatus;
  lastRunTimestamp: string | null;
  durationMs: number | null;
  runnable: boolean;
  tags: string[];
}
export interface InstanceStatus {
  id: string;
  label: string;
  baseUrl: string;
  status: "online" | "offline" | "unauthorized" | "no-key" | "error";
  detail: string;
  latencyMs: number;
  hasApiKey: boolean;
  workflows: WorkflowStatus[];
}
export interface SyncResult {
  status: "synced" | "up-to-date" | "failed" | "offline" | "not-configured" | "busy";
  at: number;
  files: number;
  bytes: number;
  skippedLarge: number;
  detail: string;
  trigger: string;
}
export interface PipelinesView {
  online: boolean;
  activeSessions: number;
  running: number;
  instances: InstanceStatus[];
  pollIntervalSeconds: number;
  lastSync: SyncResult | null;
  polledAt: number;
}
export interface RunResult {
  status: "completed" | "dispatched" | "error";
  httpStatus: number | null;
  latencyMs: number;
  detail: string;
}
export interface PipelinesConfig {
  pollIntervalSeconds: number;
  gdriveSyncWebhookUrl: string;
  gdriveTrackedPaths: string[];
  autoSyncEnabled: boolean;
  autoSyncHours: number;
  syncOnExit: boolean;
}
export interface PipelinesSettings extends PipelinesConfig {
  instances: { id: string; label: string; baseUrl: string; hasApiKey: boolean; custom: boolean }[];
  resolvedPaths: { path: string; exists: boolean }[];
}

export interface N8nDiscovery {
  found: boolean;
  container: string | null;
  image: string | null;
  status: string | null;
  url: string | null;
  healthy: boolean;
  adopted: boolean;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type Priority = "interactive" | "background";

export interface DispatchRequest {
  messages: ChatMessage[];
  priority: Priority;
  /** Force a provider id ("verifier" = the policy's verifier); otherwise the Rust routing policy decides. */
  provider?: string;
  /** Cap this request's timeout (seconds). */
  maxSecs?: number;
}

export interface DispatchResult {
  providerId: string;
  content: string;
  fellBack: boolean;
  reason: string;
  latencyMs: number;
  /** The prompt left the machine through the privacy diffuser. */
  redacted?: boolean;
  /** Phone only: the text the gateway streamed ahead of the answer and never repeats in
   * `content` (gateway_tony.py's cold-start "One sec, Nic — waking up. "), so the phone's speech
   * lines the final answer up with what it already said. Absent / "" when nothing led it. */
  streamPrefix?: string;
}

export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
}

export interface NetbirdStatus {
  connected: boolean;
  peersConnected: number;
  peersTotal: number;
  ip: string | null;
  raw: string | null;
}

// ── Agentic OS core ──────────────────────────────────────────────────────────

export type Tier = "allow" | "ask" | "deny";
export type ComputeMode = "local" | "hybrid" | "cloud";
export type OsSecret =
  | "anthropic"
  | "gemini"
  | "brave"
  | "twelvedata"
  | "vault"
  | "gateway-token"
  | "anythingllm-remote"
  | "gmail-script-id"
  | "gmail-script-key"
  | "gcal-script-id"
  | "gcal-script-key"
  | "github-pat"
  | "sentry-token"
  | "agentmail-key"
  | "instagram-token";
/** Where a credential was found (Rust `envfile::KeySource`). */
export type KeySourceKind = "env" | "env-file" | "keychain" | "missing";

/** Rust `maps::Place` / `maps::Route` (provider-neutral: OSM today, Google Maps later). */
export interface MapPlace {
  lat: number;
  lng: number;
  label: string;
}
export interface MapRoute {
  provider: string;
  distanceM: number;
  durationS: number;
  waypoints: MapPlace[];
  steps: { instruction: string; distanceM: number; durationS: number }[];
  /** GeoJSON LineString ([lng, lat] pairs). */
  geometry: { type: "LineString"; coordinates: [number, number][] };
  trafficAware: boolean;
  note: string;
  openInMaps: string;
}
export interface MapsStatus {
  provider: string;
  status: "ok" | "error" | "off" | "blocked";
  detail: string;
  homeSet: boolean;
  latencyMs: number | null;
}
export interface InstagramStatus {
  status: "ok" | "error" | "missing" | "off" | "blocked";
  source: KeySourceKind | null;
  username: string | null;
  accountType: string | null;
  followers: number | null;
  mediaCount: number | null;
  tokenExpiresAt: number | null;
  refreshedAt: number | null;
  detail: string;
}
export interface OsKeyStatus {
  source: KeySourceKind;
  /** The env var that overrides this secret; null = keychain-only. */
  envVar: string | null;
  /** A keychain entry exists (deletable from Settings). */
  keychain: boolean;
  /** Gmail only: part of the ID/key pair is set, but not both from one place. */
  pairIncomplete?: boolean;
}
export interface OsKeySources {
  keys: Record<OsSecret, OsKeyStatus>;
  /** Path of the repo-root .env that is consulted. */
  envFile: string;
  envFileFound: boolean;
}
export type OverseerEngine = "claude-cli" | "claude-api" | "gemini-cli" | "gemini-api" | "droplet" | "local";

export interface AgentTriggers {
  names: string[];
  domains: string[];
}
export interface RoutingConfig {
  autoSwitch: boolean;
  agents: Record<string, AgentTriggers>;
}

/** 0 silent (toasts only) · 1 milestones + failures · 2 + handoffs · 3 verbose. */
export type FeedbackLevel = 0 | 1 | 2 | 3;
/** os.json `feedback` (os_core.rs `FeedbackConfig`). */
export interface FeedbackConfig {
  sensitivity: FeedbackLevel;
  /** "roster" = each agent's own roster voice (Kokoro defaults for gaps); "kokoro" = local Kokoro only. */
  narrationEngine: "roster" | "kokoro";
}
/** os.json `voice` (os_core.rs `VoiceConfig`, Phase 2 Part B). */
export interface VoiceConfig {
  /** False = locked off: zero capture, zero STT (Rust refuses `stt_transcribe`). */
  micEnabled: boolean;
  /** Absolute speech gate, dBFS (-70..-10). */
  activationDb: number;
  /** Extra dB for a barge-in over Tony (0..20). */
  bargeMarginDb: number;
  /** True once the webview wrote `activationDb`; false = Rust's serde default (-44). */
  activationDbSet?: boolean;
}
/** os.json `worker` (os_core.rs `WorkerConfig`). */
export interface WorkerConfig {
  enabled: boolean;
  maxIterations: number;
  verify: boolean;
  offloadCode: boolean;
  librarianAudit: boolean;
}

// ── Agent event bus + TaskEnvelope (events.rs / envelope.rs) ──

export type EventSeverity = "critical" | "milestone" | "handoff" | "verbose";
/** `agent-event` payload (events.rs `AgentEvent`, camelCase). `shortSummary` is templated or the
 * agent's validated voice summary, scrubbed and stripped of wake words in Rust. */
export interface AgentEvent {
  v: number;
  seq: number;
  /** Unix ms. */
  at: number;
  taskId?: string;
  traceId?: string;
  agentId: string;
  eventType: string;
  severity: EventSeverity;
  shortSummary: string;
  stage?: string;
  iteration?: number;
  status?: TaskStatus;
  owner?: string;
  /** `shortSummary` is the agent's own voice summary (speak it in its voice). */
  fromVoiceSummary?: boolean;
  /** Task events: who the committed row was addressed to (the post-commit `owner` often isn't). */
  toAgent?: string;
  /** Task events: the durable handoff_log seq of the row. */
  rowSeq?: number;
  /** Task events carrying a voice summary: the app's templated summary (the facts) too. */
  templateSummary?: string;
}
export type TaskStatus = "queued" | "prompting" | "designing" | "coding" | "review_ready" | "failed";
export type TaskSource = "voice" | "typed" | "phone" | "playplace" | "ledger";
/** One append-only `handoff_log` row (snake_case on the wire, like the envelope). */
export interface HandoffEntry {
  seq: number;
  task_id: string;
  timestamp: number;
  from_agent: string;
  to_agent: string;
  event_type: string;
  severity: EventSeverity;
  short_summary: string;
  voice_summary?: string;
  summary_payload: unknown;
  detail_ref?: string;
  stage: string | null;
  iteration: number | null;
}
/** The TaskEnvelope (envelope.rs `Envelope`; field names are the spec's, verbatim). */
export interface TaskEnvelope {
  task_id: string;
  created_at: number;
  updated_at: number;
  status: TaskStatus;
  stage: string | null;
  current_owner: string;
  raw_intent: { text: string; timestamp: number; memory_reference: unknown };
  title: string;
  project_slug: string | null;
  iteration_count: number;
  max_iterations: number;
  prompt_spec: unknown;
  design_artifacts: unknown;
  coder_brief: unknown;
  code_artifacts: unknown;
  librarian_notes: unknown;
  last_eval: unknown;
  /** Latest validated voice summary per agent: `{agent: {text, at, stage}}`. */
  voice_summaries: Record<string, { text: string; at: number; stage?: string | null } | undefined> | null;
  idea_id: string | null;
  card_id: string | null;
  dedupe_key: string | null;
  options: unknown;
  lease_until: number | null;
  error: string | null;
  handoff_log: HandoffEntry[];
}
/** `task_status`: the templated answer plus the open tasks (taskworker.rs `status_text`). */
export interface TaskStatusAnswer {
  text: string;
  task_id: string | null;
  open: number;
  active: Array<{ task_id: string; title: string; status: TaskStatus; stage: string | null; current_owner: string; iteration_count: number; max_iterations: number; project_slug: string | null; updated_at: number }>;
  /** With `agent`: the line that agent speaks in its own voice ("Hey Coder, where are we at?"):
   * its stored voice summary, or a templated first-person line (taskworker.rs `addressed_line`). */
  voice?: { agent: string; text: string; task_id: string | null; source: "voice_summary" | "templated" } | null;
}

export interface McpServer {
  id: string;
  name: string;
  transport: "builtin" | "stdio" | "http";
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
  enabled: boolean;
  builtin: boolean;
  description: string;
  /** Part 2 per-agent grants: `null`/missing/containing `"all"` = every agent.
   * Tony (general/tony) always has every enabled server regardless of this. */
  agents?: string[] | null;
  /** stdio: seconds to wait for `initialize` (5–600). Unset = 120 s for npx/uvx/uv/pnpm/pnpx/bunx/pipx/serena, else 45 s. A value above 60 also raises the tool-call timeout (default 60 s; never lowered). */
  timeoutSecs?: number | null;
  /** stdio: absolute working folder. Unset = the repo (gateway workdir). */
  cwd?: string | null;
  /** Its mutating tools (writes, deletes, edits…) are hidden and refused for every caller. Omitted = false. */
  readOnly?: boolean;
}

export interface AllmSyncReport {
  added: string[];
  kept: string[];
  skipped: string[];
  /** Existing entries whose invalid "streamable-http" type was repaired. */
  fixed?: string[];
  /** Existing AnythingLLM entries its agents can run with no read-only / role limit (never removed). */
  keptWritable?: string[];
}

/** `librarian_preflight` (mcp.rs `LibrarianGuard`). */
export interface LibrarianGuard {
  slug: string;
  chatMode: string | null;
  /** Read OK and not in an agent-capable chat mode. */
  ok: boolean;
  /** chatMode "automatic" / "agent": AnythingLLM agent tools can run in the Librarian's workspace. */
  agentCapable: boolean;
  issues: string[];
  writableMcps: string[];
  /** The only tools the Librarian may call. */
  allowlist: string[];
}

export interface OsConfig {
  osName: string;
  wakeWords: string[];
  identityPath: string;
  rootDirective: boolean;
  compute: { mode: ComputeMode; vramThresholdPct: number; heavyContextChars: number; deepThinking: boolean };
  droplet: { enabled: boolean; host: string; qdrantUrl: string; n8nUrl: string; modelUrl: string; anythingllmUrl: string };
  anythingllm: { baseUrl: string; workspaces: Record<string, string>; timeoutSecs: number };
  skills: { dir: string; grants: Record<string, string[]> };
  mcps: McpServer[];
  routing: RoutingConfig;
  fsRoots: string[];
  permissions: { delegation: Tier; mcp: Tier; filesystem: Tier; cloud: Tier };
  privacy: { diffuser: boolean; networkLock: boolean; killSwitch: boolean; destructiveGate: boolean; sensitiveTerms: string[] };
  overseer: { engine: OverseerEngine; claudeModel: string; geminiModel: string; autoEscalate: boolean; manualMode: boolean };
  scheduler: SchedulerConfig;
  /** Part 6 narration / status feedback (Rust always sends it; read it through `feedbackLevel()`). */
  feedback: FeedbackConfig;
  worker: WorkerConfig;
  voice: VoiceConfig;
  memory: {
    storage: "local" | "droplet" | "hybrid";
    /** "Auto-regulate Vault & Lifecycle": standing consent for scheduled harvests. */
    autoRunEnabled: boolean;
    cadence: LifecycleCadence;
    /** Local hour of the slot (0–23, default 3). */
    targetHour: number;
    /** Weekly quiet-window weekday, 0 = Sunday. */
    weeklyDay: number;
    /** Unix secs of the last harvest whose vault files passed their SHA-256 re-read (0 = never). */
    lastVerifiedHarvestAt: number;
    /** After a verified harvest, delete Tony's OS-created local threads (a summary seeds the next one). */
    pruneThreads: boolean;
    autoFlush: boolean;
    vaultDir: string;
    datasetFormat: "chatml" | "alpaca" | "sharegpt";
    mountWorkspace: string;
    cacheCollections: string[];
    lastAutoMonth: string;
    /** Phase 3 Memory Scrolls (older os.json files get the Rust defaults). */
    scrolls: MemoryScrollsConfig;
    /** Tony's hot path caps (rolling history, RAG lookups). */
    hotPath: HotPathConfig;
  };
}

export type LifecycleCadence = "daily" | "weekly" | "monthly";
export type HarvestPeriodName = "previous_day" | "previous_week" | "previous_month" | "since_last_harvest";

/** `memory.hotPath` (os_core.rs `HotPathConfig`; Rust clamps every value). */
export interface HotPathConfig {
  historyChars: number;
  historyMsgChars: number;
  /** 1500–2500 ms; past it Tony answers directly without memory. */
  ragTimeoutMs: number;
  ragTopK: number;
  ragChunkChars: number;
  scrollSummaryChars: number;
}

/** compaction.rs `IdleBadge`. */
export interface IdleBadge {
  state: "ready" | "waiting" | "compacting" | "off";
  label: string;
  secsLeft?: number;
}

export type BufferPressure = "green" | "amber" | "red";

/** hygiene.rs `HygieneStatus`. */
export interface HygieneStatus {
  daemonRunning: boolean;
  heartbeatAt: number | null;
  lastSweepAt: number | null;
  pressure: BufferPressure | null;
  pressureRatio: number | null;
  pendingBytes: number | null;
  pendingTurns: number | null;
  thresholdKb: number;
  thresholdTurns: number;
  preset: ScrollsPreset | null;
  autoRun: boolean;
  cadence: LifecycleCadence;
  nextHarvestAt: number | null;
  catchUpQueued: boolean;
  waiting: string | null;
  harvesting: boolean;
  lastVerifiedHarvestAt: number | null;
  lastRun: { at: number; period: string; ok: boolean; catchUp: boolean; detail: string } | null;
  recent: { at: number; stage: string; step: string; ok: boolean; detail: string }[];
}

export type ScrollsPreset = "tight" | "balanced" | "relaxed";

/** `memory.scrolls` (os_core.rs `ScrollsConfig`). Paths only; no secret ever lives here. */
export interface MemoryScrollsConfig {
  /** Empty = `G:\ai-hub-memory\scrolls`. A dir under the read-only hub (`G:\ai-hub`) is refused (default applies). */
  scrollsDir: string;
  /** Empty = the CLI's resolution (env / `.env` / `D:\ai-hub-archive` / `./archive/memory`). */
  archiveDir: string;
  /** AnythingLLM workspace changed scrolls sync into (a Booking slug is refused → `librarian`). */
  workspace: string;
  /** Skip Tony's per-note documenter ingest (scrolls become the only embedded layer). */
  embedOnly: boolean;
  autoCompact: boolean;
  /** Clamped 8–1024. */
  thresholdKb: number;
  /** Clamped 5–500. */
  thresholdTurns: number;
  /** Clamped 2–240. */
  quietMins: number;
  /** Clamped 60–3600. */
  checkSecs: number;
  /** Clamped 1–4. */
  maxBatchesAuto: number;
}

/** compaction.rs `CompactOutcome` (scrubbed in Rust). */
export interface CompactOutcome {
  /** Why it did not run / stopped early ("voice active", "yielded to foreground", the CLI's own reason). */
  deferred?: string;
  error?: string;
  result?: CompactResult;
  exit?: number;
  manual: boolean;
  at: number;
}

/** The `memory_scrolls compact --json` result line (snake_case, as the CLI prints it). */
export interface CompactResult {
  archive_ids?: string[];
  scrolls_updated?: { id: string; version: number; bytes: number; rel?: string }[];
  kg_entities_upserted?: number;
  /** Scroll ids synced this run (`sync.sync_changed` lists, not counts). */
  synced?: string[];
  /** Scroll ids left pending (no AnythingLLM key). */
  sync_pending?: string[];
  /** "<scroll_id>: <short error>" per failed sync. */
  sync_failed?: string[];
  pending_targets?: number;
  llm_calls?: number;
  llm?: "live" | "replay" | "skipped";
  warnings?: string[];
}

/** `memory_scrolls status --json` (read-only). */
export interface ScrollsStatus {
  pending: { bytes: number; turns: number; records: number; by_source?: Record<string, number> };
  threshold: { kb: number; turns: number };
  threshold_hit: boolean;
  archive_root: string;
  /** flag | pinned | env | .env | os.json | D: | fallback (the CLI's wording). */
  archive_root_source: string;
  pinned: string | null;
  scrolls_root: string;
  scrolls: { id: string | null; rel: string; version: number | null; bytes: number; valid: boolean }[];
  undistilled: string[];
  unsynced: string[];
  last_run: { at: string; archive_ids: string[]; scrolls_updated: number; llm: string; pending_targets: number } | null;
  last_errors?: unknown[];
  lm: { loaded_model: string | null };
  warnings: string[];
}

/** `memory_compaction_status`. */
export interface CompactionStatus {
  status: ScrollsStatus | null;
  statusError: string | null;
  auto: boolean;
  embedOnly: boolean;
  workspace: string;
  thresholds: { kb: number; turns: number };
  quietMins: number;
  lastResult: CompactOutcome | null;
  running: boolean;
  /** Why a manual run would be deferred right now (null = idle). */
  idleReason: string | null;
  badge?: IdleBadge;
  /** Pending buffer at / over 2× the threshold (compacts between turns). */
  highWater?: boolean;
  preset?: ScrollsPreset | null;
}

/** Top-level keys replace; object sections merge one level deep (Rust side). */
export type OsConfigPatch = {
  [K in keyof OsConfig]?: OsConfig[K] extends unknown[] ? OsConfig[K] : OsConfig[K] extends object ? Partial<OsConfig[K]> : OsConfig[K];
};

export interface Replacement {
  token: string;
  kind: string;
  original: string;
}
export interface RedactionRecord {
  at: number;
  destination: string;
  payload: ChatMessage[];
  replacements: Replacement[];
}
export interface EndpointProbe {
  id: string;
  label: string;
  url: string;
  up: boolean;
  detail: string;
  latencyMs: number;
}
export interface ListenFinding {
  port: number;
  service: string;
  bind: string;
  exposed: boolean;
  fix: string;
}

export interface SchedulerConfig {
  profile: "sequential" | "hybrid" | "parallel";
  tonyPriorityPct: number;
  maxConcurrency: number;
  offloadPct: number;
  offloadEngine: "claude-cli" | "gemini-cli" | "llm-cli" | "claude-api" | "gemini-api" | "droplet";
  historyTurns: number;
}
export type DevTaskCategory = "mcp" | "auth" | "ui" | "backend" | "routing";
export type DevTaskStatus = "Pending" | "Queued" | "In Progress" | "Done";
export type DevTaskKind = "task" | "note" | "fix";
export type DevTaskSource = "typed" | "voice" | "trace" | "phone";
/** 0 = urgent … 3 = low. */
export type DevTaskPriority = 0 | 1 | 2 | 3;
export const DEV_TASK_CATEGORIES: DevTaskCategory[] = ["mcp", "auth", "ui", "backend", "routing"];
export const DEV_TASK_STATUSES: DevTaskStatus[] = ["Pending", "Queued", "In Progress", "Done"];
/** One hop of a routing trace, as attached to a `fix` (no arguments, results or secrets). */
export interface DevTraceStep {
  traceId: string;
  seq: number;
  hop: string;
  zone: string;
  label: string;
  ok: boolean;
  ms: number;
  error?: string;
  at: number;
}
/** System Map routing trace (plan §2). Rust emits router/rules/memory/model/tool; the webview adds the rest. */
export type TraceHop = "input" | "vad" | "stt" | "router" | "rules" | "memory" | "model" | "tool" | "tts" | "ui";
export type TraceZone = "cockpit" | "engine" | "ecu" | "cargo" | "exhaust";
/** `os-trace` event payload (agents::os_turn, mcp::call_tool) and the webview's own hops.
 * Labels, timings and error text only — never arguments, results or secrets. `at` = unix ms. */
export interface TraceStep extends DevTraceStep {
  hop: TraceHop;
  zone: TraceZone;
  /** Agent-event steps only: who (the per-agent lane) and how loud (the severity chip). */
  agent?: string;
  severity?: EventSeverity;
  /** Model hops: tokens/s of the streamed reply, when it could be measured. */
  tps?: number;
}
/** The only UI keys Rust keeps in a snapshot (scalars only; anything else is dropped). */
export interface DevUiState {
  voiceState?: string;
  voiceChannel?: string;
  listening?: boolean;
  section?: string;
  thread?: string;
  sttEngine?: string;
  ttsEngine?: string;
  viewMode?: string;
  /** The URL hash when a fix was queued. */
  route?: string;
  /** The focused card / zone. */
  focus?: string;
}
/** One recent failure attached to a fix (Rust keeps only these keys, at most 20, scrubbed). */
export interface DevErrorItem {
  source: "trace" | "gateway" | "bus" | "bridge" | "ui";
  at?: number | string;
  hop?: string;
  label?: string;
  error?: string;
}
/** What the OS looked like when a task was logged. Built in Rust from cached data, secret-scrubbed. */
export interface DevContextSnapshot {
  at?: number;
  /** Compact numbers from the last `system_introspect` (when one ran in the last 2 minutes). */
  system?: Partial<Record<"uptimeSecs" | "cpuPct" | "memUsedMb" | "memTotalMb" | "gpuUtilPct" | "vramUsedMb" | "vramTotalMb" | "servicesUp" | "servicesTotal" | "skills" | "storesOk" | "storesTotal", number>>;
  services?: { id?: string; label?: string; port?: number; up?: boolean; latencyMs?: number; detail?: string; manual?: boolean }[];
  /** Unix secs of the `services_health` probe the services came from (absent when from introspection). */
  servicesAt?: number;
  bus?: { id?: string; name?: string; transport?: string; status?: string; error?: string | null; lastError?: string; tools?: number; lastMs?: number; lastOk?: boolean }[];
  agents?: { active?: string[]; queuedForeground?: number; queuedBackground?: number; capacity?: number; roster?: Record<string, string | number | boolean>[] };
  ui?: DevUiState;
  git?: { branch: string | null; head: string | null };
  trace?: Partial<DevTraceStep>;
  /** Recent failures (fixes queued for Claude Code). */
  errors?: DevErrorItem[];
}
/** AnythingLLM workspace; null models = AnythingLLM's system default. */
export interface WorkspaceInfo {
  slug: string;
  name: string;
  threads: number;
  chatProvider: string | null;
  chatModel: string | null;
  agentProvider: string | null;
  agentModel: string | null;
}

/** `anythingllm_workspace_audit`: reports only, never writes. */
export interface AllmAuditFinding {
  kind:
    | "duplicate_name"
    | "name_mismatch"
    | "shared_slug"
    | "dead_slug"
    | "unused"
    | "unmapped"
    | "no_pinned_provider"
    | "automatic_mode"
    | "name_whitespace"
    | "model_mismatch"
    | "token_limit_mismatch"
    | "key_host_mismatch";
  severity: "warn" | "info";
  slugs: string[];
  role: string | null;
  detail: string;
}
export interface AllmAudit {
  workspaces: Array<{
    slug: string;
    name: string;
    threads: number;
    chatMode: string | null;
    chatProvider: string | null;
    chatModel: string | null;
    agentProvider: string | null;
    agentModel: string | null;
    roles: string[];
  }>;
  loadedModel: { key: string; context: number | null } | null;
  llmSettings: { llmProvider: string | null; lmstudioModelPref: string | null; lmstudioTokenLimit: number | null } | null;
  findings: AllmAuditFinding[];
  readOnly: true;
}

// ── System Map snapshot (`system_introspect`) ──
// Every nullable field means "no live source": show "—" with the matching *Note / error as the tooltip.

export interface AppUptime {
  /** Unix ms. */
  startedAt: number;
  uptimeSecs: number;
}
export interface SnapHost {
  cpuPct?: number;
  memUsedMb?: number;
  memTotalMb?: number;
  hostname?: string | null;
  gpu?: GpuStats | null;
  cpuBrand: string | null;
  cpuThreads: number;
  /** Why `gpu` is null. */
  gpuNote?: string;
  /** Set when sysinfo itself failed (then the numbers above are absent). */
  error?: string;
}
/** A loopback service probe (3 s timeout). `id` "lmstudio-1234" = LM Studio's default port, probed separately. */
export interface SnapService extends ServiceHealth {
  port: number | null;
}
export interface SnapChainLink {
  id: string;
  label: string;
  kind: string;
  model: string;
  local: boolean;
}
export interface SnapAgent {
  /** "general" = Tony. */
  role: string;
  label: string;
  slug: string;
  /** null = AnythingLLM unreachable / no key (see `agentsNote`); false = slug not found there. */
  found: boolean | null;
  threads: number | null;
  chatProvider: string | null;
  chatModel: string | null;
  agentProvider: string | null;
  agentModel: string | null;
  /** Holds the GPU slot right now (from the `gpu-slot` labels). */
  active: boolean;
  /** Audit flags (null / absent = unknown): other slugs with the same display name. */
  duplicateOf?: string[] | null;
  /** The workspace has no threads. */
  unused?: boolean | null;
  /** The workspace's name belongs to this other role (general → "Booking" gives "booking"). */
  nameMismatch?: string | null;
  /** A chat / agent model that isn't Tony's pinned LM Studio model. */
  modelMismatch?: string | null;
}
export interface SnapRules {
  identity: {
    path: string;
    bytes: number | null;
    modifiedMs: number | null;
    lines: number;
    headings: number;
    bullets: number;
    /** `##` titles. */
    sections: string[];
    /** Chars of it that go into the system prompt (capped at 6000). */
    promptChars: number;
  } | null;
  identityError: string | null;
  rootDirective: boolean;
  /** Bullets in HANDOFF.md's Guardrails section. */
  guardrails: number | null;
  guardrailsPath: string;
  guardrailsNote: string | null;
}
export interface SnapSkillRoot {
  path: string;
  exists: boolean;
  count: number;
  truncated: boolean;
  /** The same folder reached another way (junction); its skills are counted under this path. */
  sameAs?: string;
}
export interface SnapSkill {
  name: string;
  folder: string;
  description: string;
  path: string;
  root: string;
  /** Agents it's granted to (os.json `skills.grants`, by name or folder). */
  agents: string[];
}
export interface SnapSkills {
  total: number;
  roots: SnapSkillRoot[];
  items: SnapSkill[];
  /** Granted in os.json but not found on disk. */
  grantedMissing: string[];
}
export interface SnapLoop {
  id: "inbox" | "whisper" | "local-fit" | "droplet";
  label: string;
  intervalSecs: number;
  source: string;
  /** Unix ms; null = hasn't run since the app started. */
  lastRun: number | null;
  lastOk: boolean | null;
  detail: string | null;
  runs: number;
  overdue: boolean;
}
export interface SnapSchedulerJob {
  id: string | null;
  name: string | null;
  skill: string | null;
  cron: string | null;
  enabled: boolean | null;
  lastRun: string | null;
  nextRun: string | null;
}
export interface SnapN8nInstance {
  id: string;
  label: string;
  /** online | offline | unauthorized | no-key | error | skipped */
  status: string;
  detail: string;
  workflows: { id?: string; name: string; active: boolean; lastStatus: string; lastRun: string | null }[];
}
export interface SnapRoutines {
  loops: SnapLoop[];
  /** Gateway `/api/scheduler/jobs`; null when the gateway didn't answer (see `schedulerNote`). */
  schedulerJobs: SnapSchedulerJob[] | null;
  schedulerNote: string | null;
  /** providers.json `n8nWorkflows` (names only; webhook paths stay in Rust). */
  n8nConfigured: { name: string; mutating: boolean }[];
  n8n: SnapN8nInstance[];
  n8nNote: string | null;
}
export interface SnapStore {
  id: "devqueue" | "tasks" | "cc" | "memory" | "anythingllm" | "training-logs" | "knowledge-graph" | "scrolls" | "memory-archive";
  label: string;
  kind: "sqlite" | "jsonl" | "json" | "dir";
  path?: string;
  exists: boolean;
  bytes?: number | null;
  modifiedMs?: number | null;
  writable?: boolean | null;
  health: "ok" | "missing" | "error";
  error?: string;
  /** rows null = count failed. */
  tables: { name: string; rows: number | null }[];
  tablesTruncated?: boolean;
  /** cc: ragVectors, vaultItems · training-logs: todayLines, files · knowledge-graph: entities ·
   * scrolls: scrolls · memory-archive: files. */
  metrics: Partial<Record<"ragVectors" | "vaultItems" | "todayLines" | "files" | "entities" | "scrolls", number | null>>;
  /** scrolls: the newest `last_updated` among the scrolls. */
  newest?: string | null;
}
/** "starting" = a listing / cold start is running in the background; "needs_token" = muted, no network call is made. */
export type BusStatus = "ok" | "off" | "needs_token" | "auth_failed" | "starting" | "error" | "unknown";
export interface SnapBus {
  id: string;
  name: string;
  transport: "builtin" | "stdio" | "http" | string;
  /** From cached data only; "unknown" = not listed in the last 10 min (run a deep scan). */
  status: BusStatus;
  error: string | null;
  /** null = unknown (not listed recently, or off). */
  tools: number | null;
  /** Present once the server has been called since the app started. */
  calls?: number;
  failures?: number;
  lastMs?: number;
  lastOk?: boolean;
  lastError?: string | null;
  /** Unix secs. */
  lastAt?: number;
  /** Credential source, names only: brave "env"|"keychain"|"none"; gmail also "n8n:<wf>"; spotify "env + keychain"|"none". */
  source?: string;
}
export interface SnapSummary {
  uptimeSecs: number;
  cpuPct: number | null;
  memUsedMb: number | null;
  memTotalMb: number | null;
  gpuUtilPct: number | null;
  vramUsedMb: number | null;
  vramTotalMb: number | null;
  servicesUp: number;
  servicesTotal: number;
  skills: number;
  storesOk: number;
  storesTotal: number;
}
export interface SystemSnapshot {
  /** Unix ms when built. */
  at: number;
  deep: boolean;
  tookMs: number;
  uptimeSecs: number;
  host: SnapHost;
  services: SnapService[];
  /** Tony's provider failover chain (providers.json `policy.chain`). */
  chain: SnapChainLink[];
  agents: SnapAgent[];
  agentsNote: string | null;
  slot: SlotView;
  rules: SnapRules;
  skills: SnapSkills;
  routines: SnapRoutines;
  stores: SnapStore[];
  bus: SnapBus[];
  summary: SnapSummary;
}

export interface DevTask {
  id: string;
  title: string;
  category: DevTaskCategory;
  priority: DevTaskPriority;
  status: DevTaskStatus;
  contextSnapshot: DevContextSnapshot;
  kind: DevTaskKind;
  body: string;
  source: DevTaskSource;
  /** Unix milliseconds. */
  createdAt: number;
  updatedAt: number;
  /** Claude fix run metadata (`{}` when never dispatched). Optional for rows from older builds. */
  dispatch?: DevFixDispatch;
  tags?: string[];
}
/** `dispatch` of a fix: "queue" = Claude Code's /fix-queue edited it; "live" = a worktree run. */
export interface DevFixDispatch {
  mode?: "queue" | "live";
  state?: "running" | "finished" | "interrupted";
  branch?: string;
  worktree?: string;
  logPath?: string;
  sessionId?: string | null;
  startedAt?: number;
  finishedAt?: number | null;
  timeoutMin?: number;
  note?: string | null;
  commit?: string | null;
  verify?: { ok: boolean; steps: { label: string; ok: boolean; ms: number; tail?: string }[]; files?: number } | null;
  result?: { isError?: boolean | null; numTurns?: number | null; durationMs?: number | null } | null;
  reconciledAt?: number;
}
/** `dev-fix-progress` event: a scrubbed phase line from a live run (never tool input or output). */
export interface DevFixProgress {
  id: string;
  phase: "start" | "init" | "text" | "tool" | "result" | "verify" | "done" | "failed";
  text: string;
  at: number;
}
export interface DevBriefExport {
  markdown: string;
  /** Absolute path of the written file. */
  path: string;
}
export interface SlotView {
  active: string[];
  queuedForeground: number;
  queuedBackground: number;
  capacity: number;
  /** Permits held after a timed-out / cancelled call while the server may still be generating. */
  settling?: number;
}
export interface DropletLink {
  state: "connected" | "checking" | "reconnecting" | "offline" | "disabled";
  detail: string;
  latencyMs: number;
  at: number;
}
export interface CliStatus {
  name: string;
  label: string;
  installed: boolean;
  version: string | null;
  path: string | null;
  error: string | null;
  canInstall: boolean;
  how: string;
}

export interface OsTurnRequest {
  streamId?: string;
  text: string;
  role: string;
  explicit?: boolean;
  /** How the caller already classified this turn ("Named" | "Domain" | "Tab" | "Llm" | "Default"). */
  routeKind?: string;
  routeReason?: string;
  history?: ChatMessage[];
  context?: string;
  approved?: boolean;
  /** An approved Tier-3 delegation card: satisfies the delegation gate only — Ask-tier tools the
   * turn prefetches stay unapproved (Rust `turn_approvals`). */
  delegationApproved?: boolean;
  /** System Map trace id the turn's `os-trace` steps join (`[A-Za-z0-9_:-]`, ≤ 64 chars). */
  traceId?: string;
  /** The caller can raise an approval card: a Spotify write held by the Ask tier comes back as
   * `OsTurnResult.pendingSpotify` instead of a failure note (voice / typed `osRun` only). */
  askCards?: boolean;
  /** A Gabagool cue is playing: Rust won't offer `spotify.volume` for a bare volume line. */
  cuePlaying?: boolean;
  /** P3 Tier 2: Tony brainstorms this himself — Rust never re-routes or delegates it. */
  noDelegate?: boolean;
  /** The Business Switcher's selection: Operations-Manager / Finance turns lock to it (Rust
   * `business_lock`); missing = resolve from the text, and Tony asks when that isn't one. */
  activeBusinessId?: string;
}
export interface OsStep {
  kind: "delegate" | "reply" | "tool" | "step-in" | "error" | "overseer" | "verify";
  from: string;
  to: string;
  text: string;
  ok: boolean;
  ms: number;
}
export interface PipelineStepEvent extends OsStep {
  pipelineId: string;
  ideaId: string | null;
  cardId: string | null;
  stage: string;
  pct: number;
  thread: string;
  /** "worker": a TaskEnvelope stage (its chat turn comes from `agent-event`); absent for the
   * Play Place's inline iterate / approve and verifier notes. */
  source?: "worker";
}

export interface Idea {
  title: string;
  idea: string;
  summary?: string;
  tasks: { id: string; text: string; done: boolean }[];
  spec?: Record<string, unknown>;
  /** "parked": saved from a Tony brainstorm (P3 Tier 4) — no tasks yet, nothing ran. */
  status: "captured" | "prototyping" | "staged" | "approved" | "archived" | "parked" | "failed";
  cardId?: string;
  /** The TaskEnvelope building it (set by the worker's ledger mirror). */
  taskId?: string;
  /** Why the last build failed (worker mirror). */
  error?: string;
  tags?: string[];
  /** When a Tier-4 save parked it (ms). */
  savedAt?: number;
}

export interface PlayCard {
  id: string;
  title: string;
  idea?: string;
  ideaId?: string;
  brief?: string;
  blueprint?: string;
  buildPrompt?: string;
  buildPlan?: string;
  coderOutput?: string;
  html?: string;
  hasHtml?: boolean;
  /** "parked": a text card saved from a Tony brainstorm (P3 Tier 4) — no HTML, nothing built. */
  status: "staged" | "building" | "approved" | "committed" | "archived" | "parked";
  summary?: string;
  tags?: string[];
  savedAt?: number;
  versions?: { at: number; by: string; notes: string }[];
  vaultPath?: string;
  _updated?: number;
}

export interface OsTurnResult {
  answer: string;
  steps: OsStep[];
  providerId: string;
  delegatedTo: string | null;
  tool: string | null;
  latencyMs: number;
  reason: string;
  redacted: boolean;
  commsThread?: string;
  /** Final role this turn was routed to (after the Rust safety net, if it fired). */
  routedRole: string;
  routeReason: string;
  /** "Named" | "Domain" | "Tab" | "Llm" | "Default". */
  routeKind: string;
  /** Only with `askCards`: the Spotify write the gate held back (`answer` is then ""). Approve it
   * with `spotify_tool(name, args, approved: true)` — never by re-running the turn. */
  pendingSpotify?: PendingSpotifyCall;
  /** Who produced `answer`: the sub-agent itself ("agent"), Tony's synthesis ("os" — also when he
   * stepped in for a failed agent), the overseer, or a tool. Older builds omit it. */
  answeredBy?: "agent" | "os" | "overseer" | "tool";
  /** Learning mode: the pathways this turn saved / updated (Rust `learning::Saved`). */
  learned?: { id: string; title: string; category: string; confidence: string; outcome: string }[];
  /** Learning mode (decision 5): lessons this reply proposed, waiting for Nic's yes (Rust
   * `learning::PendingMemory`; the memory card, `learning_approve` / `learning_discard`). */
  pendingMemory?: import("@/features/modes/learning").PendingMemory[];
  /** Tony's dispatch packet (tony_dispatch.rs `DispatchView`): held / pending / queued / invalid. */
  dispatch?: import("@/features/arbiter/api").DispatchView;
  /** This turn's booking-mail scan (Rust `gmail::Booking`), one per thread read: the calendar-add card's fields. */
  bookings?: import("@/features/orchestrator/bookings").BookingRef[];
}

export interface ToolInfo {
  name: string;
  description: string;
  server: string;
  args: string[];
}
export interface ServerTools {
  id: string;
  name: string;
  enabled: boolean;
  ok: boolean;
  error: string | null;
  tools: ToolInfo[];
  status: "ok" | "off" | "needs_token" | "auth_failed" | "starting" | "error";
  /** A remote server that takes a token: where it's read from (`.env` key first, then this keychain secret). */
  auth: { secret: OsSecret; env: string; label: string } | null;
}

/** Canonical Spotify tool names, in Rust `spotify_intent::ALL_TOOLS` order (spotify-tools-sync.test.ts keeps them equal). */
export const SPOTIFY_TOOL_NAMES = [
  "spotify.now_playing", "spotify.get_queue", "spotify.recently_played", "spotify.top_items",
  "spotify.list_playlists", "spotify.get_playlist_tracks",
  "spotify.play", "spotify.pause", "spotify.resume", "spotify.next", "spotify.previous",
  "spotify.seek", "spotify.restart_track", "spotify.volume", "spotify.shuffle", "spotify.repeat",
  "spotify.transfer_device", "spotify.queue_add",
  "spotify.create_playlist", "spotify.add_to_playlist", "spotify.remove_from_playlist",
  "spotify.like_track", "spotify.unlike_track",
] as const;
export type SpotifyToolName = (typeof SPOTIFY_TOOL_NAMES)[number];
/** `spotify_parse` result: what a line asks Spotify to do. */
export interface SpotifyIntent {
  /** A tool name, or the grammar-only "spotify.reconnect" (runs `connectSpotify`, never an MCP tool). */
  tool: SpotifyToolName | "spotify.reconnect";
  /** Already normalised by Rust (`normalize_args`). */
  args: Record<string, unknown>;
  /** Card / read-back text, no IDs ("Play Bilmuri on Spotify"). */
  summary: string;
  /** A write (needs the MCP tier); false for reads and reconnect. */
  mutating: boolean;
  /** The line named Spotify ("… on spotify") — a cue phrase can't take it. */
  explicit: boolean;
}
/** A Spotify write the Rust tool path wanted but the tier/destructive gate held back (D14). */
export interface PendingSpotifyCall {
  name: SpotifyToolName;
  args: Record<string, unknown>;
  /** Card text, no IDs: "Remove Tell Me from your Late Night playlist". */
  summary: string;
  /** The exact gate error, e.g. "PERMISSION_REQUIRED:mcp" | "PERMISSION_REQUIRED:destructive". */
  required: string;
}
export type SpotifyAction = "play" | "pause" | "resume" | "next" | "previous" | "volume" | "shuffle" | "seek" | "repeat";
export interface SpotifyStatus {
  configured: boolean;
  connected: boolean;
  account: string | null;
  /** A token is stored but Spotify refuses it (e.g. the app owner needs Premium). */
  problem: string | null;
  /** How to act on `problem`: only "reauth" needs a new sign-in. */
  problemKind: SpotifyProblemKind | null;
  /** Core scope names the stored grant lacks ([] when unknown). */
  missingScopes: string[];
  /** The consent predates the current scope set or misses a scope: a consent page is offered / needed. */
  reauthPending: boolean;
  /** Days left in Spotify's 6-month sign-in window, when known. */
  expiresInDays: number | null;
}
/** "reauth": only a new sign-in helps · "owner_premium": the app owner's account needs Premium
 *  (reconnecting won't help) · "premium": this account needs Premium · "allowlist": this account
 *  isn't on the app's Users Management list (development mode) · "transient": retry later. */
export type SpotifyProblemKind = "reauth" | "owner_premium" | "premium" | "allowlist" | "transient";
/** Payload of the `spotify-reauth` event: Rust opened a consent page on its own. `url` is the
 * authorize URL (no secret); `silent` = the tab may close itself with no click. */
export interface SpotifyReauthEvent {
  reason: "scopes" | "refused" | "expired" | "renew";
  url: string;
  silent: boolean;
}
/** Payload of the `spotify-session` event: a background token refresh found the sign-in dead. */
export interface SpotifySessionEvent {
  connected: boolean;
  kind: SpotifyProblemKind;
}
/** Payload of the `tools-changed` event (Spotify connected / disconnected / revoked, MCP registry saved). */
export interface ToolsChangedEvent {
  reason: string;
}
export interface TonyToolsPreview {
  all: string[];
  routerOffered: string[];
  spotifyReady: boolean;
}
/** `track` is null when nothing is playing (Spotify answered 204). */
export interface SpotifyNowPlaying {
  isPlaying: boolean;
  track: string | null;
  artists: string[];
  album: string | null;
  artUrl: string | null;
  progressMs: number;
  durationMs: number;
  device: string | null;
  volume: number | null;
  shuffle: boolean;
  uri: string | null;
}
/** A quick-select row (recent track or playlist); play it with `spotify_play_uri`. */
export interface SpotifyItem {
  uri: string;
  title: string;
  subtitle: string;
  artUrl: string | null;
}
/** Payload of the `spotify-auth` event. */
export interface SpotifyAuthEvent {
  ok: boolean;
  error?: string;
  account?: string | null;
}
export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  kind: "skill" | "md" | "json";
  agents: string[];
}
export interface LedgerEntry {
  id: string;
  month: string;
  createdAt: number;
  sha256: string;
  verified: boolean;
  encrypted: boolean;
  records: number;
  pairs: number;
  summaryTokens: number;
  agents: string[];
  sources: Record<string, number>;
  files: Record<string, string>;
  mounts: { target: "local" | "droplet"; workspace: string; location: string; at: number }[];
  flushedAt: number | null;
  condensedBy: string;
  notes: string[];
  topics: string[];
  /** Period-aware harvests (older ledgers: "" / empty). */
  periodKind?: string;
  months?: string[];
  checksums?: Record<string, string>;
}

export interface LabModel {
  key: string;
  name: string;
  params: string;
  quant: string;
  sizeGb: number;
  vision: boolean;
  loaded: boolean;
  context: number;
  fit: string;
  tony: boolean;
}
export interface BenchResult {
  model: string;
  context: number;
  loadMs: number;
  firstTokenMs: number;
  tokensPerSec: number;
  vramUsedGb: number;
  vramTotalGb: number;
  reply: string;
  error: string | null;
}

// ── Native audio engine (src-tauri/src/audio) ──────────────────────────────
export interface AudioDeviceInfo { id: string; name: string; isDefault: boolean }
export interface AudioDevices { host: string; inputs: AudioDeviceInfo[]; outputs: AudioDeviceInfo[] }
export interface EnergyVadConfig { minSpeechDb: number; marginDb: number; onsetHops: number; hangoverHops: number; maxSpeechHops: number }
export interface AudioEngineStartOptions {
  /** Device ids from audio_engine_devices; omitted / "default" = system default. */
  inputDevice?: string;
  outputDevice?: string;
  vad?: Partial<EnergyVadConfig>;
  /** Cut the assistant off when the user starts talking (default true). No AEC yet: use a headset. */
  bargeIn?: boolean;
}
export interface AudioStreamInfo { device: string; sampleRate: number; channels: number; format: string }
export interface AudioEngineStatus {
  running: boolean;
  input: AudioStreamInfo | null;
  output: AudioStreamInfo | null;
  captureQueued: number;
  captureOverruns: number;
  playbackQueued: number;
  playbackDiscarded: number;
  playbackUnderruns: number;
  bargeIns: number;
  bargeFlag: boolean;
  turnActive: boolean;
  playing: boolean;
  inSpeech: boolean;
  levelDb: number;
  lastError: string | null;
}
export type AudioEngineEvent =
  | { type: "speechStart"; bargedIn: boolean }
  | { type: "speechEnd"; durationMs: number }
  | { type: "bargeIn" }
  | { type: "streamError"; message: string };
