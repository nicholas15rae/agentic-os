import { setQuietCheck, useCharacters } from "./character-store";
import { isDoneToast, quietReason, type CharacterEvent } from "./logic";

/**
 * What makes a character pop in. Anything can call `characterEvent`: the coins rewards (Section 28)
 * send "reward", a finished task or section sends "done" (streaks at 3, 5, 10 a day). Until those
 * call it directly, a "got it done" toast (Staged, Saved, Sent, Done…) counts as a finished thing.
 * Now and then a random "hey, what's up" (at most once an hour). Errors, warnings and alarms never
 * pop a character. Nothing pops in during a call, typing, full screen, the Trading page or Do Not
 * Disturb; `setQuiet` lets any feature (phone calls, a DND switch) hold them off.
 */
export function characterEvent(e: CharacterEvent): boolean {
  return useCharacters.getState().emit(e);
}

/** Reasons other features set to keep characters away ("dnd", "call"…). */
const quiet = new Set<string>();
export function setQuiet(reason: string, on: boolean): void {
  if (on) {
    quiet.add(reason);
    useCharacters.getState().leave();
  } else quiet.delete(reason);
}

type ToastLike = { id: string; title: string; tone: string };
type ToastStore = { getState(): { toasts: ToastLike[] }; subscribe(fn: (s: { toasts: ToastLike[] }) => void): () => void };

export interface CharacterEventDeps {
  toasts: ToastStore;
  /** Tony's voice state ("idle" when no conversation is live). */
  voiceState: () => string;
  /** The page on screen. */
  section: () => string;
  /** How often to roll for the random hello, and the odds per roll (the store keeps it ≤ once an hour). */
  helloEveryMs?: number;
  helloChance?: number;
  random?: () => number;
}

/** A key went down this recently = typing. */
export const TYPING_MS = 4_000;

const editable = (el: Element | null) => !!el && ((el as HTMLElement).isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

/** Watch the toasts, keep the quiet check current, roll for the random hello. Returns the uninstaller. */
export function installCharacterEvents(d: CharacterEventDeps): () => void {
  const hasDom = typeof window !== "undefined" && typeof document !== "undefined";
  let lastKey = -Infinity;
  const onKey = () => (lastKey = Date.now());
  if (hasDom) window.addEventListener("keydown", onKey, true);
  setQuietCheck(() =>
    quietReason({
      dnd: quiet.has("dnd"),
      inCall: quiet.has("call") || d.voiceState() !== "idle",
      typing: hasDom && (editable(document.activeElement) || Date.now() - lastKey < TYPING_MS),
      fullscreen: hasDom && (!!document.fullscreenElement || (window.innerHeight >= screen.height && window.innerWidth >= screen.width)),
      section: d.section(),
    }) ?? (quiet.size ? [...quiet][0] : null),
  );

  const seen = new Set(d.toasts.getState().toasts.map((t) => t.id));
  const off = d.toasts.subscribe((s) => {
    for (const t of s.toasts) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      if (isDoneToast(t)) characterEvent({ kind: "done" });
    }
    if (seen.size > 200) for (const id of [...seen].slice(0, 100)) seen.delete(id);
  });

  const rand = d.random ?? Math.random;
  const hello = setInterval(() => {
    if (rand() < (d.helloChance ?? 0.25)) characterEvent({ kind: "hello" });
  }, d.helloEveryMs ?? 10 * 60_000);

  return () => {
    off();
    clearInterval(hello);
    if (hasDom) window.removeEventListener("keydown", onKey, true);
    setQuietCheck(() => null);
  };
}
