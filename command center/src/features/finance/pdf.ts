/**
 * A tiny PDF writer (no dependency): text in Helvetica / Helvetica-Bold, lines and grey boxes, on
 * US Letter pages. Enough for a clean invoice saved as a real .pdf file. Pure: returns the bytes.
 */
import type { BusinessProfile } from "@/features/business/profiles";
import { invoiceTotals, type Invoice } from "./types";

export type PdfOp =
  | { t: "text"; x: number; y: number; size: number; text: string; bold?: boolean; align?: "left" | "right"; gray?: number }
  | { t: "line"; x1: number; y1: number; x2: number; y2: number; w?: number; gray?: number }
  | { t: "rect"; x: number; y: number; w: number; h: number; gray: number };

export const PAGE_W = 612;
export const PAGE_H = 792;

// Helvetica advance widths (1/1000 em) for ASCII 32..126 (Adobe AFM).
const HW = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];

/** Text width in points (bold ≈ 6 % wider: close enough to right-align numbers). */
export function textWidth(s: string, size: number, bold = false): number {
  let w = 0;
  for (const ch of winAnsi(s)) {
    const c = ch.charCodeAt(0);
    w += c >= 32 && c <= 126 ? HW[c - 32] : 556;
  }
  return (w / 1000) * size * (bold ? 1.06 : 1);
}

/** Map text onto the WinAnsi (Latin-1) range the standard fonts can draw. */
export function winAnsi(s: string): string {
  return String(s ?? "")
    .replace(/[–—−]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, "...")
    .replace(/•/g, "-")
    .replace(/→/g, "->")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[^\x20-\x7E\xA0-\xFF]/gu, "?");
}

const escPdf = (s: string) => winAnsi(s).replace(/[\\()]/g, (c) => `\\${c}`);
const n = (v: number) => (Math.round(v * 100) / 100).toString();

function content(ops: readonly PdfOp[]): string {
  const out: string[] = [];
  for (const o of ops) {
    if (o.t === "text") {
      const x = o.align === "right" ? o.x - textWidth(o.text, o.size, o.bold) : o.x;
      out.push(`BT ${n(o.gray ?? 0)} g /${o.bold ? "F2" : "F1"} ${n(o.size)} Tf ${n(x)} ${n(o.y)} Td (${escPdf(o.text)}) Tj ET`);
    } else if (o.t === "line") out.push(`${n(o.gray ?? 0)} G ${n(o.w ?? 0.5)} w ${n(o.x1)} ${n(o.y1)} m ${n(o.x2)} ${n(o.y2)} l S`);
    else out.push(`${n(o.gray)} g ${n(o.x)} ${n(o.y)} ${n(o.w)} ${n(o.h)} re f 0 g`);
  }
  return out.join("\n");
}

