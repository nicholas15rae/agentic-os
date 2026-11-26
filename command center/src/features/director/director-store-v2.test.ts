import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreativeBrief, MediaProject, Note, ProjectReview, RenderPlan, TimelineManifest } from "./contract";
import { ASSETS, IMG, V1, V2, asset, manifest, project } from "./fixtures.test-util";

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
    projectUpdate: vi.fn(),
    assetUpdate: vi.fn(),
    noteAdd: vi.fn(),
    noteResolve: vi.fn(),
    reviewGet: vi.fn(),
    approveFinal: vi.fn(),
  },
  onDirectorEvent: vi.fn(async () => () => undefined),
}));
const sendDirectorTurn = vi.fn(async (_text: string) => undefined);
vi.mock("./director-chat", () => ({ sendDirectorTurn }));

const { api, onDirectorEvent } = await import("./api");
const store = await import("./director-store");
const { addSlot } = await import("./manifest");
const m = vi.mocked(api);
const st = () => store.useDirector.getState();

const PLAN: RenderPlan = { planId: "p-1", project: "demo", manifestRevision: 4, sources: [], audio: [], outputName: "demo", outputSpec: "1920×1080", renderMode: "cpu_only", proposedBy: "director" };
const saved = (x: TimelineManifest): TimelineManifest => ({ ...x, revision: x.revision + 1 });
const NO_REVIEW: ProjectReview = { rounds: [], openDecisions: [] };
const ROUND1: ProjectReview = { rounds: [{ round: 1, renderId: "r-1", notes: ["n-1"], status: "open", summary: "" }], openDecisions: [] };
const note = (id: string, p: Partial<Note> = {}): Note => ({ id, renderId: "r-1", atSec: 1, text: "tighter", by: "nic", viaVoice: false, resolved: false, at: "t", ...p });
const BRIEF = { idea: "Dance reel for the showcase", goal: "get booked", platform: "reels" as const, lengthSec: 30, aspect: "9:16" as const, tone: "warm", references: [], guessed: ["tone" as const] };
/** s1 video, s2 image, s3 video. */
const shotted = () => manifest({ shotList: addSlot(addSlot(addSlot(manifest(), { label: "Hook" }), { label: "Slate", kind: "image" }), { label: "Spin" }).shotList });

async function open(p: Partial<MediaProject> = {}, mf: TimelineManifest = shotted(), review: ProjectReview = NO_REVIEW) {
  m.projectGet.mockResolvedValue({ project: project(p), assets: ASSETS, manifest: mf, renders: [] });
  m.reviewGet.mockResolvedValue(review);
  store.resetDirectorStore();
  await store.openProject("demo");
}

beforeEach(async () => {
  vi.clearAllMocks();
  m.chatLog.mockResolvedValue([]);
  m.manifestSave.mockImplementation(async ({ manifest: x }) => saved(x));
  m.renderPlan.mockResolvedValue(PLAN);
  m.renderExecute.mockResolvedValue({ jobId: "j-1" });
  m.projectUpdate.mockImplementation(async ({ slug, ...f }) => ({ ...project({ slug }), ...st().project, ...f }) as MediaProject);
  m.assetUpdate.mockImplementation(async ({ assetId, slotId, moments }) => ({ ...ASSETS.find((a) => a.id === assetId)!, ...(slotId !== undefined ? { slotId } : {}), ...(moments ? { moments } : {}) }));
  m.noteResolve.mockResolvedValue(undefined);
  await open();
});
afterEach(() => vi.useRealTimers());

describe("open project v2", () => {
  it("loads the review and starts with empty suggestions; a missing review command is harmless", async () => {
    await open({}, shotted(), ROUND1);
    expect(st().review).toEqual(ROUND1);
    expect(st().matchSuggestions).toEqual([]);
    m.reviewGet.mockRejectedValueOnce(new Error("unknown command"));
    store.resetDirectorStore();
    await store.openProject("demo");
    expect(st().error).toBeNull();
    expect(st().review).toBeNull();
  });
});

