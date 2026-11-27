/**
 * Top-bar clock and weather effects (plan Section 4, step 13), against a mocked gateway and a mocked
 * Open-Meteo (tests/ui/fixtures/open-meteo.json: snow today in Toronto, 7 days). The clock is pinned to
 * Thursday 26 Nov 2026, 15:42 in Toronto. Nothing leaves the machine: every other host is aborted.
 *
 * - The header has no atmosphere picker at any width; the clock sits in its old slot, Widgets after it.
 * - The clock opens "Alarms & key dates" (2 rows); Escape closes it and focus returns to the clock.
 * - The effects popover is lean (no picker, no forecast); "Open weather & forecast" has the 7-day strip and the
 *   picker; Rain shows the manual dot and Back to Live, which clears it.
 * - Settings → Appearance → 24 h changes the clock.
 * - No horizontal scroll at 375 / 768 / 1024 / 1440; at 375 the clock sits next to Widgets and the alarms
 *   popover stays inside the screen.
 * Not covered here (needs a faked desktop with the n8n calendar-create workflow): Escape with a pending
 * "Add to Google Calendar" card; the unit test pins that rule (popoverTakesEscape).
 */
import { readFileSync } from "node:fs";
import { expect, test, type Page, type Route } from "@playwright/test";

const GATEWAY = "http://127.0.0.1:8080";
const NOW = new Date("2026-11-26T15:42:00-05:00");
const OPEN_METEO = readFileSync(new URL("./fixtures/open-meteo.json", import.meta.url), "utf8");

const reminders = [
  { id: "r-alarm", title: "Wake up", kind: "alarm", dueAt: new Date("2026-11-27T06:45:00-05:00").getTime(), repeat: "none", source: "local", _created: 1, _updated: 1 },
  { id: "r-gcal", title: "Audition at the Princess of Wales", kind: "event", dueAt: new Date("2026-11-28T11:00:00-05:00").getTime(), repeat: "none", source: "gcal", gcalId: "g1", _created: 2, _updated: 2 },
];

test.use({ timezoneId: "America/Toronto", locale: "en-US" });

async function setup(page: Page) {
  await page.clock.setFixedTime(NOW);
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("seeded")) {
      localStorage.setItem("cc.settings", JSON.stringify({ state: { weatherMode: "auto", weatherLocation: { lat: 43.65, lon: -79.38, label: "Toronto" } }, version: 8 }));
      sessionStorage.setItem("seeded", "1");
    }
    sessionStorage.setItem("cc.settings.tab", "appearance");
  });
  // Hermetic: abort every non-local host, then allow only the mocked Open-Meteo and gateway.
  await page.route((url) => !/^(127\.0\.0\.1|localhost)$/.test(url.hostname), (r) => r.abort());
  await page.route("https://api.open-meteo.com/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: OPEN_METEO }));
  await page.route(`${GATEWAY}/**`, async (route: Route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (req.method() === "GET" && path === "/api/cc/c/reminders") return json({ items: reminders, now: NOW.getTime() });
    if (req.method() === "GET" && path.startsWith("/api/cc/c/")) return json({ items: [], now: NOW.getTime() });
    return json({ detail: "not mocked" }, 404);
  });
}

const banner = (page: Page) => page.getByRole("banner").first();
const clockButton = (page: Page) => banner(page).getByRole("button", { name: /Open alarms and key dates/ });
const effectsButton = (page: Page) => banner(page).getByRole("button", { name: /^Weather effects/ });

async function boot(page: Page) {
  await setup(page);
  await page.goto("/");
  await expect(clockButton(page)).toBeVisible({ timeout: 30_000 });
  // The temperature arrives from the mocked Open-Meteo.
  await expect(clockButton(page)).toContainText("-2°");
}

async function noSideScroll(page: Page) {
  const { sw, vw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, vw: window.innerWidth }));
  expect(sw, `no horizontal scroll at ${vw}px`).toBeLessThanOrEqual(vw);
  // Nothing in the header is pushed past the right edge.
  const right = await banner(page).evaluate((h) => Math.max(...Array.from(h.querySelectorAll("button")).filter((b) => b.offsetParent).map((b) => b.getBoundingClientRect().right)));
  expect(right, `header buttons inside ${vw}px`).toBeLessThanOrEqual(vw);
}

