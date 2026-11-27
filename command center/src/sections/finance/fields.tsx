/**
 * Small Finance form pieces: a dropdown with "Other…" (type your own), the area picker (Other…
 * adds an area), the "Untagged → assign" chip, and the inline record editor every list uses.
 */
import { useEffect, useState } from "react";
import { HelpCircle, Pencil, X } from "lucide-react";
import { Input, Select } from "@/components/ui";
import { useProfiles } from "@/features/business/profiles-store";
import { newAreaId, UNTAGGED } from "@/features/finance/areas";
import { useAreas } from "@/features/finance/filter-store";

const OTHER = "__other__";
const small = "!h-9 !py-1 text-[13px]";

/** A dropdown whose last choice is "Other…": pick it and type your own value. */
export function SelectOther({
  value,
  options,
  onChange,
  label,
  className = small,
  placeholder = "Type your own",
}: {
  value: string;
  options: readonly (string | { value: string; label: string })[];
  onChange: (v: string) => void;
  label: string;
  className?: string;
  placeholder?: string;
}) {
  const opts = options.map((o) => (typeof o === "string" ? { value: o, label: o } : o));
  const known = opts.some((o) => o.value === value);
  const [typing, setTyping] = useState(!known && value !== "");
  const [draft, setDraft] = useState(known ? "" : value);
  useEffect(() => {
    if (!opts.some((o) => o.value === value) && value !== "") {
      setTyping(true);
      setDraft(value);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  if (typing)
    return (
      <span className="flex min-w-0 gap-1">
        <Input
          autoFocus={!value}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => draft.trim() && onChange(draft.trim())}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (draft.trim()) onChange(draft.trim());
            }
          }}
          placeholder={placeholder}
          aria-label={label}
          className={`min-w-0 flex-1 ${className}`}
        />
        <button type="button" aria-label="Back to the list" title="Back to the list" onClick={() => setTyping(false)} className="grid size-9 shrink-0 place-items-center text-ink-3 hover:text-ink">
          <X size={13} />
        </button>
      </span>
    );
  return (
    <Select
      value={known ? value : ""}
      aria-label={label}
      className={className}
      onChange={(e) => {
        if (e.target.value === OTHER) {
          setDraft("");
          setTyping(true);
        } else onChange(e.target.value);
      }}
    >
      {!known && <option value="">—</option>}
      {opts.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
      <option value={OTHER}>Other…</option>
    </Select>
  );
}

/** Pick an area; "Other…" names a new one (added to your areas). */
export function AreaSelect({ value, onChange, className = small, allowUntagged = false }: { value: string | undefined; onChange: (area: string) => void; className?: string; allowUntagged?: boolean }) {
  const { areas, doc } = useAreas();
  const options = [...(allowUntagged ? [{ value: UNTAGGED, label: "Untagged" }] : []), ...areas.map((a) => ({ value: a.id, label: a.label }))];
  return (
    <SelectOther
      label="Area"
      value={value ?? (allowUntagged ? UNTAGGED : "")}
      options={options}
      className={className}
      placeholder="New area name"
      onChange={(v) => {
        if (options.some((o) => o.value === v)) return onChange(v);
        // A typed name: an existing area's label, or a new area.
        const hit = areas.find((a) => a.label.toLowerCase() === v.toLowerCase());
        if (hit) return onChange(hit.id);
        const id = newAreaId(v, doc);
        useProfiles.getState().addArea(id, v);
        onChange(id);
      }}
    />
  );
}

