import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  const m = new Map<string, string>();
  Object.assign(globalThis, {
    localStorage: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k), clear: () => m.clear(), key: () => null, length: 0 },
  });
});

const h = vi.hoisted(() => ({ xcmd: vi.fn(), listeners: new Map<string, (p: unknown) => void>(), tauri: true }));
vi.mock("@/lib/native-ext", () => ({
  xcmd: h.xcmd,
  onExtEvent: (name: string, fn: (p: unknown) => void) => {
    h.listeners.set(name, fn);
    return Promise.resolve(() => undefined);
  },
}));
vi.mock("@/lib/platform", async (orig) => ({ ...(await orig<typeof import("@/lib/platform")>()), isTauri: () => h.tauri }));

import { useVoice } from "@/features/voice/voice-store";
import { useSettings } from "@/stores/settings";
import { applyPage, applyTranscriptEvent, cardsToAdd, cardTurn, hydrateTranscripts, loadBody, loadMore, loadPage, mergeHeads, nestedCardIds, startTranscriptFeed, syncCards, useTranscripts, type TranscriptState } from "./transcript-store";
import { participantBadge, timeline } from "./AgentConversationCard";
import type { TranscriptConversation, TranscriptEvent, TranscriptHead, TranscriptPage } from "./types";

const conv = (id: string, over: Partial<TranscriptConversation> = {}): TranscriptConversation => ({
  convId: id,
  kind: "task",
  title: `Build ${id}`,
  thread: "auto",
  parentConvId: null,
  taskId: null,
  status: null,
  createdAt: 1000,
  updatedAt: 2000,
  messageCount: 1,
  dropped: 0,
  lastFrom: "tony",
  lastTo: "prompter",
  lastSummary: "Queued",
  lastKind: "handoff",
  ...over,
});

const head = (seq: number, at: number, over: Partial<TranscriptHead> = {}): TranscriptHead => ({
  seq,
  convId: "task:t-1",
  at,
  from: "prompter",
  to: "coder",
  kind: "handoff",
  stage: "merge",
  iteration: null,
  summary: `m${seq}`,
  bodyChars: 10,
  originalChars: 10,
  truncated: false,
  ok: true,
  handoffSeq: null,
  ...over,
});

const empty = (): TranscriptState => ({ convs: {}, pages: {}, bodies: {} });

beforeEach(() => {
  h.xcmd.mockReset();
  h.tauri = true;
  useTranscripts.setState(empty());
  useVoice.setState({ turns: [], clearedAt: {} });
  useSettings.getState().set({ chat: { showAgentConversation: true }, routing: { announcerHandoff: true, vocalHandoffs: true } });
});

