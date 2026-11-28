import { describe, expect, it } from "vitest";
import { LEAD_S, PcmChunker, StreamSchedule, streamable } from "./tts-stream";

const pcm = (...vals: number[]) => {
  const b = new Uint8Array(vals.length * 2);
  vals.forEach((v, i) => {
    const u = v < 0 ? v + 0x10000 : v;
    b[2 * i] = u & 0xff;
    b[2 * i + 1] = u >> 8;
  });
  return b;
};

describe("streamable", () => {
  it("only plain roster lines, only when the switch is on, never on the phone", () => {
    expect(streamable({ agent: "general" }, true, false)).toBe(true);
    expect(streamable({ agent: "general" }, false, false)).toBe(false);
    expect(streamable({ agent: "general" }, true, true)).toBe(false);
    expect(streamable({ agent: "general", cache: true }, true, false)).toBe(false);
    expect(streamable({ agent: "general", localOnly: true }, true, false)).toBe(false);
    expect(streamable({ voice: "am_michael" }, true, false)).toBe(false);
    expect(streamable(undefined, true, false)).toBe(false);
  });
});

describe("PcmChunker", () => {
  it("decodes signed 16-bit little endian", () => {
    const out = new PcmChunker().push(pcm(0, 16384, -32768, 32767));
    expect(Array.from(out)).toEqual([0, 0.5, -1, 32767 / 32768]);
  });

  it("carries a split sample into the next chunk", () => {
    const c = new PcmChunker();
    const b = pcm(16384, -16384);
    expect(Array.from(c.push(b.slice(0, 3)))).toEqual([0.5]);
    expect(Array.from(c.push(b.slice(3)))).toEqual([-0.5]);
  });
});

describe("StreamSchedule", () => {
  const rate = 1000; // 1 sample = 1 ms keeps the arithmetic readable
  const ms = (n: number) => new Float32Array(n);

  it("waits for 100 ms of audio, then plays pieces back to back", () => {
    const s = new StreamSchedule(rate);
    expect(s.push(ms(60), 0)).toEqual([]);
    const [[at1, p1]] = s.push(ms(60), 1);
    expect(at1).toBeCloseTo(1 + LEAD_S);
    expect(p1.length).toBe(120);
    expect(s.push(ms(20), 1.05)).toEqual([]); // under 40 ms: held back
    const [[at2, p2]] = s.push(ms(30), 1.06);
    expect(at2).toBeCloseTo(1 + LEAD_S + 0.12); // right where the first ends
    expect(p2.length).toBe(50);
  });

  it("an underrun starts the next piece now, never in the past", () => {
    const s = new StreamSchedule(rate);
    s.push(ms(100), 0);
    const [[at]] = s.push(ms(50), 5);
    expect(at).toBeCloseTo(5 + LEAD_S);
  });

  it("the end of the stream flushes whatever is left, and whole() has everything", () => {
    const s = new StreamSchedule(rate);
    expect(s.push(ms(30), 0)).toEqual([]);
    const pieces = s.push(new Float32Array(0), 0, true);
    expect(pieces).toHaveLength(1);
    expect(pieces[0][1].length).toBe(30);
    expect(s.whole().length).toBe(30);
    expect(s.push(new Float32Array(0), 0, true)).toEqual([]);
  });
});
