import type { KillIncident } from "@/features/trading/ibkr";

// Pure helpers (no store / browser imports) so they're unit-testable in node.
/** Ctrl+Shift+X anywhere in the app: press it KILL_PRESSES times, each within KILL_CONFIRM_MS of the last. */
export const KILL_HOTKEY_LABEL = "Ctrl+Shift+X";

/** Presses needed to trip the kill switch (button or hotkey). The user asked for three. */
export const KILL_PRESSES = 3;

/** How long an armed kill switch waits for the next press before it disarms itself. */
export const KILL_CONFIRM_MS = 5_000;

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

export function summarizeIncident(r: KillIncident & { note?: string }): string {
  if (r.failsafe) return r.note ?? "Lock written by the gateway; cancel/flatten started.";
  const bad = r.steps?.filter((s) => !s.ok).map((s) => `${s.step}: ${s.detail}`) ?? [];
  const head = `${r.dryRun ? "Dry run" : "Locked"} · ${r.cancelled?.length ?? 0} order(s) ${r.dryRun ? "to cancel" : "cancelled"} · ${r.flatten?.length ?? 0} position(s) ${r.dryRun ? "to flatten" : "flattening"}`;
  return bad.length ? `${head} — ${bad.join(" · ")}` : head;
}

