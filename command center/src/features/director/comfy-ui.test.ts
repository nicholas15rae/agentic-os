import { describe, expect, it } from "vitest";
import type { ComfyJob, ComfyStatus, ComfyTemplateInfo } from "./contract";
import type { RenderJob } from "./director-store";
import { asset, gen } from "./fixtures.test-util";
import * as ui from "./comfy-ui";
import { comfyJob, comfyStatus } from "./comfy-fixtures.test-util";

const IMG = asset("a-img", "image", { path: "C:\\ai-hub\\media\\projects\\demo\\raw\\still.png", width: 1024, height: 1024 });
const BIG = asset("a-big", "image", { width: 4000, height: 3000 });
const info = (name: string, p: Partial<ComfyTemplateInfo> = {}): ComfyTemplateInfo => ({ name, requiredModels: [], missing: [], ready: true, note: null, ...p });
const draft = (p: Partial<ui.GenerateDraft> = {}): ui.GenerateDraft => ({ ...ui.defaultDraft(), prompt: "a neon studio", ...p });
const render = (p: Partial<RenderJob> = {}): RenderJob => ({ slug: "demo", jobId: "j-1", status: "running", pct: 42.4, etaSec: 9.2, stage: "encoding", ...p });

describe("generateBlocker: each reason, in order", () => {
  const ok = comfyStatus();
  it("goes when everything is set", () => {
    expect(ui.generateBlocker(draft(), info("scene-still"), ok, null, true)).toBeNull();
  });
  it("no project, then no status", () => {
    expect(ui.generateBlocker(draft(), info("scene-still"), ok, null, false)).toBe("Open a project first");
    expect(ui.generateBlocker(draft(), info("scene-still"), null, null, true)).toBe("ComfyUI status unavailable");
  });
  it("not implemented: META's reason, and Rust's when it sends one", () => {
    expect(ui.generateBlocker(draft({ template: "broll-motion" }), info("broll-motion"), ok, null, true)).toBe("Not built yet: needs a video model.");
    // Weights on disk never make broll-motion ready (META ANDs implemented).
    expect(ui.generateBlocker(draft({ template: "broll-motion" }), info("broll-motion", { ready: true, implemented: true }), ok, null, true)).toBe("Not built yet: needs a video model.");
    expect(ui.generateBlocker(draft(), info("scene-still", { implemented: false, unavailableReason: "off for now" }), ok, null, true)).toBe("off for now");
  });
  it("not ready: the note", () => {
    expect(ui.generateBlocker(draft(), info("scene-still", { ready: false, missing: ["checkpoints/x"], note: "needs model checkpoints/x" }), ok, null, true)).toBe("needs model checkpoints/x");
    expect(ui.generateBlocker(draft(), undefined, ok, null, true)).toBe("ComfyUI doesn't list this template.");
  });
  it("prompt empty / too long; upscale needs none", () => {
    expect(ui.generateBlocker(draft({ prompt: "  " }), info("scene-still"), ok, null, true)).toBe("Write a prompt");
    expect(ui.generateBlocker(draft({ prompt: "x".repeat(2001) }), info("scene-still"), ok, null, true)).toBe("Prompt is too long (2000 max)");
    expect(ui.generateBlocker(draft({ template: "upscale", prompt: "" }), info("upscale"), ok, IMG, true)).toBeNull();
  });
  it("input: missing, too big to upscale", () => {
    expect(ui.generateBlocker(draft({ template: "style-transfer" }), info("style-transfer"), ok, null, true)).toBe("Pick a still from the bin");
    expect(ui.generateBlocker(draft({ template: "upscale" }), info("upscale"), ok, BIG, true)).toBe("That still is too big to upscale (2048 px max)");
    expect(ui.generateBlocker(draft({ template: "style-transfer" }), info("style-transfer"), ok, BIG, true)).toBeNull();
  });
  it("steps, denoise, seed", () => {
    expect(ui.generateBlocker(draft({ steps: 5 }), info("scene-still"), ok, null, true)).toBe("Steps must be 1 to 4");
    expect(ui.generateBlocker(draft({ steps: 0 }), info("scene-still"), ok, null, true)).toBe("Steps must be 1 to 4");
    expect(ui.generateBlocker(draft({ template: "style-transfer", denoise: 0.9 }), info("style-transfer"), ok, IMG, true)).toBe("Denoise must be 0.3 to 0.7");
    expect(ui.generateBlocker(draft({ denoise: 0.9 }), info("scene-still"), ok, null, true)).toBeNull(); // only style-transfer uses it
    expect(ui.generateBlocker(draft({ seed: 1.5 }), info("scene-still"), ok, null, true)).toBe("Seed must be a whole number, 0 or more");
    expect(ui.generateBlocker(draft({ seed: -1 }), info("scene-still"), ok, null, true)).toBe("Seed must be a whole number, 0 or more");
    expect(ui.generateBlocker(draft({ seed: 2 ** 53 }), info("scene-still"), ok, null, true)).toBe("Seed must be a whole number, 0 or more");
    expect(ui.generateBlocker(draft({ seed: 2 ** 53 - 1 }), info("scene-still"), ok, null, true)).toBeNull();
  });
});

