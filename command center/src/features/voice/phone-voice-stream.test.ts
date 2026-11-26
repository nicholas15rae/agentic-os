import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P5: the phone speaks Tony's reply while the desktop is still writing it. Through the real voice
 * controller on the phone (isDesktopApp false), with dispatch() mocked: the test drives its
 * `onPartial` (P3) and its final answer. Engines, audio and the gateway are stubbed (mocks as
 * tier3-phone-handoff.test.ts).
 */
vi.hoisted(() => {
  const m = new Map<string, string>();
  Object.assign(globalThis, {
    localStorage: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k), clear: () => m.clear(), key: () => null, length: 0 },
  });
});

const h = vi.hoisted(() => ({
  cmd: vi.fn(),
  execute: vi.fn(),
  dispatch: vi.fn(),
  speak: vi.fn(),
  prefetch: vi.fn(),
  sttStart: vi.fn(),
  sttAbort: vi.fn(),
}));
const env = vi.hoisted(() => ({ desktop: false, bargeIn: false }));

vi.mock("@/features/modes/modes-store", async () => {
  const m = await vi.importActual<typeof import("@/features/modes/modes")>("@/features/modes/modes");
  // Nothing frozen on the master switchboard; the live rule is the real one.
  return { useModes: { getState: () => ({ effective: m.DEFAULT_EFFECTIVE, load: async () => undefined }) }, currentFreeze: () => ({}), isToolLiveNow: (s: string) => m.toolLive(m.DEFAULT_EFFECTIVE, s, {}) };
});
vi.mock("@/lib/platform", () => ({ cmd: h.cmd, isTauri: () => env.desktop, onNativeEvent: async () => () => undefined, platform: "web" }));
vi.mock("@/lib/gateway", () => {
  class GatewayError extends Error {
    constructor(message: string, readonly status?: number) {
      super(message);
    }
  }
  // The phone's mic-gate poll reads the desktop's voice settings: nothing to report here.
  return { gateway: async () => ({}), api: { chat: vi.fn() }, GatewayError };
});
vi.mock("@/stores/nav", () => ({ useNav: { getState: () => ({ section: "command" }) } }));
vi.mock("@/stores/settings", () => ({
  isDesktopApp: () => env.desktop,
  isAndroidApp: () => !env.desktop,
  useSettings: {
    getState: () => ({
      osName: "Tony",
      wakeMode: false,
      confirmTimeoutSec: 30,
      routing: { announcerHandoff: false },
      audioRoute: "auto",
      conversation: { audioRoute: "auto", bargeIn: env.bargeIn, followUp: false, followUpSecs: 6, bargeEndSilenceMs: 500 },
    }),
  },
}));
vi.mock("@/features/os/os-store", () => ({ useOs: { getState: () => ({ cfg: null }) }, osName: () => "Tony", useOsName: () => "Tony" }));
vi.mock("@/sections/settings/use-providers", () => ({ useProviders: { getState: () => ({ view: null, load: async () => undefined }) } }));
vi.mock("@/features/cues/cue-runtime", () => ({ cueFor: () => null, fireCue: vi.fn(), registerCueIO: vi.fn() }));
vi.mock("@/features/cues/player", () => ({ cueRecentlyActive: () => false, registerSpeechCancel: vi.fn(), setCueDuck: vi.fn(), stopAllAudio: vi.fn() }));
vi.mock("@/features/os/os-intents", () => ({ cuePlayingNow: () => false, parseOsLine: () => null, runOsIntent: vi.fn() }));
vi.mock("@/features/os/spotify-intents", () => ({ cueOwnsVolume: () => false, parseSpotifyLine: async () => null, runPendingSpotify: vi.fn(), runSpotifyIntent: vi.fn() }));
vi.mock("@/features/os/pipeline-store", () => ({ runPipeline: vi.fn(), trackTask: vi.fn(), usePipelines: { getState: () => ({ runs: {}, recent: {} }) } }));
vi.mock("@/features/os/context", () => ({ liveContext: async () => "" }));
vi.mock("@/features/reminders/intents", () => ({ handleLocalIntent: async () => null }));
vi.mock("@/features/bridge/gate", () => ({ gated: (_o: unknown, call: (approved: boolean) => Promise<unknown>) => call(false) }));
vi.mock("@/features/orchestrator/execute", () => ({ execute: h.execute }));
vi.mock("@/features/memmap/client-trace", () => ({ clientTrace: new Proxy({}, { get: (_t, k) => (k === "id" ? null : () => undefined) }) }));
vi.mock("@/lib/cc-api", () => ({ cc: { search: vi.fn(), llmJson: vi.fn(), agentSearch: vi.fn() }, collections: { create: vi.fn() } }));
vi.mock("@/features/dispatcher/dispatch", () => ({ dispatch: h.dispatch, queueDesktopTurn: vi.fn(), queueDesktopItem: vi.fn() }));
vi.mock("@/features/voice/engines", () => ({
  audioContext: async () => null,
  // An STT engine for the barge-in listens (off unless a test turns `env.bargeIn` on).
  createEngines: () => ({ stt: { name: "test-stt", start: h.sttStart, stop: vi.fn(), abort: h.sttAbort }, tts: { supported: true, name: "test", speak: h.speak, prefetch: h.prefetch, cancel: vi.fn() } }),
}));
vi.mock("@/features/voice/audio-route", () => ({ bargeSensitivityOffset: () => -30, detectRoute: async () => "headset", detectedRoute: () => "headset", effectiveRoute: () => "headset" }));
vi.mock("@/features/voice/media-hold", () => ({ cutMedia: async () => undefined, holdMedia: async () => ({}), releaseMedia: async () => undefined }));
vi.mock("@/features/voice/spotify-duck", () => ({
  duckOnSpeech: vi.fn(),
  duckOnTrigger: vi.fn(),
  musicPlayingHere: () => false,
  restoreAfterPause: vi.fn(),
  restoreDuck: vi.fn(),
  scheduleRestore: vi.fn(),
  settleCommand: vi.fn(),
  settleNoise: vi.fn(),
}));

