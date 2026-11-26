import { describe, expect, it } from "vitest";
import type { Note } from "./contract";
import { V1, asset, manifest, project } from "./fixtures.test-util";
import {
  addAudio,
  addClip,
  addSlot,
  applyEditPlan,
  attachSlot,
  filmSlotsFilled,
  moveSlot,
  nextSlotId,
  openNotes,
  PLATFORM_PRESETS,
  platformWantsCaptions,
  presetFor,
  presetManifest,
  removeSlot,
  setCaptions,
  setClipPunchIn,
  setClipTransition,
  setColor,
  setOutputs,
  setShotList,
  toggleFilmed,
  updateAudio,
  updateSlot,
  upgradeAsset,
  upgradeManifest,
  upgradeProject,
  upgradeStatus,
  withNote,
  withNoteResolved,
} from "./manifest";

/** A manifest exactly as v1 wrote it to working/timeline_manifest.json. */
const V1_MANIFEST = {
  version: 1,
  project: "old",
  revision: 7,
  clips: [{ id: "c1", assetId: "a-v1", inSec: 1, outSec: 4, fadeMs: 200 }],
  audio: [{ id: "au1", assetId: "a-mus", startSec: 0, inSec: 0, outSec: 5, volume: 0.8 }],
  clipAudioVolume: 0.5,
  output: { aspect: "9:16", loudnessLufs: -18, maxSizeMb: 100, name: "old" },
  shotList: [{ id: "s1", label: "Hook", instructions: "", kind: "video", targetSec: 3, assetId: "a-v1", status: "attached" }],
  updatedBy: "director",
  updatedAt: "2026-11-22T00:00:00Z",
};

describe("v1 → v2 upgrade on read", () => {
  it("a v1 manifest loads as v2 with defaults and keeps every v1 value", () => {
    const m = upgradeManifest(V1_MANIFEST);
    expect(m.version).toBe(2);
    expect(m).toMatchObject({ project: "old", revision: 7, clipAudioVolume: 0.5, updatedBy: "director", output: V1_MANIFEST.output });
    expect(m.clips[0]).toEqual({ ...V1_MANIFEST.clips[0], transitionIn: { kind: "cut", ms: 0 }, punchIn: 1 });
    expect(m.audio[0]).toEqual({ ...V1_MANIFEST.audio[0], fadeInMs: 0, fadeOutMs: 0, duckUnderVoice: false });
    expect(m.shotList[0]).toEqual({ ...V1_MANIFEST.shotList[0], framing: null, action: "", source: "film", phoneTips: [], filmed: false });
    expect(m.captions).toEqual({ enabled: false, style: "clean", position: "lower", maxWordsPerLine: 4 });
    expect(m.color).toEqual({ preset: "none", strength: 0.5 });
    // The v1 output becomes the single (custom) output.
    expect(m.outputs).toEqual([{ platform: "custom", aspect: "9:16", loudnessLufs: -18, maxSizeMb: 100, maxSec: null }]);
    expect(m.notes).toEqual([]);
  });
  it("a v2 manifest passes through unchanged; garbage reads as an empty v2 manifest", () => {
    const v2 = manifest({ captions: { enabled: true, style: "karaoke", position: "middle", maxWordsPerLine: 3 } });
    expect(upgradeManifest(v2)).toEqual(v2);
    const empty = upgradeManifest(null);
    expect(empty).toMatchObject({ version: 2, clips: [], audio: [], shotList: [], notes: [], output: { aspect: "16:9", loudnessLufs: -16 } });
    expect(empty.outputs).toHaveLength(1);
  });
  it("status: intake→brief, awaiting_media→shooting, rendering→editing, ready→review", () => {
    expect(["intake", "awaiting_media", "editing", "rendering", "ready"].map(upgradeStatus)).toEqual(["brief", "shooting", "editing", "editing", "review"]);
    expect(upgradeStatus("done")).toBe("done");
    expect(upgradeStatus("nonsense")).toBe("brief");
  });
  it("a v1 project row gains brief null + speed rough; a v1 asset row gains empty v2 fields", () => {
    const { brief: _b, speed: _s, ...v1 } = project({ status: "ready" as never });
    expect(upgradeProject(v1)).toMatchObject({ status: "review", brief: null, speed: "rough", source: { from: "suite" } });
    expect(upgradeProject({ ...v1, speed: "polish" }).speed).toBe("polish");
    const { tags: _t, transcript: _tr, flags: _f, moments: _m, slotId: _sl, ...a1 } = asset("a-x", "video");
    expect(upgradeAsset(a1)).toMatchObject({ id: "a-x", tags: [], transcript: null, flags: [], moments: [], slotId: null });
  });
  it("keeps scene cut times (numbers only, ≤ 200); missing reads as null", () => {
    expect(upgradeAsset({ id: "a-x" }).scenes).toBeNull();
    expect(upgradeAsset({ id: "a-x", scenes: [] }).scenes).toEqual([]);
    expect(upgradeAsset({ id: "a-x", scenes: [1.2, "x", Number.NaN, 3.4] }).scenes).toEqual([1.2, 3.4]);
    expect(upgradeAsset({ id: "a-x", scenes: Array.from({ length: 250 }, (_, i) => i + 1) }).scenes).toHaveLength(200);
  });
});

