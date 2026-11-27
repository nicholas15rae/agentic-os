import type { BuildStatus, BuildView } from "./types";
import { STATUS_LABEL } from "./format";

/**
 * One true state per build (section pass). A Staging Hub build and its worker task (Build
 * Runners) used to show their own statuses side by side: the clock widget read "Deployed" on the
 * hub card and "Failed iter 3/3" in Build Runners, because the hub promoted it after its smoke
 * test while the worker task had given up at its loop limit. The hub card is the build's state;
 * a runner that belongs to one shows the hub's status, with what the worker reported as a note.
 */

/** Hub states past the build: the worker's loop is history. */
const SETTLED: readonly BuildStatus[] = ["ready_for_merge", "deployed", "cancelled"];

export interface RunTruth {
  /** The hub build this runner belongs to (null: a standalone run, its own status is the truth). */
  hub: BuildView | null;
  /** The status to show. */
  label: string;
  tone: "ok" | "bad" | "live";
  /** What the worker said, when it differs from the hub (shown as a note, never as the status). */
  note: string | null;
  /** Retry the worker task? Not once the hub has settled the build. */
  canRetry: boolean;
  /** Show the iteration counter? Only while the build is still being built. */
  showIteration: boolean;
  /** Finished and owned elsewhere: safe to clear from Build Runners. */
  stale: boolean;
}

interface RunLike {
  id: string;
  slug: string | null;
  status: string;
  iteration: number;
  maxIterations: number;
}

const TERMINAL = ["failed", "review_ready"];

/** The hub build a runner belongs to: bound by task id, else the same project slug. Pure. */
export function hubFor(run: Pick<RunLike, "id" | "slug">, builds: readonly BuildView[]): BuildView | null {
  const byId = builds.find((b) => b.worker_task_id === run.id);
  if (byId || !run.slug) return byId ?? null;
  // Same slug: the slug's one unfinished build (the hub allows only one), else the newest.
  const same = builds.filter((b) => b.envelope.project_slug === run.slug);
  return same.find((b) => b.envelope.status !== "deployed") ?? same.reduce<BuildView | null>((a, b) => (!a || (b.created_at ?? 0) > (a.created_at ?? 0) ? b : a), null);
}

/** Pure. */
export function runTruth(run: RunLike, builds: readonly BuildView[]): RunTruth {
  const hub = hubFor(run, builds);
  const failed = run.status === "failed";
  const ready = run.status === "review_ready";
  const workerSaid = failed ? `worker stopped${run.iteration > 0 ? ` at iter ${run.iteration}/${run.maxIterations}` : ""}` : null;
  if (!hub) {
    return { hub: null, label: run.status.replace("_", " "), tone: failed ? "bad" : ready ? "ok" : "live", note: null, canRetry: failed, showIteration: run.iteration > 0, stale: false };
  }
  const st = hub.envelope.status;
  const settled = SETTLED.includes(st);
  const tone: RunTruth["tone"] = st === "deployed" || st === "ready_for_merge" ? "ok" : st === "repair_queue" || st === "cancelled" ? "bad" : "live";
  return {
    hub,
    label: STATUS_LABEL[st],
    tone,
    note: settled && workerSaid ? `${workerSaid}; the hub's smoke test decided` : null,
    canRetry: failed && !settled,
    showIteration: !settled && run.iteration > 0,
    stale: TERMINAL.includes(run.status) && settled,
  };
}

/** The hub card's iteration counter: only while the build is still being built. Pure. */
export const showHubIteration = (b: Pick<BuildView, "iteration" | "max_iterations" | "envelope">) => b.max_iterations > 0 && b.iteration > 0 && !SETTLED.includes(b.envelope.status);
