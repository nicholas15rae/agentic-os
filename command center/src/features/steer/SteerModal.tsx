import { useEffect, useMemo, useState } from "react";
import { AppWindow, Hammer, LayoutGrid, Smile, Sparkles, X } from "lucide-react";
import { requestBuild } from "@/features/voice/voice-controller";
import { useModes } from "@/features/modes/modes-store";
import { stageBlocker } from "@/features/buildhub/gate";
import { KINDS, KIND_BLURB, KIND_LABEL, classifyIdea, pitchesFor, questionsFor, steerBrief, tagsFromAnswers, titleFor, type BuildKind, type SteerAnswers } from "./steer";
import { tasteLine, topTraits, useTaste } from "./taste-store";

const KIND_ICON: Record<BuildKind, typeof Smile> = { novelty: Smile, functional: LayoutGrid, standalone: AppWindow };

/**
 * UI fixes 4: Play Place steers back. Describe the feeling; it says which kind of build it thinks
 * this is (live character, widget, or its own app) and why, pitches a better fit when there is
 * one, asks a few sharp questions, and shows the brief. Build raises the usual confirmation card;
 * nothing is built before its yes.
 */
export function SteerModal({ initial = "", onClose }: { initial?: string; onClose: () => void }) {
  const [idea, setIdea] = useState(initial);
  const [picked, setPicked] = useState<BuildKind | null>(null);
  const [answers, setAnswers] = useState<SteerAnswers>({});
  const [error, setError] = useState<string | null>(null);
  const traits = useTaste((s) => s.traits);
  const taste = tasteLine(traits);
  const c = useMemo(() => classifyIdea(idea), [idea]);
  const kind = picked ?? c.kind;
  const qs = useMemo(() => questionsFor(kind, idea), [kind, idea]);
  const pitches = useMemo(() => (idea.trim() ? pitchesFor(idea, c, taste) : []), [idea, c, taste]);
  const brief = steerBrief(idea, kind, qs, answers, taste);
  const ready = idea.trim().length >= 3;
  const blocker = stageBlocker(
    { dispatch: useModes((s) => s.effective.dispatch), name: useModes((s) => s.effective.name), overridden: useModes((s) => s.effective.overridden) },
    useModes((s) => s.loaded),
  );

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  const choose = (id: string, choice: string) => setAnswers((a) => ({ ...a, [id]: { ...a[id], choice: a[id]?.choice === choice ? undefined : choice } }));

  const build = async () => {
    if (!ready || blocker) return;
    setError(null);
    useTaste.getState().record(tagsFromAnswers(qs, answers));
    try {
      await requestBuild(brief, titleFor(idea));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const chip = (on: boolean) => `rounded-full border px-3 py-1 fs-12 transition-colors ${on ? "border-amber/60 bg-amber/15 text-ink" : "border-white/10 text-ink-2 hover:text-ink"}`;

  return (
    <div className="fixed inset-0 z-[80] grid place-items-center bg-black/60 p-3" role="dialog" aria-modal="true" aria-label="Shape an idea">
      <div className="glass flex max-h-[92dvh] w-full max-w-2xl flex-col r-20 p-4">
        <div className="mb-3 flex items-center gap-2">
          <Sparkles size={16} className="text-amber-soft" />
          <h2 className="fs-15 font-semibold text-ink">Shape an idea</h2>
          <span className="label-caps text-ink-3">describe the feeling, Play Place fills in the rest</span>
          <button onClick={onClose} className="pill-glass ml-auto !h-8 !w-8 !p-0" aria-label="Close">
            <X size={14} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          <textarea
            autoFocus
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
            rows={2}
            maxLength={600}
            placeholder="A rough idea is fine: “a little guy that cheers when I finish a task”, “track my auditions”, “a game for my nephew”…"
            className="field w-full resize-none text-sm"
            aria-label="Your idea"
          />

          {ready && (
            <>
              <section aria-label="What kind of build">
                <p className="mb-1.5 fs-12 text-ink-2">
                  Sounds like <b className="text-ink">{KIND_LABEL[c.kind].toLowerCase()}</b>
                  {c.reasons.length > 0 && <span className="text-ink-3"> (from “{c.reasons.join("”, “")}”)</span>}. Pick another if it isn't.
                </p>
                <div role="radiogroup" aria-label="Kind of build" className="grid gap-2 sm:grid-cols-3">
                  {KINDS.map((k) => {
                    const Icon = KIND_ICON[k];
                    const on = kind === k;
                    return (
                      <button
                        key={k}
                        role="radio"
                        aria-checked={on}
                        onClick={() => setPicked(k)}
                        className={`r-14 border p-2.5 text-left transition-colors ${on ? "border-amber/60 bg-amber/10" : "border-white/10 bg-white/[0.02] hover:border-white/25"}`}
                      >
                        <span className="flex items-center gap-1.5 fs-13 text-ink">
                          <Icon size={14} className={on ? "text-amber-soft" : "text-ink-3"} /> {KIND_LABEL[k]}
                          {k === c.kind && <span className="label-caps ml-auto text-teal">Suggested</span>}
                        </span>
                        <span className="mt-1 block fs-11 text-ink-3">{KIND_BLURB[k]}</span>
                      </button>
                    );
                  })}
                </div>
              </section>

              {pitches.length > 0 && (
                <section aria-label="Play Place's pitch" className="space-y-1.5 r-14 border border-teal/20 bg-teal/[0.05] p-3">
                  {pitches.map((p, i) => (
                    <div key={i} className="flex items-start gap-2 fs-13 text-ink">
                      <Sparkles size={12} className="mt-1 shrink-0 text-teal" />
                      <span className="flex-1">{p.text}</span>
                      {p.kind !== kind && /\?$/.test(p.text) && (
                        <button className="pill-glass !h-7 shrink-0 !px-2.5 fs-11" onClick={() => setPicked(p.kind)}>
                          Yes, that
                        </button>
                      )}
                    </div>
                  ))}
                </section>
              )}

              {qs.map((q, i) => (
                <fieldset key={`${kind}-${q.id}`} className="r-12 border border-white/[0.06] bg-white/[0.02] p-3">
                  <legend className="px-1 fs-13 text-ink">
                    {i + 1}. {q.question}
                  </legend>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {q.options.map((o) => (
                      <button key={o.label} type="button" aria-pressed={answers[q.id]?.choice === o.label} onClick={() => choose(q.id, o.label)} className={chip(answers[q.id]?.choice === o.label)}>
                        {o.label}
                      </button>
                    ))}
                  </div>
                  {q.freeText && (
                    <input
                      value={answers[q.id]?.text ?? ""}
                      onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: { ...a[q.id], text: e.target.value } }))}
                      placeholder="Or say it your way"
                      className="field mt-2 !h-8 w-full !py-1 text-xs"
                    />
                  )}
                </fieldset>
              ))}

              <TasteRow />

              <details>
                <summary className="cursor-pointer fs-12 text-teal">The brief the builders get</summary>
                <pre className="well mt-1 max-h-48 overflow-auto whitespace-pre-wrap r-10 p-2 font-mono fs-11 text-ink-2">{brief}</pre>
              </details>
            </>
          )}
          {blocker && <p className="r-12 border border-amber/30 bg-amber/10 p-2.5 text-xs text-ink">{blocker}</p>}
          {error && <p className="text-xs text-alert">{error}</p>}
        </div>

        <div className="mt-3 flex items-center gap-2">
          <span className="fs-11 text-ink-3">{ready ? `${Object.values(answers).filter((a) => a.choice || a.text).length}/${qs.length} answered · unanswered ones are left to the builders` : "Say a few words to start"}</span>
          <button onClick={() => void build()} disabled={!ready || !!blocker} className="pill-primary ml-auto !h-9 text-xs disabled:opacity-50" title={blocker ?? "Raises the confirmation card; nothing is built before its yes"}>
            <Hammer size={13} /> Build it as {KIND_LABEL[kind].toLowerCase()}
          </button>
        </div>
      </div>
    </div>
  );
}

/** What Play Place thinks you like, with remove and reset. */
function TasteRow() {
  const traits = useTaste((s) => s.traits);
  const top = topTraits(traits, 6);
  return (
    <section aria-label="Your taste" className="flex flex-wrap items-center gap-1.5 fs-12 text-ink-3">
      <span>Your taste:</span>
      {top.length === 0 ? (
        <span>nothing yet; your picks teach it.</span>
      ) : (
        top.map((t) => (
          <span key={t} className="flex items-center gap-1 rounded-full border border-white/10 py-0.5 pl-2.5 pr-1 text-ink-2">
            {t}
            <button aria-label={`Forget ${t}`} title="Forget this" className="grid size-4 place-items-center rounded-full hover:text-alert" onClick={() => useTaste.getState().forget(t)}>
              <X size={10} />
            </button>
          </span>
        ))
      )}
      {top.length > 0 && (
        <button className="ml-1 underline hover:text-ink" onClick={() => useTaste.getState().reset()}>
          Reset
        </button>
      )}
    </section>
  );
}
