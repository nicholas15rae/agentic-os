import { api, gateway, GatewayError } from "@/lib/gateway";
import { cmd, type ChatMessage, type DispatchResult } from "@/lib/platform";
import { isAndroidApp, isDesktopApp } from "@/stores/settings";
import { learnedOf, pendingMemoryOf, type LearnedPathway, type PendingMemory } from "@/features/modes/learning";
import { bookingsOf, rememberBookings } from "@/features/orchestrator/bookings";
import { SUB_AGENTS, type AgentRole } from "./agents";
import { DEFAULT_ROUTING_CONFIG, directTool, resolve, type RouteKind } from "./router";

export interface DispatchOutcome {
  role: AgentRole;
  result: DispatchResult;
  /** Phone only: `result.content` is not Tony's answer but a notice about the queued turn. `waiting`:
   * the cap ran out (`desktopTimeoutMessage`: still working / still queued / lost); `unconfirmed`:
   * the gateway never confirmed the item (`DESKTOP_LOST_MESSAGE`, or `DESKTOP_UNREACHABLE_MESSAGE`
   * when it turned the POST away for now). A caller that already showed
   * (or spoke) his streamed partial answer keeps it and puts the notice in a turn of its own. */
  notice?: DesktopNotice;
  /** Phone only (decision 5): the Learning lessons Tony proposed on this reply (the same card as the
   * desktop's; `sendMemoryDecision` answers it) and the core memories it saved. */
  pendingMemory?: PendingMemory[];
  learned?: LearnedPathway[];
}

/** What a phone `dispatch` returned instead of an answer (`DispatchOutcome.notice`). */
export type DesktopNotice = "waiting" | "unconfirmed";

export interface DispatchOptions {
  /** The role the caller decided. `dispatch` never overrides it with its own re-read of the text
   * (only a live-tool read or `noDelegate` makes it Tony's): an approved Tier-3 hand-off opens
   * "[Tony — approved hand-off …]", which would read as an address to Tony. */
  role?: AgentRole;
  history?: ChatMessage[];
  /** Force a provider id (desktop only). */
  provider?: string;
  /** P3 Tier 2: Tony brainstorms this himself — the queued phone turn carries `noDelegate`, so
   * the desktop never re-routes it and never runs the Prompter's idea capture. */
  noDelegate?: boolean;
  /** How the caller resolved `role` (the plan's `routeKind` from `routeFor`; "Named" for an
   * approved Tier-3 hand-off). The phone's queued turn carries it as given: "Self" only when the
   * caller kept the line with Tony; a plain no-match stays "Default", which the desktop
   * re-resolves against its live routing table (custom Named triggers, registered businesses).
   * A caller's "Named" also keeps its agent on a live-tool read, as Rust's backstop does. */
  routeKind?: RouteKind | string;
  /** Phone only: the desktop Tony's answer as it streams in (a long-poll gateway relays his
   * deltas). Called with the accumulated text each time the gateway's `partialSeq` grows: it only
   * ever grows, and never comes after the final result, which `dispatch` returns as before. The
   * desktop app (`dispatch_chat`) never calls it. */
  onPartial?: (soFar: string) => void;
}

/** The desktop's answer to a queued phone item (`result` of `/api/os/inbox/{id}`). `streamPrefix`:
 * what gateway Tony streamed ahead of `answer` (his cold-start waking line), never part of it. */
export type DesktopResult = { answer?: string; providerId?: string; streamPrefix?: string; idea?: { id?: string; title?: string } } & Record<string, unknown>;

/** Gateway queue item states (`os_queue.status`). `failed` is what gateways before the claim/lease
 * change wrote for an error, so it is still understood. `cancelled`: taken back before any
 * desktop picked it up (POST /api/os/inbox/{id}/cancel), so it never runs there. */
export type QueueStatus = "pending" | "running" | "done" | "error" | "failed" | "expired" | "cancelled";

/** How long an unclaimed item may sit `pending` before the phone assumes the desktop is off. */
export const DESKTOP_PICKUP_MS = 12_000;
/** Hard cap on waiting for a claimed (`running`) item. */
export const DESKTOP_ANSWER_CAP_MS = 240_000;
/** The plain poll cadence against a gateway that predates long-poll (no `partialSeq`). */
export const DESKTOP_POLL_MS = 1500;
/** Longest wait between polls while the gateway poll keeps failing (backoff 3 s → 6 s → 8 s). */
export const DESKTOP_RETRY_MAX_MS = 8_000;
/** Long-poll: how long one GET /api/os/inbox/{id}?wait=W may be held open at the gateway (s). */
export const DESKTOP_LONG_POLL_S = 20;
/** A long-poll request's own timeout is its `wait` plus this. */
export const DESKTOP_LONG_POLL_PAD_MS = 10_000;
/** A long-poll that came back faster than this with nothing new didn't wait (`wait` is never under
 * 1 s): the next request is paced like a plain poll, so a gateway that ignores `wait` can't spin. */
