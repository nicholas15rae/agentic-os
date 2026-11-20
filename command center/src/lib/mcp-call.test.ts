import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async (_name: string, _args?: Record<string, unknown>) => "ok");
vi.mock("@tauri-apps/api/core", () => ({ invoke: (name: string, args?: Record<string, unknown>) => invoke(name, args) }));

import { describeToolError, isRoleRefusal, mcpCall } from "./mcp-call";

const g = globalThis as unknown as { window?: unknown };
const hadWindow = "window" in g;
const prevWindow = g.window;

beforeAll(() => {
  // `isTauri()` looks for the Tauri internals on window.
  g.window = { __TAURI_INTERNALS__: {} };
});
afterAll(() => {
  if (hadWindow) g.window = prevWindow;
  else delete g.window;
});
beforeEach(() => invoke.mockClear());

describe("mcpCall", () => {
  it("always sends the agent explicitly", async () => {
    await expect(mcpCall("fs.read", { path: "C:\\ai-hub\\README.md" }, { agent: "tony" })).resolves.toBe("ok");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0][0]).toBe("mcp_call");
    expect(invoke.mock.calls[0][1]).toEqual({ name: "fs.read", args: { path: "C:\\ai-hub\\README.md" }, agent: "tony" });
  });

  it("passes approved only when given, and a sub-agent as itself", async () => {
    await mcpCall("kg.search", { query: "x" }, { agent: " librarian ", approved: false });
    expect(invoke.mock.calls[0][1]).toEqual({ name: "kg.search", args: { query: "x" }, agent: "librarian", approved: false });
  });

  it("refuses to call without an agent", async () => {
    await expect(mcpCall("fs.read", {}, { agent: "  " })).rejects.toThrow(/agent/);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("describeToolError", () => {
  it("labels role refusals as blocked by role", () => {
    const ro = "PERMISSION_READ_ONLY_ROLE:librarian — github.merge_pull_request is blocked for the librarian agent: it is not on that agent's read-only tool list";
    expect(describeToolError(ro)).toBe("blocked by role: github.merge_pull_request is blocked for the librarian agent: it is not on that agent's read-only tool list");
    expect(describeToolError(new Error("PERMISSION_ROLE:librarian — the librarian agent is not granted Git (git), so git.status is blocked"))).toMatch(/^blocked by role: the librarian agent is not granted Git/);
    expect(isRoleRefusal(ro)).toBe(true);
    expect(isRoleRefusal("PERMISSION_ROLE:x — y")).toBe(true);
  });

  it("keeps read-only server refusals distinct and passes other errors through", () => {
    expect(describeToolError("PERMISSION_READ_ONLY:sqlite — SQLite is set to read-only")).toBe("blocked (read-only): SQLite is set to read-only");
    expect(isRoleRefusal("PERMISSION_READ_ONLY:sqlite — x")).toBe(false);
    expect(describeToolError("Error: tool x.y is not available (server off?)")).toBe("tool x.y is not available (server off?)");
  });
});
