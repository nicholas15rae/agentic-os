/**
 * Contract for the IBKR paper bridge, as served by the gateway at /api/trading/*.
 * Mirrors trading/ibkr_bridge.py `Bridge.state` and trading_api.offline_status().
 * Phase 1 is read-only telemetry; nothing here can place or cancel an order.
 */
import { gateway } from "@/lib/gateway";
import type { EngineRApi } from "@/features/trading/EngineRPanel.contract";

export type BridgeState = "CONNECTED" | "CONNECTING" | "RECONNECTING" | "LOCKED" | "DISCONNECTED" | "BRIDGE_OFFLINE";

export interface IbkrAccount {
  account: string;
  currency: string | null;
  netLiquidation: number | null;
  buyingPower: number | null;
  availableFunds: number | null;
  totalCash: number | null;
  grossPositionValue: number | null;
}

export interface IbkrPosition {
  symbol: string;
  underlying: string;
  secType: string;
  currency: string;
  conId: number;
  position: number | null;
  avgCost: number | null;
  marketPrice: number | null;
  marketValue: number | null;
  unrealizedPnl: number | null;
  realizedPnl: number | null;
}

export interface IbkrOrder {
  symbol: string;
  secType: string;
  orderId: number;
  permId: number;
  clientId: number;
  action: string;
  quantity: number | null;
  orderType: string;
  limitPrice: number | null;
  stopPrice: number | null;
  tif: string;
  status: string;
  filled: number | null;
  remaining: number | null;
}

/** trading/market_calendar.py market_status(): the static NYSE holiday / half-day table. */
export interface MarketStatus {
  open: boolean;
  reason: "open" | "holiday" | "weekend" | "pre_market" | "after_hours";
  label: string;
  date: string;
  holiday: string | null;
  earlyClose: boolean;
  earlyCloseReason: string | null;
  closeEt: string | null;
  nextOpen: number;
  nextOpenNy: string;
  known: boolean;
}

/** ibkr_bridge.down_alert(): down/locked for more than ~2 min during the regular session. */
export interface BridgeAlert {
  level: "critical";
  code: "bridge_down";
  since: number;
  sinceNy: string;
  minutes: number;
  reason: string;
  message: string;
}

export interface IbkrStatus {
  state: BridgeState;
  mode: "PAPER" | "LIVE" | string;
  host: string | null;
  port: number | null;
  clientId: number | null;
  readOnly: boolean;
  reasons: string[];
  lastError: string | null;
  connectedSince: number | null;
  /** First moment off CONNECTED (null while connected). */
  downSince?: number | null;
  /** Why it isn't connected, with the TWS API settings it needs. */
  downReason?: string | null;
  market?: MarketStatus | null;
  alert?: BridgeAlert | null;
  updatedAt: number;
  account: IbkrAccount | null;
  pnl: { daily: number | null; unrealized: number | null; realized: number | null };
  positions: IbkrPosition[];
  openOrders: IbkrOrder[];
}

export type ExecMode = "ADVISORY" | "SEMI_AUTO" | "FULL_AUTO";
export type Verdict = "APPROVED" | "MODIFIED" | "REJECTED";

export interface SecurityCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface Decision {
  verdict: Verdict;
  intentId: string;
  quantity: number;
  requestedQuantity: number;
  checks: SecurityCheck[];
  reasons: string[];
  tripKill: boolean;
  entryRef: number | null;
  riskBase: number | null;
  notionalBase: number | null;
}

/** Mirrors trading/intents.py OrderIntent.to_dict(). */
export interface OrderIntent {
  intent_id: string;
  source: "trading_agent" | "engine_a" | "engine_b" | "rule_engine" | "manual";
  asset_class: string;
  symbol: string;
  action: "BUY" | "SELL";
  quantity: number;
  order_type: "MKT" | "LMT";
  stop_loss: number;
  limit_price: number | null;
  take_profit: number | null;
  time_in_force: string;
  thesis: string;
  citations: string[];
  currency: string;
  created_at: number;
  sec_type?: "STK" | "OPT" | "BAG";
  legs?: { action: string; right: string; strike: number; expiry: string }[];
  multiplier?: number;
}

