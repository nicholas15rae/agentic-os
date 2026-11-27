/**
 * Part 6 click actions. Start on a launcher preset creates the project (with the preset's quick-start
 * template), sets its outputs, saves the starter brief (unapproved), then sends the preset's first
 * Director line. Only this click sends it; nothing here renders or queues GPU work.
 */
import { useToasts } from "@/features/reminders/notify";
import type { Platform, RenderPlan } from "./contract";
import { createProject, editManifest, flushSave, requestPlan, updateProject, useDirector } from "./director-store";
import { withVersions } from "./more-versions";
import { sendDirectorTurn } from "./director-chat";
import { applyLauncherPreset, presetBrief, presetById, type LauncherPresetId } from "./presets";

export async function startFromPreset(id: LauncherPresetId, title: string): Promise<boolean> {
  const p = presetById(id);
  const name = title.trim();
  if (!p || !name) return false;
  const project = await createProject(name, p.quick);
  if (useDirector.getState().slug !== project.slug) return false;
  editManifest((m) => applyLauncherPreset(m, p));
  // Outputs and aspect must reach disk before the brief and the first Director line go out.
  if (!(await flushSave())) return false;
  if (!(await updateProject({ brief: presetBrief(p, name) }))) return false;
  if (useDirector.getState().slug !== project.slug) return false;
  return sendDirectorTurn(p.firstLine);
}

/** Nic's "Plan versions" click (versions on demand): the picked platforms join the outputs, the
 * manifest saves (Rust validates ≤ 4 outputs) and a render plan is raised. The render itself still
 * waits for Approve & Render. */
export async function planVersions(picks: Platform[]): Promise<RenderPlan | null> {
  const m = useDirector.getState().manifest;
  if (!m) return null;
  const r = withVersions(m, picks);
  if ("error" in r) {
    useToasts.getState().push({ title: "No versions added", body: r.error, tone: "warn" });
    return null;
  }
  editManifest(() => r.manifest);
  if (!(await flushSave())) return null;
  return requestPlan("nic");
}
