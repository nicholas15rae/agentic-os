/**
 * Live E2E step runner (opt-in: E2E_LIVE=1, run only through vitest.e2e.config.ts by the Rust
 * harness in src-tauri/src/commands/media_e2e.rs). It runs the REAL page modules on the project
 * snapshot Rust wrote, with no mocks:
 *
 *   E2E_STEP=context  snapshot.json → buildDirectorContext → out-context.json
 *   E2E_STEP=plans    snapshot.json + reply.txt [+ turn.json] → out-plans.json
 *                     { plans: [{ index, type, clips }] }: the clips each propose_edit_plan /
 *                     revise_edit the page would send to media_plan_check, in reply order. Rust
 *                     runs plan_check on each and writes plan-check.json (the results, same order).
 *   E2E_STEP=apply    snapshot.json + reply.txt [+ turn.json] [+ plan-check.json] →
 *                     parseDirectorActions → the effects applyDirectorActions (director-store.ts)
 *                     would cause, computed with the real manifest ops (setShotList, attachSlot,
 *                     applyEditPlan, reviseRefusal), the plan check's snapped clips / refusals,
 *                     the revision no-op refusal, Nic's idea kept word for word, and Nic's accept
 *                     clicks on every suggestion → out-apply.json { parsed, effects, notes,
 *                     warnings, refusals, autoFix }. `autoFix` is the ONE corrective turn the page
 *                     sends ({ prompt, shown, only }) or null: Rust sends `prompt` as the next turn
 *                     (with turn.json { isFix: true, only, nicLine }) and never fixes a fix.
 *
 * turn.json (optional): { nicLine?: string; briefIdea?: string; only?: string[]; isFix?: boolean }
 * — what sendDirectorTurn knows about the turn: the line Nic typed (a first brief's idea comes from
 * it), the BriefCard idea box, an automatic turn's allowlist, and whether this is the auto-fix.
 * Without plan-check.json the plans apply unchecked (and out-apply.json says so).
 *
 * Rust then carries each effect out through the real media.rs functions (project_update,
 * manifest_save, asset_update, build_plan, review_write …). Nothing here talks to the model,
 * renders or touches media files.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "node:process";
import { describe, expect, it, vi } from "vitest";
import type { AssetTranscriptLines, CreativeBrief, DirectorAction, EditPlanBody, MediaAsset, MediaProject, Moment, ProjectReview, TimelineManifest } from "../contract";
import { parseDirectorActions, revisePlanBody } from "../actions";
import { buildDirectorContext } from "../context";
import { attachSlot, applyEditPlan, newId, setShotList, upgradeAsset, upgradeManifest, upgradeProject } from "../manifest";
import type { reviseRefusal as ReviseRefusal } from "../director-store";
import type * as Chat from "../director-chat";
import { briefIdeaFor, checkPlanFor, noopRevisionReason, notesResolved, planChangesNothing, revisionSummary, withCheckedClips, type CheckedClip, type PlanCheckResult } from "../plan-check";
import type { PlanCheckPlan } from "../contract";

// director-store / director-chat reach the webview (toasts → voice, Tauri IPC); none of that is
// used by the pure functions this runner calls, so only those side-effect modules are stubbed.
vi.mock("@/features/reminders/notify", () => ({ useToasts: { getState: () => ({ push: () => undefined }) } }));
vi.mock("@/lib/platform", () => ({ onNativeEvent: async () => () => undefined }));
vi.mock("../api", () => ({ api: {}, onDirectorEvent: async () => () => undefined }));
const { reviseRefusal } = (await import("../director-store")) as { reviseRefusal: typeof ReviseRefusal };
const { allowActions, autoFixLine, autoFixPrompt, fixAllowlist, turnProblems } = (await import("../director-chat")) as typeof Chat;

interface Snapshot {
  project: unknown;
  assets: unknown[];
  manifest: unknown;
  review?: ProjectReview | null;
}

/** What one validated action does to the studio, in the order applyDirectorActions does it. */
export type Effect =
  | { kind: "project_update"; brief: CreativeBrief }
  | { kind: "brief_held"; brief: CreativeBrief }
  | { kind: "manifest_save"; by: "nic" | "director"; manifest: TimelineManifest; why: string }
  | { kind: "asset_slot"; assetId: string; slotId: string }
  | { kind: "asset_moments"; assetId: string; moments: Moment[] }
  | { kind: "review_write"; round: 1 | 2; summary?: string; openDecisions?: string[] }
  | { kind: "render_plan"; resolves: string[] }
  | { kind: "refused"; action: DirectorAction["type"]; why: string };

