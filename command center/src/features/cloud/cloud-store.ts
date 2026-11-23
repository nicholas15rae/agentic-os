/**
 * Cloud storage state (zustand): Drive status, the folder browser, live transfers (folded from
 * `cloud-transfer` events) and the sync history. Nothing is persisted in the webview; Rust keeps
 * the inbox/outbox folders and the history in media.db.
 *
 * Upload and share are two-step on purpose: `requestPush` / `requestShare` only raise a confirm
 * card; `confirmPush` / `confirmShare` (the card's button) are the ONLY callers of
 * `cloudApi.push` / `cloudApi.share`, and the only places `approved: true` is sent.
 */
import { create } from "zustand";
import { useToasts } from "@/features/reminders/notify";
import type { VerifiedRender, AssetRole } from "@/features/director/contract";
import type { CloudFolderRef, CloudItem, CloudListing, CloudStatus, CloudSyncRecord, CloudTransfer } from "./contract";
import { MAX_PULL_FILES, cloudApi, onCloudEvent } from "./api";
import { isLive, pruneTransfers } from "./match";
import { baseName } from "./format";

export interface PendingPush {
  render: VerifiedRender;
  /** Which surface raised it ("shelf", "outbox"…): only that one draws the card. */
  origin: string;
  /** Destination; null = My Drive root. */
  folder: CloudFolderRef | null;
}
export interface PendingShare {
  driveFileId: string;
  name: string;
  origin: string;
}

export interface CloudState {
  status: CloudStatus | null;
  statusLoading: boolean;
  /** The status call itself failed (backend missing, IPC error). */
  statusError: string | null;
  connecting: boolean;
  listing: CloudListing | null;
  listingLoading: boolean;
  listingError: string | null;
  /** The search box text the current listing was made with. */
  query: string;
  /** Selected Drive file ids (media only). */
  selected: string[];
  transfers: Record<string, CloudTransfer>;
  history: CloudSyncRecord[];
  /** renderId → the push transfer this session started for it. */
  pushByRender: Record<string, string>;
  /** driveFileId → link returned by a share this session. */
  sharedLinks: Record<string, string>;
  pendingPush: PendingPush | null;
  pendingShare: PendingShare | null;
  confirmBusy: boolean;
  pulling: boolean;
}

const initial: CloudState = {
  status: null,
  statusLoading: false,
  statusError: null,
  connecting: false,
  listing: null,
  listingLoading: false,
  listingError: null,
  query: "",
  selected: [],
  transfers: {},
  history: [],
  pushByRender: {},
  sharedLinks: {},
  pendingPush: null,
  pendingShare: null,
  confirmBusy: false,
  pulling: false,
};

export const useCloud = create<CloudState>(() => ({ ...initial }));
const get = () => useCloud.getState();
const set = (p: Partial<CloudState> | ((s: CloudState) => Partial<CloudState>)) => useCloud.setState(p);

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const toast = (title: string, body?: string, tone: "info" | "warn" | "error" = "info") => useToasts.getState().push({ title, body, tone });

// ── Pull-done listeners (the Director Suite refreshes its bin) ───────────────

type PullDone = (t: CloudTransfer) => void;
const pullDone = new Set<PullDone>();
/** Called once when a pull transfer turns `done`. Returns the unsubscribe. */
export function onPullDone(fn: PullDone): () => void {
  pullDone.add(fn);
  return () => void pullDone.delete(fn);
}

/** Test hook. */
export function resetCloudStore() {
  listSeq = 0;
  pullDone.clear();
  subscribers = 0;
  unsub = [];
  useCloud.setState({ ...initial }, true);
}

// ── Status / connect ─────────────────────────────────────────────────────────

export async function refreshStatus(): Promise<void> {
  set({ statusLoading: true });
  try {
    set({ status: await cloudApi.status(), statusError: null });
  } catch (e) {
    set({ statusError: errText(e) });
  } finally {
    set({ statusLoading: false });
  }
}

/** Opens the browser consent; resolves when Rust has the token (or fails / times out). */
export async function connect(): Promise<void> {
  if (get().connecting) return;
  set({ connecting: true });
  try {
    set({ status: await cloudApi.connect(), statusError: null });
  } catch (e) {
    toast("Couldn't connect Google Drive", errText(e), "error");
  } finally {
    set({ connecting: false });
  }
}

export async function disconnect(): Promise<void> {
  try {
    set({ status: await cloudApi.disconnect(), listing: null, selected: [], query: "" });
  } catch (e) {
    toast("Couldn't disconnect Google Drive", errText(e), "error");
  }
}

