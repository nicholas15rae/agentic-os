import { describe, expect, it, vi } from "vitest";
import { cueActive, cuesPlaying, CUE_ROLES, DEFAULT_POOL, estimateSecs, LINE_MAX, pickExchange, playExchange, withHandoff, type Beat, type HandoffPool } from "./handoff-cues";

const seq = (...xs: number[]) => {
  let i = 0;
  return () => xs[i++ % xs.length];
};

describe("vocal handoff pool", () => {
  it("bundled pool: every crew role gets a 3-beat Tony → agent → Tony exchange within 5 s", () => {
    for (const role of CUE_ROLES) {
      for (let n = 0; n < 25; n++) {
        const beats = pickExchange(DEFAULT_POOL, role)!;
        expect(beats.map((b) => b.speaker)).toEqual(["general", role, "general"]);
        expect(estimateSecs(beats)).toBeLessThanOrEqual(5);
        expect(beats.every((b) => !/\{(nic|tony|agent)\}/.test(b.text))).toBe(true);
      }
    }
  });

  it("templating uses nicknames and the agent's name — never anything from the task", () => {
    const pool: HandoffPool = { ...DEFAULT_POOL, tonyOpen: ["All right {nic}, over to {agent}."], agentReply: { default: ["What's goin' on, {tony}? I got it."] }, tonyClose: ["All right, peace."], nicknames: { nic: ["Nic"], tony: ["Tone"] } };
    expect(pickExchange(pool, "coder", seq(0))).toEqual([
      { speaker: "general", text: "All right Nic, over to the Coder." },
      { speaker: "coder", text: "What's goin' on, Tone? I got it." },
      { speaker: "general", text: "All right, peace." },
    ]);
  });

  it("a pool whose lines can never fit falls back to the shortest lines (the deadline still caps playback)", () => {
    const wordy = "one two three four five six seven eight nine ten eleven twelve";
    const b = pickExchange({ ...DEFAULT_POOL, tonyOpen: [wordy, "Go {agent}."], agentReply: { default: [wordy] }, tonyClose: [wordy] }, "ops", seq(0))!;
    expect(b[0].text).toBe("Go Ops.");
  });

  it("no cue for Tony himself, Claude, or unknown roles; none from an empty pool", () => {
    expect(pickExchange(DEFAULT_POOL, "general")).toBeNull();
    expect(pickExchange(DEFAULT_POOL, "claude")).toBeNull();
    expect(pickExchange({ ...DEFAULT_POOL, tonyClose: ["x".repeat(LINE_MAX + 1)] }, "coder")).toBeNull();
  });

  it("over-budget lines lose to ones that fit", () => {
    const long = "word ".repeat(16).trim();
    const pool: HandoffPool = { ...DEFAULT_POOL, tonyOpen: ["Okay {agent}.", long], agentReply: { default: ["On it."] }, tonyClose: ["Go."] };
    // rng order per try: nic, tony, open, reply, close — the first try draws the long line.
    const beats = pickExchange(pool, "ops", seq(0, 0, 0.9, 0, 0, 0, 0, 0, 0, 0))!;
    expect(beats[0].text).toBe("Okay Ops.");
    expect(estimateSecs(beats)).toBeLessThanOrEqual(5);
  });
});

const beats: Beat[] = [
  { speaker: "general", text: "All right Nic, over to the Coder." },
  { speaker: "coder", text: "Got it, Tone." },
  { speaker: "general", text: "Peace." },
];

describe("playExchange", () => {
  it("speaks the beats in order in each speaker's voice", async () => {
    const spoken: string[] = [];
    const h = playExchange(beats, { speak: async (t, v) => void spoken.push(`${v}:${t}`), isLive: () => true });
    expect(await h.done).toBe("completed");
    expect(spoken).toEqual(["general:All right Nic, over to the Coder.", "coder:Got it, Tone.", "general:Peace."]);
  });

  it("a barge-in / mic shutoff (isLive → false) drops the remaining beats cleanly", async () => {
    let live = true;
    const spoken: string[] = [];
    const h = playExchange(beats, {
      speak: async (t) => {
        spoken.push(t);
        live = false; // Nic spoke over the first beat
      },
      isLive: () => live,
    });
    expect(await h.done).toBe("cancelled");
    expect(spoken).toHaveLength(1);
  });

  it("cancel() stops it; the deadline skips beats that can't start in time", async () => {
    const h = playExchange(beats, { speak: async () => undefined, isLive: () => true });
    h.cancel();
    expect(await h.done).toBe("cancelled");
    let t = 0;
    const spoken: string[] = [];
    const slow = playExchange(beats, { speak: async (x) => void (spoken.push(x), (t += 4800)), isLive: () => true, now: () => t }, 5);
    expect(await slow.done).toBe("timeout");
    expect(spoken).toHaveLength(1);
  });

  it("prefetches every beat up front and never throws on a TTS failure", async () => {
    const prefetch = vi.fn();
    const h = playExchange(beats, { speak: async () => Promise.reject(new Error("tts down")), prefetch, isLive: () => true });
    expect(prefetch).toHaveBeenCalledTimes(3);
    expect(await h.done).toBe("completed");
  });
});

describe("withHandoff: the job never waits on the cue", () => {
  it("dispatches before the cue starts and resolves while the cue is still speaking", async () => {
    const order: string[] = [];
    const never = new Promise<void>(() => undefined);
    const { result, cue } = withHandoff(
      async () => {
        order.push("dispatch");
        return "queued";
      },
      () => {
        order.push("cue");
        return playExchange(beats, { speak: () => never, isLive: () => true });
      },
    );
    expect(order).toEqual(["dispatch", "cue"]);
    await expect(result).resolves.toBe("queued");
    expect(cue).not.toBeNull();
  });

  it("a throwing cue never breaks the dispatch", async () => {
    const { result, cue } = withHandoff(
      async () => 1,
      () => {
        throw new Error("no voices");
      },
    );
    await expect(result).resolves.toBe(1);
    expect(cue).toBeNull();
  });
});

describe("review #11: a playing exchange counts as busy audio", () => {
  it("cueActive is true while beats play and false after", async () => {
    const before = cuesPlaying(); // earlier tests leave never-ending exchanges behind on purpose
    let finish!: () => void;
    const h = playExchange(beats, { speak: () => new Promise<void>((r) => (finish = r)), isLive: () => true });
    expect(cueActive()).toBe(true);
    expect(cuesPlaying()).toBe(before + 1);
    h.cancel();
    finish();
    await h.done;
    expect(cuesPlaying()).toBe(before);
  });
});