const LONG_POLL_FAST_MS = 500;
/** The desktop app is off: not busy and not heard from for longer than this (by this device's
 * clock). A phone turn then skips the 12 s pickup wait (`desktopOff`). */
export const DESKTOP_OFF_SECS = 60;
export const DESKTOP_EXPIRED_MESSAGE = "The desktop app didn't pick that up in time, so nothing ran.";
/** The desktop finished a turn without an answer (it had claimed it, so nothing else runs it). */
export const DESKTOP_NO_ANSWER_MESSAGE = "Tony finished that on the desktop but sent no answer back.";

/** The cap ran out while the desktop had the item (`running` seen): Tony is still on it. */
export const DESKTOP_STILL_WORKING_MESSAGE = "Tony is still working on that on the desktop. It's taking a while, so I've stopped waiting here; nothing else was asked to do it.";
/** The cap ran out with the item still queued behind an earlier one the desktop is busy with
 * (the last poll that got through said so). */
export const DESKTOP_STILL_QUEUED_MESSAGE = "The desktop is still busy with an earlier request, so Tony hasn't started this one yet. It's still in his queue; nothing else was asked to do it.";
/** The cap ran out with the item still queued and the desktop not busy with anything else. */
export const DESKTOP_QUEUED_MESSAGE = "That's still queued on the desktop; Tony hasn't started it yet. Nothing else was asked to do it.";
/** The cap ran out and the gateway stopped answering (or never did) after the item was queued;
 * also a POST / cancel that got no answer, so the item may or may not be in the desktop's queue. */
export const DESKTOP_LOST_MESSAGE = "I sent that to the desktop but then couldn't reach the gateway, so I can't tell whether Tony has it. Nothing else was asked to do it.";
/** Someone took the item back from the desktop's queue before Tony started it. */
export const DESKTOP_CANCELLED_MESSAGE = "That was taken back from the desktop's queue before Tony started it, so nothing ran.";
/** The gateway turned the POST away for now (408 / 429): nothing was queued and nothing ran. */
export const DESKTOP_UNREACHABLE_MESSAGE = "I couldn't reach Tony just now, so nothing ran. Try again in a moment.";

/** What became of a queued desktop item (`awaitDesktopItem`). */
export type DesktopWait =
  /** The desktop answered. */
  | { state: "done"; result: DesktopResult }
  /** Still `pending` past `DESKTOP_PICKUP_MS`, never claimed, and no desktop app working the inbox:
   * nothing ran. With `cancelUnclaimed` the gateway has also cancelled the item, so no desktop that
   * starts later runs it: only then may the caller run it elsewhere. */
  | { state: "unclaimed" }
  /** `cancelUnclaimed` only: nothing picked it up, but the cancel got no answer, so a desktop that
   * starts later may still run it. Nothing else may run it. */
  | { state: "uncancelled" }
  /** The cap ran out. `claimed`: the desktop took it (`running` seen) and may still be on it.
   * `polled`: at least one poll got through after the POST. `lastPollOk`: the latest poll did;
   * `busy`: that poll said the desktop was busy with another item. Nothing else may run it. */
  | { state: "timeout"; claimed: boolean; polled: boolean; lastPollOk: boolean; busy: boolean };

/** `sendDesktopTurn`'s outcome: also `unqueued` when the POST itself failed (nothing was queued). */
export type DesktopTurnWait = DesktopWait | { state: "unqueued"; error: unknown };

/** The phone's turn payload for the desktop's `os_turn` (Rust `OsTurnRequest`, camelCase). Every
 * caller sends `noDelegate` (true or false), so the desktop's legacy idea-shaped shortcut
 * (`pipeline.rs inbox_turn_route`) never fires; `capture: true` is an approved Tier-3 build "yes"
 * (Prompter breakdown + ledger); `approved: true` is the turn's own approval card. */
export type DesktopTurnPayload = Record<string, unknown> & { noDelegate: boolean };

/** What the gateway says about the desktop app (POST /api/os/inbox on newer gateways, and every
 * GET /api/os/inbox/{id}): when it last talked to the inbox (gateway epoch seconds; null = never)
 * and whether it is busy with an item. */
export type DesktopLiveness = { desktopSeenAt?: number | null; desktopBusy?: boolean };

/** POST /api/os/inbox's answer. Gateways before long-poll send only `id` / `status`. */
export type InboxPosted = { id: string; status?: string } & DesktopLiveness;

