import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { WrapItem } from "./session-types";
import * as D from "./destinations";
import { DESTINATIONS, DESTINATION_INFO, MEMORY_CATEGORIES, permittedDestinations, cardLabel, planSend } from "./destinations";

const item = (o: Partial<WrapItem> = {}): WrapItem => ({
  id: "w0123456789ab", kind: "idea", text: "A clock widget with an E46 face", quote: "a clock widget with an E46 face",
  speaker: "nic", t: 1, suggested: "play_place", dest: "play_place", status: "pending", ...o,
});

/** The gateway's own constants, read from command_center_api.py so the mirror can't drift. */
const api = readFileSync(fileURLToPath(new URL("../../../../command_center_api.py", import.meta.url)), "utf8");
const pyTuple = (name: string) => {
  const m = new RegExp(`^${name} = \\(([^)]*)\\)`, "m").exec(api);
  return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : null;
};

describe("destinations mirror the wrap-up endpoint", () => {
  it("same destinations and memory categories as WRAPUP_*", () => {
    expect(pyTuple("WRAPUP_DESTINATIONS")).toEqual([...DESTINATIONS]);
    expect(pyTuple("WRAPUP_MEMORY_CATEGORIES")).toEqual([...MEMORY_CATEGORIES]);
  });
  it("each destination has its store and label", () => {
    expect(DESTINATION_INFO.play_place.store).toBe("playplace");
    expect(DESTINATION_INFO.director.store).toBe("director_ideas");
    expect(DESTINATION_INFO.ledger.store).toBe("ideas"); // Ideas & Tasks, never Finance
    expect(DESTINATION_INFO.memory.store).toBe("memory_ref");
    expect(cardLabel("play_place")).toBe("Brainstorm wrap-up · Play Place");
    for (const d of DESTINATIONS) expect(cardLabel(d)).not.toMatch(/permission bridge/i);
  });
  it("every kind may go anywhere; memory only from Nic's words", () => {
    for (const kind of ["idea", "decision", "next_step"] as const) {
      expect(permittedDestinations(item({ kind }))).toEqual(["play_place", "director", "ledger", "memory"]);
      expect(permittedDestinations(item({ kind, speaker: "tony" }))).toEqual(["play_place", "director", "ledger"]);
    }
  });
});

describe("planSend", () => {
  it("plans one collection write with its source ref", () => {
    const r = planSend("n1", item({ dest: "ledger", kind: "next_step" }));
    expect(r).toEqual({
      ok: true,
      plan: { dest: "ledger", store: "ideas", title: "A clock widget with an E46 face", text: "A clock widget with an E46 face", quote: "a clock widget with an E46 face", kind: "next_step", source: { noteId: "n1", itemId: "w0123456789ab" } },
    });
    expect(planSend("n1", item({ dest: "director" }))).toMatchObject({ ok: true, plan: { store: "director_ideas" } });
  });
  it("memory is saved by reference only: no free text anywhere in the plan", () => {
    const r = planSend("n1", item({ dest: "memory", memoryCategory: "preference", text: "I always want dark mode" }));
    // Exactly the ref: no text and no client-chosen category (the desktop reads memoryCategory from the note item).
    expect(r).toEqual({ ok: true, plan: { dest: "memory", store: "memory_ref", ref: { noteId: "n1", itemId: "w0123456789ab" } } });
    expect(JSON.stringify(r)).not.toContain("dark mode");
    expect(JSON.stringify(r)).not.toContain("preference");
    const plan = planSend("n1", item({ dest: "memory", memoryCategory: "bogus" as never }));
    expect(plan.ok && Object.keys(plan.plan).sort()).toEqual(["dest", "ref", "store"]);
  });
  it("refuses memory for Tony's words, a missing destination, and decided items", () => {
    expect(planSend("n1", item({ dest: "memory", speaker: "tony" }))).toEqual({ ok: false, error: "not_allowed" });
    expect(planSend("n1", item({ dest: null }))).toEqual({ ok: false, error: "no_dest" });
    expect(planSend("n1", item({ dest: "finance" as never }))).toEqual({ ok: false, error: "no_dest" });
    for (const status of ["sending", "sent", "skipped"] as const) expect(planSend("n1", item({ status }))).toEqual({ ok: false, error: "not_pending" });
    expect(planSend("n1", item({ status: "failed" })).ok).toBe(true); // a retry of the one item
  });
  it("caps title and text, strips control characters", () => {
    const r = planSend("n1", item({ text: `x\u202e ${"word ".repeat(100)}` }));
    if (!r.ok || r.plan.dest === "memory") throw new Error("expected a collection plan");
    expect(r.plan.title.length).toBeLessThanOrEqual(80);
    expect(r.plan.text.length).toBeLessThanOrEqual(300);
    expect(r.plan.text).not.toContain("\u202e");
  });
  it("has no bulk export", () => {
    expect(Object.keys(D).filter((k) => /all|bulk|batch|every/i.test(k))).toEqual([]);
  });
});
