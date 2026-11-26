import { describe, expect, it } from "vitest";
import { BUILTIN_MODE_IDS, EXECUTIVE_SWITCHBOARD, OPERATIONS_SWITCHBOARD, PRESET_MODES, effectiveOf, frozenToolReason, toolLive } from "./modes";

/** A2 review: Google Calendar mirrors Gmail in every preset (modes.rs `OPERATIONS_TOOLS` / `EXECUTIVE_TOOLS`). */
describe("Google Calendar follows Gmail in the mode switchboard", () => {
  it("is live wherever Gmail is, and frozen wherever Gmail is", () => {
    for (const id of BUILTIN_MODE_IDS) {
      const e = effectiveOf(PRESET_MODES, id);
      expect(toolLive(e, "calendar"), id).toBe(toolLive(e, "gmail"));
      expect(!!frozenToolReason(e, "calendar"), id).toBe(!!frozenToolReason(e, "gmail"));
    }
  });

  it("Operations and Executive carry it right after Gmail; Builder and Learning keep it frozen", () => {
    expect(OPERATIONS_SWITCHBOARD.tools).toEqual(["gmail", "calendar", "whatsapp", "knowledge-graph", "filesystem", "maps", "fetch", "time", "weather", "instagram"]);
    expect(EXECUTIVE_SWITCHBOARD.tools).toEqual(["knowledge-graph", "gmail", "calendar", "brave-search", "time", "weather"]);
    expect(toolLive(effectiveOf(PRESET_MODES, "builder"), "calendar")).toBe(false);
    expect(toolLive(effectiveOf(PRESET_MODES, "learning"), "calendar")).toBe(false);
    expect(frozenToolReason(effectiveOf(PRESET_MODES, "builder"), "calendar", null, "Google Calendar")).toBe("Google Calendar is frozen in Builder mode");
  });
});
