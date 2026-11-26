import { useEffect, useRef } from "react";
import { ArrowRight, BookMarked } from "lucide-react";
import { PromptBox } from "@/components/PromptBox";
import { useDraft } from "@/lib/prompt-drafts";
import { tonyThreadForView, useThreadTurns, useVoice, type ThreadId, type VoiceState } from "./voice-store";
import { askOverseer, handleInput, runTurnAction, setMicEnabled, toggleListening } from "./voice-controller";
import { useMic } from "./mic-gate";
import { MicButtonView } from "./MicLockBadge";
import { isSelfRelay } from "./route-for";
import { useFocus } from "@/features/os/focus-store";
import { SUB_AGENTS, type AgentRole } from "@/features/dispatcher/agents";
import { agentBadge, useOsName } from "@/features/os/os-store";
import { isTauri } from "@/lib/platform";
import { useNav } from "@/stores/nav";
import { AgentConversationCard } from "@/features/transcript/AgentConversationCard";
import { learnedPillText } from "@/features/modes/learning";
import { DispatchCard, PacketOutcome } from "@/features/arbiter/DispatchCard";
import { MemoryProposalCard } from "@/features/modes/MemoryProposalCard";

/** Shared building blocks for the floating HUD, the Voice Console widget and the Agents section. */

export const STATE_DOT: Record<VoiceState, string> = {
  idle: "bg-ink-3",
  listening: "bg-teal shadow-[0_0_10px_#00e5c3]",
  transcribing: "bg-teal shadow-[0_0_10px_#00e5c3] animate-pulse",
  thinking: "bg-amber shadow-[0_0_10px_#ff7a2f] animate-pulse",
  confirming: "bg-amber shadow-[0_0_10px_#ff7a2f]",
  speaking: "bg-volt shadow-[0_0_10px_#00f0ff]",
  holding: "bg-amber-light shadow-[0_0_10px_#ffb37a]",
  error: "bg-alert",
};

/** Tony's own thread (hook): where voice writes — Auto, or his Agents tab; never a sub-agent's.
 * Re-renders when the section or the Agents tab changes. */
export function useTonyThread(): ThreadId {
  const section = useNav((s) => s.section);
  const active = useVoice((s) => s.activeThread);
  return tonyThreadForView(section, active);
}

/**
 * The round mic button. `locked` (default: the mic gate is off) shows the locked-off face: a click
 * asks to unlock (Rust acks first on desktop) and never starts listening. While Tony is thinking or
 * speaking a reply to a typed turn, the button stays a stop button (it never opens the mic).
 */
export function MicButton({ size = 44, locked }: { size?: number; locked?: boolean }) {
  const state = useVoice((s) => s.state);
  const gateOff = useMic((s) => !s.enabled);
  const showLocked = (locked ?? gateOff) && state !== "speaking" && state !== "thinking";
  return <MicButtonView state={state} locked={showLocked} size={size} onClick={showLocked ? () => void setMicEnabled(true) : toggleListening} />;
}

