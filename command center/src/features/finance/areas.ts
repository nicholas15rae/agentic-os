/**
 * Finance areas: Acting, Contracting, BF Supplements, Personal, plus any you add. An area IS a
 * business-profile id (src/features/business/profiles.ts), so a record's `area` picks the profile
 * its invoice prints with and its tax view uses. Records with no area are "Untagged". Pure.
 */
import { PROFILE_IDS, PROFILE_LABEL, agencyIdFor, type KnownProfileId, type ProfilesDoc } from "@/features/business/profiles";
import type { Tagged } from "./types";

export const UNTAGGED = "untagged";

export interface AreaInfo {
  id: string;
  label: string;
  /** One of the four built-in areas (can be renamed, not removed). */
  builtIn: boolean;
  /** A business (not Personal): counts towards HST and the small-supplier threshold. */
  business: boolean;
}

/** Every area in the profiles doc, built-ins first, in a stable order. */
export function listAreas(doc: ProfilesDoc | null | undefined): AreaInfo[] {
  const ids = [...PROFILE_IDS, ...Object.keys(doc?.profiles ?? {}).filter((k) => !(PROFILE_IDS as readonly string[]).includes(k))];
  return ids.map((id) => ({ id, label: areaLabel(doc, id), builtIn: (PROFILE_IDS as readonly string[]).includes(id), business: id !== "personal" }));
}

export function areaLabel(doc: ProfilesDoc | null | undefined, id: string | undefined | null): string {
  if (!id || id === UNTAGGED) return "Untagged";
  const custom = doc?.profiles?.[id]?.label?.trim();
  if (custom) return custom;
  return PROFILE_LABEL[id as KnownProfileId] ?? id.replace(/_/g, " ");
}

/** A new area's id from its name ("Rentals" → "rentals"), unique and never "untagged". */
export function newAreaId(name: string, doc: ProfilesDoc | null | undefined): string {
  return agencyIdFor(name, [...Object.keys(doc?.profiles ?? {}), UNTAGGED, ...PROFILE_IDS]);
}

/** The record's area, or "untagged". */
export const areaOf = (r: Tagged): string => (r.area && r.area.trim() ? r.area : UNTAGGED);

// ── Filters (area, agent, month, year) ──────────────────────────────────────

export interface FinanceFilter {
  /** "all" or an area id (or "untagged"). */
  area: string;
  /** "all" or an agency id (Acting only). */
  agent: string;
  /** "all" or "01".."12". */
  month: string;
  /** "all" or "2026". */
  year: string;
}

export const ALL_FILTER: FinanceFilter = { area: "all", agent: "all", month: "all", year: "all" };

/** A record's date as YYYY-MM-DD, whichever field it keeps it in. */
export function isoOf(r: Record<string, unknown>): string {
  for (const k of ["date", "receivedAt", "issuedAt", "paidAt"]) {
    const v = r[k];
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return localIso(v);
  }
  return "";
}

export const localIso = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function matchesFilter(r: Tagged & Record<string, unknown>, f: FinanceFilter): boolean {
  if (f.area !== "all" && areaOf(r) !== f.area) return false;
  if (f.agent !== "all" && r.agentId !== f.agent) return false;
  if (f.year !== "all" || f.month !== "all") {
    const iso = isoOf(r);
    if (f.year !== "all" && iso.slice(0, 4) !== f.year) return false;
    if (f.month !== "all" && iso.slice(5, 7) !== f.month) return false;
  }
  return true;
}

export function applyFilter<T extends Tagged>(rows: readonly T[], f: FinanceFilter): T[] {
  return rows.filter((r) => matchesFilter(r as T & Record<string, unknown>, f));
}

/** Years present in the records (newest first) plus this year. */
export function yearsIn(rows: readonly Record<string, unknown>[], now = Date.now()): string[] {
  const ys = new Set<string>([String(new Date(now).getFullYear())]);
  for (const r of rows) {
    const y = isoOf(r).slice(0, 4);
    if (y) ys.add(y);
  }
  return [...ys].sort().reverse();
}

export const MONTHS = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"];
export const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
