import { useMemo } from "react";
import { Filter, Lock } from "lucide-react";
import { Card, Stat, money } from "@/components/ui";
import { useCollection } from "@/lib/cc-api";
import { invoiceTotals, receiptItc, type Check, type Commission, type Goal, type Income, type Invoice, type Pending, type Receipt } from "@/features/finance/types";
import { useSettings } from "@/stores/settings";
import { ReadOnlyBanner } from "@/features/security/ReadOnlyBanner";
import { printableHst, type HstPeriod } from "@/features/business/profiles";
import { applyFilter, yearsIn } from "@/features/finance/areas";
import { useAreas, useFinanceFilter } from "@/features/finance/filter-store";
import { financeReminders, type FinanceReminder } from "@/features/finance/reminders";
import { smallSupplier } from "@/features/finance/tax";
import { LayoutSurface } from "@/core/widgets/LayoutSurface";
import { panelShown, revealPanel } from "@/core/widgets/reveal";
import { FINANCE_SURFACE, useFinanceLayout } from "./finance/panels";
import { AreaBar } from "./finance/AreaBar";

/** The old Finance tabs, now panels: a link that named a tab shows that panel instead. */
export type Tab = "overview" | "scan" | "receipts" | "expenses" | "invoices" | "income" | "cheques" | "pending" | "commissions" | "bank" | "taxes" | "goals";
export const TAB_PANEL: Record<Tab, string> = {
  overview: "fi-stats",
  scan: "fi-scan",
  income: "fi-income",
  receipts: "fi-receipts",
  expenses: "fi-expenses",
  invoices: "fi-invoices",
  cheques: "fi-cheques",
  pending: "fi-pending",
  commissions: "fi-commissions",
  bank: "fi-bank",
  taxes: "fi-taxes",
  goals: "fi-goals",
};

/** Show the panel that used to be tab `t` (switches page, opens its window, or adds it back). */
export const goTo = (t: Tab) => revealPanel(useFinanceLayout, TAB_PANEL[t], "Finance");

/**
 * Finance & bookkeeping — strictly local. No bank / Plaid / card linking exists here.
 * Shared layout system: the area filters, overview, to-do and every book (income, tax table,
 * invoices, cheques…) are panels (move, resize, hide, add back, icon, per mode, Reset). The
 * local-only note and the Read-Only / step-up banner stay above the board so they can't be hidden.
 */
export function FinanceSection() {
  const busy = useFinanceFilter((s) => s.filter.area !== "all" || s.filter.agent !== "all" || s.filter.month !== "all" || s.filter.year !== "all");
  const filtersShown = useFinanceLayout((s) => panelShown(s, "fi-filters"));
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-3 px-4 pb-2 md:px-6 xl:px-8">
        {/* A filter still applies when its panel is hidden: say so, and bring the bar back. */}
        {busy && !filtersShown && (
          <button onClick={() => revealPanel(useFinanceLayout, "fi-filters", "Finance")} className="flex items-center gap-1.5 rounded-full bg-teal/15 px-3 py-1.5 fs-11 text-teal hover:underline">
            <Filter size={12} /> Filtered · show the filters
          </button>
        )}
        <span className="ml-auto flex items-center gap-1.5 fs-11 text-ink-3">
          <Lock size={12} /> 100% local · no bank connections
        </span>
        <ReadOnlyBanner module="finance" />
      </div>
      <div className="min-h-0 flex-1">
        <LayoutSurface store={useFinanceLayout} label="Finance" />
      </div>
    </div>
  );
}

/** The area switcher and filters (agent, month, year) every Finance panel follows. */
export function FinanceFilters() {
  const income = useCollection<Income>("income").items;
  const receipts = useCollection<Receipt>("receipts").items;
  const years = useMemo(() => yearsIn([...income, ...receipts] as unknown as Record<string, unknown>[]), [income, receipts]);
  return <AreaBar years={years} />;
}

/** Everything the Overview tab counted, for the stats, to-do and savings panels. */
function useOverview() {
  const { currency } = useSettings((s) => s.business);
  const filter = useFinanceFilter((s) => s.filter);
  const { label, doc, areas } = useAreas();
  const incomeC = useCollection<Income>("income");
  const allIncome = incomeC.items;
  const income = applyFilter(allIncome, filter);
  const receipts = applyFilter(useCollection<Receipt>("receipts").items, filter);
  const invoices = applyFilter(useCollection<Invoice>("invoices").items, filter);
  const checks = applyFilter(useCollection<Check>("checks").items, filter);
  const pending = applyFilter(useCollection<Pending>("pending").items, filter);
  const commissions = applyFilter(useCollection<Commission>("commissions").items, filter);
  const { error } = incomeC;

  const year = String(new Date().getFullYear());
  const month = new Date().toISOString().slice(0, 7);
  const q = Math.floor(new Date().getMonth() / 3);
  const inQ = (iso: string) => iso.startsWith(year) && Math.floor((Number(iso.slice(5, 7)) - 1) / 3) === q;

  const incMonth = income.filter((i) => i.date.startsWith(month)).reduce((s, i) => s + i.amount, 0);
  const incYtd = income.filter((i) => i.date.startsWith(year)).reduce((s, i) => s + i.amount, 0);
  const collectedQ = income.filter((i) => inQ(i.date) && i.inReturn !== false).reduce((s, i) => s + i.taxCollected, 0);
  const itcQ = receipts.filter((r) => inQ(r.date) && r.inReturn !== false).reduce((s, r) => s + receiptItc(r), 0);
  const expensesYtd = receipts.filter((r) => r.date.startsWith(year)).reduce((s, r) => s + (r.subtotal ?? r.total ?? 0), 0);
  const outstanding = invoices.filter((i) => i.status === "sent" || i.status === "overdue").reduce((s, i) => s + invoiceTotals(i).total, 0);
  const overdue = invoices.filter((i) => (i.status === "sent" || i.status === "overdue") && i.dueAt < Date.now()).length;
  const net = collectedQ - itcQ;
  const untagged = [income, receipts, invoices, checks].reduce((s, rows) => s + rows.filter((r) => !r.area).length, 0);

  // HST filing reminders only for areas whose HST number is confirmed.
  const hstAreas: Record<string, HstPeriod> = {};
  for (const a of areas) if (a.business && doc.profiles[a.id] && printableHst(doc.profiles[a.id])) hstAreas[a.id] = doc.profiles[a.id].hstPeriod ?? "quarterly";
  const reminders = financeReminders({ checks, pending, invoices, commissions, receipts, hstAreas, areaLabel: (a) => label(a) });
  const ss = smallSupplier(allIncome);
  return { currency, error, q, incMonth, incYtd, collectedQ, itcQ, expensesYtd, outstanding, overdue, net, untagged, reminders, ss };
}

