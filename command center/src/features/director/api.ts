/**
 * Director Suite IPC (media.rs). JSON commands go through `xcmd` (ExtCommands); the two raw-body
 * commands send the bytes as the request body with their scalar args in headers, because Rust
 * reads `tauri::ipc::Request` for them. Signatures follow the locked `DirectorCommands` contract.
 * Desktop-only: every call throws on the PWA (the page never renders its studio there).
 */
import { isTauri } from "@/lib/platform";
import { onExtEvent, xcmd } from "@/lib/native-ext";
import type { DirectorCommands, DirectorEvents } from "./contract";

type Args<K extends keyof DirectorCommands> = DirectorCommands[K]["args"];
type Result<K extends keyof DirectorCommands> = DirectorCommands[K]["result"];

/** Upload chunk size for HTML5-dropped files (the contract's ≤ 8 MiB per chunk). */
export const CHUNK_BYTES = 8 * 1024 * 1024;

async function rawInvoke<T>(name: string, body: Uint8Array, headers: Record<string, string>): Promise<T> {
  if (!isTauri()) throw new Error(`native command "${name}" is desktop-only`);
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(name, body, { headers });
}

export const api = {
  projects: (): Promise<Result<"media_projects">> => xcmd("media_projects"),
  projectCreate: (a: Args<"media_project_create">): Promise<Result<"media_project_create">> => xcmd("media_project_create", a),
  projectGet: (a: Args<"media_project_get">): Promise<Result<"media_project_get">> => xcmd("media_project_get", a),
  ingestPaths: (a: Args<"media_ingest_paths">): Promise<Result<"media_ingest_paths">> => xcmd("media_ingest_paths", a),
  ingestBegin: (a: Args<"media_ingest_begin">): Promise<Result<"media_ingest_begin">> => xcmd("media_ingest_begin", a),
  /** Raw body: the chunk bytes; `x-upload-id` / `x-offset` headers. */
  ingestChunk: (a: Args<"media_ingest_chunk">): Promise<Result<"media_ingest_chunk">> =>
    rawInvoke("media_ingest_chunk", a.bytes, { "x-upload-id": a.uploadId, "x-offset": String(a.offset) }),
  ingestFinish: (a: Args<"media_ingest_finish">): Promise<Result<"media_ingest_finish">> => xcmd("media_ingest_finish", a),
  /** Raw body: the recording; `x-slug` / `x-mime` headers. */
  voiceoverSave: (a: Args<"media_voiceover_save">): Promise<Result<"media_voiceover_save">> =>
    rawInvoke("media_voiceover_save", a.bytes, { "x-slug": a.slug, "x-mime": a.mime }),
  manifestSave: (a: Args<"media_manifest_save">): Promise<Result<"media_manifest_save">> => xcmd("media_manifest_save", a),
  chatLog: (a: Args<"media_chat_log">): Promise<Result<"media_chat_log">> => xcmd("media_chat_log", a),
  renderPlan: (a: Args<"media_render_plan">): Promise<Result<"media_render_plan">> => xcmd("media_render_plan", a),
  /** Only ever from the Render Plan card's Approve & Render click. */
  renderExecute: (a: Args<"media_render_execute">): Promise<Result<"media_render_execute">> => xcmd("media_render_execute", a),
  renderCancel: (a: Args<"media_render_cancel">): Promise<Result<"media_render_cancel">> => xcmd("media_render_cancel", a),
  readiness: (): Promise<Result<"media_readiness">> => xcmd("media_readiness"),
  reveal: (a: Args<"media_reveal">): Promise<Result<"media_reveal">> => xcmd("media_reveal", a),
  /** The Director's own chat turn (director.rs). */
  turn: (a: Args<"director_turn">): Promise<Result<"director_turn">> => xcmd("director_turn", a),
  // ── v2 (contract §8) ──
  /** Title / brief / status / speed. Approving the brief moves a "brief" project to "shooting". */
  projectUpdate: (a: Args<"media_project_update">): Promise<Result<"media_project_update">> => xcmd("media_project_update", a),
  /** Tauri can't tell a missing arg from `null`, so a `slotId: null` (clear) goes over the wire as "". */
  assetUpdate: (a: Args<"media_asset_update">): Promise<Result<"media_asset_update">> =>
    xcmd("media_asset_update", a.slotId === null ? ({ ...a, slotId: "" } as unknown as Args<"media_asset_update">) : a),
  intakeStatus: (a: Args<"media_intake_status">): Promise<Result<"media_intake_status">> => xcmd("media_intake_status", a),
  transcribe: (a: Args<"media_transcribe">): Promise<Result<"media_transcribe">> => xcmd("media_transcribe", a),
  noteAdd: (a: Args<"media_note_add">): Promise<Result<"media_note_add">> => xcmd("media_note_add", a),
  /** Pass `manual: true` only for Nic's own Resolve click; a revision's notes go without it. */
  noteResolve: (a: Args<"media_note_resolve">): Promise<Result<"media_note_resolve">> => xcmd("media_note_resolve", a),
  /** Snap clips to speech + clip / total length checks (reads only; nothing is saved). */
  planCheck: (a: Args<"media_plan_check">): Promise<Result<"media_plan_check">> => xcmd("media_plan_check", a),
  /** Timed transcript lines per video asset, for the Director's TRANSCRIPT section (reads only). */
  transcriptLines: (a: Args<"media_transcript_lines">): Promise<Result<"media_transcript_lines">> => xcmd("media_transcript_lines", a),
  reviewGet: (a: Args<"media_review_get">): Promise<Result<"media_review_get">> => xcmd("media_review_get", a),
  /** Stores the Director's round summary / open decisions (text only: nothing renders or resolves). */
  reviewWrite: (a: Args<"media_review_write">): Promise<Result<"media_review_write">> => xcmd("media_review_write", a),
  /** Only ever from Nic's "Approve final" click: copies verified renders to renders/final/<platform>/. */
  approveFinal: (a: Args<"media_approve_final">): Promise<Result<"media_approve_final">> => xcmd("media_approve_final", a),
  deliverablesGet: (a: Args<"media_deliverables_get">): Promise<Result<"media_deliverables_get">> => xcmd("media_deliverables_get", a),
  // ── Part 3: ComfyUI (comfy.rs) ──
  comfyStatus: (): Promise<Result<"comfy_status">> => xcmd("comfy_status"),
  /** Only ever from an Enqueue / Re-roll click. */
  comfyEnqueue: (a: Args<"comfy_enqueue">): Promise<Result<"comfy_enqueue">> => xcmd("comfy_enqueue", a),
  comfyCancel: (a: Args<"comfy_cancel">): Promise<Result<"comfy_cancel">> => xcmd("comfy_cancel", a),
  /** Only ever from the queue's Run now click. */
  comfyRunNow: (): Promise<Result<"comfy_run_now">> => xcmd("comfy_run_now"),
  comfyQueue: (): Promise<Result<"comfy_queue_get">> => xcmd("comfy_queue_get"),
  comfySettingsSet: (a: Args<"comfy_settings_set">): Promise<Result<"comfy_settings_set">> => xcmd("comfy_settings_set", a),
  // ── Part 3: Versions (media.rs) ──
  renderSnapshot: (a: Args<"media_render_snapshot">): Promise<Result<"media_render_snapshot">> => xcmd("media_render_snapshot", a),
  /** Only from the Versions confirm click. */
  manifestRestore: (a: Args<"media_manifest_restore">): Promise<Result<"media_manifest_restore">> => xcmd("media_manifest_restore", a),
  // ── Part 4: auditions (scene_reader.rs) ──
  sceneReaderStatus: (): Promise<Result<"scene_reader_status">> => xcmd("scene_reader_status"),
  /** Only from a click (reads a copy of Scene Reader's library). */
  sceneReaderList: (): Promise<Result<"scene_reader_list">> => xcmd("scene_reader_list"),
  /** Only from the Import click. */
  sceneReaderImport: (a: Args<"scene_reader_import">): Promise<Result<"scene_reader_import">> => xcmd("scene_reader_import", a),
  sidesList: (a: Args<"media_sides_list">): Promise<Result<"media_sides_list">> => xcmd("media_sides_list", a),
  /** Raw body: the sides file; `x-slug` / `x-name` headers (the name percent-encoded: headers are ASCII). */
  sidesSave: (a: Args<"media_sides_save">): Promise<Result<"media_sides_save">> => rawInvoke("media_sides_save", a.bytes, { "x-slug": a.slug, "x-name": encodeURIComponent(a.name) }),
  slateCard: (a: Args<"media_slate_card">): Promise<Result<"media_slate_card">> => xcmd("media_slate_card", a),
  // ── Part 6: style memory (director_style.rs) ──
  styleGet: (): Promise<Result<"media_style_get">> => xcmd("media_style_get"),
  /** Only after Nic's Approve final or a note resolve. */
  styleRecord: (a: Args<"media_style_record">): Promise<Result<"media_style_record">> => xcmd("media_style_record", a),
};

