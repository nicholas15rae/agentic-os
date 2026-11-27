import { describe, expect, it } from "vitest";
import type { BuildView } from "./types";
import { hubFor, runTruth, showHubIteration } from "./build-truth";

const hub = (o: { id?: string; slug?: string; status: BuildView["envelope"]["status"]; worker?: string | null; iteration?: number }) =>
  ({ envelope: { build_id: o.id ?? "b-1", project_slug: o.slug ?? "brainstorm-build", status: o.status }, worker_task_id: o.worker ?? null, iteration: o.iteration ?? 3, max_iterations: 3 }) as unknown as BuildView;
const run = (o: Partial<{ id: string; slug: string | null; status: string; iteration: number }> = {}) => ({ id: "t-1", slug: "brainstorm-build", status: "failed", iteration: 3, maxIterations: 3, ...o });

describe("one true state per build", () => {
  it("the E46 clock: a deployed hub build is Deployed in Build Runners too, the worker's 3/3 is a note", () => {
    const t = runTruth(run(), [hub({ status: "deployed" })]);
    expect(t.label).toBe("Deployed");
    expect(t.tone).toBe("ok");
    expect(t.note).toContain("worker stopped at iter 3/3");
    expect(t.canRetry).toBe(false);
    expect(t.showIteration).toBe(false);
    expect(t.stale).toBe(true);
  });

  it("a run still building, or one with no hub build, keeps its own state", () => {
    expect(runTruth(run({ status: "coding", iteration: 1 }), [hub({ status: "building" })])).toMatchObject({ label: "Building", canRetry: false, showIteration: true, stale: false });
    expect(runTruth(run({ slug: "other" }), [hub({ status: "deployed" })])).toMatchObject({ hub: null, label: "failed", canRetry: true, stale: false });
  });

  it("binds by worker task id first, then by slug", () => {
    const a = hub({ id: "b-a", slug: "x", status: "queued", worker: "t-1" });
    const b = hub({ id: "b-b", slug: "brainstorm-build", status: "deployed" });
    expect(hubFor(run(), [b, a])?.envelope.build_id).toBe("b-a");
    expect(hubFor({ id: "t-9", slug: null }, [b])).toBeNull();
  });

  it("the hub card shows its iteration only while it is still being built", () => {
    expect(showHubIteration(hub({ status: "building" }))).toBe(true);
    expect(showHubIteration(hub({ status: "deployed" }))).toBe(false);
    expect(showHubIteration(hub({ status: "ready_for_merge" }))).toBe(false);
  });
});
