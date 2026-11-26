/**
 * Pure edit operations on the timeline manifest (contract `TimelineManifest`). Every op returns a
 * NEW manifest (never mutates) and clamps to the manifest rules, so whatever the UI or the
 * Director asks for, what gets saved is valid. `revision` / `updatedBy` / `updatedAt` are the
 * save path's job (director-store), not these ops'.
 */
import type {
  Aspect,
  AssetRole,
  AudioLayer,
  CaptionTrack,
  ColorLook,
  CreativeBrief,
  EditPlanBody,
  Framing,
  LegacyProjectStatus,
  MediaAsset,
  MediaProject,
  Note,
  Platform,
  PlatformPreset,
  ProjectStatus,
  ShotSlot,
  TimelineClip,
  TimelineManifest,
} from "./contract";

export const STILL_MIN = 0.2;
export const STILL_MAX = 60;
export const STILL_DEFAULT = 3;
export const MIN_CLIP = 0.1;
export const FADE_MAX = 2000;
export const VOLUME_MAX = 2;
export const LUFS = [-14, -16, -18] as const;
export const ASPECTS = ["16:9", "9:16", "4:5", "1:1"] as const;
// v2 ranges (contract §2, §4) — media.rs validate_manifest enforces the same numbers.
export const TRANSITION_MAX = 1500;
export const PUNCH_MIN = 1;
export const PUNCH_MAX = 1.5;
export const AUDIO_FADE_MAX = 10_000;
export const MAX_PHONE_TIPS = 4;
export const MAX_OUTPUTS = 4;
export const SHOT_SLOTS_MAX = 30;
export const CAPTION_WORDS_MAX = 12;
export const FRAMINGS: readonly Framing[] = ["wide", "medium", "mcu", "closeup", "insert", "overhead", "pov"];
export const SLOT_SOURCES: readonly ShotSlot["source"][] = ["film", "generate", "stock"];
export const TRANSITIONS: readonly TimelineClip["transitionIn"]["kind"][] = ["cut", "crossfade", "fade_black"];
export const CAPTION_STYLES: readonly CaptionTrack["style"][] = ["clean", "bold_pop", "karaoke", "minimal"];
export const COLOR_PRESETS: readonly ColorLook["preset"][] = ["none", "warm", "cool", "punchy", "film", "bw"];
export const PLATFORMS: readonly Platform[] = ["reels", "tiktok", "ig_feed", "youtube", "shorts", "self_tape", "custom"];
export const PROJECT_STATUSES: readonly ProjectStatus[] = ["brief", "shooting", "editing", "review", "done"];

export const DEFAULT_CAPTIONS: CaptionTrack = { enabled: false, style: "clean", position: "lower", maxWordsPerLine: 4 };
export const DEFAULT_COLOR: ColorLook = { preset: "none", strength: 0.5 };
/** The v2 clip fields a v1 clip (or a plan that leaves them out) gets. */
export const CLIP_V2_DEFAULTS: Pick<TimelineClip, "transitionIn" | "punchIn"> = { transitionIn: { kind: "cut", ms: 0 }, punchIn: 1 };
export const AUDIO_V2_DEFAULTS: Pick<AudioLayer, "fadeInMs" | "fadeOutMs" | "duckUnderVoice"> = { fadeInMs: 0, fadeOutMs: 0, duckUnderVoice: false };
export const SLOT_V2_DEFAULTS: Pick<ShotSlot, "framing" | "action" | "source" | "phoneTips" | "filmed"> = { framing: null, action: "", source: "film", phoneTips: [], filmed: false };
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
  return { id: newId("c"), assetId: asset.id, ...r, fadeMs: clamp(Math.round(fadeMs), 0, FADE_MAX), transitionIn: { ...CLIP_V2_DEFAULTS.transitionIn }, punchIn: 1 };
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

/** v2: how a clip comes in (cut / crossfade / fade from black, 0–1500 ms; a cut is always 0 ms). */
export function setClipTransition(m: TimelineManifest, clipId: string, kind: TimelineClip["transitionIn"]["kind"], ms: number): TimelineManifest {
  if (!TRANSITIONS.includes(kind)) return m;
  const t = { kind, ms: kind === "cut" ? 0 : clamp(Math.round(ms), 0, TRANSITION_MAX) };
  return { ...m, clips: m.clips.map((c) => (c.id === clipId ? { ...c, transitionIn: t } : c)) };
}

