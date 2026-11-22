import { describe, expect, it } from "vitest";
import { learnedPillText, pillPathways, stripLearnTags } from "./learning";

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
});
