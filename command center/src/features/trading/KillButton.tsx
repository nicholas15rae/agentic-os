import { Loader2, OctagonX } from "lucide-react";
import { KILL_PRESSES, killButtonProps, killStageLabel } from "@/features/trading/kill-switch-core";

export interface KillButtonProps {
  /** Clicks so far in the current 3-click sequence (0 = disarmed). */
  pressed: number;
  /** A live kill is in flight: disabled, with a spinner. */
  busy: boolean;
  /** One deliberate click (TradingDesk counts them and trips on the last). */
  onPress: () => void;
}

/** The red E-stop button. Every handler comes from killButtonProps (the held-Enter guard included) and the props
 *  take no handlers, so a caller can't add or override one without a type error. */
export function KillButton({ pressed, busy, onPress }: KillButtonProps) {
  const armed = pressed > 0;
  const remaining = KILL_PRESSES - pressed;
  // ARM → CONFIRM → EXECUTE KILL: the label names what the next click does.
  const label = !armed ? "KILL SWITCH · ARM" : killStageLabel(pressed);
  return (
    <button
      {...killButtonProps({ pressed, busy, onPress })}
      className={`flex h-10 items-center gap-2 rounded-full border-2 border-alert px-4 text-[13px] font-bold tracking-wide text-white shadow-[0_0_24px_rgba(239,68,68,0.45)] transition-transform hover:scale-[1.03] active:scale-95 ${remaining === 1 && armed ? "animate-pulse bg-alert" : armed ? "bg-alert" : "bg-alert/85"}`}
    >
      {busy ? <Loader2 size={16} className="animate-spin" /> : <OctagonX size={16} />}
      {label}
    </button>
  );
}
