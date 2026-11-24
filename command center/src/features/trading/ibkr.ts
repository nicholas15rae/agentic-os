/**
 * Contract for the IBKR paper bridge, as served by the gateway at /api/trading/*.
 * Mirrors trading/ibkr_bridge.py `Bridge.state` and trading_api.offline_status().
 * Phase 1 is read-only telemetry; nothing here can place or cancel an order.
 */
import { gateway } from "@/lib/gateway";

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
  source: "trading_agent" | "engine_a" | "engine_b" | "manual";
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

export interface DeskIntent {
  intentId: string;
  status: IntentStatus;
  intent: OrderIntent;
  decision: Decision;
  result: unknown;
  created: number;
  updated: number;
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

const post = <T>(path: string, body: unknown = {}, timeoutMs = 20_000) => gateway<T>(path, { method: "POST", body: JSON.stringify(body), timeoutMs });

export const tradingApi = {
  status: () => gateway<IbkrStatus>("/api/trading/status", { timeoutMs: 6_000 }),
  desk: () => gateway<DeskView>("/api/trading/desk", { timeoutMs: 8_000 }),
  setMode: (mode: ExecMode, confirm: boolean) => post<{ ok: boolean }>("/api/trading/mode", { mode, confirm }),
  approve: (id: string) => post<{ ok: boolean; status?: string; error?: string; decision?: Decision }>(`/api/trading/intents/${encodeURIComponent(id)}/approve`, {}, 35_000),
  reject: (id: string) => post<{ ok: boolean }>(`/api/trading/intents/${encodeURIComponent(id)}/reject`),
  kill: (reason: string, dryRun = false) => post<KillIncident & { lock?: KillLock; note?: string }>("/api/trading/kill-switch", { reason, dryRun }, 50_000),
  reset: (confirm: string) => post<{ locked: boolean }>("/api/trading/kill-switch/reset", { confirm }),
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

export function money(v: number | null | undefined, currency?: string | null): string {
  if (v == null) return "—";
  const s = Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${v < 0 ? "−" : ""}${s}${currency ? ` ${currency}` : ""}`;
}

export const pnlTone = (v: number | null | undefined) => (v == null || v === 0 ? "ink" : v > 0 ? "teal" : "alert") as "ink" | "teal" | "alert";
