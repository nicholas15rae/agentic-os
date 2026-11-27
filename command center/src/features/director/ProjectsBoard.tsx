import { useEffect, useRef, useState } from "react";
import { ChevronDown, Columns3, List } from "lucide-react";
import { Card, Chip, Empty } from "@/components/ui";
import type { MediaProject, ProjectStatus } from "./contract";
import { openProject, setProjectStatus, useDirector } from "./director-store";

/** Part 3 B.2: every project by status, as a board (one column per status) or a list. */

export type ProjectsLayout = "board" | "list";
export interface ProjectsFilter {
  text: string;
  /** [] = all. */
  statuses: ProjectStatus[];
}
export const NO_PROJECTS_FILTER: ProjectsFilter = { text: "", statuses: [] };

export const STATUSES: ProjectStatus[] = ["brief", "shooting", "editing", "review", "done"];
export const STATUS_LABEL: Record<ProjectStatus, string> = { brief: "Brief", shooting: "Shooting", editing: "Editing", review: "Review", done: "Done" };
const STATUS_TONE: Record<ProjectStatus, string> = {
  brief: "border-violet/40 text-violet",
  shooting: "border-amber/40 text-amber-soft",
  editing: "border-teal/40 text-teal-soft",
  review: "border-amber/60 text-amber-soft",
  done: "border-white/20 text-ink-2",
};

/** Pure: title/slug contains text (case-insensitive), status in statuses; newest updatedAt first. */
export function filterProjects(projects: MediaProject[], f: ProjectsFilter): MediaProject[] {
  const q = f.text.trim().toLowerCase();
  return projects
    .filter((p) => (!q || p.title.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q)) && (!f.statuses.length || f.statuses.includes(p.status)))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** "just now" / "5m ago" / "3h ago" / "4d ago", then the date ("Nov 3"). Pure. */
export function updatedAgo(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  if (s < 14 * 86_400) return `${Math.round(s / 86_400)}d ago`;
  return new Date(t).toLocaleDateString("en-CA", { month: "short", day: "numeric" });
}

const LAYOUT_KEY = "cc.director.projectsLayout";
export function readLayout(): ProjectsLayout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === "list" ? "list" : "board";
  } catch {
    return "board";
  }
}
function writeLayout(l: ProjectsLayout) {
  try {
    localStorage.setItem(LAYOUT_KEY, l);
  } catch {
    /* per-viewer convenience only */
  }
}

/** A project's status as a chip; clicking opens a small menu of the five statuses (Escape or a click
 * outside closes it). Inline, so no scroller clips it. Props only. */
