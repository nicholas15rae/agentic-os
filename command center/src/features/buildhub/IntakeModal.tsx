import { useEffect, useMemo, useState } from "react";
import { Braces, Hammer, Loader2, Timer, X } from "lucide-react";
import { xcmd } from "@/lib/native-ext";
import { useToasts } from "@/features/reminders/notify";
import { useNav } from "@/stores/nav";
import { compileEnvelope, deriveTitle, envelopeProblems, type Answers, type IntakeNote } from "./compile";
import { requestHubDispatch } from "./dispatch";
import { errText } from "./hub-store";
import type { IntakeQuestion, RuntimeConfig } from "./types";

export const INTERVIEW_SECS = 60;

const rand = () => Math.random().toString(36).slice(2, 8);

/**
 * Phase 2 Intake Interview: the Prompter reads the selected notes and asks 3–5 targeted questions
 * (quick-select chips + free-text overrides). Answers + notes compile into ONE strict TaskEnvelope,
 * which is staged only behind the confirmation card. The 60-second clock is a pace guide: when it
 * runs out, unanswered questions fall back to their first option — nothing is sent on its own.
 */
export function IntakeModal({ notes, onClose }: { notes: IntakeNote[]; onClose: () => void }) {
  const [questions, setQuestions] = useState<IntakeQuestion[] | null>(null);
  const [source, setSource] = useState<"prompter" | "fallback">("fallback");
  const [cfg, setCfg] = useState<RuntimeConfig | null>(null);
  const [answers, setAnswers] = useState<Answers>({});
  const [title, setTitle] = useState(() => deriveTitle(notes));
  const [left, setLeft] = useState(INTERVIEW_SECS);
  const [busy, setBusy] = useState(false);
  const [showJson, setShowJson] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now] = useState(() => Date.now());
  const [r] = useState(rand);

  useEffect(() => {
    let live = true;
    void Promise.all([xcmd("build_intake_questions", { notes: notes.map((n) => ({ title: n.title, text: n.text })) }), xcmd("build_runtime_config")])
      .then(([q, c]) => {
        if (!live) return;
        setQuestions(q.questions);
        setSource(q.source);
        setCfg(c);
      })
      .catch((e) => live && setError(errText(e)));
    return () => {
      live = false;
    };
  }, [notes]);

  useEffect(() => {
    if (!questions) return;
    const t = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [questions]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  // Out of time: unanswered questions take their first option (still nothing sent without the card).
  const effective = useMemo<Answers>(() => {
    if (!questions) return answers;
    const out: Answers = { ...answers };
    for (const q of questions) if (!out[q.id]?.choice && !out[q.id]?.text && (left === 0 || q.id === "runtime" || q.id === "worker")) out[q.id] = { choice: q.options[0] };
    return out;
  }, [answers, questions, left]);

  const compiled = useMemo(() => {
    if (!questions || !cfg) return null;
    try {
      return compileEnvelope(notes, questions, effective, { now, rand: r, stagingRoot: cfg.staging_root, externalBase: cfg.external_base, title });
    } catch {
      return null;
    }
  }, [notes, questions, effective, cfg, title, now, r]);

  const answered = questions?.filter((q) => answers[q.id]?.choice || answers[q.id]?.text).length ?? 0;
  const problems = compiled ? envelopeProblems(compiled.envelope) : ["not ready"];

  const dispatch = async () => {
    if (!compiled || problems.length) return;
    setBusy(true);
    try {
      await requestHubDispatch(compiled, () => {
        useToasts.getState().push({ title: "Staged", body: `“${compiled.envelope.title}” is in the Play Place queue.`, tone: "info" });
        useNav.getState().go("playplace");
      });
      onClose();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const set = (id: string, patch: Partial<Answers[string]>) => setAnswers((a) => ({ ...a, [id]: { ...a[id], ...patch } }));

  return (
    <div className="fixed inset-0 z-[80] grid place-items-center bg-black/60 p-3" role="dialog" aria-modal="true" aria-label="Intake interview">
      <div className="glass flex max-h-[92dvh] w-full max-w-2xl flex-col rounded-[20px] p-4">
        <div className="mb-3 flex items-center gap-2">
          <Hammer size={16} className="text-amber-soft" />
          <h2 className="text-[15px] font-semibold text-ink">Intake interview</h2>
          <span className="label-caps text-ink-3">
            {notes.length} note{notes.length === 1 ? "" : "s"} · {source === "prompter" ? "Prompter's questions" : "standard questions"}
          </span>
          <span className={`ml-auto flex items-center gap-1 font-mono text-xs ${left === 0 ? "text-amber-soft" : "text-ink-2"}`} title="A pace guide: at zero, unanswered questions use their first option">
            <Timer size={12} /> {left}s
          </span>
          <button onClick={onClose} disabled={busy} className="pill-glass !h-8 !w-8 !p-0" aria-label="Close interview">
            <X size={14} />
          </button>
        </div>
        <div className="mb-3 h-1 overflow-hidden rounded-full bg-white/10">
          <div className="h-full bg-gradient-to-r from-amber to-teal transition-[width] duration-1000 ease-linear" style={{ width: `${(left / INTERVIEW_SECS) * 100}%` }} />
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          <label className="block text-xs text-ink-2">
            Build title
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} className="field mt-1 !h-9 w-full !py-1 text-sm" />
          </label>
          {!questions && !error && (
            <p className="flex items-center gap-2 py-6 text-sm text-ink-2">
              <Loader2 size={14} className="animate-spin" /> The Prompter is reading your notes…
            </p>
          )}
          {questions?.map((q, i) => (
            <fieldset key={q.id} className="rounded-[12px] border border-white/[0.06] bg-white/[0.02] p-3">
              <legend className="px-1 text-[13px] text-ink">
                {i + 1}. {q.question}
              </legend>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {q.options.map((o) => {
                  const on = effective[q.id]?.choice === o;
                  return (
                    <button
                      key={o}
                      type="button"
                      aria-pressed={on}
                      onClick={() => set(q.id, { choice: on ? undefined : o })}
                      className={`rounded-full border px-3 py-1 text-[12px] transition-colors ${on ? "border-amber/60 bg-amber/15 text-ink" : "border-white/10 text-ink-2 hover:text-ink"}`}
                    >
                      {o}
                    </button>
                  );
                })}
              </div>
              {q.allow_free_text && (
                <input
                  value={answers[q.id]?.text ?? ""}
                  onChange={(e) => set(q.id, { text: e.target.value })}
                  placeholder="Or say it your way (overrides / adds to the choice)"
                  className="field mt-2 !h-8 w-full !py-1 text-xs"
                  maxLength={400}
                />
              )}
            </fieldset>
          ))}
          {compiled && (
            <details open={showJson} onToggle={(e) => setShowJson((e.target as HTMLDetailsElement).open)}>
              <summary className="flex cursor-pointer items-center gap-1 text-xs text-teal">
                <Braces size={12} /> TaskEnvelope (strict JSON)
              </summary>
              <pre className="well mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-[10px] p-2 font-mono text-[10.5px] text-ink-2">{JSON.stringify(compiled.envelope, null, 2)}</pre>
            </details>
          )}
          {error && <p className="text-xs text-alert">{error}</p>}
        </div>

        <div className="mt-3 flex items-center gap-2">
          <span className="text-[11px] text-ink-3">
            {answered}/{questions?.length ?? 0} answered{problems.length && compiled ? ` · fix: ${problems.join(", ")}` : ""}
          </span>
          <button onClick={() => void dispatch()} disabled={!compiled || problems.length > 0 || busy} className="pill-primary ml-auto !h-9 text-xs disabled:opacity-50" title="Raises the confirmation card; nothing is queued before its yes">
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Hammer size={13} />} Dispatch to Play Place
          </button>
        </div>
      </div>
    </div>
  );
}
