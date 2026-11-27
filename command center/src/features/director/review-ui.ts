/**
 * Pure helpers behind the v2 panels (review notes, outputs, transcripts). No store, no IPC, so the
 * components stay thin and these are unit-tested on their own.
 */
import type { MediaAsset, Note, Platform, ProjectReview, ReviewRound, TimelineManifest, VerifiedRender } from "./contract";
import type { Selection } from "./director-store";
import { MAX_OUTPUTS, clipLength, clipStarts } from "./manifest";
import type { PreviewSource } from "./PreviewPlayer";

/** The newest review round, or null before the first verified render. */
export function latestRound(review: ProjectReview | null | undefined): ReviewRound | null {
  const rounds = review?.rounds ?? [];
  return rounds.length ? rounds[rounds.length - 1] : null;
}

/** Where a new note lands: on the render being previewed (at its media time), else on the timeline (at the playhead). */
export function notePlacement(src: PreviewSource, previewTime: number, playhead: number): { renderId: string | null; atSec: number | null } {
  const r3 = (n: number) => Math.round(Math.max(0, n) * 1000) / 1000;
  if (src?.kind === "render") return { renderId: src.render.id, atSec: r3(previewTime) };
  if (src?.kind === "clip") return { renderId: null, atSec: r3(playhead) };
  return { renderId: null, atSec: null };
}

/** What clicking a note shows: its render at atSec, or the timeline clip under atSec (seconds into that clip's asset). */
export function noteTarget(note: Pick<Note, "renderId" | "atSec">, manifest: Pick<TimelineManifest, "clips"> | null): { sel: Selection; sec: number } | null {
  if (note.atSec == null) return null;
  if (note.renderId) return { sel: { kind: "render", id: note.renderId }, sec: note.atSec };
  const clips = manifest?.clips ?? [];
  if (!clips.length) return null;
  const starts = clipStarts({ clips } as TimelineManifest);
  let i = starts.findIndex((s, k) => note.atSec! >= s && note.atSec! < s + clipLength(clips[k]));
  if (i < 0) i = clips.length - 1;
  const c = clips[i];
  return { sel: { kind: "clip", id: c.id }, sec: Math.min(c.outSec, c.inSec + Math.max(0, note.atSec - starts[i])) };
}

/** Open notes first (by time), then resolved ones. */
export function sortNotes(notes: Note[]): Note[] {
  const t = (n: Note) => n.atSec ?? Number.POSITIVE_INFINITY;
  return [...notes].sort((a, b) => Number(a.resolved) - Number(b.resolved) || t(a) - t(b) || a.at.localeCompare(b.at));
}

/** Toggle one platform in the 1–4 outputs; null when the change isn't allowed (last one, or a fifth). */
export function togglePlatform(selected: Platform[], p: Platform): Platform[] | null {
  if (selected.includes(p)) return selected.length > 1 ? selected.filter((x) => x !== p) : null;
  if (selected.length >= MAX_OUTPUTS) return null;
  // "custom" is the placeholder single output: picking a real platform replaces it.
  const base = p !== "custom" && selected.length === 1 && selected[0] === "custom" ? [] : selected;
  return [...base, p];
}

export const PLATFORM_LABEL: Record<Platform, string> = { reels: "Reels", tiktok: "TikTok", ig_feed: "IG feed", youtube: "YouTube", shorts: "Shorts", self_tape: "Self-tape", custom: "Custom" };

/** A transcript's file path (Rust stores it absolute; a relative one is under the project root). */
export function transcriptFile(asset: Pick<MediaAsset, "transcript">, projectRoot: string | null | undefined): string | null {
  const p = asset.transcript?.path;
  if (!p) return null;
  if (/^[A-Za-z]:[\\/]|^[\\/]/.test(p) || !projectRoot) return p;
  return `${projectRoot.replace(/[\\/]+$/, "")}\\${p.replace(/\//g, "\\")}`;
}

