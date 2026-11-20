import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Brainstorm Listen Mode: the regressions of the thoughtform pipeline hardening pass — a failed
 * save never kills the loop or loses the phrase, Listen Mode holds Tony's wake listen, the mic is
 * re-armed the moment a phrase ends (not after Whisper + the save), a deleted note is never
 * resurrected, phrases appended during an organize still count, and the continuous profile is cut
 * into segments.
 */
vi.hoisted(() => {
  const m = new Map<string, string>();
  Object.assign(globalThis, {
    localStorage: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k), clear: () => m.clear(), key: () => null, length: 0 },
  });
});

type Handlers = { onPhase: (p: string) => void; onFinal: (t: string) => void; onError: (e: string) => void };
const h = vi.hoisted(() => ({
  starts: [] as { stt: unknown; handlers: Handlers; opts: Record<string, unknown> }[],
  stop: vi.fn(),
  abort: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  organize: vi.fn(),
  holdWake: vi.fn(),
  notes: [] as { id: string; segments?: { t: number; text: string; device: string }[] }[],
}));

vi.mock("@/lib/platform", () => ({ platform: "desktop", isTauri: () => true }));
vi.mock("@/lib/cc-api", () => ({
  cc: { organize: h.organize },
  collections: { create: h.create, update: h.update, sync: async () => undefined, snapshot: () => h.notes },
}));
vi.mock("@/features/voice/voice-controller", () => ({ holdWake: h.holdWake }));
vi.mock("@/features/voice/engines", () => {
  class FakeStt {
    readonly name = "fake";
    readonly supported = true;
    start(handlers: Handlers, opts: Record<string, unknown>) {
      h.starts.push({ stt: this, handlers, opts });
    }
    stop = h.stop;
    abort = h.abort;
  }
  return { WhisperStt: FakeStt, WebSpeechStt: FakeStt };
});

import { CONTINUOUS_SEGMENT_MS, useBrainstorm } from "./capture";
import { setMicEnabledLocal } from "@/features/voice/mic-gate";
import { useSettings } from "@/stores/settings";

const last = () => h.starts[h.starts.length - 1];

beforeEach(async () => {
  vi.useRealTimers();
  setMicEnabledLocal(true);
  useBrainstorm.getState().abort();
  useBrainstorm.setState({ noteId: null, listening: false, phase: "idle", sinceOrganize: 0, organizing: false, error: null });
  h.starts.length = 0;
  for (const f of [h.stop, h.abort, h.create, h.update, h.organize, h.holdWake]) f.mockReset();
  h.notes = [{ id: "note-1", segments: [] }];
  h.create.mockResolvedValue({ id: "note-new" });
  h.update.mockImplementation(async (_c: string, id: string, patch: { segments: { t: number; text: string; device: string }[] }) => {
    const n = h.notes.find((x) => x.id === id);
    if (n) n.segments = patch.segments;
    else h.notes.push({ id, segments: patch.segments });
    return {};
  });
  useSettings.setState((s) => ({ brainstorm: { ...s.brainstorm, listenProfile: "relaxed", autoOrganizeEvery: 0 } }));
});

describe("Listen Mode (thoughtform hardening regressions)", () => {
  it("a failed save keeps the phrase, says so, keeps listening, and saves it with the next one", async () => {
    await useBrainstorm.getState().start("note-1");
    h.update.mockRejectedValueOnce(new Error("Gateway unreachable"));
    last().handlers.onFinal("first thought");
    await vi.waitFor(() => expect(useBrainstorm.getState().error).toMatch(/Couldn't save that thought/));
    await vi.waitFor(() => expect(h.starts).toHaveLength(2)); // re-armed, not dead
    expect(useBrainstorm.getState().listening).toBe(true);
    last().handlers.onFinal("second thought");
    await vi.waitFor(() => expect(h.notes[0].segments?.map((s) => s.text)).toEqual(["first thought", "second thought"]));
    expect(useBrainstorm.getState().error).toBeNull();
  });

  it("holds Tony's hands-free wake listen while listening, and releases it on stop", async () => {
    await useBrainstorm.getState().start("note-1");
    await vi.waitFor(() => expect(h.holdWake).toHaveBeenCalledWith(true));
    h.stop.mockImplementation(() => last().handlers.onFinal(""));
    await useBrainstorm.getState().stop();
    await vi.waitFor(() => expect(h.holdWake).toHaveBeenLastCalledWith(false));
  });

  it("the next listen opens the moment a phrase ends (before Whisper and the save finish)", async () => {
    await useBrainstorm.getState().start("note-1");
    const first = last();
    first.handlers.onPhase("transcribing");
    await vi.waitFor(() => expect(h.starts).toHaveLength(2));
    expect(h.starts[1].stt).not.toBe(first.stt); // its own engine: the first one is still transcribing
    first.handlers.onFinal("the phrase that just ended");
    await vi.waitFor(() => expect(h.notes[0].segments).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 200));
    expect(h.starts).toHaveLength(2); // re-armed exactly once
  });

  it("never writes into (and resurrects) a note deleted meanwhile", async () => {
    useBrainstorm.setState({ noteId: "gone" });
    await useBrainstorm.getState().start(); // the orb with no note selected
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(useBrainstorm.getState().noteId).toBe("note-new");
    // Deleted while listening: the phrase goes to a fresh note, never a PATCH of the deleted one.
    h.notes = [{ id: "other" }];
    last().handlers.onFinal("a thought");
    await vi.waitFor(() => expect(h.update).toHaveBeenCalled());
    expect(h.update.mock.calls.every((c) => c[1] !== "gone")).toBe(true);
  });

  it("phrases appended while an organize runs still count toward the final organize", async () => {
    await useBrainstorm.getState().start("note-1");
    let finish!: () => void;
    h.organize.mockImplementation(() => new Promise<void>((r) => (finish = r)));
    useBrainstorm.setState({ sinceOrganize: 2 });
    const org = useBrainstorm.getState().organize("note-1");
    useBrainstorm.setState({ sinceOrganize: 4 }); // two more landed meanwhile
    finish();
    await org;
    expect(useBrainstorm.getState().sinceOrganize).toBe(2);
  });

  it("the continuous profile is cut into segments while it records (never one session-long clip)", async () => {
    vi.useFakeTimers();
    useSettings.setState((s) => ({ brainstorm: { ...s.brainstorm, listenProfile: "continuous" } }));
    await useBrainstorm.getState().start("note-1");
    expect(h.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(CONTINUOUS_SEGMENT_MS + 10);
    expect(h.stop).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
