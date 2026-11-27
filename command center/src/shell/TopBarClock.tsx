import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { CloudSun, Sparkles, X } from "lucide-react";
import { Segmented, type SegmentOption } from "@/components/segmented";
import { useMediaQuery, usePrefersReducedMotion } from "@/lib/use-media-query";
import { useSettings, type EffectsIntensity, type HourCycle } from "@/stores/settings";
import { useVoice } from "@/features/voice/voice-store";
import { useAtmosphereInfo, useWeather } from "@/features/weather/weather-store";
import type { Atmosphere, EffectsSource } from "@/features/weather/weather.contract";
import { POPOVER_CARD, popoverTakesEscape, useAnchoredPopover } from "./useAnchoredPopover";
import type { ClockDensity, EffectsPopoverViewProps, TopBarClockViewProps } from "./TopBarClock.contract";

// Contract: ./TopBarClock.contract.ts (LOCKED 2026-11-26). Decisions 29, 30, 33, 34, 38.
// One pill in the old atmosphere-picker slot: the effects icon (lean popover), then the clock button
// (time, temperature, date) that opens Alarms & key dates. Separate from the Mantra widget's clock.

const RemindersPanel = lazy(() => import("@/features/reminders/RemindersPanel").then((m) => ({ default: m.RemindersPanel })));
const WeatherPanel = lazy(() => import("@/features/weather/WeatherPanel").then((m) => ({ default: m.WeatherPanel })));

export const ALARMS_POPOVER_W = 360;
export const EFFECTS_POPOVER_W = 300;

// ── pure formatting ─────────────────────────────────────────────────────────

type FmtOpts = { locale?: string; timeZone?: string };

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((p) => p.type === type)?.value ?? "";
}

/** "Thursday 26 November" (fixed order, locale names). */
function longDate(now: number, opts: FmtOpts): string {
  const p = new Intl.DateTimeFormat(opts.locale, { weekday: "long", day: "numeric", month: "long", timeZone: opts.timeZone }).formatToParts(now);
  return `${part(p, "weekday")} ${part(p, "day")} ${part(p, "month")}`;
}

/** h12 → { time: "10:42", dayPeriod: "PM" } (the locale's marker: "p.m." in en-CA); h23 → { time: "22:42", dayPeriod: null }. */
export function formatClock(now: number, cycle: HourCycle, opts: FmtOpts = {}): { time: string; dayPeriod: string | null; a11y: string } {
  const p = new Intl.DateTimeFormat(opts.locale, { hour: "numeric", minute: "2-digit", hourCycle: cycle, timeZone: opts.timeZone }).formatToParts(now);
  const time = `${part(p, "hour")}:${part(p, "minute")}`;
  const dayPeriod = cycle === "h12" ? part(p, "dayPeriod") || null : null;
  return { time, dayPeriod, a11y: `${time}${dayPeriod ? ` ${dayPeriod}` : ""}, ${longDate(now, opts)}` };
}

/** "Thu 26 Nov". */
export function formatClockDate(now: number, opts: FmtOpts = {}): string {
  const p = new Intl.DateTimeFormat(opts.locale, { weekday: "short", day: "numeric", month: "short", timeZone: opts.timeZone }).formatToParts(now);
  return `${part(p, "weekday")} ${part(p, "day")} ${part(p, "month")}`;
}

/** Delay to just past the next minute boundary (+20 ms so the tick never lands a hair early). */
export function msToNextMinute(now: number): number {
  return 60_000 - (now % 60_000) + 20;
}

const floorMinute = (t: number) => t - (t % 60_000);

/**
 * Non-React minute ticker (testable with fake timers): calls `onTick(minute epoch ms)` on every minute
 * boundary. Each timeout is re-aimed from Date.now(), so a late timer after sleep/resume lands on the right
 * minute; it is cleared while the page is hidden and re-synced on visibilitychange and window focus.
 */
export function startMinuteTick(onTick: (minute: number) => void): () => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    clearTimeout(t);
    t = setTimeout(tick, msToNextMinute(Date.now()));
  };
  const tick = () => {
    onTick(floorMinute(Date.now()));
    schedule();
  };
  const hasDoc = typeof document !== "undefined";
  const onVis = () => {
    if (document.hidden) clearTimeout(t);
    else tick();
  };
  schedule();
  if (hasDoc) document.addEventListener("visibilitychange", onVis);
  if (typeof window !== "undefined") window.addEventListener("focus", tick);
  return () => {
    clearTimeout(t);
    if (hasDoc) document.removeEventListener("visibilitychange", onVis);
    if (typeof window !== "undefined") window.removeEventListener("focus", tick);
  };
}

