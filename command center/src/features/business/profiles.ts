/**
 * Business profiles (Settings → Business): one per business plus the Personal finance area,
 * stored on the local gateway (`/api/cc/business/profiles`, command_center_api.py) so desktop and
 * phone share them. Nothing here is sent anywhere else.
 *
 * Profile ids ARE the business-registry ids (business_registry.rs) plus `personal` (the finance
 * vault's untagged area, never a registry business), so Finance can key records on the same id.
 * Pure: the gateway round-trip lives in `profiles-store.ts`.
 */

export const PROFILE_IDS = ["acting", "trades_contracting", "supplements_ecom", "personal"] as const;
export type KnownProfileId = (typeof PROFILE_IDS)[number];
/** A registry business id or `personal`. */
export type ProfileId = KnownProfileId | (string & {});

export const PROFILE_LABEL: Record<KnownProfileId, string> = {
  acting: "Acting",
  trades_contracting: "Contracting",
  supplements_ecom: "BF Supplements",
  personal: "Personal",
};

/** Invoices take the profile of their area; until Finance tags records, that's Contracting. */
export const DEFAULT_INVOICE_AREA: KnownProfileId = "trades_contracting";

export type InvoiceStyle = "classic" | "modern" | "minimal";
export const INVOICE_STYLES: { id: InvoiceStyle; label: string }[] = [
  { id: "classic", label: "Classic (logo right, ruled lines)" },
  { id: "modern", label: "Modern (accent bar, bold total)" },
  { id: "minimal", label: "Minimal (no rules, small type)" },
];

/** An acting agency. A sub-agent (`parentId` set) books under its principal; a null rate inherits the principal's. */
export interface Agency {
  id: string;
  name: string;
  parentId: string | null;
  /** Commission % on union work (ACTRA / SAG-AFTRA), null = the principal's. */
  commissionUnion: number | null;
  /** Commission % on non-union work, null = the principal's. */
  commissionNonUnion: number | null;
}

export interface ContractingDefaults {
  /** How a subcontractor is paid by default: a flat amount per job or a % of the job. */
  subRateMode: "amount" | "percent";
  subRate: number;
  /** A new job's default: done by you, or subbed out. */
  defaultWork: "self" | "subbed";
}

export interface BusinessProfile {
  /** Legal business name, printed on invoices. */
  name: string;
  address: string;
  email: string;
  phone: string;
  hstNumber: string;
  /** Set only when Nic confirms the number is his real one; never printed without it. */
  hstConfirmed: boolean;
  province: string;
  taxRate: number;
  currency: "CAD" | "USD";
  /** A gateway file id (cc.upload), "" = no logo. */
  logoFileId: string;
  invoiceStyle: InvoiceStyle;
  agencies?: Agency[];
  contracting?: ContractingDefaults;
  /** Finance: the area's display name ("" / absent = the built-in name). Renameable; custom areas need one. */
  label?: string;
  /** Finance: how often this area files its HST return (only used once the HST number is confirmed). */
  hstPeriod?: HstPeriod;
  /** Finance: % of profit to set aside for income tax (an estimate, not advice). */
  setAsidePct?: number;
  /** Finance: invoice number prefix ("CON" → CON-2026-001). "" / absent = the area default. */
  invoicePrefix?: string;
}

export type HstPeriod = "monthly" | "quarterly" | "yearly";

/** Finance-wide settings kept with the profiles (one row on the gateway). */
export interface FinanceSettings {
  /** $ per km for the mileage log (your own number; CRA publishes the allowance yearly). */
  kmRate: number;
}

export const DEFAULT_FINANCE: FinanceSettings = { kmRate: 0.72 };

export interface ProfilesDoc {
  version: 1;
  /** The old single localStorage profile was copied in (once, across devices). */
  legacyImported: boolean;
  profiles: Record<string, BusinessProfile>;
  finance?: FinanceSettings;
  /** The gateway's revision of this doc (0 = never saved, or saved before revisions). A save must name it. */
  rev?: number;
}

/** The old `useSettings().business` shape. */
export interface LegacyBusiness {
  name: string;
  address: string;
  email: string;
  phone: string;
  hstNumber: string;
  province: string;
  hstRate: number;
  currency: string;
}

export const PROVINCES: [string, string, number][] = [
  ["ON", "Ontario — HST", 13], ["NS", "Nova Scotia — HST", 14], ["NB", "New Brunswick — HST", 15], ["NL", "Newfoundland — HST", 15], ["PE", "PEI — HST", 15],
  ["BC", "British Columbia — GST", 5], ["AB", "Alberta — GST", 5], ["SK", "Saskatchewan — GST", 5], ["MB", "Manitoba — GST", 5], ["QC", "Québec — GST", 5],
  ["YT", "Yukon — GST", 5], ["NT", "NWT — GST", 5], ["NU", "Nunavut — GST", 5],
];

