import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Cloud, FileAudio, FolderOpen, Image as ImageIcon, Lock, Plus, Upload, Video } from "lucide-react";
import { Card, Empty, Select } from "@/components/ui";
import { useToasts } from "@/features/reminders/notify";
import { DrivePickerModal } from "@/features/cloud/DrivePickerModal";
import { api, fileSrc } from "./api";
import type { AssetFlag, AssetRole, MediaAsset } from "./contract";
import { addAssets, editManifest, select, useDirector } from "./director-store";
import { ASSET_MIME, DIALOG_FILTERS, hasFiles, ingestDropped } from "./dnd";
import { INGEST_ROLES, addClip, timecode } from "./manifest";
import { AssetBadges, AssetDetails, GeneratedChip } from "./AssetDetails";
import { BinSuggestions } from "./BinSuggestions";
import { IntakeStatusLine } from "./IntakeStatus";
import { FLAG_LABEL } from "./review-ui";

export const assetMeta = (a: MediaAsset) => [a.durationSec != null ? timecode(a.durationSec) : null, a.width && a.height ? `${a.width}×${a.height}` : null].filter(Boolean).join(" · ");

export function AssetIcon({ kind, size = 16 }: { kind: MediaAsset["kind"]; size?: number }) {
  const I = kind === "video" ? Video : kind === "image" ? ImageIcon : FileAudio;
  return <I size={size} className="text-ink-3" />;
}

export function Thumb({ asset, className = "" }: { asset: MediaAsset; className?: string }) {
  const src = asset.thumbPath ? fileSrc(asset.thumbPath) : asset.kind === "image" ? fileSrc(asset.path) : "";
  return (
    <div className={`grid shrink-0 place-items-center overflow-hidden r-8 bg-black/40 ${className}`}>
      {src ? <img src={src} alt="" className="size-full object-cover" draggable={false} /> : <AssetIcon kind={asset.kind} />}
    </div>
  );
}

// ── Part 3 B.3: bin filters ──────────────────────────────────────────────────

export interface BinFilter {
  tag: string | null;
  /** "any": at least one flag; a kind: that flag; null: no flag filter. */
  flag: AssetFlag["kind"] | "any" | null;
  generatedOnly: boolean;
}
export const NO_BIN_FILTER: BinFilter = { tag: null, flag: null, generatedOnly: false };
const filterOn = (f: BinFilter) => f.tag != null || f.flag != null || f.generatedOnly;

/** Pure. tag: asset.tags includes it; flag "any": ≥ 1 flag, a kind: that flag; generatedOnly: asset.generation != null. Keeps order. */
export function filterAssets(assets: MediaAsset[], f: BinFilter): MediaAsset[] {
  return assets.filter(
    (a) =>
      (f.tag == null || (a.tags ?? []).includes(f.tag)) &&
      (f.flag == null || (f.flag === "any" ? (a.flags ?? []).length > 0 : (a.flags ?? []).some((x) => x.kind === f.flag))) &&
      (!f.generatedOnly || a.generation != null),
  );
}

