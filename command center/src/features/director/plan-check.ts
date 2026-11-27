/**
 * Director plans go through Rust's `media_plan_check` before they apply (E2E fixes 2–3): it snaps
 * video in/out to the transcript (word and sentence ends), refuses clips under 1 s and a total
 * off the brief's length (or over an output's maxSec). Refusals block the plan and feed the one
 * automatic corrective turn (director-chat.ts); warnings show on the reply bubble. Framing (crop +
 * fit from detect_bars) is Rust's media_render_plan's job, not this check's.
 *
 * Also here, pure: the revision no-op test (a `revise_edit` that changes nothing is refused and
 * resolves no notes) and the "keep Nic's idea word for word" helpers for a drafted brief.
 */
import type { EditPlanBody, MediaProject, Note, PlanCheck, PlanCheckClip, PlanCheckPlan, TimelineClip, TimelineManifest } from "./contract";
import { api } from "./api";
import { applyEditPlan, CLIP_FITS } from "./manifest";

export { CLIP_FITS };
export type { ClipFit } from "./contract";
/** A plan clip as the page sends it to media_plan_check (a full PlanCheckClip, no id). */
export type CheckedClip = Omit<TimelineClip, "id"> & PlanCheckClip;
/** media_plan_check's answer (contract PlanCheck). */
export type PlanCheckResult = PlanCheck;
type PlanCheckFn = (a: { slug: string; clips: CheckedClip[]; plan?: PlanCheckPlan }) => Promise<PlanCheckResult>;

/** Seconds a clip list plays for (pure): stills hold outSec, video plays out − in. */
export const clipsTotal = (clips: Pick<TimelineClip, "inSec" | "outSec">[]): number => Math.round(clips.reduce((t, c) => t + Math.max(0, c.outSec - c.inSec), 0) * 100) / 100;

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : []);

/** What media_plan_check gets besides the clips (pure): the manifest with the plan merged in
 * (its outputs, captions, color and audio decide maxSec and the crossfade accounting), and a
 * revision's note ids. */
export function checkPlanFor(m: TimelineManifest, body: EditPlanBody, resolves?: string[]): PlanCheckPlan {
  const next = applyEditPlan(m, body);
  return {
    audio: next.audio,
    clipAudioVolume: next.clipAudioVolume,
    output: next.output,
    captions: next.captions,
    color: next.color,
    outputs: next.outputs,
    ...(resolves?.length ? { resolves } : {}),
  };
}

/**
 * Run media_plan_check. `null` = no check on this backend (api.planCheck absent): the plan applies
 * as written. A thrown IPC error is not the Director's fault, so it applies unchecked with a warning.
 */
export async function planCheck(slug: string, clips: CheckedClip[], plan?: PlanCheckPlan): Promise<PlanCheckResult | null> {
  // Optional on purpose: an older backend (or a test double) without the command just skips it.
  const fn = (api as { planCheck?: PlanCheckFn }).planCheck;
  if (typeof fn !== "function") return null;
  try {
    const r = await fn(plan ? { slug, clips, plan } : { slug, clips });
    return {
      clips: Array.isArray(r?.clips) && r.clips.length ? r.clips : clips,
      totalSec: typeof r?.totalSec === "number" ? r.totalSec : clipsTotal(clips),
      targetSec: typeof r?.targetSec === "number" ? r.targetSec : null,
      warnings: strings(r?.warnings),
      refusals: strings(r?.refusals),
      ...(typeof r?.unchangedSinceRender === "boolean" ? { unchangedSinceRender: r.unchangedSinceRender } : {}),
    };
  } catch (e) {
    return { clips, totalSec: clipsTotal(clips), targetSec: null, warnings: [`the plan check didn't run (${e instanceof Error ? e.message : String(e)}): applied as written`], refusals: [] };
  }
}

/** The body with the checked (snapped) clips in place of the Director's (pure). */
export const withCheckedClips = (body: EditPlanBody, r: PlanCheckResult | null): EditPlanBody => (r ? { ...body, clips: r.clips.map(({ id: _id, ...c }) => c) } : body);

