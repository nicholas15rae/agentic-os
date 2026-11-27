import { describe, expect, it } from "vitest";
import { createKillArm, isKillHotkey, KILL_PRESSES, summarizeIncident } from "./kill-switch-core";

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

describe("kill-switch arm/confirm", () => {
  const arming = (remaining: number) => ({ kind: "arming", remaining });
  it("defaults to three presses", () => {
    expect(KILL_PRESSES).toBe(3);
    const arm = createKillArm();
    expect(arm.press(0)).toEqual(arming(2));
    expect(arm.press(1_000)).toEqual(arming(1));
    expect(arm.press(2_000)).toEqual({ kind: "fire" });
    expect(arm.isArmed(2_001)).toBe(false); // firing disarms
    expect(arm.press(2_500)).toEqual(arming(2)); // the next press starts over
  });
  it("each press must come within the window of the previous one", () => {
    const arm = createKillArm(3, 5_000);
    arm.press(0);
    arm.press(4_000);
    expect(arm.press(8_500)).toEqual({ kind: "fire" }); // 4.5 s after the 2nd press: still live
    arm.press(10_000);
    arm.press(12_000);
    expect(arm.pressed(17_001)).toBe(0); // paused over 5 s: disarmed
    expect(arm.press(17_001)).toEqual(arming(2));
  });
  it("cancel disarms mid-sequence", () => {
    const arm = createKillArm();
    arm.press(0);
    arm.press(100);
    arm.cancel();
    expect(arm.press(200)).toEqual(arming(2));
  });
  it("supports a different press count", () => {
    const arm = createKillArm(2, 5_000);
    expect(arm.press(0)).toEqual(arming(1));
    expect(arm.press(1)).toEqual({ kind: "fire" });
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
