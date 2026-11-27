/**
 * The `context` text a Director chat turn carries (pure): the project and its brief, the shot
 * list, the staged assets (flags / tags / transcript summary / moments), a compact view of the
 * timeline manifest, the review round and open notes, and the ACTION CONTRACT the Director must
 * follow. Kept compact on purpose: a typical 15-asset project stays under CONTEXT_BUDGET chars.
 */
import type { MediaAsset, MediaProject, ProjectReview, TimelineManifest } from "./contract";
import { ACTION_FENCE } from "./actions";

/** A typical project's context stays under this (context.test.ts checks a 15-asset project). */
export const CONTEXT_BUDGET = 9000;
const MAX_MOMENTS_SHOWN = 3;
const MAX_NOTES_SHOWN = 12;
const MAX_CUTS_SHOWN = 4;

/** Seconds the crossfades take off a clip list (pure), as Rust's expected_duration / media-forge
 * lay it out: each crossfade (not on the first clip, not 0 ms) overlaps its clips by its length,
 * capped at 45% of the shorter neighbour; fade_black dips without overlap. */
export function crossfadeOverlap(clips: Pick<TimelineManifest["clips"][number], "inSec" | "outSec" | "transitionIn">[]): number {
  const lens = clips.map((c) => Math.max(0, c.outSec - c.inSec));
  let o = 0;
  clips.forEach((c, k) => {
    if (k === 0 || c.transitionIn.kind !== "crossfade" || c.transitionIn.ms <= 0) return;
    const cap = Math.min(lens[k], lens[k - 1]) * 0.45;
    o += Math.round(Math.min(c.transitionIn.ms / 1000, cap) * 1000) / 1000;
  });
  return o;
}

/** "LENGTH: target … · cut …" (pure): what the plan check holds a cut to. The cut is the render's
 * length (crossfades overlap, as the plan check counts it). With `assets`, only video clips count
 * toward "under 1s" (a still may hold 0.2 s). */
