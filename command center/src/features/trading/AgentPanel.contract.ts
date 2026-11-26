// AgentPanel.contract.ts — LOCKED 2026-11-24 (approved by Nic). Changes need a new approval.
// Amended 2026-11-24 (approved): AgentView.config (TradingAgentConfig) for the System Map status card.
// Amended 2026-11-25 (approved by Nic): retired as a trader. The bridge answers /agent/run and /agent/enable with 410
// (Engine R executes; the model is an after-hours analyst, see EngineRPanel.contract.ts). AgentView.retired added;
// AgentApi.run / enable, AgentPanelState.busy / confirm and needsConfirm removed. The card is read-only history.
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

/** The agent's active configuration (served by the backend, never hard-coded in the UI). */
export interface TradingAgentConfig {
  model: string; // "qwen/qwen3.5-9b" (local)
  schedule: string; // "09:15 ET pre-market + hourly 10:00–15:00 ET + up to 3 event runs/day"
  universe: string[]; // watchlist (ETFs + commodity ETFs)
  deskMode: ExecMode;
  advisoryStart: number | null; // epoch s; start of the 1-week ADVISORY rollout
  advisoryEnd: number | null; // advisoryStart + 7 days
  isolation: { peer: "finance"; broker: "127.0.0.1:7497"; localhostOnly: boolean | null }; // from the last health check
}

/** GET /api/trading/agent (polled every 15 s). */
export interface AgentView {
  retired?: string; // agent.RETIRED: why it no longer trades (absent on a bridge that predates Engine R)
  enabled: boolean;
  blocked: string | null;
  nextSlot: string | null;
  eventsToday: number;
  eventMax: number;
  runs: AgentRun[];
  leaderboard: DeskLeaderRow[];
  callCounts: Partial<Record<DeskLeaderRow["id"], number>>;
  config: TradingAgentConfig;
}

export interface AgentPanelState {
  status: "loading" | "ready" | "error"; // error = gateway / bridge unreachable
  expandedRunId: string | null; // one run open at a time
}

/** Read-only: the trading routes (run / enable) are retired (410). */
export interface AgentApi {
  view(): Promise<AgentView>;
}
