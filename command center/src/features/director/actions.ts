/**
 * Director → UI action blocks. The Director may end a reply with fenced ```director-action
 * blocks holding exactly one `DirectorAction` each. This file extracts them, JSON-parses them and
 * validates them STRICTLY (unknown types / fields rejected, numbers clamped to the manifest rules,
 * asset / slot / note ids checked against this project). Pure: applying an action is
 * director-store's job, and no action ever renders, posts or deletes anything
 * (`execute_verified_render` only raises the Render Plan card).
 */
import type { AudioLayer, CaptionTrack, ColorLook, CreativeBrief, DirectorAction, EditPlanBody, MediaAsset, Platform, ShotSlot, TimelineClip, TimelineManifest } from "./contract";
import {
  ASPECTS,
  AUDIO_FADE_MAX,
  CAPTION_STYLES,
  CAPTION_WORDS_MAX,
  COLOR_PRESETS,
  FADE_MAX,
  FRAMINGS,
  MAX_OUTPUTS,
  MAX_PHONE_TIPS,
  PLATFORMS,
  PUNCH_MAX,
  PUNCH_MIN,
  SLOT_SOURCES,
  STILL_DEFAULT,
  TRANSITIONS,
  TRANSITION_MAX,
  VOLUME_MAX,
  clamp,
  clampRange,
  cleanOutputName,
  snapLufs,
} from "./manifest";

export const ACTION_FENCE = "director-action";
const FENCE_RE = /```director-action[^\S\r\n]*\r?\n([\s\S]*?)```/g;
export const MAX_SLOTS = 24;
export const MAX_CLIPS = 64;
export const MAX_AUDIO = 16;
export const MAX_MATCHES = 30;
export const MAX_MOMENT_SUGGESTIONS = 50;
export const MAX_DECISIONS = 10;
export const MAX_RESOLVES = 50;
export const MAX_REFERENCES = 10;

export interface ActionContext {
  assets: MediaAsset[];
  /** The open manifest: slot ids (match_footage) and note ids (revise_edit) are checked against it. */
  manifest?: Pick<TimelineManifest, "shotList" | "notes"> | null;
}

export interface ParsedActions {
  actions: DirectorAction[];
  errors: string[];
  /** The reply with every action block removed (what the chat bubble shows). */
  prose: string;
}

/** A leading line a model copies from a format example ("{json}", "json"), not JSON itself. */
const PLACEHOLDER_LINE = /^(?:\{\s*json\s*\}|json)[^\S\r\n]*\r?\n/i;

/** The raw JSON text of every ```director-action block, in order (a copied placeholder line dropped). */
export function extractActionBlocks(text: string): string[] {
  return [...text.matchAll(FENCE_RE)].map((m) => m[1].trim().replace(PLACEHOLDER_LINE, "").trim());
}

