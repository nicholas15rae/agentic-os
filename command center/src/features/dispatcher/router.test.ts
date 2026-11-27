import { describe, expect, it } from "vitest";
import { addressesSelf, DEFAULT_ROUTING_CONFIG, directTool, isFrozenRole, isSelfRoleId, matchingAgents, normalize, originalTail, overlappingPhrases, resetRouterFrozenAgents, resolve, setRouterFrozenAgents } from "./router";
import fixtures from "./router.fixtures.json";

interface Fixture {
  desc: string;
  text: string;
  role: string | null;
  kind: string;
  taskContains?: string;
  /** `directTool`'s answer; missing = null. */
  direct?: string;
  /** The configured OS name (Rust: `cfg.os_name`); missing = the default ("Tony" is built in). */
  osName?: string;
  /** The master switchboard's frozen agents for this case; missing = the default set. */
  frozen?: string[];
}

describe("resolve (shared fixtures)", () => {
  const list = fixtures as Fixture[];
  it("has a decent fixture set", () => {
    expect(list.length).toBeGreaterThanOrEqual(10);
  });
  for (const f of list) {
    it(`${f.desc} — ${JSON.stringify(f.text)}`, () => {
      const r = resolve(f.text, DEFAULT_ROUTING_CONFIG, f.osName, f.frozen ? { frozen: f.frozen } : {});
      expect(r.role).toBe(f.role);
      expect(r.kind).toBe(f.kind);
      if (f.taskContains) expect(r.task).toContain(f.taskContains);
      expect(directTool(f.text)).toBe(f.direct ?? null);
    });
  }
});

describe("normalize", () => {
  it("fixes the Whisper 'whats app' / 'what sapp' mangles anywhere", () => {
    expect(normalize("whats app")).toBe("whatsapp");
    expect(normalize("what sapp")).toBe("whatsapp");
    expect(normalize("hey tony what's new on whats app")).toBe("hey tony whats new on whatsapp");
  });
  // Regression: every "what's up" greeting became "whatsapp" (a Booking domain) and was delegated
  // to the Booking Desk (20-70 s instead of 2-5 s).
  it.each([
    ["what's up", "whats up"],
    ["Hey Tony, what's up?", "hey tony whats up"],
    ["what's up tony", "whats up tony"],
    ["hey what's up tony", "hey whats up tony"],
    ["what's up with the build", "whats up with the build"],
    ["so I'm on my phone now hey tony what's up", "so im on my phone now hey tony whats up"],
    ["what's up, any updates?", "whats up any updates"],
    // "…what's up with X" asks about X, even after a before-cue word.
    ["check what's up with the droplet", "check whats up with the droplet"],
    ["on what's up with the build", "on whats up with the build"],
    // "come / hang / hold on, what's up" is an idiom, not "on WhatsApp".
    ["come on, what's up", "come on whats up"],
    ["hang on what's up", "hang on whats up"],
    ["hold on, what's up?", "hold on whats up"],
    // "in" / "the" are no longer before-cues.
    ["I'm in, what's up?", "im in whats up"],
    ["anything new in what's up", "anything new in whats up"],
    ["the what's up", "the whats up"],
  ])("a greeting is not WhatsApp: %s", (text, out) => {
    expect(normalize(text)).toBe(out);
  });
  it.each([
    ["check my whats up messages", "check my whatsapp messages"],
    ["any whats up messages", "any whatsapp messages"],
    ["open whats up", "open whatsapp"],
    ["on whats up", "on whatsapp"],
    ["anything new on what's up", "anything new on whatsapp"],
    ["read it from whats up", "read it from whatsapp"],
    ["send it via what's up", "send it via whatsapp"],
    ["check the what's up group", "check the whatsapp group"],
    ["what's up texts from sam", "whatsapp texts from sam"],
    ["any what's up DMs", "any whatsapp dms"],
    ["clear my what's up notifications", "clear my whatsapp notifications"],
    ["what's up msgs", "whatsapp msgs"],
    ["any what's up chats", "any whatsapp chats"],
  ])("clearly the app: %s", (text, out) => {
    expect(normalize(text)).toBe(out);
  });
  it("spells out number words", () => {
    expect(normalize("last five messages")).toBe("last 5 messages");
  });
  it("lowercases and strips punctuation except &", () => {
    expect(normalize("B&Co")).toBe("b&co");
    expect(normalize("Hello, world!")).toBe("hello world");
  });
});

