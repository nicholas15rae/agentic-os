import { useEffect, useState } from "react";
import { ArrowRight, ChevronDown, ChevronRight, Loader2, MessagesSquare } from "lucide-react";
import { isTauri } from "@/lib/platform";
import { agentBadge } from "@/features/os/os-store";
import { useSettings } from "@/stores/settings";
import { loadBody, loadMore, loadPage, useTranscripts } from "./transcript-store";
import type { TranscriptConversation, TranscriptHead } from "./types";

/**
 * The Agent Conversation card: one per root conversation (a build, a Play Place hub build, a
 * delegated turn, a Claude Code run), in the thread that started it. Collapsed it is one line
 * (title, status, count, the last exchange); opened it is the whole record in time order — who
 * said what to whom, every prompt and reply, hand-offs, questions and answers, overrides, smoke
 * verdicts — with each full message loaded on demand. Nested conversations (a hub build's agent
 * pipeline, Claude Code's run) open inside it. Read-only: nothing here writes back.
 */

/** A participant's badge (the transcript's ids: tony, nic, staging, claude, tool, system, agents). Pure. */
export function participantBadge(id: string): string {
  switch (id) {
    case "tony":
      return agentBadge("os");
    case "nic":
      return agentBadge("user");
    case "staging":
      return "PLAY PLACE";
    case "claude":
      return "CLAUDE CODE";
    case "tool":
      return "TOOL";
    case "system":
      return "SYSTEM";
    default:
      return agentBadge(id);
  }
}

const KIND_TONE: Record<string, string> = {
  prompt: "text-volt",
  reply: "text-teal",
  handoff: "text-amber-light",
  question: "text-volt",
  answer: "text-amber",
  override: "text-amber",
  error: "text-alert",
  repair: "text-alert",
  smoke: "text-teal",
  retry: "text-amber-soft",
};

const STATUS_LABEL: Record<string, string> = {
  review_ready: "ready for review",
  ready_for_merge: "ready for merge",
  repair_queue: "repair queue",
  smoke_testing: "smoke testing",
};
const statusLabel = (s: string) => STATUS_LABEL[s] ?? s.replace(/_/g, " ");

const CONV_LABEL: Record<string, string> = { task: "Agent pipeline", hub: "Play Place build", turn: "Delegation", dev: "Claude Code run" };

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function Who({ id }: { id: string }) {
  return <span className="rounded-full bg-white/10 px-2 py-0.5 font-mono text-[10px] font-semibold tracking-wider text-ink">{participantBadge(id)}</span>;
}

/** Card for a chat turn with `convId`. Hidden when `chat.showAgentConversation` is off, and for a
 * conversation that turned out to be nested (its parent's card shows it). The phone has no
 * transcript store: there the turn is a plain line. */
export function AgentConversationCard({ convId, fallback }: { convId: string; fallback: string }) {
  const show = useSettings((s) => s.chat?.showAgentConversation ?? true);
  const conv = useTranscripts((s) => s.convs[convId]);
  const [open, setOpen] = useState(false);
  if (!show) return null;
  if (!conv || !isTauri()) return <p className="font-mono text-[11px] text-teal">— {fallback}</p>;
  if (conv.parentConvId) return null;
  return (
    <div className="rounded-[12px] border border-teal/25 bg-teal/[0.04] px-3 py-2 text-[13px]" data-conv={convId}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full min-w-0 items-center gap-2 text-left">
        {open ? <ChevronDown size={13} className="shrink-0 text-teal" /> : <ChevronRight size={13} className="shrink-0 text-teal" />}
        <MessagesSquare size={13} className="shrink-0 text-teal" />
        <span className="label-caps shrink-0 !text-[10px] text-teal">{CONV_LABEL[conv.kind] ?? "Agent conversation"}</span>
        <span className="min-w-0 truncate text-ink">{conv.title || "Untitled"}</span>
        {conv.status && <span className="shrink-0 rounded-full bg-white/10 px-2 py-0.5 font-mono text-[10px] text-ink-2">{statusLabel(conv.status)}</span>}
        <span className="ml-auto shrink-0 font-mono text-[10px] text-ink-3">
          {conv.messageCount} msg{conv.messageCount === 1 ? "" : "s"}
        </span>
      </button>
      {!open && <LastLine conv={conv} />}
      {open && <ConversationBody convId={convId} depth={0} />}
    </div>
  );
}

function LastLine({ conv }: { conv: TranscriptConversation }) {
  if (!conv.lastSummary) return null;
  return (
    <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[12px] text-ink-3">
      {conv.lastFrom && <Who id={conv.lastFrom} />}
      {conv.lastTo && conv.lastTo !== conv.lastFrom && (
        <>
          <ArrowRight size={10} className="shrink-0" />
          <Who id={conv.lastTo} />
        </>
      )}
      <span className="min-w-0 truncate">{conv.lastSummary}</span>
    </div>
  );
}

type Item = { at: number; seq: number; m?: TranscriptHead; child?: string };

/** Messages and nested conversations, interleaved in time order. Pure. */
export function timeline(messages: readonly TranscriptHead[], children: readonly TranscriptConversation[]): Item[] {
  const items: Item[] = [...messages.map((m) => ({ at: m.at, seq: m.seq, m })), ...children.map((c) => ({ at: c.createdAt, seq: -1, child: c.convId }))];
  return items.sort((a, b) => a.at - b.at || a.seq - b.seq);
}

