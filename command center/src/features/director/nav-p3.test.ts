/** Director Suite Part 3 B (navigation): note markers, the projects board and the bin filters.
 * Pure helpers plus renderToStaticMarkup of each XxxView (same mocks as ui-v2.test.ts). */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Note, TimelineClip } from "./contract";
import { asset, gen, project } from "./fixtures.test-util";

vi.mock("@/stores/nav", () => ({ useNav: Object.assign(() => () => undefined, { getState: () => ({ go: () => undefined }) }) }));
vi.mock("@/features/reminders/notify", () => ({ useToasts: { getState: () => ({ push: vi.fn() }) } }));
vi.mock("./bizops", () => ({ sendRenderToBizOps: vi.fn() }));

const { noteMarkers, markerLeftPx } = await import("./review-ui");
const { NoteMarkersView, clipBoxWidth, clusterMarkers } = await import("./MiniTimeline");
const { ProjectsBoardView, StatusChipView, filterProjects, updatedAgo, STATUS_LABEL, NO_PROJECTS_FILTER } = await import("./ProjectsBoard");
const { BinFilterBarView, NO_BIN_FILTER, binFlagKinds, binTags, filterAssets } = await import("./StagingBin");

const noop = () => undefined;
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const clip = (id: string, assetId: string, inSec: number, outSec: number): TimelineClip => ({ id, assetId, inSec, outSec, fadeMs: 0 }) as TimelineClip;
const note = (id: string, p: Partial<Note> = {}): Note => ({ id, renderId: null, atSec: 1, text: `note ${id}`, by: "nic", viaVoice: false, resolved: false, at: "2026-11-27T00:00:00Z", ...p });

describe("noteMarkers", () => {
  const m = { clips: [clip("c1", "a1", 0, 4), clip("c2", "a2", 2, 8)] }; // 4 s + 6 s = 10 s
  const renders = [{ id: "r1", durationSec: 20 }];
  it("timeline notes by total, render notes by render length; sorted by x", () => {
    const out = noteMarkers([note("n2", { atSec: 6 }), note("n1", { atSec: 2.5, resolved: true }), note("n3", { renderId: "r1", atSec: 5 })], m, 10, renders);
    expect(out.map((x) => [x.id, x.x, x.onRender, x.resolved])).toEqual([
      ["n1", 0.25, false, true],
      ["n3", 0.25, true, false],
      ["n2", 0.6, false, false],
    ]);
    // Target = noteTarget: 6 s on the timeline is 2 s into clip 2 (in 2 s → 4 s of its asset).
    expect(out[2].target).toEqual({ sel: { kind: "clip", id: "c2" }, sec: 4 });
    expect(out[1].target).toEqual({ sel: { kind: "render", id: "r1" }, sec: 5 });
  });
  it("skips notes without atSec, an unknown render, or no clips; clamps x", () => {
    expect(noteMarkers([note("a", { atSec: null }), note("b", { renderId: "gone", atSec: 2 })], m, 10, renders)).toEqual([]);
    expect(noteMarkers([note("c", { atSec: 2 })], { clips: [] }, 0, [])).toEqual([]);
    const far = noteMarkers([note("d", { atSec: 50 }), note("e", { renderId: "r1", atSec: 99 })], m, 10, renders);
    expect(far.map((x) => x.x)).toEqual([1, 1]);
  });
});

describe("markerLeftPx", () => {
  const boxes = [
    { widthPx: 100, sec: 4 },
    { widthPx: 200, sec: 6 },
  ];
  it("maps timeline seconds onto the drawn clip boxes (with the gap)", () => {
    expect(markerLeftPx(0, boxes)).toBe(0);
    expect(markerLeftPx(0.2, boxes)).toBe(50); // 2 s: half of box 1
    expect(markerLeftPx(0.4, boxes)).toBe(100); // the end of box 1
    expect(markerLeftPx(0.7, boxes)).toBe(206); // 7 s: 3 s into box 2 → 106 + 100
    expect(markerLeftPx(1, boxes)).toBe(306);
    expect(markerLeftPx(2, boxes)).toBe(306); // clamped
    expect(markerLeftPx(0.5, [])).toBe(0);
  });
  it("uses the same widths the strip draws", () => {
    expect(clipBoxWidth({ inSec: 0, outSec: 0.1 }, 10)).toBe(72);
    expect(clipBoxWidth({ inSec: 0, outSec: 9 }, 10)).toBe(220);
    expect(clipBoxWidth({ inSec: 0, outSec: 2 }, 10)).toBe(128);
  });
});

