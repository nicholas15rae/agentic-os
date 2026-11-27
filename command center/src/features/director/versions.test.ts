import { describe, expect, it } from "vitest";
import type { TimelineClip, VerifiedRender } from "./contract";
import { manifest } from "./fixtures.test-util";
import { DIFF_MAX_LINES, diffSummary, renderVersion, sameCut, syncFollower, versionLabel, versionRows } from "./versions";

const clip = (id: string, assetId: string, inSec: number, outSec: number, p: Partial<TimelineClip> = {}): TimelineClip => ({ id, assetId, inSec, outSec, fadeMs: 0, transitionIn: { kind: "cut", ms: 0 }, punchIn: 1, ...p });
const render = (id: string, planId: string, path: string, createdAt: string): VerifiedRender => ({ id, project: "demo", planId, path, durationSec: 28, width: 1080, height: 1920, sizeBytes: 1_000_000, loudnessLufs: -14, verify: { ok: true, checks: [] }, createdAt });

describe("renderVersion", () => {
  it("reads _vNNN from the file name", () => {
    expect(renderVersion("renders/demo_v003.mp4")).toBe(3);
    expect(renderVersion("C:\\x\\renders\\demo-reels_v012.mp4")).toBe(12);
    expect(renderVersion("renders/demo.mp4")).toBeNull();
    expect(renderVersion("renders_v2/demo.mp4")).toBeNull();
    expect(versionLabel("renders/demo_v003.mp4")).toBe("v003");
    expect(versionLabel("renders/demo.mp4")).toBe("—");
  });
});

describe("versionRows", () => {
  it("sorts newest first, marks the plans given as current and one restore target per plan", () => {
    const rows = versionRows([
      render("r1", "p-1", "renders/demo_v001.mp4", "2026-11-20T00:00:00Z"),
      render("r3", "p-3", "renders/demo-reels_v003.mp4", "2026-11-22T00:00:01Z"),
      render("r2", "p-2", "renders/demo_v002.mp4", "2026-11-21T00:00:00Z"),
      render("r3b", "p-3", "renders/demo-youtube_v003.mp4", "2026-11-22T00:00:00Z"),
    ], new Set(["p-2"]));
    expect(rows.map((r) => r.renderId)).toEqual(["r3", "r3b", "r2", "r1"]);
    expect(rows.map((r) => r.current)).toEqual([false, false, true, false]); // not simply the newest
    expect(rows.map((r) => r.primary)).toEqual([true, false, true, true]);
    expect(rows[2]).toMatchObject({ version: 2, name: "demo_v002.mp4", planId: "p-2", durationSec: 28, width: 1080, height: 1920 });
    expect(versionRows([])).toEqual([]);
  });
});

