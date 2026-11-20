import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { headerSubtitle, lockedToggleStops, toggleAction } from "./voice-status";

describe("lockedToggleStops (mic locked off, fix pass)", () => {
  it("the hotkey / mic button can still stop Tony; from rest it never opens a listen", () => {
    for (const s of ["speaking", "holding", "thinking", "transcribing", "listening"] as const) expect(lockedToggleStops(s)).toBe(true);
    for (const s of ["idle", "error", "confirming"] as const) expect(lockedToggleStops(s)).toBe(false);
  });

  it("the desktop global hotkey's `mic-locked` event goes through the same toggle (not a bare toast)", () => {
    const src = readFileSync(fileURLToPath(new URL("./VoiceHUD.tsx", import.meta.url)), "utf8");
    expect(src).toMatch(/onNativeEvent\("mic-locked", launchToggle\)/);
  });
});

describe("toggleAction", () => {
  it("submits a listen only after speech was heard", () => {
    expect(toggleAction("listening", true)).toBe("submit");
    expect(toggleAction("listening", false)).toBe("hard-stop");
  });

  it("cancels a turn that is transcribing or thinking", () => {
    expect(toggleAction("transcribing", true)).toBe("hard-stop");
    expect(toggleAction("thinking", false)).toBe("hard-stop");
  });

  it("stops speech while speaking", () => {
    expect(toggleAction("speaking", false)).toBe("stop-voice");
    expect(toggleAction("speaking", true)).toBe("stop-voice");
    expect(toggleAction("holding", true)).toBe("stop-voice");
  });

  it("starts listening from rest", () => {
    for (const s of ["idle", "error", "confirming"] as const) expect(toggleAction(s, false)).toBe("start");
  });
});

describe("headerSubtitle", () => {
  it("swaps a trailing ACTIVE for the live status", () => {
    expect(headerSubtitle("TONY ACTIVE", true)).toEqual({ text: "TONY ACTIVE", chip: false });
    expect(headerSubtitle("TONY ACTIVE", false)).toEqual({ text: "TONY STANDBY", chip: false });
    // Phase 2 hold mode reads HOLDING in the same slot.
    expect(headerSubtitle("TONY ACTIVE", true, true)).toEqual({ text: "TONY HOLDING", chip: false });
  });

  it("matches ACTIVE case-insensitively and ignores trailing spaces", () => {
    expect(headerSubtitle("Jarvis active  ", false)).toEqual({ text: "Jarvis STANDBY", chip: false });
  });

  it("only matches ACTIVE as a whole final word", () => {
    expect(headerSubtitle("HYPERACTIVE", false)).toEqual({ text: "HYPERACTIVE", chip: true });
    expect(headerSubtitle("ACTIVE DUTY", true)).toEqual({ text: "ACTIVE DUTY", chip: true });
  });

  it("keeps a custom subtitle verbatim and asks for a state chip", () => {
    expect(headerSubtitle("ONLINE", true)).toEqual({ text: "ONLINE", chip: true });
    expect(headerSubtitle("", false)).toEqual({ text: "", chip: true });
  });
});
