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
 *   Mics that DO live under `<main>` (the Memory Module's dictation, Brainstorm Listen Mode) are
 *   registered as "mic" busy probes: while one is open the soft refresh re-syncs but skips the
 *   re-mount, so an in-progress dictation is never discarded.
 * - Hard: a full webview reload (`location.reload()`) to pick up a new frontend build. It would
 *   kill in-webview audio (Tony's TTS, a cue theme, a vocal handoff exchange) and any open mic, so
 *   it only runs once all of that is idle; while anything stays busy it waits, then falls back to
 *   a soft refresh. Spotify itself plays in its own app and is never paused, skipped or reset.
 */
export const useRefresh = create<{ epoch: number; busy: boolean; bump: () => void }>((set) => ({
  epoch: 0,
  busy: false,
  bump: () => set((s) => ({ epoch: s.epoch + 1 })),
}));

// ── Busy probes (registered by the shell, so this module stays free of the heavy voice modules) ──

/** "mic": an open microphone under `<main>` (blocks the re-mount and a hard reload).
 *  "audio": playing sound outside `<main>` (blocks only a hard reload). */
export type BusyKind = "mic" | "audio";
const probes = new Map<string, { kind: BusyKind; busy: () => boolean }>();

/** Register a busy probe; returns its unregister function. */
export function registerBusyProbe(name: string, kind: BusyKind, busy: () => boolean): () => void {
  probes.set(name, { kind, busy });
  return () => {
    if (probes.get(name)?.busy === busy) probes.delete(name);
  };
}

/** Names of the probes that are busy now (optionally of one kind). */
export function busyProbes(kind?: BusyKind): string[] {
  const out: string[] = [];
  for (const [name, p] of probes) {
    if (kind && p.kind !== kind) continue;
    try {
      if (p.busy()) out.push(name);
    } catch {
      /* a broken probe never blocks a refresh */
    }
  }
  return out;
}

/** Voice states with live audio or an open mic (a reload would cut them). Pure. */
const QUIET: ReadonlySet<VoiceState> = new Set<VoiceState>(["idle", "error"]);

export interface AudioSnapshot {
  voiceState: VoiceState;
  /** A cue (theme / soundbite) is running in the webview's AudioContext. */
  cueRunning: boolean;
  /** Busy probes (dictation, Brainstorm listening, a vocal handoff exchange…). */
  busy?: string[];
}

export function audioBusy(a: AudioSnapshot): boolean {
  return !QUIET.has(a.voiceState) || a.cueRunning || (a.busy?.length ?? 0) > 0;
}

export const audioSnapshot = (): AudioSnapshot => ({ voiceState: useVoice.getState().state, cueRunning: !!useCueRun.getState().running, busy: busyProbes() });

export interface RefreshDeps {
  resync: () => Promise<unknown>;
  reloadConfig: () => Promise<unknown>;
  remount: () => void;
  reload: () => void;
  audio: () => AudioSnapshot;
  /** Open mics under `<main>` (names); non-empty = skip the re-mount. */
  micBusy?: () => string[];
  sleep: (ms: number) => Promise<void>;
}

const defaultDeps = (): RefreshDeps => ({
  resync: resyncCollections,
  reloadConfig: () => useOs.getState().load(),
  remount: () => useRefresh.getState().bump(),
  reload: () => location.reload(),
  audio: audioSnapshot,
  micBusy: () => busyProbes("mic"),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
});

/** What a soft refresh did: re-synced and re-mounted, or re-synced only (a mic was open). */
export type SoftOutcome = { remounted: true } | { remounted: false; keptOpen: string[] };

/** Soft refresh: caches → gateway re-sync → re-mount (skipped while a mic under `<main>` is open). Never touches audio. */
export async function softRefresh(deps: RefreshDeps = defaultDeps()): Promise<SoftOutcome> {
  useRefresh.setState({ busy: true });
  try {
    await Promise.allSettled([deps.resync(), deps.reloadConfig()]);
    const open = deps.micBusy?.() ?? [];
    if (open.length) return { remounted: false, keptOpen: open };
    deps.remount();
    return { remounted: true };
  } finally {
    useRefresh.setState({ busy: false });
  }
}

export type HardOutcome = "reloaded" | "soft-fallback";

/** Hard reload once audio and mics are idle (polls every 500 ms up to `waitMs`); else a soft refresh. */
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
