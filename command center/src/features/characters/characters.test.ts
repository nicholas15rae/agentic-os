import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GAP_MS, HELLO_GAP_MS, bubbleSpot, candidates, isDoneToast, isStreak, mayPop, migrateFrequency, overlap, pickLine, placeCharacter, quietReason } from "./logic";
import { CHARACTER_DEFAULTS, activeCharacters, sanitizeCharacters, setQuietCheck, useCharacters } from "./character-store";
import { installCharacterEvents, setQuiet } from "./events";
import { wavyCircle } from "./drawings";

const VW = 1280;
const VH = 800;
const S = 64;

describe("where a character peeks in", () => {
  it("its own corner when nothing is there", () => {
    expect(placeCharacter("br", VW, VH, S, [])).toMatchObject({ corner: "br", x: VW - S - 16, y: VH - S - 16 });
  });

  it("never on a safety control: it moves up, then to another corner", () => {
    const killSwitch = { x: VW - 120, y: VH - 120, w: 110, h: 110 };
    const at = placeCharacter("br", VW, VH, S, [killSwitch]);
    expect(overlap(at, { x: killSwitch.x - 8, y: killSwitch.y - 8, w: killSwitch.w + 16, h: killSwitch.h + 16 })).toBe(0);
    expect(placeCharacter("br", VW, VH, S, [{ x: VW - 100, y: 0, w: 100, h: VH }]).corner).toBe("bl");
  });

  it("every corner blocked: the spot with the least overlap", () => {
    expect(candidates("br", VW, VH, S)).toHaveLength(12);
    expect(placeCharacter("br", VW, VH, S, [{ x: 0, y: 0, w: VW, h: VH }])).toBeTruthy();
  });

  it("the bubble never covers an obstacle and stays on screen (else no bubble)", () => {
    const at = placeCharacter("br", VW, VH, S, []);
    const b = bubbleSpot(at, [], VW, VH)!;
    expect(b.x + b.w).toBeLessThanOrEqual(at.x);
    const b2 = bubbleSpot(at, [{ ...b }], VW, VH)!;
    expect(overlap(b2, b)).toBe(0);
    expect(bubbleSpot(at, [{ x: 0, y: 0, w: VW, h: VH }], VW, VH)).toBeNull();
  });
});

describe("how often, and when never", () => {
  it("Off / muted: never; otherwise after the frequency's gap", () => {
    expect(mayPop(1e12, 0, "off", false)).toBe(false);
    expect(mayPop(1e12, 0, "normal", true)).toBe(false);
    expect(mayPop(GAP_MS.normal - 1, 0, "normal", false)).toBe(false);
    expect(mayPop(GAP_MS.normal, 0, "normal", false)).toBe(true);
    expect(GAP_MS.rare).toBeGreaterThan(GAP_MS.normal);
  });

  it("older saves map onto Off / Rare / Normal", () => {
    expect(migrateFrequency("taps")).toBe("off");
    expect(migrateFrequency("lively")).toBe("normal");
    expect(migrateFrequency("rare")).toBe("rare");
    expect(migrateFrequency("whenever")).toBe("normal");
  });

  it("never during a call, typing, full screen, Trading or Do Not Disturb", () => {
    const calm = { inCall: false, typing: false, fullscreen: false, section: "command", dnd: false };
    expect(quietReason(calm)).toBeNull();
    expect(quietReason({ ...calm, inCall: true })).toBe("on a call");
    expect(quietReason({ ...calm, typing: true })).toBe("typing");
    expect(quietReason({ ...calm, fullscreen: true })).toBe("full screen");
    expect(quietReason({ ...calm, section: "trading" })).toBe("trading");
    expect(quietReason({ ...calm, dnd: true })).toBe("do not disturb");
  });

  it("streaks at 3, 5, 10, 20", () => {
    expect([1, 2, 3, 4, 5, 6, 10, 15, 20].filter(isStreak)).toEqual([3, 5, 10, 20]);
  });

  it("only good-news toasts count", () => {
    expect(isDoneToast({ title: "Staged", tone: "info" })).toBe(true);
    expect(isDoneToast({ title: "Saved", tone: "error" })).toBe(false);
    expect(isDoneToast({ title: "Done", tone: "alarm" })).toBe(false);
    expect(isDoneToast({ title: "Couldn't retry", tone: "info" })).toBe(false);
  });

  it("never repeats the last line when there is a choice", () => {
    expect(pickLine(["a", "b"], "a", () => 0)).toBe("b");
    expect(pickLine([], null)).toBe("");
  });
});

