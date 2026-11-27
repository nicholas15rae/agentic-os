/**
 * Director Suite Part 6 against a faked desktop bridge (the director-suite-p4.spec.ts pattern):
 * a launcher preset's Start creates the project, saves its outputs and starter brief, and sends the
 * preset's first Director line exactly once (never before the click); the phone shot list shows
 * big one-column shots, copies them as text (a stubbed clipboard), prints only itself, and "Ask for
 * B-roll" only fills the chat box. Every unmocked native command is refused, so nothing real runs.
 */
import { expect, test, type Page } from "@playwright/test";

const T = "2026-11-27T00:00:00Z";
const IG_LINE = "New Instagram Reel, about 30 s at 9:16. Draft a shot list as a populate_shot_list action: a hook in the first 2 s, 5 to 8 shots, phone tips on each.";
const slot = (id: string, label: string, p: Record<string, unknown> = {}) => ({ id, label, instructions: "", kind: "video", targetSec: 3, assetId: null, status: "needed", framing: "closeup", action: "Look up at the lens", source: "film", phoneTips: ["lock exposure"], filmed: false, ...p });

async function fakeDesktop(page: Page, opts: { open: boolean }) {
  await page.addInitScript(
    ({ open, T, slot0, slot1 }) => {
      const calls: { cmd: string; args: unknown }[] = [];
      const w = window as unknown as Record<string, unknown>;
      w.__calls = calls;
      w.__copied = null;
      w.__printed = 0;
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => void (w.__copied = t) } });
      window.print = () => void (w.__printed = (w.__printed as number) + 1);
      if (open) localStorage.setItem("cc.director.lastSlug", "demo");
      let cb = 0;
      let p: Record<string, unknown> | null = open
        ? { slug: "demo", title: "Demo reel", status: "shooting", root: "C:\\ai-hub\\media\\projects\\demo", createdAt: T, updatedAt: T, source: { from: "suite", refId: null, brief: null }, speed: "rough", brief: null, review: { rounds: [], openDecisions: [] } }
        : null;
      let m: Record<string, unknown> & { revision: number } = {
        version: 2, project: "demo", revision: 1, clips: [], audio: [], clipAudioVolume: 1,
        output: { aspect: "16:9", loudnessLufs: -16, maxSizeMb: null, name: "demo" },
        shotList: open ? [slot0, slot1] : [], updatedBy: "nic", updatedAt: T,
        captions: { enabled: false, style: "clean", position: "lower", maxWordsPerLine: 4 }, color: { preset: "none", strength: 0.5 },
        outputs: [{ platform: "custom", aspect: "16:9", loudnessLufs: -16, maxSizeMb: null, maxSec: null }],
        notes: [],
      };
      const ready = { enabled: true, healthy: true, tools: 4, error: null };
      w.__TAURI_INTERNALS__ = {
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
              return p ? [p] : [];
            case "media_project_create":
              p = { slug: "spring-showcase", title: args.title, status: "brief", root: "C:\\ai-hub\\media\\projects\\spring-showcase", createdAt: T, updatedAt: T, source: { from: "suite", refId: null, brief: null }, speed: "rough", brief: null, review: { rounds: [], openDecisions: [] } };
              m = { ...m, project: "spring-showcase" };
              return p;
            case "media_project_get":
              return { project: p, assets: [], manifest: m, renders: [] };
            case "media_project_update":
              p = { ...p, ...(args.brief ? { brief: args.brief } : {}) };
              return p;
            case "media_manifest_save":
              m = { ...(args.manifest as typeof m), revision: m.revision + 1 };
              return m;
            case "director_turn":
              return { answer: "On it.", providerId: "test", latencyMs: 5, answeredBy: "director" };
            case "media_chat_log":
              return [];
            case "media_review_get":
              return { rounds: [], openDecisions: [] };
            case "media_deliverables_get":
              return [];
            case "media_readiness":
              return { shotcut: ready, mediaForge: ready, ffmpegFound: true };
            case "media_intake_status":
              return { inbox: "C:\\ai-hub\\media\\projects\\demo\\inbox", pending: 0, processing: null, lastError: null };
            case "gpu_slot_view":
              return { active: [], queuedForeground: 0, queuedBackground: 0, capacity: 1 };
            default:
              throw new Error(`not mocked: ${cmd}`);
          }
        },
      };
    },
    { open: opts.open, T, slot0: slot("s1", "Hook", { phoneTips: ["lock exposure", "chest height"] }), slot1: slot("s2", "Spin", { framing: "wide", action: "Full turn" }) },
  );
}

const calls = (page: Page, cmd: string) => page.evaluate((c) => (window as unknown as { __calls: { cmd: string; args: Record<string, unknown> }[] }).__calls.filter((x) => x.cmd === c), cmd);

