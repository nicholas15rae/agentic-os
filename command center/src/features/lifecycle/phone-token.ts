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
 * Resolves once the stored token has been read (Android; at most ~3 s), so the first gateway calls
 * at launch carry it instead of failing with 401 (which emptied the cue list and re-seeded the
 * built-in cues). Off Android it resolves at once.
 */
export function phoneTokenReady(): Promise<void> {
  if (!isAndroidApp()) return Promise.resolve();
  loading ??= initPhoneToken();
  return Promise.race([loading.then(() => undefined, () => undefined), new Promise<void>((r) => setTimeout(r, 3000))]);
}

/** Returns the unsubscribe (tests); the app calls it once and never stops. */
export async function initPhoneToken(): Promise<(() => void) | undefined> {
  if (started || !isAndroidApp()) return undefined;
  started = true;
  try {
    const saved = await cmd("phone_secret_get", { key: "gateway-token" });
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
