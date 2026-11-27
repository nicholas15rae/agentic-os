import { useEffect } from "react";
import { useToasts } from "@/features/reminders/notify";
import { tradingApi, type KillIncident } from "@/features/trading/ibkr";
import { classifyKillKey, createKillArm, KILL_CONFIRM_MS, KILL_HOTKEY_LABEL, KILL_PRESSES, summarizeIncident } from "@/features/trading/kill-switch-core";

export { classifyKillKey, createKillArm, isKillHotkey, isRepeatActivation, KILL_CONFIRM_MS, KILL_HOTKEY_LABEL, KILL_PRESSES, KILL_STAGES, killStageLabel, summarizeIncident } from "@/features/trading/kill-switch-core";

export async function tripKillSwitch(reason: string, dryRun = false): Promise<KillIncident & { note?: string }> {
  return tradingApi.kill(reason, dryRun);
}

/** Mounted once in MainApp so the hotkey works from any section. Press it KILL_PRESSES times, each
 *  within KILL_CONFIRM_MS of the last, to trip; Esc disarms. */
export function useKillSwitchHotkey() {
  const toast = useToasts((s) => s.push);
  useEffect(() => {
    const arm = createKillArm();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && arm.isArmed(Date.now())) {
        arm.cancel();
        toast({ title: "Kill switch disarmed", body: "Nothing was sent.", tone: "info" });
        return;
      }
      const k = classifyKillKey(e);
      if (k === "none") return;
      e.preventDefault();
      e.stopPropagation();
      if (k === "repeat") return; // a held chord's autorepeat is not a deliberate press
      const r = arm.press(Date.now());
      if (r.kind === "arming") {
        toast({
          title: `Kill switch ARMED (${KILL_PRESSES - r.remaining}/${KILL_PRESSES})`,
          body: `Press ${KILL_HOTKEY_LABEL} ${r.remaining} more time${r.remaining === 1 ? "" : "s"} (each within ${KILL_CONFIRM_MS / 1000} s) to lock trading, cancel all orders and sell all positions at market. Esc cancels.`,
          tone: "warn",
        });
        return;
      }
      toast({ title: "KILL SWITCH", body: "Locking trading, cancelling orders, flattening positions…", tone: "error" });
      tripKillSwitch(`keyboard ${KILL_HOTKEY_LABEL} x${KILL_PRESSES} (confirmed)`)
        .then((res) => toast({ title: res.ok || res.failsafe ? "Trading LOCKED" : "Kill switch: locked with errors", body: summarizeIncident(res), tone: "error" }))
        .catch((err: Error) => toast({ title: "Kill switch call failed", body: `${err.message}. Use the red button or the bridge CLI.`, tone: "error" }));
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [toast]);
}
