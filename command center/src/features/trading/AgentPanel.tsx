import { useState } from "react";
import { Bot, ChevronDown } from "lucide-react";
import { Card } from "@/components/ui";
import { usePoll } from "@/lib/use-poll";
import { agentApi } from "@/features/trading/agent-api";
import type { AgentPanelProps, AgentPanelState, AgentRun, AgentRunStatus, AgentView, DecisionAction } from "@/features/trading/AgentPanel.contract";

const STATUS_TONE: Record<AgentRunStatus, string> = {
  running: "text-amber-light",
  done: "text-teal-soft",
  dry_run: "text-ink-2",
  blocked: "text-amber-light",
  skipped: "text-ink-3",
  no_json: "text-alert",
};
const STATUS_LABEL: Record<AgentRunStatus, string> = {
  running: "running",
  done: "done",
  dry_run: "dry run",
  blocked: "blocked",
  skipped: "skipped",
  no_json: "no answer",
};
const ACTION_TONE: Record<DecisionAction, string> = {
  propose: "text-teal-soft",
  watch: "text-amber-light",
  skip: "text-ink-3",
  rejected_scope: "text-alert",
  rejected_citations: "text-alert",
  rejected_schema: "text-alert",
  rejected_cap: "text-alert",
};
const VERDICT_TONE: Record<"APPROVED" | "MODIFIED" | "REJECTED", string> = {
  APPROVED: "text-teal-soft",
  MODIFIED: "text-amber-light",
  REJECTED: "text-alert",
};
const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
const time = (s: number) => new Date(s * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const RETIRED_FALLBACK = "retired as a trader: Engine R (deterministic rules) executes; the model only reviews after the close";

/** The retired Trading Agent: read-only history (runs, last market view, track record). Engine R trades now. */
export function AgentPanel(_props: AgentPanelProps) {
  const { data, error, loading } = usePoll<AgentView>(agentApi.view, 30_000);
  const [ui, setUi] = useState<Omit<AgentPanelState, "status">>({ expandedRunId: null });
  const status: AgentPanelState["status"] = error && !data ? "error" : loading && !data ? "loading" : "ready";
  const last = data?.runs.find((r) => r.output?.marketView);

  return (
    <Card title="Trading Agent · local model · retired" action={<span className="rounded-full border border-white/15 px-2 py-0.5 fs-11 text-ink-3">history only</span>}>
      {status === "loading" && <div className="h-5 w-2/3 animate-pulse rounded bg-white/[0.06]" aria-label="Loading agent" />}
      {status === "error" && <p className="fs-12 text-alert">Agent history unreachable: is the bridge running? ({error})</p>}

      {data && (
        <>
          <p className="flex items-start gap-1.5 fs-12 text-ink-2">
            <Bot size={13} className="mt-0.5 shrink-0 text-ink-3" />
            <span>
              The model is {data.retired ?? RETIRED_FALLBACK}. It no longer runs or proposes trades; its pending rule-change suggestions are in the Engine R panel.
            </span>
          </p>

          {last?.output?.marketView && (
            <div className="mt-3 r-14 border border-white/[0.06] bg-white/[0.02] p-3">
              <p className="label-caps text-ink-3">Market view · {time(last.started)}</p>
              <p className="mt-1 fs-12 leading-relaxed text-ink-2">{last.output.marketView}</p>
            </div>
          )}

          <div className="mt-4 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
            <div className="min-w-0">
              <p className="label-caps mb-1.5 text-ink-3">Recent runs</p>
              {data.runs.length ? (
                <ul className="space-y-1.5">
                  {data.runs.map((r) => (
                    <RunRow key={r.runId} run={r} open={ui.expandedRunId === r.runId} onToggle={() => setUi((u) => ({ ...u, expandedRunId: u.expandedRunId === r.runId ? null : r.runId }))} />
                  ))}
                </ul>
              ) : (
                <p className="r-12 border border-dashed border-white/[0.08] px-3 py-4 text-center fs-12 text-ink-3">No runs recorded.</p>
              )}
            </div>
            <div className="min-w-0">
              <p className="label-caps mb-1.5 text-ink-3">Track record · 5 sessions</p>
              <table className="w-full fs-12">
                <thead>
                  <tr className="text-left text-ink-3">
                    {["", "Calls", "Hit", "Adj.", "Avg"].map((h) => <th key={h} className="px-1.5 py-1 font-medium">{h}</th>)}
                  </tr>
                </thead>
                <tbody className="font-mono tabular">
                  {(["trading_agent", "engine_a", "baseline_spy"] as const).map((id) => {
                    const r = data.leaderboard.find((x) => x.id === id);
                    const label = id === "trading_agent" ? "Agent" : id === "engine_a" ? "Engine A" : "SPY baseline";
                    return (
                      <tr key={id} className="border-t border-white/[0.04]">
                        <td className="px-1.5 py-1 font-sans text-ink-2">{label}</td>
                        <td className="px-1.5 py-1">{r?.calls ?? data.callCounts[id] ?? 0}</td>
                        <td className="px-1.5 py-1">{r ? pct(r.hitRate) : "—"}</td>
                        <td className="px-1.5 py-1">{r ? pct(r.shrunkHitRate) : "—"}</td>
                        <td className={`px-1.5 py-1 ${r ? (r.avgRet >= 0 ? "text-teal-soft" : "text-alert") : ""}`}>{r ? `${r.avgRet.toFixed(2)}%` : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="mt-1.5 fs-11 text-ink-3">Scored calls from before the agent was retired (5-session horizon), next to Engine A and the SPY baseline.</p>
            </div>
          </div>
        </>
      )}
    </Card>
  );
}

function RunRow({ run, open, onToggle }: { run: AgentRun; open: boolean; onToggle: () => void }) {
  const props = run.results?.length ?? 0;
  return (
    <li className="r-12 border border-white/[0.06]">
      <button className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left fs-12" onClick={onToggle} aria-expanded={open}>
        <span className="font-mono fs-11 text-ink-3">{time(run.started)}</span>
        <span className="text-ink-3">{run.kind}</span>
        <span className={STATUS_TONE[run.status]}>{STATUS_LABEL[run.status]}</span>
        <span className="truncate text-ink-3">
          {run.status === "done" || run.status === "dry_run" ? `${props} proposal(s)` : run.detail}
        </span>
        <span className="ml-auto font-mono fs-10 text-ink-3">
          {run.modelS != null ? `${run.modelS.toFixed(0)}s` : ""}
          {run.waitedS ? ` · waited ${run.waitedS.toFixed(0)}s` : ""}
        </span>
        <ChevronDown size={12} className={`text-ink-3 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="space-y-2 border-t border-white/[0.04] px-2.5 py-2 fs-12">
          {run.decisions?.length ? (
            run.decisions.map((d) => {
              const res = run.results?.find((x) => x.symbol === d.symbol);
              return (
                <div key={d.symbol + d.action}>
                  <p>
                    <span className="font-mono">{d.symbol}</span> <span className={ACTION_TONE[d.action]}>{d.action.replace("_", " ")}</span>
                    {d.confidence != null && <span className="text-ink-3"> · conf {d.confidence.toFixed(2)}</span>}
                    {res?.verdict && <span className={VERDICT_TONE[res.verdict]}> · gate {res.verdict}{res.quantity != null ? ` ×${res.quantity}` : ""}</span>}
                    {res && !res.verdict && <span className="text-ink-3"> · {res.status}</span>}
                  </p>
                  {d.thesis && <p className="fs-11 text-ink-2">{d.thesis}</p>}
                  {res?.reasons.length ? <p className="fs-11 text-alert">{res.reasons.join(" · ")}</p> : null}
                  {d.citations.length ? <p className="truncate font-mono fs-10 text-ink-3" title={d.citations.join("\n")}>{d.citations.join("  ")}</p> : null}
                </div>
              );
            })
          ) : (
            <p className="text-ink-3">{run.detail || "No decisions."}</p>
          )}
          {run.output?.notes && <p className="fs-11 text-ink-3">Notes: {run.output.notes}</p>}
          {run.context && (
            <p className="font-mono fs-10 text-ink-3">
              context ~{run.context.approxTokens} tokens · {run.context.hypotheses} hypotheses{run.context.trimmedHypotheses ? ` (${run.context.trimmedHypotheses} trimmed)` : ""} · {run.context.lessons} lessons
            </p>
          )}
        </div>
      )}
    </li>
  );
}