describe("draft_brief", () => {
  it("is saved as an unapproved Director draft via media_project_update", async () => {
    const notes = await store.applyDirectorActions([{ type: "draft_brief", brief: BRIEF }]);
    expect(m.projectUpdate).toHaveBeenCalledWith({ slug: "demo", brief: expect.objectContaining({ ...BRIEF, approved: false, updatedBy: "director" }) });
    expect(st().project?.brief).toMatchObject({ approved: false, updatedBy: "director" });
    expect(notes[0]).toMatch(/Brief drafted for your approval \(1 guessed field\)/);
  });
  it("never rewrites an existing idea, and an approved brief is held back as a draft", async () => {
    const approved: CreativeBrief = { ...BRIEF, idea: "Nic's own words", guessed: [], approved: true, updatedBy: "nic", updatedAt: "t" };
    await open({ brief: { ...approved, approved: false } });
    await store.applyDirectorActions([{ type: "draft_brief", brief: { ...BRIEF, idea: "rewritten", guessed: ["idea"] } }]);
    expect(m.projectUpdate).toHaveBeenLastCalledWith({ slug: "demo", brief: expect.objectContaining({ idea: "Nic's own words", guessed: [] }) });

    await open({ brief: approved });
    m.projectUpdate.mockClear();
    const notes = await store.applyDirectorActions([{ type: "draft_brief", brief: BRIEF }]);
    expect(m.projectUpdate).not.toHaveBeenCalled();
    expect(st().briefDraft).toMatchObject({ idea: "Nic's own words", approved: false });
    expect(notes[0]).toMatch(/held/);
    expect(await store.acceptBriefDraft()).toBe(true);
    expect(st().briefDraft).toBeNull();
    store.useDirector.setState({ briefDraft: { ...approved, approved: false } });
    store.rejectBriefDraft();
    expect(st().briefDraft).toBeNull();
  });
});

describe("brief: Nic's edits and approval", () => {
  it("editBrief creates a brief from the handoff when there is none; edited fields stop being guessed", async () => {
    await open({ source: { from: "brainstorm", refId: "n1", brief: "30s teaser" } });
    await store.editBrief({ platform: "tiktok" });
    expect(m.projectUpdate).toHaveBeenCalledWith({ slug: "demo", brief: expect.objectContaining({ idea: "30s teaser", platform: "tiktok", guessed: ["lengthSec", "aspect"], approved: false, updatedBy: "nic" }) });
  });
  it("approveBrief sends approved:true by nic; nothing without a brief", async () => {
    expect(await store.approveBrief()).toBe(false);
    await open({ brief: { ...BRIEF, approved: false, updatedBy: "director", updatedAt: "t" } });
    await store.approveBrief();
    expect(m.projectUpdate).toHaveBeenCalledWith({ slug: "demo", brief: expect.objectContaining({ approved: true, updatedBy: "nic" }) });
  });
  it("a refused update toasts and leaves the project alone", async () => {
    m.projectUpdate.mockRejectedValueOnce(new Error("brief: length must be 5–600 s"));
    expect(await store.editBrief({ lengthSec: 1 })).toBe(false);
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ tone: "error" }));
    expect(st().project?.brief).toBeNull();
  });
});

describe("shot list edits", () => {
  it("add / edit / move / filmed / remove go through manifest ops and one debounced save", async () => {
    vi.useFakeTimers();
    store.addShot({ label: "Outro", framing: "wide" });
    store.editShot("s4", { action: "bow" });
    store.moveShot(3, 0);
    store.toggleShotFilmed("s4");
    store.removeShot("s2");
    expect(st().manifest?.shotList.map((s) => s.id)).toEqual(["s4", "s1", "s3"]);
    expect(st().manifest?.shotList[0]).toMatchObject({ label: "Outro", framing: "wide", action: "bow", filmed: true });
    await vi.advanceTimersByTimeAsync(store.SAVE_DEBOUNCE_MS);
    expect(m.manifestSave).toHaveBeenCalledTimes(1);
  });
});

