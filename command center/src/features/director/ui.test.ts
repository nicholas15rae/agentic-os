import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ASSETS, IMG, V1, manifest, project } from "./fixtures.test-util";

vi.mock("@/stores/nav", () => ({ useNav: Object.assign(() => () => undefined, { getState: () => ({ go: () => undefined }) }) }));
vi.mock("@/features/bridge/gate", () => ({ gated: vi.fn() }));
vi.mock("@/features/reminders/notify", () => ({ useToasts: { getState: () => ({ push: vi.fn() }) } }));

const { EmptyStateView, DesktopOnlyView, GREETING } = await import("./EmptyState");
const { RenderPlanView } = await import("./RenderPlanCard");
const { readinessPill } = await import("./StudioBar");
const { previewSource } = await import("./PreviewPlayer");
const { chatHistory, directorRequest } = await import("./director-chat");
const { buildDirectorContext } = await import("./context");
const { addClip } = await import("./manifest");

const noop = () => undefined;

describe("Director Suite empty state", () => {
  it("greets Nic with the four quick starts and recent projects", () => {
    const html = renderToStaticMarkup(createElement(EmptyStateView, { projects: [project({ title: "Old teaser" })], loaded: true, onQuickStart: async () => undefined, onOpen: noop }));
    expect(html).toContain(GREETING);
    expect(GREETING).toBe("Hey Nic, what do you want to create today?");
    for (const q of ["New Video Edit", "Plan a Video / Channel Series", "Photo &amp; Visual Staging", "Quick Stitch + Slate"]) expect(html).toContain(q);
    expect(html).toContain("Old teaser");
  });
  it("no projects yet", () => {
    const html = renderToStaticMarkup(createElement(EmptyStateView, { projects: [], loaded: true, onQuickStart: async () => undefined, onOpen: noop }));
    expect(html).toContain("No projects yet.");
  });
  it("off the desktop: one card", () => {
    expect(renderToStaticMarkup(createElement(DesktopOnlyView))).toContain("Director Suite runs on the desktop app");
  });
});

describe("Render Plan card", () => {
  const plan = { planId: "p-1", project: "demo", manifestRevision: 4, sources: [{ assetId: "a-v1", name: "a.mp4", inSec: 1, outSec: 4.5 }], audio: [{ assetId: "a-mus", name: "song.mp3", startSec: 0, volume: 0.8 }], outputName: "demo", outputSpec: "1920×1080 · H.264/AAC · −18 LUFS", renderMode: "cpu_only" as const, proposedBy: "director" as const };
  it("shows sources, audio, output, cpu_only and the two buttons", () => {
    const html = renderToStaticMarkup(createElement(RenderPlanView, { plan, busy: false, renderReady: true, onApprove: noop, onModify: noop }));
    expect(html).toContain("a.mp4");
    expect(html).toContain("00:01.00–00:04.50");
    expect(html).toContain("song.mp3");
    expect(html).toContain("render_mode: cpu_only");
    expect(html).toContain("Approve &amp; Render");
    expect(html).toContain("Modify Plan");
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>.*Approve/);
  });
  it("Approve is disabled until media-forge is green", () => {
    const html = renderToStaticMarkup(createElement(RenderPlanView, { plan, busy: false, renderReady: false, onApprove: noop, onModify: noop }));
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Approve/);
    expect(html).toContain("Rendering is off until media-forge is green.");
  });
});

describe("readiness pill", () => {
  const ok = { enabled: true, healthy: true, tools: 4, error: null };
  it("green / amber names the off server / red shows the error", () => {
    expect(readinessPill({ shotcut: ok, mediaForge: ok, ffmpegFound: true }, null)).toMatchObject({ tone: "green", label: "MCP ready · Shotcut + MediaForge" });
    expect(readinessPill({ shotcut: ok, mediaForge: ok, ffmpegFound: true }, null).detail).toMatch(/^8 tools listed \(Shotcut 4, MediaForge 4\)/);
    expect(readinessPill({ shotcut: { ...ok, enabled: false, tools: 0 }, mediaForge: ok, ffmpegFound: true }, null)).toMatchObject({ tone: "amber", label: "shotcut off" });
    expect(readinessPill({ shotcut: ok, mediaForge: { ...ok, healthy: false, error: "spawn failed" }, ffmpegFound: true }, null)).toMatchObject({ tone: "red", detail: "spawn failed" });
    expect(readinessPill({ shotcut: ok, mediaForge: ok, ffmpegFound: false }, null)).toMatchObject({ tone: "amber" });
    expect(readinessPill(null, "not registered")).toMatchObject({ tone: "red" });
    expect(readinessPill(null, null).tone).toBe("unknown");
  });
});

