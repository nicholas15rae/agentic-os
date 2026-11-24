import { Cloud, CloudUpload, ExternalLink, Link2 } from "lucide-react";
import type { VerifiedRender } from "@/features/director/contract";
import type { CloudFolderRef } from "./contract";
import { driveFileUrl } from "./api";
import { cancelTransfer, requestPush, requestShare, shareLinkFor, useCloud } from "./cloud-store";
import { CopyLinkButton } from "./CopyLinkButton";
import { PushConfirmCard } from "./PushConfirmCard";
import { ShareConfirmCard } from "./ShareConfirmCard";
import { TransferRow } from "./TransferList";
import { baseName } from "./format";
import { isLive, pushRecordFor, pushTransferFor } from "./match";

/**
 * Per-render Drive controls (Verified shelf + widget Outbox): Upload to Drive → confirm card →
 * progress → ☁ uploaded · Create share link (its own card) → Copy link · Open in Drive.
 * Draws nothing until Drive is connected.
 */
export function RenderCloudActions({ render, origin, compact = false, extraFolder }: { render: VerifiedRender; origin: string; compact?: boolean; extraFolder?: CloudFolderRef | null }) {
  const connected = useCloud((s) => !!s.status?.connected);
  const history = useCloud((s) => s.history);
  const transfers = useCloud((s) => s.transfers);
  const pushByRender = useCloud((s) => s.pushByRender);
  const sharedLinks = useCloud((s) => s.sharedLinks);
  if (!connected) return null;

  const record = pushRecordFor(render.path, history);
  const transfer = pushTransferFor(render, transfers, pushByRender[render.id]);
  const name = baseName(render.path);
  const driveFileId = record?.driveFileId ?? (transfer?.status === "done" ? transfer.result?.driveFileId : undefined) ?? null;
  const link = driveFileId ? shareLinkFor(driveFileId, record, sharedLinks) : null;

  let body;
  if (transfer && isLive(transfer)) body = <TransferRow t={transfer} onCancel={(id) => void cancelTransfer(id)} />;
  else if (driveFileId)
    body = (
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="flex h-7 items-center gap-1 rounded-full border border-teal/40 px-2 text-[11px] text-teal-soft" title="Uploaded to Google Drive">
          <Cloud size={11} /> {compact ? "" : "Uploaded"}
        </span>
        {link ? (
          <CopyLinkButton link={link} compact={compact} />
        ) : (
          <button onClick={() => requestShare(driveFileId, name, origin)} className="pill-glass !h-7 !px-2 text-[11px]" title="Anyone with the link can view">
            <Link2 size={11} /> {compact ? "Share" : "Create share link"}
          </button>
        )}
        <a href={link ?? driveFileUrl(driveFileId)} target="_blank" rel="noreferrer" className="pill-glass !h-7 !px-2 text-[11px]" title="Open in Google Drive">
          <ExternalLink size={11} /> {compact ? "" : "Open in Drive"}
        </a>
      </div>
    );
  else
    body = (
      <div className="flex flex-wrap items-center gap-1.5">
        <button onClick={() => requestPush(render, origin)} className="pill-glass !h-7 !px-2 text-[11px]" title="Upload this verified render to Google Drive (asks first)">
          <CloudUpload size={11} /> Upload to Drive
        </button>
        {transfer?.status === "failed" && <span className="truncate text-[10px] text-alert">Last upload failed: {transfer.error ?? "error"}</span>}
      </div>
    );

  return (
    <div className="mt-1.5 min-w-0">
      {body}
      <PushConfirmCard origin={origin} renderId={render.id} extraFolder={extraFolder} />
      {driveFileId && <ShareConfirmCard origin={origin} driveFileId={driveFileId} />}
    </div>
  );
}