export const taxLabel = (province: string) => (["ON", "NS", "NB", "NL", "PE"].includes(province) ? "HST" : "GST");

export const DEFAULT_AGENCIES: Agency[] = [
  { id: "imperious", name: "Imperious Inc.", parentId: null, commissionUnion: 15, commissionNonUnion: 20 },
  { id: "ml_talent", name: "ML Talent", parentId: "imperious", commissionUnion: null, commissionNonUnion: null },
];

export const DEFAULT_CONTRACTING: ContractingDefaults = { subRateMode: "percent", subRate: 0, defaultWork: "self" };

export function emptyProfile(id: ProfileId): BusinessProfile {
  const p: BusinessProfile = { name: "", address: "", email: "", phone: "", hstNumber: "", hstConfirmed: false, province: "ON", taxRate: 13, currency: "CAD", logoFileId: "", invoiceStyle: "classic" };
  if (id === "acting") p.agencies = DEFAULT_AGENCIES.map((a) => ({ ...a }));
  if (id === "trades_contracting") p.contracting = { ...DEFAULT_CONTRACTING };
  return p;
}

/** A stored doc (or none) with every known profile present and every field filled. */
export function withDefaults(doc: ProfilesDoc | null | undefined): ProfilesDoc {
  const profiles: Record<string, BusinessProfile> = {};
  const ids = [...PROFILE_IDS, ...Object.keys(doc?.profiles ?? {}).filter((k) => !(PROFILE_IDS as readonly string[]).includes(k))];
  for (const id of ids) {
    const base = emptyProfile(id);
    const got = doc?.profiles?.[id];
    profiles[id] = got ? { ...base, ...got, ...(base.agencies && !got.agencies ? { agencies: base.agencies } : {}), ...(base.contracting && !got.contracting ? { contracting: base.contracting } : {}) } : base;
  }
  const rev = typeof doc?.rev === "number" && Number.isInteger(doc.rev) && doc.rev >= 0 ? doc.rev : 0;
  return { version: 1, legacyImported: !!doc?.legacyImported, profiles, finance: { ...DEFAULT_FINANCE, ...(doc?.finance ?? {}) }, rev };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Fields of `mine` that differ from `base` (this device's unsaved edits) laid over `theirs`. */
function overlay<T extends object>(base: T | undefined, mine: T, theirs: T): T {
  const out = { ...theirs } as unknown as Record<string, unknown>;
  const b = (base ?? {}) as Record<string, unknown>;
  const m = mine as unknown as Record<string, unknown>;
  for (const k of new Set([...Object.keys(m), ...Object.keys(b)])) {
    if (same(m[k], b[k])) continue;
    if (m[k] === undefined) delete out[k];
    else out[k] = m[k];
  }
  return out as unknown as T;
}

/**
 * A stale save's three-way merge: this device's edits (`mine` against the `base` it started from)
 * applied per profile and per field over the newer doc another device saved (`theirs`). Untouched
 * fields take `theirs`; a field both changed takes this device's (the user's latest intent here).
 * The result carries `theirs`' rev, so it saves on top of it. Pure.
 */
export function mergeEdits(base: ProfilesDoc | null | undefined, mine: ProfilesDoc, theirs: ProfilesDoc | null | undefined): ProfilesDoc {
  const b = withDefaults(base);
  const m = withDefaults(mine);
  const t = withDefaults(theirs);
  const profiles: Record<string, BusinessProfile> = { ...t.profiles };
  for (const [id, mp] of Object.entries(m.profiles)) {
    const tp = t.profiles[id];
    // A profile new on this device (a custom area) has no base: every field of it is an edit.
    profiles[id] = tp ? overlay(b.profiles[id], mp, tp) : mp;
  }
  return {
    version: 1,
    legacyImported: t.legacyImported || m.legacyImported,
    profiles,
    finance: overlay(b.finance, m.finance!, t.finance!),
    rev: t.rev,
  };
}

/** Which profile the old single profile belongs to: Contracting unless its name says otherwise. */
export function legacyTarget(name: string): KnownProfileId {
  const n = name.toLowerCase();
  if (/\b(bf|born fortuna|supplements?|nutrition)\b/.test(n)) return "supplements_ecom";
  if (/\b(acting|actor|actress|talent|productions?)\b/.test(n)) return "acting";
  return "trades_contracting";
}

const textOf = (b: Pick<LegacyBusiness, "name" | "address" | "email" | "phone" | "hstNumber">) => [b.name, b.address, b.email, b.phone, b.hstNumber];
const hasContent = (b: LegacyBusiness | null | undefined): b is LegacyBusiness => !!b && textOf(b).some((v) => (v ?? "").trim());
/** A profile someone already filled in (on any device). */
export const profileHasContent = (p: BusinessProfile | null | undefined): boolean => !!p && textOf(p).some((v) => (v ?? "").trim());

/**
 * The one-time import of the old localStorage profile. `changed` = save the result. A doc already
 * marked `legacyImported` is returned as-is (another device did it, or it ran before).
 *
 * Only a device that actually HAS old details uses the import up: a device with nothing to import
 * (the phone: another origin, so an empty localStorage) leaves the doc alone, so the desktop's
 * real profile still gets copied the next time it loads. A target profile that already has content
 * (newer, entered in Settings → Business) is never overwritten: the import is just marked done.
 * The imported HST number is NOT confirmed: it may well be the placeholder.
 */
export function importLegacy(doc: ProfilesDoc | null | undefined, legacy: LegacyBusiness | null | undefined): { doc: ProfilesDoc; changed: boolean; target: KnownProfileId | null } {
  const full = withDefaults(doc);
  if (doc?.legacyImported) return { doc: full, changed: false, target: null };
  if (!hasContent(legacy)) return { doc: full, changed: false, target: null };
  const target = legacyTarget(legacy.name);
  const cur = full.profiles[target];
  if (profileHasContent(cur)) return { doc: { ...full, legacyImported: true }, changed: true, target: null };
  const t = (v: string) => (v ?? "").trim();
  const province = PROVINCES.some((p) => p[0] === legacy.province) ? legacy.province : cur.province;
  full.profiles[target] = {
    ...cur,
    name: t(legacy.name),
    address: t(legacy.address),
    email: t(legacy.email),
    phone: t(legacy.phone),
    hstNumber: t(legacy.hstNumber),
    hstConfirmed: false,
    province,
    taxRate: Number.isFinite(legacy.hstRate) && legacy.hstRate >= 0 && legacy.hstRate <= 30 ? legacy.hstRate : cur.taxRate,
    currency: legacy.currency === "USD" ? "USD" : "CAD",
  };
  return { doc: { ...full, legacyImported: true }, changed: true, target };
}

// ── HST / GST number check ──────────────────────────────────────────────────

export const HST_PLACEHOLDER = "123456789 RT0001";

export type HstCheck = { ok: true; formatted: string } | { ok: false; reason: string; empty?: boolean };

/**
 * A CRA GST/HST account: 9-digit business number + "RT" + 4-digit account ("123456789 RT0001").
 * Flags the placeholder, all-same digits and anything not 9 digits + RT + 4 digits.
 */
export function checkHstNumber(raw: string): HstCheck {
  const s = (raw ?? "").toUpperCase().replace(/[\s-]/g, "");
  if (!s) return { ok: false, reason: "No number entered", empty: true };
  const m = /^(\d{9})RT(\d{4})$/.exec(s);
  if (!m) return { ok: false, reason: "Should be 9 digits, then RT and 4 digits (e.g. 8xxxxxxxx RT0001)" };
  const [, bn, acct] = m;
  if (bn === "123456789" || `${bn} RT${acct}` === HST_PLACEHOLDER) return { ok: false, reason: "That's the example number, not yours" };
  if (/^(\d)\1{8}$/.test(bn)) return { ok: false, reason: "All the same digit: that's not a real business number" };
  if (acct === "0000") return { ok: false, reason: "The account part (after RT) is never 0000" };
  return { ok: true, formatted: `${bn} RT${acct}` };
}

/** The number to print, or null: only a well-formed number Nic has confirmed. */
export function printableHst(p: Pick<BusinessProfile, "hstNumber" | "hstConfirmed">): string | null {
  if (!p.hstConfirmed) return null;
  const c = checkHstNumber(p.hstNumber);
  return c.ok ? c.formatted : null;
}

// ── Acting: agency commission ───────────────────────────────────────────────

/**
 * The default commission % for a booking through `agencyId` (union or not): the agency's own
 * rate, else its principal's, else null (unknown agency / no rate set). Pure.
 */
export function commissionFrom(agencies: readonly Agency[] | undefined, agencyId: string, union: boolean): number | null {
  const list = agencies ?? [];
  const rate = (a: Agency) => (union ? a.commissionUnion : a.commissionNonUnion);
  let a = list.find((x) => x.id === agencyId);
  for (let hops = 0; a && hops < 3; hops++) {
    const r = rate(a);
    if (typeof r === "number" && Number.isFinite(r)) return r;
    a = a.parentId ? list.find((x) => x.id === a!.parentId) : undefined;
  }
  return null;
}

/** "imperious" from "Imperious Inc.", unique against `taken`. */
export function agencyIdFor(name: string, taken: readonly string[]): string {
  let base = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^[^a-z]+/, "").slice(0, 28) || "agency";
  if (base.length < 2) base = `${base}_a`;
  let id = base;
  for (let i = 2; taken.includes(id); i++) id = `${base}_${i}`;
  return id;
}

/** The profile an invoice / record of `area` prints with (unknown or missing area → Contracting). */
export function profileForArea(doc: ProfilesDoc | null | undefined, area?: string | null): BusinessProfile {
  const full = withDefaults(doc);
  return full.profiles[area && full.profiles[area] ? area : DEFAULT_INVOICE_AREA];
}
