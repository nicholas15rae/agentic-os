import { useEffect, useState } from "react";
import { Archive, CheckCircle2, CircleDashed, CloudUpload, Copy, Database, HardDriveDownload, Loader2, RefreshCw, Search, XCircle } from "lucide-react";
import { Card, Chip, Field, Input, Stat } from "@/components/ui";
import { backupSummary, cc, type BackupList, type CcConfig, type Collection } from "@/lib/cc-api";
import { gateway } from "@/lib/gateway";
import { useNav } from "@/stores/nav";
import { cmd, isTauri, type PipelinesSettings, type SyncResult } from "@/lib/platform";
import { MemoryLifecycleCard } from "@/sections/settings/MemorySettings";
import { useOs } from "@/features/os/os-store";
import { LayoutSurface } from "@/core/widgets/LayoutSurface";
import { panelShown, revealPanel } from "@/core/widgets/reveal";
import type { WidgetProps } from "@/core/widgets/types";
import { useVaultLayout } from "./vault/panels";
import { useVaultSearch } from "./vault/vault-store";
import { focusVaultPasswordRow, VaultPasswordBanner } from "@/sections/settings/VaultPasswordBanner";
import { useKeySources } from "@/features/integrations/key-sources";
import { driveSyncState, mirrorAlerts, vaultChecklist, vaultPasswordState, type DriveSyncState } from "@/features/vault/safety";

const FILTERS: { id: Collection; label: string }[] = [
  { id: "notes", label: "Brainstorms" },
  { id: "receipts", label: "Receipts" },
  { id: "invoices", label: "Invoices" },
  { id: "checks", label: "Cheques" },
  { id: "pipeline", label: "Scripts & auditions" },
  { id: "projects", label: "Jobs" },
  { id: "documents", label: "Documents" },
  { id: "ideas", label: "Ideas" },
  { id: "playplace", label: "Prototypes" },
];

const OPEN: Partial<Record<Collection, Parameters<ReturnType<typeof useNav.getState>["go"]>[0]>> = {
  notes: "brainstorm",
  receipts: "finance",
  invoices: "finance",
  checks: "finance",
};

/**
 * Local vector vault (semantic + keyword search) and offline backups, on the shared layout system:
 * the search box, its results, backups and (desktop) the memory lifecycle are panels.
 */
export function VaultSection() {
  // The old page's search lived in local state: it is cleared when the page closes.
  useEffect(() => () => useVaultSearch.getState().clear(), []);
  return <LayoutSurface store={useVaultLayout} label="Vault" />;
}

/** The search box and collection filters. */
export function VaultSearchPanel() {
  const { q, filters, busy, err, setQ, toggle, search } = useVaultSearch();
  const run = async () => {
    // A search always lands on visible results.
    if ((await search()) && !panelShown(useVaultLayout.getState(), "va-results")) revealPanel(useVaultLayout, "va-results", "Vault");
  };
  return (
    <Card
      title="Vault search"
      hint="Brainstorms (transcripts, summaries, tags), scripts & auditions, jobs, documents, ideas, prototypes, and your receipts, invoices and cheques are embedded locally — ask in plain language. Falls back to keyword search if no embedding model is loaded."
    >
      {isTauri() && <VaultPasswordBanner />}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <div className="relative flex-1">
          <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-3" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="“the Home Depot receipts for the deck job”, “that idea about a car reel”…" className="!pl-10" aria-label="Search the vault" autoFocus />
        </div>
        <button className="pill-primary shrink-0" disabled={busy || !q.trim()}>
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />} Search
        </button>
      </form>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <Chip key={f.id} active={filters.has(f.id)} onClick={() => toggle(f.id)}>
            {f.label}
          </Chip>
        ))}
      </div>
      {err && <p className="mt-3 text-sm text-alert">{err}</p>}
    </Card>
  );
}

