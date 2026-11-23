import { useEffect, useState } from "react";
import { CloudDownload, Loader2, Plus } from "lucide-react";
import { Select } from "@/components/ui";
import { api as mediaApi } from "@/features/director/api";
import type { AssetRole, MediaProject } from "@/features/director/contract";
import { INGEST_ROLES } from "@/features/director/manifest";
import { useToasts } from "@/features/reminders/notify";
import { MAX_PULL_FILES } from "./api";
import { errText, pullSelected, useCloud } from "./cloud-store";

const NEW = "__new__";

/**
 * Import the selected Drive files into a Director project. The target is either fixed (the bin's
 * modal) or picked here from `media_projects`, with "New project…" creating one inline.
 */
export function PullBar({
  project,
  onProject,
  lockProject = false,
  role,
  onRole,
  compact = false,
  onPulled,
}: {
  project: string | null;
  onProject?: (slug: string | null) => void;
  lockProject?: boolean;
  role: AssetRole;
  onRole: (r: AssetRole) => void;
  compact?: boolean;
  onPulled?: () => void;
}) {
  const selected = useCloud((s) => s.selected);
  const pulling = useCloud((s) => s.pulling);
  const [projects, setProjects] = useState<MediaProject[]>([]);
  const [naming, setNaming] = useState(false);
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (lockProject) return;
    let live = true;
    mediaApi
      .projects()
      .then((p) => live && setProjects([...p].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [lockProject]);

  const create = async () => {
    if (!title.trim()) return;
    setCreating(true);
    try {
      const p = await mediaApi.projectCreate({ title: title.trim() });
      setProjects((ps) => [p, ...ps.filter((x) => x.slug !== p.slug)]);
      onProject?.(p.slug);
      setNaming(false);
      setTitle("");
    } catch (e) {
      useToasts.getState().push({ title: "Couldn't create the project", body: errText(e), tone: "error" });
    } finally {
      setCreating(false);
    }
  };

  const tooMany = selected.length > MAX_PULL_FILES;
  const known = !project || projects.some((p) => p.slug === project);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {!lockProject &&
        (naming ? (
          <form
            className="flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setNaming(false)} placeholder="Project title" aria-label="New project title" className="field !h-8 !w-40 !py-0 text-[12px]" />
            <button type="submit" disabled={!title.trim() || creating} className="pill-glass !h-8 !px-2.5 text-[11px] disabled:opacity-50">
              {creating ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />} Create
            </button>
          </form>
        ) : (
          <Select
            value={project ?? ""}
            onChange={(e) => {
              if (e.target.value === NEW) setNaming(true);
              else onProject?.(e.target.value || null);
            }}
            className="!h-8 !w-auto max-w-[200px] !py-0 text-[12px]"
            aria-label="Import into project"
          >
            <option value="">Choose a project…</option>
            {projects.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.title}
              </option>
            ))}
            {!known && project && <option value={project}>{project}</option>}
            <option value={NEW}>New project…</option>
          </Select>
        ))}
      <Select value={role} onChange={(e) => onRole(e.target.value as AssetRole)} className="!h-8 !w-auto !py-0 text-[12px]" aria-label="Role for imported files">
        {INGEST_ROLES.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </Select>
      <button
        onClick={() => {
          if (!project) return;
          void pullSelected(project, role).then((ok) => ok && onPulled?.());
        }}
        disabled={!project || !selected.length || tooMany || pulling}
        className="pill-primary !h-8 !px-3 text-xs disabled:opacity-50"
        title={!project ? "Choose a project first" : tooMany ? `Up to ${MAX_PULL_FILES} files at a time` : "Copy into the project's raw/ folder (read-only)"}
      >
        {pulling ? <Loader2 size={12} className="animate-spin" /> : <CloudDownload size={12} />}
        {compact ? "Import" : "Import to project"}
        {selected.length > 0 && <span className="font-mono text-[10px]">({selected.length})</span>}
      </button>
      {tooMany && <span className="text-[11px] text-amber-soft">Up to {MAX_PULL_FILES} at a time.</span>}
    </div>
  );
}