/** GET /api/os/inbox/{id}. A long-poll gateway adds the desktop's streamed answer so far
 * (`partial`) and how many deltas it took (`partialSeq`); an older one has neither. */
type InboxPoll = {
  status: QueueStatus;
  result: { ok: boolean; result?: DesktopResult; error?: string } | null;
  partial?: string;
  partialSeq?: number;
} & DesktopLiveness;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `desktopAlive`'s window: a desktop not busy and not heard from for this long is gone. */
export const DESKTOP_ALIVE_SECS = 15;

/** The desktop is working through the inbox: busy with another item, or polled in the last 15 s. */
export function desktopAlive(r: DesktopLiveness, nowMs = Date.now()): boolean {
  return !!r.desktopBusy || (!!r.desktopSeenAt && nowMs / 1000 - r.desktopSeenAt < DESKTOP_ALIVE_SECS);
}

/** The desktop app is off, so waiting 12 s for a pickup is wasted: not busy, and never heard from
 * or not for over 60 s (this device's clock). Only an answer that reports both fields counts: an
 * older gateway's POST has neither, and never reads as "off". */
export function desktopOff(r: DesktopLiveness, nowMs = Date.now()): boolean {
  if (typeof r.desktopBusy !== "boolean" || !("desktopSeenAt" in r)) return false;
  if (r.desktopBusy) return false;
  return !r.desktopSeenAt || nowMs / 1000 - r.desktopSeenAt > DESKTOP_OFF_SECS;
}

/** The `wait` (seconds) of the next long-poll: 20 s but never past the cap, and while an unclaimed
 * item's 12 s pickup decision is still ahead only until it; at least 1 s, rounded up to 0.1 s.
 * `pending`: what the last poll said about the desktop, when it said the item is still `pending`.
 * Past the pickup window, unclaimed, with the desktop not busy, the item is kept only while the
 * desktop counts as alive (`desktopAlive`): the wait then ends when its `desktopSeenAt` turns 15 s
 * old (by `nowMs`), so a desktop that closed mid-wait is noticed then, not up to 20 s later. */
export function longPollWait(elapsedMs: number, capMs: number, claimed: boolean, pending?: DesktopLiveness, nowMs = Date.now()): number {
  let ms = Math.min(DESKTOP_LONG_POLL_S * 1000, capMs - elapsedMs);
  if (!claimed && elapsedMs < DESKTOP_PICKUP_MS) ms = Math.min(ms, DESKTOP_PICKUP_MS - elapsedMs);
  else if (!claimed && pending && !pending.desktopBusy && typeof pending.desktopSeenAt === "number") {
    ms = Math.min(ms, (pending.desktopSeenAt + DESKTOP_ALIVE_SECS) * 1000 - nowMs);
  }
  return Math.max(1, Math.ceil(ms / 100) / 10);
}

/** The gateway CLI's prompt when it answers a phone turn in the agent's place: it answers AS the
 * agent TO the user (a bare `[Tony] text` read as the user being Tony). */
export function gatewayFallbackPrompt(label: string, text: string): string {
  return `You are ${label}, Nic's assistant in Agentic OS. Nic just said this from his phone; reply to him directly and briefly:\n\n${text}`;
}

/** A poll failure worth retrying: no answer at all (network error / timeout) or a gateway-side
 * 5xx / 408 / 429. A 4xx (bad token, unknown item) is not: it throws. */
export function transientPollError(e: unknown): boolean {
  if (!(e instanceof GatewayError)) return false;
  return e.status === undefined || e.status >= 500 || e.status === 408 || e.status === 429;
}

/** The reply for a capped wait. Never claims success:
 * - claimed (`running` seen): Tony is still on it;
 * - the LAST poll got through and said the desktop is busy with an earlier item: still queued behind it;
 * - the last poll got through, desktop not busy: still queued (neutral);
 * - the last poll failed, or none ever got through: the gateway is lost, so we can't tell. */
export function desktopTimeoutMessage(w: { claimed: boolean; lastPollOk?: boolean; busy?: boolean }): string {
  if (w.claimed) return DESKTOP_STILL_WORKING_MESSAGE;
  if (!w.lastPollOk) return DESKTOP_LOST_MESSAGE;
  return w.busy ? DESKTOP_STILL_QUEUED_MESSAGE : DESKTOP_QUEUED_MESSAGE;
}

/** A failed inbox POST that may still have queued the item: no HTTP status at all (the gateway
 * timed out or the connection dropped), or a 5xx (the gateway, or a proxy in front of it, failed
 * mid-request), so the request may have landed. Nothing else may run the turn then. */