export type IntentStatus = "hypothetical" | "pending_approval" | "submitting" | "submitted" | "rejected" | "failed" | "expired" | "dismissed";

/** trading/failures.py: why a rejected / failed intent didn't trade. */
export type FailureCode = "rejected_by_ibkr" | "no_quote" | "market_closed" | "bridge_down" | "risk_limit" | "kill_switch" | "schema" | "policy" | "other";

export interface IntentFailure {
  code: FailureCode | string;
  label: string;
  detail: string;
}

export interface DeskIntent {
  intentId: string;
  status: IntentStatus;
  intent: OrderIntent;
  decision: Decision;
  result: unknown;
  created: number;
  updated: number;
  /** Set on rejected / failed rows (derived server-side for rows stored before it existed). */
  failure?: IntentFailure | null;
}

const FAILURE_LABELS: Record<FailureCode, string> = {
  rejected_by_ibkr: "Rejected by IBKR",
  no_quote: "No quote",
  market_closed: "Market closed",
  bridge_down: "Bridge down",
  risk_limit: "Risk limit",
  kill_switch: "Kill switch",
  schema: "Invalid intent",
  policy: "Refused by policy",
  other: "Failed",
};

/** "Rejected by IBKR: TWS rejected the order: ..." for a rejected / failed row; null otherwise.
 *  Old rows without `failure` fall back to their stored error text or first failing check. */
/** A failed order whose cancel couldn't be sent (the executor's "could NOT be sent, so it may still be working"):
 *  it may still be working at TWS, so it must never be shown as "not sent". */
export function mayStillBeWorking(text: string | null | undefined): boolean {
  return /may still be working/i.test(text ?? "");
}

/** The SEMI_AUTO approve toast's title: an order whose cancel couldn't be sent may still be working, not "not sent". */
export function approveToastTitle(r: { ok?: boolean; status?: string; error?: string; failure?: { label?: string; detail?: string } | null }): string {
  if (r.ok) return "Order sent to paper";
  if (mayStillBeWorking(r.error) || mayStillBeWorking(r.failure?.detail)) return "Order may still be working at TWS";
  return `Not sent: ${r.failure?.label ?? r.status ?? "error"}`;
}

export function failureText(r: Pick<DeskIntent, "status" | "failure" | "result" | "decision">): string | null {
  if (r.status !== "rejected" && r.status !== "failed") return null;
  const f = r.failure;
  if (f && (f.label || f.code)) {
    const label = f.label || FAILURE_LABELS[f.code as FailureCode] || f.code;
    return f.detail ? `${label}: ${f.detail}` : label;
  }
  const res = r.result as { error?: unknown } | null | undefined;
  if (res && typeof res === "object" && typeof res.error === "string" && res.error) return `${r.status === "failed" ? "Failed" : "Rejected"}: ${res.error}`;
  const why = r.decision?.reasons?.[0];
  if (why) return `Rejected: ${why}`;
  return r.status === "failed" ? "Failed: no reason recorded" : "Rejected: no reason recorded";
}

export interface KillLock {
  locked: true;
  at: number;
  reason: string;
  actor: string;
  incidentId: string;
}

export interface AuditRow {
  id: number;
  ts: number;
  kind: string;
  ref: string;
  verdict: string;
  actor: string;
  payload: Record<string, unknown>;
}

export interface DeskView {
  mode: ExecMode;
  agentHalted: boolean;
  posture: "normal" | "defensive" | "halt";
  financer: { allocation_base?: number; max_daily_loss_pct?: number };
  lock: KillLock | null;
  limits: Record<string, number | boolean | null> | null;
  limitsError: string | null;
  pending: DeskIntent[];
  recent: DeskIntent[];
  audit: { ok: boolean; note: string; tail: AuditRow[] };
}

export interface KillIncident {
  incidentId: string;
  dryRun: boolean;
  ok: boolean;
  steps: { step: string; ok: boolean; detail: string }[];
  cancelled: unknown[];
  flatten: { symbol: string; action: string; qty: number; status?: string }[];
  errors: string[];
  failsafe?: boolean;
  /** Desk.kill: a live kill was already running, so this press sent nothing (never flatten twice at once); the rest is
   *  that kill's incident, its `ok` included. */
  alreadyRunning?: boolean;
}

