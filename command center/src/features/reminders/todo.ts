/**
 * To-do adds, confirmed before anything is saved (live test 11-27: Nic asked for "Melissa Lee
 * invoice" and Tony tried to add "check primary inbox" instead).
 *
 *   "add Melissa Lee invoice to my to-do list"  → “Add “Melissa Lee invoice” to your to-do list?”
 *   "yes"                                        → saved, word for word
 *   "no, Melissa Lee invoice 114"                → the item is replaced and asked again
 *   "no" / "cancel"                              → nothing saved
 *   "add that to my to-do list"                  → “What exactly should the to-do say?”
 *
 * The item is Nic's own words, never the model's: this runs before any LLM call (handleLocalIntent).
 * Saved to the Ideas & Tasks ledger (collection "ideas", status "parked", tag "todo"), where a
 * parked entry starts nothing. The parse and the flow are pure (the save is injected) for Vitest.
 */

/** An unanswered question expires after this long (the next line is then an ordinary turn). */
export const TODO_CONFIRM_TTL_MS = 120_000;

const LIST = String.raw`(?:my |the |our )?(?:to[- ]?do|todo)(?:s| list)?`;
/** "add X to my to-do list", "put X on the todo list", "stick X on my to-dos". */
const TAIL = String.raw`(?:[\s,]+(?:please|thanks|thank you|tony|for (?:today|tonight|tomorrow|this week|\w+day)))*`;
const ADD_TO = new RegExp(String.raw`^(?:please )?(?:add|put|stick|throw|pop|write|jot(?: down)?)\s+(.+?)\s+(?:to|on|onto|in|into)\s+${LIST}${TAIL}\s*[.!?]*$`, "i");
/** "add to my to-do list: X", "add a to-do: X", "new to-do X", "to-do: X", "add a to-do for X", "make a to-do to X". */
const ADD_LEAD = new RegExp(
  String.raw`^(?:please )?(?:(?:add|put|make|create|start)\s+(?:a |an |one )?(?:new )?(?:to[- ]?do|todo|item)(?:\s+(?:to|on|onto)\s+${LIST})?|(?:add|put)\s+(?:to|on|onto)\s+${LIST})\s*(?:[:,-]\s*|\s+(?:for|to|that says|saying|called)\s+|\s+)(.+?)${TAIL}\s*[.!?]*$`,
  "i",
);
/** "to-do: X", "new todo - X", "todo that says X": a bare lead needs a colon / dash / "that says"
 * (so "to do list is long" or "todo app is broken" are ordinary lines). */
const ADD_BARE = /^(?:please )?(?:new\s+)?(?:to[- ]?do|todo)\s*(?:[:,–—-]\s*|\s+(?:that says|saying|called)\s+)(.+?)\s*[.!?]*$/i;
/** An item that only points at something said earlier ("add that", "put it on my list"). */
const POINTER = /^(?:it|that|this|those|these|them|the last (?:one|thing|email)|what (?:i|you) (?:just )?said|that one|this one)$/i;

/** Nic's exact item from an add line (quotes and the trailing period dropped, case kept), "" when it
 * only points back ("add that to my to-do list"), or null when the line isn't a to-do add. Pure. */