describe("NoteMarkersView", () => {
  it("one button per marker: amber dot, hollow on a render, faded when resolved; null when empty", () => {
    const markers = noteMarkers([note("n1", { atSec: 2.5, text: "tighter here" }), note("n2", { atSec: 6, resolved: true }), note("n3", { renderId: "r1", atSec: 5 })], { clips: [clip("c1", "a1", 0, 10)] }, 10, [{ id: "r1", durationSec: 10 }]);
    const h = html(createElement(NoteMarkersView, { markers, onSeek: noop }));
    expect(h).toContain('aria-label="Note at 00:02.50: tighter here"');
    expect(h).toContain('aria-label="Note at 00:05.00 on the render: note n3"');
    expect(h).toContain("border border-amber bg-transparent");
    expect(h).toContain("opacity-40");
    expect(h).toContain("left:25%");
    expect(html(createElement(NoteMarkersView, { markers, onSeek: noop, leftPx: (x) => x * 100 }))).toContain("left:25px");
    expect(h).not.toContain("animate-");
    expect(html(createElement(NoteMarkersView, { markers: [], onSeek: noop }))).toBe("");
    expect(h).toContain("size-5"); // a 20 px hit target around the 8 px dot
  });
  it("notes that would overlap merge into one marker with a count", () => {
    const markers = noteMarkers([note("n1", { atSec: 2, text: "a" }), note("n2", { atSec: 2.05, text: "b" }), note("n3", { atSec: 8, text: "c" })], { clips: [clip("c1", "a1", 0, 10)] }, 10, []);
    const px = (x: number) => x * 300;
    expect(clusterMarkers(markers, px).map((c) => c.items.map((m) => m.id))).toEqual([["n1", "n2"], ["n3"]]);
    const h = html(createElement(NoteMarkersView, { markers, onSeek: noop, leftPx: px }));
    expect(h).toContain('aria-label="2 notes from 00:02.00: a; b"');
    expect(h).toContain('data-count="2"');
    expect(h.match(/<button/g)?.length).toBe(2);
  });
});

describe("projects board", () => {
  const ps = [
    project({ slug: "a", title: "Alpha reel", status: "editing", updatedAt: "2026-11-20T00:00:00Z" }),
    project({ slug: "b", title: "Beta teaser", status: "done", updatedAt: "2026-11-26T00:00:00Z" }),
    project({ slug: "gamma-cut", title: "Third", status: "editing", updatedAt: "2026-11-25T00:00:00Z" }),
  ];
  it("filterProjects: text on title or slug, statuses, newest first", () => {
    expect(filterProjects(ps, NO_PROJECTS_FILTER).map((p) => p.slug)).toEqual(["b", "gamma-cut", "a"]);
    expect(filterProjects(ps, { text: "GAMMA", statuses: [] }).map((p) => p.slug)).toEqual(["gamma-cut"]);
    expect(filterProjects(ps, { text: "", statuses: ["editing"] }).map((p) => p.slug)).toEqual(["gamma-cut", "a"]);
    expect(filterProjects(ps, { text: "beta", statuses: ["editing"] })).toEqual([]);
    expect(ps.map((p) => p.slug)).toEqual(["a", "b", "gamma-cut"]); // not mutated
  });
  it("updatedAgo", () => {
    const now = Date.parse("2026-11-27T12:00:00Z");
    expect(updatedAgo("2026-11-27T11:59:30Z", now)).toBe("just now");
    expect(updatedAgo("2026-11-27T11:55:00Z", now)).toBe("5m ago");
    expect(updatedAgo("2026-11-27T09:00:00Z", now)).toBe("3h ago");
    expect(updatedAgo("2026-11-24T12:00:00Z", now)).toBe("3d ago");
    expect(updatedAgo("2026-10-01T12:00:00Z", now)).toMatch(/Oct/);
    expect(updatedAgo("nope", now)).toBe("");
  });
  const view = (p: Partial<Parameters<typeof ProjectsBoardView>[0]> = {}) =>
    html(createElement(ProjectsBoardView, { projects: ps, loaded: true, layout: "board", filter: NO_PROJECTS_FILTER, busySlug: null, onLayout: noop, onFilter: noop, onOpen: noop, onStatus: noop, now: Date.parse("2026-11-27T00:00:00Z"), ...p }));
  it("board: five columns with counts, cards with a status chip", () => {
    const h = view();
    for (const s of Object.values(STATUS_LABEL)) expect(h).toContain(`aria-label="${s} column"`);
    expect(h).toMatch(/Editing<\/span><span class="font-mono fs-11 text-ink-3">2</);
    expect(h).toMatch(/Brief<\/span><span class="font-mono fs-11 text-ink-3">0</);
    expect(h).toContain('aria-label="Alpha reel status: Editing"');
    expect(h).toContain('aria-haspopup="menu"');
    expect(h).toContain("7d ago");
    expect(h).toContain('aria-pressed="true" class="pill-glass');
    expect(h).not.toContain("draggable");
  });
  it("list: one row per project; filtered columns; empty and loading states", () => {
    const list = view({ layout: "list" });
    expect(list).not.toContain(" column\"");
    expect(list.match(/aria-haspopup="menu"/g)).toHaveLength(3);
    const only = view({ filter: { text: "", statuses: ["done"] } });
    expect(only).toContain('aria-label="Done column"');
    expect(only).not.toContain('aria-label="Editing column"');
    expect(view({ filter: { text: "zzz", statuses: [] } })).toContain("No projects match.");
    expect(view({ projects: [] })).toContain("No projects yet.");
    expect(view({ loaded: false })).toContain("Loading…");
    expect(view({ busySlug: "a" })).toContain("Saving…");
  });
  it("StatusChipView: closed chip, busy chip is disabled", () => {
    const h = html(createElement(StatusChipView, { status: "review", busy: false, onChange: noop }));
    expect(h).toContain("Review");
    expect(h).toContain('aria-expanded="false"');
    expect(h).not.toContain('role="menu"');
    expect(html(createElement(StatusChipView, { status: "review", busy: true, onChange: noop }))).toMatch(/disabled=""/);
  });
});

