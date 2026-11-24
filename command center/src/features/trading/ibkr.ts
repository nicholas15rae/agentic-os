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

export const tradingApi = {
  status: () => gateway<IbkrStatus>("/api/trading/status", { timeoutMs: 6_000 }),
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