describe("the characters' store", () => {
  const NOW = new Date(2026, 10, 27, 12).getTime();
  beforeEach(() => {
    vi.useFakeTimers();
    setQuietCheck(() => null);
    useCharacters.setState({ ...CHARACTER_DEFAULTS, pop: null, held: false, lastPopAt: 0, lastLine: null, done: { day: "", n: 0 }, lastHelloAt: 0 });
  });
  afterEach(() => vi.useRealTimers());

  it("hidden at rest; Gabagool is the first character", () => {
    expect(useCharacters.getState().pop).toBeNull();
    expect(activeCharacters(useCharacters.getState()).map((c) => c.id)).toEqual(["gabagool"]);
  });

  it("something done: he pops in, then ducks out on his own after a few seconds", () => {
    expect(useCharacters.getState().emit({ kind: "done" }, NOW)).toBe(true);
    expect(useCharacters.getState().pop?.id).toBe("gabagool");
    vi.advanceTimersByTime(5_001);
    expect(useCharacters.getState().pop).toBeNull();
  });

  it("his menu keeps him; closing it lets him go", () => {
    useCharacters.getState().emit({ kind: "reward" }, NOW);
    useCharacters.getState().hold(true);
    vi.advanceTimersByTime(20_000);
    expect(useCharacters.getState().pop).not.toBeNull();
    useCharacters.getState().hold(false);
    vi.advanceTimersByTime(1_300);
    expect(useCharacters.getState().pop).toBeNull();
  });

  it("inside the gap he stays away, but the thing still counts towards the streak", () => {
    useCharacters.getState().emit({ kind: "done" }, NOW);
    useCharacters.getState().leave();
    expect(useCharacters.getState().emit({ kind: "done" }, NOW + 1000)).toBe(false);
    expect(useCharacters.getState().done.n).toBe(2);
    useCharacters.setState({ lastPopAt: 0 });
    useCharacters.getState().emit({ kind: "done" }, NOW + 2000);
    expect(useCharacters.getState().pop?.text).toMatch(/3/);
  });

  it("a quiet reason, mute, Off or hide keeps him away", () => {
    setQuietCheck(() => "typing");
    expect(useCharacters.getState().emit({ kind: "reward" }, NOW)).toBe(false);
    setQuietCheck(() => null);
    useCharacters.getState().setFrequency("off");
    expect(useCharacters.getState().emit({ kind: "reward" }, NOW)).toBe(false);
    useCharacters.getState().setFrequency("normal");
    useCharacters.getState().setMuted(true);
    expect(useCharacters.getState().emit({ kind: "reward" }, NOW)).toBe(false);
    useCharacters.getState().setMuted(false);
    useCharacters.getState().setVisible(false);
    expect(useCharacters.getState().emit({ kind: "reward" }, NOW)).toBe(false);
  });

  it("the random hello comes at most once an hour", () => {
    expect(useCharacters.getState().emit({ kind: "hello" }, NOW)).toBe(true);
    useCharacters.getState().leave();
    useCharacters.setState({ lastPopAt: 0 });
    expect(useCharacters.getState().emit({ kind: "hello" }, NOW + HELLO_GAP_MS - 1)).toBe(false);
    expect(useCharacters.getState().emit({ kind: "hello" }, NOW + HELLO_GAP_MS)).toBe(true);
  });

  it("Try it pops him in whatever the frequency", () => {
    useCharacters.getState().setFrequency("off");
    useCharacters.getState().preview("gabagool", NOW);
    expect(useCharacters.getState().pop?.id).toBe("gabagool");
  });

  it("a saved file can't break it", () => {
    expect(sanitizeCharacters({ visible: "yes", frequency: "taps", chars: { gabagool: { on: false, corner: "middle" }, ghost: {} } })).toEqual({
      visible: true,
      muted: false,
      frequency: "off",
      chars: { gabagool: { on: false, corner: "br" } },
    });
  });

  it("events: a good-news toast brings him; a live voice call or setQuiet keeps him away", () => {
    const subs: ((s: { toasts: { id: string; title: string; tone: string }[] }) => void)[] = [];
    const toasts = { getState: () => ({ toasts: [] }), subscribe: (fn: (typeof subs)[number]) => (subs.push(fn), () => undefined) };
    let voice = "speaking";
    const off = installCharacterEvents({ toasts, voiceState: () => voice, section: () => "command", helloEveryMs: 1e9 });
    subs[0]({ toasts: [{ id: "1", title: "Staged", tone: "info" }] });
    expect(useCharacters.getState().pop).toBeNull();
    voice = "idle";
    setQuiet("dnd", true);
    subs[0]({ toasts: [{ id: "2", title: "Saved", tone: "info" }] });
    expect(useCharacters.getState().pop).toBeNull();
    setQuiet("dnd", false);
    subs[0]({ toasts: [{ id: "3", title: "Sent", tone: "info" }] });
    expect(useCharacters.getState().pop?.id).toBe("gabagool");
    off();
  });

  it("events: the random roll asks for a hello", () => {
    const toasts = { getState: () => ({ toasts: [] }), subscribe: () => () => undefined };
    const off = installCharacterEvents({ toasts, voiceState: () => "idle", section: () => "command", helloEveryMs: 1000, helloChance: 1, random: () => 0 });
    vi.advanceTimersByTime(1000);
    expect(useCharacters.getState().pop?.id).toBe("gabagool");
    off();
  });
});

describe("drawing", () => {
  it("the ruffled rim is a closed path", () => {
    const d = wavyCircle(32, 32, 20, 1, 12, 24);
    expect(d.startsWith("M")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
    expect(d.split("L")).toHaveLength(24);
  });
});
