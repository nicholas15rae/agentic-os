/**
 * The `context` text a Director chat turn carries (pure): the project, its staged assets, the
 * current timeline manifest and the ACTION CONTRACT the Director must follow.
 */
import type { MediaAsset, MediaProject, TimelineManifest } from "./contract";
import { ACTION_FENCE } from "./actions";

const fmtDur = (s: number | null) => (s == null ? "—" : `${Math.round(s * 100) / 100}s`);
const fmtSize = (a: MediaAsset) => (a.width && a.height ? `${a.width}×${a.height}` : "—");

export const ACTION_CONTRACT = `ACTION CONTRACT (Director Suite)
You are the Director inside Nic's Director Suite. You may end a reply with one or more fenced blocks
\`\`\`${ACTION_FENCE}
{json}
\`\`\`
each holding EXACTLY ONE of these JSON shapes (no other fields, no comments):
1. {"type":"populate_shot_list","slots":[{"id":"s1","label":"15s Hook","instructions":"…","kind":"video"|"image"|"audio","targetSec":15|null}]}
2. {"type":"propose_edit_plan","clips":[{"assetId":"a-…","inSec":0,"outSec":5.5,"fadeMs":0}],"audio":[{"assetId":"a-…","startSec":0,"inSec":0,"outSec":30,"volume":1}],"output":{"aspect":"16:9"|"9:16"|"4:5"|"1:1","loudnessLufs":-14|-16|-18,"maxSizeMb":100|null,"name":"…"},"note":"why this cut"}
3. {"type":"execute_verified_render"}
Rules:
- Use only asset ids listed below. Clips are video or image assets; audio layers are audio assets.
- Video clips: 0 ≤ inSec < outSec ≤ the asset's duration. Image (still/slate) clips: inSec 0, outSec = hold seconds 0.2–60.
- fadeMs 0–2000. volume 0–2 (1 = unity). Clip order = playback order; a slate goes first or last.
- execute_verified_render ONLY asks Nic to approve a render plan. It never renders by itself. Never claim a render ran, finished or was verified: only the Verified Outputs shelf says that.
- Renders are CPU-only (libx264). Never suggest using the GPU.
- Nothing you write runs automatically; Nic reviews every change.`;

export function buildDirectorContext(project: MediaProject, assets: MediaAsset[], manifest: TimelineManifest): string {
  const assetLines = assets.length
    ? assets.map((a) => `- ${a.id} · ${a.name} · ${a.kind} · role ${a.role} · ${fmtDur(a.durationSec)} · ${fmtSize(a)}${a.readOnly ? " · raw (read-only)" : ""}`).join("\n")
    : "- (none staged yet)";
  const brief = project.source.brief ? `\nBrief (from ${project.source.from}): ${project.source.brief.slice(0, 2000)}` : "";
  return [
    `PROJECT: ${project.title} (slug ${project.slug}) · status ${project.status}${brief}`,
    `ASSETS (${assets.length}):\n${assetLines}`,
    `CURRENT timeline_manifest.json:\n${JSON.stringify(manifest)}`,
    ACTION_CONTRACT,
  ].join("\n\n");
}
