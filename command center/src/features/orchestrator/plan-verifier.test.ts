import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Section 20.9: the verifier (policy.verifier, e.g. "ext:claude-cli") runs only on a MUTATING plan,
 * never on a normal chat turn. `planIntent` is the only place the webview asks for it
 * (`dispatch_chat` with provider "verifier"); Rust uses it only for background pipeline / worker
 * handoffs and the explicit "local" Overseer engine, never inside `run_os_turn`.
 */
const calls = vi.hoisted(() => [] as { name: string; args: unknown }[]);
vi.mock("@/lib/platform", async (orig) => {
  const real = await orig<typeof import("@/lib/platform")>();
  return {
    ...real,
    cmd: vi.fn(async (name: string, args: unknown) => {
      calls.push({ name, args });
      if (name === "dispatch_chat") {
        const verifier = (args as { req: { provider?: string } }).req.provider === "verifier";
        return { content: verifier ? '{"consistent": true, "issues": []}' : '{"role":"general","intent":"send it","summary":"s","mutating":true,"payload":{},"missing":[]}', providerId: verifier ? "ext:claude-cli" : "local", latencyMs: 1 };
      }
      if (name === "n8n_workflows" || name === "gmail_last_bookings") return [];
      return null;
    }),
  };
});

import { planIntent } from "./plan";

const verifierCalls = () => calls.filter((c) => c.name === "dispatch_chat" && (c.args as { req: { provider?: string } }).req.provider === "verifier");

describe("the verifier runs on mutating plans only", () => {
  afterEach(() => {
    calls.length = 0;
    vi.unstubAllGlobals();
  });

  it("never on a normal chat turn (questions, greetings, live-tool reads)", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    for (const text of ["what's the weather like today", "hey tony, how are you", "check my inbox", "tell me a joke", "what's on my calendar tomorrow"]) {
      const p = await planIntent(text, { role: "general" });
      expect(p.mutating, text).toBe(false);
      expect(p.verification.status, text).toBe("skipped");
    }
    expect(verifierCalls()).toHaveLength(0);
  });

  it("once per mutating plan", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    const p = await planIntent("cancel my dinner reservation with Sam tonight", { role: "general" });
    expect(p.mutating).toBe(true);
    expect(verifierCalls()).toHaveLength(1);
    expect(p.verification).toMatchObject({ status: "verified", by: "ext:claude-cli" });
  });
});
