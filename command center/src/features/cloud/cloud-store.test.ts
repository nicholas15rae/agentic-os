import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VerifiedRender } from "@/features/director/contract";
import type { CloudItem, CloudStatus, CloudTransfer } from "./contract";

const push = vi.fn();
vi.mock("@/features/reminders/notify", () => ({ useToasts: { getState: () => ({ push }) } }));
vi.mock("./api", () => ({
  PROVIDER: "gdrive",
  MAX_PULL_FILES: 20,
  onCloudEvent: vi.fn(async () => () => undefined),
  cloudApi: {
    status: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    list: vi.fn(),
    setFolders: vi.fn(),
    pull: vi.fn(),
    push: vi.fn(),
    share: vi.fn(),
    cancel: vi.fn(),
    transfers: vi.fn(),
    history: vi.fn(),
  },
}));

const { cloudApi, onCloudEvent } = await import("./api");
const store = await import("./cloud-store");
const m = vi.mocked(cloudApi);
const st = () => store.useCloud.getState();

const STATUS: CloudStatus = { provider: "gdrive", clientConfigured: true, connected: true, account: "nic@example.com", inboxFolder: { id: "in", name: "Camera" }, outboxFolder: { id: "out", name: "Renders" }, error: null };
const RENDER: VerifiedRender = { id: "r-1", project: "demo", planId: "p-1", path: "C:\\p\\demo\\renders\\demo_v001.mp4", durationSec: 12, width: 1920, height: 1080, sizeBytes: 5_000_000, loudnessLufs: -18, verify: { ok: true, checks: [] }, createdAt: "2026-11-22T10:00:00Z" };
const xfer = (p: Partial<CloudTransfer>): CloudTransfer => ({ id: "x-1", provider: "gdrive", direction: "pull", name: "clip.mp4", project: "demo", status: "running", bytesDone: 10, bytesTotal: 100, error: null, result: null, startedAt: "2026-11-22T10:00:00Z", ...p });
const item = (p: Partial<CloudItem>): CloudItem => ({ id: "f1", name: "clip.mp4", kind: "video", mimeType: "video/mp4", sizeBytes: 100, durationSec: 3, width: 1920, height: 1080, modifiedAt: "", webViewLink: null, ownedByApp: false, ...p });

beforeEach(() => {
  vi.clearAllMocks();
  store.resetCloudStore();
  m.history.mockResolvedValue([]);
  m.transfers.mockResolvedValue([]);
  m.status.mockResolvedValue(STATUS);
});

describe("driveView", () => {
  it("maps status to the four states (+ loading)", () => {
    expect(store.driveView(null, null)).toBe("loading");
    expect(store.driveView(null, "IPC down")).toBe("error");
    expect(store.driveView({ ...STATUS, clientConfigured: false, connected: false }, null)).toBe("client-missing");
    expect(store.driveView({ ...STATUS, connected: false }, null)).toBe("disconnected");
    expect(store.driveView({ ...STATUS, connected: false, error: "token revoked" }, null)).toBe("error");
    expect(store.driveView(STATUS, null)).toBe("connected");
  });
});

