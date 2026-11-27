// @vitest-environment node
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// SSR renders read a zustand store's initial state: plain stand-ins (as clock-effects-settings.test.tsx).
const h = vi.hoisted(() => ({ state: { osName: "Tony", wakeWords: ["hey tony"], fastPath: { builtins: true, userCues: false }, set: () => undefined } as Record<string, unknown> }));
vi.mock("@/stores/settings", () => ({
  useSettings: Object.assign((sel: (s: unknown) => unknown) => sel(h.state), { getState: () => h.state, subscribe: () => () => undefined }),
}));
vi.mock("@/features/os/os-store", () => ({ useOs: Object.assign((sel: (s: unknown) => unknown) => sel({ cfg: null }), { getState: () => ({ cfg: null }) }) }));

import { startupQueue } from "@/features/cues/startup";
import { FastCues, fastCueDoc } from "./FastCues";

describe("Settings → Voice & Triggers: fast cues", () => {
  it("a fast cue document is inert for the widget runtime (no phrases, no time, no startup, no OS action)", () => {
    const d = fastCueDoc({ phrase: "lock in", target: "reply", reply: "Locked in." });
    expect(d).toMatchObject({ enabled: true, phrases: [], time: "", startup: false, action: { kind: "none", value: "" }, soundbite: null, theme: null, fast: { phrase: "lock in", target: "reply" } });
    expect(startupQueue([{ ...d, id: "x", _created: 1, _updated: 1 } as never])).toEqual([]);
  });

  it("renders the switches (from settings), the built-in phrases and the saved fast cues; widgets are not listed", () => {
    const cues = [
      { id: "a", _created: 1, _updated: 1, ...fastCueDoc({ phrase: "my jam", target: "music.play" }) },
      { id: "w", _created: 1, _updated: 1, name: "Gabagool Mode", enabled: true, phrases: ["gabagool"], time: "", days: [], startup: false, intro: { mode: "static", text: "" }, soundbite: null, theme: null, action: { kind: "none", value: "" } },
    ] as never;
    const html = renderToStaticMarkup(createElement(FastCues, { cues, create: async () => undefined, update: async () => undefined, remove: async () => undefined }));
    expect(html).toContain("Instant cues");
    expect(html).toMatch(/<input type="checkbox" aria-label="Built-in instant cues"[^>]*checked=""/);
    expect(html).toMatch(/<input type="checkbox" aria-label="My fast cues"[^>]*>/);
    expect(html).not.toMatch(/<input type="checkbox" aria-label="My fast cues"[^>]*checked=""/);
    expect(html).toContain("what time is it");
    expect(html).toContain("“my jam”");
    expect(html).toContain("Start music (Spotify)");
    expect(html).not.toContain("Gabagool Mode");
    expect(html).toContain("Make this a fast cue");
  });
});