export function lengthLine(p: MediaProject, m: TimelineManifest, assets?: Pick<MediaAsset, "id" | "kind">[]): string {
  const sum = m.clips.reduce((t, c) => t + Math.max(0, c.outSec - c.inSec), 0);
  const overlap = crossfadeOverlap(m.clips);
  const total = r2(sum - overlap);
  const b = p.brief;
  const isVideo = (id: string) => {
    const a = assets?.find((x) => x.id === id);
    return !a || a.kind === "video";
  };
  const short = m.clips.filter((c) => c.outSec - c.inSec < 1 && isVideo(c.assetId)).length;
  return `LENGTH: target ${b ? `${b.lengthSec}s${b.guessed.includes("lengthSec") ? " (guessed)" : ""}` : "none (no brief)"} · cut ${total}s${short ? ` · ${short} clip${short === 1 ? "" : "s"} under 1s` : ""}`;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const fmtDur = (s: number | null) => (s == null ? "—" : `${r2(s)}s`);
const fmtSize = (a: MediaAsset) => (a.width && a.height ? `${a.width}×${a.height}` : "");
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export const ACTION_CONTRACT = `ACTION CONTRACT (Director Suite v2)
You are the Director inside Nic's Director Suite. You may end a reply with fenced blocks
\`\`\`${ACTION_FENCE}
{json}
\`\`\`
each holding EXACTLY ONE of these JSON shapes (no other fields, no comments):
1. {"type":"draft_brief","brief":{"idea":"<Nic's idea, word for word>","goal":"…","platform":"reels"|"tiktok"|"ig_feed"|"youtube"|"shorts"|"self_tape"|"custom","lengthSec":5-600,"aspect":"16:9"|"9:16"|"4:5"|"1:1","tone":"…","references":["…"],"guessed":["platform","lengthSec"]}} ("guessed": NAMES of fields you defaulted; explain them in prose)
2. {"type":"populate_shot_list","slots":[{"id":"s1","label":"Hook","instructions":"…","kind":"video"|"image"|"audio","targetSec":3|null,"framing":"wide"|"medium"|"mcu"|"closeup"|"insert"|"overhead"|"pov"|null,"action":"what happens","source":"film"|"generate"|"stock","phoneTips":["≤4 short tips"]}]}
3. {"type":"match_footage","matches":[{"assetId":"a-…","slotId":"s1","reason":"…"}],"moments":[{"assetId":"a-…","inSec":0,"outSec":2.5,"label":"…","score":0-1}]}
4. {"type":"propose_edit_plan","clips":[{"assetId":"a-…","inSec":0,"outSec":5.5,"fadeMs":0,"transitionIn":{"kind":"cut"|"crossfade"|"fade_black","ms":0-1500},"punchIn":1-1.5,"fit":"auto"}],"audio":[] or [{"assetId":"<an audio asset>","startSec":0,"inSec":0,"outSec":30,"volume":1,"fadeInMs":0,"fadeOutMs":0,"duckUnderVoice":false}],"output":{"aspect":…,"loudnessLufs":-14|-16|-18,"maxSizeMb":100|null,"name":"…"},"captions":{"enabled":true,"style":"clean"|"bold_pop"|"karaoke"|"minimal","position":"lower"|"middle","maxWordsPerLine":1-12},"color":{"preset":"none"|"warm"|"cool"|"punchy"|"film"|"bw","strength":0-1},"outputs":["reels",…≤4],"note":"why this cut"}
5. {"type":"revise_edit","round":1,"resolves":["n-…"],"plan":{same body as propose_edit_plan, no "type"},"summary":"what changed"}
6. {"type":"report_open_decisions","items":["…"]}
7. {"type":"execute_verified_render"}
Rules:
- Use only the ids listed below. Clips: video/image assets. Audio layers: audio assets only (a video clip already plays its own sound, so "audio" is [] without music or voiceover). A match pairs an asset with a slot of the same kind.
- Video clips: 0 ≤ inSec < outSec ≤ duration, each ≥ 1 s, cut in pauses, never mid-sentence. Stills: outSec = hold 0.2–60 s. fadeMs 0–2000, volume 0–2. Clip order = playback order.
- The cut totals the brief's lengthSec ±10% (LENGTH below, net of crossfade overlap); the app snaps cuts to word/sentence ends and refuses a plan off length or with a video clip under 1 s.
- Clip "fit": auto (default: from black bars), pad, fill (crop) or blur.
- captions, color and outputs are optional (left out = kept). self_tape never gets captions.
- Draft a brief only when there is none or Nic asks. Only Nic approves a brief.
- Review: Nic's round 1 notes get ONE revise_edit (round 1, "resolves" = those note ids) that changes the cut. After round 2 there is no more revising: only report_open_decisions.
- [auto-fix] lines quote what failed: send only the fixed blocks.
- Every block is a suggestion until Nic clicks; execute_verified_render only raises the Render Plan card. Never claim a render ran, finished or was verified.
- Renders are CPU-only (libx264); never suggest the GPU. Nothing you write posts, deletes or moves files.`;

function briefLines(p: MediaProject): string {
  const b = p.brief;
  const sameAsIdea = !!b && !!p.source.brief && p.source.brief.trim() === b.idea.trim();
  const source = p.source.brief ? `Brief (from ${p.source.from}): ${sameAsIdea ? "same as the idea" : cut(p.source.brief, 600)}` : "";
  if (!b) return ["BRIEF: none yet", source].filter(Boolean).join("\n");
  const g = (k: string) => (b.guessed.includes(k as never) ? " (guessed)" : "");
  return [
    `BRIEF (${b.approved ? "approved by Nic" : "draft, not approved"}): ${b.platform}${g("platform")} · ${b.lengthSec}s${g("lengthSec")} · ${b.aspect}${g("aspect")}`,
    `Idea: ${cut(b.idea, 800)}`,
    b.goal ? `Goal: ${cut(b.goal, 200)}${g("goal")}` : "",
    b.tone ? `Tone: ${cut(b.tone, 150)}${g("tone")}` : "",
    b.references.length ? `Refs: ${b.references.map((r) => cut(r, 80)).join(" | ")}` : "",
    source,
  ]
    .filter(Boolean)
    .join("\n");
}

function shotLines(m: TimelineManifest): string {
  if (!m.shotList.length) return "SHOT LIST: empty";
  const lines = m.shotList.map((s) => {
    const bits = [`${s.id} ${cut(s.label, 40)}`, s.kind, s.source, s.framing ?? "", s.targetSec != null ? `${s.targetSec}s` : "", s.assetId ? `← ${s.assetId}` : "UNFILLED", s.filmed ? "filmed" : ""];
    const act = s.action ? ` — ${cut(s.action, 80)}` : "";
    return `- ${bits.filter(Boolean).join(" · ")}${act}`;
  });
  return `SHOT LIST (${m.shotList.length}):\n${lines.join("\n")}`;
}

function assetLine(a: MediaAsset): string {
  const bits = [a.id, cut(a.name, 40), a.kind, `role ${a.role}`, fmtDur(a.durationSec), fmtSize(a)];
  if (a.slotId) bits.push(`slot ${a.slotId}`);
  if (a.generation) bits.push(`generated ${cut(a.generation.template || "?", 32)} seed ${a.generation.seed}`);
  if (a.tags.length) bits.push(`tags ${a.tags.slice(0, 6).join(",")}`);
  if (a.flags.length) bits.push(`flags ${a.flags.map((f) => f.kind).join(",")}`);
  if (a.kind === "video" && Array.isArray(a.scenes)) {
    const c = a.scenes;
    bits.push(c.length ? `shots ${c.length + 1} (cuts ${c.slice(0, MAX_CUTS_SHOWN).map(r2).join(",")}${c.length > MAX_CUTS_SHOWN ? ` +${c.length - MAX_CUTS_SHOWN}` : ""})` : "one shot");
  }
  if (a.transcript) {
    const t = a.transcript;
    bits.push(`speech ${t.words}w${t.firstSpeechSec != null && t.lastSpeechSec != null ? ` ${r2(t.firstSpeechSec)}–${r2(t.lastSpeechSec)}s` : ""}`);
  }
  if (a.moments.length) {
    const top = [...a.moments].sort((x, y) => y.score - x.score).slice(0, MAX_MOMENTS_SHOWN);
    bits.push(`moments ${top.map((mo) => `${r2(mo.inSec)}–${r2(mo.outSec)}${mo.label ? ` "${cut(mo.label, 24)}"` : ""}`).join("; ")}${a.moments.length > MAX_MOMENTS_SHOWN ? ` +${a.moments.length - MAX_MOMENTS_SHOWN}` : ""}`);
  }
  return `- ${bits.filter(Boolean).join(" · ")}`;
}

/** A clip's fit for the compact tuple: nothing when it's auto (the Rust row leaves auto out too). */
const fitOf = (c: TimelineManifest["clips"][number]): string[] => (c.fit && c.fit !== "auto" ? [c.fit] : []);

/** The manifest without what's already listed above (shot list, notes) and with short keys dropped. */
function timelineJson(m: TimelineManifest): string {
  return JSON.stringify({
    revision: m.revision,
    clips: m.clips.map((c) => [c.assetId, c.inSec, c.outSec, c.fadeMs, c.transitionIn.kind === "cut" ? "cut" : `${c.transitionIn.kind}:${c.transitionIn.ms}`, c.punchIn, ...fitOf(c)]),
    audio: m.audio.map((l) => [l.assetId, l.startSec, l.inSec, l.outSec, l.volume, l.fadeInMs, l.fadeOutMs, l.duckUnderVoice ? 1 : 0]),
    ...(m.clipAudioVolume !== 1 ? { clipAudioVolume: m.clipAudioVolume } : {}),
    output: m.output,
    captions: m.captions,
    color: m.color,
    outputs: m.outputs.map((o) => o.platform),
  });
}

function reviewLines(m: TimelineManifest, review: ProjectReview | null | undefined): string {
  const rounds = review?.rounds ?? [];
  const open = m.notes.filter((n) => !n.resolved);
  const parts: string[] = [];
  if (rounds.length) {
    const cur = rounds[rounds.length - 1];
    parts.push(`REVIEW: round ${cur.round} of 2 (${cur.status}) on render ${cur.renderId}${cur.round >= 2 ? " · no more revising: only report_open_decisions" : ""}`);
    for (const r of rounds) if (r.summary.trim()) parts.push(`Round ${r.round} summary: ${cut(r.summary.trim(), 300)}`);
  } else parts.push("REVIEW: no verified render yet");
  if (review?.openDecisions.length) parts.push(`Open decisions: ${review.openDecisions.map((d) => cut(d, 100)).join(" | ")}`);
  if (open.length) {
    const shown = open.slice(-MAX_NOTES_SHOWN).map((n) => `- ${n.id}${n.renderId ? ` on ${n.renderId}` : ""}${n.atSec != null ? ` @${r2(n.atSec)}s` : ""}: ${cut(n.text, 160)}`);
    parts.push(`OPEN NOTES (${open.length}):\n${shown.join("\n")}${open.length > MAX_NOTES_SHOWN ? `\n- …${open.length - MAX_NOTES_SHOWN} older` : ""}`);
  } else parts.push("OPEN NOTES: none");
  return parts.join("\n");
}

export function buildDirectorContext(project: MediaProject, assets: MediaAsset[], manifest: TimelineManifest, review?: ProjectReview | null): string {
  const assetLines = assets.length ? assets.map(assetLine).join("\n") : "- (none staged yet)";
  return [
    `PROJECT: ${project.title} (slug ${project.slug}) · status ${project.status} · speed ${project.speed}`,
    briefLines(project),
    shotLines(manifest),
    `ASSETS (${assets.length}):\n${assetLines}`,
    lengthLine(project, manifest, assets),
    `TIMELINE (clips = [assetId,in,out,fadeMs,transition,punchIn,fit?]; audio = [assetId,start,in,out,volume,fadeIn,fadeOut,duck]):\n${timelineJson(manifest)}`,
    reviewLines(manifest, review ?? project.review),
    ACTION_CONTRACT,
  ].join("\n\n");
}
