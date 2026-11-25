import { describe, expect, it } from "vitest";
import { originalBuiltin, startupQueue } from "./startup";
import type { CueWidget } from "./types";

type C = CueWidget & { id: string; _created: number; _deleted?: boolean };
const cue = (id: string, created: number, over: Partial<C> = {}): C =>
  ({ id, _created: created, name: id, enabled: true, startup: false, phrases: [], time: "", days: [], theme: null, soundbite: null, intro: { mode: "static", text: "" }, action: { kind: "none", value: "" }, ...over }) as unknown as C;

describe("built-in cue duplicates", () => {
  // The real state found on the gateway: the original (with theme music) and music-less re-seeds.
  const original = cue("orig", 100, { builtin: "startup", startup: true, theme: { fileId: "f1" } as C["theme"] });
  const reseedA = cue("reseedA", 500, { builtin: "startup", startup: true });
  const reseedB = cue("reseedB", 900, { builtin: "startup", startup: true });
  const gabOriginal = cue("gab", 100, { builtin: "gabagool", theme: { fileId: "f2" } as C["theme"] });
  const gabCopy = cue("gabCopy", 900, { builtin: "gabagool" });
  const custom = cue("mine", 300, { startup: true });
  const newestFirst = [reseedB, gabCopy, reseedA, custom, original, gabOriginal];

  it("originalBuiltin picks the oldest live copy (the one with the user's music)", () => {
    expect(originalBuiltin(newestFirst, "startup")?.id).toBe("orig");
    expect(originalBuiltin(newestFirst, "gabagool")?.id).toBe("gab");
    expect(originalBuiltin([{ ...original, _deleted: true }, reseedA], "startup")?.id).toBe("reseedA");
    expect(originalBuiltin([custom], "startup")).toBeUndefined();
  });

  it("startupQueue plays the original welcome once, then the user's own startup cues", () => {
    expect(startupQueue(newestFirst).map((c) => c.id)).toEqual(["orig", "mine"]);
    // A disabled original isn't replaced by a copy.
    expect(startupQueue([reseedB, { ...original, enabled: false }, custom]).map((c) => c.id)).toEqual(["mine"]);
  });
});