/** The Overview's four numbers (income this month / YTD, HST owing, outstanding invoices). */
export function FinanceStats() {
  const { currency, error, q, incMonth, incYtd, collectedQ, itcQ, expensesYtd, outstanding, overdue, net } = useOverview();
  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-alert">Gateway unreachable — finance data lives there: {error}</p>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Income this month" value={money(incMonth, currency)} tone="teal" />
        <Stat label="Income YTD" value={money(incYtd, currency)} sub={`Expenses ${money(expensesYtd, currency)}`} />
        <Stat label={`HST/GST owing · Q${q + 1}`} value={money(net, currency)} sub={`collected ${money(collectedQ, currency)} − ITCs ${money(itcQ, currency)}`} tone={net > 0 ? "amber" : "teal"} />
        <Stat label="Outstanding invoices" value={money(outstanding, currency)} sub={overdue ? `${overdue} overdue` : "none overdue"} tone={overdue ? "alert" : "ink"} />
      </div>
    </div>
  );
}

/** The Overview's savings-goal bars; "Manage" shows the Goals panel. */
export function SavingsSummary() {
  const { currency } = useSettings((s) => s.business);
  const goals = useCollection<Goal>("goals").items;
  return (
    <Card title="Savings goals" action={<button className="text-xs text-ink-3 hover:text-ink" onClick={() => goTo("goals")}>Manage →</button>}>
      <ul className="space-y-2.5" data-no-hold>
        {goals.map((g) => (
          <li key={g.id}>
            <div className="flex justify-between text-sm">
              <span className="text-ink">{g.name}</span>
              <span className="font-mono text-ink-2 tabular">
                {money(g.saved, currency)} / {money(g.target, currency)}
              </span>
            </div>
            <div className="well mt-1 h-1.5 overflow-hidden rounded-full">
              <div className="h-full rounded-full" style={{ width: `${g.target ? Math.min(100, (g.saved / g.target) * 100) : 0}%`, background: g.color ?? "#00E5C3" }} />
            </div>
          </li>
        ))}
        {!goals.length && <li className="text-sm text-ink-3">No goals yet.</li>}
      </ul>
    </Card>
  );
}

/** The Overview's to-do list: each item shows the panel that handles it. */
export function FinanceTodo() {
  const { currency, reminders, ss, untagged } = useOverview();
  return (
    <Card title="To do">
      <ul className="space-y-2 text-sm" data-no-hold>
        <Todo show={ss.level !== "ok"} onClick={() => goTo("taxes")} tone="alert">
          Revenue is at {ss.pct}% of the $30,000 small-supplier limit — see Taxes
        </Todo>
        {reminders.map((r) => (
          <Todo key={r.id} show onClick={() => goTo(r.tab)} tone={r.overdue ? "alert" : "amber"}>
            {r.title}
            {r.amount != null && <span className="ml-1 font-mono text-ink-2">{money(r.amount, currency)}</span>}
            {dueText(r)}
          </Todo>
        ))}
        <Todo show={untagged > 0} onClick={() => goTo("income")}>
          {untagged} record{untagged > 1 ? "s" : ""} without an area — tap “Untagged · assign” on each
        </Todo>
        <Todo show onClick={() => goTo("scan")}>
          Scan today's receipts
        </Todo>
      </ul>
      <p className="mt-3 fs-11 text-ink-3">The HST estimate is a bookkeeping aid, not tax advice — confirm with your accountant before filing.</p>
    </Card>
  );
}

const dueText = (r: FinanceReminder) => {
  if (r.dueAt == null || r.kind === "hst" || r.kind === "cheque") return null;
  const d = new Date(r.dueAt).toLocaleDateString();
  return <span className={`ml-1 fs-11 ${r.overdue ? "text-alert" : "text-ink-3"}`}>{r.overdue ? `· since ${d}` : `· by ${d}`}</span>;
};

function Todo({ show, onClick, children, tone = "amber" }: { show: boolean; onClick: () => void; children: React.ReactNode; tone?: "amber" | "alert" }) {
  if (!show) return null;
  return (
    <li>
      <button onClick={onClick} className="flex w-full items-center gap-2 r-10 border border-white/[0.06] px-3 py-2 text-left text-ink hover:border-amber/40">
        <span className={`size-1.5 shrink-0 rounded-full ${tone === "alert" ? "bg-alert" : "bg-amber"}`} /> <span className="min-w-0">{children}</span>
      </button>
    </li>
  );
}

export { FINANCE_SURFACE };