import { useDialogue } from "@/features/dialogue/dialogue-store";
import { useVoice } from "./voice-store";
import { endsSentence, handleInput, killTurn, startListening, stopVoice, streamedText, unspokenRest } from "./voice-controller";
import { useMic } from "./mic-gate";

const voice = { channel: "voice" as const, origin: "tap" as const };
const QUESTION = "what's the weather like today";
const S1 = "Sure thing, here is the forecast for today.";
const S2 = "It will be sunny all afternoon with a light breeze.";
const S3 = "Bring sunglasses.";
/** dispatch.ts DESKTOP_STILL_WORKING_MESSAGE (that module is mocked here). */
const STILL_WORKING = "Tony is still working on that on the desktop. It's taking a while, so I've stopped waiting here; nothing else was asked to do it.";

type DispatchOpts = { onPartial?: (soFar: string) => void } & Record<string, unknown>;
/** The dispatch() in flight: the test feeds it partials and settles it. */
let stream: {
  opts: DispatchOpts;
  partial: (soFar: string) => void;
  finish: (content: string) => void;
  /** The final answer with extra result fields (the gateway's cold-start `streamPrefix`). */
  finishWith: (content: string, extra: Record<string, unknown>) => void;
  /** A notice in place of Tony's answer (dispatch's `notice`: the cap ran out / unconfirmed). */
  notice: (content: string, kind?: "waiting" | "unconfirmed") => void;
  fail: (e: Error) => void;
};

