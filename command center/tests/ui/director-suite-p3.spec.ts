/**
 * Director Suite Part 3 (A, ComfyUI) against a faked desktop bridge (the director-suite-v2.spec.ts
 * pattern): the GPU baton pill, the Generate panel (a missing upscaler's note, Enqueue's visible
 * reason, the exact comfy_enqueue args), the Queue card ("Waiting for idle" → Cancel → Cancelled) and
 * the policy select. comfy_* and gpu_slot_view are mocked in memory; every other unmocked native
 * command is refused, so nothing real runs (no ComfyUI, no GPU, no render). Desktop project only.
 */
import { expect, test, type Page } from "@playwright/test";

const T = "2026-11-27T00:00:00Z";
const project = {
  slug: "demo", title: "Demo reel", status: "editing", root: "C:\\ai-hub\\media\\projects\\demo", createdAt: T, updatedAt: T,
  source: { from: "suite", refId: null, brief: null }, speed: "rough",
  brief: { idea: "Dance reel for the showcase", goal: "get booked", platform: "reels", lengthSec: 30, aspect: "9:16", tone: "warm", references: [], guessed: [], approved: true, updatedBy: "nic", updatedAt: T },
};
const manifest = {
  version: 2, project: "demo", revision: 3, clips: [], audio: [], clipAudioVolume: 1,
  output: { aspect: "9:16", loudnessLufs: -14, maxSizeMb: null, name: "demo" },
  shotList: [], updatedBy: "nic", updatedAt: T,
  captions: { enabled: false, style: "clean", position: "lower", maxWordsPerLine: 4 }, color: { preset: "none", strength: 0.5 },
  outputs: [{ platform: "reels", aspect: "9:16", loudnessLufs: -14, maxSizeMb: null, maxSec: 90 }],
  notes: [],
};
const ready = { enabled: true, healthy: true, tools: 4, error: null };
const UPSCALER = "upscale_models/4x-UltraSharp.pth";

async function fakeDesktop(page: Page) {
  await page.addInitScript(
    ({ project, manifest, ready, UPSCALER }) => {
      const calls: { cmd: string; args: unknown }[] = [];
      (window as unknown as { __calls: typeof calls }).__calls = calls;
      localStorage.setItem("cc.director.lastSlug", "demo");
      let cb = 0;
      let policy = "idle";
      type Job = Record<string, unknown> & { id: string; status: string };
      const jobs: Job[] = [];
      const tpl = (name: string, missing: string[] = []) => ({ name, requiredModels: missing.length ? missing : [`checkpoints/${name}.safetensors`], missing, ready: !missing.length, note: missing.length ? `needs model ${missing.join(", ")}` : null });
      const status = () => ({
        up: false, version: null, running: false, phase: "", admission: "mid-conversation (Tony spoke 20 s ago)", runNow: false,
        templates: [tpl("scene-still"), tpl("thumbnail-bg"), tpl("style-transfer"), tpl("upscale", [UPSCALER]), tpl("broll-motion")],
        counts: { queued: jobs.filter((j) => j.status === "queued").length, waiting: 0, running: 0, done: 0, failed: 0, cancelled: jobs.filter((j) => j.status === "cancelled").length },
        settings: { modelRoots: [], policy }, crashMarker: false, lastBatch: null, backoff: { failures: 0, untilMs: null }, recoveryAttempts: 0,
      });
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
              return [project];
            case "media_project_get":
              return { project, assets: [], manifest, renders: [] };
            case "media_chat_log":
              return [];
            case "media_review_get":
              return { rounds: [], openDecisions: [] };
            case "media_readiness":
              return { shotcut: ready, mediaForge: ready, ffmpegFound: true };
            case "media_intake_status":
              return { inbox: "C:\\ai-hub\\media\\projects\\demo\\inbox", pending: 0, processing: null, lastError: null };
            case "gpu_slot_view":
              return { active: ["lmstudio · Tony"], queuedForeground: 0, queuedBackground: 0, capacity: 1 };
            case "comfy_status":
              return status();
            case "comfy_queue_get":
              return { version: 1, settings: { modelRoots: [], policy }, jobs };
            case "comfy_enqueue": {
              const job: Job = { id: `g-${jobs.length + 1}`, slug: args.slug, template: args.template, params: { ...(args.params as object), seed: 1234 }, status: "queued", createdAt: Date.now(), startedAt: null, finishedAt: null, error: null, outputs: [], renderMs: null, peakVramMb: null, promptId: null };
              jobs.unshift(job);
              return job;
            }
            case "comfy_cancel": {
              const j = jobs.find((x) => x.id === args.id);
              if (!j) throw new Error("no such job");
              j.status = "cancelled";
              j.finishedAt = Date.now();
              return { ...j };
            }
            case "comfy_run_now":
              return { accepted: false, now: "mid-conversation (Tony spoke 20 s ago)" };
            case "comfy_settings_set":
              policy = ((args.patch as { policy?: string }).policy ?? policy) as string;
              return { modelRoots: [], policy };
            default:
              throw new Error(`not mocked: ${cmd}`);
          }
        },
      };
    },
    { project, manifest, ready, UPSCALER },
  );
}