/** v2: punch-in zoom 1.0–1.5. */
export function setClipPunchIn(m: TimelineManifest, clipId: string, zoom: number): TimelineManifest {
  return { ...m, clips: m.clips.map((c) => (c.id === clipId ? { ...c, punchIn: round3(clamp(zoom, PUNCH_MIN, PUNCH_MAX)) } : c)) };
}

export function removeClip(m: TimelineManifest, clipId: string): TimelineManifest {
  return { ...m, clips: m.clips.filter((c) => c.id !== clipId) };
}

export function addAudio(m: TimelineManifest, asset: MediaAsset, startSec: number, volume = 1): TimelineManifest {
  if (asset.kind !== "audio") return m;
  const r = clampRange(asset, 0, durationOf(asset));
  const layer: AudioLayer = { id: newId("au"), assetId: asset.id, startSec: round3(clamp(startSec, 0, UNKNOWN_DURATION)), ...r, volume: round3(clamp(volume, 0, VOLUME_MAX)), ...AUDIO_V2_DEFAULTS };
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
      return {
        ...next,
        ...r,
        startSec: round3(clamp(next.startSec, 0, UNKNOWN_DURATION)),
        volume: round3(clamp(next.volume, 0, VOLUME_MAX)),
        fadeInMs: clamp(Math.round(next.fadeInMs ?? 0), 0, AUDIO_FADE_MAX),
        fadeOutMs: clamp(Math.round(next.fadeOutMs ?? 0), 0, AUDIO_FADE_MAX),
        duckUnderVoice: next.duckUnderVoice === true,
      };
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

type SlotV2Key = "framing" | "action" | "source" | "phoneTips";
/** A slot as a `populate_shot_list` (or a v1 caller) gives it: the v2 detail fields may be left out. */
export type SlotInput = Omit<ShotSlot, "assetId" | "status" | "filmed" | SlotV2Key> & Partial<Pick<ShotSlot, SlotV2Key | "filmed">>;

const cleanTips = (tips: unknown): string[] =>
  Array.isArray(tips)
    ? tips
        .filter((t): t is string => typeof t === "string")
        .map((t) => t.trim().slice(0, 120))
        .filter(Boolean)
        .slice(0, MAX_PHONE_TIPS)
    : [];

/** The v2 detail fields of a slot, defaulted and clamped. */
function slotDetail(s: Partial<ShotSlot>): Pick<ShotSlot, "framing" | "action" | "source" | "phoneTips"> {
  return {
    framing: s.framing && FRAMINGS.includes(s.framing) ? s.framing : null,
    action: typeof s.action === "string" ? s.action.trim().slice(0, 500) : "",
    source: s.source && SLOT_SOURCES.includes(s.source) ? s.source : "film",
    phoneTips: cleanTips(s.phoneTips),
  };
}

/** Replace the shot list (a Director `populate_shot_list`); a slot keeps its attachment when the
 * same id comes back with the same kind, and keeps Nic's "filmed" tick when the same id comes back. */
export function setShotList(m: TimelineManifest, slots: SlotInput[]): TimelineManifest {
  const old = new Map(m.shotList.map((s) => [s.id, s]));
  return {
    ...m,
    shotList: slots.map((s) => {
      const prev = old.get(s.id);
      const keep = prev && prev.kind === s.kind && prev.assetId;
      return {
        id: s.id,
        label: s.label,
        instructions: s.instructions,
        kind: s.kind,
        targetSec: s.targetSec,
        ...slotDetail(s),
        assetId: keep ? prev.assetId : null,
        status: keep ? prev.status : "needed",
        filmed: prev?.filmed ?? s.filmed === true,
      };
    }),
  };
}

/** Next free "sN" slot id. */
export function nextSlotId(m: Pick<TimelineManifest, "shotList">): string {
  const used = new Set(m.shotList.map((s) => s.id));
  let n = m.shotList.length + 1;
  while (used.has(`s${n}`)) n++;
  return `s${n}`;
}

/** Manual add (at the end, or at `index`). Refused past 30 slots. */
export function addSlot(m: TimelineManifest, p: Partial<Omit<ShotSlot, "id" | "assetId" | "status">> = {}, index?: number): TimelineManifest {
  if (m.shotList.length >= SHOT_SLOTS_MAX) return m;
  const kind = p.kind === "image" || p.kind === "audio" ? p.kind : "video";
  const s: ShotSlot = {
    id: nextSlotId(m),
    label: (p.label ?? "").trim().slice(0, 120) || `Shot ${m.shotList.length + 1}`,
    instructions: (p.instructions ?? "").slice(0, 1000),
    kind,
    targetSec: p.targetSec == null || !Number.isFinite(p.targetSec) ? null : round3(clamp(p.targetSec, 0.2, 600)),
    ...slotDetail(p),
    assetId: null,
    status: "needed",
    filmed: p.filmed === true,
  };
  const list = [...m.shotList];
  list.splice(index == null ? list.length : clamp(index, 0, list.length), 0, s);
  return { ...m, shotList: list };
}

/** Manual edit. A kind change that no longer fits the attached asset detaches it. */
export function updateSlot(m: TimelineManifest, slotId: string, patch: Partial<Omit<ShotSlot, "id" | "assetId" | "status">>): TimelineManifest {
  return {
    ...m,
    shotList: m.shotList.map((s) => {
      if (s.id !== slotId) return s;
      const next: ShotSlot = { ...s };
      if (patch.label !== undefined) next.label = patch.label.trim().slice(0, 120) || s.label;
      if (patch.instructions !== undefined) next.instructions = patch.instructions.slice(0, 1000);
      if (patch.targetSec !== undefined) next.targetSec = patch.targetSec == null || !Number.isFinite(patch.targetSec) ? null : round3(clamp(patch.targetSec, 0.2, 600));
      if (patch.filmed !== undefined) next.filmed = patch.filmed === true;
      const detail = slotDetail({ ...s, ...patch });
      Object.assign(next, detail);
      if (patch.kind !== undefined && (patch.kind === "video" || patch.kind === "image" || patch.kind === "audio") && patch.kind !== s.kind) {
        next.kind = patch.kind;
        next.assetId = null;
        next.status = "needed";
      }
      return next;
    }),
  };
}

export function removeSlot(m: TimelineManifest, slotId: string): TimelineManifest {
  return { ...m, shotList: m.shotList.filter((s) => s.id !== slotId) };
}

/** Drag-reorder a slot. Out-of-range indexes are a no-op. */
export function moveSlot(m: TimelineManifest, from: number, to: number): TimelineManifest {
  if (from === to || from < 0 || from >= m.shotList.length || to < 0 || to >= m.shotList.length) return m;
  const list = [...m.shotList];
  const [s] = list.splice(from, 1);
  list.splice(to, 0, s);
  return { ...m, shotList: list };
}

/** Nic's checklist tick (independent of attach). */
export function toggleFilmed(m: TimelineManifest, slotId: string): TimelineManifest {
  return { ...m, shotList: m.shotList.map((s) => (s.id === slotId ? { ...s, filmed: !s.filmed } : s)) };
}

/** Every "film" slot has footage (the shooting → editing trigger; media.rs checks the same). */
export const filmSlotsFilled = (m: Pick<TimelineManifest, "shotList">) => {
  const film = m.shotList.filter((s) => s.source === "film");
  return film.length > 0 && film.every((s) => !!s.assetId);
};

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

const slot = (id: string, label: string, kind: ShotSlot["kind"], instructions: string, targetSec: number | null = null): ShotSlot => ({ id, label, kind, instructions, targetSec, assetId: null, status: "needed", ...SLOT_V2_DEFAULTS, phoneTips: [] });

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

type ClipInput = Omit<TimelineClip, "id" | "transitionIn" | "punchIn"> & Partial<Pick<TimelineClip, "transitionIn" | "punchIn">>;
type AudioInput = Omit<AudioLayer, "id" | "fadeInMs" | "fadeOutMs" | "duckUnderVoice"> & Partial<Pick<AudioLayer, "fadeInMs" | "fadeOutMs" | "duckUnderVoice">>;
export type EditPlanInput = Omit<EditPlanBody, "clips" | "audio" | "note"> & { clips: ClipInput[]; audio: AudioInput[]; note?: string };

const normTransition = (t: Partial<TimelineClip["transitionIn"]> | undefined): TimelineClip["transitionIn"] => {
  const kind = t?.kind && TRANSITIONS.includes(t.kind) ? t.kind : "cut";
  return { kind, ms: kind === "cut" ? 0 : clamp(Math.round(t?.ms ?? 0), 0, TRANSITION_MAX) };
};

/** A validated Director `propose_edit_plan`: replaces clips + audio, merges output (and, v2,
 * captions / color / outputs when the plan names them). */
export function applyEditPlan(m: TimelineManifest, plan: EditPlanInput): TimelineManifest {
  let next: TimelineManifest = {
    ...m,
    clips: plan.clips.map((c) => ({ ...c, id: newId("c"), transitionIn: normTransition(c.transitionIn), punchIn: round3(clamp(c.punchIn ?? 1, PUNCH_MIN, PUNCH_MAX)) })),
    audio: plan.audio.map((a) => ({
      ...a,
      id: newId("au"),
      fadeInMs: clamp(Math.round(a.fadeInMs ?? 0), 0, AUDIO_FADE_MAX),
      fadeOutMs: clamp(Math.round(a.fadeOutMs ?? 0), 0, AUDIO_FADE_MAX),
      duckUnderVoice: a.duckUnderVoice === true,
    })),
  };
  next = setOutput(next, plan.output);
  if (plan.captions) next = setCaptions(next, plan.captions);
  if (plan.color) next = setColor(next, plan.color);
  if (plan.outputs?.length) next = setOutputs(next, plan.outputs);
  return next;
}

// ── v2: captions, color, platform outputs ────────────────────────────────────

export function setCaptions(m: TimelineManifest, patch: Partial<CaptionTrack>): TimelineManifest {
  const c = { ...m.captions };
  if (patch.enabled !== undefined) c.enabled = patch.enabled === true;
  if (patch.style !== undefined && CAPTION_STYLES.includes(patch.style)) c.style = patch.style;
  if (patch.position === "lower" || patch.position === "middle") c.position = patch.position;
  if (patch.maxWordsPerLine !== undefined) c.maxWordsPerLine = Math.round(clamp(patch.maxWordsPerLine, 1, CAPTION_WORDS_MAX));
  return { ...m, captions: c };
}

export function setColor(m: TimelineManifest, patch: Partial<ColorLook>): TimelineManifest {
  const c = { ...m.color };
  if (patch.preset !== undefined && COLOR_PRESETS.includes(patch.preset)) c.preset = patch.preset;
  if (patch.strength !== undefined) c.strength = round3(clamp(patch.strength, 0, 1));
  return { ...m, color: c };
}

/** Platform presets (contract §4). `custom` follows the manifest's own primary output. */
export const PLATFORM_PRESETS: Record<Exclude<Platform, "custom">, PlatformPreset> = {
  reels: { platform: "reels", aspect: "9:16", loudnessLufs: -14, maxSizeMb: null, maxSec: 90 },
  tiktok: { platform: "tiktok", aspect: "9:16", loudnessLufs: -14, maxSizeMb: null, maxSec: 90 },
  ig_feed: { platform: "ig_feed", aspect: "4:5", loudnessLufs: -14, maxSizeMb: null, maxSec: 60 },
  youtube: { platform: "youtube", aspect: "16:9", loudnessLufs: -14, maxSizeMb: null, maxSec: null },
  shorts: { platform: "shorts", aspect: "9:16", loudnessLufs: -14, maxSizeMb: null, maxSec: 60 },
  self_tape: { platform: "self_tape", aspect: "16:9", loudnessLufs: -18, maxSizeMb: 100, maxSec: null },
};
/** Platforms that never burn in captions (a self-tape is the actor's take, unadorned). */
export const CAPTIONLESS_PLATFORMS: readonly Platform[] = ["self_tape"];
export const platformWantsCaptions = (p: Platform) => !CAPTIONLESS_PLATFORMS.includes(p);

/** The preset for a platform; `custom` copies the primary output. */
export function presetFor(platform: Platform, output: TimelineManifest["output"]): PlatformPreset {
  if (platform === "custom") return { platform, aspect: output.aspect, loudnessLufs: output.loudnessLufs, maxSizeMb: output.maxSizeMb, maxSec: null };
  return { ...PLATFORM_PRESETS[platform] };
}

/** Set the 1–4 outputs from platform names (duplicates and unknown names dropped; empty = a single custom output). */
export function setOutputs(m: TimelineManifest, platforms: Platform[]): TimelineManifest {
  const seen = new Set<Platform>();
  const list = platforms.filter((p) => PLATFORMS.includes(p) && !seen.has(p) && (seen.add(p), true)).slice(0, MAX_OUTPUTS);
  return { ...m, outputs: (list.length ? list : (["custom"] as Platform[])).map((p) => presetFor(p, m.output)) };
}

// ── v2: notes (Rust owns them; these apply an IPC result locally) ─────────────

export function withNote(m: TimelineManifest, note: Note): TimelineManifest {
  return m.notes.some((n) => n.id === note.id) ? m : { ...m, notes: [...m.notes, note] };
}
export function withNoteResolved(m: TimelineManifest, noteId: string): TimelineManifest {
  return { ...m, notes: m.notes.map((n) => (n.id === noteId ? { ...n, resolved: true } : n)) };
}
export const openNotes = (m: Pick<TimelineManifest, "notes">, renderId?: string | null) => m.notes.filter((n) => !n.resolved && (renderId === undefined || n.renderId === renderId));

// ── v1 → v2 upgrade on read (pure; Rust does the same in media.rs) ───────────

type Loose = Record<string, unknown>;
const obj = (v: unknown): Loose => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Loose) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const numOr = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