describe("diffSummary", () => {
  const A = manifest({ clips: [clip("c1", "beach", 0, 3), clip("c2", "spin", 1, 4)] });
  const names = { beach: "beach.mp4", spin: "spin.mp4", hop: "hop.mp4", song: "song.mp3", vo: "vo_v001.webm" };

  it("same cut (ids, revision, notes, shot list and updatedAt ignored)", () => {
    const B = { ...A, revision: 9, updatedAt: "x", updatedBy: "director" as const, clips: A.clips.map((c) => ({ ...c, id: `${c.id}-new` })), shotList: [{ id: "s1", label: "Hook", instructions: "", kind: "video" as const, targetSec: 3, assetId: null, status: "needed" as const, framing: null, action: "", source: "film" as const, phoneTips: [], filmed: false }] };
    expect(diffSummary(A, B, names)).toEqual({ same: true, lines: ["Same cut"] });
  });

  it("clips added, removed, reordered and trimmed", () => {
    const added = diffSummary(A, { ...A, clips: [...A.clips, clip("c3", "hop", 0, 2)] }, names);
    expect(added.lines).toContain("1 clip added (hop.mp4)");
    expect(added.lines).toContain("length 0:06 → 0:08");
    expect(diffSummary(A, { ...A, clips: [A.clips[0]] }, names).lines[0]).toBe("1 clip removed (spin.mp4)");
    expect(diffSummary(A, { ...A, clips: [A.clips[1], A.clips[0]] }, names).lines).toEqual(["order changed"]);
    const trimmed = diffSummary(A, { ...A, clips: [A.clips[0], { ...A.clips[1], outSec: 3.4 }] }, names);
    expect(trimmed.lines).toContain("clip 2 trimmed 3.0s → 2.4s");
    expect(diffSummary(A, { ...A, clips: [clip("x", "beach", 0, 3)] }).lines[0]).toBe("1 clip removed (spin)");
  });

  it("audio, looks, outputs and aspect", () => {
    const B = manifest({
      clips: A.clips,
      audio: [{ id: "l1", assetId: "song", startSec: 0, inSec: 0, outSec: 6, volume: 1, fadeInMs: 0, fadeOutMs: 0, duckUnderVoice: false }],
      captions: { enabled: true, style: "bold_pop", position: "lower", maxWordsPerLine: 4 },
      color: { preset: "film", strength: 0.5 },
      outputs: [...A.outputs, { platform: "youtube", aspect: "16:9", loudnessLufs: -14, maxSizeMb: null, maxSec: null }],
      output: { ...A.output, aspect: "9:16" },
    });
    const A2 = { ...A, color: { preset: "warm" as const, strength: 0.5 } };
    const d = diffSummary(A2, B, names, { song: "music" });
    expect(d.same).toBe(false);
    expect(d.lines).toEqual(expect.arrayContaining(["music added (song.mp3)", "captions on (bold pop)", "colour warm → film", "outputs + youtube", "aspect 16:9 → 9:16"]));
    const vo = (volume: number) => manifest({ clips: A.clips, audio: [{ id: "l", assetId: "vo", startSec: 0, inSec: 0, outSec: 3, volume, fadeInMs: 0, fadeOutMs: 0, duckUnderVoice: false }] });
    expect(diffSummary(vo(1), vo(0.8), names, { vo: "voiceover" }).lines).toEqual(["voiceover volume 1.0 → 0.8"]);
    expect(diffSummary(vo(1), { ...vo(1), audio: [] }, names).lines).toEqual(["audio removed (vo_v001.webm)"]);
  });

  it("names the restored fields it used to miss, and only calls it the same cut when restore changes nothing", () => {
    const withMusic = (p: Partial<{ fadeInMs: number; fadeOutMs: number; duckUnderVoice: boolean }> = {}) =>
      manifest({ clips: A.clips, audio: [{ id: "l1", assetId: "song", startSec: 0, inSec: 0, outSec: 6, volume: 1, fadeInMs: 0, fadeOutMs: 0, duckUnderVoice: false, ...p }] });
    expect(diffSummary(withMusic(), withMusic({ fadeOutMs: 1500 }), names, { song: "music" }).lines).toEqual(["music fades changed"]);
    expect(diffSummary(withMusic(), withMusic({ duckUnderVoice: true }), names, { song: "music" }).lines).toEqual(["music ducking on"]);
    const xf = (ms: number) => manifest({ clips: [A.clips[0], { ...A.clips[1], transitionIn: { kind: "crossfade", ms } }] });
    expect(diffSummary(xf(300), xf(800), names).lines).toEqual(["clip 2 crossfade 300 → 800 ms"]);
    const cap = diffSummary(A, { ...A, output: { ...A.output, maxSizeMb: 50 } });
    expect(cap).toEqual({ same: false, lines: ["size cap none → 50 MB"] });
    const plat = { ...A.outputs[0], maxSec: 60 };
    expect(diffSummary(A, { ...A, outputs: [plat, ...A.outputs.slice(1)] }).lines).toEqual([`${plat.platform} settings changed`]);
    // A sub-tolerance trim: no named line, but not the same cut either.
    const tiny = { ...A, clips: [A.clips[0], { ...A.clips[1], outSec: 4.01 }] };
    expect(diffSummary(A, tiny)).toEqual({ same: false, lines: ["small settings changed"] });
    expect(sameCut(A, tiny)).toBe(false);
    // Ids, the output name, colour strength without a preset and caption style while off don't count.
    const B = { ...A, clips: A.clips.map((c) => ({ ...c, id: `${c.id}x` })), output: { ...A.output, name: "other" }, color: { preset: "none" as const, strength: 0.9 }, captions: { ...A.captions, enabled: false, style: "karaoke" as const } };
    const A0 = { ...A, color: { preset: "none" as const, strength: 0.2 }, captions: { ...A.captions, enabled: false } };
    expect(sameCut(A0, B)).toBe(true);
  });

  it("caps at 8 lines, then +N more", () => {
    const cut = (out: number) => manifest({ clips: Array.from({ length: 12 }, (_, i) => clip(`c${i}`, `x${i}`, 0, out)) });
    const d = diffSummary(cut(1), cut(2));
    expect(d.lines).toHaveLength(DIFF_MAX_LINES + 1);
    expect(d.lines[DIFF_MAX_LINES]).toMatch(/^\+\d+ more$/);
  });
});

describe("syncFollower", () => {
  const clock = (paused: boolean, currentTime: number, duration = 30) => ({ paused, currentTime, duration });
  it("seeks only past the tolerance", () => {
    expect(syncFollower(clock(true, 5), clock(true, 5.1))).toEqual({ seekTo: null, play: null });
    expect(syncFollower(clock(true, 5), clock(true, 5.3))).toEqual({ seekTo: 5, play: null });
    expect(syncFollower(clock(true, 5), clock(true, 5.3), 0.5)).toEqual({ seekTo: null, play: null });
  });
  it("plays and pauses with the leader", () => {
    expect(syncFollower(clock(false, 2), clock(true, 2))).toEqual({ seekTo: null, play: true });
    expect(syncFollower(clock(true, 2), clock(false, 2))).toEqual({ seekTo: null, play: false });
    expect(syncFollower(clock(false, 2), clock(false, 2))).toEqual({ seekTo: null, play: null });
  });
  it("a shorter follower clamps at its end and stops", () => {
    expect(syncFollower(clock(false, 25), clock(false, 10, 20))).toEqual({ seekTo: 20, play: false });
    expect(syncFollower(clock(false, 25), clock(true, 20, 20))).toEqual({ seekTo: null, play: null });
    // Unknown follower duration (metadata not loaded): follow the leader.
    expect(syncFollower(clock(false, 3), clock(true, 0, NaN))).toEqual({ seekTo: 3, play: true });
  });
});
