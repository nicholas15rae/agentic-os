import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CreativeBrief, Note, ProjectReview, ShotSlot, VerifiedRender } from "./contract";
import { V1, V2, asset, manifest } from "./fixtures.test-util";

vi.mock("@/stores/nav", () => ({ useNav: Object.assign(() => () => undefined, { getState: () => ({ go: () => undefined }) }) }));
vi.mock("@/features/reminders/notify", () => ({ useToasts: { getState: () => ({ push: vi.fn() }) } }));
// Biz Ops pulls in the orchestrator + voice controller; the shelf only needs the call.
vi.mock("./bizops", () => ({ sendRenderToBizOps: vi.fn() }));

const ui = await import("./review-ui");
const { BriefView, briefPatch } = await import("./BriefCard");
const { IntakeStatusView } = await import("./IntakeStatus");
const { ShotChecklistView } = await import("./ShotChecklist");
const { ShotSlotCard } = await import("./ShotSlotCard");
const { slotFormPatch } = await import("./ShotSlotEditor");
const { BinSuggestionsView } = await import("./BinSuggestions");
const { AssetBadges, TagEditor } = await import("./AssetDetails");
const { ReviewPanelView } = await import("./ReviewPanel");
const { OutputsView, presetSpec } = await import("./OutputsCard");
const { FinalApprovalBar } = await import("./VerifiedShelf");
const { DeliverablesList, defaultHashtags } = await import("./Deliverables");
const { addSlot, presetFor, setOutputs, PLATFORM_PRESETS } = await import("./manifest");

const noop = () => undefined;
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const note = (id: string, p: Partial<Note> = {}): Note => ({ id, renderId: "r-1", atSec: 1, text: `note ${id}`, by: "nic", viaVoice: false, resolved: false, at: `2026-11-26T00:00:0${id.length}Z`, ...p });
const render = (id: string, p: Partial<VerifiedRender> = {}): VerifiedRender => ({ id, project: "demo", planId: "p-1", path: `C:\\ai-hub\\media\\projects\\demo\\renders\\${id}.mp4`, durationSec: 12, width: 1080, height: 1920, sizeBytes: 2_000_000, loudnessLufs: -14, verify: { ok: true, checks: ["exists"] }, createdAt: "t", ...p });
const BRIEF: CreativeBrief = { idea: "Dance reel for the showcase", goal: "get booked", platform: "reels", lengthSec: 30, aspect: "9:16", tone: "warm", references: ["like the spring reel"], guessed: ["tone", "lengthSec"], approved: false, updatedBy: "director", updatedAt: "t" };