export function parseTodoAdd(line: string): string | null {
  const t = line.trim().replace(/^(?:(?:hey|yo|ok|okay|aye)[, ]+)?(?:tony[, ]+)?(?:(?:can|could|would) you |will you )?/i, "");
  const m = ADD_TO.exec(t) ?? ADD_LEAD.exec(t) ?? ADD_BARE.exec(t);
  if (!m) return null;
  // "add to-do list app to my phone" style misses: an item that is the list itself.
  if (/^(?:list|lists|s)\b/i.test(m[1].trim())) return null;
  const item = m[1]
    .trim()
    .replace(/^["“”'‘’]+|["“”'‘’]+$/g, "")
    .replace(/[.!?]+$/, "")
    .replace(/^(?:a |an )?(?:reminder|note) (?:to |about )/i, "")
    .trim();
  return POINTER.test(item) ? "" : item;
}

const COURTESY = String.raw`(?:[\s,.!]+(?:please|thanks|thank you|tony|man|add it|do it|save it|go ahead|that'?s (?:it|right)))*[\s.!]*$`;
const YES = new RegExp(String.raw`^(?:yes|yeah|yep|yup|yes please|sure|correct|right|exactly|confirm(?:ed)?|do it|go ahead|add it|save it|that'?s (?:it|right|correct)|sounds good|perfect|ok(?:ay)?)\b${COURTESY}`, "i");
const NO = new RegExp(String.raw`^(?:no|nope|nah|no thanks|cancel(?: that| it)?|never ?mind|forget (?:it|that|about it)|don'?t(?: add it| bother| save it)?|do not(?: add it)?|stop|scratch that|leave it|not now)\b${COURTESY.replace("add it|do it|save it|go ahead|", "")}`, "i");
/** A correction's remainder that is really a refusal ("no, don't add it", "no, never mind"). */
const REFUSAL = /^(?:don'?t\b|do not\b|never ?mind|forget (?:it|that|about it)|cancel|leave it|not now|no thanks|thanks|thank you|skip it|scratch that)/i;
/** Wake word / filler in front of an answer ("Tony, yes", "okay so no"). */
const LEAD_FILLER = /^(?:(?:hey|hi|yo|ok|okay|aye|ay|so|um|uh)[\s,]+)*(?:tony\b[\s,:.!-]*)?/i;
/** "no, Melissa Lee invoice", "no it's X", "make it X", "change it to X", "it should say X", "actually X". */
const CORRECTION = /^(?:(?:no|nope|nah|actually|not quite|wrong)[\s,.!-]+)?(?:(?:it'?s|it is|make it|change it to|call it|it should say|should say|say|the item is|i said|i meant)\s+)?(.+?)[\s.!]*$/i;
const CORRECTION_LEAD = /^(?:no|nope|nah|actually|not quite|wrong|make it|change it to|call it|it should say|should say|i said|i meant|the item is)\b/i;

export type TodoReply = { reply: string; meta: string };

export interface TodoFlow {
  /** The reply for `line` when it is a to-do add or answers an open to-do question; null otherwise. */
  handle(line: string): Promise<TodoReply | null>;
  /** The item waiting for Nic's yes (null when none), for tests and the HUD. */
  pending(): { item: string } | null;
}

const ask = (item: string) => `Add “${item}” to your to-do list? Say yes, or tell me the exact words.`;
const WHAT = "What exactly should the to-do say?";

/** One flow per controller. `save` writes the confirmed item (the exact text Nic approved). */
export function createTodoFlow(save: (item: string) => Promise<unknown>, now: () => number = Date.now): TodoFlow {
  // `item` "" = waiting for the words themselves (a pointer like "add that").
  let open: { item: string; at: number } | null = null;
  const live = () => (open && now() - open.at <= TODO_CONFIRM_TTL_MS ? open : (open = null));
  const set = (item: string): TodoReply => {
    open = { item, at: now() };
    return item ? { reply: ask(item), meta: "local · to-do · waiting for your yes" } : { reply: WHAT, meta: "local · to-do · waiting for the words" };
  };
  return {
    pending: () => {
      const o = live();
      return o && o.item ? { item: o.item } : null;
    },
    async handle(line: string) {
      const raw = line.trim();
      if (!raw) return null;
      // Answers are checked without the wake word ("Tony, yes"); a bare "okay" stays an answer.
      const t = raw.replace(LEAD_FILLER, "").trim() || raw;
      // A new add always restarts the question with these exact words.
      const add = parseTodoAdd(raw);
      if (add !== null) return set(add);
      const o = live();
      if (!o) return null;
      if (!o.item) {
        if (NO.test(t)) {
          open = null;
          return { reply: "Okay, no to-do.", meta: "local · to-do · cancelled" };
        }
        return set(t.replace(/^["“”'‘’]+|["“”'‘’]+$/g, "").replace(/[.!?]+$/, "").trim());
      }
      if (YES.test(t)) {
        const item = o.item;
        open = null;
        await save(item);
        return { reply: `Added “${item}” to your to-do list.`, meta: "local · to-do · saved to the Ideas & Tasks ledger" };
      }
      if (NO.test(t)) {
        open = null;
        return { reply: "Okay, I didn't add it.", meta: "local · to-do · not saved" };
      }
      // "no, Melissa Lee invoice" / "make it …": replace the words and ask again (never saved yet).
      if (CORRECTION_LEAD.test(t)) {
        const m = CORRECTION.exec(t);
        const item = m?.[1]?.replace(/^["“”'‘’]+|["“”'‘’]+$/g, "").trim();
        if (item && REFUSAL.test(item)) {
          open = null;
          return { reply: "Okay, I didn't add it.", meta: "local · to-do · not saved" };
        }
        if (item && !POINTER.test(item)) return set(item);
      }
      // Anything else: the question lapses and the line is an ordinary turn (nothing saved).
      open = null;
      return null;
    },
  };
}
