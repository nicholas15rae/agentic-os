import { useState } from "react";
import { ChevronDown, ChevronUp, Cloud, FileAudio, FolderOpen, Image as ImageIcon, Lock, Plus, Upload, Video } from "lucide-react";
import { Card, Empty, Select } from "@/components/ui";
import { useToasts } from "@/features/reminders/notify";
import { DrivePickerModal } from "@/features/cloud/DrivePickerModal";
import { api, fileSrc } from "./api";
import type { AssetRole, MediaAsset } from "./contract";
import { addAssets, editManifest, select, useDirector } from "./director-store";
import { ASSET_MIME, DIALOG_FILTERS, hasFiles, ingestDropped } from "./dnd";
import { INGEST_ROLES, addClip, timecode } from "./manifest";
import { AssetBadges, AssetDetails } from "./AssetDetails";
import { BinSuggestions } from "./BinSuggestions";
import { IntakeStatusLine } from "./IntakeStatus";

export const assetMeta = (a: MediaAsset) => [a.durationSec != null ? timecode(a.durationSec) : null, a.width && a.height ? `${a.width}×${a.height}` : null].filter(Boolean).join(" · ");

export function AssetIcon({ kind, size = 16 }: { kind: MediaAsset["kind"]; size?: number }) {
  const I = kind === "video" ? Video : kind === "image" ? ImageIcon : FileAudio;
  return <I size={size} className="text-ink-3" />;
}

export function Thumb({ asset, className = "" }: { asset: MediaAsset; className?: string }) {
  const src = asset.thumbPath ? fileSrc(asset.thumbPath) : asset.kind === "image" ? fileSrc(asset.path) : "";
  return (
    <div className={`grid shrink-0 place-items-center overflow-hidden rounded-[8px] bg-black/40 ${className}`}>
      {src ? <img src={src} alt="" className="size-full object-cover" draggable={false} /> : <AssetIcon kind={asset.kind} />}
    </div>
  );
}

export function StagingBin() {
  const slug = useDirector((s) => s.slug);
  const assets = useDirector((s) => s.assets);
  const uploads = useDirector((s) => s.uploads);
  const selection = useDirector((s) => s.selection);
  const [role, setRole] = useState<AssetRole>("clip");
  const [over, setOver] = useState(false);
  const [drive, setDrive] = useState(false);
  const projectTitle = useDirector((s) => s.project?.title ?? s.slug ?? "");
  const projectRoot = useDirector((s) => s.project?.root ?? null);
  const [openId, setOpenId] = useState<string | null>(null);

  const pick = async () => {
    if (!slug) return;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const chosen = await open({ multiple: true, filters: DIALOG_FILTERS });
      const paths = chosen == null ? [] : Array.isArray(chosen) ? chosen : [chosen];
      if (!paths.length) return;
      addAssets(await api.ingestPaths({ slug, paths, role }));
    } catch (e) {
      useToasts.getState().push({ title: "Couldn't stage those files", body: e instanceof Error ? e.message : String(e), tone: "error" });
    }
  };

  return (
    <Card
      title="Staging Bin"
      action={
        <>
          <Select value={role} onChange={(e) => setRole(e.target.value as AssetRole)} className="!h-8 !w-auto !py-0 text-[12px]" aria-label="Role for new files">
            {INGEST_ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
          <button onClick={() => void pick()} className="pill-glass !h-8 !px-2.5 text-xs" title="Copy files into this project's raw/ folder (originals untouched)">
            <FolderOpen size={13} /> Add
          </button>
          <button onClick={() => setDrive(true)} disabled={!slug} className="pill-glass !h-8 !px-2.5 text-xs disabled:opacity-50" title="From Google Drive… import footage from a Drive folder into this project" aria-label="From Google Drive…">
            <Cloud size={13} /> Drive…
          </button>
          {drive && slug && <DrivePickerModal slug={slug} projectTitle={projectTitle} role={role} onRole={setRole} onClose={() => setDrive(false)} />}
        </>
      }
    >
      <IntakeStatusLine />
      <BinSuggestions />
      <div
        onDragOver={(e) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          if (!hasFiles(e) || !slug) return;
          e.preventDefault();
          setOver(false);
          void ingestDropped(slug, Array.from(e.dataTransfer.files), role);
        }}
        className={`rounded-[14px] border border-dashed p-2 transition-colors ${over ? "border-teal/70 bg-teal/5" : "border-white/10"}`}
      >
        {Object.entries(uploads).map(([k, u]) => (
          <div key={k} className="mb-2 rounded-[10px] bg-white/[0.03] p-2">
            <p className="truncate text-[12px] text-ink-2">
              <Upload size={11} className="mr-1 inline" />
              {u.name}
            </p>
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/10">
              <div className="h-full bg-teal transition-[width]" style={{ width: `${u.total ? Math.round((u.received / u.total) * 100) : 0}%` }} />
            </div>
          </div>
        ))}
        {assets.length ? (
          <ul className="space-y-1.5">
            {assets.map((a) => {
              const on = selection?.kind === "asset" && selection.id === a.id;
              const open = openId === a.id;
              return (
                <li key={a.id}>
                <div
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(ASSET_MIME, a.id);
                    e.dataTransfer.effectAllowed = "copy";
                  }}
                  onClick={() => select({ kind: "asset", id: a.id })}
                  className={`group flex cursor-grab items-center gap-2 rounded-[12px] border p-1.5 active:cursor-grabbing ${on ? "border-amber/40 bg-amber/10" : "border-transparent hover:bg-white/5"}`}
                >
                  <Thumb asset={a} className="h-10 w-16" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] text-ink" title={a.name}>
                      {a.name}
                    </p>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1">
                      <span className="rounded-full border border-white/10 px-1.5 font-mono text-[10px] text-ink-2">
                        {a.kind}/{a.role}
                      </span>
                      {a.readOnly && (
                        <span className="flex items-center gap-0.5 rounded-full border border-teal/30 px-1.5 text-[10px] text-teal-soft" title="The original copy in raw/ is read-only">
                          <Lock size={9} /> Raw · read-only
                        </span>
                      )}
                      <span className="font-mono text-[10px] text-ink-3">{assetMeta(a)}</span>
                      <AssetBadges asset={a} />
                      {a.tags.slice(0, 3).map((t) => (
                        <span key={t} className="rounded-full border border-teal/25 px-1.5 text-[10px] text-teal-soft">
                          {t}
                        </span>
                      ))}
                      {a.tags.length > 3 && <span className="text-[10px] text-ink-3">+{a.tags.length - 3}</span>}
                    </div>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpenId(open ? null : a.id);
                    }}
                    className="pill-glass !h-7 !w-7 shrink-0 !p-0 opacity-70 group-hover:opacity-100"
                    title={open ? "Hide details" : "Tags, transcript, moments"}
                    aria-label={open ? `Hide details for ${a.name}` : `Details for ${a.name}`}
                    aria-expanded={open}
                  >
                    {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      editManifest((m) => addClip(m, a));
                    }}
                    className="pill-glass !h-7 !w-7 shrink-0 !p-0 opacity-70 group-hover:opacity-100"
                    title={a.kind === "audio" ? "Add to the audio lane" : "Add to the timeline"}
                    aria-label={`Add ${a.name} to the timeline`}
                  >
                    <Plus size={12} />
                  </button>
                </div>
                {open && <AssetDetails asset={a} projectRoot={projectRoot} />}
                </li>
              );
            })}
          </ul>
        ) : (
          <Empty>Drop clips, photos or audio here, or use Add.</Empty>
        )}
      </div>
    </Card>
  );
}
