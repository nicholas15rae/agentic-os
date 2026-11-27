import { useState } from "react";
import { Clapperboard, Film, Images, ListChecks, Loader2, Scissors } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Card, Empty } from "@/components/ui";
import type { MediaProject } from "./contract";
import { QUICK_STARTS, type QuickStart } from "./manifest";

export const GREETING = "Hey Nic, what do you want to create today?";

const ICON: Record<QuickStart, LucideIcon> = { edit: Film, series: ListChecks, photo: Images, stitch: Scissors };

/** No project open: greeting, the four quick starts (inline title prompt) and recent projects. Props only. */
export function EmptyStateView({ projects, loaded, onQuickStart, onOpen }: { projects: MediaProject[]; loaded: boolean; onQuickStart: (q: QuickStart, title: string) => Promise<unknown>; onOpen: (slug: string) => void }) {
  const [pick, setPick] = useState<QuickStart | null>(null);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!pick || !title.trim()) return;
    setBusy(true);
    try {
      await onQuickStart(pick, title.trim());
      setPick(null);
      setTitle("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
      <section className="glass r-20 p-6">
        <Clapperboard size={22} className="text-amber-soft" />
        <h2 className="mt-3 text-2xl font-semibold text-ink">{GREETING}</h2>
        <p className="mt-1 text-sm text-ink-3">Pick a starting point. The Director plans, you approve, and renders run on the CPU.</p>
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          {QUICK_STARTS.map((q) => {
            const Icon = ICON[q.id];
            const on = pick === q.id;
            return (
              <div key={q.id} className={`r-16 border p-4 transition-colors ${on ? "border-amber/50 bg-amber/10" : "border-white/[0.08] bg-white/[0.02] hover:border-white/20"}`}>
                <button type="button" onClick={() => setPick(on ? null : q.id)} className="flex w-full items-start gap-3 text-left" aria-expanded={on}>
                  <Icon size={18} className="mt-0.5 shrink-0 text-amber-soft" />
                  <span>
                    <span className="block fs-14 font-medium text-ink">{q.label}</span>
                    <span className="mt-0.5 block text-xs text-ink-3">{q.hint}</span>
                  </span>
                </button>
                {on && (
                  <form
                    className="mt-3 flex gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void submit();
                    }}
                  >
                    <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Give it a title" className="field !h-9 !py-0 fs-13" aria-label={`${q.label} title`} />
                    <button type="submit" disabled={!title.trim() || busy} className="pill-primary !h-9 shrink-0 !px-3 text-xs disabled:opacity-50">
                      {busy ? <Loader2 size={12} className="animate-spin" /> : "Start"}
                    </button>
                  </form>
                )}
              </div>
            );
          })}
        </div>
      </section>
      <Card title="Recent projects">
        {!loaded ? (
          <Empty>Loading…</Empty>
        ) : projects.length ? (
          <ul className="space-y-1">
            {projects.slice(0, 12).map((p) => (
              <li key={p.slug}>
                <button type="button" onClick={() => onOpen(p.slug)} className="flex w-full items-center gap-2 r-12 px-3 py-2 text-left hover:bg-white/5">
                  <span className="min-w-0 flex-1 truncate text-sm text-ink">{p.title}</span>
                  <span className="label-caps shrink-0 text-ink-3">{p.status.replace("_", " ")}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No projects yet.</Empty>
        )}
      </Card>
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
