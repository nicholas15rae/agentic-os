import { describe, expect, it } from "vitest";
import { BAND_GRACE_MS, Gate, HYSTERESIS_DB, dbfs, isBelowGateFrame, isQuietFrame, isSpeechFrame, migrateSensitivity, thresholdFor } from "./vad-gate";
import { deepMergeDefaults, migrateSettings, useSettings } from "@/stores/settings";

/** Phase 2 Part B: the deterministic activation gate. */
const FRAME_48K = (1024 / 48_000) * 1000; // ≈ 21.3 ms

describe("frame decision is a pure function of (level, prob, threshold)", () => {
  it("the same inputs give the same answer whatever came before", () => {
    const a = new Gate(FRAME_48K, 700, 15_000);
    const b = new Gate(FRAME_48K, 700, 15_000);
    // `b` has heard a long noisy history first; `a` has heard nothing.
    for (let i = 0; i < 200; i++) b.push(i % 2 ? -50 : -30, null, -20);
    for (const [lvl, prob] of [[-30, null], [-44, 0.6], [-44, 0.4], [-60, null], [-10, 0.9]] as [number, number | null][]) {
      expect(isSpeechFrame(lvl, prob, -44)).toBe(isSpeechFrame(lvl, prob, -44));
    }
    // Three loud frames open both gates on exactly the same frame.
    const ra = [-30, -30, -30].map((l) => a.push(l, null, -44));
    const rb = [-30, -30, -30].map((l) => b.push(l, null, -44));
    expect(ra).toEqual([null, null, "start"]);
    expect(rb).toEqual(ra);
  });

  it("speech = level at/over the gate AND (no model or prob ≥ 0.5)", () => {
    expect(isSpeechFrame(-44, null, -44)).toBe(true);
    expect(isSpeechFrame(-44.1, null, -44)).toBe(false);
    expect(isSpeechFrame(-20, 0.49, -44)).toBe(false); // loud non-speech (Silero says no)
    expect(isSpeechFrame(-20, 0.5, -44)).toBe(true);
  });

  it("hysteresis: quiet only below gate - 6 dB (or prob < 0.35)", () => {
    expect(HYSTERESIS_DB).toBe(6);
    expect(isQuietFrame(-50, null, -44)).toBe(false);
    expect(isQuietFrame(-50.1, null, -44)).toBe(true);
    expect(isQuietFrame(-30, 0.34, -44)).toBe(true);
    expect(isQuietFrame(-30, 0.4, -44)).toBe(false);
  });
});

describe("Gate state machine", () => {
  it("onset needs a fixed 60 ms run, computed from the frame length", () => {
    expect(new Gate(FRAME_48K, 700, 15_000).onsetFrames).toBe(3);
    expect(new Gate((1024 / 44_100) * 1000, 700, 15_000).onsetFrames).toBe(3);
    expect(new Gate(20, 700, 15_000).onsetFrames).toBe(3);
    expect(new Gate(64, 700, 15_000).onsetFrames).toBe(1);
    const g = new Gate(FRAME_48K, 700, 15_000);
    expect(g.push(-30, null, -44)).toBeNull();
    expect(g.push(-60, null, -44)).toBeNull(); // the run resets
    expect(g.push(-30, null, -44)).toBeNull();
    expect(g.push(-30, null, -44)).toBeNull();
    expect(g.push(-30, null, -44)).toBe("start");
  });

  it("ends after the pause; the in-between band (gate-6..gate) keeps the utterance alive", () => {
    const g = new Gate(20, 100, 15_000);
    for (let i = 0; i < 3; i++) g.push(-30, null, -44);
    expect(g.speaking).toBe(true);
    for (let i = 0; i < 20; i++) expect(g.push(-47, null, -44)).toBeNull(); // under the gate, above gate-6
    for (let i = 0; i < 4; i++) expect(g.push(-60, null, -44)).toBeNull();
    expect(g.push(-60, null, -44)).toBe("end"); // 5 × 20 ms = the 100 ms pause
    expect(g.speaking).toBe(false);
  });

  it("room noise steadily inside the band still ends the turn (no Silero), only later than a clear pause", () => {
    // Fix pass: gate -44, room -47 used to keep quietMs at 0 until the 15 s cap.
    const g = new Gate(20, 700, 15_000);
    for (let i = 0; i < 3; i++) g.push(-30, null, -44);
    const band = (700 + BAND_GRACE_MS) / 20;
    for (let i = 0; i < band - 1; i++) expect(g.push(-47, null, -44)).toBeNull();
    expect(g.push(-47, null, -44)).toBe("end"); // 1.7 s of sub-gate room noise, not 15 s
    // A frame back above the gate resets the band count.
    const h = new Gate(20, 700, 15_000);
    for (let i = 0; i < 3; i++) h.push(-30, null, -44);
    for (let i = 0; i < band * 3; i++) expect(h.push(i % 40 === 39 ? -40 : -47, null, -44)).toBeNull();
    // Silero calling it speech keeps it alive.
    const s = new Gate(20, 700, 15_000);
    for (let i = 0; i < 3; i++) s.push(-30, 0.9, -44);
    for (let i = 0; i < band * 2; i++) expect(s.push(-47, 0.9, -44)).toBeNull();
    expect(isBelowGateFrame(-47, null, -44)).toBe(true);
    expect(isBelowGateFrame(-44, null, -44)).toBe(false);
    expect(isBelowGateFrame(-47, 0.6, -44)).toBe(false);
  });

  it("the utterance cap ends it; Infinity never ends", () => {
    const capped = new Gate(20, 10_000, 100);
    for (let i = 0; i < 3; i++) capped.push(-30, null, -44);
    const out = Array.from({ length: 6 }, () => capped.push(-30, null, -44));
    expect(out).toContain("end");
    const open = new Gate(20, Infinity, Infinity);
    for (let i = 0; i < 3; i++) open.push(-30, null, -44);
    for (let i = 0; i < 5000; i++) expect(open.push(i % 2 ? -90 : -30, null, -44)).toBeNull();
  });
});