const spoken = () => h.speak.mock.calls.map((c) => c[0] as string);
const agentTurns = () => useVoice.getState().turns.filter((t) => t.who === "agent");
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  stopVoice(); // module state from the previous test
  env.desktop = false;
  env.bargeIn = false;
  useVoice.setState({ turns: [], pending: null, state: "idle", error: null });
  useDialogue.setState({ sessions: {} });
  for (const f of Object.values(h)) f.mockReset();
  h.cmd.mockRejectedValue(new Error("offline")); // planner / verifier unavailable: heuristic plans
  h.speak.mockResolvedValue(undefined);
  h.execute.mockResolvedValue({ text: "via execute", meta: "" });
  h.dispatch.mockImplementation(
    (_text: string, opts: DispatchOpts) =>
      new Promise((resolve, reject) => {
        stream = {
          opts,
          partial: (soFar) => opts.onPartial?.(soFar),
          finish: (content) => resolve({ role: "general", result: { providerId: "desktop:local", content, fellBack: false, reason: "phone → desktop Tony", latencyMs: 5 } }),
          finishWith: (content, extra) => resolve({ role: "general", result: { providerId: "gateway:lmstudio", content, fellBack: false, reason: "phone → desktop Tony", latencyMs: 5, ...extra } }),
          notice: (content, kind = "waiting") =>
            resolve({ role: "general", result: { providerId: "desktop:tony", content, fellBack: false, reason: "phone → desktop Tony (still waiting)", latencyMs: 240_000 }, notice: kind }),
          fail: reject,
        };
      }),
  );
});

/** A phone voice turn, up to the dispatch() call (the desktop is now writing Tony's answer).
 * Wrapped: an async function returning the turn's promise would wait for the whole turn. */
async function askByVoice(text = QUESTION): Promise<{ turn: Promise<void> }> {
  const turn = handleInput(text, voice);
  await vi.waitFor(() => expect(h.dispatch).toHaveBeenCalledTimes(1));
  return { turn };
}