describe("review-ui helpers", () => {
  it("latest round", () => {
    expect(ui.latestRound(null)).toBeNull();
    expect(ui.latestRound({ rounds: [{ round: 1, renderId: "r", notes: [], status: "revised", summary: "" }, { round: 2, renderId: "s", notes: [], status: "open", summary: "" }], openDecisions: [] })?.round).toBe(2);
  });
  it("note placement: render time, timeline playhead, or no time", () => {
    expect(ui.notePlacement({ kind: "render", render: render("r-9") }, 3.14159, 7)).toEqual({ renderId: "r-9", atSec: 3.142 });
    const clip = { id: "c1", assetId: V1.id, inSec: 0, outSec: 5, fadeMs: 0, transitionIn: { kind: "cut" as const, ms: 0 }, punchIn: 1 };
    expect(ui.notePlacement({ kind: "clip", asset: V1, clip, clipStart: 0 }, 2, 7.5)).toEqual({ renderId: null, atSec: 7.5 });
    expect(ui.notePlacement({ kind: "asset", asset: V1, clip: null, clipStart: 0 }, 2, 7.5)).toEqual({ renderId: null, atSec: null });
    expect(ui.notePlacement(null, 2, 7.5)).toEqual({ renderId: null, atSec: null });
  });
  it("note target: the render, or the timeline clip under the time", () => {
    const mf = manifest({
      clips: [
        { id: "c1", assetId: V1.id, inSec: 2, outSec: 6, fadeMs: 0, transitionIn: { kind: "cut", ms: 0 }, punchIn: 1 },
        { id: "c2", assetId: V2.id, inSec: 1, outSec: 3, fadeMs: 0, transitionIn: { kind: "cut", ms: 0 }, punchIn: 1 },
      ],
    });
    expect(ui.noteTarget(note("a", { renderId: "r-2", atSec: 4 }), mf)).toEqual({ sel: { kind: "render", id: "r-2" }, sec: 4 });
    // 5 s into the timeline = 1 s into c2 (c1 is 4 s long) = asset time 2.
    expect(ui.noteTarget(note("a", { renderId: null, atSec: 5 }), mf)).toEqual({ sel: { kind: "clip", id: "c2" }, sec: 2 });
    expect(ui.noteTarget(note("a", { renderId: null, atSec: 1 }), mf)).toEqual({ sel: { kind: "clip", id: "c1" }, sec: 3 });
    // Past the end: the last clip, clamped to its out point.
    expect(ui.noteTarget(note("a", { renderId: null, atSec: 99 }), mf)).toEqual({ sel: { kind: "clip", id: "c2" }, sec: 3 });
    expect(ui.noteTarget(note("a", { atSec: null }), mf)).toBeNull();
    expect(ui.noteTarget(note("a", { renderId: null }), manifest())).toBeNull();
  });
  it("sorts open notes by time before resolved ones", () => {
    const sorted = ui.sortNotes([note("x", { resolved: true, atSec: 0 }), note("y", { atSec: 9 }), note("z", { atSec: null }), note("w", { atSec: 2 })]);
    expect(sorted.map((n) => n.id)).toEqual(["w", "y", "z", "x"]);
  });
  it("toggles 1–4 platforms; custom is replaced by a real pick; the last one stays", () => {
    expect(ui.togglePlatform(["custom"], "reels")).toEqual(["reels"]);
    expect(ui.togglePlatform(["reels"], "youtube")).toEqual(["reels", "youtube"]);
    expect(ui.togglePlatform(["reels", "youtube"], "reels")).toEqual(["youtube"]);
    expect(ui.togglePlatform(["reels"], "reels")).toBeNull();
    expect(ui.togglePlatform(["reels", "tiktok", "shorts", "youtube"], "ig_feed")).toBeNull();
    expect(ui.togglePlatform(["reels"], "custom")).toEqual(["reels", "custom"]);
  });
  it("transcript file path and lines", () => {
    expect(ui.transcriptFile(asset("a", "video", { transcript: { path: "C:\\x\\a.json", lang: "en", words: 1, firstSpeechSec: null, lastSpeechSec: null } }), "C:\\root")).toBe("C:\\x\\a.json");
    expect(ui.transcriptFile(asset("a", "video", { transcript: { path: "working/captions/a.json", lang: "en", words: 1, firstSpeechSec: null, lastSpeechSec: null } }), "C:\\root\\")).toBe("C:\\root\\working\\captions\\a.json");
    expect(ui.transcriptFile(asset("a", "video"), "C:\\root")).toBeNull();
    expect(ui.transcriptLines({ language: "en", segments: [{ start: 1, end: 2, text: " Hello " }, { start: 3, end: 4, text: "" }, "junk", { text: "no times" }] })).toEqual([
      { start: 1, end: 2, text: "Hello" },
      { start: 0, end: 0, text: "no times" },
    ]);
    expect(ui.transcriptLines(null)).toEqual([]);
    expect(ui.transcriptLines({ segments: "x" })).toEqual([]);
  });
  it("shot count", () => {
    expect(ui.shotCount(null)).toBeNull();
    expect(ui.shotCount(undefined)).toBeNull();
    expect(ui.shotCount([])).toBe("one shot");
    expect(ui.shotCount([1.2, 4])).toBe("3 shots");
  });
});