export function StatusChipView({ status, busy, onChange, label }: { status: ProjectStatus; busy: boolean; onChange: (s: ProjectStatus) => void; label?: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  return (
    <div ref={box} className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${label ? `${label} status` : "Status"}: ${STATUS_LABEL[status]}`}
        className={`flex h-6 items-center gap-1 rounded-full border px-2 fs-11 disabled:opacity-60 ${STATUS_TONE[status]}`}
      >
        {busy ? "Saving…" : STATUS_LABEL[status]}
        <ChevronDown size={10} />
      </button>
      {open && (
        <ul role="menu" aria-label={label ? `Status for ${label}` : "Status"} className="r-10 border border-white/10 bg-[rgba(11,13,17,0.92)] p-1">
          {STATUSES.map((s) => (
            <li key={s} role="none">
              <button
                type="button"
                role="menuitemradio"
                aria-checked={s === status}
                onClick={() => {
                  setOpen(false);
                  if (s !== status) onChange(s);
                }}
                className={`block w-full r-8 px-2 py-1 text-left fs-12 hover:bg-white/5 ${s === status ? "text-ink" : "text-ink-2"}`}
              >
                {STATUS_LABEL[s]}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export interface ProjectsBoardProps {
  projects: MediaProject[];
  loaded: boolean;
  /** Remembered per viewer in localStorage, default "board". */
  layout: ProjectsLayout;
  filter: ProjectsFilter;
  busySlug: string | null;
  onLayout: (l: ProjectsLayout) => void;
  onFilter: (f: ProjectsFilter) => void;
  onOpen: (slug: string) => void;
  onStatus: (slug: string, status: ProjectStatus) => void;
  /** For the relative times (tests pin it). */
  now?: number;
}

/** No project open: every project by status (board) or as rows (list), each with a status chip.
 * No drag and drop: status changes only through the chip menu. Props only. */
export function ProjectsBoardView(p: ProjectsBoardProps) {
  const shown = filterProjects(p.projects, p.filter);
  const now = p.now ?? Date.now();
  const toggleStatus = (s: ProjectStatus) => p.onFilter({ ...p.filter, statuses: p.filter.statuses.includes(s) ? p.filter.statuses.filter((x) => x !== s) : [...p.filter.statuses, s] });
  const columns = p.filter.statuses.length ? STATUSES.filter((s) => p.filter.statuses.includes(s)) : STATUSES;
  const chip = (x: MediaProject) => <StatusChipView status={x.status} busy={p.busySlug === x.slug} onChange={(s) => p.onStatus(x.slug, s)} label={x.title} />;
  const title = (x: MediaProject) => (
    <button type="button" onClick={() => p.onOpen(x.slug)} className="block min-w-0 truncate text-left fs-13 font-medium text-ink hover:text-amber-soft" title={`Open ${x.title}`}>
      {x.title}
    </button>
  );

  return (
    <Card
      title="Projects"
      action={
        <>
          <input value={p.filter.text} onChange={(e) => p.onFilter({ ...p.filter, text: e.target.value })} placeholder="Search" className="field !h-8 !w-40 !py-0 fs-12" aria-label="Search projects" />
          <div className="flex gap-1" role="group" aria-label="Layout">
            <button type="button" onClick={() => p.onLayout("board")} aria-pressed={p.layout === "board"} className={`pill-glass !h-8 !w-8 !p-0 ${p.layout === "board" ? "!border-amber/50 text-ink" : ""}`} aria-label="Board" title="Board">
              <Columns3 size={13} />
            </button>
            <button type="button" onClick={() => p.onLayout("list")} aria-pressed={p.layout === "list"} className={`pill-glass !h-8 !w-8 !p-0 ${p.layout === "list" ? "!border-amber/50 text-ink" : ""}`} aria-label="List" title="List">
              <List size={13} />
            </button>
          </div>
        </>
      }
    >
      {p.projects.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="Filter by status">
          {STATUSES.map((s) => (
            <Chip key={s} active={p.filter.statuses.includes(s)} onClick={() => toggleStatus(s)}>
              {STATUS_LABEL[s]}
            </Chip>
          ))}
        </div>
      )}
      {!p.loaded ? (
        <Empty>Loading…</Empty>
      ) : !p.projects.length ? (
        <Empty>No projects yet.</Empty>
      ) : !shown.length ? (
        <Empty>No projects match.</Empty>
      ) : p.layout === "board" ? (
        <div className="flex gap-3 overflow-x-auto pb-1 md:grid md:overflow-visible" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}>
          {columns.map((s) => {
            const col = shown.filter((x) => x.status === s);
            return (
              <section key={s} aria-label={`${STATUS_LABEL[s]} column`} className="min-w-[200px] r-14 border border-white/[0.08] bg-white/[0.02] p-2 md:min-w-0">
                <h3 className="mb-2 flex items-center gap-1.5 px-1">
                  <span className="label-caps text-ink-2">{STATUS_LABEL[s]}</span>
                  <span className="font-mono fs-11 text-ink-3">{col.length}</span>
                </h3>
                {col.length ? (
                  <ul className="space-y-1.5">
                    {col.map((x) => (
                      <li key={x.slug} aria-label={x.title} className="r-12 border border-white/10 bg-white/[0.03] p-2">
                        {title(x)}
                        <div className="mt-1 flex flex-wrap items-start justify-between gap-1">
                          {chip(x)}
                          <span className="font-mono fs-10 text-ink-3">{updatedAgo(x.updatedAt, now)}</span>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="px-1 fs-11 text-ink-3">None</p>
                )}
              </section>
            );
          })}
        </div>
      ) : (
        <ul className="space-y-1">
          {shown.map((x) => (
            <li key={x.slug} aria-label={x.title} className="flex flex-wrap items-start gap-2 r-12 px-3 py-2 hover:bg-white/5">
              <div className="min-w-0 flex-1">{title(x)}</div>
              <span className="pt-1 font-mono fs-10 text-ink-3">{updatedAgo(x.updatedAt, now)}</span>
              {chip(x)}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Store-connected board: layout remembered per viewer, filter local, status via setProjectStatus. */
export function ProjectsBoard() {
  const projects = useDirector((s) => s.projects);
  const loaded = useDirector((s) => s.projectsLoaded);
  const [layout, setLayout] = useState<ProjectsLayout>(readLayout);
  const [filter, setFilter] = useState<ProjectsFilter>(NO_PROJECTS_FILTER);
  const [busySlug, setBusySlug] = useState<string | null>(null);
  return (
    <ProjectsBoardView
      projects={projects}
      loaded={loaded}
      layout={layout}
      filter={filter}
      busySlug={busySlug}
      onLayout={(l) => {
        setLayout(l);
        writeLayout(l);
      }}
      onFilter={setFilter}
      onOpen={(slug) => void openProject(slug)}
      onStatus={(slug, status) => {
        setBusySlug(slug);
        void setProjectStatus(slug, status).finally(() => setBusySlug(null));
      }}
    />
  );
}
