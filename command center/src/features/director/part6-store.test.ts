import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaProject, RenderPlan, StyleProfile, TimelineManifest } from "./contract";
import { manifest, project } from "./fixtures.test-util";

const push = vi.fn();
vi.mock("@/features/reminders/notify", () => ({ useToasts: { getState: () => ({ push }) } }));
vi.mock("./api", () => ({
  api: {
    projectCreate: vi.fn(),
    projectGet: vi.fn(),
    projects: vi.fn(),
    chatLog: vi.fn(),
    manifestSave: vi.fn(),
    renderPlan: vi.fn(),
    renderExecute: vi.fn(),
    projectUpdate: vi.fn(),
    noteResolve: vi.fn(),
    reviewGet: vi.fn(),
    approveFinal: vi.fn(),
    deliverablesGet: vi.fn(),
    styleGet: vi.fn(),
    styleRecord: vi.fn(),
  },
  onDirectorEvent: vi.fn(async () => () => undefined),
}));
const sendDirectorTurn = vi.fn(async (_text: string) => true);
vi.mock("./director-chat", () => ({ sendDirectorTurn }));

const { api } = await import("./api");
const store = await import("./director-store");
const { startFromPreset, planVersions } = await import("./launcher");
const { presetById } = await import("./presets");
const style = await import("./style");
const m = vi.mocked(api);
const st = () => store.useDirector.getState();

const PLAN: RenderPlan = { planId: "p-1", project: "spring", manifestRevision: 2, sources: [], audio: [], outputName: "spring", outputSpec: "1080×1920", renderMode: "cpu_only", proposedBy: "nic" };
const PROFILE: StyleProfile = { version: 1, entries: [{ at: "t", slug: "spring", kind: "final", revision: 2, platform: "reels", aspect: "9:16", lengthSec: 30, clips: 10, avgClipSec: 3, captions: "off", color: "none", fits: [], themes: ["pacing"] }] };

beforeEach(() => {
  vi.clearAllMocks();
  store.resetDirectorStore();
  style.resetStyleCache();
  const p = project({ slug: "spring", title: "Spring showcase" });
  m.projectCreate.mockResolvedValue(p);
  m.projectGet.mockResolvedValue({ project: p, assets: [], manifest: manifest({ project: "spring", revision: 1 }), renders: [] });
  m.projects.mockResolvedValue([p]);
  m.chatLog.mockResolvedValue([]);
  m.reviewGet.mockResolvedValue({ rounds: [], openDecisions: [] });
  m.deliverablesGet.mockResolvedValue([]);
  m.manifestSave.mockImplementation(async ({ manifest: x }) => ({ ...x, revision: x.revision + 1 }));
  m.projectUpdate.mockImplementation(async ({ slug, ...f }) => ({ ...project({ slug, title: "Spring showcase" }), ...f }) as MediaProject);
  m.renderPlan.mockResolvedValue(PLAN);
  m.styleRecord.mockResolvedValue(PROFILE);
  m.styleGet.mockResolvedValue(PROFILE);
});

describe("Start on a preset", () => {
  it("creates the project, saves outputs + the unapproved brief, then sends the first line (once)", async () => {
    expect(await startFromPreset("ig_reel", "Spring showcase")).toBe(true);
    expect(m.projectCreate).toHaveBeenCalledWith({ title: "Spring showcase" });
    const saves = m.manifestSave.mock.calls.map((c) => c[0].manifest as TimelineManifest);
    expect(saves.at(-1)?.outputs.map((o) => o.platform)).toEqual(["reels"]);
    expect(saves.at(-1)?.output.aspect).toBe("9:16");
    const brief = m.projectUpdate.mock.calls.at(-1)?.[0].brief;
    expect(brief).toMatchObject({ idea: "Spring showcase", platform: "reels", lengthSec: 30, approved: false, updatedBy: "nic", guessed: ["lengthSec", "tone"] });
    expect(sendDirectorTurn).toHaveBeenCalledTimes(1);
    expect(sendDirectorTurn).toHaveBeenCalledWith(presetById("ig_reel")!.firstLine);
    expect(m.renderPlan).not.toHaveBeenCalled();
    expect(m.renderExecute).not.toHaveBeenCalled();
  });

  it("no title or an unknown preset does nothing", async () => {
    expect(await startFromPreset("ig_reel", "  ")).toBe(false);
    expect(await startFromPreset("nope" as never, "x")).toBe(false);
    expect(m.projectCreate).not.toHaveBeenCalled();
    expect(sendDirectorTurn).not.toHaveBeenCalled();
  });

  it("a refused outputs save stops before the brief and the Director line", async () => {
    m.manifestSave.mockRejectedValue(new Error("outputs: too many"));
    expect(await startFromPreset("ig_reel", "Spring showcase")).toBe(false);
    expect(m.projectUpdate).not.toHaveBeenCalled();
    expect(sendDirectorTurn).not.toHaveBeenCalled();
  });

  it("a refused brief stops before the Director line", async () => {
    m.projectUpdate.mockRejectedValueOnce(new Error("brief: unknown platform"));
    expect(await startFromPreset("tiktok", "Clip")).toBe(false);
    expect(sendDirectorTurn).not.toHaveBeenCalled();
  });
});

