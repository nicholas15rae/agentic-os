import { useState, type ReactNode } from "react";
import { Check, Loader2, PencilLine, Sparkles, X } from "lucide-react";
import { Card, Select } from "@/components/ui";
import type { Aspect, CreativeBrief, Platform } from "./contract";
import { acceptBriefDraft, approveBrief, defaultBrief, editBrief, rejectBriefDraft, useDirector, type BriefPatch } from "./director-store";
import { sendDirectorTurn } from "./director-chat";
import { ASPECTS, PLATFORMS } from "./manifest";
import { PLATFORM_LABEL } from "./review-ui";

export const DRAFT_BRIEF_PROMPT = "Draft a creative brief for this project as one draft_brief action. Keep my idea in my own words, and list every field you filled with a default in guessed.";

type BriefKey = keyof BriefPatch;
const FIELDS: { key: BriefKey; label: string }[] = [
  { key: "idea", label: "Idea" },
  { key: "goal", label: "Goal" },
  { key: "platform", label: "Platform" },
  { key: "lengthSec", label: "Length" },
  { key: "aspect", label: "Aspect" },
  { key: "tone", label: "Tone" },
  { key: "references", label: "References" },
];

/** A brief field as text (pure). */
export function briefValue(b: Pick<CreativeBrief, BriefKey>, key: BriefKey): string {
  switch (key) {
    case "platform":
      return PLATFORM_LABEL[b.platform];
    case "lengthSec":
      return `${b.lengthSec}s`;
    case "references":
      return b.references.join(", ");
    default:
      return String(b[key] ?? "");
  }
}

/** Only the fields that changed (so untouched "guessed" fields stay guessed). Pure. */
export function briefPatch(base: CreativeBrief, form: BriefForm): BriefPatch {
  const p: BriefPatch = {};
  const refs = form.references
    .split(/[\n,]/)
    .map((r) => r.trim())
    .filter(Boolean)
    .slice(0, 10);
  // One decimal, as a draft_brief keeps it, so an untouched 12.5 s doesn't read as an edit.
  const tenth = (n: number) => Math.round(n * 10) / 10;
  const len = tenth(Math.min(600, Math.max(5, Number(form.lengthSec) || base.lengthSec)));
  if (form.idea.trim() !== base.idea.trim()) p.idea = form.idea.trim().slice(0, 8000);
  if (form.goal.trim() !== base.goal.trim()) p.goal = form.goal.trim();
  if (form.platform !== base.platform) p.platform = form.platform;
  if (len !== tenth(base.lengthSec)) p.lengthSec = len;
  if (form.aspect !== base.aspect) p.aspect = form.aspect;
  if (form.tone.trim() !== base.tone.trim()) p.tone = form.tone.trim();
  if (refs.join("\n") !== base.references.join("\n")) p.references = refs;
  return p;
}

export interface BriefForm {
  idea: string;
  goal: string;
  platform: Platform;
  lengthSec: string;
  aspect: Aspect;
  tone: string;
  references: string;
}
const toForm = (b: CreativeBrief): BriefForm => ({ idea: b.idea, goal: b.goal, platform: b.platform, lengthSec: String(b.lengthSec), aspect: b.aspect, tone: b.tone, references: b.references.join(", ") });

export interface BriefViewProps {
  brief: CreativeBrief | null;
  draft: CreativeBrief | null;
  chatBusy: boolean;
  /** The brief shown when Nic starts one by hand (no brief yet). */
  starter: CreativeBrief;
  onSave: (patch: BriefPatch) => Promise<boolean>;
  onApprove: () => void;
  onAcceptDraft: () => void;
  onRejectDraft: () => void;
  onDraft: () => void;
  /** Start editing straight away (tests / a fresh hand-written brief). */
  initialEditing?: boolean;
}

