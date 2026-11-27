import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DB_MAX, DB_MIN, clearsGate, dbToPct, meterClearsGate, pctToDb, rmsToDbfs } from "./meter-scale";
import { isSpeechFrame } from "./vad-gate";

/** Phase 2 Part B: the meter and the threshold slider share one dBFS scale. */
describe("meter scale", () => {
  it("dbToPct is monotonic, clamped, and pctToDb inverts it", () => {
    expect(dbToPct(DB_MIN)).toBe(0);
    expect(dbToPct(DB_MAX)).toBe(100);
    expect(dbToPct(-200)).toBe(0);
    expect(dbToPct(5)).toBe(100);
    let prev = -1;
    for (let db = DB_MIN; db <= DB_MAX; db += 0.5) {
      const p = dbToPct(db);
      expect(p).toBeGreaterThan(prev);
      prev = p;
      expect(pctToDb(dbToPct(db))).toBeCloseTo(db, 9);
    }
    expect(pctToDb(-5)).toBe(DB_MIN);
    expect(pctToDb(500)).toBe(DB_MAX);
  });

  it("clearsGate matches the gate's own speech test (level ≥ threshold)", () => {
    expect(clearsGate(-44, -44)).toBe(true);
    expect(clearsGate(-44.01, -44)).toBe(false);
    for (const [lvl, thr] of [[-30, -44], [-50, -44], [-44, -44], [-10, -11]]) expect(clearsGate(lvl, thr)).toBe(isSpeechFrame(lvl, null, thr));
    expect(rmsToDbfs(0.1)).toBeCloseTo(-20);
  });

  it("meterClearsGate follows the live capture's gate: barge-in margin and Silero (fix pass)", () => {
    // A barge-in listen over Tony gates at -38 (gate -44 + 6): -40 dB must not show ✓.
    expect(meterClearsGate({ levelDb: -40, thrDb: -38, prob: null })).toBe(false);
    expect(meterClearsGate({ levelDb: -37, thrDb: -38, prob: null })).toBe(true);
    // Silero deciding: loud enough but not speech → no ✓.
    expect(meterClearsGate({ levelDb: -30, thrDb: -44, prob: 0.2 })).toBe(false);
    expect(meterClearsGate({ levelDb: -30, thrDb: -44, prob: 0.8 })).toBe(true);
    const src = readFileSync(fileURLToPath(new URL("./ThresholdMeter.tsx", import.meta.url)), "utf8");
    expect(src).toMatch(/meterClearsGate\(m\)/);
  });

  it("the old per-file log-scale bar() helpers are gone (one scale everywhere)", () => {
    for (const rel of ["../../sections/settings/VadSettings.tsx", "./ListenControls.tsx"]) {
      const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
      expect(src).not.toMatch(/const bar\s*=/);
      expect(src).not.toMatch(/vadMeter/);
    }
  });
});
