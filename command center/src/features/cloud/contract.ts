// src/features/cloud/contract.ts — LOCKED after approval
import type { AssetRole } from "@/features/director/contract";

export type CloudProviderId = "gdrive";               // later: | "dropbox"

export interface CloudStatus {
  provider: CloudProviderId;
  clientConfigured: boolean;    // OAuth client present in the keychain (Settings → Integrations → Google)
  connected: boolean;           // refresh token present and working
  account: string | null;       // e-mail from Drive about.get
  inboxFolder: CloudFolderRef | null;
  outboxFolder: CloudFolderRef | null;
  error: string | null;
}
export interface CloudFolderRef { id: string; name: string }

export interface CloudItem {
  id: string;
  name: string;
  kind: "folder" | "video" | "image" | "audio" | "other";
  mimeType: string;
  sizeBytes: number | null;
  durationSec: number | null;   // videoMediaMetadata.durationMillis / 1000
  width: number | null;
  height: number | null;
  modifiedAt: string;
  webViewLink: string | null;
  ownedByApp: boolean;          // created by this app (drive.file) → can be shared
}

export interface CloudListing { folder: CloudFolderRef; parents: CloudFolderRef[]; items: CloudItem[]; nextPageToken: string | null }

export interface CloudTransfer {
  id: string;                   // "x-<base36>"
  provider: CloudProviderId;
  direction: "pull" | "push";
  name: string;
  project: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  bytesDone: number;
  bytesTotal: number;
  error: string | null;
  result: { assetId?: string; driveFileId?: string; webViewLink?: string } | null;
  startedAt: string;
}

export interface CloudSyncRecord {
  id: string; provider: CloudProviderId; direction: "pull" | "push";
  project: string; localPath: string; driveFileId: string; name: string;
  sizeBytes: number; webViewLink: string | null; at: string;
}

/** Tauri IPC (ExtCommands; camelCase args). Desktop only. */
export interface CloudCommands {
  cloud_status:      { args: { provider: CloudProviderId }; result: CloudStatus };
  cloud_connect:     { args: { provider: CloudProviderId }; result: CloudStatus };          // opens the browser consent; resolves when done (5 min timeout)
  cloud_disconnect:  { args: { provider: CloudProviderId }; result: CloudStatus };          // revokes + deletes the token
  cloud_list:        { args: { provider: CloudProviderId; folderId: string | null; query?: string; pageToken?: string }; result: CloudListing }; // null = My Drive root
  cloud_set_folders: { args: { provider: CloudProviderId; inbox?: CloudFolderRef | null; outbox?: CloudFolderRef | null }; result: CloudStatus };
  cloud_pull:        { args: { provider: CloudProviderId; fileIds: string[]; slug: string; role: AssetRole }; result: { transferIds: string[] } };     // ≤ 20 files
  cloud_push:        { args: { provider: CloudProviderId; renderId: string; folderId: string | null; approved: true }; result: { transferId: string } };
  cloud_share:       { args: { provider: CloudProviderId; driveFileId: string; approved: true }; result: { webViewLink: string } };
  cloud_cancel:      { args: { transferId: string }; result: void };
  cloud_transfers:   { args: undefined; result: CloudTransfer[] };                          // live + last 20 finished
  cloud_history:     { args: { slug?: string }; result: CloudSyncRecord[] };
}
// AssetRole is imported from src/features/director/contract.ts.

export type CloudEvents = {
  "cloud-transfer": CloudTransfer;                    // every ~500 ms while running, and on each status change
  "cloud-status": CloudStatus;                        // after connect / disconnect / folder change
};

/** Widget `google-drive` (src/widgets/google-drive). Desktop only. Default size 4×4, min 3×3, max 8×6. */
export interface DriveWidgetConfig {
  tab: "inbox" | "outbox";
  targetProject: string | null;   // pull destination; null = ask
}
