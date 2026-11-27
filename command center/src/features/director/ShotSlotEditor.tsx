import { useState } from "react";
import { Check } from "lucide-react";
import { Select } from "@/components/ui";
import type { Framing, MediaKind, ShotSlot } from "./contract";
import { FRAMINGS, MAX_PHONE_TIPS, SLOT_SOURCES } from "./manifest";

export type SlotPatch = Partial<Omit<ShotSlot, "id" | "assetId" | "status">>;

interface SlotForm {
  label: string;
  instructions: string;
  kind: MediaKind;
  targetSec: string;
  framing: Framing | "";
  action: string;
  source: ShotSlot["source"];
  phoneTips: string;
}

const toForm = (s: ShotSlot | null): SlotForm => ({
  label: s?.label ?? "",
  instructions: s?.instructions ?? "",
  kind: s?.kind ?? "video",
  targetSec: s?.targetSec != null ? String(s.targetSec) : "",
  framing: s?.framing ?? "",
  action: s?.action ?? "",
  source: s?.source ?? "film",
  phoneTips: (s?.phoneTips ?? []).join("\n"),
});

/** The form as a slot patch (the manifest ops clamp the rest). Pure. */
export function slotFormPatch(f: SlotForm): SlotPatch {
  const t = f.targetSec.trim() === "" ? null : Number(f.targetSec);
  return {
    label: f.label,
    instructions: f.instructions,
    kind: f.kind,
    targetSec: t != null && Number.isFinite(t) ? t : null,
    framing: f.framing || null,
    action: f.action,
    source: f.source,
    phoneTips: f.phoneTips
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(0, MAX_PHONE_TIPS),
  };
}

/** Inline add / edit form for one shot-list slot. */
export function ShotSlotEditor({ slot, onSave, onCancel }: { slot: ShotSlot | null; onSave: (p: SlotPatch) => void; onCancel: () => void }) {
  const [f, setF] = useState<SlotForm>(() => toForm(slot));
  const set = <K extends keyof SlotForm>(k: K, v: SlotForm[K]) => setF((x) => ({ ...x, [k]: v }));
  const cls = "field !h-8 !py-0 text-[12px]";
  return (
    <form
      className="space-y-1.5 rounded-[14px] border border-teal/30 bg-teal/[0.04] p-2.5"
      aria-label={slot ? `Edit ${slot.label}` : "New shot"}
      onSubmit={(e) => {
        e.preventDefault();
        onSave(slotFormPatch(f));
      }}
    >
      <input autoFocus value={f.label} onChange={(e) => set("label", e.target.value)} placeholder="Label (e.g. 15s hook)" className={cls} aria-label="Shot label" />
      <div className="grid grid-cols-3 gap-1.5">
        <Select value={f.kind} onChange={(e) => set("kind", e.target.value as MediaKind)} className="!h-8 !py-0 text-[12px]" aria-label="Media kind">
          <option value="video">video</option>
          <option value="image">image</option>
          <option value="audio">audio</option>
        </Select>
        <Select value={f.framing} onChange={(e) => set("framing", e.target.value as Framing | "")} className="!h-8 !py-0 text-[12px]" aria-label="Framing">
          <option value="">framing…</option>
          {FRAMINGS.map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </Select>
        <input type="number" min={0.2} max={600} step={0.1} value={f.targetSec} onChange={(e) => set("targetSec", e.target.value)} placeholder="sec" className={cls} aria-label="Target length in seconds" />
      </div>
      <div className="flex gap-1" role="radiogroup" aria-label="Who supplies it">
        {SLOT_SOURCES.map((s) => (
          <button key={s} type="button" role="radio" aria-checked={f.source === s} onClick={() => set("source", s)} className={`h-7 flex-1 rounded-full border text-[11px] ${f.source === s ? "border-amber/60 bg-amber/15 text-ink" : "border-white/10 text-ink-2"}`}>
            {s}
          </button>
        ))}
      </div>
      <input value={f.action} onChange={(e) => set("action", e.target.value)} placeholder="Action: what happens in the shot" className={cls} aria-label="Action" />
      <textarea value={f.instructions} onChange={(e) => set("instructions", e.target.value)} rows={2} placeholder="Notes for the shot" className="field min-h-[44px] resize-y text-[12px]" aria-label="Instructions" />
      <textarea value={f.phoneTips} onChange={(e) => set("phoneTips", e.target.value)} rows={2} placeholder={`Phone tips, one per line (up to ${MAX_PHONE_TIPS})`} className="field min-h-[44px] resize-y text-[12px]" aria-label="Phone tips" />
      <div className="flex gap-1.5">
        <button type="submit" className="pill-primary !h-7 !px-2.5 text-[11px]">
          <Check size={11} /> {slot ? "Save shot" : "Add shot"}
        </button>
        <button type="button" onClick={onCancel} className="pill-glass !h-7 !px-2.5 text-[11px]">
          Cancel
        </button>
      </div>
    </form>
  );
}
