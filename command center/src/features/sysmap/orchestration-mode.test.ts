import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { OrchestratorPolicy, PolicyView } from "./diagnostics.contract";
import { canSwitchMode, isMissingCommand, modeOf, nextModeSync, ORCHESTRATION_MODES } from "./diagnostics-model";
import { DEFAULT_PAGE, PAGES, useSysMap } from "./sysmap-store";

const view = (gpu: Partial<OrchestratorPolicy["gpu"]>, mode?: PolicyView["mode"]): PolicyView =>
  ({
    policy: { gpu: { maxConcurrentSlots: 1, tiers: {}, defaultTier: 3, queueTimeoutMs: {}, preemptTier3ForTier1: false, ...gpu } } as unknown as OrchestratorPolicy,
    status: { state: "applied", file: null },
    file: null,
    mode,
  });

describe("orchestration modes", () => {
  it("mirror policy.rs MODES (ids, order, preempt flag)", () => {
    const rs = readFileSync(resolve(__dirname, "../../../src-tauri/src/commands/policy.rs"), "utf8");
    const rows = [...rs.matchAll(/Mode \{ id: "([a-z_]+)", preempt_tier3_for_tier1: (true|false) \}/g)].map((m) => [m[1], m[2] === "true"]);
    expect(rows).toEqual(ORCHESTRATION_MODES.map((m) => [m.id, m.preempt]));
  });

  it("reads the mode the backend reports, or derives it from an older build's policy", () => {
    expect(modeOf(view({ preemptTier3ForTier1: true }, "build_balanced"))).toBe("build_balanced");
    expect(modeOf(view({ preemptTier3ForTier1: true }))).toBe("trading_priority");
    expect(modeOf(view({ preemptTier3ForTier1: false }))).toBe("build_balanced");
    // Not pinned to one slot -> no mode row matches.
    expect(modeOf(view({ preemptTier3ForTier1: true, maxConcurrentSlots: null }))).toBe("custom");
    expect(modeOf(view({ preemptTier3ForTier1: false, maxConcurrentSlots: 2 }))).toBe("custom");
  });

  it("knows an IPC error for a command the running build doesn't have yet", () => {
    expect(isMissingCommand("Command policy_set_mode not found")).toBe(true);
    expect(isMissingCommand("orchestrator_policy.json is currently rejected (x); fix it before switching modes")).toBe(false);
  });

  it("knows when the running build can switch (pre-v4 policy_get has no modes)", () => {
    expect(canSwitchMode(null)).toBe(false);
    expect(canSwitchMode(view({}))).toBe(false);
    expect(canSwitchMode({ ...view({}), modes: ["trading_priority", "build_balanced"] })).toBe(true);
  });

  it("clears a stale error / needs-rebuild once the policy recovers, never an in-flight switch", () => {
    const v4 = { ...view({}), modes: ["trading_priority", "build_balanced"] as PolicyView["modes"] };
    const err = { state: "error", target: "build_balanced", error: "rejected" } as const;
    expect(nextModeSync(err, v4).state).toBe("idle");
    expect(nextModeSync(err, { ...v4, status: { state: "rejected", file: null } }).state).toBe("error");
    const nr = { state: "needs_rebuild", target: "build_balanced", error: null } as const;
    expect(nextModeSync(nr, view({})).state).toBe("needs_rebuild");
    expect(nextModeSync(nr, v4).state).toBe("idle");
    const applying = { state: "applying", target: "trading_priority", error: null } as const;
    expect(nextModeSync(applying, v4)).toBe(applying);
  });

  it("every mode has a one-line tradeoff", () => {
    for (const m of ORCHESTRATION_MODES) {
      expect(m.tradeoff.length).toBeGreaterThan(20);
      expect(m.tradeoff).not.toContain("\n");
    }
  });
});

describe("System Map tabs", () => {
  it("open on the Schematic Flowchart, ordered Schematic, Blueprint, Orbital", () => {
    expect(DEFAULT_PAGE).toBe(2);
    expect(useSysMap.getState().page).toBe(2);
    expect(PAGES.map((p) => p.id)).toEqual([2, 1, 3]);
    expect(PAGES[0].label).toBe("Schematic Flowchart");
  });
});