describe("whole-word boundaries", () => {
  it("does not match 'book' as a substring of 'booking'", () => {
    expect(resolve("please book a table for two", DEFAULT_ROUTING_CONFIG).kind).toBe("Default");
  });
  it("does not match 'ui' inside 'quick'", () => {
    expect(resolve("give me a quick summary", DEFAULT_ROUTING_CONFIG).kind).toBe("Default");
  });
});

describe("domain tie-break", () => {
  it("follows the role order on an equal score; Tony's topic never steals one", () => {
    // bizops "inventory" (9) vs designer "animation" (9).
    expect(resolve("inventory animation", DEFAULT_ROUTING_CONFIG)).toMatchObject({ role: "bizops", kind: "Domain" });
    // Tony's "schedule" (8) vs the Director's "captions" (8): the agent keeps it.
    expect(resolve("schedule the captions", DEFAULT_ROUTING_CONFIG)).toMatchObject({ role: "director", kind: "Domain" });
  });
});

// Section 20.1: the router never picks an agent frozen on the master switchboard.
describe("frozen agents: named, never by topic", () => {
  it("the Booking Desk keeps only its names; a frozen agent addressed by name is Named, its topics never fire", () => {
    expect(DEFAULT_ROUTING_CONFIG.agents.booking).toEqual({ names: ["booking desk", "booking agent", "B&Co"], domains: [] });
    expect(isFrozenRole("librarian") && isFrozenRole("booking") && !isFrozenRole("general") && !isFrozenRole("coder")).toBe(true);
    for (const [text, role] of [
      ["ask the librarian to search vault for the contract", "librarian"],
      ["librarian, find document about the lease", "librarian"],
      ["ask the booking desk to check my availability", "booking"],
      ["booking desk, any casting calls", "booking"],
      ["tony, my booking agent hasn't replied about the wardrobe", "booking"],
    ]) {
      expect(resolve(text, DEFAULT_ROUTING_CONFIG), text).toMatchObject({ role, kind: "Named" });
    }
    // Topics of a frozen agent fall through: to the next live topic, Tony's own, or nothing.
    expect(resolve("find document about the rust repo", DEFAULT_ROUTING_CONFIG)).toMatchObject({ role: "coder", kind: "Domain" });
    expect(resolve("find document about the lease", DEFAULT_ROUTING_CONFIG)).toMatchObject({ role: null, kind: "Default" });
    expect(resolve("draft email to agent about the audition", DEFAULT_ROUTING_CONFIG)).toMatchObject({ role: "general", kind: "Self" });
  });
  it("follows the master switchboard (setRouterFrozenAgents) and a per-call override", () => {
    try {
      setRouterFrozenAgents([]);
      expect(resolve("find document about the lease", DEFAULT_ROUTING_CONFIG)).toMatchObject({ role: "librarian", kind: "Domain" });
      setRouterFrozenAgents(["booking", "Coder"]);
      expect(resolve("ask the coder to fix bug in the layout", DEFAULT_ROUTING_CONFIG)).toMatchObject({ role: "coder", kind: "Named", confidence: "high" });
      expect(resolve("fix bug in the layout", DEFAULT_ROUTING_CONFIG).role).toBe("designer");
      expect(resolve("write code", DEFAULT_ROUTING_CONFIG)).toMatchObject({ role: null, kind: "Default" });
      expect(resolve("write code", DEFAULT_ROUTING_CONFIG, "", { frozen: [] })).toMatchObject({ role: "coder", kind: "Domain" });
    } finally {
      resetRouterFrozenAgents();
    }
  });
});

