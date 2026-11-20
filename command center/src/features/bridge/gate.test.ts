import { describe, expect, it, vi } from "vitest";
import type { ActionPlan } from "@/features/orchestrator/plan";

const h = vi.hoisted(() => ({ plans: [] as ActionPlan[], channels: [] as string[] }));

vi.mock("@/features/voice/voice-controller", () => ({
  requestConfirmation: (plan: ActionPlan, channel: string) => {
    h.plans.push(plan);
    h.channels.push(channel);
    return Promise.resolve();
  },
}));
vi.mock("@/features/reminders/notify", () => ({ useToasts: { getState: () => ({ push: vi.fn() }) } }));

import { gated } from "./gate";

describe("the delegation gate's card (regression)", () => {
  // With delegation set to "ask", the card landed in Tony's thread (not the asking tab), was never
  // spoken on a voice turn, and its run() posted the answer as Tony's — a second copy.
  it("lands in the asking thread, is spoken on voice, and a silent gate posts nothing itself", async () => {
    const call = vi.fn(async (approved: boolean) => {
      if (!approved) throw "PERMISSION_REQUIRED:delegation";
      return { answer: "Coder: the build is green." };
    });
    const out = gated({ action: "os-turn", summary: "Let Tony use Coder", channel: "voice", thread: "coder", silent: true }, call, (x) => x.answer);
    await vi.waitFor(() => expect(h.plans).toHaveLength(1));
    const plan = h.plans[0];
    expect(plan.thread).toBe("coder");
    expect(h.channels[0]).toBe("voice");
    const r = await plan.run!();
    expect(r.text).toBe("");
    await expect(out).resolves.toEqual({ answer: "Coder: the build is green." });
  });
  it("a non-silent gate still describes its result", async () => {
    h.plans.length = 0;
    const call = async (approved: boolean) => {
      if (!approved) throw "PERMISSION_REQUIRED:network";
      return 7;
    };
    void gated({ action: "x", summary: "Do x" }, call, (n) => `got ${n}`);
    await vi.waitFor(() => expect(h.plans).toHaveLength(1));
    expect((await h.plans[0].run!()).text).toBe("got 7");
    expect(h.plans[0].thread).toBeUndefined();
  });
});
