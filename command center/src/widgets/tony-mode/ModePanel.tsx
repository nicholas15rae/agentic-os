import { useEffect } from "react";
import { RotateCcw, Settings2 } from "lucide-react";
import type { WidgetProps } from "@/core/widgets/types";
import { WidgetHeader } from "@/components/WidgetHeader";
import { Segmented } from "@/components/segmented";
import { useModes, type OverridePatch } from "@/features/modes/modes-store";
import { ModeIcon } from "@/features/modes/ModeIcon";
import { CURIOSITY_OPTS, DISPATCH_OPTS, LEARNING_DISPATCH_LOCK, isOverridden, panelLayout, switcherModes } from "@/features/modes/mode-ui";
import { isLearningMode } from "@/features/modes/modes";
import type { EffectiveMode, ModeOverrides, TonyMode } from "@/features/modes/modes";
import { useCueRun } from "@/features/cues/player";
import { requestSettingsTab } from "@/sections/settings/settings-tab";

/**
 * Tony Mode panel (Phase 2 Part D): the work-mode switcher, the Gabagool novelty switch (an
 * overlay that never changes the work mode), and — when tall enough — the Curiosity Dial and the
 * Agent Dispatch gate as temporary overrides with "Reset to mode default".
 *
 * Changes apply from Tony's next turn: Rust swaps the MODE block into his prompt (no model load,
 * no restart). No glass or backdrop classes here: the panel also renders inside the ModePill
 * popover over the System Map's WebGL canvas.
 */

const NARRATION = ["Silent", "Milestones", "Handoffs", "Verbose"];

export interface ModePanelViewProps {
  modes: readonly TonyMode[];
  activeId: string;
  effective: EffectiveMode;
  overrides: ModeOverrides;
  /** The Gabagool cue is playing. */
  gabagoolOn: boolean;
  size: { w: number; h: number };
  error?: string | null;
  onSelect: (id: string) => void;
  onToggleNovelty: (id: string) => void;
  onOverride: (patch: OverridePatch) => void;
  onReset: () => void;
  onManage?: () => void;
}

const GRID = { "cols-2": "grid grid-cols-2 gap-1.5", "cols-3": "grid grid-cols-3 gap-1.5", row: "flex gap-1.5 overflow-x-auto pb-0.5" } as const;

