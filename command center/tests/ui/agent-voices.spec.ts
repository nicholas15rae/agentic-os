/**
 * Per-agent voices + the Comms inbox, against a faked desktop bridge (`__TAURI_INTERNALS__`): the
 * voice roster shows the "All Tony" master and a "Speak in own voice" switch per agent (Trading
 * included); each sends the right command, and All Tony leaves the per-agent switches as they were.
 * Comms → Agents lists the reports with their time and a replay button, unread until opened.
 * Every other native command is refused, so nothing real is touched. Desktop project only.
 */
import { expect, test, type Page } from "@playwright/test";

const NOW = Date.now();
const view = (allTony: boolean, directorOwn = true) => ({
  providers: [{ id: "elevenlabs", label: "ElevenLabs", kind: "tts", baseUrl: "https://api.elevenlabs.io/v1", model: "eleven_flash_v2_5", needsKey: true, engine: "elevenlabs", voice: "tony-clone", hasKey: true, custom: false }],
  policy: { chain: [], verifier: "", stt: "", tts: "elevenlabs", localTimeoutSecs: 90, cloudTimeoutSecs: 120 },
  agentVoices: {
    general: { engine: "elevenlabs", voice: "tony-clone", autoSpeak: false },
    director: { engine: "elevenlabs", voice: "dir-voice", autoSpeak: false, ...(directorOwn ? {} : { ownVoice: false }) },
  },
  agentVoicesAllTony: allTony,
});
const inbox = {
  state: {
    messages: [
      { id: "render:j1:done", agent: "director", text: "Nic, the self tape render is done. I checked the streams and it's on the verified shelf.", at: NOW - 60_000, urgent: false, source: "render", read: false },
      { id: "trading:kill:9", agent: "trading", text: "Nic, the kill switch just fired: manual. Orders are cancelled and positions are flattening.", at: NOW - 120_000, urgent: true, source: "trading", read: false, interrupted: true },
      { id: "task:t1:4", agent: "coder", text: "Nic, the card's built. I added the hover states.", at: NOW - 3_600_000, urgent: false, source: "task", read: true, spokenAt: NOW - 3_500_000, voice: "coder" },
    ],
  },
  version: 1,
};

async function fakeDesktop(page: Page, start: ReturnType<typeof view>) {
  await page.addInitScript(
    ({ start, inbox }) => {
      let current = start;
      const calls: { cmd: string; args: unknown }[] = [];
      (window as unknown as { __calls: typeof calls }).__calls = calls;
      localStorage.setItem("cc-agent-inbox", JSON.stringify(inbox));
      let cb = 0;
      (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        transformCallback: () => ++cb,
        unregisterCallback: () => undefined,
        convertFileSrc: (p: string) => p,
        invoke: async (cmd: string, args: Record<string, unknown>) => {
          calls.push({ cmd, args });
          switch (cmd) {
            case "providers_list":
              return current;
            case "agent_voice_update": {
              const role = args.role as string;
              current = { ...current, agentVoices: { ...current.agentVoices, [role]: { engine: "elevenlabs", autoSpeak: false, ...(current.agentVoices as Record<string, object>)[role], ...(args.patch as object) } } };
              return current;
            }
            case "agent_voices_all_tony":
              current = { ...current, agentVoicesAllTony: args.on as boolean };
              return current;
            case "tts_voices":
              return { voices: [], keySource: "keychain" };
            case "provider_models":
              return ["eleven_turbo_v2_5"];
            case "plugin:event|listen":
              return ++cb;
            case "security_status":
              // Test-only: the fake desktop runs with the security gate off.
              return { enabled: false, hardLocked: false, hardLockReason: null, pinSet: false, pinMinLength: 6, biometricAvailable: false, companionEnabled: false, companionPaired: false, companionDevice: false, platform: "windows", deviceId: "test", session: { locked: false }, modules: [], idleLockMinutes: 0, reauthMinutes: 0, elevationIdleMinutes: 0, elevationMaxMinutes: 0, now: Math.floor(Date.now() / 1000) };
            default:
              throw new Error(`not mocked: ${cmd}`);
          }
        },
      };
    },
    { start, inbox },
  );
}

const calls = (page: Page) => page.evaluate(() => (window as unknown as { __calls: { cmd: string; args: Record<string, unknown> }[] }).__calls.filter((c) => c.cmd === "agent_voice_update" || c.cmd === "agent_voices_all_tony"));

test.describe("per-agent voices and the Comms inbox", () => {
  test.skip(({ isMobile }) => !!isMobile, "desktop-only surfaces");

  test("roster: All Tony master + Speak in own voice per agent", async ({ page }) => {
    await fakeDesktop(page, view(false));
    await page.addInitScript(() => sessionStorage.setItem("cc.settings.tab", "voice"));
    await page.goto("/");
    await page.getByRole("button", { name: /^settings$/i }).first().click();
    await expect(page.getByText("Agent voice roster", { exact: true })).toBeVisible();
    const allTony = page.locator("label", { hasText: "All Tony" }).getByRole("switch");
    await expect(allTony).toHaveAttribute("aria-checked", "false");

    const director = page.getByRole("switch", { name: "Speak in own voice: Director" });
    const trading = page.getByRole("switch", { name: "Speak in own voice: Trading" });
    await expect(director).toHaveAttribute("aria-checked", "true");
    await expect(trading).toBeVisible();

    await director.click();
    await expect(director).toHaveAttribute("aria-checked", "false");
    await allTony.click();
    await expect(allTony).toHaveAttribute("aria-checked", "true");
    await allTony.click();
    await expect(allTony).toHaveAttribute("aria-checked", "false");
    await expect(director).toHaveAttribute("aria-checked", "false"); // remembered under All Tony
    expect(await calls(page)).toEqual([
      { cmd: "agent_voice_update", args: { role: "director", patch: { ownVoice: false } } },
      { cmd: "agent_voices_all_tony", args: { on: true } },
      { cmd: "agent_voices_all_tony", args: { on: false } },
    ]);
    await page.getByText("Agent voice roster", { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath("roster.png") });
  });

  test("Comms → Agents: reports with time and replay, unread until opened", async ({ page }) => {
    await fakeDesktop(page, view(false));
    await page.goto("/");
    await page.getByRole("button", { name: /^comms$/i }).first().click();
    await expect(page.getByRole("tab", { name: "Agents (2)" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText("You've got a message from the Director and 1 from the Trading agent.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Play the message from the Director" })).toBeVisible();
    await expect(page.getByText("Urgent")).toBeVisible();
    await page.getByRole("button", { name: "Unread: message from the Director" }).click();
    await expect(page.getByRole("tab", { name: "Agents (1)" })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("comms.png"), fullPage: false });
  });
});
