import { create } from "zustand";
import { isTauri } from "@/lib/platform";
import { onExtEvent, xcmd } from "@/lib/native-ext";
import { THREADS, useVoice, type ThreadId, type VoiceTurn } from "@/features/voice/voice-store";
import type { TranscriptConversation, TranscriptEvent, TranscriptHead, TranscriptPage } from "./types";

/**
 * The Agent Conversation feed (webview side). Rust owns the record (`transcripts.db`); this store
 * only caches what the read commands and the `agent-transcript` event hand it:
 * - `convs`: conversation summaries (title, status, counts, last line), by id;
 * - `pages`: the loaded messages (heads only) and nested conversations of an opened card;
 * - `bodies`: full message bodies, fetched one by one when a row is opened.
 * Each ROOT conversation gets one chat card: a `VoiceTurn` with `convId` in the conversation's
 * thread, at the time it started. After a restart or reload the cards are rebuilt from
 * `transcript_conversations` (never from bus delivery). The card is additive: the relay / system
 * lines, the spoken Agent Chatter and the narrator are untouched; `chat.showAgentConversation`
 * only shows or hides cards.
 */

export interface PageState {
  messages: TranscriptHead[];
  /** Nested conversation ids (a hub build's worker task / Claude item). */
  children: string[];
  more: boolean;
  loaded: boolean;
  loading: boolean;
  error?: string;
}

export interface TranscriptState {
  convs: Record<string, TranscriptConversation>;
  pages: Record<string, PageState>;
  bodies: Record<number, string>;
}

export const useTranscripts = create<TranscriptState>(() => ({ convs: {}, pages: {}, bodies: {} }));

/** The id of a conversation's chat card turn (stable: dedupes a rebuild against a live event). */
export const cardTurnId = (convId: string) => `conv:${convId}`;

/** Messages by `seq`, ordered by `(at, seq)` (the Rust page order). Pure. */
export function mergeHeads(a: readonly TranscriptHead[], b: readonly TranscriptHead[]): TranscriptHead[] {
  const bySeq = new Map<number, TranscriptHead>();
  for (const m of [...a, ...b]) bySeq.set(m.seq, m);
  return [...bySeq.values()].sort((x, y) => x.at - y.at || x.seq - y.seq);
}

/** Fold one live event into the cache: the conversation summary always; the message only into a
 * page that is already loaded (an unopened card loads its page on demand). Pure. */
export function applyTranscriptEvent(s: TranscriptState, ev: TranscriptEvent): TranscriptState {
  if (!ev?.conv?.convId || !ev.message) return s;
  const id = ev.conv.convId;
  const prev = s.convs[id];
  // Never let a stale (older) summary overwrite a newer one.
  const conv = prev && prev.updatedAt > ev.conv.updatedAt ? { ...prev, messageCount: Math.max(prev.messageCount, ev.conv.messageCount) } : ev.conv;
  let pages = s.pages;
  const page = pages[id];
  if (page?.loaded) pages = { ...pages, [id]: { ...page, messages: mergeHeads(page.messages, [ev.message]) } };
  const parent = conv.parentConvId;
  const pp = parent ? pages[parent] : undefined;
  if (parent && pp?.loaded && !pp.children.includes(id)) pages = { ...pages, [parent]: { ...pp, children: [...pp.children, id] } };
  return { ...s, convs: { ...s.convs, [id]: conv }, pages };
}

/** Fold a loaded page (first page, or `append` for "load more"). Pure. */
export function applyPage(s: TranscriptState, page: TranscriptPage, append: boolean): TranscriptState {
  const id = page.conv.convId;
  const prev = s.pages[id];
  const convs = { ...s.convs, [id]: page.conv };
  for (const c of page.children) convs[c.convId] = c;
  const messages = append && prev ? mergeHeads(prev.messages, page.messages) : mergeHeads([], page.messages);
  const children = [...new Set([...(append && prev ? prev.children : []), ...page.children.map((c) => c.convId)])];
  return { ...s, convs, pages: { ...s.pages, [id]: { messages, children, more: page.more, loaded: true, loading: false } } };
}

/** The thread a conversation's card belongs in (unknown → Tony's main thread). Pure. */
export function cardThread(c: Pick<TranscriptConversation, "thread">): ThreadId {
  return (THREADS as readonly string[]).includes(c.thread) ? (c.thread as ThreadId) : "auto";
}

/** The chat card for a root conversation: a system turn carrying `convId`, placed where the
 * conversation started. Its text is what the phone (no transcript store) shows. Pure. */
export function cardTurn(c: TranscriptConversation): VoiceTurn {
  return { id: cardTurnId(c.convId), who: "system", text: `Agent conversation · “${c.title || "untitled"}”`, thread: cardThread(c), at: c.createdAt, convId: c.convId };
}

