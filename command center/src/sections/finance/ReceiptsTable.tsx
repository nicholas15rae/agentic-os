import { Fragment, useMemo, useState } from "react";
import { AlertTriangle, Download, Image as ImageIcon, Search, Sparkles, Trash2 } from "lucide-react";
import { Card, Input, Select, downloadText, money, toCsv } from "@/components/ui";
import { cc, useCollection, type Item } from "@/lib/cc-api";
import { CATEGORIES, quarterOf, receiptItc, type Receipt } from "@/features/finance/types";
import { useSettings } from "@/stores/settings";
import { applyFilter } from "@/features/finance/areas";
import { useAreas, useFinanceFilter } from "@/features/finance/filter-store";
import { AreaTag, EditButton, EditFields, QuestionMark, SelectOther, type FieldSpec } from "./fields";

const RECEIPT_FIELDS: FieldSpec[] = [
  { key: "date", label: "Date", type: "date" },
  { key: "vendor", label: "Vendor", type: "text" },
  { key: "category", label: "Category", type: "select", options: CATEGORIES },
  { key: "area", label: "Area", type: "area" },
  { key: "subtotal", label: "Subtotal", type: "number" },
  { key: "gst", label: "GST", type: "number" },
  { key: "hst", label: "HST", type: "number" },
  { key: "pst", label: "PST", type: "number" },
  { key: "qst", label: "QST", type: "number" },
  { key: "tip", label: "Tip", type: "number" },
  { key: "total", label: "Total", type: "number" },
  { key: "inReturn", label: "In HST return", type: "check" },
  { key: "notes", label: "Notes", type: "text" },
];

