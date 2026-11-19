import { describe, expect, it } from "vitest";
import { DEFAULT_ROUTING_CONFIG } from "@/features/dispatcher/router";
import { isSelfRelay, isSubAgentThread, relayThreadFor, routeFor, routingNotice } from "./route-for";
import { THREADS, setSectionSource, tonyThread, tonyThreadFor, useVoice, type Channel, type ThreadId } from "./voice-store";

const cfg = DEFAULT_ROUTING_CONFIG;
const rf = (utterance: string, thread: ThreadId, channel: Channel) => routeFor({ utterance, thread, channel, cfg, osName: "Tony" });
const SUB_TABS = THREADS.filter((t) => t !== "auto" && t !== "general");

describe("routeFor (P2: one routing decision)", () => {
  it("voice on a sub-agent tab stays with Tony — never Tab", () => {
    for (const tab of SUB_TABS) {
      const r = rf("what's the time", tab, "voice");
      expect(r.role, tab).toBe("general");
      expect(r.kind, tab).not.toBe("Tab");
    }
    // A Domain hit by voice on a sub-agent tab also stays with Tony (U2 strict).
    expect(rf("redo the color palette and layout for the landing page", "prompter", "voice")).toMatchObject({ role: "general", kind: "Self" });
  });
  it("voice: only a Named sub-agent delegates, from any tab", () => {
    expect(rf("prompter, write a prompt for the landing page", "prompter", "voice")).toMatchObject({ role: "prompter", kind: "Named" });
    expect(rf("tell the coder to fix the build", "designer", "voice")).toMatchObject({ role: "coder", kind: "Named" });
  });
  it("voice in Auto keeps today's Domain delegation", () => {
    expect(rf("redo the color palette and layout for the landing page", "auto", "voice")).toMatchObject({ role: "designer", kind: "Domain" });
    expect(rf("good morning", "auto", "voice")).toMatchObject({ role: "general", kind: "Default" });
  });
  it("voice on Tony's own tab: Domain stays with Tony", () => {
    expect(rf("redo the color palette and layout for the landing page", "general", "voice")).toMatchObject({ role: "general", kind: "Self" });
  });
  it("addressing Tony is Self on every tab and channel", () => {
    for (const thread of THREADS) {
      for (const ch of ["voice", "text"] as Channel[]) {
        expect(rf("thanks tony", thread, ch), `${thread}/${ch}`).toMatchObject({ role: "general", kind: "Self" });
      }
    }
    expect(rf("ask tony to ask the coder to fix the build", "auto", "voice")).toMatchObject({ role: "coder", kind: "Named" });
  });
  it("a live-tool read question is Direct on any tab", () => {
    expect(rf("any whatsapp updates", "designer", "voice")).toMatchObject({ role: "general", kind: "Direct" });
    expect(rf("any whatsapp updates", "designer", "text")).toMatchObject({ role: "general", kind: "Direct" });
  });
  it("typed on a sub-agent tab still goes to that agent (unchanged)", () => {
    expect(rf("what's the time", "prompter", "text")).toMatchObject({ role: "prompter", kind: "Tab" });
    expect(rf("redo the color palette and layout", "prompter", "text")).toMatchObject({ role: "prompter", kind: "Tab" });
    expect(rf("redo the color palette and layout", "auto", "text")).toMatchObject({ role: "designer", kind: "Domain" });
    expect(rf("tell the coder to fix the build", "prompter", "text")).toMatchObject({ role: "coder", kind: "Named" });
  });
  it("never returns a self role other than general", () => {
    const old = { ...cfg, agents: { ...cfg.agents, general: { names: ["tony"], domains: [] } } };
    expect(routeFor({ utterance: "what do you think, tony", thread: "auto", channel: "voice", cfg: old })).toMatchObject({ role: "general", kind: "Self" });
  });
});

describe("routingNotice", () => {
  const base = { explicit: false, thread: "auto" as ThreadId, task: "check my calendar", utterance: "check my calendar" };
  it("is null for Tony himself, Self / Direct / Tab kinds, explicit turns and the thread's own agent", () => {
    for (const role of ["general", "tony", "dispatcher", "os"]) expect(routingNotice({ ...base, role, kind: "Named" }), role).toBeNull();
    for (const kind of ["Self", "Direct", "Tab", "Default"] as const) expect(routingNotice({ ...base, role: "booking", kind }), kind).toBeNull();
    expect(routingNotice({ ...base, role: "booking", kind: "Named", explicit: true })).toBeNull();
    expect(routingNotice({ ...base, role: "booking", kind: "Named", thread: "booking" })).toBeNull();
  });
  it("names the agent for a real delegation", () => {
    expect(routingNotice({ ...base, role: "booking", kind: "Named" })).toBe("Routing check my calendar to Booking Desk…");
    const long = "x".repeat(80);
    expect(routingNotice({ ...base, role: "coder", kind: "Domain", task: long })).toBe(`Routing ${"x".repeat(57)}… to Coder…`);
  });
});