const calls = (page: Page, cmd: string) => page.evaluate((c) => (window as unknown as { __calls: { cmd: string; args: Record<string, unknown> }[] }).__calls.filter((x) => x.cmd === c), cmd);

test.describe("Director Suite Part 3: ComfyUI", () => {
  test.skip(({ isMobile }) => !!isMobile, "the suite is desktop-only");

  test("baton pill, Generate panel, enqueue, queue row, cancel and policy", async ({ page }) => {
    await fakeDesktop(page);
    await page.goto("/#/director");

    // GPU baton: Tony holds it (static dot, no pulse).
    const baton = page.getByRole("status", { name: "GPU baton: GPU · Tony" });
    await expect(baton).toBeVisible();
    await expect(baton.locator(".animate-pulse")).toHaveCount(0);

    // Generate panel: collapsed until clicked.
    const toggle = page.getByRole("button", { name: /Generate a still/ });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    const generate = page.getByRole("region", { name: "Generate" });
    const enqueue = generate.getByRole("button", { name: "Enqueue", exact: true });

    // A missing upscaler: the note under the picker and as Enqueue's visible reason.
    const template = generate.getByRole("combobox", { name: "Template" });
    await expect(template.locator("option", { hasText: "Upscale 4x (not ready)" })).toHaveCount(1);
    await template.selectOption("upscale");
    await expect(generate.getByText(`needs model ${UPSCALER}`)).toHaveCount(2);
    await expect(generate.getByRole("note")).toHaveText(`needs model ${UPSCALER}`);
    await expect(enqueue).toBeDisabled();

    // Back to a scene still: no prompt yet, then a prompt and Enqueue.
    await template.selectOption("scene-still");
    await expect(generate.getByRole("note")).toHaveText("Write a prompt");
    await expect(enqueue).toBeDisabled();
    await generate.getByRole("textbox", { name: "Prompt", exact: true }).fill("neon rooftop at dusk");
    await expect(generate.getByText("20 / 2000")).toBeVisible();
    await expect(generate.getByText("Runs when the PC is idle. Tony is unloaded for the batch, then put back.")).toBeVisible();
    expect(await calls(page, "comfy_enqueue")).toHaveLength(0); // nothing queued before the click
    await expect(enqueue).toBeEnabled();
    await enqueue.click();
    await expect.poll(async () => (await calls(page, "comfy_enqueue")).map((c) => c.args)).toEqual([{ slug: "demo", template: "scene-still", params: { prompt: "neon rooftop at dusk", steps: 1 } }]);

    // Queue card: the job waits for idle, with Rust's reason.
    const row = page.getByRole("listitem", { name: "Queue item Scene still · neon rooftop at dusk" });
    await expect(row).toContainText("Waiting for idle");
    await expect(row).toContainText("mid-conversation (Tony spoke 20 s ago)");

    // Cancel → Cancelled.
    await row.getByRole("button", { name: "Cancel Scene still · neon rooftop at dusk" }).click();
    await expect.poll(async () => (await calls(page, "comfy_cancel")).map((c) => c.args)).toEqual([{ id: "g-1" }]);
    await expect(row).toContainText("Cancelled");
    await expect(row.getByRole("button", { name: /^Cancel / })).toHaveCount(0);

    // Policy select (global) → comfy_settings_set.
    const policy = page.getByRole("combobox", { name: "When ComfyUI runs" });
    await expect(policy).toHaveAttribute("title", "Applies to every project");
    await policy.selectOption("manual");
    await expect.poll(async () => (await calls(page, "comfy_settings_set")).map((c) => c.args)).toEqual([{ patch: { policy: "manual" } }]);
    await expect(policy).toHaveValue("manual");

    // Nothing ran: Run now was never pressed.
    expect(await calls(page, "comfy_run_now")).toHaveLength(0);
    await page.screenshot({ path: test.info().outputPath("director-p3-comfy.png"), fullPage: true });
  });
});

