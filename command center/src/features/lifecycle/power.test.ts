import { describe, expect, it } from "vitest";
import { exitConfirmText } from "./power";

describe("Exit confirm", () => {
  it("always warns that the phone loses Tony and points at Standby", () => {
    const t = exitConfirmText([]);
    expect(t).toContain("phone loses Tony");
    expect(t).toContain("Standby");
    expect(t).not.toContain("interrupt:");
  });

  it("lists mid-commit work when there is some", () => {
    const t = exitConfirmText(["Build “x” is mid-stage (coder)"]);
    expect(t).toContain("phone loses Tony");
    expect(t).toContain("• Build “x” is mid-stage (coder)");
  });
});
