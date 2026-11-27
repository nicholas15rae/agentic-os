import { useState } from "react";
import { Chip, Input, money } from "@/components/ui";
import { defaultCommission, useProfiles } from "@/features/business/profiles-store";
import { COMMISSION_PICKS, commissionCalc } from "@/features/finance/commission";
import { SelectOther } from "./fields";

export interface ActingValue {
  agentId: string;
  union: boolean;
  pct: number;
  off: boolean;
  /** The agent already kept their commission from this payment. */
  deducted: boolean;
}

export const emptyActing = (): ActingValue => ({ agentId: "", union: false, pct: 0, off: false, deducted: false });

/** The commission % for an agent / union pick, from the Acting profile (0 if unknown). */
export const prefillPct = (agentId: string, union: boolean) => (agentId ? (defaultCommission(agentId, union) ?? 0) : 0);

/**
 * Acting booking: union / non-union, agent, commission (15 / 20 / 0 / custom, or off), and the
 * live "commission owed / you keep" as the amount and choices change.
 */
export function ActingFields({ gross, value, onChange, currency }: { gross: number; value: ActingValue; onChange: (v: ActingValue) => void; currency: string }) {
  const agencies = useProfiles((s) => s.doc.profiles.acting?.agencies ?? []);
  const [custom, setCustom] = useState(!(COMMISSION_PICKS as readonly number[]).includes(value.pct));
  const set = (p: Partial<ActingValue>) => {
    const next = { ...value, ...p };
    // A new agent / union choice re-reads that agent's default rate.
    if (("agentId" in p && p.agentId !== value.agentId) || ("union" in p && p.union !== value.union)) {
      next.pct = prefillPct(next.agentId, next.union);
      setCustom(!(COMMISSION_PICKS as readonly number[]).includes(next.pct));
    }
    onChange(next);
  };
  const { commission, net } = commissionCalc(gross, value.pct, value.off);
  return (
    <div className="col-span-full space-y-2 r-12 border border-white/[0.06] bg-white/[0.02] p-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip active={!value.union} onClick={() => set({ union: false })}>
          Non-union
        </Chip>
        <Chip active={value.union} onClick={() => set({ union: true })}>
          Union
        </Chip>
        <span className="w-48">
          <SelectOther label="Agent" value={value.agentId} options={[{ value: "", label: "No agent" }, ...agencies.map((a) => ({ value: a.id, label: a.name }))]} onChange={(agentId) => set({ agentId })} placeholder="Agent's name" />
        </span>
      </div>
      {value.agentId && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="fs-12 text-ink-3">Commission</span>
          {COMMISSION_PICKS.map((p) => (
            <Chip key={p} active={!value.off && !custom && value.pct === p} onClick={() => {
                setCustom(false);
                set({ pct: p, off: false });
              }}>
              {p}%
            </Chip>
          ))}
          <Chip active={!value.off && custom} onClick={() => setCustom(true)}>
            Custom
          </Chip>
          {custom && !value.off && <Input inputMode="decimal" value={String(value.pct)} onChange={(e) => set({ pct: Math.min(100, Math.max(0, Number(e.target.value) || 0)) })} aria-label="Custom commission %" className="!h-8 !w-20 !py-0 font-mono fs-12" />}
          <label className="ml-2 flex items-center gap-1.5 fs-12 text-ink-2">
            <input type="checkbox" checked={value.off} onChange={(e) => set({ off: e.target.checked })} className="accent-amber" /> No commission on this one
          </label>
          <label className="flex items-center gap-1.5 fs-12 text-ink-2">
            <input type="checkbox" checked={value.deducted} onChange={(e) => set({ deducted: e.target.checked })} className="accent-amber" /> Agent already took it
          </label>
        </div>
      )}
      {value.agentId && (
        <p className="font-mono fs-12 tabular">
          <span className="text-amber-light">Commission {value.deducted ? "kept by agent" : "owed"}: {money(commission, currency)}</span>
          <span className="text-ink-3"> · </span>
          <span className="text-teal-soft">You keep {money(net, currency)}</span>
        </p>
      )}
    </div>
  );
}
