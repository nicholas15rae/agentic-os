/**
 * Booking money in, the one way every Finance path does it (typed, scanned, a pending payment
 * marked paid, an invoice marked paid): the income entry, then — for an acting booking through an
 * agent — what you owe that agent.
 */
import { collections } from "@/lib/cc-api";
import { useProfiles } from "@/features/business/profiles-store";
import { commissionFor } from "@/features/finance/commission";
import type { Commission, Income } from "@/features/finance/types";
import type { ActingValue } from "./ActingFields";

export async function bookIncome(income: Income, acting?: ActingValue | null) {
  const withActing: Income =
    acting && acting.agentId ? { ...income, agentId: acting.agentId, union: acting.union, commissionPct: acting.pct, commissionOff: acting.off || undefined } : income;
  const saved = await collections.create<Income>("income", withActing);
  const c = commissionFor(saved, useProfiles.getState().doc.profiles.acting?.agencies, { deducted: !!acting?.deducted });
  if (c) await collections.create<Commission>("commissions", c);
  return saved;
}
