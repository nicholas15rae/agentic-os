import { describe, expect, it } from "vitest";
import { deleteConfirmed, fitLabel, healthText, parseHfInput, progressText, vramBar, type Fit } from "./engine";

const fit = (p: Partial<Fit>): Fit => ({
  weightsMiB: 5366, kvCacheMiB: 1024, recurrentMiB: 105, projectorMiB: 0, computeMiB: 800, totalMiB: 7295,
  freeMiB: 1655, reclaimMiB: 0, availableMiB: 1255, fits: false, fitsEmptyCard: true, shortMiB: 6040, ctx: 32768, kv: "f16/f16", ...p,
});

describe("engine screen helpers", () => {
  it("VRAM bar tones", () => {
    expect(vramBar({ totalMiB: 12288, usedMiB: 10574 })).toMatchObject({ pct: 86, tone: "warn" });
    expect(vramBar({ totalMiB: 12288, usedMiB: 12000 }).tone).toBe("bad");
    expect(vramBar({ totalMiB: 12288, usedMiB: 2000 }).tone).toBe("ok");
    expect(vramBar({ totalMiB: 0, usedMiB: 5 }).pct).toBe(0);
  });

  it("fit badge: card busy vs too big vs fits", () => {
    expect(fitLabel(fit({}))).toMatchObject({ tone: "warn" });
    expect(fitLabel(fit({})).title).toContain("Bionic");
    expect(fitLabel(fit({ fits: true, availableMiB: 9000 })).text).toMatch(/^fits/);
    expect(fitLabel(fit({ fitsEmptyCard: false })).tone).toBe("bad");
    expect(fitLabel(null).tone).toBe("muted");
    expect(fitLabel(fit({ error: "not a GGUF file" })).title).toBe("not a GGUF file");
  });

  it("health text never claims Tony is on the engine while it is off", () => {
    expect(healthText({ enabled: false, health: "down", baseUrl: "" })).toContain("LM Studio");
    expect(healthText({ enabled: false, health: "ok", baseUrl: "" })).toContain("nothing routes here");
    expect(healthText({ enabled: true, health: "error", baseUrl: "" })).toContain("watchdog");
  });

  it("parses repo + file and pasted Hugging Face links, rejects escapes", () => {
    expect(parseHfInput("Qwen/Qwen3-8B-GGUF", "Qwen3-8B-Q4_K_M.gguf")).toEqual({ repo: "Qwen/Qwen3-8B-GGUF", filename: "Qwen3-8B-Q4_K_M.gguf", revision: "main" });
    expect(parseHfInput("https://huggingface.co/unsloth/Qwen3-8B-GGUF/resolve/abc123/Qwen3-8B-Q4_K_M.gguf")).toEqual({ repo: "unsloth/Qwen3-8B-GGUF", filename: "Qwen3-8B-Q4_K_M.gguf", revision: "abc123" });
    expect(parseHfInput("https://huggingface.co/o/r/blob/main/m.gguf?download=true")).toHaveProperty("error");
    expect(parseHfInput("../x/y", "a.gguf")).toHaveProperty("error");
    expect(parseHfInput("o/r", "sub/a.gguf")).toHaveProperty("error");
    expect(parseHfInput("o/r", "a.safetensors")).toHaveProperty("error");
  });

  it("delete needs the exact file name", () => {
    expect(deleteConfirmed("D:\\Models\\a\\Qwen.gguf", "Qwen.gguf")).toBe(true);
    expect(deleteConfirmed("D:\\Models\\a\\Qwen.gguf", "qwen.gguf")).toBe(false);
    expect(deleteConfirmed("D:\\Models\\a\\Qwen.gguf", "yes")).toBe(false);
    expect(deleteConfirmed("", "")).toBe(false);
  });

  it("download progress", () => {
    expect(progressText({ key: "k", state: "running", done: 512 * 1048576, total: 1024 * 1048576 })).toBe("512 MB / 1024 MB (50 %)");
    expect(progressText({ key: "k", state: "failed", done: 0, total: null, error: "sha256 mismatch" })).toContain("sha256");
    expect(progressText({ key: "k", state: "exists", done: 0, total: null })).toBe("already on disk");
  });
});
