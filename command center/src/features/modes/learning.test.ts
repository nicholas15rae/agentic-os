import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CORE_QUESTION, learnedOf, learnedPillText, pendingMemoryOf, pillPathways, stripLearnTags } from "./learning";

describe("stripLearnTags", () => {
  it("removes complete tags and collapses the gap they leave", () => {
    expect(stripLearnTags("Got it.\n\n[[LEARN rule | x | y | confirmed]]\n\nStored.", true)).toBe("Got it.\n\nStored.");
    expect(stripLearnTags("ok [[learn: pref | a | b]] done", true)).toBe("ok  done");
  });

  it("holds back a tag that is still streaming, and nothing else", () => {
    expect(stripLearnTags("So when X, you want Y?\n[[LEA")).toBe("So when X, you want Y?\n");
    expect(stripLearnTags("Saved.\n[[LEARN rule | when deploying | run plan")).toBe("Saved.\n");
    expect(stripLearnTags("Saved. [")).toBe("Saved. ");
    expect(stripLearnTags("see [[wiki link")).toBe("see [[wiki link");
    expect(stripLearnTags("Saved. [", true)).toBe("Saved. [");
  });

  it("keeps the text before a tag stable while it streams in", () => {
    const full = "Locked in. [[LEARN rule | a | b | confirmed]] Anything else?";
    const before = "Locked in. ";
    for (let i = before.length; i <= full.length; i++) expect(stripLearnTags(full.slice(0, i)).startsWith(before)).toBe(true);
    expect(stripLearnTags(full)).toBe("Locked in.  Anything else?");
  });
});

describe("pills", () => {
  it("names what happened and skips already-known lessons", () => {
    const l = [
      { id: "1", title: "Use kebab-case", category: "rule", confidence: "confirmed", outcome: "saved" },
      { id: "2", title: "Ask indoor or patio", category: "preference", confidence: "provisional", outcome: "superseded" },
      { id: "3", title: "Old", category: "rule", confidence: "confirmed", outcome: "unchanged" },
    ];
    expect(pillPathways(l).map(learnedPillText)).toEqual(["Memory saved: Use kebab-case", "Memory updated: Ask indoor or patio (provisional)"]);
    expect(pillPathways(undefined)).toEqual([]);
  });

  it("a replaced core memory is named, and a Save that changed nothing never reads as a save", () => {
    const base = { id: "lp-1", title: "Send the report every Monday", category: "correction", confidence: "confirmed" };
    expect(learnedPillText({ ...base, outcome: "superseded", replaced: "When weekly report: send it every Friday" })).toBe("Memory updated: Send the report every Monday (replaced: When weekly report: send it every Friday)");
    expect(learnedPillText({ ...base, outcome: "unchanged" })).toBe("Already a core memory: Send the report every Monday");
    // learnedOf keeps `replaced` (a string) and drops anything else there.
    expect(learnedOf([{ ...base, outcome: "superseded", replaced: "old" }, { ...base, outcome: "saved", replaced: 3 }])).toEqual([
      { ...base, outcome: "superseded", replaced: "old" },
      { ...base, outcome: "saved" },
    ]);
  });
});

describe("core memory proposals (decision 5)", () => {
  const rs = readFileSync(resolve(__dirname, "../../../src-tauri/src/commands/learning.rs"), "utf8");

  it("CORE_QUESTION is the Rust constant, and the Learning protocol asks it", () => {
    expect(rs).toContain(`pub const CORE_QUESTION: &str = "${CORE_QUESTION}";`);
  });

  it("pendingMemoryOf keeps only well-formed rows with a valid id", () => {
    expect(pendingMemoryOf([{ id: "mem-1-2", category: "rule", text: "Call me Nic", extra: 1 }, { id: "a b", category: "rule", text: "x" }, { id: "m", category: "rule", text: "  " }, null, "x"])).toEqual([{ id: "mem-1-2", category: "rule", text: "Call me Nic" }]);
    expect(pendingMemoryOf(undefined)).toEqual([]);
    expect(pendingMemoryOf({ id: "mem-1" })).toEqual([]);
  });

  it("learnedOf keeps only well-formed rows", () => {
    const ok = { id: "lp-1", title: "Call me Nic", category: "persona", confidence: "confirmed", outcome: "saved" };
    expect(learnedOf([ok, { ...ok, title: 3 }, null])).toEqual([ok]);
    expect(learnedOf("nope")).toEqual([]);
  });
});
