import { useEffect, useState } from "react";
import { xcmd } from "@/lib/native-ext";

/** The dynamically loaded sandbox body: the widget's loopback URL in an opaque-origin iframe. */
/** `bare`: no white backing or border, so a transparent widget shows the wallpaper through it. */
export default function SandboxFrame({ buildId, title, version, bare = false }: { buildId: string; title: string; version: number; bare?: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    let live = true;
    xcmd("build_widget_url", { buildId })
      .then((u) => live && setUrl(u))
      .catch((e) => live && setError(e instanceof Error ? e : new Error(String(e))));
    return () => {
      live = false;
    };
  }, [buildId]);
  // Surface load failures to the Error Boundary instead of rendering a broken frame.
  if (error) throw error;
  if (!url) return <div className="grid h-full place-items-center font-mono fs-11 text-ink-3">starting the sandbox…</div>;
  return <iframe key={version} src={url} title={`Widget: ${title}`} sandbox="allow-scripts allow-forms" className={bare ? "size-full border-0 bg-transparent" : "size-full r-12 border border-white/10 bg-white"} />;
}
