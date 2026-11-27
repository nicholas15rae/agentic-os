// EngineRPanel.contract.ts — LOCKED 2026-11-25 (approved by Nic). Changes need a new approval.
// Mount: Trading section, directly below TradingDesk (above EnginesPanel). Gateway HTTP only (no Tauri IPC) → desktop and phone.
// Backend: trading/rule_engine.py RuleEngine.view() / log(), rules.py RuleStore, backtest.py, analyst.py Analyst.view(),
// proxied by trading_api.py (/api/trading/rules*, /api/trading/engines/r/*). Contract doc: trading/TRADING_AGENT.md.
import type { AuditRow, ExecMode, OrderIntent } from "@/features/trading/ibkr";

export interface EngineRPanelProps {} // self-contained; polls its own data

// ── wire types (mirror the Python dicts exactly) ─────────────────────────────

/** rules.PARAM_SCHEMA: the only knobs that exist. */
export interface RuleParams {
  sma_fast: number;
  sma_slow: number;
  breakout_lookback: number;
  min_rel_volume: number;
  atr_period: number;
  stop_atr_mult: number;
  target_atr_mult: number;
  max_atr_pct: number;
  risk_per_trade_pct: number;
  disabled_symbols: string[];
}
export type RuleParamName = keyof RuleParams;

/** rules.diff_params(): only the changed knobs. */
export type RuleDiff = { [K in RuleParamName]?: { from: RuleParams[K]; to: RuleParams[K] } };

export interface ParamSpec {
  type: "int" | "float" | "symbols";
  min: number | null;
  max: number | null;
  default: number | string[];
  help: string;
}
export type ParamSchema = { [K in RuleParamName]: ParamSpec };

export interface RuleVersion {
  version: number;
  params: RuleParams;
  created: number; // epoch s
  changeId: string | null;
  approvedBy: string;
  reason: string;
}
export interface ActiveRule extends RuleVersion {
  rule: "trend_breakout";
}

/** rules.HardLimits (data/trading/rules/limits.json). Read-only in this panel. */
export interface HardLimits {
  max_daily_loss_base: number;
  on_daily_loss: "stop_entries" | "kill_switch";
  max_position_shares: number;
  max_position_notional_base: number;
  max_trades_per_day: number;
  max_open_positions: number;
  scan_time_et: string; // "15:45"
  universe: string[];
}

/** backtest.metrics(): one set (build or test). */
export interface SetMetrics {
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null; // 0..1
  avgWinR: number | null;
  avgLossR: number | null; // negative
  avgWinPct: number | null;
  avgLossPct: number | null;
  expectancyR: number | null;
  totalR: number;
  maxDrawdownR: number;
  maxDrawdownPct: number;
  from: string | null; // ISO date
  to: string | null;
  note: string | null; // "only N trade(s): too few to judge"
}

/** backtest.evaluate() minus the trade lists. */
export interface SplitReport {
  cutoff: string | null;
  range: { from: string | null; to: string | null };
  symbols: string[];
  openAtEnd: number;
  build: SetMetrics;
  test: SetMetrics;
}

export type CompareLabel = "improves_out_of_sample" | "worse_out_of_sample" | "mixed";

/** backtest.compare(): current vs proposed on the active rule's cutoff. */
export interface ChangeEvaluation {
  cutoff: string | null;
  range: { from: string | null; to: string | null };
  current: SplitReport;
  proposed: SplitReport;
  verdict: { label: CompareLabel; notes: string[] };
}
/** RuleEngine.propose() stores this instead when no daily bars are cached yet. */
export interface ChangeEvaluationError {
  error: string;
}

export type ChangeStatus = "pending" | "approved" | "rejected" | "stale";

/** rules._change_row(). */
export interface RuleChange {
  changeId: string;
  created: number;
  source: "analyst" | "manual";
  actor: string;
  status: ChangeStatus;
  baseVersion: number;
  diff: RuleDiff;
  rationale: { text: string; untrusted: boolean }; // untrusted = model text: rendered as plain text, labelled
  evaluation: ChangeEvaluation | ChangeEvaluationError | null;
  decided: number | null;
  decidedBy: string | null;
  note: string | null;
  newVersion: number | null;
}

export type ScanAction = "skip" | "no_signal" | "limit_block" | "would_submit" | "submitted";

export interface RuleScanRow {
  symbol: string;
  action: ScanAction;
  why?: string;
  bars?: "fresh" | "cache" | "none";
  signal?: boolean;
  close?: number | null;
  relVolume?: number | null;
  atrPct?: number | null;
  momentum?: number | null;
  date?: string | null;
  sizing?: string;
  quoteError?: string;
  intent?: OrderIntent; // dry run: what WOULD be submitted (display only)
  desk?: { status?: string; verdict?: string; reasons: string[]; error?: string | null };
}

export interface RuleScan {
  scanId: string;
  kind: "slot" | "manual";
  at: number;
  version: number | null;
  submit: boolean;
  rows: RuleScanRow[];
  status: "done" | "dry_run" | "blocked";
  detail: string;
  finished: number;
}

