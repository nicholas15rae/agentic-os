import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CloudStatus, CloudTransfer } from "./contract";

vi.mock("@/stores/nav", () => ({ useNav: Object.assign(() => () => undefined, { getState: () => ({ go: () => undefined }) }) }));
vi.mock("@/features/reminders/notify", () => ({ useToasts: { getState: () => ({ push: vi.fn() }) } }));

const { DriveGateView, CLIENT_MISSING_TEXT, CONNECTING_TEXT } = await import("./DriveGate");
const { PushConfirmView, uniqueFolders } = await import("./PushConfirmCard");
const { ShareConfirmView, SHARE_EXPLAINER } = await import("./ShareConfirmCard");
const { TransferRow, visibleTransfers } = await import("./TransferList");
const { crumbs } = await import("./DriveBrowser");
const widget = (await import("@/widgets/google-drive/index")).default;
const { isCompact } = await import("@/widgets/google-drive/GoogleDrive");

const noop = () => undefined;
const STATUS: CloudStatus = { provider: "gdrive", clientConfigured: true, connected: true, account: "nic@example.com", inboxFolder: null, outboxFolder: { id: "out", name: "Renders" }, error: null };
const gate = (p: Partial<Parameters<typeof DriveGateView>[0]>) =>
  renderToStaticMarkup(createElement(DriveGateView, { view: "connected", status: STATUS, error: null, connecting: false, onConnect: noop, onRetry: noop, onOpenSettings: noop, onDisconnect: noop, ...p }));

describe("Google Drive widget states", () => {
  it("client missing → Settings message + Open Settings", () => {
    const html = gate({ view: "client-missing", status: { ...STATUS, clientConfigured: false, connected: false } });
    expect(html).toContain("Add your Google OAuth client in Settings → Integrations → Google.");
    expect(CLIENT_MISSING_TEXT).toContain("Settings → Integrations → Google");
    expect(html).toContain("Open Settings");
    expect(html).not.toContain("Connect Google Drive");
  });
  it("not connected → Connect Google Drive; while connecting → waiting spinner, no button", () => {
    const off = { ...STATUS, connected: false, account: null };
    expect(gate({ view: "disconnected", status: off })).toContain("Connect Google Drive");
    const waiting = gate({ view: "disconnected", status: off, connecting: true });
    expect(waiting).toContain(CONNECTING_TEXT);
    expect(waiting).not.toContain("Connect Google Drive");
    expect(waiting).not.toMatch(/Cancel/);
  });
  it("connected → account chip + disconnect + children", () => {
    const html = renderToStaticMarkup(
      createElement(DriveGateView, { view: "connected", status: STATUS, error: null, connecting: false, onConnect: noop, onRetry: noop, onOpenSettings: noop, onDisconnect: noop }, createElement("p", null, "BROWSER")),
    );
    expect(html).toContain("nic@example.com");
    expect(html).toContain('aria-label="Disconnect Google Drive"');
    expect(html).toContain("BROWSER");
  });
  it("error → message + Retry (and Connect when the token is the problem)", () => {
    const ipc = gate({ view: "error", status: null, error: "unknown command cloud_status" });
    expect(ipc).toContain("unknown command cloud_status");
    expect(ipc).toContain("Retry");
    expect(ipc).not.toContain("Connect Google Drive");
    const revoked = gate({ view: "error", status: { ...STATUS, connected: false, error: "Token revoked" } });
    expect(revoked).toContain("Token revoked");
    expect(revoked).toContain("Retry");
    expect(revoked).toContain("Connect Google Drive");
  });
  it("children never render outside the connected state", () => {
    for (const view of ["loading", "client-missing", "disconnected", "error"] as const)
      expect(renderToStaticMarkup(createElement(DriveGateView, { view, status: STATUS, error: null, connecting: false, onConnect: noop, onRetry: noop, onOpenSettings: noop, onDisconnect: noop }, "SECRET-CHILD"))).not.toContain("SECRET-CHILD");
  });
});

describe("confirm cards", () => {
  it("push card names the file, size and destination, with Upload to Drive + Cancel", () => {
    const html = renderToStaticMarkup(createElement(PushConfirmView, { name: "demo_v001.mp4", sizeBytes: 5 * 1024 * 1024, folder: { id: "out", name: "Renders" }, folderChoices: [], busy: false, onFolder: noop, onConfirm: noop, onCancel: noop }));
    expect(html).toContain("demo_v001.mp4");
    expect(html).toContain("5.0 MB");
    expect(html).toContain("Renders");
    expect(html).toContain("Upload to Drive");
    expect(html).toContain("Cancel");
    expect(html).toContain('role="alertdialog"');
  });
  it("push card defaults to My Drive and offers the other destinations", () => {
    const html = renderToStaticMarkup(createElement(PushConfirmView, { name: "a.mp4", sizeBytes: 1, folder: null, folderChoices: [{ id: "out", name: "Renders" }, null], busy: false, onFolder: noop, onConfirm: noop, onCancel: noop }));
    expect(html).toContain("My Drive");
    expect(html).toContain("Renders");
    expect(html).toContain('aria-label="Destination folder"');
    expect(uniqueFolders([null, { id: "a", name: "A" }, null, { id: "a", name: "A" }])).toEqual([null, { id: "a", name: "A" }]);
  });
  it("busy push card disables both buttons", () => {
    const html = renderToStaticMarkup(createElement(PushConfirmView, { name: "a.mp4", sizeBytes: 1, folder: null, folderChoices: [], busy: true, onFolder: noop, onConfirm: noop, onCancel: noop }));
    expect(html.match(/disabled=""/g)?.length).toBe(2);
  });
  it("share card explains anyone-with-the-link and offers Create link + Cancel", () => {
    const html = renderToStaticMarkup(createElement(ShareConfirmView, { name: "demo_v001.mp4", busy: false, onConfirm: noop, onCancel: noop }));
    expect(SHARE_EXPLAINER).toMatch(/^Anyone with the link can view/);
    expect(html).toContain("Anyone with the link can view");
    expect(html).toContain("Create link");
    expect(html).toContain("Cancel");
  });
});

