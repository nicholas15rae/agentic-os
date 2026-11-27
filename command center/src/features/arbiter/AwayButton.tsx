import { useEffect } from "react";
import { Moon } from "lucide-react";
import { isTauri } from "@/lib/platform";
import { useArbiter } from "./arbiter-store";

/**
 * The "red button": Autonomous / Away Mode. On: Tony gives up his foreground reservation and
 * queued background work (builds, Security, Garbage, Observer, Booking) gets the GPU. The tray
 * menu toggles the same setting; it survives a restart.
 */
export function AwayButtonView({ away, onToggle, disabled }: { away: boolean; onToggle: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={away}
      aria-label="Away Mode"
      disabled={disabled}
      onClick={onToggle}
      title={away ? "Away Mode ON: background work has the GPU. Click to give Tony priority again." : "Away Mode: hand the GPU to background work (Tony steps out of the loop)"}
      className={`flex h-11 items-center gap-1.5 rounded-full px-3 text-[12px] font-semibold transition-colors disabled:opacity-40 ${
        away ? "bg-alert/90 text-canvas shadow-[0_0_18px_rgba(255,80,80,0.45)]" : "glass-thin text-ink-2 hover:text-alert"
      }`}
    >
      <Moon size={14} aria-hidden />
      <span className="hidden xl:inline">{away ? "Away" : "Away Mode"}</span>
    </button>
  );
}

export function AwayButton() {
  const away = useArbiter((s) => !!s.snap?.away);
  const ready = useArbiter((s) => !!s.snap);
  useEffect(() => void useArbiter.getState().start(), []);
  if (!isTauri()) return null;
  return <AwayButtonView away={away} disabled={!ready} onToggle={() => void useArbiter.getState().setAway(!away)} />;
}
