import type { KillIncident } from "@/features/trading/ibkr";

// Pure helpers (no store / browser imports) so they're unit-testable in node.
/** Ctrl+Shift+X anywhere in the app trips the E-stop (no confirmation: it is an E-stop). */
export const KILL_HOTKEY_LABEL = "Ctrl+Shift+X";

export function isKillHotkey(e: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "key">): boolean {
  return (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "x";
}

export function summarizeIncident(r: KillIncident & { note?: string }): string {
  if (r.failsafe) return r.note ?? "Lock written by the gateway; cancel/flatten started.";
  const bad = r.steps?.filter((s) => !s.ok).map((s) => `${s.step}: ${s.detail}`) ?? [];
  const head = `${r.dryRun ? "Dry run" : "Locked"} · ${r.cancelled?.length ?? 0} order(s) ${r.dryRun ? "to cancel" : "cancelled"} · ${r.flatten?.length ?? 0} position(s) ${r.dryRun ? "to flatten" : "flattening"}`;
  return bad.length ? `${head} — ${bad.join(" · ")}` : head;
}

