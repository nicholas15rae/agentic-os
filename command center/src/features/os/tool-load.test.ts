import { describe, expect, it } from "vitest";
import type { McpServer, ServerTools } from "@/lib/platform";
import { agentServers, DEFAULT_TONY_MODE_TOOLS, loadOf, sharedKey, sharedServers, TOOL_WARN, tonyModeTools, toggleTonyModeTool } from "./tool-load";

const srv = (id: string, agents: string[] | null, enabled = true) => ({ id, name: id, enabled, agents }) as unknown as McpServer;
const listing = (id: string, n: number) => ({ id, name: id, enabled: true, ok: true, error: null, status: "ok", auth: null, tools: Array.from({ length: n }, (_, i) => ({ name: `${id}.t${i}`, description: "x".repeat(40), server: id, args: ["a"] })) }) as ServerTools;

const mcps = [srv("time", ["general"]), srv("gmail", ["general"]), srv("git", ["coder"]), srv("filesystem", ["coder", "prompter"]), srv("maps", ["ops"]), srv("knowledge-graph", ["general", "prompter"])];
const base = { modeTools: null, frozenTools: [] as string[], frozen: false };

describe("tool load", () => {
  it("mirrors Rust's per-mode extras for Tony", () => {
    expect(DEFAULT_TONY_MODE_TOOLS.builder).toEqual(["git", "filesystem"]);
    expect(tonyModeTools({})).toEqual({ builder: ["git", "filesystem"], operations: ["maps", "instagram", "fetch"], executive: ["fetch"] });
    expect(toggleTonyModeTool({ builder: ["git"] }, "builder", "git")).toEqual({ builder: [] });
    expect(toggleTonyModeTool({}, "coach", "fetch")).toEqual({ coach: ["fetch"] });
  });

  it("Tony = base (every mode) + the mode's extras; a frozen agent gets nothing", () => {
    expect(agentServers({ mcps }, "general", { ...base, modeId: "learning", modeTools: [] })).toEqual(["time", "gmail", "knowledge-graph"]);
    expect(agentServers({ mcps }, "general", { ...base, modeId: "builder" })).toEqual(["time", "gmail", "git", "filesystem", "knowledge-graph"]);
    expect(agentServers({ mcps }, "general", { ...base, modeId: "builder", frozenTools: ["gmail"] })).toEqual(["time", "git", "filesystem", "knowledge-graph"]);
    expect(agentServers({ mcps }, "ops", { ...base, modeId: "x", frozen: true })).toEqual([]);
    expect(agentServers({ mcps }, "coder", { ...base, modeId: "builder", modeTools: ["git"] })).toEqual(["git"]);
  });

  it("counts tools, estimates tokens, warns over the limit", () => {
    const l = loadOf("general", ["gmail", "git", "nope"], [listing("gmail", 4), listing("git", TOOL_WARN)]);
    expect(l.tools).toBe(4 + TOOL_WARN);
    expect(l.warn).toBe(true);
    expect(l.unlisted).toEqual(["nope"]);
    expect(l.tokens).toBeGreaterThan(0);
    expect(loadOf("x", ["gmail"], [listing("gmail", 3)]).warn).toBe(false);
  });

  it("flags a server more than one active agent owns", () => {
    const s = sharedServers(mcps, ["general", "coder", "prompter"]);
    expect(s).toEqual([
      { server: "filesystem", owners: ["coder", "prompter"] },
      { server: "knowledge-graph", owners: ["general", "prompter"] },
    ]);
    // The clock is always shared and never flagged; a frozen agent doesn't count.
    expect(sharedServers(mcps, ["general", "coder"])).toEqual([]);
    expect(sharedKey({ server: "fs", owners: ["b", "a"] })).toBe("fs:a,b");
  });
});