/** The HST/GST tax table: searchable, filterable by quarter/category, exportable. */
export function ReceiptsTable() {
  const { items, remove, update, error } = useCollection<Receipt>("receipts");
  const currency = useSettings((s) => s.business.currency);
  const filter = useFinanceFilter((s) => s.filter);
  const { label } = useAreas();
  const [editing, setEditing] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [quarter, setQuarter] = useState("all");
  const [cat, setCat] = useState("all");
  const [semantic, setSemantic] = useState<Set<string> | null>(null);
  const [searching, setSearching] = useState(false);

  const quarters = useMemo(() => [...new Set(items.map((r) => quarterOf(r.date)))].sort().reverse(), [items]);
  const rows = applyFilter(items, filter)
    .filter((r) => quarter === "all" || quarterOf(r.date) === quarter)
    .filter((r) => cat === "all" || r.category === cat)
    .filter((r) => (semantic ? semantic.has(r.id) : !q || `${r.vendor} ${r.category} ${r.notes ?? ""} ${r.total ?? ""}`.toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => b.date.localeCompare(a.date));

  const sum = (k: keyof Receipt) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
  const itc = rows.reduce((s, r) => s + receiptItc(r), 0);

  const askVault = async () => {
    if (!q.trim()) return setSemantic(null);
    setSearching(true);
    try {
      const res = await cc.search(q, ["receipts"], 50);
      setSemantic(new Set(res.results.map((r) => r.id)));
    } finally {
      setSearching(false);
    }
  };

  const exportCsv = () =>
    downloadText(
      `tax-table-${quarter === "all" ? "all" : quarter.replace(" ", "-")}.csv`,
      toCsv(rows.map((r) => ({ ...r, areaName: label(r.area), inReturnText: r.inReturn === false ? "no" : "yes" })) as unknown as Record<string, unknown>[], [
        { key: "date", label: "Date" },
        { key: "areaName", label: "Area" },
        { key: "vendor", label: "Vendor" },
        { key: "category", label: "Category" },
        { key: "subtotal", label: "Subtotal" },
        { key: "gst", label: "GST" },
        { key: "hst", label: "HST" },
        { key: "pst", label: "PST" },
        { key: "qst", label: "QST" },
        { key: "tip", label: "Tip" },
        { key: "total", label: "Total" },
        { key: "currency", label: "Currency" },
        { key: "regime", label: "Tax regime" },
        { key: "notes", label: "Notes" },
        { key: "inReturnText", label: "In HST return" },
        { key: "question", label: "Question for accountant" },
      ]),
    );

  return (
    <Card
      title="Tax table · receipts & bills"
      action={
        <button onClick={exportCsv} className="pill-glass !h-8 text-xs" disabled={!rows.length}>
          <Download size={13} /> CSV
        </button>
      }
    >
      <div className="mb-3 flex flex-wrap gap-2">
        <form
          className="flex min-w-56 flex-1 gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void askVault();
          }}
        >
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
            <Input
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setSemantic(null);
              }}
              placeholder="Filter… or ask: “gas for the Whitby job”"
              className="!h-9 !py-1 !pl-9 fs-13"
              aria-label="Search receipts"
            />
          </div>
          <button className="pill-glass !h-9 shrink-0 text-xs" title="Semantic search in the vault" disabled={!q.trim() || searching}>
            <Sparkles size={13} /> {semantic ? `${semantic.size} found` : "Ask"}
          </button>
        </form>
        <Select value={quarter} onChange={(e) => setQuarter(e.target.value)} className="!h-9 !w-auto !py-1 fs-13" aria-label="Quarter">
          <option value="all">All quarters</option>
          {quarters.map((x) => (
            <option key={x}>{x}</option>
          ))}
        </Select>
        <Select value={cat} onChange={(e) => setCat(e.target.value)} className="!h-9 !w-auto !py-1 fs-13" aria-label="Category">
          <option value="all">All categories</option>
          {CATEGORIES.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </Select>
      </div>
      {error && <p className="mb-2 text-xs text-alert">Gateway: {error}</p>}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left fs-13">
          <thead>
            <tr className="label-caps text-ink-3 [&>th]:px-2 [&>th]:pb-2">
              <th>Date</th>
              <th>Vendor</th>
              <th>Category</th>
              <th className="text-right">Subtotal</th>
              <th className="text-right">GST</th>
              <th className="text-right">HST</th>
              <th className="text-right">PST/QST</th>
              <th className="text-right">Total</th>
              <th />
            </tr>
          </thead>
          <tbody className="font-mono tabular">
            {rows.map((r) => (
              <Fragment key={r.id}>
                <Row r={r} currency={currency} onDelete={() => void remove(r.id)} onPatch={(p) => void update(r.id, p)} onEdit={() => setEditing(editing === r.id ? null : r.id)} />
                {editing === r.id && (
                  <tr>
                    <td colSpan={9} className="font-sans">
                      <EditFields spec={RECEIPT_FIELDS} value={{ ...r, inReturn: r.inReturn !== false } as unknown as Record<string, unknown>} onPatch={(p) => void update(r.id, p as Partial<Receipt>)} onClose={() => setEditing(null)} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={9} className="py-8 text-center font-sans text-ink-3">
                  No receipts yet. Use Scan to capture one.
                </td>
              </tr>
            )}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <tr className="border-t border-white/10 font-mono text-ink tabular [&>td]:px-2 [&>td]:pt-2">
                <td colSpan={3} className="font-sans text-ink-2">
                  {rows.length} receipts · ITCs {money(itc, currency)}
                </td>
                <td className="text-right">{money(sum("subtotal"), currency)}</td>
                <td className="text-right">{money(sum("gst"), currency)}</td>
                <td className="text-right">{money(sum("hst"), currency)}</td>
                <td className="text-right">{money(sum("pst") + sum("qst"), currency)}</td>
                <td className="text-right text-amber-light">{money(sum("total"), currency)}</td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </Card>
  );
}

function Row({ r, currency, onDelete, onPatch, onEdit }: { r: Item<Receipt>; currency: string; onDelete: () => void; onPatch: (p: Partial<Receipt>) => void; onEdit: () => void }) {
  const flagged = (r.flags?.length ?? 0) > 0;
  return (
    <tr className="group border-t border-white/[0.05] [&>td]:px-2 [&>td]:py-1.5">
      <td className="text-ink-2">{r.date}</td>
      <td className="max-w-[260px] truncate font-sans text-ink" title={r.notes}>
        {flagged && <AlertTriangle size={12} className="mr-1 inline text-alert" aria-label={r.flags!.join("; ")} />}
        {r.vendor} <QuestionMark q={r.question} />
        <span className="ml-1.5">
          <AreaTag area={r.area} onAssign={(area) => onPatch({ area })} />
        </span>
      </td>
      <td className="font-sans">
        <span className="block w-32">
          <SelectOther label="Category" value={r.category} options={CATEGORIES} onChange={(category) => onPatch({ category })} className="!h-7 !py-0 fs-12" />
        </span>
      </td>
      <td className="text-right text-ink-2">{money(r.subtotal, currency)}</td>
      <td className="text-right text-ink-2">{r.gst ? money(r.gst, currency) : "—"}</td>
      <td className="text-right text-ink-2">{r.hst ? money(r.hst, currency) : "—"}</td>
      <td className="text-right text-ink-2">{r.pst || r.qst ? money((r.pst ?? 0) + (r.qst ?? 0), currency) : "—"}</td>
      <td className="text-right text-ink">{money(r.total, currency)}</td>
      <td className="whitespace-nowrap text-right">
        <span className="inline-block align-middle">
          <EditButton onClick={onEdit} label={`Edit ${r.vendor}`} />
        </span>
        {r.imageFileId && (
          <a href={cc.fileUrl(r.imageFileId)} target="_blank" rel="noreferrer" aria-label="View scan" className="inline-grid size-7 place-items-center rounded-full text-ink-3 hover:text-teal">
            <ImageIcon size={13} />
          </a>
        )}
        <button onClick={onDelete} aria-label={`Delete ${r.vendor}`} className="inline-grid size-7 place-items-center rounded-full text-ink-3 opacity-100 hover:text-alert md:opacity-0 md:group-hover:opacity-100">
          <Trash2 size={13} />
        </button>
      </td>
    </tr>
  );
}