describe("draftToParams", () => {
  it("drops null seed / aspect, empty negative, and denoise unless style-transfer", () => {
    expect(ui.draftToParams(draft({ prompt: " a cat " }), null)).toEqual({ prompt: "a cat", steps: 1 });
    expect(ui.draftToParams(draft({ seed: 7, aspect: "9:16", negative: "blurry", steps: 3, denoise: 0.4 }), null)).toEqual({ prompt: "a neon studio", negative: "blurry", seed: 7, steps: 3, aspect: "9:16" });
  });
  it("input templates send the asset path, keep the source size, and style-transfer its denoise", () => {
    expect(ui.draftToParams(draft({ template: "style-transfer", aspect: "1:1", denoise: 0.45 }), IMG)).toEqual({ prompt: "a neon studio", steps: 1, inputImage: IMG.path, denoise: 0.45 });
    expect(ui.draftToParams(draft({ template: "upscale", prompt: "" }), IMG)).toEqual({ prompt: "", steps: 1, inputImage: IMG.path });
  });
});

describe("inputCandidates / mergeTemplates", () => {
  it("only images; upscale only up to 2048 px; none for text-to-image", () => {
    const v = asset("a-v", "video");
    expect(ui.inputCandidates([IMG, BIG, v], "style-transfer").map((a) => a.id)).toEqual(["a-img", "a-big"]);
    expect(ui.inputCandidates([IMG, BIG, v], "upscale").map((a) => a.id)).toEqual(["a-img"]);
    expect(ui.inputCandidates([IMG], "scene-still")).toEqual([]);
  });
  it("merges Rust's rows with META; missing rows aren't ready", () => {
    const m = ui.mergeTemplates(comfyStatus({ templates: [info("scene-still"), info("upscale", { ready: false, note: "needs model upscale_models/4x.pth" })] }));
    expect(m.map((t) => t.name)).toEqual(["scene-still", "thumbnail-bg", "style-transfer", "upscale", "broll-motion"]);
    expect(m[0]).toMatchObject({ label: "Scene still", ready: true, implemented: true, needsInput: false });
    expect(m[1]).toMatchObject({ ready: false, note: "ComfyUI doesn't list this template." });
    expect(m[3]).toMatchObject({ label: "Upscale 4x", ready: false, note: "needs model upscale_models/4x.pth", needsInput: true });
    expect(m[4]).toMatchObject({ implemented: false, unavailableReason: "Not built yet: needs a video model." });
    expect(ui.mergeTemplates(null).every((t) => !t.ready && t.note === null)).toBe(true);
  });
});

