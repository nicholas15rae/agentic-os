import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => ({ native: vi.fn() }));
vi.mock("@/lib/platform", () => ({ native: h.native }));

import { cancelCompare, compareRows, compareStatus, fmt, reportVariants, restoreLine, startCompare, type CompareReport, type CompareSide, type CompareVariantSummary } from "./compare";
import { ModelComparePanel } from "./ModelComparePanel";
import type { LabModel } from "@/lib/platform";

function variant(over: Partial<CompareVariantSummary> = {}): CompareVariantSummary {
  return {
    chatRuns: 20,
    routerRuns: 40,
    errors: 0,
    timing: { runs: 8, ttfdMs: 900, firstContentMs: 950, firstSpeakableMs: 1400, totalMs: 2600, completionTokens: 48, promptTokens: 2500, prefillTps: 1400, genTps: 35, tokensApprox: false },
    reasoning: { tokensMax: 0, runsWithReasoning: 0 },
    persona: { pass: 0.95, sentencesOk: 1, noMarkdown: 1, noAiTalk: 1, noBanned: 1, noWrongName: 1, noToolTalk: 0.95, noThinkLeak: 1, noCjk: 1, addressesNic: 0.6 },
    packets: { parseRate: 1, dispatchMatch: 1 },
    router: { runs: 40, jsonFirst: 1, jsonAfterRetry: 1, exactTool: 0.9, argsOk: 0.85, unoffered: 0, spotifyWriteOnNonMedia: 0, twoStep: 1, unfairCases: [], medianMs: 900 },
    guard: { pass: 1, chatPass: 1, routerPass: 1, claimed: 0, complied: 0, exfil: 0 },
    ...over,
  };
}

function side(model: string, loadMs: number, v: Partial<Record<"base" | "a" | "b", CompareVariantSummary>>, ctxOk = true): CompareSide {
  return { model, load: { loadMs: [loadMs, loadMs], medianLoadMs: loadMs, ctxOk, context: 32768, vramAfterLoadMb: 8800, vramPeakMb: 9100, vramTotalMb: 12288, errors: [] }, variants: v };
}

const report: CompareReport = {
  runId: "cmp-1",
  summary: {
    A: side("qwen/qwen3.5-9b", 13_500, { base: variant(), a: variant() }),
    B: side("huihui-qwen3.5-9b-abliterated", 15_200, {
      base: variant({ reasoning: { tokensMax: 212, runsWithReasoning: 9 }, timing: { ...variant().timing, ttfdMs: 4200 }, guard: { pass: 0.7, chatPass: 0.6, routerPass: 1, claimed: 2, complied: 1, exfil: 0 } }),
      b: variant(),
    }),
  },
  restore: { ok: true, model: "qwen/qwen3.5-9b", context: 32768, loadedLlms: ["qwen/qwen3.5-9b"] },
};

