import { useEffect, useRef } from "react";
import { useSettings } from "@/stores/settings";
import { frameLoop } from "@/lib/motion";
import { useMic } from "./mic-gate";
import { DB_MAX, DB_MIN, dbToPct, meterClearsGate } from "./meter-scale";
import { setActivationDb } from "./threshold";
import { thresholdFor } from "./vad-gate";

// No width transition: it would re-animate on every update and bring back a frame per display
// refresh (143 Hz), defeating the meter's 30 fps budget below.
const FILL_BASE = "absolute inset-y-0 left-0 rounded-full";
const FILL_CLEAR = `${FILL_BASE} bg-gradient-to-r from-teal to-amber`;
const FILL_BELOW = `${FILL_BASE} bg-ink-3/40`;

/**
 * Activation threshold + live input meter on ONE track and ONE scale (Phase 2 Part B): the
 * slider's thumb is the gate, the fill is your voice (teal→amber when it clears the gate, dim
 * when it doesn't), plus a barge-in marker (gate + margin) and a display-only noise-floor tick.
 *
 * The meter only animates while a capture is open (`live > 0`) and never opens one itself. While
 * the mic is locked off it renders a static, dimmed track ("MIC OFF: meter paused").
 */
export function ThresholdMeter({ variant = "full" }: { variant?: "full" | "compact" }) {
  const enabled = useMic((s) => s.enabled);
  const live = useMic((s) => s.live);
  const activationDb = useSettings((s) => s.vad.activationDb);
  const bargeMarginDb = useSettings((s) => s.vad.bargeMarginDb);
  const fill = useRef<HTMLDivElement>(null);
  const floor = useRef<HTMLDivElement>(null);
  const you = useRef<HTMLSpanElement>(null);
  const metering = enabled && live > 0;
  const compact = variant === "compact";
  const barge = thresholdFor({ activationDb, bargeMarginDb, barge: true, speakers: true });

  useEffect(() => {
    if (!metering) return;
    // A capture stays open all through hands-free listening: 30 updates/s on the shared frame grid,
    // 15 while calm, none while hidden.
    const draw = () => {
      const m = useMic.getState().activeMeter;
      if (m) {
        // The capture's own gate for this frame (barge-in margin, Silero), not the bare slider.
        const clears = meterClearsGate(m);
        if (fill.current) {
          fill.current.style.width = `${dbToPct(m.levelDb)}%`;
          fill.current.className = clears ? FILL_CLEAR : FILL_BELOW;
        }
        if (floor.current) floor.current.style.left = `${dbToPct(m.floorDb)}%`;
        if (you.current) you.current.textContent = `you ${Math.round(m.levelDb)} dB ${clears ? "✓" : "·"}`;
      }
    };
    const loop = frameLoop(draw, (l) => (l === "full" ? 30 : 15));
    return () => {
      loop.stop();
      if (fill.current) fill.current.style.width = "0%";
      if (you.current) you.current.textContent = "";
    };
  }, [metering]);

  return (
    <div className={compact ? "flex min-w-[220px] flex-1 items-center gap-2 text-[11px] text-ink-3" : "space-y-1.5"}>
      {compact && <span className="shrink-0">Gate</span>}
      <div className={`relative flex-1 ${compact ? "h-4" : "h-6"} ${enabled ? "" : "opacity-40"}`}>
        <div className="absolute inset-0 overflow-hidden rounded-full bg-white/[0.06]">
          <div ref={fill} className={FILL_BELOW} style={{ width: "0%" }} />
          <div ref={floor} className="absolute inset-y-0 w-px bg-white/40" style={{ left: "0%", opacity: metering ? 1 : 0 }} title="room noise (display only)" />
          <div className="absolute inset-y-0 w-px bg-amber/70" style={{ left: `${dbToPct(barge)}%` }} title={`barge-in over Tony: ${Math.round(barge)} dB`} />
        </div>
        <input
          type="range"
          min={DB_MIN}
          max={DB_MAX}
          step={1}
          value={activationDb}
          disabled={!enabled}
          onChange={(e) => setActivationDb(Number(e.target.value))}
          className="gate-range absolute inset-0"
          aria-label="Activation threshold (dBFS)"
          aria-valuetext={`${activationDb} dB`}
        />
      </div>
      <div className={`flex items-center gap-2 font-mono ${compact ? "shrink-0 text-ink-2" : "text-[11px] text-ink-2"}`}>
        <span>gate {activationDb} dB</span>
        {enabled ? <span ref={you} className="text-ink-3" /> : <span className="text-alert/80">MIC OFF: meter paused</span>}
      </div>
    </div>
  );
}
