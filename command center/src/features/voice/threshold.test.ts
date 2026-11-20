import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 2 fix pass: the desktop startup sync must not replace the v7-migrated gate with Rust's
 * serde default (-44 dB) when os.json never held a webview-written value.
 */
const h = vi.hoisted(() => ({ cmd: vi.fn() }));
vi.mock("@/lib/platform", () => ({ isTauri: () => true, cmd: h.cmd }));

import { useSettings } from "@/stores/settings";
import { syncThresholdFromOs } from "./threshold";

const setLocal = (db: number) => useSettings.setState({ vad: { ...useSettings.getState().vad, activationDb: db } });

beforeEach(() => {
  h.cmd.mockReset();
});

describe("syncThresholdFromOs", () => {
  it("keeps the migrated local gate and writes it up when os.json only has the default", async () => {
    setLocal(-56);
    h.cmd.mockImplementation(async (name: string) => (name === "os_config_get" ? { voice: { micEnabled: true, activationDb: -44, bargeMarginDb: 6 } } : {}));
    await syncThresholdFromOs();
    expect(useSettings.getState().vad.activationDb).toBe(-56);
    expect(h.cmd).toHaveBeenCalledWith("os_config_update", { patch: { voice: { activationDb: -56, activationDbSet: true } } });
  });

  it("adopts os.json's gate once the webview has written it", async () => {
    setLocal(-56);
    h.cmd.mockImplementation(async (name: string) => (name === "os_config_get" ? { voice: { micEnabled: true, activationDb: -40, bargeMarginDb: 6, activationDbSet: true } } : {}));
    await syncThresholdFromOs();
    expect(useSettings.getState().vad.activationDb).toBe(-40);
    expect(h.cmd).not.toHaveBeenCalledWith("os_config_update", expect.anything());
  });
});
