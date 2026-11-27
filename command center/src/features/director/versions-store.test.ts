import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TimelineClip, TimelineManifest, VerifiedRender } from "./contract";
import { ASSETS, manifest, project } from "./fixtures.test-util";

const push = vi.fn();
vi.mock("@/features/reminders/notify", () => ({ useToasts: { getState: () => ({ push }) } }));
vi.mock("./api", () => ({
  api: { projectGet: vi.fn(), chatLog: vi.fn(), manifestSave: vi.fn(), reviewGet: vi.fn(), deliverablesGet: vi.fn(), renderSnapshot: vi.fn(), manifestRestore: vi.fn() },
  onDirectorEvent: vi.fn(async () => () => undefined),
}));
vi.mock("./director-chat", () => ({ sendDirectorTurn: vi.fn() }));

const { api } = await import("./api");
const store = await import("./director-store");
const m = vi.mocked(api);
const st = () => store.useDirector.getState();

const clip = (id: string, assetId: string, outSec: number): TimelineClip => ({ id, assetId, inSec: 0, outSec, fadeMs: 0, transitionIn: { kind: "cut", ms: 0 }, punchIn: 1 });
const R2: VerifiedRender = { id: "r2", project: "demo", planId: "p-2", path: "renders/demo_v002.mp4", durationSec: 3, width: 1080, height: 1920, sizeBytes: 1, loudnessLufs: null, verify: { ok: true, checks: [] }, createdAt: "2026-11-21T00:00:00Z" };
const WORKING = manifest({ revision: 5, clips: [clip("c9", "a-v2", 2)] });
const OLD = manifest({ revision: 5, clips: [clip("c1", "a-v1", 3)] });

beforeEach(async () => {
  vi.clearAllMocks();
  m.chatLog.mockResolvedValue([]);
  m.reviewGet.mockResolvedValue({ rounds: [], openDecisions: [] });
  m.deliverablesGet.mockResolvedValue([]);
  m.manifestSave.mockImplementation(async ({ manifest: x }) => ({ ...x, revision: x.revision + 1 }));
  m.projectGet.mockResolvedValue({ project: project(), assets: ASSETS, manifest: WORKING, renders: [R2] });
  store.resetDirectorStore();
  await store.openProject("demo");
});

describe("restoreVersion", () => {
  it("makes the snapshot the timeline, keeps an undo point marked restore, and toasts with Undo", async () => {
    m.manifestRestore.mockResolvedValue({ ...OLD, revision: 6 });
    expect(await store.restoreVersion("r2")).toBe(true);
    expect(m.manifestRestore).toHaveBeenCalledWith({ slug: "demo", renderId: "r2", revision: expect.any(Number) });
    expect(st().manifest?.clips[0].id).toBe("c1");
    expect(st().manifest?.revision).toBe(6);
    expect(st().undo).toMatchObject({ slug: "demo", what: "restore", before: { clips: WORKING.clips } });
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ title: "Version v002 restored", actions: [expect.objectContaining({ label: "Undo" })] }));
    // Undo puts the cut from before back and says so.
    push.mockClear();
    expect(await store.undoDirectorEdit()).toBe(true);
    expect(st().manifest?.clips).toEqual(WORKING.clips);
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ title: "Restore undone" }));
  });

  it("a refusal (no snapshot) changes nothing and shows the reason", async () => {
    m.manifestRestore.mockRejectedValue(new Error("NO_SNAPSHOT: this render was made before versions were kept, so its cut can't be restored."));
    expect(await store.restoreVersion("r2")).toBe(false);
    expect(st().manifest).toEqual(WORKING);
    expect(st().undo).toBeNull();
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ title: "Couldn't restore this version", body: expect.stringMatching(/^this render was made before/), tone: "error" }));
  });
});

describe("loadSnapshot / compare", () => {
  it("caches snapshots per render (including none)", async () => {
    m.renderSnapshot.mockResolvedValue({ renderId: "r2", planId: "p-2", manifest: OLD as TimelineManifest, createdAt: R2.createdAt });
    expect((await store.loadSnapshot("r2"))?.clips[0].id).toBe("c1");
    await store.loadSnapshot("r2");
    expect(m.renderSnapshot).toHaveBeenCalledTimes(1);
    m.renderSnapshot.mockResolvedValue({ renderId: "r1", planId: "p-1", manifest: null, createdAt: "" });
    expect(await store.loadSnapshot("r1")).toBeNull();
    await store.loadSnapshot("r1");
    expect(m.renderSnapshot).toHaveBeenCalledTimes(2);
  });

  it("openCompare / closeCompare, reset when another project opens", async () => {
    store.openCompare("r1", "r2");
    expect(st().compare).toEqual({ a: "r1", b: "r2" });
    store.openCompare("r1", "r1");
    expect(st().compare).toBeNull();
    store.openCompare("r1", "r2");
    store.closeCompare();
    expect(st().compare).toBeNull();
    store.openCompare("r1", "r2");
    m.projectGet.mockResolvedValue({ project: project({ slug: "other" }), assets: ASSETS, manifest: WORKING, renders: [] });
    await store.openProject("other");
    expect(st().compare).toBeNull();
  });

  it("Compare points the note placement at A, and any select / seek closes it so the preview shows the jump", () => {
    store.setPreviewTime(12);
    store.openCompare("r1", "r2");
    expect(st()).toMatchObject({ selection: { kind: "render", id: "r1" }, previewMode: "final", previewTime: 0 });
    store.setPreviewTime(4.5); // Compare feeds A's time
    expect(st().previewTime).toBe(4.5);
    store.seekTo({ kind: "render", id: "r2" }, 3);
    expect(st().compare).toBeNull();
    expect(st().seek?.sec).toBe(3);
    store.openCompare("r1", "r2");
    store.select({ kind: "clip", id: "c1" });
    expect(st().compare).toBeNull();
  });
});