/** Epoch ms of the current minute; re-renders only when the minute changes. Never useNow(1000). */
export function useMinuteTick(): number {
  const [minute, setMinute] = useState(() => floorMinute(Date.now()));
  useEffect(() => startMinuteTick(setMinute), []);
  return minute;
}

// ── fit: md and up, drop the date first, then the temperature, when space runs out ──

/** 0 = everything, 1 = date dropped, 2 = date and temperature dropped. */
export type FitLevel = 0 | 1 | 2;

/**
 * Pure step of the drop order. `overflow` > 1 px (the header overflows, or the callsign is truncated)
 * drops one more part; with no overflow, a part comes back only when the free space covers the width it
 * had when it was dropped (`freedAtLevel`), so the bar never flickers between two levels.
 */
export function nextFitLevel(level: FitLevel, m: { overflow: number; slack: number }, freedAtLevel: number): FitLevel {
  if (m.overflow > 1) return level < 2 ? ((level + 1) as FitLevel) : level;
  if (level > 0 && m.slack >= freedAtLevel + 2) return (level - 1) as FitLevel;
  return level;
}

function measureHeader(header: HTMLElement): { overflow: number; slack: number } {
  const cs = getComputedStyle(header);
  const gap = parseFloat(cs.columnGap) || 0;
  const inner = header.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
  let used = 0;
  let shown = 0;
  for (const el of Array.from(header.children) as HTMLElement[]) {
    if (!el.offsetWidth && getComputedStyle(el).display === "none") continue;
    used += el.offsetWidth;
    shown++;
  }
  used += gap * Math.max(0, shown - 1);
  const callsign = header.querySelector<HTMLElement>("[data-callsign]");
  const truncated = callsign ? callsign.scrollWidth - callsign.clientWidth : 0;
  return { overflow: Math.max(header.scrollWidth - header.clientWidth, truncated), slack: inner - used };
}

function useHeaderFit(anchor: RefObject<HTMLElement | null>, enabled: boolean, contentKey: string): FitLevel {
  const [level, setLevel] = useState<FitLevel>(0);
  const freed = useRef<[number, number, number]>([0, 0, 0]);
  const [, bump] = useState(0);

  // Re-check after every relevant render (content or level change).
  useLayoutEffect(() => {
    if (!enabled) {
      if (level !== 0) setLevel(0);
      return;
    }
    const header = anchor.current?.closest("header");
    if (!header) return;
    const m = measureHeader(header);
    let next = nextFitLevel(level, m, freed.current[level]);
    if (next > level) {
      // Remember how wide the part being hidden was (+ its gap) so it only returns when that fits.
      // A part that isn't shown (date off, no temperature yet) frees nothing: step past it.
      const width = (lvl: FitLevel) => header.querySelector<HTMLElement>(lvl === 1 ? '[data-clock-part="date"]' : '[data-clock-part="temp"]')?.offsetWidth ?? 0;
      freed.current[next] = width(next) ? width(next) + 6 : 0;
      if (next === 1 && !freed.current[1]) {
        next = 2;
        freed.current[2] = width(2) ? width(2) + 6 : 0;
      }
      if (!freed.current[next]) return; // nothing left to drop
    }
    if (next !== level) setLevel(next);
  });

  // Header / children size changes (window resize, pills appearing) → re-render, which re-checks above.
  useEffect(() => {
    if (!enabled || typeof ResizeObserver === "undefined") return;
    const header = anchor.current?.closest("header");
    if (!header) return;
    const ro = new ResizeObserver(() => bump((n) => n + 1));
    ro.observe(header);
    for (const el of Array.from(header.children)) ro.observe(el);
    return () => ro.disconnect();
  }, [enabled, anchor, contentKey]);

  return enabled ? level : 0;
}

// ── view ─────────────────────────────────────────────────────────────────────

export function effectsAriaLabel(e: { enabled: boolean; source: EffectsSource; atmosphere: Atmosphere }): string {
  if (!e.enabled) return "Weather effects off";
  return `Weather effects: ${e.source === "manual" ? "manual" : "live"} (${e.atmosphere})`;
}

export function clockAriaLabel(a11y: string, tempC: number | null): string {
  return `${a11y}${tempC !== null ? `, ${tempC} degrees` : ""}. Open alarms and key dates`;
}