describe("paramsFromGeneration / draftFromGeneration / rerollBlocker", () => {
  const job = comfyJob({ id: "g-1", template: "style-transfer", params: { prompt: "oil paint", seed: 99, steps: 2, aspect: "1:1", inputImage: IMG.path, denoise: 0.4, slug: "demo" } });
  it("the job's stored params win (exact, incl. inputImage)", () => {
    expect(ui.paramsFromGeneration(gen({ template: "style-transfer" }), job)).toEqual({ template: "style-transfer", params: { prompt: "oil paint", seed: 99, steps: 2, aspect: "1:1", inputImage: IMG.path, denoise: 0.4 } });
  });
  it("from GenMeta without a job (text-to-image)", () => {
    expect(ui.paramsFromGeneration(gen({ template: "scene-still" }), undefined)).toEqual({ template: "scene-still", params: { prompt: "a neon dance studio at night, wide shot", negative: "blurry", seed: 424242, steps: 4, width: 1024, height: 576 } });
  });
  it("img2img without the job: an error", () => {
    expect(ui.paramsFromGeneration(gen({ template: "style-transfer" }), undefined)).toEqual({ error: ui.REROLL_NO_SOURCE });
    expect(ui.rerollBlocker(gen({ template: "style-transfer" }), undefined)).toBe(ui.REROLL_NO_SOURCE);
    expect(ui.rerollBlocker(gen({ template: "style-transfer" }), job)).toBeNull();
    expect(ui.rerollBlocker(gen({ template: "scene-still" }), undefined)).toBeNull();
    expect(ui.rerollBlocker(gen({ template: "sdxl-turbo-still" }), undefined)).toMatch(/Unknown template/);
  });
  it("Tweak draft: input resolved to the asset, aspect from the size", () => {
    expect(ui.draftFromGeneration(gen({ template: "style-transfer" }), job, [IMG], "a-out")).toEqual({ template: "style-transfer", prompt: "oil paint", negative: "", seed: 99, aspect: null, steps: 2, denoise: 0.4, inputAssetId: "a-img", fromAssetId: "a-out" });
    expect(ui.draftFromGeneration(gen({ template: "scene-still" }), undefined, [], "a-out")).toMatchObject({ template: "scene-still", prompt: "a neon dance studio at night, wide shot", seed: 424242, aspect: "16:9", steps: 4, inputAssetId: null, fromAssetId: "a-out" });
    // img2img, job pruned: the settings still come over, the input is left to pick.
    expect(ui.draftFromGeneration(gen({ template: "upscale" }), undefined, [IMG], "a-out")).toMatchObject({ template: "upscale", inputAssetId: null, aspect: null });
  });
});

describe("aspectOf / randomSeed / upsertJob", () => {
  it("nearest aspect", () => {
    expect(ui.aspectOf(1024, 576)).toBe("16:9");
    expect(ui.aspectOf(576, 1024)).toBe("9:16");
    expect(ui.aspectOf(1024, 1024)).toBe("1:1");
    expect(ui.aspectOf(800, 1000)).toBe("4:5");
    expect(ui.aspectOf(1024, 768)).toBe("4:3");
    expect(ui.aspectOf(0, 0)).toBeNull();
  });
  it("random seed is a safe non-negative integer", () => {
    for (let i = 0; i < 50; i++) {
      const s = ui.randomSeed();
      expect(Number.isSafeInteger(s) && s >= 0).toBe(true);
    }
  });
  it("upsert replaces by id or adds at the front", () => {
    const a = comfyJob({ id: "a" });
    const b = comfyJob({ id: "b" });
    expect(ui.upsertJob([a], b).map((j) => j.id)).toEqual(["b", "a"]);
    const a2 = { ...a, status: "done" as const };
    expect(ui.upsertJob([b, a], a2)).toEqual([b, a2]);
  });
});

