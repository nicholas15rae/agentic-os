import { describe, expect, it } from "vitest";
import { addressesSelf, DEFAULT_ROUTING_CONFIG, directTool, isSelfRoleId, normalize, originalTail, resolve } from "./router";
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
}

describe("resolve (shared fixtures)", () => {
  const list = fixtures as Fixture[];
  it("has a decent fixture set", () => {
    expect(list.length).toBeGreaterThanOrEqual(10);
  });
  for (const f of list) {
    it(`${f.desc} — ${JSON.stringify(f.text)}`, () => {
      const r = resolve(f.text, DEFAULT_ROUTING_CONFIG, f.osName);
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
  it("prefers booking over ops on an equal score", () => {
    // booking "wardrobe" (8) vs ops "schedule" (8).
    const r = resolve("schedule a wardrobe fitting", DEFAULT_ROUTING_CONFIG);
    expect(r.role).toBe("booking");
    expect(r.kind).toBe("Domain");
  });
});

describe("default matrix: WhatsApp is not a Booking topic", () => {
  it("booking's domains drop bare 'whatsapp' / 'messages' but keep 'last 5 messages'", () => {
    const d = DEFAULT_ROUTING_CONFIG.agents.booking.domains;
    expect(d).not.toContain("whatsapp");
    expect(d).not.toContain("messages");
    expect(d).toContain("last 5 messages");
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
    expect(resolve("check my self-tape availability", DEFAULT_ROUTING_CONFIG)).toMatchObject({ role: "booking", kind: "Domain" });
    expect(resolve("friday, check my wardrobe for the shoot", DEFAULT_ROUTING_CONFIG)).toMatchObject({ role: "booking", kind: "Domain" });
  });
  it("only his name, not his own topic, beats another agent's topic", () => {
    expect(resolve("system status of the droplet", DEFAULT_ROUTING_CONFIG)).toMatchObject({ role: "ops", kind: "Domain" });
  });
  it("a Named agent still wins over Tony's name", () => {
    expect(resolve("hey tony, ask the booking desk to check my availability", DEFAULT_ROUTING_CONFIG)).toMatchObject({ role: "booking", kind: "Named", confidence: "high", task: "check my availability" });
    expect(resolve("tony, coder, fix the build", DEFAULT_ROUTING_CONFIG)).toMatchObject({ role: "coder", kind: "Named" });
    expect(resolve("tony, my booking agent hasn't replied about the wardrobe", DEFAULT_ROUTING_CONFIG)).toMatchObject({ role: "booking", kind: "Named" });
  });
});

// Regression: the override fired for a self name ANYWHERE in the line, so the common nouns in
// SELF_NAMES ("dispatcher", "orchestrator") and a renamed OS name ("Friday") beat every topic.
describe("only a real address beats a topic (not a mention)", () => {
  const cfg = DEFAULT_ROUTING_CONFIG;
  it("a self name used as a noun or an object leaves the topic's agent in charge", () => {
    expect(resolve("fix bug in the orchestrator react code", cfg)).toMatchObject({ role: "coder", kind: "Domain" });
    expect(resolve("refactor the dispatcher rust code", cfg)).toMatchObject({ role: "coder", kind: "Domain" });
    expect(resolve("check my self-tape availability for friday", cfg, "Friday")).toMatchObject({ role: "booking", kind: "Domain" });
    expect(resolve("book the wardrobe fitting before friday", cfg, "Friday")).toMatchObject({ role: "booking", kind: "Domain" });
    expect(resolve("fix bug in the orchestrator", cfg)).toMatchObject({ role: "coder", kind: "Domain" });
    expect(resolve("get the orchestrator react code working", cfg)).toMatchObject({ role: "coder", kind: "Domain" });
    expect(resolve("the dispatcher keeps timing out, is the droplet healthy", cfg)).toMatchObject({ role: "ops", kind: "Domain" });
  });
  it("a mention with no topic is still Tony's (the step-(d) fallback)", () => {
    expect(resolve("refactor the dispatcher", cfg)).toMatchObject({ role: "general", kind: "Self" });
    expect(resolve("so I'm on my phone now hey tony what's up", cfg)).toMatchObject({ role: "general", kind: "Self" });
  });
  it.each([
    ["hey tony, check my self-tape availability", ""],
    ["ok jarvis, redo the color palette for the landing page", ""],
    ["so tony, is the droplet healthy", ""],
    ["yo tony check my calendar", ""],
    ["friday, check my wardrobe for the shoot", "Friday"],
    ["ask tony to check my self-tape availability", ""],
    ["tell the dispatcher about the wardrobe fitting", ""],
    ["have jarvis check the droplet", ""],
    ["let tony know my availability changed", ""],
    ["check my self-tape availability, tony", ""],
    ["is the droplet healthy tony please", ""],
    ["check my self-tape availability, friday", "Friday"],
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
    expect(resolve("hey tony, check my self-tape availability", cfg, "Tony", o)).toMatchObject({ role: "booking", kind: "Domain" });
    // Without it, the same line is Tony's; with it, no topic is still Self, a Named agent still Named.
    expect(resolve("I've been thinking about a warmer color palette for the landing page, tony", cfg, "Tony")).toMatchObject({ role: "general", kind: "Self" });
    expect(resolve("thanks tony", cfg, "Tony", o)).toMatchObject({ role: "general", kind: "Self" });
    expect(resolve("hey tony, ask the booking desk to check my availability", cfg, "Tony", o)).toMatchObject({ role: "booking", kind: "Named" });
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
    "Ops, turn off the weather alerts",
    "Booking, order an umbrella for the shoot",
  ])("not a live read: %s", (text) => {
    expect(directTool(text)).toBeNull();
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
      ["hey tony, tell my booking agent to check my last five WhatsApp messages", "booking", "check my last five WhatsApp messages"],
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
