/**
 * Pure formatting for the memory hygiene UI: the "Hygiene & Buffer Pressure" bar, the vault
 * lifecycle cadence and the Memory Scrolls threshold presets / idle badge. No I/O.
 */
import type { BufferPressure, IdleBadge, LifecycleCadence, ScrollsPreset } from "@/lib/platform";

/** hygiene.rs `PRESETS`: (KB, turns). */
export const SCROLLS_PRESETS: { id: ScrollsPreset; label: string; kb: number; turns: number }[] = [
  { id: "tight", label: "Tight", kb: 25, turns: 15 },
  { id: "balanced", label: "Balanced", kb: 50, turns: 25 },
  { id: "relaxed", label: "Relaxed", kb: 100, turns: 50 },
];

export function presetOf(kb: number, turns: number): ScrollsPreset | null {
  return SCROLLS_PRESETS.find((p) => p.kb === kb && p.turns === turns)?.id ?? null;
}

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

const hh = (h: number) => `${String(Math.min(23, Math.max(0, Math.round(h)))).padStart(2, "0")}:00`;

/** "Daily at 03:00", "Weekly · Sunday 03:00", "Monthly · 1st at 03:00". */
export function cadenceLabel(c: LifecycleCadence, hour: number, weekday: number): string {
  if (c === "daily") return `Daily at ${hh(hour)}`;
  if (c === "weekly") return `Weekly · ${WEEKDAYS[((weekday % 7) + 7) % 7]} ${hh(hour)}`;
  return `Monthly · 1st at ${hh(hour)}`;
}

/** The period a scheduled run harvests. */
export function cadencePeriod(c: LifecycleCadence): string {
  return c === "daily" ? "the previous day" : c === "weekly" ? "the previous week" : "the previous month";
}

/** Relative time for unix secs: "just now", "5m ago", "in 3h", "in 2d"; "—" when unknown. */
export function relTime(secs: number | null | undefined, nowMs = Date.now()): string {
  if (!secs || !Number.isFinite(secs)) return "—";
  const d = Math.round((secs * 1000 - nowMs) / 1000);
  const a = Math.abs(d);
  if (a < 45) return "just now";
  const unit = a < 3600 ? `${Math.round(a / 60)}m` : a < 86_400 ? `${Math.round(a / 3600)}h` : `${Math.round(a / 86_400)}d`;
  return d > 0 ? `in ${unit}` : `${unit} ago`;
}

export function pressureLabel(p: BufferPressure | null | undefined): string {
  return p === "red" ? "Red · over 2× (compacting between turns)" : p === "amber" ? "Amber · over threshold" : p === "green" ? "Green" : "Unknown (no status yet)";
}

export function pressureTone(p: BufferPressure | null | undefined): string {
  return p === "red" ? "bg-alert" : p === "amber" ? "bg-amber" : p === "green" ? "bg-teal" : "bg-white/20";
}

/** Bar fill 0–100 (the 2× high-water mark = full). */
export function pressureFill(ratio: number | null | undefined): number {
  if (ratio == null || !Number.isFinite(ratio) || ratio < 0) return 0;
  return Math.min(100, Math.round((ratio / 2) * 100));
}

export function badgeTone(b: IdleBadge | null | undefined): string {
  switch (b?.state) {
    case "ready":
      return "border-teal/40 text-teal";
    case "compacting":
      return "border-volt/40 text-volt";
    case "waiting":
      return "border-amber/40 text-amber-soft";
    default:
      return "border-white/10 text-ink-3";
  }
}
