import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/** The widget builder's checklist renders every point editable, and the Build button counts them. */
const h = vi.hoisted(() => ({ dispatch: "auto" as string }));
vi.mock("@/lib/native-ext", () => ({ xcmd: vi.fn() }));
vi.mock("./dispatch", () => ({ requestHubDispatch: vi.fn(), HubDispatchCancelled: class extends Error {} }));
vi.mock("@/features/reminders/notify", () => ({ useToasts: { getState: () => ({ push: vi.fn() }) } }));
vi.mock("@/stores/nav", () => ({ useNav: { getState: () => ({ go: vi.fn() }) } }));
vi.mock("@/features/modes/modes-store", () => ({
  useModes: Object.assign((sel: (s: unknown) => unknown) => sel({ effective: { dispatch: h.dispatch, name: "Builder", overridden: [] }, loaded: true }), { getState: () => ({ effective: {}, loaded: true }) }),
}));

import { BriefChecklistCard } from "./BriefChecklistCard";
import { briefPoints } from "./brief-points";

const FORTUNE = "Make me a fortune cookie widget: tap the cookie to crack it open, show a random fortune, a button for a new fortune, keep a history of the last 5 fortunes and show 6 lucky numbers";

describe("widget builder checklist", () => {
  it("shows every point to edit and builds them all", () => {
    const html = renderToStaticMarkup(<BriefChecklistCard text={FORTUNE} initial={briefPoints(FORTUNE)} onQuick={() => undefined} onClose={() => undefined} />);
    for (const p of briefPoints(FORTUNE).points) expect(html).toContain(`value="${p}"`);
    expect(html).toContain('value="Fortune cookie"');
    expect(html).toContain("Build it (5 points)");
    expect(html).toContain("Quick card instead");
  });

  it("a mode that builds nothing disables Build and says why", () => {
    h.dispatch = "surface_only";
    const html = renderToStaticMarkup(<BriefChecklistCard text={FORTUNE} initial={briefPoints(FORTUNE)} onQuick={() => undefined} onClose={() => undefined} />);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Build it/s);
    expect(html).toContain("builds nothing");
    h.dispatch = "auto";
  });
});