describe("deriveQueueDisplay", () => {
  const j = (status: ComfyJob["status"], error: string | null = null) => ({ status, error });
  const c = (p: Partial<ComfyStatus> = {}) => comfyStatus(p);
  it("finished and live states", () => {
    expect(ui.deriveQueueDisplay(j("done"), c())).toEqual({ state: "done", label: "Done", detail: null, tone: "teal" });
    expect(ui.deriveQueueDisplay(j("failed", "OOM"), c())).toEqual({ state: "failed", label: "Failed", detail: "OOM", tone: "alert" });
    expect(ui.deriveQueueDisplay(j("cancelled"), c())).toMatchObject({ state: "cancelled", label: "Cancelled", tone: "muted" });
    expect(ui.deriveQueueDisplay(j("waiting", "needs model checkpoints/x"), c())).toEqual({ state: "waiting_model", label: "Waiting for a model", detail: "needs model checkpoints/x", tone: "amber" });
    expect(ui.deriveQueueDisplay(j("running"), c({ running: true, phase: "rendering scene-still (1/2)" }))).toEqual({ state: "running", label: "Running", detail: "rendering scene-still (1/2)", tone: "violet" });
  });
  it("queued: in line while a batch runs, queued when admitted or unknown", () => {
    expect(ui.deriveQueueDisplay(j("queued"), c({ running: true, phase: "unloading LLMs" }))).toMatchObject({ state: "queued", label: "In line", detail: "unloading LLMs" });
    expect(ui.deriveQueueDisplay(j("queued"), c({ admission: "running" }))).toMatchObject({ state: "queued", label: "Queued", detail: null });
    expect(ui.deriveQueueDisplay(j("queued"), null)).toMatchObject({ state: "queued", label: "Queued" });
  });
  it("queued and held back: the label by policy, Rust's words as the detail", () => {
    for (const [policy, label] of [
      ["idle", "Waiting for idle"],
      ["overnight", "Waiting for 01:00–06:00"],
      ["manual", "Waiting for Run now"],
    ] as const) {
      const d = ui.deriveQueueDisplay(j("queued"), c({ admission: "mid-conversation (Tony spoke 20 s ago)", settings: { modelRoots: [], policy } }));
      expect(d).toEqual({ state: "waiting_idle", label, detail: "mid-conversation (Tony spoke 20 s ago)", tone: "amber" });
    }
  });
  it("Run now pressed but held back: 'Run now pending', not the policy wait", () => {
    const d = ui.deriveQueueDisplay(j("queued"), c({ runNow: true, admission: "mid-conversation (Tony spoke 20 s ago)", settings: { modelRoots: [], policy: "manual" } }));
    expect(d).toEqual({ state: "waiting_idle", label: "Run now pending", detail: "mid-conversation (Tony spoke 20 s ago)", tone: "amber" });
  });
  it("the export job in the same words", () => {
    expect(ui.exportDisplay(render())).toEqual({ state: "running", label: "Running", detail: "42% · encoding · ~10s", tone: "violet" });
    expect(ui.exportDisplay(render({ status: "queued", stage: "" }))).toMatchObject({ state: "queued", detail: null });
    expect(ui.exportDisplay(render({ status: "failed", error: "ffmpeg exit 1" }))).toMatchObject({ state: "failed", detail: "ffmpeg exit 1" });
    expect(ui.exportDisplay(render({ status: "done" }))).toMatchObject({ state: "done", tone: "teal" });
  });
});

