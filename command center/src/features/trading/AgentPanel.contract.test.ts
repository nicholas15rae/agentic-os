import { describe, expect, it } from "vitest";
import { needsConfirm } from "./AgentPanel.contract";

describe("AgentPanel confirmation rules (locked contract)", () => {
  it("Run now is immediate only in ADVISORY", () => {
    expect(needsConfirm("run", "ADVISORY")).toBe(false);
    expect(needsConfirm("run", "SEMI_AUTO")).toBe(true);
    expect(needsConfirm("run", "FULL_AUTO")).toBe(true);
    expect(needsConfirm("run", null)).toBe(true); // mode unknown: ask
  });
  it("turning ON needs confirmation only in FULL_AUTO", () => {
    expect(needsConfirm("enable", "ADVISORY")).toBe(false);
    expect(needsConfirm("enable", "SEMI_AUTO")).toBe(false);
    expect(needsConfirm("enable", "FULL_AUTO")).toBe(true);
  });
});
