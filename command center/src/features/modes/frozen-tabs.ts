import type { ThreadId } from "@/features/voice/voice-store";

/** Split tabs into live and frozen ("Booking Desk is frozen on the master switchboard"). Auto-route
 * and Tony are never frozen. Pure. */
export function splitFrozen(threads: readonly ThreadId[], reason: (t: ThreadId) => string | null): { live: ThreadId[]; frozen: { t: ThreadId; why: string }[] } {
  const live: ThreadId[] = [];
  const frozen: { t: ThreadId; why: string }[] = [];
  for (const t of threads) {
    const why = t === "auto" || t === "general" ? null : reason(t);
    if (why) frozen.push({ t, why });
    else live.push(t);
  }
  return { live, frozen };
}
