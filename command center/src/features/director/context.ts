/**
 * The `context` text a Director chat turn carries (pure): the project and its brief, the shot
 * list, the staged assets (flags / tags / transcript summary / moments), a compact view of the
 * timeline manifest, the review round and open notes, and the ACTION CONTRACT the Director must
 * follow, plus a capped TRANSCRIPT section (what each video asset says, as timed lines, so the
 * Director picks moments by their words: run 9 picked blind). Kept compact on purpose: the whole
 * context stays under CONTEXT_BUDGET chars (the TRANSCRIPT section gets what room is left, up to
 * TRANSCRIPT_BUDGET).
 */
import type { AssetTranscriptLines, MediaAsset, MediaProject, ProjectReview, TimelineManifest } from "./contract";
import { ACTION_FENCE } from "./actions";

/** The whole context stays under this. MIRRORS director.rs MAX_CONTEXT_CHARS (Rust clips the
 * context there, from the end, where the ACTION CONTRACT is): the two must stay equal, and
 * director.rs's whole-prompt test keeps the worst case under the 24 000-char hybrid threshold. */
export const CONTEXT_BUDGET = 11_500;
/** The TRANSCRIPT section's own cap (it also never pushes the whole context past CONTEXT_BUDGET). */
export const TRANSCRIPT_BUDGET = 2_500;
/** Seconds around a moment or a timeline clip whose lines are shown first when not all fit. */
const TRANSCRIPT_WINDOW_PAD_SEC = 1.5;
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
  // The bands media.rs plan_check_core_with refuses outside of, stated up front (live E2E run 11:
  // six revisions missed a band the model only saw in refusals).
  const bands = b ? lengthBands(b.lengthSec) : null;
  const open = (m.notes ?? []).some((n) => !n.resolved);
  const band = bands ? ` · a plan must total ${bands.plan[0]}–${bands.plan[1]}s${open ? ` · a revise_edit ${bands.revision[0]}–${bands.revision[1]}s` : ""}` : "";
  return `LENGTH: target ${b ? `${b.lengthSec}s${b.guessed.includes("lengthSec") ? " (guessed)" : ""}` : "none (no brief)"} · cut ${total}s${short ? ` · ${short} clip${short === 1 ? "" : "s"} under 1s` : ""}${band}`;
}

/** Mirrors media.rs REVISION_LENGTH_TOLERANCE (keep the two equal). */
export const REVISION_LENGTH_TOLERANCE = 0.3;

/** The lengths media.rs plan_check_core_with accepts for a brief of `t` seconds (pure): a plan
 * within ±10% (at least 1.5 s), a revision within ±30% (at least 3 s). */
