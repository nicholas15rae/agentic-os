import { beforeEach, describe, expect, it, vi } from "vitest";

const gateway = vi.fn();
vi.mock("@/lib/gateway", () => ({ gateway: (...a: unknown[]) => gateway(...a), GatewayError: class extends Error {}, authHeader: () => ({}) }));
vi.mock("@/stores/settings", () => ({
  isDesktopApp: () => true,
  isAndroidApp: () => false, useSettings: Object.assign(() => "", { getState: () => ({ gatewayUrl: "http://127.0.0.1:8080" }) }) }));

import { cc, FINANCE_COLLECTIONS, isFinanceCollection } from "./cc-api";

const hit = (collection: string) => ({ score: 1, collection, id: collection, snippet: `${collection} snippet`, item: null });

describe("vault search scope (agent context never gets finance records)", () => {
  beforeEach(() => gateway.mockReset());

  it("agentSearch asks unscoped without include_finance and drops finance hits an older gateway returns", async () => {
    gateway.mockResolvedValue({ mode: "lexical", results: ["receipts", "notes", "invoices", "checks", "income", "projects"].map(hit) });
    const res = await cc.agentSearch("deck job", 5);
    const url = String(gateway.mock.calls[0][0]);
    expect(url).toContain("collections=&k=5");
    expect(url).not.toContain("include_finance");
    expect(res.results.map((r) => r.collection)).toEqual(["notes", "projects"]);
  });

  it("Nic's own search opts in explicitly", async () => {
    gateway.mockResolvedValue({ mode: "lexical", results: [] });
    await cc.search("deck job", [], 20, { includeFinance: true });
    expect(String(gateway.mock.calls[0][0])).toContain("include_finance=true");
    await cc.search("deck job", ["receipts"], 50);
    expect(String(gateway.mock.calls[1][0])).toContain("collections=receipts&k=50");
  });

  it("the finance list mirrors the gateway's", () => {
    expect([...FINANCE_COLLECTIONS].sort()).toEqual(["checks", "income", "invoices", "receipts"]);
    expect(isFinanceCollection("notes")).toBe(false);
  });
});
