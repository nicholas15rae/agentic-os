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