export function postMayHaveQueued(e: unknown): boolean {
  return e instanceof GatewayError && (e.status === undefined || e.status >= 500);
}

/** The inbox POST statuses that mean the gateway refused the item outright (a payload it can't
 * take: 400 / 413 / 422; an older gateway with no inbox route: 404): nothing was queued and
 * nothing ever will be, so the gateway's own agent may answer in Tony's place. */
export const POST_REFUSED_STATUSES: readonly number[] = [400, 404, 413, 422];

/** The gateway refused the inbox POST (`POST_REFUSED_STATUSES`): the only POST failure after which
 * the phone runs the gateway CLI. Never a 5xx / 408 / 429 (the gateway is struggling: the item may
 * have landed, or the CLI there would fail too) and never a 401 / 403 (the CLI would be refused). */
export function postRefused(e: unknown): boolean {
  return e instanceof GatewayError && e.status !== undefined && POST_REFUSED_STATUSES.includes(e.status);
}

/** The inbox kinds the phone posts and waits on (`command`: a memory decision, `sendMemoryDecision`;
 * `action`: an approved confirmation card, `sendApprovedAction`). */
export type InboxKind = "turn" | "task" | "pipeline" | "command" | "action";

/** Queue an inbox item for the desktop; resolves with the gateway's answer: the queue id and (newer
 * gateways) the desktop's liveness, as GET reports it. */
export async function postInboxItem(kind: InboxKind, payload: Record<string, unknown>): Promise<InboxPosted> {
  return gateway<InboxPosted>("/api/os/inbox", { method: "POST", body: JSON.stringify({ kind, payload }) });
}

/** Queue an inbox item for the desktop; resolves with its queue id. */
export async function postDesktopItem(kind: InboxKind, payload: Record<string, unknown>): Promise<string> {
  return (await postInboxItem(kind, payload)).id;
}

/**
 * Take back a queued item no desktop has claimed (POST /api/os/inbox/{id}/cancel), before the
 * caller runs it anywhere else. `cancelled`: no desktop will ever run it (also a repeat cancel).
 * `taken`: 409, the desktop claimed it (or already finished it), so keep waiting for it.
 * `failed`: no usable answer after one retry of a transient failure; the desktop may still run it.
 */
export async function cancelDesktopItem(id: string): Promise<"cancelled" | "taken" | "failed"> {
  for (let attempt = 0; ; attempt++) {
    try {
      await gateway(`/api/os/inbox/${id}/cancel`, { method: "POST" });
      return "cancelled";
    } catch (e) {
      if (e instanceof GatewayError && e.status === 409) return "taken";
      if (attempt >= 1 || !transientPollError(e)) return "failed";
      await sleep(DESKTOP_POLL_MS);
    }
  }
}

export interface AwaitDesktopOptions {
  capMs?: number;
  /** A caller that runs the item elsewhere when no desktop picks it up: cancel it first. */
  cancelUnclaimed?: boolean;
  /** The POST's answer. With `cancelUnclaimed`, a desktop app that is off (`desktopOff`) is given
   * up at once, without waiting for a poll. */
  posted?: DesktopLiveness;
  /** The desktop's streamed answer so far (long-poll gateways only): the accumulated text each
   * time `partialSeq` grows; never after the final result. */
  onPartial?: (soFar: string) => void;
}

/** A listener's failure never ends the wait. */
function emitPartial(onPartial: ((soFar: string) => void) | undefined, soFar: string) {
  if (!onPartial) return;
  try {
    onPartial(soFar);
  } catch {
    /* the final result still comes back as usual */
  }
}

/**
 * Wait for a queued item. The first GET /api/os/inbox/{id} is a plain one, answered at once; a
 * gateway whose answer has `partialSeq` (long-poll) is then asked
 * `GET /api/os/inbox/{id}?wait=W&after=<last partialSeq>` (it answers as soon as something changes;
 * see `longPollWait` for W); one without is polled every 1.5 s, exactly as before.
 * A transient poll failure (network blip, timeout, 5xx) is retried with a short backoff until the
 * cap; it never ends the wait. Once the desktop has claimed the item (`running` seen) the outcome
 * is only ever `done` or `timeout`, never `unclaimed`: a Prompter capture alone can take minutes,
 * and the turn must not run twice. `expired` (the gateway gave up on it), `cancelled` and a desktop
 * `error` result throw their explanation.
 * `cancelUnclaimed` (a caller that runs the item elsewhere when no desktop picks it up): before
 * giving up, cancel it at the gateway. `unclaimed` only once that worked; a 409 (the desktop just
 * claimed it) keeps waiting; a cancel with no answer is `uncancelled`. Such a caller also gives up
 * at once, without the 12 s pickup wait, when the POST or a poll says the desktop app is off
 * (`desktopOff`).
 */
