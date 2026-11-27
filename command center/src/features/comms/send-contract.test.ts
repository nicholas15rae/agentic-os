import { describe, expect, it } from "vitest";
import { canSkipCard, isPermissionRequired, type SendOrigin } from "./send-contract";

describe("Instant Send contract (Comms step 1)", () => {
  it("only a hand-typed reply to a trusted contact skips the card", () => {
    expect(canSkipCard("ui-typed", true, "sms")).toBe(true);
    expect(canSkipCard("ui-typed", true, "whatsapp")).toBe(true);
    expect(canSkipCard("ui-typed", false, "sms")).toBe(false);
    for (const o of ["ui-card", "voice", "tony", "agent"] as SendOrigin[]) expect(canSkipCard(o, true, "sms"), o).toBe(false);
  });

  it("Instagram, Messenger and RCS never skip the card", () => {
    for (const ch of ["instagram", "messenger", "rcs", "Instagram"]) expect(canSkipCard("ui-typed", true, ch), ch).toBe(false);
  });

  it("recognises the desktop and gateway 'show the card' refusals", () => {
    expect(isPermissionRequired("PERMISSION_REQUIRED:send")).toBe(true);
    expect(isPermissionRequired(Object.assign(new Error("428 Precondition Required"), { status: 428 }))).toBe(true);
    expect(isPermissionRequired(new Error("PERMISSION_REQUIRED:send"))).toBe(true);
    expect(isPermissionRequired("kill switch is on")).toBe(false);
    expect(isPermissionRequired(Object.assign(new Error("500"), { status: 500 }))).toBe(false);
    expect(isPermissionRequired(null)).toBe(false);
  });
});
