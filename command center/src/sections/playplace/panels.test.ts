import { describe, expect, it, vi } from "vitest";

vi.mock("@/sections/PlayPlaceSection", () => ({ PipelineBars: () => null, PlayCards: () => null, IdeasLedger: () => null }));
vi.mock("@/features/buildhub/StagingHub", () => ({ StagingHub: () => null }));

import { PLAYPLACE, PLAYPLACE_DEFAULT, PLAYPLACE_DEFAULT_DESKTOP, PLAYPLACE_DEFAULT_WEB, PLAYPLACE_PANELS, usePlayPlaceLayout } from "./panels";
import { availableWidgets, getWidget } from "@/core/widgets/registry";
import { fits } from "@/core/widgets/pages";

describe("Play Place on the shared layout", () => {
  it("every panel is registered for the Play Place only, as a scrolling page panel", () => {
    for (const p of PLAYPLACE_PANELS) expect(getWidget(p.id)).toMatchObject({ surfaces: [PLAYPLACE], panel: true });
    // This test runs as the browser build: the desktop-only staging hub isn't offered there.
    expect(availableWidgets(PLAYPLACE).map((d) => d.id).sort()).toEqual(PLAYPLACE_PANELS.filter((p) => !p.platforms).map((p) => p.id).sort());
    expect(availableWidgets().some((d) => d.surfaces?.includes(PLAYPLACE))).toBe(false);
  });

  it("both default layouts fill the board with no overlaps, each panel once (web: no staging hub)", () => {
    for (const d of [PLAYPLACE_DEFAULT_DESKTOP, PLAYPLACE_DEFAULT_WEB]) {
      for (const i of d) expect(fits(d, i)).toBe(true);
      expect(d.reduce((a, i) => a + i.w * i.h, 0)).toBe(12 * 8);
      expect(new Set(d.map((i) => i.widgetId)).size).toBe(d.length);
    }
    expect(PLAYPLACE_DEFAULT_DESKTOP).toHaveLength(PLAYPLACE_PANELS.length);
    expect(PLAYPLACE_DEFAULT_WEB.some((i) => i.widgetId === "pp-staging-hub")).toBe(false);
  });

  it("adding a panel to a full page is refused, never a hidden second page", () => {
    const s = usePlayPlaceLayout.getState();
    s.resetAll();
    const r = usePlayPlaceLayout.getState().add("pp-play-cards", undefined, { noNewPage: true });
    expect(r.ok).toBe(false);
    expect(usePlayPlaceLayout.getState().pages).toHaveLength(1);
  });

  it("the page's store is its own surface, and Reset brings the finished template back", () => {
    const s = usePlayPlaceLayout.getState();
    expect(s.surface).toBe(PLAYPLACE);
    s.remove("play-cards");
    usePlayPlaceLayout.getState().reset();
    expect(usePlayPlaceLayout.getState().pages[0].items.map((i) => i.instanceId).sort()).toEqual(PLAYPLACE_DEFAULT.map((i) => i.instanceId).sort());
  });
});
