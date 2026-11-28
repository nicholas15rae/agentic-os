import { useEffect, useState } from "react";
import { Card } from "@/components/ui";
import { cmd } from "@/lib/platform";
import type { FastPathSettings } from "@/features/engine/engine";
import { Toggle } from "./os-ui";

/**
 * Settings → Engine / Models: Tony's latency fast path (fastpath.json, all OFF by default). Works on
 * every turn (desktop, phone, inbox), on LM Studio or the built-in engine alike.
 */
export function FastPathCard() {
  const [v, setV] = useState<FastPathSettings | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    void cmd("fastpath_get").then(setV, (e) => setMsg(String(e)));
  }, []);
  const set = (patch: Partial<FastPathSettings>) => {
    if (!v) return;
    void cmd("fastpath_set", { value: { ...v, ...patch } }).then(setV, (e) => setMsg(String(e)));
  };
  return (
    <Card title="Fast replies (latency)" hint="Off by default. Each one shaves a model or tool call off common turns; anything they can't answer goes the normal way.">
      <Toggle on={!!v?.smallTalkSkipsTools} disabled={!v} onChange={(x) => set({ smallTalkSkipsTools: x })} label="Small talk skips tools" hint="“Hey Tony”, “thanks, that's all”: no tool planner or router, straight to the reply." />
      <Toggle on={!!v?.instantCues} disabled={!v} onChange={(x) => set({ instantCues: x })} label="Instant answers" hint="Time, date, weather and PC stats answered with no model run (weather and stats need the cache below)." />
      <Toggle on={!!v?.statsCache} disabled={!v} onChange={(x) => set({ statsCache: x })} label="Stats cache" hint="CPU, RAM, GPU, VRAM and GPU temperature every 5 s, home weather every 10 min; Tony reads these instead of looking them up live." />
      {msg && <p className="mt-2 text-xs text-amber">{msg}</p>}
    </Card>
  );
}
