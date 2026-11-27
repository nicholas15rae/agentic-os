import { useState } from "react";
import { AlertTriangle, CheckCheck, Loader2, Play, Zap } from "lucide-react";
import { Card, Empty } from "@/components/ui";
import { roleLabel } from "@/features/dispatcher/roles";
import { agentName, inboxLine } from "@/features/voice/agent-reports";
import { replayReport } from "@/features/voice/voice-controller";
import { unreadCount, useAgentInbox } from "./agent-inbox";

const time = (ms: number) => {
  const d = new Date(ms);
  const t = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? t : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${t}`;
};

/**
 * Comms → Agents: every agent report, newest first — who sent it, when, the text and a replay
 * button. Unread until opened (clicked) or heard in full. Desktop: the reports are made here.
 */
export function AgentInbox({ agent, compact = false }: { agent?: string; compact?: boolean } = {}) {
  const all = useAgentInbox((s) => s.messages);
  const messages = agent ? all.filter((m) => m.agent === agent) : all;
  const read = useAgentInbox((s) => s.read);
  const clearRead = useAgentInbox((s) => s.clearRead);
  const [playing, setPlaying] = useState<string | null>(null);
  const unread = unreadCount(messages);

  const replay = async (id: string) => {
    setPlaying(id);
    try {
      await replayReport(id);
    } finally {
      setPlaying((p) => (p === id ? null : p));
    }
  };

  return (
    <Card
      title={agent ? `${roleLabel(agent)} reports` : "Agent messages"}
      hint={compact ? undefined : unread ? inboxLine(messages) : "Reports from your agents when a background job finishes. Ask Tony for your agent reports and he tells you what's waiting."}
      action={
        <div className="flex items-center gap-3">
          {unread > 0 && (
            <button onClick={() => read(agent ? { agent } : {})} className="inline-flex items-center gap-1 text-xs text-ink-3 hover:text-ink" title="Mark every message read">
              <CheckCheck size={13} /> Mark all read
            </button>
          )}
          {messages.some((m) => m.read) && (
            <button onClick={clearRead} className="text-xs text-ink-3 hover:text-ink" title="Remove the messages you've already read">
              Clear read
            </button>
          )}
        </div>
      }
    >
      {!messages.length && <Empty>No agent messages yet.</Empty>}
      <ul className={`${compact ? "max-h-[30vh]" : "max-h-[65vh]"} space-y-1.5 overflow-y-auto`}>
        {messages.map((m) => (
          <li key={m.id}>
            <div
              role="button"
              tabIndex={0}
              aria-label={`${m.read ? "" : "Unread: "}message from ${agentName(m.agent)}`}
              onClick={() => !m.read && read({ ids: [m.id] })}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && !m.read && read({ ids: [m.id] })}
              className={`flex items-start gap-3 rounded-[12px] border px-3 py-2.5 transition-colors ${m.read ? "border-white/[0.06]" : m.urgent ? "border-alert/50 bg-alert/[0.07]" : "border-amber/30 bg-amber/[0.06]"}`}
            >
              <span className={`mt-1.5 size-2 shrink-0 rounded-full ${m.read ? "bg-transparent" : m.urgent ? "bg-alert" : "bg-amber"}`} aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className={`text-sm ${m.read ? "text-ink" : "font-semibold text-ink"}`}>{roleLabel(m.agent)}</span>
                  {m.urgent && (
                    <span className="label-caps inline-flex items-center gap-1 text-alert">
                      <AlertTriangle size={10} aria-hidden /> Urgent
                    </span>
                  )}
                  {m.interrupted && (
                    <span className="label-caps inline-flex items-center gap-1 text-ink-3" title="It cut in while Tony was talking">
                      <Zap size={10} aria-hidden /> Interrupted
                    </span>
                  )}
                  <span className="ml-auto shrink-0 font-mono text-[10px] text-ink-3">{time(m.at)}</span>
                </div>
                <p className="mt-0.5 text-sm leading-relaxed text-ink-2">{m.text}</p>
                {m.spokenAt && m.voice && <p className="mt-0.5 text-[10px] text-ink-3">Heard {time(m.spokenAt)} in {m.voice === "general" ? "Tony's" : `${roleLabel(m.voice)}'s`} voice</p>}
              </div>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  void replay(m.id);
                }}
                disabled={playing === m.id}
                className="pill-glass !h-8 !px-2.5 shrink-0 text-xs"
                aria-label={`Play the message from ${agentName(m.agent)}`}
                title="Play it again"
              >
                {playing === m.id ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
