import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@/lib/platform";
import type { SrProject } from "./contract";
import { asset, project } from "./fixtures.test-util";

const push = vi.fn();
vi.mock("@/features/reminders/notify", () => ({ useToasts: { getState: () => ({ push }) } }));
vi.mock("./api", () => ({
  api: {
    sceneReaderStatus: vi.fn(),
    sceneReaderList: vi.fn(),
    sceneReaderImport: vi.fn(),
    sidesList: vi.fn(),
    sidesSave: vi.fn(),
    slateCard: vi.fn(),
    projects: vi.fn(async () => []),
    projectGet: vi.fn(),
    chatLog: vi.fn(async () => []),
    reviewGet: vi.fn(async () => ({ rounds: [], openDecisions: [] })),
    deliverablesGet: vi.fn(async () => []),
  },
  onDirectorEvent: vi.fn(async () => () => undefined),
  fileSrc: () => "",
}));

const { api } = await import("./api");
const store = await import("./audition-store");
const dir = await import("./director-store");
const { SceneReaderCardView } = await import("./SceneReaderCard");
const { AuditionCardView } = await import("./AuditionCard");
const { reportFromEvent, isReportEvent } = await import("@/features/voice/agent-reports");
const m = vi.mocked(api);
const st = () => store.useAudition.getState();

const SR: SrProject = {
  id: "vo-1",
  title: "Coffee spot",
  updatedAt: 20,
  copyChars: 18,
  takes: [
    { id: "t1", name: "Take 1", file: "tk-1.webm", durSec: 12.5, best: false, createdAt: 1, available: true },
    { id: "t2", name: "Take 2", file: "tk-2.wav", durSec: 11, best: true, createdAt: 2, available: true },
    { id: "t3", name: "Take 3", file: "tk-3.wav", durSec: 9, best: false, createdAt: 3, available: false },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  store.resetAuditionStore();
  dir.resetDirectorStore();
});

describe("Scene Reader detection", () => {
  it("a refused or failed probe reads as down and hides the entry", async () => {
    m.sceneReaderStatus.mockRejectedValue(new Error("native command refused"));
    const s = await store.probeSceneReader();
    expect(s.up).toBe(false);
    expect(store.sceneReaderVisible(st())).toBe(false);
  });
  it("an answering probe shows the entry", async () => {
    m.sceneReaderStatus.mockResolvedValue({ up: true, url: "http://127.0.0.1:5123", projectsRoot: "C:\\x" });
    await store.probeSceneReader();
    expect(store.sceneReaderVisible(st())).toBe(true);
  });
  it("going down drops the listed takes", async () => {
    store.useAudition.setState({ status: { up: true, url: "", projectsRoot: null }, projects: [SR], openId: "vo-1" });
    m.sceneReaderStatus.mockResolvedValue({ up: false, url: "", projectsRoot: null });
    await store.probeSceneReader();
    expect(st().projects).toBeNull();
    expect(st().openId).toBeNull();
  });
});

describe("take picks and import", () => {
  it("defaults to the best take and never picks a missing file", () => {
    expect(store.picksFor(SR, {})).toEqual(["t2"]);
    expect(store.picksFor(SR, { "vo-1": ["t1", "t3"] })).toEqual(["t1"]);
    store.toggleTake(SR, SR.takes[0]);
    expect(store.picksFor(SR, st().picks)).toEqual(["t2", "t1"]);
    store.toggleTake(SR, SR.takes[2]);
    expect(store.picksFor(SR, st().picks)).toEqual(["t2", "t1"]);
    store.toggleTake(SR, SR.takes[1]);
    expect(store.picksFor(SR, st().picks)).toEqual(["t1"]);
  });
  it("lists on click and opens the newest project", async () => {
    m.sceneReaderList.mockResolvedValue([SR]);
    await store.listSceneReader();
    expect(st().projects).toEqual([SR]);
    expect(st().openId).toBe("vo-1");
  });
  it("imports the picks into a new project and opens it", async () => {
    const p = project({ slug: "coffee-spot-audition", title: "Coffee spot audition", source: { from: "scene_reader", refId: "vo-1", brief: "Wake up" } });
    m.sceneReaderImport.mockResolvedValue({ project: p, assets: [asset("a1", "audio", { role: "voiceover" })], skipped: [] });
    m.projectGet.mockResolvedValue({ project: p, assets: [], manifest: (await import("./fixtures.test-util")).manifest(), renders: [] });
    store.useAudition.setState({ projects: [SR], openId: "vo-1" });
    expect(await store.importSceneReader("vo-1")).toBe(true);
    expect(m.sceneReaderImport).toHaveBeenCalledWith({ project: "vo-1", takeIds: ["t2"] });
    expect(dir.useDirector.getState().slug).toBe("coffee-spot-audition");
    expect(st().importing).toBe(false);
  });
  it("refuses an import with nothing picked, without calling Rust", async () => {
    store.useAudition.setState({ projects: [{ ...SR, takes: SR.takes.map((t) => ({ ...t, best: false })) }] });
    expect(await store.importSceneReader("vo-1")).toBe(false);
    expect(m.sceneReaderImport).not.toHaveBeenCalled();
  });
  it("an import error leaves the page as it was", async () => {
    m.sceneReaderImport.mockRejectedValue(new Error("t3: outside Scene Reader's media folder"));
    store.useAudition.setState({ projects: [SR] });
    expect(await store.importSceneReader("vo-1")).toBe(false);
    expect(dir.useDirector.getState().slug).toBeNull();
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ tone: "error" }));
  });
});