/** RuleEngine.evaluate(): the 70/30 report for the active version. */
export interface EvaluationReport {
  at: number;
  version: number;
  rule: "trend_breakout";
  params: RuleParams;
  backtest: SplitReport;
  paper: { cutoff: string | null; build: SetMetrics; test: SetMetrics }; // Engine R's closed paper trades, same split
  method: string;
}
/** GET /rules/evaluation before the first evaluation. */
export interface NoEvaluation {
  at: null;
  note: string;
}

export interface AnalystRun {
  runId: string;
  day: string;
  started: number;
  finished: number | null;
  status: "done" | "skipped" | "error";
  detail: string;
  review: { summary: string; observations: string[]; untrusted: boolean } | null;
  suggestions: { raw: { patch: Partial<RuleParams>; rationale: string }[]; errors: string[] } | null;
  results: { changeId: string; diff: RuleDiff; verdict: ChangeEvaluation["verdict"] | null }[] | null;
  modelS: number | null;
  waitedS: number | null;
}

export interface AnalystView {
  enabled: boolean;
  blocked: string | null;
  window: string;
  runs: AnalystRun[];
}

/** GET /api/trading/rules (polled every 15 s). */
export interface RulesView {
  enabled: boolean;
  blocked: string | null; // why the 15:45 slot would not run right now
  active: ActiveRule;
  limits: HardLimits | null;
  limitsError: string | null; // invalid limits.json: Engine R is blocked
  entriesToday: number;
  schema: ParamSchema;
  pending: RuleChange[];
  recentChanges: RuleChange[];
  versions: RuleVersion[];
  lastScan: RuleScan | null;
  evaluation: EvaluationReport | null;
  analyst: AnalystView | null;
}

/** RuleEngine.log() kinds. Rows are the desk's AuditRow. */
export type RuleLogKind =
  | "rule_trade" | "rule_limit_block" | "rule_scan" | "rule_change_proposed" | "rule_change_approved" | "rule_change_rejected"
  | "ruleset_activated" | "rule_limits_changed" | "rule_engine_enabled" | "rule_evaluation" | "analyst_run" | "llm_trade_refused"
  | "trade_closed" | "order_submitted" | "kill_switch";

// ── API (implemented as `engineRApi` in ibkr.ts) ─────────────────────────────

export const APPROVE_PHRASE = "APPROVE";

export interface EngineRApi {
  view(): Promise<RulesView>; //                                     GET  /api/trading/rules
  evaluation(): Promise<EvaluationReport | NoEvaluation>; //         GET  /api/trading/rules/evaluation (polled every 60 s)
  log(limit: number): Promise<{ rows: AuditRow[] }>; //               GET  /api/trading/rules/log?limit= (polled 30 s, only while the log is open)
  approve(changeId: string, confirm: string, note: string): Promise<{ ok: true; change: RuleChange; active: ActiveRule }>; // POST /engines/r/changes/<id>/approve {confirm, note}
  reject(changeId: string, note: string): Promise<{ ok: true; change: RuleChange }>; //  POST /engines/r/changes/<id>/reject {note}
  enable(enabled: boolean): Promise<{ enabled: boolean }>; //         POST /engines/r/enable {enabled}
  dryScan(): Promise<RuleScan>; //                                    POST /engines/r/scan {submit: false}: no parameter can make it submit
  evaluate(): Promise<EvaluationReport>; //                           POST /engines/r/evaluate {refresh: true} (IBKR history; up to 10 min)
}
// Every POST is under /api/trading/engines/* → the security layer's PIN step-up. gateway() already handles the
// 423 STEP_UP_REQUIRED exactly as for the desk's mode switch: PIN modal + one retry on desktop; on a device that
// can't step up it throws GatewayError(423, "trading is read-only on this device"). The panel shows that as a toast.

// ── panel state ──────────────────────────────────────────────────────────────

export type EngineRBusy =
  | null
  | { action: "toggle" | "scan" | "evaluate" }
  | { action: "approve" | "reject"; changeId: string };

export interface EngineRPanelState {
  status: "loading" | "ready" | "error"; // error = gateway / bridge unreachable, or the bridge predates Engine R (503)
  busy: EngineRBusy;
  confirm: null | "enable"; // turning Engine R ON while the desk is FULL_AUTO (or its mode is unknown)
  deciding: null | { changeId: string; phrase: string; note: string }; // one pending change open at a time
  logOpen: boolean;
}

// ── pure rules (unit-tested) ─────────────────────────────────────────────────

/** Approve is enabled only for the exact typed phrase; that typed text is what is sent as `confirm`. */
export function canApprove(phrase: string): boolean {
  return phrase === APPROVE_PHRASE;
}

/** Turning ON asks first when the desk is FULL_AUTO (the 15:45 scan then sends to paper) or the mode is unknown. OFF never asks. */
export function needsEnableConfirm(turnOn: boolean, mode: ExecMode | null): boolean {
  return turnOn && (mode === null || mode === "FULL_AUTO");
}

export function isChangeEvaluation(e: RuleChange["evaluation"]): e is ChangeEvaluation {
  return !!e && "verdict" in e;
}

export function isEvaluationReport(e: EvaluationReport | NoEvaluation | null): e is EvaluationReport {
  return !!e && e.at !== null;
}