export interface ScanRow {
  symbol: string;
  signal: boolean;
  why: string;
  close?: number;
  momentum20?: number;
  relVolume?: number;
  atr?: number;
  date?: string;
  intent?: OrderIntent | null;
  desk?: { status?: string; verdict?: Verdict; reasons: string[]; error?: string };
}

export interface WatchRow {
  symbol: string;
  source: string;
  reason: string;
  addedAt: number;
  status: "active" | "rejected";
  problems: string[];
  advValueUsd: number | null;
  spreadPct: number | null;
}

export interface OptionsProposal {
  symbol: string;
  structure: "single" | "vertical";
  view: "bullish" | "bearish" | null;
  viewWhy: string;
  expiry?: string;
  dte?: number;
  underlying?: number;
  scanned?: number;
  notes?: string[];
  intent?: (OrderIntent & { legs: { action: string; right: string; strike: number; expiry: string }[] }) | null;
  desk?: ScanRow["desk"];
  result: string;
  at: number;
}

export interface EnginesView {
  watchlist: string[];
  watchlistRows: WatchRow[];
  lastScan: { at: number; rows: ScanRow[] } | null;
  lastOptions: OptionsProposal | null;
  optionLimits: Record<string, number | string> | null;
  optionLimitsError: string | null;
  autoScanMinutes: number;
  guard: { at?: number; flattened?: number; stopped?: number; errors?: string[] };
}

export const enginesApi = {
  view: () => gateway<EnginesView>("/api/trading/engines", { timeoutMs: 8_000 }),
  scan: (submit: boolean, symbols?: string[]) => gateway<{ ok: boolean; error?: string; at: number; rows: ScanRow[] }>("/api/trading/engines/a/scan", { method: "POST", body: JSON.stringify({ submit, symbols }), timeoutMs: 125_000 }),
  addWatch: (symbol: string, reason: string) => gateway<WatchRow>("/api/trading/engines/a/watchlist", { method: "POST", body: JSON.stringify({ symbol, reason, source: "user" }), timeoutMs: 40_000 }),
  removeWatch: (symbol: string) => gateway<{ ok: boolean }>(`/api/trading/engines/a/watchlist/${encodeURIComponent(symbol)}/remove`, { method: "POST", body: "{}" }),
  setAuto: (minutes: number) => gateway<EnginesView>("/api/trading/engines/a/auto", { method: "POST", body: JSON.stringify({ minutes }) }),
  propose: (symbol: string, view: string, structure: string, submit: boolean) =>
    gateway<OptionsProposal & { ok: boolean; error?: string }>("/api/trading/engines/b/propose", { method: "POST", body: JSON.stringify({ symbol, view, structure, submit }), timeoutMs: 125_000 }),
  guard: () => gateway<{ flatten: unknown[]; stops: unknown[]; errors: string[]; skipped?: string }>("/api/trading/engines/b/guard", { method: "POST", body: "{}", timeoutMs: 60_000 }),
};

export interface LeaderRow {
  id: string;
  name: string;
  calls: number;
  hits: number;
  hitRate: number;
  shrunkHitRate: number;
  avgRet: number;
  medianRet: number;
  horizon: number;
}

export interface JournalRecord {
  intentId: string;
  symbol: string;
  secType: string;
  source: string;
  action: string;
  units: number;
  currency: string;
  entryPrice: number;
  exitPrice: number;
  slippage: number | null;
  pnl: number;
  rMultiple: number | null;
  holdHours: number;
  exitReason: string;
  outcome: "win" | "loss" | "flat";
  postMortem: string;
  closedAt: number;
  hypothesisCitations: string[];
}

