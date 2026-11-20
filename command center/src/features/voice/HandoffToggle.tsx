import { useEffect, useState } from "react";
import { ArrowRight, Volume2, VolumeX } from "lucide-react";
import { roleLabel } from "@/features/dispatcher/roles";
import { useSettings } from "@/stores/settings";
import { loadPool, useHandoffChip } from "./handoff-cues";

/** How long the routing chip stays up after a hand-off. */
export const CHIP_MS = 8000;

/**
 * Agents/Chat header (Phase 5): the "Vocal Handoffs" switch (persisted in settings) and the routing
 * chip. ON: a delegation plays the 3-beat exchange and shows the chip; OFF: the same delegation,
 * silently, chip only. The switch never touches a job already running.
 */
export function HandoffToggle() {
  const on = useSettings((s) => s.routing.vocalHandoffs);
  const set = useSettings((s) => s.set);
  const path = useHandoffChip((s) => s.poolPath);
  useEffect(() => void loadPool(), []);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => set({ routing: { ...useSettings.getState().routing, vocalHandoffs: !on } })}
      className={`flex h-9 items-center gap-2 rounded-full border px-3 text-[12px] transition-colors ${on ? "border-teal/50 bg-teal/10 text-teal-soft" : "border-white/10 text-ink-3 hover:text-ink-2"}`}
      title={`Vocal Handoffs: when Tony delegates, a ≤5 s spoken exchange in Tony's and the agent's voices. Off: the hand-off happens silently (routing chip only).${path ? `\nEdit the lines in ${path}` : ""}`}
    >
      {on ? <Volume2 size={13} /> : <VolumeX size={13} />}
      <span>Agent Chatter: {on ? "On" : "Off"}</span>
      <span aria-hidden className={`relative h-4 w-7 rounded-full transition-colors ${on ? "bg-teal/70" : "bg-white/15"}`}>
        <span className={`absolute top-0.5 size-3 rounded-full bg-canvas transition-all ${on ? "left-3.5" : "left-0.5"}`} />
      </span>
    </button>
  );
}

/** "TONY → CODER" for a few seconds after each hand-off (🔊 when the exchange played). */
export function HandoffChip() {
  const chip = useHandoffChip((s) => s.chip);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!chip) return;
    const left = chip.at + CHIP_MS - Date.now();
    if (left <= 0) return;
    const t = setTimeout(() => tick((n) => n + 1), left);
    return () => clearTimeout(t);
  }, [chip]);
  if (!chip || Date.now() - chip.at > CHIP_MS) return null;
  return (
    <span role="status" className="label-caps flex h-9 items-center gap-1.5 rounded-full border border-amber/40 bg-amber/10 px-3 !text-[10px] text-amber-soft">
      {chip.voiced ? <Volume2 size={11} /> : <VolumeX size={11} className="opacity-60" />}
      {roleLabel("general")} <ArrowRight size={10} /> {roleLabel(chip.to)}
    </span>
  );
}
