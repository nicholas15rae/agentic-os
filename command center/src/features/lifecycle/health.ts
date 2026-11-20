/** Gateway heartbeat (Phase 1): the Rust `HealthSnapshot` and its pure indicator mapping. */

export type HealthState = "unknown" | "online" | "slow" | "timed_out" | "offline";

export interface HealthSnapshot {
  state: HealthState;
  latencyMs: number | null;
  /** Unix ms of the last probe (0 = never). */
  checkedAt: number;
  consecutiveFailures: number;
  needsReset: boolean;
  reconnecting: boolean;
  detail: string;
}

export const UNKNOWN_HEALTH: HealthSnapshot = { state: "unknown", latencyMs: null, checkedAt: 0, consecutiveFailures: 0, needsReset: false, reconnecting: false, detail: "" };

/** Mirrors lifecycle.rs (`SLOW_MS`, `RESET_AFTER`) for the phone's own probe. */
export const SLOW_MS = 1500;
export const RESET_AFTER = 2;

export type Probe = { ok: true; latencyMs: number } | { ok: false; timeout: boolean; detail: string };

/** Fold one probe into the previous snapshot (pure; the same rules as Rust `fold`). */
export function foldProbe(prev: HealthSnapshot, p: Probe, now: number): HealthSnapshot {
  if (p.ok) return { ...prev, state: p.latencyMs >= SLOW_MS ? "slow" : "online", latencyMs: p.latencyMs, checkedAt: now, consecutiveFailures: 0, needsReset: false, detail: `${p.latencyMs} ms` };
  const failures = prev.consecutiveFailures + 1;
  return { ...prev, state: p.timeout ? "timed_out" : "offline", latencyMs: null, checkedAt: now, consecutiveFailures: failures, needsReset: failures >= RESET_AFTER, detail: p.detail };
}

export interface HealthView {
  label: string;
  /** Tailwind classes for the dot. */
  dot: string;
  tone: "ok" | "warn" | "bad" | "idle";
  /** Highlight the control and offer the one-click reset. */
  alarm: boolean;
  title: string;
}

/** Compact indicator text: Online · 12 ms / Slow · 1.9 s / Timed out / Offline / Checking. */
export function healthView(h: HealthSnapshot): HealthView {
  const ms = h.latencyMs == null ? "" : h.latencyMs >= 1000 ? ` · ${(h.latencyMs / 1000).toFixed(1)} s` : ` · ${h.latencyMs} ms`;
  const base = (label: string, dot: string, tone: HealthView["tone"]): HealthView => ({
    label,
    dot,
    tone,
    alarm: h.needsReset,
    title: `Gateway: ${label}${h.detail ? ` (${h.detail})` : ""}${h.needsReset ? " · click to Reconnect" : ""}`,
  });
  if (h.reconnecting) return { ...base("Reconnecting…", "bg-amber animate-pulse", "warn"), alarm: false };
  switch (h.state) {
    case "online":
      return base(`Online${ms}`, "bg-teal", "ok");
    case "slow":
      return base(`Slow${ms}`, "bg-amber", "warn");
    case "timed_out":
      return base("Timed out", "bg-alert", "bad");
    case "offline":
      return base("Offline", "bg-alert", "bad");
    default:
      return base("Checking…", "bg-ink-3", "idle");
  }
}
