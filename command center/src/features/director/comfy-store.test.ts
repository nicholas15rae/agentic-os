import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asset, gen, manifest, project } from "./fixtures.test-util";
import { comfyJob, comfyStatus } from "./comfy-fixtures.test-util";

const push = vi.fn();
vi.mock("@/features/reminders/notify", () => ({ useToasts: { getState: () => ({ push }) } }));
vi.mock("./api", () => ({
  api: {
    projectGet: vi.fn(),
    comfyStatus: vi.fn(),
    comfyQueue: vi.fn(),
    comfyEnqueue: vi.fn(),
    comfyCancel: vi.fn(),
    comfyRunNow: vi.fn(),
    comfySettingsSet: vi.fn(),
  },
  onDirectorEvent: vi.fn(async () => () => undefined),
  fileSrc: () => "",
}));

const { api } = await import("./api");
const dir = await import("./director-store");
const store = await import("./comfy-store");
const m = vi.mocked(api);
const st = () => store.useComfy.getState();

const IMG = asset("a-img", "image", { path: "C:\\ai-hub\\media\\projects\\demo\\raw\\still.png", width: 1024, height: 1024 });
const GEN = asset("a-gen", "image", { name: "still_03.png", generation: gen({ template: "scene-still", comfyJobId: "g-9" }) });
const STYLED = asset("a-sty", "image", { name: "styled.png", generation: gen({ template: "style-transfer", comfyJobId: "g-gone" }) });

beforeEach(() => {
  vi.clearAllMocks();
  store.resetComfyStore();
  dir.resetDirectorStore();
  dir.useDirector.setState({ slug: "demo", project: project(), manifest: manifest(), assets: [IMG, GEN, STYLED] });
  m.comfyStatus.mockResolvedValue(comfyStatus());
  m.comfyQueue.mockResolvedValue({ version: 1, settings: { modelRoots: [], policy: "idle" }, jobs: [] });
  m.comfyEnqueue.mockImplementation(async ({ slug, template, params }) => comfyJob({ id: "g-new", slug, template, params: { ...params } }));
  m.projectGet.mockResolvedValue({ project: project(), assets: [IMG], manifest: manifest(), renders: [] });
});
afterEach(() => vi.useRealTimers());

describe("refreshComfy", () => {
  it("loads status and the queue", async () => {
    m.comfyQueue.mockResolvedValue({ version: 1, settings: { modelRoots: [], policy: "idle" }, jobs: [comfyJob()] });
    await store.refreshComfy();
    expect(st().status?.settings.policy).toBe("idle");
    expect(st().statusError).toBeNull();
    expect(st().jobs.map((j) => j.id)).toEqual(["g-1"]);
  });
  it("a bridge error lands in statusError and never throws", async () => {
    m.comfyStatus.mockRejectedValue(new Error("not mocked: comfy_status"));
    m.comfyQueue.mockRejectedValue(new Error("not mocked: comfy_queue_get"));
    await expect(store.refreshComfy()).resolves.toBeUndefined();
    expect(st().statusError).toBe("not mocked: comfy_status");
    expect(st().jobs).toEqual([]);
  });
});

describe("enqueueDraft", () => {
  it("refuses with the blocker (no call) and toasts", async () => {
    await store.refreshComfy();
    expect(await store.enqueueDraft()).toBeNull(); // empty prompt
    expect(m.comfyEnqueue).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ title: "Can't queue that yet", body: "Write a prompt", tone: "warn" }));
  });
  it("refuses while the status is unavailable", async () => {
    m.comfyStatus.mockRejectedValue(new Error("down"));
    await store.refreshComfy();
    store.setDraft({ prompt: "a cat" });
    expect(await store.enqueueDraft()).toBeNull();
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ body: "ComfyUI status unavailable" }));
  });
  it("enqueues the draft for the open project and adds the job", async () => {
    await store.refreshComfy();
    store.setDraft({ prompt: "a neon studio", aspect: "9:16", seed: 5 });
    const job = await store.enqueueDraft();
    expect(m.comfyEnqueue).toHaveBeenCalledWith({ slug: "demo", template: "scene-still", params: { prompt: "a neon studio", seed: 5, steps: 1, aspect: "9:16" } });
    expect(job?.id).toBe("g-new");
    expect(st().jobs.map((j) => j.id)).toEqual(["g-new"]);
    expect(st().busy.enqueue).toBe(false);
  });
  it("resolves the input asset to its path", async () => {
    await store.refreshComfy();
    store.setDraft({ template: "style-transfer", prompt: "oil paint", inputAssetId: "a-img" });
    await store.enqueueDraft();
    expect(m.comfyEnqueue).toHaveBeenCalledWith({ slug: "demo", template: "style-transfer", params: { prompt: "oil paint", steps: 1, inputImage: IMG.path, denoise: 0.5 } });
  });
  it("a Rust refusal is a toast, not a throw", async () => {
    await store.refreshComfy();
    m.comfyEnqueue.mockRejectedValue(new Error("unknown template"));
    store.setDraft({ prompt: "x" });
    expect(await store.enqueueDraft()).toBeNull();
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ title: "ComfyUI refused that", body: "unknown template", tone: "error" }));
  });
});

