import { describe, expect, it, vi } from "vitest";
import {
  classifyKillKey,
  createKillArm,
  createKillKeyListener,
  isKillHotkey,
  isRepeatActivation,
  KILL_PRESSES,
  killButtonProps,
  summarizeIncident,
  type KillToast,
} from "./kill-switch-core";

/** The exact listener useKillSwitchHotkey registers, with a fake clock, a recorded trip and recorded toasts. */
function hotkey() {
  let t = 0;
  const toasts: KillToast[] = [];
  const trip = vi.fn(async () => ({ incidentId: "i", ok: true, dryRun: false, cancelled: [], flatten: [], errors: [], steps: [] }));
  const onKey = createKillKeyListener({ trip, notify: (x) => toasts.push(x), now: () => t });
  const ev = (k: string, mods: { ctrl?: boolean; shift?: boolean; repeat?: boolean } = {}) => ({
    key: k, ctrlKey: !!mods.ctrl, metaKey: false, shiftKey: !!mods.shift, altKey: false, repeat: !!mods.repeat,
    preventDefault: vi.fn(), stopPropagation: vi.fn(),
  });
  const chord = (repeat = false) => ev("X", { ctrl: true, shift: true, repeat });
  return { onKey, trip, toasts, ev, chord, at: (ms: number) => (t = ms) };
}

describe("kill-switch hotkey listener (what useKillSwitchHotkey registers)", () => {
  it("a held Ctrl+Shift+X never trips: repeats are swallowed and never counted", () => {
    const h = hotkey();
    const first = h.chord();
    h.onKey(first);
    const repeats = Array.from({ length: 45 }, () => h.chord(true));
    repeats.forEach((e, i) => (h.at(500 + i * 33), h.onKey(e)));
    expect(h.trip).not.toHaveBeenCalled();
    expect(h.toasts.map((x) => x.title)).toEqual([`Kill switch ARMED (1/${KILL_PRESSES})`]);
    expect([first, ...repeats].every((e) => e.preventDefault.mock.calls.length === 1)).toBe(true); // swallowed, not passed on
  });
  it("three separate presses within the window trip it once", () => {
    const h = hotkey();
    [0, 400, 800].forEach((ms) => (h.at(ms), h.onKey(h.chord())));
    expect(h.trip).toHaveBeenCalledTimes(1);
    expect(h.trip).toHaveBeenCalledWith("keyboard Ctrl+Shift+X x3 (confirmed)");
  });
  it("Esc disarms; other keys pass through untouched", () => {
    const h = hotkey();
    h.onKey(h.chord());
    h.at(100);
    h.onKey(h.ev("Escape"));
    expect(h.toasts.at(-1)?.title).toBe("Kill switch disarmed");
    [200, 300].forEach((ms) => (h.at(ms), h.onKey(h.chord())));
    expect(h.trip).not.toHaveBeenCalled(); // the count started over after Esc
    const plain = h.ev("x", { ctrl: true });
    h.onKey(plain);
    expect(plain.preventDefault).not.toHaveBeenCalled();
  });
});

describe("red kill button props (spread onto TradingDesk's <button>)", () => {
  const key = (k: string, repeat: boolean) => ({ key: k, repeat, preventDefault: vi.fn() });
  it("blocks a held Enter / Space from clicking it again, lets a single press through", () => {
    const onPress = vi.fn();
    const p = killButtonProps({ pressed: 1, busy: false, onPress });
    for (const k of ["Enter", " "]) {
      const held = key(k, true);
      p.onKeyDown(held);
      expect(held.preventDefault).toHaveBeenCalledTimes(1);
      const once = key(k, false);
      p.onKeyDown(once);
      expect(once.preventDefault).not.toHaveBeenCalled();
    }
    expect(p.onClick).toBe(onPress);
  });
  it("labels and busy state", () => {
    const p0 = killButtonProps({ pressed: 0, busy: true, onPress: () => undefined });
    expect(p0.disabled).toBe(true);
    expect(p0["aria-label"]).toContain(`click ${KILL_PRESSES} times`);
    expect(killButtonProps({ pressed: 2, busy: false, onPress: () => undefined })["aria-label"]).toContain("1 more click to lock");
  });
});

const key = (k: string, mods: Partial<Record<"ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "repeat", boolean>> = {}) => ({ key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, repeat: false, ...mods });

describe("kill-switch key repeat", () => {
  const chord = (repeat = false) => key("X", { ctrlKey: true, shiftKey: true, repeat });
  it("classifies a held chord's autorepeat apart from a deliberate press", () => {
    expect(classifyKillKey(chord())).toBe("press");
    expect(classifyKillKey(chord(true))).toBe("repeat");
    expect(classifyKillKey(key("x", { ctrlKey: true, repeat: true }))).toBe("none");
  });
  it("holding Ctrl+Shift+X never trips it; three separate presses still do", () => {
    // What useKillSwitchHotkey does with each keydown: count only "press".
    const feed = (events: { e: ReturnType<typeof chord>; at: number }[]) => {
      const arm = createKillArm();
      return events.map(({ e, at }) => (classifyKillKey(e) === "press" ? arm.press(at).kind : "ignored"));
    };
    // OS autorepeat: ~500 ms delay, then ~30 Hz, for 2 s
    const held = [{ e: chord(), at: 0 }, ...Array.from({ length: 45 }, (_, i) => ({ e: chord(true), at: 500 + i * 33 }))];
    expect(feed(held)).not.toContain("fire");
    expect(feed([{ e: chord(), at: 0 }, { e: chord(), at: 400 }, { e: chord(), at: 800 }]).at(-1)).toBe("fire");
  });
  it("a held Enter or Space on the red button is a repeat activation; a single press is not", () => {
    expect(isRepeatActivation(key("Enter", { repeat: true }))).toBe(true);
    expect(isRepeatActivation(key(" ", { repeat: true }))).toBe(true);
    expect(isRepeatActivation(key("Enter"))).toBe(false);
    expect(isRepeatActivation(key("Tab", { repeat: true }))).toBe(false);
  });
});

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
