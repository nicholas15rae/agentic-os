import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ROUTING_CONFIG } from "@/features/dispatcher/router";
import { effectiveOf, PRESET_MODES } from "@/features/modes/modes";
import { frozenHold, isSelfRelay, isSubAgentThread, relayThreadFor, routeFor, routingNotice, soloHold, type RoutedTurn } from "./route-for";
import { THREADS, remoteIsNewer, setSectionSource, tonyThread, tonyThreadFor, useVoice, type Channel, type ThreadId } from "./voice-store";

const cfg = DEFAULT_ROUTING_CONFIG;
const rf = (utterance: string, thread: ThreadId, channel: Channel) => routeFor({ utterance, thread, channel, cfg, osName: "Tony" });
/** The same turn on the Android app. */
const rfPhone = (utterance: string, thread: ThreadId, channel: Channel) => routeFor({ utterance, thread, channel, cfg, osName: "Tony", phone: true });
const SUB_TABS = THREADS.filter((t) => t !== "auto" && t !== "general");
const TOPIC = "redo the color palette and layout for the landing page"; // designer Domain

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

describe("greetings stay with Tony (regression)", () => {
  // "Hey Tony, what's up?" normalized to "…whatsapp" (a Booking domain): 11 of 12 Booking turns
  // were greetings, each 20-70 s instead of 2-5 s.
  it("'what's up' is never a Booking delegation, desktop or phone, voice or typed", () => {
    for (const route of [rf, rfPhone]) {
      for (const ch of ["voice", "text"] as Channel[]) {
        for (const text of ["Hey Tony, what's up?", "what's up tony", "hey what's up tony", "so I'm on my phone now hey tony what's up"]) {
          expect(route(text, "auto", ch), `${text}/${ch}`).toMatchObject({ role: "general", kind: "Self" });
        }
        expect(route("what's up", "auto", ch).role, ch).toBe("general");
      }
    }
  });
  it("Tony's name beats a topic on the desktop too; a Named agent still delegates", () => {
    expect(rf("hey tony, check my self-tape availability", "auto", "voice")).toMatchObject({ role: "general", kind: "Self" });
    expect(rf("hey tony, check my self-tape availability", "auto", "text")).toMatchObject({ role: "general", kind: "Self" });
    expect(rf("render the reel", "auto", "voice")).toMatchObject({ role: "director", kind: "Domain" });
    expect(rf("hey tony, ask the director to edit video", "auto", "voice")).toMatchObject({ role: "director", kind: "Named" });
    // Section 20.1: plain self-tape scheduling is Tony's own topic; the frozen Booking Desk addressed
    // by name is still Named (the switchboard holds it with Tony's FROZEN note).
    expect(rf("check my self-tape availability", "auto", "voice")).toMatchObject({ role: "general", kind: "Self" });
    expect(rf("hey tony, ask the booking desk to check my availability", "auto", "voice")).toMatchObject({ role: "booking", kind: "Named" });
  });
});

// Regression: the voice controller strips the wake phrase ("Hey Tony,") BEFORE routing, so the
// router never saw the name and "Hey Tony, check my self-tape availability" still went to Booking.
// The caller now says so with `addressed`; routeFor gets the stripped text, as in the app.
describe("addressed: the wake phrase was stripped before routing", () => {
  const rfA = (utterance: string, thread: ThreadId, channel: Channel, addressed: boolean, phone = false) => routeFor({ utterance, thread, channel, cfg, osName: "Tony", phone, addressed });
  it("a Domain hit stays with Tony on the desktop, voice and typed", () => {
    for (const ch of ["voice", "text"] as Channel[]) {
      expect(rfA("render the reel", "auto", ch, true), ch).toMatchObject({ role: "general", kind: "Self", confidence: "high", reason: "you addressed Tony" });
      expect(rfA(TOPIC, "auto", ch, true), ch).toMatchObject({ role: "general", kind: "Self" });
      // Not addressed: the same stripped text still delegates from Auto (desktop unchanged).
      expect(rfA("render the reel", "auto", ch, false), ch).toMatchObject({ role: "director", kind: "Domain" });
    }
    // The renamed OS name goes in the reason.
    expect(routeFor({ utterance: TOPIC, thread: "auto", channel: "voice", cfg, osName: "Friday", phone: false, addressed: true })).toMatchObject({ role: "general", kind: "Self", reason: "you addressed Friday" });
  });
  it("a Named agent still delegates; a live read is still Direct; nothing else changes", () => {
    expect(rfA("ask the director to edit video", "auto", "voice", true)).toMatchObject({ role: "director", kind: "Named" });
    expect(rfA("coder, fix the broken build", "general", "text", true)).toMatchObject({ role: "coder", kind: "Named" });
    expect(rfA("any whatsapp updates", "auto", "voice", true)).toMatchObject({ role: "general", kind: "Direct" });
    expect(rfA("good morning", "auto", "voice", true)).toMatchObject({ role: "general", kind: "Default" });
    expect(rfA("what's up", "auto", "text", true)).toMatchObject({ role: "general", kind: "Default" });
    // A typed line on a sub-agent tab with no topic keeps its tab.
    expect(rfA("how's it going", "prompter", "text", true)).toMatchObject({ role: "prompter", kind: "Tab" });
  });
  it("defaults to not addressed", () => {
    expect(routeFor({ utterance: "render the reel", thread: "auto", channel: "voice", cfg, osName: "Tony", phone: false })).toMatchObject({ role: "director", kind: "Domain" });
  });
  it("the phone keeps an addressed topic with Tony too", () => {
    expect(rfA("check my self-tape availability", "auto", "voice", true, true)).toMatchObject({ role: "general", kind: "Self" });
  });
});

