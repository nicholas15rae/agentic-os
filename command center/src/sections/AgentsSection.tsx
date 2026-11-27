import { lazy, Suspense, useEffect, useState } from "react";
import { panelShown, revealPanel } from "@/core/widgets/reveal";
import { createPortal } from "react-dom";
import { LayoutSurface } from "@/core/widgets/LayoutSurface";
import { AGENTS_SURFACE, useAgentsLayout } from "./agents/panels";
import { ChevronDown, ChevronRight, Library, Loader2, Snowflake, Trash2, X } from "lucide-react";
import { isTauri } from "@/lib/platform";
import { SUB_AGENTS, type AgentRole } from "@/features/dispatcher/agents";
import { THREADS, useVoice, type ThreadId } from "@/features/voice/voice-store";
import { CommandInput, MicButton, Transcript } from "@/features/voice/VoiceParts";
import { useOsName } from "@/features/os/os-store";
import { HandoffChip, HandoffToggle } from "@/features/voice/HandoffToggle";
import { AgentConversationToggle } from "@/features/transcript/AgentConversationCard";
import { useModes } from "@/features/modes/modes-store";
import { frozenAgentReason } from "@/features/modes/modes";
import { useOs } from "@/features/os/os-store";
import { osSwitchboard } from "@/features/os/switchboard";
import { useAgentInbox } from "@/features/comms/agent-inbox";
import { AgentInbox } from "@/features/comms/AgentInbox";
import { HelpDeskButton } from "@/features/helpdesk/HelpDesk";
import { splitFrozen } from "@/features/modes/frozen-tabs";


/**
 * The Dispatcher. Each tab is its own isolated thread: Auto-route, every
 * sub-agent, and the OS itself. Talking on a sub-agent's tab goes straight to
 * that agent's AnythingLLM workspace; asking the OS to "ask my booking agent…"
 * from Auto-route shows the TONY ⇄ BOOKING AGENT exchange in the Booking tab.
 */
const McpRegistryCard = lazy(() => import("@/sections/settings/LibrarySettings").then((m) => ({ default: m.McpRegistryCard })));
const SkillsLibraryCard = lazy(() => import("@/sections/settings/LibrarySettings").then((m) => ({ default: m.SkillsLibraryCard })));

/** Thread names, counts and the frozen split, shared by the tab bar and the conversation. */
function useThreads() {
  const thread = useVoice((s) => s.activeThread);
  // Agent Conversation cards count as part of a thread (they are system turns with a convId).
  const counts = useVoice((s) => THREADS.map((t) => s.turns.filter((x) => x.thread === t && (x.who !== "system" || !!x.convId)).length).join(","));
  const name = useOsName();
  const n = Object.fromEntries(THREADS.map((t, i) => [t, Number(counts.split(",")[i])])) as Record<ThreadId, number>;
  const label = (t: ThreadId) => (t === "auto" ? "Auto-route" : t === "general" ? name : SUB_AGENTS[t as AgentRole].label);
  return { thread, n, name, label };
}

/**
 * The Agents page on the shared layout system: the thread tabs, the conversation, the agent's
 * reports and the Skills & MCP library are panels (move, resize, hide, add back, per mode, Reset).
 */
export function AgentsSection() {
  // A thread link (or a tab) always lands on a visible conversation.
  const thread = useVoice((s) => s.activeThread);
  useEffect(() => {
    if (!panelShown(useAgentsLayout.getState(), "ag-chat")) revealPanel(useAgentsLayout, "ag-chat", "Agents");
  }, [thread]);
  return <LayoutSurface store={useAgentsLayout} label="Agents" />;
}