/** Presentational (no store hooks): rendered by the widget and the ModePill popover. */
export function ModePanelView({ modes, activeId, effective, overrides, gabagoolOn, size, error, onSelect, onToggleNovelty, onOverride, onReset, onManage }: ModePanelViewProps) {
  const layout = panelLayout(size);
  const { work, novelty } = switcherModes(modes);
  const overridden = isOverridden(overrides);
  const curiosity = overrides.curiosity ?? effective.curiosity;
  const dispatch = overrides.dispatch ?? effective.dispatch;
  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <WidgetHeader
        title="Tony Mode"
        status={
          <>
            <span className="truncate fs-12 text-ink">{effective.name}</span>
            {overridden && (
              <span className="label-caps rounded-full border border-amber/50 bg-amber/10 px-1.5 py-0.5 text-amber-light" title={`Overridden: ${effective.overridden.join(", ") || "manual change"}`}>
                Override
              </span>
            )}
          </>
        }
      />

      <div role="radiogroup" aria-label="Tony mode" className={GRID[layout.grid]}>
        {work.map((m) => {
          const on = m.id === activeId;
          return (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={m.name}
              title={m.name}
              onClick={() => !on && onSelect(m.id)}
              className={`flex h-9 min-w-0 shrink-0 items-center gap-1.5 r-10 border px-2.5 fs-12 transition-colors ${
                layout.iconsOnly ? "justify-center" : ""
              } ${on ? "border-teal/60 bg-teal/15 text-ink" : "border-white/10 bg-white/[0.02] text-ink-2 hover:text-ink"}`}
            >
              <ModeIcon icon={m.icon} size={14} className={on ? "text-teal" : ""} />
              {!layout.iconsOnly && <span className="truncate">{m.name}</span>}
            </button>
          );
        })}
      </div>

      {novelty.length > 0 && <div className="h-px shrink-0 bg-white/10" aria-hidden />}
      {novelty.map((m) => (
        <button
          key={m.id}
          type="button"
          role="switch"
          aria-checked={gabagoolOn}
          aria-label={`${m.name} (novelty: plays the sound cue, never changes the work mode)`}
          title={gabagoolOn ? `Stop ${m.name}` : `Start ${m.name}`}
          onClick={() => onToggleNovelty(m.id)}
          className={`flex h-9 shrink-0 items-center gap-2 r-10 px-2.5 fs-12 transition-colors ${
            gabagoolOn ? "bg-amber/90 text-canvas glow-amber" : "border border-white/10 bg-white/[0.02] text-ink-2 hover:text-ink"
          }`}
        >
          <ModeIcon icon={m.icon} size={14} />
          {!layout.iconsOnly && <span className="truncate">{m.name}</span>}
          <span className="label-caps ml-auto">{gabagoolOn ? "On" : "Off"}</span>
        </button>
      ))}

      {layout.dials && (
        <div className="space-y-1.5 border-t border-white/5 pt-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="label-caps w-16 text-ink-3">Curiosity</span>
            <Segmented size="sm" label="Tony mode curiosity" value={curiosity} options={CURIOSITY_OPTS} onChange={(v) => onOverride({ curiosity: v })} />
          </div>
          <div className="flex flex-wrap items-center gap-2" title={isLearningMode(effective) ? LEARNING_DISPATCH_LOCK : undefined}>
            <span className="label-caps w-16 text-ink-3">Dispatch</span>
            <Segmented size="sm" label="Tony mode dispatch" value={isLearningMode(effective) ? "surface_only" : dispatch} options={DISPATCH_OPTS} onChange={(v) => onOverride({ dispatch: v })} disabled={isLearningMode(effective)} />
          </div>
          {overridden && (
            <button type="button" onClick={onReset} className="flex h-7 items-center gap-1.5 rounded-full border border-amber/40 px-2.5 fs-11 text-amber-light hover:bg-amber/10">
              <RotateCcw size={11} aria-hidden /> Reset to mode default
            </button>
          )}
        </div>
      )}

      {layout.footer && (
        <div className="mt-auto flex items-center gap-2 border-t border-white/5 pt-2 fs-11 text-ink-3">
          <span title="Background build narration (Settings → Voice & Triggers)">Narration · {NARRATION[effective.feedback_level] ?? "Milestones"}</span>
          {onManage && (
            <button type="button" onClick={onManage} className="ml-auto flex items-center gap-1 text-teal hover:text-ink">
              <Settings2 size={11} aria-hidden /> Manage modes…
            </button>
          )}
        </div>
      )}

      {error && <p className="fs-11 text-alert">{error}</p>}
      <p aria-live="polite" className="fs-10 text-ink-3">
        Applies from Tony's next turn
      </p>
    </div>
  );
}

/** Deep link to Settings → Tony Modes (the PrivacyPill pattern; nav loads lazily: it reads `location`). */
export function openModesManager(): void {
  requestSettingsTab("modes"); // also switches a Settings view that is already open
  void import("@/stores/nav").then(({ useNav }) => useNav.getState().go("settings"));
}

const quiet = (p: Promise<unknown>) => void p.catch(() => undefined); // errors surface in the store

/** The store-reading panel (widget + popover). */
export function ModePanel({ size, onDone }: { size: { w: number; h: number }; onDone?: () => void }) {
  const modes = useModes((s) => s.modes);
  const activeId = useModes((s) => s.activeId);
  const effective = useModes((s) => s.effective);
  const overrides = useModes((s) => s.overrides);
  const error = useModes((s) => s.error);
  const loaded = useModes((s) => s.loaded);
  const gabagoolOn = useCueRun((s) => !!s.running && s.builtin === "gabagool");
  useEffect(() => {
    if (!loaded) void useModes.getState().load();
  }, [loaded]);
  const st = useModes.getState;
  return (
    <ModePanelView
      modes={modes}
      activeId={activeId}
      effective={effective}
      overrides={overrides}
      gabagoolOn={gabagoolOn}
      size={size}
      error={error}
      onSelect={(id) => (quiet(st().setActive(id)), onDone?.())}
      onToggleNovelty={(id) => quiet(st().toggleNovelty(id))}
      onOverride={(patch) => quiet(st().override(patch))}
      onReset={() => quiet(st().reset())}
      onManage={() => (openModesManager(), onDone?.())}
    />
  );
}

export default function TonyModeWidget({ size }: WidgetProps) {
  return <ModePanel size={size} />;
}
