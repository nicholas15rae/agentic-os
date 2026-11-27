import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer, OsConfig } from "@/lib/platform";
import type { CloudSyncRecord, CloudTransfer } from "@/features/cloud/contract";
import { resetModesForTests } from "@/features/modes/modes-store";
import { useOs } from "@/features/os/os-store";
import type { VerifiedRender } from "./contract";

const requestConfirmation = vi.fn(async () => undefined);
vi.mock("@/features/voice/voice-controller", () => ({ requestConfirmation }));
vi.mock("@/features/reminders/notify", () => ({ useToasts: { getState: () => ({ push: vi.fn() }) } }));

const { bizOpsCaption, bizOpsInstagramPlan, cleanHashtags, driveDirectUrl, driveShareFor, sendRenderToBizOps, sendToBizOps } = await import("./bizops");

const desktop = () => vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
const server = (id: string, agents: string[] | null) => ({ id, name: id, agents, enabled: true, transport: "builtin", builtin: true }) as unknown as McpServer;
const withCfg = (mcps: McpServer[], frozenTools: string[] = []) => useOs.setState({ cfg: { mcps, switchboard: { version: 1, frozenAgents: [], frozenTools } } as unknown as OsConfig });

const URL = driveDirectUrl("1AbC_d-9");
const render: VerifiedRender = { id: "r-2", project: "demo", planId: "p-1", path: "C:\\ai-hub\\media\\projects\\demo\\renders\\demo_v002.mp4", durationSec: 30, width: 1080, height: 1920, sizeBytes: 5, loudnessLufs: -14, verify: { ok: true, checks: [] }, createdAt: "t" };
const record = (p: Partial<CloudSyncRecord> = {}): CloudSyncRecord => ({ id: "s-1", provider: "gdrive", direction: "push", project: "demo", localPath: render.path, driveFileId: "1AbC_d-9", name: "demo_v002.mp4", sizeBytes: 5, webViewLink: null, at: "t", ...p }) as CloudSyncRecord;
const cloud = (p: Partial<{ history: CloudSyncRecord[]; transfers: Record<string, CloudTransfer>; pushByRender: Record<string, string>; sharedLinks: Record<string, string> }> = {}) => ({ history: [], transfers: {}, pushByRender: {}, sharedLinks: {}, ...p });

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  vi.unstubAllGlobals();
  resetModesForTests();
  useOs.setState({ cfg: null });
});

describe("caption + hashtags", () => {
  it("hashtags: # stripped, punctuation removed, duplicates (any case) dropped, ≤ 30", () => {
    expect(cleanHashtags(["#Dance", "dance", "hip hop", "##reel!", "", "#"])).toEqual(["Dance", "hiphop", "reel"]);
    expect(cleanHashtags(Array.from({ length: 40 }, (_, i) => `t${i}`))).toHaveLength(30);
  });
  it("one line, edge quotes trimmed, tags appended, ≤ 2200 characters", () => {
    expect(bizOpsCaption(' "Winter showcase!\n\nBook us" ', ["dance", "#toronto"])).toBe("Winter showcase! Book us #dance #toronto");
    expect(bizOpsCaption("", ["dance"])).toBe("#dance");
    expect(bizOpsCaption("x".repeat(2195), ["dance", "more"]).length).toBeLessThanOrEqual(2200);
  });
  it("Drive direct-download URL", () => {
    expect(URL).toBe("https://drive.google.com/uc?export=download&id=1AbC_d-9");
  });
});