/** The card turns to add: root conversations without a card yet, skipping ones whose last
 * activity predates a Clear of their thread (a cleared thread stays clear across restarts). Pure. */
export function cardsToAdd(convs: readonly TranscriptConversation[], turns: readonly Pick<VoiceTurn, "convId">[], clearedAt: Partial<Record<ThreadId, number>> = {}): VoiceTurn[] {
  const have = new Set(turns.map((t) => t.convId).filter(Boolean));
  const out: VoiceTurn[] = [];
  for (const c of convs) {
    if (!c?.convId || c.parentConvId || have.has(c.convId)) continue;
    if (c.updatedAt <= (clearedAt[cardThread(c)] ?? 0)) continue;
    have.add(c.convId);
    out.push(cardTurn(c));
  }
  return out;
}

/** Card turns of conversations that turned out to be nested (a hub's worker task is created —
 * and announced — a moment before it is bound to its build). Pure. */
export function nestedCardIds(turns: readonly Pick<VoiceTurn, "id" | "convId">[], convs: Record<string, Pick<TranscriptConversation, "parentConvId">>): string[] {
  return turns.filter((t) => t.convId && convs[t.convId]?.parentConvId).map((t) => t.id);
}

/** Make the chat match the cache: add missing root cards, drop cards of nested conversations. */
export function syncCards(convs: readonly TranscriptConversation[]) {
  const v = useVoice.getState();
  const add = cardsToAdd(convs, v.turns, v.clearedAt);
  if (add.length) v.mergeRemote(add);
  const drop = new Set(nestedCardIds(useVoice.getState().turns, useTranscripts.getState().convs));
  if (drop.size) useVoice.setState((s) => ({ turns: s.turns.filter((t) => !drop.has(t.id)) }));
}

function onEvent(ev: TranscriptEvent) {
  useTranscripts.setState((s) => applyTranscriptEvent(s, ev));
  const c = useTranscripts.getState().convs[ev?.conv?.convId];
  if (c) syncCards([c]);
}

/** Load (or reload) a conversation's first page. */
export async function loadPage(convId: string): Promise<void> {
  if (!isTauri()) return;
  useTranscripts.setState((s) => ({ pages: { ...s.pages, [convId]: { ...(s.pages[convId] ?? { messages: [], children: [], more: false, loaded: false }), loading: true, error: undefined } } }));
  try {
    const page = await xcmd("transcript_get", { conv_id: convId });
    useTranscripts.setState((s) => applyPage(s, page, false));
  } catch (e) {
    useTranscripts.setState((s) => ({ pages: { ...s.pages, [convId]: { ...(s.pages[convId] ?? { messages: [], children: [], more: false, loaded: false }), loading: false, error: String(e) } } }));
  }
}

/** The next page after the last loaded message. */
export async function loadMore(convId: string): Promise<void> {
  const p = useTranscripts.getState().pages[convId];
  const last = p?.messages[p.messages.length - 1];
  if (!isTauri() || !p?.loaded || !last) return;
  try {
    const page = await xcmd("transcript_get", { conv_id: convId, after_seq: last.seq });
    useTranscripts.setState((s) => applyPage(s, page, true));
  } catch {
    /* the button stays; a retry is one click */
  }
}

/** One message's full body (cached). */
export async function loadBody(seq: number): Promise<string | null> {
  const have = useTranscripts.getState().bodies[seq];
  if (have !== undefined) return have;
  if (!isTauri()) return null;
  try {
    const m = await xcmd("transcript_message", { seq });
    useTranscripts.setState((s) => ({ bodies: { ...s.bodies, [seq]: m.body } }));
    return m.body;
  } catch {
    return null;
  }
}

/** Rebuild from Rust's persisted rows (startup, a webview reload). */
export async function hydrateTranscripts(): Promise<void> {
  const list = await xcmd("transcript_conversations", { limit: 50, roots_only: true });
  useTranscripts.setState((s) => {
    const convs = { ...s.convs };
    for (const c of list) if (!convs[c.convId] || convs[c.convId].updatedAt < c.updatedAt) convs[c.convId] = c;
    return { convs };
  });
  syncCards(list);
}

let started = false;
/** Desktop: listen first, then rebuild from the store (an event that lands meanwhile is merged,
 * not lost). Phone: nothing (its mirrored card turns render as plain lines). */
export function startTranscriptFeed() {
  if (started || !isTauri()) return;
  started = true;
  void onExtEvent<TranscriptEvent>("agent-transcript", onEvent).then(() => hydrateTranscripts().catch(() => undefined));
}