export function stripActionBlocks(text: string): string {
  return text.replace(FENCE_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** Extract + parse + validate every block. A bad block is reported, never half-applied. */
export function parseDirectorActions(text: string, ctx: ActionContext): ParsedActions {
  const actions: DirectorAction[] = [];
  const errors: string[] = [];
  extractActionBlocks(text).forEach((raw, i) => {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      errors.push(`block ${i + 1}: not valid JSON`);
      return;
    }
    const r = validateAction(json, ctx);
    if (r.ok) actions.push(r.action);
    else errors.push(`block ${i + 1}: ${r.error}`);
  });
  return { actions, errors, prose: stripActionBlocks(text) };
}

type V<T> = { ok: true; action: T } | { ok: false; error: string };
class Invalid extends Error {}
const fail = (msg: string): never => {
  throw new Invalid(msg);
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function onlyKeys(o: Record<string, unknown>, allowed: string[], where: string) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(`${where}: unknown field "${k}"`);
}
function str(o: Record<string, unknown>, k: string, where: string, max: number, required = true): string {
  const v = o[k];
  if (v === undefined && !required) return "";
  if (typeof v !== "string") return fail(`${where}: "${k}" must be a string`);
  return v.trim().slice(0, max);
}
function num(o: Record<string, unknown>, k: string, where: string): number {
  const v = o[k];
  if (typeof v !== "number" || !Number.isFinite(v)) return fail(`${where}: "${k}" must be a number`);
  return v;
}
function bool(o: Record<string, unknown>, k: string, where: string): boolean {
  const v = o[k];
  if (typeof v !== "boolean") return fail(`${where}: "${k}" must be true or false`);
  return v;
}
function arr(o: Record<string, unknown>, k: string, where: string, max: number): unknown[] {
  const v = o[k];
  if (!Array.isArray(v)) return fail(`${where}: "${k}" must be an array`);
  if (v.length > max) fail(`${where}: "${k}" has more than ${max} entries`);
  return v;
}
function oneOf<T extends string>(o: Record<string, unknown>, k: string, where: string, allowed: readonly T[]): T {
  const v = o[k];
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) return fail(`${where}: "${k}" must be one of ${allowed.join(", ")}`);
  return v as T;
}
/** A list of short strings: each trimmed and cut to `maxLen`; empty entries are an error. */
function strList(o: Record<string, unknown>, k: string, where: string, max: number, maxLen: number): string[] {
  return arr(o, k, where, max).map((v, i) => {
    if (typeof v !== "string") return fail(`${where}: "${k}" entry ${i + 1} must be a string`);
    const s = v.trim().slice(0, maxLen);
    if (!s) fail(`${where}: "${k}" entry ${i + 1} is empty`);
    return s;
  });
}
const round1 = (n: number) => Math.round(n * 10) / 10;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function validateAction(json: unknown, ctx: ActionContext): V<DirectorAction> {
  try {
    if (!isObj(json)) fail("an action must be a JSON object");
    const o = json as Record<string, unknown>;
    const type = o.type;
    switch (type) {
      case "draft_brief":
        return { ok: true, action: draftBrief(o) };
      case "populate_shot_list":
        return { ok: true, action: shotList(o) };
      case "match_footage":
        return { ok: true, action: matchFootage(o, ctx) };
      case "propose_edit_plan":
        onlyKeys(o, ["type", ...PLAN_KEYS], type);
        return { ok: true, action: { type, ...editPlanBody(o, ctx, type) } };
      case "revise_edit":
        return { ok: true, action: reviseEdit(o, ctx) };
      case "report_open_decisions": {
        onlyKeys(o, ["type", "items"], type);
        const items = strList(o, "items", type, MAX_DECISIONS, 300);
        if (!items.length) fail("report_open_decisions: no items");
        return { ok: true, action: { type, items } };
      }
      case "execute_verified_render":
        onlyKeys(o, ["type"], type);
        return { ok: true, action: { type } };
      default:
        return fail(typeof type === "string" ? `unknown action type "${type}"` : `missing "type"`);
    }
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, error: e.message };
    throw e;
  }
}

// ── draft_brief ──────────────────────────────────────────────────────────────

type BriefDraft = Extract<DirectorAction, { type: "draft_brief" }>["brief"];
/** The brief fields the Director may mark "guessed" (media.rs BRIEF_KEYS, minus the approval fields). */
export const BRIEF_FIELDS = ["idea", "goal", "platform", "lengthSec", "aspect", "tone", "references"] as const satisfies readonly (keyof CreativeBrief)[];

function draftBrief(o: Record<string, unknown>): Extract<DirectorAction, { type: "draft_brief" }> {
  onlyKeys(o, ["type", "brief"], "draft_brief");
  if (!isObj(o.brief)) return fail(`draft_brief: "brief" must be an object`);
  const b = o.brief;
  const where = "brief";
  onlyKeys(b, [...BRIEF_FIELDS, "guessed"], where);
  const idea = str(b, "idea", where, 8000);
  if (!idea) fail(`${where}: empty idea`);
  const guessed = b.guessed === undefined ? [] : arr(b, "guessed", where, BRIEF_FIELDS.length);
  const seen = new Set<string>();
  for (const g of guessed) {
    if (typeof g !== "string" || !(BRIEF_FIELDS as readonly string[]).includes(g)) fail(`${where}: "guessed" lists an unknown field ${JSON.stringify(g)}`);
    if (seen.has(g as string)) fail(`${where}: "guessed" repeats "${g as string}"`);
    seen.add(g as string);
  }
  const brief: BriefDraft = {
    idea,
    goal: str(b, "goal", where, 300, false),
    platform: oneOf<Platform>(b, "platform", where, PLATFORMS),
    lengthSec: round1(clamp(num(b, "lengthSec", where), 5, 600)),
    aspect: oneOf(b, "aspect", where, ASPECTS),
    tone: str(b, "tone", where, 200, false),
    references: b.references === undefined ? [] : strList(b, "references", where, MAX_REFERENCES, 500),
    guessed: guessed as BriefDraft["guessed"],
  };
  return { type: "draft_brief", brief };
}

// ── populate_shot_list (v2 slot details) ─────────────────────────────────────

