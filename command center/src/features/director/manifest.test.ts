import { describe, expect, it } from "vitest";
import { ASSETS, IMG, MUS, V1, V2, asset, manifest } from "./fixtures.test-util";
import {
  addAudio,
  addClip,
  allSlotsAttached,
  applyEditPlan,
  attachSlot,
  clampRange,
  cleanOutputName,
  clipStarts,
  clipsFromShotList,
  presetManifest,
  removeAudio,
  removeClip,
  reorderClip,
  roleForKind,
  setClipAudioVolume,
  setClipFade,
  setOutput,
  setShotList,
  snapClip,
  snapLufs,
  timecode,
  timelineLength,
  trimClip,
  updateAudio,
} from "./manifest";

const three = () => addClip(addClip(addClip(manifest(), V1), V2), IMG);

describe("clampRange", () => {
  it("stills: in 0, hold clamped 0.2–60", () => {
    expect(clampRange(IMG, 5, 0.01)).toEqual({ inSec: 0, outSec: 0.2 });
    expect(clampRange(IMG, 0, 999)).toEqual({ inSec: 0, outSec: 60 });
    expect(clampRange(IMG, 0, 4.5)).toEqual({ inSec: 0, outSec: 4.5 });
  });
  it("media: 0 ≤ in < out ≤ duration", () => {
    expect(clampRange(V1, -3, 50)).toEqual({ inSec: 0, outSec: 10 });
    expect(clampRange(V1, 8, 2)).toEqual({ inSec: 8, outSec: 8.1 });
    expect(clampRange(V1, 12, 13)).toEqual({ inSec: 9.9, outSec: 10 });
    expect(clampRange(V1, NaN, NaN)).toEqual({ inSec: 0, outSec: 0.1 });
  });
  it("unknown duration is bounded, never NaN", () => {
    const r = clampRange(asset("a-x", "video", { durationSec: null }), 1, 5);
    expect(r).toEqual({ inSec: 1, outSec: 5 });
  });
});

describe("clip ops", () => {
  it("addClip: full-length media clip, 3 s still, audio goes to the audio lane", () => {
    const m = three();
    expect(m.clips.map((c) => [c.assetId, c.inSec, c.outSec])).toEqual([
      ["a-v1", 0, 10],
      ["a-v2", 0, 4],
      ["a-img", 0, 3],
    ]);
    expect(new Set(m.clips.map((c) => c.id)).size).toBe(3);
    const withMusic = addClip(m, MUS);
    expect(withMusic.clips).toHaveLength(3);
    expect(withMusic.audio).toHaveLength(1);
  });
  it("addClip inserts at an index", () => {
    const m = addClip(three(), V2, 0);
    expect(m.clips[0].assetId).toBe("a-v2");
    expect(m.clips).toHaveLength(4);
  });
  it("never mutates its input", () => {
    const m = three();
    const before = JSON.stringify(m);
    reorderClip(m, 0, 2);
    trimClip(m, m.clips[0].id, 2, 3, ASSETS);
    removeClip(m, m.clips[0].id);
    expect(JSON.stringify(m)).toBe(before);
  });
  it("reorderClip moves; out of range is a no-op (same object)", () => {
    const m = three();
    expect(reorderClip(m, 0, 2).clips.map((c) => c.assetId)).toEqual(["a-v2", "a-img", "a-v1"]);
    expect(reorderClip(m, 2, 0).clips.map((c) => c.assetId)).toEqual(["a-img", "a-v1", "a-v2"]);
    expect(reorderClip(m, 0, 9)).toBe(m);
    expect(reorderClip(m, 1, 1)).toBe(m);
  });
  it("snapClip moves a slate to the start or the end", () => {
    const m = three();
    const slate = m.clips[2].id;
    expect(snapClip(m, slate, "start").clips[0].id).toBe(slate);
    const back = snapClip(snapClip(m, slate, "start"), slate, "end");
    expect(back.clips[2].id).toBe(slate);
    expect(snapClip(m, "nope", "start")).toBe(m);
  });
  it("trimClip clamps to the asset; stills trim = hold", () => {
    const m = three();
    const [a, , s] = m.clips;
    const t = trimClip(m, a.id, 2.5, 99, ASSETS);
    expect(t.clips[0]).toMatchObject({ inSec: 2.5, outSec: 10 });
    const h = trimClip(m, s.id, 4, 75, ASSETS);
    expect(h.clips[2]).toMatchObject({ inSec: 0, outSec: 60 });
  });
  it("fade clamps 0–2000 ms; remove drops the clip", () => {
    const m = three();
    expect(setClipFade(m, m.clips[0].id, 5000).clips[0].fadeMs).toBe(2000);
    expect(setClipFade(m, m.clips[0].id, -5).clips[0].fadeMs).toBe(0);
    expect(removeClip(m, m.clips[1].id).clips.map((c) => c.assetId)).toEqual(["a-v1", "a-img"]);
  });
  it("timeline length and clip starts", () => {
    const m = three();
    expect(timelineLength(m)).toBe(17);
    expect(clipStarts(m)).toEqual([0, 10, 14]);
  });
});

