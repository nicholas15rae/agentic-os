/**
 * Pending money (owed to you), agent commissions (owed by you), and expenses & mileage typed in
 * by hand. Every list follows the Finance area / agent / month / year filters.
 */
import { useState } from "react";
import { CheckCircle2, Loader2, MapPin, Phone, Plus, Trash2 } from "lucide-react";
import { Card, Chip, Input, money } from "@/components/ui";
import { useCollection, type Item } from "@/lib/cc-api";
import { cmd, isTauri } from "@/lib/platform";
import { useProfiles } from "@/features/business/profiles-store";
import { applyFilter, localIso } from "@/features/finance/areas";
import { owedByAgent } from "@/features/finance/commission";
import { useAreas, useFinanceFilter } from "@/features/finance/filter-store";
import { kmFromRoute, mileageTotals, mileageValue, parseKm } from "@/features/finance/mileage";
import { CATEGORIES, PAY_METHODS, type Commission, type MileageTrip, type Pending, type Receipt } from "@/features/finance/types";
import { useSettings } from "@/stores/settings";
import { AreaSelect, AreaTag, EditButton, EditFields, QuestionMark, SelectOther, type FieldSpec } from "./fields";
import { bookIncome } from "./book";
import { ContactChip, ContactSelect } from "@/features/contacts/ContactSelect";
import { linkOrCreate } from "@/features/contacts/phonebook-store";
import { areaTaxRate } from "./LedgerPanels";

const small = "!h-9 !py-1 fs-13";
const row = "group flex flex-wrap items-center gap-3 r-12 border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-sm";
const del = "text-ink-3 opacity-100 hover:text-alert md:opacity-0 md:group-hover:opacity-100";
const defaultArea = (a: string) => (a !== "all" && a !== "untagged" ? a : "");

// ── Pending money ────────────────────────────────────────────────────────────

const PENDING_FIELDS: FieldSpec[] = [
  { key: "who", label: "Who", type: "text" },
  { key: "phone", label: "Phone", type: "text" },
  { key: "amount", label: "Amount (before HST)", type: "number" },
  { key: "date", label: "Expected", type: "date" },
  { key: "area", label: "Area", type: "area" },
  { key: "what", label: "What for", type: "text" },
  { key: "method", label: "How they'll pay", type: "select", options: PAY_METHODS },
  { key: "saveContact", label: "Save contact", type: "check" },
];