describe("re-roll and tweak", () => {
  it("re-roll: the same params without a seed, toast with the asset's name", async () => {
    const job = await store.reroll(GEN);
    expect(m.comfyEnqueue).toHaveBeenCalledWith({ slug: "demo", template: "scene-still", params: { prompt: "a neon dance studio at night, wide shot", negative: "blurry", steps: 4, width: 1024, height: 576 } });
    expect(job?.id).toBe("g-new");
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ title: "Queued: re-roll of still_03.png" }));
  });
  it("re-roll uses the queued job's params when it is still there", async () => {
    store.useComfy.setState({ jobs: [comfyJob({ id: "g-gone", template: "style-transfer", params: { prompt: "oil", seed: 3, steps: 2, inputImage: IMG.path, denoise: 0.6 } })] });
    await store.reroll(STYLED);
    expect(m.comfyEnqueue).toHaveBeenCalledWith({ slug: "demo", template: "style-transfer", params: { prompt: "oil", steps: 2, inputImage: IMG.path, denoise: 0.6 } });
  });
  it("re-roll of img2img with the job pruned: refused with a toast", async () => {
    expect(await store.reroll(STYLED)).toBeNull();
    expect(m.comfyEnqueue).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ title: "Can't re-roll this one" }));
  });
  it("tweak: prefills the draft and opens the panel; nothing is queued", () => {
    store.tweak(GEN);
    expect(st().generateOpen).toBe(true);
    expect(st().draft).toMatchObject({ template: "scene-still", prompt: "a neon dance studio at night, wide shot", seed: 424242, aspect: "16:9", fromAssetId: "a-gen" });
    expect(m.comfyEnqueue).not.toHaveBeenCalled();
  });
});