export function onStatusEvent(s: CloudStatus) {
  set({ status: s, statusError: null });
  if (!s.connected) set({ listing: null, selected: [] });
}

export type DriveView = "loading" | "client-missing" | "disconnected" | "connected" | "error";

/** Which of the §4 states to draw (pure). */
export function driveView(status: CloudStatus | null, statusError: string | null): DriveView {
  if (statusError) return "error";
  if (!status) return "loading";
  if (!status.clientConfigured) return "client-missing";
  if (!status.connected) return status.error ? "error" : "disconnected";
  return "connected";
}

// ── Browser ──────────────────────────────────────────────────────────────────

let listSeq = 0;

/** List a folder (null = My Drive root), optionally searching. Replaces the listing. */
export async function browse(folderId: string | null, query = ""): Promise<void> {
  const seq = ++listSeq;
  set({ listingLoading: true, listingError: null, query, selected: [] });
  try {
    const listing = await cloudApi.list(query.trim() ? { folderId, query: query.trim() } : { folderId });
    if (seq === listSeq) set({ listing });
  } catch (e) {
    if (seq === listSeq) set({ listingError: errText(e) });
  } finally {
    if (seq === listSeq) set({ listingLoading: false });
  }
}

/** "Load more": the next page of the current listing, appended. */
export async function loadMore(): Promise<void> {
  const { listing, query } = get();
  if (!listing?.nextPageToken) return;
  const seq = ++listSeq;
  set({ listingLoading: true });
  try {
    const next = await cloudApi.list({ folderId: listing.folder.id, pageToken: listing.nextPageToken, ...(query.trim() ? { query: query.trim() } : {}) });
    if (seq !== listSeq) return;
    const seen = new Set(listing.items.map((i) => i.id));
    set({ listing: { ...listing, items: [...listing.items, ...next.items.filter((i) => !seen.has(i.id))], nextPageToken: next.nextPageToken } });
  } catch (e) {
    if (seq === listSeq) toast("Couldn't load more files", errText(e), "error");
  } finally {
    if (seq === listSeq) set({ listingLoading: false });
  }
}

export const isMedia = (i: CloudItem) => i.kind === "video" || i.kind === "image" || i.kind === "audio";

export function toggleSelect(item: CloudItem) {
  if (!isMedia(item)) return;
  set((s) => ({ selected: s.selected.includes(item.id) ? s.selected.filter((x) => x !== item.id) : [...s.selected, item.id] }));
}
export const clearSelection = () => set({ selected: [] });

export async function setFolder(which: "inbox" | "outbox", folder: CloudFolderRef | null): Promise<void> {
  try {
    set({ status: await cloudApi.setFolders(which === "inbox" ? { inbox: folder } : { outbox: folder }) });
    toast(which === "inbox" ? "Inbox folder set" : "Outbox folder set", folder?.name ?? "My Drive");
  } catch (e) {
    toast("Couldn't save the folder", errText(e), "error");
  }
}

// ── Pull ─────────────────────────────────────────────────────────────────────

/** Import the selected Drive files into a project's raw/ (read-only, like a local ingest). */
export async function pullSelected(slug: string, role: AssetRole): Promise<boolean> {
  const fileIds = get().selected;
  if (!fileIds.length || !slug) return false;
  if (fileIds.length > MAX_PULL_FILES) {
    toast("Too many files", `Import up to ${MAX_PULL_FILES} at a time.`, "warn");
    return false;
  }
  set({ pulling: true });
  try {
    await cloudApi.pull({ fileIds, slug, role });
    set({ selected: [] });
    await loadTransfers();
    return true;
  } catch (e) {
    toast("Couldn't start the import", errText(e), "error");
    return false;
  } finally {
    set({ pulling: false });
  }
}

// ── Transfers ────────────────────────────────────────────────────────────────

const TERMINAL = (t: CloudTransfer) => !isLive(t);

/** Fold one transfer update in. A stale non-terminal update never overwrites a finished one. */
export function foldTransfer(t: CloudTransfer, silent = false): void {
  const prev = get().transfers[t.id];
  if (prev && TERMINAL(prev) && !TERMINAL(t)) return;
  set((s) => ({ transfers: pruneTransfers({ ...s.transfers, [t.id]: t }) }));
  const turnedDone = t.status === "done" && prev?.status !== "done";
  if (silent || !turnedDone) {
    if (!silent && t.status === "failed" && prev?.status !== "failed") toast(t.direction === "pull" ? "Import failed" : "Upload failed", `${t.name}: ${t.error ?? "unknown error"}`, "error");
    return;
  }
  if (t.direction === "pull") {
    for (const fn of pullDone) {
      try {
        fn(t);
      } catch {
        /* a listener's failure never blocks the others */
      }
    }
  } else {
    toast("Uploaded to Drive", t.name);
    void loadHistory();
  }
}

