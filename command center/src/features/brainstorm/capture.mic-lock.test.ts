import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 2 Part B: Brainstorm Listen Mode under the hard mic lock. Locking the mic ABORTS the
 * listen (the phrase in flight is discarded, never flushed to Whisper, never appended or
 * organized) and its 120 ms / 1500 ms re-arms never reopen it. Starting while locked is refused.
 */
vi.hoisted(() => {
  const m = new Map<string, string>();
  Object.assign(globalThis, {
    localStorage: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k), clear: () => m.clear(), key: () => null, length: 0 },
  });
});

const h = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  abort: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  organize: vi.fn(),
}));

vi.mock("@/lib/platform", () => ({ platform: "desktop", isTauri: () => true }));
vi.mock("@/lib/cc-api", () => ({
  cc: { organize: h.organize },
  collections: { create: h.create, update: h.update, sync: async () => undefined, snapshot: () => [] },
}));
vi.mock("@/features/voice/engines", () => {
  class FakeStt {
    readonly name = "fake";
    readonly supported = true;
    start = h.start;
    stop = h.stop;
    abort = h.abort;
  }
  return { WhisperStt: FakeStt, WebSpeechStt: FakeStt };
});

import { useBrainstorm } from "./capture";
import { setMicEnabledLocal } from "@/features/voice/mic-gate";

beforeEach(() => {
  vi.useRealTimers();
  setMicEnabledLocal(true);
  useBrainstorm.setState({ noteId: null, listening: false, phase: "idle", sinceOrganize: 0, organizing: false, error: null });
  for (const f of Object.values(h)) f.mockReset();
  h.create.mockResolvedValue({ id: "note-1" });
});

describe("Listen Mode under the mic lock", () => {
  it("locking aborts (not flushes) the listen; nothing is appended or organized; no re-arm reopens it", async () => {
    await useBrainstorm.getState().start();
    expect(h.start).toHaveBeenCalledTimes(1);
    const handlers = h.start.mock.calls[0][0];
    useBrainstorm.setState({ sinceOrganize: 3 }); // an organize would be due on a normal stop
    vi.useFakeTimers();

    setMicEnabledLocal(false);
    expect(h.abort).toHaveBeenCalledTimes(1);
    expect(h.stop).not.toHaveBeenCalled(); // stop() would flush the last phrase to Whisper
    expect(useBrainstorm.getState()).toMatchObject({ listening: false, phase: "idle" });
    expect(useBrainstorm.getState().error).toBe("Mic locked off: Listen Mode stopped (last phrase discarded)");

    // A stale empty final / an error from the aborted engine schedules the usual re-arms.
    handlers.onFinal("");
    handlers.onError("Mic is locked off");
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.organize).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });

  it("start() while locked is refused: no note, no engine start", async () => {
    setMicEnabledLocal(false);
    await useBrainstorm.getState().start();
    expect(h.start).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
    expect(useBrainstorm.getState().error).toBe("Mic is locked off");
    expect(useBrainstorm.getState().listening).toBe(false);
  });

  it("a re-arm already queued when the mic locks does not start the engine", async () => {
    await useBrainstorm.getState().start();
    const handlers = h.start.mock.calls[0][0];
    vi.useFakeTimers();
    handlers.onFinal(""); // queues loop() in 120 ms (still listening)
    await Promise.resolve();
    await Promise.resolve();
    setMicEnabledLocal(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.start).toHaveBeenCalledTimes(1);
  });
});