describe("P5: the phone speaks Tony's streamed reply (voice)", () => {
  it("starts speaking at the first complete sentence while the desktop is still writing, then says only the rest", async () => {
    const { turn } = await askByVoice();
    expect(h.execute).not.toHaveBeenCalled();
    expect(stream.opts).toMatchObject({ role: "general", onPartial: expect.any(Function) });

    stream.partial(S1);
    await vi.waitFor(() => expect(spoken()).toEqual([S1]));
    expect(useVoice.getState().state).toBe("speaking");
    // The growing text is on screen, as on the desktop.
    expect(agentTurns()).toHaveLength(1);
    expect(agentTurns()[0]).toMatchObject({ text: S1, meta: "streaming…", from: "os" });

    stream.partial(`${S1} ${S2}`);
    await vi.waitFor(() => expect(spoken()).toEqual([S1, S2]));
    expect(agentTurns()[0].text).toBe(`${S1} ${S2}`);

    stream.finish(`${S1} ${S2} ${S3}`);
    await turn;
    expect(spoken()).toEqual([S1, S2, S3]); // the final only adds what was never said
    expect(agentTurns()).toHaveLength(1); // the live bubble became the answer
    expect(agentTurns()[0].text).toBe(`${S1} ${S2} ${S3}`);
    expect(agentTurns()[0].meta).toMatch(/desktop:local · 5ms$/);
    expect(useVoice.getState().state).toBe("idle");
  });

  it("chains the streamed sentences like the desktop: one breaker scope, prosody from the line before, rendered ahead", async () => {
    const { turn } = await askByVoice();
    stream.partial(`${S1} ${S2} `);
    stream.finish(`${S1} ${S2} ${S3}`);
    await turn;
    const opts = h.speak.mock.calls.map((c) => c[1] as { agent?: string; previousText?: string; utteranceId?: string });
    expect(opts.map((o) => o.previousText)).toEqual([undefined, S1, S2]);
    expect(opts.every((o) => o.agent === "general")).toBe(true);
    expect(new Set(opts.map((o) => o.utteranceId)).size).toBe(1);
    expect(opts[0].utteranceId).toMatch(/^phone-[A-Za-z0-9-]+-general$/);
    expect(h.prefetch.mock.calls.map((c) => c[0])).toEqual([S1, S2, S3]);
  });

  it("speaks the first clause of a sentence still being written", async () => {
    const { turn } = await askByVoice();
    stream.partial("Honestly, the forecast looks great today, with clear skies and");
    await vi.waitFor(() => expect(spoken()).toEqual(["Honestly, the forecast looks great today,"]));
    stream.finish("Honestly, the forecast looks great today, with clear skies and no rain.");
    await turn;
    expect(spoken()).toEqual(["Honestly, the forecast looks great today,", "with clear skies and no rain."]);
  });

  it("a stream that stops on a number's dot (\"3.\") waits for more before speaking it", async () => {
    const { turn } = await askByVoice();
    stream.partial("The meeting has been moved to room 3.");
    await flush();
    expect(spoken()).toEqual([]);
    stream.partial("The meeting has been moved to room 3.5 on the second floor, near the lifts.");
    await vi.waitFor(() => expect(spoken()).toEqual(["The meeting has been moved to room 3.5 on the second floor,"]));
    stream.finish("The meeting has been moved to room 3.5 on the second floor, near the lifts.");
    await turn;
    expect(spoken()).toEqual(["The meeting has been moved to room 3.5 on the second floor,", "near the lifts."]);
  });

  it("never re-speaks what was said when the final text doesn't start with it", async () => {
    const { turn } = await askByVoice();
    stream.partial(S1);
    await vi.waitFor(() => expect(spoken()).toEqual([S1]));
    stream.finish("Here's the forecast for today, sure thing. Sunny all day.");
    await turn;
    expect(spoken()).toEqual([S1, "Sunny all day."]);
    expect(agentTurns()).toHaveLength(1);
    expect(agentTurns()[0].text).toBe("Here's the forecast for today, sure thing. Sunny all day.");
  });

  it("with no partials (an older gateway, the CLI fallback) the whole reply is shown, then spoken once", async () => {
    const { turn } = await askByVoice();
    await flush();
    expect(spoken()).toEqual([]);
    expect(useVoice.getState().state).toBe("thinking");
    stream.finish(`${S1} ${S2}`);
    await turn;
    expect(spoken()).toEqual([`${S1} ${S2}`]);
    expect(agentTurns()).toHaveLength(1);
    expect(agentTurns()[0].text).toBe(`${S1} ${S2}`);
  });

  it("ignores a partial that arrives after the final answer", async () => {
    const { turn } = await askByVoice();
    stream.partial(S1);
    stream.finish(`${S1} ${S3}`);
    await turn;
    stream.partial(`${S1} ${S2} and more text that should never appear.`);
    await flush();
    expect(spoken()).toEqual([S1, S3]);
    expect(agentTurns()).toHaveLength(1);
    expect(agentTurns()[0].text).toBe(`${S1} ${S3}`);
  });

  it("a cut mid-stream stops the speech; the text still lands on screen", async () => {
    const { turn } = await askByVoice();
    stream.partial(S1);
    await vi.waitFor(() => expect(spoken()).toEqual([S1]));
    killTurn();
    stream.partial(`${S1} ${S2}`);
    stream.finish(`${S1} ${S2} ${S3}`);
    await turn;
    expect(spoken()).toEqual([S1]);
    expect(agentTurns()[0].text).toBe(`${S1} ${S2} ${S3}`);
  });

  it("a failed dispatch after partials keeps the partial text, marked interrupted, and reports the error", async () => {
    const { turn } = await askByVoice();
    stream.partial(S1);
    await vi.waitFor(() => expect(spoken()).toEqual([S1]));
    stream.fail(new Error("The desktop app didn't pick that up in time, so nothing ran."));
    await turn;
    expect(agentTurns()[0]).toMatchObject({ text: S1, meta: "interrupted" });
    expect(useVoice.getState().turns.some((t) => t.who === "system" && t.tone === "error")).toBe(true);
  });

  it("a notice in place of the answer after partials keeps the streamed text and says the notice whole, after the queued speech", async () => {
    // S1 is still playing when the notice lands.
    let s1Done!: () => void;
    h.speak.mockImplementation((text: string) => (text === S1 ? new Promise<void>((r) => (s1Done = r)) : Promise.resolve()));
    const { turn } = await askByVoice();
    stream.partial(`${S1} It will be sunny all`);
    await vi.waitFor(() => expect(spoken()).toEqual([S1]));
    stream.notice(STILL_WORKING);
    await flush();
    // Never overwritten: Tony's streamed words stay in their bubble, marked interrupted; the
    // notice is a turn of its own.
    expect(agentTurns()).toHaveLength(2);
    expect(agentTurns()[0]).toMatchObject({ text: `${S1} It will be sunny all`, meta: "interrupted" });
    expect(agentTurns()[1]).toMatchObject({ text: STILL_WORKING, from: "os" });
    expect(agentTurns()[1].meta).toMatch(/desktop:tony/);
    expect(spoken()).toEqual([S1]); // the notice waits for the line playing now
    s1Done();
    await turn;
    expect(spoken()).toEqual([S1, STILL_WORKING]); // whole, not "the rest" of it
    expect(useVoice.getState().state).toBe("idle");
  });

  it("an unconfirmed notice after a partial that was shown but not yet spoken: the bubble stays, the notice is said whole", async () => {
    const { turn } = await askByVoice();
    stream.partial("Let me check");
    await vi.waitFor(() => expect(agentTurns()).toHaveLength(1));
    expect(spoken()).toEqual([]);
    const LOST = "I sent that to the desktop but then couldn't reach the gateway, so I can't tell whether Tony has it. Nothing else was asked to do it.";
    stream.notice(LOST, "unconfirmed");
    await turn;
    expect(agentTurns().map((t) => [t.text, /desktop:tony/.test(t.meta ?? "") ? "notice" : t.meta])).toEqual([
      ["Let me check", "interrupted"],
      [LOST, "notice"],
    ]);
    expect(spoken()).toEqual([LOST]);
  });

  it("a notice with no partials is shown and spoken once, as before", async () => {
    const { turn } = await askByVoice();
    stream.notice(STILL_WORKING);
    await turn;
    expect(agentTurns()).toHaveLength(1);
    expect(agentTurns()[0].text).toBe(STILL_WORKING);
    expect(spoken()).toEqual([STILL_WORKING]);
  });

  it("a stream that stops on an abbreviation's dot (\"Mr.\") waits for more before speaking it", async () => {
    const { turn } = await askByVoice();
    stream.partial("Your table is booked with Mr.");
    await flush();
    expect(spoken()).toEqual([]);
    stream.finish("Your table is booked with Mr. Rossi for eight tonight.");
    await turn;
    expect(spoken()).toEqual(["Your table is booked with Mr. Rossi for eight tonight."]);
  });
});

