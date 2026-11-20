import { describe, expect, it } from "vitest";
import { SUB_AGENTS, agentFor, classify, titleCaseId } from "./agents";
import { ROLE_IDS, SUB_AGENT_IDS, roleIds, roleLabel, subAgentIds } from "./roles";
import { agentBadge } from "@/features/os/os-store";
import { CURIOSITY_HIGH } from "@/features/modes/modes";

/**
 * Phase 2 §4 (prep only, no new agents): the registry is data-driven, so a future read-only
 * specialist (Security Patrol, Finance…) added to os.json `routing.agents` resolves everywhere
 * without a refactor.
 */
describe("data-driven agent registry", () => {
  it("an unknown registry id gets a generic read-only agent that reports to Tony", () => {
    const a = agentFor("security-patrol");
    expect(a.role).toBe("security-patrol");
    expect(a.label).toBe("Security Patrol");
    expect(a.keywords).toEqual([]);
    expect(a.systemPrompt).toMatch(/read-only specialist/);
    expect(a.systemPrompt).toMatch(/report only to Tony/);
    expect(a.systemPrompt).toMatch(/never act/);
    expect(a.systemPrompt.toLowerCase()).not.toContain("json");
    // A plain index lookup is safe too (no caller needs `agentFor`).
    expect(SUB_AGENTS["security-patrol"]).toBe(a);
    expect(SUB_AGENTS["finance"].label).toBe("Finance");
  });

  it("known agents are unchanged and enumeration lists only them", () => {
    expect(agentFor("coder")).toBe(SUB_AGENTS.coder);
    expect(SUB_AGENTS.booking.label).toBe("Booking Desk");
    expect(Object.keys(SUB_AGENTS).sort()).toEqual(["booking", "coder", "designer", "general", "librarian", "ops", "prompter"]);
    // An invalid id never becomes an agent: it falls back to Tony.
    expect(agentFor("../etc").role).toBe("general");
    expect(SUB_AGENTS["Not An Id"]).toBeUndefined();
    // The keyword classifier never picks a generic agent.
    expect(classify("run a security patrol on the finance numbers")).not.toMatch(/security|finance/);
  });

  it("labels and badges fall back to the title-cased id", () => {
    expect(titleCaseId("security-patrol")).toBe("Security Patrol");
    expect(titleCaseId("finance_2")).toBe("Finance 2");
    expect(roleLabel("security-patrol")).toBe("Security Patrol");
    expect(roleLabel("librarian")).toBe("Librarian");
    expect(roleLabel("booking")).toBe("Booking Desk");
    expect(agentBadge("finance")).toBe("FINANCE");
    expect(agentBadge("security-patrol")).toBe("SECURITY PATROL");
    expect(agentBadge("coder")).toBe("CODER AGENT");
  });

  it("role ids come from the routing registry at runtime, the static list first", () => {
    expect(roleIds(null)).toEqual([...ROLE_IDS]);
    expect(subAgentIds(undefined)).toEqual([...SUB_AGENT_IDS]);
    const agents = { general: {}, coder: {}, finance: {}, "security-patrol": {}, tony: {}, "Bad Id": {} };
    expect(roleIds(agents)).toEqual([...ROLE_IDS, "finance", "security-patrol"]);
    expect(subAgentIds(agents)).toEqual([...SUB_AGENT_IDS, "finance", "security-patrol"]);
  });

  it("Tony's gateway prompt carries the active MODE block (Brainstorming by default)", () => {
    const sys = SUB_AGENTS.general.systemPrompt;
    expect(sys).toContain("MODE: Brainstorming.");
    expect(sys).toContain(CURIOSITY_HIGH);
    expect(sys.toLowerCase()).not.toContain("json");
    // Sub-agents never get it.
    expect(SUB_AGENTS.coder.systemPrompt).not.toContain("MODE:");
  });
});
