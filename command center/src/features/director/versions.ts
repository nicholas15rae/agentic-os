/**
 * Part 3 C.2: pure helpers for Versions (restore a past render's cut) and Compare (A/B two renders).
 * No store, no IPC: versions.test.ts covers them.
 */
import type { AssetRole, TimelineClip, TimelineManifest, VerifiedRender } from "./contract";
import { clipLength, timelineLength } from "./manifest";

const base = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** "renders/demo_v003.mp4" → 3; null without _vNNN. */
export function renderVersion(path: string): number | null {
  const m = /_v(\d+)\.[a-z0-9]+$/i.exec(base(path));
  return m ? Number(m[1]) : null;
}

/** "v003" (or "—" without a version number). */
export const versionLabel = (path: string): string => {
  const n = renderVersion(path);
  return n == null ? "—" : `v${String(n).padStart(3, "0")}`;
};

export interface VersionRow {
  renderId: string;
  version: number | null;
  name: string;
  createdAt: string;
  planId: string;
  durationSec: number;
  width: number;
  height: number;
  /** Its cut is the working timeline's (its plan is in `currentPlans`; the caller works that out
   * from the loaded snapshots with sameCut, not from which render is newest). */
  current: boolean;
  /** The first row of its plan: the one restore target for a multi-output render. */
  primary: boolean;
}

/** Renders (newest first) → rows; renders sharing a planId (multi-output) are kept as one restore
 * target (the first row of the plan carries the button: `primary`). `currentPlans` = the plans whose
 * cut equals the working timeline (marked `current`). */
export function versionRows(renders: VerifiedRender[], currentPlans: ReadonlySet<string> = new Set()): VersionRow[] {
  const sorted = [...renders].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const seen = new Set<string>();
  return sorted.map((r) => {
    const primary = !seen.has(r.planId);
    seen.add(r.planId);
    return { renderId: r.id, version: renderVersion(r.path), name: base(r.path), createdAt: r.createdAt, planId: r.planId, durationSec: r.durationSec, width: r.width, height: r.height, current: currentPlans.has(r.planId), primary };
  });
}

export interface DiffSummary {
  same: boolean;
  lines: string[];
}

/** Sorted-key JSON, so key order never makes two equal values differ. */
const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x));

/** What media_manifest_restore takes from a snapshot and what changes the render: clips and audio
 * layers without their ids, the camera-audio level, the output (not its file name), captions (only
 * on/off when off), colour (strength only with a preset) and the outputs. */
function restoredCut(m: TimelineManifest) {
  return {
    clips: m.clips.map(({ id: _id, fit, ...c }) => ({ ...c, fit: fit ?? "auto" })),
    audio: m.audio.map(({ id: _id, ...l }) => l),
    clipAudioVolume: m.clipAudioVolume,
    output: { aspect: m.output.aspect, loudnessLufs: m.output.loudnessLufs, maxSizeMb: m.output.maxSizeMb ?? null },
    captions: m.captions.enabled ? m.captions : { enabled: false },
    color: m.color.preset === "none" ? { preset: "none" } : m.color,
    outputs: m.outputs,
  };
}

/** Pure. True when restoring A over B would change nothing in the render (every restored field equal). */
export const sameCut = (a: TimelineManifest, b: TimelineManifest): boolean => canon(restoredCut(a)) === canon(restoredCut(b));

export const DIFF_MAX_LINES = 8;
const s1 = (x: number) => `${x.toFixed(1)}s`;
const v1 = (x: number) => x.toFixed(1);
const mss = (sec: number) => {
  const t = Math.max(0, Math.round(sec));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};
const near = (x: number, y: number, eps = 0.05) => Math.abs(x - y) < eps;
const words = (s: string) => s.replace(/_/g, " ");
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Pair each clip of `b` with the same asset's k-th clip in `a` (k = its occurrence count). */
function pairClips(a: TimelineClip[], b: TimelineClip[]): { added: TimelineClip[]; removed: TimelineClip[]; pairs: { a: TimelineClip; b: TimelineClip; bIndex: number }[] } {
  const pool = new Map<string, TimelineClip[]>();
  for (const c of a) pool.set(c.assetId, [...(pool.get(c.assetId) ?? []), c]);
  const pairs: { a: TimelineClip; b: TimelineClip; bIndex: number }[] = [];
  const added: TimelineClip[] = [];
  b.forEach((c, bIndex) => {
    const left = pool.get(c.assetId);
    const match = left?.shift();
    if (match) pairs.push({ a: match, b: c, bIndex });
    else added.push(c);
  });
  const removed = [...pool.values()].flat();
  return { added, removed, pairs };
}

