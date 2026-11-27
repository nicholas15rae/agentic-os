import { describe, expect, it } from "vitest";
import type { ModeMirror } from "@/features/modes/modes";
import { applyOptimistic, type OsStatus } from "./hud-status";

const mode: ModeMirror = {
  id: "brainstorm",
  name: "Brainstorming",
  icon: "lightbulb",
  curiosity: "high",
  verbosity: "conversational",
  dispatch: "ask_before_dispatch",
  feedbackLevel: 1,
  overridden: [],
  list: [
    { id: "surface", name: "Surface / Solo", icon: "message-circle", isNovelty: false },
    { id: "brainstorm", name: "Brainstorming", icon: "lightbulb", isNovelty: false },
    { id: "executive", name: "Executive", icon: "briefcase", isNovelty: false },
    { id: "gabagool", name: "Gabagool Mode", icon: "x", isNovelty: true },
    { id: "focus", name: "Focus", icon: "flame", isNovelty: false },
  ],
};
const base: OsStatus = { computeMode: "local", privacy: { diffuser: true, networkLock: true, killSwitch: false }, mode, voice: { micEnabled: true, activationDb: -44 } };

describe("applyOptimistic (phone HUD)", () => {
  it("a mode switch takes the preset's dials and clears overrides", () => {
    const r = applyOptimistic({ ...base, mode: { ...mode, overridden: ["curiosity"] } }, { modeId: "executive" });
    expect(r.mode).toMatchObject({ id: "executive", name: "Executive", icon: "briefcase", curiosity: "low", verbosity: "terse", dispatch: "ask_before_dispatch", overridden: [] });
  });

  it("a custom mode keeps the old dials until the mirror confirms", () => {
    const r = applyOptimistic(base, { modeId: "focus" });
    expect(r.mode).toMatchObject({ id: "focus", name: "Focus", curiosity: "high" });
  });

  it("a custom mode never inherits the previous mode's auto_dispatch (fix pass)", () => {
    const builder = { ...base, mode: { ...mode, id: "builder", dispatch: "auto_dispatch" as const } };
    expect(applyOptimistic(builder, { modeId: "focus" }).mode?.dispatch).toBe("ask_before_dispatch");
  });

  it("the novelty never becomes the work mode, and an unknown id changes nothing", () => {
    expect(applyOptimistic(base, { modeId: "gabagool" }).mode).toEqual(mode);
    expect(applyOptimistic(base, { modeId: "nope" }).mode).toEqual(mode);
  });

  it("an override marks only the keys it set; reset restores the preset", () => {
    const o = applyOptimistic(base, { overrides: { curiosity: "low" } });
    expect(o.mode).toMatchObject({ curiosity: "low", dispatch: "ask_before_dispatch", overridden: ["curiosity"] });
    const r = applyOptimistic(o, { resetOverrides: true });
    expect(r.mode).toMatchObject({ curiosity: "high", overridden: [] });
  });

  it("locking the desktop mic and the old fields still work", () => {
    const r = applyOptimistic(base, { micEnabled: false, killSwitch: true, computeMode: "hybrid" });
    expect(r.voice).toEqual({ micEnabled: false, activationDb: -44 });
    expect(r.privacy.killSwitch).toBe(true);
    expect(r.computeMode).toBe("hybrid");
    expect(r.mode).toEqual(mode);
  });

  it("an older desktop without a mode mirror is left alone", () => {
    const old: OsStatus = { ...base, mode: undefined };
    expect(applyOptimistic(old, { modeId: "executive" }).mode).toBeUndefined();
  });
});
