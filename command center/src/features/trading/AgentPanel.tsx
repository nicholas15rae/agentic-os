import { useState } from "react";
import { Bot, ChevronDown, FlaskConical, Loader2, Play, Power } from "lucide-react";
import { Card } from "@/components/ui";
import { useToasts } from "@/features/reminders/notify";
import { usePoll } from "@/lib/use-poll";
import { tradingApi, type DeskView } from "@/features/trading/ibkr";
import { agentApi } from "@/features/trading/agent-api";
import {
  needsConfirm,
  type AgentPanelProps,
  type AgentPanelState,
  type AgentRun,
  type AgentRunStatus,
  type AgentView,
  type DecisionAction,
} from "@/features/trading/AgentPanel.contract";

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

/** The Trading Agent: on/off, schedule, last market view, runs with gate verdicts, score vs baselines. */
export function AgentPanel(_props: AgentPanelProps) {
  const { data, error, loading, refresh } = usePoll<AgentView>(agentApi.view, 15_000);
  const desk = usePoll<DeskView>(tradingApi.desk, 15_000);
  const toast = useToasts((s) => s.push);
  const [ui, setUi] = useState<Omit<AgentPanelState, "status">>({ busy: null, expandedRunId: null, confirm: null });
  const status: AgentPanelState["status"] = error && !data ? "error" : loading && !data ? "loading" : "ready";
  const mode = desk.data?.mode ?? null;

  const act = async (busy: NonNullable<AgentPanelState["busy"]>, fn: () => Promise<void>) => {
    setUi((u) => ({ ...u, busy, confirm: null }));
    try {
      await fn();
    } catch (e) {
      toast({ title: "Trading Agent", body: e instanceof Error ? e.message : String(e), tone: "error" });
    } finally {
      setUi((u) => ({ ...u, busy: null }));
      refresh();
    }
  };

  const doRun = (submit: boolean) =>
    act(submit ? "run" : "dry", async () => {
      const r = await agentApi.run(submit);
      setUi((u) => ({ ...u, expandedRunId: r.runId }));
      const proposals = r.results?.length ?? 0;
      toast({
        title: `Agent ${submit ? "run" : "dry run"}: ${STATUS_LABEL[r.status]}`,
        body: r.status === "done" || r.status === "dry_run" ? `${proposals} proposal(s)${r.modelS ? ` · ${r.modelS.toFixed(0)} s model time` : ""}` : r.detail,
        tone: r.status === "no_json" ? "warn" : "info",
      });
    });

  const doToggle = (enabled: boolean) =>
    act("toggle", async () => {
      await agentApi.enable(enabled);
    });

  const onRun = () => (needsConfirm("run", mode) ? setUi((u) => ({ ...u, confirm: "run" })) : void doRun(true));
  const onToggle = () => {
    if (!data) return;
    if (data.enabled) return void doToggle(false);
    return needsConfirm("enable", mode) ? setUi((u) => ({ ...u, confirm: "enable" })) : void doToggle(true);
  };

  const last = data?.runs.find((r) => r.output?.marketView);

  return (
    <Card
      title="Trading Agent · local model"
      action={
        <div className="flex items-center gap-1.5">
          <button className="pill-glass !h-8 text-[11px]" disabled={status !== "ready" || !!ui.busy} onClick={() => void doRun(false)} title="Think + evaluate in the gate, in memory. Sends nothing.">
            {ui.busy === "dry" ? <Loader2 size={12} className="animate-spin" /> : <FlaskConical size={12} />} Dry run
          </button>
          <button className="pill-glass !h-8 text-[11px]" disabled={status !== "ready" || !!ui.busy} onClick={onRun} title={mode === "ADVISORY" ? "Run now: proposals are logged as hypothetical trades (ADVISORY)" : "Run now: proposals go to the desk in its current mode"}>
            {ui.busy === "run" ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} Run now
          </button>
          <button
            className={`flex h-8 items-center gap-1.5 rounded-full border px-3 text-[11px] font-semibold ${data?.enabled ? "border-teal/50 bg-teal/15 text-teal-soft" : "border-white/15 bg-white/[0.04] text-ink-3"}`}
            disabled={status !== "ready" || !!ui.busy}
            aria-pressed={!!data?.enabled}
            onClick={onToggle}
          >
            {ui.busy === "toggle" ? <Loader2 size={12} className="animate-spin" /> : <Power size={12} />} {data?.enabled ? "ON" : "OFF"}
          </button>
        </div>
      }
    >
      {status === "loading" && <div className="h-5 w-2/3 animate-pulse rounded bg-white/[0.06]" aria-label="Loading agent" />}
      {status === "error" && <p className="text-[12px] text-alert">Agent unreachable — is the bridge running? ({error})</p>}

      {data && (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-3">
            <span className="flex items-center gap-1"><Bot size={12} /> qwen3.5-9b · ETFs only · long only</span>
            <span>next run: <span className="text-ink-2">{data.enabled ? data.nextSlot ?? "—" : "off"}</span></span>
            <span>events today: <span className="text-ink-2">{data.eventsToday}/{data.eventMax}</span></span>
            <span>desk mode: <span className="text-ink-2">{mode ?? "…"}</span></span>
          </div>
          {data.blocked && <p className="mt-1.5 text-[12px] text-amber-light">Blocked: {data.blocked}</p>}

          {ui.confirm && (
            <div className="mt-3 rounded-[14px] border border-amber/50 bg-amber/10 p-3 text-[12px]">
              <p className="text-ink">
                {ui.confirm === "run"
                  ? `The desk is in ${mode}: the agent's proposals will ${mode === "FULL_AUTO" ? "be SENT to the paper account" : "queue as trade cards for your approval"}. Run now?`
                  : "The desk is in FULL_AUTO: once on, the agent's approved proposals are sent to the paper account automatically. Turn it on?"}
              </p>
              <div className="mt-2 flex gap-2">
                <button className="pill-primary !h-8 text-[11px]" onClick={() => void (ui.confirm === "run" ? doRun(true) : doToggle(true))}>Confirm</button>
                <button className="pill-glass !h-8 text-[11px]" onClick={() => setUi((u) => ({ ...u, confirm: null }))}>Cancel</button>
              </div>
            </div>
          )}

          {last?.output?.marketView && (
            <div className="mt-3 rounded-[14px] border border-white/[0.06] bg-white/[0.02] p-3">
              <p className="label-caps text-ink-3">Market view · {time(last.started)}</p>
              <p className="mt-1 text-[12px] leading-relaxed text-ink-2">{last.output.marketView}</p>
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
                <p className="rounded-[12px] border border-dashed border-white/[0.08] px-3 py-4 text-center text-[12px] text-ink-3">No runs yet — try a Dry run.</p>
              )}
            </div>
            <div className="min-w-0">
              <p className="label-caps mb-1.5 text-ink-3">Track record · 5 sessions</p>
              <table className="w-full text-[12px]">
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
              <p className="mt-1.5 text-[11px] text-ink-3">Calls are scored once 5 sessions have passed. The agent should beat the SPY baseline before it graduates from ADVISORY.</p>
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
    <li className="rounded-[12px] border border-white/[0.06]">
      <button className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px]" onClick={onToggle} aria-expanded={open}>
        <span className="font-mono text-[11px] text-ink-3">{time(run.started)}</span>
        <span className="text-ink-3">{run.kind}</span>
        <span className={STATUS_TONE[run.status]}>{STATUS_LABEL[run.status]}</span>
        <span className="truncate text-ink-3">
          {run.status === "done" || run.status === "dry_run" ? `${props} proposal(s)` : run.detail}
        </span>
        <span className="ml-auto font-mono text-[10px] text-ink-3">
          {run.modelS != null ? `${run.modelS.toFixed(0)}s` : ""}
          {run.waitedS ? ` · waited ${run.waitedS.toFixed(0)}s` : ""}
        </span>
        <ChevronDown size={12} className={`text-ink-3 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="space-y-2 border-t border-white/[0.04] px-2.5 py-2 text-[12px]">
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
                  {d.thesis && <p className="text-[11px] text-ink-2">{d.thesis}</p>}
                  {res?.reasons.length ? <p className="text-[11px] text-alert">{res.reasons.join(" · ")}</p> : null}
                  {d.citations.length ? <p className="truncate font-mono text-[10px] text-ink-3" title={d.citations.join("\n")}>{d.citations.join("  ")}</p> : null}
                </div>
              );
            })
          ) : (
            <p className="text-ink-3">{run.detail || "No decisions."}</p>
          )}
          {run.output?.notes && <p className="text-[11px] text-ink-3">Notes: {run.output.notes}</p>}
          {run.context && (
            <p className="font-mono text-[10px] text-ink-3">
              context ~{run.context.approxTokens} tokens · {run.context.hypotheses} hypotheses{run.context.trimmedHypotheses ? ` (${run.context.trimmedHypotheses} trimmed)` : ""} · {run.context.lessons} lessons
            </p>
          )}
        </div>
      )}
    </li>
  );
}
