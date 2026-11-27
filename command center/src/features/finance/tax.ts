/**
 * Tax views: income, expenses, HST collected and paid (ITCs) per area and period, a suggested
 * set-aside (an estimate, never advice), the $30,000 small-supplier threshold, HST filing dates,
 * and the accountant export. The app never decides what is deductible: records carry a
 * "question for accountant" note instead. Pure.
 */
import type { HstPeriod } from "@/features/business/profiles";
import { areaOf, UNTAGGED } from "./areas";
import type { Commission, Income, MileageTrip, Receipt } from "./types";

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export const SMALL_SUPPLIER_LIMIT = 30_000;

/** "2026-11" / "2026 Q4" / "2026" for a YYYY-MM-DD date. */
export function periodKey(iso: string, period: HstPeriod): string {
  const y = iso.slice(0, 4);
  const m = Number(iso.slice(5, 7));
  if (period === "monthly") return iso.slice(0, 7);
  if (period === "quarterly") return `${y} Q${Math.floor((m - 1) / 3) + 1}`;
  return y;
}

export interface TaxData {
  income: readonly (Income & { id?: string })[];
  receipts: readonly (Receipt & { id?: string })[];
  commissions?: readonly (Commission & { id?: string })[];
  mileage?: readonly (MileageTrip & { id?: string })[];
}

/** The pre-tax cost of a receipt (subtotal, else total less the taxes printed on it). */
export function receiptBase(r: Pick<Receipt, "subtotal" | "total" | "gst" | "hst" | "pst" | "qst">): number {
  if (r.subtotal != null) return r.subtotal;
  if (r.total == null) return 0;
  return r2(r.total - (r.gst ?? 0) - (r.hst ?? 0) - (r.pst ?? 0) - (r.qst ?? 0));
}

/** One row of the HST view: a sale (HST collected) or a purchase (HST paid = ITC). */
export interface HstLine {
  collection: "income" | "receipts";
  id: string;
  date: string;
  area: string;
  category: string;
  who: string;
  kind: "sale" | "purchase";
  base: number;
  hst: number;
  inReturn: boolean;
}