/** Stable comparison form: keys sorted, ids dropped, numbers to 3 places, absent ≡ null ≡ fit "auto". */
function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (typeof v === "number") return Math.round(v * 1000) / 1000;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) {
      if (k === "id" || o[k] === undefined || o[k] === null) continue;
      if (k === "fit" && o[k] === "auto") continue;
      out[k] = canon(o[k]);
    }
    return out;
  }
  return v;
}
const same = (a: unknown, b: unknown) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

/**
 * Words that make a review note about framing (whole words, lowercase), plus "punch in" and the
 * aspect ratios. MIRRORED in src-tauri/src/commands/media.rs (`FRAMING_NOTE_WORDS`,
 * `FRAMING_NOTE_RATIOS`, `note_is_about_framing`): change both together (a Rust test checks it).
 */
export const FRAMING_NOTE_WORDS = [
  "frame", "frames", "framed", "framing", "reframe", "reframed", "fit", "fits", "crop", "crops", "cropped", "cropping", "bars", "letterbox", "letterboxed", "letterboxing",
  "pillarbox", "pillarboxed", "pillarboxing", "blur", "blurred", "blurry", "fill", "zoom", "zoomed", "zooming", "vertical", "aspect", "punchin",
  "pad", "padded", "padding", "portrait", "landscape", "widescreen", "squished", "squashed", "stretched", "closeup", "headroom", "center", "centre", "centered", "centred",
] as const;
export const FRAMING_NOTE_RATIOS = ["9:16", "16:9", "4:5", "1:1"] as const;
/** Two-word framing phrases. Mirrored in media.rs (`FRAMING_NOTE_PAIRS`). */
const FRAMING_NOTE_PAIRS: readonly (readonly [string, string])[] = [["punch", "in"], ["close", "up"]];
const FRAMING_WORD_SET = new Set<string>(FRAMING_NOTE_WORDS);

/** `r` stands alone in `low` (no digit or ':' right before or after it), so a timestamp such as
 * "at 1:12", "4:55" or "0:09:16" is not an aspect ratio. Rust's `has_ratio`. */
function hasRatio(low: string, r: string): boolean {
  const near = (c: string | undefined) => c !== undefined && /[0-9:]/.test(c);
  for (let i = low.indexOf(r); i !== -1; i = low.indexOf(r, i + 1)) {
    if (!near(low[i - 1]) && !near(low[i + r.length])) return true;
  }
  return false;
}

/** Is this review note about framing (fit, crop, bars, zoom, aspect…)? Pure; Rust's
 * `note_is_about_framing` is the same rule. */
export function noteIsAboutFraming(text: string): boolean {
  const low = text.toLowerCase();
  const toks = low.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return (
    toks.some((t) => FRAMING_WORD_SET.has(t)) ||
    toks.some((t, i) => FRAMING_NOTE_PAIRS.some(([a, b]) => t === a && toks[i + 1] === b)) ||
    FRAMING_NOTE_RATIOS.some((r) => hasRatio(low, r))
  );
}

/** A clip without its framing-only fields (fit, punchIn). */
const unframed = (c: Partial<TimelineClip>) => {
  const { fit: _f, punchIn: _p, ...rest } = c;
  return rest;
};

/**
 * True when applying `body` leaves clips, audio, captions, color, outputs and the output spec as
 * they are (the output's file name aside). Pure.
 *
 * The rule for resolving revision notes (run 9: round 2 kept every in/out point and only changed
 * fit fill → auto, and that resolved "Tighten the middle and end on a stronger beat"): a clip's
 * `fit` and `punchIn` are framing-only fields. Given the notes being resolved, they count as a
 * change only when one of them is about framing (`noteIsAboutFraming`); otherwise a revision that
 * changes nothing but them changes nothing the notes ask for. Without `notes` every field counts.
 * Rust's `plans_equivalent_as` (media_plan_check's unchangedSinceRender, media_note_resolve's
 * UNCHANGED_PLAN) is the same rule; Nic's manual Resolve skips both.
 */
