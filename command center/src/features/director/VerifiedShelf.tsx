import { useState } from "react";
import { BadgeCheck, FolderOpen, Loader2, ShieldCheck } from "lucide-react";
import { Card, Empty, SubTabs } from "@/components/ui";
import { useToasts } from "@/features/reminders/notify";
import { RenderCloudActions } from "@/features/cloud/RenderCloudActions";
import { api } from "./api";
import { approveFinal, select, useDirector } from "./director-store";
import { timecode } from "./manifest";
import { DeliverablesList, defaultHashtags } from "./Deliverables";
import { Versions } from "./VersionsPanel";

const mb = (b: number) => `${(b / 1_048_576).toFixed(1)} MB`;
const base = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** The final-approval steps: pick renders, then confirm (pure). */
export function FinalApprovalBar({ count, confirming, busy, onConfirm, onAsk, onCancel }: { count: number; confirming: boolean; busy: boolean; onConfirm: () => void; onAsk: () => void; onCancel: () => void }) {
  if (confirming)
    return (
      <div className="mt-2 rounded-[12px] border border-teal/40 bg-teal/[0.06] p-2.5" role="alertdialog" aria-label="Confirm final approval">
        <p className="text-[12px] text-ink">
          Approve {count} render{count === 1 ? "" : "s"} as final? They're copied to renders/final/ and the project is marked done.
        </p>
        <div className="mt-2 flex gap-1.5">
          <button onClick={onConfirm} disabled={busy} className="pill-primary !h-8 !px-3 text-xs disabled:opacity-50">
            {busy ? <Loader2 size={12} className="animate-spin" /> : <BadgeCheck size={12} />} Yes, approve final
          </button>
          <button onClick={onCancel} disabled={busy} className="pill-glass !h-8 !px-3 text-xs">
            Cancel
          </button>
        </div>
      </div>
    );
  return (
    <div className="mt-2 flex items-center gap-1.5">
      <span className="text-[11px] text-ink-2">{count ? `${count} selected` : "Tick the renders that are final"}</span>
      <button onClick={onAsk} disabled={!count} className="pill-primary ml-auto !h-8 !px-3 text-xs disabled:opacity-50">
        <BadgeCheck size={12} /> Approve final
      </button>
      <button onClick={onCancel} className="pill-glass !h-8 !px-3 text-xs">
        Cancel
      </button>
    </div>
  );
}

/** Renders Rust has verified (exists, > 0 bytes, ffprobe OK, within the cap), the final approval, and the deliverables. */
export function VerifiedShelf() {
  const renders = useDirector((s) => s.renders);
  const selection = useDirector((s) => s.selection);
  const previewMode = useDirector((s) => s.previewMode);
  const deliverables = useDirector((s) => s.deliverables);
  const done = useDirector((s) => s.project?.status === "done");
  const assets = useDirector((s) => s.assets);
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"outputs" | "versions">("outputs");

  const stop = () => {
    setPicking(false);
    setPicked([]);
    setConfirming(false);
  };
  const confirm = async () => {
    setBusy(true);
    try {
      if (await approveFinal(picked)) stop();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Verified outputs"
      action={
        renders.length > 0 &&
        !picking &&
        tab === "outputs" && (
          <button onClick={() => setPicking(true)} className="pill-glass !h-8 !px-3 text-xs" title="Choose the renders that are final (asks before copying)">
            <BadgeCheck size={12} /> Approve final…
          </button>
        )
      }
    >
      {renders.length > 0 && (
        <div className="mb-2">
          <SubTabs
            tabs={[
              { id: "outputs", label: "Outputs" },
              { id: "versions", label: "Versions" },
            ]}
            value={tab}
            onChange={setTab}
          />
        </div>
      )}
      {tab === "versions" && renders.length ? (
        <Versions />
      ) : renders.length ? (
        <ul className="space-y-1.5">
          {renders.map((r, i) => {
            const on = previewMode === "final" && (selection?.kind === "render" ? selection.id === r.id : i === 0);
            const ticked = picked.includes(r.id);
            return (
              <li key={r.id} className={`rounded-[12px] border p-2 ${on ? "border-teal/40 bg-teal/5" : "border-white/[0.08]"}`}>
                <div className="flex items-center gap-2">
                  {picking && (
                    <input
                      type="checkbox"
                      checked={ticked}
                      disabled={confirming}
                      onChange={() => setPicked((p) => (ticked ? p.filter((x) => x !== r.id) : [...p, r.id]))}
                      className="size-4 shrink-0 accent-teal"
                      aria-label={`Final: ${base(r.path)}`}
                    />
                  )}
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
                </div>
                <RenderCloudActions render={r} origin="shelf" />
              </li>
            );
          })}
        </ul>
      ) : (
        <Empty>No verified renders yet.</Empty>
      )}
      {picking && tab === "outputs" && <FinalApprovalBar count={picked.length} confirming={confirming} busy={busy} onAsk={() => setConfirming(true)} onConfirm={() => void confirm()} onCancel={confirming ? () => setConfirming(false) : stop} />}
      <DeliverablesList deliverables={deliverables} renders={renders} hashtags={defaultHashtags(assets.map((a) => a.tags))} done={done} />
    </Card>
  );
}
