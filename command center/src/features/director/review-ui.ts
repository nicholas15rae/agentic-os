/**
 * Pure helpers behind the v2 panels (review notes, outputs, transcripts). No store, no IPC, so the
 * components stay thin and these are unit-tested on their own.
 */
import type { MediaAsset, Note, Platform, ProjectReview, ReviewRound, TimelineManifest } from "./contract";
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
