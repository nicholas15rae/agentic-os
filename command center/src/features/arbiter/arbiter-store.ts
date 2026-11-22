import { create } from "zustand";
import { isTauri } from "@/lib/platform";
import { acmd, onArbiterEvent, type ArbiterSnapshot, type ArbiterStateEvent, type Handoff } from "./api";

/**
 * Live compute-arbiter state for the System Map and the Away button. Push first: `arbiter-state`
 * (node view on change) and `arbiter-handoff` (one row per pass). `refresh()` pulls the full
 * snapshot (hardware, latency, memory) — the HUD calls it on its own visible-only poll.
 */
export interface ArbiterStore {
  snap: ArbiterSnapshot | null;
  /** Hand-offs that arrived since mount (newest last), for edge pulses. */
  pulses: (Handoff & { key: number })[];
  error: string | null;
  started: boolean;
  start: () => Promise<void>;
  refresh: () => Promise<void>;
  setAway: (on: boolean) => Promise<void>;
}

const PULSE_MAX = 24;
let seq = 0;

export const useArbiter = create<ArbiterStore>((set, get) => ({
  snap: null,
  pulses: [],
  error: null,
  started: false,
  async start() {
    if (get().started || !isTauri()) return;
    set({ started: true });
    await onArbiterEvent<ArbiterStateEvent>("arbiter-state", (e) => {
      const cur = get().snap;
      set({ snap: cur ? { ...cur, nodes: e.nodes, away: e.away, holder: e.holder } : null });
      if (!cur) void get().refresh();
    });
    await onArbiterEvent<Handoff>("arbiter-handoff", (h) => {
      const cur = get().snap;
      set({
        pulses: [...get().pulses, { ...h, key: ++seq }].slice(-PULSE_MAX),
        snap: cur ? { ...cur, feed: [h, ...cur.feed].slice(0, 40) } : cur,
      });
    });
    await get().refresh();
  },
  async refresh() {
    try {
      set({ snap: await acmd("arbiter_snapshot"), error: null });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },
  async setAway(on) {
    try {
      set({ snap: await acmd("arbiter_set_away", { on }), error: null });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },
}));