describe("transfer event folding", () => {
  it("merges updates by id and ignores a stale running update after done", () => {
    store.onTransferEvent(xfer({ bytesDone: 10 }));
    store.onTransferEvent(xfer({ bytesDone: 60 }));
    expect(st().transfers["x-1"].bytesDone).toBe(60);
    store.onTransferEvent(xfer({ status: "done", bytesDone: 100, result: { assetId: "a-1" } }));
    store.onTransferEvent(xfer({ status: "running", bytesDone: 70 }));
    expect(st().transfers["x-1"]).toMatchObject({ status: "done", bytesDone: 100 });
  });

  it("fires the pull-done hook once per pull, never for pushes or on initial load", async () => {
    const done = vi.fn();
    const off = store.onPullDone(done);
    store.onTransferEvent(xfer({ status: "running" }));
    expect(done).not.toHaveBeenCalled();
    store.onTransferEvent(xfer({ status: "done" }));
    store.onTransferEvent(xfer({ status: "done" }));
    expect(done).toHaveBeenCalledTimes(1);
    expect(done.mock.calls[0][0]).toMatchObject({ id: "x-1", project: "demo", direction: "pull" });

    store.onTransferEvent(xfer({ id: "x-push", direction: "push", status: "done" }));
    expect(done).toHaveBeenCalledTimes(1);
    expect(m.history).toHaveBeenCalled(); // a finished push refreshes the ☁ badges

    m.transfers.mockResolvedValue([xfer({ id: "x-old", status: "done" })]);
    await store.loadTransfers();
    expect(st().transfers["x-old"]).toBeDefined();
    expect(done).toHaveBeenCalledTimes(1);

    off();
    store.onTransferEvent(xfer({ id: "x-9", status: "running" }));
    store.onTransferEvent(xfer({ id: "x-9", status: "done" }));
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("toasts a failure once", () => {
    store.onTransferEvent(xfer({ status: "failed", error: "quota" }));
    store.onTransferEvent(xfer({ status: "failed", error: "quota" }));
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0]).toMatchObject({ tone: "error", body: "clip.mp4: quota" });
  });

  it("cloud-status events replace the status and clear the browser on disconnect", () => {
    store.useCloud.setState({ listing: { folder: { id: "in", name: "Camera" }, parents: [], items: [], nextPageToken: null }, selected: ["f1"] });
    store.onStatusEvent({ ...STATUS, connected: false, account: null });
    expect(st().status?.connected).toBe(false);
    expect(st().listing).toBeNull();
    expect(st().selected).toEqual([]);
  });
});

describe("startCloud", () => {
  it("subscribes once however many surfaces mount, and loads status/transfers/history", async () => {
    const a = store.startCloud();
    const b = store.startCloud();
    await vi.waitFor(() => expect(st().status).toEqual(STATUS));
    expect(onCloudEvent).toHaveBeenCalledTimes(2);
    expect(vi.mocked(onCloudEvent).mock.calls.map((c) => c[0]).sort()).toEqual(["cloud-status", "cloud-transfer"]);
    expect(m.status).toHaveBeenCalledTimes(1);
    expect(m.transfers).toHaveBeenCalledTimes(1);
    expect(m.history).toHaveBeenCalledTimes(1);
    a();
    a();
    b();
    store.startCloud();
    expect(onCloudEvent).toHaveBeenCalledTimes(4);
  });
  it("a failing status call is the error state", async () => {
    m.status.mockRejectedValue(new Error("unknown command cloud_status"));
    await store.refreshStatus();
    expect(store.driveView(st().status, st().statusError)).toBe("error");
  });
});

describe("connect / browse / pull", () => {
  it("connect toggles the waiting flag and toasts errors", async () => {
    let resolve!: (s: CloudStatus) => void;
    m.connect.mockReturnValue(new Promise((r) => (resolve = r)));
    const p = store.connect();
    expect(st().connecting).toBe(true);
    resolve(STATUS);
    await p;
    expect(st().connecting).toBe(false);
    expect(st().status).toEqual(STATUS);
    m.connect.mockRejectedValue(new Error("timed out"));
    await store.connect();
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ title: "Couldn't connect Google Drive", tone: "error" }));
  });

  it("browse drops stale responses; loadMore appends the next page", async () => {
    let first!: (v: unknown) => void;
    m.list.mockReturnValueOnce(new Promise((r) => (first = r as never)));
    m.list.mockResolvedValueOnce({ folder: { id: "b", name: "B" }, parents: [{ id: "root", name: "My Drive" }], items: [item({ id: "1" })], nextPageToken: "t2" });
    const p1 = store.browse("a");
    await store.browse("b");
    first({ folder: { id: "a", name: "A" }, parents: [], items: [], nextPageToken: null });
    await p1;
    expect(st().listing?.folder.id).toBe("b");
    expect(m.list).toHaveBeenLastCalledWith({ folderId: "b" });

    m.list.mockResolvedValueOnce({ folder: { id: "b", name: "B" }, parents: [], items: [item({ id: "1" }), item({ id: "2" })], nextPageToken: null });
    await store.loadMore();
    expect(m.list).toHaveBeenLastCalledWith({ folderId: "b", pageToken: "t2" });
    expect(st().listing?.items.map((i) => i.id)).toEqual(["1", "2"]);
    expect(st().listing?.nextPageToken).toBeNull();
  });

  it("search passes the query; selection takes media only", async () => {
    m.list.mockResolvedValue({ folder: { id: "b", name: "B" }, parents: [], items: [], nextPageToken: null });
    await store.browse("b", "  beach ");
    expect(m.list).toHaveBeenLastCalledWith({ folderId: "b", query: "beach" });
    store.toggleSelect(item({ id: "v" }));
    store.toggleSelect(item({ id: "doc", kind: "other" }));
    store.toggleSelect(item({ id: "dir", kind: "folder" }));
    expect(st().selected).toEqual(["v"]);
    store.toggleSelect(item({ id: "v" }));
    expect(st().selected).toEqual([]);
  });

  it("pull sends the selection with slug + role, clears it and refreshes transfers", async () => {
    m.pull.mockResolvedValue({ transferIds: ["x-1", "x-2"] });
    m.transfers.mockResolvedValue([xfer({ id: "x-1", status: "queued" }), xfer({ id: "x-2", status: "queued" })]);
    store.useCloud.setState({ selected: ["f1", "f2"] });
    expect(await store.pullSelected("demo", "clip")).toBe(true);
    expect(m.pull).toHaveBeenCalledWith({ fileIds: ["f1", "f2"], slug: "demo", role: "clip" });
    expect(st().selected).toEqual([]);
    expect(Object.keys(st().transfers).sort()).toEqual(["x-1", "x-2"]);
  });

  it("refuses more than 20 files without calling Rust", async () => {
    store.useCloud.setState({ selected: Array.from({ length: 21 }, (_, i) => `f${i}`) });
    expect(await store.pullSelected("demo", "clip")).toBe(false);
    expect(m.pull).not.toHaveBeenCalled();
  });
});