/** Subscribe to a Director Suite event. No-op on the PWA. */
export function onDirectorEvent<E extends keyof DirectorEvents>(event: E, handler: (payload: DirectorEvents[E]) => void): Promise<() => void> {
  return onExtEvent<DirectorEvents[E]>(event, handler);
}

/** Webview URL of a file inside projects/ (asset protocol). Empty string off the desktop. */
let convert: ((p: string) => string) | null = null;
void (async () => {
  if (!isTauri()) return;
  const core = await import("@tauri-apps/api/core");
  convert = core.convertFileSrc;
})();
export function fileSrc(path: string | null | undefined): string {
  if (!path) return "";
  if (convert) return convert(path);
  // Before the lazy import resolves: the same URL convertFileSrc builds on Windows (asset protocol).
  return isTauri() ? `http://asset.localhost/${encodeURIComponent(path)}` : "";
}

/**
 * Stream an HTML5-dropped File into raw/ in sequential 8 MiB chunks: begin → chunk… → finish.
 * `onProgress(received, total)` after every chunk.
 */
export async function ingestFile(slug: string, file: File, role: Args<"media_ingest_begin">["role"], onProgress?: (received: number, total: number) => void): Promise<Result<"media_ingest_finish">> {
  const { uploadId } = await api.ingestBegin({ slug, name: file.name, sizeBytes: file.size, role });
  let offset = 0;
  while (offset < file.size) {
    const end = Math.min(file.size, offset + CHUNK_BYTES);
    const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
    const { received } = await api.ingestChunk({ uploadId, offset, bytes });
    offset = received > offset ? received : end;
    onProgress?.(offset, file.size);
  }
  return api.ingestFinish({ uploadId });
}
