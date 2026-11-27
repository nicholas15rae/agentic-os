import { ACTIVATION_DB_MAX, ACTIVATION_DB_MIN, dbfs, isSpeechFrame } from "./vad-gate";

/**
 * One scale for the input meter AND the threshold slider (Phase 2 Part B), so "your voice
 * clears the gate" on screen means exactly what the gate decides. Linear in dBFS.
 */
export const DB_MIN = ACTIVATION_DB_MIN;
export const DB_MAX = ACTIVATION_DB_MAX;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** dBFS → 0–100 % across the track (clamped). */
export function dbToPct(db: number): number {
  if (!Number.isFinite(db)) return db > 0 ? 100 : 0;
  return clamp(((db - DB_MIN) / (DB_MAX - DB_MIN)) * 100, 0, 100);
}

/** 0–100 % → dBFS (clamped). */
export function pctToDb(pct: number): number {
  return DB_MIN + (clamp(pct, 0, 100) / 100) * (DB_MAX - DB_MIN);
}

export const rmsToDbfs = dbfs;

/** The level reaches the gate (the same `>=` the gate itself uses). */
export function clearsGate(levelDb: number, thrDb: number): boolean {
  return levelDb >= thrDb;
}

/**
 * What the live capture's gate decides for its latest frame: its own threshold (`thrDb`, which
 * includes the barge-in margin over Tony) and, when Silero is deciding, its probability. The
 * meter's ✓ uses this, so it never disagrees with the gate.
 */
export function meterClearsGate(m: { levelDb: number; thrDb: number; prob: number | null }): boolean {
  return isSpeechFrame(m.levelDb, m.prob, m.thrDb);
}
