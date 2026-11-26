import { describe, expect, it } from "vitest";
import { addMessage, markRead, unreadCount } from "./agent-inbox";
import type { AgentReport } from "@/features/voice/agent-reports";

const r = (id: string, at: number, agent = "director"): AgentReport => ({ id, agent, text: `Nic, ${id}.`, at, urgent: false, source: "note" });

describe("agent inbox", () => {
  it("newest first, unread, deduped, capped", () => {
    let l = addMessage([], r("a", 1));
    l = addMessage(l, r("b", 3));
    l = addMessage(l, r("c", 2));
    expect(l.map((m) => m.id)).toEqual(["b", "c", "a"]);
    expect(unreadCount(l)).toBe(3);
    l = markRead(l, { ids: ["b"] });
    expect(addMessage(l, r("b", 3)).find((m) => m.id === "b")!.read).toBe(true); // a replayed event keeps its read state
    expect(addMessage(l, r("d", 4), 3).map((m) => m.id)).toEqual(["d", "b", "c"]);
  });

  it("marks by id, by agent, or everything", () => {
    const l = [r("a", 1), r("b", 2, "coder"), r("c", 3)].reduce((acc, x) => addMessage(acc, x), [] as ReturnType<typeof addMessage>);
    expect(unreadCount(markRead(l, { agent: "director" }))).toBe(1);
    expect(unreadCount(markRead(l, {}))).toBe(0);
    expect(unreadCount(markRead(l, { ids: ["zzz"] }))).toBe(3);
  });
});
