import { useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Check, PencilLine, Smartphone, Trash2, X } from "lucide-react";
import type { AssetRole, MediaAsset, ShotSlot } from "./contract";
import { editManifest, editShot, moveShot, removeShot, toggleShotFilmed } from "./director-store";
import { draggedAsset, hasFiles, hasType, ASSET_MIME, ingestDropped } from "./dnd";
import { attachSlot } from "./manifest";
import { ShotSlotEditor } from "./ShotSlotEditor";
import { Thumb } from "./StagingBin";

const roleForSlot = (s: ShotSlot): AssetRole => (s.kind === "audio" ? "music" : s.kind === "image" ? (/slate|title|outro|end/i.test(s.label) ? "slate" : "photo") : "clip");

export const SOURCE_TONE: Record<ShotSlot["source"], string> = {
  film: "border-teal/40 text-teal-soft",
  generate: "border-amber/40 text-amber-soft",
  stock: "border-white/20 text-ink-2",
};

/** One shot-list slot: framing / source / tips, the "filmed" tick, attach state and the manual edit controls. */
export function ShotSlotCard({ slot, index, count, slug, asset }: { slot: ShotSlot; index: number; count: number; slug: string | null; asset: MediaAsset | null }) {
  const [over, setOver] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const tone = slot.status === "approved" ? "text-teal" : slot.status === "attached" ? "text-amber-soft" : "text-ink-3";

  if (editing)
    return (
      <li>
        <ShotSlotEditor
          slot={slot}
          onCancel={() => setEditing(false)}
          onSave={(p) => {
            editShot(slot.id, p);
            setEditing(false);
          }}
        />
      </li>
    );

  return (
    <li
      onDragOver={(e) => {
        if (!hasType(e, ASSET_MIME) && !hasFiles(e)) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={async (e) => {
        e.preventDefault();
        setOver(false);
        setRefused(null);
        let a = draggedAsset(e);
        if (!a && hasFiles(e) && slug) a = (await ingestDropped(slug, Array.from(e.dataTransfer.files).slice(0, 1), roleForSlot(slot)))[0] ?? null;
        if (!a) return;
        if (a.kind !== slot.kind) {
          setRefused(`Needs ${slot.kind}, got ${a.kind}`);
          return;
        }
        editManifest((m) => attachSlot(m, slot.id, a));
      }}
      className={`rounded-[14px] border p-2.5 transition-colors ${over ? "border-teal/70 bg-teal/5" : slot.assetId ? "border-white/10 bg-white/[0.02]" : "border-dashed border-white/15"}`}
    >
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10px] text-ink-3">{slot.id}</span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{slot.label}</span>
        <span className="font-mono text-[10px] text-ink-3">
          {slot.kind}
          {slot.targetSec != null ? ` Â· ${slot.targetSec}s` : ""}
        </span>
        <span className={`label-caps ${tone}`}>{slot.status}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {slot.framing && <span className="rounded-full border border-white/10 px-1.5 font-mono text-[10px] text-ink-2">{slot.framing}</span>}
        <span className={`rounded-full border px-1.5 text-[10px] ${SOURCE_TONE[slot.source]}`} title="Who supplies this shot">
          {slot.source}
        </span>
        <label className="ml-auto flex cursor-pointer items-center gap-1 text-[11px] text-ink-2" title="Your filming checklist (separate from attaching footage)">
          <input type="checkbox" checked={slot.filmed} onChange={() => toggleShotFilmed(slot.id)} className="accent-teal" aria-label={`Filmed ${slot.label}`} />
          Filmed
        </label>
      </div>
      {slot.action && <p className="mt-1 text-[12px] leading-snug text-ink">{slot.action}</p>}
      {slot.instructions && <p className="mt-0.5 text-[12px] leading-snug text-ink-2">{slot.instructions}</p>}
      {slot.phoneTips.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {slot.phoneTips.map((t) => (
            <li key={t} className="flex items-start gap-1 text-[11px] text-ink-2">
              <Smartphone size={10} className="mt-0.5 shrink-0 text-ink-3" /> {t}
            </li>
          ))}
        </ul>
      )}
      {asset ? (
        <div className="mt-2 flex items-center gap-2">
          <Thumb asset={asset} className="h-8 w-12" />
          <span className="min-w-0 flex-1 truncate text-[12px] text-ink-2">{asset.name}</span>
          {slot.status === "attached" && (
            <button onClick={() => editManifest((m) => ({ ...m, shotList: m.shotList.map((x) => (x.id === slot.id ? { ...x, status: "approved" } : x)) }))} className="pill-glass !h-7 !w-7 !p-0" title="Approve this shot" aria-label={`Approve ${slot.label}`}>
              <Check size={12} />
            </button>
          )}
          <button onClick={() => editManifest((m) => attachSlot(m, slot.id, null))} className="pill-glass !h-7 !w-7 !p-0" title="Detach" aria-label={`Detach from ${slot.label}`}>
            <X size={12} />
          </button>
        </div>
      ) : (
        <p className="mt-2 text-[11px] text-ink-3">{slot.source === "film" ? `Drop a ${slot.kind} from the bin or your files here.` : `Not attached yet (${slot.source}).`}</p>
      )}
      {refused && <p className="mt-1 text-[11px] text-alert">{refused}</p>}
      <div className="mt-2 flex items-center gap-1 border-t border-white/[0.06] pt-1.5">
        <IconBtn label={`Move ${slot.label} up`} disabled={index === 0} onClick={() => moveShot(index, index - 1)}>
          <ArrowUp size={11} />
        </IconBtn>
        <IconBtn label={`Move ${slot.label} down`} disabled={index >= count - 1} onClick={() => moveShot(index, index + 1)}>
          <ArrowDown size={11} />
        </IconBtn>
        <IconBtn label={`Edit ${slot.label}`} onClick={() => setEditing(true)}>
          <PencilLine size={11} />
        </IconBtn>
        <span className="ml-auto" />
        {confirmDelete ? (
          <>
            <button onClick={() => removeShot(slot.id)} className="h-6 rounded-full border border-alert/60 px-2 text-[10px] text-alert">
              Delete {slot.id}
            </button>
            <button onClick={() => setConfirmDelete(false)} className="h-6 rounded-full border border-white/10 px-2 text-[10px] text-ink-2">
              Keep
            </button>
          </>
        ) : (
          <IconBtn label={`Delete ${slot.label}`} onClick={() => setConfirmDelete(true)}>
            <Trash2 size={11} />
          </IconBtn>
        )}
      </div>
    </li>
  );
}

function IconBtn({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button onClick={onClick} disabled={disabled} className="grid size-6 place-items-center rounded-full border border-white/10 text-ink-2 hover:text-ink disabled:opacity-30" title={label} aria-label={label}>
      {children}
    </button>
  );
}
