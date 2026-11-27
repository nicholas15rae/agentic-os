import { useEffect, useRef, useState } from "react";
import { AppWindow, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { xcmd } from "@/lib/native-ext";
import { useToasts } from "@/features/reminders/notify";
import { errText } from "./hub-store";
import type { BuildView } from "./types";

/**
 * Live Read-In / Peek View (Phase 3): a sandboxed iframe on the build's loopback preview (its own
 * dev port, or the hub's static server over the output folder). Reachability comes from the Rust
 * hub loop (`build-hub` events) — nothing polls here. While the preview is down or the build is
 * recompiling, a non-blocking overlay sits over the LAST loaded page (the snapshot) and the frame
 * re-attaches by itself when the preview answers again or the output changes. Opening, refreshing
 * or closing this view never touches the build: it only reads what the build already wrote.
 */
export function PeekView({ b, height = 380 }: { b: BuildView; height?: number }) {
  const id = b.envelope.build_id;
  const [url, setUrl] = useState<string | null>(b.peek.url);
  const [key, setKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const reachable = b.peek.reachable;
  const prev = useRef({ reachable, version: b.preview_version });

  useEffect(() => {
    let live = true;
    void xcmd("build_peek_status", { buildId: id, watch: true })
      .then((s) => live && setUrl(s.url))
      .catch(() => undefined);
    return () => {
      live = false;
      void xcmd("build_peek_status", { buildId: id, watch: false }).catch(() => undefined);
    };
  }, [id]);

  useEffect(() => {
    if (b.peek.url && b.peek.url !== url) setUrl(b.peek.url);
  }, [b.peek.url, url]);

  // Auto re-attach: the preview came back, or the build wrote new output.
  useEffect(() => {
    const p = prev.current;
    if ((reachable && !p.reachable) || (reachable && b.preview_version !== p.version)) setKey((k) => k + 1);
    prev.current = { reachable, version: b.preview_version };
  }, [reachable, b.preview_version]);

  const compiling = b.envelope.status === "building" || b.envelope.status === "smoke_testing" || (b.envelope.status === "queued" && !!(b.worker_task_id || b.dev_task_id));
  const overlay = !url ? "Waiting for the first build output…" : !reachable && b.peek.checked_at > 0 ? "Building / Reconnecting Preview…" : null;

  const act = (name: "build_open_browser" | "build_open_window") =>
    void xcmd(name, { buildId: id }).catch((e) => useToasts.getState().push({ title: "Preview", body: errText(e), tone: "error" }));

  return (
    <div className="mt-2 overflow-hidden r-12 border border-white/10">
      <div className="flex items-center gap-1.5 border-b border-white/10 bg-black/30 px-2 py-1.5">
        <span className={`size-2 shrink-0 rounded-full ${reachable ? "bg-teal" : "bg-amber animate-pulse"}`} title={reachable ? "Preview answering" : "Preview not answering"} />
        <input readOnly value={url ?? "no preview yet"} onFocus={(e) => e.target.select()} className="min-w-0 flex-1 bg-transparent font-mono fs-11 text-ink-2 outline-none" aria-label="Preview URL" />
        {compiling && reachable && <span className="label-caps shrink-0 text-amber-soft">building · last output</span>}
        <button onClick={() => setKey((k) => k + 1)} disabled={!url} className="pill-glass !h-7 !w-7 !p-0" title="Refresh the preview (the build keeps running)" aria-label="Refresh preview">
          <RefreshCw size={12} />
        </button>
        <button onClick={() => act("build_open_browser")} disabled={!url} className="pill-glass !h-7 !px-2 fs-11" title="Pop Out in Browser">
          <ExternalLink size={12} /> Pop out
        </button>
        <button onClick={() => act("build_open_window")} disabled={!url} className="pill-glass !h-7 !px-2 fs-11" title="Open Dedicated Preview Window">
          <AppWindow size={12} /> Window
        </button>
      </div>
      <div className="relative bg-white" style={{ height }}>
        {url && (
          <iframe
            key={key}
            src={url}
            title={`Preview: ${b.envelope.title}`}
            // No allow-same-origin: the build runs in an opaque origin, isolated from the OS.
            sandbox="allow-scripts allow-forms allow-modals allow-popups"
            onLoad={() => setLoading(false)}
            className="size-full border-0"
          />
        )}
        {(overlay || (loading && url)) && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center bg-black/45 backdrop-blur-[1px]">
            <span className="flex items-center gap-2 rounded-full bg-black/70 px-3 py-1.5 font-mono fs-11 text-amber-soft">
              <Loader2 size={12} className="animate-spin" /> {overlay ?? "Loading preview…"}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
