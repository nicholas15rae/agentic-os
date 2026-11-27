import { useEffect, type CSSProperties, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import { useModes } from "./modes-store";
import { ModeIcon } from "./ModeIcon";
import { isOverridden } from "./mode-ui";
import { NOVELTY_MODE_ID, type EffectiveMode } from "./modes";
import { ModePanel, ModePanelView, type ModePanelViewProps } from "@/widgets/tony-mode/ModePanel";
import { useCueRun } from "@/features/cues/player";
import { POPOVER_CARD, POPOVER_W, useAnchoredPopover } from "@/shell/useAnchoredPopover";

/**
 * Top-bar Tony mode switch (Phase 2 Part D): a split pill — (a) the mode trigger that opens the
 * Mode Panel in a popover, (b) the one-tap novelty switch (it replaces the old standalone
 * GabagoolPill in the top bar and still never changes the work mode).
 *
 * The popover is portaled to <body> at z-40 (below the VoiceHUD z-50, the modals z-75…z-85, the ConfirmCard z-90 and the Toasts z-95),
 * position:fixed under the trigger, with an opaque panel and no backdrop filter: it sits over
 * the System Map's WebGL canvas, where a backdrop filter breaks compositing.
 * Open/position/dismiss live in the shared shell/useAnchoredPopover hook (same behaviour).
 */

// Kept exported from here: mode-pill.test.ts imports them from this module.
export { POPOVER_W, popoverPosition } from "@/shell/useAnchoredPopover";

/** The pill's two segments (presentational). */
export function ModePillView({
  effective,
  overridden,
  gabagoolOn,
  open,
  onOpen,
  onToggleNovelty,
  triggerRef,
}: {
  effective: Pick<EffectiveMode, "name" | "icon">;
  overridden: boolean;
  gabagoolOn: boolean;
  open: boolean;
  onOpen: () => void;
  onToggleNovelty: () => void;
  triggerRef?: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <div className="glass-thin flex h-11 items-center gap-0.5 rounded-full p-1">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Tony mode"
        title={`Tony mode: ${effective.name}${overridden ? " (overridden)" : ""}`}
        onClick={onOpen}
        className={`relative flex h-9 items-center gap-1.5 rounded-full px-3 fs-12 transition-colors ${open ? "bg-teal/20 text-teal" : "text-ink-2 hover:text-ink"}`}
      >
        <ModeIcon icon={effective.icon} size={14} />
        <span className="hidden max-w-[9rem] truncate xl:inline">{effective.name}</span>
        <ChevronDown size={12} aria-hidden />
        {overridden && <span aria-hidden className="absolute right-1 top-1 size-1.5 rounded-full bg-amber" />}
      </button>
      <button
        type="button"
        role="switch"
        aria-checked={gabagoolOn}
        aria-label="Gabagool Mode"
        title={gabagoolOn ? "Stop Gabagool Mode" : "Enter Gabagool Mode (novelty: never changes Tony's work mode)"}
        onClick={onToggleNovelty}
        className={`flex h-9 items-center rounded-full px-2.5 fs-13 transition-colors ${gabagoolOn ? "bg-amber/90 text-canvas glow-amber" : "text-ink-2 hover:text-ink"}`}
      >
        <span aria-hidden>{"\u{1F35D}"}</span>
      </button>
    </div>
  );
}

/** The popover's panel (presentational): an opaque card holding the Mode Panel at its full size. */
export function ModePopoverView({ style, ...panel }: Omit<ModePanelViewProps, "size"> & { style?: CSSProperties }) {
  return (
    <div role="dialog" aria-label="Tony mode" style={style} className={POPOVER_CARD}>
      <ModePanelView {...panel} size={{ w: 3, h: 4 }} />
    </div>
  );
}

export function ModePill() {
  const effective = useModes((s) => s.effective);
  const overrides = useModes((s) => s.overrides);
  const gabagoolOn = useCueRun((s) => !!s.running && s.builtin === "gabagool");
  const { open, setOpen, triggerRef: trigger, popRef: pop, pos, width } = useAnchoredPopover(POPOVER_W);

  useEffect(() => {
    if (open && !useModes.getState().loaded) void useModes.getState().load();
  }, [open]);
  // Warm the cue runtime (loaded lazily by the store) so a tap starts the sound within the gesture.
  useEffect(() => void import("@/features/cues/cue-runtime").catch(() => undefined), []);

  return (
    <>
      <ModePillView effective={effective} overridden={isOverridden(overrides)} gabagoolOn={gabagoolOn} open={open} onOpen={() => setOpen((o) => !o)} onToggleNovelty={() => void useModes.getState().toggleNovelty(NOVELTY_MODE_ID)} triggerRef={trigger} />
      {open &&
        pos &&
        createPortal(
          <div ref={pop} className="fixed z-40" style={{ top: pos.top, left: pos.left, width }}>
            <div role="dialog" aria-label="Tony mode" className={POPOVER_CARD}>
              <ModePanel size={{ w: 3, h: 4 }} onDone={() => setOpen(false)} />
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
