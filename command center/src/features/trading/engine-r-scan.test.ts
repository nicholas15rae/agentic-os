// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/gateway", () => ({ GatewayError: class extends Error {}, gateway: vi.fn(async () => ({})) }));
// notify.ts pulls in the voice engines (browser-only at import); the scan table doesn't toast.
vi.mock("@/features/reminders/notify", () => ({ useToasts: () => () => undefined }));

import type { OrderIntent } from "./ibkr";
import type { RuleScan, RuleScanRow } from "./EngineRPanel.contract";
import { DESK_REFUSED, scanRowView } from "./engine-r-format";
import { ScanSection } from "./EngineRPanel";

const intent = (symbol: string): OrderIntent => ({
  intent_id: `re-${symbol}`, source: "rule_engine", asset_class: "etf", symbol, action: "BUY", quantity: 5, order_type: "LMT",
  stop_loss: 590, limit_price: 600, take_profit: 620, time_in_force: "DAY", thesis: "t", citations: [], currency: "USD", created_at: 0,
});
const sent = (symbol: string, status: string, why = "trend breakout"): RuleScanRow => ({
  symbol, action: "submitted", why, intent: intent(symbol), desk: { status, verdict: "APPROVED", reasons: [], error: null },
});

describe("scan rows: a desk-refused order never reads as a trade", () => {
  it("labels refused rows with the desk's verdict, in the alert tone", () => {
    for (const st of ["failed", "rejected", "expired", "dismissed"])
      expect(scanRowView(sent("SPY", st))).toEqual({ label: `desk ${st}`, tone: "text-alert", refused: true });
    for (const st of ["submitted", "hypothetical", "pending_approval"])
      expect(scanRowView(sent("SPY", st))).toEqual({ label: "submitted", tone: "text-teal-soft", refused: false });
    expect(scanRowView({ action: "would_submit" })).toEqual({ label: "would submit", tone: "text-teal-soft", refused: false });
    expect(scanRowView({ action: "limit_block" }).tone).toBe("text-alert");
    expect(scanRowView({ action: "submitted" }).refused).toBe(false); // no desk result yet: not called refused
  });

  it("matches the Python side's list of no-trade desk statuses", () => {
    const py = readFileSync(fileURLToPath(new URL("../../../../trading/rule_engine.py", import.meta.url)), "utf8");
    const m = /^ENTRY_STATUSES_EXCLUDED = \(([^)]*)\)/m.exec(py);
    expect(m).not.toBeNull();
    const statuses = [...m![1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]).sort();
    expect([...DESK_REFUSED].sort()).toEqual(statuses);
  });

  it("the panel's scan table renders the refusal, strikes the order line, keeps accepted rows as they were", () => {
    const scan: RuleScan = {
      scanId: "s", kind: "slot", at: 1_764_000_000, version: 1, submit: true, status: "done", detail: "", finished: 1_764_000_010,
      rows: [sent("SPY", "failed", "desk failed: TWS rejected the order: Warning 321: Read-Only"), sent("QQQ", "submitted")],
    };
    const html = renderToStaticMarkup(createElement(ScanSection, { scan }));
    const spy = html.slice(html.indexOf(">SPY<"), html.indexOf(">QQQ<"));
    const qqq = html.slice(html.indexOf(">QQQ<"));
    expect(spy).toContain('class="text-alert">desk failed<');
    expect(spy).toContain("line-through");
    expect(spy).toContain("Not sent: the desk refused it");
    expect(spy).toContain("Read-Only");
    expect(qqq).toContain('class="text-teal-soft">submitted<');
    expect(qqq).not.toContain("line-through");
  });
});
