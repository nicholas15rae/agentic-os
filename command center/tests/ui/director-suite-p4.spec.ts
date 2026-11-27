/**
 * Director Suite Part 4 (auditions) against a faked desktop bridge (the director-suite-p3.spec.ts
 * pattern): the Scene Reader entry stays hidden when scene_reader_status says down, shows when up,
 * and the Import click sends the best take and opens the new audition project. Every unmocked
 * native command is refused, so nothing real runs (no Scene Reader, no file copy). Desktop only.
 */
import { expect, test, type Page } from "@playwright/test";

const T = "2026-11-27T00:00:00Z";
const audition = {
  slug: "coffee-spot-audition", title: "Coffee spot audition", status: "brief", root: "C:\\ai-hub\\media\\projects\\coffee-spot-audition", createdAt: T, updatedAt: T,
  source: { from: "scene_reader", refId: "vo-1", brief: "Wake up slowly." }, speed: "rough", brief: null, review: { rounds: [], openDecisions: [] },
};
const manifest = {
  version: 2, project: "coffee-spot-audition", revision: 1, clips: [], audio: [], clipAudioVolume: 1,
  output: { aspect: "16:9", loudnessLufs: -18, maxSizeMb: 100, name: "coffee-spot-audition" },
  shotList: [], updatedBy: "nic", updatedAt: T,
  captions: { enabled: false, style: "clean", position: "lower", maxWordsPerLine: 4 }, color: { preset: "none", strength: 0.5 },
  outputs: [{ platform: "self_tape", aspect: "16:9", loudnessLufs: -18, maxSizeMb: 100, maxSec: null }],
  notes: [],
};
const srProjects = [
  {
    id: "vo-1", title: "Coffee spot", updatedAt: 20, copyChars: 15,
    takes: [
      { id: "t1", name: "Take 1", file: "tk-1.webm", durSec: 12.5, best: false, createdAt: 1, available: true },
      { id: "t2", name: "Take 2", file: "tk-2.wav", durSec: 11, best: true, createdAt: 2, available: true },
    ],
  },
];
const ready = { enabled: true, healthy: true, tools: 4, error: null };

async function fakeDesktop(page: Page, up: boolean) {
  await page.addInitScript(
    ({ up, audition, manifest, srProjects, ready }) => {
      const calls: { cmd: string; args: unknown }[] = [];
      (window as unknown as { __calls: typeof calls }).__calls = calls;
      let cb = 0;
      let imported = false;
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
            case "scene_reader_status":
              return { up, url: "http://127.0.0.1:5123", projectsRoot: up ? "C:\\Users\\x\\AppData\\Roaming\\com.scenereader.dev" : null };
            case "scene_reader_list":
              return srProjects;
            case "scene_reader_import":
              imported = true;
              return { project: audition, assets: [], skipped: [] };
            case "media_projects":
              return imported ? [audition] : [];
            case "media_project_get":
              return { project: audition, assets: [], manifest, renders: [] };
            case "media_chat_log":
              return [];
            case "media_review_get":
              return { rounds: [], openDecisions: [] };
            case "media_deliverables_get":
              return [];
            case "media_sides_list":
              return [];
            case "media_readiness":
              return { shotcut: ready, mediaForge: ready, ffmpegFound: true };
            case "media_intake_status":
              return { inbox: "C:\\ai-hub\\media\\projects\\coffee-spot-audition\\inbox", pending: 0, processing: null, lastError: null };
            case "gpu_slot_view":
              return { active: [], queuedForeground: 0, queuedBackground: 0, capacity: 1 };
            default:
              throw new Error(`not mocked: ${cmd}`);
          }
        },
      };
    },
    { up, audition, manifest, srProjects, ready },
  );
}

const calls = (page: Page, cmd: string) => page.evaluate((c) => (window as unknown as { __calls: { cmd: string; args: Record<string, unknown> }[] }).__calls.filter((x) => x.cmd === c), cmd);

test.describe("Director Suite Part 4: Scene Reader", () => {
  test.skip(({ isMobile }) => !!isMobile, "the suite is desktop-only");

  test("the entry is hidden while Scene Reader is down", async ({ page }) => {
    await fakeDesktop(page, false);
    await page.goto("/#/director");
    await expect(page.getByText("Hey Nic, what do you want to create today?")).toBeVisible();
    await expect.poll(async () => (await calls(page, "scene_reader_status")).length).toBeGreaterThan(0);
    await expect(page.getByTestId("scene-reader-card")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Show takes" })).toHaveCount(0);
    expect(await calls(page, "scene_reader_list")).toHaveLength(0);
  });

  test("shows when up; Import sends the best take and opens the audition project", async ({ page }) => {
    await fakeDesktop(page, true);
    await page.goto("/#/director");
    const card = page.getByTestId("scene-reader-card");
    await expect(card).toHaveCount(1);
    expect(await calls(page, "scene_reader_list")).toHaveLength(0); // nothing read before the click
    await page.getByRole("button", { name: "Show takes" }).click();
    await expect(card.getByRole("checkbox", { name: "Take Take 2" })).toBeChecked();
    await expect(card.getByRole("checkbox", { name: "Take Take 1" })).not.toBeChecked();
    expect(await calls(page, "scene_reader_import")).toHaveLength(0);
    await card.getByRole("button", { name: "Import 1 take" }).click();
    await expect.poll(async () => (await calls(page, "scene_reader_import")).map((c) => c.args)).toEqual([{ project: "vo-1", takeIds: ["t2"] }]);
    // The new audition project opens with its sides and slate card.
    await expect(page.getByTestId("audition-card")).toBeVisible();
    await expect(page.getByRole("button", { name: "Make slate" })).toBeDisabled();
  });
});
