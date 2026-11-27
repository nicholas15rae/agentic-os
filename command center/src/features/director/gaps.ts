/**
 * Part 6 "fill the gaps" (pure) and the chat line suggestion. For an unfilled film slot the page
 * offers "Generate a still" (pre-fills the Generate panel; Nic clicks Enqueue) and "Ask for B-roll"
 * (puts a line in the Director chat box; Nic clicks Send). Nothing is queued or sent from here.
 */
import { create } from "zustand";
import type { ShotSlot, TimelineManifest } from "./contract";
import { framingLabel } from "./shot-print";

/** Mirrors comfy.rs COMFY_PROMPT_MAX. */
const PROMPT_MAX = 2000;

/** Film slots with nothing attached yet (pure). */
export const unfilledFilmSlots = (m: Pick<TimelineManifest, "shotList">): ShotSlot[] => m.shotList.filter((s) => s.source === "film" && !s.assetId);

/** A scene-still prompt from the slot (pure): framing, what happens, the label. */
export function slotStillPrompt(s: Pick<ShotSlot, "label" | "action" | "instructions" | "framing">): string {
  const what = (s.action || s.instructions).trim();
  const shot = s.framing ? `${framingLabel(s.framing).toLowerCase()} shot` : "shot";
  const parts = [`${shot}: ${what || s.label.trim()}`, what && s.label.trim() ? s.label.trim() : ""].filter(Boolean);
  return `${parts.join(". ")}. Cinematic, natural light.`.slice(0, PROMPT_MAX);
}

/** The B-roll request line for the Director (pure). */
export function brollLine(s: Pick<ShotSlot, "id" | "label" | "action" | "framing" | "targetSec">): string {
  const bits = [framingLabel(s.framing), s.targetSec != null ? `${s.targetSec}s` : "", s.action.trim()].filter(Boolean).join(", ");
  return `Slot ${s.id} "${s.label}"${bits ? ` (${bits})` : ""} has no footage. Suggest B-roll that could fill it: staged clips first, else a still to generate or a quick reshoot tip. Only suggest.`;
}

// ── A line waiting in the Director chat box (DirectorChat picks it up) ──────────

export interface ChatDraft {
  draft: { text: string; n: number } | null;
}
export const useChatDraft = create<ChatDraft>(() => ({ draft: null }));

/** Put `text` in the Director chat box and focus it. Nic sends it (or not). */
export function suggestChatLine(text: string): void {
  useChatDraft.setState((s) => ({ draft: { text, n: (s.draft?.n ?? 0) + 1 } }));
}
