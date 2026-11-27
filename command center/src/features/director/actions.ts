/**
 * Director → UI action blocks. The Director may end a reply with fenced ```director-action
 * blocks holding exactly one `DirectorAction` each. This file extracts them, JSON-parses them and
 * validates them STRICTLY (unknown types / fields rejected, numbers clamped to the manifest rules,
 * asset ids checked against this project). Pure: applying an action is director-store's job, and
 * no action ever renders anything (`execute_verified_render` only raises the Render Plan card).
 */
import type { AudioLayer, DirectorAction, MediaAsset, ShotSlot, TimelineClip, TimelineManifest } from "./contract";
import { ASPECTS, FADE_MAX, STILL_DEFAULT, VOLUME_MAX, clamp, clampRange, cleanOutputName, snapLufs } from "./manifest";

export const ACTION_FENCE = "director-action";
const FENCE_RE = /```director-action[^\S\r\n]*\r?\n([\s\S]*?)```/g;
export const MAX_SLOTS = 24;
export const MAX_CLIPS = 64;
export const MAX_AUDIO = 16;

export interface ActionContext {
  assets: MediaAsset[];
}

export interface ParsedActions {
  actions: DirectorAction[];
  errors: string[];
  /** The reply with every action block removed (what the chat bubble shows). */
  prose: string;
}

