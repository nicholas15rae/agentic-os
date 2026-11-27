import { describe, expect, it } from "vitest";
import { businessIdError, digestLine, idsOf, keepActive, newBusinessFrom, parseTerms, provisionLabel, reasonLabel, suggestId } from "./logic";
import { activeBusinessForTurn, useOps } from "./ops-store";
import type { Business, QItem, ReviewGroup } from "./types";

const biz = (id: string, status: Business["status"] = "active", provision: Partial<Business["provision"]> = {}): Business => ({
  businessId: id,
  displayName: id,
  category: "",
  description: "",
  aliases: [],
  workspaceSlug: `bizops_${id}`,
  ragNamespace: `bizops_${id}`,
  memoryPath: `C:/cfg/memory/ops/${id}`,
  librarianScope: `bizops_${id}`,
  financeLedgerTag: id,
  crossDomainBlocklist: [],
  status,
  provision: { memoryDir: true, workspace: true, lastError: null, updatedAt: 0, ...provision },
  createdAt: 0,
});

const item = (id: string, business: string, reason = "flagged"): QItem => ({
  itemId: id,
  businessId: business,
  sourceAgent: "garbage",
  reasonCode: reason,
  reason: "x",
  timestamp: 0,
  backupPath: "",
  sha256: "",
  bytes: 1,
  kind: "note",
  rel: "a.md",
  status: "pending",
  resolvedAt: null,
});

describe("business ids (mirrors Rust validate_business_id)", () => {
  it("accepts and refuses the same ids as Rust", () => {
    expect(businessIdError("bakery_2")).toBeNull();
    expect(businessIdError("trades_contracting")).toBeNull();
    // The same refusal list as business_registry.rs `ids_and_derived_fields_are_locked`.
    for (const bad of ["", "a", "Trades", "9shop", "shop-1", "shop_", "a__b", "con", "nul", "ops", "bizops", "finance", "general", "x".repeat(33)]) {
      expect(businessIdError(bad), bad).not.toBeNull();
    }
  });

  it("suggests a valid id from a display name", () => {
    expect(suggestId("Corner Bakery & Café")).toBe("corner_bakery_cafe");
    expect(suggestId("Supplements & E-Commerce")).toBe("supplements_e_commerce");
    expect(suggestId("123 Go")).toBe("go");
    expect(suggestId("!")).toBe("");
    for (const n of ["Trades & Contracting", "A very long business name that keeps going and going"]) expect(businessIdError(suggestId(n))).toBeNull();
  });
});

describe("form → NewBusiness", () => {
  it("never sends derived fields, and cleans term lists", () => {
    const nb = newBusinessFrom({ displayName: " Corner Bakery ", businessId: "corner_bakery", category: "food", description: "", aliases: "bakery, Bakery, ab", blocklist: "Flour Co\n\nMain St Market" });
    expect(nb).toEqual({ businessId: "corner_bakery", displayName: "Corner Bakery", category: "food", description: "", aliases: ["bakery"], crossDomainBlocklist: ["Flour Co", "Main St Market"] });
    expect(Object.keys(nb)).not.toContain("workspaceSlug");
    expect(parseTerms("x, yy, zzz")).toEqual(["zzz"]);
  });
});

describe("active business", () => {
  it("keeps a saved selection only while that business is active", () => {
    const list = [biz("a"), biz("b", "archived"), biz("c", "provisioning", { workspace: false })];
    expect(keepActive("a", list)).toBe("a");
    expect(keepActive("b", list)).toBeNull();
    expect(keepActive("c", list)).toBeNull();
    expect(keepActive("gone", list)).toBeNull();
    expect(keepActive(null, list)).toBeNull();
  });

  it("rides on the next OS turn, and can't be set to an inactive business", () => {
    useOps.setState({ businesses: [biz("trades_contracting"), biz("supplements_ecom", "archived")], activeBusinessId: null });
    expect(activeBusinessForTurn()).toBeUndefined();
    useOps.getState().setActive("trades_contracting");
    expect(activeBusinessForTurn()).toBe("trades_contracting");
    useOps.getState().setActive("supplements_ecom");
    expect(activeBusinessForTurn()).toBeUndefined();
  });

  it("labels provisioning progress", () => {
    expect(provisionLabel(biz("a"))).toBe("Active");
    expect(provisionLabel(biz("a", "provisioning", { memoryDir: false, workspace: false }))).toBe("Creating memory folder");
    expect(provisionLabel(biz("a", "provisioning", { workspace: false }))).toBe("Creating workspace");
    expect(provisionLabel(biz("a", "provisioning", { workspace: false, lastError: "x" }))).toBe("Needs attention");
  });
});

describe("review digest helpers", () => {
  const groups: ReviewGroup[] = [
    { businessId: "a", displayName: "A", count: 2, reasons: [{ reasonCode: "empty_file", items: [item("q-1", "a"), item("q-2", "a")] }] },
    { businessId: "b", displayName: "B", count: 1, reasons: [{ reasonCode: "cross_domain", items: [item("q-3", "b", "cross_domain")] }] },
  ];
  it("collects batch ids per business or for everything", () => {
    expect(idsOf(groups)).toEqual(["q-1", "q-2", "q-3"]);
    expect(idsOf(groups, "b")).toEqual(["q-3"]);
  });
  it("summarises in one line", () => {
    expect(digestLine(groups)).toBe("3 items · 2 businesses");
    expect(digestLine([])).toBe("Nothing waiting for review");
    expect(reasonLabel("cross_domain")).toBe("Mentions another business");
    expect(reasonLabel("new_code")).toBe("new code");
  });
});
