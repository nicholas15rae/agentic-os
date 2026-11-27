import { useEffect } from "react";
import { create } from "zustand";
import { useToasts } from "@/features/reminders/notify";
import { tradingApi, type KillIncident } from "@/features/trading/ibkr";
import { installKillHotkey } from "@/features/trading/kill-switch-core";

export { classifyKillKey, createKillArm, createKillKeyListener, guardKillButtonKeydown, installKillHotkey, isKillHotkey, isRepeatActivation, KILL_CONFIRM_MS, KILL_HOTKEY_LABEL, KILL_PRESSES, KILL_STAGES, killButtonProps, killStageLabel, summarizeIncident } from "@/features/trading/kill-switch-core";

/** One live kill in flight, whichever E-stop started it (red button or hotkey). The button reads it (disabled with a
 *  spinner meanwhile), so a dry run finishing, or the other E-stop, can't re-enable it mid-kill. */
export const useKillInFlight = create<{ on: boolean }>(() => ({ on: false }));

export async function tripKillSwitch(reason: string, dryRun = false): Promise<KillIncident & { note?: string }> {
  if (dryRun) return tradingApi.kill(reason, true);
  useKillInFlight.setState({ on: true });
  try {
    return await tradingApi.kill(reason, false);
  } finally {
    useKillInFlight.setState({ on: false });
  }
}

/** Mounted once in MainApp so the hotkey works from any section. Press it KILL_PRESSES times, each
 *  within KILL_CONFIRM_MS of the last, to trip; Esc disarms. The behaviour lives in createKillKeyListener (tested). */
export function useKillSwitchHotkey() {
  const toast = useToasts((s) => s.push);
  useEffect(() => installKillHotkey(window, { trip: (reason) => tripKillSwitch(reason), notify: toast }), [toast]);
}
