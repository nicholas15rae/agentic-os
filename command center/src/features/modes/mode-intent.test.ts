import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MODE_ALIASES, parseModeSwitch } from "./mode-intent";

describe("parseModeSwitch", () => {
  it.each([
    ["go into builder mode", "builder"],
    ["Go into coach mode", "coach"],
    ["go into solo mode", "surface"],
    ["go into brainstorming mode", "brainstorm"],
    ["go into executive mode", "executive"],
    ["go into learning mode", "learning"],
    ["switch to surface mode", "surface"],
    ["surface solo mode", "surface"],
    ["go solo", "surface"],
    ["build mode", "builder"],
    ["building mode", "builder"],
    ["coaching mode", "coach"],
    ["motivation mode", "coach"],
    ["motivational mode please", "coach"],
    ["brainstorm mode", "brainstorm"],
    ["exec mode", "executive"],
    ["learn mode", "learning"],
    ["study mode", "learning"],
    ["hey Tony, builder mode", "builder"],
    ["Tony switch over to exec mode.", "executive"],
    ["can you put yourself in coaching mode", "coach"],
    ["set mode to learning mode", "learning"],
    ["activate brainstorm mode!", "brainstorm"],
    ["change to executive mode", "executive"],
    ["operations mode", "operations"],
    ["ops mode", "operations"],
    ["go into ops mode", "operations"],
    ["hey Tony, switch to operations mode", "operations"],
    ["Ops mode please", "operations"],
    ["operational mode", "operations"],
    ["switch to business operations mode", "operations"],
  ])("%s → %s (pure switch)", (line, mode) => {
    expect(parseModeSwitch(line)).toEqual({ mode, rest: "" });
  });

  it("splits a compound command and keeps the instruction's casing", () => {
    expect(parseModeSwitch("Go into builder mode and check the Staging Hub")).toEqual({ mode: "builder", rest: "check the Staging Hub" });
    expect(parseModeSwitch("hey tony, exec mode, then give me the week's priorities")).toEqual({ mode: "executive", rest: "give me the week's priorities" });
    expect(parseModeSwitch("go solo and just talk to me")).toEqual({ mode: "surface", rest: "just talk to me" });
    expect(parseModeSwitch("go into ops mode and check the Invoices")).toEqual({ mode: "operations", rest: "check the Invoices" });
  });

  it("'ops' / 'operations' without 'mode' never switch (they are Ops / Biz Ops routing names)", () => {
    for (const line of ["ops, check the invoices", "ops", "operations", "tell ops to call the supplier", "check operations for the contracting business", "go into operations", "switch to ops", "ops mode is weird today"]) {
      expect(parseModeSwitch(line), line).toBeNull();
    }
  });

  it("never fires on talk about a mode or on other mode words", () => {
    for (const line of [
      "what does builder mode do?",
      "builder mode is slow today",
      "I liked coaching mode yesterday",
      "turn on gabagool mode",
      "gabagool mode off",
      "go into local mode",
      "switch to hybrid mode",
      "the executive summary",
      "build me a weather widget",
      "",
    ]) {
      expect(parseModeSwitch(line), line).toBeNull();
    }
  });

  it("every TS work mode resolves in Rust too (resolve_work_mode / tony.set_mode)", () => {
    const rs = readFileSync(resolve(__dirname, "../../../src-tauri/src/commands/modes.rs"), "utf8");
    const body = rs.slice(rs.indexOf("pub fn resolve_work_mode("), rs.indexOf("pub fn set_mode_by_tool("));
    for (const id of new Set(Object.values(MODE_ALIASES))) expect(body, id).toContain(`("${id}", &[`);
    expect(body).toMatch(/\("operations", &\[[^\]]*"ops"/);
  });

  it("uses the configured OS name as the wake word", () => {
    expect(parseModeSwitch("Jarvis, builder mode", "Jarvis")).toEqual({ mode: "builder", rest: "" });
  });
});