describe("platform presets", () => {
  it("match the contract table", () => {
    expect(PLATFORM_PRESETS.reels).toEqual({ platform: "reels", aspect: "9:16", loudnessLufs: -14, maxSizeMb: null, maxSec: 90 });
    expect(PLATFORM_PRESETS.tiktok).toMatchObject({ aspect: "9:16", loudnessLufs: -14, maxSec: 90 });
    expect(PLATFORM_PRESETS.ig_feed).toMatchObject({ aspect: "4:5", loudnessLufs: -14, maxSec: 60 });
    expect(PLATFORM_PRESETS.youtube).toMatchObject({ aspect: "16:9", loudnessLufs: -14, maxSec: null });
    expect(PLATFORM_PRESETS.shorts).toMatchObject({ aspect: "9:16", loudnessLufs: -14, maxSec: 60 });
    expect(PLATFORM_PRESETS.self_tape).toEqual({ platform: "self_tape", aspect: "16:9", loudnessLufs: -18, maxSizeMb: 100, maxSec: null });
    expect(platformWantsCaptions("self_tape")).toBe(false);
    expect(platformWantsCaptions("reels")).toBe(true);
    expect(presetFor("custom", { aspect: "1:1", loudnessLufs: -16, maxSizeMb: 50, name: "x" })).toEqual({ platform: "custom", aspect: "1:1", loudnessLufs: -16, maxSizeMb: 50, maxSec: null });
  });
  it("setOutputs: 1–4, deduped, unknowns dropped, empty → one custom", () => {
    const m = setOutputs(manifest(), ["reels", "reels", "youtube", "bogus" as never, "shorts", "ig_feed", "tiktok"]);
    expect(m.outputs.map((o) => o.platform)).toEqual(["reels", "youtube", "shorts", "ig_feed"]);
    expect(setOutputs(manifest(), []).outputs.map((o) => o.platform)).toEqual(["custom"]);
  });
});

describe("shot list ops (v2)", () => {
  const base = () => setShotList(manifest(), [{ id: "s1", label: "Hook", instructions: "", kind: "video", targetSec: 3 }]);
  it("setShotList defaults v2 detail fields and keeps the filmed tick for the same id", () => {
    const m = toggleFilmed(base(), "s1");
    expect(m.shotList[0]).toMatchObject({ framing: null, action: "", source: "film", phoneTips: [], filmed: true });
    const again = setShotList(m, [{ id: "s1", label: "Hook 2", instructions: "", kind: "video", targetSec: 3, framing: "closeup", phoneTips: ["a", "b", "c", "d", "e"] }]);
    expect(again.shotList[0]).toMatchObject({ label: "Hook 2", framing: "closeup", filmed: true });
    expect(again.shotList[0].phoneTips).toHaveLength(4);
  });
  it("addSlot picks the next free id, clamps, caps at 30", () => {
    const m = addSlot(base(), { label: "  ", kind: "image", targetSec: 9999, framing: "bogus" as never, source: "stock" });
    expect(m.shotList[1]).toMatchObject({ id: "s2", label: "Shot 2", kind: "image", targetSec: 600, framing: null, source: "stock", assetId: null, status: "needed", filmed: false });
    expect(nextSlotId({ shotList: [{ ...m.shotList[0], id: "s2" }] })).toBe("s3");
    let full = manifest();
    for (let i = 0; i < 35; i++) full = addSlot(full);
    expect(full.shotList).toHaveLength(30);
    expect(addSlot(base(), {}, 0).shotList[0].id).toBe("s2");
  });
  it("updateSlot clamps and detaches on a kind change", () => {
    const att = attachSlot(base(), "s1", V1);
    const u = updateSlot(att, "s1", { action: "walk in", phoneTips: ["lock exposure"], framing: "wide", targetSec: null });
    expect(u.shotList[0]).toMatchObject({ action: "walk in", phoneTips: ["lock exposure"], framing: "wide", targetSec: null, assetId: "a-v1", status: "attached" });
    expect(updateSlot(att, "s1", { kind: "image" }).shotList[0]).toMatchObject({ kind: "image", assetId: null, status: "needed" });
    expect(updateSlot(att, "s1", { label: "" }).shotList[0].label).toBe("Hook");
  });
  it("moveSlot / removeSlot / filmSlotsFilled", () => {
    let m = addSlot(addSlot(base(), { label: "B" }), { label: "C", source: "generate" });
    expect(moveSlot(m, 2, 0).shotList.map((s) => s.label)).toEqual(["C", "Hook", "B"]);
    expect(moveSlot(m, 5, 0)).toBe(m);
    expect(removeSlot(m, "s2").shotList.map((s) => s.id)).toEqual(["s1", "s3"]);
    expect(filmSlotsFilled(m)).toBe(false);
    m = attachSlot(attachSlot(m, "s1", V1), "s2", V1);
    expect(filmSlotsFilled(m)).toBe(true); // the "generate" slot doesn't count
    expect(filmSlotsFilled(manifest())).toBe(false);
  });
  it("quick-start slots carry the v2 defaults", () => {
    expect(presetManifest(manifest(), "stitch", "x").shotList.every((s) => s.source === "film" && s.filmed === false && Array.isArray(s.phoneTips))).toBe(true);
  });
});

