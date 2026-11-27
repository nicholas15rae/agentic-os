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

/** The red button's onKeyDown: a held Enter / Space must not click it again. */
export function guardKillButtonKeydown(e: Pick<KeyboardEvent, "key" | "repeat" | "preventDefault">): void {
  if (isRepeatActivation(e)) e.preventDefault();
}

/** Handlers and labels for TradingDesk's red button, spread onto the <button>: kept here so the key-repeat guard
 *  is tested, not just the helper it calls. `pressed` = clicks so far in the current sequence (0 = disarmed). */
export function killButtonProps({ pressed, busy, onPress }: { pressed: number; busy: boolean; onPress: () => void }) {
  const armed = pressed > 0;
  const remaining = KILL_PRESSES - pressed;
  const s = remaining === 1 ? "" : "s";
  return {
    onClick: onPress,
    onKeyDown: guardKillButtonKeydown,
    disabled: busy,
    "aria-label": armed
      ? `Kill switch armed: ${remaining} more click${s} to lock trading, cancel all orders, sell all positions at market`
      : `Kill switch: click ${KILL_PRESSES} times to lock trading, cancel all orders, flatten all positions`,
    title: armed
      ? `${remaining} more click${s}, each within ${KILL_CONFIRM_MS / 1000} s`
      : `Kill switch (or ${KILL_HOTKEY_LABEL} ×${KILL_PRESSES}): click ${KILL_PRESSES} times. Locks, cancels all orders, flattens all positions`,
  };
}

/** Registers the kill-switch keydown listener on `target` (the window) in the capture phase; returns the uninstall.
 *  useKillSwitchHotkey is exactly useEffect(() => installKillHotkey(window, …)). */
export function installKillHotkey(target: Pick<EventTarget, "addEventListener" | "removeEventListener">,
  deps: Parameters<typeof createKillKeyListener>[0]): () => void {
  const onKey = createKillKeyListener(deps) as unknown as EventListener;
  target.addEventListener("keydown", onKey, { capture: true });
  return () => target.removeEventListener("keydown", onKey, { capture: true });
}

export type KillToast = { title: string; body: string; tone: "info" | "warn" | "error" };
type KillKeyEvent = Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "key" | "repeat" | "preventDefault" | "stopPropagation">;

/** The keydown listener useKillSwitchHotkey registers on window (capture phase). Pure: trip / notify / clock are
 *  injected, so the whole behaviour is tested: only deliberate presses count (a held chord's autorepeat is swallowed
 *  and never counted), Esc disarms, the 3rd press within the window trips. */
export function createKillKeyListener(deps: {
  trip: (reason: string) => Promise<KillIncident & { note?: string }>;
  notify: (t: KillToast) => void;
  now?: () => number;
  arm?: ReturnType<typeof createKillArm>;
}): (e: KillKeyEvent) => void {
  const arm = deps.arm ?? createKillArm();
  const now = deps.now ?? Date.now;
  const { notify } = deps;
  return (e) => {
    if (e.key === "Escape" && arm.isArmed(now())) {
      arm.cancel();
      notify({ title: "Kill switch disarmed", body: "Nothing was sent.", tone: "info" });
      return;
    }
    const k = classifyKillKey(e);
    if (k === "none") return;
    e.preventDefault();
    e.stopPropagation();
    if (k === "repeat") return; // a held chord's autorepeat is not a deliberate press
    const r = arm.press(now());
    if (r.kind === "arming") {
      notify({
        title: `Kill switch ARMED (${KILL_PRESSES - r.remaining}/${KILL_PRESSES})`,
        body: `Press ${KILL_HOTKEY_LABEL} ${r.remaining} more time${r.remaining === 1 ? "" : "s"} (each within ${KILL_CONFIRM_MS / 1000} s) to lock trading, cancel all orders and sell all positions at market. Esc cancels.`,
        tone: "warn",
      });
      return;
    }
    notify({ title: "KILL SWITCH", body: "Locking trading, cancelling orders, flattening positions…", tone: "error" });
    deps
      .trip(`keyboard ${KILL_HOTKEY_LABEL} x${KILL_PRESSES} (confirmed)`)
      .then((res) => notify({ title: killToastTitle(res), body: summarizeIncident(res), tone: "error" }))
      .catch((err: Error) => notify({ title: "Kill switch call failed", body: `${err.message}. Use the red button or the bridge CLI.`, tone: "error" }));
  };
}

/** The toast title for a live kill's result. A second press while a kill ran reports that kill, as it went. */
export function killToastTitle(r: KillIncident): string {
  if (r.alreadyRunning) return r.ok ? "Kill switch already running" : "Kill switch already ran, with errors";
  return r.ok || r.failsafe ? "Trading LOCKED" : "Kill switch: locked with errors";
}

export function summarizeIncident(r: KillIncident & { note?: string }): string {
  if (r.alreadyRunning) return r.note ?? "A kill is already running: nothing more was sent.";
  if (r.failsafe) return r.note ?? "Lock written by the gateway; cancel/flatten started.";
  const bad = r.steps?.filter((s) => !s.ok).map((s) => `${s.step}: ${s.detail}`) ?? [];
  const head = `${r.dryRun ? "Dry run" : "Locked"} · ${r.cancelled?.length ?? 0} order(s) ${r.dryRun ? "to cancel" : "cancelled"} · ${r.flatten?.length ?? 0} position(s) ${r.dryRun ? "to flatten" : "flattening"}`;
  return bad.length ? `${head} — ${bad.join(" · ")}` : head;
}

