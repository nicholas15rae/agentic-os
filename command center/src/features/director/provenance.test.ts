import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { asset, gen } from "./fixtures.test-util";

vi.mock("@/stores/nav", () => ({ useNav: Object.assign(() => () => undefined, { getState: () => ({ go: () => undefined }) }) }));
vi.mock("@/features/reminders/notify", () => ({ useToasts: { getState: () => ({ push: vi.fn() }) } }));

const { upgradeAsset, upgradeGenMeta, genSettingsJson } = await import("./manifest");
const { GeneratedChip, GenerationBlock } = await import("./AssetDetails");

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

describe("generation provenance: upgrade", () => {
  it("old (v1 / v2) asset rows read as not generated", () => {
    expect(upgradeAsset({ id: "a-x" }).generation).toBeNull();
    expect(upgradeAsset({ id: "a-x", generation: null }).generation).toBeNull();
    expect(upgradeAsset({ id: "a-x", generation: "junk" }).generation).toBeNull();
    expect(upgradeAsset({ id: "a-x", generation: [1] }).generation).toBeNull();
  });

  it("upgradeAsset keeps a generation record as it came from Rust", () => {
    const g = gen();
    expect(upgradeAsset({ ...asset("a-g", "image"), generation: g }).generation).toEqual(g);
  });

  it("a partial record gets defaults; bad values don't leak through", () => {
    const g = upgradeGenMeta({ template: "t1", seed: 7, peakVramMb: "lots", whisperResident: "yes", renderMs: Number.NaN, workflow: { "3": {} } })!;
    expect(g).toMatchObject({ template: "t1", seed: 7, steps: 0, prompt: "", peakVramMb: null, whisperResident: null, renderMs: 0, checkpointSha256: null, sidecarPath: null, durationSec: null });
    expect(g.workflow).toEqual({ "3": {} });
    expect("workflow" in upgradeGenMeta({ template: "t" })!).toBe(false);
  });

  it("Copy settings is the re-usable settings only (no ids, timings, paths or workflow)", () => {
    const j = JSON.parse(genSettingsJson({ ...gen(), workflow: { big: true } }));
    expect(j).toEqual({ template: "sdxl-turbo-still", prompt: "a neon dance studio at night, wide shot", negative: "blurry", seed: 424242, steps: 4, cfg: 1, sampler: "euler_ancestral", scheduler: "normal", width: 1024, height: 576, denoise: 1, checkpoint: "sd_xl_turbo_1.0_fp16.safetensors", checkpointSha256: "ab12", comfyuiVersion: "0.46.0" });
  });
});

describe("generation provenance: UI", () => {
  it("the bin chip shows only for generated assets", () => {
    expect(html(createElement(GeneratedChip, { asset: asset("a-v", "video") }))).toBe("");
    const h = html(createElement(GeneratedChip, { asset: asset("a-g", "image", { generation: gen() }) }));
    expect(h).toContain("Generated");
    expect(h).toContain("seed 424242");
  });

  it("the details block shows template, seed, steps, prompt, render time and peak VRAM, and copies the settings", () => {
    const h = html(createElement(GenerationBlock, { gen: gen(), onCopy: () => undefined }));
    for (const s of ["sdxl-turbo-still", "424242", "4 · cfg 1 · euler_ancestral", "a neon dance studio at night", "2.1 s", "7.1 GB", "Copy settings"]) expect(h).toContain(s);
    expect(h).not.toMatch(/re-?roll|tweak/i);
    const unknown = html(createElement(GenerationBlock, { gen: gen({ peakVramMb: null, renderMs: 0, prompt: "" }), onCopy: () => undefined }));
    expect(unknown).toContain("—");
    expect(unknown).not.toContain("“");
  });
});