describe("edit fields (v2)", () => {
  it("new clips/audio carry defaults; transition, punch-in and audio fades clamp", () => {
    let m = addClip(manifest(), V1);
    expect(m.clips[0]).toMatchObject({ transitionIn: { kind: "cut", ms: 0 }, punchIn: 1 });
    const id = m.clips[0].id;
    expect(setClipTransition(m, id, "crossfade", 9000).clips[0].transitionIn).toEqual({ kind: "crossfade", ms: 1500 });
    expect(setClipTransition(m, id, "cut", 500).clips[0].transitionIn).toEqual({ kind: "cut", ms: 0 });
    expect(setClipPunchIn(m, id, 3).clips[0].punchIn).toBe(1.5);
    expect(setClipPunchIn(m, id, 0.5).clips[0].punchIn).toBe(1);
    const mus = asset("a-mus", "audio", { durationSec: 30 });
    m = addAudio(m, mus, 0);
    expect(m.audio[0]).toMatchObject({ fadeInMs: 0, fadeOutMs: 0, duckUnderVoice: false });
    const u = updateAudio(m, m.audio[0].id, { fadeInMs: -5, fadeOutMs: 99_999, duckUnderVoice: true }, [mus]);
    expect(u.audio[0]).toMatchObject({ fadeInMs: 0, fadeOutMs: 10_000, duckUnderVoice: true });
  });
  it("captions / color clamp; applyEditPlan fills v2 defaults and applies captions/color/outputs", () => {
    expect(setCaptions(manifest(), { enabled: true, maxWordsPerLine: 40, style: "bogus" as never }).captions).toEqual({ enabled: true, style: "clean", position: "lower", maxWordsPerLine: 12 });
    expect(setColor(manifest(), { preset: "warm", strength: 2 }).color).toEqual({ preset: "warm", strength: 1 });
    const m = applyEditPlan(manifest(), { clips: [{ assetId: "a-v1", inSec: 0, outSec: 2, fadeMs: 0, transitionIn: { kind: "fade_black", ms: 400 } }], audio: [], output: {}, captions: { enabled: true }, color: { preset: "film" }, outputs: ["reels", "youtube"] });
    expect(m.clips[0]).toMatchObject({ transitionIn: { kind: "fade_black", ms: 400 }, punchIn: 1 });
    expect(m.captions.enabled).toBe(true);
    expect(m.color.preset).toBe("film");
    expect(m.outputs.map((o) => o.platform)).toEqual(["reels", "youtube"]);
  });
});

describe("notes (applied locally from the IPC result)", () => {
  const note = (id: string, renderId: string | null = "r-1"): Note => ({ id, renderId, atSec: 2, text: "tighter", by: "nic", viaVoice: false, resolved: false, at: "" });
  it("withNote is idempotent; resolve hides it from openNotes", () => {
    let m = withNote(withNote(manifest(), note("n1")), note("n1"));
    m = withNote(m, note("n2", "r-2"));
    expect(m.notes).toHaveLength(2);
    expect(openNotes(m, "r-1").map((n) => n.id)).toEqual(["n1"]);
    m = withNoteResolved(m, "n1");
    expect(openNotes(m).map((n) => n.id)).toEqual(["n2"]);
  });
});