// Section 20.2: Settings → Routing warns when a phrase matches more than one agent.
describe("trigger overlap", () => {
  it("lists every agent a phrase matches, frozen ones marked", () => {
    const m = matchingAgents("edit my self-tape for the audition", DEFAULT_ROUTING_CONFIG);
    expect(m.map((x) => x.role).sort()).toEqual(["director", "general"]);
    expect(m.find((x) => x.role === "director")?.phrases).toEqual(["edit my self-tape"]);
    expect(matchingAgents("search vault", DEFAULT_ROUTING_CONFIG)).toEqual([{ role: "librarian", phrases: ["vault", "search vault"], frozen: true }]);
    expect(matchingAgents("good morning", DEFAULT_ROUTING_CONFIG)).toEqual([]);
  });
  it("the static list holds the phrases that match more than one live agent's triggers", () => {
    const o = overlappingPhrases(DEFAULT_ROUTING_CONFIG);
    const byPhrase = Object.fromEntries(o.map((x) => [x.phrase, x.roles]));
    expect(byPhrase["edit my self-tape"]?.sort()).toEqual(["director", "general"]);
    expect(byPhrase["system status"]).toBeUndefined();
    // The frozen Librarian never counts; the old business / finance / calendar overlaps are gone.
    for (const x of o) expect(x.roles, x.phrase).not.toContain("librarian");
    for (const p of ["invoice", "quote", "calendar", "schedule", "contracting"]) expect(byPhrase[p], p).toBeUndefined();
  });
});

describe("default matrix: WhatsApp is not a Booking topic", () => {
  it("booking's domains hold no messages / texts phrase at all (Tony reads them himself)", () => {
    const d = DEFAULT_ROUTING_CONFIG.agents.booking.domains;
    for (const p of d) expect(p, p).not.toMatch(/whatsapp|messages?|texts?/);
  });
  it("a plain messages read is Tony's WhatsApp tool, never the agent inbox or the Booking Desk", () => {
    for (const text of ["check my messages", "any new messages", "read my last five messages", "give me the last 5 messages", "check my texts"]) {
      expect(directTool(text), text).toBe("whatsapp");
      expect(resolve(text, DEFAULT_ROUTING_CONFIG).role, text).not.toBe("booking");
    }
    for (const text of ["check my agent messages", "the messages in this design feel off", "send a message to Sam"]) expect(directTool(text), text).toBeNull();
    // An email word still wins: Gmail, not WhatsApp.
    expect(directTool("check my last five gmail messages")).toBe("gmail");
  });
  it("WhatsApp lines are Tony's (Default + his live tool), never a Booking Domain", () => {
    for (const text of ["check my whatsapp", "any whatsapp updates", "what's up", "check my what's up messages"]) {
      const r = resolve(text, DEFAULT_ROUTING_CONFIG);
      expect([r.role, r.kind], text).toEqual([null, "Default"]);
    }
  });
});