describe("Brief card", () => {
  const base = { draft: null, chatBusy: false, starter: { ...BRIEF, guessed: [], approved: false }, onSave: async () => true, onApprove: noop, onAcceptDraft: noop, onRejectDraft: noop, onDraft: noop };
  it("no brief: Draft a brief (Director turn) or write it", () => {
    const h = html(createElement(BriefView, { ...base, brief: null }));
    expect(h).toContain("Draft a brief");
    expect(h).toContain("Write it myself");
    expect(h).not.toContain("Approve brief");
  });
  it("shows every field with guessed chips, and Approve brief until approved", () => {
    const h = html(createElement(BriefView, { ...base, brief: BRIEF }));
    for (const t of ["Dance reel for the showcase", "get booked", "Reels", "30s", "9:16", "warm", "like the spring reel"]) expect(h).toContain(t);
    expect(h.match(/>guessed</g)).toHaveLength(2);
    expect(h).toContain("Approve brief");
    expect(h).toContain("Waiting for your approval");
    const ok = html(createElement(BriefView, { ...base, brief: { ...BRIEF, approved: true, guessed: [] } }));
    expect(ok).not.toContain("Approve brief");
    expect(ok).toContain("Approved");
    expect(ok).not.toContain(">guessed<");
  });
  it("a held Director draft offers Accept / Reject with the changed fields", () => {
    const h = html(createElement(BriefView, { ...base, brief: { ...BRIEF, approved: true }, draft: { ...BRIEF, tone: "moody, slow" } }));
    expect(h).toContain("Accept draft");
    expect(h).toContain("Reject");
    expect(h).toContain("moody, slow");
    expect(h).not.toContain(">get booked</dd>");
  });
  it("edit mode has an input for every field", () => {
    const h = html(createElement(BriefView, { ...base, brief: BRIEF, initialEditing: true }));
    for (const l of ["Idea", "Goal", "Platform", "Length in seconds", "Aspect", "Tone", "References"]) expect(h).toContain(`aria-label="${l}"`);
    expect(h).toContain("Save brief");
  });
  it("briefPatch sends only changed fields (untouched guesses stay guessed)", () => {
    const form = { idea: BRIEF.idea, goal: "get booked", platform: "reels" as const, lengthSec: "30", aspect: "9:16" as const, tone: "warm", references: "like the spring reel" };
    expect(briefPatch(BRIEF, form)).toEqual({});
    expect(briefPatch(BRIEF, { ...form, tone: " moody ", lengthSec: "9999", references: "a, b\nc" })).toEqual({ tone: "moody", lengthSec: 600, references: ["a", "b", "c"] });
  });
  it("briefPatch: an untouched fractional length or a padded idea is not an edit (ts-4)", () => {
    const drafted = { ...BRIEF, lengthSec: 12.5, idea: "  Dance reel \n", guessed: ["lengthSec" as const] };
    const form = { idea: drafted.idea, goal: drafted.goal, platform: drafted.platform, lengthSec: String(drafted.lengthSec), aspect: drafted.aspect, tone: "moody", references: drafted.references.join(", ") };
    expect(briefPatch(drafted, form)).toEqual({ tone: "moody" });
    expect(briefPatch(drafted, { ...form, lengthSec: "14.25" })).toEqual({ tone: "moody", lengthSec: 14.3 });
  });
});

describe("Intake status line", () => {
  it("inbox path with reveal, pending, processing, last error", () => {
    const h = html(createElement(IntakeStatusView, { info: { inbox: "C:\\ai-hub\\media\\projects\\demo\\inbox", pending: 2, processing: "take3.mp4", lastError: "ffprobe failed" }, error: null, autoMatch: true, onReveal: noop, onAutoMatch: noop }));
    for (const t of ["projects\\demo\\inbox", "Reveal", "2 waiting", "processing take3.mp4", "ffprobe failed", "Auto-match"]) expect(h).toContain(t);
    expect(html(createElement(IntakeStatusView, { info: { inbox: "x", pending: 0, processing: null, lastError: null }, error: null, autoMatch: false, onReveal: noop, onAutoMatch: noop }))).toContain("Inbox empty");
    expect(html(createElement(IntakeStatusView, { info: null, error: null, autoMatch: true, onReveal: noop, onAutoMatch: noop }))).toBe("");
  });
});

