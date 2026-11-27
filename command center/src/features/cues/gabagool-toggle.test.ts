import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Fix pass: the Mode Panel / ModePill Gabagool switch shows "Gabagool is playing", so its tap must
 * match: another cue playing → that stops AND Gabagool starts (it used to only stop the other cue).
 */
const h = vi.hoisted(() => ({ run: { running: null as string | null, builtin: null as string | null }, runCue: vi.fn(), stopAllAudio: vi.fn(), push: vi.fn() }));

vi.mock("@/lib/cc-api", () => ({
  collections: { snapshot: () => [{ id: "g1", name: "Gabagool Mode", builtin: "gabagool", enabled: true, phrases: [], action: { kind: "none", value: "" }, days: [] }] },
  useCollection: vi.fn(),
}));
vi.mock("./player", () => ({ runCue: h.runCue, stopAllAudio: h.stopAllAudio, useCueRun: { getState: () => h.run } }));
vi.mock("@/stores/nav", () => ({ useNav: { getState: () => ({ go: vi.fn() }) }, SECTIONS: [] }));
vi.mock("@/features/voice/voice-store", () => ({ useVoice: { getState: () => ({ setActiveThread: vi.fn() }) }, THREADS: [] }));
vi.mock("@/features/reminders/notify", () => ({ useToasts: { getState: () => ({ push: h.push }) } }));

import { toggleGabagoolMode } from "./cue-runtime";

beforeEach(() => {
  h.run = { running: null, builtin: null };
  for (const f of [h.runCue, h.stopAllAudio, h.push]) f.mockReset();
  h.runCue.mockResolvedValue(undefined);
});

describe("toggleGabagoolMode", () => {
  it("nothing playing: starts Gabagool", () => {
    toggleGabagoolMode();
    expect(h.stopAllAudio).not.toHaveBeenCalled();
    expect(h.runCue).toHaveBeenCalledWith(expect.objectContaining({ builtin: "gabagool" }), expect.any(Function), expect.any(Function));
  });

  it("Gabagool playing: stops it, starts nothing", () => {
    h.run = { running: "Gabagool Mode", builtin: "gabagool" };
    toggleGabagoolMode();
    expect(h.stopAllAudio).toHaveBeenCalledTimes(1);
    expect(h.runCue).not.toHaveBeenCalled();
  });

  it("another cue playing (switch shows off): that cue stops and Gabagool starts", () => {
    h.run = { running: "Good morning", builtin: "startup" };
    toggleGabagoolMode();
    expect(h.stopAllAudio).toHaveBeenCalledTimes(1);
    expect(h.runCue).toHaveBeenCalledWith(expect.objectContaining({ builtin: "gabagool" }), expect.any(Function), expect.any(Function));
  });
});
