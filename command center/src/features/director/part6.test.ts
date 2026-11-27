import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ShotSlot, StyleEntry } from "./contract";
import { manifest } from "./fixtures.test-util";

vi.mock("@/stores/nav", () => ({ useNav: Object.assign(() => () => undefined, { getState: () => ({ go: () => undefined }) }) }));
vi.mock("@/features/reminders/notify", () => ({ useToasts: { getState: () => ({ push: vi.fn() }) } }));

const { LAUNCHER_PRESETS, applyLauncherPreset, presetBrief, presetById } = await import("./presets");
const { presetManifest, PLATFORMS, MAX_OUTPUTS, QUICK_STARTS } = await import("./manifest");
const { EmptyStateView } = await import("./EmptyState");
const { styleLine, STYLE_LINE_MAX } = await import("./style");
const { STYLE_BUDGET } = await import("./context");
const { shotListText } = await import("./shot-print");
const { ShotChecklistView } = await import("./ShotChecklist");
const { ShotSlotCard } = await import("./ShotSlotCard");
const { brollLine, slotStillPrompt, unfilledFilmSlots, suggestChatLine, useChatDraft } = await import("./gaps");
const { versionOutputs, withVersions, VERSION_PLATFORMS } = await import("./more-versions");
const { MoreVersionsView, OutputsView } = await import("./OutputsCard");

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const noop = () => undefined;
const slot = (id: string, label: string, p: Partial<ShotSlot> = {}): ShotSlot => ({ id, label, instructions: "", kind: "video", targetSec: null, assetId: null, status: "needed", framing: "closeup", action: "Look up", source: "film", phoneTips: ["lock exposure"], filmed: false, ...p });

describe("launcher presets", () => {
  it("six presets, each a valid brief, 1–4 known outputs and a first line that asks for a shot list", () => {
    expect(LAUNCHER_PRESETS.map((p) => p.label)).toEqual(["Instagram Reel", "TikTok", "YouTube Short", "YouTube long-form", "Self-tape audition", "Demo reel"]);
    expect(new Set(LAUNCHER_PRESETS.map((p) => p.id)).size).toBe(6);
    for (const p of LAUNCHER_PRESETS) {
      expect(PLATFORMS).toContain(p.brief.platform);
      expect(p.brief.lengthSec).toBeGreaterThanOrEqual(5);
      expect(p.brief.lengthSec).toBeLessThanOrEqual(600);
      expect(p.brief.tone.length).toBeLessThanOrEqual(200);
      expect(p.outputs.length).toBeGreaterThanOrEqual(1);
      expect(p.outputs.length).toBeLessThanOrEqual(MAX_OUTPUTS);
      expect(QUICK_STARTS.map((q) => q.id)).toContain(p.quick);
      expect(p.firstLine).toMatch(/populate_shot_list/);
      expect(p.firstLine.length).toBeLessThan(300);
      expect(p.firstLine).not.toMatch(/\b(he|his|him|she|her)\b/i);
    }
  });

  it("the starter brief keeps the title as the idea, unapproved, saved as Nic's, with its guesses", () => {
    const b = presetBrief(presetById("ig_reel")!, "  Spring showcase  ", "t");
    expect(b).toEqual({ idea: "Spring showcase", goal: "", platform: "reels", lengthSec: 30, aspect: "9:16", tone: "upbeat, punchy", references: [], guessed: ["lengthSec", "tone"], approved: false, updatedBy: "nic", updatedAt: "t" });
  });

  it("outputs and the primary output follow the preset, after the quick-start template", () => {
    const self = presetById("self_tape")!;
    const m = applyLauncherPreset(presetManifest(manifest(), self.quick, "Audition"), self);
    expect(m.outputs.map((o) => o.platform)).toEqual(["self_tape"]);
    expect(m.output).toMatchObject({ aspect: "16:9", loudnessLufs: -18, maxSizeMb: 100, name: "Audition" });
    expect(m.shotList.map((s) => s.label)).toEqual(["Clip A", "Clip B", "Slate"]); // the stitch template's slots
    const demo = presetById("demo_reel")!;
    const d = applyLauncherPreset(presetManifest(manifest(), demo.quick, "Reel"), demo);
    expect(d.outputs.map((o) => o.platform)).toEqual(["youtube", "reels"]);
    expect(d.output).toMatchObject({ aspect: "16:9", loudnessLufs: -14 });
    const tt = applyLauncherPreset(manifest(), presetById("tiktok")!);
    expect(tt.output.aspect).toBe("9:16");
  });

  it("the empty state lists the presets (with the line Start sends) only when wired", () => {
    const h = html(createElement(EmptyStateView, { onQuickStart: async () => undefined, onPreset: async () => undefined, board: null }));
    expect(h).toContain('aria-label="Presets"');
    for (const p of LAUNCHER_PRESETS) expect(h).toContain(p.label);
    const bare = html(createElement(EmptyStateView, { onQuickStart: async () => undefined, board: null }));
    expect(bare).not.toContain('aria-label="Presets"');
    expect(bare).toContain("New Video Edit");
  });
});