describe("bin filters", () => {
  const flag = (kind: "blurry" | "dark") => ({ kind, detail: "" });
  const bin = [
    asset("a1", "video", { tags: ["hook", "wide"], flags: [flag("blurry")] }),
    asset("a2", "video", { tags: ["hook"] }),
    asset("a3", "image", { tags: ["wide", "hook"], generation: gen(), flags: [flag("dark")] }),
    asset("a4", "audio", {}),
  ];
  it("filterAssets: tag, any flag, a flag kind, generated only; keeps order", () => {
    expect(filterAssets(bin, NO_BIN_FILTER).map((a) => a.id)).toEqual(["a1", "a2", "a3", "a4"]);
    expect(filterAssets(bin, { ...NO_BIN_FILTER, tag: "wide" }).map((a) => a.id)).toEqual(["a1", "a3"]);
    expect(filterAssets(bin, { ...NO_BIN_FILTER, flag: "any" }).map((a) => a.id)).toEqual(["a1", "a3"]);
    expect(filterAssets(bin, { ...NO_BIN_FILTER, flag: "dark" }).map((a) => a.id)).toEqual(["a3"]);
    expect(filterAssets(bin, { ...NO_BIN_FILTER, generatedOnly: true }).map((a) => a.id)).toEqual(["a3"]);
    expect(filterAssets(bin, { tag: "hook", flag: "blurry", generatedOnly: true })).toEqual([]);
  });
  it("binTags most used first; binFlagKinds present only", () => {
    expect(binTags(bin)).toEqual(["hook", "wide"]);
    expect(binTags([])).toEqual([]);
    expect(binFlagKinds(bin)).toEqual(["blurry", "dark"]);
  });
  const bar = (p: Partial<Parameters<typeof BinFilterBarView>[0]> = {}) => html(createElement(BinFilterBarView, { filter: NO_BIN_FILTER, tags: ["hook", "wide"], flagKinds: ["blurry"], shown: 4, total: 4, onChange: noop, ...p }));
  it("BinFilterBarView: selects + Generated; Showing … · Clear only while on; hidden for small bins", () => {
    const h = bar();
    for (const s of ['aria-label="Filter by tag"', 'aria-label="Filter by flag"', "All tags", "Any flag", "blurry", 'aria-pressed="false"', "Generated"]) expect(h).toContain(s);
    expect(h).not.toContain("Showing");
    const on = bar({ filter: { ...NO_BIN_FILTER, generatedOnly: true }, shown: 1, total: 12 });
    expect(on).toContain("Showing 1 of 12");
    expect(on).toContain("Clear");
    expect(on).toContain('aria-pressed="true"');
    expect(bar({ total: 3, shown: 3 })).toBe("");
    expect(bar({ total: 3, shown: 1, filter: { ...NO_BIN_FILTER, tag: "hook" } })).toContain("Showing 1 of 3");
    expect(bar({ tags: [], flagKinds: [] })).not.toContain("Filter by tag");
  });
});

