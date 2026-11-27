/**
 * What Finance should remind you about: cheques to deposit, pending money, unpaid / overdue
 * invoices, commissions owed to agents, and HST returns coming due (areas with a confirmed HST
 * number). `financeReminders(data, now)` is pure, so other code (Tony, later) can call it.
 */
import type { HstPeriod } from "@/features/business/profiles";
import { areaOf } from "./areas";
import { owedByAgent } from "./commission";
import { nextHstDue } from "./tax";
import { invoiceTotals, type Check, type Commission, type Invoice, type Pending, type Receipt } from "./types";

export interface FinanceReminder {
  id: string;
  kind: "cheque" | "pending" | "invoice" | "commission" | "hst" | "review";
  title: string;
  /** Epoch ms when it's due (or became due), if it has a date. */
  dueAt?: number;
  amount?: number;
  area?: string;
  overdue: boolean;
  /** The Finance tab that handles it. */
  tab: "cheques" | "pending" | "invoices" | "commissions" | "taxes" | "receipts";
}

export interface ReminderData {
  checks?: readonly (Check & { id: string })[];
  pending?: readonly (Pending & { id: string })[];
  invoices?: readonly (Invoice & { id: string })[];
  commissions?: readonly (Commission & { id: string })[];
  receipts?: readonly (Receipt & { id: string })[];
  /** Areas that file HST: id → reporting period (only areas with a confirmed HST number). */
  hstAreas?: Readonly<Record<string, HstPeriod>>;
  /** Display names for areas (defaults to the id). */
  areaLabel?: (id: string) => string;
  /** Show an HST return this many days ahead (default 30). */
  hstLeadDays?: number;
}

const DAY = 86_400_000;
const at = (iso: string) => Date.parse(iso + "T09:00:00");
const r2 = (n: number) => Math.round(n * 100) / 100;

export function financeReminders(d: ReminderData, now = Date.now()): FinanceReminder[] {
  const label = d.areaLabel ?? ((x: string) => x);
  const out: FinanceReminder[] = [];

  const undeposited = (d.checks ?? []).filter((c) => !c.deposited);
  if (undeposited.length)
    out.push({ id: "cheques", kind: "cheque", title: `Deposit ${undeposited.length} cheque${undeposited.length > 1 ? "s" : ""}`, amount: r2(undeposited.reduce((s, c) => s + c.amount, 0)), dueAt: Math.min(...undeposited.map((c) => c.receivedAt)), overdue: undeposited.some((c) => now - c.receivedAt > 7 * DAY), tab: "cheques" });

  for (const p of d.pending ?? []) {
    if (p.paid) continue;
    const due = at(p.date);
    out.push({ id: `pending:${p.id}`, kind: "pending", title: `${p.who || "Someone"} owes you${p.what ? ` for ${p.what}` : ""}${p.phone ? ` · ${p.phone}` : ""}`, amount: p.amount, dueAt: due, area: areaOf(p), overdue: due < now, tab: "pending" });
  }

  for (const inv of d.invoices ?? []) {
    if (inv.status !== "sent" && inv.status !== "overdue") continue;
    const overdue = inv.dueAt < now;
    out.push({ id: `invoice:${inv.id}`, kind: "invoice", title: `${overdue ? "Follow up on" : "Waiting on"} ${inv.number} · ${inv.client}`, amount: invoiceTotals(inv).total, dueAt: inv.dueAt, area: areaOf(inv), overdue, tab: "invoices" });
  }

  for (const a of owedByAgent(d.commissions ?? [])) {
    if (a.owed <= 0) continue;
    const oldest = Math.min(...(d.commissions ?? []).filter((c) => !c.paid && c.agentId === a.agentId).map((c) => at(c.date)));
    out.push({ id: `commission:${a.agentId}`, kind: "commission", title: `Pay ${a.agentName} commission (${a.unpaidCount} booking${a.unpaidCount > 1 ? "s" : ""})`, amount: a.owed, dueAt: oldest, area: "acting", overdue: now - oldest > 30 * DAY, tab: "commissions" });
  }

  const lead = (d.hstLeadDays ?? 30) * DAY;
  for (const [area, period] of Object.entries(d.hstAreas ?? {})) {
    const due = nextHstDue(period, now);
    if (!due) continue;
    const dueAt = at(due.paymentDue && due.paymentDue >= new Date(now).toISOString().slice(0, 10) ? due.paymentDue : due.due);
    if (dueAt - now > lead) continue;
    out.push({ id: `hst:${area}:${due.period}`, kind: "hst", title: `${label(area)} HST return for ${due.period} due ${due.due}${due.paymentDue ? ` (payment by ${due.paymentDue})` : ""}`, dueAt, area, overdue: false, tab: "taxes" });
  }

  const flagged = (d.receipts ?? []).filter((r) => (r.flags?.length ?? 0) > 0 && !r.question);
  if (flagged.length) out.push({ id: "review", kind: "review", title: `Review ${flagged.length} flagged receipt${flagged.length > 1 ? "s" : ""}`, overdue: false, tab: "receipts" });

  return out.sort((a, b) => Number(b.overdue) - Number(a.overdue) || (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity));
}
