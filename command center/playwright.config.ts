import { defineConfig, devices } from "@playwright/test";

/**
 * UI checks against the Vite dev build in a real browser, with the gateway mocked per test (page.route).
 * Port 1430, not 1420: `npm run dev` (predev) kills 1420/1421, and a dev server you already have open
 * there must not be touched. Uses the installed Microsoft Edge (channel "msedge"), so no browser download.
 * Run: npm run test:ui
 */
const PORT = 1430;

export default defineConfig({
  testDir: "tests/ui",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["line"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    channel: "msedge",
    headless: true,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Edge"], channel: "msedge", viewport: { width: 1440, height: 1000 } } },
    { name: "phone", use: { channel: "msedge", viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
  ],
  webServer: {
    command: `npx vite --port ${PORT} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
