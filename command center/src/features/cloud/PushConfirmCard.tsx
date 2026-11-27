import { CloudUpload, Loader2, X } from "lucide-react";
import { Select } from "@/components/ui";
import type { CloudFolderRef } from "./contract";
import { cancelPush, confirmPush, setPushFolder, useCloud } from "./cloud-store";
import { baseName, formatBytes } from "./format";

export const MY_DRIVE = "My Drive";

/**
 * Upload confirm card (props only): names the file, its size and the destination folder.
 * "Upload to Drive" is the only control that leads to `cloud_push` (with `approved: true`).
 */
export function PushConfirmView({
  name,
  sizeBytes,
  folder,
  folderChoices,
  busy,
  onFolder,
  onConfirm,
  onCancel,
}: {
  name: string;
  sizeBytes: number;
  folder: CloudFolderRef | null;
  /** Other destinations to offer (the outbox, My Drive root). */
  folderChoices: (CloudFolderRef | null)[];
  busy: boolean;
  onFolder: (f: CloudFolderRef | null) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const choices = uniqueFolders([folder, ...folderChoices]);
  return (
    <section className="glass mt-2 rounded-[16px] border-amber/50 p-3 ring-1 ring-amber/40" role="alertdialog" aria-label="Confirm upload to Google Drive">
      <div className="flex items-center gap-1.5">
        <CloudUpload size={14} className="text-amber-soft" />
        <h3 className="label-caps text-amber-soft">Upload to Drive?</h3>
      </div>
      <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-[12px]">
        <dt className="text-ink-3">File</dt>
        <dd className="truncate text-ink" title={name}>
          {name}
        </dd>
        <dt className="text-ink-3">Size</dt>
        <dd className="font-mono text-ink-2">{formatBytes(sizeBytes)}</dd>
        <dt className="text-ink-3">To</dt>
        <dd className="min-w-0 text-ink-2">
          {choices.length > 1 ? (
            <Select value={folder?.id ?? ""} onChange={(e) => onFolder(choices.find((c) => (c?.id ?? "") === e.target.value) ?? null)} className="!h-7 !w-auto max-w-full !py-0 text-[12px]" aria-label="Destination folder">
              {choices.map((c) => (
                <option key={c?.id ?? ""} value={c?.id ?? ""}>
                  {c?.name ?? MY_DRIVE}
                </option>
              ))}
            </Select>
          ) : (
            <span className="truncate">{folder?.name ?? MY_DRIVE}</span>
          )}
        </dd>
      </dl>
      <p className="mt-2 text-[11px] text-ink-3">Only you can see it until you create a share link.</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <button onClick={onConfirm} disabled={busy} className="pill-primary !h-8 !px-3 text-xs disabled:opacity-50">
          {busy ? <Loader2 size={12} className="animate-spin" /> : <CloudUpload size={12} />} Upload to Drive
        </button>
        <button onClick={onCancel} disabled={busy} className="pill-glass !h-8 !px-3 text-xs">
          <X size={12} /> Cancel
        </button>
      </div>
    </section>
  );
}

export function uniqueFolders(list: (CloudFolderRef | null)[]): (CloudFolderRef | null)[] {
  const seen = new Set<string>();
  const out: (CloudFolderRef | null)[] = [];
  for (const f of list) {
    const k = f?.id ?? "";
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
  }
  return out;
}

/** Store-wired card: drawn only by the surface (`origin`) that raised the request for this render. */
export function PushConfirmCard({ origin, renderId, extraFolder }: { origin: string; renderId: string; extraFolder?: CloudFolderRef | null }) {
  const pending = useCloud((s) => s.pendingPush);
  const busy = useCloud((s) => s.confirmBusy);
  const outbox = useCloud((s) => s.status?.outboxFolder ?? null);
  if (!pending || pending.origin !== origin || pending.render.id !== renderId) return null;
  return (
    <PushConfirmView
      name={baseName(pending.render.path)}
      sizeBytes={pending.render.sizeBytes}
      folder={pending.folder}
      folderChoices={[outbox, ...(extraFolder !== undefined ? [extraFolder] : []), null]}
      busy={busy}
      onFolder={setPushFolder}
      onConfirm={() => void confirmPush()}
      onCancel={cancelPush}
    />
  );
}
