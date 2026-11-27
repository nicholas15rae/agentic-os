import { Card } from "@/components/ui";
import { Segmented, type SegmentOption } from "@/components/segmented";
import { usePrefersReducedMotion } from "@/lib/use-media-query";
import { useSettings, type EffectsIntensity, type HourCycle } from "@/stores/settings";
import { useAtmosphereInfo, useWeather } from "@/features/weather/weather-store";
import { statusText } from "@/features/weather/WeatherPanel";

/**
 * Settings → Appearance: the top-bar clock (shell/TopBarClock) and the weather particle effects
 * (features/weather/WeatherCanvas). Plan Section 4 step 11; decisions 29 (12 h default), 31, 33, 36, 38.
 */

const CYCLES: readonly SegmentOption<HourCycle>[] = [
  { id: "h12", label: "12 h" },
  { id: "h23", label: "24 h" },
];

const INTENSITY: readonly SegmentOption<EffectsIntensity>[] = [
  { id: "low", label: "Low" },
  { id: "normal", label: "Normal" },
  { id: "high", label: "High" },
];

function Toggle({ on, label, onChange }: { on: boolean; label: string; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm text-ink-2">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        onClick={() => onChange(!on)}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${on ? "bg-teal/80" : "bg-white/15"}`}
      >
        <span aria-hidden className={`absolute top-0.5 size-4 rounded-full bg-white transition-[left] ${on ? "left-[18px]" : "left-0.5"}`} />
      </button>
      {label}
    </label>
  );
}

export function ClockCard() {
  const clock = useSettings((s) => s.clock);
  const set = useSettings((s) => s.set);
  const patch = (p: Partial<typeof clock>) => set({ clock: { ...useSettings.getState().clock, ...p } });
  return (
    <Card title="Top bar clock" hint="Tap the clock for Alarms & key dates. On narrow windows the date drops first, then the temperature. °C only.">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <Segmented label="Time format" value={clock.hourCycle} options={CYCLES} onChange={(hourCycle) => patch({ hourCycle })} />
        <Toggle on={clock.showDate} label="Show date" onChange={(showDate) => patch({ showDate })} />
        <Toggle on={clock.showTemp} label="Show temperature" onChange={(showTemp) => patch({ showTemp })} />
      </div>
    </Card>
  );
}

export function EffectsCard() {
  const effects = useSettings((s) => s.effects);
  const set = useSettings((s) => s.set);
  const { atmosphere, source, mode } = useAtmosphereInfo();
  const liveLabel = useWeather((s) => s.now?.label);
  const suppressed = usePrefersReducedMotion();
  const manual = mode !== "auto";
  const patch = (p: Partial<typeof effects>) => set({ effects: { ...useSettings.getState().effects, ...p } });
  return (
    <Card
      title="Weather effects"
      hint="Particles follow the live weather unless you pick an atmosphere in the Living Weather widget. They are always off in the Android app and the phone HUD (performance)."
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <span data-testid="settings-effects-status" className={`label-caps ${manual ? "text-amber-light" : "text-ink-3"}`}>
            {manual && <span aria-hidden className="mr-1 inline-block size-1.5 rounded-full bg-amber align-middle" />}
            {statusText(source, atmosphere, liveLabel)}
          </span>
          {manual && (
            <button type="button" className="pill-glass !h-8 text-xs" onClick={() => set({ weatherMode: "auto" })}>
              Back to Live
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <Toggle on={effects.enabled} label="Effects on" onChange={(enabled) => patch({ enabled })} />
          <Segmented label="Effects intensity" value={effects.intensity} options={INTENSITY} disabled={!effects.enabled} onChange={(intensity) => patch({ intensity })} />
        </div>
        {suppressed && <p className="fs-11 text-ink-3">Particles are off on this device (reduced motion or the Android app).</p>}
      </div>
    </Card>
  );
}