/** turn.json: what sendDirectorTurn knows about this turn. */
export interface TurnInfo {
  nicLine?: string;
  briefIdea?: string;
  only?: DirectorAction["type"][];
  isFix?: boolean;
}

export interface PlanInput {
  index: number;
  type: "propose_edit_plan" | "revise_edit";
  clips: CheckedClip[];
  /** checkPlanFor (director-store checkedBody): the plan merged into the manifest as it stands
   * when the store checks it, plus a revision's note ids. Absent without a manifest. */
  plan?: PlanCheckPlan;
}

/** What each plan action sends to media_plan_check (pure): its clips and, given the manifest, the
 * rest of the plan (checkPlanFor). Earlier plans in the same reply are merged in first, as the
 * store would have applied them by then (checkPlanFor reads no clips, so snapping can't matter). */
export function planInputs(actions: DirectorAction[], manifest?: TimelineManifest): PlanInput[] {
  const out: PlanInput[] = [];
  let m = manifest;
  actions.forEach((a, index) => {
    if (a.type !== "propose_edit_plan" && a.type !== "revise_edit") return;
    const body: EditPlanBody = a.type === "propose_edit_plan" ? a : revisePlanBody(a);
    const resolves = a.type === "revise_edit" ? a.resolves : undefined;
    out.push({ index, type: a.type, clips: body.clips, ...(m ? { plan: checkPlanFor(m, body, resolves) } : {}) });
    if (m) m = applyEditPlan(m, body);
  });
  return out;
}

export interface EffectsOpts {
  /** media_plan_check results for the plan actions, in reply order (absent = unchecked). */
  checks?: PlanCheckResult[] | null;
  nicLine?: string;
  briefIdea?: string | null;
}
export interface EffectsOut {
  effects: Effect[];
  notes: string[];
  warnings: string[];
  refusals: string[];
  refusedTypes: DirectorAction["type"][];
  /** Action types that did something (an effect other than a refusal). */
  appliedTypes: DirectorAction["type"][];
}

const live = env.E2E_LIVE === "1";
const dir = env.E2E_DIR ?? "";

function load(): { project: MediaProject; assets: MediaAsset[]; manifest: TimelineManifest; review: ProjectReview | null; transcripts: AssetTranscriptLines[] } {
  const s = JSON.parse(readFileSync(join(dir, "snapshot.json"), "utf8")) as Snapshot & { transcripts?: AssetTranscriptLines[] };
  const project = upgradeProject(s.project);
  return { project, assets: s.assets.map(upgradeAsset), manifest: upgradeManifest(s.manifest), review: s.review ?? project.review ?? null, transcripts: Array.isArray(s.transcripts) ? s.transcripts : [] };
}

