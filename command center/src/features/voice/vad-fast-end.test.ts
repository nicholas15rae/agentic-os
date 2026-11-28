import { describe, expect, it } from "vitest";
import { FAST_END_MIN_MS, Gate, fastEndFor } from "./vad-gate";

const FRAME = 20;
const THR = -44;
const SPEECH = { db: -30, p: 0.9 };
const SILENT = { db: -70, p: 0.02 };
const BREATH = { db: -60, p: 0.25 }; // quiet to the gate, but Silero hears something

/** Runs frames through a gate; returns the ms of pause at which it ended (null = still open). */
function pauseUntilEnd(g: Gate, pause: { db: number; p: number | null }[]): number | null {
  for (let i = 0; i < 10; i++) g.push(SPEECH.db, SPEECH.p, THR);
  for (let i = 0; i < pause.length; i++) if (g.push(pause[i].db, pause[i].p, THR) === "end") return (i + 1) * FRAME;
  return null;
}
const frames = (f: { db: number; p: number | null }, ms: number) => Array.from({ length: ms / FRAME }, () => f);

describe("fastEndFor", () => {
  it("off unless switched on; clamped between 300 ms and the usual wait", () => {
    expect(fastEndFor(false, 500, 700)).toBeNull();
    expect(fastEndFor(true, 500, 700)).toBe(500);
    expect(fastEndFor(true, undefined, 700)).toBe(500);
    expect(fastEndFor(true, 100, 700)).toBe(FAST_END_MIN_MS);
    expect(fastEndFor(true, 900, 700)).toBe(700);
    expect(fastEndFor(true, 500, Infinity)).toBeNull(); // continuous dictation never ends on silence
  });
});

describe("Gate with the shorter, Silero-checked wait", () => {
  it("a clean silent pause ends at 500 ms instead of 700", () => {
    const g = new Gate(FRAME, 700, 15000, 500);
    expect(pauseUntilEnd(g, frames(SILENT, 1000))).toBe(500);
    expect(g.endedFast).toBe(true);
  });

  it("without the switch it still waits 700 ms", () => {
    const g = new Gate(FRAME, 700, 15000, null);
    expect(pauseUntilEnd(g, frames(SILENT, 1000))).toBe(700);
    expect(g.endedFast).toBe(false);
  });

  it("a breath or 'mmm' in the pause keeps the full wait (no cut mid-thought)", () => {
    const g = new Gate(FRAME, 700, 15000, 500);
    const pause = [...frames(SILENT, 200), ...frames(BREATH, 60), ...frames(SILENT, 800)];
    expect(pauseUntilEnd(g, pause)).toBe(700);
    expect(g.endedFast).toBe(false);
  });

  it("without Silero deciding (energy only) it keeps the full wait", () => {
    const g = new Gate(FRAME, 700, 15000, 500);
    expect(pauseUntilEnd(g, frames({ db: -70, p: null }, 1000))).toBe(700);
  });

  it("a 400 ms pause between words never ends the turn, and the next pause is judged on its own", () => {
    const g = new Gate(FRAME, 700, 15000, 500);
    for (let i = 0; i < 10; i++) g.push(SPEECH.db, SPEECH.p, THR);
    for (const f of [...frames(BREATH, 100), ...frames(SILENT, 300)]) expect(g.push(f.db, f.p, THR)).toBeNull();
    for (let i = 0; i < 10; i++) expect(g.push(SPEECH.db, SPEECH.p, THR)).toBeNull();
    let ended = 0;
    for (const f of frames(SILENT, 1000)) {
      ended += FRAME;
      if (g.push(f.db, f.p, THR) === "end") break;
    }
    expect(ended).toBe(500); // the earlier soft pause doesn't carry over
  });
});