export function hstLines(d: Pick<TaxData, "income" | "receipts">): HstLine[] {
  const out: HstLine[] = [];
  for (const i of d.income)
    out.push({ collection: "income", id: i.id ?? "", date: i.date, area: areaOf(i), category: "sales", who: i.client, kind: "sale", base: i.amount, hst: i.taxCollected ?? 0, inReturn: i.inReturn !== false });
  for (const r of d.receipts)
    out.push({ collection: "receipts", id: r.id ?? "", date: r.date, area: areaOf(r), category: r.category || "other", who: r.vendor, kind: "purchase", base: receiptBase(r), hst: r2((r.gst ?? 0) + (r.hst ?? 0)), inReturn: r.inReturn !== false });
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

export interface HstTotals {
  collected: number;
  itc: number;
  /** collected − ITCs: + = you owe, − = refund. */
  net: number;
  sales: number;
  purchases: number;
  byCategory: Record<string, { hst: number; base: number; kind: "sale" | "purchase" }>;
}

/** Totals of the lines ticked "include in return" (optionally only one area and one period). */
export function hstTotals(lines: readonly HstLine[], opts: { area?: string; period?: HstPeriod; key?: string } = {}): HstTotals {
  const t: HstTotals = { collected: 0, itc: 0, net: 0, sales: 0, purchases: 0, byCategory: {} };
  for (const l of lines) {
    if (!l.inReturn) continue;
    if (opts.area && opts.area !== "all" && l.area !== opts.area) continue;
    if (opts.period && opts.key && periodKey(l.date, opts.period) !== opts.key) continue;
    if (l.kind === "sale") {
      t.collected += l.hst;
      t.sales += l.base;
    } else {
      t.itc += l.hst;
      t.purchases += l.base;
    }
    const c = (t.byCategory[l.category] ??= { hst: 0, base: 0, kind: l.kind });
    c.hst = r2(c.hst + l.hst);
    c.base = r2(c.base + l.base);
  }
  t.collected = r2(t.collected);
  t.itc = r2(t.itc);
  t.sales = r2(t.sales);
  t.purchases = r2(t.purchases);
  t.net = r2(t.collected - t.itc);
  return t;
}

/** Period keys present in the lines, newest first. */
export const periodKeys = (lines: readonly HstLine[], period: HstPeriod): string[] => [...new Set(lines.map((l) => periodKey(l.date, period)))].sort().reverse();

// ── Income / expenses / set-aside ───────────────────────────────────────────

export interface AreaSummary {
  area: string;
  income: number;
  expenses: number;
  commissions: number;
  /** km × your per-km rate (an estimate). */
  mileage: number;
  km: number;
  profit: number;
  collected: number;
  itc: number;
  netHst: number;
  setAsidePct: number;
  /** profit × set-aside % — an estimate for planning, not a tax calculation. */
  setAside: number;
  questions: number;
}

/**
 * Per-area summary for `year` ("all" = every year). `setAsidePct(area)` gives each area's %
 * (Settings → Business); commissions count once paid or owed, by their date.
 */
export function summarize(d: TaxData, opts: { year?: string; kmRate: number; setAsidePct: (area: string) => number }): AreaSummary[] {
  const inYear = (iso: string) => !opts.year || opts.year === "all" || iso.startsWith(opts.year);
  const m = new Map<string, AreaSummary>();
  const get = (area: string) => {
    let s = m.get(area);
    if (!s) m.set(area, (s = { area, income: 0, expenses: 0, commissions: 0, mileage: 0, km: 0, profit: 0, collected: 0, itc: 0, netHst: 0, setAsidePct: opts.setAsidePct(area), setAside: 0, questions: 0 }));
    return s;
  };
  for (const i of d.income.filter((x) => inYear(x.date))) {
    const s = get(areaOf(i));
    s.income += i.amount;
    if (i.inReturn !== false) s.collected += i.taxCollected ?? 0;
    if (i.question) s.questions++;
  }
  for (const r of d.receipts.filter((x) => inYear(x.date))) {
    const s = get(areaOf(r));
    s.expenses += receiptBase(r);
    if (r.inReturn !== false) s.itc += (r.gst ?? 0) + (r.hst ?? 0);
    if (r.question) s.questions++;
  }
  for (const c of (d.commissions ?? []).filter((x) => inYear(x.date))) {
    const s = get(areaOf(c));
    s.commissions += c.amount;
    if (c.question) s.questions++;
  }
  for (const t of (d.mileage ?? []).filter((x) => inYear(x.date))) {
    const s = get(areaOf(t));
    s.km += t.km;
    s.mileage += t.km * opts.kmRate;
    if (t.question) s.questions++;
  }
  return [...m.values()].map((s) => {
    const profit = r2(s.income - s.expenses - s.commissions - s.mileage);
    return {
      ...s,
      income: r2(s.income),
      expenses: r2(s.expenses),
      commissions: r2(s.commissions),
      mileage: r2(s.mileage),
      km: r2(s.km),
      profit,
      collected: r2(s.collected),
      itc: r2(s.itc),
      netHst: r2(s.collected - s.itc),
      setAside: r2(Math.max(0, profit) * (s.setAsidePct / 100)),
    };
  });
}

/** The business areas added together (Personal left out). */
export function combine(rows: readonly AreaSummary[]): AreaSummary {
  const biz = rows.filter((r) => r.area !== "personal");
  const sum = (k: keyof AreaSummary) => r2(biz.reduce((s, r) => s + (r[k] as number), 0));
  return {
    area: "all",
    income: sum("income"),
    expenses: sum("expenses"),
    commissions: sum("commissions"),
    mileage: sum("mileage"),
    km: sum("km"),
    profit: sum("profit"),
    collected: sum("collected"),
    itc: sum("itc"),
    netHst: sum("netHst"),
    setAsidePct: 0,
    setAside: sum("setAside"),
    questions: biz.reduce((s, r) => s + r.questions, 0),
  };
}

// ── Small supplier ($30,000 over the last four calendar quarters) ───────────

export interface SmallSupplier {
  quarters: { key: string; revenue: number }[];
  total: number;
  pct: number;
  level: "ok" | "near" | "over";
  /** One quarter alone went over $30,000. */
  singleQuarterOver: boolean;
}

const quarterStart = (y: number, q: number) => `${y}-${String(q * 3 + 1).padStart(2, "0")}`;

/**
 * Running revenue (before tax) for this calendar quarter and the three before it, across the
 * business areas (Personal left out; untagged counted to be safe). near = 80 %+, over = 100 %+.
 */
export function smallSupplier(income: readonly Income[], now = Date.now(), areas?: readonly string[]): SmallSupplier {
  const d = new Date(now);
  let y = d.getFullYear();
  let q = Math.floor(d.getMonth() / 3);
  const keys: { key: string; y: number; q: number }[] = [];
  for (let i = 0; i < 4; i++) {
    keys.unshift({ key: `${y} Q${q + 1}`, y, q });
    q--;
    if (q < 0) {
      q = 3;
      y--;
    }
  }
  const counts = (i: Income) => {
    const a = areaOf(i);
    if (a === "personal") return false;
    return !areas || a === UNTAGGED || areas.includes(a);
  };
  const quarters = keys.map(({ key, y, q }) => {
    const from = quarterStart(y, q);
    const revenue = income.filter((i) => counts(i) && i.date.slice(0, 7) >= from && i.date.slice(0, 7) < (q === 3 ? `${y + 1}-01` : quarterStart(y, q + 1))).reduce((s, i) => s + i.amount, 0);
    return { key, revenue: r2(revenue) };
  });
  const total = r2(quarters.reduce((s, x) => s + x.revenue, 0));
  const pct = Math.round((total / SMALL_SUPPLIER_LIMIT) * 1000) / 10;
  const singleQuarterOver = quarters.some((x) => x.revenue > SMALL_SUPPLIER_LIMIT);
  return { quarters, total, pct, level: total > SMALL_SUPPLIER_LIMIT || singleQuarterOver ? "over" : pct >= 80 ? "near" : "ok", singleQuarterOver };
}

// ── HST filing dates ────────────────────────────────────────────────────────

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const lastDay = (y: number, m0: number) => new Date(y, m0 + 1, 0);

export interface HstDue {
  period: string;
  /** Return due (YYYY-MM-DD). */
  due: string;
  /** Payment due when it differs from the return (yearly filers: April 30). */
  paymentDue?: string;
}

/**
 * The next HST return due for a reporting period (the CRA's general rule: one month after a
 * monthly / quarterly period; yearly sole proprietors with a Dec 31 year-end file by June 15 and
 * pay by April 30). Returns the earliest return due on or after `now`. An aid for reminders:
 * check your own dates with the CRA.
 */
export function nextHstDue(period: HstPeriod, now = Date.now()): HstDue {
  const today = iso(new Date(now));
  const d = new Date(now);
  const cands: HstDue[] = [];
  if (period === "yearly") {
    for (const y of [d.getFullYear() - 1, d.getFullYear()]) cands.push({ period: String(y), due: `${y + 1}-06-15`, paymentDue: `${y + 1}-04-30` });
  } else {
    for (let k = -3; k <= 3; k++) {
      const end = lastDay(d.getFullYear(), d.getMonth() + k);
      if (period === "quarterly" && end.getMonth() % 3 !== 2) continue;
      const label = period === "monthly" ? iso(end).slice(0, 7) : `${end.getFullYear()} Q${Math.floor(end.getMonth() / 3) + 1}`;
      cands.push({ period: label, due: iso(lastDay(end.getFullYear(), end.getMonth() + 1)) });
    }
  }
  return cands.filter((c) => c.due >= today).sort((a, b) => a.due.localeCompare(b.due))[0];
}

// ── Accountant export ───────────────────────────────────────────────────────

export interface ExportRow {
  type: string;
  date: string;
  area: string;
  who: string;
  description: string;
  category: string;
  amount: number;
  tax: number;
  total: number;
  method: string;
  inReturn: string;
  question: string;
}

/** Every record as one flat row for the accountant's CSV. `label(area)` = the area's display name. */
export function accountantRows(d: TaxData, label: (area: string) => string, kmRate: number): ExportRow[] {
  const rows: ExportRow[] = [];
  for (const i of d.income)
    rows.push({ type: "Income", date: i.date, area: label(areaOf(i)), who: i.client, description: i.description, category: "sales", amount: i.amount, tax: i.taxCollected ?? 0, total: r2(i.amount + (i.taxCollected ?? 0)), method: i.method ?? "", inReturn: i.inReturn === false ? "no" : "yes", question: i.question ?? "" });
  for (const r of d.receipts)
    rows.push({ type: "Expense", date: r.date, area: label(areaOf(r)), who: r.vendor, description: r.notes ?? "", category: r.category, amount: receiptBase(r), tax: r2((r.gst ?? 0) + (r.hst ?? 0) + (r.pst ?? 0) + (r.qst ?? 0)), total: r.total ?? receiptBase(r), method: r.source ?? "scan", inReturn: r.inReturn === false ? "no" : "yes", question: r.question ?? "" });
  for (const c of d.commissions ?? [])
    rows.push({ type: "Agent commission", date: c.date, area: label(areaOf(c)), who: c.agentName, description: `${c.pct}% of ${c.gross} (${c.client})`, category: "commission", amount: c.amount, tax: 0, total: c.amount, method: c.paid ? (c.paidMethod ?? "paid") : "owed", inReturn: "n/a", question: c.question ?? "" });
  for (const t of d.mileage ?? [])
    rows.push({ type: "Mileage (estimate)", date: t.date, area: label(areaOf(t)), who: `${t.from} → ${t.to}`, description: t.purpose, category: "vehicle", amount: r2(t.km * kmRate), tax: 0, total: r2(t.km * kmRate), method: `${t.km} km (${t.kmSource})`, inReturn: "n/a", question: t.question ?? "" });
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

/** A plain-words summary for the accountant (text file). */
export function accountantSummary(rows: readonly AreaSummary[], opts: { year: string; label: (a: string) => string; money: (n: number) => string; kmRate: number }): string {
  const m = opts.money;
  const lines = [`Bookkeeping summary — ${opts.year === "all" ? "all years" : opts.year}`, `Prepared from my own records. Numbers are what I entered or scanned; please check them.`, ""];
  for (const s of [...rows, ...(rows.length > 1 ? [combine(rows)] : [])]) {
    lines.push(s.area === "all" ? "ALL BUSINESSES (Personal not included)" : opts.label(s.area).toUpperCase());
    lines.push(`  Income (before tax): ${m(s.income)}`);
    lines.push(`  Expenses (before tax): ${m(s.expenses)}`);
    if (s.commissions) lines.push(`  Agent commissions: ${m(s.commissions)}`);
    if (s.km) lines.push(`  Mileage: ${s.km} km × ${m(opts.kmRate)}/km = ${m(s.mileage)} (estimate)`);
    lines.push(`  Profit before tax: ${m(s.profit)}`);
    lines.push(`  HST/GST collected: ${m(s.collected)} · paid on purchases (ITCs): ${m(s.itc)} · difference: ${m(s.netHst)}`);
    if (s.area !== "all" && s.setAsidePct) lines.push(`  Set aside for tax (my estimate at ${s.setAsidePct}%): ${m(s.setAside)}`);
    if (s.questions) lines.push(`  Records marked "question for accountant": ${s.questions}`);
    lines.push("");
  }
  lines.push("Nothing here decides what is deductible — the records marked with a question are the ones I'd like you to look at.");
  return lines.join("\n");
}
