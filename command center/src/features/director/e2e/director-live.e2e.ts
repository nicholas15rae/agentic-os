/**
 * Live E2E step runner (opt-in: E2E_LIVE=1, run only through vitest.e2e.config.ts by the Rust
 * harness in src-tauri/src/commands/media_e2e.rs). It runs the REAL page modules on the project
 * snapshot Rust wrote, with no mocks:
 *
 *   E2E_STEP=context  snapshot.json → buildDirectorContext → out-context.json
 *   E2E_STEP=apply    snapshot.json + reply.txt → parseDirectorActions → the effects
 *                     applyDirectorActions (director-store.ts) would cause, computed with the real
 *                     manifest ops (setShotList, attachSlot, applyEditPlan, reviseRefusal) and with
 *                     Nic's accept clicks on every suggestion → out-apply.json
 *
 * Rust then carries each effect out through the real media.rs functions (project_update,
 * manifest_save, asset_update, build_plan, review_write …). Nothing here talks to the model,
 * renders or touches media files.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "node:process";
import { describe, expect, it, vi } from "vitest";
import type { CreativeBrief, DirectorAction, EditPlanBody, MediaAsset, MediaProject, Moment, ProjectReview, TimelineManifest } from "../contract";
import { parseDirectorActions, revisePlanBody } from "../actions";
import { buildDirectorContext } from "../context";
import { attachSlot, applyEditPlan, newId, setShotList, upgradeAsset, upgradeManifest, upgradeProject } from "../manifest";
import type { reviseRefusal as ReviseRefusal } from "../director-store";

// director-store's imports reach the webview (toasts → voice, Tauri IPC); neither is used by the
// pure reviseRefusal this runner calls, so only those two side-effect modules are stubbed.
vi.mock("@/features/reminders/notify", () => ({ useToasts: { getState: () => ({ push: () => undefined }) } }));
vi.mock("../api", () => ({ api: {}, onDirectorEvent: async () => () => undefined }));
const { reviseRefusal } = (await import("../director-store")) as { reviseRefusal: typeof ReviseRefusal };

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

const live = env.E2E_LIVE === "1";
const dir = env.E2E_DIR ?? "";

function load(): { project: MediaProject; assets: MediaAsset[]; manifest: TimelineManifest; review: ProjectReview | null } {
  const s = JSON.parse(readFileSync(join(dir, "snapshot.json"), "utf8")) as Snapshot;
  const project = upgradeProject(s.project);
  return { project, assets: s.assets.map(upgradeAsset), manifest: upgradeManifest(s.manifest), review: s.review ?? project.review ?? null };
}

/** applyDirectorActions (director-store.ts), pure: the same branches, with Nic accepting every match and moment. */
export function effectsFor(actions: DirectorAction[], project: MediaProject, assets: MediaAsset[], manifest: TimelineManifest, review: ProjectReview | null): { effects: Effect[]; notes: string[] } {
  const effects: Effect[] = [];
  const notes: string[] = [];
  let m = manifest;
  let p = project;
  const now = () => new Date().toISOString();
  for (const a of actions) {
    switch (a.type) {
      case "draft_brief": {
        const prev = p.brief;
        const brief: CreativeBrief = {
          ...a.brief,
          idea: prev?.idea || a.brief.idea,
          guessed: prev?.idea ? a.brief.guessed.filter((g) => g !== "idea") : a.brief.guessed,
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
      case "propose_edit_plan":
        m = applyEditPlan(m, a as EditPlanBody);
        effects.push({ kind: "manifest_save", by: "director", manifest: m, why: "propose_edit_plan" });
        effects.push({ kind: "render_plan", resolves: [] });
        notes.push(`Edit plan: ${a.clips.length} clips, ${a.audio.length} audio layers`);
        break;
      case "revise_edit": {
        const refusal = reviseRefusal(a.round, review, null);
        if (refusal) {
          effects.push({ kind: "refused", action: a.type, why: refusal });
          notes.push(`Revision not applied: ${refusal}`);
          break;
        }
        const body = revisePlanBody(a);
        m = applyEditPlan(m, body);
        effects.push({ kind: "manifest_save", by: "director", manifest: m, why: "revise_edit" });
        if (a.summary.trim()) effects.push({ kind: "review_write", round: a.round, summary: a.summary });
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
  return { effects, notes };
}

describe.skipIf(!live)("director live e2e step", () => {
  it(`runs ${env.E2E_STEP ?? "?"}`, () => {
    expect(dir).not.toBe("");
    const { project, assets, manifest, review } = load();
    if (env.E2E_STEP === "context") {
      const context = buildDirectorContext(project, assets, manifest, review);
      writeFileSync(join(dir, "out-context.json"), JSON.stringify({ context, chars: context.length }, null, 2));
      return;
    }
    expect(env.E2E_STEP).toBe("apply");
    const reply = readFileSync(join(dir, "reply.txt"), "utf8");
    const parsed = parseDirectorActions(reply, { assets, manifest });
    const { effects, notes } = effectsFor(parsed.actions, project, assets, manifest, review);
    writeFileSync(join(dir, "out-apply.json"), JSON.stringify({ parsed, effects, notes }, null, 2));
  });
});
