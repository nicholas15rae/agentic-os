import { useEffect, useState } from "react";
import { create } from "zustand";
import { Lock, Mic, MicOff, Square } from "lucide-react";
import { requestMicEnabled, useMic } from "./mic-gate";
import { useVoice, type VoiceState } from "./voice-store";
import { isMicOff, micIndicator, type MicIndicator } from "./mic-indicator";
import { safety } from "@/lib/safety";

/**
 * The mic's locked-off indicator (Phase 2 Part D). Solid, static red when the line is dead —
 * never animated, so it can't be mistaken for a live waveform; a loud pulsing red only if a
 * capture is somehow still open while muted. No glass / backdrop classes (safe over WebGL).
 *
 * Presentational views (`MicLockBadgeView`, `MicButtonView`) take plain props so they render
 * under `renderToStaticMarkup`; `MicLockBadge` is the store-reading container.
 */

export type BadgeVariant = "chip" | "dot" | "button";

const LIVE_DOT = "bg-teal shadow-[0_0_10px_#00e5c3]";

const LABEL: Record<MicIndicator, string> = {
  locked: "Mic locked off",
  leak: "Mic still open while locked off",
  live: "Mic live",
  armed: "Mic on, not listening",
};

const TEXT: Record<MicIndicator, string> = { locked: "MIC OFF", leak: "MIC STILL OPEN", live: "MIC LIVE", armed: "MIC ON" };

const CHIP_TONE: Record<MicIndicator, string> = {
  locked: "border border-alert/50 bg-alert/15 text-alert",
  leak: "bg-alert text-white animate-pulse",
  live: "border border-teal/40 text-teal",
  armed: "border border-white/10 text-ink-3",
};

function KindIcon({ kind, size }: { kind: MicIndicator; size: number }) {
  if (kind === "locked")
    return (
      <>
        <MicOff size={size} aria-hidden />
        <Lock size={size - 2} aria-hidden />
      </>
    );
  if (kind === "leak") return <MicOff size={size} aria-hidden />;
  if (kind === "live") return <span aria-hidden className={`size-2 rounded-full ${LIVE_DOT}`} />;
  return <Mic size={size} aria-hidden className="text-ink-3" />;
}

export function MicLockBadgeView({ kind, variant = "chip", flash = false, onToggle, className = "" }: { kind: MicIndicator; variant?: BadgeVariant; flash?: boolean; onToggle?: () => void; className?: string }) {
  const ring = flash ? "ring-2 ring-alert ring-offset-1 ring-offset-canvas" : "";
  if (variant === "dot") {
    if (kind === "live") return <span role="status" aria-label={LABEL[kind]} title={LABEL[kind]} className={`size-2 shrink-0 rounded-full ${LIVE_DOT} ${className}`} />;
    if (kind === "armed")
      return (
        <span role="status" aria-label={LABEL[kind]} title={LABEL[kind]} className={`grid size-4 shrink-0 place-items-center text-ink-3 ${className}`}>
          <Mic size={11} aria-hidden />
        </span>
      );
    if (kind === "leak") return <span role="status" aria-label={LABEL[kind]} title={LABEL[kind]} className={`size-2.5 shrink-0 rounded-full bg-alert animate-pulse ${className}`} />;
    return (
      <span role="status" aria-label={LABEL[kind]} title="Mic locked off: nothing is captured or transcribed" className={`grid size-4 shrink-0 place-items-center rounded-full border border-alert/50 bg-alert/15 text-alert ${ring} ${className}`}>
        <MicOff size={10} aria-hidden />
      </span>
    );
  }
  const body = (
    <>
      <KindIcon kind={kind} size={12} />
      <span>{TEXT[kind]}</span>
    </>
  );
  const base = `flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 font-mono fs-10 font-bold tracking-wider ${CHIP_TONE[kind]} ${ring} ${className}`;
  if (variant === "button") {
    const off = isMicOff(kind);
    return (
      <button
        type="button"
        role="switch"
        aria-checked={!off}
        aria-label={off ? "Mic locked off: tap to unlock" : "Mic on: tap to lock it off"}
        title={off ? "Unlock the mic" : "Lock the mic off"}
        onClick={onToggle}
        className={`${base} !h-8`}
      >
        {body}
      </button>
    );
  }
  return (
    <span role="status" aria-label={LABEL[kind]} title={LABEL[kind]} className={base}>
      {body}
    </span>
  );
}