/** The PDF bytes for one or more pages of drawing operations. */
export function buildPdf(pages: readonly (readonly PdfOp[])[], title = ""): Uint8Array {
  const objs: string[] = [];
  const add = (body: string) => objs.push(body); // the new length = the 1-based object number
  const catalog = add("");
  const pagesObj = add("");
  const f1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const f2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  const kids: number[] = [];
  for (const ops of pages.length ? pages : [[]]) {
    const c = content(ops);
    const cs = add(`<< /Length ${c.length} >>\nstream\n${c}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${cs} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  const info = add(`<< /Title (${escPdf(title)}) /Producer (Command Center) >>`);
  let pdf = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  // Every char is ≤ 0xFF (winAnsi), so one char = one byte.
  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xff;
  return bytes;
}

/** Wrap text to a width (in points) for the given size. */
export function wrap(text: string, width: number, size: number): string[] {
  const words = winAnsi(text).split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && textWidth(next, size) > width) {
      lines.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

export interface InvoicePdfOpts {
  money: (n: number) => string;
  taxLabel: string;
  /** The HST number to print (only a confirmed one), or null. */
  hstNumber: string | null;
  date: (ms: number) => string;
}

/** An invoice as PDF bytes, from its area's business profile. */
export function invoicePdf(inv: Invoice, b: Pick<BusinessProfile, "name" | "address" | "email" | "phone">, o: InvoicePdfOpts): Uint8Array {
  const t = invoiceTotals(inv);
  const L = 54;
  const R = PAGE_W - 54;
  const pages: PdfOp[][] = [];
  let ops: PdfOp[] = [];
  let y = PAGE_H - 64;
  const text = (x: number, yy: number, s: string, size = 10, extra: Partial<Extract<PdfOp, { t: "text" }>> = {}) => ops.push({ t: "text", x, y: yy, size, text: s, ...extra });

  text(L, y, "INVOICE", 24, { bold: true });
  text(L, y - 18, inv.number, 10, { gray: 0.4 });
  let ry = y;
  text(R, ry, b.name || "Your business", 11, { bold: true, align: "right" });
  for (const line of [...wrap(b.address, 220, 9), [b.email, b.phone].filter(Boolean).join("  "), o.hstNumber ? `${o.taxLabel} # ${o.hstNumber}` : ""].filter(Boolean)) {
    ry -= 13;
    text(R, ry, line, 9, { align: "right", gray: 0.25 });
  }
  y = Math.min(y - 40, ry) - 30;
  text(L, y, "Bill to", 8, { gray: 0.45 });
  text(R, y, "Issued", 8, { gray: 0.45, align: "right" });
  y -= 14;
  text(L, y, inv.client, 11, { bold: true });
  text(R, y, o.date(inv.issuedAt), 10, { align: "right" });
  let by = y;
  for (const line of [...wrap(inv.clientAddress ?? "", 260, 9), inv.clientEmail ?? ""].filter(Boolean)) {
    by -= 13;
    text(L, by, line, 9, { gray: 0.25 });
  }
  text(R, y - 18, "Due", 8, { gray: 0.45, align: "right" });
  text(R, y - 31, o.date(inv.dueAt), 10, { align: "right", bold: true });
  y = Math.min(by, y - 31) - 34;

  const head = () => {
    ops.push({ t: "rect", x: L, y: y - 6, w: R - L, h: 20, gray: 0.94 });
    text(L + 6, y, "DESCRIPTION", 8, { bold: true, gray: 0.35 });
    text(R - 200, y, "QTY", 8, { bold: true, gray: 0.35, align: "right" });
    text(R - 110, y, "RATE", 8, { bold: true, gray: 0.35, align: "right" });
    text(R - 6, y, "AMOUNT", 8, { bold: true, gray: 0.35, align: "right" });
    y -= 24;
  };
  head();
  for (const l of inv.items) {
    const desc = wrap(l.desc || "—", R - L - 240, 10);
    if (y - desc.length * 13 < 140) {
      pages.push(ops);
      ops = [];
      y = PAGE_H - 64;
      head();
    }
    text(R - 200, y, String(l.qty), 10, { align: "right" });
    text(R - 110, y, o.money(l.rate), 10, { align: "right" });
    text(R - 6, y, o.money((Number(l.qty) || 0) * (Number(l.rate) || 0)), 10, { align: "right" });
    for (const d of desc) {
      text(L + 6, y, d, 10);
      y -= 13;
    }
    y -= 4;
    ops.push({ t: "line", x1: L, y1: y + 8, x2: R, y2: y + 8, w: 0.4, gray: 0.85 });
  }
  y -= 10;
  const tot = (label: string, v: string, big = false) => {
    text(R - 130, y, label, big ? 12 : 10, { align: "right", bold: big });
    text(R - 6, y, v, big ? 12 : 10, { align: "right", bold: big });
    y -= big ? 20 : 15;
  };
  tot("Subtotal", o.money(t.subtotal));
  tot(`${o.taxLabel} ${inv.taxRate}%`, o.money(t.tax));
  ops.push({ t: "line", x1: R - 220, y1: y + 10, x2: R, y2: y + 10, w: 0.8 });
  y -= 4;
  tot("Total", o.money(t.total), true);
  if (inv.notes) {
    y -= 16;
    for (const line of wrap(inv.notes, R - L, 9)) {
      text(L, y, line, 9, { gray: 0.35 });
      y -= 12;
    }
  }
  pages.push(ops);
  return buildPdf(pages, inv.number);
}
