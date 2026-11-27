import { useState } from "react";
import { CheckSquare, Hammer, Loader2, Plus, Sparkles, X } from "lucide-react";
import { xcmd } from "@/lib/native-ext";
import { useModes } from "@/features/modes/modes-store";
import { useNav } from "@/stores/nav";
import { useToasts } from "@/features/reminders/notify";
import { MAX_POINTS, compileWidgetBuild, type BriefChecklist } from "./brief-points";
import { HubDispatchCancelled, requestHubDispatch } from "./dispatch";
import { hubRefusalText, stageBlocker } from "./gate";
import { envelopeProblems } from "./compile";

/**
 * Widget builder: the checklist Nic sees before a described widget is built. Every point becomes
 * an acceptance criterion the verifier must prove in a real browser; he can edit, drop or add
 * points first. "Build it" stages it in the Play Place behind the usual confirmation card;
 * "Quick card" uses the instant template generator instead.
 */
export function BriefChecklistCard({ text, initial, onQuick, onClose }: { text: string; initial: BriefChecklist; onQuick: () => void; onClose: () => void }) {
  const [title, setTitle] = useState(initial.title);
  const [points, setPoints] = useState<string[]>(initial.points);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const modes = useModes((s) => s.effective);
  const loaded = useModes((s) => s.loaded);
  const blocker = stageBlocker({ dispatch: modes.dispatch, name: modes.name, overridden: modes.overridden }, loaded);
  const clean = points.map((p) => p.trim()).filter(Boolean);

  const build = async () => {
    setBusy(true);
    setError(null);
    try {
      const cfg = await xcmd("build_runtime_config");
      const c = compileWidgetBuild(text, { title: title.trim() || initial.title, points: clean }, { now: Date.now(), rand: crypto.randomUUID().replace(/-/g, "").slice(0, 6), stagingRoot: cfg.staging_root, externalBase: cfg.external_base });
      const problems = envelopeProblems(c.envelope);
      if (problems.length) throw new Error(`The build isn't valid yet (${problems.join(", ")})`);
      await requestHubDispatch(
        c,
        () => {
          useToasts.getState().push({ title: "Building your widget", body: `“${c.envelope.title}”: ${clean.length} point${clean.length === 1 ? "" : "s"} to check. Watch it in the Play Place.`, tone: "info" });
          useNav.getState().go("playplace");
        },
        "fallback",
      );
      onClose();
    } catch (e) {
      const m = useModes.getState();
      setError(e instanceof HubDispatchCancelled ? "Not built (the card was declined, timed out or replaced). The checklist is still here." : hubRefusalText(e, m.effective, m.loaded));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="glass space-y-2 r-18 p-3" role="dialog" aria-label="Widget checklist">
      <div className="flex items-center gap-2">
        <CheckSquare size={14} className="text-teal" />
        <input className="field !h-8 !w-auto min-w-0 flex-1 !py-1 fs-13 font-semibold" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Widget name" />
        <button className="grid size-7 place-items-center rounded-full text-ink-3 hover:text-ink" onClick={onClose} aria-label="Close the checklist">
          <X size={14} />
        </button>
      </div>
      <p className="fs-12 text-ink-2">Each point is built and then checked in a real browser before the widget is offered to you. Edit, drop or add points first.</p>
      <ol className="space-y-1">
        {points.map((p, i) => (
          <li key={i} className="flex items-center gap-2">
            <span className="w-5 text-right font-mono fs-11 text-ink-3">{i + 1}.</span>
            <input
              className="field !h-8 flex-1 !py-1 fs-13"
              value={p}
              onChange={(e) => setPoints((ps) => ps.map((x, j) => (j === i ? e.target.value : x)))}
              aria-label={`Point ${i + 1}`}
            />
            <button className="grid size-7 place-items-center rounded-full text-ink-3 hover:text-alert" onClick={() => setPoints((ps) => ps.filter((_, j) => j !== i))} aria-label={`Drop point ${i + 1}`}>
              <X size={12} />
            </button>
          </li>
        ))}
      </ol>
      {initial.overflow.length > 0 && <p className="fs-11 text-amber-soft">Only {MAX_POINTS} points fit one build; these were left out: {initial.overflow.join("; ")}.</p>}
      {points.length < MAX_POINTS && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) setPoints((ps) => [...ps, draft.trim()]);
            setDraft("");
          }}
        >
          <input className="field !h-8 flex-1 !py-1 fs-13" placeholder="Add a point, e.g. “sounds a chime when it opens”" value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Add a point" />
          <button className="pill-glass !h-8 !px-3 fs-12" disabled={!draft.trim()}>
            <Plus size={12} /> Add
          </button>
        </form>
      )}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button className="pill-primary !h-9 !px-3 fs-13" disabled={busy || !clean.length || !!blocker} onClick={() => void build()} title="Stage it in the Play Place: Prompter, Designer and Coder build it, then each point is checked">
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Hammer size={13} />} Build it ({clean.length} point{clean.length === 1 ? "" : "s"})
        </button>
        <button className="pill-glass !h-9 !px-3 fs-13" onClick={onQuick} disabled={busy} title="The instant card generator (a few simple templates; nothing is checked)">
          <Sparkles size={13} /> Quick card instead
        </button>
        {blocker && <span className="fs-12 text-amber-soft">{blocker}</span>}
      </div>
      {error && <p className="fs-12 text-alert">{error}</p>}
    </div>
  );
}