/** The last search's results; a tap opens the page the item lives on. */
export function VaultResultsPanel({ setBadge }: WidgetProps) {
  const res = useVaultSearch((s) => s.res);
  const go = useNav((s) => s.go);
  const count = res ? res.results.length : null;
  useEffect(() => {
    setBadge?.(count ? String(count) : null);
  }, [count, setBadge]);
  return (
    <Card title="Results">
      {!res ? (
        <p className="text-sm text-ink-3">Search the vault and what it finds shows here.</p>
      ) : (
        <div className="space-y-2" data-no-hold>
          <p className="label-caps text-ink-3">
            {res.results.length} results · {res.mode === "hybrid" ? "semantic + keyword" : res.mode}
          </p>
          {res.results.map((r) => (
            <button
              key={r.id}
              onClick={() => OPEN[r.collection] && go(OPEN[r.collection]!)}
              className="block w-full r-14 border border-white/[0.07] bg-white/[0.02] p-3 text-left hover:border-amber/40"
            >
              <div className="mb-1 flex items-center gap-2">
                <span className="label-caps text-amber-soft">{FILTERS.find((f) => f.id === r.collection)?.label ?? r.collection}</span>
                <span className="ml-auto font-mono fs-11 text-ink-3">{(r.score * 100).toFixed(0)}%</span>
              </div>
              <p className="line-clamp-3 whitespace-pre-line text-sm text-ink">{r.snippet}</p>
            </button>
          ))}
          {!res.results.length && <p className="text-sm text-ink-3">Nothing matched.</p>}
        </div>
      )}
    </Card>
  );
}

/** The memory lifecycle card (desktop app); it draws nothing until the OS config loads. */
export function VaultMemoryPanel() {
  const ready = useOs((s) => !!s.cfg);
  const error = useOs((s) => s.error);
  if (!isTauri()) return null;
  return (
    <>
      <VaultChecklistCard />
      <MemoryLifecycleCard passwordBanner={false} />
      {!ready && (
        <Card title="Memory lifecycle">
          <p className="text-sm text-ink-3">{error ? `Couldn't load the OS config: ${error}` : "Loading the OS config…"}</p>
        </Card>
      )}
    </>
  );
}

/**
 * GET /api/cc/backups with a longer timeout than the default: it probes the mirror folders
 * (bounded on the gateway, ~2 s, cached a minute), and a slow answer must not blank the card.
 */
const BACKUPS_TIMEOUT_MS = 45_000;
const fetchBackups = () => gateway<BackupList>("/api/cc/backups", { timeoutMs: BACKUPS_TIMEOUT_MS });