export function TopBarClockView(p: TopBarClockViewProps) {
  const { time, dayPeriod, a11y } = formatClock(p.now, p.hourCycle);
  const date = p.showDate && p.density !== "compact" ? formatClockDate(p.now) : null;
  const manual = p.effects.source === "manual";
  return (
    <div data-testid="topbar-clock" className="glass-thin flex h-11 shrink-0 items-center gap-0.5 rounded-full p-1">
      <button
        ref={p.effectsRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={p.open === "effects"}
        aria-label={effectsAriaLabel(p.effects)}
        title={effectsAriaLabel(p.effects)}
        onClick={p.onToggleEffects}
        className={`relative grid size-9 shrink-0 place-items-center rounded-full transition-colors ${
          p.open === "effects" ? "bg-teal/20 text-teal" : p.effects.enabled ? "text-ink-2 hover:text-ink" : "text-ink-3 hover:text-ink-2"
        }`}
      >
        <Sparkles size={14} aria-hidden />
        {!p.effects.enabled && <span aria-hidden className="absolute h-px w-4 rotate-45 rounded-full bg-current" />}
        {manual && <span aria-hidden data-testid="effects-manual-dot" className="absolute right-1 top-1 size-1.5 rounded-full bg-amber" />}
      </button>
      <button
        ref={p.clockRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={p.open === "alarms"}
        aria-label={clockAriaLabel(a11y, p.tempC)}
        onClick={p.onToggleAlarms}
        className={`flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full transition-colors ${p.density === "compact" ? "px-2" : "px-3"} ${p.open === "alarms" ? "bg-teal/20" : "hover:bg-white/[0.06]"}`}
      >
        <span className="font-mono fs-13 font-semibold tracking-wider text-ink tabular" data-clock-part="time">
          {time}
        </span>
        {dayPeriod && <span className="label-caps -ml-0.5 text-ink-3">{dayPeriod}</span>}
        {p.tempC !== null && (
          <span data-clock-part="temp" className="font-mono fs-12 font-semibold text-teal tabular">
            {p.tempC}°
          </span>
        )}
        {date && (
          <span data-clock-part="date" className="label-caps text-ink-2">
            {date}
          </span>
        )}
      </button>
    </div>
  );
}

const INTENSITY: readonly SegmentOption<EffectsIntensity>[] = [
  { id: "low", label: "Low" },
  { id: "normal", label: "Normal" },
  { id: "high", label: "High" },
];

const ATMOSPHERE_LABEL: Record<Atmosphere, string> = { clear: "Sunrise", autumn: "Autumn", rain: "Rain", snow: "Snow", fog: "Fog", midnight: "Midnight" };

/** The lean effects popover: on/off, intensity, Live/Manual + Back to Live, "Open weather & forecast". No picker. */
export function EffectsPopoverView(p: EffectsPopoverViewProps) {
  const manual = p.mode !== "auto";
  return (
    <div className="flex flex-col gap-2.5 p-1">
      <div className="flex items-center gap-2">
        <h2 className="label-caps text-ink-2">Weather effects</h2>
        <span data-testid="effects-status" className={`label-caps ml-auto truncate ${manual ? "text-amber-light" : "text-ink-3"}`}>
          {manual && <span aria-hidden className="mr-1 inline-block size-1.5 rounded-full bg-amber align-middle" />}
          {manual ? "Manual" : "Live"} · {p.source === "fallback" ? "following the clock" : ATMOSPHERE_LABEL[p.atmosphere]}
        </span>
      </div>
      {manual && (
        <button type="button" onClick={() => p.onMode("auto")} className="pill-glass !h-8 w-fit text-xs">
          Back to Live
        </button>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          role="switch"
          aria-checked={p.effects.enabled}
          aria-label="Weather effects"
          onClick={() => p.onEffects({ enabled: !p.effects.enabled })}
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${p.effects.enabled ? "bg-teal/80" : "bg-white/15"}`}
        >
          <span aria-hidden className={`absolute top-0.5 size-4 rounded-full bg-white transition-[left] ${p.effects.enabled ? "left-[18px]" : "left-0.5"}`} />
        </button>
        <span className="fs-12 text-ink-2">{p.effects.enabled ? "On" : "Off"}</span>
        <Segmented size="sm" label="Effects intensity" value={p.effects.intensity} options={INTENSITY} disabled={!p.effects.enabled} onChange={(intensity) => p.onEffects({ intensity })} className="ml-auto" />
      </div>
      {p.particlesSuppressed && <p className="fs-11 text-ink-3">Particles are off on this device (performance).</p>}
      <button type="button" onClick={p.onOpenForecast} className="pill-glass !h-8 justify-center gap-1.5 text-xs">
        <CloudSun size={13} aria-hidden /> Open weather &amp; forecast
      </button>
    </div>
  );
}

// ── container ────────────────────────────────────────────────────────────────

function densityOf(md: boolean, xl: boolean): ClockDensity {
  if (!md) return "compact";
  return xl ? "full" : "regular";
}

export function TopBarClock() {
  const now = useMinuteTick();
  const clock = useSettings((s) => s.clock);
  const effects = useSettings((s) => s.effects);
  const set = useSettings((s) => s.set);
  const weatherNow = useWeather((s) => s.now);
  const { atmosphere, source, mode } = useAtmosphereInfo();
  const particlesSuppressed = usePrefersReducedMotion();
  const density = densityOf(useMediaQuery("(min-width: 768px)"), useMediaQuery("(min-width: 1280px)"));
  const alarms = useAnchoredPopover(ALARMS_POPOVER_W);
  const fx = useAnchoredPopover(EFFECTS_POPOVER_W);
  const [sheet, setSheet] = useState(false);

  const knownTemp = clock.showTemp && weatherNow ? Math.round(weatherNow.tempC) : null;
  const level = useHeaderFit(alarms.triggerRef, density !== "compact", `${now}|${knownTemp}|${clock.showDate}|${clock.hourCycle}|${density}`);
  const showDate = clock.showDate && level < 1;
  const tempC = level < 2 ? knownTemp : null;

  return (
    <>
      <TopBarClockView
        now={now}
        hourCycle={clock.hourCycle}
        showDate={showDate}
        tempC={tempC}
        density={density}
        effects={{ enabled: effects.enabled, source, atmosphere }}
        open={alarms.open ? "alarms" : fx.open ? "effects" : "none"}
        onToggleAlarms={() => {
          fx.setOpen(false);
          alarms.setOpen((o) => !o);
        }}
        onToggleEffects={() => {
          alarms.setOpen(false);
          fx.setOpen((o) => !o);
        }}
        clockRef={alarms.triggerRef}
        effectsRef={fx.triggerRef}
      />
      {alarms.open &&
        alarms.pos &&
        createPortal(
          <div ref={alarms.popRef} className="fixed z-40" style={{ top: alarms.pos.top, left: alarms.pos.left, width: alarms.width }}>
            <div role="dialog" aria-label="Alarms & key dates" className={`${POPOVER_CARD} px-3 pt-3`}>
              <Suspense fallback={<p className="p-3 font-mono text-xs text-ink-3">loading…</p>}>
                <RemindersPanel variant="popover" onDone={() => alarms.setOpen(false)} />
              </Suspense>
            </div>
          </div>,
          document.body,
        )}
      {fx.open &&
        fx.pos &&
        createPortal(
          <div ref={fx.popRef} className="fixed z-40" style={{ top: fx.pos.top, left: fx.pos.left, width: fx.width }}>
            <div role="dialog" aria-label="Weather effects" className={POPOVER_CARD}>
              <EffectsPopoverView
                effects={effects}
                mode={mode}
                atmosphere={atmosphere}
                source={source}
                particlesSuppressed={particlesSuppressed}
                onEffects={(patch) => set({ effects: { ...useSettings.getState().effects, ...patch } })}
                onMode={(weatherMode) => set({ weatherMode })}
                onOpenForecast={() => {
                  fx.setOpen(false);
                  setSheet(true);
                }}
              />
            </div>
          </div>,
          document.body,
        )}
      {sheet && (
        <WeatherSheet
          onClose={() => {
            setSheet(false);
            fx.triggerRef.current?.focus();
          }}
        />
      )}
    </>
  );
}

/** "Open weather & forecast": the full WeatherPanel (forecast + picker + effects) in a modal sheet (z-80, under the ConfirmCard). */
function WeatherSheet({ onClose }: { onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  // The parent passes a fresh onClose each render (the clock re-renders every minute): read it
  // through a ref so focus moves to the close button once, on open, and is never pulled back.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (!popoverTakesEscape(e.key, !!useVoice.getState().pending)) return;
      e.stopPropagation();
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Weather & forecast"
      className="fixed inset-0 z-[80] flex items-end justify-center bg-black/45 p-2 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] sm:items-center"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={`${POPOVER_CARD} relative max-h-[85vh] w-full max-w-[420px] overflow-y-auto p-3`}>
        <button ref={closeRef} type="button" aria-label="Close weather" onClick={onClose} className="absolute right-2 top-2 z-[1] grid size-7 place-items-center rounded-full text-ink-3 hover:bg-white/10 hover:text-ink">
          <X size={14} />
        </button>
        <Suspense fallback={<p className="p-3 font-mono text-xs text-ink-3">loading…</p>}>
          <div className="pr-7">
            <WeatherPanel layout="popover" />
          </div>
        </Suspense>
      </div>
    </div>,
    document.body,
  );
}
