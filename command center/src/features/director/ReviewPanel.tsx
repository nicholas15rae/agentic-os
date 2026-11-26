import { useMemo, useState } from "react";
import { Check, Clapperboard, Loader2, MessageSquarePlus, TriangleAlert, X } from "lucide-react";
import { Card, Empty } from "@/components/ui";
import type { Note, ProjectReview } from "./contract";
import { addNote, approvePlan, canRender, discardRevision, requestPlan, resolveNote, seekTo, useDirector, type PendingRevision } from "./director-store";
import { timecode } from "./manifest";
import { previewSource } from "./PreviewPlayer";
import { latestRound, notePlacement, noteTarget, sortNotes } from "./review-ui";

export interface ReviewPanelViewProps {
  notes: Note[];
  review: ProjectReview | null;
  openDecisions: string[];
  revision: PendingRevision | null;
  /** Where "Add note" lands right now (null atSec = no time: nothing playable is selected). */
  placement: { renderId: string | null; atSec: number | null };
  renderName: (id: string) => string;
  hasPlan: boolean;
  renderReady: boolean;
  planBusy: boolean;
  onAdd: (text: string) => Promise<boolean>;
  onSeek: (note: Note) => void;
  onResolve: (noteId: string) => void;
  onApproveRevision: () => void;
  onShowPlan: () => void;
  onDiscardRevision: () => void;
}

const ROUND_TONE = { open: "border-amber/40 text-amber-soft", revised: "border-white/20 text-ink-2", approved: "border-teal/40 text-teal-soft" } as const;

