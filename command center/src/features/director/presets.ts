/**
 * Part 6 launcher presets (pure table + helpers). Each preset is a starter brief (platform, aspect,
 * length, tone, the fields left as guesses), default outputs, the quick-start template it builds
 * on (manifest.ts presetManifest: the stitch template's slate slots for a self-tape) and a first
 * Director line. The line is sent only by Nic's Start click (launcher.ts), never on its own.
 */
import type { Aspect, CreativeBrief, Platform, TimelineManifest } from "./contract";
import { PLATFORM_PRESETS, setOutput, setOutputs, type QuickStart } from "./manifest";

export type LauncherPresetId = "ig_reel" | "tiktok" | "yt_short" | "yt_long" | "self_tape" | "demo_reel";

export interface LauncherPreset {
  id: LauncherPresetId;
  label: string;
  hint: string;
  /** The quick-start template applied first (its shot list, if it has one). */
  quick: QuickStart;
  brief: { platform: Exclude<Platform, "custom">; aspect: Aspect; lengthSec: number; tone: string; guessed: (keyof CreativeBrief)[] };
  /** 1–4 outputs; the first sets the primary output's aspect and loudness. */
  outputs: Exclude<Platform, "custom">[];
  /** Sent to the Director by the Start click only. */
  firstLine: string;
}

export const LAUNCHER_PRESETS: readonly LauncherPreset[] = [
  {
    id: "ig_reel",
    label: "Instagram Reel",
    hint: "9:16, about 30 s, hook first.",
    quick: "edit",
    brief: { platform: "reels", aspect: "9:16", lengthSec: 30, tone: "upbeat, punchy", guessed: ["lengthSec", "tone"] },
    outputs: ["reels"],
    firstLine: "New Instagram Reel, about 30 s at 9:16. Draft a shot list as a populate_shot_list action: a hook in the first 2 s, 5 to 8 shots, phone tips on each.",
  },
  {
    id: "tiktok",
    label: "TikTok",
    hint: "9:16, about 25 s, fast cuts.",
    quick: "edit",
    brief: { platform: "tiktok", aspect: "9:16", lengthSec: 25, tone: "fast, playful", guessed: ["lengthSec", "tone"] },
    outputs: ["tiktok"],
    firstLine: "New TikTok, about 25 s at 9:16. Draft a shot list as a populate_shot_list action: open on the payoff, quick cuts, phone tips on each shot.",
  },
  {
    id: "yt_short",
    label: "YouTube Short",
    hint: "9:16, up to 60 s.",
    quick: "edit",
    brief: { platform: "shorts", aspect: "9:16", lengthSec: 45, tone: "clear, energetic", guessed: ["lengthSec", "tone"] },
    outputs: ["shorts"],
    firstLine: "New YouTube Short, about 45 s at 9:16. Draft a shot list as a populate_shot_list action: a clear hook, one idea, phone tips on each shot.",
  },
  {
    id: "yt_long",
    label: "YouTube long-form",
    hint: "16:9, about 5 min, planned first.",
    quick: "series",
    brief: { platform: "youtube", aspect: "16:9", lengthSec: 300, tone: "relaxed, informative", guessed: ["lengthSec", "tone"] },
    outputs: ["youtube"],
    firstLine: "New YouTube video, about 5 min at 16:9. Draft a shot list as a populate_shot_list action: intro, three or four sections, an outro, with B-roll slots.",
  },
  {
    id: "self_tape",
    label: "Self-tape audition",
    hint: "16:9, slate then the take, no captions.",
    quick: "stitch",
    brief: { platform: "self_tape", aspect: "16:9", lengthSec: 90, tone: "natural, grounded", guessed: ["lengthSec"] },
    outputs: ["self_tape"],
    firstLine: "New self-tape audition at 16:9. Draft a shot list as a populate_shot_list action: slate, the take in a medium close-up, framing and lighting tips. No captions.",
  },
  {
    id: "demo_reel",
    label: "Demo reel",
    hint: "16:9 and 9:16, about 60 s of best moments.",
    quick: "edit",
    brief: { platform: "youtube", aspect: "16:9", lengthSec: 60, tone: "confident, varied", guessed: ["lengthSec", "tone"] },
    outputs: ["youtube", "reels"],
    firstLine: "New demo reel, about 60 s, for 16:9 and 9:16. Draft a shot list as a populate_shot_list action: strongest moment first, range across clips, an end slate.",
  },
];

export const presetById = (id: string): LauncherPreset | undefined => LAUNCHER_PRESETS.find((p) => p.id === id);

/** The starter brief (pure): Nic's title is the idea, word for word; unapproved until Nic approves it. */
export function presetBrief(p: LauncherPreset, title: string, now = new Date().toISOString()): CreativeBrief {
  return {
    idea: title.trim().slice(0, 8000),
    goal: "",
    platform: p.brief.platform,
    lengthSec: p.brief.lengthSec,
    aspect: p.brief.aspect,
    tone: p.brief.tone,
    references: [],
    guessed: [...p.brief.guessed],
    approved: false,
    updatedBy: "nic",
    updatedAt: now,
  };
}

/** The preset's outputs on a manifest (pure): outputs set, the primary output takes the first
 * one's aspect and loudness (after the quick-start template, which may have set its own). */
export function applyLauncherPreset(m: TimelineManifest, p: LauncherPreset): TimelineManifest {
  const first = PLATFORM_PRESETS[p.outputs[0]];
  const withOut = setOutputs(m, p.outputs);
  return setOutput(withOut, { aspect: first.aspect, loudnessLufs: first.loudnessLufs, ...(first.maxSizeMb != null ? { maxSizeMb: first.maxSizeMb } : {}) });
}