function ConversationBody({ convId, depth }: { convId: string; depth: number }) {
  const page = useTranscripts((s) => s.pages[convId]);
  const conv = useTranscripts((s) => s.convs[convId]);
  const convs = useTranscripts((s) => s.convs);
  useEffect(() => {
    void loadPage(convId);
  }, [convId]);
  if (!page || (page.loading && !page.loaded)) {
    return (
      <p className="mt-2 flex items-center gap-2 font-mono text-[11px] text-ink-3">
        <Loader2 size={12} className="animate-spin" /> loading the conversation…
      </p>
    );
  }
  if (page.error && !page.loaded) return <p className="mt-2 font-mono text-[11px] text-alert">Couldn't load it: {page.error}</p>;
  const children = page.children.map((id) => convs[id]).filter((c): c is TranscriptConversation => !!c);
  const items = timeline(page.messages, children);
  return (
    <div className={`mt-2 space-y-1.5 ${depth > 0 ? "border-l border-white/10 pl-3" : ""}`}>
      {!items.length && <p className="font-mono text-[11px] text-ink-3">Nothing recorded yet.</p>}
      {items.map((it) => (it.m ? <MessageRow key={`m${it.m.seq}`} m={it.m} /> : <NestedConversation key={`c${it.child}`} convId={it.child!} depth={depth + 1} />))}
      {page.more && (
        <button type="button" onClick={() => void loadMore(convId)} className="pill-glass !h-7 !px-3 text-[11px]">
          Load more
        </button>
      )}
      {!!conv?.dropped && <p className="font-mono text-[10px] text-ink-3">{conv.dropped} routine line{conv.dropped === 1 ? "" : "s"} past the cap weren't kept (hand-offs, errors, smoke tests and overrides always are).</p>}
    </div>
  );
}

function NestedConversation({ convId, depth }: { convId: string; depth: number }) {
  const conv = useTranscripts((s) => s.convs[convId]);
  const [open, setOpen] = useState(false);
  if (!conv) return null;
  return (
    <div className="rounded-[10px] border border-white/10 bg-white/[0.02] px-2.5 py-1.5">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full min-w-0 items-center gap-2 text-left text-[12px]">
        {open ? <ChevronDown size={12} className="shrink-0 text-ink-3" /> : <ChevronRight size={12} className="shrink-0 text-ink-3" />}
        <span className="label-caps shrink-0 !text-[10px] text-ink-2">{CONV_LABEL[conv.kind] ?? "Conversation"}</span>
        <span className="min-w-0 truncate text-ink-2">{conv.taskId ?? conv.title}</span>
        {conv.status && <span className="shrink-0 rounded-full bg-white/10 px-2 py-0.5 font-mono text-[10px] text-ink-3">{statusLabel(conv.status)}</span>}
        <span className="ml-auto shrink-0 font-mono text-[10px] text-ink-3">{conv.messageCount}</span>
      </button>
      {!open && <LastLine conv={conv} />}
      {open && <ConversationBody convId={convId} depth={depth} />}
    </div>
  );
}

function MessageRow({ m }: { m: TranscriptHead }) {
  const [open, setOpen] = useState(false);
  const body = useTranscripts((s) => s.bodies[m.seq]);
  const toggle = () => {
    if (!open && body === undefined) void loadBody(m.seq);
    setOpen((o) => !o);
  };
  const self = m.from === m.to;
  return (
    <div className={`rounded-[10px] px-2 py-1.5 ${m.ok ? "" : "bg-alert/[0.06]"}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Who id={m.from} />
        {!self && (
          <>
            <ArrowRight size={10} className="text-ink-3" />
            <Who id={m.to} />
          </>
        )}
        <span className={`font-mono text-[10px] uppercase tracking-wider ${KIND_TONE[m.kind] ?? "text-ink-3"}`}>{m.kind}</span>
        {m.stage && (
          <span className="font-mono text-[10px] text-ink-3">
            {m.stage}
            {m.iteration ? ` · it ${m.iteration}` : ""}
          </span>
        )}
        <span className="ml-auto font-mono text-[10px] text-ink-3">{time(m.at)}</span>
      </div>
      <p className="mt-0.5 whitespace-pre-wrap break-words text-ink-2">{m.summary}</p>
      {m.bodyChars > 0 && (
        <button type="button" onClick={toggle} className="mt-0.5 font-mono text-[10px] text-teal hover:underline" aria-expanded={open}>
          {open ? "Hide full message" : `Show full message (${m.originalChars.toLocaleString()} chars)`}
        </button>
      )}
      {open && (
        <div className="mt-1">
          {body === undefined ? (
            <p className="font-mono text-[11px] text-ink-3">loading…</p>
          ) : (
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-[8px] bg-black/30 p-2 font-mono text-[11px] leading-relaxed text-ink-2">{body}</pre>
          )}
          {m.truncated && <p className="mt-0.5 font-mono text-[10px] text-ink-3">Long message: the start and the end are kept ({m.bodyChars.toLocaleString()} of {m.originalChars.toLocaleString()} characters).</p>}
        </div>
      )}
    </div>
  );
}

/** Agents header switch: show / hide the Agent Conversation cards. Visual only — the spoken Agent
 * Chatter switch beside it is separate. */
export function AgentConversationToggle() {
  const on = useSettings((s) => s.chat?.showAgentConversation ?? true);
  const set = useSettings((s) => s.set);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => set({ chat: { ...useSettings.getState().chat, showAgentConversation: !on } })}
      className={`flex h-9 items-center gap-2 rounded-full border px-3 text-[12px] transition-colors ${on ? "border-teal/50 bg-teal/10 text-teal-soft" : "border-white/10 text-ink-3 hover:text-ink-2"}`}
      title="Agent Log: a card in the chat for every build and delegation — the full conversation between Tony and the agents (prompts, replies, hand-offs, interview, steers, smoke tests), to review. Visual only; Agent Chatter (spoken) is separate."
    >
      <MessagesSquare size={13} />
      <span>Agent Log: {on ? "On" : "Off"}</span>
    </button>
  );
}
