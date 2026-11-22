import type { BuildStatus, BuildView } from "./types";

/** Card display helpers (pure). */

export const STATUS_LABEL: Record<BuildStatus, string> = {
  queued: "Queued",
  building: "Building",
  paused: "Paused",
  repair_queue: "Repair queue",
  smoke_testing: "Smoke testing",
  ready_for_merge: "Ready for merge",
  deployed: "Deployed",
  cancelled: "Cancelled",
};

export const RUNTIME_BADGE = { internal_widget: "INTERNAL WIDGET", external_os: "EXTERNAL OS" } as const;

/** Active worker indicator: Claude Working / Coder Active / Designer Active / Queued / Idle. */
export function workerIndicator(b: Pick<BuildView, "envelope" | "worker_task_id" | "dev_task_id">): { label: string; live: boolean } {
  const s = b.envelope.status;
  const w = b.envelope.assigned_worker;
  if (s === "building") return { label: w === "claude" ? "Claude Working" : w === "designer" ? "Designer Active" : "Coder Active", live: true };
  if (s === "smoke_testing") return { label: "Checks running", live: true };
  if (s === "queued") return { label: b.worker_task_id || b.dev_task_id ? (w === "claude" ? "Waiting on Claude" : "Handed off") : "Queued", live: false };
  return { label: "Idle", live: false };
}

/** Automated smoke-test badge: Testing / Failed Check / Ready for Merge (null before any check). */
export function smokeBadge(b: Pick<BuildView, "envelope" | "smoke">): { label: string; tone: "run" | "bad" | "ok" } | null {
  if (b.smoke.running || b.envelope.status === "smoke_testing") return { label: "Testing", tone: "run" };
  if (b.envelope.status === "ready_for_merge" || b.envelope.status === "deployed") return b.smoke.last?.passed ? { label: "Ready for Merge", tone: "ok" } : null;
  if (b.smoke.last && !b.smoke.last.passed) return { label: `Failed Check${b.smoke.failures > 1 ? ` ×${b.smoke.failures}` : ""}`, tone: "bad" };
  return null;
}

/** The current envelope milestone, proportional to progress. */
export function currentMilestone(b: Pick<BuildView, "envelope" | "progress">): string {
  const m = b.envelope.milestones;
  if (!m.length) return "";
  if (b.envelope.status === "ready_for_merge" || b.envelope.status === "deployed") return m[m.length - 1];
  return m[Math.min(m.length - 1, Math.floor((b.progress / 100) * m.length))];
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** "elapsed 3m 10s · ETA ~4m" (ETA only once there's enough progress to extrapolate). */
export function elapsedEta(b: Pick<BuildView, "started_at" | "finished_at" | "progress" | "envelope">, now: number): string {
  if (b.started_at == null) return b.envelope.status === "queued" ? "waiting" : "";
  const end = b.finished_at ?? now;
  const elapsed = end - b.started_at;
  let s = `elapsed ${fmtDuration(elapsed)}`;
  if (!b.finished_at && b.envelope.status === "building" && b.progress >= 10 && b.progress < 100) {
    s += ` · ETA ~${fmtDuration((elapsed / b.progress) * (100 - b.progress))}`;
  }
  return s;
}

export const hubCounts = (builds: readonly BuildView[]) => ({
  staging: builds.filter((b) => b.envelope.status !== "repair_queue").length,
  repair: builds.filter((b) => b.envelope.status === "repair_queue").length,
});
