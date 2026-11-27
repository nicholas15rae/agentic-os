import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GMAIL_SCOPES, gmailInboxScope, gmailScopePatch } from "./comms-settings";

/** Live test 11-27: Gmail reads are Primary only, as a saved Settings → Comms choice. */
describe("Settings → Comms: Gmail inbox scope", () => {
  it("defaults to Primary only (missing, empty or unknown values too)", () => {
    expect(gmailInboxScope(null)).toBe("primary");
    expect(gmailInboxScope({})).toBe("primary");
    expect(gmailInboxScope({ gmail: { bookingInstructionsPath: "x", inboxScope: "" } })).toBe("primary");
    expect(gmailInboxScope({ gmail: { bookingInstructionsPath: "x", inboxScope: "promotions" } })).toBe("primary");
    expect(gmailInboxScope({ gmail: { bookingInstructionsPath: "x", inboxScope: " ALL " } })).toBe("all");
  });

  it("the default option comes first and names the Primary query", () => {
    expect(GMAIL_SCOPES[0].id).toBe("primary");
    expect(GMAIL_SCOPES[0].label).toMatch(/default/i);
    expect(GMAIL_SCOPES[0].hint).toContain("category:primary in:inbox");
  });

  it("saves only gmail.inboxScope", () => {
    expect(gmailScopePatch("all")).toEqual({ gmail: { inboxScope: "all" } });
    expect(gmailScopePatch("primary")).toEqual({ gmail: { inboxScope: "primary" } });
  });

  it("Settings has a Comms tab with the card, and Rust saves the same field", () => {
    const section = readFileSync(new URL("../SettingsSection.tsx", import.meta.url), "utf8");
    expect(section).toContain('{ id: "comms", label: "Comms" }');
    expect(section).toContain("<GmailInboxCard />");
    const rs = readFileSync(new URL("../../../src-tauri/src/commands/os_core.rs", import.meta.url), "utf8");
    expect(rs).toContain("pub inbox_scope: String,");
    expect(rs).toContain("#[serde(rename_all = \"camelCase\", default)]\npub struct GmailConfig".replace("\n", rs.includes("\r\n") ? "\r\n" : "\n"));
  });
});