describe("thresholdFor / dbfs / migration", () => {
  it("barge adds exactly the margin (margin-2 on a headset); no barge = the gate", () => {
    const g = { activationDb: -44, bargeMarginDb: 6 };
    expect(thresholdFor(g)).toBe(-44);
    expect(thresholdFor({ ...g, barge: true, speakers: true })).toBe(-38);
    expect(thresholdFor({ ...g, barge: true, speakers: false })).toBe(-40);
    expect(thresholdFor({ activationDb: -44, bargeMarginDb: 1, barge: true })).toBe(-44); // never below the gate
  });

  it("dbfs", () => {
    expect(dbfs(1)).toBe(0);
    expect(dbfs(0.1)).toBeCloseTo(-20);
    expect(dbfs(0)).toBe(-100);
  });

  it("migrateSensitivity: 60 → -44, 0 → -20, 100 → -60", () => {
    expect(migrateSensitivity(60)).toBe(-44);
    expect(migrateSensitivity(0)).toBe(-20);
    expect(migrateSensitivity(100)).toBe(-60);
    expect(migrateSensitivity(Number.NaN)).toBe(-44);
  });

  it("settings v6 → v7 keeps every other field (wakeMode included) and drops sensitivity", () => {
    const v6 = {
      wakeMode: true,
      wakeRequire: false,
      vad: { sensitivity: 80, endSilenceMs: 900, maxUtteranceMs: 20_000 },
      conversation: { followUp: false, followUpSecs: 4, bargeIn: false, bargeEndSilenceMs: 500, audioRoute: "headset" },
    };
    const s = migrateSettings(structuredClone(v6), 6);
    expect(s.vad).toEqual({ activationDb: -52, bargeMarginDb: 6, endSilenceMs: 900, maxUtteranceMs: 20_000 });
    expect(s.vad).not.toHaveProperty("sensitivity");
    expect(s.wakeMode).toBe(true);
    expect(s.wakeRequire).toBe(false);
    expect(s.conversation).toEqual(v6.conversation);
    const merged = deepMergeDefaults(s, useSettings.getState());
    expect(merged.vad).not.toHaveProperty("sensitivity");
    expect(merged.vad.activationDb).toBe(-52);
    // A v6 store that never saved `vad` gets the defaults; v7 data is left alone.
    expect(deepMergeDefaults(migrateSettings({ wakeMode: false }, 6), useSettings.getState()).vad.activationDb).toBe(-44);
    expect(migrateSettings({ vad: { activationDb: -30, bargeMarginDb: 3, endSilenceMs: 700, maxUtteranceMs: 15_000 } }, 7).vad.activationDb).toBe(-30);
    expect(useSettings.getState().vad).toMatchObject({ activationDb: -44, bargeMarginDb: 6 });
  });
});
