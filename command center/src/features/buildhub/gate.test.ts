import { describe, expect, it } from "vitest";
import { MODE_NOT_AUTO, SOLO_REFUSAL_LINE } from "@/features/modes/modes";
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
  it("short mode names", () => {
    expect(shortModeName("Surface / Solo")).toBe("Solo");
    expect(shortModeName("Gabagool Mode")).toBe("Gabagool");
    expect(shortModeName("Deep Focus")).toBe("Deep Focus");
    expect(shortModeName("")).toBe("This");
  });
});

describe("hubRefusalText", () => {
  it("maps a Rust mode refusal to the calm line, never the raw code", () => {
    const t = hubRefusalText(new Error("MODE_SURFACE_ONLY: Solo mode builds nothing — switch modes to dispatch"));
    expect(t).toBe(SOLO_REFUSAL_LINE);
    expect(t).not.toContain("MODE_SURFACE_ONLY");
    expect(hubRefusalText(`${MODE_NOT_AUTO}: nothing was queued.`)).not.toContain(MODE_NOT_AUTO);
  });
  it("keeps any other refusal as written", () => {
    expect(hubRefusalText(new Error("“tip” is already staged"))).toBe("“tip” is already staged");
  });
});
