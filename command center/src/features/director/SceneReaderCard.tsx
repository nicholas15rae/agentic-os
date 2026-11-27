import { useEffect } from "react";
import { Loader2, Mic, Star } from "lucide-react";
import { Card } from "@/components/ui";
import type { SrProject, SrTake } from "./contract";
import { importSceneReader, listSceneReader, openSceneReaderProject, picksFor, probeSceneReader, sceneReaderVisible, toggleTake, useAudition } from "./audition-store";

/** Part 4: Scene Reader takes → a new audition project. Hidden while Scene Reader doesn't answer. */

const secs = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : `${s.toFixed(1)} s`);

export interface SceneReaderCardProps {
  visible: boolean;
  projects: SrProject[] | null;
  listing: boolean;
  listError: string | null;
  openId: string | null;
  picks: Record<string, string[]>;
  importing: boolean;
  onList: () => void;
  onOpen: (id: string | null) => void;
  onToggle: (p: SrProject, t: SrTake) => void;
  onImport: (projectId: string) => void;
}

/** Props only. Renders nothing when Scene Reader is down. */
export function SceneReaderCardView(p: SceneReaderCardProps) {
  if (!p.visible) return null;
  const open = p.projects?.find((x) => x.id === p.openId) ?? null;
  const picked = open ? picksFor(open, p.picks) : [];
  return (
    <Card
      title="Scene Reader"
      hint="Copy takes into a new audition project. The best take is picked. Scene Reader's files stay as they are."
      action={
        !p.projects && (
          <button type="button" onClick={p.onList} disabled={p.listing} className="pill-glass !h-8 !px-3 text-xs disabled:opacity-50">
            {p.listing ? <Loader2 size={12} className="animate-spin" /> : "Show takes"}
          </button>
        )
      }
    >
      <div data-testid="scene-reader-card">
        {p.listError && <p className="text-xs text-alert">{p.listError}</p>}
        {p.projects && p.projects.length === 0 && <p className="text-xs text-ink-3">No voiceover projects in Scene Reader yet.</p>}
        {p.projects && p.projects.length > 0 && (
          <div className="space-y-3">
            <label className="block fs-12 text-ink-2">
              Project
              <select className="field mt-1 !h-9 !py-0 fs-13" value={p.openId ?? ""} onChange={(e) => p.onOpen(e.target.value || null)} aria-label="Scene Reader project">
                {p.projects.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.title} ({x.takes.length} take{x.takes.length === 1 ? "" : "s"})
                  </option>
                ))}
              </select>
            </label>
            {open && (
              <>
                {open.takes.length === 0 ? (
                  <p className="text-xs text-ink-3">No takes recorded.</p>
                ) : (
                  <ul className="space-y-1" aria-label="Takes">
                    {open.takes.map((t) => {
                      const on = picked.includes(t.id);
                      return (
                        <li key={t.id}>
                          <label className={`flex items-center gap-2 r-10 border px-2 py-1.5 fs-13 ${t.available ? "border-white/10" : "border-white/5 opacity-50"}`}>
                            <input type="checkbox" checked={on} disabled={!t.available} onChange={() => p.onToggle(open, t)} aria-label={`Take ${t.name}`} />
                            <Mic size={12} className="shrink-0 text-ink-3" />
                            <span className="min-w-0 flex-1 truncate text-ink">{t.name}</span>
                            {t.best && (
                              <span className="flex items-center gap-0.5 fs-11 text-amber-soft">
                                <Star size={10} /> Best
                              </span>
                            )}
                            <span className="fs-11 text-ink-3">{t.available ? secs(t.durSec) : "file missing"}</span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
                <button type="button" onClick={() => p.onImport(open.id)} disabled={p.importing || picked.length === 0} className="pill-primary !h-9 !px-3 text-xs disabled:opacity-50">
                  {p.importing ? <Loader2 size={12} className="animate-spin" /> : `Import ${picked.length} take${picked.length === 1 ? "" : "s"}`}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

/** Store wrapper: probes Scene Reader once on mount. */
export function SceneReaderCard() {
  const s = useAudition();
  useEffect(() => {
    void probeSceneReader();
  }, []);
  return (
    <SceneReaderCardView
      visible={sceneReaderVisible(s)}
      projects={s.projects}
      listing={s.listing}
      listError={s.listError}
      openId={s.openId}
      picks={s.picks}
      importing={s.importing}
      onList={() => void listSceneReader()}
      onOpen={openSceneReaderProject}
      onToggle={toggleTake}
      onImport={(id) => void importSceneReader(id)}
    />
  );
}
