import { useState } from "react";
import { Check, Copy, Printer } from "lucide-react";
import type { ShotSlot } from "./contract";
import { framingLabel } from "./shot-print";

/** Phone / print view: the filming checklist in one column with big type, one big tap target per
 * shot (framing, what to do, phone tips), plus Copy as text and Print. `.shot-print` is what the
 * print stylesheet keeps (director.css). Props only. */
export function ShotChecklistView({ slots, onToggle, onCopy, onPrint }: { slots: ShotSlot[]; onToggle: (slotId: string) => void; onCopy?: () => Promise<boolean>; onPrint?: () => void }) {
  const [copied, setCopied] = useState<"ok" | "fail" | null>(null);
  const done = slots.filter((s) => s.filmed).length;
  const copy = async () => {
    if (!onCopy) return;
    const ok = await onCopy();
    setCopied(ok ? "ok" : "fail");
    setTimeout(() => setCopied(null), 2000);
  };
  return (
    <div className="shot-print" data-testid="shot-print">
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <p className="mr-auto text-[14px] text-ink-2" role="status">
          {done} of {slots.length} filmed
        </p>
        {onCopy && (
          <button type="button" onClick={() => void copy()} className="no-print pill-glass !h-9 !px-3 text-xs" title="Copy the shot list as plain text (for notes or a chat)">
            {copied === "ok" ? <Check size={12} /> : <Copy size={12} />} {copied === "ok" ? "Copied" : copied === "fail" ? "Copy failed" : "Copy as text"}
          </button>
        )}
        {onPrint && (
          <button type="button" onClick={onPrint} className="no-print pill-glass !h-9 !px-3 text-xs" title="Print the shot list">
            <Printer size={12} /> Print
          </button>
        )}
      </div>
      <ul className="space-y-2">
        {slots.map((s, i) => {
          const what = s.action || s.instructions;
          return (
            <li key={s.id}>
              <button
                type="button"
                role="checkbox"
                aria-checked={s.filmed}
                aria-label={`Filmed: ${s.label}`}
                onClick={() => onToggle(s.id)}
                className={`flex min-h-[64px] w-full items-start gap-3 rounded-[16px] border px-3 py-3 text-left transition-colors ${s.filmed ? "border-teal/50 bg-teal/10" : "border-white/15 bg-white/[0.02]"}`}
              >
                <span className={`mt-0.5 grid size-9 shrink-0 place-items-center rounded-full border-2 ${s.filmed ? "border-teal bg-teal text-black" : "border-white/30"}`}>{s.filmed && <Check size={18} />}</span>
                <span className="min-w-0 flex-1">
                  <span className={`block text-[17px] font-semibold leading-snug ${s.filmed ? "text-ink-2 line-through" : "text-ink"}`}>
                    {i + 1}. {s.label}
                  </span>
                  {(s.framing || s.targetSec != null) && <span className="mt-0.5 block text-[13px] font-medium text-amber-soft">{[framingLabel(s.framing), s.targetSec != null ? `${s.targetSec}s` : ""].filter(Boolean).join(" · ")}</span>}
                  {what && <span className="mt-1 block text-[15px] leading-snug text-ink-2">{what}</span>}
                  {s.phoneTips.length > 0 && (
                    <span className="mt-1 block space-y-0.5">
                      {s.phoneTips.map((t) => (
                        <span key={t} className="block text-[13px] leading-snug text-ink-3">
                          · {t}
                        </span>
                      ))}
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
