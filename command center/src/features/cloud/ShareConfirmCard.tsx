import { Link2, Loader2, X } from "lucide-react";
import { cancelShare, confirmShare, useCloud } from "./cloud-store";
import { safety } from "@/lib/safety";

export const SHARE_EXPLAINER = "Anyone with the link can view this file. They can't edit it, and you can turn the link off in Google Drive.";

/** Share confirm card (props only). "Create link" is the only control that leads to `cloud_share`. */
export function ShareConfirmView({ name, busy, onConfirm, onCancel }: { name: string; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <section {...safety("confirm-card")} className="glass mt-2 r-16 border-amber/50 p-3 ring-1 ring-amber/40" role="alertdialog" aria-label="Confirm share link">
      <div className="flex items-center gap-1.5">
        <Link2 size={14} className="text-amber-soft" />
        <h3 className="label-caps text-amber-soft">Create a share link?</h3>
      </div>
      <p className="mt-2 truncate fs-12 text-ink" title={name}>
        {name}
      </p>
      <p className="mt-1 fs-12 leading-relaxed text-ink-2">{SHARE_EXPLAINER}</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <button onClick={onConfirm} disabled={busy} className="pill-primary !h-8 !px-3 text-xs disabled:opacity-50">
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Link2 size={12} />} Create link
        </button>
        <button onClick={onCancel} disabled={busy} className="pill-glass !h-8 !px-3 text-xs">
          <X size={12} /> Cancel
        </button>
      </div>
    </section>
  );
}

export function ShareConfirmCard({ origin, driveFileId }: { origin: string; driveFileId: string }) {
  const pending = useCloud((s) => s.pendingShare);
  const busy = useCloud((s) => s.confirmBusy);
  if (!pending || pending.origin !== origin || pending.driveFileId !== driveFileId) return null;
  return <ShareConfirmView name={pending.name} busy={busy} onConfirm={() => void confirmShare()} onCancel={cancelShare} />;
}
