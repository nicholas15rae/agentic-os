/**
 * Typed contract for the Thought-to-Product commands and events (lifecycle.rs, buildhub.rs,
 * handoff_cues). Kept beside `platform.ts` (not inside it) so the shared NativeCommands file
 * isn't churned by this feature; it uses the same `native()` invoke and the same desktop-only rule.
 */
import { isTauri, native } from "@/lib/platform";
import type { HealthSnapshot } from "@/features/lifecycle/health";
import type { BuildEnvelope, BuildHubView, IntakeQuestion, PeekStatus, RuntimeConfig, SmokeReport } from "@/features/buildhub/types";

export interface ExtCommands {
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
  build_enqueue: { args: { envelope: BuildEnvelope; brief: string; noteIds: string[]; approved?: boolean }; result: BuildEnvelope };
  build_reorder: { args: { buildId: string; direction: "up" | "down" | "top" }; result: BuildHubView };
  build_pause: { args: { buildId: string }; result: BuildEnvelope };
  build_resume: { args: { buildId: string }; result: BuildEnvelope };
  build_steer: { args: { buildId: string; directive: string }; result: BuildEnvelope };
  build_to_repair: { args: { buildId: string; reason?: string }; result: BuildEnvelope };
  build_requeue: { args: { buildId: string; note?: string }; result: BuildEnvelope };
  build_smoke: { args: { buildId: string }; result: SmokeReport };
  build_promote: { args: { buildId: string }; result: BuildEnvelope };
  build_remove: { args: { buildId: string }; result: BuildHubView };
  /** Loopback URL of a promoted (frozen) internal widget, served for its sandbox iframe. */
  build_widget_url: { args: { buildId: string }; result: string };
  /** Starts the loopback preview server once; `watch: false` when the Peek View closes. */
  build_peek_status: { args: { buildId: string; watch?: boolean }; result: PeekStatus };
  build_open_window: { args: { buildId: string }; result: void };
  build_open_browser: { args: { buildId: string }; result: void };
}

export function xcmd<K extends keyof ExtCommands>(name: K, ...args: ExtCommands[K]["args"] extends undefined ? [] : [ExtCommands[K]["args"]]): Promise<ExtCommands[K]["result"]> {
  return native<ExtCommands[K]["result"]>(name, args[0] as Record<string, unknown> | undefined);
}

export type ExtEventName = "gateway-health" | "build-hub";

/** Subscribe to one of this feature's Rust → webview events. No-op on the PWA. */
export async function onExtEvent<P>(event: ExtEventName, handler: (payload: P) => void): Promise<() => void> {
  if (!isTauri()) return () => undefined;
  const { listen } = await import("@tauri-apps/api/event");
  return listen<P>(event, (e) => handler(e.payload));
}
