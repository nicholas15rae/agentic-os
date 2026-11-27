import { create } from "zustand";
import { isTauri } from "@/lib/platform";
import { onExtEvent, xcmd } from "@/lib/native-ext";
import type { BuildHubView } from "./types";

/**
 * The staging hub view, pushed by Rust (`build-hub` after every change; the hub loop does all
 * polling, probing and orchestration off the UI thread). Desktop only.
 */
interface HubStore {
  view: BuildHubView | null;
  error: string | null;
  set: (v: BuildHubView) => void;
}

export const useHub = create<HubStore>((set) => ({ view: null, error: null, set: (view) => set({ view, error: null }) }));

let started = false;

export function startHub(): void {
  if (started || !isTauri()) return;
  started = true;
  void onExtEvent<BuildHubView>("build-hub", (v) => useHub.getState().set(v));
  void xcmd("build_hub_view")
    .then((v) => useHub.getState().set(v))
    .catch((e) => useHub.setState({ error: e instanceof Error ? e.message : String(e) }));
}

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Clear an input only once its command succeeded: `run()` reports a failure with a toast and
 * resolves `undefined`, and what Nic typed (a Steer directive, a repair note) must survive that.
 */
export async function clearOnSuccess<T>(p: Promise<T | undefined>, clear: () => void): Promise<T | undefined> {
  const r = await p;
  if (r !== undefined) clear();
  return r;
}
