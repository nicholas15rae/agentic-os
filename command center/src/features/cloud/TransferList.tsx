import { Check, CloudDownload, CloudUpload, Square, TriangleAlert } from "lucide-react";
import type { CloudTransfer } from "./contract";
import { cancelTransfer, useCloud } from "./cloud-store";
import { progressPct, transferLine } from "./format";
import { isLive } from "./match";

/** Live first, then finished newest first; optionally limited to one project / direction. */
export function visibleTransfers(map: Record<string, CloudTransfer>, opts: { project?: string | null; direction?: CloudTransfer["direction"]; limit?: number } = {}): CloudTransfer[] {
  return Object.values(map)
    .filter((t) => (!opts.project || t.project === opts.project) && (!opts.direction || t.direction === opts.direction))
    .sort((a, b) => Number(isLive(b)) - Number(isLive(a)) || b.startedAt.localeCompare(a.startedAt))
    .slice(0, opts.limit ?? 8);
}

export function TransferRow({ t, onCancel }: { t: CloudTransfer; onCancel: (id: string) => void }) {
  const live = isLive(t);
  const pct = t.status === "done" ? 100 : progressPct(t.bytesDone, t.bytesTotal);
  const Dir = t.direction === "pull" ? CloudDownload : CloudUpload;
  const bar = t.status === "failed" ? "bg-alert" : t.status === "cancelled" ? "bg-ink-3" : t.status === "done" ? "bg-teal" : "bg-amber";
  return (
    <li className="r-10 bg-white/[0.03] p-2">
      <div className="flex items-center gap-1.5">
        <Dir size={12} className="shrink-0 text-ink-3" />
        <span className="min-w-0 flex-1 truncate fs-12 text-ink-2" title={t.name}>
          {t.name}
        </span>
        {live ? (
          <button onClick={() => onCancel(t.id)} className="grid size-5 shrink-0 place-items-center rounded-full text-ink-3 hover:bg-white/10 hover:text-ink" title="Cancel" aria-label={`Cancel ${t.name}`}>
            <Square size={9} />
          </button>
        ) : t.status === "done" ? (
          <Check size={12} className="shrink-0 text-teal" aria-label="Done" />
        ) : t.status === "failed" ? (
          <TriangleAlert size={12} className="shrink-0 text-alert" aria-label="Failed" />
        ) : (
          <span className="shrink-0 fs-10 text-ink-3">cancelled</span>
        )}
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/10" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${t.name} progress`}>
        <div className={`h-full transition-[width] ${bar}`} style={{ width: `${pct}%` }} />
      </div>
      <p className={`mt-0.5 truncate font-mono fs-10 ${t.status === "failed" ? "text-alert" : "text-ink-3"}`}>
        {t.status === "failed" ? (t.error ?? "failed") : t.status === "queued" ? "queued" : t.status === "done" ? `done · ${t.project}` : transferLine(t)}
      </p>
    </li>
  );
}

/** Progress bars for cloud transfers (cancel while live, done / failed afterwards). */
export function TransferList({ project, direction, limit }: { project?: string | null; direction?: CloudTransfer["direction"]; limit?: number }) {
  const transfers = useCloud((s) => s.transfers);
  const rows = visibleTransfers(transfers, { project, direction, limit });
  if (!rows.length) return null;
  return (
    <ul className="space-y-1.5" aria-label="Transfers">
      {rows.map((t) => (
        <TransferRow key={t.id} t={t} onCancel={(id) => void cancelTransfer(id)} />
      ))}
    </ul>
  );
}
