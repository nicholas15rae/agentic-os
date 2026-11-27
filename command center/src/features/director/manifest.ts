/**
 * Pure edit operations on the timeline manifest (contract `TimelineManifest`). Every op returns a
 * NEW manifest (never mutates) and clamps to the manifest rules, so whatever the UI or the
 * Director asks for, what gets saved is valid. `revision` / `updatedBy` / `updatedAt` are the
 * save path's job (director-store), not these ops'.
 */
import type { AssetRole, AudioLayer, MediaAsset, ShotSlot, TimelineClip, TimelineManifest } from "./contract";

export const STILL_MIN = 0.2;
export const STILL_MAX = 60;
export const STILL_DEFAULT = 3;
export const MIN_CLIP = 0.1;
export const FADE_MAX = 2000;
export const VOLUME_MAX = 2;
export const LUFS = [-14, -16, -18] as const;
export const ASPECTS = ["16:9", "9:16", "4:5", "1:1"] as const;
/** Upper bound for a media file whose duration ffprobe couldn't read (24 h). */
const UNKNOWN_DURATION = 86_400;

export const clamp = (n: number, lo: number, hi: number) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo);
const round3 = (n: number) => Math.round(n * 1000) / 1000;

let seq = 0;
/** "c-<base36>" style ids, unique within a session. */
export function newId(prefix: string): string {
  seq = (seq + 1) % 1296;
  return `${prefix}-${Date.now().toString(36)}${seq.toString(36).padStart(2, "0")}`;
}

export const isStill = (a: Pick<MediaAsset, "kind"> | undefined | null) => a?.kind === "image";
const durationOf = (a: MediaAsset | undefined) => (a?.durationSec && a.durationSec > 0 ? a.durationSec : UNKNOWN_DURATION);

/** Clamp an in/out pair to an asset: stills = in 0, out = hold 0.2–60 s; media = 0 ≤ in < out ≤ duration. */
export function clampRange(asset: MediaAsset | undefined, inSec: number, outSec: number): { inSec: number; outSec: number } {
  if (isStill(asset)) return { inSec: 0, outSec: round3(clamp(outSec, STILL_MIN, STILL_MAX)) };
  const dur = durationOf(asset);
  const minLen = Math.min(MIN_CLIP, dur);
  const i = clamp(inSec, 0, Math.max(0, dur - minLen));
  const o = clamp(outSec, i + minLen, dur);
  return { inSec: round3(i), outSec: round3(o) };
}

export const clipLength = (c: Pick<TimelineClip, "inSec" | "outSec">) => Math.max(0, c.outSec - c.inSec);
export const timelineLength = (m: TimelineManifest) => m.clips.reduce((t, c) => t + clipLength(c), 0);

/** Where each clip starts on the timeline (seconds), in order. */
export function clipStarts(m: TimelineManifest): number[] {
  let t = 0;
  return m.clips.map((c) => {
    const s = t;
    t += clipLength(c);
    return s;
  });
}

const assetMap = (assets: MediaAsset[]) => new Map(assets.map((a) => [a.id, a]));

export function makeClip(asset: MediaAsset, inSec?: number, outSec?: number, fadeMs = 0): TimelineClip {
  const r = isStill(asset) ? clampRange(asset, 0, outSec ?? STILL_DEFAULT) : clampRange(asset, inSec ?? 0, outSec ?? durationOf(asset));
  return { id: newId("c"), assetId: asset.id, ...r, fadeMs: clamp(Math.round(fadeMs), 0, FADE_MAX) };
}

/** Append (or insert at `index`) a clip of `asset`. Audio assets go on the audio lane instead. */
export function addClip(m: TimelineManifest, asset: MediaAsset, index?: number): TimelineManifest {
  if (asset.kind === "audio") return addAudio(m, asset, 0);
  const clip = makeClip(asset);
  const clips = [...m.clips];
  clips.splice(index == null ? clips.length : clamp(index, 0, clips.length), 0, clip);
  return { ...m, clips };
}

/** Move the clip at `from` to `to` (drag-reorder). Out-of-range indexes are a no-op. */
export function reorderClip(m: TimelineManifest, from: number, to: number): TimelineManifest {
  if (from === to || from < 0 || from >= m.clips.length || to < 0 || to >= m.clips.length) return m;
  const clips = [...m.clips];
  const [c] = clips.splice(from, 1);
  clips.splice(to, 0, c);
  return { ...m, clips };
}

/** Slate snap: move a clip to the very start or end of the timeline. */
export function snapClip(m: TimelineManifest, clipId: string, edge: "start" | "end"): TimelineManifest {
  const i = m.clips.findIndex((c) => c.id === clipId);
  if (i < 0) return m;
  return reorderClip(m, i, edge === "start" ? 0 : m.clips.length - 1);
}

