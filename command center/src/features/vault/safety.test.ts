import { describe, expect, it } from "vitest";
import type { OsKeySources, OsKeyStatus, PipelinesSettings, SyncResult } from "@/lib/platform";
import type { BackupList, MirrorRow } from "@/lib/cc-api";
import { backupSummary } from "@/lib/cc-api";
import { driveSyncState, mirrorAlerts, VAULT_PASSWORD_COPY, vaultChecklist, vaultPasswordState } from "./safety";

const keys = (vault: OsKeyStatus | undefined) => ({ keys: (vault ? { vault } : {}) as OsKeySources["keys"] });
const st = (source: OsKeyStatus["source"]): OsKeyStatus => ({ source, envVar: null, keychain: source === "keychain" });

const settings = (p: Partial<PipelinesSettings> = {}): PipelinesSettings => ({
  pollIntervalSeconds: 15,
  gdriveSyncWebhookUrl: "",
  gdriveTrackedPaths: ["G:\\agentic os\\training_logs", "@os-config"],
  autoSyncEnabled: false,
  autoSyncHours: 6,
  syncOnExit: true,
  instances: [],
  resolvedPaths: [],
  ...p,
});
const sync = (status: SyncResult["status"]): SyncResult => ({ status, at: 1_764_000_000_000, files: 3, bytes: 10, skippedLarge: 0, detail: "3 files", trigger: "manual" });
const row = (p: Partial<MirrorRow>): MirrorRow => ({ dir: "D:\\Backups\\cc-mirror", reachable: true, ok: true, lastOkAt: 1, ...p });
const list = (mirrors: MirrorRow[]): Pick<BackupList, "mirrors"> => ({ mirrors });

describe("Section 16.3: vault password status (presence only)", () => {
  it("reads set / missing / unknown from the key sources", () => {
    expect(vaultPasswordState(null)).toBe("unknown");
    expect(vaultPasswordState(keys(undefined))).toBe("unknown");
    expect(vaultPasswordState(keys(st("missing")))).toBe("missing");
    expect(vaultPasswordState(keys(st("keychain")))).toBe("set");
  });

  it("the banner says what it protects, that archives are unencrypted without it, and that a lost one can't be recovered", () => {
    const all = Object.values(VAULT_PASSWORD_COPY).join(" ").toLowerCase();
    for (const w of ["aes-256", "unencrypted", "no recovery", "can't be opened", "password manager", "write it down"]) expect(all).toContain(w);
  });
});

describe("Section 16.2: mirrors and the off-site copy", () => {
  it("lists only the mirrors that need a look", () => {
    expect(mirrorAlerts(null)).toEqual([]);
    expect(mirrorAlerts(list([row({})]))).toEqual([]);
    expect(mirrorAlerts(list([row({}), row({ dir: "E:\\copies", reachable: false, ok: null, alert: "E:\\ is not reachable right now" })]))).toEqual(["E:\\copies: E:\\ is not reachable right now"]);
  });

  it("Drive sync status comes from the saved settings and the last recorded sync", () => {
    const none = driveSyncState(settings(), null, "G:\\agentic os\\backups\\command-center");
    expect(none).toMatchObject({ configured: false, auto: false, tracksBackups: false, last: null, lastOk: false });
    const on = driveSyncState(settings({ gdriveSyncWebhookUrl: "http://127.0.0.1:5678/webhook/gdrive-sync", autoSyncEnabled: true, gdriveTrackedPaths: ["g:/agentic os/backups/"] }), sync("synced"), "G:\\agentic os\\backups\\command-center");
    expect(on).toMatchObject({ configured: true, auto: true, autoHours: 6, tracksBackups: true, lastOk: true });
    expect(driveSyncState(settings({ gdriveSyncWebhookUrl: " " }), sync("failed"), null)).toMatchObject({ configured: false, lastOk: false, tracksBackups: false });
    // A path that merely starts with the same letters is not the folder.
    expect(driveSyncState(settings({ gdriveTrackedPaths: ["G:\\agentic os\\back"] }), null, "G:\\agentic os\\backups").tracksBackups).toBe(false);
  });

  it("the backup summary counts mirror copies and failures", () => {
    const b = { file: "x\\cc-1.zip", size: 1, at: 1, reason: "manual", ok: true, verified: { ok: true, problems: [], entries: 3, files: 1 } };
    expect(backupSummary(b)).not.toContain("mirrored");
    expect(backupSummary({ ...b, mirrors: { "D:\\m": { ok: true, at: 1 }, "E:\\m": { ok: false, at: 1, reason: "unreachable" } } })).toContain("mirrored to 1/2 (1 FAILED)");
  });
});

describe("Vault safety checklist", () => {
  const drive = driveSyncState(settings({ gdriveSyncWebhookUrl: "http://127.0.0.1:5678/webhook/gdrive-sync" }), sync("up-to-date"), null);

  it("is all done only when the password is set and written down, a mirror is healthy and Drive synced", () => {
    const items = vaultChecklist({ password: "set", writtenDown: true, list: list([row({})]), drive });
    expect(items.map((i) => [i.id, i.done])).toEqual([["password", true], ["written-down", true], ["mirror", true], ["offsite", true]]);
  });

  it("flags what's missing, and can't tell what it can't read", () => {
    const items = vaultChecklist({ password: "missing", writtenDown: true, list: list([]), drive: null });
    expect(items.map((i) => [i.id, i.done])).toEqual([["password", false], ["written-down", false], ["mirror", false], ["offsite", null]]);
    const unknown = vaultChecklist({ password: "unknown", writtenDown: false, list: null, drive: null });
    expect(unknown.every((i) => i.done === null)).toBe(true);
    expect(vaultChecklist({ password: "set", writtenDown: false, list: list([row({ alert: "the last copy failed", ok: false })]), drive }).filter((i) => !i.done).map((i) => i.id)).toEqual(["written-down", "mirror"]);
  });
});
