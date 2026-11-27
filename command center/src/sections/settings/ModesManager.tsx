import { useEffect, useState, type ReactNode } from "react";
import { Copy, Plus, RotateCcw, Trash2 } from "lucide-react";
import { Card, Input } from "@/components/ui";
import { Segmented } from "@/components/segmented";
import { useModes } from "@/features/modes/modes-store";
import { ModeIcon } from "@/features/modes/ModeIcon";
import { CURIOSITY_OPTS, DISPATCH_OPTS, MODE_ICON_NAMES, TTS_OPTS, VERBOSITY_OPTS, canDelete, duplicateMode, isModeIconName, isOverridden, modifierCount, newModeDraft, switchboardSummary, validateModeDraft } from "@/features/modes/mode-ui";
import { MODIFIER_MAX, isBuiltinMode, type TonyMode } from "@/features/modes/modes";
import { CfgError } from "./os-ui";

/**
 * Settings → Tony Modes (Phase 2 Part D): create, edit, duplicate, delete and switch Tony's modes.
 * Presets are read-only (re-seeded from code by Rust; duplicate one to customise). Every edit is
 * validated here on blur (the same rules as Rust `validate_mode`) and again by Rust on save.
 * Desktop only: Rust owns modes.json.
 */

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface ModeRowProps {
  mode: TonyMode;
  isActive: boolean;
  /** Presets and the active mode can't be deleted. */
  deletable: boolean;
  onUse: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  /** Persist an edited custom mode (rejects with Rust's message). */
  onSave: (m: TonyMode) => Promise<unknown> | void;
  /** Settings → Voice & Triggers (the Gabagool cue's sounds and phrases). */
  onOpenVoice?: () => void;
}

function Field2({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1">
      <span className="label-caps w-36 shrink-0 text-ink-3">{label}</span>
      {children}
    </div>
  );
}

/** One mode (presentational: local draft state only, no store hooks). */
export function ModeRow({ mode, isActive, deletable, onUse, onDuplicate, onDelete, onSave, onOpenVoice }: ModeRowProps) {
  const preset = isBuiltinMode(mode.id);
  const novelty = mode.is_novelty;
  const [name, setName] = useState(mode.name);
  const [icon, setIcon] = useState(mode.icon);
  const [rules, setRules] = useState(mode.prompt_modifier);
  const [err, setErr] = useState<string | null>(null);
  // A save from elsewhere (another window, the phone) replaces the draft.
  useEffect(() => {
    setName(mode.name);
    setIcon(mode.icon);
    setRules(mode.prompt_modifier);
  }, [mode.name, mode.icon, mode.prompt_modifier]);

  const save = (patch: Partial<TonyMode>) => {
    if (preset) return;
    const next = { ...mode, ...patch };
    const bad = validateModeDraft(next);
    setErr(bad);
    if (bad) return;
    if (JSON.stringify(next) === JSON.stringify(mode)) return;
    void Promise.resolve(onSave(next))
      .then(() => setErr(null))
      .catch((e) => setErr(errText(e)));
  };

  return (
    <div className={`r-14 border p-3 ${isActive ? "border-teal/40 bg-teal/[0.04]" : "border-white/[0.06] bg-white/[0.02]"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="grid size-8 shrink-0 place-items-center rounded-full border border-white/10 text-ink">
          <ModeIcon icon={preset ? mode.icon : icon} size={15} />
        </span>
        {preset ? (
          <span className="text-sm font-semibold text-ink">{mode.name}</span>
        ) : (
          <Input value={name} maxLength={32} onChange={(e) => setName(e.target.value)} onBlur={() => save({ name: name.trim() })} aria-label="Mode name" className="!h-8 !w-48 !py-1 !fs-13" />
        )}
        {preset && <span className="label-caps rounded-full border border-white/15 px-1.5 py-0.5 text-ink-3">Preset</span>}
        {novelty && <span className="label-caps rounded-full border border-amber/40 bg-amber/10 px-1.5 py-0.5 text-amber-light">Novelty</span>}
        <div className="ml-auto flex items-center gap-1.5">
          {!novelty &&
            (isActive ? (
              <span className="label-caps rounded-full border border-teal/50 bg-teal/15 px-2 py-0.5 text-teal">Active</span>
            ) : (
              <button type="button" onClick={onUse} className="pill-primary !h-8 !px-3 text-xs">
                Use
              </button>
            ))}
          {!novelty && (
            <button type="button" onClick={onDuplicate} className="flex h-8 items-center gap-1 rounded-full border border-white/10 px-3 text-xs text-ink-2 hover:text-ink" title="Make an editable copy">
              <Copy size={12} aria-hidden /> Duplicate
            </button>
          )}
          {deletable && (
            <button
              type="button"
              onClick={() => confirm(`Delete the “${mode.name}” mode? This can't be undone.`) && onDelete()}
              aria-label={`Delete ${mode.name}`}
              className="grid size-8 place-items-center rounded-full border border-white/10 text-ink-3 hover:border-alert/50 hover:text-alert"
            >
              <Trash2 size={13} aria-hidden />
            </button>
          )}
        </div>
      </div>

      {novelty ? (
        <p className="mt-2 text-xs text-ink-3">
          A novelty overlay: it plays its sound cue and never changes Tony's work mode or his prompt.{" "}
          <button type="button" onClick={onOpenVoice} className="text-teal hover:text-ink">
            Configure sound &amp; phrases → Voice &amp; Triggers
          </button>
        </p>
      ) : (
        <fieldset disabled={preset} className="mt-2 min-w-0 space-y-0.5 disabled:opacity-80">
          {preset && <p className="mb-1 fs-11 text-ink-3">Preset: duplicate to customise.</p>}
          {!preset && (
            <Field2 label="Icon">
              <div role="radiogroup" aria-label="Mode icon" className="flex items-center gap-1">
                {MODE_ICON_NAMES.map((n) => (
                  <button
                    key={n}
                    type="button"
                    role="radio"
                    aria-checked={icon === n}
                    aria-label={n}
                    title={n}
                    onClick={() => (setIcon(n), save({ icon: n }))}
                    className={`grid size-7 place-items-center rounded-full border ${icon === n ? "border-teal/60 bg-teal/15 text-teal" : "border-white/10 text-ink-3 hover:text-ink"}`}
                  >
                    <ModeIcon icon={n} size={13} />
                  </button>
                ))}
              </div>
              <Input
                value={isModeIconName(icon) ? "" : icon}
                maxLength={8}
                placeholder="or emoji"
                onChange={(e) => setIcon(e.target.value)}
                onBlur={(e) => e.target.value.trim() && save({ icon: e.target.value.trim() })}
                aria-label="Mode icon (emoji)"
                className="!h-7 !w-24 !py-0.5 !fs-13"
              />
            </Field2>
          )}
          <Field2 label="Curiosity">
            <Segmented size="sm" label="Curiosity" value={mode.curiosity_level} options={CURIOSITY_OPTS} onChange={(v) => save({ curiosity_level: v })} disabled={preset} />
          </Field2>
          <Field2 label="Verbosity">
            <Segmented size="sm" label="Verbosity" value={mode.verbosity} options={VERBOSITY_OPTS} onChange={(v) => save({ verbosity: v })} disabled={preset} />
          </Field2>
          <Field2 label="Agent dispatch policy">
            <Segmented size="sm" label="Agent dispatch policy" value={mode.agent_dispatch_policy} options={DISPATCH_OPTS} onChange={(v) => save({ agent_dispatch_policy: v })} disabled={preset} />
          </Field2>
          <Field2 label="Narration">
            <Segmented size="sm" label="Narration" value={mode.tts_interrupt_level} options={TTS_OPTS} onChange={(v) => save({ tts_interrupt_level: v })} disabled={preset} />
          </Field2>
          <Field2 label="Switchboard">
            {/* Edited in the Master switchboard card above (on-duty agents and tools). */}
            <span className="text-xs text-ink-2">{switchboardSummary(mode)}</span>
          </Field2>
          <label className="block pt-1">
            <span className="label-caps text-ink-3">Behaviour rules (injected into Tony's prompt)</span>
            <textarea
              value={rules}
              maxLength={MODIFIER_MAX}
              rows={2}
              onChange={(e) => setRules(e.target.value.replace(/[\r\n]+/g, " "))}
              onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), e.currentTarget.blur())}
              onBlur={() => save({ prompt_modifier: rules.trim() })}
              placeholder={preset ? "" : "e.g. Keep answers about the build; push back when a plan looks too big."}
              className="field mt-1 min-h-14 resize-y !py-2 !fs-13"
            />
            <span className="mt-0.5 block text-right font-mono fs-10 text-ink-3">{modifierCount(rules)}</span>
          </label>
        </fieldset>
      )}
      <CfgError error={err} />
    </div>
  );
}

