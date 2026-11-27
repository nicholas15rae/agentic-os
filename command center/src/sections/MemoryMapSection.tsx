import { useEffect, type CSSProperties } from "react";
import { useMediaQuery } from "@/lib/use-media-query";
import { TopStatusBar } from "@/features/memmap/TopStatusBar";
import { LeftColumn } from "@/features/memmap/LeftColumn";
import { CentreStage } from "@/features/memmap/CentreStage";
import { TraceStream } from "@/features/memmap/TraceStream";
import { IntentNoteBar } from "@/features/memmap/IntentNoteBar";
import { TaskDock } from "@/features/memmap/TaskDock";
import { ZoneInspector } from "@/features/memmap/ZoneInspector";
import { RoutingFlowchart } from "@/features/memmap/RoutingFlowchart";
import { useDevQueue } from "@/features/memmap/dev-queue";
import { openCounts } from "@/features/memmap/format";
import { LayoutSurface } from "@/core/widgets/LayoutSurface";
import { panelShown, revealPanel } from "@/core/widgets/reveal";
import type { WidgetProps } from "@/core/widgets/types";
import { useSystemMapLayout } from "./memorymap/panels";
import { useZoneUi } from "@/features/memmap/zone-store";
import { SysMapCanvasPage, SysMapSwitcher } from "@/features/sysmap/SysMapPages";
import { useSysMap } from "@/features/sysmap/sysmap-store";

/** Carbon weave under a faint cyan bloom (static CSS, no animation). */
const CARBON: CSSProperties = {
  backgroundColor: "#06080c",
  backgroundImage: [
    "radial-gradient(ellipse at 50% 38%, rgba(0,210,255,0.07), transparent 62%)",
    "repeating-linear-gradient(45deg, rgba(255,255,255,0.016) 0 2px, transparent 2px 4px)",
    "repeating-linear-gradient(-45deg, rgba(0,0,0,0.35) 0 2px, transparent 2px 4px)",
  ].join(","),
};

/**
 * System Map: three separate, full pages behind one pill switcher —
 * 1 · Gabagool Blueprint (the E46 hardware / telemetry deck, below),
 * 2 · Schematic Flowchart and 3 · Orbital Ecosystem (`features/sysmap`), which share the Deep
 * Inspector. Only the active page is mounted, so Page 3's WebGL context exists only while it
 * shows. Plan: docs/memory-map-plan.md.
 */
export function MemoryMapSection() {
  const page = useSysMap((s) => s.page);
  return (
    <div className="flex h-full w-full flex-col" style={CARBON}>
      <div className="flex shrink-0 items-center gap-3 px-3 pt-3 md:px-4">
        <SysMapSwitcher className="min-w-0" />
      </div>
      <div className="min-h-0 flex-1">{page === 1 ? <BlueprintPage /> : <div className="h-full px-3 pb-32 pt-3 md:px-4 md:pb-4"><SysMapCanvasPage page={page} /></div>}</div>
    </div>
  );
}

/**
 * Page 1 · Gabagool Blueprint ("architectural X-ray"): how the OS is wired, how data moves
 * through it and why a node succeeds or fails — plus the dev task queue. Each block is a panel on
 * the shared layout (sections/memorymap/panels.tsx); the default keeps the old HUD grid: status
 * bar across the top, the OS-state column on the left, the car stage over the task dock in the
 * centre, the live trace (the zone inspector opens over it) over the note bar on the right.
 */
function BlueprintPage() {
  // Leave no zone hovered or inspector open behind when the page is left.
  useEffect(() => () => useZoneUi.setState({ hovered: null, selected: null }), []);
  // A zone click always lands on a visible inspector: it opens over the trace panel.
  const selected = useZoneUi((s) => s.selected);
  useEffect(() => {
    if (selected && !panelShown(useSystemMapLayout.getState(), "sm-trace")) revealPanel(useSystemMapLayout, "sm-trace", "System Map");
  }, [selected]);
  return (
    <div className="h-full pt-3">
      <LayoutSurface store={useSystemMapLayout} label="System Map" />
    </div>
  );
}

/** The status bar (fills its row). */
export function SmStatusBar() {
  return <TopStatusBar className="h-full" />;
}

/** The routing flowchart as its own panel (the stage then drops its strip). */
export function SmFlowchart() {
  const md = useMediaQuery("(min-width: 768px)");
  return <RoutingFlowchart orient={md ? undefined : "v"} />;
}

/** The car stage: the 3D viewport fills the panel (static chassis below md). */
export function SmStage() {
  const md = useMediaQuery("(min-width: 768px)");
  const flowPanel = useSystemMapLayout((s) => panelShown(s, "sm-flow"));
  return <CentreStage narrow={!md} flow={!flowPanel} className="h-full" />;
}

/** The live trace with the zone inspector drawer over it. */
export function SmTrace() {
  return (
    <div className="relative flex h-full min-h-[300px] flex-col md:min-h-0" data-no-hold>
      <TraceStream className="min-h-0 flex-1" />
      <ZoneInspector />
    </div>
  );
}

/** The intent / runtime note bar. */
export function SmNote() {
  return <IntentNoteBar className="h-full" />;
}

/** The future-tasks dock; its icon badge is the open-task count. */
export function SmDock({ setBadge }: WidgetProps) {
  const open = useDevQueue((q) => openCounts(q.tasks).all);
  useEffect(() => setBadge?.(open > 0 ? String(open) : null), [open, setBadge]);
  return (
    <div className="h-full" data-no-hold>
      <TaskDock className="h-full min-h-[220px] md:min-h-0" />
    </div>
  );
}

/** The OS-state column and subsystem cards. */
export function SmLeft() {
  return (
    <div data-no-hold>
      <LeftColumn className="pr-1" />
    </div>
  );
}
