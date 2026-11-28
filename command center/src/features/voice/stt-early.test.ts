import { describe, expect, it, vi } from "vitest";
import { EARLY_AT_MS, EarlyFinal } from "./stt-early";

const clip = (n: number, seed = 1) => Float32Array.from({ length: n }, (_, i) => ((i * 7 + seed) % 13) / 13);
const tick = (quietMs: number, audio: Float32Array) => ({ speechMs: 1000, quietMs, rate: 16000, audio: () => audio });

describe("EarlyFinal", () => {
  it("decodes once the pause reaches 150 ms, and that text is the final when nothing was said since", async () => {
    const decode = vi.fn(async (pcm: Float32Array) => `heard ${pcm.length}`);
    const e = new EarlyFinal(decode);
    const sofar = clip(8000);
    e.tick(tick(EARLY_AT_MS - 20, sofar));
    expect(decode).not.toHaveBeenCalled();
    e.tick(tick(EARLY_AT_MS + 1, sofar));
    e.tick(tick(EARLY_AT_MS + 40, sofar)); // still the same pause: no second decode
    expect(decode).toHaveBeenCalledTimes(1);
    // The final clip = the same audio plus the rest of the pause.
    const final = new Float32Array(9000);
    final.set(sofar);
    await expect(e.take(final)).resolves.toBe("heard 8000");
    expect(e.used).toBe(1);
  });

  it("speaking again throws the early text away, and the next pause starts a fresh one", () => {
    const decode = vi.fn(async () => "x");
    const e = new EarlyFinal(decode);
    e.tick(tick(200, clip(4000)));
    e.tick(tick(0, clip(4100))); // a word
    const longer = clip(9000);
    e.tick(tick(200, longer));
    expect(decode).toHaveBeenCalledTimes(2);
    expect(e.take(longer)).not.toBeNull();
  });

  it("a stale early text is never used", () => {
    const e = new EarlyFinal(async () => "old");
    e.tick(tick(200, clip(4000)));
    e.tick(tick(0, clip(4000)));
    expect(e.take(clip(6000))).toBeNull();
  });

  it("a clip that doesn't start with the decoded audio decodes as today", () => {
    const e = new EarlyFinal(async () => "x");
    e.tick(tick(200, clip(4000, 1)));
    expect(e.take(clip(6000, 5))).toBeNull();
    const e2 = new EarlyFinal(async () => "x");
    e2.tick(tick(200, clip(4000)));
    expect(e2.take(clip(3000))).toBeNull(); // shorter than what it decoded
  });

  it("reset drops it; a failed early decode rejects so the caller falls back", async () => {
    const e = new EarlyFinal(async () => {
      throw new Error("busy");
    });
    const a = clip(4000);
    e.tick(tick(200, a));
    const p = e.take(a);
    await expect(p).rejects.toThrow("busy");
    e.tick(tick(200, a));
    e.reset();
    expect(e.take(a)).toBeNull();
  });
});