describe("preview source", () => {
  const m = addClip(addClip(manifest(), V1), IMG);
  const base = { assets: ASSETS, manifest: m, renders: [], previewMode: "working" as const, selection: null };
  it("working: selected asset, else selected clip (with its timeline start), else the first clip", () => {
    expect(previewSource({ ...base, selection: { kind: "asset", id: "a-mus" } })).toMatchObject({ kind: "asset", asset: { id: "a-mus" } });
    expect(previewSource({ ...base, selection: { kind: "clip", id: m.clips[1].id } })).toMatchObject({ kind: "clip", clipStart: 10, asset: { id: "a-img" } });
    expect(previewSource(base)).toMatchObject({ kind: "clip", clipStart: 0 });
    expect(previewSource({ ...base, manifest: manifest() })).toBeNull();
  });
  it("final: selected render, else the latest; none → null", () => {
    const r = (id: string) => ({ id, project: "demo", planId: "p", path: `C:\\r\\${id}.mp4`, durationSec: 1, width: 1, height: 1, sizeBytes: 1, loudnessLufs: null, verify: { ok: true as const, checks: [] }, createdAt: "t" });
    expect(previewSource({ ...base, previewMode: "final" })).toBeNull();
    expect(previewSource({ ...base, previewMode: "final", renders: [r("new"), r("old")] })).toMatchObject({ kind: "render", render: { id: "new" } });
    expect(previewSource({ ...base, previewMode: "final", renders: [r("new"), r("old")], selection: { kind: "render", id: "old" } })).toMatchObject({ render: { id: "old" } });
  });
});

describe("director chat request", () => {
  it("history = last 10 finished turns as user/assistant", () => {
    const chat = Array.from({ length: 14 }, (_, i) => ({ id: String(i), role: (i % 2 ? "director" : "nic") as "nic" | "director", text: `m${i}`, at: "t" }));
    chat.push({ id: "live", role: "director", text: "partial", at: "t", streaming: true } as (typeof chat)[number]);
    const h = chatHistory(chat);
    expect(h).toHaveLength(10);
    expect(h[0]).toEqual({ role: "user", content: "m4" });
    expect(h[9]).toEqual({ role: "assistant", content: "m13" });
  });
  it("the director_turn request carries the line, history, context and stream id only (no Tony routing)", () => {
    expect(directorRequest("hi", [{ role: "user", content: "a" }, { role: "assistant", content: "b" }], "ctx", "sid")).toEqual({ text: "hi", history: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }], context: "ctx", streamId: "sid" });
    const r = directorRequest("hi", [], "ctx", "sid") as unknown as Record<string, unknown>;
    for (const k of ["role", "explicit", "routeKind", "noDelegate", "askCards"]) expect(r[k]).toBeUndefined();
  });
  it("context carries the project, assets, the manifest and the action contract", () => {
    const c = buildDirectorContext(project({ source: { from: "brainstorm", refId: "n1", brief: "30s teaser" } }), ASSETS, manifest());
    expect(c).toContain("PROJECT: Demo (slug demo) · status editing");
    expect(c).toContain("Brief (from brainstorm): 30s teaser");
    expect(c).toContain("a-v1 · a-v1.mp4 · video · role clip · 10s · 1920×1080");
    expect(c).toContain('"revision":3');
    expect(c).toContain("```director-action");
    expect(c).toMatch(/Never claim a render ran/);
    expect(c).toMatch(/CPU-only/);
  });
});