// ── Part 3 B: navigation (projects board, note markers) ──────────────────────

const navAsset = (id: string, name: string, durationSec: number) => ({
  id, project: "demo", kind: "video", role: "clip", name, path: `C:\\ai-hub\\media\\projects\\demo\\raw\\${name}`, readOnly: true, sizeBytes: 1000,
  durationSec, width: 1080, height: 1920, thumbPath: null, addedAt: T, tags: [], transcript: null, flags: [], moments: [], slotId: null,
});

/** The same refusing bridge, for navigation: projects (board) and an open project with two clips and
 * one timed note. media_project_update is mocked in memory; nothing else new. */
async function fakeNav(page: Page, opts: { open: boolean }) {
  const other = { ...project, slug: "teaser", title: "Old teaser", status: "brief", updatedAt: "2026-11-20T00:00:00Z" };
  const navManifest = {
    ...manifest,
    clips: [
      { id: "c1", assetId: "a1", inSec: 0, outSec: 4, fadeMs: 0 },
      { id: "c2", assetId: "a2", inSec: 1, outSec: 7, fadeMs: 0 },
    ],
    notes: [{ id: "n1", renderId: null, atSec: 6, text: "tighter here", by: "nic", viaVoice: false, resolved: false, at: T }],
  };
  const assets = [navAsset("a1", "a.mp4", 4), navAsset("a2", "b.mp4", 8)];
  await page.addInitScript(
    ({ project, other, navManifest, assets, ready, open }) => {
      const calls: { cmd: string; args: unknown }[] = [];
      (window as unknown as { __calls: typeof calls }).__calls = calls;
      if (open) localStorage.setItem("cc.director.lastSlug", "demo");
      else localStorage.removeItem("cc.director.lastSlug");
      let cb = 0;
      const rows: Record<string, unknown>[] = [project, other];
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
              return rows;
            case "media_project_get":
              return { project: rows.find((r) => r.slug === args.slug) ?? project, assets, manifest: navManifest, renders: [] };
            case "media_project_update": {
              const i = rows.findIndex((r) => r.slug === args.slug);
              if (i < 0) throw new Error("no such project");
              rows[i] = { ...rows[i], ...(args.status ? { status: args.status } : {}), updatedAt: new Date().toISOString() };
              return rows[i];
            }
            case "media_chat_log":
              return [];
            case "media_review_get":
              return { rounds: [], openDecisions: [] };
            case "media_readiness":
              return { shotcut: ready, mediaForge: ready, ffmpegFound: true };
            case "media_intake_status":
              return { inbox: "C:\\ai-hub\\media\\projects\\demo\\inbox", pending: 0, processing: null, lastError: null };
            default:
              throw new Error(`not mocked: ${cmd}`);
          }
        },
      };
    },
    { project, other, navManifest, assets, ready, open: opts.open },
  );
}

