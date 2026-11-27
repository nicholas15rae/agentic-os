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
import type { EditPlanBody, MediaProject, PlanCheck, PlanCheckClip, PlanCheckPlan, TimelineClip, TimelineManifest } from "./contract";
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

/** True when applying `body` leaves clips, audio, captions, color, outputs and the output spec as
 * they are (the output's file name aside). Pure. */
export function planChangesNothing(m: TimelineManifest, body: EditPlanBody): boolean {
  const next = applyEditPlan(m, body);
  const spec = (o: TimelineManifest["output"]) => ({ ...o, name: "" });
  return same(next.clips, m.clips) && same(next.audio, m.audio) && same(next.captions, m.captions) && same(next.color, m.color) && same(next.outputs, m.outputs) && same(spec(next.output), spec(m.output));
}

/** What the Director hears when its revision is a no-op (pure). */
export function noopRevisionRefusal(m: Pick<TimelineManifest, "notes">, resolves: string[]): string {
  const notes = resolves.map((id) => m.notes.find((n) => n.id === id)).filter((n) => !!n);
  const quoted = notes.length ? notes.map((n) => `${n.id} "${n.text.length > 200 ? `${n.text.slice(0, 199)}…` : n.text}"`).join("; ") : resolves.join(", ");
  return `revise_edit refused: that revision changes nothing (same clips, audio, captions, color and outputs as the cut Nic's notes are on), so its notes stay open. Nic's notes: ${quoted}. Change the cut so it answers them.`;
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
