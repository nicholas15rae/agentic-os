import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BADGE_MAX_TICKERS, badgeLabel, badgeName, badgeStatus, badgeTickers, clipText, statusText, tickerValue } from "./badge-format";
import { GabagoulBadge } from "./GabagoulBadge";

describe("GABAGOUL badge helpers", () => {
  it("defaults to ONTARIO // GABAGOUL and caps custom names", () => {
    expect(badgeName(undefined)).toEqual({ region: "ONTARIO", callsign: "GABAGOUL" });
    expect(badgeName({ region: "  ", callsign: "" })).toEqual({ region: "ONTARIO", callsign: "GABAGOUL" });
    expect(badgeName({ region: "Quebec", callsign: "E46" })).toEqual({ region: "Quebec", callsign: "E46" });
    expect(badgeName({ callsign: "A".repeat(40) }).callsign).toHaveLength(16);
  });

  it("cleans free text to one capped line", () => {
    expect(clipText("a\n\tb\u0007c", 20)).toBe("a b c");
    expect(clipText("abcdefgh", 5)).toBe("abcd…");
    expect(clipText(null, 5)).toBe("");
    expect(clipText("<b>x</b>", 20)).toBe("<b>x</b>"); // text, rendered escaped by React
  });

  it("formats ticker values, null for no source", () => {
    expect(tickerValue(2400, "rpm")).toBe("2400 rpm");
    expect(tickerValue(13.66, "V")).toBe("13.7 V");
    expect(tickerValue("open")).toBe("open");
    expect(tickerValue(null, "V")).toBeNull();
    expect(tickerValue(NaN)).toBeNull();
    expect(tickerValue("   ")).toBeNull();
  });

  it("keeps at most three tickers with unique ids", () => {
    const t = (id: string) => ({ id, label: id, value: 1 });
    const out = badgeTickers([t("a"), t("a"), t("b"), t("c"), t("d")]);
    expect(out.map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(out).toHaveLength(BADGE_MAX_TICKERS);
    expect(badgeTickers(undefined)).toEqual([]);
    expect(badgeTickers([{ id: "x", label: "Coolant", value: null }])[0]).toMatchObject({ value: null, why: "No live source", tone: null });
  });

  it("derives the default status from the services count", () => {
    expect(badgeStatus(null)).toBeNull();
    expect(badgeStatus({ servicesUp: 3, servicesTotal: 3 })).toEqual({ tone: "ok", text: "3/3 online" });
    expect(badgeStatus({ servicesUp: 1, servicesTotal: 3 })?.tone).toBe("warn");
    expect(badgeStatus({ servicesUp: 0, servicesTotal: 3 })?.tone).toBe("down");
    expect(badgeStatus({ servicesUp: 0, servicesTotal: 0 })).toEqual({ tone: "idle", text: "No services" });
    expect(statusText(null)).toBeNull();
    expect(statusText({ tone: "ok", text: "x".repeat(40) })).toHaveLength(24);
  });

  it("builds the accessible name", () => {
    const name = badgeName(undefined);
    expect(badgeLabel(name, null, [])).toBe("ONTARIO // GABAGOUL");
    expect(badgeLabel(name, "3/3 online", badgeTickers([{ id: "rpm", label: "RPM", value: null }]))).toBe("ONTARIO // GABAGOUL — 3/3 online · RPM unavailable");
  });
});

describe("GabagoulBadge", () => {
  it("renders text only, with no leader-line anchor and no pointer events", () => {
    const html = renderToStaticMarkup(createElement(GabagoulBadge, { state: { status: { tone: "ok", text: "<i>ok</i>" }, tickers: [{ id: "v", label: "Batt", value: 12.6, unit: "V" }], source: "obd" } }));
    expect(html).toContain("ONTARIO");
    expect(html).toContain("GABAGOUL");
    expect(html).toContain("12.6 V");
    expect(html).toContain("&lt;i&gt;ok&lt;/i&gt;");
    expect(html).not.toContain("data-zone");
    expect(html).not.toContain("backdrop");
    expect(html).toContain("pointer-events-none");
  });
});