const KINDS: ShotSlot["kind"][] = ["video", "image", "audio"];

function shotList(o: Record<string, unknown>): Extract<DirectorAction, { type: "populate_shot_list" }> {
  onlyKeys(o, ["type", "slots"], "populate_shot_list");
  const raw = arr(o, "slots", "populate_shot_list", MAX_SLOTS);
  if (!raw.length) fail("populate_shot_list: no slots");
  const seen = new Set<string>();
  const slots = raw.map((s, i) => {
    const where = `slot ${i + 1}`;
    if (!isObj(s)) return fail(`${where}: must be an object`);
    onlyKeys(s, ["id", "label", "instructions", "kind", "targetSec", "framing", "action", "source", "phoneTips"], where);
    const id = str(s, "id", where, 16);
    if (!/^[A-Za-z0-9_-]+$/.test(id)) fail(`${where}: bad id "${id}"`);
    if (seen.has(id)) fail(`${where}: duplicate id "${id}"`);
    seen.add(id);
    const label = str(s, "label", where, 80);
    if (!label) fail(`${where}: empty label`);
    const kind = s.kind;
    if (typeof kind !== "string" || !KINDS.includes(kind as ShotSlot["kind"])) return fail(`${where}: "kind" must be video, image or audio`);
    let targetSec: number | null = null;
    if (s.targetSec !== undefined && s.targetSec !== null) targetSec = round1(clamp(num(s, "targetSec", where), 0.2, 600));
    const framing = s.framing === undefined || s.framing === null ? null : oneOf(s, "framing", where, FRAMINGS);
    const source = s.source === undefined ? "film" : oneOf(s, "source", where, SLOT_SOURCES);
    const phoneTips = s.phoneTips === undefined ? [] : strList(s, "phoneTips", where, MAX_PHONE_TIPS, 120);
    return { id, label, instructions: str(s, "instructions", where, 600, false), kind: kind as ShotSlot["kind"], targetSec, framing, action: str(s, "action", where, 500, false), source, phoneTips };
  });
  return { type: "populate_shot_list", slots };
}

// ── match_footage ────────────────────────────────────────────────────────────

function assetLookup(ctx: ActionContext) {
  const byId = new Map(ctx.assets.map((a) => [a.id, a]));
  return (v: unknown, where: string): MediaAsset => {
    if (typeof v !== "string") return fail(`${where}: "assetId" must be a string`);
    const a = byId.get(v);
    return a ?? fail(`${where}: asset "${v}" is not in this project`);
  };
}

function matchFootage(o: Record<string, unknown>, ctx: ActionContext): Extract<DirectorAction, { type: "match_footage" }> {
  onlyKeys(o, ["type", "matches", "moments"], "match_footage");
  const asset = assetLookup(ctx);
  const slots = new Map((ctx.manifest?.shotList ?? []).map((s) => [s.id, s]));
  const rawMatches = o.matches === undefined ? [] : arr(o, "matches", "match_footage", MAX_MATCHES);
  const slotSeen = new Set<string>();
  const matches = rawMatches.map((m, i) => {
    const where = `match ${i + 1}`;
    if (!isObj(m)) return fail(`${where}: must be an object`);
    onlyKeys(m, ["assetId", "slotId", "reason"], where);
    const a = asset(m.assetId, where);
    if (typeof m.slotId !== "string") return fail(`${where}: "slotId" must be a string`);
    const slot = slots.get(m.slotId) ?? fail(`${where}: slot "${m.slotId}" is not in the shot list`);
    if (slot.kind !== a.kind) fail(`${where}: "${a.id}" is ${a.kind} but slot "${slot.id}" wants ${slot.kind}`);
    if (slotSeen.has(slot.id)) fail(`${where}: slot "${slot.id}" is matched twice`);
    slotSeen.add(slot.id);
    return { assetId: a.id, slotId: slot.id, reason: str(m, "reason", where, 300, false) };
  });
  const rawMoments = o.moments === undefined ? [] : arr(o, "moments", "match_footage", MAX_MOMENT_SUGGESTIONS);
  const moments = rawMoments.map((m, i) => {
    const where = `moment ${i + 1}`;
    if (!isObj(m)) return fail(`${where}: must be an object`);
    onlyKeys(m, ["assetId", "inSec", "outSec", "label", "score"], where);
    const a = asset(m.assetId, where);
    if (a.kind === "image") fail(`${where}: "${a.id}" is a still; moments are for video or audio`);
    const r = clampRange(a, num(m, "inSec", where), num(m, "outSec", where));
    return { assetId: a.id, ...r, label: str(m, "label", where, 120, false), score: round3(clamp(m.score === undefined ? 0.5 : num(m, "score", where), 0, 1)) };
  });
  if (!matches.length && !moments.length) fail("match_footage: no matches or moments");
  return { type: "match_footage", matches, moments };
}