// ── The mic-locked flash (a launcher pressed while locked) ──────────────────

export const useMicFlash = create<{ at: number }>(() => ({ at: 0 }));
export const FLASH_MS = 1200;

/** Flash every visible locked chip for 1.2 s (the hotkey / orb was pressed while locked off). */
export function flashMicLock(): void {
  useMicFlash.setState({ at: Date.now() });
}

function useFlash(): boolean {
  const at = useMicFlash((s) => s.at);
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!at) return;
    setOn(true);
    const t = setTimeout(() => setOn(false), FLASH_MS);
    return () => clearTimeout(t);
  }, [at]);
  return on;
}

/** The current indicator from the gate and the voice state (hook). */
export function useMicIndicator(): MicIndicator {
  const enabled = useMic((s) => s.enabled);
  const live = useMic((s) => s.live);
  const state = useVoice((s) => s.state);
  return micIndicator(enabled, live, state);
}

/**
 * The store-reading badge. `onlyWhenOff`: render nothing while the mic is on (the HUD headers
 * show it only as the locked-off warning). The button variant toggles the mic (the phone's own
 * lock applies locally first; an unlock on desktop waits for Rust's ack).
 */
export function MicLockBadge({ variant = "chip", onlyWhenOff = false, className }: { variant?: BadgeVariant; onlyWhenOff?: boolean; className?: string }) {
  const kind = useMicIndicator();
  const flash = useFlash();
  if (onlyWhenOff && !isMicOff(kind)) return null;
  return <MicLockBadgeView kind={kind} variant={variant} flash={flash && isMicOff(kind)} className={className} onToggle={() => void requestMicEnabled(isMicOff(kind))} />;
}

// ── The mic button's two faces ──────────────────────────────────────────────

/**
 * The round mic button. `locked`: alert-toned MicOff + Lock, `aria-disabled` (it does not
 * listen), and a click only asks to unlock — it never opens a capture.
 */
export function MicButtonView({ state, locked, size = 44, onClick }: { state: VoiceState; locked: boolean; size?: number; onClick: () => void }) {
  if (locked)
    return (
      <button
        type="button"
        aria-disabled="true"
        aria-label="Mic locked off: tap to unlock"
        title="Mic locked off: tap to unlock"
        onClick={onClick}
        style={{ width: size, height: size }}
        className="relative grid shrink-0 place-items-center rounded-full border border-alert/50 bg-alert/10 text-alert transition-transform duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] active:scale-95"
      >
        <MicOff size={size * 0.38} aria-hidden />
        <Lock size={Math.max(9, size * 0.22)} aria-hidden className="absolute bottom-[18%] right-[18%]" />
      </button>
    );
  const live = state === "listening" || state === "speaking";
  return (
    <button
      {...safety("tony-stop")}
      type="button"
      aria-label={state === "listening" ? "Stop listening" : state === "speaking" ? "Stop speaking" : "Start listening"}
      onClick={onClick}
      style={{ width: size, height: size }}
      className={`grid shrink-0 place-items-center rounded-full transition-transform duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] active:scale-95 ${live ? "bg-teal text-canvas glow-teal" : "pill-primary !p-0"}`}
      // pill-primary sets its own height; the inline size wins.
    >
      {live ? <Square size={size * 0.34} fill="currentColor" /> : <Mic size={size * 0.4} />}
    </button>
  );
}