export async function awaitDesktopItem(id: string, kind: string, opts: AwaitDesktopOptions = {}): Promise<DesktopWait> {
  const t0 = Date.now();
  const cap = opts.capMs ?? DESKTOP_ANSWER_CAP_MS;
  let claimed = false;
  let polled = false;
  let lastPollOk = false;
  let busy = false;
  let failures = 0;
  // The first GET is a plain one (today's request, answered at once by any gateway); an answer
  // with `partialSeq` says the gateway long-polls, and the next GETs wait there.
  let longPoll = false;
  let first = true;
  let pace = false; // the last long-poll came back at once with nothing new
  // The last `partialSeq` seen: the next long-poll's `after`, always sent (0 on the first one): the
  // gateway reads a missing `after` as -1, and its `partialSeq` 0 would then answer at once.
  let seq = 0;
  let lastStatus: QueueStatus = "pending";
  let pendingLive: DesktopLiveness | undefined; // the last poll's liveness, while it said `pending`
  /** Give up on an item nothing claimed; null = the desktop took it as we cancelled (409). */
  const giveUp = async (): Promise<DesktopWait | null> => {
    if (!opts.cancelUnclaimed) return { state: "unclaimed" };
    const c = await cancelDesktopItem(id);
    if (c === "cancelled") return { state: "unclaimed" };
    if (c === "failed") return { state: "uncancelled" };
    claimed = true; // 409: the desktop took it after all; it's Tony's now, never given up
    return null;
  };
  if (opts.cancelUnclaimed && opts.posted && desktopOff(opts.posted)) {
    const out = await giveUp();
    if (out) return out;
  }
  while (Date.now() - t0 < cap) {
    const delay = failures ? Math.min(DESKTOP_POLL_MS * 2 ** failures, DESKTOP_RETRY_MAX_MS) : first || (longPoll && !pace) ? 0 : DESKTOP_POLL_MS;
    first = false;
    if (delay) await sleep(Math.min(delay, cap - (Date.now() - t0))); // a backoff never runs past the cap
    let r: InboxPoll;
    const sentAt = Date.now();
    const asked = longPoll; // this GET asked the gateway to wait
    try {
      if (asked) {
        const w = longPollWait(sentAt - t0, cap, claimed, pendingLive, sentAt);
        r = await gateway<InboxPoll>(`/api/os/inbox/${id}?wait=${w}&after=${seq}`, { timeoutMs: w * 1000 + DESKTOP_LONG_POLL_PAD_MS });
      } else {
        r = await gateway<InboxPoll>(`/api/os/inbox/${id}`);
      }
    } catch (e) {
      if (!transientPollError(e)) throw e;
      failures++;
      lastPollOk = false;
      continue;
    }
    failures = 0;
    polled = lastPollOk = true;
    busy = !!r.desktopBusy;
    pendingLive = r.status === "pending" ? r : undefined;
    longPoll = typeof r.partialSeq === "number";
    const grew = longPoll && (r.partialSeq as number) > seq;
    pace = asked && longPoll && !grew && r.status === lastStatus && Date.now() - sentAt < LONG_POLL_FAST_MS;
    lastStatus = r.status;
    if (grew && (r.status === "pending" || r.status === "running")) {
      // Never for a finished item: its final result is what the caller gets.
      seq = r.partialSeq as number;
      if (typeof r.partial === "string") emitPartial(opts.onPartial, r.partial);
    }
    if (r.status === "pending") {
      // Not picked up yet. Fall back only when there's no desktop app: one that is busy with an earlier
      // turn (it takes them one at a time) or polled lately will answer, so keep waiting for Tony.
      // An item the desktop already claimed (a lease that lapsed back to pending) is never given up.
      // A caller that runs it elsewhere doesn't wait out the 12 s when the desktop app is plainly off.
      const pickupOver = Date.now() - t0 >= DESKTOP_PICKUP_MS && !desktopAlive(r);
      if (!claimed && (pickupOver || (opts.cancelUnclaimed && desktopOff(r)))) {
        const out = await giveUp();
        if (out) return out;
      }
      continue;
    }
    if (r.status === "running") {
      claimed = true; // the desktop is working on it
      continue;
    }
    if (r.status === "expired") throw new Error(DESKTOP_EXPIRED_MESSAGE);
    if (r.status === "cancelled") throw new Error(DESKTOP_CANCELLED_MESSAGE);
    if (r.result?.ok && r.result.result) return { state: "done", result: r.result.result };
    throw new Error(r.result?.error ?? `desktop ${kind} failed`);
  }
  return { state: "timeout", claimed, polled, lastPollOk, busy };
}