describe("Tony's name beats a topic", () => {
  it("a self address + a Domain-only hit is Self", () => {
    for (const text of ["hey tony, check my self-tape availability", "tony, how's the droplet doing", "jarvis redo the color palette", "ask the dispatcher to check my calendar"]) {
      expect(resolve(text, DEFAULT_ROUTING_CONFIG), text).toMatchObject({ role: "general", kind: "Self", confidence: "high" });
    }
    // The renamed OS's name counts too.
    expect(resolve("friday, check my wardrobe for the shoot", DEFAULT_ROUTING_CONFIG, "Friday")).toMatchObject({ role: "general", kind: "Self" });
  });
  it("without Tony's name the same topic still delegates", () => {
    expect(resolve("render the reel", DEFAULT_ROUTING_CONFIG)).toMatchObject({ role: "director", kind: "Domain" });
    expect(resolve("friday, check my reel for the shoot", DEFAULT_ROUTING_CONFIG)).toMatchObject({ role: "director", kind: "Domain" });
    // Plain self-tape / availability are Tony's own topics now (Section 20.1).
    expect(resolve("check my self-tape availability", DEFAULT_ROUTING_CONFIG)).toMatchObject({ role: "general", kind: "Self" });
  });
  it("infrastructure, job quotes and estimates are his own topics: no agent takes them", () => {
    for (const t of ["system status of the droplet", "is the droplet healthy and is docker up", "how many estimates are still out", "send the quote for the deck job"]) {
      expect(resolve(t, DEFAULT_ROUTING_CONFIG), t).toMatchObject({ role: "general", kind: "Self" });
    }
  });
  it("a Named agent still wins over Tony's name", () => {
    expect(resolve("hey tony, ask the director to edit video for the shoot", DEFAULT_ROUTING_CONFIG)).toMatchObject({ role: "director", kind: "Named", confidence: "high", task: "edit video for the shoot" });
    expect(resolve("tony, coder, fix the build", DEFAULT_ROUTING_CONFIG)).toMatchObject({ role: "coder", kind: "Named" });
    expect(resolve("tony, my coder hasn't replied about the layout", DEFAULT_ROUTING_CONFIG)).toMatchObject({ role: "coder", kind: "Named" });
    // The frozen Booking Desk is never Named.
    expect(resolve("hey tony, ask the booking desk to check my availability", DEFAULT_ROUTING_CONFIG)).toMatchObject({ role: "booking", kind: "Named", confidence: "high" });
  });
});

// Regression: the override fired for a self name ANYWHERE in the line, so the common nouns in
// SELF_NAMES ("dispatcher", "orchestrator") and a renamed OS name ("Friday") beat every topic.
describe("only a real address beats a topic (not a mention)", () => {
  const cfg = DEFAULT_ROUTING_CONFIG;
  it("a self name used as a noun or an object leaves the topic's agent in charge", () => {
    expect(resolve("fix bug in the orchestrator react code", cfg)).toMatchObject({ role: "coder", kind: "Domain" });
    expect(resolve("refactor the dispatcher rust code", cfg)).toMatchObject({ role: "coder", kind: "Domain" });
    expect(resolve("render the reel for friday", cfg, "Friday")).toMatchObject({ role: "director", kind: "Domain" });
    expect(resolve("fix the layout css before friday", cfg, "Friday")).toMatchObject({ role: "designer", kind: "Domain" });
    expect(resolve("fix bug in the orchestrator", cfg)).toMatchObject({ role: "coder", kind: "Domain" });
    expect(resolve("get the orchestrator react code working", cfg)).toMatchObject({ role: "coder", kind: "Domain" });
    expect(resolve("the dispatcher keeps timing out, fix bug in the retry loop", cfg)).toMatchObject({ role: "coder", kind: "Domain" });
  });
  it("a mention with no topic is still Tony's (the step-(d) fallback)", () => {
    expect(resolve("refactor the dispatcher", cfg)).toMatchObject({ role: "general", kind: "Self" });
    expect(resolve("so I'm on my phone now hey tony what's up", cfg)).toMatchObject({ role: "general", kind: "Self" });
    expect(resolve("the dispatcher keeps timing out, is the droplet healthy", cfg)).toMatchObject({ role: "general", kind: "Self" });
  });
  it.each([
    ["hey tony, render the reel", ""],
    ["ok jarvis, redo the color palette for the landing page", ""],
    ["so tony, is the reel rendered", ""],
    ["yo tony check my layout css", ""],
    ["friday, check my reel for the shoot", "Friday"],
    ["ask tony to render the reel", ""],
    ["tell the dispatcher about the thumbnail", ""],
    ["have jarvis check the inventory", ""],
    ["let tony know the layout changed", ""],
    ["render the reel, tony", ""],
    ["is the thumbnail ready tony please", ""],
    ["render the reel, friday", "Friday"],
  ])("an address beats the topic: %s", (text, osName) => {
    expect(resolve(text, cfg, osName)).toMatchObject({ role: "general", kind: "Self", confidence: "high", reason: "you addressed the OS by name" });
    expect(addressesSelf(text, cfg, osName)).toBe(true);
  });
  it("addressesSelf is false for a mention, a greeting, a Named agent's own name and an empty line", () => {
    for (const [text, osName] of [
      ["fix bug in the orchestrator react code", ""],
      ["refactor the dispatcher rust code", ""],
      ["get the orchestrator react code working", ""],
      ["check my self-tape availability for friday", "Friday"],
      ["play something by tony", ""],
      ["the dispatcher keeps timing out", ""],
      ["check my self-tape availability", ""],
      ["", ""],
    ]) {
      expect(addressesSelf(text, cfg, osName), text).toBe(false);
    }
  });
  it("ignoreSelfAddress reads the topic only (the brainstorm's agent for an offer)", () => {
    const o = { ignoreSelfAddress: true };
    expect(resolve("I've been thinking about a warmer color palette for the landing page, tony", cfg, "Tony", o)).toMatchObject({ role: "designer", kind: "Domain" });
    expect(resolve("hey tony, render the reel", cfg, "Tony", o)).toMatchObject({ role: "director", kind: "Domain" });
    // Without it, the same line is Tony's; with it, no topic is still Self, a Named agent still Named.
    expect(resolve("I've been thinking about a warmer color palette for the landing page, tony", cfg, "Tony")).toMatchObject({ role: "general", kind: "Self" });
    expect(resolve("thanks tony", cfg, "Tony", o)).toMatchObject({ role: "general", kind: "Self" });
    expect(resolve("hey tony, ask the director to check the reel", cfg, "Tony", o)).toMatchObject({ role: "director", kind: "Named" });
  });
});