const LEGACY_STATUS: Record<LegacyProjectStatus, ProjectStatus> = { intake: "brief", awaiting_media: "shooting", editing: "editing", rendering: "editing", ready: "review" };
/** v1 → v2 project status (a v2 status passes through; anything unknown reads as "brief"). */
export function upgradeStatus(s: unknown): ProjectStatus {
  if (typeof s === "string" && (PROJECT_STATUSES as readonly string[]).includes(s)) return s as ProjectStatus;
  return LEGACY_STATUS[s as LegacyProjectStatus] ?? "brief";
}

export function upgradeProject(raw: unknown): MediaProject {
  const p = obj(raw) as unknown as MediaProject & Loose;
  const speed = p.speed === "polish" || p.speed === "full_ai" ? p.speed : "rough";
  return { ...p, status: upgradeStatus(p.status), brief: (p.brief as CreativeBrief | null | undefined) ?? null, speed };
}

export function upgradeAsset(raw: unknown): MediaAsset {
  const a = obj(raw) as unknown as MediaAsset & Loose;
  return {
    ...a,
    tags: list(a.tags).filter((t): t is string => typeof t === "string"),
    transcript: (a.transcript as MediaAsset["transcript"] | undefined) ?? null,
    flags: list(a.flags) as MediaAsset["flags"],
    moments: list(a.moments) as MediaAsset["moments"],
    slotId: typeof a.slotId === "string" ? a.slotId : null,
    scenes: Array.isArray(a.scenes) ? (a.scenes as unknown[]).filter((t): t is number => typeof t === "number" && Number.isFinite(t)).slice(0, 200) : null,
  };
}

