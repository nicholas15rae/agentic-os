import { Component, type CSSProperties, type ReactNode } from "react";

/**
 * Last line of defence around the whole app. Without it, a render error anywhere outside a
 * widget boundary unmounts the entire tree and leaves the window an empty dark rectangle —
 * indistinguishable from "the app didn't load". This shows what broke and how to recover.
 * Inline styles only: it must still render if the stylesheet is what failed.
 */
export class RootErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error("[root] Command Center crashed while rendering", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" style={wrap}>
        <div style={{ fontSize: 12, letterSpacing: "0.18em", color: "#f87171" }}>COMMAND CENTER CRASHED</div>
        <div style={{ fontSize: 15, color: "#e5e7eb", maxWidth: 720 }}>{error.message || String(error)}</div>
        <pre style={stack}>{(error.stack ?? "").split("\n").slice(0, 8).join("\n")}</pre>
        <div style={{ display: "flex", gap: 8 }}>
          <button style={btn} onClick={() => this.setState({ error: null })}>
            Try again
          </button>
          <button style={btn} onClick={() => window.location.reload()}>
            Reload window
          </button>
        </div>
      </div>
    );
  }
}

const wrap: CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "flex",
  flexDirection: "column",
  gap: 12,
  alignItems: "flex-start",
  justifyContent: "center",
  padding: "0 48px",
  background: "#0b0d11",
  fontFamily: "ui-sans-serif, system-ui, sans-serif",
};
const stack: CSSProperties = {
  margin: 0,
  maxWidth: "100%",
  overflow: "auto",
  fontSize: 11,
  lineHeight: 1.5,
  color: "#9ca3af",
  whiteSpace: "pre-wrap",
};
const btn: CSSProperties = {
  height: 32,
  padding: "0 14px",
  borderRadius: 999,
  border: "1px solid #374151",
  background: "#111827",
  color: "#e5e7eb",
  cursor: "pointer",
};
