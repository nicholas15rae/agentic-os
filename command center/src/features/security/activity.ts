import { isTauri } from "@/lib/platform";

/** Activity reaches Rust at most this often (Rust owns the idle lock and step-up idle timers). */
export const ACTIVITY_EVERY_MS = 30_000;

let last = 0;

/**
 * "Nic is using the app": throttled `security_touch`. Pointer / key / wheel / touch input sends it
 * from the SecurityGate; section pass: so do Tony's turns (spoken or typed) and hands-free
 * listening, so talking to Tony no longer counts as idle (the 15-minute lock) and keeps open
 * PIN step-ups alive. Never unlocks anything: Rust ignores a touch on a locked session.
 */
export function reportActivity(now = Date.now(), send: () => Promise<unknown> = sendTouch): boolean {
  if (!isTauri() || now - last < ACTIVITY_EVERY_MS) return false;
  last = now;
  void send().catch(() => undefined);
  return true;
}

/** Lazy, so the voice controller doesn't pull the security API into its import graph. */
const sendTouch = () => import("./api").then((m) => m.securityApi.touch());

/** Tests only. */
export function resetActivityForTests() {
  last = 0;
}