export function planChangesNothing(m: TimelineManifest, body: EditPlanBody, notes?: Pick<Note, "text">[]): boolean {
  const next = applyEditPlan(m, body);
  const spec = (o: TimelineManifest["output"]) => ({ ...o, name: "" });
  const framingCounts = !notes || notes.some((n) => noteIsAboutFraming(n.text));
  const clipsSame = framingCounts ? same(next.clips, m.clips) : same(next.clips.map(unframed), m.clips.map(unframed));
  return clipsSame && same(next.audio, m.audio) && same(next.captions, m.captions) && same(next.color, m.color) && same(next.outputs, m.outputs) && same(spec(next.output), spec(m.output));
}

/** Only framing changed (fit / punchIn), everything else as it is (pure). */
export function planChangesOnlyFraming(m: TimelineManifest, body: EditPlanBody): boolean {
  return !planChangesNothing(m, body) && planChangesNothing(m, body, []);
}

/** The notes a revision resolves, as the manifest has them (pure). */
export const notesResolved = (m: Pick<TimelineManifest, "notes">, resolves: string[]): Note[] => resolves.map((id) => m.notes.find((n) => n.id === id)).filter((n): n is Note => !!n);

/** What the Director hears when its revision is a no-op (pure). `framingOnly`: it changed only
 * framing, which none of the notes ask for. */
export function noopRevisionRefusal(m: Pick<TimelineManifest, "notes">, resolves: string[], framingOnly = false): string {
  const notes = notesResolved(m, resolves);
  const quoted = notes.length ? notes.map((n) => `${n.id} "${n.text.length > 200 ? `${n.text.slice(0, 199)}…` : n.text}"`).join("; ") : resolves.join(", ");
  const what = framingOnly
    ? "that revision only changes framing (fit or punchIn) and keeps every clip's in and out points, which none of Nic's notes ask for"
    : "that revision changes nothing (same clips, audio, captions, color and outputs as the cut Nic's notes are on)";
  return `revise_edit refused: ${what}, so its notes stay open. Nic's notes: ${quoted}. Change the cut so it answers them.`;
}

/**
 * The no-op refusal for a revision found unchanged (pure). `fromRender` = Rust's
 * unchangedSinceRender said so: Rust compared with the noted render's snapshot (not the current
 * cut, which may hold edits made since), and ignored fit / punchIn unless a note is about
 * framing, so the reason says exactly that rather than guessing from the current cut. Otherwise
 * (the page's own check, against the current cut) `noopRevisionRefusal` as before.
 */
export function noopRevisionReason(m: TimelineManifest, body: EditPlanBody, resolves: string[], fromRender: boolean): string {
  if (!fromRender) return noopRevisionRefusal(m, resolves, planChangesOnlyFraming(m, body));
  const notes = notesResolved(m, resolves);
  if (notes.some((n) => noteIsAboutFraming(n.text))) return noopRevisionRefusal(m, resolves);
  const quoted = notes.length ? notes.map((n) => `${n.id} "${n.text.length > 200 ? `${n.text.slice(0, 199)}…` : n.text}"`).join("; ") : resolves.join(", ");
  const what =
    "that revision changes nothing Nic's notes ask for: compared with the render the notes are on, it has the same clips and in/out points, audio, captions, color and outputs (a fit or punchIn change doesn't count, since none of the notes are about framing)";
  return `revise_edit refused: ${what}, so its notes stay open. Nic's notes: ${quoted}. Change the cut so it answers them.`;
}