export function trimClip(m: TimelineManifest, clipId: string, inSec: number, outSec: number, assets: MediaAsset[]): TimelineManifest {
  const byId = assetMap(assets);
  return { ...m, clips: m.clips.map((c) => (c.id === clipId ? { ...c, ...clampRange(byId.get(c.assetId), inSec, outSec) } : c)) };
}

export function setClipFade(m: TimelineManifest, clipId: string, fadeMs: number): TimelineManifest {
  return { ...m, clips: m.clips.map((c) => (c.id === clipId ? { ...c, fadeMs: clamp(Math.round(fadeMs), 0, FADE_MAX) } : c)) };
}

export function removeClip(m: TimelineManifest, clipId: string): TimelineManifest {
  return { ...m, clips: m.clips.filter((c) => c.id !== clipId) };
}

export function addAudio(m: TimelineManifest, asset: MediaAsset, startSec: number, volume = 1): TimelineManifest {
  if (asset.kind !== "audio") return m;
  const r = clampRange(asset, 0, durationOf(asset));
  const layer: AudioLayer = { id: newId("au"), assetId: asset.id, startSec: round3(clamp(startSec, 0, UNKNOWN_DURATION)), ...r, volume: round3(clamp(volume, 0, VOLUME_MAX)) };
  return { ...m, audio: [...m.audio, layer] };
}

export function updateAudio(m: TimelineManifest, layerId: string, patch: Partial<Omit<AudioLayer, "id" | "assetId">>, assets: MediaAsset[]): TimelineManifest {
  const byId = assetMap(assets);
  return {
    ...m,
    audio: m.audio.map((l) => {
      if (l.id !== layerId) return l;
      const next = { ...l, ...patch };
      const r = clampRange(byId.get(l.assetId), next.inSec, next.outSec);
      return { ...next, ...r, startSec: round3(clamp(next.startSec, 0, UNKNOWN_DURATION)), volume: round3(clamp(next.volume, 0, VOLUME_MAX)) };
    }),
  };
}

export function removeAudio(m: TimelineManifest, layerId: string): TimelineManifest {
  return { ...m, audio: m.audio.filter((l) => l.id !== layerId) };
}

export function setClipAudioVolume(m: TimelineManifest, v: number): TimelineManifest {
  return { ...m, clipAudioVolume: round3(clamp(v, 0, VOLUME_MAX)) };
}

/** Nearest allowed loudness target (−14 / −16 / −18 LUFS). */
export function snapLufs(n: number): TimelineManifest["output"]["loudnessLufs"] {
  return LUFS.reduce((best, l) => (Math.abs(l - n) < Math.abs(best - n) ? l : best), LUFS[2] as TimelineManifest["output"]["loudnessLufs"]);
}

/** Output name: file-name safe, ≤ 60 chars, never empty. */
export function cleanOutputName(s: string): string {
  const n = s
    .trim()
    .replace(/[^A-Za-z0-9 _.-]+/g, "")
    .replace(/\s+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 60);
  return n || "render";
}

export function setOutput(m: TimelineManifest, patch: Partial<TimelineManifest["output"]>): TimelineManifest {
  const o = { ...m.output };
  if (patch.aspect !== undefined && (ASPECTS as readonly string[]).includes(patch.aspect)) o.aspect = patch.aspect;
  if (patch.loudnessLufs !== undefined) o.loudnessLufs = snapLufs(patch.loudnessLufs);
  if (patch.maxSizeMb !== undefined) o.maxSizeMb = patch.maxSizeMb == null || !Number.isFinite(patch.maxSizeMb) || patch.maxSizeMb <= 0 ? null : Math.round(clamp(patch.maxSizeMb, 1, 4096));
  if (patch.name !== undefined) o.name = cleanOutputName(patch.name);
  return { ...m, output: o };
}

// ── Shot list ────────────────────────────────────────────────────────────────

/** Replace the shot list (a Director `populate_shot_list`); a slot keeps its attachment when the
 * same id comes back with the same kind. */
export function setShotList(m: TimelineManifest, slots: Omit<ShotSlot, "assetId" | "status">[]): TimelineManifest {
  const old = new Map(m.shotList.map((s) => [s.id, s]));
  return {
    ...m,
    shotList: slots.map((s) => {
      const prev = old.get(s.id);
      const keep = prev && prev.kind === s.kind && prev.assetId;
      return { ...s, assetId: keep ? prev.assetId : null, status: keep ? prev.status : "needed" };
    }),
  };
}

