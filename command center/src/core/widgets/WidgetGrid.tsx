import { Component, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AppWindow, Expand, GripVertical, Lock, Maximize2, Palette, Shrink, X } from "lucide-react";
import { getWidget } from "./registry";
import { GRID_COLS, GRID_ROWS, activeItems, type WidgetWindow } from "./layout-store";
import { useSurface } from "./surface-context";
import { LOCKED_MIN_SCALE } from "./locks";
import { useDefaultFrame } from "@/features/appearance/use-tokens";
import { isLockedWidget } from "./registry";
import { placePushing } from "./pages";
import type { WidgetDefinition, WidgetInstance } from "./types";
import { ALIGN_CLASS, DEFAULT_GLASS_ALPHA, FIT_MIN, FONT_CLASS, clampScale, frameOf, opacityFor, overflowRatio, type Align, type DisplayMode, type FontChoice, type Frame } from "./look";
import { useWidgetBadges } from "./widget-badges";
import { useMediaQuery, usePrefersReducedMotion } from "@/lib/use-media-query";
import { useWallpapers } from "@/features/wallpaper/wallpaper-store";

/**
 * 12×8 snap grid on desktop/tablet; a single scrolling column on phones.
 * Empty cells are intentional — they let the wallpaper breathe.
 * In edit mode, drag the grip to move and the corner to resize (pointer events,
 * so it works with mouse and touch); neighbours move aside.
 *
 * Section pass: every widget has its own look (frame, font, size, colour, alignment, glass
 * opacity per wallpaper), its content scales down to fit its cell, a tap focuses it (solid and
 * readable, with an expand button; click away / Esc returns it to glass), and it can be shown
 * full, compact or as an app icon that opens in a movable, resizable window.
 */
export function WidgetGrid() {
  const useLayout = useSurface();
  const activePage = useLayout((s) => s.activePage);
  return (
    <>
      <PageBoard key={activePage} />
      <WidgetWindows />
    </>
  );
}

/** One page's board. Keyed by page id, so a page switch remounts it and fades it in. */
function PageBoard() {
  const useLayout = useSurface();
  // `activeItems` returns the stored array, so this only re-renders when the page's items change.
  const instances = useLayout(activeItems);
  const editing = useLayout((s) => s.editing);
  const compact = useMediaQuery("(max-width: 767px)");
  const reduced = usePrefersReducedMotion();
  const gridRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!reduced) gridRef.current?.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: "ease-out" });
  }, [reduced]);

  // Click away / Esc: the focused widget returns to its resting glass.
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!useLayout.getState().focused) return;
      const t = e.target as HTMLElement | null;
      if (!t?.closest?.("[data-widget],[data-widget-window]")) useLayout.getState().setFocused(null);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && useLayout.getState().setFocused(null);
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", esc);
    };
  }, [useLayout]);

  // Touch: press and hold an empty spot or a widget for half a second to edit the layout.
  const hold = useRef<{ t: number; x: number; y: number } | null>(null);
  const holdStart = (e: React.PointerEvent) => {
    holdEnd();
    if (editing || e.pointerType === "mouse" || !e.isPrimary) return;
    const t = e.target as HTMLElement | null;
    // Holding a button, slider or field (or anything in a portal opened from a widget) is that control's.
    if (!t || !e.currentTarget.contains(t) || t.closest(HOLD_IGNORE)) return;
    const x = e.clientX;
    const y = e.clientY;
    hold.current = {
      x,
      y,
      t: window.setTimeout(() => {
        hold.current = null;
        useLayout.getState().setEditing(true);
        navigator.vibrate?.(12);
      }, LONG_PRESS_MS),
    };
  };
  const holdMove = (e: React.PointerEvent) => {
    const h = hold.current;
    if (h && Math.hypot(e.clientX - h.x, e.clientY - h.y) > 10) holdEnd();
  };
  const holdEnd = () => {
    if (hold.current) window.clearTimeout(hold.current.t);
    hold.current = null;
  };
  useEffect(() => holdEnd, []);
  const holdProps = { onPointerDown: holdStart, onPointerMove: holdMove, onPointerUp: holdEnd, onPointerCancel: holdEnd };

  if (compact) {
    const order = (i: WidgetInstance) => getWidget(i.widgetId)?.compactOrder ?? i.row;
    const ordered = [...instances].sort((a, b) => order(a) - order(b) || a.col - b.col);
    const icons = ordered.filter((i) => i.display === "icon");
    return (
      <div ref={gridRef} className="flex flex-col gap-3 px-4 pb-40 pt-2" {...holdProps}>
        {icons.length > 0 && (
          <div className="grid grid-cols-4 gap-3">
            {icons.map((inst) => (
              <WidgetCell key={inst.instanceId} inst={inst} editing={editing} compact />
            ))}
          </div>
        )}
        {ordered
          .filter((i) => i.display !== "icon")
          .map((inst) => (
            <WidgetCell key={inst.instanceId} inst={inst} editing={editing} compact />
          ))}
      </div>
    );
  }

  return (
    <div
      ref={gridRef}
      className="relative grid h-full gap-4 px-6 pb-4 xl:gap-5 xl:px-8"
      {...holdProps}
      style={{ gridTemplateColumns: `repeat(${GRID_COLS}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${GRID_ROWS}, minmax(0, 1fr))` }}
    >
      {editing && <GridGuides />}
      {instances.map((inst) => (
        <WidgetCell key={inst.instanceId} inst={inst} editing={editing} gridRef={gridRef} />
      ))}
    </div>
  );
}

