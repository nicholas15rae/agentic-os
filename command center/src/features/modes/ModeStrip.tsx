import { RotateCcw } from "lucide-react";
import { Segmented } from "@/components/segmented";
import { ModeIcon } from "./ModeIcon";
import { CURIOSITY_OPTS, switcherModes } from "./mode-ui";
import type { Curiosity, TonyMode } from "./modes";

/**
 * The phone HUD's Tony mode row (Phase 2 Part D): work-mode chips (teal when active, distinct
 * from the amber thread pills above them), a compact Curiosity Dial, and Reset when a manual
 * change is in place. Presentational: the HUD passes the mirror's state and its write path.
 */
export function ModeStripView({
  modes,
  activeId,
  curiosity,
  overridden,
  onSelect,
  onCuriosity,
  onReset,
}: {
  modes: readonly TonyMode[];
  activeId: string;
  curiosity: Curiosity;
  overridden: boolean;
  onSelect: (id: string) => void;
  onCuriosity: (c: Curiosity) => void;
  onReset: () => void;
}) {
  const { work } = switcherModes(modes);
  return (
    <div className="space-y-1.5">
      <div role="radiogroup" aria-label="Tony mode" className="-mx-3 flex gap-1.5 overflow-x-auto px-3 pb-1">
        {work.map((m) => {
          const on = m.id === activeId;
          return (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={m.name}
              onClick={() => !on && onSelect(m.id)}
              className={`flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs ${on ? "border-teal/60 bg-teal/15 text-ink" : "border-white/10 text-ink-2"}`}
            >
              <ModeIcon icon={m.icon} size={12} className={on ? "text-teal" : ""} />
              {m.name}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        <span className="label-caps text-ink-3">Curiosity</span>
        <Segmented size="sm" label="Tony mode curiosity" value={curiosity} options={CURIOSITY_OPTS} onChange={onCuriosity} />
        {overridden && (
          <button type="button" onClick={onReset} className="ml-auto flex h-7 items-center gap-1 rounded-full border border-amber/40 px-2.5 text-[11px] text-amber-light">
            <RotateCcw size={11} aria-hidden /> Reset
          </button>
        )}
      </div>
    </div>
  );
}
