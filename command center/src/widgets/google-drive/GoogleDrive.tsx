import { useEffect, useState } from "react";
import { Loader2, ShieldCheck } from "lucide-react";
import { Empty, WidgetHeader } from "@/components/WidgetHeader";
import type { WidgetProps } from "@/core/widgets/types";
import { isTauri } from "@/lib/platform";
import { api as mediaApi } from "@/features/director/api";
import type { AssetRole } from "@/features/director/contract";
import { DriveGate } from "@/features/cloud/DriveGate";
import { DriveBrowser } from "@/features/cloud/DriveBrowser";
import { PullBar } from "@/features/cloud/PullBar";
import { TransferList } from "@/features/cloud/TransferList";
import { RenderCloudActions } from "@/features/cloud/RenderCloudActions";
import { errText, useCloud } from "@/features/cloud/cloud-store";
import { formatBytes, formatDuration, baseName } from "@/features/cloud/format";
import { recentRenders, type OutboxRow } from "@/features/cloud/match";
import type { DriveConfig } from "./index";

/** Small grid sizes drop metadata and secondary buttons. */
export const isCompact = (size: { w: number; h: number }) => size.w <= 3 || size.h <= 3;
/** Outbox: at most this many verified renders, from the newest projects. */
export const OUTBOX_CAP = 30;
const OUTBOX_PROJECTS = 15;

export default function GoogleDrive(props: WidgetProps<DriveConfig>) {
  if (!isTauri())
    return (
      <div className="flex h-full flex-col">
        <WidgetHeader title="Google Drive" />
        <Empty>Google Drive runs in the desktop app.</Empty>
      </div>
    );
  return <GoogleDriveDesktop {...props} />;
}

function GoogleDriveDesktop({ config, setConfig, size }: WidgetProps<DriveConfig>) {
  const compact = isCompact(size);
  const tab = config.tab === "outbox" ? "outbox" : "inbox";
  return (
    <div className="flex h-full min-h-0 flex-col">
      <WidgetHeader
        title="Google Drive"
        status={
          <div role="tablist" className="well flex gap-0.5 rounded-full p-0.5">
            {(["inbox", "outbox"] as const).map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                onClick={() => setConfig({ tab: t })}
                className={`rounded-full px-2.5 py-0.5 text-[11px] capitalize transition-colors ${tab === t ? "border border-white/10 bg-raised text-ink" : "text-ink-2 hover:text-ink"}`}
              >
                {t}
              </button>
            ))}
          </div>
        }
      />
      <DriveGate compact={compact}>{tab === "inbox" ? <InboxTab config={config} setConfig={setConfig} compact={compact} /> : <OutboxTab compact={compact} />}</DriveGate>
    </div>
  );
}

function InboxTab({ config, setConfig, compact }: { config: DriveConfig; setConfig: (p: Partial<DriveConfig>) => void; compact: boolean }) {
  const inbox = useCloud((s) => s.status?.inboxFolder?.id ?? null);
  const [role, setRole] = useState<AssetRole>("clip");
  return (
    <>
      <DriveBrowser startFolderId={inbox} compact={compact} />
      <PullBar project={config.targetProject} onProject={(slug) => setConfig({ targetProject: slug })} role={role} onRole={setRole} compact={compact} />
      <TransferList direction="pull" limit={compact ? 2 : 4} />
    </>
  );
}

function OutboxTab({ compact }: { compact: boolean }) {
  const [rows, setRows] = useState<OutboxRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const browsed = useCloud((s) => s.listing?.folder ?? null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const projects = [...(await mediaApi.projects())].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, OUTBOX_PROJECTS);
        const got = await Promise.all(projects.map((p) => mediaApi.projectGet({ slug: p.slug }).then((d) => ({ project: d.project, renders: d.renders })).catch(() => ({ project: p, renders: [] }))));
        if (live) setRows(recentRenders(got, OUTBOX_CAP));
      } catch (e) {
        if (live) setError(errText(e));
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  if (error) return <p className="text-[12px] text-alert">{error}</p>;
  if (!rows)
    return (
      <div className="grid flex-1 place-items-center text-ink-3">
        <Loader2 size={15} className="animate-spin" />
      </div>
    );
  if (!rows.length) return <Empty>No verified renders yet. Render one in the Director Suite.</Empty>;
  return (
    <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto">
      {rows.map(({ render: r, projectTitle }) => (
        <li key={r.id} className="rounded-[12px] border border-white/[0.08] p-2">
          <p className="flex items-center gap-1 truncate text-[13px] text-ink" title={r.path}>
            <ShieldCheck size={12} className="shrink-0 text-teal" /> {baseName(r.path)}
          </p>
          {!compact && (
            <p className="truncate font-mono text-[10px] text-ink-3">
              {projectTitle} · {formatDuration(r.durationSec)} · {r.width}×{r.height} · {formatBytes(r.sizeBytes)}
            </p>
          )}
          <RenderCloudActions render={r} origin="outbox" compact={compact} extraFolder={browsed} />
        </li>
      ))}
    </ul>
  );
}
