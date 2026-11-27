import { describe, expect, it } from "vitest";
import { auditGroups, clampMinutes, filterAudit, IDLE_LOCK_LIMITS, REAUTH_LIMITS } from "./audit-filter";

const e = (event: string, module: string | null = null) => ({ event, module });

describe("audit trail filters", () => {
  it("groups the events the security layer writes", () => {
    expect(auditGroups(e("login_failure"))).toEqual(["logins"]);
    expect(auditGroups(e("unknown_device"))).toEqual(["logins"]);
    expect(auditGroups(e("inactivity_lock"))).toEqual(["locks"]);
    expect(auditGroups(e("hard_lock"))).toEqual(["locks"]);
    expect(auditGroups(e("step_up_unlock", "trading"))).toEqual(["approvals", "trading"]);
    expect(auditGroups(e("step_up_unlock", "settings"))).toEqual(["approvals"]);
    expect(auditGroups(e("trading_kill_switch"))).toEqual(["trading"]);
    expect(auditGroups(e("session_config_changed", "settings"))).toEqual(["settings"]);
    expect(auditGroups(e("companion_paired", "settings"))).toEqual(["settings"]);
    expect(auditGroups(e("remote_kill", "trading"))).toEqual(["locks", "trading"]);
  });

  it("filters, with All passing everything", () => {
    const list = [e("login_success"), e("manual_lock"), e("step_up_unlock", "finance"), e("pin_changed")];
    expect(filterAudit(list, "all")).toHaveLength(4);
    expect(filterAudit(list, "logins").map((x) => x.event)).toEqual(["login_success"]);
    expect(filterAudit(list, "approvals").map((x) => x.event)).toEqual(["step_up_unlock"]);
    expect(filterAudit(list, "settings").map((x) => x.event)).toEqual(["pin_changed"]);
    expect(filterAudit(list, "trading")).toEqual([]);
  });

  it("clamps lock timers to the card's limits", () => {
    expect(clampMinutes(1, IDLE_LOCK_LIMITS)).toBe(5);
    expect(clampMinutes(999, IDLE_LOCK_LIMITS)).toBe(120);
    expect(clampMinutes(45.6, REAUTH_LIMITS)).toBe(46);
    expect(clampMinutes(10, REAUTH_LIMITS)).toBe(30);
    expect(clampMinutes(Number.NaN, REAUTH_LIMITS)).toBe(30);
  });
});