/** Attach an asset to a slot (null detaches). A kind mismatch is refused (no-op). */
export function attachSlot(m: TimelineManifest, slotId: string, asset: MediaAsset | null): TimelineManifest {
  return {
    ...m,
    shotList: m.shotList.map((s) => {
      if (s.id !== slotId) return s;
      if (!asset) return { ...s, assetId: null, status: "needed" };
      if (asset.kind !== s.kind) return s;
      return { ...s, assetId: asset.id, status: "attached" };
    }),
  };
}

export const allSlotsAttached = (m: TimelineManifest) => m.shotList.length > 0 && m.shotList.every((s) => s.assetId && s.status !== "needed");

/** "Assemble with Director": one clip per attached slot, in slot order (target length respected). */
export function clipsFromShotList(m: TimelineManifest, assets: MediaAsset[]): TimelineManifest {
  const byId = assetMap(assets);
  const clips: TimelineClip[] = [];
  for (const s of m.shotList) {
    const a = s.assetId ? byId.get(s.assetId) : undefined;
    if (!a || a.kind === "audio") continue;
    const target = s.targetSec ?? undefined;
    clips.push(isStill(a) ? makeClip(a, 0, target ?? STILL_DEFAULT) : makeClip(a, 0, target ?? durationOf(a)));
  }
  return { ...m, clips };
}

// ── Presets (quick starts) ───────────────────────────────────────────────────

export type QuickStart = "edit" | "series" | "photo" | "stitch";

export const QUICK_STARTS: { id: QuickStart; label: string; hint: string }[] = [
  { id: "edit", label: "New Video Edit", hint: "Stage clips, trim them and let the Director shape the cut." },
  { id: "series", label: "Plan a Video / Channel Series", hint: "The Director drafts a shot list before any footage exists." },
  { id: "photo", label: "Photo & Visual Staging", hint: "Stills held on screen with music or a voiceover." },
  { id: "stitch", label: "Quick Stitch + Slate", hint: "Two clips and a slate at −18 LUFS." },
];

const slot = (id: string, label: string, kind: ShotSlot["kind"], instructions: string, targetSec: number | null = null): ShotSlot => ({ id, label, kind, instructions, targetSec, assetId: null, status: "needed" });

/** The preset a quick start applies on top of a fresh manifest (clips/audio untouched). */
export function presetManifest(m: TimelineManifest, q: QuickStart, title: string): TimelineManifest {
  const name = cleanOutputName(title);
  switch (q) {
    case "stitch":
      return { ...m, shotList: [slot("s1", "Clip A", "video", "First clip."), slot("s2", "Clip B", "video", "Second clip."), slot("s3", "Slate", "image", "Title / end slate, held on screen.", 3)], output: { ...m.output, loudnessLufs: -18, name } };
    case "photo":
      return { ...m, output: { ...m.output, aspect: "4:5", name } };
    case "series":
    case "edit":
      return { ...m, output: { ...m.output, name } };
  }
}

/** Role chip options at ingest, by what the file is. */
export const INGEST_ROLES: AssetRole[] = ["clip", "photo", "slate", "outro", "music", "sfx"];

/** A role that fits a kind (the picker's role may not: a song dropped as "clip" is music). */
export function roleForKind(kind: MediaAsset["kind"], role: AssetRole): AssetRole {
  if (kind === "audio") return role === "music" || role === "sfx" || role === "voiceover" ? role : "music";
  if (kind === "image") return role === "photo" || role === "slate" || role === "outro" ? role : "photo";
  return role === "clip" || role === "slate" || role === "outro" ? role : "clip";
}

/** mm:ss.ff (ff = hundredths). */
export function timecode(sec: number): string {
  const s = Math.max(0, Number.isFinite(sec) ? sec : 0);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  const whole = Math.floor(r);
  const ff = Math.min(99, Math.round((r - whole) * 100));
  return `${String(m).padStart(2, "0")}:${String(whole).padStart(2, "0")}.${String(ff).padStart(2, "0")}`;
}

/** A validated Director `propose_edit_plan`: replaces clips + audio, merges output. */
export function applyEditPlan(m: TimelineManifest, plan: { clips: Omit<TimelineClip, "id">[]; audio: Omit<AudioLayer, "id">[]; output: Partial<TimelineManifest["output"]> }): TimelineManifest {
  const next: TimelineManifest = {
    ...m,
    clips: plan.clips.map((c) => ({ ...c, id: newId("c") })),
    audio: plan.audio.map((a) => ({ ...a, id: newId("au") })),
  };
  return setOutput(next, plan.output);
}
