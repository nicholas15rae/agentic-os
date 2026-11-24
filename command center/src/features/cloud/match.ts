/** Pure matching between verified renders, cloud transfers and the sync history. */
import type { MediaProject, VerifiedRender } from "@/features/director/contract";
import type { CloudSyncRecord, CloudTransfer } from "./contract";
import { baseName } from "./format";

/** Windows paths: compare without case and with one separator. */
export const samePath = (a: string, b: string) => a.replace(/\//g, "\\").toLowerCase() === b.replace(/\//g, "\\").toLowerCase();

/** The newest push record for a local file, or null. */
export function pushRecordFor(path: string, history: CloudSyncRecord[]): CloudSyncRecord | null {
  let best: CloudSyncRecord | null = null;
  for (const r of history) if (r.direction === "push" && samePath(r.localPath, path) && (!best || r.at > best.at)) best = r;
  return best;
}

export const LIVE_STATUSES: ReadonlySet<CloudTransfer["status"]> = new Set(["queued", "running"]);
export const isLive = (t: CloudTransfer) => LIVE_STATUSES.has(t.status);

/**
 * The push transfer for a render: the one this session started for it (`transferId`), else the
 * newest push of the same file name into the same project.
 */
export function pushTransferFor(render: VerifiedRender, transfers: Record<string, CloudTransfer>, transferId?: string): CloudTransfer | null {
  if (transferId && transfers[transferId]) return transfers[transferId];
  const name = baseName(render.path);
  let best: CloudTransfer | null = null;
  for (const t of Object.values(transfers)) if (t.direction === "push" && t.project === render.project && t.name === name && (!best || t.startedAt > best.startedAt)) best = t;
  return best;
}

export interface OutboxRow {
  render: VerifiedRender;
  projectTitle: string;
}

/** Verified renders across projects, newest first, capped. */
export function recentRenders(entries: { project: MediaProject; renders: VerifiedRender[] }[], cap = 30): OutboxRow[] {
  return entries
    .flatMap((e) => e.renders.map((render) => ({ render, projectTitle: e.project.title })))
    .sort((a, b) => b.render.createdAt.localeCompare(a.render.createdAt))
    .slice(0, cap);
}

/** Keep every live transfer and the newest `keepFinished` finished ones. */
export function pruneTransfers(map: Record<string, CloudTransfer>, keepFinished = 20): Record<string, CloudTransfer> {
  const all = Object.values(map);
  const finished = all.filter((t) => !isLive(t)).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  if (finished.length <= keepFinished) return map;
  const drop = new Set(finished.slice(keepFinished).map((t) => t.id));
  return Object.fromEntries(all.filter((t) => !drop.has(t.id)).map((t) => [t.id, t]));
}