/** Tags in use, most used first (ties alphabetical), for the tag Select. Pure. */
export function binTags(assets: MediaAsset[]): string[] {
  const n = new Map<string, number>();
  for (const a of assets) for (const t of new Set(a.tags ?? [])) n.set(t, (n.get(t) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
}

/** Flag kinds present in the bin, in FLAG_LABEL order. Pure. */
export function binFlagKinds(assets: MediaAsset[]): AssetFlag["kind"][] {
  const have = new Set(assets.flatMap((a) => (a.flags ?? []).map((f) => f.kind)));
  return (Object.keys(FLAG_LABEL) as AssetFlag["kind"][]).filter((k) => have.has(k));
}

/** One compact row under the bin's header: tag, flag, "Generated", and "Showing 3 of 12 · Clear"
 * while a filter is on. Null when the bin has fewer than 4 assets and no filter is on. Props only. */
export function BinFilterBarView({ filter, tags, flagKinds, shown, total, onChange }: { filter: BinFilter; tags: string[]; flagKinds: AssetFlag["kind"][]; shown: number; total: number; onChange: (f: BinFilter) => void }) {
  const on = filterOn(filter);
  if (total < 4 && !on) return null;
  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5" role="group" aria-label="Bin filters">
      {(tags.length > 0 || filter.tag != null) && (
        <Select value={filter.tag ?? ""} onChange={(e) => onChange({ ...filter, tag: e.target.value || null })} className="!h-7 !w-auto max-w-[130px] !py-0 fs-11" aria-label="Filter by tag">
          <option value="">All tags</option>
          {filter.tag != null && !tags.includes(filter.tag) && <option value={filter.tag}>{filter.tag}</option>}
          {tags.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
      )}
      {(flagKinds.length > 0 || filter.flag != null) && (
        <Select value={filter.flag ?? ""} onChange={(e) => onChange({ ...filter, flag: (e.target.value || null) as BinFilter["flag"] })} className="!h-7 !w-auto max-w-[130px] !py-0 fs-11" aria-label="Filter by flag">
          <option value="">All flags</option>
          <option value="any">Any flag</option>
          {filter.flag != null && filter.flag !== "any" && !flagKinds.includes(filter.flag) && <option value={filter.flag}>{FLAG_LABEL[filter.flag]}</option>}
          {flagKinds.map((k) => (
            <option key={k} value={k}>
              {FLAG_LABEL[k]}
            </option>
          ))}
        </Select>
      )}
      <button
        type="button"
        onClick={() => onChange({ ...filter, generatedOnly: !filter.generatedOnly })}
        aria-pressed={filter.generatedOnly}
        className={`h-7 rounded-full border px-2.5 fs-11 ${filter.generatedOnly ? "border-violet/50 bg-violet/10 text-violet" : "border-white/10 text-ink-2 hover:text-ink"}`}
      >
        Generated
      </button>
      {on && (
        <span className="ml-auto fs-11 text-ink-3">
          Showing {shown} of {total} ·{" "}
          <button type="button" onClick={() => onChange(NO_BIN_FILTER)} className="text-teal-soft hover:underline">
            Clear
          </button>
        </span>
      )}
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
  // Bin filter: local, reset on project switch, not persisted.
  const [filter, setFilter] = useState<BinFilter>(NO_BIN_FILTER);
  useEffect(() => setFilter(NO_BIN_FILTER), [slug]);
  const shown = filterAssets(assets, filter);

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
          <Select value={role} onChange={(e) => setRole(e.target.value as AssetRole)} className="!h-8 !w-auto !py-0 fs-12" aria-label="Role for new files">
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
      <BinFilterBarView filter={filter} tags={binTags(assets)} flagKinds={binFlagKinds(assets)} shown={shown.length} total={assets.length} onChange={setFilter} />
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
        className={`r-14 border border-dashed p-2 transition-colors ${over ? "border-teal/70 bg-teal/5" : "border-white/10"}`}
      >
        {Object.entries(uploads).map(([k, u]) => (
          <div key={k} className="mb-2 r-10 bg-white/[0.03] p-2">
            <p className="truncate fs-12 text-ink-2">
              <Upload size={11} className="mr-1 inline" />
              {u.name}
            </p>
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/10">
              <div className="h-full bg-teal transition-[width]" style={{ width: `${u.total ? Math.round((u.received / u.total) * 100) : 0}%` }} />
            </div>
          </div>
        ))}
        {shown.length ? (
          <ul className="space-y-1.5">
            {shown.map((a) => {
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
                  className={`group flex cursor-grab items-center gap-2 r-12 border p-1.5 active:cursor-grabbing ${on ? "border-amber/40 bg-amber/10" : "border-transparent hover:bg-white/5"}`}
                >
                  <Thumb asset={a} className="h-10 w-16" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate fs-13 text-ink" title={a.name}>
                      {a.name}
                    </p>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1">
                      <span className="rounded-full border border-white/10 px-1.5 font-mono fs-10 text-ink-2">
                        {a.kind}/{a.role}
                      </span>
                      {a.readOnly && (
                        <span className="flex items-center gap-0.5 rounded-full border border-teal/30 px-1.5 fs-10 text-teal-soft" title="The original copy in raw/ is read-only">
                          <Lock size={9} /> Raw · read-only
                        </span>
                      )}
                      <GeneratedChip asset={a} />
                      <span className="font-mono fs-10 text-ink-3">{assetMeta(a)}</span>
                      <AssetBadges asset={a} />
                      {a.tags.slice(0, 3).map((t) => (
                        <span key={t} className="rounded-full border border-teal/25 px-1.5 fs-10 text-teal-soft">
                          {t}
                        </span>
                      ))}
                      {a.tags.length > 3 && <span className="fs-10 text-ink-3">+{a.tags.length - 3}</span>}
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
        ) : assets.length ? (
          <Empty>Nothing in the bin matches the filter.</Empty>
        ) : (
          <Empty>Drop clips, photos or audio here, or use Add.</Empty>
        )}
      </div>
    </Card>
  );
}