export function PendingPanel() {
  const { items, create, update, remove } = useCollection<Pending>("pending");
  const filter = useFinanceFilter((s) => s.filter);
  const currency = useSettings((s) => s.business.currency);
  const [d, setD] = useState({ amount: "", date: localIso(Date.now() + 7 * 86_400_000), who: "", phone: "", what: "", area: defaultArea(filter.area), saveContact: false, contactId: "" });
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const rows = applyFilter(items, filter).sort((a, b) => Number(a.paid) - Number(b.paid) || a.date.localeCompare(b.date));
  const open = rows.filter((p) => !p.paid);

  const markPaid = async (p: Item<Pending>) => {
    setBusy(p.id);
    try {
      const rate = areaTaxRate(p.area);
      const inc = await bookIncome({
        date: localIso(Date.now()),
        client: p.who,
        description: p.what || "Pending payment",
        amount: p.amount,
        taxCollected: Math.round(p.amount * rate) / 100,
        method: p.method || "e-transfer",
        area: p.area,
        phone: p.phone,
        pendingId: p.id,
      });
      await update(p.id, { paid: true, paidAt: Date.now(), incomeId: inc.id });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card title="Pending money" hint={`${open.length} waiting · ${money(open.reduce((s, p) => s + p.amount, 0), currency)}. It stays in To do until you mark it paid, then it moves into Income by itself.`}>
      <form
        className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-[1fr_1.2fr_1fr_1fr_1.2fr_1.2fr_auto]"
        onSubmit={async (e) => {
          e.preventDefault();
          const amount = Number(d.amount);
          if (!d.who || !amount) return;
          // "Save contact" files the person in the phone book (or finds them there) and links them.
          let contactId = d.contactId || undefined;
          if (d.saveContact && !contactId) {
            try {
              contactId = (await linkOrCreate({ name: d.who, phone: d.phone || undefined, group: d.area || undefined, source: "finance" })).id;
            } catch {
              /* the payment is still recorded; the contact can be linked later */
            }
          }
          await create({ amount, date: d.date, who: d.who, phone: d.phone || undefined, what: d.what || undefined, area: d.area || undefined, paid: false, saveContact: d.saveContact || undefined, contactId });
          setD({ ...d, amount: "", who: "", phone: "", what: "", saveContact: false, contactId: "" });
        }}
      >
        <Input inputMode="decimal" value={d.amount} onChange={(e) => setD({ ...d, amount: e.target.value })} placeholder="Amount" className={`${small} font-mono`} aria-label="Amount" />
        <Input value={d.who} onChange={(e) => setD({ ...d, who: e.target.value })} placeholder="Who owes it" className={small} aria-label="Who" />
        <Input type="tel" value={d.phone} onChange={(e) => setD({ ...d, phone: e.target.value })} placeholder="Phone" className={small} aria-label="Phone" />
        <Input type="date" value={d.date} onChange={(e) => setD({ ...d, date: e.target.value })} className={small} aria-label="Expected by" />
        <AreaSelect value={d.area || undefined} onChange={(area) => setD({ ...d, area })} />
        <Input value={d.what} onChange={(e) => setD({ ...d, what: e.target.value })} placeholder="What for" className={small} aria-label="What for" />
        <button className="pill-primary !h-9 text-xs">
          <Plus size={13} /> Add
        </button>
        <div className="col-span-full flex flex-wrap items-center gap-3 fs-12 text-ink-2">
          <span className="flex min-w-[220px] items-center gap-1.5">
            From the phone book
            <ContactSelect
              value={d.contactId}
              className={`${small} min-w-0 flex-1`}
              onChange={(c) => setD(c ? { ...d, contactId: c.id, who: d.who || c.company || c.name, phone: d.phone || c.phones[0]?.number || "" } : { ...d, contactId: "" })}
            />
          </span>
          {!d.contactId && (
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={d.saveContact} onChange={(e) => setD({ ...d, saveContact: e.target.checked })} className="accent-teal" /> Save contact (adds them to the phone book and links them)
            </label>
          )}
        </div>
      </form>
      <ul className="space-y-1.5">
        {rows.map((p) => {
          const late = !p.paid && p.date < localIso(Date.now());
          return (
            <li key={p.id} className={`${row} ${p.paid ? "opacity-60" : ""}`}>
              <span className={`font-mono fs-12 ${late ? "text-alert" : "text-ink-3"}`}>{p.date}</span>
              <AreaTag area={p.area} onAssign={(area) => void update(p.id, { area })} />
              <span className="min-w-0 flex-1 truncate text-ink">
                {p.who} {p.what && <span className="text-ink-3">· {p.what}</span>} <QuestionMark q={p.question} />
              </span>
              <ContactChip id={p.contactId} className="max-w-[180px]" />
              {p.phone && (
                <a href={`tel:${p.phone.replace(/[^\d+]/g, "")}`} className="flex items-center gap-1 font-mono fs-11 text-ink-3 hover:text-teal">
                  <Phone size={11} /> {p.phone}
                </a>
              )}
              <span className="font-mono text-ink tabular">{money(p.amount, currency)}</span>
              {p.paid ? (
                <span className="fs-11 text-teal">paid · in Income</span>
              ) : (
                <button onClick={() => void markPaid(p)} disabled={busy === p.id} className="pill-glass !h-8 text-xs">
                  {busy === p.id ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />} Mark paid
                </button>
              )}
              <EditButton onClick={() => setEditing(editing === p.id ? null : p.id)} label={`Edit pending from ${p.who}`} />
              <button aria-label={`Delete pending from ${p.who}`} onClick={() => void remove(p.id)} className={del}>
                <Trash2 size={13} />
              </button>
              {editing === p.id && (
                <>
                  <EditFields spec={PENDING_FIELDS} value={p as unknown as Record<string, unknown>} onPatch={(x) => void update(p.id, x as Partial<Pending>)} onClose={() => setEditing(null)} />
                  <span className="flex w-full items-center gap-1.5 fs-12 text-ink-2">
                    Phone-book contact
                    <ContactSelect value={p.contactId} className={`${small} min-w-0 max-w-xs flex-1`} onChange={(c) => void update(p.id, { contactId: c?.id ?? undefined })} />
                  </span>
                </>
              )}
            </li>
          );
        })}
        {!rows.length && <li className="py-6 text-center text-sm text-ink-3">{items.length ? "Nothing matches the filters." : "Nothing pending. Add money someone owes you above."}</li>}
      </ul>
    </Card>
  );
}

// ── Agent commissions ────────────────────────────────────────────────────────

const COMMISSION_FIELDS: FieldSpec[] = [
  { key: "date", label: "Booking date", type: "date" },
  { key: "agentName", label: "Agent", type: "text" },
  { key: "client", label: "Booking", type: "text" },
  { key: "gross", label: "Fee", type: "number" },
  { key: "pct", label: "Commission %", type: "number" },
  { key: "amount", label: "Owed", type: "number" },
  { key: "paidMethod", label: "Paid by", type: "select", options: ["cheque", "e-transfer", "cash", "deducted"] },
  { key: "notes", label: "Notes", type: "text" },
];

export function CommissionsPanel() {
  const { items, update, remove } = useCollection<Commission>("commissions");
  const filter = useFinanceFilter((s) => s.filter);
  const currency = useSettings((s) => s.business.currency);
  const [editing, setEditing] = useState<string | null>(null);
  const [method, setMethod] = useState("e-transfer");
  const rows = applyFilter(items, filter).sort((a, b) => Number(a.paid) - Number(b.paid) || b.date.localeCompare(a.date));
  const totals = owedByAgent(rows);
  return (
    <div className="space-y-4">
      <Card title="Owed to agents" hint="Every paid acting booking through an agent adds what you owe them. Mark it paid when you send it (or tick “agent already took it” when you log the booking).">
        <div className="grid gap-2 sm:grid-cols-3">
          {totals.map((t) => (
            <div key={t.agentId} className="r-14 border border-white/[0.07] bg-white/[0.02] p-3">
              <p className="truncate text-sm text-ink">{t.agentName}</p>
              <p className={`font-mono text-lg tabular ${t.owed > 0 ? "text-amber-light" : "text-teal-soft"}`}>{money(t.owed, currency)}</p>
              <p className="fs-11 text-ink-3">
                {t.unpaidCount} unpaid · {money(t.paid, currency)} paid so far
              </p>
            </div>
          ))}
          {!totals.length && <p className="col-span-full py-4 text-center text-sm text-ink-3">No commissions yet. Log an Acting payment with an agent in Income or Scan.</p>}
        </div>
      </Card>
      <Card
        title="Commissions"
        action={
          <span className="flex items-center gap-1.5 fs-11 text-ink-3">
            Mark paid by
            <span className="w-36">
              <SelectOther label="Paid by" value={method} options={["e-transfer", "cheque", "cash"]} onChange={setMethod} className="!h-8 !py-0 fs-12" />
            </span>
          </span>
        }
      >
        <ul className="space-y-1.5">
          {rows.map((c) => (
            <li key={c.id} className={`${row} ${c.paid ? "opacity-60" : ""}`}>
              <span className="font-mono fs-12 text-ink-3">{c.date}</span>
              <span className="min-w-0 flex-1 truncate text-ink">
                {c.agentName} <span className="text-ink-3">· {c.client} · {c.pct}% of {money(c.gross, currency)}</span> <QuestionMark q={c.question} />
              </span>
              <span className="font-mono text-amber-light tabular">{money(c.amount, currency)}</span>
              {c.paid ? (
                <button className="fs-11 text-teal hover:text-ink" title="Mark unpaid" onClick={() => void update(c.id, { paid: false, paidAt: undefined, paidMethod: undefined })}>
                  paid · {c.paidMethod === "deducted" ? "agent kept it" : c.paidMethod}
                </button>
              ) : (
                <button onClick={() => void update(c.id, { paid: true, paidAt: Date.now(), paidMethod: method })} className="pill-glass !h-8 text-xs">
                  <CheckCircle2 size={12} /> Paid
                </button>
              )}
              <EditButton onClick={() => setEditing(editing === c.id ? null : c.id)} label={`Edit commission for ${c.agentName}`} />
              <button aria-label={`Delete commission for ${c.agentName}`} onClick={() => void remove(c.id)} className={del}>
                <Trash2 size={13} />
              </button>
              {editing === c.id && <EditFields spec={COMMISSION_FIELDS} value={c as unknown as Record<string, unknown>} onPatch={(x) => void update(c.id, x as Partial<Commission>)} onClose={() => setEditing(null)} />}
            </li>
          ))}
          {!rows.length && <li className="py-6 text-center text-sm text-ink-3">{items.length ? "Nothing matches the filters." : "Nothing owed."}</li>}
        </ul>
      </Card>
    </div>
  );
}

// ── Expenses (typed in) & mileage ────────────────────────────────────────────

const r2 = (n: number) => Math.round(n * 100) / 100;

export function ExpensesPanel() {
  const receipts = useCollection<Receipt>("receipts");
  const filter = useFinanceFilter((s) => s.filter);
  const currency = useSettings((s) => s.business.currency);
  const [d, setD] = useState({ date: localIso(Date.now()), vendor: "", category: "materials", amount: "", hst: "", area: defaultArea(filter.area), notes: "", question: "" });
  const manual = applyFilter(receipts.items, filter).filter((r) => r.source === "manual").sort((a, b) => b.date.localeCompare(a.date)).slice(0, 12);
  const sub = Number(d.amount) || 0;
  const hst = d.hst === "" ? null : Number(d.hst);
  return (
    <div className="space-y-4">
      <Card title="Add an expense" hint="For anything without a scan. It lands in the Tax table with the receipts; you can attach a photo later by scanning it.">
        <form
          className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_1.4fr_1.1fr_1fr_0.9fr_1.2fr_auto]"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!d.vendor || !sub) return;
            await receipts.create({
              vendor: d.vendor,
              date: d.date,
              subtotal: r2(sub),
              gst: null,
              hst: hst == null ? null : r2(hst),
              pst: null,
              qst: null,
              tip: null,
              total: r2(sub + (hst ?? 0)),
              currency,
              category: d.category,
              verified: true,
              source: "manual",
              area: d.area || undefined,
              notes: d.notes || undefined,
              question: d.question || undefined,
            });
            setD({ ...d, vendor: "", amount: "", hst: "", notes: "", question: "" });
          }}
        >
          <Input type="date" value={d.date} onChange={(e) => setD({ ...d, date: e.target.value })} className={small} aria-label="Date" />
          <Input value={d.vendor} onChange={(e) => setD({ ...d, vendor: e.target.value })} placeholder="Paid to (store, person)" className={small} aria-label="Vendor" />
          <SelectOther label="Category" value={d.category} options={CATEGORIES} onChange={(category) => setD({ ...d, category })} />
          <Input inputMode="decimal" value={d.amount} onChange={(e) => setD({ ...d, amount: e.target.value })} placeholder="Before tax" className={`${small} font-mono`} aria-label="Amount before tax" />
          <Input inputMode="decimal" value={d.hst} onChange={(e) => setD({ ...d, hst: e.target.value })} placeholder="HST paid" className={`${small} font-mono`} aria-label="HST paid" />
          <AreaSelect value={d.area || undefined} onChange={(area) => setD({ ...d, area })} />
          <button className="pill-primary !h-9 text-xs">
            <Plus size={13} /> Add
          </button>
          <Input value={d.notes} onChange={(e) => setD({ ...d, notes: e.target.value })} placeholder="What it was for (optional)" className={`col-span-2 sm:col-span-4 ${small}`} aria-label="Notes" />
          <Input value={d.question} onChange={(e) => setD({ ...d, question: e.target.value })} placeholder="Question for accountant (optional)" className={`col-span-2 sm:col-span-3 ${small}`} aria-label="Question for accountant" />
        </form>
        {manual.length > 0 && (
          <ul className="mt-3 space-y-1">
            {manual.map((r) => (
              <li key={r.id} className="flex items-center gap-3 fs-13">
                <span className="font-mono fs-12 text-ink-3">{r.date}</span>
                <AreaTag area={r.area} onAssign={(area) => void receipts.update(r.id, { area })} />
                <span className="min-w-0 flex-1 truncate text-ink">
                  {r.vendor} <span className="text-ink-3">· {r.category}</span>
                </span>
                <span className="font-mono tabular text-ink">{money(r.total, currency)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <MileageLog />
    </div>
  );
}

const MILEAGE_FIELDS: FieldSpec[] = [
  { key: "date", label: "Date", type: "date" },
  { key: "from", label: "From", type: "text" },
  { key: "to", label: "To", type: "text" },
  { key: "purpose", label: "Purpose", type: "text" },
  { key: "km", label: "km", type: "number" },
  { key: "area", label: "Area", type: "area" },
  { key: "roundTrip", label: "Round trip", type: "check" },
  { key: "notes", label: "Notes", type: "text" },
];

function MileageLog() {
  const { items, create, update, remove } = useCollection<MileageTrip>("mileage");
  const filter = useFinanceFilter((s) => s.filter);
  const { label } = useAreas();
  const rate = useProfiles((s) => s.doc.finance?.kmRate ?? 0.72);
  const currency = useSettings((s) => s.business.currency);
  const [d, setD] = useState({ date: localIso(Date.now()), from: "", to: "", purpose: "", km: "", area: defaultArea(filter.area), roundTrip: true, fromMaps: false });
  const [routing, setRouting] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const rows = applyFilter(items, filter).sort((a, b) => b.date.localeCompare(a.date));
  const totals = mileageTotals(rows, rate);

  const measure = async () => {
    if (!d.to.trim()) return setRouting("Type where you went first.");
    setRouting("Working out the distance…");
    try {
      const from = d.from.trim();
      const r = await cmd("map_route", { destination: d.to.trim(), ...(from && !/^home$/i.test(from) ? { origin: from } : {}) });
      setD({ ...d, km: String(kmFromRoute(r.distanceM, d.roundTrip)), fromMaps: true });
      setRouting(`About ${kmFromRoute(r.distanceM)} km each way by the shortest driving route (an estimate: no live traffic, no detours).`);
    } catch (e) {
      setRouting(`Couldn't get a distance (${e instanceof Error ? e.message : String(e)}). Type the km instead.`);
    }
  };

  return (
    <Card title="Mileage log" hint={`At ${money(rate, currency)}/km (change it under Areas & rates). Distances from the maps connection are estimates; your odometer wins.`}>
      <form
        className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_1.2fr_1.2fr_1.4fr_0.8fr_1.2fr_auto]"
        onSubmit={async (e) => {
          e.preventDefault();
          const km = parseKm(d.km);
          if (!d.to || km == null) return setRouting("Add where you went and the km.");
          await create({ date: d.date, from: d.from || "Home", to: d.to, purpose: d.purpose, km, kmSource: d.fromMaps ? "maps" : "manual", roundTrip: d.roundTrip, area: d.area || undefined });
          setD({ ...d, to: "", purpose: "", km: "", fromMaps: false });
          setRouting(null);
        }}
      >
        <Input type="date" value={d.date} onChange={(e) => setD({ ...d, date: e.target.value })} className={small} aria-label="Date" />
        <Input value={d.from} onChange={(e) => setD({ ...d, from: e.target.value })} placeholder="From (blank = home)" className={small} aria-label="From" />
        <Input value={d.to} onChange={(e) => setD({ ...d, to: e.target.value, fromMaps: false })} placeholder="To" className={small} aria-label="To" />
        <Input value={d.purpose} onChange={(e) => setD({ ...d, purpose: e.target.value })} placeholder="Purpose (site visit, audition…)" className={small} aria-label="Purpose" />
        <Input inputMode="decimal" value={d.km} onChange={(e) => setD({ ...d, km: e.target.value, fromMaps: false })} placeholder="km" className={`${small} font-mono`} aria-label="Kilometres" />
        <AreaSelect value={d.area || undefined} onChange={(area) => setD({ ...d, area })} />
        <button className="pill-primary !h-9 text-xs">
          <Plus size={13} /> Log
        </button>
        <div className="col-span-full flex flex-wrap items-center gap-2">
          <Chip active={d.roundTrip} onClick={() => setD({ ...d, roundTrip: !d.roundTrip, fromMaps: false })}>
            Round trip
          </Chip>
          {isTauri() && (
            <button type="button" onClick={() => void measure()} className="pill-glass !h-8 text-xs">
              <MapPin size={12} /> Get distance from maps
            </button>
          )}
          {routing && <span className="fs-11 text-ink-3">{routing}</span>}
        </div>
      </form>
      {totals.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {totals.map((t) => (
            <span key={t.area} className="rounded-full border border-white/10 px-2.5 py-1 font-mono fs-11 text-ink-2">
              {label(t.area)}: {t.km} km · {money(t.value, currency)} (estimate)
            </span>
          ))}
        </div>
      )}
      <ul className="mt-3 space-y-1.5">
        {rows.map((t) => (
          <li key={t.id} className={row}>
            <span className="font-mono fs-12 text-ink-3">{t.date}</span>
            <AreaTag area={t.area} onAssign={(area) => void update(t.id, { area })} />
            <span className="min-w-0 flex-1 truncate text-ink">
              {t.from} → {t.to}
              {t.roundTrip ? " and back" : ""} <span className="text-ink-3">· {t.purpose}</span> <QuestionMark q={t.question} />
            </span>
            <span className="font-mono fs-12 text-ink-2 tabular" title={t.kmSource === "maps" ? "From maps: an estimate" : "Typed in"}>
              {t.km} km{t.kmSource === "maps" ? " ≈" : ""}
            </span>
            <span className="font-mono text-ink tabular">{money(mileageValue(t.km, rate), currency)}</span>
            <EditButton onClick={() => setEditing(editing === t.id ? null : t.id)} label="Edit trip" />
            <button aria-label="Delete trip" onClick={() => void remove(t.id)} className={del}>
              <Trash2 size={13} />
            </button>
            {editing === t.id && <EditFields spec={MILEAGE_FIELDS} value={t as unknown as Record<string, unknown>} onPatch={(x) => void update(t.id, { ...(x as Partial<MileageTrip>), ...("km" in x ? { kmSource: "manual" as const } : {}) })} onClose={() => setEditing(null)} />}
          </li>
        ))}
        {!rows.length && <li className="py-6 text-center text-sm text-ink-3">{items.length ? "Nothing matches the filters." : "No trips logged."}</li>}
      </ul>
    </Card>
  );
}