describe("P5: a gateway cold start — 'One sec, Nic — waking up.' streams ahead of Tony's answer", () => {
  /** gateway_tony.py WAKING_LINE: the first delta of a cold turn; the final answer never has it. */
  const WAKING = "One sec, Nic — waking up.";
  const prefix = { streamPrefix: `${WAKING} ` };

  it("a short answer after the waking line is still spoken (measured against streamPrefix + final)", async () => {
    const { turn } = await askByVoice();
    stream.partial(`${WAKING} `);
    await vi.waitFor(() => expect(spoken()).toEqual([WAKING]));
    stream.partial(`${WAKING} Sure.`); // too short to be a chunk of its own
    await flush();
    expect(spoken()).toEqual([WAKING]);
    stream.finishWith("Sure.", prefix);
    await turn;
    expect(spoken()).toEqual([WAKING, "Sure."]);
    expect(agentTurns()).toHaveLength(1);
    expect(agentTurns()[0].text).toBe("Sure."); // the bubble becomes the answer alone
  });

  it("…the same when the last partial never reached the phone (the final delta and 'done' in one poll)", async () => {
    const { turn } = await askByVoice();
    stream.partial(`${WAKING} `);
    await vi.waitFor(() => expect(spoken()).toEqual([WAKING]));
    stream.finishWith("It's 3 PM.", prefix);
    await turn;
    expect(spoken()).toEqual([WAKING, "It's 3 PM."]);
  });

  it("a longer streamed answer: never a repeat of the waking line or of a sentence already said", async () => {
    const { turn } = await askByVoice();
    stream.partial(`${WAKING} `);
    stream.partial(`${WAKING} ${S1} `);
    await vi.waitFor(() => expect(spoken()).toEqual([WAKING, S1]));
    stream.finishWith(`${S1} ${S2}`, prefix);
    await turn;
    expect(spoken()).toEqual([WAKING, S1, S2]);
  });

  it("a final that already starts with the lead-in is not doubled", async () => {
    const { turn } = await askByVoice();
    stream.partial(`${WAKING} `);
    await vi.waitFor(() => expect(spoken()).toEqual([WAKING]));
    stream.finishWith(`${WAKING} Sure.`, prefix);
    await turn;
    expect(spoken()).toEqual([WAKING, "Sure."]);
  });

  it("no streamPrefix (an older gateway): a last partial that ends with the final stands in for it", async () => {
    const { turn } = await askByVoice();
    stream.partial(`${WAKING} `);
    await vi.waitFor(() => expect(spoken()).toEqual([WAKING]));
    stream.partial(`${WAKING} 3 PM`); // no sentence end: never a chunk while streaming
    stream.finish("3 PM");
    await turn;
    expect(spoken()).toEqual([WAKING, "3 PM"]);
  });

  it("no partials at all: the answer is said once, without the waking line", async () => {
    const { turn } = await askByVoice();
    stream.finishWith("Sure.", prefix);
    await turn;
    expect(spoken()).toEqual(["Sure."]);
  });
});