/** The thread tabs (frozen ones grouped), the routing switches, the library and Clear. */
export function AgentThreadsBar() {
  const [drawer, setDrawer] = useState(false);
  const { thread, n, name, label } = useThreads();
  const setThread = useVoice((s) => s.setActiveThread);
  const clear = useVoice((s) => s.clear);
  // Frozen agents (master switchboard or the active mode) are tucked into their own group.
  const effective = useModes((s) => s.effective);
  const mirror = useModes((s) => s.frozen);
  const cfg = useOs((s) => s.cfg);
  const sb = osSwitchboard(cfg);
  const freeze = mirror ? { frozenAgents: mirror.agents, frozenTools: mirror.tools } : { frozenAgents: sb.frozenAgents, frozenTools: sb.frozenTools };
  const { live, frozen } = splitFrozen(THREADS, (t) => frozenAgentReason(effective, t, freeze, name));
  const [showFrozen, setShowFrozen] = useState(false);
  // Unread agent reports per tab (the Comms inbox, filtered by agent).
  const inbox = useAgentInbox((s) => s.messages);
  const unreadOf = (t: ThreadId) => inbox.reduce((k, m) => k + (!m.read && m.agent === t ? 1 : 0), 0);

  const tab = (t: ThreadId, why?: string) => {
    const Icon = t === "auto" ? null : SUB_AGENTS[t as AgentRole].icon;
    const unread = unreadOf(t);
    return (
      <button
        key={t}
        role="tab"
        aria-selected={thread === t}
        onClick={() => setThread(t)}
        title={why}
        className={`flex h-9 items-center gap-2 rounded-full border px-3.5 fs-13 transition-colors ${
          thread === t ? "border-amber/60 bg-amber/15 text-ink" : "border-white/10 bg-[rgba(11,13,17,0.45)] text-ink-2 backdrop-blur-md hover:text-ink"
        } ${why ? "opacity-50" : ""}`}
      >
        {Icon && <Icon size={14} />}
        {label(t)}
        {n[t] > 0 && <span className="rounded-full bg-white/10 px-1.5 font-mono fs-10 text-ink-2">{n[t]}</span>}
        {unread > 0 && (
          <span className="rounded-full bg-amber px-1.5 font-mono fs-10 text-canvas" aria-label={`${unread} unread report${unread === 1 ? "" : "s"}`}>
            {unread}
          </span>
        )}
      </button>
    );
  };

  return (
    <>
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Conversation threads">
        {live.map((t) => tab(t))}
        {frozen.length > 0 && (
          <button
            type="button"
            onClick={() => setShowFrozen((v) => !v)}
            aria-expanded={showFrozen}
            className="flex h-9 items-center gap-1.5 rounded-full border border-dashed border-white/10 px-3 fs-12 text-ink-3 hover:text-ink-2"
            title={frozen.map((f) => f.why).join("\n")}
          >
            <Snowflake size={12} /> Frozen ({frozen.length}) {showFrozen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        )}
        {(showFrozen ? frozen : frozen.filter((f) => f.t === thread)).map((f) => tab(f.t, f.why))}
        {/* Thought-to-Product Phase 5: the routing chip + the Vocal Handoffs switch. */}
        <div className="ml-auto flex items-center gap-2">
          <HandoffChip />
          <HandoffToggle />
          <AgentConversationToggle />
          <HelpDeskButton thread={thread} />
        </div>
        {isTauri() && (
          <button onClick={() => setDrawer(true)} className="flex h-9 items-center gap-1.5 rounded-full border border-white/10 px-3 fs-13 text-ink-2 hover:text-ink" title="Skills & MCP library">
            <Library size={13} /> Skills & MCP
          </button>
        )}
        {n[thread] > 0 && (
          <button onClick={() => clear(thread)} className="flex h-9 items-center gap-1.5 rounded-full px-3 fs-13 text-ink-3 hover:text-ink" aria-label={`Clear the ${label(thread)} thread`}>
            <Trash2 size={13} /> Clear
          </button>
        )}
      </div>
      {drawer &&
        createPortal(
          <div className="fixed inset-0 z-[75] flex justify-end bg-black/40" onClick={() => setDrawer(false)}>
            <aside className="h-full w-full max-w-2xl space-y-4 overflow-y-auto p-4" onClick={(e) => e.stopPropagation()} aria-label="Skills and MCP library">
              <div className="flex justify-end">
                <button onClick={() => setDrawer(false)} className="glass-thin grid size-9 place-items-center rounded-full text-ink-2 hover:text-ink" aria-label="Close library">
                  <X size={16} />
                </button>
              </div>
              <AgentLibrary />
            </aside>
          </div>,
          document.body,
        )}
    </>
  );
}

/** The conversation of the selected thread: transcript, status, mic and input. */
export function AgentChat() {
  const { thread, n, name, label } = useThreads();
  const state = useVoice((s) => s.state);
  const inbox = useAgentInbox((s) => s.messages);
  // The agent's reports show here too unless the Agent reports panel is on the page.
  const reportsPanel = useAgentsLayout((s) => panelShown(s, "ag-reports"));
  const hasReports = thread !== "auto" && !reportsPanel && inbox.some((m) => m.agent === thread);
  return (
    <div className="glass-chat flex h-full min-h-0 flex-col r-20">
      <div className="min-h-0 flex-1 overflow-y-auto p-5" data-no-hold>
        {hasReports && (
          <div className="mb-4">
            <AgentInbox agent={thread} compact />
          </div>
        )}
        {n[thread] === 0 && (
          <p className="max-w-prose text-sm leading-relaxed text-ink-3">
            {thread === "auto"
              ? `Speak or type — ${name} routes it. Say “ask my booking agent for the last 5 messages” and the exchange with the Booking agent shows up in its own tab.`
              : thread === "general"
                ? `Talk to ${name} directly: live dashboard context, its own tools (weather, files, git, web) and your identity file.`
                : `This thread is only you and the ${label(thread)} agent (its AnythingLLM workspace), plus anything ${name} asked it on your behalf.`}{" "}
            Anything that would change something — send, book, pay, delete — is read back on a confirmation card first.
          </p>
        )}
        <Transcript thread={thread} max={120} />
        {(state === "thinking" || state === "transcribing") && (
          <p className="mt-3 flex items-center gap-2 font-mono text-xs text-amber-soft">
            <Loader2 size={13} className="animate-spin" /> {state === "transcribing" ? "transcribing…" : "dispatching…"}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-white/5 p-3">
        <MicButton size={40} />
        <div className="flex-1">
          <CommandInput thread={thread} placeholder={thread === "auto" ? `Message ${name}…` : `Message ${label(thread)}…`} />
        </div>
      </div>
    </div>
  );
}

/** Reports from the selected agent (every agent's on Auto-route and the OS thread). */
export function AgentReports({ compact = false }: { compact?: boolean }) {
  const { thread } = useThreads();
  const agent = thread === "auto" || thread === "general" ? undefined : thread;
  // The inbox draws its own card ("Booking reports" / "Agent messages"); a long-press selects text.
  return (
    <div data-no-hold>
      <AgentInbox agent={agent} compact={compact} />
    </div>
  );
}

/** The Skills & MCP library (desktop). */
export function AgentLibrary() {
  return (
    <Suspense fallback={<p className="text-sm text-ink-3">Loading…</p>}>
      <div className="space-y-4">
        <McpRegistryCard />
        <SkillsLibraryCard />
      </div>
    </Suspense>
  );
}

export { AGENTS_SURFACE };
