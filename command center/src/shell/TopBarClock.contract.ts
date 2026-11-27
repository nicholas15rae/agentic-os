// TopBarClock.contract.ts — LOCKED 2026-11-26 (approved by Nic: all recommended defaults, decisions 29–38). Changes need a new approval.
// Scope: build plan Section 4 (docs/build-plan-sections-8-10.md), steps 7, 9, 10. Implemented in part 2; this file is the spec.
// IPC / HTTP / events: NONE new. Reads useSettings (clock, effects, weatherMode), useWeather (now), useAtmosphereInfo().
// Decisions recorded here:
//   29 Default time format: 12-hour (settings.clock.hourCycle = "h12").
//   30 Placement: the clock pill takes the old atmosphere-picker slot in TopBar; EditToggle ("Widgets") follows it on Command.
//   33 Effects popover is LEAN: on/off, intensity, Live/Manual status + Back to Live, "Open weather & forecast". NO picker,
//      NO forecast in the top bar. "Open weather & forecast" opens a sheet with <WeatherPanel layout="popover" />.
//   34 Alarms popover: list only (no MiniMonth).
//   35 S22 HUD clock + temperature chip: yes (MobileHud step 12, separate).
//   38 °C only.
import type { RefObject } from "react";
import type { HourCycle } from "@/stores/settings";
import type { Atmosphere, EffectsSettings, EffectsSource, WeatherMode } from "@/features/weather/weather.contract";

export type { HourCycle };

// ── pure formatting (shell/TopBarClock.tsx) ──────────────────────────────────
/** Intl.DateTimeFormat with hourCycle; locale/timeZone only for deterministic tests.
 *  h12 → { time: "10:42", dayPeriod: "PM" | "p.m." (locale) }, h23 → { time: "22:42", dayPeriod: null }.
 *  a11y: "10:42 PM, Thursday 26 November". Tests must use 2026 dates around the DST changes 2026-03-08 and
 *  2026-11-01; 26 Nov 2026 is a Thursday. */
export type FormatClock = (now: number, cycle: HourCycle, opts?: { locale?: string; timeZone?: string }) => { time: string; dayPeriod: string | null; a11y: string };
/** "Thu 26 Nov". */
export type FormatClockDate = (now: number, opts?: { locale?: string; timeZone?: string }) => string;
/** Epoch ms, re-rendering only on minute boundaries (setTimeout to the next minute, then 60 s), paused while
 *  hidden and re-synced on visibilitychange (sleep/resume). Never useNow(1000). */
export type UseMinuteTick = () => number;

// ── view ─────────────────────────────────────────────────────────────────────
/** compact = below md (time, + temperature when showTemp). regular = md–xl: date dropped first, then temperature,
 *  if space runs out. full = xl+: time, temperature, date (when showDate). The pill is shrink-0 and never shrinks;
 *  the callsign pill truncates but keeps at least 3 characters. */
export type ClockDensity = "compact" | "regular" | "full";

export interface TopBarClockViewProps {
  now: number;
  hourCycle: HourCycle;
  showDate: boolean;
  /** null hides the temperature (no data yet, or showTemp off). */
  tempC: number | null;
  density: ClockDensity;
  effects: { enabled: boolean; source: EffectsSource; atmosphere: Atmosphere };
  open: "none" | "alarms" | "effects";
  onToggleAlarms: () => void;
  onToggleEffects: () => void;
  clockRef?: RefObject<HTMLButtonElement | null>;
  effectsRef?: RefObject<HTMLButtonElement | null>;
}
// One `glass-thin flex h-11 shrink-0 items-center gap-0.5 rounded-full p-1` pill:
//  - effects button (size-9): aria-label "Weather effects: live (snow)" | "Weather effects: manual (rain)" | "Weather effects off";
//    an amber dot whenever source === "manual" (the Manual indicator always shows).
//  - clock button: aria-haspopup="dialog" aria-expanded, aria-label "<a11y>, 3 degrees. Open alarms and key dates".
//    Tapping it opens Alarms & key dates (the same RemindersPanel as the widget).

/** The lean effects popover (presentational). */
export interface EffectsPopoverViewProps {
  effects: EffectsSettings;
  mode: WeatherMode;
  atmosphere: Atmosphere;
  source: EffectsSource;
  particlesSuppressed: boolean;
  onEffects: (patch: Partial<EffectsSettings>) => void;
  /** "auto" = Back to Live. */
  onMode: (m: WeatherMode) => void;
  onOpenForecast: () => void;
}

// ── shared popover hook (shell/useAnchoredPopover.ts, extracted from ModePill; ModePill behaviour unchanged) ──
export interface AnchoredPopover {
  open: boolean;
  setOpen: (v: boolean | ((o: boolean) => boolean)) => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
  popRef: RefObject<HTMLDivElement | null>;
  pos: { top: number; left: number } | null;
  /** min(requested, innerWidth - 16): a 360 px popover on a 360 px screen is 344 px and stays inside it. */
  width: number;
}
/** Escape closes the popover and refocuses the trigger, EXCEPT while a confirmation card is pending
 *  (useVoice pending): then Escape is not stopped and reaches ConfirmCard. Outside pointerdown closes. */
export type UseAnchoredPopover = (width: number) => AnchoredPopover;
/** Signature kept: popoverPosition(r, vw) still uses POPOVER_W (mode-pill.test.ts); `w` is the clamped width. */
export type PopoverPosition = (r: { left: number; right: number; bottom: number }, vw: number, w?: number) => { top: number; left: number };
// POPOVER_CARD moves to useAnchoredPopover.ts and is exported from there. Portals to body at z-40.