/** The record's area as a chip; an untagged record gets a one-tap "assign". */
export function AreaTag({ area, onAssign }: { area?: string; onAssign: (a: string) => void }) {
  const { label } = useAreas();
  const [open, setOpen] = useState(false);
  if (open) return <AreaSelect value={undefined} onChange={(a) => {
          setOpen(false);
          onAssign(a);
        }} className="!h-7 !w-36 !py-0 text-[12px]" />;
  const untagged = !area || area === UNTAGGED;
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      title={untagged ? "Assign an area" : "Change area"}
      className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider ${untagged ? "border-amber/50 text-amber-light" : "border-white/10 text-ink-3 hover:text-ink"}`}
    >
      {untagged ? "Untagged · assign" : label(area)}
    </button>
  );
}

export type FieldSpec =
  | { key: string; label: string; type: "text" | "number" | "date" }
  | { key: string; label: string; type: "select"; options: readonly (string | { value: string; label: string })[] }
  | { key: string; label: string; type: "area" }
  | { key: string; label: string; type: "check" };

/** Every field of a record, editable in place; each change saves on its own (blur / pick). */
export function EditFields({ spec, value, onPatch, onClose }: { spec: readonly FieldSpec[]; value: Record<string, unknown>; onPatch: (patch: Record<string, unknown>) => void; onClose: () => void }) {
  return (
    <div className="mt-2 w-full rounded-[12px] border border-amber/25 bg-amber/[0.04] p-2.5">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {spec.map((f) => (
          <label key={f.key} className="block min-w-0 space-y-1">
            <span className="label-caps text-[10px] text-ink-3">{f.label}</span>
            <FieldInput f={f} v={value[f.key]} onPatch={onPatch} />
          </label>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <QuestionField value={(value.question as string) ?? ""} onPatch={onPatch} />
        <button type="button" onClick={onClose} className="pill-glass ml-auto !h-8 text-xs">
          Done
        </button>
      </div>
    </div>
  );
}

function FieldInput({ f, v, onPatch }: { f: FieldSpec; v: unknown; onPatch: (p: Record<string, unknown>) => void }) {
  const [draft, setDraft] = useState(v == null ? "" : String(v));
  useEffect(() => setDraft(v == null ? "" : String(v)), [v]);
  if (f.type === "area") return <AreaSelect value={(v as string) || undefined} onChange={(a) => onPatch({ [f.key]: a })} />;
  if (f.type === "select") return <SelectOther label={f.label} value={(v as string) ?? ""} options={f.options} onChange={(x) => onPatch({ [f.key]: x })} />;
  if (f.type === "check")
    return (
      <input type="checkbox" checked={!!v} onChange={(e) => onPatch({ [f.key]: e.target.checked })} className="accent-teal" aria-label={f.label} />
    );
  const commit = () => {
    if (draft === (v == null ? "" : String(v))) return;
    if (f.type === "number") {
      const n = draft.trim() === "" ? null : Number(draft.replace(/[$,\s]/g, ""));
      if (n !== null && !Number.isFinite(n)) return setDraft(v == null ? "" : String(v));
      onPatch({ [f.key]: n });
    } else onPatch({ [f.key]: draft });
  };
  return (
    <Input
      type={f.type === "date" ? "date" : "text"}
      inputMode={f.type === "number" ? "decimal" : undefined}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
      }}
      aria-label={f.label}
      className={`${small} ${f.type === "number" ? "font-mono" : ""}`}
    />
  );
}

/** "Question for accountant": a note on the record. The app never decides deductibility. */
function QuestionField({ value, onPatch }: { value: string; onPatch: (p: Record<string, unknown>) => void }) {
  const [on, setOn] = useState(!!value);
  const [draft, setDraft] = useState(value);
  if (!on)
    return (
      <button type="button" onClick={() => setOn(true)} className="pill-glass !h-8 text-xs">
        <HelpCircle size={12} /> Question for accountant
      </button>
    );
  return (
    <span className="flex min-w-60 flex-1 items-center gap-1.5">
      <HelpCircle size={13} className="shrink-0 text-amber" />
      <Input value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => onPatch({ question: draft.trim() })} placeholder="What to ask your accountant (e.g. is this deductible?)" aria-label="Question for accountant" className={`flex-1 ${small}`} />
    </span>
  );
}

/** The pencil that opens a row's inline editor. */
export function EditButton({ onClick, label = "Edit" }: { onClick: () => void; label?: string }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className="grid size-7 place-items-center rounded-full text-ink-3 hover:bg-white/10 hover:text-ink">
      <Pencil size={12} />
    </button>
  );
}

/** A "?" marker for records with a question for the accountant. */
export function QuestionMark({ q }: { q?: string }) {
  if (!q) return null;
  return (
    <span title={`Question for accountant: ${q}`} className="text-amber">
      <HelpCircle size={12} className="inline" aria-label={`Question for accountant: ${q}`} />
    </span>
  );
}