export const onTransferEvent = (t: CloudTransfer) => foldTransfer(t);

export async function loadTransfers(): Promise<void> {
  try {
    const list = await cloudApi.transfers();
    for (const t of list) foldTransfer(t, true);
  } catch {
    /* the list is a convenience; events keep coming */
  }
}

export async function cancelTransfer(id: string): Promise<void> {
  try {
    await cloudApi.cancel({ transferId: id });
  } catch (e) {
    toast("Couldn't cancel", errText(e), "error");
  }
}

export async function loadHistory(): Promise<void> {
  try {
    set({ history: await cloudApi.history({}) });
  } catch {
    /* no badges until it loads */
  }
}

// ── Push / share: request (card) → confirm (button) ──────────────────────────

/** Raise the Upload confirm card. Never uploads by itself. */
export function requestPush(render: VerifiedRender, origin: string, folder?: CloudFolderRef | null) {
  set({ pendingPush: { render, origin, folder: folder === undefined ? (get().status?.outboxFolder ?? null) : folder }, pendingShare: null });
}
export function setPushFolder(folder: CloudFolderRef | null) {
  const p = get().pendingPush;
  if (p) set({ pendingPush: { ...p, folder } });
}
export const cancelPush = () => set({ pendingPush: null });

/** The Upload confirm card's "Upload to Drive" click — the only path to `cloud_push`. */
export async function confirmPush(): Promise<string | null> {
  const p = get().pendingPush;
  if (!p || get().confirmBusy) return null;
  set({ confirmBusy: true });
  try {
    const { transferId } = await cloudApi.push({ renderId: p.render.id, folderId: p.folder?.id ?? null, approved: true });
    set((s) => ({ pendingPush: null, pushByRender: { ...s.pushByRender, [p.render.id]: transferId } }));
    foldTransfer(
      { id: transferId, provider: "gdrive", direction: "push", name: baseName(p.render.path), project: p.render.project, status: "queued", bytesDone: 0, bytesTotal: p.render.sizeBytes, error: null, result: null, startedAt: new Date().toISOString() },
      true,
    );
    return transferId;
  } catch (e) {
    toast("Upload refused", errText(e), "error");
    return null;
  } finally {
    set({ confirmBusy: false });
  }
}

/** Raise the Share confirm card. Never shares by itself. */
export function requestShare(driveFileId: string, name: string, origin: string) {
  set({ pendingShare: { driveFileId, name, origin }, pendingPush: null });
}
export const cancelShare = () => set({ pendingShare: null });

/** The Share confirm card's "Create link" click — the only path to `cloud_share`. */
export async function confirmShare(): Promise<string | null> {
  const p = get().pendingShare;
  if (!p || get().confirmBusy) return null;
  set({ confirmBusy: true });
  try {
    const { webViewLink } = await cloudApi.share({ driveFileId: p.driveFileId, approved: true });
    set((s) => ({ pendingShare: null, sharedLinks: { ...s.sharedLinks, [p.driveFileId]: webViewLink } }));
    toast("Share link created", "Anyone with the link can view.");
    void loadHistory();
    return webViewLink;
  } catch (e) {
    toast("Couldn't create the link", errText(e), "error");
    return null;
  } finally {
    set({ confirmBusy: false });
  }
}

/** The shareable link for a pushed file: this session's share result, else the record's. */
export function shareLinkFor(driveFileId: string, record: CloudSyncRecord | null, sharedLinks: Record<string, string>): string | null {
  return sharedLinks[driveFileId] ?? record?.webViewLink ?? null;
}

// ── Lifecycle: one event subscription however many surfaces are mounted ──────

let subscribers = 0;
let unsub: Promise<() => void>[] = [];

/** Mount hook body: status + transfers + history, and the two events. Returns the release. */
export function startCloud(): () => void {
  subscribers++;
  if (subscribers === 1) {
    unsub = [onCloudEvent("cloud-transfer", onTransferEvent), onCloudEvent("cloud-status", onStatusEvent)];
    void refreshStatus();
    void loadTransfers();
    void loadHistory();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    subscribers = Math.max(0, subscribers - 1);
    if (subscribers === 0) {
      const offs = unsub;
      unsub = [];
      offs.forEach((p) => void p.then((off) => off()).catch(() => undefined));
    }
  };
}