export function Transcript({ max = 50, className = "", thread }: { max?: number; className?: string; thread?: ThreadId }) {
  const turns = useThreadTurns(thread).slice(-max);
  const name = useOsName();
  const end = useRef<HTMLDivElement>(null);
  const desktop = isTauri();
  // Braces matter: newer Chromium returns a Promise from scrollIntoView, and an
  // effect must not return anything but a cleanup function.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [turns.length]);
  if (!turns.length) return null;
  const openThread = (t: ThreadId) => {
    useVoice.getState().setActiveThread(t);
    useNav.getState().go("agents");
  };
  return (
    <div className={`space-y-3 overflow-y-auto ${className}`} aria-live="polite">
      {turns.map((t) => {
        // An Agent Conversation card (the setting hides it; on the phone it's a plain line).
        if (t.convId) return <AgentConversationCard key={t.id} convId={t.convId} fallback={t.text} />;
        if (t.who === "system")
          return (
            <p key={t.id} className={`font-mono text-[11px] ${t.tone === "error" ? "text-alert" : t.tone === "warn" ? "text-amber-soft" : "text-teal"}`}>
              — {t.text}
            </p>
          );
        // Never "TONY → TONY": a relay from Tony to himself (any alias, or one saved before P2). A
        // build's own single-agent row (a retry, a skipped Designer, a wait) is a status line with
        // one badge — part of the record, never dropped.
        const selfRow = t.who === "relay" && (isSelfRelay(t, name) || agentBadge(t.from ?? "os") === agentBadge(t.to ?? "user"));
        if (selfRow && !t.taskId) return null;
        if (t.who === "relay")
          return (
            <div key={t.id} className={`rounded-[12px] border px-3 py-2 text-[13px] ${t.tone === "warn" ? "border-amber/30 bg-amber/[0.05]" : "border-volt/20 bg-volt/[0.04]"}`}>
              <div className="mb-1 flex flex-wrap items-center gap-1.5">
                <span className="rounded-full bg-white/10 px-2 py-0.5 font-mono text-[10px] font-semibold tracking-wider text-ink">{agentBadge(t.from ?? "os")}</span>
                {!selfRow && (
                  <>
                    <ArrowRight size={11} className="text-ink-3" />
                    <span className="rounded-full bg-white/10 px-2 py-0.5 font-mono text-[10px] font-semibold tracking-wider text-ink">{agentBadge(t.to ?? "user")}</span>
                  </>
                )}
                {t.meta && <span className="font-mono text-[10px] text-ink-3">{t.meta}</span>}
              </div>
              <p className="whitespace-pre-wrap break-words text-ink-2">{t.text}</p>
            </div>
          );
        const sender = t.who === "user" ? "Query" : t.from === "overseer" ? "Overseer" : t.from && t.from !== "os" ? agentBadge(t.from) : name;
        return (
          <div key={t.id} className="group grid grid-cols-[72px_1fr] gap-3 text-sm">
            <span className={`label-caps truncate pt-0.5 ${t.who === "user" ? "text-amber" : t.from === "overseer" ? "text-volt" : "text-teal"}`} title={sender}>
              {sender}
            </span>
            <div className="min-w-0">
              <p className={`whitespace-pre-wrap break-words ${t.who === "user" ? "italic text-ink" : "text-ink"}`}>{t.text}</p>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                {t.meta && <span className="font-mono text-[11px] text-ink-3">{t.meta}</span>}
                {t.link && (
                  <button onClick={() => openThread(t.link!)} className="rounded-full border border-teal/40 bg-teal/10 px-2.5 py-0.5 text-[11px] text-teal hover:bg-teal/20">
                    View in {t.link === "general" ? name : SUB_AGENTS[t.link as AgentRole]?.label ?? t.link} →
                  </button>
                )}
                {t.commsThread && (
                  <button
                    onClick={() => (useFocus.getState().set({ commsThread: t.commsThread }), useNav.getState().go("comms"))}
                    className="rounded-full border border-volt/40 bg-volt/10 px-2.5 py-0.5 text-[11px] text-volt hover:bg-volt/20"
                  >
                    Jump to Thread in Comms →
                  </button>
                )}
                {t.dispatch && <DispatchCard turnId={t.id} view={t.dispatch} />}
                {t.packet && <PacketOutcome result={t.packet} />}
                {!!t.pendingMemory?.length && <MemoryProposalCard turnId={t.id} items={t.pendingMemory} />}
                {t.learned?.map((p) => (
                  <span key={p.id} title={`${p.category} · ${p.confidence}`} className="inline-flex items-center gap-1 rounded-full border border-teal/30 bg-teal/[0.06] px-2 py-0.5 text-[10.5px] text-teal/90">
                    <BookMarked size={10} aria-hidden /> {learnedPillText(p)}
                  </span>
                ))}
                {t.cardId && (
                  <button
                    onClick={() => (useFocus.getState().set({ card: t.cardId }), useNav.getState().go("playplace"))}
                    className="rounded-full border border-amber/40 bg-amber/10 px-2.5 py-0.5 text-[11px] text-amber-light hover:bg-amber/20"
                  >
                    Open in Play Place →
                  </button>
                )}
                {t.actions?.map((a) => (
                  <button key={a.run} onClick={() => runTurnAction(a.run, t.thread)} className={a.run.startsWith("pipeline:") ? "pill-primary !h-7 !px-3 text-[11px]" : "pill-glass !h-7 !px-3 text-[11px]"}>
                    {a.label}
                  </button>
                ))}
                {desktop && t.who === "agent" && t.from !== "overseer" && (
                  <button
                    onClick={() => void askOverseer(t)}
                    className="rounded-full border border-white/10 px-2.5 py-0.5 text-[11px] text-ink-3 opacity-70 transition-opacity hover:text-ink group-hover:opacity-100"
                    title="Escalate this answer to the Overseer (Claude / Gemini / droplet — Settings → Integrations)"
                  >
                    Ask Overseer
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })}
      <div ref={end} />
    </div>
  );
}

export function CommandInput({ thread, placeholder = "Type a command for the dispatcher…", autoFocus }: { thread?: ThreadId; placeholder?: string; autoFocus?: boolean }) {
  // One draft per thread: a long message survives closing the panel or switching views.
  const [text, setText] = useDraft(`chat.${thread ?? "general"}`);
  const state = useVoice((s) => s.state);
  const pending = useVoice((s) => !!s.pending);
  const busy = state === "thinking" || state === "transcribing";
  return (
    <PromptBox
      label="Command"
      value={text}
      onChange={setText}
      autoFocus={autoFocus}
      busy={busy}
      historyKey="chat"
      size="md"
      placeholder={pending ? "Type yes or no…" : `${placeholder} (Enter = new line)`}
      onSubmit={(t) => {
        if (busy) return;
        setText("");
        void handleInput(t, { channel: "text", thread });
      }}
    />
  );
}
