// @vitest-environment node
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Record exactly what TradingDesk hands the red button.
const seen: Record<string, unknown>[] = [];
vi.mock("@/features/trading/KillButton", () => ({ KillButton: (p: Record<string, unknown>) => (seen.push(p), null) }));
vi.mock("@/lib/gateway", () => ({ GatewayError: class extends Error {}, gateway: vi.fn(async () => ({})) }));
// notify.ts pulls in the voice engines (browser-only at import).
vi.mock("@/features/reminders/notify", () => ({ useToasts: () => () => undefined }));

import { TradingDesk } from "./TradingDesk";

describe("TradingDesk renders the red E-stop through KillButton only", () => {
  it("passes the click counter and busy state, and no handler of its own", () => {
    renderToStaticMarkup(createElement(TradingDesk));
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0]).sort()).toEqual(["busy", "onPress", "pressed"]);
    expect(seen[0]).toMatchObject({ pressed: 0, busy: false });
    expect(typeof seen[0].onPress).toBe("function");
  });
});
