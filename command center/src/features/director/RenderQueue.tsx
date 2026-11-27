import { useState } from "react";
import { Cpu, Image as ImageIcon, Loader2, Play, Sparkles, X } from "lucide-react";
import { Card, Select } from "@/components/ui";
import { useToasts } from "@/features/reminders/notify";
import { api } from "./api";
import type { ComfyPolicy } from "./contract";
import { cancelJob, runNow, setPolicy, useComfy } from "./comfy-store";
import { POLICY_LABEL, capFinished, queueRows, runNowBlocker, type QueueDisplayInfo, type QueueRow } from "./comfy-ui";
import { select, useDirector } from "./director-store";

export type { QueueRow } from "./comfy-ui";

export interface RenderQueueProps {
  rows: QueueRow[]; // the media-render job for this slug first, then this slug's comfy jobs, newest first
  policy: ComfyPolicy | null;
  runNowBlocked: string | null; // null, or why (no queued jobs: "Nothing queued"; status unavailable)
  admission: string | null; // Rust's admission line, shown small under the header when it isn't "running"
  busy: { runNow: boolean; policy: boolean; cancel: string | null };
  onCancel: (row: QueueRow) => void; // export → api.renderCancel; comfy → cancelJob
  onRunNow: () => void;
  onPolicy: (p: ComfyPolicy) => void;
  onShowOutput: (assetId: string) => void; // select({kind:"asset"}) in the bin
}

const TONE: Record<QueueDisplayInfo["tone"], string> = {
  teal: "border-teal/40 text-teal-soft",
  amber: "border-amber/40 text-amber-soft",
  violet: "border-violet/40 text-violet",
  alert: "border-alert/50 text-alert",
  muted: "border-white/10 text-ink-3",
};

const POLICIES: ComfyPolicy[] = ["idle", "overnight", "manual"];

/** Centre column, under GeneratePanel: the CPU export and this project's ComfyUI jobs. Null when empty. */
export function RenderQueueView(p: RenderQueueProps) {
  const [showAll, setShowAll] = useState(false);
  if (!p.rows.length) return null;
  const capped = capFinished(p.rows);
  const rows = showAll ? p.rows : capped.rows;
  return (
    <Card
      title="Queue"
      action={
        <>
          {p.policy && (
            <Select value={p.policy} disabled={p.busy.policy} onChange={(e) => p.onPolicy(e.target.value as ComfyPolicy)} className="!h-8 !w-auto !py-0 fs-12 disabled:opacity-50" aria-label="When ComfyUI runs" title="Applies to every project">
              {POLICIES.map((x) => (
                <option key={x} value={x}>
                  {POLICY_LABEL[x]}
                </option>
              ))}
            </Select>
          )}
          <button type="button" onClick={p.onRunNow} disabled={!!p.runNowBlocked || p.busy.runNow} className="pill-glass !h-8 !px-3 text-xs disabled:opacity-50" title={p.runNowBlocked ?? "Start the ComfyUI batch now"}>
            {p.busy.runNow ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} Run now
          </button>
        </>
      }
    >
      {p.admission && p.admission !== "running" && <p className="mb-2 fs-11 text-ink-3">ComfyUI: {p.admission}</p>}
      <ul className="space-y-1.5">
        {rows.map((r) => (
          <li key={`${r.kind}-${r.id}`} className="well r-12 px-2.5 py-2" aria-label={`Queue item ${r.title}`}>
            <div className="flex items-center gap-2">
              {r.kind === "export" ? <Cpu size={12} className="shrink-0 text-ink-3" /> : <Sparkles size={12} className="shrink-0 text-violet" />}
              <span className="min-w-0 flex-1 truncate fs-12 text-ink" title={r.title}>
                {r.title}
              </span>
              <span className={`shrink-0 rounded-full border px-1.5 fs-10 ${TONE[r.display.tone]}`}>{r.display.label}</span>
              {r.canCancel && (
                <button
                  type="button"
                  onClick={() => p.onCancel(r)}
                  disabled={p.busy.cancel === r.id}
                  className="grid size-6 shrink-0 place-items-center rounded-full border border-white/10 text-ink-2 hover:text-ink disabled:opacity-40"
                  title="Cancel"
                  aria-label={`Cancel ${r.title}`}
                >
                  {p.busy.cancel === r.id ? <Loader2 size={10} className="animate-spin" /> : <X size={10} />}
                </button>
              )}
            </div>
            {r.display.detail && <p className="mt-0.5 fs-11 text-ink-3">{r.display.detail}</p>}
            {r.kind === "export" && r.pct != null && (
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/10" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(r.pct)} aria-label="Export progress">
                <div className="h-full bg-amber" style={{ width: `${Math.max(0, Math.min(100, r.pct))}%` }} />
              </div>
            )}
            {r.kind === "comfy" && r.outputAssetIds.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {r.outputAssetIds.map((id, i) => (
                  <button key={id} type="button" onClick={() => p.onShowOutput(id)} className="flex items-center gap-1 fs-11 text-teal-soft hover:underline">
                    <ImageIcon size={10} /> Show output{r.outputAssetIds.length > 1 ? ` ${i + 1}` : ""}
                  </button>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
      {capped.hidden > 0 && (
        <button type="button" onClick={() => setShowAll((v) => !v)} className="mt-2 fs-11 text-teal-soft hover:underline">
          {showAll ? "Show fewer" : `Show all (${capped.hidden} more)`}
        </button>
      )}
    </Card>
  );
}

export function RenderQueue() {
  const slug = useDirector((s) => s.slug);
  const job = useDirector((s) => s.job);
  const jobs = useComfy((s) => s.jobs);
  const status = useComfy((s) => s.status);
  const statusError = useComfy((s) => s.statusError);
  const busy = useComfy((s) => s.busy);
  const live = statusError ? null : status;
  const rows = queueRows(slug, job, jobs, live);
  if (!rows.length) return null;
  return (
    <RenderQueueView
      rows={rows}
      policy={live?.settings.policy ?? null}
      runNowBlocked={runNowBlocker(live)}
      admission={live?.admission ?? null}
      busy={{ runNow: busy.runNow, policy: busy.policy, cancel: busy.cancel }}
      onCancel={(r) => {
        if (r.kind === "comfy") void cancelJob(r.id);
        else
          void api.renderCancel({ jobId: r.id }).catch((e: unknown) => useToasts.getState().push({ title: "Couldn't cancel the export", body: e instanceof Error ? e.message : String(e), tone: "error" }));
      }}
      onRunNow={() => void runNow()}
      onPolicy={(x) => void setPolicy(x)}
      onShowOutput={(id) => select({ kind: "asset", id })}
    />
  );
}
