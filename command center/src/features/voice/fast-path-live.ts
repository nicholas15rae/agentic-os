/**
 * Instant cues (Section 20.10): the live side of `fast-path.ts`. Reads ONLY what the client
 * stores already hold — the clock's weather reading, the synced "reminders" and Finance
 * collections, the user's fast cues in the "cues" collection — and never fetches. Any handler
 * that can't answer from that (stale weather, a collection not loaded, a frozen tool, a locked
 * session) returns null and the turn falls through to the model unchanged.
 */
import { collections } from "@/lib/cc-api";
import { useSettings } from "@/stores/settings";
import { useWeather } from "@/features/weather/weather-store";
import { isTonyToolLiveNow } from "@/features/modes/modes-store";
import type { CueWidget } from "@/features/cues/types";
import type { Reminder } from "@/features/reminders/types";
import { dateReply, isFastTarget, matchFastPath, pendingReply, timeReply, weatherReply, type FastCueSpec, type FastHandlerId, type FastMatch } from "./fast-path";

/** The fast-path switches (Settings → Voice & Triggers). Missing = on. */
export function fastPathSettings(): { builtins: boolean; userCues: boolean } {
  const f = (useSettings.getState() as { fastPath?: { builtins?: boolean; userCues?: boolean } }).fastPath;
  return { builtins: f?.builtins !== false, userCues: f?.userCues !== false };
}

/** Nic's fast cues: cue documents carrying a `fast` spec (enabled, not deleted). */
export function userFastCues(): (FastCueSpec & { id: string })[] {
  const out: (FastCueSpec & { id: string })[] = [];
  for (const c of collections.snapshot<CueWidget>("cues")) {
    const f = c.fast;
    if (!c.enabled || c._deleted || !f || !f.phrase || !isFastTarget(f.target)) continue;
    out.push({ id: c.id, phrase: f.phrase, target: f.target, reply: f.reply });
  }
  return out;
}

/** Match `line` against the built-ins and the user's fast cues, per the settings. */
export function matchFastLine(line: string): FastMatch | null {
  const s = fastPathSettings();
  if (!s.builtins && !s.userCues) return null;
  const st = useSettings.getState();
  const names = [st.osName || "Tony", ...(st.wakeWords ?? [])];
  return matchFastPath(line, { builtins: s.builtins, userCuesOn: s.userCues, userCues: s.userCues ? userFastCues() : [], names });
}

/**
 * The spoken answer for a READ-ONLY handler, or null (→ fall through). Throws only on a bug in
 * a handler; the controller treats a throw as a fall-through too.
 */
export function answerReadOnly(handler: FastHandlerId, now = Date.now()): string | null {
  switch (handler) {
    case "time":
      return timeReply(new Date(now), useSettings.getState().clock?.hourCycle ?? "h12");
    case "date":
      return dateReply(new Date(now));
    case "weather":
      // Frozen weather (switchboard) → the normal turn, where Rust gives the frozen reason.
      if (!isTonyToolLiveNow("weather")) return null;
      return weatherReply(useWeather.getState().now, now);
    case "pending": {
      if (!collections.loaded("reminders")) return null;
      const reminders = collections.snapshot<Reminder>("reminders");
      // Reminders only: money questions go to finance.ask (live gateway data), never a stale copy.
      return pendingReply({ reminders, finance: null, now });
    }
    default:
      return null;
  }
}