test.describe("Director Suite Part 6", () => {
  test.skip(({ isMobile }) => !!isMobile, "the suite is desktop-only");

  test("a preset's Start creates the project, saves its brief and outputs, and sends its first line once", async ({ page }) => {
    await fakeDesktop(page, { open: false });
    await page.goto("/#/director");
    const presets = page.getByRole("group", { name: "Presets" });
    await expect(presets).toBeVisible();
    for (const l of ["Instagram Reel", "TikTok", "YouTube Short", "YouTube long-form", "Self-tape audition", "Demo reel"]) await expect(presets.getByRole("button", { name: new RegExp(`^${l}`) })).toBeVisible();
    await presets.getByRole("button", { name: /^Instagram Reel/ }).click();
    await expect(presets.getByText(`Start sends the Director: "${IG_LINE}"`)).toBeVisible();
    await presets.getByRole("textbox", { name: "Instagram Reel title" }).fill("Spring showcase");
    expect(await calls(page, "director_turn")).toHaveLength(0); // nothing sent before Start
    expect(await calls(page, "media_project_create")).toHaveLength(0);
    await presets.getByRole("button", { name: "Start" }).click();

    await expect.poll(async () => (await calls(page, "director_turn")).map((c) => (c.args.req as { text: string }).text)).toEqual([IG_LINE]);
    expect((await calls(page, "media_project_create")).map((c) => c.args)).toEqual([{ title: "Spring showcase" }]);
    const saves = await calls(page, "media_manifest_save");
    const last = saves.at(-1)?.args.manifest as { outputs: { platform: string }[]; output: { aspect: string } };
    expect(last.outputs.map((o) => o.platform)).toEqual(["reels"]);
    expect(last.output.aspect).toBe("9:16");
    const brief = (await calls(page, "media_project_update")).at(-1)?.args.brief as Record<string, unknown>;
    expect(brief).toMatchObject({ idea: "Spring showcase", platform: "reels", aspect: "9:16", lengthSec: 30, approved: false, updatedBy: "nic" });
    // The project is open and the chat shows the line that was sent.
    await expect(page.getByText(IG_LINE).first()).toBeVisible();
    await expect(page.getByText("On it.")).toBeVisible();
    expect(await calls(page, "media_render_execute")).toHaveLength(0);
    expect(await calls(page, "comfy_enqueue")).toHaveLength(0);
  });

  test("phone shot list: big one-column shots, copy as text, print only the list; B-roll only fills the chat box", async ({ page }) => {
    await fakeDesktop(page, { open: true });
    await page.goto("/#/director");
    await page.getByRole("button", { name: "Phone view" }).click();
    const sheet = page.getByTestId("shot-print");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText("0 of 2 filmed")).toBeVisible();
    await expect(sheet.getByText("1. Hook")).toBeVisible();
    await expect(sheet.getByText("Close-up · 3s")).toBeVisible();
    await expect(sheet.getByText("chest height")).toBeVisible();
    expect(await sheet.getByText("1. Hook").evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(17);

    await sheet.getByRole("button", { name: "Copy as text" }).click();
    await expect(sheet.getByRole("button", { name: "Copied" })).toBeVisible();
    const copied = await page.evaluate(() => (window as unknown as { __copied: string }).__copied);
    expect(copied).toContain("Shot list: Demo reel (0 of 2 filmed)");
    expect(copied).toContain("[ ] 1. Hook (Close-up, 3s)\n    Look up at the lens\n    - lock exposure\n    - chest height");
    expect(copied).toContain("[ ] 2. Spin (Wide, 3s)");

    await sheet.getByRole("checkbox", { name: "Filmed: Hook" }).click();
    await expect(sheet.getByText("1 of 2 filmed")).toBeVisible();
    await expect.poll(async () => (await calls(page, "media_manifest_save")).length).toBeGreaterThan(0);

    await sheet.getByRole("button", { name: "Print" }).click();
    expect(await page.evaluate(() => (window as unknown as { __printed: number }).__printed)).toBe(1);
    await page.emulateMedia({ media: "print" });
    await expect(sheet.getByText("1. Hook")).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Copy as text" })).toBeHidden();
    await expect(page.getByPlaceholder("Ask the Director…")).toBeHidden();
    await page.emulateMedia({ media: "screen" });

    // Fill the gaps (full list): Ask for B-roll lands in the chat box; nothing is sent.
    await page.getByRole("button", { name: "Full shot list" }).click();
    await page.getByRole("button", { name: "Ask for B-roll for Spin" }).click();
    await expect(page.getByPlaceholder("Ask the Director…")).toHaveValue(/^Slot s2 "Spin" \(Wide, 3s, Full turn\) has no footage\./);
    expect(await calls(page, "director_turn")).toHaveLength(0);
    await expect(page.getByRole("button", { name: "Generate a still for Spin" })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("director-p6.png"), fullPage: true });
  });
});
