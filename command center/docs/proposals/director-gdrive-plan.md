# Google Drive ⇄ Director Suite — plan and locked contract

Status: **awaiting approval** · 2026-11-22 · branch `feat/director-media-mcp`.

## 1. Audit

| Fact | Where | Consequence |
|---|---|---|
| Your OAuth client is saved by Settings → Integrations → Google as `{clientId, clientSecret}` under keychain provider `google` (`IntegrationSettings.tsx` `secret_set`). Nothing reads it yet. | `secrets::get(state, "google")` | Drive auth reuses it. **No credentials in code, os.json, git or chat logs.** |
| An API key only reads *public* files. | Google Drive API | Not used. Everything goes through OAuth. |
| MCP calls cap at 600 s and drop progress. | `mcp.rs` | Drive is **native Rust** (`gdrive.rs`), streaming with progress events. The earlier `workspace-mcp` plan is dropped. |
| Widgets are auto-discovered from `src/widgets/<id>/index.ts` (`defineWidget`). | `core/widgets/registry.ts` | New `src/widgets/google-drive/`, no central list. |
| Director projects, the read-only ingest, verified renders and `media.db` already exist. | `media.rs` | A pull reuses `finalize_asset`. A push only accepts a verified render row. |

## 2. Design

- **Auth (installed-app flow):**
  - Rust binds `127.0.0.1:<random>` and opens your default browser to Google's consent page (PKCE S256 + `state`).
  - It receives the code on the loopback, exchanges it, and stores **only the refresh token** in the keychain under a new provider id, `gdrive-token`.
  - Access tokens live in memory and are refreshed when they expire.
  - **Scopes:** `drive.readonly` (browse and pull your folders, e.g. phone footage) and `drive.file` (create and share only the files this app uploads).
  - **Disconnect:** revokes the token at Google and deletes the keychain entry.
- **Pull (Drive → project):**
  - Video, image and audio files only, up to 20 GB.
  - Streamed into `projects/<slug>/working/.uploads/*.part`, then moved into `raw/` and finalised exactly like a local ingest (read-only, probed, thumbnail).
  - Google Docs/Sheets and folders are refused.
- **Push (project → Drive):**
  - **Verified renders only** (the path must match a `render` row). The upload is resumable, in 8 MiB chunks, retried on 5xx/network errors.
  - Needs `approved: true` from a confirm card.
- **Share link:** "anyone with the link: viewer" on a file this app uploaded. It needs its own `approved: true` card. Copy Link only reads the existing link.
- **Records:** `media.db` v2 adds `drive_sync` (every pull and push) and `kv` (default inbox and outbox folder ids). The verified shelf shows ☁ and the link when a render has been pushed.
- **Provider seam:** a `CloudProvider` trait (`list`, `download`, `upload_resumable`, `share`) with `GoogleDrive` as the first implementation, so Dropbox can be added later without touching the UI. The UI speaks only the `cloud_*` commands below with `provider: "gdrive"`.

## 3. Locked contract

```ts
// src/features/cloud/contract.ts — LOCKED after approval
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
```

## 4. Widget and Director Suite UI

- **States:**
  - *Client missing* → "Add your Google OAuth client in Settings → Integrations → Google" + **Open Settings**.
  - *Not connected* → **Connect Google Drive** (browser consent).
  - *Connected* → account chip + tabs.
  - *Error* → message + **Retry**.
- **Inbox tab (pull):**
  - Folder browser with breadcrumbs. **Set as inbox** remembers the folder (e.g. your phone's camera-upload folder).
  - Multi-select media → **Import to project ▾**: an existing Director project, or a new one.
  - Live progress bars. Imported files appear in that project's staging bin as `Raw · read-only`.
- **Outbox tab (push):**
  - Verified renders across projects (newest first). **Upload to Drive** opens a confirm card naming the file, its size and the destination folder; progress follows.
  - Once uploaded: **Create share link** (its own confirm card) → **Copy link**. **Open in Drive** opens the link in the browser.
- **Director Suite:**
  - the Verified Outputs shelf gets **Upload to Drive** / **Copy link** per render;
  - the staging bin's **Add** menu gets **From Google Drive…**, which opens the same browser as a modal targeting the current project.
- **Never automatic:** no upload, share or deletion happens without its confirm card. Nothing is ever deleted on Drive or locally. A pull never overwrites anything (`unique_path`).

## 5. Phases and checks

1. **Rust `gdrive.rs`:**
   - OAuth (PKCE, loopback, keychain), list, streamed pull into raw, resumable push, share, revoke, transfers + events;
   - `media.db` v2 (`drive_sync`, `kv`);
   - unit tests against a local mock Google server (token exchange, refresh on 401, resumable 308/Range resume, retry on 503, path guards, refusals without `approved`).
2. **Frontend:** `features/cloud/*` (contract, api, store) + `widgets/google-drive` + the Director Suite hooks. Vitest + tsc.
3. **Real smoke (with you):**
   - **Connect:** you click Allow in the browser.
   - **Pull:** list a folder, pull one clip into a project, and check it is read-only and that its SHA-256 matches Drive's `sha256Checksum`.
   - **Push:** push the verified smoke render after you approve the card; check Drive's checksum matches the local file.
   - **Share:** create a link after you approve that card, open it in a private window, then disconnect.

## 6. Decisions (my defaults)

1. **Scopes:** `drive.readonly` + `drive.file`. `drive.readonly` is a "restricted" scope. For a personal app in Testing mode it works for your own account (you're the test user), but Google shows an "unverified app" screen at consent and **refresh tokens expire after 7 days in Testing mode**. Publishing the consent screen to "In production" (unverified, personal use) avoids the 7-day expiry. Alternative: `drive.file` only, so pulls would come through Google's Picker instead of a folder browser. Simpler consent, but much more UI work.
2. **Push only verified renders.** Staged raw files, stills and voiceovers can't be uploaded, which keeps it clear what leaves the machine. Thumbnail and stills export can come later.
3. **One app-wide inbox and outbox.** Not per project. Each push lets you pick another folder.
