/**
 * Acting commissions: the % an agent takes from a booking, what you owe them, and the running
 * total per agent. Pure (the default % comes from the Acting profile's agencies).
 */
import type { Agency } from "@/features/business/profiles";
import type { Commission, Income } from "./types";

export const COMMISSION_PICKS = [15, 20, 0] as const;

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Commission and what you keep, from the gross (pre-HST) fee. Off = 0 commission. */
export function commissionCalc(gross: number, pct: number | null | undefined, off = false): { commission: number; net: number; pct: number } {
  const g = Number.isFinite(gross) ? gross : 0;
  const p = off || pct == null || !Number.isFinite(pct) ? 0 : Math.min(100, Math.max(0, pct));
  const commission = r2((g * p) / 100);
  return { commission, net: r2(g - commission), pct: p };
}

/** The agency's display name (sub-agents show "ML Talent (Imperious Inc.)"). */
export function agencyName(agencies: readonly Agency[] | undefined, id: string | undefined): string {
  if (!id) return "";
  const a = (agencies ?? []).find((x) => x.id === id);
  if (!a) return id;
  const parent = a.parentId ? (agencies ?? []).find((x) => x.id === a.parentId) : undefined;
  return parent ? `${a.name} (${parent.name})` : a.name;
}

/**
 * The commission record a paid acting booking creates, or null (no agent, or 0 %).
 * `deducted` = the agent already kept it from the payment (recorded as paid).
 */
export function commissionFor(income: Income & { id?: string }, agencies: readonly Agency[] | undefined, opts: { deducted?: boolean; now?: number } = {}): Commission | null {
  if (!income.agentId) return null;
  const { commission, pct } = commissionCalc(income.amount, income.commissionPct, income.commissionOff);
  if (commission <= 0) return null;
  return {
    area: income.area ?? "acting",
    agentId: income.agentId,
    agentName: agencyName(agencies, income.agentId),
    incomeId: income.id,
    date: income.date,
    client: income.client,
    gross: income.amount,
    pct,
    amount: commission,
    union: income.union,
    paid: !!opts.deducted,
    ...(opts.deducted ? { paidAt: opts.now ?? Date.now(), paidMethod: "deducted" } : {}),
  };
}

export interface AgentOwed {
  agentId: string;
  agentName: string;
  owed: number;
  paid: number;
  unpaidCount: number;
}

/** Running totals per agent: still owed, and paid so far. Sorted by most owed. */
export function owedByAgent(rows: readonly Commission[]): AgentOwed[] {
  const m = new Map<string, AgentOwed>();
  for (const c of rows) {
    const cur = m.get(c.agentId) ?? { agentId: c.agentId, agentName: c.agentName || c.agentId, owed: 0, paid: 0, unpaidCount: 0 };
    if (c.paid) cur.paid = r2(cur.paid + c.amount);
    else {
      cur.owed = r2(cur.owed + c.amount);
      cur.unpaidCount++;
    }
    m.set(c.agentId, cur);
  }
  return [...m.values()].sort((a, b) => b.owed - a.owed || a.agentName.localeCompare(b.agentName));
}