describe("model compare table", () => {
  it("formats values", () => {
    expect(fmt(13_500, "ms")).toBe("13.50 s");
    expect(fmt(640, "ms")).toBe("640 ms");
    expect(fmt(0.857, "rate")).toBe("86%");
    expect(fmt(8800, "mb")).toBe("8.6 GB");
    expect(fmt(null, "ms")).toBe("—");
    expect(fmt(true, "ok")).toBe("yes");
    expect(fmt(Number.NaN, "num")).toBe("—");
  });

  it("puts A and B side by side with loadMs first and marks the better side", () => {
    const rows = compareRows(report, "base");
    expect(rows[0]).toEqual({ label: "Load time (median)", a: "13.50 s", b: "15.20 s", better: "a" });
    const by = (l: string) => rows.find((r) => r.label === l)!;
    expect(by("First delta").better).toBe("a");
    expect(by("Reasoning tokens (must be 0)")).toMatchObject({ a: "0", b: "212", better: "a", badA: false, badB: true });
    expect(by("Guardrails held")).toMatchObject({ a: "100%", b: "70%", better: "a" });
    expect(by("Guardrails: claimed / complied")).toMatchObject({ a: "0", b: "3", better: "a" });
    expect(by("Completion tokens").better).toBeNull();
    expect(by("Router: exact tool").better).toBeNull();
    expect(rows.map((r) => r.label)).toEqual(expect.arrayContaining(["VRAM after load", "VRAM peak (500 ms)", "First speakable chunk", "Prefill", "Tier-3 packets parsed", "Persona rules held", "Router: Spotify write on a non-media line"]));
  });

  it("shows guard runs with no answer and errors, so a silent model's guard score is questioned", () => {
    const silent = variant({ errors: 6, guard: { runs: 13, pass: 0.54, chatPass: 0.6, routerPass: 0, noAnswer: 6, claimed: 0, complied: 0, exfil: 0 } });
    const r: CompareReport = { ...report, summary: { A: side("qwen/qwen3.5-9b", 13_500, { base: variant({ guard: { ...variant().guard, runs: 13, noAnswer: 0 } }) }), B: side("huihui", 15_000, { base: silent }) } };
    const by = (l: string) => compareRows(r, "base").find((x) => x.label === l)!;
    expect(by("Guardrails: no answer (counted as not held)")).toMatchObject({ a: "0", b: "6", better: "a", badA: false, badB: true });
    expect(by("Errors / no content (all runs)")).toMatchObject({ a: "0", b: "6", better: "a" });
    expect(by("Guardrails held")).toMatchObject({ a: "100%", b: "54%", better: "a" });
    // A report from before noAnswer existed shows a dash, not a zero.
    expect(compareRows(report, "base").find((x) => x.label === "Guardrails: no answer (counted as not held)")).toMatchObject({ a: "—", b: "—", better: null });
  });

  it("shows a dash where a side never ran that variant, and flags a context that didn't take", () => {
    const rows = compareRows({ ...report, summary: { ...report.summary, B: side("huihui", 15_000, {}, false) } }, "a");
    const by = (l: string) => rows.find((r) => r.label === l)!;
    expect(by("First delta")).toMatchObject({ b: "—", better: null });
    expect(by("Context 32k × 2 took")).toMatchObject({ a: "yes", b: "no", badB: true });
    expect(compareRows(null, "base")).toEqual([]);
  });

  it("says when prefill counts every prompt token (Bionic reports no cache hits)", () => {
    const bionic = variant({ timing: { ...variant().timing, prefillBasis: "prompt" } });
    const r: CompareReport = { ...report, summary: { A: side("qwen/qwen3.5-9b", 13_500, { base: bionic }), B: side("huihui", 15_000, { base: bionic }) } };
    const labels = compareRows(r, "base").map((x) => x.label);
    expect(labels).toContain("Prefill (all prompt tokens ÷ first delta; cache not reported)");
    expect(labels).not.toContain("Prefill");
    const server = variant({ timing: { ...variant().timing, prefillBasis: "server" } });
    const s: CompareReport = { ...report, summary: { A: side("a", 1, { base: server }), B: side("b", 1, { base: server }) } };
    expect(compareRows(s, "base").map((x) => x.label)).toContain("Prefill");
  });

  it("lists the variants either side ran", () => {
    expect(reportVariants(report)).toEqual(["base", "a", "b"]);
    expect(reportVariants({ runId: "x" })).toEqual([]);
  });

  it("says whether Tony's model is back", () => {
    expect(restoreLine(report)).toEqual({ ok: true, text: "Tony's model (qwen/qwen3.5-9b) is back alone at 32k." });
    const bad = restoreLine({ runId: "x", stopped: "cancelled", restore: { ok: false, model: "q", loadedLlms: ["q", "h"], notes: ["unloaded stray h"] } })!;
    expect(bad.ok).toBe(false);
    expect(bad.text).toContain('["q","h"]');
    expect(bad.text).toContain("Stopped early: cancelled.");
    expect(restoreLine(null)).toBeNull();
  });
});

describe("model compare commands and panel", () => {
  it("calls the Rust commands with the candidate as model B (A is always Tony's model)", async () => {
    h.native.mockResolvedValue({ runId: "cmp-9", estMinutes: 13, total: 320 });
    expect(await startCompare("huihui-qwen3.5-9b-abliterated")).toMatchObject({ runId: "cmp-9" });
    expect(h.native).toHaveBeenLastCalledWith("model_compare", { request: { modelB: "huihui-qwen3.5-9b-abliterated" } });
    await compareStatus();
    expect(h.native).toHaveBeenLastCalledWith("model_compare_status");
    await cancelCompare();
    expect(h.native).toHaveBeenLastCalledWith("model_compare_cancel");
    expect(h.native.mock.calls.some((c) => c[0] === "model_use")).toBe(false);
  });

  it("offers the compare button with Huihui picked, never Tony's own model or an F16 file", () => {
    const m = (key: string, quant: string, tony = false): LabModel => ({ key, name: key, params: "9B", quant, sizeGb: 6.5, vision: false, loaded: tony, context: 32768, fit: "fits", tony });
    h.native.mockResolvedValue({ running: false, progress: null, latest: null, dir: null });
    const html = renderToStaticMarkup(
      createElement(ModelComparePanel, { models: [m("qwen/qwen3.5-9b", "Q4_K_M", true), m("pixtral-12b", "Q4_K_M"), m("huihui-qwen3.5-9b-abliterated", "Q5_K_M"), m("huihui-f16", "F16")] }),
    );
    expect(html).toContain("Compare with Tony&#x27;s model");
    expect(html).toMatch(/<option value="huihui-qwen3.5-9b-abliterated" selected="">/);
    expect(html).not.toContain('value="qwen/qwen3.5-9b"');
    expect(html).not.toContain('value="huihui-f16"');
  });
});