/** The Settings card (store-reading). */
export function ModesManagerCard({ onOpenVoice }: { onOpenVoice?: () => void }) {
  const modes = useModes((s) => s.modes);
  const activeId = useModes((s) => s.activeId);
  const overrides = useModes((s) => s.overrides);
  const error = useModes((s) => s.error);
  const loaded = useModes((s) => s.loaded);
  useEffect(() => {
    void useModes.getState().load();
  }, []);
  const st = useModes.getState;
  const quiet = (p: Promise<unknown>) => void p.catch(() => undefined); // shown via `error`

  return (
    <Card
      title="Tony modes"
      hint="A mode is a small rule set swapped into Tony's prompt on his next turn: no extra model, no restart. Presets can't be edited or deleted; duplicate one to make it yours."
      action={
        <>
          {isOverridden(overrides) && (
            <button type="button" onClick={() => quiet(st().reset())} className="pill-glass !h-8 text-xs">
              <RotateCcw size={13} /> Reset overrides
            </button>
          )}
          <button type="button" onClick={() => quiet(st().upsert(newModeDraft(st().modes), true))} className="pill-glass !h-8 text-xs" disabled={!loaded}>
            <Plus size={13} /> New mode
          </button>
        </>
      }
    >
      {!loaded && <p className="mb-2 text-xs text-ink-3">Loading Tony's modes…</p>}
      <div className="space-y-2">
        {modes.map((m) => (
          <ModeRow
            key={m.id}
            mode={m}
            isActive={m.id === activeId}
            deletable={canDelete(m, activeId)}
            onUse={() => quiet(st().setActive(m.id))}
            onDuplicate={() => quiet(st().duplicate(m.id, duplicateMode(st().modes, m).name))}
            onDelete={() => quiet(st().remove(m.id))}
            onSave={(next) => st().upsert(next, false)}
            onOpenVoice={onOpenVoice}
          />
        ))}
      </div>
      <CfgError error={error} />
    </Card>
  );
}
