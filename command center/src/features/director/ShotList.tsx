import { useState } from "react";
import { Check, Loader2, Sparkles, Wand2, X } from "lucide-react";
import { Card, Empty } from "@/components/ui";
import type { AssetRole, ShotSlot } from "./contract";
import { editManifest, flushSave, useDirector } from "./director-store";
import { sendDirectorTurn } from "./director-chat";
import { draggedAsset, hasFiles, hasType, ASSET_MIME, ingestDropped } from "./dnd";
import { allSlotsAttached, attachSlot, clipsFromShotList } from "./manifest";
import { Thumb } from "./StagingBin";

export const ASSEMBLE_PROMPT = "All shot-list slots are attached and I've laid them on the timeline in slot order. Propose an edit plan (trims, order, audio, output) as a propose_edit_plan action.";
export const SHOT_LIST_PROMPT = "Draft a shot list for this project as a populate_shot_list action.";

const roleForSlot = (s: ShotSlot): AssetRole => (s.kind === "audio" ? "music" : s.kind === "image" ? (/slate|title|outro|end/i.test(s.label) ? "slate" : "photo") : "clip");

export function ShotList() {
  const slug = useDirector((s) => s.slug);
  const manifest = useDirector((s) => s.manifest);
  const assets = useDirector((s) => s.assets);
  const chatBusy = useDirector((s) => s.chatBusy);
  const [busy, setBusy] = useState(false);
  if (!manifest) return null;
  const ready = allSlotsAttached(manifest);

  const assemble = async () => {
    setBusy(true);
    try {
      editManifest((m) => clipsFromShotList(m, useDirector.getState().assets));
      if (await flushSave()) await sendDirectorTurn(ASSEMBLE_PROMPT);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Shot List"
      action={
        manifest.shotList.length > 0 && (
          <button onClick={() => void assemble()} disabled={!ready || busy || chatBusy} className="pill-primary !h-8 !px-3 text-xs disabled:opacity-50" title={ready ? "Lay the slots on the timeline and ask the Director for an edit plan" : "Attach media to every slot first"}>
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />} Assemble with Director
          </button>
        )
      }
    >
      {manifest.shotList.length ? (
        <ul className="space-y-2">
          {manifest.shotList.map((s) => (
            <SlotCard key={s.id} slot={s} slug={slug} asset={assets.find((a) => a.id === s.assetId) ?? null} />
          ))}
        </ul>
      ) : (
        <div className="text-center">
          <Empty>No shot list yet.</Empty>
          <button onClick={() => void sendDirectorTurn(SHOT_LIST_PROMPT)} disabled={chatBusy} className="pill-glass !h-8 !px-3 text-xs disabled:opacity-50">
            <Sparkles size={12} /> Ask the Director for one
          </button>
        </div>
      )}
    </Card>
  );
}

function SlotCard({ slot, slug, asset }: { slot: ShotSlot; slug: string | null; asset: ReturnType<typeof useDirector.getState>["assets"][number] | null }) {
  const [over, setOver] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const tone = slot.status === "approved" ? "text-teal" : slot.status === "attached" ? "text-amber-soft" : "text-ink-3";
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
          {slot.targetSec != null ? ` · ${slot.targetSec}s` : ""}
        </span>
        <span className={`label-caps ${tone}`}>{slot.status}</span>
      </div>
      {slot.instructions && <p className="mt-1 text-[12px] leading-snug text-ink-2">{slot.instructions}</p>}
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
        <p className="mt-2 text-[11px] text-ink-3">Drop a {slot.kind} from the bin or your files here.</p>
      )}
      {refused && <p className="mt-1 text-[11px] text-alert">{refused}</p>}
    </li>
  );
}