describe("Shot list v2", () => {
  const slots = addSlot(addSlot(manifest(), { label: "Hook", framing: "closeup", action: "Look up", source: "film", phoneTips: ["lock exposure"] }), { label: "B-roll", source: "stock" }).shotList;
  it("phone view: big checkboxes and a filmed count", () => {
    const h = html(createElement(ShotChecklistView, { slots: [{ ...slots[0], filmed: true }, slots[1]], onToggle: noop }));
    expect(h).toContain("1 of 2 filmed");
    expect(h.match(/role="checkbox"/g)).toHaveLength(2);
    expect(h).toContain('aria-checked="true"');
    expect(h).toContain("lock exposure");
  });
  it("a slot shows framing, action, source, tips, the filmed tick and reorder controls", () => {
    const s: ShotSlot = { ...slots[0], filmed: true };
    const h = html(createElement("ul", null, createElement(ShotSlotCard, { slot: s, index: 0, count: 2, slug: "demo", asset: null })));
    for (const t of ["closeup", "Look up", ">film<", "lock exposure", "Filmed", "Drop a video"]) expect(h).toContain(t);
    expect(h).toMatch(/<input type="checkbox"[^>]*aria-label="Filmed Hook" checked=""/);
    expect(h).toMatch(/disabled=""[^>]*aria-label="Move Hook up"/);
    expect(h).not.toMatch(/disabled=""[^>]*aria-label="Move Hook down"/);
    expect(h).toContain('aria-label="Delete Hook"');
    const stock = html(createElement("ul", null, createElement(ShotSlotCard, { slot: slots[1], index: 1, count: 2, slug: "demo", asset: null })));
    expect(stock).toContain("Not attached yet (stock).");
  });
  it("slot form → patch", () => {
    expect(slotFormPatch({ label: "A", instructions: "", kind: "video", targetSec: "", framing: "", action: "go", source: "generate", phoneTips: "one\n\n two \nthree\nfour\nfive" })).toEqual({
      label: "A",
      instructions: "",
      kind: "video",
      targetSec: null,
      framing: null,
      action: "go",
      source: "generate",
      phoneTips: ["one", "two", "three", "four"],
    });
    expect(slotFormPatch({ label: "A", instructions: "", kind: "image", targetSec: "3", framing: "wide", action: "", source: "film", phoneTips: "" }).targetSec).toBe(3);
  });
});

describe("Staging bin v2", () => {
  it("pending suggestions with accept / reject each", () => {
    const h = html(
      createElement(BinSuggestionsView, {
        matches: [{ id: "mt-1", assetId: V1.id, slotId: "s1", reason: "same hook line" }],
        moments: [{ id: "ms-1", assetId: V2.id, inSec: 1, outSec: 2.5, label: "the spin", score: 0.8 }],
        assets: [V1, V2],
        slots: [{ id: "s1", label: "Hook" }],
        onMatch: noop,
        onMoment: noop,
      }),
    );
    for (const t of ["a-v1.mp4 → s1 Hook", "same hook line", "Moment in a-v2.mp4", "00:01.00–00:02.50", "the spin · 80%", 'aria-label="Accept match a-v1.mp4 to s1 Hook"', 'aria-label="Reject moment the spin"']) expect(h).toContain(t);
    expect(html(createElement(BinSuggestionsView, { matches: [], moments: [], assets: [], slots: [], onMatch: noop, onMoment: noop }))).toBe("");
  });
  it("badges: flags as warnings, the shot count, the transcript size", () => {
    const a = asset("a-x", "video", { flags: [{ kind: "clipped_audio", detail: "peak 0.0 dBFS" }], scenes: [2.5, 6], transcript: { path: "x.json", lang: "en", words: 42, firstSpeechSec: 0.5, lastSpeechSec: 9 } });
    const h = html(createElement(AssetBadges, { asset: a }));
    expect(h).toContain("clipped audio");
    expect(h).toContain('title="peak 0.0 dBFS"');
    expect(h).toContain("3 shots");
    expect(h).toContain("42w");
    expect(html(createElement(AssetBadges, { asset: asset("a-y", "video") }))).toBe("");
  });
  it("tags as removable chips", () => {
    const h = html(createElement(TagEditor, { tags: ["rain", "night"], onChange: noop }));
    expect(h).toContain('aria-label="Remove tag rain"');
    expect(h).toContain('aria-label="New tag"');
    const full = html(createElement(TagEditor, { tags: Array.from({ length: 12 }, (_, i) => `t${i}`), onChange: noop }));
    expect(full).not.toContain('aria-label="New tag"');
  });
});