/** The raw JSON text of every ```director-action block, in order. */
export function extractActionBlocks(text: string): string[] {
  return [...text.matchAll(FENCE_RE)].map((m) => m[1].trim());
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
function arr(o: Record<string, unknown>, k: string, where: string, max: number): unknown[] {
  const v = o[k];
  if (!Array.isArray(v)) return fail(`${where}: "${k}" must be an array`);
  if (v.length > max) fail(`${where}: "${k}" has more than ${max} entries`);
  return v;
}

export function validateAction(json: unknown, ctx: ActionContext): V<DirectorAction> {
  try {
    if (!isObj(json)) fail("an action must be a JSON object");
    const o = json as Record<string, unknown>;
    const type = o.type;
    switch (type) {
      case "populate_shot_list":
        return { ok: true, action: shotList(o) };
      case "propose_edit_plan":
        return { ok: true, action: editPlan(o, ctx) };
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

const KINDS: ShotSlot["kind"][] = ["video", "image", "audio"];

function shotList(o: Record<string, unknown>): Extract<DirectorAction, { type: "populate_shot_list" }> {
  onlyKeys(o, ["type", "slots"], "populate_shot_list");
  const raw = arr(o, "slots", "populate_shot_list", MAX_SLOTS);
  if (!raw.length) fail("populate_shot_list: no slots");
  const seen = new Set<string>();
  const slots = raw.map((s, i) => {
    const where = `slot ${i + 1}`;
    if (!isObj(s)) return fail(`${where}: must be an object`);
    onlyKeys(s, ["id", "label", "instructions", "kind", "targetSec"], where);
    const id = str(s, "id", where, 16);
    if (!/^[A-Za-z0-9_-]+$/.test(id)) fail(`${where}: bad id "${id}"`);
    if (seen.has(id)) fail(`${where}: duplicate id "${id}"`);
    seen.add(id);
    const label = str(s, "label", where, 80);
    if (!label) fail(`${where}: empty label`);
    const kind = s.kind;
    if (typeof kind !== "string" || !KINDS.includes(kind as ShotSlot["kind"])) return fail(`${where}: "kind" must be video, image or audio`);
    let targetSec: number | null = null;
    if (s.targetSec !== undefined && s.targetSec !== null) targetSec = Math.round(clamp(num(s, "targetSec", where), 0.2, 600) * 10) / 10;
    return { id, label, instructions: str(s, "instructions", where, 600, false), kind: kind as ShotSlot["kind"], targetSec };
  });
  return { type: "populate_shot_list", slots };
}

function editPlan(o: Record<string, unknown>, ctx: ActionContext): Extract<DirectorAction, { type: "propose_edit_plan" }> {
  onlyKeys(o, ["type", "clips", "audio", "output", "note"], "propose_edit_plan");
  const byId = new Map(ctx.assets.map((a) => [a.id, a]));
  const asset = (v: unknown, where: string): MediaAsset => {
    if (typeof v !== "string") return fail(`${where}: "assetId" must be a string`);
    const a = byId.get(v);
    return a ?? fail(`${where}: asset "${v}" is not in this project`);
  };

  const rawClips = arr(o, "clips", "propose_edit_plan", MAX_CLIPS);
  if (!rawClips.length) fail("propose_edit_plan: no clips");
  const clips: Omit<TimelineClip, "id">[] = rawClips.map((c, i) => {
    const where = `clip ${i + 1}`;
    if (!isObj(c)) return fail(`${where}: must be an object`);
    onlyKeys(c, ["assetId", "inSec", "outSec", "fadeMs"], where);
    const a = asset(c.assetId, where);
    if (a.kind === "audio") fail(`${where}: "${a.id}" is audio — put it in "audio"`);
    // Stills: inSec is ignored (0) and outSec is the hold length (default 3 s, clamped 0.2–60).
    const r = a.kind === "image" ? clampRange(a, 0, c.outSec === undefined ? STILL_DEFAULT : num(c, "outSec", where)) : clampRange(a, num(c, "inSec", where), num(c, "outSec", where));
    const fadeMs = c.fadeMs === undefined ? 0 : Math.round(clamp(num(c, "fadeMs", where), 0, FADE_MAX));
    return { assetId: a.id, ...r, fadeMs };
  });

  const rawAudio = o.audio === undefined ? [] : arr(o, "audio", "propose_edit_plan", MAX_AUDIO);
  const audio: Omit<AudioLayer, "id">[] = rawAudio.map((l, i) => {
    const where = `audio ${i + 1}`;
    if (!isObj(l)) return fail(`${where}: must be an object`);
    onlyKeys(l, ["assetId", "startSec", "inSec", "outSec", "volume"], where);
    const a = asset(l.assetId, where);
    if (a.kind !== "audio") fail(`${where}: "${a.id}" is not an audio asset`);
    const inSec = l.inSec === undefined ? 0 : num(l, "inSec", where);
    const outSec = l.outSec === undefined ? (a.durationSec ?? 86_400) : num(l, "outSec", where);
    const r = clampRange(a, inSec, outSec);
    return {
      assetId: a.id,
      startSec: Math.round(clamp(l.startSec === undefined ? 0 : num(l, "startSec", where), 0, 86_400) * 1000) / 1000,
      ...r,
      volume: Math.round(clamp(l.volume === undefined ? 1 : num(l, "volume", where), 0, VOLUME_MAX) * 1000) / 1000,
    };
  });

  const output: Partial<TimelineManifest["output"]> = {};
  if (o.output !== undefined) {
    if (!isObj(o.output)) fail(`propose_edit_plan: "output" must be an object`);
    const out = o.output as Record<string, unknown>;
    onlyKeys(out, ["aspect", "loudnessLufs", "maxSizeMb", "name"], "output");
    if (out.aspect !== undefined) {
      if (typeof out.aspect !== "string" || !(ASPECTS as readonly string[]).includes(out.aspect)) fail(`output: "aspect" must be one of ${ASPECTS.join(", ")}`);
      output.aspect = out.aspect as TimelineManifest["output"]["aspect"];
    }
    if (out.loudnessLufs !== undefined) output.loudnessLufs = snapLufs(num(out, "loudnessLufs", "output"));
    if (out.maxSizeMb !== undefined) {
      const mb = out.maxSizeMb === null ? null : num(out, "maxSizeMb", "output");
      output.maxSizeMb = mb === null || mb <= 0 ? null : Math.round(clamp(mb, 1, 4096));
    }
    if (out.name !== undefined) output.name = cleanOutputName(str(out, "name", "output", 120));
  }

  const note = o.note === undefined ? "" : str(o, "note", "propose_edit_plan", 1000);
  return { type: "propose_edit_plan", clips, audio, output, note };
}
