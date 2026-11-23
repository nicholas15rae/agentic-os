import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RenderPlan, TimelineManifest, VerifiedRender } from "./contract";
import { ASSETS, V1, manifest, project } from "./fixtures.test-util";

const push = vi.fn();
vi.mock("@/features/reminders/notify", () => ({ useToasts: { getState: () => ({ push }) } }));
vi.mock("./api", () => ({
  api: {
    projectGet: vi.fn(),
    chatLog: vi.fn(),
    manifestSave: vi.fn(),
    renderPlan: vi.fn(),
    renderExecute: vi.fn(),
    projects: vi.fn(),
  },
}));

const { api } = await import("./api");
const store = await import("./director-store");
const { addClip } = await import("./manifest");
const m = vi.mocked(api);
const st = () => store.useDirector.getState();

const PLAN: RenderPlan = { planId: "p-1", project: "demo", manifestRevision: 4, sources: [], audio: [], outputName: "demo", outputSpec: "1920×1080", renderMode: "cpu_only", proposedBy: "director" };
const saved = (x: TimelineManifest): TimelineManifest => ({ ...x, revision: x.revision + 1 });

beforeEach(async () => {
  vi.clearAllMocks();
  store.resetDirectorStore();
  m.projectGet.mockResolvedValue({ project: project(), assets: ASSETS, manifest: manifest(), renders: [] });
  m.chatLog.mockResolvedValue([{ role: "director", text: "Plan:\n```director-action\n{\"type\":\"execute_verified_render\"}\n```", at: "t" }]);
  m.manifestSave.mockImplementation(async ({ manifest: x }) => saved(x));
  m.renderPlan.mockResolvedValue(PLAN);
  m.renderExecute.mockResolvedValue({ jobId: "j-1" });
  await store.openProject("demo");
});
afterEach(() => vi.useRealTimers());

describe("openProject", () => {
  it("loads project, assets, manifest and the chat log (action blocks hidden)", () => {
    expect(st().manifest?.revision).toBe(3);
    expect(st().assets).toHaveLength(4);
    expect(st().chat[0]).toMatchObject({ role: "director", text: "Plan:" });
  });
});

describe("debounced manifest save", () => {
  it("coalesces edits into one save 400 ms after the last, with the loaded revision", async () => {
    vi.useFakeTimers();
    store.editManifest((x) => addClip(x, V1));
    await vi.advanceTimersByTimeAsync(200);
    store.editManifest((x) => addClip(x, V1));
    await vi.advanceTimersByTimeAsync(399);
    expect(m.manifestSave).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(m.manifestSave).toHaveBeenCalledTimes(1);
    const sent = m.manifestSave.mock.calls[0][0];
    expect(sent.slug).toBe("demo");
    expect(sent.manifest).toMatchObject({ revision: 3, updatedBy: "nic" });
    expect(sent.manifest.clips).toHaveLength(2);
    await vi.runAllTimersAsync();
    expect(st().manifest?.revision).toBe(4);
  });

  it("an edit made while a save is in flight is kept and rides on the new revision", async () => {
    let release!: () => void;
    m.manifestSave.mockImplementationOnce(({ manifest: x }) => new Promise((r) => (release = () => r(saved(x)))));
    store.editManifest((x) => addClip(x, V1));
    const p = store.flushSave();
    await Promise.resolve();
    store.editManifest((x) => addClip(x, V1));
    release();
    await p;
    expect(st().manifest?.clips).toHaveLength(2);
    expect(st().manifest?.revision).toBe(4);
    await store.flushSave();
    expect(m.manifestSave).toHaveBeenLastCalledWith(expect.objectContaining({ manifest: expect.objectContaining({ revision: 4 }) }));
  });

  it("a stale revision reloads the project and toasts", async () => {
    m.manifestSave.mockRejectedValueOnce("STALE_REVISION: manifest is at 5, got 3");
    m.projectGet.mockResolvedValueOnce({ project: project(), assets: ASSETS, manifest: manifest({ revision: 5 }), renders: [] });
    store.editManifest((x) => addClip(x, V1));
    expect(await store.flushSave()).toBe(false);
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ tone: "warn" }));
    expect(st().manifest?.revision).toBe(5);
    expect(st().manifest?.clips).toHaveLength(0);
  });

  it("nothing to save → no call", async () => {
    expect(await store.flushSave()).toBe(true);
    expect(m.manifestSave).not.toHaveBeenCalled();
  });
});

