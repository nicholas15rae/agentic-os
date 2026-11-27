import { beforeEach, describe, expect, it, vi } from "vitest";

const created: { c: string; data: Record<string, unknown> }[] = [];
vi.mock("@/lib/cc-api", () => ({
  collections: {
    create: vi.fn(async (c: string, data: Record<string, unknown>) => {
      created.push({ c, data });
      return { ...data, id: `${c}-${created.length}` };
    }),
  },
}));
vi.mock("@/features/business/profiles-store", async () => {
  const { withDefaults } = await import("@/features/business/profiles");
  return { useProfiles: { getState: () => ({ doc: withDefaults(null) }) } };
});

import { bookIncome } from "./book";

const base = { date: "2026-11-03", client: "Prod Co", description: "Day player", amount: 1000, taxCollected: 0, method: "cheque", area: "acting" };

describe("bookIncome", () => {
  beforeEach(() => {
    created.length = 0;
  });

  it("an acting booking through an agent books the income and what's owed to the agent", async () => {
    await bookIncome(base, { agentId: "ml_talent", union: true, pct: 15, off: false, deducted: false });
    expect(created.map((x) => x.c)).toEqual(["income", "commissions"]);
    expect(created[0].data).toMatchObject({ agentId: "ml_talent", union: true, commissionPct: 15 });
    expect(created[1].data).toMatchObject({ agentName: "ML Talent (Imperious Inc.)", amount: 150, paid: false, incomeId: "income-1", area: "acting" });
  });

  it("agent already took it → recorded as paid; commission off or no agent → no commission", async () => {
    await bookIncome(base, { agentId: "imperious", union: false, pct: 20, off: false, deducted: true });
    expect(created[1].data).toMatchObject({ amount: 200, paid: true, paidMethod: "deducted" });
    created.length = 0;
    await bookIncome(base, { agentId: "imperious", union: false, pct: 20, off: true, deducted: false });
    await bookIncome({ ...base, area: "trades_contracting" }, null);
    expect(created.map((x) => x.c)).toEqual(["income", "income"]);
  });
});