describe("audio ops", () => {
  it("addAudio only takes audio assets; offset + volume clamped", () => {
    expect(addAudio(manifest(), V1, 0).audio).toHaveLength(0);
    const m = addAudio(manifest(), MUS, -4, 7);
    expect(m.audio[0]).toMatchObject({ assetId: "a-mus", startSec: 0, inSec: 0, outSec: 30, volume: 2 });
  });
  it("updateAudio clamps; removeAudio removes", () => {
    const m = addAudio(manifest(), MUS, 2);
    const id = m.audio[0].id;
    const u = updateAudio(m, id, { startSec: 5, volume: -1, outSec: 99 }, ASSETS);
    expect(u.audio[0]).toMatchObject({ startSec: 5, volume: 0, outSec: 30 });
    expect(removeAudio(u, id).audio).toHaveLength(0);
  });
  it("clip audio volume 0–2", () => {
    expect(setClipAudioVolume(manifest(), 3).clipAudioVolume).toBe(2);
    expect(setClipAudioVolume(manifest(), 0.5).clipAudioVolume).toBe(0.5);
  });
});

describe("output", () => {
  it("snaps loudness, validates aspect, caps size, cleans the name", () => {
    const m = setOutput(manifest(), { loudnessLufs: -15.2 as -16, aspect: "9:16", maxSizeMb: 99999, name: "  My cut / v2!  " });
    expect(m.output).toEqual({ aspect: "9:16", loudnessLufs: -16, maxSizeMb: 4096, name: "My_cut_v2" });
    expect(setOutput(manifest(), { aspect: "21:9" as "16:9" }).output.aspect).toBe("16:9");
    expect(setOutput(manifest(), { maxSizeMb: 0 }).output.maxSizeMb).toBeNull();
    expect(setOutput(manifest(), { maxSizeMb: null }).output.maxSizeMb).toBeNull();
  });
  it("snapLufs / cleanOutputName edges", () => {
    expect(snapLufs(-30)).toBe(-18);
    expect(snapLufs(0)).toBe(-14);
    expect(cleanOutputName("...")).toBe("render");
    expect(cleanOutputName("x".repeat(100))).toHaveLength(60);
  });
});

describe("shot list", () => {
  const slots = [
    { id: "s1", label: "Hook", instructions: "", kind: "video" as const, targetSec: 3 },
    { id: "s2", label: "Slate", instructions: "", kind: "image" as const, targetSec: null },
  ];
  it("setShotList starts slots as needed and keeps a same-kind attachment", () => {
    const m = setShotList(manifest(), slots);
    expect(m.shotList.map((s) => s.status)).toEqual(["needed", "needed"]);
    const att = attachSlot(m, "s1", V1);
    const again = setShotList(att, [{ ...slots[0] }, { ...slots[1] }]);
    expect(again.shotList[0]).toMatchObject({ assetId: "a-v1", status: "attached" });
    const changedKind = setShotList(att, [{ ...slots[0], kind: "image" }]);
    expect(changedKind.shotList[0]).toMatchObject({ assetId: null, status: "needed" });
  });
  it("attachSlot refuses a kind mismatch; null detaches", () => {
    const m = setShotList(manifest(), slots);
    expect(attachSlot(m, "s1", IMG).shotList[0].assetId).toBeNull();
    const a = attachSlot(m, "s1", V1);
    expect(attachSlot(a, "s1", null).shotList[0]).toMatchObject({ assetId: null, status: "needed" });
  });
  it("allSlotsAttached + clipsFromShotList in slot order with target lengths", () => {
    let m = setShotList(manifest(), slots);
    expect(allSlotsAttached(m)).toBe(false);
    m = attachSlot(attachSlot(m, "s1", V1), "s2", IMG);
    expect(allSlotsAttached(m)).toBe(true);
    const c = clipsFromShotList(m, ASSETS);
    expect(c.clips.map((x) => [x.assetId, x.inSec, x.outSec])).toEqual([
      ["a-v1", 0, 3],
      ["a-img", 0, 3],
    ]);
    expect(allSlotsAttached(manifest())).toBe(false);
  });
});

describe("presets + plan", () => {
  it("Quick Stitch: Clip A, Clip B, Slate at −18 LUFS", () => {
    const m = presetManifest(manifest(), "stitch", "Launch teaser");
    expect(m.shotList.map((s) => [s.label, s.kind])).toEqual([
      ["Clip A", "video"],
      ["Clip B", "video"],
      ["Slate", "image"],
    ]);
    expect(m.output).toMatchObject({ loudnessLufs: -18, name: "Launch_teaser" });
  });
  it("applyEditPlan replaces clips + audio with fresh ids and merges output", () => {
    const m = applyEditPlan(three(), { clips: [{ assetId: "a-v2", inSec: 1, outSec: 2, fadeMs: 0 }], audio: [{ assetId: "a-mus", startSec: 0, inSec: 0, outSec: 5, volume: 0.5 }], output: { aspect: "1:1" } });
    expect(m.clips).toHaveLength(1);
    expect(m.clips[0].id).toMatch(/^c-/);
    expect(m.audio[0].id).toMatch(/^au-/);
    expect(m.output.aspect).toBe("1:1");
    expect(m.output.loudnessLufs).toBe(-16);
  });
});

describe("helpers", () => {
  it("timecode mm:ss.ff", () => {
    expect(timecode(0)).toBe("00:00.00");
    expect(timecode(65.5)).toBe("01:05.50");
    expect(timecode(-1)).toBe("00:00.00");
    expect(timecode(59.999)).toBe("00:59.99");
  });
  it("roleForKind fits the kind", () => {
    expect(roleForKind("audio", "clip")).toBe("music");
    expect(roleForKind("audio", "sfx")).toBe("sfx");
    expect(roleForKind("image", "clip")).toBe("photo");
    expect(roleForKind("image", "slate")).toBe("slate");
    expect(roleForKind("video", "music")).toBe("clip");
  });
});
