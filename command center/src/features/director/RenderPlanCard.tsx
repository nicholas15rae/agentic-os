import { Clapperboard, Cpu, Loader2, PencilLine } from "lucide-react";
import type { RenderPlan } from "./contract";
import { approvePlan, canRender, modifyPlan, useDirector } from "./director-store";
import { timecode } from "./manifest";

/** The Render Plan card: the ONLY place a render starts (Approve & Render → approved: true). Props only. */
export function RenderPlanView({ plan, busy, renderReady, onApprove, onModify }: { plan: RenderPlan; busy: boolean; renderReady: boolean; onApprove: () => void; onModify: () => void }) {
  return (
    <section className="glass rounded-[20px] border-amber/50 p-4 ring-1 ring-amber/40" aria-label="Render plan">
      <div className="mb-2 flex items-center gap-2">
        <Clapperboard size={15} className="text-amber-soft" />
        <h2 className="label-caps text-amber-soft">Render plan</h2>
        <span className="ml-auto font-mono text-[10px] text-ink-3">
          {plan.planId} · rev {plan.manifestRevision} · by {plan.proposedBy}
        </span>
      </div>
      <p className="label-caps mt-2 text-ink-3">Sources</p>
      <ol className="mt-1 space-y-0.5 text-[12px] text-ink-2">
        {plan.sources.map((s, i) => (
          <li key={`${s.assetId}-${i}`} className="flex gap-2">
            <span className="w-4 shrink-0 font-mono text-ink-3">{i + 1}</span>
            <span className="min-w-0 flex-1 truncate">{s.name}</span>
            <span className="shrink-0 font-mono text-[11px] text-ink-3">
              {timecode(s.inSec)}–{timecode(s.outSec)}
            </span>
          </li>
        ))}
      </ol>
      {plan.audio.length > 0 && (
        <>
          <p className="label-caps mt-2 text-ink-3">Audio layers</p>
          <ul className="mt-1 space-y-0.5 text-[12px] text-ink-2">
            {plan.audio.map((a, i) => (
              <li key={`${a.assetId}-${i}`} className="flex gap-2">
                <span className="min-w-0 flex-1 truncate">{a.name}</span>
                <span className="shrink-0 font-mono text-[11px] text-ink-3">
                  @{timecode(a.startSec)} · vol {a.volume.toFixed(2)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="label-caps mt-2 text-ink-3">Output</p>
      <p className="mt-1 font-mono text-[12px] text-ink">{plan.outputName}</p>
      <p className="font-mono text-[11px] text-ink-2">{plan.outputSpec}</p>
      <p className="mt-2 flex items-center gap-1.5 font-mono text-[11px] text-teal-soft">
        <Cpu size={11} /> render_mode: {plan.renderMode}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button onClick={onApprove} disabled={busy || !renderReady} className="pill-primary !h-9 text-xs disabled:opacity-50" title={renderReady ? "Render this plan on the CPU" : "Rendering needs media-forge ready and ffmpeg found"}>
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Clapperboard size={13} />} Approve &amp; Render
        </button>
        <button onClick={onModify} className="pill-glass !h-9 text-xs">
          <PencilLine size={13} /> Modify Plan
        </button>
      </div>
      {!renderReady && <p className="mt-2 text-[11px] text-amber-soft">Rendering is off until media-forge is green.</p>}
    </section>
  );
}

export function RenderPlanCard() {
  const plan = useDirector((s) => s.plan);
  const busy = useDirector((s) => s.planBusy);
  const readiness = useDirector((s) => s.readiness);
  if (!plan) return null;
  return <RenderPlanView plan={plan} busy={busy} renderReady={canRender(readiness)} onApprove={() => void approvePlan()} onModify={() => modifyPlan("timeline")} />;
}
