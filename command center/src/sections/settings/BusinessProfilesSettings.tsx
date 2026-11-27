import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ImagePlus, Lock, Plus, Trash2 } from "lucide-react";
import { Card, Field, Input, Select, SubTabs } from "@/components/ui";
import { cc } from "@/lib/cc-api";
import { useProfiles } from "@/features/business/profiles-store";
import {
  agencyIdFor,
  checkHstNumber,
  DEFAULT_CONTRACTING,
  INVOICE_STYLES,
  PROFILE_IDS,
  PROFILE_LABEL,
  PROVINCES,
  taxLabel,
  type Agency,
  type BusinessProfile,
  type ContractingDefaults,
  type KnownProfileId,
} from "@/features/business/profiles";

/** Settings → Business: one profile per business + Personal, on the local gateway. */
export function BusinessProfilesSettings() {
  const { doc, loaded, error, saving, pending, importedTo, load } = useProfiles();
  const [id, setId] = useState<KnownProfileId>("trades_contracting");
  useEffect(() => {
    void load();
  }, [load]);
  const p = doc.profiles[id];
  return (
    <div className="space-y-4">
      <p className="flex items-start gap-2 rounded-[12px] border border-teal/20 bg-teal/[0.05] px-3 py-2 text-[12px] text-ink-2">
        <Lock size={13} className="mt-0.5 shrink-0 text-teal" />
        These details stay on this machine: they're kept in your local gateway (shared with your phone over your own network) and printed on your invoices. They're never sent anywhere else.
      </p>
      {error && (
        <p className="text-sm text-alert">
          {pending
            ? `Couldn't save to the gateway: ${error}. Your changes are kept on this device and saved automatically the next time the gateway answers.`
            : loaded
              ? `Couldn't reach the gateway: ${error}.`
              : `Couldn't load your profiles from the gateway: ${error}. Anything you change here is kept on this device and merged in when it's back.`}
        </p>
      )}      {importedTo && <p className="text-[12px] text-ink-3">Your earlier business details were copied into {PROFILE_LABEL[importedTo as KnownProfileId] ?? importedTo}. Check the HST number below.</p>}
      <SubTabs tabs={PROFILE_IDS.map((x) => ({ id: x, label: PROFILE_LABEL[x] }))} value={id} onChange={setId} />
      {!loaded && !error ? <p className="text-sm text-ink-3">Loading…</p> : p && <ProfileEditor key={id} id={id} p={p} saving={saving} />}
    </div>
  );
}

