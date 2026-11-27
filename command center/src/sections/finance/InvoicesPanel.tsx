import { useEffect, useState } from "react";
import { CheckCircle2, FileDown, Loader2, Mail, Plus, Printer, Send, Trash2, X } from "lucide-react";
import { Card, Field, Input, Select, money } from "@/components/ui";
import { cc, useCollection, type Item } from "@/lib/cc-api";
import { cmd, isTauri } from "@/lib/platform";
import { invoiceTotals, PAY_METHODS, type Invoice, type InvoiceLine } from "@/features/finance/types";
import { useSettings } from "@/stores/settings";
import { profileFor, useProfiles } from "@/features/business/profiles-store";
import { DEFAULT_INVOICE_AREA, printableHst, taxLabel, type BusinessProfile } from "@/features/business/profiles";
import { applyFilter, localIso } from "@/features/finance/areas";
import { useFinanceFilter } from "@/features/finance/filter-store";
import { nextInvoiceNumber, numberTaken, prefixFor } from "@/features/finance/invoice-number";
import { invoicePdf } from "@/features/finance/pdf";
import { AreaSelect, AreaTag, QuestionMark, SelectOther } from "./fields";
import { bookIncome } from "./book";

const STATUS_TONE: Record<Invoice["status"], string> = {
  draft: "border-white/15 text-ink-2",
  sent: "border-amber/50 text-amber-light",
  overdue: "border-alert/60 text-alert",
  paid: "border-teal/60 text-teal",
  void: "border-white/10 text-ink-3",
};

