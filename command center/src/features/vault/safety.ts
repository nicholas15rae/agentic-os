import type { OsKeySources, PipelinesSettings, SyncResult } from "@/lib/platform";
import type { BackupList, MirrorRow } from "@/lib/cc-api";

/**
 * Section 16.2 / 16.3: what keeps the vault safe, read-only and pure: whether the vault password
 * exists (presence only, from `os_secret_sources`; the value is never read), which backup mirrors
 * need a look, whether the Google Drive sync (the off-site copy) is set up, and the checklist the
 * Vault page shows. No network: Drive status comes from the saved pipelines settings and the
 * last recorded sync.
 */

/** "set" = a vault password is in the keychain; "unknown" = not loaded / not the desktop app. */
export type VaultPasswordState = "set" | "missing" | "unknown";

export function vaultPasswordState(src: Pick<OsKeySources, "keys"> | null | undefined): VaultPasswordState {
  const st = src?.keys?.vault;
  if (!st) return "unknown";
  return st.source === "missing" ? "missing" : "set";
}

/** The banner's words (shared by the Vault page and Memory settings). */
export const VAULT_PASSWORD_COPY = {
  title: "No vault password set: archives are being written UNENCRYPTED",
  protects:
    "The vault password locks your Memory Books, fine-tuning datasets and locked archives with AES-256-GCM before they are written to the vault folder.",
  unencrypted: "Until you set one, every archive is written as plain files anyone with access to this PC (or a copy of the folder) can read.",
  lost: "There is no recovery: if you lose the password, archives locked with it can't be opened by anyone, including you.",
  writeItDown: "Write it down somewhere safe or store it in your password manager before you rely on it.",
} as const;

/** Mirror rows that need a look, as "<folder>: <why>" lines (empty = all good). */
export function mirrorAlerts(list: Pick<BackupList, "mirrors"> | null | undefined): string[] {
  return (list?.mirrors ?? []).filter((m: MirrorRow) => !!m.alert).map((m) => `${m.dir}: ${m.alert}`);
}

export interface DriveSyncState {
  /** A gdrive-sync webhook is set (Settings → Integrations → n8n & Cloud Backup). */
  configured: boolean;
  auto: boolean;
  autoHours: number;
  /** The gateway backup folder (or a folder above it) is one of the tracked paths. */
  tracksBackups: boolean;
  last: { status: SyncResult["status"]; at: number; detail: string } | null;
  /** The last sync worked (synced / up-to-date). */
  lastOk: boolean;
}

const norm = (p: string) => p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();

/** Drive sync status from the saved settings and the last recorded result (no network). */
export function driveSyncState(s: Pick<PipelinesSettings, "gdriveSyncWebhookUrl" | "gdriveTrackedPaths" | "autoSyncEnabled" | "autoSyncHours"> | null | undefined, last: SyncResult | null | undefined, backupDir: string | null | undefined): DriveSyncState {
  const configured = !!s?.gdriveSyncWebhookUrl?.trim();
  const dir = backupDir ? norm(backupDir) : "";
  const tracksBackups = !!dir && (s?.gdriveTrackedPaths ?? []).some((p) => {
    const t = norm(p);
    return !!t && !t.startsWith("@") && (dir === t || dir.startsWith(`${t}\\`));
  });
  return {
    configured,
    auto: configured && !!s?.autoSyncEnabled,
    autoHours: s?.autoSyncHours ?? 0,
    tracksBackups,
    last: last ? { status: last.status, at: last.at, detail: last.detail } : null,
    lastOk: !!last && (last.status === "synced" || last.status === "up-to-date"),
  };
}

export interface ChecklistItem {
  id: "password" | "written-down" | "mirror" | "offsite";
  label: string;
  /** null = can't tell from here (not the desktop app / not loaded). */
  done: boolean | null;
  hint: string;
}

/** The Vault safety checklist. `writtenDown` is the user's own tick (this device only). */
export function vaultChecklist(o: { password: VaultPasswordState; writtenDown: boolean; list: Pick<BackupList, "mirrors"> | null; drive: DriveSyncState | null }): ChecklistItem[] {
  const mirrors = o.list?.mirrors ?? [];
  return [
    {
      id: "password",
      label: "Vault password set",
      done: o.password === "unknown" ? null : o.password === "set",
      hint: "Settings → Memory → Vault password. Without it archives are written unencrypted.",
    },
    {
      id: "written-down",
      label: "Vault password written down / in my password manager",
      done: o.password === "set" ? o.writtenDown : o.password === "unknown" ? null : false,
      hint: "A lost password means locked archives can't be opened. There is no recovery key.",
    },
    {
      id: "mirror",
      label: "Backups copied to a second drive",
      done: o.list ? mirrors.length > 0 && mirrors.every((m) => !m.alert && m.ok === true) : null,
      hint: mirrors.length ? "A mirror needs a look (see Second copies)." : "Add a mirror folder on another drive under Second copies.",
    },
    {
      id: "offsite",
      label: "Off-site copy (Google Drive sync)",
      done: o.drive ? o.drive.configured && o.drive.lastOk : null,
      hint: "Settings → Integrations → n8n & Cloud Backup (the gdrive-sync workflow).",
    },
  ];
}
