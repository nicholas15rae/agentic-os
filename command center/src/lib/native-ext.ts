/**
 * Typed contract for the Thought-to-Product commands and events (lifecycle.rs, buildhub.rs,
 * handoff_cues). Kept beside `platform.ts` (not inside it) so the shared NativeCommands file
 * isn't churned by this feature; it uses the same `native()` invoke and the same desktop-only rule.
 */
import { isTauri, native } from "@/lib/platform";
import type { HealthSnapshot } from "@/features/lifecycle/health";

export interface ExtCommands {
  // ── Phase 1: lifecycle ──
  gateway_health: { args: undefined; result: HealthSnapshot };
  gateway_reconnect: { args: undefined; result: HealthSnapshot };
  app_exit_check: { args: undefined; result: { busy: string[] } };
  /** Refuses with `BUSY:<labels>` when something is mid-commit, unless `force`. */
  app_exit: { args: { force?: boolean }; result: void };
}

export function xcmd<K extends keyof ExtCommands>(name: K, ...args: ExtCommands[K]["args"] extends undefined ? [] : [ExtCommands[K]["args"]]): Promise<ExtCommands[K]["result"]> {
  return native<ExtCommands[K]["result"]>(name, args[0] as Record<string, unknown> | undefined);
}

export type ExtEventName = "gateway-health";

/** Subscribe to one of this feature's Rust → webview events. No-op on the PWA. */
export async function onExtEvent<P>(event: ExtEventName, handler: (payload: P) => void): Promise<() => void> {
  if (!isTauri()) return () => undefined;
  const { listen } = await import("@tauri-apps/api/event");
  return listen<P>(event, (e) => handler(e.payload));
}