/** A v1 (or partial) manifest as v2: every new field gets its default; v2 values are kept. */
export function upgradeManifest(raw: unknown): TimelineManifest {
  const m = obj(raw);
  const out = obj(m.output);
  const output: TimelineManifest["output"] = {
    aspect: (ASPECTS as readonly string[]).includes(out.aspect as string) ? (out.aspect as Aspect) : "16:9",
    loudnessLufs: (LUFS as readonly number[]).includes(out.loudnessLufs as number) ? (out.loudnessLufs as TimelineManifest["output"]["loudnessLufs"]) : -16,
    maxSizeMb: typeof out.maxSizeMb === "number" ? out.maxSizeMb : null,
    name: typeof out.name === "string" ? out.name : String(m.project ?? "render"),
  };
  const next: TimelineManifest = {
    version: 2,
    project: String(m.project ?? ""),
    revision: numOr(m.revision, 0),
    clips: list(m.clips).map((c) => {
      const x = obj(c) as unknown as TimelineClip & Loose;
      return { ...x, transitionIn: normTransition(obj(x.transitionIn) as Partial<TimelineClip["transitionIn"]>), punchIn: numOr(x.punchIn, 1) };
    }),
    audio: list(m.audio).map((l) => {
      const x = obj(l) as unknown as AudioLayer & Loose;
      return { ...x, fadeInMs: numOr(x.fadeInMs, 0), fadeOutMs: numOr(x.fadeOutMs, 0), duckUnderVoice: x.duckUnderVoice === true };
    }),
    clipAudioVolume: numOr(m.clipAudioVolume, 1),
    output,
    shotList: list(m.shotList).map((s) => {
      const x = obj(s) as unknown as ShotSlot & Loose;
      return { ...x, ...slotDetail(x), filmed: x.filmed === true };
    }),
    updatedBy: m.updatedBy === "director" ? "director" : "nic",
    updatedAt: typeof m.updatedAt === "string" ? m.updatedAt : "",
    captions: { ...DEFAULT_CAPTIONS, ...(obj(m.captions) as Partial<CaptionTrack>) },
    color: { ...DEFAULT_COLOR, ...(obj(m.color) as Partial<ColorLook>) },
    outputs: [],
    notes: list(m.notes) as Note[],
  };
  const outputs = list(m.outputs) as PlatformPreset[];
  next.outputs = outputs.length ? outputs : [presetFor("custom", output)];
  return next;
}
