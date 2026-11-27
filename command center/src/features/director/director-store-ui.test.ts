import { beforeEach, describe, expect, it, vi } from "vitest";
import { ASSETS, V1, manifest, project } from "./fixtures.test-util";

const push = vi.fn();
vi.mock("@/features/reminders/notify", () => ({ useToasts: { getState: () => ({ push }) } }));
vi.mock("./api", () => ({
  api: { projectGet: vi.fn(), chatLog: vi.fn(), reviewGet: vi.fn(), assetUpdate: vi.fn() },
  onDirectorEvent: vi.fn(async () => () => undefined),
}));
vi.mock("./director-chat", () => ({ sendDirectorTurn: vi.fn() }));

const { api } = await import("./api");
const store = await import("./director-store");
const m = vi.mocked(api);
const st = () => store.useDirector.getState();

beforeEach(async () => {
  vi.clearAllMocks();
  m.chatLog.mockResolvedValue([]);
  m.reviewGet.mockResolvedValue({ rounds: [], openDecisions: [] });
  m.projectGet.mockResolvedValue({ project: project(), assets: ASSETS, manifest: manifest(), renders: [] });
  store.resetDirectorStore();
  await store.openProject("demo");
});

describe("tags", () => {
  it("cleanTags matches Rust's clean_tags (trim, lowercase, ≤ 32 chars, no duplicates, ≤ 12)", () => {
    expect(store.cleanTags([" Rain ", "rain", "", "NIGHT", "x".repeat(40)])).toEqual(["rain", "night", "x".repeat(32)]);
    expect(store.cleanTags(Array.from({ length: 20 }, (_, i) => `t${i}`))).toHaveLength(12);
  });
  it("setAssetTags saves the cleaned list and replaces the asset with the stored one", async () => {
    m.assetUpdate.mockImplementation(async ({ assetId, tags }) => ({ ...ASSETS.find((a) => a.id === assetId)!, tags: tags ?? [] }));
    expect(await store.setAssetTags(V1.id, ["Rain", "rain", "Night"])).toBe(true);
    expect(m.assetUpdate).toHaveBeenCalledWith({ slug: "demo", assetId: V1.id, tags: ["rain", "night"] });
    expect(st().assets.find((a) => a.id === V1.id)?.tags).toEqual(["rain", "night"]);
  });
  it("a refused save keeps the local tags and says so", async () => {
    m.assetUpdate.mockRejectedValue(new Error("tag too long"));
    expect(await store.setAssetTags(V1.id, ["a"])).toBe(false);
    expect(st().assets.find((a) => a.id === V1.id)?.tags).toEqual([]);
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ title: "Couldn't save the tags", tone: "error" }));
  });
});

describe("preview seek", () => {
  it("seekTo selects the source and bumps the request", () => {
    store.seekTo({ kind: "render", id: "r-1" }, 4.2);
    expect(st().selection).toEqual({ kind: "render", id: "r-1" });
    expect(st().previewMode).toBe("final");
    expect(st().seek).toEqual({ sec: 4.2, n: 1 });
    store.seekTo({ kind: "asset", id: V1.id }, -3);
    expect(st().previewMode).toBe("working");
    expect(st().seek).toEqual({ sec: 0, n: 2 });
  });
  it("preview time is clamped and reset when a project opens", async () => {
    store.setPreviewTime(Number.NaN);
    expect(st().previewTime).toBe(0);
    store.setPreviewTime(7.5);
    expect(st().previewTime).toBe(7.5);
    await store.openProject("demo");
    expect(st().previewTime).toBe(0);
    expect(st().seek).toBeNull();
  });
});