/** applyDirectorActions (director-store.ts), pure: the same branches, with Nic accepting every match and moment. */
export function effectsFor(actions: DirectorAction[], project: MediaProject, assets: MediaAsset[], manifest: TimelineManifest, review: ProjectReview | null, opts: EffectsOpts = {}): EffectsOut {
  const effects: Effect[] = [];
  const notes: string[] = [];
  const warnings: string[] = [];
  const refusals: string[] = [];
  const refusedTypes: DirectorAction["type"][] = [];
  let m = manifest;
  let p = project;
  let briefIdea = opts.briefIdea ?? null;
  let planNo = 0;
  /** The last plan check's answer (its unchangedSinceRender decides a revision's no-op test). */
  let lastCheck: PlanCheckResult | null = null;
  const now = () => new Date().toISOString();
  /** director-store checkedBody: the snapped clips, or null when the plan check refused it. */
  const checked = (body: EditPlanBody, type: "propose_edit_plan" | "revise_edit"): EditPlanBody | null => {
    const r = opts.checks ? (opts.checks[planNo] ?? null) : null;
    planNo++;
    lastCheck = r;
    if (!r) return body;
    warnings.push(...r.warnings);
    if (r.refusals.length) {
      notes.push(`${type === "revise_edit" ? "Revision" : "Edit plan"} not applied: ${r.refusals.join("; ")}`);
      for (const x of r.refusals) refusals.push(`${type} refused by the plan check: ${x}`);
      refusedTypes.push(type);
      effects.push({ kind: "refused", action: type, why: `plan check: ${r.refusals.join("; ")}` });
      return null;
    }
    return withCheckedClips(body, r);
  };
  const appliedTypes: DirectorAction["type"][] = [];
  for (const a of actions) {
    const before = effects.length;
    applyOne(a);
    if (effects.slice(before).some((e) => e.kind !== "refused") && !appliedTypes.includes(a.type)) appliedTypes.push(a.type);
  }
  return { effects, notes, warnings, refusals, refusedTypes, appliedTypes };

  function applyOne(a: DirectorAction): void {
    switch (a.type) {
      case "draft_brief": {
        const prev = p.brief;
        const nicIdea = briefIdeaFor(p, briefIdea, opts.nicLine);
        const brief: CreativeBrief = {
          ...a.brief,
          idea: nicIdea || a.brief.idea,
          guessed: nicIdea ? a.brief.guessed.filter((g) => g !== "idea") : a.brief.guessed,
          approved: false,
          updatedBy: "director",
          updatedAt: now(),
        };
        if (prev?.approved) {
          effects.push({ kind: "brief_held", brief });
          notes.push("Brief draft held: your approved brief stays until you accept the draft");
        } else {
          effects.push({ kind: "project_update", brief });
          p = { ...p, brief };
          briefIdea = null;
          notes.push(`Brief drafted for your approval (${brief.guessed.length} guessed)`);
        }
        break;
      }
      case "populate_shot_list":
        m = setShotList(m, a.slots);
        // editManifest → the debounced flushSave(), which saves as "nic" (director-store.ts).
        effects.push({ kind: "manifest_save", by: "nic", manifest: m, why: "populate_shot_list" });
        notes.push(`Shot list: ${a.slots.length} slots`);
        break;
      case "match_footage": {
        // acceptMatch per suggestion (Nic's click): attach → save → mirror slotId on the asset.
        const accepted: { assetId: string; slotId: string }[] = [];
        for (const x of a.matches) {
          if (m.shotList.find((sl) => sl.id === x.slotId)?.assetId === x.assetId) continue;
          const asset = assets.find((q) => q.id === x.assetId);
          const next = asset ? attachSlot(m, x.slotId, asset) : m;
          if (!asset || next.shotList.find((s) => s.id === x.slotId)?.assetId !== asset.id) {
            effects.push({ kind: "refused", action: a.type, why: `match ${x.assetId}→${x.slotId} no longer fits` });
            continue;
          }
          m = next;
          accepted.push({ assetId: x.assetId, slotId: x.slotId });
        }
        if (accepted.length) {
          effects.push({ kind: "manifest_save", by: "nic", manifest: m, why: `accept ${accepted.length} match(es)` });
          for (const x of accepted) effects.push({ kind: "asset_slot", ...x });
        }
        // acceptMoment per suggestion: appended to the asset's moments, by: director.
        const byAsset = new Map<string, Moment[]>();
        for (const x of a.moments) {
          const asset = assets.find((q) => q.id === x.assetId);
          if (!asset) continue;
          const list = byAsset.get(x.assetId) ?? [...asset.moments];
          list.push({ id: newId("m"), inSec: x.inSec, outSec: x.outSec, label: x.label, score: x.score, by: "director" });
          byAsset.set(x.assetId, list);
        }
        for (const [assetId, moments] of byAsset) effects.push({ kind: "asset_moments", assetId, moments });
        notes.push(`Accepted ${accepted.length} match(es) and ${a.moments.length} moment(s)`);
        break;
      }
      case "propose_edit_plan": {
        const body = checked(a as EditPlanBody, a.type);
        if (!body) break;
        m = applyEditPlan(m, body);
        effects.push({ kind: "manifest_save", by: "director", manifest: m, why: "propose_edit_plan" });
        effects.push({ kind: "render_plan", resolves: [] });
        notes.push(`Edit plan: ${body.clips.length} clips, ${body.audio.length} audio layers`);
        break;
      }
      case "revise_edit": {
        const refusal = reviseRefusal(a.round, review, null);
        if (refusal) {
          // The store never checks a refused revision, but planInputs listed it: skip its result
          // so later plans in this reply keep their own (checks are in planInputs order).
          planNo++;
          effects.push({ kind: "refused", action: a.type, why: refusal });
          notes.push(`Revision not applied: ${refusal}`);
          break;
        }
        const body = checked(revisePlanBody(a), a.type);
        if (!body) break;
        // (cast: TS narrows a closure-assigned `let` to its initial null)
        const fromRender = (lastCheck as PlanCheckResult | null)?.unchangedSinceRender;
        if (fromRender ?? planChangesNothing(m, body, notesResolved(m, a.resolves))) {
          const why = noopRevisionReason(m, body, a.resolves, fromRender === true);
          effects.push({ kind: "refused", action: a.type, why });
          notes.push("Revision not applied: it changes nothing, so your notes stay open");
          refusals.push(why);
          refusedTypes.push(a.type);
          break;
        }
        const summary = revisionSummary(m, body, a.summary);
        m = applyEditPlan(m, body);
        effects.push({ kind: "manifest_save", by: "director", manifest: m, why: "revise_edit" });
        if (summary.trim()) effects.push({ kind: "review_write", round: a.round, summary: summary.slice(0, 2000) });
        effects.push({ kind: "render_plan", resolves: a.resolves });
        notes.push(`Round ${a.round} revision: ${body.clips.length} clips, answers ${a.resolves.length} note(s)`);
        break;
      }
      case "report_open_decisions": {
        const rounds = review?.rounds ?? [];
        effects.push({ kind: "review_write", round: rounds[rounds.length - 1]?.round ?? 1, openDecisions: a.items });
        notes.push(`Open decisions: ${a.items.length}`);
        break;
      }
      case "execute_verified_render":
        effects.push({ kind: "render_plan", resolves: [] });
        notes.push("Render plan raised for your approval");
        break;
    }
  }
}

