import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FX2 (decision 5), the desktop app through the real voice controller: Tony's Learning reply
 * carries a proposal card; Nic's typed "yes" / "no" reaches Rust's `os_turn`, which answers it with
 * no model call (provider "learning", a fixed reply). That answer ends the card above it ("Saved" /
 * "Skipped") instead of leaving live Save / Skip buttons. A normal reply leaves the card live.
 * os_turn is mocked; engines, audio and the gateway are stubbed (mocks as switchboard-turns.test.ts).
 */
vi.hoisted(() => {
  const m = new Map<string, string>();
  Object.assign(globalThis, {
    localStorage: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k), clear: () => m.clear(), key: () => null, length: 0 },
  });
});

const h = vi.hoisted(() => ({ cmd: vi.fn(), execute: vi.fn(), speak: vi.fn() }));

vi.mock("@/features/modes/modes-store", async () => {
  const m = await vi.importActual<typeof import("@/features/modes/modes")>("@/features/modes/modes");
  return { useModes: { getState: () => ({ effective: m.DEFAULT_EFFECTIVE, load: async () => undefined }) }, currentFreeze: () => ({}), isToolLiveNow: (s: string) => m.toolLive(m.DEFAULT_EFFECTIVE, s, {}) };
});
vi.mock("@/lib/platform", () => ({ cmd: h.cmd, isTauri: () => true, onNativeEvent: async () => () => undefined, platform: "desktop" }));
vi.mock("@/stores/nav", () => ({ useNav: { getState: () => ({ section: "command" }) } }));
vi.mock("@/stores/settings", () => ({
  isDesktopApp: () => true,
  isAndroidApp: () => false,
  useSettings: {
    getState: () => ({
      osName: "Tony",
      wakeMode: false,
      confirmTimeoutSec: 30,
      routing: { announcerHandoff: false },
      audioRoute: "auto",
      conversation: { audioRoute: "auto", bargeIn: false, followUp: false, followUpSecs: 6, bargeEndSilenceMs: 500 },
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
vi.mock("@/features/arbiter/api", () => ({ onArbiterEvent: async () => () => undefined }));
vi.mock("@/features/reminders/intents", () => ({ handleLocalIntent: async () => null }));
vi.mock("@/features/bridge/gate", () => ({ gated: (_o: unknown, call: (approved: boolean) => Promise<unknown>) => call(false) }));
vi.mock("@/features/orchestrator/execute", () => ({ execute: h.execute }));
vi.mock("@/features/memmap/client-trace", () => ({ clientTrace: new Proxy({}, { get: (_t, k) => (k === "id" ? null : () => undefined) }) }));
vi.mock("@/lib/cc-api", () => ({ cc: { search: vi.fn(), llmJson: vi.fn(), agentSearch: vi.fn() }, collections: { create: vi.fn() } }));
vi.mock("@/features/dispatcher/dispatch", () => ({ dispatch: vi.fn(), queueDesktopTurn: vi.fn(), queueDesktopItem: vi.fn() }));
vi.mock("@/features/voice/engines", () => ({
  audioContext: () => null,
  createEngines: () => ({ stt: null, tts: { supported: true, name: "test", speak: h.speak, cancel: vi.fn() } }),
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
import { CORE_QUESTION, DISCARDED_REPLY, PROPOSAL_TTL_MS, SAVED_REPLY, SAVE_FAILED_REPLY, type PendingMemory } from "@/features/modes/learning";
import { useVoice } from "./voice-store";
import { handleInput, stopVoice } from "./voice-controller";

const text = { channel: "text" as const, thread: "auto" as const };
const ASK = `So when someone asks who books you, the Booking Desk handles it? ${CORE_QUESTION}`;
const pending: PendingMemory[] = [{ id: `mem-${Date.now()}-3`, category: "domain_knowledge", text: "When someone asks who books Nic: the Booking Desk handles it" }];
const base = { steps: [], latencyMs: 4, routedRole: "general", routeKind: "Self", routeReason: "", redacted: false, answeredBy: "os" };
/** os_turn's answers, in order. */
let answers: Record<string, unknown>[] = [];
const agentTurns = () => useVoice.getState().turns.filter((t) => t.who === "agent");

beforeEach(() => {
  stopVoice();
  useVoice.setState({ turns: [], pending: null, state: "idle", error: null });
  useDialogue.setState({ sessions: {} });
  for (const f of Object.values(h)) f.mockReset();
  answers = [];
  h.cmd.mockImplementation(async (name: string) => {
    if (name === "os_turn") return answers.shift() ?? { ...base, answer: "ok", providerId: "lmstudio", reason: "" };
    throw new Error(`offline ${name}`); // planner / verifier unavailable: heuristic plans
  });
  h.speak.mockResolvedValue(undefined);
  h.execute.mockImplementation(async () => ({ text: "ok", meta: "" }));
});

describe("FX2: Rust's answer to a typed yes / no ends the desktop card", () => {
  it("yes: the card above reads Saved, with no live buttons left (and it got its 10-minute expiry)", async () => {
    answers = [
      { ...base, answer: ASK, providerId: "lmstudio", reason: "", pendingMemory: pending },
      { ...base, answer: SAVED_REPLY, providerId: "learning", reason: "core memory approved", learned: [{ id: "lp-1-0", title: "the Booking Desk handles it", category: "domain_knowledge", confidence: "confirmed", outcome: "saved" }] },
    ];
    await handleInput("when someone asks who books me, it's the booking desk", text);
    const [card] = agentTurns();
    expect(card).toMatchObject({ text: ASK, pendingMemory: pending });
    expect(card.memoryExpiresAt).toBeGreaterThan(Date.now() + PROPOSAL_TTL_MS - 60_000);
    await handleInput("yes", text);
    expect(h.cmd.mock.calls.filter((c) => c[0] === "os_turn")).toHaveLength(2);
    const [ended, answer] = agentTurns();
    expect(answer).toMatchObject({ text: SAVED_REPLY });
    expect(answer.meta).toMatch(/^learning · /);
    expect(ended).toMatchObject({ id: card.id, memoryEnd: "saved" });
  });

  it("no: the card above reads Skipped", async () => {
    answers = [
      { ...base, answer: ASK, providerId: "lmstudio", reason: "", pendingMemory: pending },
      { ...base, answer: DISCARDED_REPLY, providerId: "learning", reason: "core memory discarded" },
    ];
    await handleInput("when someone asks who books me, it's the booking desk", text);
    await handleInput("no", text);
    expect(agentTurns()[0].memoryEnd).toBe("skipped");
  });

  it("yes → Rust's failed save (it asks again) → yes: the card reads Saved", async () => {
    answers = [
      { ...base, answer: ASK, providerId: "lmstudio", reason: "", pendingMemory: pending },
      { ...base, answer: SAVE_FAILED_REPLY, providerId: "learning", reason: "core memory save failed" },
      { ...base, answer: SAVED_REPLY, providerId: "learning", reason: "core memory approved" },
    ];
    await handleInput("when someone asks who books me, it's the booking desk", text);
    await handleInput("yes", text);
    expect(agentTurns()[0].memoryEnd).toBeUndefined(); // the failed save: still pending, card live
    await handleInput("yes", text);
    const [card, failed, done] = agentTurns();
    expect([failed.text, done.text]).toEqual([SAVE_FAILED_REPLY, SAVED_REPLY]);
    expect(card.memoryEnd).toBe("saved");
  });

  it("a card proposed later in Tony's other thread ('general') keeps a yes in 'auto' from ending the older card", async () => {
    answers = [
      { ...base, answer: ASK, providerId: "lmstudio", reason: "", pendingMemory: pending },
      { ...base, answer: `Keep it short when you drive? ${CORE_QUESTION}`, providerId: "lmstudio", reason: "", pendingMemory: [{ ...pending[0], id: `mem-${Date.now()}-9`, text: "When Nic is driving: keep it short" }] },
      { ...base, answer: SAVED_REPLY, providerId: "learning", reason: "core memory approved" },
    ];
    await handleInput("when someone asks who books me, it's the booking desk", text);
    await handleInput("when I'm driving keep it short", { channel: "text", thread: "general" });
    await handleInput("yes", text);
    const cards = agentTurns().filter((t) => t.pendingMemory?.length);
    expect(cards.map((t) => t.thread)).toEqual(["auto", "general"]);
    expect(cards.map((t) => t.memoryEnd)).toEqual([undefined, undefined]);
  });

  it("the yes carries the ids of its own thread's card (answering), and Rust's answeredMemory ends exactly that card", async () => {
    const cardB: PendingMemory[] = [{ ...pending[0], id: `mem-${Date.now()}-9`, text: "When Nic is driving: keep it short" }];
    answers = [
      { ...base, answer: ASK, providerId: "lmstudio", reason: "", pendingMemory: pending },
      { ...base, answer: `Keep it short when you drive? ${CORE_QUESTION}`, providerId: "lmstudio", reason: "", pendingMemory: cardB },
      { ...base, answer: SAVED_REPLY, providerId: "learning", reason: "core memory approved", answeredMemory: { ids: [pending[0].id], approved: true } },
    ];
    await handleInput("when someone asks who books me, it's the booking desk", text);
    await handleInput("when I'm driving keep it short", { channel: "text", thread: "general" });
    await handleInput("yes", text);
    const reqs = h.cmd.mock.calls.filter((c) => c[0] === "os_turn").map((c) => (c[1] as { req: { answering?: string[] } }).req);
    expect(reqs[0].answering).toEqual([]); // no agent turn in "auto" yet: no card to answer
    expect(reqs[1].answering).toEqual([]); // nor in "general" ("auto"'s card is not its to answer)
    expect(reqs[2].answering).toEqual([pending[0].id]); // "auto"'s own card, never "general"'s newer one
    const cards = agentTurns().filter((t) => t.pendingMemory?.length);
    expect(cards.map((t) => [t.thread, t.memoryEnd])).toEqual([["auto", "saved"], ["general", undefined]]);
    expect(agentTurns().at(-1)?.answeredMemory).toEqual({ ids: [pending[0].id], approved: true });
  });

  it("a normal model reply leaves the card live", async () => {
    answers = [
      { ...base, answer: ASK, providerId: "lmstudio", reason: "", pendingMemory: pending },
      { ...base, answer: "Weekdays only, got it.", providerId: "lmstudio", reason: "" },
    ];
    await handleInput("when someone asks who books me, it's the booking desk", text);
    await handleInput("yes but only on weekdays", text);
    expect(agentTurns()[0].memoryEnd).toBeUndefined();
  });
});
