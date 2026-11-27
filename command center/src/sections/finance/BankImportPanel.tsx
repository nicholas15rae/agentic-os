/**
 * Bank / credit-card statement import: pick a CSV you downloaded from your bank, check the columns,
 * and the lines are stored read-only ("statement_lines") and matched against your own records.
 * Unmatched lines are flagged for review. No bank connection: files only.
 */
import { useMemo, useState } from "react";
import { CheckCircle2, EyeOff, Loader2, Upload } from "lucide-react";
import { Card, Chip, Select, money } from "@/components/ui";
import { cc, useCollection } from "@/lib/cc-api";
import { applyFilter, localIso } from "@/features/finance/areas";
import { candidatesFrom, detectColumns, matchLines, parseCsv, toLines, type ColumnMap } from "@/features/finance/csv-import";
import { useFinanceFilter } from "@/features/finance/filter-store";
import { CATEGORIES, type Check, type Commission, type Income, type Receipt, type StatementLine } from "@/features/finance/types";
import { useSettings } from "@/stores/settings";
import { AreaTag, SelectOther } from "./fields";

const MAX_BYTES = 2 * 1024 * 1024;

export function BankImportPanel() {
  const lines = useCollection<StatementLine>("statement_lines");
  const income = useCollection<Income>("income").items;
  const receipts = useCollection<Receipt>("receipts");
  const checks = useCollection<Check>("checks").items;
  const commissions = useCollection<Commission>("commissions").items;
  const filter = useFinanceFilter((s) => s.filter);
  const currency = useSettings((s) => s.business.currency);
  const [raw, setRaw] = useState<string[][] | null>(null);
  const [fileName, setFileName] = useState("");
  const [map, setMap] = useState<ColumnMap | null>(null);
  const [account, setAccount] = useState("Chequing");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState<"review" | "all">("review");
  const [windowDays, setWindowDays] = useState(5);

  const preview = useMemo(() => (raw && map ? toLines(raw, map) : null), [raw, map]);
  const stored = applyFilter(lines.items, { ...filter, area: "all", agent: "all" });
  const matched = useMemo(() => {
    const cands = candidatesFrom({ income, receipts: receipts.items, checks, commissions });
    // Lines you already linked by hand keep that record; the rest are matched fresh.
    const linked = new Set(stored.filter((l) => l.status === "matched" && l.match).map((l) => `${l.match!.collection}:${l.match!.id}`));
    const open = stored.filter((l) => l.status !== "matched" && l.status !== "ignored");
    return new Map(matchLines(open, cands.filter((c) => !linked.has(`${c.collection}:${c.id}`)), windowDays).map((x) => [x.line.id, x.match]));
  }, [stored, income, receipts.items, checks, commissions, windowDays]);

  const pick = async (file: File | undefined) => {
    setMsg(null);
    if (!file) return;
    if (file.size > MAX_BYTES) return setMsg("That file is over 2 MB: export a shorter date range.");
    const rows = parseCsv(await file.text());
    setFileName(file.name);
    setRaw(rows);
    const guess = detectColumns(rows);
    setMap(guess ?? { hasHeader: true, date: 0, description: 1, amount: 2 });
    setMsg(guess ? null : "Couldn't tell the columns apart: pick them below.");
  };

  const save = async () => {
    if (!preview?.lines.length) return;
    setBusy(true);
    try {
      const r = await cc.statementImport({ importId: `${localIso(Date.now())}-${fileName}`.slice(0, 64), account: account.trim() || "Bank", lines: preview.lines });
      setMsg(`Imported ${r.added} line${r.added === 1 ? "" : "s"}${r.skipped ? ` (${r.skipped} already there, skipped)` : ""}.`);
      setRaw(null);
      setMap(null);
      void lines.refresh();
    } catch (e) {
      setMsg(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const rows = stored
    .map((l) => ({ l, m: l.status === "matched" ? (l.match ?? null) : (matched.get(l.id) ?? null) }))
    .filter(({ l, m }) => show === "all" || (!m && l.status !== "ignored" && l.status !== "reviewed"))
    .sort((a, b) => b.l.date.localeCompare(a.l.date));
  const unmatched = stored.filter((l) => l.status === "unmatched" && !matched.get(l.id)).length;

  return (
    <div className="space-y-4">
      <Card title="Import a statement" hint="Download a CSV from your bank or card website and pick it here. It's only read: the lines are kept as a copy for matching, never sent anywhere.">
        <div className="flex flex-wrap items-center gap-2">
          <label className="pill-primary cursor-pointer !h-9 text-xs">
            <Upload size={13} /> Choose CSV
            <input type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => void pick(e.target.files?.[0])} />
          </label>
          <span className="w-44">
            <SelectOther label="Account" value={account} options={["Chequing", "Savings", "Credit card", "Business chequing"]} onChange={setAccount} placeholder="Account name" />
          </span>
          {fileName && raw && <span className="text-[12px] text-ink-3">{fileName}</span>}
        </div>
        {msg && <p className="mt-2 text-xs text-amber-light">{msg}</p>}
        {raw && map && <ColumnMapper rows={raw} map={map} onChange={setMap} />}
        {preview && (
          <div className="mt-3">
            <p className="text-[12px] text-ink-2">
              {preview.lines.length} lines read{preview.skipped ? ` · ${preview.skipped} rows skipped (no date or amount)` : ""}. First few:
            </p>
            <ul className="mt-1 space-y-0.5 font-mono text-[12px] text-ink-2">
              {preview.lines.slice(0, 5).map((l, i) => (
                <li key={i}>
                  {l.date} · {l.description} · <span className={l.amount < 0 ? "text-alert" : "text-teal"}>{money(l.amount, currency)}</span>
                </li>
              ))}
            </ul>
            <button className="pill-primary mt-2 !h-9 text-xs" disabled={busy || !preview.lines.length} onClick={() => void save()}>
              {busy ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />} Import {preview.lines.length} lines
            </button>
          </div>
        )}
      </Card>

      <Card
        title="Statement lines"
        hint={`${unmatched} not matched to anything you've logged. A match = same amount within ${windowDays} days. Matching never changes your records.`}
        action={
          <span className="flex items-center gap-1.5">
            <Chip active={show === "review"} onClick={() => setShow("review")}>
              To review
            </Chip>
            <Chip active={show === "all"} onClick={() => setShow("all")}>
              All
            </Chip>
            <Select value={String(windowDays)} onChange={(e) => setWindowDays(Number(e.target.value))} className="!h-8 !w-auto !py-0 text-[12px]" aria-label="Date window">
              {[2, 5, 10, 30].map((d) => (
                <option key={d} value={d}>
                  ± {d} days
                </option>
              ))}
            </Select>
          </span>
        }
      >
        <ul className="space-y-1.5">
          {rows.map(({ l, m }) => (
            <li key={l.id} className="flex flex-wrap items-center gap-3 rounded-[12px] border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-sm">
              <span className="font-mono text-[12px] text-ink-3">{l.date}</span>
              <span className="text-[11px] text-ink-3">{l.account}</span>
              <span className="min-w-0 flex-1 truncate text-ink">{l.description}</span>
              <span className={`font-mono tabular ${l.amount < 0 ? "text-ink" : "text-teal-soft"}`}>{money(l.amount, currency)}</span>
              {m ? (
                <span className="flex items-center gap-1.5 text-[11px] text-teal">
                  <CheckCircle2 size={12} /> {m.label}
                  {l.status !== "matched" && (
                    <button className="text-ink-3 underline hover:text-ink" onClick={() => void lines.update(l.id, { status: "matched", match: m })}>
                      confirm
                    </button>
                  )}
                </span>
              ) : (
                <>
                  <AreaTag area={l.area} onAssign={(area) => void lines.update(l.id, { area })} />
                  {l.amount < 0 && (
                    <button
                      className="pill-glass !h-7 text-[11px]"
                      title="Log it as an expense (you can edit it in the Tax table)"
                      onClick={async () => {
                        const r = await receipts.create({ vendor: l.description.slice(0, 80), date: l.date, subtotal: -l.amount, gst: null, hst: null, pst: null, qst: null, tip: null, total: -l.amount, currency, category: l.category || "other", verified: false, source: "statement", area: l.area, notes: `From statement (${l.account})` });
                        await lines.update(l.id, { status: "matched", match: { collection: "receipts", id: r.id, label: `Expense · ${r.vendor}` } });
                      }}
                    >
                      + expense
                    </button>
                  )}
                  <span className="w-28">
                    <SelectOther label="Category" value={l.category ?? ""} options={CATEGORIES} onChange={(category) => void lines.update(l.id, { category })} className="!h-7 !py-0 text-[11px]" />
                  </span>
                  <button className="flex items-center gap-1 text-[11px] text-ink-3 hover:text-ink" onClick={() => void lines.update(l.id, { status: "reviewed" })} title="Checked: nothing to log">
                    <CheckCircle2 size={11} /> ok
                  </button>
                  <button className="flex items-center gap-1 text-[11px] text-ink-3 hover:text-ink" onClick={() => void lines.update(l.id, { status: "ignored" })} title="Personal / transfer: ignore">
                    <EyeOff size={11} /> ignore
                  </button>
                </>
              )}
            </li>
          ))}
          {!rows.length && <li className="py-6 text-center text-sm text-ink-3">{stored.length ? "Everything is matched or reviewed." : "No statements imported yet."}</li>}
        </ul>
      </Card>
    </div>
  );
}

/** Pick which column is which when the layout wasn't recognised (or to fix a guess). */
function ColumnMapper({ rows, map, onChange }: { rows: string[][]; map: ColumnMap; onChange: (m: ColumnMap) => void }) {
  const width = Math.max(...rows.slice(0, 5).map((r) => r.length));
  const names = (map.hasHeader ? rows[0] : []).concat();
  const cols = Array.from({ length: width }, (_, i) => ({ value: String(i), label: `${i + 1}: ${names[i] || rows[map.hasHeader ? 1 : 0]?.[i] || ""}`.slice(0, 30) }));
  const pickCol = (key: "date" | "description" | "amount" | "debit" | "credit", optional = false) => (
    <label className="flex items-center gap-1 text-[12px] text-ink-2">
      {key}
      <Select
        value={map[key] == null ? "" : String(map[key])}
        onChange={(e) => onChange({ ...map, [key]: e.target.value === "" ? undefined : Number(e.target.value) })}
        className="!h-8 !w-auto !py-0 text-[12px]"
        aria-label={`${key} column`}
      >
        {optional && <option value="">—</option>}
        {cols.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </Select>
    </label>
  );
  const single = map.amount != null;
  return (
    <div className="glass-thin mt-3 space-y-2 rounded-[14px] p-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-[12px] text-ink-2">
          <input type="checkbox" checked={map.hasHeader} onChange={(e) => onChange({ ...map, hasHeader: e.target.checked })} className="accent-teal" /> First row is headings
        </label>
        <Chip active={single} onClick={() => onChange({ ...map, amount: map.amount ?? 2, debit: undefined, credit: undefined })}>
          One amount column
        </Chip>
        <Chip active={!single} onClick={() => onChange({ ...map, amount: undefined, debit: map.debit ?? 2, credit: map.credit ?? 3 })}>
          Money out / money in columns
        </Chip>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {pickCol("date")}
        {pickCol("description")}
        {single ? pickCol("amount") : (
          <>
            {pickCol("debit", true)}
            {pickCol("credit", true)}
          </>
        )}
        <label className="flex items-center gap-1.5 text-[12px] text-ink-2">
          <input type="checkbox" checked={!!map.invert} onChange={(e) => onChange({ ...map, invert: e.target.checked })} className="accent-teal" /> Flip signs (card shows purchases as +)
        </label>
        <label className="flex items-center gap-1.5 text-[12px] text-ink-2">
          <input type="checkbox" checked={!!map.dayFirst} onChange={(e) => onChange({ ...map, dayFirst: e.target.checked })} className="accent-teal" /> Dates are day/month
        </label>
      </div>
      <p className="text-[11px] text-ink-3">“debit” = money out, “credit” = money in.</p>
    </div>
  );
}
