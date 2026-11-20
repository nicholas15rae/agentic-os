import { create } from "zustand";
import { resyncCollections } from "@/lib/cc-api";
import { useOs } from "@/features/os/os-store";
import { useVoice, type VoiceState } from "@/features/voice/voice-store";
import { useCueRun } from "@/features/cues/player";

/**
 * Refresh / Hard Reload (Phase 1).
 *
 * - Soft (default): drop the cached collections, re-sync them and the OS config from the
 *   gateway / Rust, then re-mount the section view (`epoch` is `<main>`'s key in App.tsx). The
 *   voice HUD, TTS engine, cue player, Spotify duck / hold and the mic all live OUTSIDE `<main>`
 *   (module singletons + the always-mounted VoiceHUD), so a soft refresh cannot interrupt them.
 * - Hard: a full webview reload (`location.reload()`) to pick up a new frontend build. It would
 *   kill in-webview audio (Tony's TTS, a cue theme) and forget a media hold, so it only runs once
 *   all of that is idle; while audio stays busy it waits, then falls back to a soft refresh.
 *   Spotify itself plays in its own app and is never paused, skipped or reset by either.
 */
export const useRefresh = create<{ epoch: number; busy: boolean; bump: () => void }>((set) => ({
  epoch: 0,
  busy: false,
  bump: () => set((s) => ({ epoch: s.epoch + 1 })),
}));

/** Voice states with live audio or an open mic (a reload would cut them). Pure. */
const QUIET: ReadonlySet<VoiceState> = new Set<VoiceState>(["idle", "error"]);

export interface AudioSnapshot {
  voiceState: VoiceState;
  /** A cue (theme / soundbite) is running in the webview's AudioContext. */
  cueRunning: boolean;
}

export function audioBusy(a: AudioSnapshot): boolean {
  return !QUIET.has(a.voiceState) || a.cueRunning;
}

export const audioSnapshot = (): AudioSnapshot => ({ voiceState: useVoice.getState().state, cueRunning: !!useCueRun.getState().running });

export interface RefreshDeps {
  resync: () => Promise<unknown>;
  reloadConfig: () => Promise<unknown>;
  remount: () => void;
  reload: () => void;
  audio: () => AudioSnapshot;
  sleep: (ms: number) => Promise<void>;
}

const defaultDeps = (): RefreshDeps => ({
  resync: resyncCollections,
  reloadConfig: () => useOs.getState().load(),
  remount: () => useRefresh.getState().bump(),
  reload: () => location.reload(),
  audio: audioSnapshot,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
});

/** Soft refresh: caches → gateway re-sync → re-mount. Never touches audio. */
export async function softRefresh(deps: RefreshDeps = defaultDeps()): Promise<void> {
  useRefresh.setState({ busy: true });
  try {
    await Promise.allSettled([deps.resync(), deps.reloadConfig()]);
    deps.remount();
  } finally {
    useRefresh.setState({ busy: false });
  }
}

export type HardOutcome = "reloaded" | "soft-fallback";

/** Hard reload once audio is idle (polls every 500 ms up to `waitMs`); else a soft refresh. */
export async function hardRefresh(deps: RefreshDeps = defaultDeps(), waitMs = 15_000): Promise<HardOutcome> {
  for (let waited = 0; audioBusy(deps.audio()); waited += 500) {
    if (waited >= waitMs) {
      await softRefresh(deps);
      return "soft-fallback";
    }
    await deps.sleep(500);
  }
  deps.reload();
  return "reloaded";
}