describe("queueRows / capFinished / runNowBlocker", () => {
  it("export first, then this slug's jobs newest first", () => {
    const jobs = [comfyJob({ id: "old", createdAt: 1, status: "done", outputs: [{ path: "p", filename: "f", kind: "image", assetId: "a-1", gen: gen() }] }), comfyJob({ id: "new", createdAt: 5 }), comfyJob({ id: "other", slug: "else", createdAt: 9 })];
    const rows = ui.queueRows("demo", render(), jobs, comfyStatus());
    expect(rows.map((r) => r.id)).toEqual(["j-1", "new", "old"]);
    expect(rows[0]).toMatchObject({ kind: "export", pct: 42.4, canCancel: true });
    expect(rows[1]).toMatchObject({ kind: "comfy", canCancel: true, title: "Scene still · a neon dance studio" });
    expect(rows[2]).toMatchObject({ canCancel: false, outputAssetIds: ["a-1"] });
    expect(ui.queueRows("demo", render({ slug: "else" }), [], null)).toEqual([]);
    expect(ui.queueRows(null, render(), jobs, null)).toEqual([]);
  });
  it("long prompts are cut at 40 chars; upscale shows just the label", () => {
    expect(ui.comfyRowTitle({ template: "scene-still", params: { prompt: "x".repeat(60) } })).toBe(`Scene still · ${"x".repeat(39)}…`);
    expect(ui.comfyRowTitle({ template: "upscale", params: { prompt: "" } })).toBe("Upscale 4x");
  });
  it("caps finished rows, keeps every live one", () => {
    const rows = ui.queueRows("demo", null, [comfyJob({ id: "live", createdAt: 100 }), ...Array.from({ length: 10 }, (_, i) => comfyJob({ id: `d${i}`, createdAt: i, status: "done" }))], comfyStatus());
    const c = ui.capFinished(rows);
    expect(c.rows).toHaveLength(9);
    expect(c.hidden).toBe(2);
    expect(c.rows[0].id).toBe("live");
  });
  it("Run now: why not", () => {
    expect(ui.runNowBlocker(null)).toBe("ComfyUI status unavailable");
    expect(ui.runNowBlocker(comfyStatus({ running: true }))).toBe("A batch is running");
    expect(ui.runNowBlocker(comfyStatus())).toBe("Nothing queued");
    expect(ui.runNowBlocker(comfyStatus({ counts: { queued: 1, waiting: 0, running: 0, done: 0, failed: 0, cancelled: 0 } }))).toBeNull();
  });
});

describe("batonInfo", () => {
  const slot = (active: string[], p: Partial<{ queuedForeground: number; queuedBackground: number; capacity: number }> = {}) => ({ active, queuedForeground: 0, queuedBackground: 0, capacity: 1, ...p });
  it("ComfyUI's phase wins while a batch runs", () => {
    expect(ui.batonInfo(slot(["maintenance · comfyui · 2 job(s)"]), comfyStatus({ running: true, phase: "rendering scene-still (1/2)" }), null)).toMatchObject({ who: "comfy", label: "ComfyUI · rendering scene-still (1/2)", tone: "violet" });
    expect(ui.batonInfo(slot([]), comfyStatus({ running: true, phase: "unloading LLMs" }), null)).toMatchObject({ who: "comfy", label: "ComfyUI · unloading LLMs", tone: "amber" });
    expect(ui.batonInfo(slot(["maintenance · comfyui · 1 job(s)"]), null, null)).toMatchObject({ who: "comfy", label: "ComfyUI · rendering" });
  });
  it("Tony, another holder, or free", () => {
    expect(ui.batonInfo(slot(["lmstudio · Tony"]), comfyStatus(), null)).toMatchObject({ who: "tony", label: "GPU · Tony" });
    expect(ui.batonInfo(slot(["anythingllm · coder (streaming)"]), null, null)).toMatchObject({ who: "other", label: "GPU · coder (streaming)" });
    expect(ui.batonInfo(slot([]), comfyStatus(), null)).toMatchObject({ who: "free", label: "GPU free", tone: "green", detail: "1 slot free" });
    expect(ui.batonInfo(slot([]), null, render())).toMatchObject({ who: "free", label: "GPU free · CPU render" });
    expect(ui.batonInfo(null, null, null)).toMatchObject({ who: "free", tone: "unknown", detail: null });
  });
  it("detail lists holders and queued counts", () => {
    const d = ui.batonInfo(slot(["lmstudio · Tony"], { queuedForeground: 1, queuedBackground: 2 }), comfyStatus({ counts: { queued: 2, waiting: 1, running: 0, done: 0, failed: 0, cancelled: 0 } }), null).detail;
    expect(d).toBe("Holding the GPU: lmstudio · Tony · Queued: 1 Tony, 2 background · ComfyUI: 2 queued, 1 waiting for a model");
  });
});