describe("phone (Android app): a topic stays with Tony", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it("a Domain hit stays with Tony by voice and typed, on Tony's threads", () => {
    for (const thread of ["auto", "general"] as ThreadId[]) {
      for (const ch of ["voice", "text"] as Channel[]) {
        const r = rfPhone(TOPIC, thread, ch);
        expect(r.role, `${thread}/${ch}`).toBe("general");
        expect(r.kind, `${thread}/${ch}`).not.toBe("Domain");
      }
    }
    expect(rfPhone(TOPIC, "auto", "voice")).toMatchObject({ role: "general", kind: "Self" });
    expect(rfPhone(TOPIC, "auto", "text")).toMatchObject({ role: "general", kind: "Self" });
    expect(rfPhone("check my self-tape availability for friday", "auto", "voice")).toMatchObject({ role: "general", kind: "Self" });
  });
  it("only a Named agent or an explicit pick delegates", () => {
    for (const ch of ["voice", "text"] as Channel[]) {
      expect(rfPhone("tell the coder to fix the build", "auto", ch), ch).toMatchObject({ role: "coder", kind: "Named" });
      expect(rfPhone("director, please check the reel", "auto", ch), ch).toMatchObject({ role: "director", kind: "Named" });
      expect(rfPhone("my director hasn't replied yet", "auto", ch), ch).toMatchObject({ role: "director", kind: "Named" });
    }
    // A typed line on a sub-agent's own tab is an explicit pick of that agent.
    expect(rfPhone(TOPIC, "prompter", "text")).toMatchObject({ role: "prompter", kind: "Tab" });
    // Voice on a sub-agent tab stays Tony's, as on the desktop.
    expect(rfPhone(TOPIC, "prompter", "voice")).toMatchObject({ role: "general", kind: "Self" });
  });
  it("live reads, self addresses and no-match lines are unchanged", () => {
    expect(rfPhone("any whatsapp updates", "auto", "voice")).toMatchObject({ role: "general", kind: "Direct" });
    expect(rfPhone("thanks tony", "auto", "text")).toMatchObject({ role: "general", kind: "Self" });
    expect(rfPhone("good morning", "auto", "voice")).toMatchObject({ role: "general", kind: "Default" });
  });
  it("the desktop keeps delegating a Domain hit from Auto", () => {
    expect(rf(TOPIC, "auto", "voice")).toMatchObject({ role: "designer", kind: "Domain" });
    expect(rf(TOPIC, "auto", "text")).toMatchObject({ role: "designer", kind: "Domain" });
    expect(routeFor({ utterance: TOPIC, thread: "auto", channel: "text", cfg, phone: false })).toMatchObject({ role: "designer", kind: "Domain" });
  });
  it("defaults to isAndroidApp(): the Android app keeps the topic, desktop Tauri delegates", () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Linux; Android 14; SM-S901W) AppleWebKit/537.36" });
    expect(routeFor({ utterance: TOPIC, thread: "auto", channel: "voice", cfg })).toMatchObject({ role: "general", kind: "Self" });
    expect(routeFor({ utterance: TOPIC, thread: "auto", channel: "text", cfg })).toMatchObject({ role: "general", kind: "Self" });
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/131.0" });
    expect(routeFor({ utterance: TOPIC, thread: "auto", channel: "voice", cfg })).toMatchObject({ role: "designer", kind: "Domain" });
  });
  it("Tony's phone threads: Auto in the app, Tony's own thread on the HUD (both keep topics above)", () => {
    expect(tonyThreadFor("command", "auto")).toBe("auto");
    expect(tonyThreadFor("command", "booking", true)).toBe("general");
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

describe("Solo hold mirrored from Rust (regression)", () => {
  // Under Solo the chat used to say "Routing … to Coder…" and play the handoff cue, then Rust kept
  // the turn with Tony: the transcript recorded a delegation that never happened.
  it("a Domain / low-confidence hit stays with Tony under surface_only; a Named-high address doesn't", () => {
    const solo = { explicit: false, dispatch: "surface_only" };
    expect(soloHold(rf("I think the coder should check the landing page", "auto", "text"), solo)).toMatchObject({ role: "general", kind: "Self" });
    expect(soloHold(rf("fix bug in the repo script", "auto", "text"), solo)).toMatchObject({ role: "general", kind: "Self" });
    expect(soloHold(rf("tell the coder to fix the build", "auto", "text"), solo)).toMatchObject({ role: "coder", kind: "Named" });
    expect(soloHold(rf("fix bug in the repo script", "auto", "text"), { explicit: false, dispatch: "ask_before_dispatch" }).role).toBe("coder");
    // Casting calls are Tony's own topic now (Section 20.1): nothing to hold.
    expect(soloHold(rf("check my last five whatsapp messages from the casting call", "auto", "text"), solo).role).toBe("general");
  });
});

describe("switchboard hold mirrored from Rust (frozenHold)", () => {
  const eff = (id: string) => effectiveOf(PRESET_MODES, id);
  const master = { frozenAgents: ["booking"], frozenTools: [] };
  const hold = (r: RoutedTurn, id: string, explicit = false, freeze: typeof master | null = master) => frozenHold(r, { explicit, effective: eff(id), freeze, osName: "Tony" });

  it("Tony's own routing never goes to an agent frozen in the mode", () => {
    // A Domain hit (the Designer's topic) in Operations: Ops + Biz Ops only.
    expect(rf(TOPIC, "auto", "text")).toMatchObject({ role: "designer", kind: "Domain" });
    expect(hold(rf(TOPIC, "auto", "text"), "operations")).toMatchObject({ role: "general", kind: "Self", reason: "Designer is frozen in Operations mode" });
    // A low-confidence mention is not a direct ask.
    expect(hold(rf("I think the coder should check the landing page", "auto", "text"), "operations")).toMatchObject({ role: "general", kind: "Self" });
    // Live in the mode, or no overlay: unchanged.
    expect(hold(rf(TOPIC, "auto", "text"), "builder")).toMatchObject({ role: "designer", kind: "Domain" });
    expect(hold(rf(TOPIC, "auto", "text"), "brainstorm")).toMatchObject({ role: "designer", kind: "Domain" });
  });

  it("a direct ask (naming the agent, or typing on its tab) still goes through, like Solo", () => {
    expect(hold(rf("tell the coder to fix the build", "auto", "text"), "operations")).toMatchObject({ role: "coder", kind: "Named" });
    expect(hold(rf("what's the time", "coder", "text"), "operations", true)).toMatchObject({ role: "coder", kind: "Tab" });
    expect(hold(rf("tell the coder to fix the build", "auto", "voice"), "learning")).toMatchObject({ role: "coder", kind: "Named" });
  });

  it("a globally frozen agent never runs, even asked directly", () => {
    // Named, the frozen Booking Desk is routed to and then held (Section 20.1).
    const booking = rf("hey tony, ask the booking desk to check my availability", "auto", "voice");
    expect(booking).toMatchObject({ role: "booking", kind: "Named" });
    expect(hold(booking, "brainstorm")).toMatchObject({ role: "general", kind: "Self", reason: "Booking Desk is frozen on the master switchboard" });
    expect(hold(rf("check my availability", "booking", "text"), "brainstorm", true)).toMatchObject({ role: "general", kind: "Self" });
    // A route that does reach a master-frozen agent (the webview's config lagging) is held.
    const dirFrozen = { frozenAgents: ["director"], frozenTools: [] };
    const named = rf("hey tony, ask the director to edit video", "auto", "voice");
    expect(named).toMatchObject({ role: "director", kind: "Named" });
    const held = hold(named, "brainstorm", false, dirFrozen);
    expect(held).toMatchObject({ role: "general", kind: "Self" });
    expect(held.reason).toMatch(/frozen on the master switchboard/);
    // Thawed on the master switchboard: back to the old routing.
    expect(hold(named, "brainstorm", false, null)).toMatchObject({ role: "director", kind: "Named" });
  });

  it("Tony himself is never held", () => {
    for (const id of ["learning", "operations", "builder"]) expect(hold(rf("thanks tony", "auto", "text"), id)).toMatchObject({ role: "general", kind: "Self" });
    expect(hold(rf("good morning", "auto", "voice"), "learning").role).toBe("general");
  });
});

describe("the phone mirror of a streamed answer (regression)", () => {
  // The phone kept the first ~1.5 s of a streamed answer ("streaming…") for good: mergeRemote
  // ignored every id it already had, and the desktop never re-pushed an in-place update.
  it("a newer revision of a turn the phone already holds replaces it", () => {
    useVoice.setState({ turns: [] });
    const t = useVoice.getState().pushTurn({ who: "agent", from: "os", text: "Once", thread: "auto", meta: "streaming…" });
    const partial = useVoice.getState().turns[0];
    useVoice.getState().updateTurn(t.id, { text: "Once upon a time, the end.", meta: "local" });
    const full = useVoice.getState().turns[0];
    expect(full.rev).toBe(1);
    expect(remoteIsNewer(partial, full)).toBe(true);
    useVoice.setState({ turns: [partial] });
    useVoice.getState().mergeRemote([full]);
    expect(useVoice.getState().turns).toHaveLength(1);
    expect(useVoice.getState().turns[0]).toMatchObject({ text: "Once upon a time, the end.", meta: "local" });
    // An older copy never overwrites a newer local one.
    useVoice.getState().mergeRemote([partial]);
    expect(useVoice.getState().turns[0].text).toBe("Once upon a time, the end.");
  });
});