/** Review: timestamped notes, the round (1 of 2) with the Director's summary, open decisions, and a waiting revision. Props only. */
export function ReviewPanelView(p: ReviewPanelViewProps) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const notes = useMemo(() => sortNotes(p.notes), [p.notes]);
  const round = latestRound(p.review);
  const open = p.notes.filter((n) => !n.resolved).length;
  const where = p.placement.atSec == null ? "" : ` at ${timecode(p.placement.atSec)}`;

  const add = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      if (await p.onAdd(text)) setText("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Review"
      action={
        round ? (
          <span className={`rounded-full border px-2 text-[11px] ${ROUND_TONE[round.status]}`} title="Two review rounds: your notes get one revision, then the Director lists what's still open">
            Round {round.round} of 2 · {round.status}
          </span>
        ) : (
          <span className="text-[11px] text-ink-3">No verified render yet</span>
        )
      }
    >
      {(p.review?.rounds ?? []).filter((r) => r.summary.trim()).length > 0 && (
        <div className="mb-3 space-y-1.5">
          {(p.review?.rounds ?? [])
            .filter((r) => r.summary.trim())
            .map((r) => (
              <div key={r.round} className="rounded-[12px] border border-white/[0.08] bg-white/[0.02] p-2">
                <p className="label-caps text-ink-3">Director · round {r.round}</p>
                <p className="mt-0.5 whitespace-pre-wrap text-[12px] leading-snug text-ink-2">{r.summary}</p>
              </div>
            ))}
        </div>
      )}

      {p.revision && (
        <div className="mb-3 rounded-[12px] border border-amber/50 bg-amber/10 p-2.5" role="group" aria-label="Waiting revision">
          <p className="text-[12px] text-ink">
            Round {p.revision.round} revision ready. It answers {p.revision.resolves.length} note{p.revision.resolves.length === 1 ? "" : "s"}; they resolve when you approve its render.
          </p>
          {p.revision.summary && <p className="mt-1 text-[12px] text-ink-2">{p.revision.summary}</p>}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {p.hasPlan ? (
              <button onClick={p.onApproveRevision} disabled={p.planBusy || !p.renderReady} className="pill-primary !h-8 !px-3 text-xs disabled:opacity-50" title={p.renderReady ? "Approve the plan and render it on the CPU" : "Rendering needs media-forge ready and ffmpeg found"}>
                {p.planBusy ? <Loader2 size={12} className="animate-spin" /> : <Clapperboard size={12} />} Approve plan
              </button>
            ) : (
              <button onClick={p.onShowPlan} disabled={p.planBusy} className="pill-primary !h-8 !px-3 text-xs disabled:opacity-50">
                {p.planBusy ? <Loader2 size={12} className="animate-spin" /> : <Clapperboard size={12} />} Show render plan
              </button>
            )}
            <button onClick={p.onDiscardRevision} className="pill-glass !h-8 !px-3 text-xs" title="Don't render it: the notes stay open">
              <X size={12} /> Discard
            </button>
          </div>
        </div>
      )}

      <form
        className="flex items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <input value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} placeholder={p.placement.renderId ? `Note on ${p.renderName(p.placement.renderId)}${where}` : `Note on the timeline${where}`} className="field !h-9 !py-0 text-[12px]" aria-label="New review note" />
        <button type="submit" disabled={!text.trim() || busy} className="pill-glass !h-9 shrink-0 !px-3 text-xs disabled:opacity-50" title={`Add the note${where || " (no time: nothing is playing)"}`}>
          {busy ? <Loader2 size={12} className="animate-spin" /> : <MessageSquarePlus size={12} />} Add note{where}
        </button>
      </form>

      {notes.length ? (
        <ul className="mt-2 space-y-1">
          {notes.map((n) => (
            <li key={n.id} className={`flex items-start gap-2 rounded-[10px] px-1.5 py-1 ${n.resolved ? "opacity-55" : "hover:bg-white/[0.03]"}`}>
              <button onClick={() => p.onSeek(n)} disabled={n.atSec == null} className="w-[62px] shrink-0 text-left font-mono text-[11px] text-teal-soft hover:underline disabled:text-ink-3 disabled:no-underline" title={n.atSec == null ? "No time on this note" : "Play from here"}>
                {n.atSec == null ? "—" : timecode(n.atSec)}
              </button>
              <div className="min-w-0 flex-1">
                <p className={`text-[12px] leading-snug ${n.resolved ? "text-ink-3 line-through" : "text-ink"}`}>{n.text}</p>
                <p className="text-[10px] text-ink-3">{n.renderId ? p.renderName(n.renderId) : "timeline"}</p>
              </div>
              {!n.resolved && (
                <button onClick={() => p.onResolve(n.id)} className="grid size-6 shrink-0 place-items-center rounded-full border border-white/10 text-ink-2 hover:text-teal" title="Resolve" aria-label={`Resolve note: ${n.text.slice(0, 40)}`}>
                  <Check size={11} />
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <Empty>No notes yet. Pause on a moment and add one.</Empty>
      )}
      {notes.length > 0 && <p className="mt-1 text-[11px] text-ink-3">{open} open</p>}

      {p.openDecisions.length > 0 && (
        <div className="mt-3 rounded-[12px] border border-white/[0.1] bg-white/[0.02] p-2.5">
          <p className="label-caps flex items-center gap-1 text-amber-soft">
            <TriangleAlert size={11} /> Open decisions{round && round.round >= 2 ? " after round 2" : ""}
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[12px] text-ink-2">
            {p.openDecisions.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

const base = (p: string) => p.split(/[\\/]/).pop() ?? p;
const NO_NOTES: Note[] = [];

export function ReviewPanel() {
  const manifest = useDirector((s) => s.manifest);
  const review = useDirector((s) => s.review);
  const openDecisions = useDirector((s) => s.openDecisions);
  const revision = useDirector((s) => s.revision);
  const renders = useDirector((s) => s.renders);
  const plan = useDirector((s) => s.plan);
  const planBusy = useDirector((s) => s.planBusy);
  const readiness = useDirector((s) => s.readiness);
  const selection = useDirector((s) => s.selection);
  const previewMode = useDirector((s) => s.previewMode);
  const assets = useDirector((s) => s.assets);
  const previewTime = useDirector((s) => s.previewTime);
  const playhead = useDirector((s) => s.playhead);
  if (!manifest) return null;
  const src = previewSource({ selection, previewMode, assets, manifest, renders });
  const placement = notePlacement(src, previewTime, playhead);
  return (
    <ReviewPanelView
      notes={manifest.notes ?? NO_NOTES}
      review={review}
      openDecisions={openDecisions}
      revision={revision}
      placement={placement}
      renderName={(id) => {
        const r = renders.find((x) => x.id === id);
        return r ? base(r.path) : id;
      }}
      hasPlan={!!plan}
      renderReady={canRender(readiness)}
      planBusy={planBusy}
      onAdd={async (text) => !!(await addNote(text, placement))}
      onSeek={(n) => {
        const t = noteTarget(n, useDirector.getState().manifest);
        if (t) seekTo(t.sel, t.sec);
      }}
      onResolve={(id) => void resolveNote(id)}
      onApproveRevision={() => void approvePlan()}
      onShowPlan={() => void requestPlan("director")}
      onDiscardRevision={discardRevision}
    />
  );
}