/**
 * Queue a turn payload for the desktop app and wait for its result. Returns null when nothing
 * answered: still unclaimed after 12 s with no desktop app running, or the 240 s cap ran out.
 * Desktop errors and `expired` throw (see `awaitDesktopItem`).
 */
export async function queueDesktopTurn(payload: DesktopTurnPayload): Promise<DesktopResult | null> {
  return queueDesktopItem("turn", payload);
}

/**
 * Queue any inbox item for the desktop and wait for its result (same pickup / cap / expired rules
 * as `queueDesktopTurn`; null = no result). A desktop refusal (e.g. the mode gate's
 * `MODE_SURFACE_ONLY` / `MODE_NOT_AUTO` on a `task`) throws its error text, so the caller never
 * claims success. A failed POST throws (nothing was queued).
 */
export async function queueDesktopItem(kind: InboxKind, payload: Record<string, unknown>, opts: { capMs?: number } = {}): Promise<DesktopResult | null> {
  const id = await postDesktopItem(kind, payload);
  const w = await awaitDesktopItem(id, kind, opts);
  return w.state === "done" ? w.result : null;
}

/** How long the phone waits for the desktop to answer a memory decision. */
export const MEMORY_DECISION_CAP_MS = 30_000;

/**
 * Phone (decision 5): Save (`approve`) or Skip one of Tony's pending core-memory proposals: an inbox
 * `command` (`memoryApprove` / `memoryDiscard`, applied by the desktop's InboxAction::Command).
 * Resolves with the desktop's `memory` answer ({ id, approved, saved }); null when no desktop
 * answered in time. A desktop refusal (expired / already answered) throws its text.
 */
export async function sendMemoryDecision(id: string, approve: boolean): Promise<Record<string, unknown> | null> {
  const r = await queueDesktopItem("command", approve ? { memoryApprove: id } : { memoryDiscard: id }, { capMs: MEMORY_DECISION_CAP_MS });
  const m = r?.memory;
  return m && typeof m === "object" ? (m as Record<string, unknown>) : null;
}

/** How long the phone waits for the desktop to run an approved card (the gateway drops it after 5 min). */
export const ACTION_CAP_MS = 60_000;
/** The tools a phone card may approve through the inbox (os_api.py `_ACTION_TOOLS`, pipeline.rs `APPROVED_ACTION_TOOLS`). */
export const APPROVED_ACTION_TOOLS = ["calendar.create_event", "gmail.create_draft"] as const;
export type ApprovedActionTool = (typeof APPROVED_ACTION_TOOLS)[number];

/** No desktop app took the approved card, and the gateway took it back: nothing ran, nothing will. */
export const ACTION_NEEDS_DESKTOP_MESSAGE = "Nothing was done: that needs the desktop app running. Open it on the PC and approve it again.";
/** The cancel got no answer: a desktop that starts soon may still run it. */
export const ACTION_UNCANCELLED_MESSAGE = "The desktop app isn't answering, and I couldn't take the request back, so it may still run when the app starts. Check before approving it again.";
/** The POST may have landed (no answer / 5xx). */
export const ACTION_UNCONFIRMED_MESSAGE = "I couldn't confirm the desktop got that, so it may or may not run. Check before approving it again.";

/**
 * Phone: run an APPROVED confirmation card on the desktop (`action` inbox item; pipeline.rs runs it
 * through the same approved-only path as the desktop card). Resolves with the desktop's answer.
 * Never a gateway CLI agent: no desktop app → the item is cancelled at the gateway and this throws
 * `ACTION_NEEDS_DESKTOP_MESSAGE` (nothing ran); a refusal throws its reason.
 */
export async function sendApprovedAction(tool: ApprovedActionTool, args: Record<string, unknown>, planId: string, now = new Date()): Promise<string> {
  const payload = { tool, args, planId, approvedAt: now.toISOString() };
  let posted: InboxPosted;
  try {
    posted = await postInboxItem("action", payload);
  } catch (e) {
    if (postMayHaveQueued(e)) throw new Error(ACTION_UNCONFIRMED_MESSAGE);
    throw new Error(`Nothing was done — ${e instanceof Error ? e.message : String(e)}`);
  }
  const w = await awaitDesktopItem(posted.id, "action", { capMs: ACTION_CAP_MS, cancelUnclaimed: true, posted });
  if (w.state === "done") return typeof w.result.answer === "string" && w.result.answer ? w.result.answer : "Done on the desktop.";
  if (w.state === "unclaimed") throw new Error(ACTION_NEEDS_DESKTOP_MESSAGE);
  if (w.state === "uncancelled") throw new Error(ACTION_UNCANCELLED_MESSAGE);
  throw new Error(desktopTimeoutMessage(w));
}