describe("Director actions never render", () => {
  it("propose_edit_plan saves as the director, then raises the plan card", async () => {
    const notes = await store.applyDirectorActions([{ type: "propose_edit_plan", clips: [{ assetId: "a-v1", inSec: 1, outSec: 4, fadeMs: 0 }], audio: [], output: { aspect: "9:16" }, note: "" }]);
    expect(m.manifestSave).toHaveBeenCalledWith(expect.objectContaining({ manifest: expect.objectContaining({ updatedBy: "director", clips: [expect.objectContaining({ assetId: "a-v1", inSec: 1, outSec: 4 })] }) }));
    expect(m.renderPlan).toHaveBeenCalledWith({ slug: "demo", proposedBy: "director" });
    expect(st().plan).toEqual(PLAN);
    expect(m.renderExecute).not.toHaveBeenCalled();
    expect(notes[0]).toMatch(/Edit plan: 1 clip/);
  });

  it("execute_verified_render only raises the plan card", async () => {
    await store.applyDirectorActions([{ type: "execute_verified_render" }]);
    expect(st().plan).toEqual(PLAN);
    expect(m.renderExecute).not.toHaveBeenCalled();
  });

  it("populate_shot_list fills the shot list", async () => {
    await store.applyDirectorActions([{ type: "populate_shot_list", slots: [{ id: "s1", label: "Hook", instructions: "", kind: "video", targetSec: 5 }] }]);
    expect(st().manifest?.shotList[0]).toMatchObject({ id: "s1", status: "needed", assetId: null });
  });

  it("Approve & Render is the only path to media_render_execute (approved: true)", async () => {
    await store.requestPlan("nic");
    await store.approvePlan();
    expect(m.renderExecute).toHaveBeenCalledWith({ slug: "demo", planId: "p-1", approved: true });
    expect(st().plan).toBeNull();
    expect(st().job).toMatchObject({ jobId: "j-1", status: "queued" });
  });
});

describe("render events", () => {
  const render: VerifiedRender = { id: "r1", project: "demo", planId: "p-1", path: "C:\\x\\renders\\demo_v001.mp4", durationSec: 10, width: 1920, height: 1080, sizeBytes: 5, loudnessLufs: -18, verify: { ok: true, checks: [] }, createdAt: "t" };
  it("a done event with a verified render lands on the shelf once; other projects are ignored", () => {
    store.onRenderEvent({ slug: "other", jobId: "j", status: "done", pct: 100, etaSec: null, stage: "done", render });
    expect(st().renders).toHaveLength(0);
    store.onRenderEvent({ slug: "demo", jobId: "j", status: "running", pct: 40, etaSec: 3, stage: "encode" });
    expect(st().renders).toHaveLength(0);
    store.onRenderEvent({ slug: "demo", jobId: "j", status: "done", pct: 100, etaSec: null, stage: "done", render });
    store.onRenderEvent({ slug: "demo", jobId: "j", status: "done", pct: 100, etaSec: null, stage: "done", render });
    expect(st().renders).toEqual([render]);
  });
  it("canRender needs media-forge green + ffmpeg", () => {
    const ok = { enabled: true, healthy: true, tools: 3, error: null };
    expect(store.canRender(null)).toBe(false);
    expect(store.canRender({ shotcut: ok, mediaForge: ok, ffmpegFound: true })).toBe(true);
    expect(store.canRender({ shotcut: ok, mediaForge: { ...ok, healthy: false }, ffmpegFound: true })).toBe(false);
    expect(store.canRender({ shotcut: ok, mediaForge: ok, ffmpegFound: false })).toBe(false);
  });
});