export interface TranscriptLine {
  start: number;
  end: number;
  text: string;
}
/** media-forge's transcribe JSON (`{language, segments: [{start, end, text}]}`) → lines; anything else → []. */
export function transcriptLines(json: unknown, max = 400): TranscriptLine[] {
  const segs = typeof json === "object" && json !== null && Array.isArray((json as { segments?: unknown }).segments) ? (json as { segments: unknown[] }).segments : [];
  const out: TranscriptLine[] = [];
  for (const s of segs) {
    if (typeof s !== "object" || s === null) continue;
    const x = s as Record<string, unknown>;
    const text = typeof x.text === "string" ? x.text.trim() : "";
    if (!text) continue;
    out.push({ start: typeof x.start === "number" ? x.start : 0, end: typeof x.end === "number" ? x.end : 0, text });
    if (out.length >= max) break;
  }
  return out;
}

/** "3 shots" / "one shot" / null when scene detection hasn't run. */
export function shotCount(scenes: MediaAsset["scenes"]): string | null {
  if (scenes == null) return null;
  return scenes.length ? `${scenes.length + 1} shots` : "one shot";
}

/** Asset flag kinds as words. */
export const FLAG_LABEL: Record<MediaAsset["flags"][number]["kind"], string> = {
  blurry: "blurry",
  dark: "dark",
  overexposed: "overexposed",
  clipped_audio: "clipped audio",
  too_short: "too short",
  no_speech: "no speech",
  silent: "silent",
  wrong_aspect: "wrong aspect",
};

// ── Part 3 B.1: note markers on the timeline ─────────────────────────────────

export interface NoteMarker {
  id: string;
  /** 0–1 along the clip strip. */
  x: number;
  resolved: boolean;
  /** A note on a render: placed by the render's length (its cut may differ from the timeline), drawn hollow. */
  onRender: boolean;
  text: string;
  /** Seconds the note sits at (on the timeline, or into the render). */
  atSec: number;
  target: { sel: Selection; sec: number };
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** Notes with atSec → markers. Timeline notes: x = atSec / total. Render notes: x = atSec / render
 * duration (`onRender: true`). target = noteTarget(note, manifest). Skips notes without atSec or
 * target (and render notes whose render isn't listed). Clamps x to [0, 1]. Sorted by x. */
export function noteMarkers(notes: Note[], manifest: Pick<TimelineManifest, "clips"> | null, totalSec: number, renders: Pick<VerifiedRender, "id" | "durationSec">[]): NoteMarker[] {
  const out: NoteMarker[] = [];
  for (const n of notes) {
    if (n.atSec == null || !Number.isFinite(n.atSec)) continue;
    const target = noteTarget(n, manifest);
    if (!target) continue;
    let x: number;
    if (n.renderId) {
      const r = renders.find((v) => v.id === n.renderId);
      if (!r) continue;
      x = r.durationSec > 0 ? n.atSec / r.durationSec : 0;
    } else x = totalSec > 0 ? n.atSec / totalSec : 0;
    out.push({ id: n.id, x: clamp01(x), resolved: n.resolved, onRender: !!n.renderId, text: n.text, atSec: n.atSec, target });
  }
  return out.sort((a, b) => a.x - b.x || a.id.localeCompare(b.id));
}

/** x (0–1 of the timeline's seconds) → px from the strip's left edge, using the widths the strip
 * actually draws (clip boxes are clamped to 72–220 px, so a straight percentage would drift).
 * `clips` = each box's drawn width and its length in seconds, in order; `gapPx` = the gap between boxes. */
export function markerLeftPx(x: number, clips: { widthPx: number; sec: number }[], gapPx = 6): number {
  if (!clips.length) return 0;
  const total = clips.reduce((t, c) => t + Math.max(0, c.sec), 0);
  const t = clamp01(x) * total;
  let acc = 0;
  let left = 0;
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const sec = Math.max(0, c.sec);
    if (t <= acc + sec || i === clips.length - 1) {
      const f = sec > 0 ? Math.min(1, Math.max(0, (t - acc) / sec)) : 0;
      return Math.round((left + f * c.widthPx) * 10) / 10;
    }
    acc += sec;
    left += c.widthPx + gapPx;
  }
  return left;
}