describe("ordering and pages", () => {
  it("orders messages by (at, seq) and dedupes by seq", () => {
    const m = mergeHeads([head(5, 300), head(1, 100)], [head(3, 300), head(2, 200), head(1, 100)]);
    expect(m.map((x) => x.seq)).toEqual([1, 2, 3, 5]);
  });

  it("a live event updates the summary and appends only to a loaded page", () => {
    let s = applyTranscriptEvent(empty(), { conv: conv("task:t-1"), message: head(1, 100) });
    expect(s.convs["task:t-1"].title).toBe("Build task:t-1");
    expect(s.pages["task:t-1"]).toBeUndefined(); // an unopened card loads on demand
    const page: TranscriptPage = { conv: conv("task:t-1"), messages: [head(1, 100)], children: [], more: false };
    s = applyPage(s, page, false);
    s = applyTranscriptEvent(s, { conv: conv("task:t-1", { messageCount: 2, updatedAt: 3000 }), message: head(2, 50) });
    expect(s.pages["task:t-1"].messages.map((x) => x.seq)).toEqual([2, 1]); // (at, seq), not arrival
    // A stale summary never overwrites a newer one.
    s = applyTranscriptEvent(s, { conv: conv("task:t-1", { updatedAt: 10, lastSummary: "old" }), message: head(1, 100) });
    expect(s.convs["task:t-1"].updatedAt).toBe(3000);
  });

  it("pages append for load more and nest children under their parent", () => {
    let s = applyPage(empty(), { conv: conv("hub:b-1", { kind: "hub" }), messages: [head(1, 100, { convId: "hub:b-1" })], children: [conv("task:t-9", { parentConvId: "hub:b-1" })], more: true }, false);
    s = applyPage(s, { conv: conv("hub:b-1", { kind: "hub" }), messages: [head(4, 400, { convId: "hub:b-1" })], children: [], more: false }, true);
    expect(s.pages["hub:b-1"]).toMatchObject({ more: false, children: ["task:t-9"], loaded: true });
    expect(s.pages["hub:b-1"].messages.map((x) => x.seq)).toEqual([1, 4]);
    // A live event of a new child joins the loaded parent.
    s = applyTranscriptEvent(s, { conv: conv("dev:d-1", { kind: "dev", parentConvId: "hub:b-1" }), message: head(9, 500, { convId: "dev:d-1" }) });
    expect(s.pages["hub:b-1"].children).toEqual(["task:t-9", "dev:d-1"]);
    // The card shows messages and nested runs in time order.
    const t = timeline(s.pages["hub:b-1"].messages, [conv("task:t-9", { createdAt: 200 })]);
    expect(t.map((i) => i.m?.seq ?? i.child)).toEqual([1, "task:t-9", 4]);
  });
});

describe("chat cards", () => {
  it("one card per root conversation, in its thread, where it started", () => {
    const add = cardsToAdd([conv("task:t-1", { thread: "coder", createdAt: 1234 }), conv("task:t-2", { parentConvId: "hub:b-1" }), conv("turn:x", { thread: "phone" })], []);
    expect(add.map((t) => [t.convId, t.thread, t.at, t.who])).toEqual([
      ["task:t-1", "coder", 1234, "system"],
      ["turn:x", "auto", 1000, "system"],
    ]);
    expect(cardsToAdd([conv("task:t-1")], [{ convId: "task:t-1" }])).toEqual([]);
    expect(cardTurn(conv("task:t-1", { title: "" })).text).toContain("untitled");
  });

  it("a cleared thread stays clear across a rebuild; newer activity brings the card back", () => {
    expect(cardsToAdd([conv("task:t-1", { updatedAt: 500 })], [], { auto: 600 })).toEqual([]);
    expect(cardsToAdd([conv("task:t-1", { updatedAt: 700 })], [], { auto: 600 })).toHaveLength(1);
    useVoice.getState().pushTurn({ who: "user", text: "hi", thread: "auto" });
    useVoice.getState().clear("auto");
    expect(useVoice.getState().clearedAt.auto).toBeGreaterThan(0);
  });

  it("drops the card of a conversation that turned out to be nested", () => {
    useTranscripts.setState({ convs: { "task:t-1": conv("task:t-1"), "task:t-2": conv("task:t-2") } });
    syncCards([conv("task:t-1"), conv("task:t-2")]);
    expect(useVoice.getState().turns.map((t) => t.convId)).toEqual(["task:t-1", "task:t-2"]);
    useTranscripts.setState((s) => ({ convs: { ...s.convs, "task:t-2": conv("task:t-2", { parentConvId: "hub:b-1" }) } }));
    expect(nestedCardIds(useVoice.getState().turns, useTranscripts.getState().convs)).toEqual(["conv:task:t-2"]);
    syncCards([useTranscripts.getState().convs["task:t-2"]]);
    expect(useVoice.getState().turns.map((t) => t.convId)).toEqual(["task:t-1"]);
  });

  it("a restart rebuilds the cards from Rust's persisted rows, without duplicates", async () => {
    h.xcmd.mockImplementation(async (name: string) => {
      if (name === "transcript_conversations") return [conv("hub:b-1", { kind: "hub", createdAt: 10 }), conv("task:t-7", { thread: "prompter", createdAt: 20 })];
      throw new Error(name);
    });
    await hydrateTranscripts();
    await hydrateTranscripts(); // a reload: same cards, not twice
    expect(h.xcmd).toHaveBeenCalledWith("transcript_conversations", { limit: 50, roots_only: true });
    const turns = useVoice.getState().turns;
    expect(turns.map((t) => [t.id, t.thread])).toEqual([
      ["conv:hub:b-1", "auto"],
      ["conv:task:t-7", "prompter"],
    ]);
    expect(useTranscripts.getState().convs["hub:b-1"].kind).toBe("hub");
  });

  it("live events add a card once and feed an open page", async () => {
    h.xcmd.mockResolvedValue([]);
    startTranscriptFeed();
    await Promise.resolve();
    const fire = h.listeners.get("agent-transcript")!;
    expect(fire).toBeTypeOf("function");
    const ev: TranscriptEvent = { conv: conv("turn:s-1", { kind: "turn", updatedAt: Date.now() }), message: head(1, 100, { convId: "turn:s-1" }) };
    fire(ev);
    fire({ ...ev, message: head(2, 101, { convId: "turn:s-1" }) });
    expect(useVoice.getState().turns.filter((t) => t.convId === "turn:s-1")).toHaveLength(1);
  });
});

