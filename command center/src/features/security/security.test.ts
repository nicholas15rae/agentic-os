import { describe, expect, it } from "vitest";
import { describeSecurityError, gatewayModule, parseSecurityError } from "./api";
import { elevatedModules } from "./store";
import { createKillArm, KILL_CONFIRM_MS, killStageLabel } from "@/features/trading/kill-switch-core";
import type { SecurityStatus } from "./api";

describe("Rust refusal parsing", () => {
  it("reads codes, args and messages from session.rs / gate.rs", () => {
    expect(parseSecurityError("STEP_UP_REQUIRED:trading: trading is read-only; confirm with your PIN")).toEqual({ code: "STEP_UP_REQUIRED", arg: "trading", message: "trading is read-only; confirm with your PIN" });
    expect(parseSecurityError("LOCKED: the Command Center is locked; unlock it first")?.code).toBe("LOCKED");
    expect(parseSecurityError("BAD_PIN:3: wrong PIN (3 attempt(s) left before the lockout)")?.arg).toBe("3");
    expect(parseSecurityError("LOCKED_OUT:1700000300: too many wrong PINs")?.arg).toBe("1700000300");
    expect(parseSecurityError("plain failure")).toBeNull();
    expect(parseSecurityError(new Error("HARD_LOCKED: the remote failsafe locked this app"))?.code).toBe("HARD_LOCKED");
    expect(describeSecurityError("BAD_PIN:1: x")).toBe("Wrong PIN — 1 attempt left before the lockout.");
  });

  it("maps gateway paths to their protected module", () => {
    expect(gatewayModule("/api/trading/mode")).toBe("trading");
    expect(gatewayModule("/api/trading/kill-switch")).toBe("trading"); // the gateway itself never gates the E-stop
    expect(gatewayModule("/api/cc/c/invoices/abc")).toBe("finance");
    expect(gatewayModule("/api/cc/c/notes")).toBeNull();
    expect(gatewayModule("/api/cc/config")).toBe("settings");
    expect(gatewayModule("/api/cc/kv/ui.desktop")).toBeNull();
  });

  it("lists only live elevations", () => {
    const s = { modules: [{ module: "trading", readOnlyByDefault: true, elevatedUntil: 200 }, { module: "finance", readOnlyByDefault: true, elevatedUntil: 50 }, { module: "settings", readOnlyByDefault: true, elevatedUntil: null }] } as unknown as SecurityStatus;
    expect(elevatedModules(s, 100)).toEqual(["trading"]);
    expect(elevatedModules(null)).toEqual([]);
  });
});

describe("3-click kill switch", () => {
  it("labels ARM → CONFIRM → EXECUTE KILL and resets after 4 s", () => {
    expect([0, 1, 2].map((n) => killStageLabel(n))).toEqual(["ARM", "CONFIRM", "EXECUTE KILL"]);
    expect(KILL_CONFIRM_MS).toBe(4_000);
    const arm = createKillArm();
    arm.press(0);
    expect(arm.pressed(KILL_CONFIRM_MS + 1)).toBe(0); // a stray click disarms itself
    // A deliberate sequence fires in well under 2 s.
    arm.press(10_000);
    arm.press(10_500);
    expect(arm.press(11_000)).toEqual({ kind: "fire" });
  });
});
