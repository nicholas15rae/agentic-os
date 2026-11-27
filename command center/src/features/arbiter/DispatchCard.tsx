import { useState } from "react";
import { Send, X } from "lucide-react";
import { useVoice } from "@/features/voice/voice-store";
import { acmd, type DispatchView, type PacketResult } from "./api";

const STATE_TEXT: Record<DispatchView["state"], string> = {
  held: "held",
  pending: "needs your yes",
  queued: "queued",
  invalid: "not dispatched (malformed packet)",
};

const TONE: Record<string, string> = {
  queued: "text-teal",
  done: "text-teal",
  pending: "text-amber-light",
  held: "text-ink-3",
  refused: "text-alert",
  failed: "text-alert",
  halted: "text-alert",
  blocked: "text-ink-3",
};

/**
 * Tony's dispatch packet under his reply: every task (agent → action, its status), and in Ask
 * mode one Dispatch / Hold choice. Never claims a task is finished: only queued / held.
 */
export function DispatchCard({ turnId, view }: { turnId: string; view: DispatchView }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const update = (v: DispatchView) => useVoice.getState().updateTurn(turnId, { dispatch: v });
  const approve = async () => {
    setBusy(true);
    setErr(null);
    try {
      update(await acmd("tony_dispatch_approve", { id: view.id }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const hold = async () => {
    setBusy(true);
    await acmd("tony_dispatch_discard", { id: view.id }).catch(() => false);
    update({ ...view, state: "held", reason: "You held it", tasks: view.tasks.map((t) => ({ ...t, status: "held" })) });
    setBusy(false);
  };
  return (
    <div className="mt-1 w-full r-10 border border-white/10 bg-white/[0.02] p-2 fs-11" aria-label="Dispatch packet">
      <div className="mb-1 flex items-center gap-2">
        <span className="label-caps text-ink-3">Dispatch</span>
        <span className={view.state === "queued" ? "text-teal" : view.state === "pending" ? "text-amber-light" : "text-ink-3"}>{STATE_TEXT[view.state]}</span>
        {view.priority !== "normal" && <span className={`label-caps rounded-full border px-1.5 ${view.priority === "urgent" ? "border-alert/50 text-alert" : "border-white/10 text-ink-3"}`}>{view.priority}</span>}
        <span className="ml-auto truncate text-ink-3" title={view.reason}>{view.reason}</span>
      </div>
      {view.tasks.length > 0 && (
        <ol className="space-y-0.5">
          {view.tasks.map((t) => (
            <li key={t.taskId} className="flex gap-2" title={`Acceptance: ${t.acceptance.join("; ")}${t.dependsOn.length ? `\nAfter: ${t.dependsOn.join(", ")}` : ""}${t.detail ? `\n${t.detail}` : ""}`}>
              <span className="w-16 shrink-0 font-mono uppercase text-ink-2">{t.targetAgent}</span>
              <span className="min-w-0 flex-1 truncate text-ink">{t.action}</span>
              <span className={`shrink-0 ${TONE[t.status] ?? "text-ink-3"}`}>{t.status}</span>
            </li>
          ))}
        </ol>
      )}
      {view.state === "pending" && (
        <div className="mt-1.5 flex gap-2">
          <button type="button" disabled={busy} onClick={() => void approve()} className="pill-primary !h-7 !px-3 fs-11">
            <Send size={11} aria-hidden /> Dispatch
          </button>
          <button type="button" disabled={busy} onClick={() => void hold()} className="pill-glass !h-7 !px-3 fs-11">
            <X size={11} aria-hidden /> Hold
          </button>
        </div>
      )}
      {err && <p className="mt-1 text-alert">{err}</p>}
    </div>
  );
}

/** A closed packet: per task its status, attempts and (collapsed) output. */
export function PacketOutcome({ result }: { result: PacketResult }) {
  return (
    <div className="mt-1 w-full space-y-1 fs-11">
      {result.results.map((r) => (
        <details key={r.taskId} className="r-8 border border-white/10 px-2 py-1">
          <summary className="flex cursor-pointer gap-2">
            <span className="w-16 shrink-0 font-mono uppercase text-ink-2">{r.targetAgent}</span>
            <span className="min-w-0 flex-1 truncate text-ink">{r.taskId}</span>
            <span className={TONE[r.status] ?? "text-ink-3"}>
              {r.status}
              {r.attempts > 1 ? ` · ${r.attempts} tries` : ""}
              {r.preempted ? ` · paused ${r.preempted}×` : ""}
            </span>
          </summary>
          {r.error && <p className="mt-1 text-alert">{r.error}</p>}
          {r.output && <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words text-ink-2">{r.output}</pre>}
        </details>
      ))}
    </div>
  );
}
