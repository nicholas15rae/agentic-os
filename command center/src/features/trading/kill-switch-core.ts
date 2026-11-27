import type { KillIncident } from "@/features/trading/ibkr";

// Pure helpers (no store / browser imports) so they're unit-testable in node.
/** Ctrl+Shift+X anywhere in the app: press it KILL_PRESSES times, each within KILL_CONFIRM_MS of the last. */
export const KILL_HOTKEY_LABEL = "Ctrl+Shift+X";

/** Presses needed to trip the kill switch (button or hotkey). The user asked for three. */
export const KILL_PRESSES = 3;

/** How long an armed kill switch waits for the next press before it disarms itself (a stray
 *  click resets after 4 s; a deliberate ARM → CONFIRM → EXECUTE still takes well under 2 s). */
export const KILL_CONFIRM_MS = 4_000;

/** Button label for each stage of the 3-click sequence: what the NEXT click does. */
export const KILL_STAGES = ["ARM", "CONFIRM", "EXECUTE KILL"] as const;

/** The label to show after `pressed` presses (0 = disarmed). */
export function killStageLabel(pressed: number, presses = KILL_PRESSES): string {
  if (presses === 3) return KILL_STAGES[Math.min(Math.max(pressed, 0), 2)];
  return pressed <= 0 ? "ARM" : pressed >= presses - 1 ? "EXECUTE KILL" : `CONFIRM (${presses - 1 - pressed} more)`;
}

/** After a press: still arming (with how many presses are left), or fire. */
export type KillPress = { kind: "arming"; remaining: number } | { kind: "fire" };

/** Multi-press arm/confirm so a stray click or keypress can't lock and flatten the account.
 *  Each press must come within `windowMs` of the previous one, or the count starts over. Firing disarms. */
export function createKillArm(presses = KILL_PRESSES, windowMs = KILL_CONFIRM_MS) {
  let count = 0;
  let last = 0;
  const live = (now: number) => count > 0 && now - last <= windowMs;
  return {
    press(now: number): KillPress {
      count = live(now) ? count + 1 : 1;
      last = now;
      if (count >= presses) {
        count = 0;
        return { kind: "fire" };
      }
      return { kind: "arming", remaining: presses - count };
    },
    cancel(): void {
      count = 0;
    },
    isArmed(now: number): boolean {
      return live(now);
    },
    /** Presses made so far in the current sequence (0 when disarmed). */
    pressed(now: number): number {
      return live(now) ? count : 0;
    },
  };
}

export function isKillHotkey(e: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "key">): boolean {
  return (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "x";
}

/** What a keydown means to the kill switch. "repeat" = OS autorepeat from a held chord: swallow it, but never
 *  count it, or holding Ctrl+Shift+X for ~0.5 s would stand in for three deliberate presses. */
export type KillKey = "none" | "repeat" | "press";

export function classifyKillKey(e: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "key" | "repeat">): KillKey {
  if (!isKillHotkey(e)) return "none";
  return e.repeat ? "repeat" : "press";
}

/** A held Enter on the focused red button: the browser fires a click on every autorepeat keydown, so one
 *  held key could complete the 3-click sequence. Its default must be prevented. (Space clicks on keyup: once.) */
export function isRepeatActivation(e: Pick<KeyboardEvent, "key" | "repeat">): boolean {
  return e.repeat && (e.key === "Enter" || e.key === " ");
}

export function summarizeIncident(r: KillIncident & { note?: string }): string {
  if (r.failsafe) return r.note ?? "Lock written by the gateway; cancel/flatten started.";
  const bad = r.steps?.filter((s) => !s.ok).map((s) => `${s.step}: ${s.detail}`) ?? [];
  const head = `${r.dryRun ? "Dry run" : "Locked"} · ${r.cancelled?.length ?? 0} order(s) ${r.dryRun ? "to cancel" : "cancelled"} · ${r.flatten?.length ?? 0} position(s) ${r.dryRun ? "to flatten" : "flattening"}`;
  return bad.length ? `${head} — ${bad.join(" · ")}` : head;
}