// ── propose_edit_plan body (v2: transitions, punch-in, audio fades, captions, color, outputs) ──

const PLAN_KEYS = ["clips", "audio", "output", "captions", "color", "outputs", "note"];

function editPlanBody(o: Record<string, unknown>, ctx: ActionContext, where0: string): EditPlanBody {
  const asset = assetLookup(ctx);

  const rawClips = arr(o, "clips", where0, MAX_CLIPS);
  if (!rawClips.length) fail(`${where0}: no clips`);
  const clips: Omit<TimelineClip, "id">[] = rawClips.map((c, i) => {
    const where = `clip ${i + 1}`;
    if (!isObj(c)) return fail(`${where}: must be an object`);
    onlyKeys(c, ["assetId", "inSec", "outSec", "fadeMs", "transitionIn", "punchIn"], where);
    const a = asset(c.assetId, where);
    if (a.kind === "audio") fail(`${where}: "${a.id}" is audio — put it in "audio"`);
    // Stills: inSec is ignored (0) and outSec is the hold length (default 3 s, clamped 0.2–60).
    const r = a.kind === "image" ? clampRange(a, 0, c.outSec === undefined ? STILL_DEFAULT : num(c, "outSec", where)) : clampRange(a, num(c, "inSec", where), num(c, "outSec", where));
    const fadeMs = c.fadeMs === undefined ? 0 : Math.round(clamp(num(c, "fadeMs", where), 0, FADE_MAX));
    let transitionIn: TimelineClip["transitionIn"] = { kind: "cut", ms: 0 };
    if (c.transitionIn !== undefined) {
      if (!isObj(c.transitionIn)) return fail(`${where}: "transitionIn" must be an object`);
      const t = c.transitionIn;
      onlyKeys(t, ["kind", "ms"], `${where} transitionIn`);
      const kind = oneOf(t, "kind", `${where} transitionIn`, TRANSITIONS);
      const ms = kind === "cut" || t.ms === undefined ? 0 : Math.round(clamp(num(t, "ms", `${where} transitionIn`), 0, TRANSITION_MAX));
      transitionIn = { kind, ms: kind === "cut" ? 0 : ms };
    }
    const punchIn = c.punchIn === undefined ? 1 : round3(clamp(num(c, "punchIn", where), PUNCH_MIN, PUNCH_MAX));
    return { assetId: a.id, ...r, fadeMs, transitionIn, punchIn };
  });

  const rawAudio = o.audio === undefined ? [] : arr(o, "audio", where0, MAX_AUDIO);
  const audio: Omit<AudioLayer, "id">[] = rawAudio.map((l, i) => {
    const where = `audio ${i + 1}`;
    if (!isObj(l)) return fail(`${where}: must be an object`);
    onlyKeys(l, ["assetId", "startSec", "inSec", "outSec", "volume", "fadeInMs", "fadeOutMs", "duckUnderVoice"], where);
    const a = asset(l.assetId, where);
    if (a.kind !== "audio") fail(`${where}: "${a.id}" is not an audio asset (a video clip plays its own sound: leave "audio" [] unless there is a music or voiceover asset)`);
    const inSec = l.inSec === undefined ? 0 : num(l, "inSec", where);
    const outSec = l.outSec === undefined ? (a.durationSec ?? 86_400) : num(l, "outSec", where);
    const r = clampRange(a, inSec, outSec);
    const fade = (k: string) => (l[k] === undefined ? 0 : Math.round(clamp(num(l, k, where), 0, AUDIO_FADE_MAX)));
    return {
      assetId: a.id,
      startSec: round3(clamp(l.startSec === undefined ? 0 : num(l, "startSec", where), 0, 86_400)),
      ...r,
      volume: round3(clamp(l.volume === undefined ? 1 : num(l, "volume", where), 0, VOLUME_MAX)),
      fadeInMs: fade("fadeInMs"),
      fadeOutMs: fade("fadeOutMs"),
      duckUnderVoice: l.duckUnderVoice === undefined ? false : bool(l, "duckUnderVoice", where),
    };
  });

  const output: Partial<TimelineManifest["output"]> = {};
  if (o.output !== undefined) {
    if (!isObj(o.output)) fail(`${where0}: "output" must be an object`);
    const out = o.output as Record<string, unknown>;
    onlyKeys(out, ["aspect", "loudnessLufs", "maxSizeMb", "name"], "output");
    if (out.aspect !== undefined) output.aspect = oneOf(out, "aspect", "output", ASPECTS);
    if (out.loudnessLufs !== undefined) output.loudnessLufs = snapLufs(num(out, "loudnessLufs", "output"));
    if (out.maxSizeMb !== undefined) {
      const mb = out.maxSizeMb === null ? null : num(out, "maxSizeMb", "output");
      output.maxSizeMb = mb === null || mb <= 0 ? null : Math.round(clamp(mb, 1, 4096));
    }
    if (out.name !== undefined) output.name = cleanOutputName(str(out, "name", "output", 120));
  }

  const body: EditPlanBody = { clips, audio, output, note: o.note === undefined ? "" : str(o, "note", where0, 1000) };

  if (o.captions !== undefined) {
    if (!isObj(o.captions)) return fail(`${where0}: "captions" must be an object`);
    const c = o.captions;
    onlyKeys(c, ["enabled", "style", "position", "maxWordsPerLine"], "captions");
    const captions: Partial<CaptionTrack> = {};
    if (c.enabled !== undefined) captions.enabled = bool(c, "enabled", "captions");
    if (c.style !== undefined) captions.style = oneOf(c, "style", "captions", CAPTION_STYLES);
    if (c.position !== undefined) captions.position = oneOf(c, "position", "captions", ["lower", "middle"] as const);
    if (c.maxWordsPerLine !== undefined) captions.maxWordsPerLine = Math.round(clamp(num(c, "maxWordsPerLine", "captions"), 1, CAPTION_WORDS_MAX));
    body.captions = captions;
  }
  if (o.color !== undefined) {
    if (!isObj(o.color)) return fail(`${where0}: "color" must be an object`);
    const c = o.color;
    onlyKeys(c, ["preset", "strength"], "color");
    const color: Partial<ColorLook> = {};
    if (c.preset !== undefined) color.preset = oneOf(c, "preset", "color", COLOR_PRESETS);
    if (c.strength !== undefined) color.strength = round3(clamp(num(c, "strength", "color"), 0, 1));
    body.color = color;
  }
  if (o.outputs !== undefined) {
    const raw = arr(o, "outputs", where0, MAX_OUTPUTS);
    if (!raw.length) fail(`${where0}: "outputs" is empty (leave it out for one output)`);
    const seen = new Set<string>();
    body.outputs = raw.map((p, i) => {
      if (typeof p !== "string" || !(PLATFORMS as readonly string[]).includes(p)) return fail(`outputs: entry ${i + 1} must be one of ${PLATFORMS.join(", ")}`);
      if (seen.has(p)) fail(`outputs: "${p}" is listed twice`);
      seen.add(p);
      return p as Platform;
    });
  }
  return body;
}

