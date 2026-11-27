/**
 * Brainstorm step 8: the typed contract for the pure helpers (talk-intent.ts, talk-digest.ts,
 * wrapup.ts, destinations.ts). Types only, no runtime code. The shared shapes (WrapUp, WrapItem,
 * Destination, CancelReason, MemoryCommitRef …) stay in session-types.ts, the step-1 contract.
 */
import type { CancelReason, Destination, MemoryCommitRef, WrapItem, WrapKind, WrapUp } from "./session-types";
import type { Reflex, ReflexCtx } from "@/features/voice/reflex-parse";

// ── talk-intent.ts ──────────────────────────────────────────────────────────

/**
 * What one heard line means while Talk is live. Order: empty → reflex → end talk → wrap → talk turn.
 * Everything else (Spotify, OS, dev, defer "save it for later", "keep going", "go ahead and …"
 * lines) is a talk turn.
 */
export type TalkIntent =
  | { kind: "reflex"; reflex: TalkReflex }
  | { kind: "end_talk" }
  | { kind: "wrap" }
  | { kind: "talk"; text: string }
  /** Nothing was said (empty or whitespace-only, e.g. a Whisper blank): no turn, no transcript line. */
  | { kind: "empty" };

/** The reflexes Talk honours: cut, hold and stand-down only. A resume or submit ("keep going",
 * "go ahead and …") is a talk turn in Talk, so no reflex ever carries a command out of it. */
export type TalkReflex = NonNullable<Reflex> & { kind: "cut" | "hold" | "standdown" };

export interface TalkIntentCtx extends ReflexCtx {
  /** The assistant's name (settings osName); "Tony" when empty. */
  osName?: string;
}

// ── talk-digest.ts ──────────────────────────────────────────────────────────

export interface TalkDigestOptions {
  /** Only lines spoken strictly before this epoch ms (the line being answered is left out). */
  beforeT?: number;
  /** The assistant's name: legacy "Tony:"-labelled lines are left out, and a leading "Tony:" /
   * "<osName>:" label is stripped from Nic's lines; "Tony" when empty. */
  osName?: string;
}

// ── wrapup.ts ───────────────────────────────────────────────────────────────

/** A spoken reply on one voice walk card. "stop" ends the walk and leaves the rest pending. */
export type WalkReply = "yes" | "no" | "stop" | "unclear";

/** What a walk reply does to the ONE item on the card. There is no step that touches two items. */
export type WalkStep =
  | { action: "approve"; itemId: string; dest: Destination }
  | { action: "cancel"; itemId: string; reason: CancelReason; endWalk: boolean }
  | { action: "ask_again"; itemId: string };

/** Result of a single-item status change: the new wrap-up, or why nothing changed. */
export type WrapChange = { ok: true; wrapup: WrapUp } | { ok: false; error: "no_item" | "bad_status" | "bad_dest" };

export interface SentInfo {
  dest: Destination;
  refId: string;
  at: number;
  via: "tap" | "voice";
}

// ── destinations.ts ─────────────────────────────────────────────────────────

export interface DestinationInfo {
  dest: Destination;
  /** Short name on the item ("Play Place", "Director ideas", "Ideas & Tasks", "Memory"). */
  label: string;
  /** Where the write lands. */
  store: "playplace" | "director_ideas" | "ideas" | "memory_ref";
}

/** The one write a Send performs. Memory carries the reference only ({noteId, itemId}): no text or
 * category field exists on it; the desktop reads both from the note item. */
export type SendPlan =
  | {
      dest: "play_place" | "ledger" | "director";
      store: "playplace" | "ideas" | "director_ideas";
      title: string;
      text: string;
      quote: string;
      kind: WrapKind;
      source: MemoryCommitRef;
    }
  | { dest: "memory"; store: "memory_ref"; ref: MemoryCommitRef };

export type SendPlanResult = { ok: true; plan: SendPlan } | { ok: false; error: "no_dest" | "not_allowed" | "not_pending" };

/** Re-exported for the helpers' callers. */
export type { WrapItem };
