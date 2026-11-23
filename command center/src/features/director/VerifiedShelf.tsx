import { FolderOpen, ShieldCheck } from "lucide-react";
import { Card, Empty } from "@/components/ui";
import { useToasts } from "@/features/reminders/notify";
import { api } from "./api";
import { select, useDirector } from "./director-store";
import { timecode } from "./manifest";

const mb = (b: number) => `${(b / 1_048_576).toFixed(1)} MB`;
const base = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** Renders Rust has verified (exists, > 0 bytes, ffprobe OK, within the cap). */
export function VerifiedShelf() {
  const renders = useDirector((s) => s.renders);
  const selection = useDirector((s) => s.selection);
  const previewMode = useDirector((s) => s.previewMode);
  return (
    <Card title="Verified outputs">
      {renders.length ? (
        <ul className="space-y-1.5">
          {renders.map((r, i) => {
            const on = previewMode === "final" && (selection?.kind === "render" ? selection.id === r.id : i === 0);
            return (
              <li key={r.id} className={`flex items-center gap-2 rounded-[12px] border p-2 ${on ? "border-teal/40 bg-teal/5" : "border-white/[0.08]"}`}>
                <button onClick={() => select({ kind: "render", id: r.id })} className="min-w-0 flex-1 text-left" title={r.verify.checks.join("\n")}>
                  <p className="flex items-center gap-1 truncate text-[13px] text-ink">
                    <ShieldCheck size={12} className="shrink-0 text-teal" /> {base(r.path)}
                  </p>
                  <p className="font-mono text-[10px] text-ink-3">
                    {timecode(r.durationSec)} · {r.width}×{r.height} · {mb(r.sizeBytes)}
                    {r.loudnessLufs != null ? ` · ${r.loudnessLufs.toFixed(1)} LUFS` : ""}
                  </p>
                </button>
                <button
                  onClick={() => void api.reveal({ path: r.path }).catch((e) => useToasts.getState().push({ title: "Couldn't open the folder", body: String(e), tone: "error" }))}
                  className="pill-glass !h-7 !px-2 shrink-0 text-[11px]"
                  title="Open folder"
                >
                  <FolderOpen size={11} /> Open folder
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <Empty>No verified renders yet.</Empty>
      )}
    </Card>
  );
}