/**
 * Phone: queue a turn for the desktop's Tony and say what became of it. Only `unclaimed` (no
 * desktop app, and the gateway cancelled the item, so a desktop that starts later never runs it)
 * and `unqueued` with a refusal status (nothing was queued; see `postRefused`) leave the turn free
 * to run elsewhere; `uncancelled`, `timeout` and any other `unqueued` never do. A desktop error /
 * `expired` throws. When the POST (or a poll) says the desktop
 * app is off, the item is cancelled at once instead of after the 12 s pickup wait. `onPartial`:
 * Tony's answer so far as the desktop streams it (see `awaitDesktopItem`).
 */
export async function sendDesktopTurn(payload: DesktopTurnPayload, opts: { capMs?: number; onPartial?: (soFar: string) => void } = {}): Promise<DesktopTurnWait> {
  let posted: InboxPosted;
  try {
    posted = await postInboxItem("turn", payload);
  } catch (error) {
    return { state: "unqueued", error };
  }
  return awaitDesktopItem(posted.id, "turn", { ...opts, cancelUnclaimed: true, posted });
}

/**
 * Single entry point for "send this to the agents".
 *
 * Desktop: Rust `dispatch_chat` picks local vs cloud (GPU-load aware), injects
 * API keys from the OS keychain, and reports whether it fell back.
 * PWA and the Android app: the turn is queued for the desktop's Tony through the gateway (its Rust
 *          side runs on the phone, where 127.0.0.1 isn't the PC). The gateway's own agent (the
 *          opencode CLI) is the fallback ONLY when the turn never reached a desktop app and never
 *          will: the gateway refused the POST (400 / 404 / 413 / 422, `postRefused`: nothing
 *          queued), or nothing claimed it with no desktop polling AND the gateway cancelled it (at
 *          once when the desktop app is plainly off, `desktopOff`; else after the 12 s pickup
 *          wait). Once the desktop has claimed it, the phone waits for Tony or says he's still on
 *          it; when it can't tell (a POST with no answer or a 5xx, a cancel with no answer) it says
 *          so and runs nothing; a POST turned away for now (408 / 429) says to try again; any other
 *          POST status (401 / 403 …) throws. Desktop errors surface as errors. `opts.onPartial`
 *          gets Tony's answer so far while the desktop streams it; a done result's `streamPrefix`
 *          (gateway Tony's cold-start lead-in) is passed on in `result.streamPrefix`.
 */