/**
 * Pure. What changed from A to B in what renders (ids, revisions, notes, shot list, updatedAt and the
 * output's file name ignored). ≤ 8 lines, then "+N more". Same cut → lines = ["Same cut"].
 * Asset names come from `names` (id → name), else the id; `roles` (id → asset role) names audio
 * layers ("music added"), else the asset name.
 */
export function diffSummary(a: TimelineManifest, b: TimelineManifest, names: Record<string, string> = {}, roles: Record<string, AssetRole> = {}): DiffSummary {
  const nameOf = (id: string) => names[id] ?? id;
  const out: string[] = [];

  // Clips.
  const { added, removed, pairs } = pairClips(a.clips, b.clips);
  if (added.length) out.push(`${plural(added.length, "clip")} added (${added.map((c) => nameOf(c.assetId)).join(", ")})`);
  if (removed.length) out.push(`${plural(removed.length, "clip")} removed (${removed.map((c) => nameOf(c.assetId)).join(", ")})`);
  const aOrder = pairs.map((p) => a.clips.indexOf(p.a));
  if (aOrder.some((x, i) => i > 0 && x < aOrder[i - 1])) out.push("order changed");
  for (const { a: ca, b: cb, bIndex } of pairs) {
    const n = bIndex + 1;
    const la = clipLength(ca);
    const lb = clipLength(cb);
    if (!near(la, lb)) out.push(`clip ${n} trimmed ${s1(la)} → ${s1(lb)}`);
    else if (!near(ca.inSec, cb.inSec)) out.push(`clip ${n} moved in its source ${s1(ca.inSec)} → ${s1(cb.inSec)}`);
    if (ca.transitionIn.kind !== cb.transitionIn.kind) out.push(`clip ${n} transition ${words(ca.transitionIn.kind)} → ${words(cb.transitionIn.kind)}`);
    else if (ca.transitionIn.ms !== cb.transitionIn.ms) out.push(`clip ${n} ${words(cb.transitionIn.kind)} ${ca.transitionIn.ms} → ${cb.transitionIn.ms} ms`);
    if (!near(ca.punchIn, cb.punchIn, 0.005) || (ca.fit ?? "auto") !== (cb.fit ?? "auto")) out.push(`clip ${n} framing changed`);
    if (ca.fadeMs !== cb.fadeMs) out.push(`clip ${n} fade ${ca.fadeMs} → ${cb.fadeMs} ms`);
  }
  const lenA = timelineLength(a);
  const lenB = timelineLength(b);
  if (mss(lenA) !== mss(lenB)) out.push(`length ${mss(lenA)} → ${mss(lenB)}`);

  // Audio layers (paired by asset).
  const label = (id: string) => roles[id] ?? nameOf(id);
  const audioB = [...b.audio];
  for (const la of a.audio) {
    const k = audioB.findIndex((x) => x.assetId === la.assetId);
    if (k < 0) {
      out.push(roles[la.assetId] ? `${label(la.assetId)} removed (${nameOf(la.assetId)})` : `audio removed (${nameOf(la.assetId)})`);
      continue;
    }
    const lb = audioB.splice(k, 1)[0];
    if (!near(la.volume, lb.volume, 0.01)) out.push(`${label(la.assetId)} volume ${v1(la.volume)} → ${v1(lb.volume)}`);
    if (!near(la.startSec, lb.startSec) || !near(la.inSec, lb.inSec) || !near(la.outSec, lb.outSec)) out.push(`${label(la.assetId)} moved or trimmed`);
    if (la.fadeInMs !== lb.fadeInMs || la.fadeOutMs !== lb.fadeOutMs) out.push(`${label(la.assetId)} fades changed`);
    if (la.duckUnderVoice !== lb.duckUnderVoice) out.push(`${label(la.assetId)} ducking ${lb.duckUnderVoice ? "on" : "off"}`);
  }
  for (const lb of audioB) out.push(roles[lb.assetId] ? `${label(lb.assetId)} added (${nameOf(lb.assetId)})` : `audio added (${nameOf(lb.assetId)})`);
  if (!near(a.clipAudioVolume, b.clipAudioVolume, 0.01)) out.push(`camera audio ${v1(a.clipAudioVolume)} → ${v1(b.clipAudioVolume)}`);

  // Looks.
  const ca = a.captions;
  const cb = b.captions;
  if (ca.enabled !== cb.enabled) out.push(cb.enabled ? `captions on (${words(cb.style)})` : "captions off");
  else if (cb.enabled && (ca.style !== cb.style || ca.position !== cb.position || ca.maxWordsPerLine !== cb.maxWordsPerLine)) out.push(ca.style !== cb.style ? `captions ${words(ca.style)} → ${words(cb.style)}` : "captions layout changed");
  if (a.color.preset !== b.color.preset) out.push(`colour ${a.color.preset} → ${b.color.preset}`);
  else if (b.color.preset !== "none" && !near(a.color.strength, b.color.strength, 0.01)) out.push(`colour strength ${v1(a.color.strength)} → ${v1(b.color.strength)}`);

  // Outputs and format.
  const pa = a.outputs.map((o) => o.platform);
  const pb = b.outputs.map((o) => o.platform);
  const plus = pb.filter((p) => !pa.includes(p));
  const minus = pa.filter((p) => !pb.includes(p));
  if (plus.length || minus.length) out.push(["outputs", ...plus.map((p) => `+ ${p}`), ...minus.map((p) => `− ${p}`)].join(" "));
  for (const ob of b.outputs) {
    const oa = a.outputs.find((o) => o.platform === ob.platform);
    if (oa && canon(oa) !== canon(ob)) out.push(`${ob.platform} settings changed`);
  }
  if (!plus.length && !minus.length && pa.join() !== pb.join()) out.push("outputs reordered");
  if (a.output.aspect !== b.output.aspect) out.push(`aspect ${a.output.aspect} → ${b.output.aspect}`);
  if (a.output.loudnessLufs !== b.output.loudnessLufs) out.push(`loudness ${a.output.loudnessLufs} → ${b.output.loudnessLufs} LUFS`);
  const cap = (x: number | null | undefined) => (x == null ? "none" : `${x} MB`);
  if ((a.output.maxSizeMb ?? null) !== (b.output.maxSizeMb ?? null)) out.push(`size cap ${cap(a.output.maxSizeMb)} → ${cap(b.output.maxSizeMb)}`);

  // Anything restore would change that the lines above don't name (a sub-tolerance trim, say).
  if (!out.length && !sameCut(a, b)) out.push("small settings changed");
  if (!out.length) return { same: true, lines: ["Same cut"] };
  return { same: false, lines: out.length > DIFF_MAX_LINES ? [...out.slice(0, DIFF_MAX_LINES), `+${out.length - DIFF_MAX_LINES} more`] : out };
}

/** A/B sync (no rAF): call from the leader video's play / pause / seeked / timeupdate events. */
export interface VideoClock {
  paused: boolean;
  currentTime: number;
  duration: number;
}
export const SYNC_TOLERANCE_SEC = 0.15;

/** What to do to the follower: seek when |Δt| > tolerance, play / pause when they differ. A shorter
 * follower clamps at its end (and is paused there). Null = leave it. */
export function syncFollower(leader: VideoClock, follower: VideoClock, tolerance = SYNC_TOLERANCE_SEC): { seekTo: number | null; play: boolean | null } {
  const fDur = Number.isFinite(follower.duration) && follower.duration > 0 ? follower.duration : Infinity;
  const lt = Number.isFinite(leader.currentTime) ? Math.max(0, leader.currentTime) : 0;
  const past = lt >= fDur;
  const target = past ? fDur : lt;
  const seekTo = Math.abs(follower.currentTime - target) > tolerance ? target : null;
  const wantPlay = !leader.paused && !past;
  const play = wantPlay === !follower.paused ? null : wantPlay;
  return { seekTo, play };
}