describe("the Instagram ConfirmCard plan", () => {
  it("is the orchestrator's own mutating instagram.publish_post Reel plan for Biz Ops, with the exact caption", async () => {
    desktop();
    const r = await bizOpsInstagramPlan({ caption: "Winter showcase", hashtags: ["dance"], mediaUrl: URL });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan).toMatchObject({ role: "bizops", mutating: true, target: { kind: "tool", tool: "instagram.publish_post", args: { caption: "Winter showcase #dance", videoUrl: URL } } });
    expect(r.plan.readBack).toMatch(/publish a Reel to Instagram with the caption "Winter showcase #dance".*goes live.*Proceed\?$/);
  });

  it("sendToBizOps only RAISES the card (requestConfirmation); nothing is executed", async () => {
    desktop();
    const r = await sendToBizOps({ caption: "Showcase", hashtags: [], mediaUrl: URL });
    expect(r.ok).toBe(true);
    expect(requestConfirmation).toHaveBeenCalledTimes(1);
    expect(requestConfirmation).toHaveBeenCalledWith(expect.objectContaining({ target: expect.objectContaining({ tool: "instagram.publish_post" }) }), "text");
  });

  it("refused (no card) without https, off the desktop, when Instagram is frozen or another agent owns it", async () => {
    expect(await sendToBizOps({ caption: "x", hashtags: [], mediaUrl: "http://drive.google.com/x" })).toMatchObject({ ok: false, reason: expect.stringContaining("https") });
    expect(await sendToBizOps({ caption: "x", hashtags: [], mediaUrl: URL })).toMatchObject({ ok: false, reason: expect.stringContaining("desktop") });
    desktop();
    withCfg([server("instagram", null)], ["instagram"]);
    expect(await sendToBizOps({ caption: "x", hashtags: [], mediaUrl: URL })).toMatchObject({ ok: false, reason: expect.stringContaining("frozen") });
    withCfg([server("instagram", ["general"])]);
    expect(await sendToBizOps({ caption: "x", hashtags: [], mediaUrl: URL })).toMatchObject({ ok: false, reason: expect.stringMatching(/job/) });
    expect(requestConfirmation).not.toHaveBeenCalled();
  });

  it("a caption the card parser would change is refused rather than posted differently", async () => {
    desktop();
    expect(await sendToBizOps({ caption: ": leading colon", hashtags: [], mediaUrl: URL })).toMatchObject({ ok: false, reason: expect.stringContaining("caption") });
    expect(requestConfirmation).not.toHaveBeenCalled();
  });
});

describe("from a render's Drive share", () => {
  it("needs an upload AND a share link; uses the Drive file id", async () => {
    expect(driveShareFor(render, cloud())).toBeNull();
    // Uploaded but not shared: the upload's private webViewLink doesn't count.
    expect(driveShareFor(render, cloud({ history: [record()] }))).toBeNull();
    expect(driveShareFor(render, cloud({ history: [record({ webViewLink: "https://drive.google.com/file/d/1AbC_d-9/view" })] }))).toEqual({ driveFileId: "1AbC_d-9", shareLink: "https://drive.google.com/file/d/1AbC_d-9/view" });
    // A final copy's path matches too, and this session's share link wins.
    const final = { path: "C:\\ai-hub\\media\\projects\\demo\\renders\\final\\reels\\demo_v002.mp4" };
    expect(driveShareFor(render, cloud({ history: [record({ localPath: final.path })], sharedLinks: { "1AbC_d-9": "https://share" } }), final)).toEqual({ driveFileId: "1AbC_d-9", shareLink: "https://share" });
  });

  it("sendRenderToBizOps raises the card with the direct-download URL, or explains what's missing", async () => {
    desktop();
    expect(await sendRenderToBizOps(render, cloud(), { caption: "x", hashtags: [] })).toMatchObject({ ok: false, reason: expect.stringContaining("share link") });
    const r = await sendRenderToBizOps(render, cloud({ history: [record()], sharedLinks: { "1AbC_d-9": "https://share" } }), { caption: "Showcase", hashtags: ["dance"] });
    expect(r).toMatchObject({ ok: true, plan: { target: { args: { videoUrl: URL, caption: "Showcase #dance" } } } });
    expect(requestConfirmation).toHaveBeenCalledTimes(1);
  });
});
