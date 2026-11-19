import type { SnapSummary } from "@/lib/platform";
import type { Tone } from "./format";

/**
 * The GABAGOUL HUD badge's prop contract and pure helpers (unit-tested in badge-format.test.ts).
 * Phase 3 binds live telemetry / OBD-II here: every field is free text from an outside source,
 * so it is cleaned and capped before rendering (as text only, never HTML).
 */

export type BadgeTone = Tone;
export type BadgeSource = "static" | "telemetry" | "obd" | "custom";

export interface BadgeTicker {
  id: string;
  label: string;
  /** null = no live source: rendered as "—" with `why` as the reason. */
  value: string | number | null;
  unit?: string;
  tone?: BadgeTone;
  why?: string;
}

export interface BadgeStatus {
  tone: BadgeTone;
  text: string;
}

export interface GabagoulBadgeState {
  region?: string;
  callsign?: string;
  /** undefined = derive from the System Map snapshot; null = no status (a "—"). */
  status?: BadgeStatus | null;
  tickers?: BadgeTicker[];
  source?: BadgeSource;
}

export const BADGE_REGION = "ONTARIO";
export const BADGE_CALLSIGN = "GABAGOUL";
export const BADGE_MAX_TICKERS = 3;
const NAME_MAX = 16;
const LABEL_MAX = 10;
const VALUE_MAX = 12;
const STATUS_MAX = 24;

/** Single-line display text: control characters dropped, whitespace collapsed, capped with "…". */
export function clipText(s: unknown, max: number): string {
  if (s == null) return "";
  // eslint-disable-next-line no-control-regex
  const t = String(s).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, Math.max(1, max - 1)).trimEnd()}…` : t;
}

/** The main line's two halves; a blank or missing value falls back to ONTARIO // GABAGOUL. */
export function badgeName(state: Pick<GabagoulBadgeState, "region" | "callsign"> | undefined): { region: string; callsign: string } {
  return { region: clipText(state?.region, NAME_MAX) || BADGE_REGION, callsign: clipText(state?.callsign, NAME_MAX) || BADGE_CALLSIGN };
}

/** "42 %", "3.1 V", "OPEN"; null for a missing / non-finite value (shown as a Dash). */
export function tickerValue(value: BadgeTicker["value"], unit?: string): string | null {
  if (value == null) return null;
  let v: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    v = Number.isInteger(value) ? String(value) : value.toFixed(1);
  } else {
    v = clipText(value, VALUE_MAX);
    if (!v) return null;
  }
  const u = clipText(unit, 4);
  return clipText(u ? `${v} ${u}` : v, VALUE_MAX);
}

export interface ShownTicker {
  id: string;
  label: string;
  value: string | null;
  tone: BadgeTone | null;
  why: string;
}

/** At most three tickers, cleaned for display; ids de-duplicated so React keys stay stable. */
export function badgeTickers(list: readonly BadgeTicker[] | undefined): ShownTicker[] {
  const seen = new Set<string>();
  const out: ShownTicker[] = [];
  for (const t of list ?? []) {
    if (out.length >= BADGE_MAX_TICKERS) break;
    const id = clipText(t.id, 32) || `t${out.length}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: clipText(t.label, LABEL_MAX) || "—", value: tickerValue(t.value, t.unit), tone: t.tone ?? null, why: clipText(t.why, 80) || "No live source" });
  }
  return out;
}

/** The default status from the shared System Map snapshot: services online. Null before the first snapshot. */
export function badgeStatus(summary: Pick<SnapSummary, "servicesUp" | "servicesTotal"> | null): BadgeStatus | null {
  if (!summary) return null;
  const { servicesUp: up, servicesTotal: total } = summary;
  if (total <= 0) return { tone: "idle", text: "No services" };
  const tone: BadgeTone = up >= total ? "ok" : up <= 0 ? "down" : "warn";
  return { tone, text: `${up}/${total} online` };
}

/** Status text as shown (capped), or null. */
export function statusText(s: BadgeStatus | null | undefined): string | null {
  return clipText(s?.text, STATUS_MAX) || null;
}

/** The badge's accessible name: "ONTARIO // GABAGOUL — 3/3 online · RPM 2400". */
export function badgeLabel(name: { region: string; callsign: string }, status: string | null, tickers: readonly ShownTicker[]): string {
  const parts = [status, ...tickers.map((t) => `${t.label} ${t.value ?? "unavailable"}`)].filter(Boolean);
  return `${name.region} // ${name.callsign}${parts.length ? ` — ${parts.join(" · ")}` : ""}`;
}