describe("Review panel", () => {
  const review: ProjectReview = {
    rounds: [
      { round: 1, renderId: "r-1", notes: ["n1"], status: "revised", summary: "Opened on the spin; kept the music low." },
      { round: 2, renderId: "r-2", notes: [], status: "open", summary: "" },
    ],
    openDecisions: ["Keep the slate or cut it?"],
  };
  const props = {
    notes: [note("n1", { resolved: true }), note("n2", { atSec: 3.5, text: "tighter here" })],
    review,
    openDecisions: review.openDecisions,
    revision: null,
    placement: { renderId: "r-2", atSec: 3.5 },
    renderName: (id: string) => `${id}.mp4`,
    hasPlan: false,
    renderReady: true,
    planBusy: false,
    onAdd: async () => true,
    onSeek: noop,
    onResolve: noop,
    onApproveRevision: noop,
    onShowPlan: noop,
    onDiscardRevision: noop,
  };
  it("round, Director summary, notes (seekable, resolvable) and open decisions", () => {
    const h = html(createElement(ReviewPanelView, props));
    for (const t of ["Round 2 of 2 · open", "Director · round 1", "Opened on the spin", "tighter here", "00:03.50", "Add note at 00:03.50", "Note on r-2.mp4 at 00:03.50", "1 open", "Open decisions after round 2", "Keep the slate or cut it?"]) expect(h).toContain(t);
    // The open note comes first and is resolvable; the resolved one isn't.
    expect(h.indexOf("tighter here")).toBeLessThan(h.indexOf("note n1"));
    expect(h.match(/aria-label="Resolve note/g)).toHaveLength(1);
  });
  it("a waiting revision: Approve plan when the card is up, else Show render plan; Discard", () => {
    const rev = { round: 1 as const, resolves: ["n2"], summary: "Tightened the middle." };
    const withPlan = html(createElement(ReviewPanelView, { ...props, revision: rev, hasPlan: true }));
    expect(withPlan).toContain("Round 1 revision ready. It answers 1 note");
    expect(withPlan).toContain("Approve plan");
    expect(withPlan).toContain("Discard");
    expect(html(createElement(ReviewPanelView, { ...props, revision: rev, hasPlan: false }))).toContain("Show render plan");
    expect(html(createElement(ReviewPanelView, { ...props, revision: rev, hasPlan: true, renderReady: false }))).toMatch(/disabled=""[^>]*>.*Approve plan/);
  });
  it("before any render", () => {
    const h = html(createElement(ReviewPanelView, { ...props, notes: [], review: null, openDecisions: [], placement: { renderId: null, atSec: null } }));
    expect(h).toContain("No verified render yet");
    expect(h).toContain("No notes yet.");
    expect(h).not.toContain("Open decisions");
  });
});

describe("Outputs", () => {
  it("platform chips, preset specs, captions and colour", () => {
    const m = setOutputs(manifest(), ["reels", "self_tape"]);
    const h = html(createElement(OutputsView, { outputs: m.outputs, captions: { enabled: true, style: "bold_pop", position: "lower", maxWordsPerLine: 4 }, color: { preset: "warm", strength: 0.5 }, onOutputs: noop, onCaptions: noop, onColor: noop }));
    expect(h.match(/aria-pressed="true"/g)).toHaveLength(2);
    expect(h).toContain("9:16 · −14 LUFS · ≤ 90 s");
    expect(h).toContain("Self-tape renders without captions.");
    expect(h).toContain('aria-label="Caption style"');
    expect(h).toContain('aria-label="Colour look"');
    expect(h).toContain("50%");
  });
  it("preset spec text", () => {
    expect(presetSpec(PLATFORM_PRESETS.self_tape)).toBe("16:9 · −18 LUFS · ≤ 100 MB");
    expect(presetSpec(presetFor("custom", manifest().output))).toBe("16:9 · −16 LUFS");
  });
});

describe("Verified shelf: final approval + deliverables", () => {
  it("asks before approving, then confirms", () => {
    expect(html(createElement(FinalApprovalBar, { count: 0, confirming: false, busy: false, onConfirm: noop, onAsk: noop, onCancel: noop }))).toMatch(/disabled=""[^>]*>.*Approve final/);
    const c = html(createElement(FinalApprovalBar, { count: 2, confirming: true, busy: false, onConfirm: noop, onAsk: noop, onCancel: noop }));
    expect(c).toContain("Approve 2 renders as final?");
    expect(c).toContain("Yes, approve final");
  });
  it("deliverables with Send to Biz Ops (raises the card only)", () => {
    const r = render("r-1");
    const h = html(createElement(DeliverablesList, { deliverables: [{ platform: "reels", renderId: "r-1", path: "C:\\p\\renders\\final\\reels\\demo.mp4", captionPath: "C:\\p\\renders\\final\\reels\\demo.srt", thumbPath: null }], renders: [r], hashtags: "dance", done: true }));
    for (const t of ["Deliverables", "Reels", "demo.mp4", "captions: demo.srt", "Send to Biz Ops"]) expect(h).toContain(t);
    expect(html(createElement(DeliverablesList, { deliverables: [], renders: [], hashtags: "", done: true }))).toContain("finals are in renders/final");
    expect(html(createElement(DeliverablesList, { deliverables: [], renders: [], hashtags: "", done: false }))).toBe("");
  });
  it("default hashtags from the asset tags", () => {
    expect(defaultHashtags([["dance", "night"], ["dance"], []])).toBe("dance night");
  });
});
