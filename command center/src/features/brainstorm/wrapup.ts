import type { CancelReason, Destination, WrapItem, WrapItemStatus, WrapUp } from "./session-types";
import type { SentInfo, WalkReply, WalkStep, WrapChange } from "./helper-types";
import { canSendTo, isDestination } from "./destinations";
import { norm } from "@/features/cues/gaba";

/**
 * Wrap-up item status rules, client side (the gateway only ever writes "pending"). Pure.
 *   pending → sending → sent | failed;  failed → sending (retry);  pending → skipped (explicit no).
 * Every change takes ONE item id. There is no approve-all, skip-all or any other bulk step: each
 * item needs its own yes. Only an explicit "no" (CancelReason "declined") makes an item skipped;
 * a timeout, a superseded card, a dismiss, a cut or "stop" leaves it pending.
 */

/** What a confirm card closing without a yes does to its item. */
export function statusAfterCancel(reason: CancelReason): Extract<WrapItemStatus, "pending" | "skipped"> {
  return reason === "declined" ? "skipped" : "pending";
}

function change(w: WrapUp, itemId: string, from: readonly WrapItemStatus[], f: (i: WrapItem) => WrapItem | null): WrapChange {
  const idx = w.items.findIndex((i) => i.id === itemId);
  if (idx < 0) return { ok: false, error: "no_item" };
  const cur = w.items[idx];
  if (!from.includes(cur.status)) return { ok: false, error: "bad_status" };
  const next = f(cur);
  if (!next) return { ok: false, error: "bad_dest" };
  const items = w.items.slice();
  items[idx] = next;
  return { ok: true, wrapup: { ...w, items } };
}

/** A card for this pending item closed without a yes. Only "declined" changes anything. */
export function applyCancel(w: WrapUp, itemId: string, reason: CancelReason): WrapChange {
  return change(w, itemId, ["pending"], (i) => (statusAfterCancel(reason) === "skipped" ? { ...i, status: "skipped" } : i));
}

/** Pick a destination by tap (the only way to change one). Pending or failed items only. */
export function setDestination(w: WrapUp, itemId: string, dest: Destination): WrapChange {
  return change(w, itemId, ["pending", "failed"], (i) => (canSendTo(i, dest) ? { ...i, dest } : null));
}

/** The one item's yes: it starts sending to its own destination. Pending, or failed for a retry. */
export function markSending(w: WrapUp, itemId: string): WrapChange {
  return change(w, itemId, ["pending", "failed"], (i) => {
    if (!isDestination(i.dest) || !canSendTo(i, i.dest)) return null;
    const { error: _e, ...rest } = i;
    return { ...rest, status: "sending" };
  });
}

export function markSent(w: WrapUp, itemId: string, sent: SentInfo): WrapChange {
  return change(w, itemId, ["sending"], (i) => (i.dest === sent.dest ? { ...i, status: "sent", sentTo: { ...sent } } : null));
}

export function markFailed(w: WrapUp, itemId: string, error: string): WrapChange {
  return change(w, itemId, ["sending"], (i) => ({ ...i, status: "failed", error: String(error).slice(0, 300) }));
}

/** Items the voice walk offers, one card each, in wrap-up order: pending with a destination set.
 * A pending item without one needs a tap first (destinations are never picked by voice). */
export function walkQueue(w: WrapUp): WrapItem[] {
  return w.items.filter((i) => i.status === "pending" && isDestination(i.dest) && canSendTo(i, i.dest));
}

/** Pending items the walk skips because no destination is chosen yet. */
export function needsDestination(w: WrapUp): WrapItem[] {
  return w.items.filter((i) => i.status === "pending" && !isDestination(i.dest));
}

/* Replies are read in `norm()` form, the same as the rest of the voice stack: lower case, every
 * non-alphanumeric (a straight or curly apostrophe included) a space, so "that’s" and "that's"
 * both read "that s". The tables below are written that way. A bare "ok" / "okay" is filler, not
 * a yes: it never starts a send on its own ("ok send it" still does). */
const FILLER = /^(?:(?:hey|ok|okay|um|uh|so|well|tony|jarvis|please)\s+)+/;
const STOP = /^(?:stop|stop it|stop there|that s enough|thats enough|enough|cut it|end|end it|we re done|were done|i m done|im done|done for now|later)(?: (?:please|tony|for now|now))*$/;
const NO = /^(?:no|nope|nah|naw|skip|skip it|skip that|skip this|not that one|no thanks|no thank you|don t|dont|leave it|pass)(?: (?:please|tony|thanks|that one|it))*$/;
const YES = /^(?:yes|yeah|yep|yup|sure|do it|send it|send|go ahead|go for it|approve|approved|please do|sounds good)(?: (?:please|tony|thanks|do it|send it|go ahead))*$/;

/** One spoken reply on a walk card. Stop is read first ("no, stop" is a stop, not a no). A
 * hedged yes ("yes but…", "send it somewhere else") is unclear: the card asks again. */
export function walkReply(text: string): WalkReply {
  const t = norm(String(text ?? "")).replace(FILLER, "").trim();
  if (!t) return "unclear";
  const parts = t.split(" ");
  if (STOP.test(t) || ((parts[0] === "no" || parts[0] === "nah") && STOP.test(parts.slice(1).join(" ")))) return "stop";
  if (/\b(but|except|instead|wait|change|not|somewhere|else|other)\b/.test(t) && !NO.test(t)) return "unclear";
  if (NO.test(t)) return "no";
  if (YES.test(t)) return "yes";
  return "unclear";
}

/** What a reply on the card for `item` does. A timeout is `cancel("timed out")`, never a skip. */
export function walkStep(item: WrapItem, reply: WalkReply): WalkStep {
  if (reply === "yes" && isDestination(item.dest)) return { action: "approve", itemId: item.id, dest: item.dest };
  if (reply === "no") return { action: "cancel", itemId: item.id, reason: "declined", endWalk: false };
  if (reply === "stop") return { action: "cancel", itemId: item.id, reason: "stopped", endWalk: true };
  return { action: "ask_again", itemId: item.id };
}

/** Counts for the card header. */
export function wrapCounts(w: WrapUp): Record<WrapItemStatus, number> {
  const c: Record<WrapItemStatus, number> = { pending: 0, sending: 0, sent: 0, skipped: 0, failed: 0 };
  for (const i of w.items) c[i.status] = (c[i.status] ?? 0) + 1;
  return c;
}
