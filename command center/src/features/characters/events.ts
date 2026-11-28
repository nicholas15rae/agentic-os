import { useCharacters } from "./character-store";
import { isDoneToast, type CharacterEvent } from "./logic";

/**
 * UI fixes 2: what makes a character pop up. Anything can call `characterEvent` (the Gabagool coins
 * rewards will, Section 28); until then a "got it done" toast (Staged, Saved, Sent, Done…) counts
 * as a finished thing, and the third, fifth and tenth of the day are a streak. Errors, warnings and
 * alarms never pop a character. Frequency and Mute are applied by the store.
 */
export function characterEvent(e: CharacterEvent): boolean {
  return useCharacters.getState().emit(e);
}

type ToastLike = { id: string; title: string; tone: string };
type ToastStore = { getState(): { toasts: ToastLike[] }; subscribe(fn: (s: { toasts: ToastLike[] }) => void): () => void };

/** Watch the toasts and say hello once a day a few seconds after start. Returns the uninstaller. */
export function installCharacterEvents(toasts: ToastStore, helloAfterMs = 4000): () => void {
  const seen = new Set(toasts.getState().toasts.map((t) => t.id));
  const off = toasts.subscribe((s) => {
    for (const t of s.toasts) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      if (isDoneToast(t)) characterEvent({ kind: "done" });
    }
    // Forget ids that are long gone so the set stays small.
    if (seen.size > 200) for (const id of [...seen].slice(0, 100)) seen.delete(id);
  });
  const hello = setTimeout(() => characterEvent({ kind: "hello" }), helloAfterMs);
  return () => {
    off();
    clearTimeout(hello);
  };
}
