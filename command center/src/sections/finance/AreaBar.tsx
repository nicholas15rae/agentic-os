import { useState } from "react";
import { Plus, Settings2 } from "lucide-react";
import { Chip, Input, Select } from "@/components/ui";
import { useProfiles } from "@/features/business/profiles-store";
import { PROFILE_LABEL, type HstPeriod, type KnownProfileId } from "@/features/business/profiles";
import { MONTH_NAMES, MONTHS, newAreaId, UNTAGGED } from "@/features/finance/areas";
import { useAreas, useFinanceFilter } from "@/features/finance/filter-store";
import { prefixFor } from "@/features/finance/invoice-number";

const sel = "!h-8 !w-auto !py-0 text-[12px]";

/** The area switcher and filters (agent, month, year) every Finance tab follows. */
export function AreaBar({ years }: { years: string[] }) {
  const { areas } = useAreas();
  const { filter, set, reset } = useFinanceFilter();
  const agencies = useProfiles((s) => s.doc.profiles.acting?.agencies ?? []);
  const [manage, setManage] = useState(false);
  const busy = filter.area !== "all" || filter.agent !== "all" || filter.month !== "all" || filter.year !== "all";
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip active={filter.area === "all"} onClick={() => set({ area: "all" })}>
          All areas
        </Chip>
        {areas.map((a) => (
          <Chip key={a.id} active={filter.area === a.id} onClick={() => set({ area: a.id, ...(a.id !== "acting" ? { agent: "all" } : {}) })}>
            {a.label}
          </Chip>
        ))}
        <Chip active={filter.area === UNTAGGED} onClick={() => set({ area: UNTAGGED })} tone="teal">
          Untagged
        </Chip>
        <span className="mx-1 h-5 w-px bg-white/10" />
        {(filter.area === "all" || filter.area === "acting") && (
          <Select value={filter.agent} onChange={(e) => set({ agent: e.target.value })} className={sel} aria-label="Filter by agent">
            <option value="all">Any agent</option>
            {agencies.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        )}
        <Select value={filter.month} onChange={(e) => set({ month: e.target.value })} className={sel} aria-label="Filter by month">
          <option value="all">Any month</option>
          {MONTHS.map((m, i) => (
            <option key={m} value={m}>
              {MONTH_NAMES[i]}
            </option>
          ))}
        </Select>
        <Select value={filter.year} onChange={(e) => set({ year: e.target.value })} className={sel} aria-label="Filter by year">
          <option value="all">Any year</option>
          {years.map((y) => (
            <option key={y}>{y}</option>
          ))}
        </Select>
        {busy && (
          <button onClick={reset} className="text-[11px] text-ink-3 hover:text-ink">
            Clear
          </button>
        )}
        <button onClick={() => setManage(!manage)} aria-expanded={manage} className="ml-auto flex items-center gap-1 text-[11px] text-ink-3 hover:text-ink">
          <Settings2 size={12} /> Areas & rates
        </button>
      </div>
      {manage && <ManageAreas />}
    </div>
  );
}

/** Rename areas, add one, and set each area's HST period, tax set-aside % and invoice prefix. */
function ManageAreas() {
  const { areas, doc } = useAreas();
  const patch = useProfiles((s) => s.patch);
  const kmRate = useProfiles((s) => s.doc.finance?.kmRate ?? 0.72);
  const [name, setName] = useState("");
  return (
    <div className="glass-thin space-y-2 rounded-[14px] p-3">
      <p className="text-[11px] text-ink-3">Business details (name, HST number, address) are in Settings → Business. The set-aside % is your own estimate for planning, not tax advice.</p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-[12px]">
          <thead>
            <tr className="label-caps text-left text-[10px] text-ink-3 [&>th]:pb-1 [&>th]:pr-2">
              <th>Area name</th>
              <th>HST filing</th>
              <th>Set aside %</th>
              <th>Invoice prefix</th>
            </tr>
          </thead>
          <tbody>
            {areas.map((a) => {
              const p = doc.profiles[a.id];
              return (
                <tr key={a.id} className="[&>td]:py-1 [&>td]:pr-2">
                  <td>
                    <Input defaultValue={p?.label ?? ""} placeholder={PROFILE_LABEL[a.id as KnownProfileId] ?? a.id} onBlur={(e) => patch(a.id, { label: e.target.value.trim() })} aria-label={`Name for ${a.label}`} className="!h-8 !py-0 text-[12px]" />
                  </td>
                  <td>
                    <Select value={p?.hstPeriod ?? "quarterly"} onChange={(e) => patch(a.id, { hstPeriod: e.target.value as HstPeriod })} className="!h-8 !py-0 text-[12px]" aria-label={`HST filing for ${a.label}`}>
                      <option value="monthly">Monthly</option>
                      <option value="quarterly">Quarterly</option>
                      <option value="yearly">Yearly</option>
                    </Select>
                  </td>
                  <td>
                    <Input
                      inputMode="decimal"
                      defaultValue={String(p?.setAsidePct ?? (a.business ? 25 : 0))}
                      onBlur={(e) => {
                        const n = Number(e.target.value);
                        if (Number.isFinite(n) && n >= 0 && n <= 90) patch(a.id, { setAsidePct: n });
                      }}
                      aria-label={`Set aside % for ${a.label}`}
                      className="!h-8 !w-20 !py-0 font-mono text-[12px]"
                    />
                  </td>
                  <td>
                    <Input
                      defaultValue={p?.invoicePrefix ?? ""}
                      placeholder={prefixFor(a.id)}
                      onBlur={(e) => patch(a.id, { invoicePrefix: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6) })}
                      aria-label={`Invoice prefix for ${a.label}`}
                      className="!h-8 !w-24 !py-0 font-mono text-[12px]"
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <form
          className="flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            const n = name.trim();
            if (!n || areas.some((a) => a.label.toLowerCase() === n.toLowerCase())) return;
            useProfiles.getState().addArea(newAreaId(n, doc), n);
            setName("");
          }}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="New area (e.g. Rentals)" aria-label="New area name" className="!h-8 !py-0 text-[12px]" />
          <button className="pill-glass !h-8 shrink-0 text-xs">
            <Plus size={12} /> Add area
          </button>
        </form>
        <label className="ml-auto flex items-center gap-1.5 text-[12px] text-ink-2">
          Mileage $ / km
          <Input
            inputMode="decimal"
            defaultValue={String(kmRate)}
            onBlur={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n) && n >= 0 && n <= 10) useProfiles.getState().patchFinance({ kmRate: n });
            }}
            aria-label="Mileage rate per km"
            className="!h-8 !w-20 !py-0 font-mono text-[12px]"
          />
        </label>
      </div>
    </div>
  );
}
