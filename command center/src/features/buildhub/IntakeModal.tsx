import { useEffect, useMemo, useState } from "react";
import { Braces, Hammer, Info, Loader2, PanelLeft, Timer, X } from "lucide-react";
import { xcmd } from "@/lib/native-ext";
import { useToasts } from "@/features/reminders/notify";
import { useNav } from "@/stores/nav";
import { useModes } from "@/features/modes/modes-store";
import { compileEnvelope, deriveTitle, envelopeProblems, type Answers, type IntakeNote } from "./compile";
import { HubDispatchCancelled, requestHubDispatch } from "./dispatch";
import { errText } from "./hub-store";
import { hubRefusalText, stageBlocker } from "./gate";
import type { IntakeQuestion, RuntimeConfig } from "./types";
import { MountFields } from "@/features/myapps/PinButton";
import { useMyApps, type AppIcon } from "@/features/myapps/store";

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
  // "Add as Command Center Page": mounted in MY APPS once the hub shows the build.
  const [mount, setMount] = useState(false);
  const [mountLabel, setMountLabel] = useState("");
  const [mountIcon, setMountIcon] = useState<AppIcon>("app");
  const [r] = useState(rand);
  // The Tony-mode gate, before any card: a surface_only mode (Solo / Coach / Gabagool) stages
  // nothing, so Dispatch is disabled with a calm line (Rust still refuses on its own).
  const modeDispatch = useModes((s) => s.effective.dispatch);
  const modeName = useModes((s) => s.effective.name);
  const modeOverridden = useModes((s) => s.effective.overridden);
  const modesLoaded = useModes((s) => s.loaded);
  const blocker = stageBlocker({ dispatch: modeDispatch, name: modeName, overridden: modeOverridden }, modesLoaded);

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
    if (!compiled || problems.length || blocker) return;
    setBusy(true);
    setError(null);
    try {
      // Waits for the card's answer AND the enqueue: the modal (answers, title, envelope) stays
      // open on a decline, a timeout, a superseding card or a refusal, so nothing is retyped.
      await requestHubDispatch(
        compiled,
        () => {
          if (mount) useMyApps.getState().addPending({ slug: compiled.envelope.project_slug, label: mountLabel.trim() || compiled.envelope.title, icon: mountIcon });
          useToasts.getState().push({ title: "Staged", body: `“${compiled.envelope.title}” is in the Play Place queue.${mount ? " It will appear under My Apps in the left rail." : ""}`, tone: "info" });
          useNav.getState().go("playplace");
        },
        source,
      );
      onClose();
    } catch (e) {
      // A Rust MODE_* refusal reads calmly, never as a raw code or a "timed out", and names the
      // mode in force when it lands (read now: it may have changed while the card was up).
      const m = useModes.getState();
      setError(e instanceof HubDispatchCancelled ? "Not staged (the card was declined, timed out or replaced) — your answers are still here." : hubRefusalText(e, m.effective, m.loaded));
    } finally {
      setBusy(false);
    }
  };

  const set = (id: string, patch: Partial<Answers[string]>) => setAnswers((a) => ({ ...a, [id]: { ...a[id], ...patch } }));

  return (
    <div className="fixed inset-0 z-[80] grid place-items-center bg-black/60 p-3" role="dialog" aria-modal="true" aria-label="Intake interview">
      <div className="glass flex max-h-[92dvh] w-full max-w-2xl flex-col r-20 p-4">
        <div className="mb-3 flex items-center gap-2">
          <Hammer size={16} className="text-amber-soft" />
          <h2 className="fs-15 font-semibold text-ink">Intake interview</h2>
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
            <fieldset key={q.id} className="r-12 border border-white/[0.06] bg-white/[0.02] p-3">
              <legend className="px-1 fs-13 text-ink">
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
                      className={`rounded-full border px-3 py-1 fs-12 transition-colors ${on ? "border-amber/60 bg-amber/15 text-ink" : "border-white/10 text-ink-2 hover:text-ink"}`}
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
                />
              )}
            </fieldset>
          ))}
          <fieldset className="r-12 border border-white/[0.06] bg-white/[0.02] p-3">
            <label className="flex cursor-pointer items-center gap-2 fs-13 text-ink">
              <input type="checkbox" checked={mount} onChange={(e) => setMount(e.target.checked)} className="accent-amber" />
              <PanelLeft size={13} className="text-amber-soft" /> Add as Command Center page
              <span className="fs-11 text-ink-3">(mount in the left sidebar under My Apps)</span>
            </label>
            {mount && (
              <div className="mt-2">
                <MountFields label={mountLabel} icon={mountIcon} onLabel={setMountLabel} onIcon={setMountIcon} placeholder={title || "App name"} />
              </div>
            )}
          </fieldset>
          {compiled && (
            <details open={showJson} onToggle={(e) => setShowJson((e.target as HTMLDetailsElement).open)}>
              <summary className="flex cursor-pointer items-center gap-1 text-xs text-teal">
                <Braces size={12} /> TaskEnvelope (strict JSON)
              </summary>
              <pre className="well mt-1 max-h-64 overflow-auto whitespace-pre-wrap r-10 p-2 font-mono fs-10.5 text-ink-2">{JSON.stringify(compiled.envelope, null, 2)}</pre>
            </details>
          )}
          {blocker && (
            <p role="status" className="flex items-start gap-2 r-12 border border-amber/30 bg-amber/10 p-2.5 text-xs text-ink">
              <Info size={13} className="mt-0.5 shrink-0 text-amber-soft" /> {blocker}
            </p>
          )}
          {/* The amber banner already says why a mode refusal happened: never both lines at once. */}
          {error && !(blocker && /mode builds nothing|Dispatch is set to Solo/.test(error)) && <p className="text-xs text-alert">{error}</p>}
        </div>

        <div className="mt-3 flex items-center gap-2">
          <span className="fs-11 text-ink-3">
            {answered}/{questions?.length ?? 0} answered{problems.length && compiled ? ` · fix: ${problems.join(", ")}` : ""}
          </span>
          <button onClick={() => void dispatch()} disabled={!compiled || problems.length > 0 || busy || !!blocker} className="pill-primary ml-auto !h-9 text-xs disabled:opacity-50" title={blocker ?? "Raises the confirmation card; nothing is queued before its yes"}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Hammer size={13} />} Dispatch to Play Place
          </button>
        </div>
      </div>
    </div>
  );
}
