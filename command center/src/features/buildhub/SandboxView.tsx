import { Component, lazy, Suspense, type ErrorInfo, type ReactNode } from "react";
import { ShieldAlert } from "lucide-react";

/**
 * Path A `internal_widget` Sandbox View (Phase 3): the staged widget is loaded dynamically
 * (`React.lazy` → its own chunk) inside a React Error Boundary, and the widget's own code runs in
 * a sandboxed, opaque-origin iframe. A crash anywhere in it is contained to this box; the Play
 * Place and the dashboard keep running.
 */
const SandboxFrame = lazy(() => import("./SandboxFrame"));

interface BoundaryState {
  error: string | null;
}

export class SandboxBoundary extends Component<{ children: ReactNode; label: string; onReset?: () => void }, BoundaryState> {
  state: BoundaryState = { error: null };
  static getDerivedStateFromError(e: unknown): BoundaryState {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  componentDidCatch(e: unknown, info: ErrorInfo) {
    console.warn(`[sandbox] ${this.props.label} crashed`, e, info.componentStack);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="grid h-full place-items-center r-12 border border-alert/40 bg-alert/5 p-4 text-center text-xs text-alert">
        <div>
          <ShieldAlert size={18} className="mx-auto mb-1" />
          <p>“{this.props.label}” crashed inside its sandbox — nothing else was affected.</p>
          <p className="mt-1 font-mono fs-10 text-ink-3">{this.state.error}</p>
          <button
            onClick={() => {
              this.setState({ error: null });
              this.props.onReset?.();
            }}
            className="pill-glass mt-2 !h-7 fs-11"
          >
            Reload widget
          </button>
        </div>
      </div>
    );
  }
}

export function SandboxView({ buildId, title, version, height = 320, bare = false }: { buildId: string; title: string; version: number; height?: number | string; bare?: boolean }) {
  return (
    <div style={{ height }} className={bare ? "" : "mt-2"}>
      <SandboxBoundary label={title}>
        <Suspense fallback={<div className="grid h-full place-items-center font-mono fs-11 text-ink-3">loading sandbox…</div>}>
          <SandboxFrame buildId={buildId} title={title} version={version} bare={bare} />
        </Suspense>
      </SandboxBoundary>
    </div>
  );
}
