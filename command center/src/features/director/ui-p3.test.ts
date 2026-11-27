import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { asset, gen } from "./fixtures.test-util";
import { comfyJob, comfyStatus } from "./comfy-fixtures.test-util";

vi.mock("@/stores/nav", () => ({ useNav: Object.assign(() => () => undefined, { getState: () => ({ go: () => undefined }) }) }));
vi.mock("@/features/reminders/notify", () => ({ useToasts: { getState: () => ({ push: vi.fn() }) } }));
vi.mock("./bizops", () => ({ sendRenderToBizOps: vi.fn() }));

const ui = await import("./comfy-ui");
const { GeneratePanelView } = await import("./GeneratePanel");
const { RenderQueueView } = await import("./RenderQueue");
const { BatonPillView } = await import("./BatonPill");
const { GenerationBlock } = await import("./AssetDetails");
const { ShotSlotCard } = await import("./ShotSlotCard");

const noop = () => undefined;
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const IMG = asset("a-img", "image", { name: "still_01.png" });

const panel = (p: Partial<Parameters<typeof GeneratePanelView>[0]> = {}) =>
  html(
    createElement(GeneratePanelView, {
      open: true,
      onToggle: noop,
      templates: ui.mergeTemplates(comfyStatus()),
      draft: ui.defaultDraft(),
      onDraft: noop,
      projectAspect: "9:16",
      inputs: [],
      tweakingName: null,
      blocker: null,
      policy: "idle",
      busy: false,
      onEnqueue: noop,
      ...p,
    }),
  );

describe("GeneratePanelView", () => {
  it("collapsed: one row with the readiness dot", () => {
    const h = panel({ open: false });
    expect(h).toContain("Generate a still");
    expect(h).toContain('aria-expanded="false"');
    expect(h).toContain("bg-teal");
    expect(h).not.toContain("Enqueue");
  });
  it("open: the fields, the project aspect, the count and the policy line", () => {
    const h = panel({ draft: { ...ui.defaultDraft(), prompt: "hello" } });
    for (const s of ['aria-label="Template"', 'aria-label="Prompt"', "5 / 2000", "Has little effect on SDXL Turbo", 'aria-label="Seed"', "Random", "Project (9:16)", 'aria-label="Steps"', "Enqueue", "Runs when the PC is idle. Tony is unloaded for the batch, then put back."]) expect(h).toContain(s);
    expect(h).not.toContain('aria-label="Denoise"');
    expect(h).not.toContain("Input still");
    // broll-motion is disabled in the picker.
    expect(h).toMatch(/<option value="broll-motion" disabled="">B-roll motion \(not ready\)<\/option>/);
  });
  it("Enqueue is disabled with its visible reason", () => {
    const h = panel({ blocker: "Write a prompt" });
    expect(h).toMatch(/<button type="button" disabled=""[^>]*>Enqueue<\/button>/);
    expect(h).toContain('role="note">Write a prompt</span>');
  });
  it("a not-ready template shows its note under the picker", () => {
    const templates = ui.mergeTemplates(comfyStatus({ templates: [{ name: "upscale", requiredModels: ["upscale_models/4x.pth"], missing: ["upscale_models/4x.pth"], ready: false, note: "needs model upscale_models/4x.pth" }] }));
    const h = panel({ templates, draft: { ...ui.defaultDraft(), template: "upscale" }, inputs: [IMG] });
    expect(h).toContain('text-amber-soft">needs model upscale_models/4x.pth</span>');
    expect(h).toContain("Upscale 4x (not ready)");
    expect(h).not.toContain('aria-label="Prompt"'); // upscale has no prompt
    expect(h).not.toContain('aria-label="Aspect"'); // keeps the source size
    expect(h).toContain('aria-label="Input still_01.png"');
    expect(h).toContain("bg-amber");
  });
  it("style-transfer: denoise + input; an empty bin says so; Tweaking line", () => {
    const h = panel({ draft: { ...ui.defaultDraft(), template: "style-transfer" }, tweakingName: "still_03.png" });
    expect(h).toContain('aria-label="Denoise"');
    expect(h).toContain("Add a still to the bin first.");
    expect(h).toContain("Tweaking still_03.png");
    expect(h).toContain("Clear");
  });
});

