import { describe, expect, it } from "vitest";
import { foldProbe, healthView, RESET_AFTER, SLOW_MS, UNKNOWN_HEALTH, type HealthSnapshot } from "./health";

const snap = (p: Partial<HealthSnapshot>): HealthSnapshot => ({ ...UNKNOWN_HEALTH, ...p });

describe("heartbeat state mapping", () => {
  it("never probed → Checking, no alarm", () => {
    const v = healthView(UNKNOWN_HEALTH);
    expect(v.label).toBe("Checking…");
    expect(v.alarm).toBe(false);
  });

  it("online shows latency in ms; slow shows seconds", () => {
    expect(healthView(snap({ state: "online", latencyMs: 12 })).label).toBe("Online · 12 ms");
    expect(healthView(snap({ state: "slow", latencyMs: 1900 })).label).toBe("Slow · 1.9 s");
    expect(healthView(snap({ state: "online", latencyMs: 12 })).tone).toBe("ok");
  });

  it("timed out / offline are bad; the reset is offered only once needsReset is set", () => {
    expect(healthView(snap({ state: "timed_out", consecutiveFailures: 1 })).alarm).toBe(false);
    const v = healthView(snap({ state: "timed_out", consecutiveFailures: 2, needsReset: true }));
    expect(v.label).toBe("Timed out");
    expect(v.tone).toBe("bad");
    expect(v.alarm).toBe(true);
    expect(v.title).toContain("Reconnect");
    expect(healthView(snap({ state: "offline", needsReset: true })).label).toBe("Offline");
  });

  it("reconnecting overrides the state and drops the alarm", () => {
    const v = healthView(snap({ state: "offline", needsReset: true, reconnecting: true }));
    expect(v.label).toBe("Reconnecting…");
    expect(v.alarm).toBe(false);
  });

  it("foldProbe mirrors Rust: failures count up, success clears them", () => {
    let h = foldProbe(UNKNOWN_HEALTH, { ok: false, timeout: true, detail: "no answer" }, 1);
    expect(h.state).toBe("timed_out");
    expect(h.needsReset).toBe(false);
    for (let i = 1; i < RESET_AFTER; i++) h = foldProbe(h, { ok: false, timeout: false, detail: "unreachable" }, 2);
    expect(h.state).toBe("offline");
    expect(h.needsReset).toBe(true);
    h = foldProbe(h, { ok: true, latencyMs: SLOW_MS + 1 }, 3);
    expect(h.state).toBe("slow");
    expect(h.consecutiveFailures).toBe(0);
    expect(h.needsReset).toBe(false);
  });
});
