import { useEffect } from "react";
import { create } from "zustand";
import { useToasts } from "@/features/reminders/notify";
import { tradingApi, type KillIncident } from "@/features/trading/ibkr";
import { installKillHotkey } from "@/features/trading/kill-switch-core";

export { classifyKillKey, createKillArm, createKillKeyListener, guardKillButtonKeydown, installKillHotkey, isKillHotkey, isRepeatActivation, KILL_CONFIRM_MS, KILL_HOTKEY_LABEL, KILL_PRESSES, KILL_STAGES, killButtonProps, killStageLabel, killToastTitle, summarizeIncident } from "@/features/trading/kill-switch-core";

/** Live kills in flight, whichever E-stop started them (red button or hotkey). The button reads `on` (disabled with a
 *  spinner meanwhile), so a dry run finishing, or the other E-stop, can't re-enable it mid-kill. A count, not a flag:
 *  with the button and the hotkey both pressed, the first call to settle must not clear the other's. */
export const useKillInFlight = create<{ n: number; on: boolean }>(() => ({ n: 0, on: false }));

const inFlight = (d: 1 | -1) =>
  useKillInFlight.setState((s) => {
    const n = Math.max(0, s.n + d);
    return { n, on: n > 0 };
  });

export async function tripKillSwitch(reason: string, dryRun = false): Promise<KillIncident & { note?: string }> {
  if (dryRun) return tradingApi.kill(reason, true);
  inFlight(1);
  try {
    return await tradingApi.kill(reason, false);
  } finally {
    inFlight(-1);
  }
}

/** Mounted once in MainApp so the hotkey works from any section. Press it KILL_PRESSES times, each
 *  within KILL_CONFIRM_MS of the last, to trip; Esc disarms. The behaviour lives in createKillKeyListener (tested). */
export function useKillSwitchHotkey() {
  const toast = useToasts((s) => s.push);
  useEffect(() => installKillHotkey(window, { trip: (reason) => tripKillSwitch(reason), notify: toast }), [toast]);
}
