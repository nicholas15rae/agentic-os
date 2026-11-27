/**
 * The two open issues from live E2E run 9 (e2e-demo-reel-9, 2026-11-27):
 * 1. The Director never saw WHAT is said: the context now carries a TRANSCRIPT section of timed
 *    lines (media_transcript_lines), capped, lines near moments / clips first.
 * 2. A fit-only revision resolved a timing note: framing-only changes (fit, punchIn) count only for
 *    notes about framing, and the stored round summary never claims clip changes that didn't happen.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetTranscriptLines, MediaProject, Note, ProjectReview, RenderPlan, TimelineClip, TimelineManifest } from "./contract";
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
    transcriptLines: vi.fn(),
  },
  onDirectorEvent: vi.fn(async () => () => undefined),
}));

const { api } = await import("./api");
const store = await import("./director-store");
const chat = await import("./director-chat");
const pc = await import("./plan-check");
const { ACTION_CONTRACT, CONTEXT_BUDGET, TRANSCRIPT_BUDGET, buildDirectorContext, transcriptSection } = await import("./context");
const m = vi.mocked(api) as unknown as Record<string, ReturnType<typeof vi.fn>>;
const st = () => store.useDirector.getState();

const REEL = "a-mwyfgu751";
/** Run 9's real lines around its clips (working/captions/a-mwyfgu751.json, rounded as Rust sends them). */
const RUN9_LINES: AssetTranscriptLines = {
  assetId: REEL,
  more: 0,
  lines: [
    { start: 6.03, end: 8.35, text: "Boys, I swear that was going bar down." },
    { start: 8.65, end: 10.07, text: "My stick just panicked." },
    { start: 18.08, end: 19.26, text: "Ooh, she's frosty." },
    { start: 23.61, end: 24.51, text: "Doesn't he a spotlight?" },
    { start: 25.11, end: 26.27, text: "He never forgets the boys." },
    { start: 40.57, end: 45.07, text: "most valuable provider of beverages." },
    { start: 45.07, end: 50.21, text: "Think in the head to keeping the boys alive out there to our real one." },
    { start: 62.83, end: 67.67, text: "Tossed around, Joseph's brother Moses creates packaging that can protect the candy" },
    { start: 94.75, end: 99.31, text: "And for the world's first ever chocolate-covered raisins, they choose raisins." },
    { start: 122.07, end: 123.61, text: "But they have no idea." },
  ],
};
const reel = asset(REEL, "video", { name: "Nicholas_Rae_Demo_Reel.mp4", durationSec: 140, moments: [{ id: "m-1", inSec: 24, outSec: 26.5, label: "s1 Hook", score: 0.98, by: "director" }] });

const clip = (p: Partial<TimelineClip> = {}): TimelineClip => ({ id: "c-1", assetId: "a-v1", inSec: 0, outSec: 5, fadeMs: 0, transitionIn: { kind: "cut", ms: 0 }, punchIn: 1, ...p });
const PLAN: RenderPlan = { planId: "p-1", project: "demo", manifestRevision: 4, sources: [], audio: [], outputName: "demo", outputSpec: "1920×1080", renderMode: "cpu_only", proposedBy: "director" };
const ROUND1: ProjectReview = { rounds: [{ round: 1, renderId: "r-1", notes: ["n-1"], status: "open", summary: "" }], openDecisions: [] };
const TIMING: Note = { id: "n-1", renderId: "r-1", atSec: null, text: "Tighten the middle and end on a stronger beat.", by: "nic", viaVoice: false, resolved: false, at: "t" };
const FRAMING: Note = { ...TIMING, id: "n-2", text: "The black bars look bad: fill the frame." };
const passCheck = async ({ clips }: { clips: PlanCheckResult["clips"] }): Promise<PlanCheckResult> => ({ clips, totalSec: pc.clipsTotal(clips), targetSec: null, warnings: [], refusals: [] });
/** Run 9 round 1: three fill clips. */
const ROUND1_CLIPS = [clip({ id: "c-1", inSec: 23.85, outSec: 26.5, punchIn: 1.2, fit: "fill" }), clip({ id: "c-2", inSec: 44.43, outSec: 50.21, punchIn: 1.2, fit: "fill" }), clip({ id: "c-3", inSec: 94.93, outSec: 100.25, punchIn: 1.2, fit: "fill" })];
const planClips = (fit: "auto" | "fill", outs: number[] = [26.5, 50.21, 100.25]) =>
  ROUND1_CLIPS.map((c, i) => ({ assetId: c.assetId, inSec: c.inSec, outSec: outs[i], fadeMs: 0, transitionIn: { kind: "cut" as const, ms: 0 }, punchIn: 1.2, fit }));
