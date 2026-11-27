import { useState, type ReactNode } from "react";
import { Clapperboard, Film, Images, ListChecks, Loader2, Scissors } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Card, Empty } from "@/components/ui";
import { QUICK_STARTS, type QuickStart } from "./manifest";
import { LAUNCHER_PRESETS, type LauncherPresetId } from "./presets";

export const GREETING = "Hey Nic, what do you want to create today?";

const ICON: Record<QuickStart, LucideIcon> = { edit: Film, series: ListChecks, photo: Images, stitch: Scissors };

type Pick = { kind: "quick"; id: QuickStart } | { kind: "preset"; id: LauncherPresetId };
const same = (a: Pick | null, b: Pick) => !!a && a.kind === b.kind && a.id === b.id;

/** One start card: click to open the inline title prompt, Start submits. `note` sits under the form. */
function StartCard({ label, hint, icon: Icon, open, busy, title, note, onToggle, onTitle, onSubmit }: { label: string; hint: string; icon?: LucideIcon; open: boolean; busy: boolean; title: string; note?: string; onToggle: () => void; onTitle: (t: string) => void; onSubmit: () => void }) {
  return (
    <div className={`rounded-[16px] border p-4 transition-colors ${open ? "border-amber/50 bg-amber/10" : "border-white/[0.08] bg-white/[0.02] hover:border-white/20"}`}>
      <button type="button" onClick={onToggle} className="flex w-full items-start gap-3 text-left" aria-expanded={open}>
        {Icon && <Icon size={18} className="mt-0.5 shrink-0 text-amber-soft" />}
        <span>
          <span className="block text-[14px] font-medium text-ink">{label}</span>
          <span className="mt-0.5 block text-xs text-ink-3">{hint}</span>
        </span>
      </button>
      {open && (
        <>
          <form
            className="mt-3 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              onSubmit();
            }}
          >
            <input autoFocus value={title} onChange={(e) => onTitle(e.target.value)} placeholder="Give it a title" className="field !h-9 !py-0 text-[13px]" aria-label={`${label} title`} />
            <button type="submit" disabled={!title.trim() || busy} className="pill-primary !h-9 shrink-0 !px-3 text-xs disabled:opacity-50">
              {busy ? <Loader2 size={12} className="animate-spin" /> : "Start"}
            </button>
          </form>
          {note && <p className="mt-2 text-[11px] leading-snug text-ink-3">{note}</p>}
        </>
      )}
    </div>
  );
}

/** No project open: greeting, the four quick starts and the six launcher presets (inline title
 * prompt each), then the projects board (passed in as `board`). A preset's Start also sends its
 * first Director line, shown under the form before the click. Props only. */
export function EmptyStateView({ onQuickStart, onPreset, board }: { onQuickStart: (q: QuickStart, title: string) => Promise<unknown>; onPreset?: (id: LauncherPresetId, title: string) => Promise<unknown>; board: ReactNode }) {
  const [pick, setPick] = useState<Pick | null>(null);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!pick || !title.trim()) return;
    setBusy(true);
    try {
      if (pick.kind === "quick") await onQuickStart(pick.id, title.trim());
      else await onPreset?.(pick.id, title.trim());
      setPick(null);
      setTitle("");
    } finally {
      setBusy(false);
    }
  };
  const card = (p: Pick, label: string, hint: string, icon?: LucideIcon, note?: string) => (
    <StartCard key={`${p.kind}-${p.id}`} label={label} hint={hint} icon={icon} note={note} open={same(pick, p)} busy={busy} title={title} onTitle={setTitle} onToggle={() => setPick(same(pick, p) ? null : p)} onSubmit={() => void submit()} />
  );
  return (
    <div className="space-y-4">
      <section className="glass rounded-[20px] p-6">
        <Clapperboard size={22} className="text-amber-soft" />
        <h2 className="mt-3 text-2xl font-semibold text-ink">{GREETING}</h2>
        <p className="mt-1 text-sm text-ink-3">Pick a starting point. The Director plans, you approve, and renders run on the CPU.</p>
        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{QUICK_STARTS.map((q) => card({ kind: "quick", id: q.id }, q.label, q.hint, ICON[q.id]))}</div>
        {onPreset && (
          <div className="mt-5" role="group" aria-label="Presets">
            <p className="label-caps text-ink-3">Presets</p>
            <div className="mt-2 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{LAUNCHER_PRESETS.map((p) => card({ kind: "preset", id: p.id }, p.label, p.hint, undefined, `Start sends the Director: "${p.firstLine}"`))}</div>
          </div>
        )}
      </section>
      {board}
    </div>
  );
}

/** Phone / browser PWA: the studio needs local files, ffmpeg and the desktop's IPC. */
export function DesktopOnlyView() {
  return (
    <div className="mx-auto h-full w-full max-w-7xl overflow-y-auto px-4 pb-32 md:px-6 md:pb-8">
      <Card title="Director Suite">
        <Empty>Director Suite runs on the desktop app.</Empty>
      </Card>
    </div>
  );
}
