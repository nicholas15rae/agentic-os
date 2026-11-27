import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { VerifiedRender } from "./contract";

vi.mock("@/stores/nav", () => ({ useNav: Object.assign(() => () => undefined, { getState: () => ({ go: () => undefined }) }) }));
vi.mock("@/features/reminders/notify", () => ({ useToasts: { getState: () => ({ push: vi.fn() }) } }));
vi.mock("./bizops", () => ({ sendRenderToBizOps: vi.fn() }));

const { VersionsView, RESTORE_CONFIRM, NO_SNAPSHOT_HINT } = await import("./VersionsPanel");
const { CompareView, compareRenders } = await import("./Compare");
const { versionRows } = await import("./versions");

const noop = () => undefined;
const render = (id: string, planId: string, v: number, createdAt: string): VerifiedRender => ({ id, project: "demo", planId, path: `C:\\p\\renders\\demo_v00${v}.mp4`, durationSec: 28, width: 1080, height: 1920, sizeBytes: 1_000_000, loudnessLufs: -14, verify: { ok: true, checks: [] }, createdAt });
const RENDERS = [render("r1", "p-1", 1, "2026-11-20T00:00:00Z"), render("r2", "p-2", 2, "2026-11-21T00:00:00Z"), render("r3", "p-3", 3, "2026-11-22T00:00:00Z")];
const rows = versionRows(RENDERS, new Set(["p-3"]));
const view = (p: Partial<Parameters<typeof VersionsView>[0]> = {}) =>
  renderToStaticMarkup(createElement(VersionsView, { rows, confirming: null, busy: null, diff: {}, expanded: null, compareA: null, onExpand: noop, onAskRestore: noop, onConfirmRestore: noop, onCancel: noop, onCompare: noop, ...p }));
const rowHtml = (h: string, id: string) => {
  const start = h.indexOf(`data-testid="version-${id}"`);
  const next = h.indexOf('data-testid="version-', start + 10);
  return h.slice(start, next < 0 ? undefined : next);
};

describe("VersionsView", () => {
  it("Restore is on every version, disabled on the one that is already the timeline's cut", () => {
    const h = view();
    expect(rowHtml(h, "r3")).toContain("Current");
    expect(rowHtml(h, "r3")).toMatch(/disabled=""[^>]*title="Already the timeline&#x27;s cut"/);
    expect(rowHtml(h, "r2")).toContain("Restore…");
    expect(rowHtml(h, "r2")).not.toContain("Already the timeline");
    expect(rowHtml(h, "r1")).toContain("Restore…");
    expect(h).toContain("v003");
    expect(h.match(/Compare</g)?.length).toBe(3);
  });

  it("asks before restoring, with the plain confirm text", () => {
    const h = view({ confirming: "r2" });
    expect(h).toContain('role="alertdialog"');
    expect(h).toContain(RESTORE_CONFIRM("v002").replace(/'/g, "&#x27;"));
    expect(h).toContain("Yes, restore");
  });

  it("a version made before snapshots can't be restored, and says why", () => {
    const h = rowHtml(view({ diff: { r1: "none" } }), "r1");
    expect(h).toMatch(/disabled=""[^>]*title="Made before versions were kept"/);
    expect(h).toContain(NO_SNAPSHOT_HINT);
  });

  it("shows the diff lines when expanded, and the Compare A pick", () => {
    const h = view({ expanded: "r2", diff: { r2: { same: false, lines: ["1 clip added (hop.mp4)", "length 0:28 → 0:31"] } }, compareA: "r1" });
    expect(h).toContain("Since v002");
    expect(h).toContain("1 clip added (hop.mp4)");
    expect(h).toContain("Comparing from v001: pick a second version.");
    expect(rowHtml(h, "r1")).toContain('aria-pressed="true"');
  });

  it("no renders: an empty line, no buttons", () => {
    const h = view({ rows: [] });
    expect(h).toContain("No versions yet");
    expect(h).not.toContain("<button");
  });
});

describe("CompareView", () => {
  const side = (r: VerifiedRender, label: string) => ({ render: r, src: `asset://${r.id}`, label });
  const cv = (p: Partial<Parameters<typeof CompareView>[0]> = {}) =>
    renderToStaticMarkup(createElement(CompareView, { a: side(RENDERS[1], "v002"), b: side(RENDERS[2], "v003"), mode: "side", wipe: 0.5, diff: null, onMode: noop, onWipe: noop, onClose: noop, ...p }));

  it("side by side: two videos, B muted, one play and one seek bar, no frame loop or infinite animation", () => {
    const h = cv();
    expect(h.match(/<video/g)?.length).toBe(2);
    expect(h).toMatch(/aria-selected="true"[^>]*>Audio A</);
    expect(h).toContain('aria-label="Play both"');
    expect(h).toContain('aria-label="Seek both"');
    expect(h).toContain("@xl:grid-cols-2"); // by the Compare card's width, not the viewport
    expect(h).not.toContain("Wipe position");
    expect(h).not.toContain("animate-");
  });

  it("wipe: B clipped by --wipe, a range drives it; diff lines under the videos", () => {
    const h = cv({ mode: "wipe", wipe: 0.25, diff: { same: false, lines: ["colour warm → film"] } });
    expect(h).toContain("--wipe:0.25");
    expect(h).toContain("clip-path:inset(0 0 0 calc(var(--wipe) * 100%))");
    expect(h).toContain('aria-label="Wipe position"');
    expect(h).toContain("v002 → v003");
    expect(h).toContain("colour warm → film");
  });

  it("compareRenders needs both renders", () => {
    expect(compareRenders({ compare: { a: "r1", b: "r2" }, renders: RENDERS })?.b.id).toBe("r2");
    expect(compareRenders({ compare: { a: "r1", b: "gone" }, renders: RENDERS })).toBeNull();
    expect(compareRenders({ compare: null, renders: RENDERS })).toBeNull();
  });
});
