/**
 * Cloud storage IPC (gdrive.rs). Every command is plain JSON through `xcmd` (ExtCommands) and
 * follows the locked `CloudCommands` contract. Desktop-only: each call throws on the PWA.
 *
 * `push` and `share` take `approved: true` as a literal type. They are only ever called from the
 * confirm-card handlers in `cloud-store.ts` (`confirmPush` / `confirmShare`).
 */
import { onExtEvent, xcmd } from "@/lib/native-ext";
import type { CloudCommands, CloudEvents, CloudProviderId } from "./contract";

type Args<K extends keyof CloudCommands> = CloudCommands[K]["args"];
type Result<K extends keyof CloudCommands> = CloudCommands[K]["result"];
/** Args without the provider: the UI only speaks Google Drive for now. */
type NoProvider<K extends keyof CloudCommands> = Omit<NonNullable<Args<K>>, "provider">;

export const PROVIDER: CloudProviderId = "gdrive";
/** The contract's per-call pull limit. */
export const MAX_PULL_FILES = 20;

export const cloudApi = {
  status: (): Promise<Result<"cloud_status">> => xcmd("cloud_status", { provider: PROVIDER }),
  connect: (): Promise<Result<"cloud_connect">> => xcmd("cloud_connect", { provider: PROVIDER }),
  disconnect: (): Promise<Result<"cloud_disconnect">> => xcmd("cloud_disconnect", { provider: PROVIDER }),
  list: (a: NoProvider<"cloud_list">): Promise<Result<"cloud_list">> => xcmd("cloud_list", { provider: PROVIDER, ...a }),
  setFolders: (a: NoProvider<"cloud_set_folders">): Promise<Result<"cloud_set_folders">> => xcmd("cloud_set_folders", { provider: PROVIDER, ...a }),
  pull: (a: NoProvider<"cloud_pull">): Promise<Result<"cloud_pull">> => xcmd("cloud_pull", { provider: PROVIDER, ...a }),
  /** Only from the Push confirm card (`confirmPush`). */
  push: (a: NoProvider<"cloud_push">): Promise<Result<"cloud_push">> => xcmd("cloud_push", { provider: PROVIDER, ...a }),
  /** Only from the Share confirm card (`confirmShare`). */
  share: (a: NoProvider<"cloud_share">): Promise<Result<"cloud_share">> => xcmd("cloud_share", { provider: PROVIDER, ...a }),
  cancel: (a: Args<"cloud_cancel">): Promise<Result<"cloud_cancel">> => xcmd("cloud_cancel", a),
  transfers: (): Promise<Result<"cloud_transfers">> => xcmd("cloud_transfers"),
  history: (a: Args<"cloud_history"> = {}): Promise<Result<"cloud_history">> => xcmd("cloud_history", a),
};

/** Subscribe to a cloud event. No-op on the PWA. */
export function onCloudEvent<E extends keyof CloudEvents>(event: E, handler: (payload: CloudEvents[E]) => void): Promise<() => void> {
  return onExtEvent<CloudEvents[E]>(event, handler);
}

/** Drive's viewer URL for a file id (used when no `webViewLink` is known yet; owner-only until shared). */
export const driveFileUrl = (id: string) => `https://drive.google.com/file/d/${encodeURIComponent(id)}/view`;