const entry = (p: Partial<StyleEntry> = {}): StyleEntry => ({ at: "t", slug: "demo", kind: "final", revision: 1, platform: "reels", aspect: "9:16", lengthSec: 30, clips: 12, avgClipSec: 2.5, captions: "bold_pop", color: "warm", fits: [], themes: [], ...p });

describe("style memory summariser", () => {
  it("nothing to say with no entries", () => {
    expect(styleLine(null)).toBe("");
    expect(styleLine({ entries: [] })).toBe("");
  });

  it("one line: platforms, typical length, pacing, captions, look, fit and note themes", () => {
    const line = styleLine({
      entries: [entry({ themes: ["pacing", "music"] }), entry({ platform: "youtube", lengthSec: 60, avgClipSec: 4.5, fits: ["fill"], themes: ["pacing"] }), entry({ kind: "notes", lengthSec: 28, avgClipSec: 2, color: "none", captions: "off", themes: ["length"] })],
    });
    expect(line).toBe("STYLE (3 past sign-offs; the brief wins): reels ×2, youtube · ~30s · clips avg 3s · captions bold_pop · look warm · fit fill · notes often on pacing, length, music");
    expect(line.length).toBeLessThanOrEqual(STYLE_LINE_MAX);
  });

  it("never over the cap, whatever the profile holds, and the cap matches the context's", () => {
    expect(STYLE_LINE_MAX).toBe(STYLE_BUDGET);
    const long = Array.from({ length: 20 }, (_, i) => entry({ platform: `platform-${"x".repeat(30)}-${i % 2}`, captions: "c".repeat(60), color: "k".repeat(60), fits: ["blur"], themes: ["transitions", "framing", "captions"] }));
    const line = styleLine({ entries: long });
    expect(line.length).toBeLessThanOrEqual(STYLE_LINE_MAX);
    expect(line.startsWith("STYLE (20 past sign-offs")).toBe(true);
    expect(styleLine({ entries: Array.from({ length: 30 }, () => entry()) })).toMatch(/^STYLE \(20 past/);
  });

  it("a 'none' look and missing pacing are left out", () => {
    const l = styleLine({ entries: [entry({ color: "none", clips: 0, avgClipSec: 0 })] });
    expect(l).not.toContain("look");
    expect(l).not.toContain("clips avg");
    expect(l).toContain("1 past sign-off;");
  });
});

describe("phone-friendly shot list", () => {
  const slots = [slot("s1", "Hook", { targetSec: 3, filmed: true, phoneTips: ["lock exposure", "chest height"] }), slot("s2", "Spin", { framing: null, action: "", instructions: "Full turn", phoneTips: [] })];

  it("copy as text: a header with the count, [x]/[ ] per shot, framing, what to do and tips", () => {
    expect(shotListText("Winter reel", slots)).toBe(
      ["Shot list: Winter reel (1 of 2 filmed)", "[x] 1. Hook (Close-up, 3s)\n    Look up\n    - lock exposure\n    - chest height", "[ ] 2. Spin\n    Full turn"].join("\n\n"),
    );
    expect(shotListText(" ", [])).toBe("Shot list: Untitled (0 of 0 filmed)");
  });

  it("the view is one column of big tap targets with framing, action, tips, Copy and Print", () => {
    const h = html(createElement(ShotChecklistView, { slots, onToggle: noop, onCopy: async () => true, onPrint: noop }));
    expect(h).toContain('data-testid="shot-print"');
    expect(h).toContain("1 of 2 filmed");
    expect(h.match(/role="checkbox"/g)).toHaveLength(2);
    for (const t of ["Close-up", "Look up", "lock exposure", "chest height", "Full turn", "Copy as text", "Print", "text-[17px]"]) expect(h).toContain(t);
    const bare = html(createElement(ShotChecklistView, { slots, onToggle: noop }));
    expect(bare).not.toContain("Copy as text");
  });
});

describe("fill the gaps", () => {
  it("unfilled film slots only", () => {
    const m = manifest({ shotList: [slot("s1", "A"), slot("s2", "B", { assetId: "a-1", status: "attached" }), slot("s3", "C", { source: "generate" })] });
    expect(unfilledFilmSlots(m).map((s) => s.id)).toEqual(["s1"]);
  });

  it("a still prompt from framing, action and label; a B-roll line that only asks for suggestions", () => {
    expect(slotStillPrompt(slot("s1", "Hook"))).toBe("close-up shot: Look up. Hook. Cinematic, natural light.");
    expect(slotStillPrompt(slot("s1", "Hook", { framing: null, action: "" }))).toBe("shot: Hook. Cinematic, natural light.");
    expect(slotStillPrompt(slot("s1", "x", { action: "y".repeat(5000) })).length).toBeLessThanOrEqual(2000);
    const l = brollLine(slot("s4", "Street", { targetSec: 2 }));
    expect(l).toBe('Slot s4 "Street" (Close-up, 2s, Look up) has no footage. Suggest B-roll that could fill it: staged clips first, else a still to generate or a quick reshoot tip. Only suggest.');
  });

  it("an unfilled film slot offers Generate a still and Ask for B-roll; a filled or generate slot doesn't get both", () => {
    const card = (s: ShotSlot) => html(createElement("ul", null, createElement(ShotSlotCard, { slot: s, index: 0, count: 1, slug: "demo", asset: null })));
    const film = card(slot("s1", "Hook"));
    expect(film).toContain('aria-label="Generate a still for Hook"');
    expect(film).toContain('aria-label="Ask for B-roll for Hook"');
    expect(film).not.toContain("Generate…");
    const gen = card(slot("s1", "Sky", { source: "generate", kind: "image" }));
    expect(gen).not.toContain("Ask for B-roll");
    expect(film).not.toContain("Â");
  });

  it("a suggested chat line only lands in the draft store (bumping n each time)", () => {
    suggestChatLine("one");
    suggestChatLine("two");
    expect(useChatDraft.getState().draft).toEqual({ text: "two", n: 2 });
  });
});

describe("versions on demand", () => {
  it("adds other platforms, replaces the placeholder custom output, and refuses past four or nothing new", () => {
    expect(versionOutputs(["reels"], ["tiktok", "youtube"])).toEqual({ platforms: ["reels", "tiktok", "youtube"], added: ["tiktok", "youtube"] });
    expect(versionOutputs(["custom"], ["reels"])).toEqual({ platforms: ["reels"], added: ["reels"] });
    expect(versionOutputs(["reels"], ["reels"])).toEqual({ error: "Those formats are already in Outputs." });
    expect(versionOutputs(["reels", "tiktok", "youtube"], ["self_tape", "shorts"])).toEqual({ error: "Up to 4 formats per render: 5 picked." });
    const r = withVersions(manifest({ outputs: [{ platform: "reels", aspect: "9:16", loudnessLufs: -14, maxSizeMb: null, maxSec: 90 }] }), ["self_tape"]);
    expect("manifest" in r && r.manifest.outputs.map((o) => [o.platform, o.aspect, o.loudnessLufs])).toEqual([
      ["reels", "9:16", -14],
      ["self_tape", "16:9", -18],
    ]);
    expect(VERSION_PLATFORMS).toEqual(["reels", "tiktok", "youtube", "self_tape"]);
  });

  it("the picker lists only formats not in Outputs and starts with nothing picked", () => {
    const h = html(createElement(MoreVersionsView, { outputs: ["reels"], busy: false, onPlan: noop }));
    expect(h).toContain('aria-label="More versions"');
    expect(h).toContain("TikTok");
    expect(h).not.toMatch(/>Reels</);
    expect(h).toMatch(/disabled=""[^>]*>.*Plan version/);
    expect(html(createElement(MoreVersionsView, { outputs: [...VERSION_PLATFORMS], busy: false, onPlan: noop }))).toBe("");
    const card = html(createElement(OutputsView, { outputs: [], captions: manifest().captions, color: manifest().color, onOutputs: noop, onCaptions: noop, onColor: noop }));
    expect(card).not.toContain("More versions");
  });
});