describe("directTool", () => {
  it.each([
    ["any WhatsApp updates?", "whatsapp"],
    ["Hey Tony, anything new on WhatsApp", "whatsapp"],
    ["read my last 3 whatsapp messages", "whatsapp"],
    ["what's in my inbox", "gmail"],
    ["did I get any mail today", "gmail"],
    ["is it going to snow tonight", "weather"],
    ["how cold is it outside", "weather"],
    ["what song is this", "spotify"],
    ["give me an update on WhatsApp", "whatsapp"],
    ["do I need an umbrella today", "weather"],
    ["weather forecast for Paris", "weather"],
    ["what's the weather", "weather"],
    ["check my what's up messages", "whatsapp"],
  ])("%s → %s", (text, tool) => {
    expect(directTool(text)).toBe(tool);
  });

  it.each(["send a whatsapp to Sam", "delete my last email", "tell him on whatsapp I'm late", "play purple rain", "what's the CPU temperature", "hey what's up", ""])("%s → null", (text) => {
    expect(directTool(text)).toBeNull();
  });

  // Review fix: writes and work talk that merely mention the weather / mail / WhatsApp words.
  it.each([
    "add a weather widget to the dashboard",
    "set the forecast widget to Toronto",
    "order an umbrella",
    "buy an umbrella on amazon",
    "create a filter for new emails from Amazon",
    "check the new mail server config",
    "pay the invoice from the latest email",
    "add the new emails from Sam to my todo list",
    "mark all emails from Sam as read",
    "cancel the meeting from my inbox invite",
    "add umbrella to my shopping list",
    "update the sales forecast spreadsheet",
    "schedule a meeting with Sam about the forecast",
    "email the forecast to Sam",
    "mute the WhatsApp chat with Sam",
    "what's up, any updates on the build?",
    "hey what's up, any updates?",
    "fix the weather api bug in the code",
    "Biz Ops, turn off the weather alerts",
    "Booking, order an umbrella for the shoot",
  ])("not a live read: %s", (text) => {
    expect(directTool(text)).toBeNull();
  });

  // Section 11.10: money READ questions are Tony's own Finance tool (mirrors routing.rs).
  it.each([
    "what do I owe ML Talent?",
    "how much do I still owe Imperious",
    "how much did contracting make this month?",
    "how much have I made this year",
    "how much did I spend last month",
    "what's still pending?",
    "who owes me money",
    "when is HST due?",
    "when is my next HST return due",
    "any unpaid invoices?",
    "which invoices are still unpaid",
    "how much commission do I owe",
    "what are my money reminders",
  ])("money read: %s → finance", (text) => {
    expect(directTool(text)).toBe("finance");
  });

  it.each([
    "log the hst on the commission cheque",
    "mark the ML Talent commission as paid",
    "record a 400 dollar cheque from Lee",
    "pay ML Talent what I owe them",
    "send Smith a reminder about the unpaid invoice",
    "add 42 dollars to the gear budget",
    "what orders are pending on the online store",
    "any pending emails?",
    "fix the overdue invoices widget",
    "make a new invoice for Smith",
  ])("not a money read: %s", (text) => {
    // "any pending emails?" is Tony's Gmail read; none of these is a Finance read.
    expect(directTool(text)).not.toBe("finance");
  });
});

