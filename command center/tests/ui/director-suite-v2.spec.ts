/**
 * Director Suite v2 panels against a faked desktop bridge (`__TAURI_INTERNALS__`, the same pattern as
 * agent-voices.spec.ts): the brief with its guessed chips and Nic's approval, the shot list's filmed
 * tick and phone view, the inbox status line, the review round with the Director's summary, the output
 * presets, and "Approve final" behind its confirm. Every other native command is refused, so nothing
 * real is touched (no render, no post, no file copy). Desktop project only.
 */
import { expect, test, type Page } from "@playwright/test";

const T = "2026-11-26T00:00:00Z";
const slot = (id: string, label: string, p: Record<string, unknown> = {}) => ({ id, label, instructions: "", kind: "video", targetSec: null, assetId: null, status: "needed", framing: "closeup", action: "Look up", source: "film", phoneTips: ["lock exposure"], filmed: false, ...p });
const project = {
  slug: "demo", title: "Demo reel", status: "review", root: "C:\\ai-hub\\media\\projects\\demo", createdAt: T, updatedAt: T,
  source: { from: "suite", refId: null, brief: null }, speed: "rough",
  brief: { idea: "Dance reel for the showcase", goal: "get booked", platform: "reels", lengthSec: 30, aspect: "9:16", tone: "warm", references: [], guessed: ["tone"], approved: false, updatedBy: "director", updatedAt: T },
};
const manifest = {
  version: 2, project: "demo", revision: 3, clips: [], audio: [], clipAudioVolume: 1,
  output: { aspect: "9:16", loudnessLufs: -14, maxSizeMb: null, name: "demo" },
  shotList: [slot("s1", "Hook"), slot("s2", "Spin", { framing: "wide" })], updatedBy: "nic", updatedAt: T,
  captions: { enabled: false, style: "clean", position: "lower", maxWordsPerLine: 4 }, color: { preset: "none", strength: 0.5 },
  outputs: [{ platform: "reels", aspect: "9:16", loudnessLufs: -14, maxSizeMb: null, maxSec: 90 }],
  notes: [{ id: "n-1", renderId: "r-1", atSec: 2.5, text: "tighter here", by: "nic", viaVoice: false, resolved: false, at: T }],
};
const render = { id: "r-1", project: "demo", planId: "p-1", path: "C:\\ai-hub\\media\\projects\\demo\\renders\\demo_v001.mp4", durationSec: 12, width: 1080, height: 1920, sizeBytes: 2_000_000, loudnessLufs: -14, verify: { ok: true, checks: ["exists"] }, createdAt: T };
const review = { rounds: [{ round: 1, renderId: "r-1", notes: ["n-1"], status: "open", summary: "Opened on the spin; kept the music low." }], openDecisions: [] };
const ready = { enabled: true, healthy: true, tools: 4, error: null };

async function fakeDesktop(page: Page) {
  await page.addInitScript(
    ({ project, manifest, render, review, ready }) => {
      const calls: { cmd: string; args: unknown }[] = [];
      (window as unknown as { __calls: typeof calls }).__calls = calls;
      localStorage.setItem("cc.director.lastSlug", "demo");
      let p = project;
      let m = manifest;
      let cb = 0;
      (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        transformCallback: () => ++cb,
        unregisterCallback: () => undefined,
        convertFileSrc: (x: string) => x,
        invoke: async (cmd: string, args: Record<string, unknown>) => {
          calls.push({ cmd, args });
          switch (cmd) {
            case "plugin:event|listen":
              return ++cb;
            case "security_status":
              return { enabled: false, hardLocked: false, hardLockReason: null, pinSet: false, pinMinLength: 6, biometricAvailable: false, companionEnabled: false, companionPaired: false, companionDevice: false, platform: "windows", deviceId: "test", session: { locked: false }, modules: [], idleLockMinutes: 0, reauthMinutes: 0, elevationIdleMinutes: 0, elevationMaxMinutes: 0, now: Math.floor(Date.now() / 1000) };
            case "media_projects":
              return [p];
            case "media_project_get":
              return { project: p, assets: [], manifest: m, renders: [render] };
            case "media_chat_log":
              return [];
            case "media_review_get":
              return review;
            case "media_readiness":
              return { shotcut: ready, mediaForge: ready, ffmpegFound: true };
            case "media_intake_status":
              return { inbox: "C:\\ai-hub\\media\\projects\\demo\\inbox", pending: 1, processing: null, lastError: null };
            case "media_project_update":
              p = { ...p, ...(args.brief ? { brief: args.brief } : {}) } as typeof p;
              return p;
            case "media_manifest_save":
              m = { ...(args.manifest as typeof m), revision: m.revision + 1 };
              return m;
            case "media_approve_final":
              return [{ platform: "reels", renderId: "r-1", path: "C:\\ai-hub\\media\\projects\\demo\\renders\\final\\reels\\demo_v001.mp4", captionPath: null, thumbPath: null }];
            default:
              throw new Error(`not mocked: ${cmd}`);
          }
        },
      };
    },
    { project, manifest, render, review, ready },
  );
}

