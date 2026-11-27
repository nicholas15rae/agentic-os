import { beforeEach, describe, expect, it, vi } from "vitest";
import { manifest, project } from "./fixtures.test-util";

const go = vi.fn();
vi.mock("@/stores/nav", () => ({ useNav: { getState: () => ({ go }) } }));
const push = vi.fn();
vi.mock("@/features/reminders/notify", () => ({ useToasts: { getState: () => ({ push }) } }));
vi.mock("./api", () => ({
  api: {
    projectCreate: vi.fn(),
    projectGet: vi.fn(),
    chatLog: vi.fn(),
    ingestPaths: vi.fn(),
    projects: vi.fn(),
  },
}));

const { api } = await import("./api");
const { brainstormHandoff, playCardHandoff, sendToDirector } = await import("./handoff");
const { resetDirectorStore, useDirector } = await import("./director-store");
const m = vi.mocked(api);

beforeEach(() => {
  vi.clearAllMocks();
  resetDirectorStore();
  const p = project({ slug: "launch-teaser", title: "Launch teaser", source: { from: "brainstorm", refId: "n1", brief: "b" } });
  m.projectCreate.mockResolvedValue(p);
  m.projectGet.mockResolvedValue({ project: p, assets: [], manifest: manifest({ project: p.slug }), renders: [] });
  m.chatLog.mockResolvedValue([]);
  m.projects.mockResolvedValue([p]);
  m.ingestPaths.mockResolvedValue([]);
});

describe("sendToDirector", () => {
  it("creates the project with its source, opens it in the store and switches the nav", async () => {
    const p = await sendToDirector({ from: "brainstorm", refId: "n1", title: "  Launch teaser ", brief: "Make a 30s teaser", assetPaths: [] });
    expect(p?.slug).toBe("launch-teaser");
    expect(m.projectCreate).toHaveBeenCalledWith({ title: "Launch teaser", source: { from: "brainstorm", refId: "n1", brief: "Make a 30s teaser" } });
    expect(useDirector.getState().slug).toBe("launch-teaser");
    expect(useDirector.getState().manifest?.project).toBe("launch-teaser");
    expect(m.ingestPaths).not.toHaveBeenCalled();
    expect(go).toHaveBeenCalledWith("director");
  });

  it("ingests handed-off asset paths as clips", async () => {
    await sendToDirector({ from: "playplace", refId: "c1", title: "X", brief: "", assetPaths: ["C:\\clips\\a.mp4"] });
    expect(m.projectCreate).toHaveBeenCalledWith({ title: "X", source: { from: "playplace", refId: "c1", brief: null } });
    expect(m.ingestPaths).toHaveBeenCalledWith({ slug: "launch-teaser", paths: ["C:\\clips\\a.mp4"], role: "clip" });
  });

  it("a failed create toasts and never navigates", async () => {
    m.projectCreate.mockRejectedValue(new Error("media.db locked"));
    expect(await sendToDirector({ from: "brainstorm", refId: "n1", title: "X", brief: "", assetPaths: [] })).toBeNull();
    expect(go).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ tone: "error", body: "media.db locked" }));
  });
});

describe("handoff builders", () => {
  it("brainstorm: title from the first note, refId = first id, brief from every note", () => {
    const notes = [
      { id: "n1", title: "Teaser idea", rawText: "a fast cut of the launch", segments: [], organized: { summary: "30s teaser" }, _created: 1 },
      { id: "n2", title: "Music", rawText: "lofi", segments: [], _created: 2 },
    ] as unknown as Parameters<typeof brainstormHandoff>[0];
    const h = brainstormHandoff(notes);
    expect(h).toMatchObject({ from: "brainstorm", refId: "n1", title: "Teaser idea", assetPaths: [] });
    expect(h.brief).toContain("Summary: 30s teaser");
    expect(h.brief).toContain("a fast cut of the launch");
    expect(h.brief).toContain("## Music\nlofi");
  });
  it("play place: title + brief + notes", () => {
    const h = playCardHandoff({ id: "c9", title: "Promo", brief: "A promo reel", idea: "Use the drone shots" } as Parameters<typeof playCardHandoff>[0]);
    expect(h).toEqual({ from: "playplace", refId: "c9", title: "Promo", brief: "A promo reel\n\nNotes: Use the drone shots", assetPaths: [] });
  });
});