export async function dispatch(text: string, opts: DispatchOptions = {}): Promise<DispatchOutcome> {
  // Phone/PWA has no live sync of the user's custom routing matrix yet, so it
  // resolves against the shared defaults — still far better than the old
  // keyword classifier, and "explicit" now means an actually-Named route
  // rather than "any role other than general" (previously *every* classified
  // role was treated as explicit, so a wrong keyword guess went straight to
  // that agent's raw reply with no Tony synthesis or fallback).
  // A caller that decided the role has the text read for its topic only: a self address can't
  // turn it into Tony's (the hand-off's own "[Tony — approved hand-off …]" opener).
  const resolved = resolve(text, DEFAULT_ROUTING_CONFIG, "", { ignoreSelfAddress: !!opts.role });
  // A live-tool read question ("any WhatsApp updates?") is Tony's own tool path on any tab;
  // only a Named delegation (the text's, or the caller's) keeps its agent (Rust applies the same
  // backstop to inbox turns: `route_for_turn` skips `direct_tool` for kind "Named").
  const named = resolved.kind === "Named" || opts.routeKind === "Named";
  const direct = named ? null : directTool(text);
  const routed = direct ? { ...resolved, role: "general", kind: "Direct" as const, reason: `live ${direct} tool` } : resolved;
  // The caller's role always stands. Without one, "Self" (the line addresses Tony himself:
  // "thanks tony", "ask the dispatcher…") is Tony, never explicit — Rust then answers as Tony
  // and never re-promotes it.
  const role: AgentRole = direct || opts.noDelegate ? "general" : (opts.role ?? (routed.kind === "Self" ? "general" : ((routed.role as AgentRole | null) ?? "general")));
  const explicit = !direct && !opts.role && !opts.noDelegate && routed.kind === "Named";
  // The caller's route kind goes to the desktop as given ("Self" only when `routeFor` kept the
  // line with Tony; a plain no-match stays "Default", re-resolved against the desktop's live
  // routing table, with `stayWithTony` from the Android app). Tier 2 is always "Self"; a live-tool
  // read always "Direct".
  const callerKind = !direct && !opts.noDelegate && opts.routeKind ? opts.routeKind : null;
  const routeKind = opts.noDelegate && !direct ? "Self" : (callerKind ?? routed.kind);
  const routeReason = opts.noDelegate && !direct ? "brainstorm with Tony (Tier 2)" : callerKind && callerKind !== routed.kind ? `caller-resolved (${callerKind})` : routed.reason;
  const agent = SUB_AGENTS[role];

  if (isDesktopApp()) {
    const messages: ChatMessage[] = [
      { role: "system", content: agent.systemPrompt },
      ...(opts.history ?? []).slice(-10),
      { role: "user", content: text },
    ];
    const result = await cmd("dispatch_chat", { req: { messages, priority: agent.priority, provider: opts.provider } });
    return { role, result };
  }

  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  // Phone: queue the turn for the desktop's OS core (same Tony, tools, sub-agents). A desktop
  // error or an expired item throws to the caller (never a silent fallback).
  const history = (opts.history ?? []).slice(-8);
  // The Android app's routing keeps a topic (Domain) with Tony (`routeFor`'s `phone`): when the
  // desktop re-resolves a Default turn, `stayWithTony` keeps a Domain hit with Tony too, while a
  // Named match or a registered business still routes. The PWA delegates topics, so it never sends it.
  const w = await sendDesktopTurn(
    { text, role, explicit, routeKind, routeReason, history, context: "", noDelegate: !!opts.noDelegate, ...(isAndroidApp() ? { stayWithTony: true } : {}) },
    { onPartial: opts.onPartial },
  );
  if (w.state === "done") {
    if (!w.result.answer) throw new Error(DESKTOP_NO_ANSWER_MESSAGE);
    // Gateway Tony's cold start streamed a lead-in ("One sec, Nic — waking up. ") the answer never
    // repeats: the phone's speech lines the final up with it (voice-controller `streamedText`).
    const prefix = w.result.streamPrefix;
    // Decision 5: the full OsTurnResult reaches the phone; keep the Learning card and pills.
    const pendingMemory = pendingMemoryOf(w.result.pendingMemory);
    const learned = learnedOf(w.result.learned);
    // A2: a booking-mail scan's threads, for a calendar-add card on a later turn.
    if (Array.isArray(w.result.bookings)) rememberBookings(bookingsOf(w.result.bookings));
    return {
      role,
      result: {
        providerId: `desktop:${w.result.providerId ?? "tony"}`,
        content: w.result.answer,
        fellBack: false,
        reason: "phone → desktop Tony",
        latencyMs: ms(),
        ...(typeof prefix === "string" && prefix ? { streamPrefix: prefix } : {}),
      },
      ...(pendingMemory.length ? { pendingMemory } : {}),
      ...(learned.length ? { learned } : {}),
    };
  }
  if (w.state === "timeout") {
    // The desktop has it (or it's queued behind an earlier turn): running it on the CLI too would do it twice.
    return {
      role,
      result: { providerId: "desktop:tony", content: desktopTimeoutMessage(w), fellBack: false, reason: "phone → desktop Tony (still waiting)", latencyMs: ms() },
      notice: "waiting",
    };
  }
  if (w.state === "uncancelled" || (w.state === "unqueued" && postMayHaveQueued(w.error))) {
    // It may be (or stay) in the desktop's queue: a desktop that starts later would answer it too.
    return {
      role,
      result: { providerId: "desktop:tony", content: DESKTOP_LOST_MESSAGE, fellBack: false, reason: "phone → desktop Tony (unconfirmed)", latencyMs: ms() },
      notice: "unconfirmed",
    };
  }
  if (w.state === "unqueued" && !postRefused(w.error)) {
    // Turned away for now (408 / 429): nothing queued, and a struggling gateway's CLI is no better.
    if (transientPollError(w.error)) {
      return {
        role,
        result: { providerId: "desktop:tony", content: DESKTOP_UNREACHABLE_MESSAGE, fellBack: false, reason: "phone → desktop Tony (gateway busy)", latencyMs: ms() },
        notice: "unconfirmed",
      };
    }
    // 401 / 403 / 409 …: the gateway's CLI would be refused the same way; say what went wrong.
    throw w.error;
  }
  // Never reached a desktop app and never will (`unclaimed`: cancelled at the gateway; `unqueued`:
  // the gateway refused the item, `postRefused`): the gateway's own agent answers, as the agent to the user.
  const res = await api.chat(agent.gatewayAgent, gatewayFallbackPrompt(agent.label, text));
  return {
    role,
    result: {
      providerId: `gateway:${agent.gatewayAgent}`,
      content: res.response?.content ?? "",
      fellBack: false,
      reason: "PWA → Agentic OS gateway",
      latencyMs: Math.round(performance.now() - started),
    },
  };
}