/** Generate, log, print and archive client invoices. */
export function InvoicesPanel() {
  const { items, update, remove } = useCollection<Invoice>("invoices");
  const { currency } = useSettings((s) => s.business);
  const filter = useFinanceFilter((s) => s.filter);
  const [editing, setEditing] = useState<Item<Invoice> | "new" | null>(null);
  const [emailing, setEmailing] = useState<Item<Invoice> | null>(null);
  const [paidBy, setPaidBy] = useState("e-transfer");
  // The per-business profiles printInvoice reads (Settings → Business).
  useEffect(() => {
    if (!useProfiles.getState().loaded) void useProfiles.getState().load();
  }, []);
  const now = Date.now();
  const rows = applyFilter(items, filter).map((i) => (i.status === "sent" && i.dueAt < now ? { ...i, status: "overdue" as const } : i)).sort((a, b) => b.issuedAt - a.issuedAt);
  const outstanding = rows.filter((i) => i.status === "sent" || i.status === "overdue").reduce((s, i) => s + invoiceTotals(i).total, 0);

  const markPaid = async (inv: Item<Invoice>) => {
    const t = invoiceTotals(inv);
    await update(inv.id, { status: "paid", paidAt: Date.now() });
    // Paying an invoice books the income (and the tax collected) automatically, in its area.
    await bookIncome({
      date: localIso(Date.now()),
      client: inv.client,
      description: `Invoice ${inv.number}`,
      amount: t.subtotal,
      taxCollected: t.tax,
      method: paidBy,
      invoiceNumber: inv.number,
      area: inv.area,
    });
  };

  return (
    <div className="space-y-4">
      <Card
        title="Invoices"
        hint={`Outstanding: ${money(outstanding, currency)}. Marking one paid books the income and the HST collected. Each area numbers its own invoices.`}
        action={
          <>
            <span className="flex items-center gap-1.5 text-[11px] text-ink-3">
              Paid by
              <span className="w-32">
                <SelectOther label="Paid by" value={paidBy} options={PAY_METHODS} onChange={setPaidBy} className="!h-8 !py-0 text-[12px]" />
              </span>
            </span>
            <button onClick={() => setEditing("new")} className="pill-primary !h-8 text-xs">
              <Plus size={13} /> New invoice
            </button>
          </>
        }
      >
        <ul className="space-y-1.5">
          {rows.map((inv) => {
            const t = invoiceTotals(inv);
            return (
              <li key={inv.id} className="group flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[12px] border border-white/[0.06] bg-white/[0.02] px-3 py-2">
                <span className="font-mono text-[12px] text-ink-2">{inv.number}</span>
                <AreaTag area={inv.area} onAssign={(area) => void update(inv.id, { area })} />
                <button onClick={() => setEditing(inv)} className="min-w-0 flex-1 truncate text-left text-sm text-ink hover:text-amber-light" title="Edit">
                  {inv.client} <QuestionMark q={inv.question} />
                </button>
                <span className="font-mono text-[11px] text-ink-3">due {new Date(inv.dueAt).toLocaleDateString()}</span>
                <span className="w-24 text-right font-mono text-sm text-ink tabular">{money(t.total, currency)}</span>
                <span className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${STATUS_TONE[inv.status]}`}>{inv.status}</span>
                <div className="flex">
                  {inv.status === "draft" && (
                    <Btn label="Mark sent" onClick={() => void update(inv.id, { status: "sent", sentAt: Date.now() })}>
                      <Send size={13} />
                    </Btn>
                  )}
                  {(inv.status === "sent" || inv.status === "overdue") && (
                    <Btn label="Mark paid (books income)" onClick={() => void markPaid(inv)}>
                      <CheckCircle2 size={13} />
                    </Btn>
                  )}
                  <Btn label="Download PDF" onClick={() => downloadInvoicePdf(inv)}>
                    <FileDown size={13} />
                  </Btn>
                  <Btn label="Email (Gmail draft)" onClick={() => setEmailing(inv)}>
                    <Mail size={13} />
                  </Btn>
                  <Btn label="Print" onClick={() => printInvoice(inv)}>
                    <Printer size={13} />
                  </Btn>
                  <Btn label="Delete" onClick={() => void remove(inv.id)} danger>
                    <Trash2 size={13} />
                  </Btn>
                </div>
              </li>
            );
          })}
          {!rows.length && <li className="py-6 text-center text-sm text-ink-3">No invoices yet.</li>}
        </ul>
      </Card>
      {emailing && (
        <EmailDraftCard
          key={emailing.id}
          inv={emailing}
          onClose={() => setEmailing(null)}
          onDrafted={() => {
            if (emailing.status === "draft") void update(emailing.id, { status: "sent", sentAt: Date.now() });
          }}
        />
      )}
      {editing && <InvoiceEditor initial={editing === "new" ? null : editing} defaultArea={filter.area !== "all" && filter.area !== "untagged" ? filter.area : undefined} onClose={() => setEditing(null)} />}
    </div>
  );
}

function Btn({ label, onClick, danger, children }: { label: string; onClick: () => void; danger?: boolean; children: React.ReactNode }) {
  return (
    <button aria-label={label} title={label} onClick={onClick} className={`grid size-8 place-items-center rounded-full text-ink-3 hover:bg-white/10 ${danger ? "hover:text-alert" : "hover:text-ink"}`}>
      {children}
    </button>
  );
}

/** The next free number for an area (max in use + 1, per area and year). */
const numberFor = (rows: readonly Invoice[], area: string, at = Date.now()) => nextInvoiceNumber(rows.map((r) => r.number), prefixFor(area, profileFor(area).invoicePrefix), new Date(at).getFullYear());

function InvoiceEditor({ initial, defaultArea, onClose }: { initial: Item<Invoice> | null; defaultArea?: string; onClose: () => void }) {
  const { create, update, items } = useCollection<Invoice>("invoices");
  const { currency } = useSettings((s) => s.business);
  useProfiles((s) => s.doc); // re-render when the profiles load
  const startArea = defaultArea ?? DEFAULT_INVOICE_AREA;
  const [inv, setInv] = useState<Invoice>(
    initial ?? {
      number: numberFor(items, startArea),
      client: "",
      items: [{ desc: "", qty: 1, rate: 0 }],
      // A new invoice starts at its area's tax rate.
      taxRate: profileFor(startArea).taxRate,
      issuedAt: Date.now(),
      dueAt: Date.now() + 30 * 86_400_000,
      status: "draft",
      area: startArea,
    },
  );
  const [numberEdited, setNumberEdited] = useState(!!initial);
  const taken = numberTaken(items, inv.number, initial?.id);
  const setArea = (area: string) => setInv({ ...inv, area, ...(initial ? {} : { taxRate: profileFor(area).taxRate }), ...(numberEdited ? {} : { number: numberFor(items, area, inv.issuedAt) }) });
  const t = invoiceTotals(inv);
  const setLine = (i: number, patch: Partial<InvoiceLine>) => setInv({ ...inv, items: inv.items.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

  return (
    <Card
      title={initial ? `Edit ${initial.number}` : "New invoice"}
      action={
        <button onClick={onClose} aria-label="Close editor" className="grid size-8 place-items-center rounded-full text-ink-2 hover:text-ink">
          <X size={15} />
        </button>
      }
    >
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (taken) return;
          if (initial) await update(initial.id, inv);
          else await create(inv);
          onClose();
        }}
      >
        <div className="grid gap-2 sm:grid-cols-3">
          <Field label="Area (whose invoice)">
            <AreaSelect value={inv.area} onChange={setArea} className="" />
          </Field>
          <Field label={taken ? "Invoice # (already used!)" : "Invoice #"}>
            <Input
              value={inv.number}
              onChange={(e) => {
                setNumberEdited(true);
                setInv({ ...inv, number: e.target.value });
              }}
              className={`font-mono ${taken ? "!border-alert" : ""}`}
              required
            />
          </Field>
          <Field label="Client">
            <Input value={inv.client} onChange={(e) => setInv({ ...inv, client: e.target.value })} required />
          </Field>
          <Field label="Client email">
            <Input type="email" value={inv.clientEmail ?? ""} onChange={(e) => setInv({ ...inv, clientEmail: e.target.value })} />
          </Field>
          <Field label="Client address">
            <Input value={inv.clientAddress ?? ""} onChange={(e) => setInv({ ...inv, clientAddress: e.target.value })} />
          </Field>
          <Field label="Issued">
            <Input type="date" value={day(inv.issuedAt)} onChange={(e) => setInv({ ...inv, issuedAt: Date.parse(e.target.value + "T12:00:00") })} />
          </Field>
          <Field label="Due">
            <span className="flex gap-1">
              <Input type="date" value={day(inv.dueAt)} onChange={(e) => setInv({ ...inv, dueAt: Date.parse(e.target.value + "T12:00:00") })} className="min-w-0 flex-1" />
              <Select
                value=""
                onChange={(e) => {
                  if (e.target.value) setInv({ ...inv, dueAt: inv.issuedAt + Number(e.target.value) * 86_400_000 });
                }}
                className="!w-24"
                aria-label="Due in"
              >
                <option value="">Net…</option>
                <option value="0">On receipt</option>
                <option value="7">Net 7</option>
                <option value="15">Net 15</option>
                <option value="30">Net 30</option>
                <option value="60">Net 60</option>
              </Select>
            </span>
          </Field>
          <Field label="Tax %">
            <Input type="number" step="0.5" value={inv.taxRate} onChange={(e) => setInv({ ...inv, taxRate: Number(e.target.value) })} className="font-mono" />
          </Field>
        </div>
        <div className="space-y-1.5">
          {inv.items.map((l, i) => (
            <div key={i} className="grid grid-cols-[1fr_70px_100px_32px] gap-1.5">
              <Input value={l.desc} onChange={(e) => setLine(i, { desc: e.target.value })} placeholder="Description" className="!h-9 !py-1 text-[13px]" aria-label="Line description" />
              <Input type="number" min={0} step="0.25" value={l.qty} onChange={(e) => setLine(i, { qty: Number(e.target.value) })} className="!h-9 !py-1 font-mono text-[13px]" aria-label="Quantity" />
              <Input type="number" min={0} step="0.01" value={l.rate} onChange={(e) => setLine(i, { rate: Number(e.target.value) })} className="!h-9 !py-1 font-mono text-[13px]" aria-label="Rate" />
              <button type="button" aria-label="Remove line" onClick={() => setInv({ ...inv, items: inv.items.filter((_, j) => j !== i) })} className="grid size-9 place-items-center text-ink-3 hover:text-alert" disabled={inv.items.length === 1}>
                <X size={13} />
              </button>
            </div>
          ))}
          <button type="button" onClick={() => setInv({ ...inv, items: [...inv.items, { desc: "", qty: 1, rate: 0 }] })} className="pill-glass !h-8 text-xs">
            <Plus size={12} /> Line
          </button>
        </div>
        <Field label="Notes / payment terms">
          <Input value={inv.notes ?? ""} onChange={(e) => setInv({ ...inv, notes: e.target.value })} placeholder="e-Transfer to … · Net 30" />
        </Field>
        <div className="flex flex-wrap items-center gap-4 border-t border-white/5 pt-3 font-mono text-sm tabular">
          <span className="text-ink-2">Subtotal {money(t.subtotal, currency)}</span>
          <span className="text-ink-2">
            Tax {inv.taxRate}% {money(t.tax, currency)}
          </span>
          <span className="text-amber-light">Total {money(t.total, currency)}</span>
          <Select value={inv.status} onChange={(e) => setInv({ ...inv, status: e.target.value as Invoice["status"] })} className="!h-9 !w-auto !py-1 font-sans text-[13px]" aria-label="Status">
            {["draft", "sent", "paid", "void"].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </Select>
          <button className="pill-primary ml-auto" disabled={taken} title={taken ? "That invoice number is already used" : undefined}>
            Save invoice
          </button>
        </div>
      </form>
    </Card>
  );
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);


const INVOICE_CSS: Record<BusinessProfile["invoiceStyle"], string> = {
  classic: `body{font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#111;margin:48px;max-width:760px}
h1{font-size:28px;margin:0}table{width:100%;border-collapse:collapse;margin-top:28px}th,td{padding:8px 6px;border-bottom:1px solid #ddd;text-align:left}
th{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#666}`,
  modern: `body{font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;color:#141414;margin:0 48px 48px;max-width:760px;border-top:10px solid #d97706;padding-top:36px}
h1{font-size:34px;margin:0;letter-spacing:-.02em}table{width:100%;border-collapse:collapse;margin-top:28px}th,td{padding:9px 6px;text-align:left}
thead th{background:#f4f4f5}tbody tr:nth-child(even) td{background:#fafafa}th{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#555}`,
  minimal: `body{font:13px/1.5 Georgia,"Times New Roman",serif;color:#222;margin:56px;max-width:720px}
h1{font-size:20px;font-weight:400;letter-spacing:.2em;margin:0}table{width:100%;border-collapse:collapse;margin-top:28px}th,td{padding:6px 4px;text-align:left}
th{font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:#888;font-weight:400}`,
};

/** A clean, light printable invoice → the browser's Print → Save as PDF. Uses the profile of the invoice's area. */
function printInvoice(inv: Invoice) {
  const b = profileFor(inv.area);
  const t = invoiceTotals(inv);
  const m = (n: number) => money(n, b.currency);
  const label = taxLabel(b.province);
  // Only a well-formed number Nic confirmed is ever printed (Settings → Business).
  const hst = printableHst(b);
  const logo = b.logoFileId ? `<img src="${esc(cc.fileUrl(b.logoFileId))}" alt="" style="max-height:64px;max-width:200px;margin-bottom:8px"><br>` : "";
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(inv.number)}</title>
<style>${INVOICE_CSS[b.invoiceStyle] ?? INVOICE_CSS.classic}
.r{text-align:right}.tot td{border:0;padding:4px 6px;background:none}.big{font-size:18px;font-weight:700}
.muted{color:#666}.row{display:flex;justify-content:space-between;gap:24px;margin-top:24px}@media print{body{margin:24px}}</style></head><body>
<div class="row"><div><h1>INVOICE</h1><div class="muted">${esc(inv.number)}</div></div>
<div style="text-align:right">${logo}<b>${esc(b.name || "Your business")}</b><br>${esc(b.address)}<br>${esc(b.email)} ${esc(b.phone)}<br>${hst ? `${label} # ${esc(hst)}` : ""}</div></div>
<div class="row"><div><div class="muted">Bill to</div><b>${esc(inv.client)}</b><br>${esc(inv.clientAddress ?? "")}<br>${esc(inv.clientEmail ?? "")}</div>
<div style="text-align:right"><div class="muted">Issued</div>${new Date(inv.issuedAt).toLocaleDateString()}<div class="muted" style="margin-top:6px">Due</div>${new Date(inv.dueAt).toLocaleDateString()}</div></div>
<table><thead><tr><th>Description</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Amount</th></tr></thead><tbody>
${inv.items.map((l) => `<tr><td>${esc(l.desc)}</td><td class="r">${l.qty}</td><td class="r">${m(l.rate)}</td><td class="r">${m(l.qty * l.rate)}</td></tr>`).join("")}
</tbody></table>
<table style="width:auto;margin-left:auto"><tbody class="tot"><tr><td>Subtotal</td><td class="r">${m(t.subtotal)}</td></tr>
<tr><td>${label} ${inv.taxRate}%</td><td class="r">${m(t.tax)}</td></tr><tr><td class="big">Total</td><td class="r big">${m(t.total)}</td></tr></tbody></table>
${inv.notes ? `<p class="muted" style="margin-top:32px">${esc(inv.notes)}</p>` : ""}
<script>window.onload=()=>{window.print()}</script></body></html>`;
  const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  const w = window.open(url, "_blank");
  if (!w) {
    // Popup blocked (or the desktop shell): download the HTML instead.
    const a = Object.assign(document.createElement("a"), { href: url, download: `${inv.number}.html` });
    a.click();
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** A real .pdf file of the invoice (built in the app, no print dialog), saved to Downloads. */
function downloadInvoicePdf(inv: Invoice) {
  const b = profileFor(inv.area);
  const bytes = invoicePdf(inv, b, { money: (n) => money(n, b.currency), taxLabel: taxLabel(b.province), hstNumber: printableHst(b), date: (ms) => new Date(ms).toLocaleDateString() });
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: `${inv.number}.pdf` });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** The email body: a plain summary (Gmail drafts here can't carry attachments). */
function emailBody(inv: Invoice, b: BusinessProfile): string {
  const t = invoiceTotals(inv);
  const m = (n: number) => money(n, b.currency);
  return [
    `Hi ${inv.client},`,
    "",
    `Here is invoice ${inv.number} from ${b.name || "me"}.`,
    "",
    ...inv.items.map((l) => `- ${l.desc}: ${l.qty} x ${m(l.rate)} = ${m(l.qty * l.rate)}`),
    "",
    `Subtotal: ${m(t.subtotal)}`,
    `${taxLabel(b.province)} ${inv.taxRate}%: ${m(t.tax)}`,
    `Total: ${m(t.total)}`,
    `Due: ${new Date(inv.dueAt).toLocaleDateString()}`,
    ...(inv.notes ? ["", inv.notes] : []),
    "",
    "Thank you,",
    b.name || "",
  ].join("\n");
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Email an invoice = a Gmail DRAFT, never a send: this card shows exactly what goes into the
 * draft and creates it only on "Create draft". The PDF downloads alongside; attach it in Gmail.
 */
function EmailDraftCard({ inv, onClose, onDrafted }: { inv: Invoice; onClose: () => void; onDrafted: () => void }) {
  const b = profileFor(inv.area);
  const [to, setTo] = useState(inv.clientEmail ?? "");
  const [subject, setSubject] = useState(`Invoice ${inv.number}${b.name ? ` from ${b.name}` : ""}`);
  const [body, setBody] = useState(() => emailBody(inv, b));
  const [state, setState] = useState<{ s: "idle" | "working" | "done" | "error"; msg?: string }>({ s: "idle" });
  const desktop = isTauri();
  return (
    <Card
      title={`Email ${inv.number} · Gmail draft`}
      hint="Nothing is sent. This creates a draft in your Gmail with the text below; open Gmail, attach the PDF (it downloads now) and press Send yourself."
      action={
        <button onClick={onClose} aria-label="Close" className="grid size-8 place-items-center rounded-full text-ink-2 hover:text-ink">
          <X size={15} />
        </button>
      }
    >
      <div className="space-y-2">
        <Field label="To">
          <Input type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="client@example.com" />
        </Field>
        <Field label="Subject">
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
        </Field>
        <Field label="Message">
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={10} className="field w-full font-mono text-[12px]" />
        </Field>
        {!desktop && <p className="text-xs text-amber-light">Gmail drafts need the desktop app. Download the PDF and email it yourself.</p>}
        {state.msg && <p className={`text-xs ${state.s === "error" ? "text-alert" : "text-teal"}`}>{state.msg}</p>}
        <div className="flex flex-wrap gap-2">
          <button className="pill-glass" onClick={() => downloadInvoicePdf(inv)}>
            <FileDown size={14} /> Download PDF
          </button>
          <button
            className="pill-primary ml-auto"
            disabled={!desktop || !EMAIL_RE.test(to.trim()) || state.s === "working" || state.s === "done"}
            onClick={async () => {
              setState({ s: "working" });
              try {
                downloadInvoicePdf(inv);
                await cmd("gmail_create_draft", { to: to.trim(), subject, body, approved: true });
                setState({ s: "done", msg: "Draft created in Gmail (not sent). Attach the downloaded PDF there, then send it yourself." });
                onDrafted();
              } catch (e) {
                setState({ s: "error", msg: `Couldn't create the draft: ${e instanceof Error ? e.message : String(e)}` });
              }
            }}
          >
            {state.s === "working" ? <Loader2 size={14} className="animate-spin" /> : <Mail size={14} />} Create draft
          </button>
        </div>
      </div>
    </Card>
  );
}