// ── revise_edit ──────────────────────────────────────────────────────────────

function reviseEdit(o: Record<string, unknown>, ctx: ActionContext): Extract<DirectorAction, { type: "revise_edit" }> {
  onlyKeys(o, ["type", "round", "resolves", "plan", "summary"], "revise_edit");
  const round = o.round;
  if (round !== 1 && round !== 2) return fail(`revise_edit: "round" must be 1 or 2`);
  const notes = new Map((ctx.manifest?.notes ?? []).map((n) => [n.id, n]));
  const resolves = strList(o, "resolves", "revise_edit", MAX_RESOLVES, 40);
  if (!resolves.length) fail("revise_edit: \"resolves\" names no notes");
  const seen = new Set<string>();
  for (const id of resolves) {
    const n = notes.get(id) ?? fail(`revise_edit: note "${id}" is not in this project`);
    if (n.resolved) fail(`revise_edit: note "${id}" is already resolved`);
    if (seen.has(id)) fail(`revise_edit: note "${id}" is listed twice`);
    seen.add(id);
  }
  if (!isObj(o.plan)) return fail(`revise_edit: "plan" must be an object`);
  onlyKeys(o.plan, PLAN_KEYS, "plan");
  const plan = editPlanBody(o.plan, ctx, "plan");
  return { type: "revise_edit", round, resolves, plan, summary: str(o, "summary", "revise_edit", 1000, false) };
}

/** A validated `revise_edit` plan is an `EditPlanBody` (the contract types it loosely). */
export const revisePlanBody = (a: Extract<DirectorAction, { type: "revise_edit" }>): EditPlanBody => a.plan as unknown as EditPlanBody;
