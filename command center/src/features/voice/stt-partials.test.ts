import { describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => core);

import { DEFAULT_PARTIAL_MS, LocalAgreement, PARTIAL_MAX_SPEECH_MS, PartialLoop, partialMsFrom, replyStreaming, sttPartial, type PartialLoopOpts, type PartialReply, type SpeechTick } from "./stt-partials";
import { PhoneSttStream, streamFinalMs, streamUrl, type SocketLike } from "./stt-stream";

describe("sttPartial (desktop IPC)", () => {
  it("sends the WAV as the raw body of Rust stt_partial, the capture id as a header", async () => {
    core.invoke.mockResolvedValue({ text: "Tony", stale: false, off: false, busy: false });
    const wav = new Uint8Array([82, 73, 70, 70]);
    await expect(sttPartial(wav, "cap-1")).resolves.toEqual({ text: "Tony", stale: false, off: false, busy: false });
    expect(core.invoke).toHaveBeenCalledWith("stt_partial", wav, { headers: { "x-capture": "cap-1" } });
  });
});

describe("LocalAgreement-2", () => {
  it("commits what two hypotheses agree on, never retracts, and matches the Python copies", () => {
    // The same sequence as tests/test_fw_server.py and tests/test_language_hub.py.
    const la = new LocalAgreement();
    const seen = ["Play", "Play Bill", "Play Bilmuri on", "play, Bilmuri on Spotify.", "Pay Bilmuri on Spotify now", ""].map((s) => {
      const v = la.push(s);
      return [v.text, v.stable];
    });
    expect(seen).toEqual([
      ["Play", ""],
      ["Play Bill", "Play"],
      ["Play Bilmuri on", "Play"],
      ["Play Bilmuri on Spotify.", "Play Bilmuri on"],
      ["Play Bilmuri on Spotify now", "Play Bilmuri on"],
      ["Play Bilmuri on", "Play Bilmuri on"],
    ]);
  });

  it("splits stable and tentative", () => {
    const la = new LocalAgreement();
    la.push("Tony cut");
    // Committed words keep the newest hypothesis's spelling (as the Python copies do).
    expect(la.push("Tony, cut it out")).toEqual({ text: "Tony, cut it out", stable: "Tony, cut", tentative: "it out" });
  });
});

describe("settings and pauses", () => {
  it("partialMs: default, off, clamped", () => {
    expect(partialMsFrom(undefined)).toBe(DEFAULT_PARTIAL_MS);
    expect(partialMsFrom("600")).toBe(DEFAULT_PARTIAL_MS);
    expect(partialMsFrom(0)).toBe(0);
    expect(partialMsFrom(-5)).toBe(0);
    expect(partialMsFrom(50)).toBe(300);
    expect(partialMsFrom(99_999)).toBe(3000);
    expect(partialMsFrom(750.4)).toBe(750);
  });

  it("Tony's reply streaming pauses captions; a stale bubble does not", () => {
    const now = 1_000_000;
    expect(replyStreaming({ state: "thinking", turns: [] }, now)).toBe(true);
    expect(replyStreaming({ state: "speaking", turns: [{ meta: "streaming…", at: now - 2000 }] }, now)).toBe(true);
    expect(replyStreaming({ state: "listening", turns: [{ meta: "streaming…", at: now - 300_000 }] }, now)).toBe(false);
    expect(replyStreaming({ state: "listening", turns: [{ meta: "interrupted", at: now }] }, now)).toBe(false);
  });

  it("the phone's final wait grows with the clip", () => {
    expect(streamFinalMs(0)).toBe(6000);
    expect(streamFinalMs(10)).toBe(11_000);
  });

  it("stream URL: https → wss, the stream path, no query (the token never goes in the URL)", () => {
    expect(streamUrl("https://100.84.91.149:8443")).toBe("wss://100.84.91.149:8443/api/cc/lang/stt/stream");
    expect(streamUrl("http://127.0.0.1:8080/?token=x#y")).toBe("ws://127.0.0.1:8080/api/cc/lang/stt/stream");
    expect(streamUrl("file:///x")).toBeNull();
    expect(streamUrl("not a url")).toBeNull();
  });
});

