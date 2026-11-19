import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceTurn } from "@/features/voice/voice-store";

const h = vi.hoisted(() => ({
  cmd: vi.fn(),
  llmJson: vi.fn(),
  create: vi.fn(),
}));

vi.mock("@/lib/platform", () => ({ cmd: h.cmd, platform: "desktop" }));
vi.mock("@/lib/cc-api", () => ({ cc: { llmJson: h.llmJson }, collections: { create: h.create } }));

import { buildArtifact, conversationSlice, fallbackTitle, rawContextOf, saveArtifact } from "./package";

let n = 0;
const turn = (who: VoiceTurn["who"], text: string, o: Partial<VoiceTurn> = {}): VoiceTurn => ({ id: `t${++n}`, who, text, thread: "auto", at: 1_000_000 + n, ...o });

beforeEach(() => {
  n = 0;
  h.cmd.mockReset();
  h.llmJson.mockReset();
  h.create.mockReset().mockImplementation(async (_c: string, data: object) => ({ id: "new-id", ...data }));
});

describe("conversationSlice", () => {
  it("keeps only this thread's user / agent talk", () => {
    const turns = [
      turn("user", "old chatter", { at: 0 }),
      turn("user", "I've been thinking about an audition tracker"),
      turn("relay", "Routing … to Designer…", { from: "os", to: "designer" }),
      turn("agent", "Nice — what would you track first?", { from: "os" }),
      turn("system", "Approved (tap): something"),
      turn("agent", "Paused Spotify.", { from: "os", meta: "os-control" }),
      turn("user", "on the coder tab", { thread: "coder" }),
      turn("user", "self-tapes and callbacks"),
      turn("user", "nah, save it for later"),
    ];
    const defer = turns[turns.length - 1];
    const s = conversationSlice(turns, "auto", { fromTurnId: turns[1].id, excludeIds: [defer.id] });
    expect(s.map((t) => t.text)).toEqual(["I've been thinking about an audition tracker", "Nice — what would you track first?", "self-tapes and callbacks"]);
  });

  it("without a session: the last 20 turns of the past 30 minutes", () => {
    const now = 10_000_000;
    const turns = [turn("user", "ancient", { at: now - 31 * 60_000 }), ...Array.from({ length: 25 }, (_, i) => turn("user", `line ${i}`, { at: now - 1000 }))];
    const s = conversationSlice(turns, "auto", { now });
    expect(s).toHaveLength(20);
    expect(s[0].text).toBe("line 5");
  });

  it("rawContext labels speakers", () => {
    expect(rawContextOf([turn("user", "hi"), turn("agent", "hey")], "Tony")).toBe("You: hi\nTony: hey");
  });
});

describe("buildArtifact", () => {
  const slice = () => [turn("user", "Hey Tony, I've been thinking about an audition tracker."), turn("agent", "What would you track first?"), turn("user", "self-tapes and callbacks")];

  it("uses the local model's title / summary / tags", async () => {
    h.llmJson.mockResolvedValue({ title: "Audition Tracker", summary: "An app to track self-tapes and callbacks.", tags: ["Acting", "app", "acting"] });
    const a = await buildArtifact(slice(), { osName: "Tony", now: 42 });
    expect(a).toEqual({ title: "Audition Tracker", summary: "An app to track self-tapes and callbacks.", rawContext: expect.stringContaining("You: Hey Tony"), timestamp: 42, tags: ["acting", "app"] });
    expect(h.llmJson).toHaveBeenCalledTimes(1);
    expect(h.llmJson.mock.calls[0][1].length).toBeLessThanOrEqual(7500);
  });

  it("falls back deterministically when the model is down", async () => {
    h.llmJson.mockRejectedValue(new Error("Local LLM unavailable"));
    const a = await buildArtifact(slice(), { osName: "Tony", now: 7 });
    expect(a.title).toBe("An audition tracker");
    expect(a.summary).toBe("Hey Tony, I've been thinking about an audition tracker. self-tapes and callbacks");
    expect(a.tags).toEqual([]);
    expect(a.timestamp).toBe(7);
  });

  it("falls back when the model is slow", async () => {
    h.llmJson.mockReturnValue(new Promise(() => undefined));
    const a = await buildArtifact(slice(), { timeoutMs: 5 });
    expect(a.title).toBe("An audition tracker");
  });

  it("fallbackTitle trims filler and caps the length", () => {
    expect(fallbackTitle([turn("user", "so what if we built a budgeting app for actors who tour a lot and need per diems tracked")]).length).toBeLessThanOrEqual(60);
    expect(fallbackTitle([])).toBe("Untitled idea");
  });
});

describe("saveArtifact", () => {
  const a = { title: "Audition Tracker", summary: "Track tapes.", rawContext: "You: idea\nTony: nice", timestamp: 99, tags: ["acting"] };
  const slice = () => [turn("user", "idea"), turn("agent", "nice")];

  it("brainstorm → a notes entry with the organized summary", async () => {
    await saveArtifact("brainstorm", a, slice(), "Tony");
    expect(h.create).toHaveBeenCalledWith(
      "notes",
      expect.objectContaining({ title: "Audition Tracker", rawText: a.rawContext, organized: { title: "Audition Tracker", summary: "Track tapes.", tags: ["acting"] }, organizedAt: 99, tags: ["acting"], source: "tony" }),
    );
    expect(h.create.mock.calls[0][1].segments).toEqual([expect.objectContaining({ text: "You: idea", device: "desktop" }), expect.objectContaining({ text: "Tony: nice" })]);
  });

  it("ledger → an ideas entry, parked, no tasks", async () => {
    await saveArtifact("ledger", a, slice());
    expect(h.create).toHaveBeenCalledWith("ideas", expect.objectContaining({ title: "Audition Tracker", idea: a.rawContext, summary: "Track tapes.", tasks: [], status: "parked", tags: ["acting"], savedAt: 99 }));
  });

  it("playplace → a parked text card with no HTML", async () => {
    await saveArtifact("playplace", a, slice());
    expect(h.create).toHaveBeenCalledWith("playplace", expect.objectContaining({ title: "Audition Tracker", brief: "Track tapes.", status: "parked", html: "", tags: ["acting"] }));
  });

  it("never runs an agent, a capture or a pipeline", async () => {
    h.llmJson.mockResolvedValue({ title: "X", summary: "Y", tags: [] });
    for (const target of ["brainstorm", "ledger", "playplace"] as const) await saveArtifact(target, await buildArtifact(slice()), slice());
    expect(h.cmd).not.toHaveBeenCalled();
    expect(h.cmd).not.toHaveBeenCalledWith("idea_capture", expect.anything());
    expect(h.cmd).not.toHaveBeenCalledWith("os_turn", expect.anything());
    expect(h.cmd).not.toHaveBeenCalledWith("idea_pipeline_run", expect.anything());
  });
});