describe("self (Tony) is never a delegation target", () => {
  it("isSelfRoleId: aliases and the OS name, any case", () => {
    for (const id of ["tony", "Tony", "general", "dispatcher", "orchestrator", "os", "jarvis", " TONY "]) expect(isSelfRoleId(id, "Tony")).toBe(true);
    expect(isSelfRoleId("friday", "Friday")).toBe(true);
    for (const id of ["prompter", "coder", "booking", "", "friday"]) expect(isSelfRoleId(id, "Tony")).toBe(false);
  });
  it("skips a self match and keeps scanning (mirrors routing.rs)", () => {
    const r = resolve("ask tony to ask the coder to fix it", DEFAULT_ROUTING_CONFIG);
    expect([r.role, r.kind]).toEqual(["coder", "Named"]);
    expect(r.task).toContain("fix");
    expect(resolve("tony, coder, fix the build", DEFAULT_ROUTING_CONFIG)).toMatchObject({ role: "coder", kind: "Named" });
  });
  it("an old config listing 'tony' / a self-alias key, and a renamed OS, all give Self", () => {
    const cfg = {
      ...DEFAULT_ROUTING_CONFIG,
      agents: { ...DEFAULT_ROUTING_CONFIG.agents, general: { names: ["tony"], domains: ["system status"] }, dispatcher: { names: ["boss"], domains: [] } },
    };
    for (const text of ["thanks friday", "thanks tony", "ask the boss what time it is"]) {
      expect(resolve(text, cfg, "Friday"), text).toMatchObject({ role: "general", kind: "Self" });
    }
  });
  it("the default matrix gives Tony no name triggers", () => {
    expect(DEFAULT_ROUTING_CONFIG.agents.general.names).toEqual([]);
  });
});

describe("a Named delegation's task keeps Nic's exact words (regression)", () => {
  // It used to be the lower-cased, punctuation-stripped normalized text: "rename configjson to
  // settingsjson and bump it to v25" reached the Coder.
  it("file names, versions, URLs, hex colours and decimals survive", () => {
    const cases: [string, string, string][] = [
      ["Tell the coder to rename config.json to settings.json and bump it to v2.5", "coder", "rename config.json to settings.json and bump it to v2.5"],
      ["Ask the coder to fix the bug at https://localhost:5173/play?id=3 — it's 1 off", "coder", "fix the bug at https://localhost:5173/play?id=3 — it's 1 off"],
      ["Designer, fix the hero: 1.5x bigger with #FF5500 accents", "designer", "fix the hero: 1.5x bigger with #FF5500 accents"],
      ["hey tony, tell my designer agent to check my last five WhatsApp messages", "designer", "check my last five WhatsApp messages"],
    ];
    for (const [text, role, task] of cases) {
      const r = resolve(text, DEFAULT_ROUTING_CONFIG);
      expect([r.role, r.kind, r.confidence], text).toEqual([role, "Named", "high"]);
      expect(r.task, text).toBe(task);
    }
  });
  it("falls back to the normalized tail when a Whisper mangle merges words", () => {
    expect(originalTail("tell the coder to check whats up messages", 4)).toBe("check whatsapp messages");
  });
});