describe("cancel, run now, policy", () => {
  it("cancel upserts the job", async () => {
    store.useComfy.setState({ jobs: [comfyJob()] });
    m.comfyCancel.mockResolvedValue(comfyJob({ status: "cancelled" }));
    expect(await store.cancelJob("g-1")).toBe(true);
    expect(m.comfyCancel).toHaveBeenCalledWith({ id: "g-1" });
    expect(st().jobs[0].status).toBe("cancelled");
    expect(st().busy.cancel).toBeNull();
  });
  it("run now toasts Rust's reason when it waits", async () => {
    m.comfyRunNow.mockResolvedValue({ accepted: false, now: "mid-conversation (Tony spoke 3 s ago)" });
    expect(await store.runNow()).toBe(false);
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ title: "Not yet", body: "mid-conversation (Tony spoke 3 s ago)" }));
  });
  it("run now accepted but still waiting says so (Rust always accepts)", async () => {
    m.comfyRunNow.mockResolvedValue({ accepted: true, now: "mid-conversation (Tony spoke 3 s ago)" });
    expect(await store.runNow()).toBe(false);
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ title: "Run now is set", body: "Waiting: mid-conversation (Tony spoke 3 s ago)" }));
    m.comfyRunNow.mockResolvedValue({ accepted: true, now: "starting" });
    expect(await store.runNow()).toBe(true);
    expect(push).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Starting the ComfyUI batch" }));
  });
  it("applies the queue snapshot without waiting for comfy_status", async () => {
    let release!: () => void;
    m.comfyStatus.mockImplementation(() => new Promise((r) => (release = () => r(comfyStatus()))));
    m.comfyQueue.mockResolvedValue({ version: 1, settings: { modelRoots: [], policy: "idle" }, jobs: [comfyJob({ id: "q-1" })] });
    const refresh = store.refreshComfy();
    await vi.waitFor(() => expect(st().jobs.map((j) => j.id)).toEqual(["q-1"]));
    release();
    await refresh;
  });
  it("a second enqueue while one is in flight queues nothing", async () => {
    let done!: () => void;
    m.comfyEnqueue.mockImplementation(({ slug, template, params }) => new Promise((r) => (done = () => r(comfyJob({ id: "g-1x", slug, template, params: { ...params } })))));
    const first = store.enqueue("demo", "scene-still", { prompt: "x" });
    expect(await store.enqueue("demo", "scene-still", { prompt: "x" })).toBeNull();
    done();
    expect((await first)?.id).toBe("g-1x");
    expect(m.comfyEnqueue).toHaveBeenCalledTimes(1);
  });
  it("a shot slot's Generate… starts a fresh draft, not the last Tweak", () => {
    store.setDraft({ template: "upscale", seed: 42, inputAssetId: "a-img", fromAssetId: "a-gen", prompt: "old" });
    store.generateFromPrompt("wide shot of the bay");
    expect(st().draft).toEqual({ ...store.defaultDraft(), prompt: "wide shot of the bay" });
    expect(st().generateOpen).toBe(true);
  });
  it("drops a queue snapshot when a job changed while it was in flight", async () => {
    let late!: (v: { version: number; settings: { modelRoots: string[]; policy: "idle" }; jobs: never[] }) => void;
    m.comfyQueue.mockImplementation(() => new Promise((r) => (late = r)));
    const refresh = store.refreshComfy();
    store.onQueueEvent(comfyJob({ id: "new" }));
    late({ version: 2, settings: { modelRoots: [], policy: "idle" }, jobs: [] });
    await refresh;
    expect(st().jobs.map((j) => j.id)).toEqual(["new"]);
  });
  it("policy updates the status's settings", async () => {
    await store.refreshComfy();
    m.comfySettingsSet.mockResolvedValue({ modelRoots: [], policy: "manual" });
    expect(await store.setPolicy("manual")).toBe(true);
    expect(m.comfySettingsSet).toHaveBeenCalledWith({ patch: { policy: "manual" } });
    expect(st().status?.settings.policy).toBe("manual");
  });
});

describe("events", () => {
  it("comfy-queue upserts; a done job of the open project refreshes the bin once", async () => {
    vi.useFakeTimers();
    store.onQueueEvent(comfyJob({ status: "running" }));
    store.onQueueEvent(comfyJob({ status: "done" }));
    store.onQueueEvent(comfyJob({ status: "done" }));
    store.onQueueEvent(comfyJob({ id: "g-x", slug: "else", status: "done" }));
    expect(st().jobs.map((j) => [j.id, j.status])).toEqual([
      ["g-x", "done"],
      ["g-1", "done"],
    ]);
    await vi.advanceTimersByTimeAsync(store.COMFY_STATUS_DEBOUNCE_MS + 10);
    expect(m.projectGet).toHaveBeenCalledTimes(1);
  });
  it("comfy-asset for the open project refreshes the bin, debounced", async () => {
    vi.useFakeTimers();
    store.onAssetEvent({ slug: "demo", assetId: "a-1" });
    store.onAssetEvent({ slug: "demo", assetId: "a-2" });
    store.onAssetEvent({ slug: "else", assetId: "a-3" });
    await vi.advanceTimersByTimeAsync(store.COMFY_STATUS_DEBOUNCE_MS + 10);
    expect(m.projectGet).toHaveBeenCalledTimes(1);
  });
  it("comfy-service idle with a batch toasts the result", () => {
    store.onServiceEvent({ phase: "idle", batch: { done: 2, failed: 1, requeued: 0, error: null, restoreOk: true } });
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ title: "2 stills ready · 1 failed", tone: "warn" }));
    push.mockClear();
    store.onServiceEvent({ phase: "starting ComfyUI" });
    expect(push).not.toHaveBeenCalled();
  });
});