export function lengthBands(t: number): { plan: [number, number]; revision: [number, number] } {
  const tol = Math.max(t * 0.1, 1.5);
  const rev = Math.max(t * REVISION_LENGTH_TOLERANCE, 3, tol);
  return { plan: [r2(Math.max(0, t - tol)), r2(t + tol)], revision: [r2(Math.max(0, t - rev)), r2(t + rev)] };
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
- Video clips: 0 ≤ inSec < outSec ≤ duration, each ≥ 1 s, cut in pauses, never mid-sentence: prefer starting a clip on a TRANSCRIPT line's start and ending it on a line's end. Stills: outSec = hold 0.2–60 s. fadeMs 0–2000, volume 0–2. Clip order = playback order.
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

const fmtLineSec = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

/**
 * The TRANSCRIPT section (pure): each video asset's lines as "[start–end] text", whole segments
 * only, within `budget` chars. When not all fit, the lines near the asset's moments and its
 * timeline clips (±1.5 s) go first, then the rest in time order; each asset says how many lines
 * were left out ("… 14 more lines not shown", counting the ones Rust's own cap left out). "" when
 * there are no lines at all.
 */
export function transcriptSection(
  assets: Pick<MediaAsset, "id" | "name" | "kind" | "moments">[],
  manifest: Pick<TimelineManifest, "clips">,
  transcripts: AssetTranscriptLines[] | null | undefined,
  budget: number = TRANSCRIPT_BUDGET,
): string {
  const per = assets
    .filter((a) => a.kind === "video")
    .map((a) => ({ a, t: transcripts?.find((x) => x.assetId === a.id) }))
    .filter((x) => !!x.t && (x.t.lines.length > 0 || x.t.more > 0))
    .map((x) => ({ a: x.a, t: x.t as AssetTranscriptLines }));
  if (!per.length) return "";
  const head = "TRANSCRIPT (what each video says, [start–end] in asset seconds; clips start and end on these boundaries):";
  type Cand = { k: number; start: number; text: string; pri: number };
  const cands: Cand[] = [];
  per.forEach(({ a, t }, k) => {
    const windows = [...a.moments.map((m) => [m.inSec, m.outSec]), ...manifest.clips.filter((c) => c.assetId === a.id).map((c) => [c.inSec, c.outSec])];
    for (const l of t.lines) {
      if (!(Number.isFinite(l.start) && Number.isFinite(l.end)) || !l.text?.trim()) continue;
      const near = windows.some(([s, e]) => l.end > s - TRANSCRIPT_WINDOW_PAD_SEC && l.start < e + TRANSCRIPT_WINDOW_PAD_SEC);
      cands.push({ k, start: l.start, text: `[${fmtLineSec(l.start)}–${fmtLineSec(l.end)}] ${l.text.trim().replace(/\s+/g, " ")}`, pri: near ? 0 : 1 });
    }
  });
  const headerOf = (k: number) => `${per[k].a.id} (${cut(per[k].a.name, 40)}):`;
  const extra = (k: number) => Math.max(0, Math.floor(per[k].t.more || 0));
  // Room kept for each asset's header and "… N more lines not shown" footer.
  let used = head.length + per.reduce((n, _, k) => n + headerOf(k).length + 1 + 40, 0);
  const chosen = new Set<Cand>();
  const ranked = [...cands].sort((x, y) => x.pri - y.pri || x.k - y.k || x.start - y.start);
  for (const c of ranked) {
    const cost = c.text.length + 1;
    if (used + cost > budget) continue;
    used += cost;
    chosen.add(c);
  }
  const blocks = per.map((_, k) => {
    const mine = cands.filter((c) => c.k === k);
    const shown = mine.filter((c) => chosen.has(c)).sort((x, y) => x.start - y.start);
    const dropped = mine.length - shown.length + extra(k);
    const rows = [headerOf(k), ...shown.map((c) => c.text)];
    if (dropped > 0) rows.push(`… ${dropped} more line${dropped === 1 ? "" : "s"} not shown`);
    return rows.join("\n");
  });
  const out = `${head}\n${blocks.join("\n")}`;
  if (out.length <= budget) return out;
  // Too small a budget even for the headers: only the count.
  const total = cands.length + per.reduce((n, _, k) => n + extra(k), 0);
  const short = `TRANSCRIPT: ${total} line${total === 1 ? "" : "s"} not shown (no room)`;
  return short.length <= budget ? short : "";
}

/** The Part 6 STYLE line's cap (mirrors style.ts STYLE_LINE_MAX). Its room comes out of the
 * TRANSCRIPT section's share, so CONTEXT_BUDGET and TRANSCRIPT_BUDGET together are unchanged. */
export const STYLE_BUDGET = 200;

export function buildDirectorContext(project: MediaProject, assets: MediaAsset[], manifest: TimelineManifest, review?: ProjectReview | null, transcripts?: AssetTranscriptLines[] | null, style?: string | null): string {
  const assetLines = assets.length ? assets.map(assetLine).join("\n") : "- (none staged yet)";
  const styleText = style?.trim() ? cut(style.trim().replace(/\s+/g, " "), STYLE_BUDGET) : "";
  const before = [
    `PROJECT: ${project.title} (slug ${project.slug}) · status ${project.status} · speed ${project.speed}`,
    briefLines(project),
    ...(styleText ? [styleText] : []),
    shotLines(manifest),
    `ASSETS (${assets.length}):\n${assetLines}`,
  ];
  const after = [
    lengthLine(project, manifest, assets),
    `TIMELINE (clips = [assetId,in,out,fadeMs,transition,punchIn,fit?]; audio = [assetId,start,in,out,volume,fadeIn,fadeOut,duck]):\n${timelineJson(manifest)}`,
    reviewLines(manifest, review ?? project.review),
    ACTION_CONTRACT,
  ];
  const rest = [...before, ...after].join("\n\n").length;
  // The transcript gets the room left under CONTEXT_BUDGET (less its "\n\n"), up to its own cap.
  // A STYLE line's chars come out of the transcript's cap (its share of the budget).
  const room = Math.min(TRANSCRIPT_BUDGET - (styleText ? styleText.length + 2 : 0), CONTEXT_BUDGET - 1 - rest - 2);
  const transcript = room > 0 ? transcriptSection(assets, manifest, transcripts, room) : "";
  return [...before, ...(transcript ? [transcript] : []), ...after].join("\n\n");
}
