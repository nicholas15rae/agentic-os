import { Check } from "lucide-react";
import type { ShotSlot } from "./contract";

/** Phone view: just the filming checklist, one big tap target per shot. Props only. */
export function ShotChecklistView({ slots, onToggle }: { slots: ShotSlot[]; onToggle: (slotId: string) => void }) {
  const done = slots.filter((s) => s.filmed).length;
  return (
    <div>
      <p className="mb-2 text-[12px] text-ink-2" role="status">
        {done} of {slots.length} filmed
      </p>
      <ul className="space-y-2">
        {slots.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              role="checkbox"
              aria-checked={s.filmed}
              onClick={() => onToggle(s.id)}
              className={`flex min-h-[60px] w-full items-center gap-3 rounded-[16px] border px-3 py-2.5 text-left transition-colors ${s.filmed ? "border-teal/50 bg-teal/10" : "border-white/15 bg-white/[0.02]"}`}
            >
              <span className={`grid size-8 shrink-0 place-items-center rounded-full border-2 ${s.filmed ? "border-teal bg-teal text-black" : "border-white/30"}`}>{s.filmed && <Check size={16} />}</span>
              <span className="min-w-0 flex-1">
                <span className={`block text-[15px] font-medium ${s.filmed ? "text-ink-2 line-through" : "text-ink"}`}>{s.label}</span>
                <span className="block text-[12px] text-ink-2">{[s.framing, s.action || s.instructions].filter(Boolean).join(" · ")}</span>
                {s.phoneTips.length > 0 && <span className="mt-0.5 block text-[11px] text-ink-3">{s.phoneTips.join(" · ")}</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