function ProfileEditor({ id, p, saving }: { id: KnownProfileId; p: BusinessProfile; saving: boolean }) {
  const patch = useProfiles((s) => s.patch);
  const up = (x: Partial<BusinessProfile>) => patch(id, x);
  const personal = id === "personal";
  return (
    <>
      <Card title={`${PROFILE_LABEL[id]} details`} hint={personal ? "Your own name and address, for anything personal you invoice or file." : "Printed on this business's invoices and used for its HST/GST summary."} action={saving ? <span className="text-[11px] text-ink-3">Saving…</span> : undefined}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={personal ? "Your name" : "Legal business name"}>
            <Input value={p.name} onChange={(e) => up({ name: e.target.value })} />
          </Field>
          <Field label="Address">
            <Input value={p.address} onChange={(e) => up({ address: e.target.value })} />
          </Field>
          <Field label="Email">
            <Input type="email" value={p.email} onChange={(e) => up({ email: e.target.value })} />
          </Field>
          <Field label="Phone">
            <Input value={p.phone} onChange={(e) => up({ phone: e.target.value })} />
          </Field>
          <Field label="Province (sets the default tax rate)">
            <Select
              value={p.province}
              onChange={(e) => {
                const prov = PROVINCES.find((x) => x[0] === e.target.value)!;
                up({ province: prov[0], taxRate: prov[2] });
              }}
            >
              {PROVINCES.map(([code, name, rate]) => (
                <option key={code} value={code}>
                  {name} {rate}%
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Invoice tax rate %">
            <Input type="number" step="0.5" min={0} max={30} value={p.taxRate} onChange={(e) => up({ taxRate: Number(e.target.value) })} className="font-mono" />
          </Field>
          <Field label="Currency">
            <Select value={p.currency} onChange={(e) => up({ currency: e.target.value as BusinessProfile["currency"] })}>
              <option>CAD</option>
              <option>USD</option>
            </Select>
          </Field>
          <Field label="Invoice template">
            <Select value={p.invoiceStyle} onChange={(e) => up({ invoiceStyle: e.target.value as BusinessProfile["invoiceStyle"] })}>
              {INVOICE_STYLES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <HstField p={p} up={up} />
        <LogoField p={p} up={up} />
      </Card>
      {id === "acting" && <AgenciesCard agencies={p.agencies ?? []} set={(agencies) => up({ agencies })} />}
      {id === "trades_contracting" && <ContractingCard c={p.contracting ?? DEFAULT_CONTRACTING} set={(contracting) => up({ contracting })} currency={p.currency} />}
    </>
  );
}

function HstField({ p, up }: { p: BusinessProfile; up: (x: Partial<BusinessProfile>) => void }) {
  const check = checkHstNumber(p.hstNumber);
  const label = taxLabel(p.province);
  return (
    <div className="mt-4 space-y-2 border-t border-white/5 pt-3">
      <Field label={`${label} registration #`}>
        {/* Editing the number always takes the confirmation away again. */}
        <Input value={p.hstNumber} onChange={(e) => up({ hstNumber: e.target.value, hstConfirmed: false })} placeholder="9 digits + RT + 4 digits" className="font-mono" />
      </Field>
      {check.ok ? (
        p.hstConfirmed ? (
          <p className="flex items-center gap-2 text-[12px] text-teal-soft">
            <CheckCircle2 size={13} /> Confirmed. {check.formatted} prints on invoices.
            <button onClick={() => up({ hstConfirmed: false })} className="ml-2 text-ink-3 hover:text-ink">
              Undo
            </button>
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-2 text-[12px] text-amber-light">
            <AlertTriangle size={13} /> Not confirmed yet, so invoices leave it off.
            <button onClick={() => up({ hstNumber: check.formatted, hstConfirmed: true })} className="h-7 rounded-full bg-amber px-3 font-semibold text-canvas">
              This is my real {label} number
            </button>
          </div>
        )
      ) : (
        !check.empty && (
          <p className="flex items-center gap-2 text-[12px] text-alert">
            <AlertTriangle size={13} /> {check.reason}. Invoices leave it off until it's fixed and confirmed.
          </p>
        )
      )}
    </div>
  );
}

function LogoField({ p, up }: { p: BusinessProfile; up: (x: Partial<BusinessProfile>) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pick = async (f: File | undefined) => {
    if (!f) return;
    if (!f.type.startsWith("image/")) return setErr("Pick an image (PNG, JPG, SVG).");
    if (f.size > 2 * 1024 * 1024) return setErr("Keep the logo under 2 MB.");
    setBusy(true);
    setErr(null);
    try {
      const r = await cc.upload(f, f.name);
      up({ logoFileId: r.id });
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-white/5 pt-3">
      <span className="text-[12px] text-ink-3">Logo</span>
      {p.logoFileId ? <img src={cc.fileUrl(p.logoFileId)} alt="Logo" className="h-10 max-w-[160px] rounded bg-white/90 object-contain p-1" /> : <span className="text-[12px] text-ink-3">none</span>}
      <button onClick={() => input.current?.click()} disabled={busy} className="pill-glass !h-8 text-xs disabled:opacity-40">
        <ImagePlus size={13} /> {busy ? "Uploading…" : p.logoFileId ? "Replace" : "Upload"}
      </button>
      {p.logoFileId && (
        <button onClick={() => up({ logoFileId: "" })} className="text-[12px] text-ink-3 hover:text-alert">
          Remove
        </button>
      )}
      <input ref={input} type="file" accept="image/*" className="hidden" onChange={(e) => void pick(e.target.files?.[0])} />
      {err && <span className="text-[12px] text-alert">{err}</span>}
    </div>
  );
}

const RATE_PRESETS = ["15", "20", "0"];

/** A commission % picker: 15 / 20 / 0 / custom, or "same as principal" for a sub-agent. */
function RateInput({ value, set, inherit, label }: { value: number | null; set: (v: number | null) => void; inherit: boolean; label: string }) {
  const mode = value === null ? "inherit" : RATE_PRESETS.includes(String(value)) ? String(value) : "custom";
  return (
    <div className="flex items-center gap-1.5">
      <Select
        aria-label={label}
        value={mode}
        onChange={(e) => {
          const v = e.target.value;
          set(v === "inherit" ? null : v === "custom" ? (value ?? 10) : Number(v));
        }}
        className="!h-9 !w-auto !py-1 text-[13px]"
      >
        {inherit && <option value="inherit">Principal's</option>}
        {!inherit && value === null && <option value="inherit">Not set</option>}
        <option value="15">15%</option>
        <option value="20">20%</option>
        <option value="0">0%</option>
        <option value="custom">Custom</option>
      </Select>
      {mode === "custom" && <Input type="number" min={0} max={100} step="0.5" value={value ?? 0} onChange={(e) => set(Math.min(100, Math.max(0, Number(e.target.value) || 0)))} className="!h-9 !w-20 !py-1 font-mono text-[13px]" aria-label={`${label} custom %`} />}
    </div>
  );
}

function AgenciesCard({ agencies, set }: { agencies: Agency[]; set: (a: Agency[]) => void }) {
  const [name, setName] = useState("");
  const [parent, setParent] = useState("");
  const principals = agencies.filter((a) => !a.parentId);
  const edit = (id: string, x: Partial<Agency>) => set(agencies.map((a) => (a.id === id ? { ...a, ...x } : a)));
  // Removing a principal removes its sub-agents too (a sub-agent can't stand alone).
  const remove = (id: string) => set(agencies.filter((a) => a.id !== id && a.parentId !== id));
  const add = () => {
    const n = name.trim();
    if (!n) return;
    const id = agencyIdFor(n, agencies.map((a) => a.id));
    set([...agencies, { id, name: n, parentId: parent || null, commissionUnion: parent ? null : 15, commissionNonUnion: parent ? null : 20 }]);
    setName("");
    setParent("");
  };
  const ordered = principals.flatMap((p) => [p, ...agencies.filter((a) => a.parentId === p.id)]);
  return (
    <Card title="Agencies" hint="Your principal agent and anyone booking under them. The default commission Finance takes off each booking, union and non-union. A sub-agent left on “Principal's” uses its principal's rate.">
      <ul className="space-y-2">
        {ordered.map((a) => (
          <li key={a.id} className={`flex flex-wrap items-center gap-2 rounded-[12px] border border-white/[0.06] bg-white/[0.02] px-3 py-2 ${a.parentId ? "ml-6" : ""}`}>
            <Input value={a.name} onChange={(e) => edit(a.id, { name: e.target.value })} className="!h-9 min-w-[140px] flex-1 !py-1 text-[13px]" aria-label="Agency name" />
            <span className="text-[11px] text-ink-3">{a.parentId ? "sub-agent" : "principal"}</span>
            <span className="text-[11px] text-ink-3">Union</span>
            <RateInput value={a.commissionUnion} set={(v) => edit(a.id, { commissionUnion: v })} inherit={!!a.parentId} label={`${a.name} union commission`} />
            <span className="text-[11px] text-ink-3">Non-union</span>
            <RateInput value={a.commissionNonUnion} set={(v) => edit(a.id, { commissionNonUnion: v })} inherit={!!a.parentId} label={`${a.name} non-union commission`} />
            <button onClick={() => remove(a.id)} aria-label={`Remove ${a.name}`} className="grid size-8 place-items-center rounded-full text-ink-3 hover:text-alert">
              <Trash2 size={13} />
            </button>
          </li>
        ))}
        {!agencies.length && <li className="py-3 text-center text-sm text-ink-3">No agencies yet.</li>}
      </ul>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Agency name" className="!h-9 min-w-[160px] flex-1 !py-1 text-[13px]" onKeyDown={(e) => e.key === "Enter" && add()} />
        <Select value={parent} onChange={(e) => setParent(e.target.value)} className="!h-9 !w-auto !py-1 text-[13px]" aria-label="Books under">
          <option value="">Principal agent</option>
          {principals.map((p) => (
            <option key={p.id} value={p.id}>
              Under {p.name}
            </option>
          ))}
        </Select>
        <button onClick={add} disabled={!name.trim()} className="pill-glass !h-9 text-xs disabled:opacity-40">
          <Plus size={13} /> Add
        </button>
      </div>
    </Card>
  );
}

function ContractingCard({ c, set, currency }: { c: ContractingDefaults; set: (c: ContractingDefaults) => void; currency: string }) {
  return (
    <Card title="Job defaults" hint="What a new contracting job starts with: who does the work, and what a subcontractor is paid when it's subbed out.">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="New jobs are">
          <Select value={c.defaultWork} onChange={(e) => set({ ...c, defaultWork: e.target.value as ContractingDefaults["defaultWork"] })}>
            <option value="self">Done myself</option>
            <option value="subbed">Subbed out</option>
          </Select>
        </Field>
        <Field label="Sub rate is">
          <Select value={c.subRateMode} onChange={(e) => set({ ...c, subRateMode: e.target.value as ContractingDefaults["subRateMode"], subRate: 0 })}>
            <option value="percent">% of the job</option>
            <option value="amount">A flat amount ({currency})</option>
          </Select>
        </Field>
        <Field label={c.subRateMode === "percent" ? "Default sub rate %" : `Default sub amount (${currency})`}>
          <Input
            type="number"
            min={0}
            max={c.subRateMode === "percent" ? 100 : 1_000_000}
            step={c.subRateMode === "percent" ? "0.5" : "1"}
            value={c.subRate}
            onChange={(e) => set({ ...c, subRate: Math.max(0, Math.min(c.subRateMode === "percent" ? 100 : 1_000_000, Number(e.target.value) || 0)) })}
            className="font-mono"
          />
        </Field>
      </div>
      {c.defaultWork === "self" && <p className="mt-2 text-[11px] text-ink-3">The sub rate is only used on jobs you mark as subbed out.</p>}
    </Card>
  );
}