export function BackupCard() {
  const [cfg, setCfg] = useState<CcConfig | null>(null);
  const [list, setList] = useState<BackupList | null>(null);
  const [health, setHealth] = useState<Awaited<ReturnType<typeof cc.health>> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [drive, setDrive] = useState<{ settings: PipelinesSettings; last: SyncResult | null } | null>(null);

  const load = async () => {
    if (isTauri()) {
      // Saved settings + the last recorded sync only: no n8n poll, no network.
      void Promise.all([cmd("pipelines_settings"), cmd("pipelines_last_sync").catch(() => null)])
        .then(([settings, last]) => setDrive({ settings, last }))
        .catch(() => setDrive(null));
    }
    // Loaded separately: a slow backups list (mirror drives) can't blank the schedule / health.
    const backups = fetchBackups()
      .then(setList)
      .catch((e) => setMsg(`Backups list: ${String(e)}`));
    try {
      const [c, h] = await Promise.all([cc.config(), cc.health()]);
      setCfg(c);
      setHealth(h);
    } catch (e) {
      setMsg(`Gateway: ${String(e)}`);
    }
    await backups;
  };
  const driveState = drive ? driveSyncState(drive.settings, drive.last, cfg?.backup.dir) : null;
  const alerts = mirrorAlerts(list);
  useEffect(() => void load(), []);

  const saveBackup = async (patch: Partial<CcConfig["backup"]>) => {
    try {
      setCfg(await cc.setConfig({ backup: patch }));
      setMsg("Schedule saved.");
    } catch (e) {
      setMsg(String(e));
    }
  };

  return (
    <Card
      title="Offline backups"
      hint="Mirrors the shared database (notes, finance, reminders…), scanned documents, gateway config and each device's UI settings into a local folder as timestamped zips. Secrets stay in the OS keychain and are never included."
      action={
        <button onClick={() => void load()} aria-label="Refresh" className="pill-glass !h-8 !w-8 !p-0">
          <RefreshCw size={13} />
        </button>
      }
    >
      {list?.failure && (
        <div role="alert" className="mb-4 rounded-xl border border-alert/40 bg-alert/10 px-3 py-2 text-xs text-ink">
          <p className="font-semibold text-alert">The last backup failed its self-check ({new Date(list.failure.at * 1000).toLocaleString()})</p>
          <ul className="mt-1 list-disc pl-4 text-ink-2">
            {(list.failure.verified?.problems ?? []).map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          <p className="mt-1 text-ink-3">
            Kept aside as {list.failure.file.split(/[\\/]/).pop()}; older good backups were not rotated out.
            {list.lastGood ? ` Last good backup: ${new Date(list.lastGood.at * 1000).toLocaleString()}.` : ""}
          </p>
          <button
            className="pill-glass !h-8 mt-2 text-xs"
            disabled={!!busy}
            title="Only if you really removed that much (deleted scans, a cleared vault): this backup becomes the good one and the new size baseline."
            onClick={async () => {
              const name = list.failure?.file.split(/[\\/]/).pop() ?? "";
              setBusy("accept");
              try {
                const r = (await cc.acceptBackup(name)) as { mirrorsPending?: boolean };
                setMsg(`Accepted ${name} as a good backup.${r?.mirrorsPending ? " Copying it to the mirror folders in the background (Refresh to see)." : ""}`);
                await load();
              } catch (e) {
                setMsg(String(e));
              } finally {
                setBusy(null);
              }
            }}
          >
            It's right, I removed that data
          </button>
        </div>
      )}
      {alerts.length > 0 && (
        <div role="alert" className="mb-4 rounded-xl border border-alert/40 bg-alert/10 px-3 py-2 text-xs text-ink">
          <p className="font-semibold text-alert">{alerts.length === 1 ? "A backup mirror needs a look" : `${alerts.length} backup mirrors need a look`}</p>
          <ul className="mt-1 list-disc pl-4 text-ink-2">
            {alerts.map((a) => (
              <li key={a} className="break-all">
                {a}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-ink-3">The backups in the main folder are not affected; only the second copy is missing. Plug the drive in, then use Mirror latest now.</p>
        </div>
      )}
      {health && (
        <div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-4">
          <Stat label="Items" value={Object.values(health.counts).reduce((a, b) => a + b, 0)} sub={Object.entries(health.counts).map(([k, v]) => `${k} ${v}`).join(" · ") || "—"} />
          <Stat label="Vault" value={`${health.vault.embedded}/${health.vault.items}`} sub="embedded / indexed" tone="teal" />
          <Stat label="Local LLM" value={health.llm.ok ? "online" : "offline"} sub={health.llm.ok ? `${health.llm.models?.length ?? 0} models` : health.llm.error} tone={health.llm.ok ? "teal" : "alert"} />
          <Stat label="Last backup" value={list?.last ? new Date(list.last.at * 1000).toLocaleDateString() : "never"} sub={list?.last ? `${(list.last.size / 1024).toFixed(0)} KB · ${list.last.reason}` : undefined} tone="amber" />
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          className="pill-primary"
          disabled={!!busy}
          onClick={async () => {
            setBusy("backup");
            try {
              const b = await cc.backupNow();
              setMsg(backupSummary(b));
              await load();
            } catch (e) {
              setMsg(String(e));
            } finally {
              setBusy(null);
            }
          }}
        >
          {busy === "backup" ? <Loader2 size={15} className="animate-spin" /> : <HardDriveDownload size={15} />} Backup now
        </button>
        <button
          className="pill-glass"
          disabled={!!busy}
          onClick={async () => {
            setBusy("reindex");
            try {
              const r = await cc.reindex();
              setMsg(`Re-embedding ${r.queued} items in the background.`);
            } finally {
              setBusy(null);
            }
          }}
        >
          <Database size={15} /> Re-index vault
        </button>
      </div>
      {cfg && (
        <div className="mt-4 grid gap-3 sm:grid-cols-[auto_1fr_1fr_2fr]">
          <label className="flex items-center gap-2 self-end pb-2.5 text-sm text-ink-2">
            <input type="checkbox" checked={cfg.backup.enabled} onChange={(e) => void saveBackup({ enabled: e.target.checked })} className="accent-amber" /> Scheduled
          </label>
          <Field label="Every (hours)">
            <Input type="number" min={1} max={720} defaultValue={cfg.backup.intervalHours} onBlur={(e) => void saveBackup({ intervalHours: Number(e.target.value) })} className="font-mono" />
          </Field>
          <Field label="Keep last">
            <Input type="number" min={1} max={365} defaultValue={cfg.backup.keep} onBlur={(e) => void saveBackup({ keep: Number(e.target.value) })} className="font-mono" />
          </Field>
          <Field label="Backup folder (on the gateway machine)">
            <Input defaultValue={cfg.backup.dir} onBlur={(e) => e.target.value !== cfg.backup.dir && void saveBackup({ dir: e.target.value })} className="font-mono !fs-12" spellCheck={false} />
          </Field>
        </div>
      )}
      {cfg && <MirrorsPanel cfg={cfg} list={list} busy={busy} setBusy={setBusy} setMsg={setMsg} onSaved={setCfg} reload={load} />}
      {isTauri() && <OffsitePanel drive={driveState} />}
      {msg && <p className="mt-3 break-all text-xs text-ink-2">{msg}</p>}
      {list && list.backups.length > 0 && (
        <ul className="mt-4 max-h-56 space-y-1 overflow-y-auto font-mono fs-12">
          {list.backups.map((b) => (
            <li key={b.name} className="flex items-center gap-2 r-10 border border-white/[0.05] px-3 py-1.5 text-ink-2">
              <Archive size={12} className="text-ink-3" />
              <span className="flex-1 truncate">{b.name}</span>
              <span>{(b.size / 1024).toFixed(0)} KB</span>
              <span className="text-ink-3">{new Date(b.at * 1000).toLocaleString()}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

const when = (secs?: number | null) => (secs ? new Date(secs * 1000).toLocaleString() : "never");

/** Section 16.2: second copies of each verified backup on another drive. */
function MirrorsPanel({
  cfg,
  list,
  busy,
  setBusy,
  setMsg,
  onSaved,
  reload,
}: {
  cfg: CcConfig;
  list: BackupList | null;
  busy: string | null;
  setBusy: (b: string | null) => void;
  setMsg: (m: string | null) => void;
  onSaved: (c: CcConfig) => void;
  reload: () => Promise<void>;
}) {
  const dirs = cfg.backup.mirrorDirs ?? [];
  const rows = list?.mirrors ?? [];
  const save = async (patch: { mirrorDirs?: string[]; mirrorKeep?: number }) => {
    try {
      onSaved(await cc.setConfig({ backup: patch }));
      setMsg("Mirror settings saved.");
      await reload();
    } catch (e) {
      setMsg(String(e));
    }
  };
  return (
    <div className="mt-5 border-t border-white/[0.06] pt-4">
      <p className="label-caps text-amber-soft">Second copies</p>
      <p className="mt-1 text-xs leading-relaxed text-ink-3">
        After each backup passes its self-check, the zip is copied to these folders (another drive, e.g. D:\Backups\cc-mirror) and the copy is checked: same size, a readable zip, the same SHA-256. A mirror never removes anything unless you set Keep below; then only copies the gateway wrote there are removed.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-[3fr_1fr]">
        <Field label="Mirror folders (one per line, on the gateway machine)">
          <textarea
            key={dirs.join("|")}
            defaultValue={dirs.join("\n")}
            rows={Math.max(2, dirs.length + 1)}
            spellCheck={false}
            placeholder="D:\Backups\cc-mirror"
            aria-label="Mirror folders"
            className="field font-mono !fs-12"
            onBlur={(e) => {
              const next = e.target.value
                .split(/\r?\n/)
                .map((x) => x.trim())
                .filter(Boolean);
              if (next.join("|") !== dirs.join("|")) void save({ mirrorDirs: next });
            }}
          />
        </Field>
        <Field label="Keep in each mirror (0 = all)">
          <Input
            type="number"
            min={0}
            max={365}
            defaultValue={cfg.backup.mirrorKeep ?? 0}
            onBlur={(e) => Number(e.target.value) !== (cfg.backup.mirrorKeep ?? 0) && void save({ mirrorKeep: Number(e.target.value) })}
            className="font-mono"
          />
        </Field>
      </div>
      {rows.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {rows.map((r) => (
            <li key={r.dir} className="flex flex-wrap items-center gap-2 r-10 border border-white/[0.05] px-3 py-1.5 fs-12">
              {r.alert ? <XCircle size={13} className="text-alert" /> : r.ok ? <CheckCircle2 size={13} className="text-teal" /> : <CircleDashed size={13} className="text-ink-3" />}
              <span className="min-w-0 flex-1 truncate font-mono text-ink-2" title={r.dir}>
                {r.dir}
              </span>
              <span className={r.alert ? "text-alert" : "text-ink-3"}>{r.alert ? (r.reachable ? "failed" : "unreachable") : r.ok ? "ok" : "not copied yet"}</span>
              <span className="text-ink-3">last good copy: {when(r.lastOkAt)}</span>
              {r.alert && <p className="w-full break-all fs-11 text-ink-3">{r.alert}</p>}
            </li>
          ))}
        </ul>
      )}
      {dirs.length > 0 && (
        <button
          className="pill-glass mt-3 !h-8 text-xs"
          disabled={!!busy}
          onClick={async () => {
            setBusy("mirror");
            try {
              const r = await cc.mirrorNow();
              const all = Object.values(r.mirrors);
              const bad = all.filter((m) => !m.ok).length;
              setMsg(bad ? `Copied to ${all.length - bad}/${all.length} mirrors; ${bad} failed (see above).` : `Copied the newest backup to ${all.length} mirror${all.length === 1 ? "" : "s"} and verified it.`);
              await reload();
            } catch (e) {
              setMsg(String(e));
            } finally {
              setBusy(null);
            }
          }}
        >
          {busy === "mirror" ? <Loader2 size={13} className="animate-spin" /> : <Copy size={13} />} Mirror latest now
        </button>
      )}
    </div>
  );
}

/** The off-site copy is the Google Drive sync (n8n gdrive-sync): status only, from saved settings. */
function OffsitePanel({ drive }: { drive: DriveSyncState | null }) {
  const go = useNav((s) => s.go);
  return (
    <div className="mt-5 border-t border-white/[0.06] pt-4">
      <p className="label-caps flex items-center gap-1.5 text-amber-soft">
        <CloudUpload size={13} /> Off-site copy
      </p>
      <p className="mt-1 text-xs leading-relaxed text-ink-3">
        There is no separate cloud uploader: the off-site copy is the Google Drive sync in Settings → Integrations → n8n &amp; Cloud Backup (the gdrive-sync workflow). It uploads the tracked folders as they are (not encrypted) and sends files over 1 MB as metadata only, so full backup zips stay on your own drives: keep a mirror on a second drive for those.
      </p>
      {!drive ? (
        <p className="mt-2 text-xs text-ink-3">Drive sync status unavailable.</p>
      ) : (
        <ul className="mt-2 space-y-0.5 text-xs text-ink-2">
          <li>
            Configured: <span className={drive.configured ? "text-teal" : "text-alert"}>{drive.configured ? "yes (webhook set)" : "no"}</span>
            {drive.configured && ` · automatic: ${drive.auto ? `every ${drive.autoHours} h` : "off (manual only)"}`}
          </li>
          <li>
            Last sync:{" "}
            {drive.last ? (
              <span className={drive.lastOk ? "text-teal" : "text-alert"}>
                {drive.last.status} · {new Date(drive.last.at).toLocaleString()}
                {drive.last.detail ? ` · ${drive.last.detail}` : ""}
              </span>
            ) : (
              "never"
            )}
          </li>
          <li>Gateway backup folder tracked: {drive.tracksBackups ? "yes" : "no"}</li>
        </ul>
      )}
      <button className="pill-glass mt-2 !h-8 text-xs" onClick={() => go("settings")}>
        Open Settings
      </button>
    </div>
  );
}

const WRITTEN_DOWN_KEY = "cc.vault.passwordWrittenDown";
function readWrittenDown(): boolean {
  try {
    return localStorage.getItem(WRITTEN_DOWN_KEY) === "1";
  } catch {
    return false;
  }
}

/** Section 16.3: the Vault safety checklist (desktop: the keychain and Drive settings live there). */
function VaultChecklistCard() {
  const { data } = useKeySources();
  const [list, setList] = useState<BackupList | null>(null);
  const [drive, setDrive] = useState<DriveSyncState | null>(null);
  const [writtenDown, setWrittenDown] = useState(readWrittenDown);
  useEffect(() => {
    void fetchBackups().then(setList).catch(() => setList(null));
    void Promise.all([cmd("pipelines_settings"), cmd("pipelines_last_sync").catch(() => null), cc.config().catch(() => null)])
      .then(([s, last, c]) => setDrive(driveSyncState(s, last, c?.backup.dir)))
      .catch(() => setDrive(null));
  }, []);
  const password = vaultPasswordState(data);
  const items = vaultChecklist({ password, writtenDown, list, drive });
  return (
    <Card title="Vault safety checklist" hint="What keeps your vault and backups recoverable. Read-only: nothing here changes a setting.">
      <ul className="space-y-1.5">
        {items.map((it) => (
          <li key={it.id} className="flex items-start gap-2 text-sm">
            {it.done === true ? (
              <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-teal" />
            ) : it.done === false ? (
              <XCircle size={15} className="mt-0.5 shrink-0 text-alert" />
            ) : (
              <CircleDashed size={15} className="mt-0.5 shrink-0 text-ink-3" />
            )}
            <span className="min-w-0 flex-1">
              <span className="text-ink">{it.label}</span>
              <span className="block text-xs text-ink-3">{it.hint}</span>
              {it.id === "password" && it.done === false && (
                <button type="button" className="pill-glass !h-7 mt-1 text-xs" onClick={() => focusVaultPasswordRow()}>
                  Set it
                </button>
              )}
              {it.id === "written-down" && password === "set" && (
                <label className="mt-1 flex items-center gap-2 text-xs text-ink-2">
                  <input
                    type="checkbox"
                    className="accent-amber"
                    checked={writtenDown}
                    onChange={(e) => {
                      setWrittenDown(e.target.checked);
                      try {
                        localStorage.setItem(WRITTEN_DOWN_KEY, e.target.checked ? "1" : "0");
                      } catch {
                        /* this device only; nothing else depends on it */
                      }
                    }}
                  />
                  I wrote it down / saved it in my password manager
                </label>
              )}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
