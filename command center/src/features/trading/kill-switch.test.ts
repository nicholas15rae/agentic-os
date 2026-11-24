import { describe, expect, it } from "vitest";
import { isKillHotkey, summarizeIncident } from "./kill-switch-core";

const key = (k: string, mods: Partial<Record<"ctrlKey" | "metaKey" | "shiftKey" | "altKey", boolean>> = {}) => ({ key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });

describe("kill-switch hotkey", () => {
  it("fires on Ctrl/Cmd+Shift+X only", () => {
    expect(isKillHotkey(key("X", { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isKillHotkey(key("x", { metaKey: true, shiftKey: true }))).toBe(true);
    expect(isKillHotkey(key("x", { ctrlKey: true }))).toBe(false);
    expect(isKillHotkey(key("x", { shiftKey: true }))).toBe(false);
    expect(isKillHotkey(key("x", { ctrlKey: true, shiftKey: true, altKey: true }))).toBe(false);
    expect(isKillHotkey(key("k", { ctrlKey: true, shiftKey: true }))).toBe(false);
  });
});

describe("summarizeIncident", () => {
  const base = { incidentId: "i", ok: true, cancelled: [{}, {}], flatten: [{ symbol: "SPY", action: "SELL", qty: 5 }], errors: [] };
  it("describes a live kill and a dry run", () => {
    expect(summarizeIncident({ ...base, dryRun: false, steps: [] })).toBe("Locked · 2 order(s) cancelled · 1 position(s) flattening");
    expect(summarizeIncident({ ...base, dryRun: true, steps: [] })).toBe("Dry run · 2 order(s) to cancel · 1 position(s) to flatten");
  });
  it("surfaces failed steps and the gateway failsafe", () => {
    const s = summarizeIncident({ ...base, dryRun: false, ok: false, steps: [{ step: "connect", ok: false, detail: "refused" }] });
    expect(s).toContain("connect: refused");
    expect(summarizeIncident({ ...base, dryRun: false, steps: [], failsafe: true, note: "lock written by the gateway" })).toBe("lock written by the gateway");
  });
});