describe("lazy loading", () => {
  it("loads a page, more after the last message, and a body once", async () => {
    h.xcmd.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === "transcript_get" && args.after_seq === undefined) return { conv: conv("task:t-1"), messages: [head(1, 100), head(2, 200)], children: [], more: true };
      if (name === "transcript_get") return { conv: conv("task:t-1"), messages: [head(3, 300)], children: [], more: false };
      if (name === "transcript_message") return { ...head(2, 200), body: "the full prompt" };
      throw new Error(name);
    });
    await loadPage("task:t-1");
    await loadMore("task:t-1");
    expect(h.xcmd).toHaveBeenCalledWith("transcript_get", { conv_id: "task:t-1", after_seq: 2 });
    expect(useTranscripts.getState().pages["task:t-1"].messages.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(await loadBody(2)).toBe("the full prompt");
    expect(await loadBody(2)).toBe("the full prompt");
    expect(h.xcmd.mock.calls.filter(([n]) => n === "transcript_message")).toHaveLength(1);
  });

  it("a failed load keeps the error on the page", async () => {
    h.xcmd.mockRejectedValue(new Error("no such conversation"));
    await loadPage("task:gone");
    expect(useTranscripts.getState().pages["task:gone"]).toMatchObject({ loaded: false, loading: false });
    expect(useTranscripts.getState().pages["task:gone"].error).toContain("no such conversation");
  });

  it("the phone never calls the transcript commands", async () => {
    h.tauri = false;
    await loadPage("task:t-1");
    expect(await loadBody(1)).toBeNull();
    expect(h.xcmd).not.toHaveBeenCalled();
  });
});

describe("the Agent Log toggle", () => {
  it("defaults on and is independent of the spoken Agent Chatter", () => {
    const s = useSettings.getState();
    expect(s.chat.showAgentConversation).toBe(true);
    s.set({ chat: { showAgentConversation: false } });
    expect(useSettings.getState().routing.vocalHandoffs).toBe(true);
    useSettings.getState().set({ routing: { ...useSettings.getState().routing, vocalHandoffs: false } });
    expect(useSettings.getState().chat.showAgentConversation).toBe(false);
    useSettings.getState().set({ chat: { showAgentConversation: true } });
    expect(useSettings.getState().routing.vocalHandoffs).toBe(false);
  });

  it("badges name the transcript's participants", () => {
    expect(participantBadge("staging")).toBe("PLAY PLACE");
    expect(participantBadge("claude")).toBe("CLAUDE CODE");
    expect(participantBadge("tool")).toBe("TOOL");
    expect(participantBadge("coder")).toBe("CODER AGENT");
  });
});
