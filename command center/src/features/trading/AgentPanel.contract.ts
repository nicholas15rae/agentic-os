// AgentPanel.contract.ts — LOCKED 2026-11-24 (approved by Nic). Changes need a new approval.
// Mount: Trading section, below EnginesPanel. Gateway HTTP only (no Tauri IPC) → desktop and phone.
import type { ExecMode } from "@/features/trading/ibkr";

export interface AgentPanelProps {} // self-contained; polls its own data

export type AgentRunStatus = "running" | "done" | "dry_run" | "blocked" | "skipped" | "no_json";
export type AgentRunKind = "slot" | "event" | "manual";
export type DecisionAction = "propose" | "watch" | "skip" | "rejected_scope" | "rejected_citations" | "rejected_schema" | "rejected_cap";

export interface AgentDecision {
  symbol: string;
  action: DecisionAction;
  confidence: number | null;
  thesis: string;
  citations: string[];
}

export interface AgentResult {
  intentId: string;
  symbol: string;
  status: "hypothetical" | "pending_approval" | "submitted" | "rejected" | "failed" | "dry_run";
  verdict: "APPROVED" | "MODIFIED" | "REJECTED" | null;
  reasons: string[];
  quantity?: number;
  error?: string | null;
}

export interface AgentRun {
  runId: string;
  kind: AgentRunKind;
  started: number;
  finished: number | null;
  status: AgentRunStatus;
  detail: string;
  context: { approxTokens: number; hypotheses: number; trimmedHypotheses: number; lessons: number } | null;
  output: { marketView?: string; notes?: string; watchlistAdd?: { symbol: string; reason: string }[]; raw?: string } | null;
  decisions: AgentDecision[] | null;
  results: AgentResult[] | null;
  modelS: number | null;
  waitedS: number | null;
}

export interface DeskLeaderRow {
  id: "trading_agent" | "engine_a" | "baseline_spy";
  name: string;
  calls: number;
  hitRate: number;
  shrunkHitRate: number;
  avgRet: number;
}

/** GET /api/trading/agent (polled every 15 s). */
export interface AgentView {
  enabled: boolean;
  blocked: string | null;
  nextSlot: string | null;
  eventsToday: number;
  eventMax: number;
  runs: AgentRun[];
  leaderboard: DeskLeaderRow[];
  callCounts: Partial<Record<DeskLeaderRow["id"], number>>;
}

export interface AgentPanelState {
  status: "loading" | "ready" | "error"; // error = gateway / bridge unreachable
  busy: null | "dry" | "run" | "toggle";
  expandedRunId: string | null; // one run open at a time
  confirm: null | "run" | "enable"; // pending confirmation
}

export interface AgentApi {
  view(): Promise<AgentView>;
  run(submit: boolean): Promise<AgentRun>; // POST /api/trading/agent/run {submit}
  enable(enabled: boolean): Promise<{ enabled: boolean }>; // POST /api/trading/agent/enable {enabled}
}

/**
 * Mutating actions and when they need a confirmation (from the approved contract):
 * - "run" (Run now): straight away in ADVISORY (hypothetical only); confirm in SEMI_AUTO / FULL_AUTO.
 * - "enable" (turning ON): confirm only in FULL_AUTO. Turning OFF never needs one.
 * - Dry run is not mutating: never confirmed.
 */
export function needsConfirm(action: "run" | "enable", mode: ExecMode | null): boolean {
  if (action === "run") return mode !== "ADVISORY";
  return mode === "FULL_AUTO";
}
