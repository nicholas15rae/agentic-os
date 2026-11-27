import { useEffect, useState } from "react";
import { cmd, isTauri } from "@/lib/platform";
import type { EngineSwitchView } from "./engine";

/** Section 26: where Tony's chat / compaction run now (engine.json, read by Rust). Polls every
 * `everyMs`; null outside the desktop app or before the first answer. Read-only. */
export function useEngineSwitch(everyMs = 10_000): EngineSwitchView | null {
  const [v, setV] = useState<EngineSwitchView | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    let live = true;
    const tick = () => void cmd("engine_switch_get").then((x) => live && setV(x), () => undefined);
    tick();
    const t = setInterval(tick, everyMs);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [everyMs]);
  return v;
}