describe("push / share only through the confirm card", () => {
  it("requestPush raises the card (outbox folder by default) and calls nothing", () => {
    store.useCloud.setState({ status: STATUS });
    store.requestPush(RENDER, "shelf");
    expect(st().pendingPush).toMatchObject({ origin: "shelf", folder: { id: "out" } });
    expect(m.push).not.toHaveBeenCalled();
    store.cancelPush();
    expect(st().pendingPush).toBeNull();
    expect(m.push).not.toHaveBeenCalled();
  });

  it("confirmPush with no pending card does nothing", async () => {
    expect(await store.confirmPush()).toBeNull();
    expect(m.push).not.toHaveBeenCalled();
  });

  it("confirmPush sends approved: true with the chosen folder and tracks the transfer", async () => {
    m.push.mockResolvedValue({ transferId: "x-p" });
    store.useCloud.setState({ status: STATUS });
    store.requestPush(RENDER, "outbox");
    store.setPushFolder(null);
    expect(await store.confirmPush()).toBe("x-p");
    expect(m.push).toHaveBeenCalledTimes(1);
    expect(m.push).toHaveBeenCalledWith({ renderId: "r-1", folderId: null, approved: true });
    expect(st().pendingPush).toBeNull();
    expect(st().pushByRender["r-1"]).toBe("x-p");
    expect(st().transfers["x-p"]).toMatchObject({ direction: "push", status: "queued", name: "demo_v001.mp4", bytesTotal: 5_000_000 });
  });

  it("a refused push keeps the card and toasts", async () => {
    m.push.mockRejectedValue(new Error("PERMISSION_REQUIRED"));
    store.requestPush(RENDER, "shelf");
    expect(await store.confirmPush()).toBeNull();
    expect(st().pendingPush).not.toBeNull();
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ title: "Upload refused" }));
  });

  it("requestShare raises its own card; confirmShare sends approved: true and keeps the link", async () => {
    m.share.mockResolvedValue({ webViewLink: "https://drive.google.com/file/d/f1/view" });
    store.requestShare("f1", "demo_v001.mp4", "shelf");
    expect(st().pendingShare).toMatchObject({ driveFileId: "f1" });
    expect(m.share).not.toHaveBeenCalled();
    expect(await store.confirmShare()).toBe("https://drive.google.com/file/d/f1/view");
    expect(m.share).toHaveBeenCalledWith({ driveFileId: "f1", approved: true });
    expect(st().pendingShare).toBeNull();
    expect(store.shareLinkFor("f1", null, st().sharedLinks)).toBe("https://drive.google.com/file/d/f1/view");
  });

  it("confirmShare with no pending card does nothing", async () => {
    expect(await store.confirmShare()).toBeNull();
    expect(m.share).not.toHaveBeenCalled();
  });
});