/** Press-and-hold to enter Edit layout on touch screens. */
export const LONG_PRESS_MS = 500;
/** Presses that belong to a control, never to the layout hold. */
export const HOLD_IGNORE = "button,a,input,textarea,select,label,[role=slider],[role=button],[role=switch],[contenteditable],[data-safety],[data-no-hold]";

function GridGuides() {
  return (
    <>
      {Array.from({ length: GRID_COLS * GRID_ROWS }, (_, i) => (
        <div
          key={i}
          aria-hidden
          className="pointer-events-none r-14 border border-dashed border-white/[0.07]"
          style={{ gridColumn: (i % GRID_COLS) + 1, gridRow: Math.floor(i / GRID_COLS) + 1 }}
        />
      ))}
    </>
  );
}

type DragMode = "move" | "resize";

const FRAME_CLASS: Record<Frame, string> = {
  glass: "glass r-20",
  ultra: "glass-ultra r-20",
  solid: "glass-chat r-20",
  frameless: "",
};

/** The glass background at a per-wallpaper opacity (only when the widget set one). */
function glassStyle(frame: Frame, alpha: number): React.CSSProperties | undefined {
  if (frame !== "glass" || alpha === DEFAULT_GLASS_ALPHA) return undefined;
  return { background: `linear-gradient(rgba(24, 28, 38, ${alpha}), rgba(24, 28, 38, ${alpha})) padding-box, linear-gradient(to bottom right, rgba(255,255,255,0.16), rgba(255,255,255,0.03)) border-box` };
}

