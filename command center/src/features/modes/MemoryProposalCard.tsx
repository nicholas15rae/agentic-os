import { useEffect, useState } from "react";
import { BookMarked, Check, X } from "lucide-react";
import { useVoice } from "@/features/voice/voice-store";
import type { MemoryCardEnd, PendingMemory } from "./learning";
import { afterDecision, decideMemory, settleCardsAfterRestart } from "./memory-proposals";

/** What an ended card says in place of "needs your yes" and the buttons. */
export const CARD_END_LABEL: Record<MemoryCardEnd, string> = {
  saved: "Saved",
  known: "Already a core memory",
  skipped: "Skipped",
  gone: "No longer pending",
};

/**
 * Decision 5: Tony's Learning-mode proposals under his reply ("Want me to add that to my core
 * memories?"), one row each with Save / Skip (the DispatchCard pattern). Save makes it a core
 * memory (every Tony prompt); Skip drops it. A spoken / typed "yes" / "no" right after this reply
 * answers it too; once the conversation moves on, only the card does. Same card on the desktop
 * and the phone (`decideMemory` picks the path).
 * The card never outlives its proposals with live buttons: `end` (a later spoken / typed answer,
 * or a desktop restart) or `expiresAt` passing (Rust's 10-minute TTL) shows the rows with what
 * became of them instead.
 */
export function MemoryProposalCard({ turnId, items, end, expiresAt }: { turnId: string; items: PendingMemory[]; end?: MemoryCardEnd; expiresAt?: number }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const shown: MemoryCardEnd | null = end ?? (expiresAt !== undefined && now >= expiresAt ? "gone" : null);
  // Re-render as the proposals expire, so the buttons go when Rust drops them.
  useEffect(() => {
    if (shown || expiresAt === undefined) return;
    const t = setTimeout(() => setNow(Date.now()), Math.max(0, expiresAt - Date.now()) + 50);
    return () => clearTimeout(t);
  }, [shown, expiresAt, now]);
  // Desktop app: cards from before this run of the app are no longer pending (once per load).
  useEffect(() => {
    if (!shown) void settleCardsAfterRestart();
  }, [shown]);
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
    <div className={`mt-1 w-full r-10 border p-2 fs-11 ${shown ? "border-white/10 bg-white/[0.02]" : "border-teal/25 bg-teal/[0.04]"}`} aria-label="Core memory proposal">
      <div className="mb-1 flex items-center gap-2">
        <BookMarked size={11} className={shown ? "text-ink-3" : "text-teal"} aria-hidden />
        <span className="label-caps text-ink-3">Core memory</span>
        {shown ? <span className={shown === "gone" ? "text-ink-3" : "text-teal"}>{CARD_END_LABEL[shown]}</span> : <span className="text-amber-light">needs your yes</span>}
      </div>
      <ul className="space-y-1.5">
        {items.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-2">
            <span className="w-20 shrink-0 font-mono uppercase text-ink-2" title={p.category}>
              {p.category.replace(/_/g, " ")}
            </span>
            <span className={`min-w-0 flex-1 break-words ${shown ? "text-ink-2" : "text-ink"}`}>{p.text}</span>
            {!shown && (
              <span className="flex shrink-0 gap-1.5">
                <button type="button" disabled={busy !== null} onClick={() => void decide(p, true)} className="pill-primary !h-7 !px-3 fs-11">
                  <Check size={11} aria-hidden /> Save
                </button>
                <button type="button" disabled={busy !== null} onClick={() => void decide(p, false)} className="pill-glass !h-7 !px-3 fs-11">
                  <X size={11} aria-hidden /> Skip
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {err && !shown && <p className="mt-1 text-alert">{err}</p>}
    </div>
  );
}
