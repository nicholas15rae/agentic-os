/**
 * Taxes: income, expenses, HST collected / paid per area and combined, a set-aside estimate, the
 * $30,000 small-supplier watch, the HST return view (areas with a confirmed HST number) and the
 * exports (accountant CSV + summary, QuickBooks Online CSVs). Bookkeeping aids, not tax advice.
 */
import { useMemo, useState } from "react";
import { AlertTriangle, Download, FileText } from "lucide-react";
import { Card, Chip, Select, Stat, downloadText, money, toCsv } from "@/components/ui";
import { useCollection } from "@/lib/cc-api";
import { useProfiles } from "@/features/business/profiles-store";
import { printableHst, type HstPeriod } from "@/features/business/profiles";
import { applyFilter, ALL_FILTER, yearsIn } from "@/features/finance/areas";
import { useAreas, useFinanceFilter } from "@/features/finance/filter-store";
import { ledgerBankLines, qboBankCsv, qboInvoicesCsv, type QboDateFormat } from "@/features/finance/qbo";
import { accountantRows, accountantSummary, combine, hstLines, hstTotals, periodKey, periodKeys, SMALL_SUPPLIER_LIMIT, smallSupplier, summarize } from "@/features/finance/tax";
import type { Commission, Income, Invoice, MileageTrip, Receipt } from "@/features/finance/types";
import { useSettings } from "@/stores/settings";