describe("transfers + browser helpers", () => {
  const t = (p: Partial<CloudTransfer>): CloudTransfer => ({ id: "x", provider: "gdrive", direction: "pull", name: "clip.mp4", project: "demo", status: "running", bytesDone: 25, bytesTotal: 100, error: null, result: null, startedAt: "2026-11-22T10:00:00Z", ...p });
  it("rows show progress, cancel while live, and the error when failed", () => {
    const live = renderToStaticMarkup(createElement(TransferRow, { t: t({}), onCancel: noop }));
    expect(live).toContain('aria-valuenow="25"');
    expect(live).toContain('aria-label="Cancel clip.mp4"');
    const failed = renderToStaticMarkup(createElement(TransferRow, { t: t({ status: "failed", error: "quota exceeded" }), onCancel: noop }));
    expect(failed).toContain("quota exceeded");
    expect(failed).not.toContain("Cancel clip.mp4");
    expect(renderToStaticMarkup(createElement(TransferRow, { t: t({ status: "done" }), onCancel: noop }))).toContain('aria-valuenow="100"');
  });
  it("visibleTransfers: live first, filtered", () => {
    const map = { a: t({ id: "a", status: "done", startedAt: "3" }), b: t({ id: "b", status: "running", startedAt: "1" }), c: t({ id: "c", project: "other", startedAt: "2" }), d: t({ id: "d", direction: "push", startedAt: "4" }) };
    expect(visibleTransfers(map, { project: "demo", direction: "pull" }).map((x) => x.id)).toEqual(["b", "a"]);
  });
  it("breadcrumbs = ancestors then the folder; My Drive before the first listing", () => {
    expect(crumbs(null)).toEqual([{ id: "root", name: "My Drive" }]);
    expect(crumbs({ folder: { id: "c", name: "Camera" }, parents: [{ id: "root", name: "My Drive" }, { id: "p", name: "Phone" }], items: [], nextPageToken: null }).map((c) => c.name)).toEqual(["My Drive", "Phone", "Camera"]);
  });
});

describe("google-drive widget definition", () => {
  it("matches the contract", () => {
    expect(widget).toMatchObject({ id: "google-drive", title: "Google Drive", defaultSize: { w: 4, h: 4 }, minSize: { w: 3, h: 3 }, maxSize: { w: 8, h: 6 }, platforms: ["desktop"], defaultConfig: { tab: "inbox", targetProject: null } });
    expect(widget.keywords).toEqual(expect.arrayContaining(["drive", "google drive", "upload", "footage", "sync"]));
    expect(isCompact({ w: 3, h: 4 })).toBe(true);
    expect(isCompact({ w: 4, h: 4 })).toBe(false);
  });
});

describe("guard: uploads and shares only from the confirm handlers", () => {
  const sources = import.meta.glob<string>(["../../features/**/*.{ts,tsx}", "../../widgets/**/*.{ts,tsx}", "../../sections/**/*.{ts,tsx}", "!../../**/*.test.{ts,tsx}"], { query: "?raw", import: "default", eager: true });
  it("cloudApi.push / cloudApi.share are called only inside confirmPush / confirmShare", () => {
    const callers: string[] = [];
    const rawIpc: string[] = [];
    for (const [path, src] of Object.entries(sources)) {
      for (const call of ["cloudApi.push(", "cloudApi.share("]) {
        let i = src.indexOf(call);
        while (i !== -1) {
          const fn = src.slice(0, i).match(/export async function (\w+)\(/g)?.pop() ?? "?";
          callers.push(`${path.split("/").pop()}:${fn.replace(/export async function |\(/g, "")}:${call}`);
          i = src.indexOf(call, i + 1);
        }
      }
      if (src.includes('xcmd("cloud_push"') || src.includes('xcmd("cloud_share"')) rawIpc.push(path.split("/").pop() ?? path);
    }
    expect(callers.sort()).toEqual(["cloud-store.ts:confirmPush:cloudApi.push(", "cloud-store.ts:confirmShare:cloudApi.share("]);
    // The IPC itself is only wrapped once (api.ts), so nothing can bypass the store's confirm handlers.
    expect(rawIpc).toEqual(["api.ts"]);
  });
});
