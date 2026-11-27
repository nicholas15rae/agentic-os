/**
 * Section 14.6 / 14.7 (display only): Engine R's paper track record vs. its backtest, and Discord /
 * desk rankings that need a real sample. Mirrors trading/track_record.py and outcomes.leaderboard().
 * GET only: nothing here can change a mode, a limit or an order.
 */
import { gateway } from "@/lib/gateway";
import type { LeaderRow } from "@/features/trading/ibkr";

// ── 14.7 rankings ──────────────────────────────────────────────────────────
/** outcomes.MIN_SCORED: scored calls before a source is ranked. Used when an older bridge sends no `ranked`. */
export const MIN_SCORED = 30;

export interface BoardSplit {
  ranked: LeaderRow[];
  notEnough: LeaderRow[];
  minScored: number;
}

/** Wilson 95% interval (same formula as outcomes.wilson), for rows from a bridge that predates the band. */
export function wilson(hits: number, n: number, z = 1.96): [number, number] {
  if (n <= 0) return [0, 1];
  const p = hits / n;
  const den = 1 + (z * z) / n;
  const mid = (p + (z * z) / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return [Math.max(0, mid - half), Math.min(1, mid + half)];
}

const band = (r: LeaderRow): [number, number] => (r.wilsonLow != null && r.wilsonHigh != null ? [r.wilsonLow, r.wilsonHigh] : wilson(r.hits, r.calls));

/** Ranked rows (>= minScored calls) by the Wilson lower bound; the rest, by sample size, as "not enough calls yet". */
export function splitBoard(rows: LeaderRow[] | null | undefined): BoardSplit {
  const list = rows ?? [];
  const minScored = list.find((r) => r.minScored != null)?.minScored ?? MIN_SCORED;
  const isRanked = (r: LeaderRow) => r.ranked ?? r.calls >= minScored;
  const ranked = list.filter(isRanked).sort((a, b) => band(b)[0] - band(a)[0] || b.shrunkHitRate - a.shrunkHitRate || b.avgRet - a.avgRet);
  const notEnough = list.filter((r) => !isRanked(r)).sort((a, b) => b.calls - a.calls || b.shrunkHitRate - a.shrunkHitRate);
  return { ranked, notEnough, minScored };
}

const pct0 = (v: number) => `${(v * 100).toFixed(0)}%`;

/** "40–89%": the 95% Wilson band shown on every row. */
export function bandText(r: LeaderRow): string {
  const [lo, hi] = band(r);
  return `${pct0(lo)}–${pct0(hi)}`;
}

/** The adjusted hit rate the ranking sorts by (Wilson lower bound). */
export const adjustedHit = (r: LeaderRow): number => band(r)[0];

// ── 14.6 track record ──────────────────────────────────────────────────────
export interface TrackSet {
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  expectancyR: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
  totalR: number | null;
  stdR: number | null;
  maxDrawdownR: number | null;
  pctEquity: number | null; // totalR x risk per trade (% of equity, additive)
  from: string | null;
  to: string | null;
  note?: string | null;
}

export interface SpyBaseline {
  from: string;
  to: string;
  buyDate?: string;
  sellDate?: string;
  retPct: number | null;
  partial?: boolean;
  why?: string;
}

export type DriftStatus = "too_few" | "no_test" | "within" | "above" | "below";

export interface TrackRecord {
  at: number;
  evaluationAt: number | null;
  version: number | null;
  cutoff: string | null;
  riskPerTradePct: number | null;
  paper: TrackSet;
  build: TrackSet | null;
  test: TrackSet | null;
  spy: { paper: SpyBaseline | null; build: SpyBaseline | null; test: SpyBaseline | null };
  drift: {
    status: DriftStatus;
    message: string;
    paperTrades: number;
    paperExpectancyR: number | null;
    minPaper: number;
    interval: { low: number; high: number; mean: number; n: number; stdR: number; approx: boolean } | null;
  };
  /** Information only: not wired to any desk mode or gate. */
  goal: { target: number; trades: number; expectancyR: number | null; positive: boolean; met: boolean; informationOnly: true; text: string };
  notes: string[];
  readOnly: true;
}

/** Guards the panel against an older gateway (404 body / partial JSON). */
export function isTrackRecord(d: unknown): d is TrackRecord {
  const t = d as Partial<TrackRecord> | null | undefined;
  return !!t && typeof t === "object" && !!t.paper && !!t.drift && !!t.goal && !!t.spy && typeof t.drift.message === "string";
}

export const trackRecordApi = {
  get: () => gateway<TrackRecord>("/api/trading/track-record", { timeoutMs: 20_000 }),
};

export const DRIFT_TONE: Record<DriftStatus, string> = {
  too_few: "text-ink-3",
  no_test: "text-ink-3",
  within: "text-teal-soft",
  above: "text-amber-light",
  below: "text-alert",
};

export function rText(v: number | null | undefined): string {
  if (v == null) return "—";
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(2)}R`;
}

export function pctText(v: number | null | undefined, signed = false): string {
  if (v == null) return "—";
  return `${signed && v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(signed ? 2 : 0)}%`;
}

export function spyText(s: SpyBaseline | null | undefined): string {
  if (!s) return "—";
  if (s.retPct == null) return "n/a";
  return `${pctText(s.retPct, true)}${s.partial ? "*" : ""}`;
}

export type TrackRowKey = "trades" | "winRate" | "expectancyR" | "avgWinR" | "avgLossR" | "maxDrawdownR" | "pctEquity";

export const TRACK_ROWS: { key: TrackRowKey; label: string }[] = [
  { key: "trades", label: "Trades" },
  { key: "winRate", label: "Win rate" },
  { key: "expectancyR", label: "Expectancy" },
  { key: "avgWinR", label: "Avg win" },
  { key: "avgLossR", label: "Avg loss" },
  { key: "maxDrawdownR", label: "Max drawdown" },
  { key: "pctEquity", label: "Total (% equity)" },
];

export function trackCell(key: TrackRowKey, s: TrackSet | null | undefined): string {
  if (!s) return "—";
  const v = s[key];
  if (v == null) return "—";
  if (key === "trades") return String(v);
  if (key === "winRate") return pctText(v * 100);
  if (key === "maxDrawdownR") return `${v.toFixed(2)}R`;
  if (key === "pctEquity") return pctText(v, true);
  return rText(v);
}
