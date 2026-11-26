import { cmd } from "@/lib/platform";
import { isAndroidApp, useSettings } from "@/stores/settings";

/**
 * Android app: keep the gateway token across restarts. It's never in localStorage (the settings
 * store's `partialize` drops it); the Rust `phone_secret_*` commands keep it encrypted with an
 * Android Keystore key (SecureStorePlugin.kt). Loaded once at start; every later change is saved
 * (an emptied field forgets it). The desktop and the browser PWA keep the old behaviour.
 */
let started = false;
let loading: Promise<unknown> | null = null;

/**
 * Resolves once the stored token has been read (Android), so gateway calls carry it instead of
 * failing with 401 (which once emptied the cue list and re-seeded the built-in cues). Each call
 * waits at most 8 s: while the app is still locked (the read waits for the unlock) the background
 * pollers then go without, and the app's pages, which mount only after the unlock, get the token
 * read right then. Off Android it resolves at once.
 */
export function phoneTokenReady(): Promise<void> {
  if (!isAndroidApp()) return Promise.resolve();
  loading ??= initPhoneToken();
  return Promise.race([loading.then(() => undefined, () => undefined), new Promise<void>((r) => setTimeout(r, READY_CAP_MS))]);
}

/** How long one gateway call waits for the stored token before going without it. */
const READY_CAP_MS = 8000;
const RETRY_MS = 250;
/** Non-lock failures (the secure store still starting): ~7 s of retries, then give up. */
const RETRIES = 28;
const LOCKED_BACKOFF_MAX_MS = 5000;

export interface TokenDeps {
  wait: (ms: number) => Promise<void>;
  /** Resolves once the app is unlocked (the lock screen gone; Rust's gate passes commands again). */
  unlocked: () => Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The Rust security gate refused the call because the app is locked: not a failure, a wait. */
export const isLockRefusal = (e: unknown): boolean => /^(HARD_)?LOCKED:/.test(typeof e === "string" ? e : e instanceof Error ? e.message : "");

/** Resolves once the security store shows a live session (as SecurityGate decides it). */
async function untilUnlocked(): Promise<void> {
  const { useSecurity } = await import("@/features/security/store");
  type S = ReturnType<typeof useSecurity.getState>["status"];
  const live = (s: S) => !!s && !s.hardLocked && (!s.enabled || !s.session.locked);
  if (live(useSecurity.getState().status)) return;
  await new Promise<void>((resolve) => {
    const off = useSecurity.subscribe((st) => {
      if (!live(st.status)) return;
      off();
      resolve();
    });
  });
}

/**
 * Read the stored token. The phone app starts LOCKED (biometric / PIN), and until it is unlocked
 * Rust's gate refuses every command, this read included (`LOCKED: ...`, before it ever reaches the
 * Keystore). Giving up there left the app with no token, so every gateway call 401'd (the Language
 * Hub "401") until the next restart. So: on a lock refusal, wait for the unlock and read again (no
 * limit, the lock can last any time; the backoff only matters if the status were ever stale). Any
 * other failure is retried for ~7 s. `null` (nothing stored) is an answer, not a failure.
 */
async function readSaved(d: TokenDeps): Promise<string | null> {
  let failures = 0;
  let lockWaits = 0;
  for (;;) {
    try {
      return (await cmd("phone_secret_get", { key: "gateway-token" })) ?? null;
    } catch (e) {
      if (isLockRefusal(e)) {
        await Promise.all([d.unlocked(), d.wait(Math.min(RETRY_MS * 2 ** lockWaits++, LOCKED_BACKOFF_MAX_MS))]);
        continue;
      }
      if (++failures > RETRIES) throw e;
      await d.wait(RETRY_MS);
    }
  }
}

/** Returns the unsubscribe (tests); the app calls it once and never stops. */
export async function initPhoneToken(deps: Partial<TokenDeps> = {}): Promise<(() => void) | undefined> {
  if (started || !isAndroidApp()) return undefined;
  started = true;
  const d: TokenDeps = { wait: sleep, unlocked: untilUnlocked, ...deps };
  try {
    const saved = await readSaved(d);
    if (saved && !useSettings.getState().gatewayToken.trim()) useSettings.getState().set({ gatewayToken: saved });
  } catch {
    /* store unavailable: the field still works for this session */
  }
  let last = useSettings.getState().gatewayToken;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unsubscribe = useSettings.subscribe((s) => {
    if (s.gatewayToken === last) return;
    last = s.gatewayToken;
    clearTimeout(timer);
    timer = setTimeout(() => void cmd("phone_secret_set", { key: "gateway-token", value: last.trim() }).catch(() => undefined), 600);
  });
  return () => {
    clearTimeout(timer);
    unsubscribe();
  };
}