test.describe("Director Suite Part 3: navigation", () => {
  test.skip(({ isMobile }) => !!isMobile, "the suite is desktop-only");

  test("projects board: the status chip menu calls media_project_update and moves the card", async ({ page }) => {
    await fakeNav(page, { open: false });
    await page.goto("/#/director");

    const editing = page.getByRole("region", { name: "Editing column" });
    const review = page.getByRole("region", { name: "Review column" });
    await expect(editing.getByRole("listitem", { name: "Demo reel" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Brief column" }).getByRole("listitem", { name: "Old teaser" })).toBeVisible();
    await expect(review.getByRole("listitem")).toHaveCount(0);

    // Chip → menu → Review. Escape closes the menu without a call.
    const chip = page.getByRole("button", { name: "Demo reel status: Editing" });
    await chip.click();
    await expect(page.getByRole("menu", { name: "Status for Demo reel" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    expect(await calls(page, "media_project_update")).toHaveLength(0);

    await chip.click();
    await page.getByRole("menuitemradio", { name: "Review" }).click();
    await expect.poll(async () => (await calls(page, "media_project_update")).map((c) => c.args)).toEqual([{ slug: "demo", status: "review" }]);
    await expect(review.getByRole("listitem", { name: "Demo reel" })).toBeVisible();
    await expect(review.getByRole("button", { name: "Demo reel status: Review" })).toBeVisible();
    await expect(editing.getByRole("listitem")).toHaveCount(0);

    // List layout: the same chip per row.
    await page.getByRole("button", { name: "List", exact: true }).click();
    await expect(page.getByRole("region", { name: "Review column" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Demo reel status: Review" })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("director-p3-board.png"), fullPage: true });
  });

  test("a note marker click seeks the preview to its clip; All projects… closes the project", async ({ page }) => {
    await fakeNav(page, { open: true });
    await page.goto("/#/director");

    // 6 s on the timeline = 2 s into clip 2 (b.mp4, in 1 s → 3 s of its asset).
    const marker = page.getByRole("group", { name: "Note markers" }).getByRole("button", { name: "Note at 00:06.00: tighter here" });
    await expect(marker).toBeVisible();
    // Placed over clip 2's box, not by a straight percentage of the strip.
    const [mBox, c2Box] = [await marker.boundingBox(), await page.locator('[title="b.mp4"][draggable="true"]').boundingBox()];
    expect(mBox && c2Box && mBox.x + mBox.width / 2 >= c2Box.x && mBox.x + mBox.width / 2 <= c2Box.x + c2Box.width).toBe(true);

    await expect(page.getByText("#2 · b.mp4")).toHaveCount(0);
    await marker.click();
    await expect(page.getByText("#2 · b.mp4")).toBeVisible(); // the clip under the note is selected
    await expect(page.locator("video")).toHaveAttribute("src", /b\.mp4$/); // the preview shows it

    // StudioBar's project Select: All projects… → the board.
    await page.getByRole("combobox", { name: "Project" }).selectOption({ label: "All projects…" });
    await expect(page.getByRole("region", { name: "Editing column" })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("director-p3-markers.png"), fullPage: true });
  });
});

// ── Part 3 C: versions (restore, compare) ────────────────────────────────────

/** The same refusing bridge with three verified renders: v001 from before snapshots, v002 with one,
 * v003 current. media_render_snapshot / media_manifest_restore are mocked in memory. */
async function fakeVersions(page: Page) {
  const assets = [navAsset("a1", "a.mp4", 4), navAsset("a2", "b.mp4", 8)];
  const cut = (id: string, assetId: string, inSec: number, outSec: number) => ({ id, assetId, inSec, outSec, fadeMs: 0, transitionIn: { kind: "cut", ms: 0 }, punchIn: 1 });
  const working = { ...manifest, revision: 7, clips: [cut("c1", "a1", 0, 4)] };
  const v2cut = { ...working, revision: 5, clips: [cut("c1", "a1", 0, 4), cut("c2", "a2", 1, 7)] };
  const render = (id: string, planId: string, v: number, at: string) => ({ id, project: "demo", planId, path: `C:\\ai-hub\\media\\projects\\demo\\renders\\demo_v00${v}.mp4`, durationSec: v * 3, width: 1080, height: 1920, sizeBytes: 2_000_000, loudnessLufs: -14, verify: { ok: true, checks: [] }, createdAt: at });
  const renders = [render("r3", "p-3", 3, "2026-11-26T00:00:00Z"), render("r2", "p-2", 2, "2026-11-25T00:00:00Z"), render("r1", "p-1", 1, "2026-11-24T00:00:00Z")];
  await page.addInitScript(
    ({ project, working, v2cut, assets, renders, ready }) => {
      const calls: { cmd: string; args: unknown }[] = [];
      (window as unknown as { __calls: typeof calls }).__calls = calls;
      localStorage.setItem("cc.director.lastSlug", "demo");
      let cb = 0;
      let current: Record<string, unknown> = working;
      const snaps: Record<string, unknown> = { r1: null, r2: v2cut, r3: working };
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
              return [project];
            case "media_project_get":
              return { project, assets, manifest: current, renders };
            case "media_chat_log":
              return [];
            case "media_review_get":
              return { rounds: [], openDecisions: [] };
            case "media_readiness":
              return { shotcut: ready, mediaForge: ready, ffmpegFound: true };
            case "media_intake_status":
              return { inbox: "C:\\ai-hub\\media\\projects\\demo\\inbox", pending: 0, processing: null, lastError: null };
            case "media_render_snapshot": {
              const r = renders.find((x) => x.id === args.renderId);
              if (!r) throw new Error("no render in this project");
              return { renderId: r.id, planId: r.planId, manifest: snaps[r.id], createdAt: r.createdAt };
            }
            case "media_manifest_restore": {
              const s = snaps[args.renderId as string] as Record<string, unknown> | null;
              if (!s) throw new Error("NO_SNAPSHOT: this render was made before versions were kept, so its cut can't be restored.");
              if (args.revision !== undefined && args.revision !== current.revision) throw new Error(`STALE_REVISION: the timeline changed (now revision ${current.revision}); reload it`);
              current = { ...s, notes: current.notes, shotList: current.shotList, revision: (current.revision as number) + 1, updatedBy: "nic" };
              return current;
            }
            default:
              throw new Error(`not mocked: ${cmd}`);
          }
        },
      };
    },
    { project, working, v2cut, assets, renders, ready },
  );
}

test.describe("Director Suite Part 3: versions", () => {
  test.skip(({ isMobile }) => !!isMobile, "the suite is desktop-only");

  test("Versions: restore asks first and calls media_manifest_restore once; Compare opens two videos", async ({ page }) => {
    await fakeVersions(page);
    await page.goto("/#/director");

    await page.getByRole("tab", { name: "Versions" }).click();
    const list = page.getByRole("list", { name: "Versions" });
    const v3 = list.getByTestId("version-r3");
    const v2 = list.getByTestId("version-r2");
    const v1 = list.getByTestId("version-r1");
    // v003's cut is the working timeline's: marked Current, its Restore disabled.
    await expect(v3).toContainText("Current");
    await expect(v3.getByRole("button", { name: /Restore/ })).toBeDisabled();

    // v001 was made before snapshots: expanding it says so and disables Restore.
    await v1.getByRole("button", { name: /v001/ }).click();
    await expect(v1.getByText("Made before versions were kept, so there is no cut to show.")).toBeVisible();
    await expect(v1.getByRole("button", { name: /Restore/ })).toBeDisabled();

    // v002: the diff vs the working cut, then Restore… → confirm.
    await v2.getByRole("button", { name: /v002/ }).click();
    await expect(v2.getByText("1 clip removed (b.mp4)")).toBeVisible();
    await v2.getByRole("button", { name: /Restore/ }).click();
    const confirm = v2.getByRole("alertdialog", { name: "Confirm restore" });
    await expect(confirm).toContainText("Restore v002's cut? The timeline becomes that cut; notes and the shot list stay. Undo is available.");
    expect(await calls(page, "media_manifest_restore")).toHaveLength(0); // nothing before the confirm click
    // Cancel closes it without a call.
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toHaveCount(0);
    expect(await calls(page, "media_manifest_restore")).toHaveLength(0);
    await v2.getByRole("button", { name: /Restore/ }).click();
    await v2.getByRole("button", { name: "Yes, restore" }).click();
    await expect.poll(async () => (await calls(page, "media_manifest_restore")).map((c) => c.args)).toEqual([{ slug: "demo", renderId: "r2", revision: 7 }]);
    await expect(page.getByText("Version v002 restored")).toBeVisible();
    await expect(v2.getByText("Same cut")).toBeVisible(); // the working cut is now v002's
    await expect(v2.getByRole("button", { name: /Restore/ })).toBeDisabled();
    // Current follows the timeline, not the newest render: v002 now, and v003 can be restored back.
    await expect(v2).toContainText("Current");
    await expect(v3).not.toContainText("Current");
    await expect(v3.getByRole("button", { name: /Restore/ })).toBeEnabled();

    // Compare: v001 as A, v003 as B → two videos replace the preview; Close returns.
    await v1.getByRole("button", { name: "Compare" }).click();
    await expect(page.getByText("Comparing from v001: pick a second version.")).toBeVisible();
    await v3.getByRole("button", { name: "Compare" }).click();
    const cmp = page.getByRole("region", { name: "Compare versions" });
    await expect(cmp).toBeVisible();
    await expect(cmp.locator("video")).toHaveCount(2);
    await expect(cmp.getByTestId("compare-a")).toHaveAttribute("src", /demo_v001\.mp4$/);
    await expect(cmp.getByTestId("compare-b")).toHaveAttribute("src", /demo_v003\.mp4$/);
    await cmp.getByRole("tab", { name: "Wipe" }).click();
    await expect(cmp.getByRole("slider", { name: "Wipe position" })).toBeVisible();
    await expect(cmp.locator("video")).toHaveCount(2);
    await page.screenshot({ path: test.info().outputPath("director-p3-compare.png"), fullPage: true });
    await cmp.getByRole("button", { name: "Close" }).click();
    await expect(cmp).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Working Preview" })).toBeVisible();
    expect(await calls(page, "media_manifest_restore")).toHaveLength(1);
  });
});
