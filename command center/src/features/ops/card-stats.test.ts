import { describe, expect, it } from "vitest";
import { businessCardStats, type CardInputs } from "./card-stats";

const NOW = new Date(2026, 10, 15, 12).getTime();
const DAY = 86_400_000;
const empty = (): CardInputs => ({ income: [], invoices: [], checks: [], pipeline: [], projects: [], reminders: [] });
const income = (date: string, amount: number, area?: string) => ({ date, client: "c", description: "", amount, taxCollected: 0, method: "cash" as const, ...(area ? { area } : {}) });
const invoice = (status: "sent" | "paid" | "overdue" | "draft", total: number, area?: string, dueAt = NOW + 5 * DAY) => ({ number: `INV-${total}`, client: "c", items: [{ desc: "", qty: 1, rate: total }], taxRate: 0, issuedAt: NOW, dueAt, status, ...(area ? { area } : {}) });

describe("business card stats", () => {
  it("untagged finance data shows as unknown, not as someone's numbers", () => {
    const c = { ...empty(), income: [income("2026-11-02", 500)], invoices: [invoice("sent", 300)] };
    const s = businessCardStats("trades_contracting", c, NOW);
    expect(s.incomeThisMonth.value).toBeNull();
    expect(s.incomeThisMonth.hint).toMatch(/aren't tagged/);
    expect(s.pendingPayments.value).toBeNull();
    expect(s.unreadMessages.value).toBeNull();
  });

  it("tagged finance rows count only for their business and this month", () => {
    const c: CardInputs = {
      ...empty(),
      income: [income("2026-11-02", 500, "acting"), income("2026-10-30", 900, "acting"), income("2026-11-03", 40, "trades_contracting")],
      invoices: [invoice("sent", 300, "acting"), invoice("overdue", 100, "acting", NOW - DAY), invoice("paid", 999, "acting"), invoice("sent", 70, "trades_contracting")],
      checks: [{ payer: "p", amount: 25, receivedAt: NOW, deposited: false, area: "acting" }, { payer: "p", amount: 1000, receivedAt: NOW, deposited: true, area: "acting" }],
    };
    const a = businessCardStats("acting", c, NOW);
    expect(a.incomeThisMonth.value).toBe(500);
    expect(a.pendingPayments.value).toBe(425);
    expect(a.nextDeadline).toMatchObject({ at: NOW + 5 * DAY, what: "Invoice INV-300 due" });
    expect(businessCardStats("supplements_ecom", c, NOW).incomeThisMonth.value).toBe(0);
  });

  it("open jobs: pipeline for Acting, projects for Contracting, deadlines from each", () => {
    const c: CardInputs = {
      ...empty(),
      pipeline: [
        { title: "Self-tape: Lead", status: "prepping", dueAt: NOW + 2 * DAY },
        { title: "Callback", status: "callback", dueAt: NOW + DAY },
        { title: "Passed", status: "passed", dueAt: NOW + 3 * DAY },
        { title: "Old booking", status: "booked", dueAt: NOW - 3 * DAY },
      ],
      projects: [
        { client: "Smith", job: "Patio", status: "bid-sent", followUpAt: NOW + 4 * DAY },
        { client: "Lee", job: "Wall", status: "in-progress" },
        { client: "Done", job: "x", status: "paid", followUpAt: NOW + DAY },
      ],
    };
    const a = businessCardStats("acting", c, NOW);
    expect(a.openJobs.value).toBe(2);
    expect(a.nextDeadline).toMatchObject({ at: NOW + DAY, what: "Callback" });
    const t = businessCardStats("trades_contracting", c, NOW);
    expect(t.openJobs.value).toBe(2);
    expect(t.nextDeadline).toMatchObject({ at: NOW + 4 * DAY, what: "Smith · Patio" });
    const s = businessCardStats("supplements_ecom", c, NOW);
    expect(s.openJobs.value).toBeNull();
    expect(s.nextDeadline).toMatchObject({ at: null, hint: expect.stringMatching(/Reminders aren't tagged/) });
    expect(businessCardStats("acting", empty(), NOW).nextDeadline).toMatchObject({ at: null, hint: "Nothing due" });
  });

  it("a tagged reminder is a deadline for its business only", () => {
    const c: CardInputs = { ...empty(), reminders: [{ title: "Ship order batch", kind: "reminder", dueAt: NOW + DAY, repeat: "none", source: "local", area: "supplements_ecom" }] };
    expect(businessCardStats("supplements_ecom", c, NOW).nextDeadline.what).toBe("Ship order batch");
    expect(businessCardStats("acting", c, NOW).nextDeadline.at).toBeNull();
  });
});