describe("Plan versions", () => {
  it("adds the outputs, saves, raises a plan by Nic, and never executes", async () => {
    await store.openProject("spring");
    const plan = await planVersions(["tiktok", "self_tape"]);
    expect(plan).toEqual(PLAN);
    const saved = m.manifestSave.mock.calls.at(-1)?.[0].manifest as TimelineManifest;
    expect(saved.outputs.map((o) => o.platform)).toEqual(["tiktok", "self_tape"]); // the custom placeholder gave way
    expect(m.renderPlan).toHaveBeenCalledWith({ slug: "spring", proposedBy: "nic" });
    expect(m.renderExecute).not.toHaveBeenCalled();
    expect(st().plan).toEqual(PLAN);
  });

  it("too many formats: a toast, no save, no plan", async () => {
    await store.openProject("spring");
    store.editManifest((x) => ({ ...x, outputs: ["reels", "tiktok", "youtube"].map((p) => ({ platform: p as "reels", aspect: "9:16" as const, loudnessLufs: -14 as const, maxSizeMb: null, maxSec: null })) }));
    await store.flushSave();
    m.manifestSave.mockClear();
    expect(await planVersions(["self_tape", "shorts"])).toBeNull();
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ title: "No versions added" }));
    expect(m.manifestSave).not.toHaveBeenCalled();
    expect(m.renderPlan).not.toHaveBeenCalled();
  });
});

describe("style memory hooks", () => {
  it("Approve final and a note resolve record a sign-off; the STYLE line refreshes from the result", async () => {
    await store.openProject("spring");
    m.approveFinal.mockResolvedValue([]);
    m.noteResolve.mockResolvedValue(undefined);
    await store.approveFinal(["r-1"]);
    await store.resolveNote("n-1", { manual: true });
    await vi.waitFor(() => expect(m.styleRecord).toHaveBeenCalledTimes(2));
    expect(m.styleRecord.mock.calls.map((c) => c[0])).toEqual([
      { slug: "spring", kind: "final" },
      { slug: "spring", kind: "notes" },
    ]);
    expect(await style.styleLineFor()).toMatch(/^STYLE \(1 past sign-off; the brief wins\): reels · ~30s · clips avg 3s · captions off · notes often on pacing$/);
    expect(m.styleGet).not.toHaveBeenCalled(); // the record's result was cached
  });

  it("a refused resolve records nothing, and a failing profile read is just no line", async () => {
    await store.openProject("spring");
    m.noteResolve.mockRejectedValueOnce(new Error("UNCHANGED"));
    await store.resolveNote("n-1");
    expect(m.styleRecord).not.toHaveBeenCalled();
    m.styleGet.mockRejectedValueOnce(new Error("bridge down"));
    expect(await style.styleLineFor()).toBe("");
    m.styleRecord.mockRejectedValueOnce(new Error("disk full"));
    await expect(style.recordStyle("spring", "final")).resolves.toBeUndefined();
  });
});

describe("style cache order", () => {
  it("an older profile read that lands after a record does not overwrite the newer line", async () => {
    const OLD: StyleProfile = { version: 1, entries: [] };
    let release!: (p: StyleProfile) => void;
    m.styleGet.mockImplementationOnce(() => new Promise<StyleProfile>((r) => (release = r)));
    const read = style.styleLineFor();
    await style.recordStyle("spring", "final");
    release(OLD);
    expect(await read).toMatch(/^STYLE \(1 past sign-off/);
    expect(await style.styleLineFor()).toMatch(/^STYLE \(1 past sign-off/);
  });

  it("two records that return in reverse order keep the newest", async () => {
    const TWO: StyleProfile = { version: 1, entries: [PROFILE.entries[0], { ...PROFILE.entries[0], kind: "notes" }] };
    const rs: ((p: StyleProfile) => void)[] = [];
    m.styleRecord.mockImplementation(() => new Promise<StyleProfile>((r) => rs.push(r)));
    const a = style.recordStyle("spring", "notes");
    const b = style.recordStyle("spring", "notes");
    rs[1](TWO);
    await b;
    rs[0](PROFILE);
    await a;
    expect(await style.styleLineFor()).toMatch(/^STYLE \(2 past sign-offs/);
  });
});

describe("chat draft", () => {
  it("opening another project or closing clears a waiting B-roll line", async () => {
    const { suggestChatLine, useChatDraft } = await import("./gaps");
    await store.openProject("spring");
    suggestChatLine("Slot s3 has no footage.");
    store.closeProject();
    expect(useChatDraft.getState().draft).toBeNull();
    suggestChatLine("Slot s3 has no footage.");
    await store.openProject("other");
    expect(useChatDraft.getState().draft).toBeNull();
  });
});
