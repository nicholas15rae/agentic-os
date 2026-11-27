/**
 * Bank / credit-card statement CSV import: parse, detect the common column layouts (or map them
 * by hand), and match each line against your own records (same amount, date within a window).
 * The statement is only ever read. Pure.
 */
import { localIso } from "./areas";
import type { Check, Commission, Income, Receipt } from "./types";

/** RFC 4180-ish: quoted fields, doubled quotes, commas / newlines inside quotes, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let f = "";
  let q = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          f += '"';
          i++;
        } else q = false;
      } else f += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(f);
      f = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(f);
      if (row.some((x) => x.trim() !== "")) rows.push(row.map((x) => x.trim()));
      row = [];
      f = "";
    } else f += c;
  }
  row.push(f);
  if (row.some((x) => x.trim() !== "")) rows.push(row.map((x) => x.trim()));
  return rows;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n: number) => String(n).padStart(2, "0");
const ok = (y: number, m: number, d: number) => (y > 1900 && m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${pad(m)}-${pad(d)}` : null);

/**
 * A statement date as YYYY-MM-DD, or null. Slashed dates are read month-first (MM/DD/YYYY, the
 * usual Canadian bank export) unless `dayFirst`, or the first part is over 12.
 */
export function parseDate(raw: string, dayFirst = false): string | null {
  const s = (raw ?? "").trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  if (m) return ok(+m[1], +m[2], +m[3]);
  m = /^(\d{8})$/.exec(s);
  if (m) return ok(+s.slice(0, 4), +s.slice(4, 6), +s.slice(6, 8));
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(s);
  if (m) {
    let a = +m[1];
    let b = +m[2];
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    if (dayFirst || a > 12) [a, b] = [b, a];
    return ok(y, a, b);
  }
  m = /^([A-Za-z]{3,4})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (m && MONTHS[m[1].toLowerCase()]) return ok(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
  m = /^(\d{1,2})[\s-]([A-Za-z]{3,4})[a-z]*\.?[\s-],?\s*(\d{4})$/.exec(s);
  if (m && MONTHS[m[2].toLowerCase()]) return ok(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  return null;
}

/** "$1,234.56", "(12.00)", "-12", "12.00 CR", "12.00-" → number, "" → null. */
export function parseAmount(raw: string): number | null {
  let s = (raw ?? "").trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  if (/\s*(DR|-)$/i.test(s)) {
    neg = !neg;
    s = s.replace(/\s*(DR|-)$/i, "");
  }
  s = s.replace(/\s*CR$/i, "");
  s = s.replace(/[$€£\s,]|CAD|USD/gi, "");
  if (s.startsWith("-")) {
    neg = !neg;
    s = s.slice(1);
  }
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(s)) return null;
  const n = Math.round(Number(s) * 100) / 100;
  return neg ? -n : n;
}

/** Which column holds what (0-based). Either `amount`, or `debit` (money out) and/or `credit` (money in). */
export interface ColumnMap {
  hasHeader: boolean;
  date: number;
  description: number;
  amount?: number;
  debit?: number;
  credit?: number;
  /** Flip the sign (credit-card exports often show purchases as positive). */
  invert?: boolean;
  dayFirst?: boolean;
}

const find = (h: string[], ...words: RegExp[]) => h.findIndex((x) => words.some((w) => w.test(x)));

/**
 * Guess the layout. Headers named date / description / amount (or debit / withdrawal, credit /
 * deposit) are recognised; a headerless file is read as date, description, amount (3 columns) or
 * date, description, debit, credit[, balance] (4–5 columns, the TD / RBC style). null = use the
 * column mapper.
 */
export function detectColumns(rows: readonly string[][]): ColumnMap | null {
  if (!rows.length) return null;
  const head = rows[0].map((x) => x.toLowerCase());
  if (!parseDate(rows[0][0] ?? "") && head.some((x) => /date/.test(x))) {
    const date = find(head, /^(transaction |trans\.? |posted |posting )?date/, /date/);
    const description = find(head, /desc/, /payee/, /merchant/, /details/, /memo/, /name/, /transaction$/);
    const amount = find(head, /^amount/, /cad\$?$/, /amount/);
    const debit = find(head, /debit/, /withdraw/, /money out/, /paid out/);
    const credit = find(head, /credit/, /deposit/, /money in/, /paid in/);
    if (date < 0 || description < 0) return null;
    if (debit >= 0 || credit >= 0) return { hasHeader: true, date, description, ...(debit >= 0 ? { debit } : {}), ...(credit >= 0 ? { credit } : {}) };
    if (amount >= 0) return { hasHeader: true, date, description, amount };
    return null;
  }
  const first = rows[0];
  if (!parseDate(first[0] ?? "")) return null;
  if (first.length === 3 && parseAmount(first[2]) != null) return { hasHeader: false, date: 0, description: 1, amount: 2 };
  if (first.length >= 4 && first.length <= 5) return { hasHeader: false, date: 0, description: 1, debit: 2, credit: 3 };
  return null;
}

export interface ParsedLine {
  date: string;
  description: string;
  /** + money in, − money out. */
  amount: number;
}

/** The statement lines under a column map; rows that don't parse are counted, not guessed. */
export function toLines(rows: readonly string[][], map: ColumnMap): { lines: ParsedLine[]; skipped: number } {
  const lines: ParsedLine[] = [];
  let skipped = 0;
  for (const r of map.hasHeader ? rows.slice(1) : rows) {
    const date = parseDate(r[map.date] ?? "", map.dayFirst);
    let amount: number | null = null;
    if (map.amount != null) amount = parseAmount(r[map.amount] ?? "");
    else {
      const out = map.debit != null ? parseAmount(r[map.debit] ?? "") : null;
      const inn = map.credit != null ? parseAmount(r[map.credit] ?? "") : null;
      if (out != null || inn != null) amount = Math.round(((inn ?? 0) - Math.abs(out ?? 0)) * 100) / 100;
    }
    if (!date || amount == null || amount === 0) {
      skipped++;
      continue;
    }
    lines.push({ date, description: (r[map.description] ?? "").replace(/\s+/g, " ").slice(0, 300), amount: map.invert ? -amount : amount });
  }
  return { lines, skipped };
}

// ── Matching against your own records ───────────────────────────────────────

export interface Candidate {
  collection: string;
  id: string;
  date: string;
  /** Signed like a statement line: + money in, − money out. */
  amount: number;
  label: string;
}

const days = (a: string, b: string) => Math.abs(Date.parse(a + "T12:00:00Z") - Date.parse(b + "T12:00:00Z")) / 86_400_000;

/**
 * Pair each line with the closest-dated unused record of the same signed amount (±1 cent) within
 * `windowDays`. Unmatched lines get null: they're the ones to review.
 */
export function matchLines<L extends ParsedLine & { id?: string }>(lines: readonly L[], candidates: readonly Candidate[], windowDays = 5): { line: L; match: Candidate | null }[] {
  const used = new Set<string>();
  const order = [...lines.keys()].sort((a, b) => lines[a].date.localeCompare(lines[b].date));
  const out: { line: L; match: Candidate | null }[] = lines.map((line) => ({ line, match: null }));
  for (const i of order) {
    const l = lines[i];
    let best: Candidate | null = null;
    let bestD = Infinity;
    for (const c of candidates) {
      const key = `${c.collection}:${c.id}`;
      if (used.has(key) || Math.abs(c.amount - l.amount) > 0.011) continue;
      const d = days(c.date, l.date);
      if (d <= windowDays && d < bestD) {
        best = c;
        bestD = d;
      }
    }
    if (best) {
      used.add(`${best.collection}:${best.id}`);
      out[i].match = best;
    }
  }
  return out;
}

/** Your records as match candidates (income in, expenses / paid commissions out, cheques in). */
export function candidatesFrom(d: {
  income: readonly (Income & { id: string })[];
  receipts: readonly (Receipt & { id: string })[];
  checks?: readonly (Check & { id: string })[];
  commissions?: readonly (Commission & { id: string })[];
}): Candidate[] {
  const out: Candidate[] = [];
  const r2 = (n: number) => Math.round(n * 100) / 100;
  for (const i of d.income) out.push({ collection: "income", id: i.id, date: i.date, amount: r2(i.amount + (i.taxCollected ?? 0)), label: `Income · ${i.client}` });
  for (const r of d.receipts) if (r.total != null || r.subtotal != null) out.push({ collection: "receipts", id: r.id, date: r.date, amount: -r2(r.total ?? r.subtotal ?? 0), label: `Expense · ${r.vendor}` });
  // A cheque often IS an income entry too: matching the income first (above) leaves the cheque for a second line.
  for (const c of d.checks ?? []) out.push({ collection: "checks", id: c.id, date: localIso(c.depositedAt ?? c.receivedAt), amount: r2(c.amount), label: `Cheque · ${c.payer}` });
  for (const c of d.commissions ?? []) if (c.paid && c.paidMethod !== "deducted" && c.paidAt) out.push({ collection: "commissions", id: c.id, date: localIso(c.paidAt), amount: -r2(c.amount), label: `Commission · ${c.agentName}` });
  return out;
}