/**
 * The round summary the app stores for an applied revision (pure). The Director's own summary may
 * claim clip changes that never happened (run 9: "Extended the middle B-Roll clip" with every
 * in/out point unchanged), so when the revision's clips (footage, order, in/out, fades,
 * transitions) are the same as the cut it replaces, a factual prefix written by the app comes
 * first: "Clips unchanged (…); changed: framing, captions. The Director wrote: …". Otherwise, or
 * when the Director wrote no summary (no claim to correct), the Director's words as they are.
 * Compared with the cut the revision replaces (the page has no copy of the noted render's plan):
 * when nothing at all differs from it, Rust has already said the revision differs from the noted
 * render, so the difference is the edits made since, and the prefix says that.
 */
export function revisionSummary(m: TimelineManifest, body: EditPlanBody, summary: string): string {
  const next = applyEditPlan(m, body);
  const text = summary.trim();
  if (!text || !same(next.clips.map(unframed), m.clips.map(unframed))) return text;
  const spec = (o: TimelineManifest["output"]) => ({ ...o, name: "" });
  const changed = [
    !same(next.clips, m.clips) ? "framing (fit or punch-in)" : "",
    !same(next.audio, m.audio) ? "audio" : "",
    !same(next.captions, m.captions) ? "captions" : "",
    !same(next.color, m.color) ? "color" : "",
    !same(next.outputs, m.outputs) || !same(spec(next.output), spec(m.output)) ? "outputs" : "",
  ].filter(Boolean);
  const prefix = changed.length
    ? `Clips unchanged (same footage and in/out points); changed: ${changed.join(", ")}.`
    : "Clips unchanged (same footage and in/out points as the current cut, which keeps the edits made since the noted render).";
  return `${prefix} The Director wrote: ${text}`;
}

/** A trailing (or leading) "draft the brief"-style instruction, and its leftover punctuation. */
const TRAILING_ASK = /(?:^|(?<=[.!?:;\n]))\s*(?:(?:ok(?:ay)?|so|now|then|and|please|can you|could you|would you|pls)[\s,]+)*(?:draft|write|make|create|do|give me|put together|start|set up|whip up)\s+(?:me\s+|up\s+)?(?:a|an|the|my|our|this)?\s*(?:creative\s+)?brief\b[^.!?:\n]*[.!?]*\s*$/i;
const LEADING_ASK = /^\s*(?:(?:please|can you|could you|now)[\s,]+)*(?:draft|write|make|create)\s+(?:me\s+)?(?:a|an|the|my)?\s*(?:creative\s+)?brief\s*(?:for|from|about|of)?\s*(?:this|it)?\s*[:\-–—]\s*/i;

/** Does this chat line ask for a brief ("draft the brief", "write a brief: …")? Pure. */
export const asksForBrief = (line: string): boolean => LEADING_ASK.test(line.trim()) || TRAILING_ASK.test(line.trim());

/** Nic's idea from the chat line that asked for a brief (pure): the line minus a "draft the brief"
 * instruction. Null when nothing but the instruction is left. */
export function ideaFromLine(line: string): string | null {
  let t = line.trim().replace(LEADING_ASK, "").trim();
  for (let i = 0; i < 2; i++) t = t.replace(TRAILING_ASK, "").trim();
  t = t.replace(/[\s,;:\-–—]+$/, "").trim();
  return t.length >= 3 ? t.slice(0, 8000) : null;
}

/** The idea a drafted brief keeps (pure): an existing brief's idea, else Nic's recorded idea (the
 * BriefCard box), else Nic's line minus its "draft the brief" ask (only a line that asked for a
 * brief: "which clip has the best laugh?" is not an idea), else the handoff text. Null = only the
 * model's words are available (and "idea" stays guessed). */
export function briefIdeaFor(p: Pick<MediaProject, "brief" | "source">, recorded: string | null | undefined, nicLine: string | undefined): string | null {
  if (p.brief?.idea) return p.brief.idea;
  const r = recorded?.trim();
  if (r) return r.slice(0, 8000);
  const fromLine = nicLine && asksForBrief(nicLine) ? ideaFromLine(nicLine) : null;
  if (fromLine) return fromLine;
  return p.source.brief?.trim().slice(0, 8000) || null;
}