describe("relays", () => {
  it("isSelfRelay: Tony → Tony under any alias", () => {
    expect(isSelfRelay({ from: "os", to: "general" })).toBe(true);
    expect(isSelfRelay({ from: "os", to: "tony" })).toBe(true);
    expect(isSelfRelay({ from: "general", to: "dispatcher" })).toBe(true);
    expect(isSelfRelay({ from: "os", to: "friday" }, "Friday")).toBe(true);
    expect(isSelfRelay({ from: "os", to: "booking" })).toBe(false);
    expect(isSelfRelay({ from: "os", to: "user" })).toBe(false);
    expect(isSelfRelay({ from: "os" })).toBe(false);
  });
  it("relayThreadFor keeps Tony's thread a clean transcript (U3)", () => {
    const tony = { finalRole: "general" as const, relayThread: "auto" as ThreadId, tonyThread: "auto" as ThreadId };
    // Tony's own turn: tool and step-in relays never land in his thread.
    expect(relayThreadFor({ kind: "tool", from: "os", to: "spotify.play" }, tony)).toBeNull();
    expect(relayThreadFor({ kind: "step-in", from: "os", to: "user" }, tony)).toBeNull();
    expect(relayThreadFor({ kind: "delegate", from: "os", to: "general" }, tony)).toBeNull();
    // A Librarian comms lookup on Tony's own turn goes to the Librarian's tab.
    expect(relayThreadFor({ kind: "delegate", from: "os", to: "librarian" }, tony)).toBe("librarian");
    expect(relayThreadFor({ kind: "reply", from: "librarian", to: "os" }, tony)).toBe("librarian");
    // A delegated turn: everything goes to the agent's tab.
    const del = { finalRole: "booking" as const, relayThread: "booking" as ThreadId, tonyThread: "auto" as ThreadId };
    for (const kind of ["delegate", "reply", "tool", "step-in"]) {
      const step = kind === "reply" ? { kind, from: "booking", to: "os" } : { kind, from: "os", to: kind === "delegate" ? "booking" : "whatsapp.recent" };
      expect(relayThreadFor(step, del), kind).toBe("booking");
    }
    expect(relayThreadFor({ kind: "error", from: "booking", to: "os" }, del)).toBe("booking");
  });
  it("isSubAgentThread", () => {
    expect(isSubAgentThread("prompter")).toBe(true);
    expect(isSubAgentThread("auto")).toBe(false);
    expect(isSubAgentThread("general")).toBe(false);
    expect(isSubAgentThread("overseer")).toBe(false);
    expect(isSubAgentThread(undefined)).toBe(false);
  });
});

describe("Tony's thread", () => {
  it("tonyThreadFor never returns a sub-agent thread", () => {
    for (const active of THREADS) {
      for (const section of ["agents", "command", "settings"] as const) {
        const t = tonyThreadFor(section, active);
        expect(["auto", "general"], `${section}/${active}`).toContain(t);
      }
      expect(tonyThreadFor("command", active, true)).toBe("general"); // phone HUD
    }
    expect(tonyThreadFor("agents", "general")).toBe("general");
    expect(tonyThreadFor("command", "general")).toBe("auto");
    expect(tonyThreadFor("agents", "prompter")).toBe("auto");
  });
  it("pushTurn without a thread never lands in the open sub-agent tab", () => {
    setSectionSource(() => "agents");
    useVoice.getState().setActiveThread("prompter");
    expect(tonyThread()).toBe("auto");
    const t = useVoice.getState().pushTurn({ who: "system", text: "TTS fell back" });
    expect(t.thread).toBe("auto");
    useVoice.getState().setActiveThread("general");
    expect(useVoice.getState().pushTurn({ who: "system", text: "x" }).thread).toBe("general");
    // An explicit thread is always kept.
    expect(useVoice.getState().pushTurn({ who: "system", text: "y", thread: "coder" }).thread).toBe("coder");
    useVoice.getState().setActiveThread("auto");
    setSectionSource(() => "command");
  });
});
