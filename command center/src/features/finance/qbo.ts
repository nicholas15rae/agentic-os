/**
 * QuickBooks Online-compatible CSV exports (files only — there is no QuickBooks connection):
 *   - bank transactions, 3-column (Date, Description, Amount; money out negative) or
 *     4-column (Date, Description, Credit, Debit),
 *   - invoices (one row per invoice line, QBO's invoice-import columns).
 * QBO asks for the date format during import; pick the same one here. Pure.
 */
import { localIso } from "./areas";
import { invoiceTotals, type Commission, type Income, type Invoice, type Receipt } from "./types";
import type { ParsedLine } from "./csv-import";

export type QboDateFormat = "MM/DD/YYYY" | "DD/MM/YYYY";

export function qboDate(iso: string, fmt: QboDateFormat): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return fmt === "MM/DD/YYYY" ? `${m}/${d}/${y}` : `${d}/${m}/${y}`;
}

const cell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (rows: unknown[][]) => rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
const amt = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

/** Bank transactions for QBO's "Upload from file". `lines` are signed: + money in, − money out. */
export function qboBankCsv(lines: readonly ParsedLine[], columns: 3 | 4, fmt: QboDateFormat = "MM/DD/YYYY"): string {
  const sorted = [...lines].sort((a, b) => a.date.localeCompare(b.date));
  if (columns === 3) return csv([["Date", "Description", "Amount"], ...sorted.map((l) => [qboDate(l.date, fmt), l.description, amt(l.amount)])]);
  return csv([["Date", "Description", "Credit", "Debit"], ...sorted.map((l) => [qboDate(l.date, fmt), l.description, l.amount > 0 ? amt(l.amount) : "", l.amount < 0 ? amt(-l.amount) : ""])]);
}

/** QBO's tax code for a rate (Canadian QBO names; adjust in QBO if yours differ). */
export const qboTaxCode = (rate: number): string => (rate === 13 ? "HST ON" : rate === 15 ? "HST" : rate === 5 ? "GST" : rate === 0 ? "Exempt" : `${rate}%`);

/** Invoices for QBO's invoice import (one row per line; the invoice fields repeat). */
export function qboInvoicesCsv(invoices: readonly Invoice[], fmt: QboDateFormat = "MM/DD/YYYY"): string {
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const rows: unknown[][] = [["InvoiceNo", "Customer", "InvoiceDate", "DueDate", "Item(Product/Service)", "ItemDescription", "ItemQuantity", "ItemRate", "ItemAmount", "ItemTaxCode", "ItemTaxAmount", "Memo"]];
  for (const inv of [...invoices].filter((i) => i.status !== "void").sort((a, b) => a.issuedAt - b.issuedAt)) {
    for (const l of inv.items) {
      const amount = (Number(l.qty) || 0) * (Number(l.rate) || 0);
      rows.push([inv.number, inv.client, qboDate(iso(inv.issuedAt), fmt), qboDate(iso(inv.dueAt), fmt), "Services", l.desc, l.qty, amt(l.rate), amt(amount), qboTaxCode(inv.taxRate), amt((amount * inv.taxRate) / 100), inv.notes ?? ""]);
    }
    if (!inv.items.length) rows.push([inv.number, inv.client, qboDate(iso(inv.issuedAt), fmt), qboDate(iso(inv.dueAt), fmt), "Services", "", 0, "0.00", "0.00", qboTaxCode(inv.taxRate), amt(invoiceTotals(inv).tax), inv.notes ?? ""]);
  }
  return csv(rows);
}

/** Your own ledger as bank-style lines (income in with its HST, expenses and paid commissions out). */
export function ledgerBankLines(d: { income: readonly Income[]; receipts: readonly Receipt[]; commissions?: readonly Commission[] }): ParsedLine[] {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const out: ParsedLine[] = [];
  for (const i of d.income) out.push({ date: i.date, description: [i.client, i.description].filter(Boolean).join(" - "), amount: r2(i.amount + (i.taxCollected ?? 0)) });
  for (const r of d.receipts) if (r.total != null || r.subtotal != null) out.push({ date: r.date, description: [r.vendor, r.category].filter(Boolean).join(" - "), amount: -r2(r.total ?? r.subtotal ?? 0) });
  for (const c of d.commissions ?? []) if (c.paid && c.paidAt && c.paidMethod !== "deducted") out.push({ date: localIso(c.paidAt), description: `Commission - ${c.agentName}`, amount: -r2(c.amount) });
  return out;
}