test("no picker in the header; the clock shows time, temperature and date and opens Alarms & key dates", async ({ page, isMobile }) => {
  await boot(page);
  await expect(banner(page).getByRole("radiogroup", { name: "Atmosphere" })).toHaveCount(0);
  const clock = clockButton(page);
  await expect(clock).toContainText("3:42");
  await expect(clock).toContainText("PM");
  if (!isMobile) await expect(clock).toContainText("Thu 26 Nov");
  else await expect(clock).not.toContainText("Thu 26 Nov");

  // Widgets follows the clock (Command page).
  const widgets = banner(page).getByRole("button", { name: "Widgets" });
  const cb = (await banner(page).getByTestId("topbar-clock").boundingBox())!;
  const wb = (await widgets.boundingBox())!;
  expect(wb.x).toBeGreaterThan(cb.x + cb.width - 1);
  expect(wb.x - (cb.x + cb.width), "the clock pill sits next to Widgets").toBeLessThanOrEqual(13);
  if (isMobile) await expect(widgets.getByText("Widgets", { exact: true })).toBeHidden(); // icon-only on phones

  await clock.click();
  const dialog = page.getByRole("dialog", { name: "Alarms & key dates" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("list", { name: "Upcoming alarms and dates" }).getByRole("listitem")).toHaveCount(2);
  await expect(dialog.getByText("Wake up")).toBeVisible();
  const vw = page.viewportSize()!.width;
  const db = (await dialog.boundingBox())!;
  expect(db.x).toBeGreaterThanOrEqual(8);
  expect(db.x + db.width).toBeLessThanOrEqual(vw - 8);
  await page.screenshot({ path: test.info().outputPath("alarms.png") });

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(clock).toBeFocused();
});

test("lean effects popover; the forecast sheet's Rain shows the manual dot and Back to Live clears it", async ({ page }) => {
  await boot(page);
  await expect(effectsButton(page)).toHaveAttribute("aria-label", "Weather effects: live (snow)");
  await expect(banner(page).getByTestId("effects-manual-dot")).toHaveCount(0);

  await effectsButton(page).click();
  const fx = page.getByRole("dialog", { name: "Weather effects" });
  await expect(fx).toBeVisible();
  await expect(fx.getByTestId("effects-status")).toHaveText("Live · Snow");
  await expect(fx.getByRole("switch", { name: "Weather effects" })).toHaveAttribute("aria-checked", "true");
  await expect(fx.getByRole("radiogroup", { name: "Atmosphere" })).toHaveCount(0);
  await expect(fx.getByRole("list", { name: "Forecast" })).toHaveCount(0);

  await fx.getByRole("button", { name: "Open weather & forecast" }).click();
  const sheet = page.getByRole("dialog", { name: "Weather & forecast" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("list", { name: "Forecast" }).getByRole("listitem")).toHaveCount(7);
  await sheet.getByRole("radio", { name: "Rain" }).click();
  await expect(sheet.getByTestId("weather-status")).toContainText("Manual · Rain");
  await page.screenshot({ path: test.info().outputPath("forecast-sheet.png") });
  await sheet.getByRole("button", { name: "Close weather" }).click();
  await expect(sheet).toHaveCount(0);

  await expect(effectsButton(page)).toHaveAttribute("aria-label", "Weather effects: manual (rain)");
  await expect(banner(page).getByTestId("effects-manual-dot")).toBeVisible();
  await effectsButton(page).click();
  await expect(fx.getByTestId("effects-status")).toHaveText("Manual · Rain");
  await fx.getByRole("button", { name: "Back to Live" }).click();
  await expect(fx.getByTestId("effects-status")).toHaveText("Live · Snow");
  await expect(banner(page).getByTestId("effects-manual-dot")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(fx).toHaveCount(0);
  await expect(effectsButton(page)).toBeFocused();
});

test("Settings → Appearance → 24 h changes the clock", async ({ page, isMobile }) => {
  test.skip(!!isMobile, "the Settings route is reached from the desktop rail here");
  await boot(page);
  await page.getByRole("button", { name: /^settings$/i }).first().click();
  const card = page.locator("section", { has: page.getByRole("heading", { name: "Top bar clock" }) });
  await expect(card).toBeVisible();
  await card.getByRole("radio", { name: "24 h" }).click();
  await expect(clockButton(page)).toContainText("15:42");
  await expect(clockButton(page)).not.toContainText("PM");
  await card.getByRole("switch", { name: "Show temperature" }).click();
  await expect(clockButton(page)).not.toContainText("-2°");
});

test("no horizontal scroll at 375 / 768 / 1024 / 1440; the callsign keeps 3 characters", async ({ page, isMobile }) => {
  await boot(page);
  const widths = isMobile ? [375, 360] : [1440, 1024, 768];
  for (const width of widths) {
    await page.setViewportSize({ width, height: isMobile ? 812 : 900 });
    await page.waitForTimeout(250); // ResizeObserver → the fit level settles
    await noSideScroll(page);
    const callsign = await banner(page).locator("[data-callsign]").evaluate((el) => ({ w: el.clientWidth, ch: parseFloat(getComputedStyle(el).fontSize) * 0.6 }));
    expect(callsign.w, `callsign at ${width}px`).toBeGreaterThanOrEqual(Math.floor(callsign.ch * 3));
    await expect(clockButton(page)).toBeInViewport();
    await page.screenshot({ path: test.info().outputPath(`topbar-${width}.png`) });
  }
});
