import { beforeEach, describe, expect, it } from "vitest";
import { GAP_MS, bubbleSpot, candidates, isDoneToast, isStreak, mayPop, overlap, pickLine, placeCharacter } from "./logic";
import { CHARACTER_DEFAULTS, activeCharacters, sanitizeCharacters, useCharacters } from "./character-store";
import { installCharacterEvents } from "./events";
import { wavyCircle } from "./drawings";

const VW = 1280;
const VH = 800;
const S = 64;

describe("UI fixes 2: where a character sits", () => {
  it("its own corner when nothing is there", () => {
    const at = placeCharacter("br", VW, VH, S, []);
    expect(at).toMatchObject({ corner: "br", x: VW - S - 16, y: VH - S - 16 });
  });

  it("never on a safety control: it moves up, then to another corner", () => {
    // A kill switch sitting in the bottom-right corner.
    const killSwitch = { x: VW - 120, y: VH - 120, w: 110, h: 110 };
    const at = placeCharacter("br", VW, VH, S, [killSwitch]);
    expect(overlap(at, { x: killSwitch.x - 8, y: killSwitch.y - 8, w: killSwitch.w + 16, h: killSwitch.h + 16 })).toBe(0);
    expect(at.corner).toBe("br");
    // The whole right edge blocked (a tall panel): another corner.
    const wall = { x: VW - 100, y: 0, w: 100, h: VH };
    expect(placeCharacter("br", VW, VH, S, [wall]).corner).toBe("bl");
  });

  it("every corner blocked: the spot with the least overlap", () => {
    const everything = { x: 0, y: 0, w: VW, h: VH };
    expect(candidates("br", VW, VH, S)).toHaveLength(12);
    expect(placeCharacter("br", VW, VH, S, [everything])).toBeTruthy();
  });

  it("the bubble never covers an obstacle and stays on screen (else no bubble)", () => {
    const at = placeCharacter("br", VW, VH, S, []);
    const b = bubbleSpot(at, [], VW, VH)!;
    expect(b.x + b.w).toBeLessThanOrEqual(at.x);
    const blocker = { ...b };
    const b2 = bubbleSpot(at, [blocker], VW, VH)!;
    expect(overlap(b2, blocker)).toBe(0);
    expect(bubbleSpot(at, [{ x: 0, y: 0, w: VW, h: VH }], VW, VH)).toBeNull();
  });
});

describe("UI fixes 2: how often", () => {
  it("a tap always works; events wait for the gap, never while muted, never on taps-only", () => {
    expect(mayPop(0, 0, "taps", true, "tap")).toBe(true);
    expect(mayPop(GAP_MS.normal - 1, 0, "normal", false, "event")).toBe(false);
    expect(mayPop(GAP_MS.normal, 0, "normal", false, "event")).toBe(true);
    expect(mayPop(1e12, 0, "normal", true, "event")).toBe(false);
    expect(mayPop(1e12, 0, "taps", false, "event")).toBe(false);
  });

  it("streaks at 3, 5, 10, 20", () => {
    expect([1, 2, 3, 4, 5, 6, 10, 15, 20].filter(isStreak)).toEqual([3, 5, 10, 20]);
  });

  it("only good-news toasts count; errors, warnings and alarms never pop a character", () => {
    expect(isDoneToast({ title: "Staged", tone: "info" })).toBe(true);
    expect(isDoneToast({ title: "Saved to Finance", tone: "info" })).toBe(true);
    expect(isDoneToast({ title: "Saved", tone: "error" })).toBe(false);
    expect(isDoneToast({ title: "Done", tone: "alarm" })).toBe(false);
    expect(isDoneToast({ title: "Couldn't retry", tone: "info" })).toBe(false);
  });

  it("never repeats the last line when there is a choice", () => {
    expect(pickLine(["a", "b"], "a", () => 0)).toBe("b");
    expect(pickLine(["a"], "a", () => 0)).toBe("a");
    expect(pickLine([], null)).toBe("");
  });
});

describe("UI fixes 2: the characters' store", () => {
  beforeEach(() => useCharacters.setState({ ...CHARACTER_DEFAULTS, pop: null, lastPopAt: 0, lastLine: null, done: { day: "", n: 0 }, helloDay: "" }));
  const NOW = new Date(2026, 10, 27, 12).getTime();

  it("Gabagool is the first character, on by default", () => {
    expect(activeCharacters(useCharacters.getState()).map((c) => c.id)).toEqual(["gabagool"]);
  });

  it("something done pops it up; a second one inside the gap does not", () => {
    expect(useCharacters.getState().emit({ kind: "done" }, NOW)).toBe(true);
    expect(useCharacters.getState().pop).toMatchObject({ id: "gabagool", kind: "pop" });
    expect(useCharacters.getState().emit({ kind: "done" }, NOW + 1000)).toBe(false);
    expect(useCharacters.getState().done.n).toBe(2); // still counted towards the streak
  });

  it("the third thing done today is a streak line", () => {
    const s = useCharacters.getState();
    s.emit({ kind: "done" }, NOW);
    s.emit({ kind: "done" }, NOW + 1);
    useCharacters.setState({ lastPopAt: 0 });
    useCharacters.getState().emit({ kind: "done" }, NOW + GAP_MS.normal + 2);
    expect(useCharacters.getState().pop?.text).toMatch(/3/);
  });

  it("muted or hidden: no pop-ups; a tap still reacts while muted, and a second tap tucks it", () => {
    useCharacters.getState().setMuted(true);
    expect(useCharacters.getState().emit({ kind: "done" }, NOW)).toBe(false);
    useCharacters.getState().tap("gabagool", NOW);
    expect(useCharacters.getState().pop).toMatchObject({ kind: "react" });
    useCharacters.getState().tap("gabagool", NOW + 10);
    expect(useCharacters.getState().pop).toBeNull();
    useCharacters.getState().setMuted(false);
    useCharacters.getState().setVisible(false);
    expect(useCharacters.getState().emit({ kind: "done" }, NOW)).toBe(false);
  });

  it("hello once a day", () => {
    expect(useCharacters.getState().emit({ kind: "hello" }, NOW)).toBe(true);
    useCharacters.setState({ lastPopAt: 0 });
    expect(useCharacters.getState().emit({ kind: "hello" }, NOW + 1)).toBe(false);
  });

  it("a saved file can't break it", () => {
    expect(sanitizeCharacters({ visible: "yes", frequency: "always", chars: { gabagool: { on: false, corner: "middle" }, ghost: {} } })).toEqual({
      visible: true,
      muted: false,
      frequency: "normal",
      chars: { gabagool: { on: false, corner: "br" } },
    });
  });

  it("a good-news toast reaches the character", () => {
    const subs: ((s: { toasts: { id: string; title: string; tone: string }[] }) => void)[] = [];
    const toasts = { getState: () => ({ toasts: [] }), subscribe: (fn: (typeof subs)[number]) => (subs.push(fn), () => undefined) };
    const off = installCharacterEvents(toasts, 1e9);
    subs[0]({ toasts: [{ id: "1", title: "Staged", tone: "info" }] });
    expect(useCharacters.getState().pop?.id).toBe("gabagool");
    off();
  });
});

describe("UI fixes 2: drawing", () => {
  it("the ruffled rim is a closed path", () => {
    const d = wavyCircle(32, 32, 20, 1, 12, 24);
    expect(d.startsWith("M")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
    expect(d.split("L")).toHaveLength(24);
  });
});