describe("P5: a phone turn waiting on the desktop counts as in flight for barge-in", () => {
  type Handlers = { onPhase: (p: string) => void; onFinal: (t: string) => void; onError: (e: string) => void };
  const handlers = (i: number) => h.sttStart.mock.calls[i][0] as Handlers;

  beforeEach(() => {
    env.bargeIn = true;
    useMic.setState({ enabled: true, hydrated: true });
  });

  it("a cough between streamed sentences keeps the turn ('thinking', the barge-in listen re-armed), never idle mid-reply", async () => {
    const { turn } = await askByVoice();
    stream.partial(S1);
    await vi.waitFor(() => expect(spoken()).toEqual([S1]));
    await flush(); // S1 has played; S2 isn't written yet
    expect(h.sttStart).toHaveBeenCalledTimes(1); // the barge-in listen
    handlers(0).onPhase("speech");
    handlers(0).onFinal(""); // a cough: nothing transcribed
    expect(useVoice.getState().state).toBe("thinking");
    expect(h.sttStart).toHaveBeenCalledTimes(2); // listening for a reflex over the rest of it
    // A mic error between sentences: the same, not "error".
    handlers(1).onError("whisper timed out");
    expect(useVoice.getState().state).toBe("thinking");
    expect(useVoice.getState().error).toBeNull();
    expect(h.sttStart).toHaveBeenCalledTimes(3);
    stream.partial(`${S1} ${S2}`);
    await vi.waitFor(() => expect(spoken()).toEqual([S1, S2]));
    expect(useVoice.getState().state).toBe("speaking");
    stream.finish(`${S1} ${S2}`);
    await turn;
    expect(useVoice.getState().state).toBe("idle");
  });

  it("a turn a cut left behind no longer counts: noise in a new listen goes idle", async () => {
    const { turn } = await askByVoice();
    stream.partial(S1);
    await vi.waitFor(() => expect(spoken()).toEqual([S1]));
    killTurn(); // the desktop is still writing; this phone turn is dropped
    startListening({ origin: "tap" });
    const n = h.sttStart.mock.calls.length;
    handlers(n - 1).onFinal("");
    expect(useVoice.getState().state).toBe("idle");
    expect(h.sttStart).toHaveBeenCalledTimes(n); // no barge-in re-arm for a dead turn
    stream.finish(`${S1} ${S2}`);
    await turn;
  });
});