export interface IntelView {
  discord: {
    messages: number;
    calls: number;
    from: number | null;
    to: number | null;
    scoredCalls: number;
    sources: { channelId: string; guild: string; channel: string; messages: number; lastPoll: number | null }[];
    live: { token: boolean; channels: string[]; pollSeconds: number };
    liveStatus: { at?: number; skipped?: string; channels?: { channelId: string; channel?: string; kept?: number; error?: string }[] };
    inbox: string;
  };
  lastScoring: { calls: number; scored: number; rows: number; at: string; errors: string[] } | null;
  leaderboards: { horizon: number; authors: LeaderRow[]; channels: LeaderRow[] };
  journal: { trades: number; pnl: number; wins: number; recent: JournalRecord[] };
  rag: { active: number; archived: number; byClass: Record<string, number> };
}

export interface DiscordHit {
  key: string;
  ts: number;
  channel: string;
  author: string;
  content: string;
  tickers: string[];
  direction: string | null;
}

export const intelApi = {
  view: () => gateway<IntelView>("/api/trading/intel", { timeoutMs: 10_000 }),
  search: (q: string, ticker?: string) =>
    gateway<{ results: DiscordHit[] }>(`/api/trading/intel/discord/search?q=${encodeURIComponent(q)}${ticker ? `&ticker=${encodeURIComponent(ticker)}` : ""}&limit=25`, { timeoutMs: 10_000 }),
  leaderboards: (horizon: number) => gateway<IntelView["leaderboards"]>(`/api/trading/intel/leaderboards?horizon=${horizon}`),
  importInbox: () => gateway<{ files: { file: string; kept?: number; calls?: number; dup?: number; error?: string }[]; channelsFilter: string[] | null }>("/api/trading/intel/discord/import", { method: "POST", body: "{}", timeoutMs: 300_000 }),
  poll: () => gateway<IntelView["discord"]["liveStatus"]>("/api/trading/intel/discord/poll", { method: "POST", body: "{}", timeoutMs: 60_000 }),
  score: () => gateway<NonNullable<IntelView["lastScoring"]>>("/api/trading/intel/outcomes/score", { method: "POST", body: "{}", timeoutMs: 300_000 }),
};

export type HealthStatus = "PASS" | "WARN" | "FAIL" | "SKIP";

export interface HealthCheckRow {
  stage: string;
  name: string;
  status: HealthStatus;
  detail: string;
  ms: number;
  /** The connection row comes from the live bridge state, not the stored run. */
  live?: boolean;
}

export interface HealthResult {
  at: number;
  atNy: string;
  overall: HealthStatus | null;
  counts?: Record<HealthStatus, number>;
  checks: HealthCheckRow[];
  /** "HH:MM" New York of the stored run (set when the bridge overlays the live connection row). */
  asOfNy?: string;
  /** The connection changed since the run: its other rows are as of then. */
  stale?: boolean;
  staleReason?: string;
}

export const healthApi = {
  last: () => gateway<HealthResult>("/api/trading/health/last", { timeoutMs: 8_000 }),
  run: (dryRunKill = true) => gateway<HealthResult>("/api/trading/health/check", { method: "POST", body: JSON.stringify({ dryRunKill }), timeoutMs: 240_000 }),
};

/** GET /api/trading/bars — IBKR historical bars for the "IBKR bars" chart (trading/bars.py shapes them). */
export interface IbkrBars {
  ok: boolean;
  error?: string;
  symbol: string;
  currency?: string;
  interval: string;
  range: string;
  barSize?: string;
  duration?: string;
  /** Same shape as the Yahoo companion chart: epoch seconds + OHLCV, oldest first. */
  candles: { t: number; o: number; h: number; l: number; c: number; v: number }[];
  fetchedAt?: number;
  cached?: boolean;
}

export const barsUrl = (symbol: string, interval: string, range: string) =>
  `/api/trading/bars?${new URLSearchParams({ symbol: symbol.trim().toUpperCase(), interval, range })}`;

/** How often the IBKR chart re-requests: IBKR paces identical historical requests (≥15 s apart, ≤60 / 10 min). */
export const barsRefreshMs = (interval: string) => (interval === "1d" ? 300_000 : interval === "1m" ? 20_000 : 30_000);

const post = <T>(path: string, body: unknown = {}, timeoutMs = 20_000) => gateway<T>(path, { method: "POST", body: JSON.stringify(body), timeoutMs });