describe("RenderQueueView", () => {
  const props = (rows: ReturnType<typeof ui.queueRows>, p: Partial<Parameters<typeof RenderQueueView>[0]> = {}) => ({
    rows,
    policy: "idle" as const,
    runNowBlocked: null,
    admission: null,
    busy: { runNow: false, policy: false, cancel: null },
    onCancel: noop,
    onRunNow: noop,
    onPolicy: noop,
    onShowOutput: noop,
    ...p,
  });
  it("nothing to show: null", () => {
    expect(html(createElement(RenderQueueView, props([])))).toBe("");
  });
  it("the waiting-model row shows the missing model", () => {
    const rows = ui.queueRows("demo", null, [comfyJob({ status: "waiting", error: "needs model checkpoints/sd_xl_turbo.safetensors" })], comfyStatus());
    const h = html(createElement(RenderQueueView, props(rows)));
    expect(h).toContain("Waiting for a model");
    expect(h).toContain("needs model checkpoints/sd_xl_turbo.safetensors");
    expect(h).toContain('aria-label="Cancel Scene still · a neon dance studio"');
  });
  it("a queued row under the manual policy says Waiting for Run now", () => {
    const status = comfyStatus({ admission: "manual policy: press Run now", settings: { modelRoots: [], policy: "manual" }, counts: { queued: 1, waiting: 0, running: 0, done: 0, failed: 0, cancelled: 0 } });
    const rows = ui.queueRows("demo", null, [comfyJob()], status);
    const h = html(createElement(RenderQueueView, props(rows, { policy: "manual", admission: status.admission })));
    expect(h).toContain("Waiting for Run now");
    expect(h).toContain("ComfyUI: manual policy: press Run now");
    expect(h).toContain('title="Applies to every project"');
    expect(h).toContain("Only on Run now");
    expect(h).not.toMatch(/disabled=""[^>]*title="Start the ComfyUI batch now"/);
  });
  it("Run now disabled with its reason; export row has a bar; done row links its output", () => {
    const rows = ui.queueRows("demo", { slug: "demo", jobId: "j-1", status: "running", pct: 30, etaSec: null, stage: "encoding" }, [comfyJob({ status: "done", outputs: [{ path: "p", filename: "f", kind: "image", assetId: "a-1", gen: gen() }] })], comfyStatus());
    const h = html(createElement(RenderQueueView, props(rows, { runNowBlocked: "Nothing queued" })));
    expect(h).toMatch(/disabled=""[^>]*title="Nothing queued"/);
    expect(h).toContain("Export (CPU render)");
    expect(h).toContain('aria-valuenow="30"');
    expect(h).toContain("Show output");
    expect(h).toContain(">Done<");
  });
});

describe("BatonPillView", () => {
  it("static dot (no pulse), label and detail", () => {
    const h = html(createElement(BatonPillView, { info: ui.batonInfo({ active: ["lmstudio · Tony"], queuedForeground: 0, queuedBackground: 0, capacity: 1 }, null, null) }));
    expect(h).toContain("GPU · Tony");
    expect(h).toContain('title="Holding the GPU: lmstudio · Tony"');
    expect(h).not.toContain("animate-");
  });
});

describe("GenerationBlock: Re-roll / Tweak", () => {
  it("shows both buttons with handlers; a blocked re-roll is disabled with its reason", () => {
    const h = html(createElement(GenerationBlock, { gen: gen(), onCopy: noop, onReroll: noop, onTweak: noop, rerollBlocked: ui.REROLL_NO_SOURCE }));
    expect(h).toContain("Re-roll");
    expect(h).toContain("Tweak");
    expect(h).toMatch(/disabled=""[^>]*title="The source still for this one isn&#x27;t known any more"/);
    expect(h).toContain("Re-roll: The source still");
    const ok = html(createElement(GenerationBlock, { gen: gen(), onCopy: noop, onReroll: noop, onTweak: noop, rerollBlocked: null }));
    expect(ok).not.toContain('disabled=""');
  });
});

describe("ShotSlotCard: Generate… for a generate slot", () => {
  it("only on source generate, never on film", () => {
    const base = { id: "s1", label: "Neon sky", instructions: "", kind: "image" as const, targetSec: null, assetId: null, status: "needed" as const, framing: null, action: "", source: "generate" as const, phoneTips: [], filmed: false };
    const h = html(createElement("ul", null, createElement(ShotSlotCard, { slot: base, index: 0, count: 1, slug: "demo", asset: null })));
    expect(h).toContain('aria-label="Generate a still for Neon sky"');
    const film = html(createElement("ul", null, createElement(ShotSlotCard, { slot: { ...base, source: "film" }, index: 0, count: 1, slug: "demo", asset: null })));
    expect(film).not.toContain("Generate…");
  });
});
