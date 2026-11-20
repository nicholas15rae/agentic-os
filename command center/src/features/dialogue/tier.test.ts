import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_ROUTING_CONFIG, directTool, resolve } from "@/features/dispatcher/router";
import { parseDevTask } from "@/features/os/os-intent-parse";
import { BRAINSTORM_IDLE_MS, useDialogue } from "./dialogue-store";
import { classifyTier, commitStrength, isCommitCue, leadsBrainstorm, looksBrainstorm, looksBuildShaped, offerTarget, parseDefer, type TierCtx } from "./tier";

const cfg = DEFAULT_ROUTING_CONFIG;
/** The voice controller's inputs for a line, from the real router (mutating is supplied per case). */
function ctx(text: string, o: Partial<TierCtx> = {}): TierCtx {
  const r = resolve(text, cfg, "Tony");
  const direct = r.kind !== "Named" && !!directTool(text);
  return { brainstormActive: false, routeKind: direct ? "Direct" : r.kind, routeConfidence: r.confidence, mutating: false, directTool: direct, osName: "Tony", ...o };
}

describe("parseDefer (Tier 4)", () => {
  it("hits, each to its target", () => {
    const cases: [string, string, boolean][] = [
      ["nah save it for later", "brainstorm", false],
      ["Nah, save it for later.", "brainstorm", false],
      ["Hey Tony, save that for later", "brainstorm", false],
      ["park it", "brainstorm", false],
      ["shelve that idea for now", "brainstorm", false],
      ["save for later", "brainstorm", false],
      ["add it to my brainstorming list", "brainstorm", true],
      ["add this to the brainstorm list", "brainstorm", true],
      ["put it in Play Place", "playplace", true],
      ["put that in the playplace", "playplace", true],
      ["save it to the play place for later", "playplace", true],
      ["add it to the ledger", "ledger", true],
      ["add it to the ideas and tasks ledger", "ledger", true],
      ["ok tony, add this to my ideas & tasks ledger please", "ledger", true],
      ["keep that for another time in my brainstorm notes", "brainstorm", true],
    ];
    for (const [line, target, explicit] of cases) expect(parseDefer(line, "Tony"), line).toEqual({ target, explicit });
  });

  it("misses: Spotify, the dev queue, questions, other lists, Named delegations", () => {
    for (const line of [
      "save this song for later",
      "save it for later on spotify",
      "add this song to my Late Night playlist",
      "add a todo to Linear",
      "add milk to my shopping list",
      "add this to the dev queue: the HUD flickers",
      "log a dev note the mic cuts out",
      "what's in the play place?",
      "tell the designer to update the play place layout",
      "save it",
      "keep it",
      "keep going",
      "I want to save money for later",
    ]) {
      expect(parseDefer(line, "Tony"), line).toBeNull();
    }
    // The dev-queue phrase stays a dev task (it parses before any defer line).
    expect(parseDevTask("add this to the dev queue: the HUD flickers")).not.toBeNull();
  });

  it("follows the configured OS name", () => {
    expect(parseDefer("Friday, park it", "Friday")).toEqual({ target: "brainstorm", explicit: false });
  });

  it("'for now' answers a question, it doesn't save: only park / shelve or a named list take it", () => {
    // Fix pass: "Want me to clear the 3 pm slot?" — "nah, keep it for now" used to save the
    // last 30 minutes of the thread to the Brainstorm list.
    for (const line of ["nah, keep it for now", "keep it for now", "hold onto it for now", "hang onto that for now", "save it for now", "no, keep that for now", "nah, save it for now", "keep for now"]) {
      expect(parseDefer(line, "Tony"), line).toBeNull();
    }
    expect(parseDefer("park it for now", "Tony")).toEqual({ target: "brainstorm", explicit: false });
    expect(parseDefer("park for now", "Tony")).toEqual({ target: "brainstorm", explicit: false });
    expect(parseDefer("nah, save it for later", "Tony")).toEqual({ target: "brainstorm", explicit: false });
    expect(parseDefer("save it to my brainstorm list for now", "Tony")).toEqual({ target: "brainstorm", explicit: true });
    expect(parseDefer("put that in the play place for now", "Tony")).toEqual({ target: "playplace", explicit: true });
  });
});

