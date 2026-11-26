import type { MediaAsset, MediaProject, TimelineManifest } from "./contract";

export function asset(id: string, kind: MediaAsset["kind"], p: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id,
    project: "demo",
    kind,
    role: kind === "video" ? "clip" : kind === "image" ? "slate" : "music",
    name: `${id}.${kind === "video" ? "mp4" : kind === "image" ? "png" : "mp3"}`,
    path: `C:\\ai-hub\\media\\projects\\demo\\raw\\${id}`,
    readOnly: true,
    sizeBytes: 1000,
    durationSec: kind === "image" ? null : 10,
    width: kind === "audio" ? null : 1920,
    height: kind === "audio" ? null : 1080,
    thumbPath: null,
    addedAt: "2026-11-22T00:00:00Z",
    tags: [],
    transcript: null,
    flags: [],
    moments: [],
    slotId: null,
    ...p,
  };
}

export function manifest(p: Partial<TimelineManifest> = {}): TimelineManifest {
  return {
    version: 2,
    project: "demo",
    revision: 3,
    clips: [],
    audio: [],
    clipAudioVolume: 1,
    output: { aspect: "16:9", loudnessLufs: -16, maxSizeMb: null, name: "demo" },
    shotList: [],
    updatedBy: "nic",
    updatedAt: "2026-11-22T00:00:00Z",
    captions: { enabled: false, style: "clean", position: "lower", maxWordsPerLine: 4 },
    color: { preset: "none", strength: 0.5 },
    outputs: [{ platform: "custom", aspect: "16:9", loudnessLufs: -16, maxSizeMb: null, maxSec: null }],
    notes: [],
    ...p,
  };
}

export function project(p: Partial<MediaProject> = {}): MediaProject {
  return {
    slug: "demo",
    title: "Demo",
    status: "editing",
    root: "C:\\ai-hub\\media\\projects\\demo",
    createdAt: "2026-11-22T00:00:00Z",
    updatedAt: "2026-11-22T00:00:00Z",
    source: { from: "suite", refId: null, brief: null },
    brief: null,
    speed: "rough",
    ...p,
  };
}

export const V1 = asset("a-v1", "video");
export const V2 = asset("a-v2", "video", { durationSec: 4 });
export const IMG = asset("a-img", "image");
export const MUS = asset("a-mus", "audio", { durationSec: 30 });
export const ASSETS = [V1, V2, IMG, MUS];
