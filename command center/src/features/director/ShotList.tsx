import { useState } from "react";
import { List, Loader2, Plus, Smartphone, Sparkles, Wand2 } from "lucide-react";
import { Card, Empty } from "@/components/ui";
import { addShot, editManifest, flushSave, toggleShotFilmed, useDirector } from "./director-store";
import { sendDirectorTurn } from "./director-chat";
import { SHOT_SLOTS_MAX, allSlotsAttached, clipsFromShotList } from "./manifest";
import { ShotChecklistView } from "./ShotChecklist";
import { copyText, shotListText } from "./shot-print";
import { ShotSlotCard } from "./ShotSlotCard";
import { ShotSlotEditor } from "./ShotSlotEditor";

export const ASSEMBLE_PROMPT = "All shot-list slots are attached and I've laid them on the timeline in slot order. Propose an edit plan (trims, order, audio, output) as a propose_edit_plan action.";
export const SHOT_LIST_PROMPT = "Draft a shot list for this project as a populate_shot_list action.";

const PHONE_KEY = "cc.director.phoneView";
const readPhone = () => {
  try {
    return localStorage.getItem(PHONE_KEY) === "1";
  } catch {
    return false;
  }
};

export function ShotList() {
  const slug = useDirector((s) => s.slug);
  const manifest = useDirector((s) => s.manifest);
  const assets = useDirector((s) => s.assets);
  const chatBusy = useDirector((s) => s.chatBusy);
  const title = useDirector((s) => s.project?.title ?? "");
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [phone, setPhoneState] = useState(readPhone);
  if (!manifest) return null;
  const ready = allSlotsAttached(manifest);
  const slots = manifest.shotList;
  const full = slots.length >= SHOT_SLOTS_MAX;

  const setPhone = (on: boolean) => {
    setPhoneState(on);
    try {
      localStorage.setItem(PHONE_KEY, on ? "1" : "0");
    } catch {
      /* private mode */
    }
  };

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
        <>
          {slots.length > 0 && (
            <button onClick={() => setPhone(!phone)} aria-pressed={phone} className="pill-glass !h-8 !w-8 !p-0" title={phone ? "Full shot list" : "Phone view: the filming checklist, big type, copy or print"} aria-label={phone ? "Full shot list" : "Phone view"}>
              {phone ? <List size={13} /> : <Smartphone size={13} />}
            </button>
          )}
          {!phone && (
            <button onClick={() => setAdding(true)} disabled={adding || full} className="pill-glass !h-8 !w-8 !p-0 disabled:opacity-50" title={full ? `Up to ${SHOT_SLOTS_MAX} shots` : "Add a shot"} aria-label="Add a shot">
              <Plus size={13} />
            </button>
          )}
          {slots.length > 0 && !phone && (
            <button onClick={() => void assemble()} disabled={!ready || busy || chatBusy} className="pill-primary !h-8 !px-3 text-xs disabled:opacity-50" title={ready ? "Lay the slots on the timeline and ask the Director for an edit plan" : "Attach media to every slot first"}>
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />} Assemble with Director
            </button>
          )}
        </>
      }
    >
      {phone && slots.length ? (
        <ShotChecklistView slots={slots} onToggle={toggleShotFilmed} onCopy={() => copyText(shotListText(title, slots))} onPrint={() => window.print()} />
      ) : (
        <>
          {slots.length > 0 && (
            <ul className="space-y-2">
              {slots.map((s, i) => (
                <ShotSlotCard key={s.id} slot={s} index={i} count={slots.length} slug={slug} asset={assets.find((a) => a.id === s.assetId) ?? null} />
              ))}
            </ul>
          )}
          {adding && (
            <div className={slots.length ? "mt-2" : ""}>
              <ShotSlotEditor
                slot={null}
                onCancel={() => setAdding(false)}
                onSave={(p) => {
                  addShot(p);
                  setAdding(false);
                }}
              />
            </div>
          )}
          {!slots.length && !adding && (
            <div className="text-center">
              <Empty>No shot list yet.</Empty>
              <div className="flex flex-wrap justify-center gap-1.5">
                <button onClick={() => void sendDirectorTurn(SHOT_LIST_PROMPT)} disabled={chatBusy} className="pill-glass !h-8 !px-3 text-xs disabled:opacity-50">
                  <Sparkles size={12} /> Ask the Director for one
                </button>
                <button onClick={() => setAdding(true)} className="pill-glass !h-8 !px-3 text-xs">
                  <Plus size={12} /> Add a shot
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
