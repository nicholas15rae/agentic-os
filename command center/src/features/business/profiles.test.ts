import { describe, expect, it } from "vitest";
import { agencyIdFor, checkHstNumber, commissionFrom, DEFAULT_AGENCIES, emptyProfile, importLegacy, legacyTarget, printableHst, profileForArea, withDefaults, type LegacyBusiness, type ProfilesDoc } from "./profiles";

const legacy = (patch: Partial<LegacyBusiness> = {}): LegacyBusiness => ({ name: "", address: "", email: "", phone: "", hstNumber: "", province: "ON", hstRate: 13, currency: "CAD", ...patch });

describe("business profiles", () => {
  it("every known profile exists, with per-business extras", () => {
    const d = withDefaults(null);
    expect(Object.keys(d.profiles)).toEqual(["acting", "trades_contracting", "supplements_ecom", "personal"]);
    expect(d.profiles.acting.agencies?.map((a) => a.name)).toEqual(["Imperious Inc.", "ML Talent"]);
    expect(d.profiles.trades_contracting.contracting).toEqual({ subRateMode: "percent", subRate: 0, defaultWork: "self" });
    expect(d.profiles.personal.agencies).toBeUndefined();
    expect(d.legacyImported).toBe(false);
    // A stored extra business profile is kept.
    expect(Object.keys(withDefaults({ version: 1, legacyImported: true, profiles: { bakery: emptyProfile("bakery") } }).profiles)).toContain("bakery");
  });

  it("imports the old single profile once, into Contracting unless the name says otherwise", () => {
    expect(legacyTarget("Nic Rae Masonry")).toBe("trades_contracting");
    expect(legacyTarget("")).toBe("trades_contracting");
    expect(legacyTarget("BF Supplements Inc.")).toBe("supplements_ecom");
    expect(legacyTarget("Born Fortuna")).toBe("supplements_ecom");
    expect(legacyTarget("Nic Rae Acting")).toBe("acting");

    const r = importLegacy(null, legacy({ name: "Rae Contracting", email: "nic@x.ca", hstNumber: "123456789 RT0001", hstRate: 13 }));
    expect(r.changed).toBe(true);
    expect(r.target).toBe("trades_contracting");
    const c = r.doc.profiles.trades_contracting;
    expect([c.name, c.email, c.hstNumber, c.hstConfirmed, c.taxRate]).toEqual(["Rae Contracting", "nic@x.ca", "123456789 RT0001", false, 13]);
    expect(r.doc.profiles.acting.name).toBe("");
    expect(r.doc.legacyImported).toBe(true);
    // Second time (or another device): untouched.
    const again = importLegacy(r.doc, legacy({ name: "Something else" }));
    expect(again.changed).toBe(false);
    expect(again.doc.profiles.trades_contracting.name).toBe("Rae Contracting");
    // Nothing to import: just marked done.
    const empty = importLegacy(null, legacy());
    expect([empty.changed, empty.target, empty.doc.legacyImported]).toEqual([true, null, true]);
    // A filled target field wins over the old one.
    const pre: ProfilesDoc = { ...withDefaults(null), legacyImported: false };
    pre.profiles.trades_contracting.name = "Already set";
    expect(importLegacy(pre, legacy({ name: "Old", phone: "555" })).doc.profiles.trades_contracting).toMatchObject({ name: "Already set", phone: "555" });
  });

  it("flags placeholder and malformed HST numbers, and never prints an unconfirmed one", () => {
    expect(checkHstNumber("123456789 RT0001")).toMatchObject({ ok: false });
    expect(checkHstNumber("123456789RT0002")).toMatchObject({ ok: false });
    expect(checkHstNumber("111111111 RT0001")).toMatchObject({ ok: false });
    expect(checkHstNumber("12345678 RT0001")).toMatchObject({ ok: false });
    expect(checkHstNumber("812345678 RC0001")).toMatchObject({ ok: false });
    expect(checkHstNumber("812345678 RT001")).toMatchObject({ ok: false });
    expect(checkHstNumber("812345678 RT0000")).toMatchObject({ ok: false });
    expect(checkHstNumber("")).toMatchObject({ ok: false, empty: true });
    expect(checkHstNumber(" 812-345-678 rt0001 ")).toEqual({ ok: true, formatted: "812345678 RT0001" });

    expect(printableHst({ hstNumber: "812345678RT0001", hstConfirmed: false })).toBeNull();
    expect(printableHst({ hstNumber: "812345678RT0001", hstConfirmed: true })).toBe("812345678 RT0001");
    expect(printableHst({ hstNumber: "123456789 RT0001", hstConfirmed: true })).toBeNull();
  });

  it("default commission: own rate, else the principal's", () => {
    expect(commissionFrom(DEFAULT_AGENCIES, "imperious", true)).toBe(15);
    expect(commissionFrom(DEFAULT_AGENCIES, "imperious", false)).toBe(20);
    expect(commissionFrom(DEFAULT_AGENCIES, "ml_talent", false)).toBe(20);
    const custom = DEFAULT_AGENCIES.map((a) => (a.id === "ml_talent" ? { ...a, commissionNonUnion: 0 } : a));
    expect(commissionFrom(custom, "ml_talent", false)).toBe(0);
    expect(commissionFrom(custom, "ml_talent", true)).toBe(15);
    expect(commissionFrom(DEFAULT_AGENCIES, "nobody", true)).toBeNull();
    expect(commissionFrom(undefined, "imperious", true)).toBeNull();
    expect(agencyIdFor("Imperious Inc.", ["imperious"])).toBe("imperious_inc");
    expect(agencyIdFor("ML Talent", ["ml_talent"])).toBe("ml_talent_2");
    expect(agencyIdFor("!!", [])).toBe("agency");
  });

  it("invoices take their area's profile, Contracting by default", () => {
    const d = withDefaults(null);
    d.profiles.trades_contracting.name = "Contracting Co";
    d.profiles.acting.name = "Acting Co";
    expect(profileForArea(d).name).toBe("Contracting Co");
    expect(profileForArea(d, "acting").name).toBe("Acting Co");
    expect(profileForArea(d, "unknown_area").name).toBe("Contracting Co");
  });
});
