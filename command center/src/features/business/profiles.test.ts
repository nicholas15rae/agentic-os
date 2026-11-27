import { describe, expect, it } from "vitest";
import { agencyIdFor, checkHstNumber, commissionFrom, DEFAULT_AGENCIES, emptyProfile, importLegacy, legacyTarget, mergeEdits, printableHst, profileForArea, withDefaults, type LegacyBusiness, type ProfilesDoc } from "./profiles";

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
    // Nothing to import (the phone: another origin, empty localStorage): the import is NOT used up.
    const empty = importLegacy(null, legacy());
    expect([empty.changed, empty.target, empty.doc.legacyImported]).toEqual([false, null, false]);
    expect(importLegacy(null, null).changed).toBe(false);
    // ...so the desktop, loading later with its real old profile, still copies it in.
    const desktop = importLegacy(empty.doc, legacy({ name: "Rae Masonry", phone: "555" }));
    expect([desktop.changed, desktop.target, desktop.doc.legacyImported, desktop.doc.profiles.trades_contracting.name]).toEqual([true, "trades_contracting", true, "Rae Masonry"]);
    // A target profile that already has (newer) content is never overwritten: just marked done.
    const pre: ProfilesDoc = { ...withDefaults(null), legacyImported: false };
    pre.profiles.trades_contracting.name = "Already set";
    pre.profiles.trades_contracting.taxRate = 5;
    const kept = importLegacy(pre, legacy({ name: "Old", phone: "555", hstRate: 13 }));
    expect([kept.changed, kept.target, kept.doc.legacyImported]).toEqual([true, null, true]);
    expect(kept.doc.profiles.trades_contracting).toMatchObject({ name: "Already set", phone: "", taxRate: 5 });
  });

  it("merges this device's edits per profile and per field over a newer doc", () => {
    const base = withDefaults({ version: 1, legacyImported: true, profiles: {}, rev: 3 });
    base.profiles.acting.name = "Acting";
    base.profiles.trades_contracting.name = "Masonry";
    // This device: changed Acting's phone and the km rate, added an area.
    const mine = structuredClone(base);
    mine.profiles.acting.phone = "555-1234";
    mine.finance = { kmRate: 0.7 };
    mine.profiles.rentals = { ...emptyProfile("rentals"), label: "Rentals" };
    // Another device (saved meanwhile): renamed Acting, filled Contracting's email.
    const theirs = structuredClone(base);
    theirs.rev = 5;
    theirs.profiles.acting.name = "Nic Rae Acting";
    theirs.profiles.trades_contracting.email = "nic@x.ca";
    const m = mergeEdits(base, mine, theirs);
    expect(m.rev).toBe(5);
    expect(m.profiles.acting).toMatchObject({ name: "Nic Rae Acting", phone: "555-1234" });
    expect(m.profiles.trades_contracting).toMatchObject({ name: "Masonry", email: "nic@x.ca" });
    expect(m.profiles.rentals.label).toBe("Rentals");
    expect(m.finance).toEqual({ kmRate: 0.7 });
    // Both changed the same field: this device's edit wins.
    const both = structuredClone(mine);
    both.profiles.acting.name = "Mine";
    expect(mergeEdits(base, both, theirs).profiles.acting.name).toBe("Mine");
    // No edits here: exactly theirs.
    expect(mergeEdits(base, base, theirs)).toEqual(withDefaults(theirs));
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
