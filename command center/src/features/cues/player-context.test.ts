import { describe, expect, it, vi } from "vitest";
import { contextIsDead } from "@/lib/audio-context";

/**
 * Android reroutes audio when the mic opens and Chrome drops the running AudioContext with an
 * `error` event; a dropped context never plays again. The cue player must build a new one (and a
 * new master bus) instead of staying silent for the rest of the session.
 */
class FakeNode {
  gain = { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, setTargetAtTime() {} };
  threshold = { value: 0 };
  knee = { value: 0 };
  ratio = { value: 0 };
  attack = { value: 0 };
  release = { value: 0 };
  curve: unknown = null;
  oversample = "none";
  connect(n: unknown) {
    return n;
  }
}

class FakeContext {
  static made: FakeContext[] = [];
  state: AudioContextState = "running";
  destination = {};
  currentTime = 0;
  private listeners: Record<string, (() => void)[]> = {};
  constructor() {
    FakeContext.made.push(this);
  }
  addEventListener(type: string, f: () => void) {
    (this.listeners[type] ??= []).push(f);
  }
  fire(type: string) {
    for (const f of this.listeners[type] ?? []) f();
  }
  resume = vi.fn(async () => undefined);
  close = vi.fn(async () => {
    this.state = "closed";
  });
  createGain = () => new FakeNode();
  createDynamicsCompressor = () => new FakeNode();
  createWaveShaper = () => new FakeNode();
}

vi.stubGlobal("AudioContext", FakeContext);

describe("cue audio context", () => {
  it("contextIsDead: an error, closed or interrupted context is dead", () => {
    const c = { state: "running" } as AudioContext;
    expect(contextIsDead(c, false)).toBe(false);
    expect(contextIsDead(c, true)).toBe(true);
    expect(contextIsDead({ state: "closed" } as AudioContext, false)).toBe(true);
    expect(contextIsDead({ state: "interrupted" } as unknown as AudioContext, false)).toBe(true);
  });

  it("rebuilds the context after the audio device drops it", async () => {
    const { audio } = await import("./player");
    const first = audio() as unknown as FakeContext;
    expect(audio()).toBe(first as unknown as AudioContext); // reused while healthy
    first.fire("error"); // Android: "…error from the audio device or the WebAudio renderer"
    const second = audio() as unknown as FakeContext;
    expect(second).not.toBe(first);
    expect(first.close).toHaveBeenCalled();
    second.state = "closed";
    expect(audio()).not.toBe(second as unknown as AudioContext);
    expect(FakeContext.made).toHaveLength(3);
  });
});
