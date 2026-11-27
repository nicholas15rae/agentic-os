import { ChevronDown, ChevronUp, Dices, Loader2, Sparkles } from "lucide-react";
import { Select } from "@/components/ui";
import { COMFY_ASPECTS, COMFY_PROMPT_MAX, COMFY_STYLE_DENOISE, COMFY_TURBO_MAX_STEPS, type Aspect, type ComfyAspect, type ComfyPolicy, type ComfyTemplateName, type MediaAsset } from "./contract";
import { GENERATE_PANEL_ID, defaultDraft, enqueueDraft, openGenerate, setDraft, useComfy, type GenerateDraft } from "./comfy-store";
import { POLICY_NOTE, generateBlocker, inputCandidates, mergeTemplates, randomSeed, type MergedTemplate } from "./comfy-ui";
import { useDirector } from "./director-store";
import { Thumb } from "./StagingBin";

export interface GeneratePanelProps {
  open: boolean;
  onToggle: (open: boolean) => void;
  templates: MergedTemplate[]; // merged with COMFY_TEMPLATE_META
  draft: GenerateDraft;
  onDraft: (patch: Partial<GenerateDraft>) => void;
  projectAspect: Aspect | null; // shown as "Project (9:16)" for aspect null
  inputs: MediaAsset[]; // inputCandidates(...) for the selected template
  tweakingName: string | null; // "Tweaking still_03.png" + a Clear link (onDraft defaultDraft)
  blocker: string | null; // generateBlocker(...); Enqueue disabled with this as the visible reason
  policy: ComfyPolicy | null; // for the line under Enqueue
  busy: boolean;
  onEnqueue: () => void;
}

const usable = (t: MergedTemplate | undefined) => !!t && t.implemented && t.ready;