describe("sides and slate", () => {
  it("keeps PDFs and text files and skips the rest", async () => {
    store.useAudition.setState({ sidesSlug: "demo", sides: [] });
    m.sidesSave.mockImplementation(async ({ name }) => ({ name, path: `C:\\p\\raw\\sides\\${name}`, sizeBytes: 3 }));
    const out = await store.addSides("demo", [new File(["abc"], "Sides.pdf"), new File(["x"], "clip.mp4"), new File(["hi"], "notes.TXT")]);
    expect(out.map((s) => s.name)).toEqual(["Sides.pdf", "notes.TXT"]);
    expect(m.sidesSave).toHaveBeenCalledTimes(2);
    expect(m.sidesSave.mock.calls[0][0].bytes).toBeInstanceOf(Uint8Array);
    expect(st().sides.map((s) => s.name)).toEqual(["notes.TXT", "Sides.pdf"]);
  });
  it("a slate goes to the bin and needs a name", async () => {
    dir.useDirector.setState({ slug: "demo", assets: [] });
    expect(await store.makeSlate("demo", { name: "  ", role: "", contact: "" })).toBeNull();
    m.slateCard.mockResolvedValue(asset("sl", "image", { role: "slate" }));
    await store.makeSlate("demo", { name: "Nic Rae", role: " Barista ", contact: "" });
    expect(m.slateCard).toHaveBeenCalledWith({ slug: "demo", name: "Nic Rae", role: "Barista", contact: undefined });
    expect(dir.useDirector.getState().assets.map((a) => a.id)).toContain("sl");
  });
});

describe("views", () => {
  const noop = () => undefined;
  const card = (p: Partial<Parameters<typeof SceneReaderCardView>[0]> = {}) =>
    renderToStaticMarkup(createElement(SceneReaderCardView, { visible: true, projects: null, listing: false, listError: null, openId: null, picks: {}, importing: false, onList: noop, onOpen: noop, onToggle: noop, onImport: noop, ...p }));
  it("renders nothing while Scene Reader is down", () => {
    expect(card({ visible: false, projects: [SR], openId: "vo-1" })).toBe("");
  });
  it("shows the takes with the best one picked and a missing file disabled", () => {
    const h = card({ projects: [SR], openId: "vo-1" });
    expect(h).toContain("Scene Reader");
    expect(h).toContain("Import 1 take");
    expect(h).toContain("Best");
    expect(h).toContain("file missing");
    expect(h).not.toMatch(/\b(you|your|he|his)\b/i);
  });
  it("offers Show takes before listing", () => {
    expect(card()).toContain("Show takes");
  });
  it("the audition card lists sides and the slate form", () => {
    const h = renderToStaticMarkup(createElement(AuditionCardView, { sides: [{ name: "Sides.pdf", path: "C:\\s\\Sides.pdf", sizeBytes: 2048 }], sidesBusy: false, slateBusy: false, onDropFiles: noop, onSlate: noop }));
    expect(h).toContain("Sides.pdf");
    expect(h).toContain("Make slate");
    expect(h).toContain("−18 LUFS");
  });
});

describe("Director reports reach the inbox path", () => {
  // director_reports.rs publishes `agent_report` notes as "director"; the existing report player
  // speaks them after Tony and adds the inbox entry. De-duplication is in Rust (media.db kv).
  const ev = (seq: number, summary: string): AgentEvent =>
    ({ v: 1, seq, at: 1000 + seq, agentId: "director", eventType: "agent_report", severity: "milestone", shortSummary: summary, traceId: "media:demo", fromVoiceSummary: false }) as unknown as AgentEvent;
  it("a Director agent_report is a report addressed to Nic", () => {
    const e = ev(1, "demo round 2 is ready for review on the verified shelf.");
    expect(isReportEvent(e)).toBe(true);
    const r = reportFromEvent(e, []);
    expect(r?.agent).toBe("director");
    expect(r?.text).toBe("Nic, demo round 2 is ready for review on the verified shelf.");
    expect(r?.id).toBe("note:director:1:1001");
  });
});