const revise = (resolves: string[], fit: "auto" | "fill", outs?: number[]) => ({
  type: "revise_edit" as const,
  round: 1 as const,
  resolves,
  plan: { clips: planClips(fit, outs), audio: [], output: {}, note: "" },
  summary: "Extended the middle B-Roll clip (44.43-50.21) to increase total duration from 8.6s to ~15s while maintaining the hook and payoff structure.",
});

async function open(mf: TimelineManifest, review: ProjectReview = ROUND1) {
  m.projectGet.mockResolvedValue({ project: project(), assets: ASSETS, manifest: mf, renders: [] });
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
  m.transcriptLines.mockResolvedValue([]);
});

// ── Issue 1: TRANSCRIPT ───────────────────────────────────────────────────────

describe("TRANSCRIPT section (pure)", () => {
  it("lists each line whole as [start–end] text under its asset", () => {
    const s = transcriptSection([reel], manifest(), [RUN9_LINES]);
    expect(s.split("\n")[0]).toMatch(/^TRANSCRIPT \(/);
    expect(s).toContain(`${REEL} (Nicholas_Rae_Demo_Reel.mp4):`);
    expect(s).toContain("[23.61–24.51] Doesn't he a spotlight?");
    expect(s).toContain("[6.03–8.35] Boys, I swear that was going bar down.");
    expect(s).not.toMatch(/not shown/);
    expect(s.length).toBeLessThanOrEqual(TRANSCRIPT_BUDGET);
  });

  it("is empty with no lines, for non-video assets, and for unknown asset ids", () => {
    expect(transcriptSection([reel], manifest(), [])).toBe("");
    expect(transcriptSection([reel], manifest(), null)).toBe("");
    expect(transcriptSection([asset(REEL, "audio")], manifest(), [RUN9_LINES])).toBe("");
    expect(transcriptSection([asset("a-other", "video")], manifest(), [RUN9_LINES])).toBe("");
  });

  it("over budget: lines near moments and timeline clips first, whole lines only, and says how many were dropped", () => {
    const mf = manifest({ clips: [clip({ assetId: REEL, inSec: 94.93, outSec: 100.25 })] });
    const s = transcriptSection([reel], mf, [{ ...RUN9_LINES, more: 3 }], 420);
    expect(s.length).toBeLessThanOrEqual(420);
    // The moment (24–26.5) and the clip (94.93–100.25) win over the reel's other lines.
    expect(s).toContain("[23.61–24.51] Doesn't he a spotlight?");
    expect(s).toContain("[25.11–26.27] He never forgets the boys.");
    expect(s).toContain("[94.75–99.31] And for the world's first ever chocolate-covered raisins, they choose raisins.");
    expect(s).not.toContain("Tossed around");
    // Every shown line is a whole line from the transcript (never cut mid-word), in time order.
    const shown = s.split("\n").filter((l) => l.startsWith("["));
    for (const l of shown) expect(RUN9_LINES.lines.some((x) => l.endsWith(`] ${x.text}`))).toBe(true);
    const starts = shown.map((l) => Number(l.slice(1, l.indexOf("–"))));
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    // Dropped = lines not shown here + the 3 Rust's cap already left out.
    const dropped = RUN9_LINES.lines.length - shown.length + 3;
    expect(s).toContain(`… ${dropped} more lines not shown`);
  });

  it("a budget too small for any line still never overflows", () => {
    const s = transcriptSection([reel], manifest(), [RUN9_LINES], 60);
    expect(s.length).toBeLessThanOrEqual(60);
    expect(s).toBe("TRANSCRIPT: 10 lines not shown (no room)");
    expect(transcriptSection([reel], manifest(), [RUN9_LINES], 10)).toBe("");
  });
});

describe("the context carries the TRANSCRIPT section within CONTEXT_BUDGET", () => {
  it("between ASSETS and LENGTH, with the ACTION CONTRACT still whole at the end", () => {
    const c = buildDirectorContext(project(), [reel], manifest(), null, [RUN9_LINES]);
    expect(c.indexOf("TRANSCRIPT (")).toBeGreaterThan(c.indexOf("ASSETS ("));
    expect(c.indexOf("TRANSCRIPT (")).toBeLessThan(c.indexOf("LENGTH:"));
    expect(c.endsWith(ACTION_CONTRACT)).toBe(true);
    expect(buildDirectorContext(project(), [reel], manifest(), null)).not.toContain("TRANSCRIPT (");
  });

  it("worst case (huge transcripts on many assets) stays under CONTEXT_BUDGET", () => {
    const many = Array.from({ length: 12 }, (_, i) => asset(`a-v${i}`, "video", { name: `take_${i}_with_a_rather_long_file_name.MOV`, durationSec: 600 }));
    const lines = many.map((a) => ({ assetId: a.id, more: 40, lines: Array.from({ length: 200 }, (_, k) => ({ start: k * 3, end: k * 3 + 2.5, text: `Line ${k} of a long take where a lot is said in one breath, word after word.` })) }));
    const c = buildDirectorContext(project(), many, manifest(), null, lines);
    expect(c.length).toBeLessThan(CONTEXT_BUDGET);
    expect(c.endsWith(ACTION_CONTRACT)).toBe(true);
    expect(c).toMatch(/more lines not shown/);
  });

  it("the ACTION CONTRACT tells the Director to start and end clips on TRANSCRIPT lines", () => {
    expect(ACTION_CONTRACT).toMatch(/prefer starting a clip on a TRANSCRIPT line's start and ending it on a line's end/);
    expect(ACTION_CONTRACT).not.toMatch(/\b(he|she|his|her|him)\b/i);
  });
});

describe("a Director turn fetches the transcript lines for its context", () => {
  it("sends TRANSCRIPT lines from media_transcript_lines; a failing or missing command sends none", async () => {
    await open(manifest({ clips: [clip()] }), { rounds: [], openDecisions: [] });
    m.transcriptLines.mockResolvedValueOnce([{ assetId: "a-v1", more: 0, lines: [{ start: 1, end: 2.5, text: "Hello there." }] }]);
    m.turn.mockResolvedValue({ answer: "Noted.", providerId: "local", latencyMs: 1, answeredBy: "director" });
    await chat.sendDirectorTurn("what does take one say?");
    expect(m.transcriptLines).toHaveBeenCalledWith({ slug: "demo" });
    const ctx = (m.turn.mock.calls[0][0] as { req: { context: string } }).req.context;
    expect(ctx).toContain("[1.00–2.50] Hello there.");
    m.transcriptLines.mockRejectedValueOnce(new Error("no such command"));
    await chat.sendDirectorTurn("and now?");
    expect((m.turn.mock.calls[1][0] as { req: { context: string } }).req.context).not.toContain("TRANSCRIPT (");
    expect(await chat.transcriptLinesFor("demo")).toEqual([]);
  });
});

// ── Issue 2: framing-only revisions ───────────────────────────────────────────

describe("framing notes (pure; Rust note_is_about_framing is the same rule)", () => {
  it("run 9's timing note is not about framing; framing notes are", () => {
    expect(pc.noteIsAboutFraming("Tighten the middle and end on a stronger beat.")).toBe(false);
    expect(pc.noteIsAboutFraming("Punch up the ending; it feels flat")).toBe(false);
    expect(pc.noteIsAboutFraming("Barely any energy in the first two seconds")).toBe(false);
    // Timestamps are not aspect ratios.
    for (const t of ["Cut the dead air at 1:12", "tighten 1:15-1:18", "the pause at 4:55 drags", "trim from 0:09:16", "at 11:10 it drags"]) {
      expect(pc.noteIsAboutFraming(t), t).toBe(false);
    }
    for (const t of [
      "The black bars look bad",
      "Fill the frame",
      "crop tighter on my face",
      "too much letterboxing",
      "Punch in on the laugh",
      "make it 9:16",
      "make it 1:1.",
      "(16:9) please",
      "Zoomed in too far",
      "the blur background is distracting",
      "Doesn't fit vertically",
      "FIT it",
      "My head is cut off at the top, use pad",
      "it looks squished in portrait",
      "go to a close up on the laugh",
      "keep me centered",
    ]) {
      expect(pc.noteIsAboutFraming(t), t).toBe(true);
    }
  });

  it("planChangesNothing: a fit-only change counts only for framing notes (and without notes, as before)", () => {
    const cur = manifest({ clips: ROUND1_CLIPS, notes: [TIMING, FRAMING] });
    const body = { clips: planClips("auto"), audio: [], output: {}, note: "" } as never;
    expect(pc.planChangesNothing(cur, body)).toBe(false);
    expect(pc.planChangesNothing(cur, body, [TIMING])).toBe(true);
    expect(pc.planChangesNothing(cur, body, [FRAMING])).toBe(false);
    expect(pc.planChangesNothing(cur, body, [TIMING, FRAMING])).toBe(false);
    expect(pc.planChangesOnlyFraming(cur, body)).toBe(true);
    const trimmed = { clips: planClips("auto", [26.5, 48.11, 100.25]), audio: [], output: {}, note: "" } as never;
    expect(pc.planChangesNothing(cur, trimmed, [TIMING])).toBe(false);
    expect(pc.planChangesOnlyFraming(cur, trimmed)).toBe(false);
  });

  it("noopRevisionReason: Rust's render comparison gets its own wording, not one guessed from the current cut", () => {
    const cur = manifest({ clips: ROUND1_CLIPS, notes: [TIMING, FRAMING] });
    // Against the current cut the clips differ (edits since the render), but Rust said unchanged.
    const retimed = { clips: planClips("auto", [26.5, 48.11, 100.25]), audio: [], output: {}, note: "" } as never;
    expect(pc.noopRevisionReason(cur, retimed, ["n-1"], true)).toMatch(/^revise_edit refused: that revision changes nothing Nic's notes ask for: compared with the render the notes are on, .*none of the notes are about framing\)/);
    expect(pc.noopRevisionReason(cur, retimed, ["n-2"], true)).toMatch(/^revise_edit refused: that revision changes nothing \(same clips/);
    // The page's own check keeps the old wording.
    const fitOnly = { clips: planClips("auto"), audio: [], output: {}, note: "" } as never;
    expect(pc.noopRevisionReason(cur, fitOnly, ["n-1"], false)).toBe(pc.noopRevisionRefusal(cur, ["n-1"], true));
  });

  it("revisionSummary: an app-written prefix when the clips are unchanged, the Director's words otherwise", () => {
    const cur = manifest({ clips: ROUND1_CLIPS });
    const fitOnly = { clips: planClips("auto"), audio: [], output: {}, note: "" } as never;
    expect(pc.revisionSummary(cur, fitOnly, "Extended the middle clip.")).toBe("Clips unchanged (same footage and in/out points); changed: framing (fit or punch-in). The Director wrote: Extended the middle clip.");
    const captions = { clips: planClips("fill"), audio: [], output: {}, note: "", captions: { enabled: true, style: "bold_pop", position: "lower", maxWordsPerLine: 3 } } as never;
    expect(pc.revisionSummary(cur, captions, "Warmer.")).toBe("Clips unchanged (same footage and in/out points); changed: captions. The Director wrote: Warmer.");
    // No summary, no claim to correct; nothing changed from the current cut: says so.
    expect(pc.revisionSummary(cur, captions, "  ")).toBe("");
    expect(pc.revisionSummary(cur, { clips: planClips("fill"), audio: [], output: {}, note: "" } as never, "Retimed.")).toMatch(/^Clips unchanged \(same footage and in\/out points as the current cut, which keeps the edits made since the noted render\)\. The Director wrote: Retimed\.$/);
    const trimmed = { clips: planClips("fill", [26.5, 48.11, 100.25]), audio: [], output: {}, note: "" } as never;
    // Clips changed: the real length change comes first, written by the app (live E2E run 10).
    const out = pc.revisionSummary(cur, trimmed, " Extended the payoff to meet 15s. ");
    const m = /^Length (\d+\.\d) s → (\d+\.\d) s\. The Director wrote: Extended the payoff to meet 15s\.$/.exec(out);
    expect(m, out).not.toBeNull();
    expect(Number(m![1]) - Number(m![2])).toBeCloseTo(2.1, 1);
    // Under half a second of change: the Director's words alone.
    const nudged = { clips: planClips("fill", [26.5, 50.0, 100.25]), audio: [], output: {}, note: "" } as never;
    expect(pc.revisionSummary(cur, nudged, "Nudged.")).toBe("Nudged.");
  });
});

describe("run 9 round 2: a fit-only revision of a timing note", () => {
  it("is refused (fallback check, no Rust snapshot): no save, no summary, the note stays open, and the refusal says why", async () => {
    await open(manifest({ clips: ROUND1_CLIPS, notes: [TIMING] }));
    const r = await store.applyDirectorActionsReport([revise(["n-1"], "auto")]);
    expect(r.refusedTypes).toEqual(["revise_edit"]);
    expect(r.notes).toEqual(["Revision not applied: it changes nothing, so your notes stay open"]);
    expect(r.refusals[0]).toMatch(/^revise_edit refused: that revision only changes framing \(fit or punchIn\) and keeps every clip's in and out points, which none of Nic's notes ask for, so its notes stay open\. Nic's notes: n-1 "Tighten the middle/);
    expect(m.manifestSave).not.toHaveBeenCalled();
    expect(m.reviewWrite).not.toHaveBeenCalled();
    expect(st().revision).toBeNull();
  });

  it("is refused when Rust says unchangedSinceRender (its own framing rule), whatever the fallback thinks", async () => {
    await open(manifest({ clips: ROUND1_CLIPS, notes: [TIMING] }));
    m.planCheck.mockImplementationOnce(async (a: { clips: PlanCheckResult["clips"] }) => ({ ...(await passCheck(a)), unchangedSinceRender: true }));
    const r = await store.applyDirectorActionsReport([revise(["n-1"], "auto", [26.5, 50.21, 100.25])]);
    expect(r.refusedTypes).toEqual(["revise_edit"]);
  });

  it("applies for a framing note, and the stored summary says the clips are unchanged", async () => {
    await open(manifest({ clips: ROUND1_CLIPS, notes: [FRAMING] }), { rounds: [{ round: 1, renderId: "r-1", notes: ["n-2"], status: "open", summary: "" }], openDecisions: [] });
    const r = await store.applyDirectorActionsReport([revise(["n-2"], "auto")]);
    expect(r.refusals).toEqual([]);
    const summary = "Clips unchanged (same footage and in/out points); changed: framing (fit or punch-in). The Director wrote: Extended the middle B-Roll clip (44.43-50.21) to increase total duration from 8.6s to ~15s while maintaining the hook and payoff structure.";
    expect(st().revision).toEqual({ round: 1, resolves: ["n-2"], summary });
    expect(m.reviewWrite).toHaveBeenCalledWith({ slug: "demo", round: 1, summary });
  });

  it("a revision that really retimes a clip keeps the Director's summary, after the real length change", async () => {
    await open(manifest({ clips: ROUND1_CLIPS, notes: [TIMING] }));
    const r = await store.applyDirectorActionsReport([revise(["n-1"], "fill", [26.5, 48.11, 100.25])]);
    expect(r.refusals).toEqual([]);
    // The middle clip was shortened by 2.1 s while the Director's words say "Extended".
    expect(st().revision?.summary).toMatch(/^Length \d+\.\d s → \d+\.\d s\. The Director wrote: Extended the middle B-Roll clip/);
  });
});

describe("run 11: the length bands are in the context before the Director revises", () => {
  it("lengthBands mirrors media.rs (plan ±10% ≥ 1.5 s, revision ±30% ≥ 3 s)", async () => {
    const ctx = await import("./context");
    expect(ctx.lengthBands(15)).toEqual({ plan: [13.5, 16.5], revision: [10.5, 19.5] });
    expect(ctx.lengthBands(5)).toEqual({ plan: [3.5, 6.5], revision: [2, 8] });
    expect(ctx.lengthBands(60).revision).toEqual([42, 78]);
  });
  it("the revision band shows only while a note is open", async () => {
    const ctx = await import("./context");
    const p = { brief: { lengthSec: 15, guessed: [] } } as never;
    const open = manifest({ clips: ROUND1_CLIPS, notes: [{ id: "n-1", renderId: "r-1", atSec: 1, text: "Tighten", viaVoice: false, resolved: false }] as never });
    expect(ctx.lengthLine(p, open)).toMatch(/· a plan must total 13\.5–16\.5s · a revise_edit 10\.5–19\.5s$/);
    const done = manifest({ clips: ROUND1_CLIPS, notes: [] });
    expect(ctx.lengthLine(p, done)).toMatch(/· a plan must total 13\.5–16\.5s$/);
  });
});
