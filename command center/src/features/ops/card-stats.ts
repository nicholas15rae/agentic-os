/**
 * The key numbers on an Operations business card, computed from the gateway collections. Pure.
 *
 * Today only some data is per business by nature: `pipeline` (auditions, self-tapes, bookings) is
 * Acting's, `projects` (estimates, bids, jobs) is Contracting's. Finance rows (income, invoices,
 * cheques) and reminders carry no business tag yet: a row counts for a business only when it has
 * `area` (or `businessId`) set to that business id. Where nothing is tagged the number is `null`
 * and the card shows "—" with the hint.
 */
import type { Check, Income, Invoice } from "@/features/finance/types";
import { invoiceTotals } from "@/features/finance/types";
import type { Reminder } from "@/features/reminders/types";

/** The subset of a pipeline item this needs (widgets/pipeline/Pipeline.tsx). */
export interface PipelineLike {
  title: string;
  status: "received" | "prepping" | "submitted" | "callback" | "booked" | "passed";
  dueAt?: number;
}

/** The subset of a contracting project this needs (widgets/contracting/Contracting.tsx). */
export interface ProjectLike {
  client: string;
  job: string;
  status: "lead" | "estimating" | "bid-sent" | "won" | "in-progress" | "invoiced" | "paid" | "lost";
  followUpAt?: number;
}

/** A future Finance / reminders tag. */
interface Tagged {
  area?: string;
  businessId?: string;
}

export interface CardInputs {
  income: (Income & Tagged)[];
  invoices: (Invoice & Tagged)[];
  checks: (Check & Tagged)[];
  pipeline: PipelineLike[];
  projects: ProjectLike[];
  reminders: (Reminder & Tagged)[];
}

export interface CardNumber {
  /** null = not known per business yet (show "—"). */
  value: number | null;
  /** Why it's "—", or what it counts. */
  hint: string;
}

export interface CardDeadline {
  at: number | null;
  what: string;
  hint: string;
}

export interface CardStats {
  incomeThisMonth: CardNumber;
  pendingPayments: CardNumber;
  openJobs: CardNumber;
  unreadMessages: CardNumber;
  nextDeadline: CardDeadline;
}

const NOT_TAGGED = "Finance entries aren't tagged per business yet";
const tagOf = (r: Tagged) => r.area ?? r.businessId;

/** Rows tagged for `id`, or null when nothing in the collection is tagged at all. */
function tagged<T extends Tagged>(rows: readonly T[], id: string): T[] | null {
  if (!rows.some((r) => tagOf(r))) return null;
  return rows.filter((r) => tagOf(r) === id);
}

const monthKey = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

export function businessCardStats(businessId: string, c: CardInputs, now: number): CardStats {
  // Income this month (amount before tax).
  const inc = tagged(c.income, businessId);
  const month = monthKey(now);
  const incomeThisMonth: CardNumber = inc
    ? { value: inc.filter((i) => (i.date ?? "").slice(0, 7) === month).reduce((s, i) => s + (Number(i.amount) || 0), 0), hint: "Income booked this month, before tax" }
    : { value: null, hint: NOT_TAGGED };

  // Pending payments: invoices sent / overdue + cheques not deposited yet.
  const inv = tagged(c.invoices, businessId);
  const chq = tagged(c.checks, businessId);
  const pendingPayments: CardNumber =
    inv || chq
      ? {
          value: (inv ?? []).filter((i) => i.status === "sent" || i.status === "overdue").reduce((s, i) => s + invoiceTotals(i).total, 0) + (chq ?? []).filter((k) => !k.deposited).reduce((s, k) => s + (Number(k.amount) || 0), 0),
          hint: "Unpaid invoices and undeposited cheques",
        }
      : { value: null, hint: NOT_TAGGED };

  // Open jobs / bookings, and their own deadlines.
  const deadlines: { at: number; what: string }[] = [];
  let openJobs: CardNumber;
  if (businessId === "acting") {
    const open = c.pipeline.filter((p) => p.status !== "passed" && !(p.status === "booked" && (p.dueAt ?? Infinity) < now - 86_400_000));
    openJobs = { value: open.length, hint: "Open auditions, self-tapes, callbacks and bookings" };
    for (const p of open) if (p.dueAt && p.dueAt >= now) deadlines.push({ at: p.dueAt, what: p.title });
  } else if (businessId === "trades_contracting") {
    const open = c.projects.filter((p) => !["paid", "lost"].includes(p.status));
    openJobs = { value: open.length, hint: "Leads, bids and jobs not paid or lost" };
    for (const p of open) if (p.followUpAt && p.followUpAt >= now) deadlines.push({ at: p.followUpAt, what: `${p.client} · ${p.job}`.replace(/^ · | · $/g, "") });
  } else {
    openJobs = { value: null, hint: "No jobs / orders list for this business yet" };
  }

  // Reminders tagged for this business (none are, today) and invoice due dates of its own invoices.
  for (const r of c.reminders) if (tagOf(r) === businessId && !r.dismissed && r.dueAt >= now) deadlines.push({ at: r.dueAt, what: r.title });
  for (const i of inv ?? []) if (i.status === "sent" && i.dueAt >= now) deadlines.push({ at: i.dueAt, what: `Invoice ${i.number} due` });
  deadlines.sort((a, b) => a.at - b.at);
  const hasSource = businessId === "acting" || businessId === "trades_contracting" || !!inv || c.reminders.some((r) => tagOf(r));
  const nextDeadline: CardDeadline = deadlines[0]
    ? { at: deadlines[0].at, what: deadlines[0].what, hint: "The soonest due date or follow-up" }
    : { at: null, what: "", hint: hasSource ? "Nothing due" : "Reminders aren't tagged per business yet" };

  return {
    incomeThisMonth,
    pendingPayments,
    openJobs,
    unreadMessages: { value: null, hint: "Messages aren't sorted per business yet" },
    nextDeadline,
  };
}
