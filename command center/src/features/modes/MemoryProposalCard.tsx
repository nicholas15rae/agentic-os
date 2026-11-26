import { useState } from "react";
import { BookMarked, Check, X } from "lucide-react";
import { useVoice } from "@/features/voice/voice-store";
import type { PendingMemory } from "./learning";
import { afterDecision, decideMemory } from "./memory-proposals";

/**
 * Decision 5: Tony's Learning-mode proposals under his reply ("Want me to add that to my core
 * memories?"), one row each with Save / Skip (the DispatchCard pattern). Save makes it a core
 * memory (every Tony prompt); Skip drops it. A spoken / typed "yes" / "no" right after this reply
 * answers it too; once the conversation moves on, only the card does. Same card on the desktop
 * and the phone (`decideMemory` picks the path).
 */
export function MemoryProposalCard({ turnId, items }: { turnId: string; items: PendingMemory[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const decide = async (p: PendingMemory, approve: boolean) => {
    setBusy(p.id);
    setErr(null);
    try {
      const saved = await decideMemory(p.id, approve);
      const s = useVoice.getState();
      const turn = s.turns.find((t) => t.id === turnId) ?? { pendingMemory: items };
      s.updateTurn(turnId, afterDecision(turn, p.id, saved));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  if (!items.length) return null;
  return (
    <div className="mt-1 w-full rounded-[10px] border border-teal/25 bg-teal/[0.04] p-2 text-[11px]" aria-label="Core memory proposal">
      <div className="mb-1 flex items-center gap-2">
        <BookMarked size={11} className="text-teal" aria-hidden />
        <span className="label-caps text-ink-3">Core memory</span>
        <span className="text-amber-light">needs your yes</span>
      </div>
      <ul className="space-y-1.5">
        {items.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-2">
            <span className="w-20 shrink-0 font-mono uppercase text-ink-2" title={p.category}>
              {p.category.replace(/_/g, " ")}
            </span>
            <span className="min-w-0 flex-1 break-words text-ink">{p.text}</span>
            <span className="flex shrink-0 gap-1.5">
              <button type="button" disabled={busy !== null} onClick={() => void decide(p, true)} className="pill-primary !h-7 !px-3 text-[11px]">
                <Check size={11} aria-hidden /> Save
              </button>
              <button type="button" disabled={busy !== null} onClick={() => void decide(p, false)} className="pill-glass !h-7 !px-3 text-[11px]">
                <X size={11} aria-hidden /> Skip
              </button>
            </span>
          </li>
        ))}
      </ul>
      {err && <p className="mt-1 text-alert">{err}</p>}
    </div>
  );
}
