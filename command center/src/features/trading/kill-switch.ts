import { useEffect } from "react";
import { useToasts } from "@/features/reminders/notify";
import { tradingApi, type KillIncident } from "@/features/trading/ibkr";
import { isKillHotkey, KILL_HOTKEY_LABEL, summarizeIncident } from "@/features/trading/kill-switch-core";

export { isKillHotkey, KILL_HOTKEY_LABEL, summarizeIncident } from "@/features/trading/kill-switch-core";

export async function tripKillSwitch(reason: string, dryRun = false): Promise<KillIncident & { note?: string }> {
  return tradingApi.kill(reason, dryRun);
}

/** Mounted once in MainApp so the hotkey works from any section. */
export function useKillSwitchHotkey() {
  const toast = useToasts((s) => s.push);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isKillHotkey(e)) return;
      e.preventDefault();
      e.stopPropagation();
      toast({ title: "KILL SWITCH", body: "Locking trading, cancelling orders, flattening positions…", tone: "error" });
      tripKillSwitch(`keyboard ${KILL_HOTKEY_LABEL}`)
        .then((r) => toast({ title: r.ok || r.failsafe ? "Trading LOCKED" : "Kill switch: locked with errors", body: summarizeIncident(r), tone: "error" }))
        .catch((err: Error) => toast({ title: "Kill switch call failed", body: `${err.message}. Use the red button or the bridge CLI.`, tone: "error" }));
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [toast]);
}