/** The creative brief: guessed chips, inline edit, Nic's approval, and a held Director draft. Props only. */
export function BriefView({ brief, draft, chatBusy, starter, onSave, onApprove, onAcceptDraft, onRejectDraft, onDraft, initialEditing = false }: BriefViewProps) {
  const [editing, setEditing] = useState(initialEditing);
  const [form, setForm] = useState<BriefForm>(() => toForm(brief ?? starter));
  const [busy, setBusy] = useState(false);
  const base = brief ?? starter;

  const begin = () => {
    setForm(toForm(base));
    setEditing(true);
  };
  const save = async () => {
    const patch = briefPatch(base, form);
    // A hand-started brief saves even when nothing changed (so it exists).
    if (!Object.keys(patch).length && brief) return setEditing(false);
    setBusy(true);
    try {
      if (await onSave(patch)) setEditing(false);
    } finally {
      setBusy(false);
    }
  };
  const field = <K extends keyof BriefForm>(k: K, v: BriefForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  const status = brief ? (
    brief.approved ? (
      <span className="rounded-full border border-teal/40 px-2 text-[11px] text-teal-soft">Approved</span>
    ) : (
      <span className="rounded-full border border-amber/40 px-2 text-[11px] text-amber-soft">Waiting for your approval</span>
    )
  ) : null;

  return (
    <Card
      title="Brief"
      action={
        <>
          {status}
          {brief && !editing && (
            <button onClick={begin} className="pill-glass !h-7 !w-7 !p-0" title="Edit the brief" aria-label="Edit the brief">
              <PencilLine size={12} />
            </button>
          )}
        </>
      }
    >
      {draft && (
        <div className="mb-3 rounded-[12px] border border-amber/40 bg-amber/10 p-2.5" role="group" aria-label="Director's brief draft">
          <p className="text-[12px] text-ink">The Director drafted a new brief. Your approved one stays until you accept this.</p>
          <dl className="mt-1.5 space-y-0.5 text-[11px]">
            {FIELDS.filter((f) => !brief || briefValue(draft, f.key) !== briefValue(brief, f.key)).map((f) => (
              <div key={f.key} className="flex gap-1.5">
                <dt className="w-16 shrink-0 text-ink-3">{f.label}</dt>
                <dd className="min-w-0 flex-1 break-words text-ink-2">{briefValue(draft, f.key) || "â€”"}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-2 flex gap-1.5">
            <button onClick={onAcceptDraft} className="pill-primary !h-7 !px-2.5 text-[11px]">
              <Check size={11} /> Accept draft
            </button>
            <button onClick={onRejectDraft} className="pill-glass !h-7 !px-2.5 text-[11px]">
              <X size={11} /> Reject
            </button>
          </div>
        </div>
      )}

      {!brief && !editing ? (
        <div className="space-y-2 text-center">
          <p className="text-[12px] text-ink-2">No brief yet. The Director can draft one from your idea, or you can write it.</p>
          <div className="flex flex-wrap justify-center gap-1.5">
            <button onClick={onDraft} disabled={chatBusy} className="pill-primary !h-8 !px-3 text-xs disabled:opacity-50">
              {chatBusy ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />} Draft a brief
            </button>
            <button onClick={begin} className="pill-glass !h-8 !px-3 text-xs">
              <PencilLine size={12} /> Write it myself
            </button>
          </div>
        </div>
      ) : editing ? (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Labeled label="Idea" guessed={base.guessed.includes("idea")}>
            <textarea value={form.idea} onChange={(e) => field("idea", e.target.value)} rows={3} className="field min-h-[60px] resize-y text-[12px]" aria-label="Idea" />
          </Labeled>
          <Labeled label="Goal" guessed={base.guessed.includes("goal")}>
            <input value={form.goal} onChange={(e) => field("goal", e.target.value)} className="field !h-8 !py-0 text-[12px]" aria-label="Goal" />
          </Labeled>
          <div className="grid grid-cols-3 gap-1.5">
            <Labeled label="Platform" guessed={base.guessed.includes("platform")}>
              <Select value={form.platform} onChange={(e) => field("platform", e.target.value as Platform)} className="!h-8 !py-0 text-[12px]" aria-label="Platform">
                {PLATFORMS.map((p) => (
                  <option key={p} value={p}>
                    {PLATFORM_LABEL[p]}
                  </option>
                ))}
              </Select>
            </Labeled>
            <Labeled label="Length (s)" guessed={base.guessed.includes("lengthSec")}>
              <input type="number" min={5} max={600} value={form.lengthSec} onChange={(e) => field("lengthSec", e.target.value)} className="field !h-8 !py-0 text-[12px]" aria-label="Length in seconds" />
            </Labeled>
            <Labeled label="Aspect" guessed={base.guessed.includes("aspect")}>
              <Select value={form.aspect} onChange={(e) => field("aspect", e.target.value as Aspect)} className="!h-8 !py-0 text-[12px]" aria-label="Aspect">
                {ASPECTS.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </Select>
            </Labeled>
          </div>
          <Labeled label="Tone" guessed={base.guessed.includes("tone")}>
            <input value={form.tone} onChange={(e) => field("tone", e.target.value)} className="field !h-8 !py-0 text-[12px]" aria-label="Tone" />
          </Labeled>
          <Labeled label="References" guessed={base.guessed.includes("references")}>
            <input value={form.references} onChange={(e) => field("references", e.target.value)} placeholder="Links or names, comma separated" className="field !h-8 !py-0 text-[12px]" aria-label="References" />
          </Labeled>
          <div className="flex gap-1.5 pt-1">
            <button type="submit" disabled={busy || !form.idea.trim()} className="pill-primary !h-8 !px-3 text-xs disabled:opacity-50">
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Save brief
            </button>
            <button type="button" onClick={() => setEditing(false)} className="pill-glass !h-8 !px-3 text-xs">
              Cancel
            </button>
          </div>
        </form>
      ) : (
        brief && (
          <>
            <dl className="space-y-1.5">
              {FIELDS.map((f) => (
                <div key={f.key} className="flex gap-2 text-[12px]">
                  <dt className="label-caps w-[72px] shrink-0 pt-0.5 text-ink-3">{f.label}</dt>
                  <dd className="min-w-0 flex-1 break-words text-ink-2">
                    <button onClick={begin} className="text-left hover:text-ink" title={`Edit ${f.label.toLowerCase()}`}>
                      {briefValue(brief, f.key) || <span className="text-ink-3">not set</span>}
                    </button>
                    {brief.guessed.includes(f.key) && <GuessedChip />}
                  </dd>
                </div>
              ))}
            </dl>
            {!brief.approved && (
              <button onClick={onApprove} className="pill-primary mt-3 !h-8 !px-3 text-xs" title="Approve this brief (the project moves to shooting)">
                <Check size={12} /> Approve brief
              </button>
            )}
          </>
        )
      )}
    </Card>
  );
}

function GuessedChip() {
  return (
    <span className="ml-1.5 inline-block rounded-full border border-amber/40 px-1.5 align-middle text-[10px] text-amber-soft" title="The Director filled this with a default: check it">
      guessed
    </span>
  );
}

function Labeled({ label, guessed, children }: { label: string; guessed: boolean; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="label-caps text-ink-3">
        {label}
        {guessed && <GuessedChip />}
      </span>
      {children}
    </label>
  );
}

export function BriefCard() {
  const project = useDirector((s) => s.project);
  const manifest = useDirector((s) => s.manifest);
  const draft = useDirector((s) => s.briefDraft);
  const chatBusy = useDirector((s) => s.chatBusy);
  if (!project) return null;
  const starter: CreativeBrief = project.brief ?? defaultBrief(project, manifest);
  return (
    <BriefView
      key={project.slug}
      brief={project.brief}
      draft={draft}
      chatBusy={chatBusy}
      starter={starter}
      onSave={editBrief}
      onApprove={() => void approveBrief()}
      onAcceptDraft={() => void acceptBriefDraft()}
      onRejectDraft={rejectBriefDraft}
      onDraft={() => void sendDirectorTurn(DRAFT_BRIEF_PROMPT)}
    />
  );
}
