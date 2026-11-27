import { badgeLabel, badgeName, badgeStatus, badgeTickers, statusText, type GabagoulBadgeState } from "./badge-format";
import { Dash, Dot } from "./parts";
import { useMemmap } from "./use-memmap-data";

export type { BadgeSource, BadgeStatus, BadgeTicker, BadgeTone, GabagoulBadgeState } from "./badge-format";

/** Corner brackets, echoing the Gabagool blueprint card's. */
const BRACKETS = ["left-[3px] top-[3px] border-l border-t", "right-[3px] top-[3px] border-r border-t", "bottom-[3px] left-[3px] border-b border-l", "bottom-[3px] right-[3px] border-b border-r"];

/**
 * ONTARIO // GABAGOUL: the HUD badge over the E46 stage. Glass look from a translucent fill,
 * a cyan edge and a box-shadow glow; no backdrop-filter (it sits over the WebGL canvas, see
 * parts.tsx). Static: nothing animates, so reduced motion needs no special case. No
 * `data-zone` (that would earn it a leader line) and pointer-events none, so it never blocks
 * orbit drag or zone hover.
 *
 * `state` is the Phase 3 binding (telemetry / OBD tickers). Without a `status` it shows the
 * services-online count from the shared System Map snapshot — read-only, no polling here.
 */
export function GabagoulBadge({ state, className = "" }: { state?: GabagoulBadgeState; className?: string }) {
  const summary = useMemmap((s) => s.snap?.summary ?? null);
  const snapErr = useMemmap((s) => s.error);
  const name = badgeName(state);
  const shown = state?.status !== undefined ? state.status : badgeStatus(summary);
  const status = statusText(shown);
  const tone = shown?.tone ?? "idle";
  const tickers = badgeTickers(state?.tickers);
  const why = state?.status === null ? "No status source" : (snapErr ?? "Waiting for the first system snapshot");

  return (
    <div
      role="group"
      aria-label={badgeLabel(name, status, tickers)}
      data-source={state?.source ?? "static"}
      className={`pointer-events-none relative inline-flex min-w-0 max-w-full select-none flex-col items-center gap-0.5 rounded-[10px] border border-holo/35 bg-[rgba(7,11,17,0.72)] px-3 py-1.5 @max-[46rem]:px-2 shadow-[0_0_18px_-6px_rgba(0,210,255,0.55),inset_0_1px_0_rgba(0,210,255,0.10)] ${className}`}
    >
      {BRACKETS.map((b) => (
        <span key={b} aria-hidden className={`absolute size-1.5 border-holo/70 ${b}`} />
      ))}
      <p aria-hidden className="max-w-full truncate font-mono text-[11px] font-semibold uppercase leading-4 tracking-[0.22em] @max-[46rem]:text-[10px] @max-[46rem]:tracking-[0.08em]">
        <span className="text-ink-2">{name.region}</span> <span className="text-ink-3">//</span> <span className="text-holo [text-shadow:0_0_6px_rgba(0,210,255,0.6)]">{name.callsign}</span>
      </p>
      <div aria-hidden className="flex max-w-full items-center gap-2 overflow-hidden whitespace-nowrap">
        <span className="label-caps flex min-w-0 items-center gap-1 !text-[9px] text-ink-2">
          <Dot tone={tone} />
          {status ? <span className="truncate">{status}</span> : <Dash why={why} />}
        </span>
        {tickers.map((t) => (
          <span key={t.id} className="flex min-w-0 items-baseline gap-1">
            <span className="label-caps !text-[8px] text-ink-3">{t.label}</span>
            <span className={`truncate font-mono text-[10px] tabular-nums ${t.tone === "down" ? "text-alert" : t.tone === "warn" ? "text-ember" : t.tone === "ok" ? "text-teal-soft" : "text-ink-2"}`}>
              {t.value ?? <Dash why={t.why} />}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}