describe("thoughtform hardening (regressions)", () => {
  it("bare agreement is a weak cue (never Builder's no-card auto build); a real commit is strong", () => {
    for (const l of ["sounds good", "Sounds good.", "yeah that works", "Go.", "so do it"]) expect(commitStrength(l), l).toBe("weak");
    for (const l of ["ok let's do it", "lock it in", "ship it", "that's the plan", "let's build it", "sounds good, let's do it"]) expect(commitStrength(l), l).toBe("strong");
    expect(commitStrength("what's the plan")).toBeNull();
  });
  it("a bare 'thinking about…' opener is not build-shaped unless it names something to build", () => {
    for (const l of ["I've been thinking about emailing Sam about the contract renewal", "I'm thinking about calling my mom tonight", "I have an idea"]) expect(looksBuildShaped(l), l).toBe(false);
    for (const l of ["I've been thinking about building an audition tracker", "I've been thinking about an app that sends reminders", "I have an idea for a habit tracker app", "I want to build a landing page"]) expect(looksBuildShaped(l), l).toBe(true);
  });
});

describe("isCommitCue / looksBrainstorm", () => {
  it("commit cues", () => {
    for (const l of ["ok let's do it", "Okay, let's do it.", "that's the plan", "lock it in", "sounds good, go", "let's run with it", "alright let's go", "Hey Tony, let's build it"]) expect(isCommitCue(l), l).toBe(true);
    for (const l of ["let's do it tomorrow at 5", "do it again", "what's the plan", "ok"]) expect(isCommitCue(l), l).toBe(false);
  });
  it("brainstorm-shaped lines", () => {
    for (const l of ["I've been thinking about building an audition tracker", "what if the layout had a sidebar", "help me think through pricing", "should I go with a subscription"]) expect(looksBrainstorm(l), l).toBe(true);
    expect(looksBrainstorm("pause the music")).toBe(false);
  });
});

describe("classifyTier", () => {
  it("Tier 2: thinking out loud stays with Tony", () => {
    expect(classifyTier("I've been thinking about building an audition tracker", ctx("I've been thinking about building an audition tracker"))).toBe(2);
    // A Domain designer hit is still Tony's brainstorm.
    const line = "what if the layout had a sidebar";
    expect(resolve(line, cfg, "Tony").kind).toBe("Domain");
    expect(classifyTier(line, ctx(line))).toBe(2);
    // Thinking out loud beats the mutating verb list.
    expect(classifyTier("I've been thinking about an app that sends reminders", ctx("x", { mutating: true }))).toBe(2);
    // In a live brainstorm a plain follow-up is Tier 2; a real action is not.
    expect(classifyTier("and maybe a calendar view", ctx("and maybe a calendar view", { brainstormActive: true }))).toBe(2);
    expect(classifyTier("email Sam the deck", ctx("email Sam the deck", { brainstormActive: true, mutating: true }))).toBe(1);
  });

  it("a mutating command that only MENTIONS a brainstorm stays a command (Tier 1)", () => {
    // Fix pass: these went to brainstormTurn (noDelegate, no card) and nothing was done.
    for (const l of ["email Sam what if we pushed the shoot", "schedule a brainstorming session with Sam on Friday", "send my brainstorm notes to Sam", "text Sam should i bring the tripod"]) {
      expect(leadsBrainstorm(l), l).toBe(false);
      expect(classifyTier(l, ctx(l, { mutating: true })), l).toBe(1);
      expect(classifyTier(l, ctx(l, { mutating: true, brainstormActive: true })), l).toBe(1);
    }
    // Opening as thinking out loud still wins over the verb list.
    for (const l of ["what if we emailed Sam about pushing the shoot", "Hey Tony, should I email Sam the deck", "so I've been thinking about an app that sends reminders"]) {
      expect(leadsBrainstorm(l), l).toBe(true);
      expect(classifyTier(l, ctx(l, { mutating: true })), l).toBe(2);
    }
    // Not mutating: a mention is still enough (today's behaviour).
    expect(classifyTier("help me think through a brainstorming format", ctx("help me think through a brainstorming format"))).toBe(2);
  });

  it("Tier 1: commands", () => {
    const named = "tell the coder to fix the login bug";
    expect(resolve(named, cfg, "Tony")).toMatchObject({ kind: "Named", confidence: "high" });
    expect(classifyTier(named, ctx(named))).toBe(1);
    expect(classifyTier("tell the coder I've been thinking about a new idea", ctx("tell the coder I've been thinking about a new idea"))).toBe(1);
    for (const l of ["pause the music", "set a timer for 10 minutes", "any WhatsApp updates?"]) expect(classifyTier(l, ctx(l)), l).toBe(1);
    expect(classifyTier("any WhatsApp updates?", ctx("any WhatsApp updates?", { brainstormActive: true }))).toBe(1);
  });

  it("Tier 3: a commit cue only inside a live brainstorm", () => {
    expect(classifyTier("ok let's do it", ctx("ok let's do it", { brainstormActive: true }))).toBe(3);
    expect(classifyTier("ok let's do it", ctx("ok let's do it"))).toBe(1);
  });

  it("Tier 4: defer lines", () => {
    expect(classifyTier("nah, save it for later", ctx("nah, save it for later", { brainstormActive: true }))).toBe(4);
  });
});