export const tradingApi = {
  status: () => gateway<IbkrStatus>("/api/trading/status", { timeoutMs: 6_000 }),
  desk: () => gateway<DeskView>("/api/trading/desk", { timeoutMs: 8_000 }),
  setMode: (mode: ExecMode, confirm: boolean) => post<{ ok: boolean }>("/api/trading/mode", { mode, confirm }),
  approve: (id: string) => post<{ ok: boolean; status?: string; error?: string; decision?: Decision; failure?: IntentFailure | null }>(`/api/trading/intents/${encodeURIComponent(id)}/approve`, {}, 35_000),
  reject: (id: string) => post<{ ok: boolean }>(`/api/trading/intents/${encodeURIComponent(id)}/reject`),
  kill: (reason: string, dryRun = false) => post<KillIncident & { lock?: KillLock; note?: string }>("/api/trading/kill-switch", { reason, dryRun }, 50_000),
  reset: (confirm: string) => post<{ locked: boolean }>("/api/trading/kill-switch/reset", { confirm }),
  bars: (symbol: string, interval: string, range: string) => gateway<IbkrBars>(barsUrl(symbol, interval, range), { timeoutMs: 70_000 }),
};

/**
 * Engine R (deterministic rules) — implements the locked EngineRApi contract. Every POST is under
 * /api/trading/engines/r/*, so the security layer's PIN step-up applies; gateway() handles the 423.
 * Nothing here can place an order: the only scan the UI can start is a dry run (submit: false).
 */
const rulePath = (id: string, verb: "approve" | "reject") => `/api/trading/engines/r/changes/${encodeURIComponent(id)}/${verb}`;

export const engineRApi: EngineRApi = {
  view: () => gateway("/api/trading/rules", { timeoutMs: 10_000 }),
  evaluation: () => gateway("/api/trading/rules/evaluation", { timeoutMs: 10_000 }),
  log: (limit: number) => gateway(`/api/trading/rules/log?limit=${Math.max(1, Math.min(Math.round(limit), 500))}`, { timeoutMs: 10_000 }),
  approve: (changeId: string, confirm: string, note: string) => post(rulePath(changeId, "approve"), { confirm, note }),
  reject: (changeId: string, note: string) => post(rulePath(changeId, "reject"), { note }),
  enable: (enabled: boolean) => post("/api/trading/engines/r/enable", { enabled }),
  dryScan: () => post("/api/trading/engines/r/scan", { submit: false }, 125_000),
  evaluate: () => post("/api/trading/engines/r/evaluate", { refresh: true }, 610_000),
};

/** What the HUD badge shows. A stale snapshot (bridge hung) is not "Connected". */
export type HudLevel = "connected" | "reconnecting" | "locked" | "disconnected";

export const STALE_AFTER_S = 15;

export function hudLevel(s: IbkrStatus | null, nowS: number = Date.now() / 1000): { level: HudLevel; label: string } {
  if (!s) return { level: "disconnected", label: "Disconnected" };
  if (s.state === "LOCKED") return { level: "locked", label: "Locked" };
  if (s.state === "BRIDGE_OFFLINE") return { level: "disconnected", label: "Bridge offline" };
  if (s.state === "DISCONNECTED") return { level: "disconnected", label: "Disconnected" };
  if (s.state === "CONNECTING" || s.state === "RECONNECTING") return { level: "reconnecting", label: s.state === "CONNECTING" ? "Connecting" : "Reconnecting" };
  if (nowS - s.updatedAt > STALE_AFTER_S) return { level: "reconnecting", label: "Stale" };
  return { level: "connected", label: "Connected" };
}

/** Chip tone for the market line: open, a half day (early close today), or closed. */
export function marketTone(m: MarketStatus): "open" | "early" | "closed" {
  if (m.earlyClose && (m.open || m.reason === "pre_market")) return "early";
  return m.open ? "open" : "closed";
}

export function money(v: number | null | undefined, currency?: string | null): string {
  if (v == null) return "—";
  const s = Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${v < 0 ? "−" : ""}${s}${currency ? ` ${currency}` : ""}`;
}

export const pnlTone = (v: number | null | undefined) => (v == null || v === 0 ? "ink" : v > 0 ? "teal" : "alert") as "ink" | "teal" | "alert";
