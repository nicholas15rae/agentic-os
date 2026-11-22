import { Component, lazy, Suspense, useEffect, type ReactNode } from "react";
import { useSysMap, type SysPage } from "./sysmap-store";
import { SchematicFlowchart } from "./SchematicFlowchart";
import { DeepInspector } from "./DeepInspector";

/** three.js + R3F for Page 3 live in their own chunk, fetched only when Page 3 opens. */
const OrbitalEcosystem = lazy(() => import("./OrbitalEcosystem"));

export const PAGES: readonly { id: SysPage; label: string; hint: string }[] = [
  { id: 1, label: "Gabagool Blueprint", hint: "Hardware & telemetry deck" },
  { id: 2, label: "Schematic Flowchart", hint: "Architectural wiring & memory map" },
  { id: 3, label: "Orbital Ecosystem", hint: "3D planetary star map" },
];

/** `Page 1 | Page 2 | Page 3` pills (the dashboard PageSwitcher's look). Ctrl+Alt+1/2/3 jumps. */
export function SysMapSwitcher({ className = "" }: { className?: string }) {
  const page = useSysMap((s) => s.page);
  const setPage = useSysMap((s) => s.setPage);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.altKey || !["1", "2", "3"].includes(e.key)) return;
      e.preventDefault();
      setPage(Number(e.key) as SysPage);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setPage]);
  return (
    <nav aria-label="System Map pages" className={`flex items-center gap-1.5 overflow-x-auto [scrollbar-width:none] ${className}`}>
      {PAGES.map((p) => {
        const active = p.id === page;
        return (
          <button
            key={p.id}
            type="button"
            aria-current={active ? "page" : undefined}
            title={`${p.hint} (Ctrl+Alt+${p.id})`}
            onClick={() => setPage(p.id)}
            className={`flex h-9 shrink-0 items-center gap-2 rounded-full border px-3.5 font-mono text-[12px] transition-colors ${
              active ? "border-amber/70 bg-amber/10 text-ink" : "border-white/10 bg-[rgba(11,13,17,0.6)] text-ink-2 hover:border-white/25 hover:text-ink"
            }`}
          >
            <span className="text-ink-3">{p.id}</span>
            <span className="whitespace-nowrap">{p.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

/** WebGL failed (or the chunk did): say so instead of a blank page. */
class GlBoundary extends Component<{ children: ReactNode }, { failed: string | null }> {
  state = { failed: null as string | null };
  static getDerivedStateFromError(e: Error) {
    return { failed: e.message };
  }
  render() {
    return this.state.failed ? (
      <div className="grid h-full place-items-center p-6 text-center text-[12px] text-ink-3">
        <p>
          The orbital view needs WebGL and couldn't start ({this.state.failed}).
          <br />
          The Schematic Flowchart shows the same live data.
        </p>
      </div>
    ) : (
      this.props.children
    );
  }
}

/**
 * Pages 2 and 3, full-canvas, with the shared Deep Inspector over them. Only the active page is
 * mounted: leaving Page 3 unmounts its Canvas, which stops its frame loop and releases the WebGL
 * context (0 % GPU while you are elsewhere).
 */
export function SysMapCanvasPage({ page }: { page: 2 | 3 }) {
  useEffect(() => () => useSysMap.getState().close(), []);
  return (
    <div className="relative h-full min-h-[480px] overflow-hidden rounded-[14px] border border-holo/20 bg-[#03050a]">
      {page === 2 ? (
        <SchematicFlowchart />
      ) : (
        <GlBoundary>
          <Suspense fallback={<p className="grid h-full place-items-center text-[12px] text-ink-3">Loading the orbital map…</p>}>
            <OrbitalEcosystem />
          </Suspense>
        </GlBoundary>
      )}
      <DeepInspector />
    </div>
  );
}