describe("offerTarget (U5)", () => {
  it("build-shaped → the pipeline", () => {
    expect(offerTarget({ buildShaped: true, userText: "", cfg })).toEqual({ kind: "pipeline" });
    expect(offerTarget({ buildShaped: false, userText: "I want to build a tracker app for auditions", cfg })).toEqual({ kind: "pipeline" });
  });
  it("otherwise the agent the brainstorm was about", () => {
    expect(offerTarget({ buildShaped: false, topicRole: "designer", userText: "", cfg })).toEqual({ kind: "agent", role: "designer" });
    expect(offerTarget({ buildShaped: false, userText: "what if we redo the color palette and layout", cfg, osName: "Tony" })).toEqual({ kind: "agent", role: "designer" });
  });
  it("nothing to hand off → null (Tony keeps talking)", () => {
    expect(offerTarget({ buildShaped: false, userText: "should I call my mom tonight", cfg, osName: "Tony" })).toBeNull();
    expect(offerTarget({ buildShaped: false, topicRole: "general", userText: "", cfg, osName: "Tony" })).toBeNull();
  });
});

describe("dialogue-store sessions", () => {
  beforeEach(() => useDialogue.setState({ sessions: {} }));
  it("starts on the first Tier-2 turn and keeps its start", () => {
    const d = useDialogue.getState();
    d.touch("auto", "t1", { topicRole: "designer" }, 1000);
    d.touch("auto", "t2", { buildShaped: true }, 2000);
    expect(useDialogue.getState().active("auto", 2500)).toMatchObject({ fromTurnId: "t1", topicRole: "designer", buildShaped: true, startedAt: 1000, lastAt: 2000 });
    // Tony's conversation is one brainstorm on both his threads ("auto" / "general": the view
    // decides which a voice line lands in); a sub-agent thread has its own.
    expect(useDialogue.getState().active("general", 2500)).toMatchObject({ fromTurnId: "t1" });
    expect(useDialogue.getState().active("coder", 2500)).toBeNull();
  });
  it("ends on end() and after 20 minutes idle", () => {
    const d = useDialogue.getState();
    d.touch("auto", "t1", {}, 0);
    expect(d.active("auto", BRAINSTORM_IDLE_MS)).not.toBeNull();
    expect(d.active("auto", BRAINSTORM_IDLE_MS + 1)).toBeNull();
    d.touch("general", "t9", {}, 0);
    d.end("general");
    expect(d.active("general", 1)).toBeNull();
  });
});