describe("endsSentence (pure)", () => {
  it("a sentence end", () => {
    for (const t of ["Here is the plan.", "Really?", "Go!", "He said \"go.\"", "It works (mostly).", "We're in.", "Wait…", "Hmm..."]) expect(endsSentence(t), t).toBe(true);
  });

  it("never an abbreviation's dot, a single-letter word's, or a number's", () => {
    for (const t of ["with Mr.", "and Mrs.", "Ms.", "see Dr.", "on Main St.", "Martin Luther King Jr.", "Sr.", "Lakers vs.", "apples, pears, etc.", "fruit, e.g.", "that is, i.e.", "DR.", "by J.", "in the U.S.", "room 3."]) {
      expect(endsSentence(t), t).toBe(false);
    }
  });

  it("a word that only ends like an abbreviation is still a sentence end", () => {
    for (const t of ["We met at the first.", "That was a mistake.", "I like jazz.", "Mister.", "Doctor."]) expect(endsSentence(t), t).toBe(true);
  });
});

describe("P5: everything else is unchanged", () => {
  it("a typed phone turn still goes through execute (no streaming)", async () => {
    await handleInput(QUESTION, { channel: "text", thread: "auto" });
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(spoken()).toEqual([]);
  });

  it("a desktop voice turn is still the desktop's own os_turn (never the phone stream)", async () => {
    env.desktop = true;
    h.cmd.mockImplementation(async (name: string) => {
      if (name === "os_turn") return { answer: "It's sunny.", steps: [], providerId: "local", latencyMs: 1, routedRole: "general", routeKind: "Self", routeReason: "", redacted: false, reason: "" };
      throw new Error("offline");
    });
    await handleInput(QUESTION, voice);
    expect(h.cmd).toHaveBeenCalledWith("os_turn", expect.anything());
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
    expect(spoken()).toEqual(["It's sunny."]);
  });
});

describe("streamedText (pure)", () => {
  const WAKING = "One sec, Nic — waking up.";

  it("a lead-in the final doesn't repeat goes in front of it", () => {
    expect(streamedText("Sure.", `${WAKING} `)).toBe(`${WAKING} Sure.`);
    expect(streamedText(`${WAKING} Sure.`, `${WAKING} `)).toBe(`${WAKING} Sure.`);
  });

  it("without one, a last streamed text that ends with the final stands in; otherwise the final as is", () => {
    expect(streamedText("3 PM", "", `${WAKING} 3 PM`)).toBe(`${WAKING} 3 PM`);
    expect(streamedText(`${S1} ${S2}`, "", S1)).toBe(`${S1} ${S2}`);
    expect(streamedText(S1, "", S1)).toBe(S1);
    expect(streamedText("", "", S1)).toBe("");
  });
});

describe("unspokenRest (pure)", () => {
  it("nothing spoken yet: the whole final", () => {
    expect(unspokenRest(` ${S1} ${S2} `, "")).toBe(`${S1} ${S2}`);
  });

  it("the final starts with what was spoken: only what follows it", () => {
    expect(unspokenRest(`${S1} ${S2}`, S1, S1)).toBe(S2);
    expect(unspokenRest(`${S1} ${S2}`, `${S1} ${S2}`, S2)).toBe("");
  });

  it("the same words with different spacing still line up", () => {
    expect(unspokenRest(`${S1}\n\n${S2}`, `\n${S1.replace(/ /g, "  ")}`, S1)).toBe(S2);
  });

  it("what was said appears further on (a line added in front): the rest follows it", () => {
    expect(unspokenRest(`Okay. ${S1} ${S2}`, S1, S1)).toBe(S2);
    expect(unspokenRest(`Okay. Hmm, ${S2} ${S3}`, `${S1} ${S2}`, S2)).toBe(S3);
  });

  it("a different text: the prefix is never said again, only sentences past the spoken length", () => {
    expect(unspokenRest("Here's the forecast for today, sure thing. Sunny all day.", S1, S1)).toBe("Sunny all day.");
    expect(unspokenRest("Totally different answer here.", `${S1} ${S2}`, S2)).toBe("");
    expect(unspokenRest("Short.", S1, S1)).toBe("");
  });
});
