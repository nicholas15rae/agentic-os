/**
 * Decision 5: answering Tony's pending core-memory proposals from the card under his Learning
 * reply. Desktop app: the Tauri commands `learning_approve` / `learning_discard`. Every phone (the
 * PWA and the Android app, which is Tauri too but whose Rust side holds none of the desktop's
 * proposals): an inbox `command` (`memoryApprove` / `memoryDiscard`) the desktop applies. A spoken
 * "yes" / "no" needs none of this: it reaches Rust's `os_turn` like any line.
 */
import { native } from "@/lib/platform";
import { isDesktopApp } from "@/stores/settings";
import { sendMemoryDecision } from "@/features/dispatcher/dispatch";
import { learnedOf, MEMORY_ID_RE, type LearnedPathway, type PendingMemory } from "./learning";
import type { VoiceTurn } from "@/features/voice/voice-store";

export const MEMORY_NO_DESKTOP = "The desktop app didn't answer, so nothing was saved. Try again with it open.";
/** Skip on a proposal Rust no longer holds (`learning_discard` false). */
export const MEMORY_GONE = "That memory proposal expired or was already answered.";

/** Save (`approve`) or Skip one proposal. Resolves with what was saved (Skip: []). Throws when
 * Rust refuses (expired / already answered) or, on the phone, when no desktop answered. */
export async function decideMemory(id: string, approve: boolean): Promise<LearnedPathway[]> {
  if (!MEMORY_ID_RE.test(id)) throw new Error("bad memory proposal id");
  if (isDesktopApp()) {
    if (!approve) {
      if (!(await native<boolean>("learning_discard", { id }))) throw new Error(MEMORY_GONE);
      return [];
    }
    return learnedOf(await native<unknown>("learning_approve", { id }));
  }
  const m = await sendMemoryDecision(id, approve);
  if (!m) throw new Error(MEMORY_NO_DESKTOP);
  return approve ? learnedOf(m.saved) : [];
}

/** The turn after one proposal was answered (pure): it leaves the card; what was saved joins the
 * turn's "Memory saved" pills. */
export function afterDecision(turn: Pick<VoiceTurn, "pendingMemory" | "learned">, id: string, saved: readonly LearnedPathway[]): Pick<VoiceTurn, "pendingMemory" | "learned"> {
  const left: PendingMemory[] = (turn.pendingMemory ?? []).filter((p) => p.id !== id);
  const learned = [...(turn.learned ?? []), ...saved.filter((s) => !(turn.learned ?? []).some((l) => l.id === s.id && l.outcome === s.outcome))];
  return { pendingMemory: left.length ? left : undefined, learned: learned.length ? learned : undefined };
}