/** A PartialLoop whose `send` resolves when the test says. */
function loopWith(over: Partial<PartialLoopOpts> = {}) {
  const pending: { wav: Uint8Array; resolve: (r: PartialReply) => void; reject: (e: Error) => void }[] = [];
  const onPartial = vi.fn();
  const send = vi.fn<(wav: Uint8Array, capture: string) => Promise<PartialReply>>(
    (wav) =>
      new Promise<PartialReply>((resolve, reject) => {
        pending.push({ wav, resolve, reject });
      }),
  );
  const encode = vi.fn((pcm: Float32Array) => new Uint8Array(44 + pcm.length));
  const loop = new PartialLoop({ everyMs: 600, capture: "cap-1", send, encode, onPartial, paused: () => false, allowed: () => true, ...over });
  const tick = (speechMs: number, quietMs = 0): SpeechTick => ({ speechMs, quietMs, rate: 48_000, audio: () => new Float32Array(speechMs * 48) });
  return { loop, pending, send, encode, onPartial, tick };
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("PartialLoop (desktop captions)", () => {
  it("one caption per partialMs of speech, single-flight, through LocalAgreement", async () => {
    const t = loopWith();
    t.loop.tick(t.tick(300));
    expect(t.send).not.toHaveBeenCalled(); // not yet 600 ms of speech
    t.loop.tick(t.tick(620));
    t.loop.tick(t.tick(1300)); // the first is still in flight: nothing more is sent
    expect(t.send).toHaveBeenCalledTimes(1);
    expect(t.send.mock.calls[0][1]).toBe("cap-1");
    expect(t.encode.mock.calls[0][0].length).toBe(620 * 48); // the audio so far, built only now
    t.pending[0].resolve({ text: "Tony" });
    await settle();
    expect(t.onPartial).toHaveBeenLastCalledWith("Tony", "");
    t.loop.tick(t.tick(1000)); // due at 620 + 600
    expect(t.send).toHaveBeenCalledTimes(1);
    t.loop.tick(t.tick(1230));
    t.pending[1].resolve({ text: "Tony, cut" });
    await settle();
    expect(t.onPartial).toHaveBeenLastCalledWith("Tony, cut", "Tony,");
  });

  it("skips a trailing pause, Tony's streaming reply and a muted mic without using up the slot", async () => {
    let paused = true;
    let allowed = true;
    const t = loopWith({ paused: () => paused, allowed: () => allowed });
    t.loop.tick(t.tick(700));
    paused = false;
    t.loop.tick(t.tick(720, 300)); // 300 ms quiet: the end is near
    allowed = false;
    t.loop.tick(t.tick(740));
    expect(t.send).not.toHaveBeenCalled();
    allowed = true;
    t.loop.tick(t.tick(760));
    expect(t.send).toHaveBeenCalledTimes(1);
  });

  it("off for the capture when the server is not on a GPU, or after two failures", async () => {
    const a = loopWith();
    a.loop.tick(a.tick(600));
    a.pending[0].resolve({ text: "", off: true });
    await settle();
    a.loop.tick(a.tick(5000));
    expect(a.send).toHaveBeenCalledTimes(1);
    expect(a.loop.disabled).toBe(true);

    const b = loopWith();
    b.loop.tick(b.tick(600));
    b.pending[0].reject(new Error("timed out"));
    await settle();
    b.loop.tick(b.tick(1200));
    b.pending[1].reject(new Error("timed out"));
    await settle();
    b.loop.tick(b.tick(1800));
    expect(b.send).toHaveBeenCalledTimes(2);
  });

  it("stale / busy replies show nothing; nothing after close() (the final took over); none past one window", async () => {
    const t = loopWith();
    t.loop.tick(t.tick(600));
    t.pending[0].resolve({ text: "", stale: true });
    await settle();
    t.loop.tick(t.tick(1200));
    t.pending[1].resolve({ text: "x", busy: true });
    await settle();
    t.loop.tick(t.tick(1800));
    t.loop.close();
    t.pending[2].resolve({ text: "late" });
    await settle();
    expect(t.onPartial).not.toHaveBeenCalled();
    const long = loopWith();
    long.loop.tick(long.tick(PARTIAL_MAX_SPEECH_MS));
    long.loop.tick(long.tick(PARTIAL_MAX_SPEECH_MS + 600));
    expect(long.send).not.toHaveBeenCalled();
  });
});

class FakeSocket implements SocketLike {
  binaryType: BinaryType = "blob";
  sent: (string | ArrayBuffer)[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) {}
  send(d: string | ArrayBuffer) {
    this.sent.push(d);
  }
  close() {
    this.closed = true;
  }
  json() {
    return this.sent.filter((s): s is string => typeof s === "string").map((s) => JSON.parse(s));
  }
  audio() {
    return this.sent.filter((s): s is ArrayBuffer => typeof s !== "string").reduce((n, b) => n + b.byteLength, 0);
  }
  reply(o: unknown) {
    this.onmessage?.({ data: JSON.stringify(o) });
  }
}

function stream(over: Partial<ConstructorParameters<typeof PhoneSttStream>[0]> = {}) {
  let sock!: FakeSocket;
  const onPartial = vi.fn();
  const s = new PhoneSttStream({
    url: "wss://pc:8443/api/cc/lang/stt/stream",
    token: () => "s3cret",
    inRate: 48_000,
    partials: true,
    partialMs: 600,
    onPartial,
    socket: (u) => (sock = new FakeSocket(u)),
    ...over,
  });
  return { s, sock: () => sock, onPartial };
}

describe("PhoneSttStream", () => {
  it("queues until open, sends the token only in the start message, batches ~100 ms of PCM16", async () => {
    const t = stream();
    t.s.push(new Float32Array(2400)); // 50 ms at 48 kHz: under one batch
    expect(t.sock().sent).toEqual([]);
    t.s.push(new Float32Array(2880)); // 60 ms
    t.sock().onopen?.({});
    expect(t.sock().binaryType).toBe("arraybuffer");
    expect(t.sock().json()[0]).toEqual({ type: "start", lang: "en", partials: true, partial_ms: 600, token: "s3cret" });
    expect(t.sock().url).not.toContain("s3cret");
    expect(t.sock().audio()).toBe(1760 * 2); // 110 ms at 16 kHz, one message
    t.sock().reply({ type: "partial", partial: "Tony cut", stable: "Tony" });
    expect(t.onPartial).toHaveBeenCalledWith("Tony cut", "Tony");
    t.s.setPartials(false);
    t.s.setPartials(false); // only a change is sent
    t.s.push(new Float32Array(480)); // 10 ms tail
    const fin = t.s.finish(5000);
    expect(t.sock().json().slice(1)).toEqual([{ type: "config", partials: false }, { type: "end" }]);
    expect(t.sock().audio()).toBe(1920 * 2); // the tail was flushed before "end"
    t.sock().reply({ type: "final", final: "Tony, cut it." });
    await expect(fin).resolves.toBe("Tony, cut it.");
    expect(t.sock().closed).toBe(true);
  });

  it("rejects the final on an error message, a close, a timeout or a dead socket (the caller uploads)", async () => {
    vi.useFakeTimers();
    try {
      const a = stream();
      a.sock().onopen?.({});
      const fa = a.s.finish(5000);
      a.sock().reply({ type: "error", error: "unavailable" });
      await expect(fa).rejects.toThrow("unavailable");

      const b = stream();
      b.sock().onopen?.({});
      const fb = b.s.finish(5000);
      b.sock().onclose?.({});
      await expect(fb).rejects.toThrow("closed");

      const c = stream();
      c.sock().onopen?.({});
      const fc = c.s.finish(5000);
      vi.advanceTimersByTime(5001);
      await expect(fc).rejects.toThrow("final timed out");

      const d = stream({ connectMs: 1000 });
      vi.advanceTimersByTime(1001); // never opened
      expect(d.s.broken).toBe(true);
      await expect(d.s.finish(5000)).rejects.toThrow("connect timeout");

      const e = stream({
        socket: () => {
          throw new Error("blocked by CSP");
        },
      });
      await expect(e.s.finish(5000)).rejects.toThrow("no socket");
    } finally {
      vi.useRealTimers();
    }
  });

  it("abort sends cancel once open and never captions again", () => {
    const t = stream();
    t.sock().onopen?.({});
    t.s.abort();
    expect(t.sock().json().at(-1)).toEqual({ type: "cancel" });
    expect(t.sock().closed).toBe(true);
    t.sock().onmessage?.({ data: JSON.stringify({ type: "partial", partial: "x" }) }); // handlers were detached
    expect(t.onPartial).not.toHaveBeenCalled();
  });
});
