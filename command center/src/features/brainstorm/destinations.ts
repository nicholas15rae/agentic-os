import type { Destination, LearnCategory, WrapItem } from "./session-types";
import type { DestinationInfo, SendPlanResult } from "./helper-types";

/**
 * Where a wrap-up item can go, mirroring command_center_api.py (WRAPUP_DESTINATIONS and
 * `_wrap_validate`). Pure: no stores, no network. The endpoint lets every kind (idea, decision,
 * next step) go to any of the four destinations, with one rule: memory only from Nic's own words.
 *   play_place → Play Place (collection "playplace")
 *   director   → the Director idea board
 *   ledger     → the Ideas & Tasks ledger (collection "ideas"), never Finance
 *   memory     → core memory, saved BY REFERENCE ({noteId, itemId}); the desktop reads the text
 */

/** Same order as WRAPUP_DESTINATIONS. */
export const DESTINATIONS: readonly Destination[] = ["play_place", "director", "ledger", "memory"];

/** Same as WRAPUP_MEMORY_CATEGORIES (display only: the category is read from the note item on the desktop, never sent). */
export const MEMORY_CATEGORIES: readonly LearnCategory[] = ["preference", "workflow", "rule", "persona", "domain_knowledge", "correction"];

/** Mirrors WRAPUP_TEXT_MAX / WRAPUP_TITLE_MAX. */
export const ITEM_TEXT_MAX = 300;
export const ITEM_TITLE_MAX = 80;

export const DESTINATION_INFO: Readonly<Record<Destination, DestinationInfo>> = {
  play_place: { dest: "play_place", label: "Play Place", store: "playplace" },
  director: { dest: "director", label: "Director ideas", store: "director_ideas" },
  ledger: { dest: "ledger", label: "Ideas & Tasks", store: "ideas" },
  memory: { dest: "memory", label: "Memory", store: "memory_ref" },
};

export function isDestination(v: unknown): v is Destination {
  return typeof v === "string" && (DESTINATIONS as readonly string[]).includes(v);
}

/** The confirm card's title: "Brainstorm wrap-up · Play Place" (never "Permission Bridge"). */
export function cardLabel(dest: Destination): string {
  return `Brainstorm wrap-up · ${DESTINATION_INFO[dest].label}`;
}

/** The destinations one item may be sent to: all four, minus memory unless Nic said it. */
export function permittedDestinations(item: Pick<WrapItem, "speaker">): Destination[] {
  return DESTINATIONS.filter((d) => d !== "memory" || item.speaker === "nic");
}

export function canSendTo(item: Pick<WrapItem, "speaker">, dest: Destination): boolean {
  return isDestination(dest) && permittedDestinations(item).includes(dest);
}

/** One line of display text, cut at a word boundary (the endpoint's `_wrap_clean`, simplified). */
function clip(s: string, cap: number): string {
  // eslint-disable-next-line no-control-regex
  const one = String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim();
  if (one.length <= cap) return one;
  const cut = one.slice(0, cap);
  const sp = cut.lastIndexOf(" ");
  return (sp > cap / 2 ? cut.slice(0, sp) : cut).trimEnd();
}

/**
 * The single write Send performs for ONE item. Only a pending (or failed, for a retry) item with a
 * destination it is allowed to use gets a plan. A memory plan carries `{noteId, itemId}` only: no
 * text, title, quote or category field exists on it, so nothing client-chosen can reach memory. The
 * desktop reads the text and the stored memoryCategory from the note item (plan step 4).
 */
export function planSend(noteId: string, item: WrapItem, dest: Destination | null = item.dest): SendPlanResult {
  if (item.status !== "pending" && item.status !== "failed") return { ok: false, error: "not_pending" };
  if (!dest || !isDestination(dest)) return { ok: false, error: "no_dest" };
  if (!canSendTo(item, dest)) return { ok: false, error: "not_allowed" };
  const ref = { noteId, itemId: item.id };
  if (dest === "memory") return { ok: true, plan: { dest, store: "memory_ref", ref } };
  const text = clip(item.text, ITEM_TEXT_MAX);
  return {
    ok: true,
    plan: {
      dest,
      store: DESTINATION_INFO[dest].store as "playplace" | "ideas" | "director_ideas",
      title: clip(text, ITEM_TITLE_MAX),
      text,
      quote: clip(item.quote, ITEM_TEXT_MAX),
      kind: item.kind,
      source: ref,
    },
  };
}
