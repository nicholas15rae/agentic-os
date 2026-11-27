import { describe, expect, it } from "vitest";
import { effectiveOf, MODE_NOT_AUTO, PRESET_MODES, SOLO_REFUSAL_LINE } from "@/features/modes/modes";
import { hubRefusalText, shortModeName, stageBlocker } from "./gate";

describe("stageBlocker (the mode gate, before the card)", () => {
  // Nic's active mode was "coach" (surface_only): every Dispatch raised a card whose yes Rust
  // refused with MODE_SURFACE_ONLY — the gate now says so before any card.
  it("a loaded surface_only mode blocks with a calm line naming the mode and the way out", () => {
    const line = stageBlocker({ dispatch: "surface_only", name: "Motivation / Coach" }, true);
    expect(line).toBe("Coach mode builds nothing — switch to Brainstorming or Builder to stage this.");
    expect(line).not.toMatch(/MODE_|timed out/);
  });
  it("modes that can dispatch never block", () => {
    expect(stageBlocker({ dispatch: "ask_before_dispatch", name: "Brainstorming" }, true)).toBeNull();
    expect(stageBlocker({ dispatch: "auto_dispatch", name: "Builder" }, true)).toBeNull();
  });
  it("an unloaded mode store never blocks (Rust stays authoritative)", () => {
    expect(stageBlocker({ dispatch: "surface_only", name: "Surface / Solo" }, false)).toBeNull();
  });
  // A Mode Panel "Tony mode dispatch" override to Solo under Brainstorming / Builder: the way out
  // is resetting the override (Rust clears overrides on a mode switch), never "switch to
  // Brainstorming" while Brainstorming is already the mode (r17 review).
  it("a Solo dispatch override names the override and the reset, not a switch to the current mode", () => {
    for (const id of ["brainstorm", "builder"]) {
      const eff = effectiveOf(PRESET_MODES, id, { dispatch: "surface_only" });
      expect(eff.overridden).toContain("dispatch");
      const line = stageBlocker(eff, true)!;
      expect(line).toBe("Dispatch is set to Solo for now — set it back (or reset) in the Mode Panel to stage this.");
      expect(line).not.toMatch(/switch to/i);
    }
  });
  it("never suggests switching to the mode already active", () => {
    // A custom surface_only mode that happens to share a target's name.
    expect(stageBlocker({ dispatch: "surface_only", name: "Builder" }, true)).toBe("Builder mode builds nothing — switch to Brainstorming to stage this.");
    expect(stageBlocker({ dispatch: "surface_only", name: "Brainstorming" }, true)).toBe("Brainstorming mode builds nothing — switch to Builder to stage this.");
    // An override of something else leaves the mode-name line.
    expect(stageBlocker({ dispatch: "surface_only", name: "Motivation / Coach", overridden: ["verbosity"] }, true)).toBe("Coach mode builds nothing — switch to Brainstorming or Builder to stage this.");
  });
  it("short mode names", () => {
    expect(shortModeName("Surface / Solo")).toBe("Solo");
    expect(shortModeName("Gabagool Mode")).toBe("Gabagool");
    expect(shortModeName("Deep Focus")).toBe("Deep Focus");
    expect(shortModeName("")).toBe("This");
  });
});

describe("hubRefusalText", () => {
  const RUST = "MODE_SURFACE_ONLY: Solo mode builds nothing — switch modes to dispatch";
  it("maps a Rust mode refusal to a calm line, never the raw code", () => {
    const t = hubRefusalText(new Error(RUST));
    expect(t).not.toContain("MODE_SURFACE_ONLY");
    expect(hubRefusalText(`${MODE_NOT_AUTO}: nothing was queued.`)).not.toContain(MODE_NOT_AUTO);
  });
  // Rust's message always says "Solo"; under Coach the modal named the wrong mode and offered a
  // park action it doesn't have (r17 review). Tony's spoken path keeps SOLO_REFUSAL_LINE.
  it("names the mode in force for a MODE_SURFACE_ONLY refusal and never offers to park", () => {
    const coach = effectiveOf(PRESET_MODES, "coach");
    const t = hubRefusalText(new Error(RUST), coach, true);
    expect(t).toBe("Coach mode builds nothing, so nothing was queued — your answers are still here. Switch to Brainstorming or Builder to stage this.");
    expect(t).not.toMatch(/Solo|park/i);
    expect(t).not.toBe(SOLO_REFUSAL_LINE);
  });
  it("a Solo dispatch override is named as the override", () => {
    const t = hubRefusalText(RUST, effectiveOf(PRESET_MODES, "brainstorm", { dispatch: "surface_only" }), true);
    expect(t).toBe("Dispatch is set to Solo for now, so nothing was queued — your answers are still here. Set it back (or reset) in the Mode Panel to stage this.");
  });
  it("an unloaded store (or a mode that can dispatch by now) gets a mode-neutral line", () => {
    const neutral = "The current Tony mode builds nothing, so nothing was queued — your answers are still here. Switch to Brainstorming or Builder to stage this.";
    expect(hubRefusalText(RUST, effectiveOf(PRESET_MODES, "coach"), false)).toBe(neutral);
    expect(hubRefusalText(RUST)).toBe(neutral);
    expect(hubRefusalText(RUST, effectiveOf(PRESET_MODES, "builder"), true)).toBe(neutral);
    expect(hubRefusalText(RUST, null, true)).not.toMatch(/park|Solo mode is on/);
  });
  it("keeps any other refusal as written", () => {
    expect(hubRefusalText(new Error("“tip” is already staged"))).toBe("“tip” is already staged");
  });
});