describe("match_footage: suggestions until Nic accepts", () => {
  const match = { type: "match_footage" as const, matches: [{ assetId: "a-v1", slotId: "s1", reason: "best" }, { assetId: "a-v2", slotId: "s3", reason: "" }], moments: [{ assetId: "a-v1", inSec: 1, outSec: 3, label: "spin", score: 0.9 }] };

  it("only stores suggestions: no save, no asset update", async () => {
    const notes = await store.applyDirectorActions([match]);
    expect(st().matchSuggestions).toHaveLength(2);
    expect(st().momentSuggestions).toHaveLength(1);
    expect(m.manifestSave).not.toHaveBeenCalled();
    expect(m.assetUpdate).not.toHaveBeenCalled();
    expect(notes[0]).toBe("Suggested 2 matches and 1 moment: accept or reject each");
    // A newer suggestion for the same slot replaces the older one.
    await store.applyDirectorActions([{ type: "match_footage", matches: [{ assetId: "a-v2", slotId: "s1", reason: "" }], moments: [] }]);
    expect(st().matchSuggestions.map((x) => `${x.slotId}=${x.assetId}`)).toEqual(["s3=a-v2", "s1=a-v2"]);
  });

  it("acceptMatch attaches (manifest save) then mirrors slotId via media_asset_update", async () => {
    await store.applyDirectorActions([match]);
    const id = st().matchSuggestions[0].id;
    expect(await store.acceptMatch(id)).toBe(true);
    expect(m.manifestSave).toHaveBeenCalledWith(expect.objectContaining({ manifest: expect.objectContaining({ shotList: expect.arrayContaining([expect.objectContaining({ id: "s1", assetId: "a-v1", status: "attached" })]) }) }));
    expect(m.assetUpdate).toHaveBeenCalledWith({ slug: "demo", assetId: "a-v1", slotId: "s1" });
    expect(m.manifestSave.mock.invocationCallOrder[0]).toBeLessThan(m.assetUpdate.mock.invocationCallOrder[0]);
    expect(st().assets.find((a) => a.id === "a-v1")?.slotId).toBe("s1");
    expect(st().matchSuggestions.map((x) => x.slotId)).toEqual(["s3"]);
  });

  it("rejectMatch drops it; a stale match (kind changed) is refused without saving", async () => {
    await store.applyDirectorActions([match]);
    store.rejectMatch(st().matchSuggestions[0].id);
    expect(st().matchSuggestions.map((x) => x.slotId)).toEqual(["s3"]);
    store.editShot("s3", { kind: "image" });
    m.manifestSave.mockClear();
    expect(await store.acceptMatch(st().matchSuggestions[0].id)).toBe(false);
    expect(m.assetUpdate).not.toHaveBeenCalled();
    expect(st().matchSuggestions).toEqual([]);
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ title: "That match no longer fits" }));
  });

  it("acceptMoment appends a director moment; rejectMoment drops it", async () => {
    await store.applyDirectorActions([match, { type: "match_footage", matches: [], moments: [{ assetId: "a-v2", inSec: 0, outSec: 1, label: "x", score: 0.1 }] }]);
    const [first, second] = st().momentSuggestions;
    expect(await store.acceptMoment(first.id)).toBe(true);
    expect(m.assetUpdate).toHaveBeenCalledWith({ slug: "demo", assetId: "a-v1", moments: [expect.objectContaining({ inSec: 1, outSec: 3, label: "spin", score: 0.9, by: "director" })] });
    store.rejectMoment(second.id);
    expect(st().momentSuggestions).toEqual([]);
  });
});