const calls = (page: Page, cmd: string) => page.evaluate((c) => (window as unknown as { __calls: { cmd: string; args: Record<string, unknown> }[] }).__calls.filter((x) => x.cmd === c), cmd);

test.describe("Director Suite v2 panels", () => {
  test.skip(({ isMobile }) => !!isMobile, "the suite is desktop-only");

  test("brief, shot list, intake, review, outputs and final approval", async ({ page }) => {
    await fakeDesktop(page);
    await page.goto("/#/director");

    // Top-bar pill: honest label, count in the tooltip.
    const pill = page.getByRole("status").filter({ hasText: "MCP ready · Shotcut + MediaForge" });
    await expect(pill).toBeVisible();
    await expect(pill).toHaveAttribute("title", /^8 tools listed/);

    // Brief: guessed chip, then Nic approves.
    await expect(page.getByText("Dance reel for the showcase")).toBeVisible();
    await expect(page.getByText("guessed", { exact: true })).toHaveCount(1);
    await page.getByRole("button", { name: "Approve brief" }).click();
    await expect.poll(async () => (await calls(page, "media_project_update")).map((c) => (c.args.brief as { approved: boolean }).approved)).toEqual([true]);

    // Intake line.
    await expect(page.getByRole("status", { name: "Inbox status" })).toContainText("1 waiting");

    // Shot list: tick "filmed", then the phone checklist.
    await page.getByRole("checkbox", { name: "Filmed Hook" }).check();
    await expect.poll(async () => (await calls(page, "media_manifest_save")).length).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Phone view" }).click();
    await expect(page.getByText("1 of 2 filmed")).toBeVisible();
    await page.getByRole("button", { name: "Full shot list" }).click();

    // Review: round 1 with the Director's summary and the note.
    await expect(page.getByText("Round 1 of 2 · open")).toBeVisible();
    await expect(page.getByText("Opened on the spin; kept the music low.")).toBeVisible();
    await expect(page.getByText("tighter here")).toBeVisible();

    // Outputs: add YouTube.
    await page.getByRole("group", { name: "Output platforms" }).getByRole("button", { name: "YouTube" }).click();
    await expect(page.getByRole("group", { name: "Output platforms" }).getByRole("button", { name: "YouTube" })).toHaveAttribute("aria-pressed", "true");

    // Approve final: pick, confirm, deliverables.
    await page.getByRole("button", { name: "Approve final…" }).click();
    await page.getByRole("checkbox", { name: "Final: demo_v001.mp4" }).check();
    await page.getByRole("button", { name: "Approve final", exact: true }).click();
    expect(await calls(page, "media_approve_final")).toHaveLength(0); // still behind the confirm
    await page.getByRole("button", { name: "Yes, approve final" }).click();
    await expect.poll(async () => (await calls(page, "media_approve_final")).map((c) => c.args)).toEqual([{ slug: "demo", renderIds: ["r-1"], approved: true }]);
    await expect(page.getByText("Deliverables")).toBeVisible();
    await expect(page.getByRole("button", { name: "Send to Biz Ops" })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("director-v2.png"), fullPage: true });
  });
});
