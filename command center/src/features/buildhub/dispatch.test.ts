import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionPlan } from "@/features/orchestrator/plan";

vi.hoisted(() => {
  const m = new Map<string, string>();
  Object.assign(globalThis, {
    localStorage: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k), clear: () => m.clear(), key: () => null, length: 0 },
  });
});

const h = vi.hoisted(() => ({ plans: [] as ActionPlan[], xcmd: vi.fn() }));

vi.mock("@/features/voice/voice-controller", () => ({
  requestConfirmation: (plan: ActionPlan) => {
    h.plans.push(plan);
    return Promise.resolve();
  },
  startHandoffCue: () => null,
}));
vi.mock("@/features/voice/handoff-cues", () => ({ noteHandoff: vi.fn(), withHandoff: (run: () => Promise<unknown>) => ({ result: run(), cue: null }) }));
vi.mock("@/lib/native-ext", () => ({ xcmd: h.xcmd }));

import { useVoice } from "@/features/voice/voice-store";
import { compileEnvelope, type IntakeNote } from "./compile";
import { HubDispatchCancelled, interviewOf, requestHubDispatch } from "./dispatch";
import type { IntakeQuestion } from "./types";
import { hubRefusalText } from "./gate";
import { effectiveOf, PRESET_MODES, SOLO_REFUSAL_LINE } from "@/features/modes/modes";

const notes: IntakeNote[] = [{ id: "n1", title: "Tip calculator", text: "split the bill", created: 1 }];
const qs: IntakeQuestion[] = [
  { id: "success", question: "What does done look like?", options: ["It renders"], allow_free_text: true },
  { id: "runtime", question: "Where should it run?", options: ["Internal widget (inside the dashboard)"], allow_free_text: false },
  { id: "worker", question: "Who builds it?", options: ["Coder (local pipeline)"], allow_free_text: false },
];
const compiled = () => compileEnvelope(notes, qs, { success: { text: "MUST work offline" }, runtime: { choice: qs[1].options[0] }, worker: { choice: qs[2].options[0] } }, { now: 1_800_000_000_000, rand: "ab12", stagingRoot: "D:\\x\\staging", externalBase: "C:\\ext" });

beforeEach(() => {
  h.plans.length = 0;
  h.xcmd.mockReset();
  useVoice.setState({ turns: [] });
});

describe("the intake dispatch waits for the card (regressions)", () => {
  // It returned as soon as the card was SHOWN: the modal closed and a decline / timeout / refusal
  // threw away the whole interview.
  it("a declined / timed-out / superseded card rejects (the modal keeps its answers)", async () => {
    const p = requestHubDispatch(compiled());
    await vi.waitFor(() => expect(h.plans).toHaveLength(1));
    h.plans[0].onCancel!();
    await expect(p).rejects.toBeInstanceOf(HubDispatchCancelled);
  });
  it("an enqueue refusal rejects with its reason", async () => {
    h.xcmd.mockImplementation(async (name: string) => {
      if (name === "build_enqueue") throw new Error("“tip-calculator” is already staged — finish or remove it first");
      return null;
    });
    const p = requestHubDispatch(compiled());
    await vi.waitFor(() => expect(h.plans).toHaveLength(1));
    await expect(h.plans[0].run!()).rejects.toThrow(/already staged/);
    await expect(p).rejects.toThrow(/already staged/);
  });
  // Nic's coach mode (surface_only): Rust refuses the approved enqueue. That refusal must reach the
  // modal as itself (mapped there to a line naming the mode in force), never as a cancelled /
  // timed-out card.
  it("a MODE_SURFACE_ONLY enqueue refusal surfaces that error, not HubDispatchCancelled", async () => {
    h.xcmd.mockImplementation(async (name: string) => {
      if (name === "build_enqueue") throw "MODE_SURFACE_ONLY: Solo mode builds nothing — switch modes to dispatch";
      return null;
    });
    const p = requestHubDispatch(compiled());
    await vi.waitFor(() => expect(h.plans).toHaveLength(1));
    await expect(h.plans[0].run!()).rejects.toMatch(/MODE_SURFACE_ONLY/);
    // A later onCancel (the card closing) can't re-settle it as a cancel.
    h.plans[0].onCancel?.();
    const err = await p.catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(HubDispatchCancelled);
    expect(String(err)).toContain("MODE_SURFACE_ONLY");
    const coach = effectiveOf(PRESET_MODES, "coach");
    expect(hubRefusalText(err, coach, true)).toBe("Coach mode builds nothing, so nothing was queued — your answers are still here. Switch to Brainstorming or Builder to stage this.");
    expect(hubRefusalText(err, coach, true)).not.toBe(SOLO_REFUSAL_LINE);
    expect(hubRefusalText(err, coach, true)).not.toMatch(/MODE_|timed out|park/);
  });
  it("resolves once staged, and records the interview (from the stored, scrubbed brief) in the chat", async () => {
    const c = compiled();
    h.xcmd.mockImplementation(async (name: string) => {
      if (name === "build_enqueue") return c.envelope;
      if (name === "build_hub_view") return { builds: [{ ...c.envelope, envelope: c.envelope, brief: c.brief, position: 1 }] };
      return null;
    });
    const p = requestHubDispatch(c, undefined, "prompter");
    await vi.waitFor(() => expect(h.plans).toHaveLength(1));
    const r = await h.plans[0].run!();
    await expect(p).resolves.toBe(c.envelope.build_id);
    expect(r.text).toContain("#1 in the queue");
    const turn = useVoice.getState().turns.find((t) => t.from === "prompter");
    expect(turn?.text).toContain("the Prompter's questions");
    expect(turn?.text).toContain("MUST work offline");
    expect(turn?.text).toContain("Acceptance criteria");
    // The interview also opens the build's Agent Conversation: Rust gets the questions and
    // answers (and who asked them) with the approved enqueue — never without the card's yes.
    const call = h.xcmd.mock.calls.find(([n]) => n === "build_enqueue")!;
    expect(call[1]).toMatchObject({ approved: true, intakeSource: "prompter" });
    expect(call[1].intake).toContainEqual({ q: "What does done look like?", a: "MUST work offline" });
    expect(c.intake).toHaveLength(3);
  });
  it("interviewOf reads only the interview block", () => {
    expect(interviewOf("Intake interview:\nQ: a?\nA: b\n\nBrainstorm notes (1, oldest first):\n## x\ny")).toBe("Q: a?\nA: b");
    expect(interviewOf("no interview here")).toBeNull();
  });
});
