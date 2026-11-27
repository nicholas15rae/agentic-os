/**
 * The live-E2E fixes (2026-11-26 report): plan check + snapping, length / ≥ 1 s refusals, the
 * revision no-op refusal, the one automatic corrective turn, Nic's idea kept word for word, and
 * the per-clip "fit" field.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CreativeBrief, MediaProject, Note, ProjectReview, RenderPlan, TimelineClip, TimelineManifest } from "./contract";
import { ASSETS, asset, manifest, project } from "./fixtures.test-util";
import type { PlanCheckResult } from "./plan-check";

vi.mock("@/features/reminders/notify", () => ({ useToasts: { getState: () => ({ push: vi.fn() }) } }));
vi.mock("@/lib/platform", () => ({ onNativeEvent: vi.fn(async () => () => undefined) }));
vi.mock("./api", () => ({
  api: {
    projectGet: vi.fn(),
    chatLog: vi.fn(),
    manifestSave: vi.fn(),
    renderPlan: vi.fn(),
    renderExecute: vi.fn(),
    projectUpdate: vi.fn(),
    noteResolve: vi.fn(),
    reviewGet: vi.fn(),
    reviewWrite: vi.fn(),
    deliverablesGet: vi.fn(),
    turn: vi.fn(),
    planCheck: vi.fn(),
  },
  onDirectorEvent: vi.fn(async () => () => undefined),
}));

const { api } = await import("./api");
const store = await import("./director-store");
const chat = await import("./director-chat");
const pc = await import("./plan-check");
const { validateAction } = await import("./actions");
const { ACTION_CONTRACT, buildDirectorContext, crossfadeOverlap, lengthLine } = await import("./context");
const { RenderPlanView } = await import("./RenderPlanCard");
const { BriefView, draftBriefLine, DRAFT_BRIEF_PROMPT } = await import("./BriefCard");
const m = vi.mocked(api) as unknown as Record<string, ReturnType<typeof vi.fn>>;
const st = () => store.useDirector.getState();

const block = (o: unknown) => "```director-action\n" + JSON.stringify(o) + "\n```";
const clip = (p: Partial<TimelineClip> = {}): TimelineClip => ({ id: "c-1", assetId: "a-v1", inSec: 0, outSec: 5, fadeMs: 0, transitionIn: { kind: "cut", ms: 0 }, punchIn: 1, ...p });
const PLAN: RenderPlan = { planId: "p-1", project: "demo", manifestRevision: 4, sources: [], audio: [], outputName: "demo", outputSpec: "1920×1080", renderMode: "cpu_only", proposedBy: "director" };
const ROUND1: ProjectReview = { rounds: [{ round: 1, renderId: "r-1", notes: ["n-1"], status: "open", summary: "" }], openDecisions: [] };
const NOTE: Note = { id: "n-1", renderId: "r-1", atSec: 2, text: "Tighten the middle and end on a stronger beat.", by: "nic", viaVoice: false, resolved: false, at: "t" };
const passCheck = async ({ clips }: { clips: PlanCheckResult["clips"] }): Promise<PlanCheckResult> => ({ clips, totalSec: pc.clipsTotal(clips), targetSec: null, warnings: [], refusals: [] });
const reply = (text: string) => ({ answer: text, providerId: "local", latencyMs: 1, answeredBy: "director" as const });

async function open(p: Partial<MediaProject> = {}, mf: TimelineManifest = manifest({ clips: [clip()] }), review: ProjectReview = { rounds: [], openDecisions: [] }) {
  m.projectGet.mockResolvedValue({ project: project(p), assets: ASSETS, manifest: mf, renders: [] });
  m.reviewGet.mockResolvedValue(review);
  store.resetDirectorStore();
  await store.openProject("demo");
}

beforeEach(async () => {
  vi.clearAllMocks();
  m.chatLog.mockResolvedValue([]);
  m.manifestSave.mockImplementation(async ({ manifest: x }: { manifest: TimelineManifest }) => ({ ...x, revision: x.revision + 1 }));
  m.renderPlan.mockResolvedValue(PLAN);
  m.projectUpdate.mockImplementation(async ({ slug, ...f }: { slug: string }) => ({ ...project({ slug }), ...st().project, ...f }) as MediaProject);
  m.reviewWrite.mockImplementation(async () => st().review ?? ROUND1);
  m.planCheck.mockImplementation(passCheck);
  await open();
});

// ── pure helpers ──────────────────────────────────────────────────────────────

describe("plan-check helpers (pure)", () => {
  it("clipsTotal sums out − in", () => {
    expect(pc.clipsTotal([clip({ inSec: 1, outSec: 3.5 }), clip({ inSec: 0, outSec: 0.3 })])).toBe(2.8);
  });

  it("planChangesNothing ignores ids, key order, fit auto and the output name", () => {
    const cur = manifest({ clips: [clip()], output: { aspect: "16:9", loudnessLufs: -16, maxSizeMb: null, name: "demo" } });
    const same = { clips: [{ punchIn: 1, transitionIn: { ms: 0, kind: "cut" as const }, fadeMs: 0, outSec: 5, inSec: 0, assetId: "a-v1", fit: "auto" }], audio: [], output: { name: "renamed" }, note: "" };
    expect(pc.planChangesNothing(cur, same as never)).toBe(true);
    expect(pc.planChangesNothing(cur, { ...same, clips: [{ ...same.clips[0], outSec: 4 }] } as never)).toBe(false);
    expect(pc.planChangesNothing(cur, { ...same, clips: [{ ...same.clips[0], fit: "blur" }] } as never)).toBe(false);
    expect(pc.planChangesNothing(cur, { ...same, color: { preset: "warm" } } as never)).toBe(false);
    expect(pc.planChangesNothing(cur, { ...same, outputs: ["reels"] } as never)).toBe(false);
    expect(pc.planChangesNothing(cur, { ...same, output: { aspect: "9:16" } } as never)).toBe(false);
  });

  it("noopRevisionRefusal quotes Nic's notes", () => {
    const t = pc.noopRevisionRefusal({ notes: [NOTE] }, ["n-1"]);
    expect(t).toMatch(/^revise_edit refused: that revision changes nothing/);
    expect(t).toContain(`Nic's notes: n-1 "Tighten the middle and end on a stronger beat."`);
    expect(t).not.toMatch(/\b(he|she|his|her|him)\b/i);
  });

  it("ideaFromLine drops a 'draft the brief' ask and keeps the rest word for word", () => {
    const idea = "Cut my demo reel into a 15-second Instagram Reel that gets me noticed by casting directors: open on my strongest moment, punchy, captions on.";
    expect(pc.ideaFromLine(`${idea}\n\nDraft the brief.`)).toBe(idea);
    expect(pc.ideaFromLine(`${idea} Can you draft a brief for this?`)).toBe(idea);
    expect(pc.ideaFromLine(`${idea} Please write the creative brief`)).toBe(idea);
    expect(pc.ideaFromLine("Draft a brief: a moody 30s dance reel")).toBe("a moody 30s dance reel");
    expect(pc.ideaFromLine("draft the brief")).toBeNull();
    expect(pc.ideaFromLine("  ")).toBeNull();
    expect(pc.ideaFromLine("A reel about my brief career in tennis")).toBe("A reel about my brief career in tennis");
  });

  it("planCheck: absent command → null; a thrown IPC error applies unchecked with a warning", async () => {
    const clips = [clip()];
    const saved = m.planCheck;
    (api as unknown as Record<string, unknown>).planCheck = undefined;
    expect(await pc.planCheck("demo", clips)).toBeNull();
    (api as unknown as Record<string, unknown>).planCheck = saved;
    m.planCheck.mockRejectedValueOnce(new Error("media-forge isn't connected"));
    const r = await pc.planCheck("demo", clips);
    expect(r).toMatchObject({ clips, refusals: [], warnings: [expect.stringMatching(/didn't run \(media-forge isn't connected\)/)] });
  });
});

describe('per-clip "fit"', () => {
  const ctx = { assets: ASSETS };
  const plan = (fit?: unknown) => ({ type: "propose_edit_plan", clips: [{ assetId: "a-v1", inSec: 0, outSec: 2, ...(fit === undefined ? {} : { fit }) }], audio: [], output: {}, note: "" });
  it("accepts auto|pad|fill|blur, keeps non-auto, drops auto (Rust leaves auto unwritten too)", () => {
    for (const f of ["pad", "fill", "blur"]) expect(validateAction(plan(f), ctx)).toMatchObject({ ok: true, action: { clips: [{ fit: f }] } });
    const auto = validateAction(plan("auto"), ctx);
    expect(auto.ok && "clips" in auto.action && "fit" in auto.action.clips[0]).toBe(false);
    expect(validateAction(plan("stretch"), ctx)).toMatchObject({ ok: false, error: expect.stringMatching(/"fit" must be one of auto, pad, fill, blur/) });
  });
});

describe("context: length, ≥ 1 s, sentences, fit", () => {
  it("lengthLine shows the target and the current cut", () => {
    const b: CreativeBrief = { idea: "x", goal: "", platform: "reels", lengthSec: 15, aspect: "9:16", tone: "", references: [], guessed: ["lengthSec"], approved: false, updatedBy: "director", updatedAt: "t" };
    const mf = manifest({ clips: [clip({ inSec: 0, outSec: 9.3 }), clip({ inSec: 2, outSec: 2.3 })] });
    expect(lengthLine(project({ brief: b }), mf)).toBe("LENGTH: target 15s (guessed) · cut 9.6s · 1 clip under 1s");
    expect(lengthLine(project(), manifest())).toBe("LENGTH: target none (no brief) · cut 0s");
    expect(buildDirectorContext(project({ brief: b }), ASSETS, mf)).toContain("LENGTH: target 15s");
  });
  it("the contract asks for the length, ≥ 1 s clips, sentence cuts, fit and corrected [auto-fix] blocks", () => {
    expect(ACTION_CONTRACT).toMatch(/lengthSec ±10%/);
    expect(ACTION_CONTRACT).toMatch(/each ≥ 1 s/);
    expect(ACTION_CONTRACT).toMatch(/never mid-sentence/);
    expect(ACTION_CONTRACT).toMatch(/"fit": auto \(default: from black bars\), pad, fill \(crop\) or blur/);
    expect(ACTION_CONTRACT).toMatch(/\[auto-fix\]/);
    expect(ACTION_CONTRACT).toMatch(/that changes the cut/);
  });
  it("shows the speech span (AssetTranscript has no sentence times, so none are invented) and a non-auto fit in the clip tuple", () => {
    const a = asset("a-s", "video", { transcript: { path: "x", lang: "en", words: 30, firstSpeechSec: 0.5, lastSpeechSec: 9 } });
    const c = buildDirectorContext(project(), [a], manifest({ clips: [{ ...clip({ assetId: "a-s" }), fit: "blur" } as TimelineClip] }));
    expect(c).toContain("speech 30w 0.5–9s");
    expect(c).not.toContain("sentences ");
    expect(c).toContain('["a-s",0,5,0,"cut",1,"blur"]');
  });
});

// ── store: plan check, no-op revision, idea ──────────────────────────────────

describe("Director plans go through media_plan_check", () => {
  const PROPOSE = { type: "propose_edit_plan" as const, clips: [{ assetId: "a-v1", inSec: 0.4, outSec: 3.1, fadeMs: 0, transitionIn: { kind: "cut" as const, ms: 0 }, punchIn: 1 }], audio: [], output: {}, note: "" };

  it("applies the snapped clips and reports the warnings", async () => {
    m.planCheck.mockResolvedValueOnce({ clips: [{ ...PROPOSE.clips[0], id: "", inSec: 0.2, outSec: 3.4, fit: "fill" }], totalSec: 3.2, targetSec: 3, warnings: ["clip 1: in 0.4 → 0.2 s (start of the word)"], refusals: [] });
    const r = await store.applyDirectorActionsReport([PROPOSE]);
    expect(m.planCheck).toHaveBeenCalledWith({ slug: "demo", clips: PROPOSE.clips, plan: expect.objectContaining({ outputs: st().manifest?.outputs }) });
    expect(st().manifest?.clips).toEqual([expect.objectContaining({ assetId: "a-v1", inSec: 0.2, outSec: 3.4, fit: "fill" })]);
    expect(st().manifest?.clips[0].id).toMatch(/^c-/);
    expect(r.warnings).toEqual(["clip 1: in 0.4 → 0.2 s (start of the word)"]);
    expect(r.refusals).toEqual([]);
    expect(st().plan).toEqual(PLAN);
  });

  it("a refusal blocks the plan (nothing saved, no card) and is worded for the Director", async () => {
    const before = st().manifest;
    m.planCheck.mockResolvedValueOnce({ clips: PROPOSE.clips, totalSec: 9.6, targetSec: 15, warnings: [], refusals: ["the cut is 9.6 s but the brief asks for 15 s: add about 5.4 s (anything from 13.5 to 16.5 s is fine)", "clip 3 is 0.3 s; keep every clip ≥ 1 s"] });
    const r = await store.applyDirectorActionsReport([PROPOSE]);
    expect(st().manifest).toBe(before);
    expect(m.manifestSave).not.toHaveBeenCalled();
    expect(m.renderPlan).not.toHaveBeenCalled();
    expect(r.notes[0]).toMatch(/^Edit plan not applied: the cut is 9\.6 s/);
    expect(r.refusals).toEqual([expect.stringMatching(/^propose_edit_plan refused by the plan check: the cut is 9\.6 s/), "propose_edit_plan refused by the plan check: clip 3 is 0.3 s; keep every clip ≥ 1 s"]);
    expect(r.refusedTypes).toEqual(["propose_edit_plan"]);
  });
});

describe("a revision that changes nothing", () => {
  const revise = (outSec: number) => ({ type: "revise_edit" as const, round: 1 as const, resolves: ["n-1"], plan: { clips: [{ assetId: "a-v1", inSec: 0, outSec, fadeMs: 0, transitionIn: { kind: "cut" as const, ms: 0 }, punchIn: 1 }], audio: [], output: {}, note: "" }, summary: "" });

  beforeEach(async () => {
    await open({}, manifest({ clips: [clip()], notes: [NOTE] }), ROUND1);
  });

  it("is refused: no save, no card, no summary, no pending revision, the note stays open", async () => {
    const r = await store.applyDirectorActionsReport([revise(5)]);
    expect(r.notes).toEqual(["Revision not applied: it changes nothing, so your notes stay open"]);
    expect(r.refusals[0]).toMatch(/^revise_edit refused: that revision changes nothing .* Nic's notes: n-1 "Tighten the middle/);
    expect(r.refusedTypes).toEqual(["revise_edit"]);
    expect(m.manifestSave).not.toHaveBeenCalled();
    expect(m.renderPlan).not.toHaveBeenCalled();
    expect(m.reviewWrite).not.toHaveBeenCalled();
    expect(st().revision).toBeNull();
    await store.approvePlan();
    expect(m.noteResolve).not.toHaveBeenCalled();
    expect(st().manifest?.notes[0].resolved).toBe(false);
  });

  it("snapping that lands on the current cut is a no-op too; a real change still applies", async () => {
    m.planCheck.mockImplementationOnce(async ({ clips }: { clips: PlanCheckResult["clips"] }) => ({ clips: clips.map((c) => ({ ...c, outSec: 5 })), totalSec: 5, targetSec: null, warnings: ["clip 1: out 4.9 → 5 s"], refusals: [] }));
    expect((await store.applyDirectorActionsReport([revise(4.9)])).refusedTypes).toEqual(["revise_edit"]);
    const ok = await store.applyDirectorActionsReport([revise(4)]);
    expect(ok.refusals).toEqual([]);
    expect(st().revision).toEqual({ round: 1, resolves: ["n-1"], summary: "" });
  });

  it("a plan-check refusal on a revision blocks it the same way", async () => {
    m.planCheck.mockResolvedValueOnce({ clips: [], totalSec: 4, targetSec: 15, warnings: [], refusals: ["the cut is 4 s but the brief asks for 15 s"] });
    const r = await store.applyDirectorActionsReport([revise(4)]);
    expect(r.notes[0]).toMatch(/^Revision not applied: the cut is 4 s/);
    expect(st().revision).toBeNull();
  });
});

describe("a first brief keeps Nic's idea word for word", () => {
  const DRAFT = { type: "draft_brief" as const, brief: { idea: "Cut Nicholas_Rae_Demo_Reel.mp4 into a 15s Reel with fast cuts.", goal: "", platform: "reels" as const, lengthSec: 15, aspect: "9:16" as const, tone: "", references: [], guessed: ["idea" as const, "tone" as const] } };
  const IDEA = "Cut my demo reel into a 15-second Instagram Reel: open on my strongest moment, punchy, captions on.";

  it("from Nic's chat line (minus the 'draft the brief' ask)", async () => {
    await store.applyDirectorActions([DRAFT], "demo", { nicLine: `${IDEA}\n\nDraft the brief.` });
    expect(st().project?.brief).toMatchObject({ idea: IDEA, guessed: ["tone"], approved: false });
  });

  it("from the BriefCard idea box, which wins over the line and is cleared once the brief exists", async () => {
    store.setBriefIdea("  My own words for it.  ");
    await store.applyDirectorActions([DRAFT], "demo", { nicLine: "something else entirely" });
    expect(st().project?.brief?.idea).toBe("My own words for it.");
    expect(st().briefIdea).toBeNull();
  });

  it("falls back to the handoff text, then to the model's words (still marked guessed)", async () => {
    await open({ source: { from: "brainstorm", refId: "n1", brief: "A handoff idea from Brainstorm." } });
    await store.applyDirectorActions([DRAFT], "demo", { nicLine: "draft the brief" });
    expect(st().project?.brief?.idea).toBe("A handoff idea from Brainstorm.");
    await open();
    await store.applyDirectorActions([DRAFT], "demo", { nicLine: "draft the brief" });
    expect(st().project?.brief).toMatchObject({ idea: DRAFT.brief.idea, guessed: ["idea", "tone"] });
  });

  it("an existing brief's idea still wins", async () => {
    const b: CreativeBrief = { ...DRAFT.brief, idea: "Nic's first words", guessed: [], approved: false, updatedBy: "nic", updatedAt: "t" };
    await open({ brief: b });
    await store.applyDirectorActions([DRAFT], "demo", { nicLine: `${IDEA} Draft the brief.` });
    expect(st().project?.brief?.idea).toBe("Nic's first words");
  });
});

// ── chat: the one automatic corrective turn ──────────────────────────────────

describe("auto-fix (one corrective turn)", () => {
  const GOOD_PLAN = { type: "propose_edit_plan", clips: [{ assetId: "a-v2", inSec: 0, outSec: 2 }], audio: [], output: {}, note: "" };
  const BAD_PLAN = { ...GOOD_PLAN, clips: [{ assetId: "a-v2", inSec: 0, outSec: "2" }] };
  const SLOTS = { type: "populate_shot_list", slots: [{ id: "z1", label: "Other", instructions: "", kind: "video", targetSec: 3 }] };
  const MATCH = { type: "match_footage", matches: [], moments: [{ assetId: "a-v1", inSec: 0, outSec: 2, label: "x", score: 0.5 }] };
  const sent = () => m.turn.mock.calls.map((c) => (c[0] as { req: { text: string } }).req.text);

  it("pure helpers: turnProblems, fixAllowlist, autoFixPrompt", () => {
    const answer = `x\n${block(SLOTS)}\n${block(BAD_PLAN)}\n\`\`\`director-action\n{not json\n\`\`\``;
    const p = chat.turnProblems(answer, ['block 2: clip 1: "outSec" must be a number'], [], []);
    expect(p.types).toEqual(["propose_edit_plan"]);
    expect(p.blocks).toEqual([JSON.stringify(BAD_PLAN)]);
    expect(chat.turnProblems(answer, ["block 3: not valid JSON"], [], []).types).toBeNull();
    expect(chat.turnProblems(answer, [], ["propose_edit_plan refused by the plan check: x"], ["propose_edit_plan"])).toMatchObject({ types: ["propose_edit_plan"], blocks: [JSON.stringify(BAD_PLAN)] });
    expect(chat.fixAllowlist(["propose_edit_plan"], undefined)).toEqual(["propose_edit_plan"]);
    expect(chat.fixAllowlist(null, ["match_footage"])).toEqual(["match_footage"]);
    expect(chat.fixAllowlist(["propose_edit_plan"], ["match_footage"])).toBe(false);
    const prompt = chat.autoFixPrompt(p);
    expect(prompt.startsWith("[auto-fix] ")).toBe(true);
    expect(prompt).toContain('- block 2: clip 1: "outSec" must be a number');
    expect(prompt).toContain(JSON.stringify(BAD_PLAN));
    expect(prompt).toMatch(/Everything stays a suggestion until Nic clicks/);
    expect(prompt).not.toMatch(/\b(he|she|his|her|him)\b/i);
  });

  it("a reply with a broken block gets ONE [auto-fix] turn quoting the exact error; the fix applies", async () => {
    m.turn.mockResolvedValueOnce(reply(`Here's the cut.\n${block(BAD_PLAN)}`)).mockResolvedValueOnce(reply(`Fixed.\n${block(GOOD_PLAN)}`));
    expect(await chat.sendDirectorTurn("cut it")).toBe(true);
    expect(sent()).toHaveLength(2);
    expect(sent()[1]).toMatch(/^\[auto-fix\] The app couldn't use part of your last reply:\n- block 1: clip 1: "outSec" must be a number/);
    expect(st().manifest?.clips.map((c) => c.assetId)).toEqual(["a-v2"]);
    const fixLine = st().chat.find((x) => x.autoFix);
    expect(fixLine).toMatchObject({ role: "nic", text: expect.stringMatching(/^\[auto-fix\] Asked the Director to fix: block 1:/) });
    expect(m.chatLog).toHaveBeenCalledWith({ slug: "demo", append: { role: "nic", text: fixLine?.text } });
    const last = st().chat[st().chat.length - 1];
    expect(last.applied?.[0]).toMatch(/^Edit plan: 1 clip/);
    expect(last.undoId).toBe(st().undo?.id);
    expect(st().chatBusy).toBe(false);
  });

  it("never more than one retry, even when the fix is broken too", async () => {
    m.turn.mockResolvedValue(reply(`Again.\n${block(BAD_PLAN)}`));
    await chat.sendDirectorTurn("cut it");
    expect(sent()).toHaveLength(2);
    expect(st().autoFixed).toHaveLength(1);
  });

  it("a plan refused by media_plan_check feeds the retry with the refusal", async () => {
    m.planCheck.mockResolvedValueOnce({ clips: [], totalSec: 2, targetSec: 15, warnings: [], refusals: ["the cut is 2 s but the brief asks for 15 s: add about 13 s"] });
    m.turn.mockResolvedValueOnce(reply(block(GOOD_PLAN))).mockResolvedValueOnce(reply("ok"));
    await chat.sendDirectorTurn("cut it");
    expect(sent()[1]).toContain("- propose_edit_plan refused by the plan check: the cut is 2 s but the brief asks for 15 s: add about 13 s");
    expect(sent()[1]).toContain(JSON.stringify(GOOD_PLAN));
  });

  it("the fix may only apply the failed action types (no extra shot list sneaks in)", async () => {
    const before = st().manifest?.shotList;
    m.turn.mockResolvedValueOnce(reply(block(BAD_PLAN))).mockResolvedValueOnce(reply(`${block(GOOD_PLAN)}\n${block(SLOTS)}`));
    await chat.sendDirectorTurn("cut it");
    expect(st().manifest?.clips.map((c) => c.assetId)).toEqual(["a-v2"]);
    expect(st().manifest?.shotList).toEqual(before);
    expect(st().chat[st().chat.length - 1].errors?.join(" ")).toMatch(/populate_shot_list: not applied on an automatic turn/);
  });

  it("an automatic turn's fix still only suggests; a failure outside its allowlist gets no fix", async () => {
    const BAD_MATCH = { ...MATCH, moments: [{ ...MATCH.moments[0], inSec: "0" }] };
    m.turn.mockResolvedValueOnce(reply(block(BAD_MATCH))).mockResolvedValueOnce(reply(`${block(MATCH)}\n${block(GOOD_PLAN)}`));
    await chat.sendDirectorTurn("[auto] match", { only: store.AUTO_TURN_ACTIONS });
    expect(sent()).toHaveLength(2);
    expect(st().momentSuggestions).toHaveLength(1);
    expect(st().manifest?.clips.map((c) => c.assetId)).toEqual(["a-v1"]);
    expect(m.manifestSave).not.toHaveBeenCalled();

    m.turn.mockClear();
    m.turn.mockResolvedValueOnce(reply(block(BAD_PLAN)));
    await chat.sendDirectorTurn("[auto] match", { only: store.AUTO_TURN_ACTIONS });
    expect(sent()).toHaveLength(1);
  });

  it("a clean reply sends no fix; chat stays busy through the fix so no other turn slips in", async () => {
    m.turn.mockResolvedValueOnce(reply(`fine\n${block(GOOD_PLAN)}`));
    await chat.sendDirectorTurn("cut it");
    expect(sent()).toHaveLength(1);

    m.turn.mockClear();
    let during: boolean | null = null;
    m.turn.mockResolvedValueOnce(reply(block(BAD_PLAN))).mockImplementationOnce(async () => {
      during = await chat.sendDirectorTurn("me too");
      return reply("ok");
    });
    await chat.sendDirectorTurn("cut it");
    expect(during).toBe(false);
    expect(sent()).toHaveLength(2);
  });

  it("the store guard: a reply already fixed is never fixed again", async () => {
    m.turn.mockResolvedValueOnce(reply(block(BAD_PLAN)));
    const spy = vi.spyOn(globalThis.crypto, "randomUUID");
    spy.mockReturnValueOnce("00000000-0000-4000-8000-000000000001").mockReturnValueOnce("00000000-0000-4000-8000-000000000002");
    store.useDirector.setState({ autoFixed: ["r-00000000-0000-4000-8000-000000000002"] });
    await chat.sendDirectorTurn("cut it");
    spy.mockRestore();
    expect(sent()).toHaveLength(1);
  });

  it("plan-check warnings land on the reply bubble", async () => {
    m.planCheck.mockImplementationOnce(async (a: { clips: PlanCheckResult["clips"] }) => ({ ...(await passCheck(a)), warnings: ["clip 1: out 2 → 2.2 s (end of the word or sentence)"] }));
    m.turn.mockResolvedValueOnce(reply(block(GOOD_PLAN)));
    await chat.sendDirectorTurn("cut it");
    expect(st().chat[st().chat.length - 1].warnings).toEqual(["clip 1: out 2 → 2.2 s (end of the word or sentence)"]);
  });

  it("the turn Nic typed is the idea source for a first brief; the BriefCard idea is recorded", async () => {
    const DRAFT = { type: "draft_brief", brief: { idea: "paraphrase", platform: "reels", lengthSec: 15, aspect: "9:16", guessed: ["idea"] } };
    m.turn.mockResolvedValueOnce(reply(block(DRAFT)));
    await chat.sendDirectorTurn("A punchy 15s reel of my demo reel. Draft the brief.");
    expect(st().project?.brief?.idea).toBe("A punchy 15s reel of my demo reel.");

    await open();
    m.turn.mockResolvedValueOnce(reply(block(DRAFT)));
    await chat.sendDirectorTurn(draftBriefLine("My words, exactly."), { briefIdea: "My words, exactly.", nicLine: "My words, exactly." });
    expect(sent()[sent().length - 1]).toBe(`${DRAFT_BRIEF_PROMPT}\n\nMy idea, in my words: My words, exactly.`);
    expect(st().project?.brief?.idea).toBe("My words, exactly.");
  });
});

describe("BriefCard asks for the idea first", () => {
  const noop = () => undefined;
  const starter: CreativeBrief = { idea: "Demo", goal: "", platform: "custom", lengthSec: 30, aspect: "16:9", tone: "", references: [], guessed: [], approved: false, updatedBy: "nic", updatedAt: "t" };
  const base = { brief: null, draft: null, chatBusy: false, starter, onSave: async () => true, onApprove: noop, onAcceptDraft: noop, onRejectDraft: noop, onDraft: noop };
  it("shows the idea box prefilled with the handoff text", () => {
    const h = renderToStaticMarkup(createElement(BriefView, { ...base, initialAsking: true, ideaSeed: "A handoff idea" }));
    expect(h).toContain("Your idea, in your words");
    expect(h).toContain(">A handoff idea</textarea>");
    expect(h).toContain("Ask the Director");
    expect(h).not.toContain("â€");
  });
  it("draftBriefLine quotes the idea after the ask", () => {
    expect(draftBriefLine("  x y  ")).toBe(`${DRAFT_BRIEF_PROMPT}\n\nMy idea, in my words: x y`);
    expect(draftBriefLine("")).toBe(DRAFT_BRIEF_PROMPT);
  });
});

// ── the opt-in live E2E step runner mirrors the store ────────────────────────

describe("e2e step runner (effectsFor / planInputs)", () => {
  it("plan check + snapping, refusal, no-op revision and Nic's idea, as the store does them", async () => {
    const { effectsFor, planInputs } = await import("./e2e/director-live.e2e");
    const cur = manifest({ clips: [clip()], notes: [NOTE] });
    const PROPOSE = { type: "propose_edit_plan" as const, clips: [{ assetId: "a-v1", inSec: 0.4, outSec: 3.1, fadeMs: 0, transitionIn: { kind: "cut" as const, ms: 0 }, punchIn: 1 }], audio: [], output: {}, note: "" };
    const REVISE = { type: "revise_edit" as const, round: 1 as const, resolves: ["n-1"], plan: { clips: [{ ...PROPOSE.clips[0], inSec: 0, outSec: 5 }], audio: [], output: {}, note: "" }, summary: "" };
    const DRAFT = { type: "draft_brief" as const, brief: { idea: "paraphrase", goal: "", platform: "reels" as const, lengthSec: 15, aspect: "9:16" as const, tone: "", references: [], guessed: ["idea" as const] } };
    expect(planInputs([DRAFT, PROPOSE, REVISE]).map((x) => [x.index, x.type, x.clips.length])).toEqual([
      [1, "propose_edit_plan", 1],
      [2, "revise_edit", 1],
    ]);

    const snapped = { clips: [{ ...PROPOSE.clips[0], inSec: 0.2, fit: "fill" as const }], totalSec: 2.9, targetSec: 3, warnings: ["clip 1: in 0.4 → 0.2 s"], refusals: [] };
    const ok = effectsFor([DRAFT, PROPOSE], project(), ASSETS, cur, ROUND1, { checks: [snapped], nicLine: "My reel, my words. Draft the brief." });
    expect(ok.effects[0]).toMatchObject({ kind: "project_update", brief: { idea: "My reel, my words.", guessed: [] } });
    expect(ok.effects[1]).toMatchObject({ kind: "manifest_save", manifest: { clips: [expect.objectContaining({ inSec: 0.2, fit: "fill" })] } });
    expect(ok.warnings).toEqual(["clip 1: in 0.4 → 0.2 s"]);

    const refused = effectsFor([PROPOSE], project(), ASSETS, cur, ROUND1, { checks: [{ ...snapped, refusals: ["clip 1 is 0.3 s; keep every clip ≥ 1 s"] }] });
    expect(refused.effects).toEqual([{ kind: "refused", action: "propose_edit_plan", why: "plan check: clip 1 is 0.3 s; keep every clip ≥ 1 s" }]);
    expect(refused.refusedTypes).toEqual(["propose_edit_plan"]);

    const noop = effectsFor([REVISE], project(), ASSETS, cur, ROUND1, { checks: [{ ...snapped, clips: REVISE.plan.clips }] });
    expect(noop.effects).toEqual([expect.objectContaining({ kind: "refused", action: "revise_edit", why: expect.stringMatching(/changes nothing/) })]);
    expect(noop.refusals[0]).toContain(`Nic's notes: n-1 "Tighten the middle`);
  });

  it("planInputs carries checkPlanFor, and a refused revision doesn't shift later plans' check results", async () => {
    const { effectsFor, planInputs } = await import("./e2e/director-live.e2e");
    const cur = manifest({ clips: [clip()], notes: [NOTE] });
    const c = { assetId: "a-v1", inSec: 0, outSec: 3, fadeMs: 0, transitionIn: { kind: "cut" as const, ms: 0 }, punchIn: 1 };
    const REVISE2 = { type: "revise_edit" as const, round: 2 as const, resolves: ["n-1"], plan: { clips: [c], audio: [], output: {}, note: "" }, summary: "" };
    const PROPOSE = { type: "propose_edit_plan" as const, clips: [c], audio: [], output: {}, captions: { enabled: true }, outputs: ["tiktok" as const], note: "" };
    const inputs = planInputs([REVISE2, PROPOSE], cur);
    expect(inputs.map((x) => x.plan?.resolves)).toEqual([["n-1"], undefined]);
    expect(inputs[1].plan?.outputs).toEqual([expect.objectContaining({ platform: "tiktok" })]);
    expect(planInputs([PROPOSE])[0].plan).toBeUndefined();
    const pass = (outSec: number) => ({ clips: [{ ...c, outSec }], totalSec: outSec, targetSec: null, warnings: [], refusals: [] });
    // Round 2 is refused by reviseRefusal (never checked); the proposal must get the 2nd result.
    const out = effectsFor([REVISE2, PROPOSE], project(), ASSETS, cur, ROUND1, { checks: [pass(9), pass(4)] });
    expect(out.effects[0]).toMatchObject({ kind: "refused", action: "revise_edit" });
    expect(out.effects[1]).toMatchObject({ kind: "manifest_save", manifest: { clips: [expect.objectContaining({ outSec: 4 })] } });
  });
});

describe("live E2E run 6: json-fenced actions and null clip defaults", () => {
  it("a ```json fence naming an action type is an action block; other json stays prose", async () => {
    const { extractActionBlocks, parseDirectorActions, stripActionBlocks } = await import("./actions");
    const plan = { type: "propose_edit_plan", clips: [{ assetId: "a-v1", inSec: 0, outSec: 3, fadeMs: 0, transitionIn: { kind: "cut", ms: 0 }, punchIn: null, fit: "auto" }], audio: [], output: {}, note: "" };
    const reply = `Cut locked.\n\n\`\`\`ts\nconst x = 1;\n\`\`\`\n\n\`\`\`json\n{"settings": {"type": "x"}}\n\`\`\`\n\n\`\`\`json\n${JSON.stringify(plan)}\n\`\`\`\nDone.`;
    expect(extractActionBlocks(reply)).toHaveLength(1);
    const r = parseDirectorActions(reply, { assets: ASSETS, manifest: manifest() });
    expect(r.errors).toEqual([]);
    expect(r.actions).toEqual([expect.objectContaining({ type: "propose_edit_plan", clips: [expect.objectContaining({ punchIn: 1, fadeMs: 0 })] })]);
    expect(r.prose).toContain("const x = 1;");
    expect(r.prose).toContain('{"settings"');
    expect(r.prose).not.toContain("propose_edit_plan");
    expect(stripActionBlocks("```director-action\n{json}\n" + JSON.stringify(plan) + "\n```")).toBe("");
  });
  it("run 7: a clip or moment starting past the asset's end is an error that says so (not a silent 0.1 s clamp)", async () => {
    const { validateAction } = await import("./actions");
    const v = ASSETS.find((a) => a.kind === "video" && (a.durationSec ?? 0) > 0)!;
    const dur = v.durationSec!;
    const clipAt = (inSec: number) => ({ type: "propose_edit_plan", clips: [{ assetId: v.id, inSec, outSec: inSec + 3 }], audio: [], output: {}, note: "" });
    const bad = validateAction(clipAt(dur + 20), { assets: ASSETS, manifest: manifest() });
    expect(bad).toEqual({ ok: false, error: expect.stringMatching(/clip 1: inSec .* is past the end of .*not m:ss/) });
    expect(validateAction(clipAt(0), { assets: ASSETS, manifest: manifest() }).ok).toBe(true);
    const moment = validateAction({ type: "match_footage", matches: [], moments: [{ assetId: v.id, inSec: dur, outSec: dur + 3, label: "x", score: 0.9 }] }, { assets: ASSETS, manifest: manifest() });
    expect(moment).toEqual({ ok: false, error: expect.stringMatching(/past the end/) });
  });
});

describe("resolving notes", () => {
  it("Nic's own Resolve click passes manual; the render-approval path doesn't, and an unchanged cut leaves the note open", async () => {
    await open({}, manifest({ clips: [clip()], notes: [NOTE] }), ROUND1);
    m.noteResolve.mockResolvedValueOnce(undefined);
    expect(await store.resolveNote("n-1", { manual: true })).toBe(true);
    expect(m.noteResolve).toHaveBeenLastCalledWith({ slug: "demo", noteId: "n-1", manual: true });
    await open({}, manifest({ clips: [clip()], notes: [NOTE] }), ROUND1);
    m.noteResolve.mockRejectedValueOnce(new Error("UNCHANGED_PLAN: the revised cut is the same as the one this note is on"));
    expect(await store.resolveNote("n-1")).toBe(false);
    expect(m.noteResolve).toHaveBeenLastCalledWith({ slug: "demo", noteId: "n-1" });
    expect(st().manifest?.notes[0].resolved).toBe(false);
  });
});


// ── review findings (2026-11-26 second pass) ─────────────────────────────────

describe("review fixes: the Render Plan card shows framing and warnings", () => {
  const view = (plan: RenderPlan) => renderToStaticMarkup(createElement(RenderPlanView, { plan, busy: false, renderReady: true, onApprove: () => undefined, onModify: () => undefined }));
  it("each source row shows its framing, and the plan's warnings sit above Approve & Render", () => {
    const h = view({
      ...PLAN,
      sources: [{ assetId: "a-v1", name: "reel.mp4", inSec: 10, outSec: 14, framing: "reels fill · youtube pad · 608×1080 (bars cropped)" }, { assetId: "a-v1", name: "reel.mp4", inSec: 70, outSec: 75, framing: "pad" }],
      warnings: ["clip 2: couldn't measure black bars (Media Forge is off), so it pads with no crop"],
    });
    expect(h).toContain("reels fill · youtube pad · 608×1080 (bars cropped)");
    expect(h).toContain("Before you approve");
    expect(h).toContain("clip 2: couldn&#x27;t measure black bars (Media Forge is off), so it pads with no crop");
    expect(h.indexOf("Before you approve")).toBeLessThan(h.indexOf("Approve &amp; Render"));
  });
  it("older plans (no framing, no warnings) still render", () => {
    const h = view({ ...PLAN, sources: [{ assetId: "a-v1", name: "reel.mp4", inSec: 0, outSec: 4 }] });
    expect(h).toContain("reel.mp4");
    expect(h).not.toContain("Before you approve");
  });
});

describe("review fixes: LENGTH is the render's length", () => {
  const b: CreativeBrief = { idea: "x", goal: "", platform: "reels", lengthSec: 15, aspect: "9:16", tone: "", references: [], guessed: [], approved: true, updatedBy: "nic", updatedAt: "t" };
  it("crossfades overlap as Rust's expected_duration counts them (≤ 45% of the shorter clip)", () => {
    const xf = (ms: number) => ({ kind: "crossfade" as const, ms });
    // Five 3 s clips, four 600 ms crossfades: 15 − 2.4 = 12.6 s (the plan check's total).
    const five = manifest({ clips: [clip({ outSec: 3 }), ...Array.from({ length: 4 }, () => clip({ outSec: 3, transitionIn: xf(600) }))] });
    expect(lengthLine(project({ brief: b }), five)).toBe("LENGTH: target 15s · cut 12.6s");
    expect(crossfadeOverlap(five.clips)).toBeCloseTo(2.4, 6);
    // The cap: a 1500 ms crossfade into a 2 s clip overlaps 0.9 s; a crossfade on clip 1 is a cut.
    expect(crossfadeOverlap([clip({ outSec: 2, transitionIn: xf(1000) }), clip({ outSec: 5, transitionIn: xf(1500) })])).toBeCloseTo(0.9, 6);
    expect(crossfadeOverlap([clip({ transitionIn: { kind: "fade_black", ms: 800 } }), clip({ transitionIn: { kind: "fade_black", ms: 800 } })])).toBe(0);
    expect(ACTION_CONTRACT).toMatch(/net of crossfade overlap/);
  });
  it("a short still hold isn't flagged under 1 s (the 1 s minimum is video only)", () => {
    const mf = manifest({ clips: [clip({ assetId: "a-img", inSec: 0, outSec: 0.5 }), clip({ assetId: "a-v1", inSec: 0, outSec: 0.5 })] });
    expect(lengthLine(project(), mf, ASSETS)).toBe("LENGTH: target none (no brief) · cut 1s · 1 clip under 1s");
    expect(ACTION_CONTRACT).toMatch(/Stills: outSec = hold 0\.2–60 s/);
    expect(ACTION_CONTRACT).toMatch(/video clip under 1 s/);
  });
});

describe("review fixes: plan check gets the plan's own outputs, and revisions compare with the noted render", () => {
  const PROPOSE = { type: "propose_edit_plan" as const, clips: [{ assetId: "a-v1", inSec: 0, outSec: 3, fadeMs: 0, transitionIn: { kind: "cut" as const, ms: 0 }, punchIn: 1 }], audio: [], output: {}, captions: { enabled: true }, outputs: ["tiktok" as const], note: "" };
  it("propose_edit_plan sends the merged outputs / captions (not the saved ones)", async () => {
    await store.applyDirectorActionsReport([PROPOSE]);
    const arg = m.planCheck.mock.calls[0][0] as { plan: { outputs: { platform: string; maxSec: number | null }[]; captions: { enabled: boolean }; resolves?: string[] } };
    expect(arg.plan.outputs).toEqual([expect.objectContaining({ platform: "tiktok", maxSec: 90 })]);
    expect(arg.plan.captions.enabled).toBe(true);
    expect(arg.plan.resolves).toBeUndefined();
    expect(pc.checkPlanFor(manifest(), { ...PROPOSE, outputs: ["reels"] } as never, ["n-1"])).toMatchObject({ outputs: [{ platform: "reels" }], resolves: ["n-1"] });
  });

  const revise = (outSec: number) => ({ type: "revise_edit" as const, round: 1 as const, resolves: ["n-1"], plan: { clips: [{ assetId: "a-v1", inSec: 0, outSec, fadeMs: 0, transitionIn: { kind: "cut" as const, ms: 0 }, punchIn: 1 }], audio: [], output: {}, note: "" }, summary: "" });
  it("a revision equal to Nic's own edit since the render applies when Rust says it differs from the noted cut", async () => {
    // Nic trimmed the noted cut (0–5) to 0–4 by hand; the revision sends 0–4 too.
    await open({}, manifest({ clips: [clip({ outSec: 4 })], notes: [NOTE] }), ROUND1);
    m.planCheck.mockImplementationOnce(async (a: { clips: PlanCheckResult["clips"] }) => ({ ...(await passCheck(a)), unchangedSinceRender: false }));
    const r = await store.applyDirectorActionsReport([revise(4)]);
    expect((m.planCheck.mock.calls[0][0] as { plan: { resolves: string[] } }).plan.resolves).toEqual(["n-1"]);
    expect(r.refusals).toEqual([]);
    expect(st().revision).toEqual({ round: 1, resolves: ["n-1"], summary: "" });
  });
  it("…and is refused when Rust says it renders the noted cut, even if it differs from the current one", async () => {
    await open({}, manifest({ clips: [clip({ outSec: 4 })], notes: [NOTE] }), ROUND1);
    m.planCheck.mockImplementationOnce(async (a: { clips: PlanCheckResult["clips"] }) => ({ ...(await passCheck(a)), unchangedSinceRender: true }));
    const r = await store.applyDirectorActionsReport([revise(5)]);
    expect(r.refusedTypes).toEqual(["revise_edit"]);
    expect(r.refusals[0]).toMatch(/as the cut Nic's notes are on/);
    expect(st().revision).toBeNull();
  });
  it("planCheck keeps unchangedSinceRender only when Rust sent a boolean", async () => {
    m.planCheck.mockResolvedValueOnce({ clips: [clip()], totalSec: 5, targetSec: null, warnings: [], refusals: [], unchangedSinceRender: true });
    expect((await pc.planCheck("demo", [clip()]))?.unchangedSinceRender).toBe(true);
    expect("unchangedSinceRender" in ((await pc.planCheck("demo", [clip()])) ?? {})).toBe(false);
  });
});

describe("review fixes: a chat line is only the idea when it asked for a brief", () => {
  const DRAFT = { type: "draft_brief", brief: { idea: "paraphrase", platform: "reels", lengthSec: 15, aspect: "9:16", guessed: ["idea"] } };
  it("an unrelated question never becomes brief.idea: the handoff idea wins, else the model's words stay guessed", async () => {
    expect(pc.asksForBrief("which clip has the best laugh?")).toBe(false);
    expect(pc.asksForBrief("Draft a brief: B")).toBe(true);
    expect(pc.briefIdeaFor(project({ source: { from: "brainstorm", refId: null, brief: "The real idea." } }), null, "which clip has the best laugh?")).toBe("The real idea.");
    await open({ source: { from: "brainstorm", refId: "n1", brief: "The real idea." } });
    m.turn.mockResolvedValueOnce(reply(block(DRAFT)));
    await chat.sendDirectorTurn("which clip has the best laugh?");
    expect(st().project?.brief?.idea).toBe("The real idea.");
    await open();
    m.turn.mockResolvedValueOnce(reply(block(DRAFT)));
    await chat.sendDirectorTurn("what shots do I still need?");
    expect(st().project?.brief).toMatchObject({ idea: "paraphrase", guessed: ["idea"] });
  });
  it("the BriefCard idea lasts one turn: a later typed brief request keeps its own idea", async () => {
    m.turn.mockResolvedValueOnce(reply("Tell me more about the tone first.")).mockResolvedValueOnce(reply(block(DRAFT)));
    await chat.sendDirectorTurn(draftBriefLine("Idea A"), { briefIdea: "Idea A", nicLine: "Idea A" });
    expect(st().briefIdea).toBeNull();
    await chat.sendDirectorTurn("Draft a brief: Idea B, a moody 30s dance reel");
    expect(st().project?.brief?.idea).toBe("Idea B, a moody 30s dance reel");
  });
});

describe("review fixes: the auto-fix line stays the app's after a reload", () => {
  it("openProject restores autoFix from the logged line, and model history labels it as the app's", async () => {
    const shown = chat.autoFixLine(['block 1: clip 1: "outSec" must be a number']);
    m.chatLog.mockResolvedValue([
      { role: "nic", text: "cut it", at: "t1" },
      { role: "director", text: "Here.", at: "t2" },
      { role: "nic", text: shown, at: "t3" },
    ]);
    await open();
    expect(st().chat.map((x) => !!x.autoFix)).toEqual([false, false, true]);
    const h = chat.chatHistory(st().chat);
    expect(h[0].content).toBe("cut it");
    expect(h[2]).toEqual({ role: "user", content: `${chat.AUTO_FIX_HISTORY_LABEL} ${shown}` });
    expect(chat.AUTO_FIX_HISTORY_LABEL).not.toMatch(/\b(he|she|his|her|him)\b/i);
  });
});
