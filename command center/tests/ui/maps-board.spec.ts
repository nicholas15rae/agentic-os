/**
 * Maps findability (plan Section 5, steps 1–2), against a faked desktop bridge (`__TAURI_INTERNALS__`):
 * - a v5 board gains the one-time "Travel" page, and Settings → Integrations → "Show on board" goes to it;
 * - on a v6 board with no Maps and a full Page 1, "Add to board" makes Page 2, says so, and goes there.
 * Every native command is refused (except the security gate, off), so nothing real is touched. Desktop only.
 */
import { expect, test, type Page } from "@playwright/test";

const cell = (instanceId: string, widgetId: string, col: number, row: number, w: number, h: number) => ({ instanceId, widgetId, col, row, w, h, config: {} });
/** A full 12×8 Page 1 of light widgets. */
const FULL = [cell("a", "quick-notes", 1, 1, 6, 4), cell("b", "quick-notes", 7, 1, 6, 4), cell("c", "quick-notes", 1, 5, 6, 4), cell("d", "quick-notes", 7, 5, 6, 4)];

async function fakeDesktop(page: Page, layout: { version: number; pages: { id: string; name: string; items: unknown[] }[] }) {
  await page.addInitScript((layout) => {
    if (!sessionStorage.getItem("seeded")) {
      localStorage.setItem("cc.layout", JSON.stringify({ state: { pages: layout.pages, activePage: layout.pages[0].id }, version: layout.version }));
      sessionStorage.setItem("seeded", "1");
    }
    sessionStorage.setItem("cc.settings.tab", "integrations");
    let cb = 0;
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => ++cb,
      unregisterCallback: () => undefined,
      convertFileSrc: (p: string) => p,
      invoke: async (cmd: string) => {
        if (cmd === "plugin:event|listen") return ++cb;
        if (cmd === "security_status")
          // Test-only: the fake desktop runs with the security gate off.
          return { enabled: false, hardLocked: false, hardLockReason: null, pinSet: false, pinMinLength: 6, biometricAvailable: false, companionEnabled: false, companionPaired: false, companionDevice: false, platform: "windows", deviceId: "test", session: { locked: false }, modules: [], idleLockMinutes: 0, reauthMinutes: 0, elevationIdleMinutes: 0, elevationMaxMinutes: 0, now: Math.floor(Date.now() / 1000) };
        throw new Error(`not mocked: ${cmd}`);
      },
    };
  }, layout);
}

const stored = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem("cc.layout") ?? "null") as { version: number; state: { pages: { id: string; name: string; items: { widgetId: string }[] }[]; activePage: string } });
const pageTab = (page: Page, name: string) => page.getByRole("navigation", { name: "Dashboard pages" }).getByRole("button", { name, exact: true });

test.describe("Maps on the board", () => {
  test.skip(({ isMobile }) => !!isMobile, "Settings is desktop-only");

  test("v5 → v6 adds Travel once; Show on board goes there", async ({ page }) => {
    await fakeDesktop(page, { version: 5, pages: [{ id: "p1", name: "Page 1", items: FULL }] });
    await page.goto("/");
    await expect(pageTab(page, "Travel")).toBeVisible();
    let s = await stored(page);
    expect(s.version).toBe(6);
    expect(s.state.pages.map((p) => p.name)).toEqual(["Page 1", "Travel"]);
    expect(s.state.pages[0].items).toHaveLength(4);
    expect(s.state.activePage).toBe("p1");

    // Reload: still exactly one Travel page.
    await page.reload();
    await expect(pageTab(page, "Travel")).toBeVisible();
    expect((await stored(page)).state.pages.filter((p) => p.name === "Travel")).toHaveLength(1);

    await page.getByRole("button", { name: /^settings$/i }).first().click();
    await page.getByRole("button", { name: "Show on board" }).click();
    await expect(page.getByText("Maps is on Travel")).toBeVisible();
    await expect(pageTab(page, "Travel")).toHaveAttribute("aria-current", "page");
    s = await stored(page);
    expect(s.state.activePage).toBe("travel");
    await page.screenshot({ path: test.info().outputPath("travel.png") });
  });

  test("full board: Add to board makes Page 2, says so, and goes there", async ({ page }) => {
    await fakeDesktop(page, { version: 6, pages: [{ id: "p1", name: "Page 1", items: FULL }] });
    await page.goto("/");
    await page.getByRole("button", { name: /^settings$/i }).first().click();
    await page.getByRole("button", { name: "Add to board" }).click();
    await expect(page.getByText("Maps added on Page 2")).toBeVisible();
    await expect(page.getByText(/Every page was full/)).toBeVisible();
    await expect(pageTab(page, "Page 2")).toHaveAttribute("aria-current", "page");
    const s = await stored(page);
    expect(s.state.pages.map((p) => p.name)).toEqual(["Page 1", "Page 2"]);
    expect(s.state.pages[1].items.map((i) => i.widgetId)).toEqual(["route-map"]);
    await page.screenshot({ path: test.info().outputPath("added.png") });
  });
});