describe("revise_edit respects the round cap", () => {
  const revise = (round: 1 | 2, resolves = ["n-1"]) => ({ type: "revise_edit" as const, round, resolves, plan: { clips: [{ assetId: "a-v1", inSec: 0, outSec: 2, fadeMs: 0, transitionIn: { kind: "cut" as const, ms: 0 }, punchIn: 1 }], audio: [], output: {}, note: "" }, summary: "trimmed" });

  it("reviseRefusal (pure): no render, round 2, wrong round, already revised", () => {
    expect(store.reviseRefusal(1, NO_REVIEW, null)).toMatch(/no verified render/);
    expect(store.reviseRefusal(1, ROUND1, null)).toBeNull();
    expect(store.reviseRefusal(2, ROUND1, null)).toMatch(/no round 3/);
    expect(store.reviseRefusal(1, { rounds: [...ROUND1.rounds.map((r) => ({ ...r, status: "revised" as const })), { round: 2, renderId: "r-2", notes: [], status: "open", summary: "" }], openDecisions: [] }, null)).toMatch(/no round 3/);
    expect(store.reviseRefusal(1, ROUND1, { round: 1, resolves: [], summary: "" })).toMatch(/one revision/);
  });

  it("round 1: applies the plan, raises the card, resolves the notes only on Nic's render approval", async () => {
    await open({}, shotted(), ROUND1);
    store.useDirector.setState((s) => ({ manifest: s.manifest && { ...s.manifest, notes: [note("n-1")] } }));
    const notes = await store.applyDirectorActions([revise(1)]);
    expect(notes[0]).toMatch(/Round 1 revision: 1 clip, answers 1 note/);
    expect(st().revision).toEqual({ round: 1, resolves: ["n-1"], summary: "trimmed" });
    expect(st().plan).toEqual(PLAN);
    expect(m.noteResolve).not.toHaveBeenCalled();
    expect(m.renderExecute).not.toHaveBeenCalled();
    // A second revision for the same round is refused.
    expect((await store.applyDirectorActions([revise(1)]))[0]).toMatch(/Revision not applied: round 1 already has its one revision/);
    await store.approvePlan();
    expect(m.renderExecute).toHaveBeenCalledWith({ slug: "demo", planId: "p-1", approved: true });
    expect(m.noteResolve).toHaveBeenCalledWith({ slug: "demo", noteId: "n-1" });
    expect(st().manifest?.notes[0].resolved).toBe(true);
    expect(st().revision).toBeNull();
  });

  it("after round 2 nothing is applied", async () => {
    await open({}, shotted(), { rounds: [{ ...ROUND1.rounds[0], status: "revised" }, { round: 2, renderId: "r-2", notes: [], status: "open", summary: "" }], openDecisions: [] });
    const notes = await store.applyDirectorActions([revise(2)]);
    expect(notes[0]).toMatch(/no round 3/);
    expect(m.manifestSave).not.toHaveBeenCalled();
    expect(m.renderPlan).not.toHaveBeenCalled();
  });

  it("discardRevision keeps the notes open", async () => {
    await open({}, shotted(), ROUND1);
    await store.applyDirectorActions([revise(1)]);
    store.discardRevision();
    await store.approvePlan();
    expect(m.noteResolve).not.toHaveBeenCalled();
  });
});

it("report_open_decisions is stored for display only", async () => {
  const notes = await store.applyDirectorActions([{ type: "report_open_decisions", items: ["logo or text end card?", "music drop at 0:12?"] }]);
  expect(st().openDecisions).toEqual(["logo or text end card?", "music drop at 0:12?"]);
  expect(notes).toEqual(["Open decisions: 2"]);
  expect(m.manifestSave).not.toHaveBeenCalled();
});

describe("notes + approve final", () => {
  it("addNote goes through media_note_add (by nic) and lands locally without a manifest save", async () => {
    m.noteAdd.mockResolvedValue(note("n-7", { text: "louder music", atSec: 4.2 }));
    m.reviewGet.mockResolvedValueOnce(ROUND1);
    const n = await store.addNote("  louder music ", { renderId: "r-1", atSec: 4.2 });
    expect(m.noteAdd).toHaveBeenCalledWith({ slug: "demo", note: { renderId: "r-1", atSec: 4.2, text: "louder music", by: "nic", viaVoice: false } });
    expect(n?.id).toBe("n-7");
    expect(st().manifest?.notes.map((x) => x.id)).toEqual(["n-7"]);
    expect(st().review).toEqual(ROUND1);
    expect(m.manifestSave).not.toHaveBeenCalled();
    expect(await store.addNote("   ")).toBeNull();
  });
  it("resolveNote marks it resolved locally after Rust does", async () => {
    store.useDirector.setState((s) => ({ manifest: s.manifest && { ...s.manifest, notes: [note("n-1")] } }));
    expect(await store.resolveNote("n-1")).toBe(true);
    expect(m.noteResolve).toHaveBeenCalledWith({ slug: "demo", noteId: "n-1" });
    expect(st().manifest?.notes[0].resolved).toBe(true);
  });
  it("approveFinal sends approved:true with the picked renders, stores deliverables and reloads the status", async () => {
    const d = [{ platform: "reels" as const, renderId: "r-2", path: "C:\\x\\renders\\final\\reels\\demo_v002.mp4", captionPath: null, thumbPath: null }];
    m.approveFinal.mockResolvedValue(d);
    m.projectGet.mockResolvedValueOnce({ project: project({ status: "done" }), assets: ASSETS, manifest: shotted(), renders: [] });
    expect(await store.approveFinal(["r-2"])).toEqual(d);
    expect(m.approveFinal).toHaveBeenCalledWith({ slug: "demo", renderIds: ["r-2"], approved: true });
    expect(st().deliverables).toEqual(d);
    expect(st().project?.status).toBe("done");
    expect(await store.approveFinal([])).toBeNull();
  });
});

