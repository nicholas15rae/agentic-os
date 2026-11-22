import { describe, expect, it, vi } from "vitest";
import type { CueWidget } from "./types";

// Mimics player.runCue's contract: it bumps the generation synchronously, resolves later,
// and a stop (another bump) supersedes it.
const p = vi.hoisted(() => ({ gen: 0, order: [] as string[], finish: new Map<string, () => void>() }));
vi.mock("./player", () => ({
  cueGeneration: () => p.gen,
  runCue: vi.fn((w: CueWidget) => {
    p.gen++;
    p.order.push(w.name);
    return new Promise<void>((r) => p.finish.set(w.name, r));
  }),
  stopAllAudio: vi.fn(),
  useCueRun: { getState: () => ({ cueId: null }) },
}));
vi.mock("@/lib/cc-api", () => ({ collections: { snapshot: () => [] }, useCollection: vi.fn() }));
vi.mock("@/stores/nav", () => ({ useNav: { getState: () => ({ go: vi.fn() }) }, SECTIONS: [] }));
vi.mock("@/features/voice/voice-store", () => ({ useVoice: { getState: () => ({ setActiveThread: vi.fn() }) }, THREADS: [] }));
vi.mock("@/features/reminders/notify", () => ({ useToasts: { getState: () => ({ push: vi.fn() }) } }));

import { runStartupCues } from "./cue-runtime";

const cue = (name: string, extra: Partial<CueWidget> = {}) => ({ name, enabled: true, startup: true, ...extra }) as CueWidget;
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("startup cues", () => {
  it("play one after another, the built-in welcome first, skipping disabled / non-startup ones", async () => {
    p.gen = 0;
    p.order = [];
    const done = runStartupCues([cue("Gabagool"), cue("Off", { enabled: false }), cue("Welcome", { builtin: "startup" }), cue("Phrase only", { startup: false }), cue("Gypsy")]);
    await tick();
    expect(p.order).toEqual(["Welcome"]); // the others wait — they no longer cancel it
    p.finish.get("Welcome")!();
    await tick();
    expect(p.order).toEqual(["Welcome", "Gabagool"]);
    p.finish.get("Gabagool")!();
    await tick();
    p.finish.get("Gypsy")!();
    await done;
    expect(p.order).toEqual(["Welcome", "Gabagool", "Gypsy"]);
  });

  it("a stop during one cue ends the chain", async () => {
    p.gen = 0;
    p.order = [];
    const done = runStartupCues([cue("Welcome", { builtin: "startup" }), cue("Gypsy")]);
    await tick();
    p.gen++; // the user said "stop"
    p.finish.get("Welcome")!();
    await done;
    expect(p.order).toEqual(["Welcome"]);
  });
});