const readJson = <T>(name: string): T | null => (existsSync(join(dir, name)) ? (JSON.parse(readFileSync(join(dir, name), "utf8")) as T) : null);

describe.skipIf(!live)("director live e2e step", () => {
  it(`runs ${env.E2E_STEP ?? "?"}`, () => {
    expect(dir).not.toBe("");
    const { project, assets, manifest, review, transcripts } = load();
    if (env.E2E_STEP === "context") {
      const context = buildDirectorContext(project, assets, manifest, review, transcripts);
      writeFileSync(join(dir, "out-context.json"), JSON.stringify({ context, chars: context.length }, null, 2));
      return;
    }
    const reply = readFileSync(join(dir, "reply.txt"), "utf8");
    const turn = readJson<TurnInfo>("turn.json") ?? {};
    const parsed = parseDirectorActions(reply, { assets, manifest });
    // sendDirectorTurn: an automatic turn (or its fix) applies only its allowlist.
    const { actions, refused } = allowActions(parsed.actions, turn.only);
    if (env.E2E_STEP === "plans") {
      writeFileSync(join(dir, "out-plans.json"), JSON.stringify({ plans: planInputs(actions, manifest) }, null, 2));
      return;
    }
    expect(env.E2E_STEP).toBe("apply");
    const checks = readJson<PlanCheckResult[]>("plan-check.json");
    const out = effectsFor(actions, project, assets, manifest, review, { checks, nicLine: turn.nicLine, briefIdea: turn.briefIdea ?? null });
    // The one auto-fix: never for a fix, only for failed types within the allowlist.
    const problems = turnProblems(reply, parsed.errors, out.refusals, out.refusedTypes);
    const only = problems.problems.length && !turn.isFix ? fixAllowlist(problems.types, turn.only) : false;
    const autoFix = only === false ? null : { prompt: autoFixPrompt(problems), shown: autoFixLine(problems.problems), only: only ?? null };
    writeFileSync(join(dir, "out-apply.json"), JSON.stringify({ parsed: { ...parsed, ignored: refused }, ...out, planCheck: checks ? "ran" : planInputs(actions).length ? "not run" : "no plans", autoFix }, null, 2));
  });
});
