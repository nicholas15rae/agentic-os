import { describe, expect, it } from "vitest";
import { DEFAULT_ROUTING_CONFIG, directTool, isSelfRoleId, normalize, originalTail, resolve } from "./router";
import fixtures from "./router.fixtures.json";

interface Fixture {
  desc: string;
  text: string;
  role: string | null;
  kind: string;
  taskContains?: string;
  /** `directTool`'s answer; missing = null. */
  direct?: string;
}

describe("resolve (shared fixtures)", () => {
  const list = fixtures as Fixture[];
  it("has a decent fixture set", () => {
    expect(list.length).toBeGreaterThanOrEqual(10);
  });
  for (const f of list) {
    it(`${f.desc} — ${JSON.stringify(f.text)}`, () => {
      const r = resolve(f.text, DEFAULT_ROUTING_CONFIG);
      expect(r.role).toBe(f.role);
      expect(r.kind).toBe(f.kind);
      if (f.taskContains) expect(r.task).toContain(f.taskContains);
      expect(directTool(f.text)).toBe(f.direct ?? null);
    });
  }
});

describe("normalize", () => {
  it("fixes the three Whisper mangles", () => {
    expect(normalize("what's up")).toBe("whatsapp");
    expect(normalize("whats app")).toBe("whatsapp");
    expect(normalize("what sapp")).toBe("whatsapp");
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
    const r = resolve("schedule a reminder about my messages", DEFAULT_ROUTING_CONFIG);
    expect(r.role).toBe("booking");
    expect(r.kind).toBe("Domain");
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