function WidgetCell({
  inst,
  editing,
  compact,
  gridRef,
}: {
  inst: WidgetInstance;
  editing: boolean;
  compact?: boolean;
  gridRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const useLayout = useSurface();
  const def = getWidget(inst.widgetId);
  const locked = isLockedWidget(inst.widgetId);
  const defaultFrame = useDefaultFrame();
  const { place, remove, setGlass, setFocused, openWindow } = useLayout.getState();
  const focused = useLayout((s) => s.focused === inst.instanceId);
  const windowed = useLayout((s) => s.windows.some((w) => w.instanceId === inst.instanceId));
  const wallpaperId = useWallpapers((s) => s.currentId);
  const [ghost, setGhost] = useState<Pick<WidgetInstance, "col" | "row" | "w" | "h"> | null>(null);
  const [ghostValid, setGhostValid] = useState(true);
  const [styling, setStyling] = useState<DOMRect | null>(null);
  const drag = useRef<{ mode: DragMode; startX: number; startY: number; cellW: number; cellH: number } | null>(null);

  const onPointerDown = useCallback(
    (mode: DragMode) => (e: React.PointerEvent) => {
      const grid = gridRef?.current;
      if (!grid) return;
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      const rect = grid.getBoundingClientRect();
      drag.current = { mode, startX: e.clientX, startY: e.clientY, cellW: rect.width / GRID_COLS, cellH: rect.height / GRID_ROWS };
    },
    [gridRef],
  );

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dc = Math.round((e.clientX - d.startX) / d.cellW);
    const dr = Math.round((e.clientY - d.startY) / d.cellH);
    // Content scales to fit, so any widget can shrink to a single cell.
    const min = { w: 1, h: 1 };
    const max = def?.maxSize ?? { w: GRID_COLS, h: GRID_ROWS };
    const next =
      d.mode === "move"
        ? { col: inst.col + dc, row: inst.row + dr, w: inst.w, h: inst.h }
        : {
            col: inst.col,
            row: inst.row,
            w: Math.min(max.w, Math.max(min.w, inst.w + dc)),
            h: Math.min(max.h, Math.max(min.h, inst.h + dr)),
          };
    setGhost(next);
    // Valid when it fits, pushing neighbours aside if needed.
    setGhostValid(placePushing(activeItems(useLayout.getState()), inst.instanceId, next) !== null);
  };

  const onPointerUp = () => {
    if (ghost) place(inst.instanceId, ghost);
    drag.current = null;
    setGhost(null);
  };

  useEffect(() => {
    if (!editing) {
      setGhost(null);
      setStyling(null);
    }
  }, [editing]);

  if (!def) {
    return (
      <div className="glass r-14 p-4 text-sm text-ink-2" style={compact ? undefined : area(inst)}>
        Missing widget “{inst.widgetId}”.{" "}
        <button className="text-amber underline" onClick={() => remove(inst.instanceId)}>
          Remove
        </button>
      </div>
    );
  }

  const icon = inst.display === "icon";
  const frame = frameOf(inst, !!def.chromeless, defaultFrame);
  const alpha = opacityFor(inst.look, wallpaperId);
  const restingFrame = focused ? "solid" : frame;
  const frameless = restingFrame === "frameless";

  const toolbar = editing && (
    <>
      <div className="absolute inset-x-2 top-2 z-20 flex items-center justify-between gap-1">
        {!compact ? (
          <button
            aria-label={`Move ${def.title}`}
            className="well flex min-w-0 cursor-grab touch-none items-center gap-1 rounded-full px-2 py-1 text-ink-2 active:cursor-grabbing"
            onPointerDown={onPointerDown("move")}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            <GripVertical size={14} />
            {!icon && <span className="label-caps truncate">{def.title}</span>}
          </button>
        ) : (
          <span className="label-caps truncate text-ink-2">{def.title}</span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {!icon && !def.chromeless && frame !== "solid" && frame !== "frameless" && (
            <button
              role="switch"
              aria-checked={frame === "ultra"}
              aria-label={`Ultra-glass transparency for ${def.title}`}
              title={frame === "ultra" ? "Ultra glass: on" : "Ultra glass: off"}
              onClick={() => setGlass(inst.instanceId, frame !== "ultra")}
              className={`well flex h-7 items-center gap-1.5 rounded-full pl-1.5 pr-2.5 fs-10 font-mono uppercase tracking-wider ${frame === "ultra" ? "text-teal" : "text-ink-2"}`}
            >
              <span className={`relative h-3.5 w-6 rounded-full transition-colors ${frame === "ultra" ? "bg-teal/80" : "bg-white/15"}`}>
                <span className={`absolute top-0.5 size-2.5 rounded-full bg-white shadow transition-[left] duration-200 ${frame === "ultra" ? "left-3" : "left-0.5"}`} />
              </span>
              Glass
            </button>
          )}
          <button
            aria-label={`Style ${def.title}`}
            aria-expanded={!!styling}
            title="Look: frame, font, size, colour, opacity, icon / compact / full"
            onClick={(e) => {
              // Read the widget's box now: the event's target is gone once React runs the updater.
              const rect = (e.currentTarget.closest("[data-widget]") as HTMLElement | null)?.getBoundingClientRect() ?? null;
              setStyling((v) => (v ? null : rect));
            }}
            className="well grid size-7 place-items-center rounded-full text-ink-2 hover:text-ink"
          >
            <Palette size={13} />
          </button>
          {locked ? (
            <span className="well grid size-7 place-items-center rounded-full text-amber-soft" title="Safety control: it can move, but it can't be hidden or removed" aria-label={`${def.title} is a safety control`}>
              <Lock size={12} />
            </span>
          ) : (
            <button aria-label={`Remove ${def.title}`} className="well grid size-7 place-items-center rounded-full text-ink-2 hover:text-alert" onClick={() => remove(inst.instanceId)}>
              <X size={14} />
            </button>
          )}
        </div>
      </div>
      {!compact && (
        <button
          aria-label={`Resize ${def.title}`}
          className="well absolute bottom-2 right-2 z-20 grid size-7 cursor-nwse-resize touch-none place-items-center rounded-full text-ink-2"
          onPointerDown={onPointerDown("resize")}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <Maximize2 size={12} className="rotate-90" />
        </button>
      )}
      {styling && <StylePanel inst={inst} def={def} wallpaperId={wallpaperId} anchor={styling} onClose={() => setStyling(null)} />}
    </>
  );

  return (
    <>
      {ghost && (
        <div
          aria-hidden
          className={`pointer-events-none z-10 r-20 border-2 ${ghostValid ? "border-teal/70 bg-teal/10" : "border-alert/70 bg-alert/10"}`}
          style={area(ghost)}
        />
      )}
      {icon ? (
        <section data-widget={inst.instanceId} aria-label={def.title} className={`relative min-h-0 ${editing ? "r-20 ring-1 ring-amber/40" : ""}`} style={compact ? undefined : area(inst)}>
          <IconTile inst={inst} def={def} onOpen={() => !editing && openWindow(inst.instanceId)} />
          {!windowed && (
            <div hidden aria-hidden className="pointer-events-none absolute size-0 overflow-hidden">
              <WidgetBody inst={inst} def={def} legible={false} />
            </div>
          )}
          {toolbar}
        </section>
      ) : (
        <section
          data-widget={inst.instanceId}
          data-safety={locked ? "panel" : undefined}
          aria-label={def.title}
          onClickCapture={() => !editing && !focused && setFocused(inst.instanceId)}
          onFocusCapture={() => !editing && !focused && setFocused(inst.instanceId)}
          className={[
            // Clipped: a widget's content never spills over its neighbours (it scales to fit instead).
            "group relative min-h-0 overflow-hidden",
            editing && frameless ? "r-20 outline-1 outline-dashed outline-white/20" : FRAME_CLASS[restingFrame],
            "transition-[background-color,backdrop-filter,box-shadow] duration-300",
            compact ? (frameless ? "" : "min-h-40") : "",
            editing ? "ring-1 ring-amber/40" : focused ? "ring-1 ring-teal/50" : "",
          ].join(" ")}
          style={{ ...(compact ? {} : area(inst)), ...(focused ? {} : glassStyle(frame, alpha)) }}
        >
          <div className={`h-full ${frameless ? "" : "p-4 xl:p-5"} ${editing || focused ? "pt-11 xl:pt-11" : ""}`}>
            {/* #12: one live copy only: a widget opened larger lives in its window meanwhile. */}
            {windowed ? <div className="grid h-full place-items-center text-xs text-ink-3">Open in a window</div> : <WidgetBody inst={inst} def={def} legible={!focused && restingFrame !== "solid"} />}
          </div>
          {focused && !editing && (
            <div className="absolute right-2 top-2 z-20 flex gap-1">
              <button aria-label={`Open ${def.title} larger`} title="Open larger" onClick={() => openWindow(inst.instanceId)} className="well grid size-7 place-items-center rounded-full text-ink-2 hover:text-ink">
                <Expand size={12} />
              </button>
              <button aria-label={`Return ${def.title} to glass`} title="Back to glass (or click away)" onClick={(e) => (e.stopPropagation(), setFocused(null))} className="well grid size-7 place-items-center rounded-full text-ink-2 hover:text-ink">
                <Shrink size={12} />
              </button>
            </div>
          )}
          {toolbar}
        </section>
      )}
    </>
  );
}

/** The widget itself, in its look, with content zoomed down to fit its box (never up). */
function WidgetBody({ inst, def, legible, forceFull }: { inst: WidgetInstance; def: WidgetDefinition<any>; legible: boolean; forceFull?: boolean }) {
  const setConfig = useSurface().getState().setConfig;
  const setBadge = useWidgetBadges((s) => s.set);
  const look = inst.look ?? {};
  const scale = clampScale(look.scale);
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(1);

  // A new box size starts again at full size; then shrink while the content overflows. Ratios are
  // measured inside one element, so they don't depend on the zoom itself (no feedback loop).
  useLayoutEffect(() => {
    const o = outer.current;
    if (!o || typeof ResizeObserver === "undefined") return;
    let last = `${o.clientWidth}x${o.clientHeight}`;
    const ro = new ResizeObserver(() => {
      const k = `${o.clientWidth}x${o.clientHeight}`;
      if (k !== last) {
        last = k;
        setFit(1);
      }
    });
    ro.observe(o);
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => setFit(1), [scale, look.font]);
  useEffect(() => {
    const i = inner.current;
    if (!i || typeof MutationObserver === "undefined") return;
    let t: number | undefined;
    const mo = new MutationObserver(() => {
      window.clearTimeout(t);
      t = window.setTimeout(() => setFit(1), 250);
    });
    mo.observe(i, { childList: true, subtree: true, characterData: true });
    return () => {
      window.clearTimeout(t);
      mo.disconnect();
    };
  }, []);
  // Clear this widget's icon badge when it goes away.
  useEffect(() => () => useWidgetBadges.getState().set(inst.instanceId, null), [inst.instanceId]);
  useLayoutEffect(() => {
    const check = () => {
      const i = inner.current;
      if (!i || document.hidden) return;
      const r = overflowRatio(i);
      if (r > 1.02) setFit((f) => Math.max(FIT_MIN, f / r));
    };
    check();
    // Content that arrives later (a list loading) is caught too; cheap, and paused while hidden.
    const t = window.setInterval(check, 2000);
    return () => window.clearInterval(t);
  }, [fit, scale]);

  const Widget = def.component;
  const size = forceFull && inst.fullSize ? inst.fullSize : { w: inst.w, h: inst.h };
  return (
    <div ref={outer} className="h-full w-full overflow-auto" style={{ scrollbarGutter: "stable" }}>
      <div
        ref={inner}
        className={`h-full w-full ${FONT_CLASS[look.font ?? "sans"]} ${look.align ? ALIGN_CLASS[look.align] : ""} ${legible ? "legible" : ""}`}
        style={{ zoom: def.locked ? Math.max(LOCKED_MIN_SCALE, scale * fit) : scale * fit, color: (!def.locked && look.color) || undefined }}
      >
        <WidgetBoundary name={def.title}>
          <Suspense fallback={<div className="h-full animate-pulse r-14 bg-white/[0.03]" />}>
            <Widget
              instanceId={inst.instanceId}
              config={{ ...def.defaultConfig, ...inst.config }}
              setConfig={(patch) => setConfig(inst.instanceId, patch)}
              size={size}
              display={forceFull ? "full" : (inst.display ?? "full")}
              setBadge={(b) => setBadge(inst.instanceId, b)}
            />
          </Suspense>
        </WidgetBoundary>
      </div>
    </div>
  );
}

/** Icon mode: an app-sized tile with the widget's icon, name and badge / live value. */
function IconTile({ inst, def, onOpen }: { inst: WidgetInstance; def: WidgetDefinition<any>; onOpen: () => void }) {
  const badge = useWidgetBadges((s) => s.badges[inst.instanceId]);
  const Icon = def.icon;
  return (
    <button onClick={onOpen} className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-center" aria-label={`Open ${def.title}${badge ? ` (${badge})` : ""}`} title={def.title}>
      <span className="glass relative grid aspect-square w-[min(4.5rem,70%)] place-items-center rounded-[22%]">
        <Icon size={26} className="text-teal" aria-hidden />
        {badge && <span className="absolute -right-1.5 -top-1.5 min-w-5 rounded-full bg-amber px-1.5 font-mono fs-10 leading-5 text-canvas">{badge}</span>}
      </span>
      <span className="legible max-w-full truncate px-1 fs-11 font-medium text-ink">{inst.look?.frame === "frameless" ? "" : def.title}</span>
    </button>
  );
}

const FRAMES: { id: Frame; label: string }[] = [
  { id: "glass", label: "Glass" },
  { id: "ultra", label: "Clear" },
  { id: "solid", label: "Solid" },
  { id: "frameless", label: "None" },
];
const FONTS: { id: FontChoice; label: string }[] = [
  { id: "sans", label: "Sans" },
  { id: "mono", label: "Mono" },
  { id: "display", label: "Display" },
];
const ALIGNS: { id: Align; label: string }[] = [
  { id: "start", label: "Left" },
  { id: "center", label: "Centre" },
  { id: "end", label: "Right" },
];
const DISPLAYS: { id: DisplayMode; label: string }[] = [
  { id: "full", label: "Full" },
  { id: "compact", label: "Compact" },
  { id: "icon", label: "Icon" },
];

/** Edit mode → the palette button: this widget's look, saved with the page. */
function StylePanel({ inst, def, wallpaperId, anchor, onClose }: { inst: WidgetInstance; def: WidgetDefinition<any>; wallpaperId: string; anchor: DOMRect; onClose: () => void }) {
  const { setLook, setDisplay } = useSurface().getState();
  const locked = isLockedWidget(inst.widgetId);
  const [note, setNote] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panel.current?.focus();
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  const look = inst.look ?? {};
  const frame = frameOf(inst, !!def.chromeless, useDefaultFrame());
  const seg = (on: boolean) => `rounded-full border px-2.5 py-1 fs-11 ${on ? "border-teal/60 bg-teal/15 text-teal" : "border-white/10 text-ink-2 hover:text-ink"}`;
  // Floats above the page (a widget clips its own content), next to the widget, kept on screen.
  const W = 256;
  const left = Math.max(8, Math.min(window.innerWidth - W - 8, anchor.right + 8 + W > window.innerWidth ? anchor.left - W - 8 : anchor.right + 8));
  const top = Math.max(8, Math.min(window.innerHeight - 440, anchor.top));
  return createPortal(
    <div ref={panel} tabIndex={-1} className="glass-chat fixed z-[85] w-64 space-y-2.5 r-14 p-3 text-left outline-none" style={{ left, top }} role="dialog" aria-label={`${def.title} look`} onPointerDown={(e) => e.stopPropagation()}>
      <div className="flex items-center">
        <span className="label-caps text-amber-soft">Look</span>
        <button className="ml-auto text-ink-3 hover:text-ink" onClick={onClose} aria-label="Close the look panel">
          <X size={13} />
        </button>
      </div>
      <Row label="Show as">
        {DISPLAYS.filter((d) => !(locked && d.id === "icon")).map((d) => (
          <button key={d.id} className={seg((inst.display ?? "full") === d.id)} onClick={() => setNote(setDisplay(inst.instanceId, d.id) ? null : "No room on this page for that size.")}>
            {d.id === "icon" && <AppWindow size={10} className="mr-1 inline" />}
            {d.label}
          </button>
        ))}
      </Row>
      <Row label="Frame">
        {FRAMES.map((f) => (
          <button key={f.id} className={seg(frame === f.id)} onClick={() => setLook(inst.instanceId, { frame: f.id })}>
            {f.label}
          </button>
        ))}
      </Row>
      {frame === "glass" && (
        <Row label="Opacity">
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(opacityFor(look, wallpaperId) * 100)}
            onChange={(e) => setLook(inst.instanceId, { opacity: { [wallpaperId]: Number(e.target.value) / 100 } })}
            className="w-full"
            aria-label="Glass opacity on this wallpaper"
            title="Saved for this wallpaper"
          />
        </Row>
      )}
      <Row label="Font">
        {FONTS.map((f) => (
          <button key={f.id} className={seg((look.font ?? "sans") === f.id)} onClick={() => setLook(inst.instanceId, { font: f.id })}>
            {f.label}
          </button>
        ))}
      </Row>
      <Row label="Size">
        <input type="range" min={60} max={160} step={5} value={Math.round(clampScale(look.scale) * 100)} onChange={(e) => setLook(inst.instanceId, { scale: Number(e.target.value) / 100 })} className="w-full" aria-label="Text and content size" />
      </Row>
      <Row label="Align">
        {ALIGNS.map((a) => (
          <button key={a.id} className={seg(look.align === a.id)} onClick={() => setLook(inst.instanceId, { align: a.id })}>
            {a.label}
          </button>
        ))}
      </Row>
      {!locked && (
      <Row label="Colour">
        <input type="color" value={look.color || "#e8ecf4"} onChange={(e) => setLook(inst.instanceId, { color: e.target.value })} aria-label="Text colour" className="h-7 w-10 rounded border border-white/10 bg-transparent" />
        {look.color && (
          <button className={seg(false)} onClick={() => setLook(inst.instanceId, { color: "" })}>
            Theme
          </button>
        )}
      </Row>
      )}
      {note && <p className="fs-11 text-alert">{note}</p>}
    </div>,
    document.body,
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="mb-1 fs-10 uppercase tracking-wider text-ink-3">{label}</p>
      <div className="flex flex-wrap items-center gap-1">{children}</div>
    </div>
  );
}

/**
 * Icon-mode widgets (and "Open larger" from a focused one) as floating windows over the page:
 * drag the title bar to move, the corner to resize; several at once; close returns to the icon.
 * Phone: one full-screen sheet at a time.
 */
function WidgetWindows() {
  const useLayout = useSurface();
  const windows = useLayout((s) => s.windows);
  const pages = useLayout((s) => s.pages);
  const phone = useMediaQuery("(max-width: 767px)");
  const all = pages.flatMap((p) => p.items);
  const shown = phone ? windows.slice(-1) : windows;
  return (
    <>
      {shown.map((w) => {
        const inst = all.find((i) => i.instanceId === w.instanceId);
        const def = inst && getWidget(inst.widgetId);
        if (!inst || !def) return null;
        return <WidgetWindowFrame key={w.instanceId} w={w} inst={inst} def={def} phone={phone} />;
      })}
    </>
  );
}

function WidgetWindowFrame({ w, inst, def, phone }: { w: WidgetWindow; inst: WidgetInstance; def: WidgetDefinition<any>; phone: boolean }) {
  const useLayout = useSurface();
  const { moveWindow, closeWindow, openWindow } = useLayout.getState();
  const drag = useRef<{ mode: DragMode; sx: number; sy: number; ox: number; oy: number; ow: number; oh: number } | null>(null);
  const down = (mode: DragMode) => (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    openWindow(w.instanceId); // to the front
    drag.current = { mode, sx: e.clientX, sy: e.clientY, ox: w.x, oy: w.y, ow: w.w, oh: w.h };
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (d.mode === "move") moveWindow(w.instanceId, { x: Math.max(0, Math.min(window.innerWidth - 120, d.ox + dx)), y: Math.max(0, Math.min(window.innerHeight - 60, d.oy + dy)) });
    else moveWindow(w.instanceId, { w: Math.max(260, d.ow + dx), h: Math.max(180, d.oh + dy) });
  };
  const up = () => (drag.current = null);
  // Esc closes the front window.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const ws = useLayout.getState().windows;
      const front = ws.reduce<WidgetWindow | null>((a, b) => (!a || b.z > a.z ? b : a), null);
      if (front?.instanceId === w.instanceId) closeWindow(w.instanceId);
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [w.instanceId, closeWindow, useLayout]);
  const Icon = def.icon;
  return (
    <div
      data-widget-window={w.instanceId}
      role="dialog"
      aria-label={def.title}
      className={`glass-chat fixed flex flex-col overflow-hidden ${phone ? "inset-0 rounded-none pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]" : "r-18"}`}
      style={phone ? { zIndex: 80 } : { left: w.x, top: w.y, width: w.w, height: w.h, zIndex: 70 + w.z }}
      onPointerDown={() => openWindow(w.instanceId)}
    >
      <div className={`flex items-center gap-2 border-b border-white/5 px-3 py-2 ${phone ? "" : "cursor-grab touch-none active:cursor-grabbing"}`} onPointerDown={phone ? undefined : down("move")} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        <Icon size={14} className="text-teal" aria-hidden />
        <span className="label-caps text-ink-2">{def.title}</span>
        <button onPointerDown={(e) => e.stopPropagation()} onClick={() => closeWindow(w.instanceId)} className="ml-auto grid size-7 place-items-center rounded-full text-ink-2 hover:text-ink" aria-label={`Close ${def.title}`}>
          <X size={14} />
        </button>
      </div>
      <div className="min-h-0 flex-1 p-4">
        <WidgetBody inst={inst} def={def} legible={false} forceFull />
      </div>
      {!phone && (
        <button aria-label={`Resize the ${def.title} window`} className="absolute bottom-1 right-1 grid size-6 cursor-nwse-resize touch-none place-items-center text-ink-3" onPointerDown={down("resize")} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
          <Maximize2 size={11} className="rotate-90" />
        </button>
      )}
    </div>
  );
}

const area = (r: Pick<WidgetInstance, "col" | "row" | "w" | "h">): React.CSSProperties => ({
  gridColumn: `${r.col} / span ${r.w}`,
  gridRow: `${r.row} / span ${r.h}`,
});

/** One crashing widget shows an inline error instead of blanking the whole board. */
class WidgetBoundary extends Component<{ name: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error(`[widget:${this.props.name}]`, error);
  }
  render() {
    if (this.state.error)
      return (
        <div className="flex h-full flex-col items-start justify-center gap-2 text-sm">
          <span className="label-caps text-alert">{this.props.name} crashed</span>
          <span className="text-ink-2">{this.state.error.message}</span>
          <button className="pill-glass h-8 text-xs" onClick={() => this.setState({ error: null })}>
            Retry
          </button>
        </div>
      );
    return this.props.children;
  }
}
