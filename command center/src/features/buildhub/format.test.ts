import { describe, expect, it } from "vitest";
import { currentMilestone, elapsedEta, fmtDuration, hubCounts, smokeBadge, workerIndicator } from "./format";
import type { BuildStatus, BuildView } from "./types";

function build(status: BuildStatus, p: Partial<BuildView> = {}): BuildView {
  return {
    envelope: {
      build_id: "b-1",
      project_slug: "x",
      title: "X",
      target_runtime: "internal_widget",
      output_directory: "D:\\s\\x",
      spec_summary: "s",
      milestones: ["Spec", "Layout", "Core", "Smoke", "Promote"],
      acceptance_criteria: ["Renders"],
      assigned_worker: "coder",
      preview_url: null,
      status,
      human_override: [],
    },
    seq: 1,
    created_at: 0,
    started_at: null,
    finished_at: null,
    progress: 0,
    stage: null,
    iteration: 0,
    max_iterations: 0,
    worker_task_id: null,
    dev_task_id: null,
    logs: [],
    smoke: { attempts: 0, failures: 0, running: false, last: null },
    repair: null,
    paused_from: null,
    brief: "",
    note_ids: [],
    promoted_at: null,
    preview_version: 0,
    committing: false,
    position: null,
    peek: { url: null, reachable: false, checked_at: 0 },
    ...p,
  };
}

const report = (passed: boolean) => ({ passed, at: 0, ms: 1, checks: [], failed_assertions: passed ? [] : ["body: x"], trace: "" });

describe("staging card format", () => {
  it("worker indicator: Claude Working / Coder Active / Queued / Idle", () => {
    expect(workerIndicator(build("building"))).toEqual({ label: "Coder Active", live: true });
    const c = build("building");
    c.envelope.assigned_worker = "claude";
    expect(workerIndicator(c).label).toBe("Claude Working");
    expect(workerIndicator(build("queued")).label).toBe("Queued");
    expect(workerIndicator(build("queued", { worker_task_id: "t" })).label).toBe("Handed off");
    expect(workerIndicator(build("paused"))).toEqual({ label: "Idle", live: false });
  });

  it("smoke badge: Testing / Failed Check / Ready for Merge", () => {
    expect(smokeBadge(build("building"))).toBeNull();
    expect(smokeBadge(build("smoke_testing"))?.label).toBe("Testing");
    expect(smokeBadge(build("queued", { smoke: { attempts: 1, failures: 1, running: false, last: report(false) } }))?.label).toBe("Failed Check");
    expect(smokeBadge(build("repair_queue", { smoke: { attempts: 2, failures: 2, running: false, last: report(false) } }))?.label).toBe("Failed Check ×2");
    expect(smokeBadge(build("ready_for_merge", { smoke: { attempts: 1, failures: 0, running: false, last: report(true) } }))).toEqual({ label: "Ready for Merge", tone: "ok" });
  });

  it("current milestone follows progress", () => {
    expect(currentMilestone(build("building", { progress: 0 }))).toBe("Spec");
    expect(currentMilestone(build("building", { progress: 50 }))).toBe("Core");
    expect(currentMilestone(build("building", { progress: 62 }))).toBe("Smoke");
    expect(currentMilestone(build("building", { progress: 100 }))).toBe("Promote");
    expect(currentMilestone(build("ready_for_merge", { progress: 50 }))).toBe("Promote");
  });

  it("elapsed / ETA", () => {
    expect(elapsedEta(build("queued"), 1000)).toBe("waiting");
    expect(elapsedEta(build("building", { started_at: 0, progress: 50 }), 60_000)).toBe("elapsed 1m 00s · ETA ~1m 00s");
    expect(elapsedEta(build("building", { started_at: 0, progress: 5 }), 60_000)).toBe("elapsed 1m 00s");
    expect(elapsedEta(build("ready_for_merge", { started_at: 0, finished_at: 30_000, progress: 100 }), 999_999)).toBe("elapsed 30s");
    expect(fmtDuration(3_725_000)).toBe("1h 02m");
  });

  it("hub counts split staging from repair", () => {
    expect(hubCounts([build("queued"), build("repair_queue"), build("deployed")])).toEqual({ staging: 2, repair: 1 });
  });
});
