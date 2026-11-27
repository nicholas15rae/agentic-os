import { describe, expect, it, vi } from "vitest";

vi.mock("@/sections/VaultSection", () => ({ VaultSearchPanel: () => null, VaultResultsPanel: () => null, BackupCard: () => null, VaultMemoryPanel: () => null }));

import { VAULT_DEFAULT_DESKTOP, VAULT_DEFAULT_WEB, VAULT_PANELS, VAULT_SURFACE, useVaultLayout } from "./panels";
import { getWidget } from "@/core/widgets/registry";
import { fits } from "@/core/widgets/pages";

describe("Vault on the shared layout", () => {
  it("every panel is a Vault page panel", () => {
    for (const p of VAULT_PANELS) expect(getWidget(p.id)).toMatchObject({ surfaces: [VAULT_SURFACE], panel: true });
  });

  it("both defaults fill the board with no overlaps (web: no desktop-only memory panel)", () => {
    for (const d of [VAULT_DEFAULT_DESKTOP, VAULT_DEFAULT_WEB]) {
      for (const i of d) expect(fits(d, i)).toBe(true);
      expect(d.reduce((a, i) => a + i.w * i.h, 0)).toBe(12 * 8);
    }
    expect(VAULT_DEFAULT_WEB.some((i) => i.widgetId === "va-memory")).toBe(false);
  });

  it("Reset brings the search box back", () => {
    useVaultLayout.getState().remove("search");
    useVaultLayout.getState().reset();
    expect(useVaultLayout.getState().pages[0].items.some((i) => i.widgetId === "va-search")).toBe(true);
  });
});
