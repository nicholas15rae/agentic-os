import { useEffect } from "react";
import { useToasts } from "@/features/reminders/notify";
import { tradingApi, type KillIncident } from "@/features/trading/ibkr";
import { installKillHotkey } from "@/features/trading/kill-switch-core";

export { classifyKillKey, createKillArm, createKillKeyListener, guardKillButtonKeydown, installKillHotkey, isKillHotkey, isRepeatActivation, KILL_CONFIRM_MS, KILL_HOTKEY_LABEL, KILL_PRESSES, KILL_STAGES, killButtonProps, killStageLabel, summarizeIncident } from "@/features/trading/kill-switch-core";

export async function tripKillSwitch(reason: string, dryRun = false): Promise<KillIncident & { note?: string }> {
  return tradingApi.kill(reason, dryRun);
}

/** Mounted once in MainApp so the hotkey works from any section. Press it KILL_PRESSES times, each
 *  within KILL_CONFIRM_MS of the last, to trip; Esc disarms. The behaviour lives in createKillKeyListener (tested). */
export function useKillSwitchHotkey() {
  const toast = useToasts((s) => s.push);
  useEffect(() => installKillHotkey(window, { trip: (reason) => tripKillSwitch(reason), notify: toast }), [toast]);
}
