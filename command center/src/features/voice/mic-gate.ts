import { create } from "zustand";

/**
 * Hard mic sovereignty (Phase 2 Part B): the webview's single source of truth for "may
 * anything listen right now?". Mute is a dead line, not a UI state:
 *
 *   - Every capture (MicCapture, a Web Speech recognizer) registers here while it holds the mic.
 *     Muting stops every one of them SYNCHRONOUSLY, before any listener runs.
 *   - `assertMicAllowed()` guards every capture start (before AudioContext, before and after
 *     getUserMedia); `platform.nativeRaw("stt_transcribe")` refuses while muted.
 *   - Desktop: Rust (`voice::MIC_ENABLED`, os.json `voice.micEnabled`) is authoritative. A mute is
 *     applied here first, then sent; an unmute waits for Rust's ack (a failed call stays muted).
 *   - Fail closed: the store starts locked and un-hydrated, so nothing can capture during startup.
 *
 * Pure at module scope (zustand only): no browser APIs, no static import of `@/lib/platform`
 * (platform imports this file for its own gate, so platform is loaded lazily here).
 */

export const MIC_LOCKED_MSG = "Mic is locked off";

export class MicLockedError extends Error {
  constructor() {
    super(MIC_LOCKED_MSG);
    this.name = "MicLockedError";
  }
}

/** One capture's live meter, mutated in place every audio frame (read in rAF, never React state). */
export interface MeterSnapshot {
  /** Input level, dBFS. */
  levelDb: number;
  /** Display-only running noise floor, dBFS (never part of the decision). */
  floorDb: number;
  /** The gate this frame was judged against, dBFS. */
  thrDb: number;
  /** Silero speech probability when the neural model is deciding, else null. */
  prob: number | null;
  speaking: boolean;
  neural: boolean;
}

interface MicStore {
  /** The line is live (false = locked off: zero capture, zero STT). */
  enabled: boolean;
  /** The authoritative state has been read once (or the read failed and we stayed locked). */
  hydrated: boolean;
  /** Captures holding the mic right now. */
  live: number;
  /** The meter of the capture that opened last (null when none is open). */
  activeMeter: MeterSnapshot | null;
}

export const useMic = create<MicStore>(() => ({ enabled: false, hydrated: false, live: 0, activeMeter: null }));

interface Capture {
  stop: () => void;
}

const captures = new Set<Capture>();
const listeners = new Set<(on: boolean) => void>();
/** Bumped by every local change: a slower hydration read never overwrites a newer choice. */
let version = 0;

export const micEnabled = (): boolean => useMic.getState().enabled;

export function assertMicAllowed(): void {
  if (!micEnabled()) throw new MicLockedError();
}

/** Stop every registered capture now (copy first: each stop() unregisters itself). */
export function killAllCaptures(): void {
  for (const c of [...captures]) {
    try {
      c.stop();
    } catch {
      /* a capture that fails to stop must not keep the others open */
    }
  }
  captures.clear();
}

/** Apply a state locally. Mute: every capture is stopped before any listener hears about it. */
export function setMicEnabledLocal(on: boolean): void {
  version++;
  const was = useMic.getState().enabled;
  if (!on) killAllCaptures();
  useMic.setState(on ? { enabled: true } : { enabled: false, activeMeter: null });
  if (was !== on) for (const l of [...listeners]) l(on);
}

export function onMicChange(fn: (on: boolean) => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** Hold the mic. Refused (throws `MicLockedError`) while muted. Returns the release function. */
export function registerCapture(c: Capture): () => void {
  assertMicAllowed();
  captures.add(c);
  return () => void captures.delete(c);
}

export function captureOpened(): void {
  useMic.setState((s) => ({ live: s.live + 1 }));
}

export function captureClosed(): void {
  useMic.setState((s) => ({ live: Math.max(0, s.live - 1) }));
}

/** The capture whose level the meters show (null clears it). */
export function publishMeter(m: MeterSnapshot | null): void {
  useMic.setState({ activeMeter: m });
}

/** Clear the meter only if it is still this capture's (a newer capture may own it). */
export function unpublishMeter(m: MeterSnapshot): void {
  if (useMic.getState().activeMeter === m) useMic.setState({ activeMeter: null });
}

async function phoneCommand(micEnabled: boolean): Promise<void> {
  const { gateway } = await import("@/lib/gateway");
  await gateway("/api/os/inbox", { method: "POST", body: JSON.stringify({ kind: "command", payload: { micEnabled } }) });
}

/**
 * The Mic switch. Disable: applied here synchronously (before any await), then sent to Rust /
 * the desktop; a failed send leaves it muted. Enable on desktop: Rust must ack first; any
 * failure stays muted. Enable on the phone: its own capture unlocks at once, then the desktop.
 * Resolves to the resulting state.
 */
export async function requestMicEnabled(on: boolean): Promise<boolean> {
  if (!on) setMicEnabledLocal(false);
  try {
    const p = await import("@/lib/platform");
    if (p.isTauri()) {
      const ack = await p.cmd("mic_set_enabled", { enabled: on });
      if (on && ack === true) setMicEnabledLocal(true);
    } else if (on) {
      setMicEnabledLocal(true);
      void phoneCommand(true).catch(() => undefined);
    } else {
      await phoneCommand(false);
    }
  } catch {
    /* fail closed: a failed mute is still muted here; a failed unmute never unlocked */
  }
  return micEnabled();
}

let hydrating: Promise<void> | null = null;
let phonePoll: ReturnType<typeof setInterval> | undefined;

/**
 * Read the authoritative state once (idempotent). Desktop: `mic_get` + the `mic-state` event.
 * Phone: `/api/os/state` `voice.micEnabled` (a desktop without the key predates Part B: live),
 * then a 10 s poll that only ever LOCKS (unlocking is a tap, never remote-by-poll). A failed
 * read stays locked and marks the store hydrated so the HUD can offer Unlock.
 */
export function hydrateMic(): Promise<void> {
  hydrating ??= (async () => {
    const v0 = version;
    try {
      const p = await import("@/lib/platform");
      if (p.isTauri()) {
        void p
          .onNativeEvent<{ enabled?: unknown }>("mic-state", (e) => {
            if (typeof e?.enabled === "boolean" && e.enabled !== micEnabled()) setMicEnabledLocal(e.enabled);
          })
          .catch(() => undefined);
        const on = await p.cmd("mic_get");
        if (typeof on === "boolean" && version === v0) setMicEnabledLocal(on);
      } else {
        const { gateway } = await import("@/lib/gateway");
        const st = await gateway<{ voice?: { micEnabled?: unknown } }>("/api/os/state");
        const remote = st?.voice?.micEnabled;
        if (version === v0) setMicEnabledLocal(remote !== false);
        clearInterval(phonePoll);
        phonePoll = setInterval(() => {
          void gateway<{ voice?: { micEnabled?: unknown } }>("/api/os/state")
            .then((s) => {
              if (s?.voice?.micEnabled === false && micEnabled()) setMicEnabledLocal(false);
            })
            .catch(() => undefined);
        }, 10_000);
      }
    } catch {
      /* stay as we are (locked by default) */
    }
    useMic.setState({ hydrated: true });
  })();
  return hydrating;
}

/** Tests only: back to the fail-closed boot state (listeners stay: modules register them once). */
export function resetMicGateForTests(): void {
  killAllCaptures();
  hydrating = null;
  clearInterval(phonePoll);
  version = 0;
  useMic.setState({ enabled: false, hydrated: false, live: 0, activeMeter: null });
}