export function TaxPanel() {
  const income = useCollection<Income>("income");
  const receipts = useCollection<Receipt>("receipts");
  const commissions = useCollection<Commission>("commissions").items;
  const mileage = useCollection<MileageTrip>("mileage").items;
  const invoices = useCollection<Invoice>("invoices").items;
  const filter = useFinanceFilter((s) => s.filter);
  const { areas, label, doc } = useAreas();
  const currency = useSettings((s) => s.business.currency);
  const kmRate = useProfiles((s) => s.doc.finance?.kmRate ?? 0.72);
  const years = useMemo(() => yearsIn([...income.items, ...receipts.items] as unknown as Record<string, unknown>[]), [income.items, receipts.items]);
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const m = (n: number) => money(n, currency);

  // The area / agent / month filters apply; the year is chosen here (taxes are yearly).
  const f = { ...filter, year: year === "all" ? "all" : year };
  const data = { income: applyFilter(income.items, f), receipts: applyFilter(receipts.items, f), commissions: applyFilter(commissions, f), mileage: applyFilter(mileage, f) };
  const setAside = (a: string) => doc.profiles[a]?.setAsidePct ?? (a === "personal" || a === "untagged" ? 0 : 25);
  const rows = summarize(data, { year: "all", kmRate, setAsidePct: setAside }).sort((a, b) => areas.findIndex((x) => x.id === a.area) - areas.findIndex((x) => x.id === b.area));
  const all = combine(rows);
  const ss = smallSupplier(applyFilter(income.items, ALL_FILTER));
  const hstAreas = areas.filter((a) => a.business && printableHst(doc.profiles[a.id] ?? { hstNumber: "", hstConfirmed: false }));

  const exportAccountant = () => {
    const name = `${filter.area === "all" ? "all-areas" : filter.area}-${year}`;
    downloadText(
      `accountant-${name}.csv`,
      toCsv(accountantRows(data, (a) => label(a), kmRate) as unknown as Record<string, unknown>[], [
        { key: "type", label: "Type" },
        { key: "date", label: "Date" },
        { key: "area", label: "Area" },
        { key: "who", label: "Who" },
        { key: "description", label: "Description" },
        { key: "category", label: "Category" },
        { key: "amount", label: "Amount before tax" },
        { key: "tax", label: "Tax" },
        { key: "total", label: "Total" },
        { key: "method", label: "Method / note" },
        { key: "inReturn", label: "In HST return" },
        { key: "question", label: "Question for accountant" },
      ]),
    );
    downloadText(`accountant-summary-${name}.txt`, accountantSummary(rows, { year, label: (a) => label(a), money: m, kmRate }), "text/plain");
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={year} onChange={(e) => setYear(e.target.value)} className="!h-8 !w-auto !py-0 fs-12" aria-label="Tax year">
          {years.map((y) => (
            <option key={y}>{y}</option>
          ))}
          <option value="all">All years</option>
        </Select>
        <span className="fs-11 text-ink-3">{filter.area === "all" ? "All areas" : label(filter.area)} · estimates for planning, not tax advice: check with your accountant.</span>
        <button onClick={exportAccountant} className="pill-glass ml-auto !h-8 text-xs">
          <FileText size={13} /> Export for accountant
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Income (before tax)" value={m(all.income)} sub={`Expenses ${m(all.expenses + all.commissions + all.mileage)}`} tone="teal" />
        <Stat label="Profit before tax" value={m(all.profit)} sub="Personal not included" />
        <Stat label="HST collected − paid" value={m(all.netHst)} sub={`${m(all.collected)} − ITCs ${m(all.itc)}`} tone={all.netHst > 0 ? "amber" : "teal"} />
        <Stat label="Set aside for tax (estimate)" value={m(all.setAside)} sub="Your % per area (Areas & rates)" tone="amber" />
      </div>

      <SmallSupplierCard ss={ss} m={m} />

      <Card title="By area" hint="Expenses are before tax; mileage is km × your rate (an estimate). A record marked “question for accountant” is counted as entered; nothing here decides what's deductible.">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] fs-13">
            <thead>
              <tr className="label-caps text-left text-ink-3 [&>th]:px-2 [&>th]:pb-2">
                <th>Area</th>
                <th className="text-right">Income</th>
                <th className="text-right">Expenses</th>
                <th className="text-right">Commissions</th>
                <th className="text-right">Mileage</th>
                <th className="text-right">Profit</th>
                <th className="text-right">HST in</th>
                <th className="text-right">ITCs</th>
                <th className="text-right">Set aside</th>
                <th className="text-right">Questions</th>
              </tr>
            </thead>
            <tbody className="font-mono tabular">
              {[...rows, ...(rows.length > 1 ? [all] : [])].map((r) => (
                <tr key={r.area} className={`border-t border-white/[0.05] [&>td]:px-2 [&>td]:py-1.5 ${r.area === "all" ? "text-amber-light" : "text-ink-2"}`}>
                  <td className="font-sans text-ink">{r.area === "all" ? "All businesses" : label(r.area)}</td>
                  <td className="text-right">{m(r.income)}</td>
                  <td className="text-right">{m(r.expenses)}</td>
                  <td className="text-right">{m(r.commissions)}</td>
                  <td className="text-right">{m(r.mileage)}</td>
                  <td className="text-right">{m(r.profit)}</td>
                  <td className="text-right">{m(r.collected)}</td>
                  <td className="text-right">{m(r.itc)}</td>
                  <td className="text-right">
                    {m(r.setAside)}
                    {r.area !== "all" && r.setAsidePct ? <span className="text-ink-3"> ({r.setAsidePct}%)</span> : null}
                  </td>
                  <td className="text-right">{r.questions || ""}</td>
                </tr>
              ))}
              {!rows.length && (
                <tr>
                  <td colSpan={10} className="py-6 text-center font-sans text-ink-3">
                    Nothing for this year and filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {hstAreas.length ? (
        <HstReturn areaIds={hstAreas.map((a) => a.id)} income={data.income} receipts={data.receipts} />
      ) : (
        <Card title="HST return">
          <p className="text-sm text-ink-3">The HST return view opens once an area has its HST number entered and confirmed (Settings → Business).</p>
        </Card>
      )}

      <QboExport income={data.income} receipts={data.receipts} commissions={data.commissions} invoices={applyFilter(invoices, f)} />
    </div>
  );
}

function SmallSupplierCard({ ss, m }: { ss: ReturnType<typeof smallSupplier>; m: (n: number) => string }) {
  const tone = ss.level === "over" ? "border-alert/60 bg-alert/10" : ss.level === "near" ? "border-amber/50 bg-amber/10" : "border-white/[0.07]";
  return (
    <Card title="Small-supplier threshold">
      <div className={`r-14 border p-3 ${tone}`}>
        <div className="flex flex-wrap items-baseline gap-2">
          {ss.level !== "ok" && <AlertTriangle size={14} className={ss.level === "over" ? "text-alert" : "text-amber"} />}
          <span className="font-mono text-lg tabular text-ink">{m(ss.total)}</span>
          <span className="text-sm text-ink-2">
            of {m(SMALL_SUPPLIER_LIMIT)} over the last four calendar quarters ({ss.pct}%)
          </span>
        </div>
        <div className="well mt-2 h-2 overflow-hidden rounded-full">
          <div className={`h-full rounded-full ${ss.level === "over" ? "bg-alert" : ss.level === "near" ? "bg-amber" : "bg-teal"}`} style={{ width: `${Math.min(100, ss.pct)}%` }} />
        </div>
        <p className="mt-2 font-mono fs-11 text-ink-3">{ss.quarters.map((q) => `${q.key}: ${m(q.revenue)}`).join(" · ")}</p>
        <p className="mt-1 fs-12 text-ink-2">
          {ss.level === "over"
            ? "You're over $30,000: you likely have to register for HST and start charging it. Talk to your accountant now."
            : ss.level === "near"
              ? "You're past 80% of $30,000. Plan for HST registration with your accountant."
              : "Revenue before tax from your business areas (Personal left out). Sole-proprietor businesses count together; a corporation counts on its own — ask your accountant which applies."}
        </p>
      </div>
    </Card>
  );
}

function HstReturn({ areaIds, income, receipts }: { areaIds: string[]; income: Income[]; receipts: Receipt[] }) {
  const incomeC = useCollection<Income>("income");
  const receiptsC = useCollection<Receipt>("receipts");
  const { label, doc } = useAreas();
  const currency = useSettings((s) => s.business.currency);
  const m = (n: number) => money(n, currency);
  const [area, setArea] = useState(areaIds[0]);
  const cur = areaIds.includes(area) ? area : areaIds[0];
  const [period, setPeriod] = useState<HstPeriod | null>(null);
  const per: HstPeriod = period ?? doc.profiles[cur]?.hstPeriod ?? "quarterly";
  const lines = hstLines({ income: income.filter((i) => i.area === cur), receipts: receipts.filter((r) => r.area === cur) });
  const keys = periodKeys(lines, per);
  const [key, setKey] = useState<string | null>(null);
  const k = key && keys.includes(key) ? key : (keys[0] ?? periodKey(new Date().toISOString().slice(0, 10), per));
  const shown = lines.filter((l) => periodKey(l.date, per) === k);
  const t = hstTotals(shown);
  const toggle = (l: (typeof lines)[number], on: boolean) => (l.collection === "income" ? incomeC.update(l.id, { inReturn: on }) : receiptsC.update(l.id, { inReturn: on }));

  const exportCsv = () =>
    downloadText(
      `hst-${cur}-${k.replace(" ", "-")}.csv`,
      toCsv(shown.map((l) => ({ ...l, kind: l.kind === "sale" ? "Sale (HST collected)" : "Purchase (ITC)", inReturn: l.inReturn ? "yes" : "no" })) as unknown as Record<string, unknown>[], [
        { key: "date", label: "Date" },
        { key: "kind", label: "Type" },
        { key: "who", label: "Who" },
        { key: "category", label: "Category" },
        { key: "base", label: "Amount before tax" },
        { key: "hst", label: "HST / GST" },
        { key: "inReturn", label: "Include in return" },
      ]) + `\n\nPeriod,${k}\nHST collected,${t.collected}\nITCs,${t.itc}\nNet (owing + / refund -),${t.net}\n`,
    );

  return (
    <Card
      title="HST return"
      hint="Tick what goes in this return; the totals follow live. These are your own records, for filling in your return or handing to your accountant. Check every line."
      action={
        <button onClick={exportCsv} className="pill-glass !h-8 text-xs" disabled={!shown.length}>
          <Download size={13} /> CSV
        </button>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {areaIds.map((a) => (
          <Chip key={a} active={a === cur} onClick={() => setArea(a)}>
            {label(a)}
          </Chip>
        ))}
        <span className="mx-1 h-5 w-px bg-white/10" />
        {(["monthly", "quarterly", "yearly"] as HstPeriod[]).map((p) => (
          <Chip key={p} active={per === p} onClick={() => setPeriod(p)} tone="teal">
            {p}
          </Chip>
        ))}
        <Select value={k} onChange={(e) => setKey(e.target.value)} className="!h-8 !w-auto !py-0 fs-12" aria-label="Reporting period">
          {(keys.length ? keys : [k]).map((x) => (
            <option key={x}>{x}</option>
          ))}
        </Select>
      </div>
      <div className="mb-3 grid grid-cols-3 gap-2">
        <Stat label="HST collected" value={m(t.collected)} sub={`on ${m(t.sales)} of sales`} />
        <Stat label="ITCs (HST paid)" value={m(t.itc)} sub={`on ${m(t.purchases)} of purchases`} />
        <Stat label={t.net >= 0 ? "Net owing" : "Net refund"} value={m(Math.abs(t.net))} tone={t.net > 0 ? "amber" : "teal"} />
      </div>
      {Object.keys(t.byCategory).length > 0 && (
        <p className="mb-2 font-mono fs-11 text-ink-3">
          {Object.entries(t.byCategory)
            .map(([c, v]) => `${c}: ${m(v.hst)}`)
            .join(" · ")}
        </p>
      )}
      <ul className="space-y-1">
        {shown.map((l) => (
          <li key={`${l.collection}:${l.id}`} className={`flex items-center gap-3 r-10 px-2 py-1 fs-13 ${l.inReturn ? "" : "opacity-50"}`}>
            <input type="checkbox" checked={l.inReturn} onChange={(e) => void toggle(l, e.target.checked)} className="accent-teal" aria-label={`Include ${l.who} in the return`} />
            <span className="font-mono fs-12 text-ink-3">{l.date}</span>
            <span className={`fs-11 ${l.kind === "sale" ? "text-teal" : "text-amber-light"}`}>{l.kind === "sale" ? "sale" : "purchase"}</span>
            <span className="min-w-0 flex-1 truncate text-ink">
              {l.who} <span className="text-ink-3">· {l.category}</span>
            </span>
            <span className="font-mono text-ink-3 tabular">{m(l.base)}</span>
            <span className="w-20 text-right font-mono text-ink tabular">{m(l.hst)}</span>
          </li>
        ))}
        {!shown.length && <li className="py-4 text-center text-sm text-ink-3">No records in {k} for {label(cur)}.</li>}
      </ul>
    </Card>
  );
}

function QboExport({ income, receipts, commissions, invoices }: { income: Income[]; receipts: Receipt[]; commissions: Commission[]; invoices: Invoice[] }) {
  const [fmt, setFmt] = useState<QboDateFormat>("MM/DD/YYYY");
  const lines = ledgerBankLines({ income, receipts, commissions });
  return (
    <Card title="QuickBooks Online export" hint="CSV files you upload in QuickBooks yourself (Banking → Upload from file; Sales → Import invoices). There's no QuickBooks connection. Pick the same date format QuickBooks asks for.">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={fmt} onChange={(e) => setFmt(e.target.value as QboDateFormat)} className="!h-8 !w-auto !py-0 fs-12" aria-label="Date format">
          <option value="MM/DD/YYYY">MM/DD/YYYY</option>
          <option value="DD/MM/YYYY">DD/MM/YYYY</option>
        </Select>
        <button className="pill-glass !h-8 text-xs" disabled={!lines.length} onClick={() => downloadText("qbo-bank-3col.csv", qboBankCsv(lines, 3, fmt))}>
          <Download size={13} /> Transactions (3-column)
        </button>
        <button className="pill-glass !h-8 text-xs" disabled={!lines.length} onClick={() => downloadText("qbo-bank-4col.csv", qboBankCsv(lines, 4, fmt))}>
          <Download size={13} /> Transactions (4-column)
        </button>
        <button className="pill-glass !h-8 text-xs" disabled={!invoices.length} onClick={() => downloadText("qbo-invoices.csv", qboInvoicesCsv(invoices, fmt))}>
          <Download size={13} /> Invoices
        </button>
        <span className="fs-11 text-ink-3">
          {lines.length} transactions · {invoices.length} invoices (following the filters above)
        </span>
      </div>
    </Card>
  );
}
