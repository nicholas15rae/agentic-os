import type { ComfyJob, ComfyStatus } from "./contract";

/** A comfy_status answer: ComfyUI down, nothing running, every built template ready, idle policy, nothing queued. */
export function comfyStatus(p: Partial<ComfyStatus> = {}): ComfyStatus {
  const t = (name: string) => ({ name, requiredModels: [`checkpoints/${name}.safetensors`], missing: [], ready: true, note: null });
  return {
    up: false,
    version: null,
    running: false,
    phase: "",
    admission: "not checked yet",
    runNow: false,
    templates: [t("scene-still"), t("thumbnail-bg"), t("style-transfer"), t("upscale"), t("broll-motion")],
    counts: { queued: 0, waiting: 0, running: 0, done: 0, failed: 0, cancelled: 0 },
    settings: { modelRoots: [], policy: "idle" },
    crashMarker: false,
    lastBatch: null,
    backoff: { failures: 0, untilMs: null },
    recoveryAttempts: 0,
    ...p,
  };
}

/** A queued scene-still job for "demo" (as comfy_enqueue returns it). */
export function comfyJob(p: Partial<ComfyJob> = {}): ComfyJob {
  return {
    id: "g-1",
    slug: "demo",
    template: "scene-still",
    params: { prompt: "a neon dance studio", seed: 7, steps: 1, aspect: "16:9", slug: "demo" },
    status: "queued",
    createdAt: 1_764_000_000_000,
    startedAt: null,
    finishedAt: null,
    error: null,
    outputs: [],
    renderMs: null,
    peakVramMb: null,
    promptId: null,
    ...p,
  };
}