describe("media-intake events", () => {
  const ev = (assetId: string, stage: "ingested" | "transcribed" | "failed" = "transcribed", slug = "demo") => ({ slug, assetId, stage, detail: "" });
  const NEW1 = asset("a-new1", "video");
  const NEW2 = asset("a-new2", "video");

  it("refreshes assets (debounced) and a batch of transcribed clips sends ONE match turn", async () => {
    vi.useFakeTimers();
    m.projectGet.mockResolvedValue({ project: project(), assets: [...ASSETS, NEW1, NEW2], manifest: shotted(), renders: [] });
    store.onIntakeEvent(ev("a-new1", "ingested"));
    store.onIntakeEvent(ev("a-new1"));
    await vi.advanceTimersByTimeAsync(1000);
    store.onIntakeEvent(ev("a-new2"));
    await vi.advanceTimersByTimeAsync(store.INTAKE_REFRESH_MS);
    expect(st().assets.map((a) => a.id)).toContain("a-new2");
    expect(sendDirectorTurn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(store.AUTO_MATCH_DEBOUNCE_MS);
    expect(sendDirectorTurn).toHaveBeenCalledTimes(1);
    const line = sendDirectorTurn.mock.calls[0][0] as string;
    expect(line).toMatch(/^\[auto\]/);
    expect(line).toContain("a-new1 (a-new1.mp4), a-new2 (a-new2.mp4)");
    expect(line).toContain("s1 Hook, s3 Spin");
    expect(line).not.toContain("s2 Slate"); // an image slot: video clips can't fill it
    // The same clips never trigger a second auto turn.
    store.onIntakeEvent(ev("a-new1"));
    await vi.advanceTimersByTimeAsync(store.AUTO_MATCH_DEBOUNCE_MS + 10);
    expect(sendDirectorTurn).toHaveBeenCalledTimes(1);
  });

  it("no turn when every film slot is filled, autoMatch is off, or it's another project", async () => {
    vi.useFakeTimers();
    const filled = shotted();
    filled.shotList = filled.shotList.map((s) => ({ ...s, assetId: s.kind === "image" ? IMG.id : V1.id, status: "attached" }));
    m.projectGet.mockResolvedValue({ project: project(), assets: [...ASSETS, NEW1], manifest: filled, renders: [] });
    await open({}, filled);
    store.onIntakeEvent(ev("a-new1"));
    await vi.advanceTimersByTimeAsync(store.AUTO_MATCH_DEBOUNCE_MS + 10);
    expect(sendDirectorTurn).not.toHaveBeenCalled();

    await open();
    store.setAutoMatch(false);
    store.onIntakeEvent(ev(V2.id));
    store.onIntakeEvent(ev(V2.id, "transcribed", "other"));
    await vi.advanceTimersByTimeAsync(store.AUTO_MATCH_DEBOUNCE_MS + 10);
    expect(sendDirectorTurn).not.toHaveBeenCalled();
  });

  it("waits while a chat turn is busy, then sends", async () => {
    vi.useFakeTimers();
    m.projectGet.mockResolvedValue({ project: project(), assets: [...ASSETS, NEW1], manifest: shotted(), renders: [] });
    store.useDirector.setState({ chatBusy: true });
    store.onIntakeEvent(ev("a-new1"));
    await vi.advanceTimersByTimeAsync(store.AUTO_MATCH_DEBOUNCE_MS + 10);
    expect(sendDirectorTurn).not.toHaveBeenCalled();
    store.useDirector.setState({ chatBusy: false });
    await vi.advanceTimersByTimeAsync(store.AUTO_MATCH_DEBOUNCE_MS + 10);
    expect(sendDirectorTurn).toHaveBeenCalledTimes(1);
  });

  it("a failed stage toasts; startDirectorEvents subscribes render, ingest and intake", async () => {
    store.onIntakeEvent({ slug: "demo", assetId: "a-x", stage: "failed", detail: "ffprobe failed" });
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ tone: "warn", body: "ffprobe failed" }));
    const off = await store.startDirectorEvents();
    expect(vi.mocked(onDirectorEvent).mock.calls.map((c) => c[0])).toEqual(["media-render", "media-ingest", "media-intake"]);
    off();
  });
});
