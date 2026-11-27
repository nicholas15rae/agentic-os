/**
 * Typed contract for the Thought-to-Product commands and events (lifecycle.rs, buildhub.rs,
 * handoff_cues). Kept beside `platform.ts` (not inside it) so the shared NativeCommands file
 * isn't churned by this feature; it uses the same `native()` invoke and the same desktop-only rule.
 */
import { isTauri, native } from "@/lib/platform";
import type { HealthSnapshot } from "@/features/lifecycle/health";
import type { BuildEnvelope, BuildHubView, DeleteReport, IntakeQuestion, PeekStatus, RuntimeConfig, SmokeReport, TrashEntry } from "@/features/buildhub/types";
import type { TranscriptConversation, TranscriptMessage, TranscriptPage } from "@/features/transcript/types";
import type { DirectorCommands } from "@/features/director/contract";
import type { CloudCommands } from "@/features/cloud/contract";

/** Director Suite (media.rs): every JSON-args command. The two raw-body ones (`media_ingest_chunk`,
 * `media_voiceover_save`) go through `features/director/api.ts`, never `xcmd`. */
export type DirectorJsonCommands = Omit<DirectorCommands, "media_ingest_chunk" | "media_voiceover_save">;

/** Cloud storage (gdrive.rs): every `cloud_*` command is plain JSON, so the locked contract is used as is. */
export interface ExtCommands extends DirectorJsonCommands, CloudCommands {
  // ── Phase 1: lifecycle ──
  gateway_health: { args: undefined; result: HealthSnapshot };
  gateway_reconnect: { args: undefined; result: HealthSnapshot };
  app_exit_check: { args: undefined; result: { busy: string[] } };
  /** Refuses with `BUSY:<labels>` when something is mid-commit, unless `force`. */
  app_exit: { args: { force?: boolean }; result: void };
  // ── Phases 2–4: Play Place staging hub (buildhub.rs) ──
  build_hub_view: { args: undefined; result: BuildHubView };
  build_runtime_config: { args: undefined; result: RuntimeConfig };
  build_set_external_base: { args: { path: string }; result: RuntimeConfig };
  /** Prompter intake questions for the selected notes (deterministic fallback when no model answers). */
  build_intake_questions: { args: { notes: { title: string; text: string }[] }; result: { questions: IntakeQuestion[]; source: "prompter" | "fallback" } };
  /** Append one compiled envelope to the FIFO staging queue. Refused with `PERMISSION_REQUIRED:build-dispatch`
   * unless `approved: true` — only ever from the confirmation card (`requestHubDispatch`). */
  build_enqueue: {
    args: { envelope: BuildEnvelope; brief: string; noteIds: string[]; approved?: boolean; intake?: { q: string; a: string }[]; intakeSource?: "prompter" | "fallback" };
    result: BuildEnvelope;
  };
  build_reorder: { args: { buildId: string; direction: "up" | "down" | "top" }; result: BuildHubView };
  build_pause: { args: { buildId: string }; result: BuildEnvelope };
  build_resume: { args: { buildId: string }; result: BuildEnvelope };
  build_steer: { args: { buildId: string; directive: string }; result: BuildEnvelope };
  build_to_repair: { args: { buildId: string; reason?: string }; result: BuildEnvelope };
  build_set_max_iterations: { args: { buildId: string; max: number }; result: number };
  build_requeue: { args: { buildId: string; note?: string }; result: BuildEnvelope };
  build_smoke: { args: { buildId: string }; result: SmokeReport };
  build_promote: { args: { buildId: string }; result: BuildEnvelope };
  /** Fix from the dashboard: a promoted internal widget goes back into Play Place staging with the directive. */
  build_rework: { args: { buildId: string; directive: string }; result: BuildEnvelope };
  build_remove: { args: { buildId: string }; result: BuildHubView };
  /** Archive a build out of the Staging hub list (or bring it back); card and files kept. */
  build_archive: { args: { buildId: string; archived: boolean }; result: BuildHubView };
  /** Hard stop (distinct from Pause): abort the in-flight step, release the GPU slot, kill a Claude run. */
  cancel_build_job: { args: { jobId: string }; result: BuildEnvelope };
  /** Delete a build (aborting it first) into the Trash: card, steer copies, promoted copy and output folder, kept 30 days. */
  delete_build_job: { args: { jobId: string; purgeFiles?: boolean }; result: DeleteReport };
  /** The Trash, newest first (expired entries swept first). */
  trash_list: { args: undefined; result: TrashEntry[] };
  /** Undo a delete: folders back in place, the card back in the hub / the run back on the list. */
  trash_restore: { args: { trashId: string }; result: TrashEntry };
  /** Delete one Trash entry for good. */
  trash_purge: { args: { trashId: string }; result: void };
  /** Delete every Repair Queue and cancelled build. */
  clear_failed_jobs: { args: { purgeFiles?: boolean }; result: DeleteReport[] };
  /** Build Runners row: cancel if live, hide from the runner list (audit log kept), optionally purge staging/<slug>. */
  runner_dismiss: { args: { taskId: string; purgeFiles?: boolean }; result: DeleteReport };
  /** Loopback URL of a promoted (frozen) internal widget, served for its sandbox iframe. */
  build_widget_url: { args: { buildId: string }; result: string };
  /** Starts the loopback preview server once; `watch: false` when the Peek View closes. */
  build_peek_status: { args: { buildId: string; watch?: boolean }; result: PeekStatus };
  build_open_window: { args: { buildId: string }; result: void };
  build_open_browser: { args: { buildId: string }; result: void };
  // ── Agent Conversation transcripts (transcript.rs; read-only) ──
  /** Root conversations, newest activity first (default 50, max 200). */
  transcript_conversations: { args: { limit?: number; before?: number; roots_only?: boolean }; result: TranscriptConversation[] };
  /** One page of a conversation (`ORDER BY at, seq`) + its nested ones; a task is backfilled from tasks.db first. */
  transcript_get: { args: { conv_id: string; after_seq?: number; limit?: number }; result: TranscriptPage };
  /** One message with its body (loaded lazily when a row is opened). */
  transcript_message: { args: { seq: number }; result: TranscriptMessage };
}

export function xcmd<K extends keyof ExtCommands>(name: K, ...args: ExtCommands[K]["args"] extends undefined ? [] : [ExtCommands[K]["args"]]): Promise<ExtCommands[K]["result"]> {
  return native<ExtCommands[K]["result"]>(name, args[0] as Record<string, unknown> | undefined);
}

export type ExtEventName = "gateway-health" | "build-hub" | "agent-transcript" | "media-render" | "media-ingest" | "cloud-transfer" | "cloud-status";

/** Subscribe to one of this feature's Rust → webview events. No-op on the PWA. */
export async function onExtEvent<P>(event: ExtEventName, handler: (payload: P) => void): Promise<() => void> {
  if (!isTauri()) return () => undefined;
  const { listen } = await import("@tauri-apps/api/event");
  return listen<P>(event, (e) => handler(e.payload));
}
