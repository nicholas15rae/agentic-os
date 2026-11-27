/**
 * The mic's TRUE state for the HUD surfaces (Phase 2 Part D), from the mic gate (`useMic`) and the
 * voice state. Pure: no React, no stores.
 *
 *   locked — the line is dead: the gate is off and no capture holds the mic.
 *   leak   — the gate is off but a capture is still registered as open. Should never happen
 *            (muting stops every capture synchronously); shown loudly if it ever does.
 *   live   — the gate is on and a capture is open (or the voice state says it is listening).
 *   armed  — the gate is on, nothing is capturing right now.
 *
 * A voice state can never make a locked mic look live: only the gate and the capture count can.
 */
export type MicIndicator = "locked" | "leak" | "live" | "armed";

const LISTENING_STATES = new Set(["listening", "transcribing"]);

export function micIndicator(enabled: boolean, live: number, state?: string | null): MicIndicator {
  if (!enabled) return live > 0 ? "leak" : "locked";
  return live > 0 || (state != null && LISTENING_STATES.has(state)) ? "live" : "armed";
}

/** Locked or leaking: the surfaces show the red locked-off treatment instead of the state dot. */
export const isMicOff = (i: MicIndicator): boolean => i === "locked" || i === "leak";

/**
 * The phone HUD's mic chips: the phone's own lock, and the desktop mic from the mirror
 * (`voice.micEnabled`; undefined = an older desktop without the key, treated as on).
 */
export function hudMicChips(phoneEnabled: boolean, deskEnabled: boolean | undefined, desktop: boolean): string[] {
  const out: string[] = [];
  if (!phoneEnabled) out.push("MIC LOCKED");
  if (!desktop && deskEnabled === false) out.push("DESK MIC OFF");
  return out;
}
