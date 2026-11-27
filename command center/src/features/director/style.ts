/**
 * Part 6 style memory (page side). Rust (director_style.rs) records one entry of style facts per
 * sign-off (Approve final, note resolves) in <projects root>/style-profile.json; this file turns the
 * last entries into ONE short "STYLE …" line for the Director's context (≤ STYLE_LINE_MAX chars,
 * inside CONTEXT_BUDGET: it takes room from the TRANSCRIPT section, never adds to the budget).
 * Every call fails quietly: no profile = no line.
 */
import { api } from "./api";
import type { StyleEntry, StyleKind, StyleProfile } from "./contract";

export const STYLE_LINE_MAX = 200;

const r1 = (n: number) => Math.round(n * 10) / 10;

/** Values by how often they occur, most first (ties: most recent first). */
function ranked(values: string[]): { v: string; n: number }[] {
  const m = new Map<string, { n: number; last: number }>();
  values.forEach((v, i) => {
    if (!v) return;
    const e = m.get(v) ?? { n: 0, last: -1 };
    m.set(v, { n: e.n + 1, last: i });
  });
  return [...m.entries()].sort((a, b) => b[1].n - a[1].n || b[1].last - a[1].last).map(([v, { n }]) => ({ v, n }));
}

function median(xs: number[]): number {
  const s = xs.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (!s.length) return 0;
  const k = Math.floor(s.length / 2);
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
}

/** The one-line summary of the profile (pure): "" with no entries; never over STYLE_LINE_MAX. */
export function styleLine(profile: Pick<StyleProfile, "entries"> | null | undefined): string {
  const es: StyleEntry[] = (profile?.entries ?? []).slice(-20);
  if (!es.length) return "";
  const plat = ranked(es.map((e) => e.platform)).slice(0, 2).map((x) => (x.n > 1 ? `${x.v} ×${x.n}` : x.v));
  const len = median(es.map((e) => e.lengthSec));
  const paced = es.filter((e) => e.clips > 0 && e.avgClipSec > 0);
  const pace = paced.length ? paced.reduce((t, e) => t + e.avgClipSec, 0) / paced.length : 0;
  const cap = ranked(es.map((e) => e.captions))[0]?.v;
  const look = ranked(es.map((e) => e.color))[0]?.v;
  const fit = ranked(es.flatMap((e) => e.fits))[0]?.v;
  const themes = ranked(es.flatMap((e) => e.themes)).slice(0, 3).map((x) => x.v);
  const bits = [
    plat.length ? plat.join(", ") : "",
    len ? `~${Math.round(len)}s` : "",
    pace ? `clips avg ${r1(pace)}s` : "",
    cap ? `captions ${cap}` : "",
    look && look !== "none" ? `look ${look}` : "",
    fit ? `fit ${fit}` : "",
    themes.length ? `notes often on ${themes.join(", ")}` : "",
  ].filter(Boolean);
  const line = `STYLE (${es.length} past sign-off${es.length === 1 ? "" : "s"}; the brief wins): ${bits.join(" · ")}`;
  return line.length <= STYLE_LINE_MAX ? line : `${line.slice(0, STYLE_LINE_MAX - 1)}…`;
}

// ── Cached line + the two IPC calls (fail quietly) ──────────────────────────────

let cached: string | null = null;
/** Bumped by every read or record; only the newest call may write `cached` (IPC can return out of order). */
let seq = 0;

/** For tests. */
export function resetStyleCache() {
  cached = null;
  seq++;
}

/** The STYLE line for a Director turn: read once, then refreshed by each record. "" when unknown. */
export async function styleLineFor(): Promise<string> {
  if (cached !== null) return cached;
  const fn = (api as { styleGet?: () => Promise<StyleProfile> }).styleGet;
  if (typeof fn !== "function") return "";
  const my = ++seq;
  try {
    const line = styleLine(await fn());
    if (my === seq) cached = line;
    return cached ?? line;
  } catch {
    return cached ?? "";
  }
}

/** After Nic's Approve final or note resolve: one entry (Rust derives the facts). Never throws. */
export async function recordStyle(slug: string, kind: StyleKind): Promise<void> {
  const fn = (api as { styleRecord?: (a: { slug: string; kind: StyleKind }) => Promise<StyleProfile> }).styleRecord;
  if (typeof fn !== "function") return;
  const my = ++seq;
  try {
    const line = styleLine(await fn({ slug, kind }));
    if (my === seq) cached = line;
  } catch {
    /* style memory is a nicety; a failed record changes nothing else */
  }
}