/** Centre column, under OutputsCard. Collapsed: one row ("Generate a still" + the selected template's readiness dot). Props only. */
export function GeneratePanelView(p: GeneratePanelProps) {
  const { draft: d, onDraft } = p;
  const sel = p.templates.find((t) => t.name === d.template);
  const dot = !sel ? "bg-ink-3" : usable(sel) ? "bg-teal" : "bg-amber";
  const isUpscale = d.template === "upscale";
  const isStyle = d.template === "style-transfer";
  const needsInput = sel?.needsInput ?? false;
  const disabled = !!p.blocker || p.busy;
  const selNote = sel && (!sel.implemented ? sel.unavailableReason : !sel.ready ? sel.note : null);
  return (
    <section id={GENERATE_PANEL_ID} className="glass r-20 p-5" aria-label="Generate">
      <button type="button" onClick={() => p.onToggle(!p.open)} className="flex w-full items-center gap-2 text-left" aria-expanded={p.open} aria-controls={`${GENERATE_PANEL_ID}-body`}>
        <Sparkles size={13} className="text-violet" />
        <span className="label-caps text-amber-soft">Generate a still</span>
        <span className={`size-2 rounded-full ${dot}`} title={sel ? (usable(sel) ? `${sel.label} is ready` : (selNote ?? "Not ready")) : "ComfyUI status unavailable"} />
        {sel && <span className="min-w-0 truncate fs-11 text-ink-3">{sel.label}</span>}
        <span className="ml-auto text-ink-3">{p.open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</span>
      </button>

      {p.open && (
        <div id={`${GENERATE_PANEL_ID}-body`} className="@container mt-3 space-y-2.5">
          {p.tweakingName && (
            <p className="flex items-center gap-2 fs-11 text-ink-2">
              Tweaking {p.tweakingName}
              <button type="button" onClick={() => onDraft(defaultDraft())} className="text-teal-soft hover:underline">
                Clear
              </button>
            </p>
          )}

          <label className="block space-y-1">
            <span className="label-caps text-ink-3">Template</span>
            <Select value={d.template} onChange={(e) => onDraft({ template: e.target.value as ComfyTemplateName })} className="!h-8 !py-0 fs-12" aria-label="Template">
              {p.templates.map((t) => (
                <option key={t.name} value={t.name} disabled={!t.implemented}>
                  {t.label}
                  {usable(t) ? "" : " (not ready)"}
                </option>
              ))}
            </Select>
            {selNote && <span className="block fs-11 text-amber-soft">{selNote}</span>}
          </label>

          {!isUpscale && (
            <label className="block space-y-1">
              <span className="flex items-center justify-between">
                <span className="label-caps text-ink-3">Prompt</span>
                <span className={`font-mono fs-10 ${d.prompt.length > COMFY_PROMPT_MAX ? "text-alert" : "text-ink-3"}`}>
                  {d.prompt.length} / {COMFY_PROMPT_MAX}
                </span>
              </span>
              <textarea value={d.prompt} onChange={(e) => onDraft({ prompt: e.target.value })} rows={3} className="field min-h-[72px] resize-y fs-12" placeholder="A neon dance studio at night, wide shot" aria-label="Prompt" />
            </label>
          )}

          <label className="block space-y-1">
            <span className="label-caps text-ink-3">Negative</span>
            <input value={d.negative} onChange={(e) => onDraft({ negative: e.target.value })} className="field !h-8 !py-0 fs-12" placeholder="blurry, text" aria-label="Negative prompt" />
            <span className="block fs-10 text-ink-3">Has little effect on SDXL Turbo</span>
          </label>

          <div className="grid gap-2 @md:grid-cols-2">
            <div className="space-y-1">
              <span className="label-caps block text-ink-3">Seed</span>
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={d.seed ?? ""}
                  disabled={d.seed == null}
                  onChange={(e) => onDraft({ seed: e.target.value === "" ? null : Number(e.target.value) })}
                  placeholder="random"
                  className="field !h-8 min-w-0 flex-1 !py-0 font-mono fs-12 disabled:opacity-50"
                  aria-label="Seed"
                />
                <label className="flex shrink-0 items-center gap-1 fs-11 text-ink-2">
                  <input type="checkbox" checked={d.seed == null} onChange={(e) => onDraft({ seed: e.target.checked ? null : randomSeed() })} className="accent-teal" aria-label="Random seed" />
                  Random
                </label>
                <button type="button" onClick={() => onDraft({ seed: randomSeed() })} className="grid size-8 shrink-0 place-items-center rounded-full border border-white/10 text-ink-2 hover:text-ink" title="New random seed" aria-label="New random seed">
                  <Dices size={13} />
                </button>
              </div>
            </div>
            {!needsInput && (
              <label className="block space-y-1">
                <span className="label-caps text-ink-3">Aspect</span>
                <Select value={d.aspect ?? ""} onChange={(e) => onDraft({ aspect: (e.target.value || null) as ComfyAspect | null })} className="!h-8 !py-0 fs-12" aria-label="Aspect">
                  <option value="">Project{p.projectAspect ? ` (${p.projectAspect})` : ""}</option>
                  {COMFY_ASPECTS.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </Select>
              </label>
            )}
          </div>

          <label className="flex items-center gap-2 fs-11 text-ink-2">
            <span className="w-14 shrink-0">Steps</span>
            <input type="range" min={1} max={COMFY_TURBO_MAX_STEPS} step={1} value={d.steps} onChange={(e) => onDraft({ steps: Number(e.target.value) })} className="min-w-0 flex-1 accent-amber" aria-label="Steps" />
            <span className="w-6 shrink-0 text-right font-mono fs-10">{d.steps}</span>
          </label>

          {isStyle && (
            <label className="flex items-center gap-2 fs-11 text-ink-2">
              <span className="w-14 shrink-0">Denoise</span>
              <input type="range" min={COMFY_STYLE_DENOISE[0]} max={COMFY_STYLE_DENOISE[1]} step={0.05} value={d.denoise} onChange={(e) => onDraft({ denoise: Number(e.target.value) })} className="min-w-0 flex-1 accent-amber" aria-label="Denoise" />
              <span className="w-8 shrink-0 text-right font-mono fs-10">{d.denoise.toFixed(2)}</span>
            </label>
          )}

          {needsInput && (
            <div className="space-y-1">
              <span className="label-caps block text-ink-3">Input still</span>
              {p.inputs.length ? (
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="Input still">
                  {p.inputs.map((a) => {
                    const on = a.id === d.inputAssetId;
                    return (
                      <button
                        key={a.id}
                        type="button"
                        onClick={() => onDraft({ inputAssetId: on ? null : a.id })}
                        aria-pressed={on}
                        aria-label={`Input ${a.name}`}
                        title={a.name}
                        className={`r-10 border p-0.5 ${on ? "border-teal/70" : "border-white/10 hover:border-white/25"}`}
                      >
                        <Thumb asset={a} className="h-10 w-14" />
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="fs-11 text-ink-3">Add a still to the bin first.</p>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button type="button" onClick={p.onEnqueue} disabled={disabled} className="pill-primary !h-8 !px-4 text-xs disabled:opacity-50">
              {p.busy ? <Loader2 size={12} className="animate-spin" /> : "Enqueue"}
            </button>
            {p.blocker && (
              <span className="fs-11 text-amber-soft" role="note">
                {p.blocker}
              </span>
            )}
          </div>
          {p.policy && <p className="fs-10 text-ink-3">{POLICY_NOTE[p.policy]}</p>}
        </div>
      )}
    </section>
  );
}

export function GeneratePanel() {
  const slug = useDirector((s) => s.slug);
  const assets = useDirector((s) => s.assets);
  const projectAspect = useDirector((s) => s.manifest?.output.aspect ?? null);
  const status = useComfy((s) => s.status);
  const statusError = useComfy((s) => s.statusError);
  const draft = useComfy((s) => s.draft);
  const open = useComfy((s) => s.generateOpen);
  const busy = useComfy((s) => s.busy.enqueue);
  if (!slug) return null;
  const live = statusError ? null : status;
  const templates = mergeTemplates(live);
  const inputs = inputCandidates(assets, draft.template);
  const input = draft.inputAssetId ? (assets.find((a) => a.id === draft.inputAssetId) ?? null) : null;
  const tweaking = draft.fromAssetId ? (assets.find((a) => a.id === draft.fromAssetId)?.name ?? null) : null;
  return (
    <GeneratePanelView
      open={open}
      onToggle={openGenerate}
      templates={templates}
      draft={draft}
      onDraft={setDraft}
      projectAspect={projectAspect}
      inputs={inputs}
      tweakingName={tweaking}
      blocker={generateBlocker(
        draft,
        templates.find((t) => t.name === draft.template),
        live,
        input,
        true,
      )}
      policy={live?.settings.policy ?? null}
      busy={busy}
      onEnqueue={() => void enqueueDraft()}
    />
  );
}
