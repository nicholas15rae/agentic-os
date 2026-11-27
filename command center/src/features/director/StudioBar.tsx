import { useState } from "react";
import { Clapperboard, Cpu, Home, Loader2, Plus, Settings2, Square } from "lucide-react";
import { Select } from "@/components/ui";
import { usePoll } from "@/lib/use-poll";
import { useNav } from "@/stores/nav";
import { requestSettingsTab } from "@/sections/settings/settings-tab";
import { api } from "./api";
import type { McpReady } from "./contract";
import { closeProject, createProject, openProject, setReadiness, useDirector, type Readiness, type RenderJob } from "./director-store";
import { BatonPill } from "./BatonPill";
import { COMFY_STATUS_POLL_MS, refreshComfy } from "./comfy-store";

export const READINESS_POLL_MS = 10_000;
/** The project Select's "All projects…" entry (closes the project: the board shows). */
const ALL_PROJECTS = "__all_projects__";

export type PillTone = "green" | "amber" | "red" | "violet" | "unknown";

/** MCP readiness → pill tone + label (pure). */
export function readinessPill(r: Readiness | null, err: string | null): { tone: PillTone; label: string; detail: string | null } {
  if (err) return { tone: "red", label: "Media tools offline", detail: err };
  if (!r) return { tone: "unknown", label: "Checking media tools…", detail: null };
  const servers: [string, McpReady][] = [
    ["shotcut", r.shotcut],
    ["media-forge", r.mediaForge],
  ];
  const broken = servers.find(([, s]) => s.enabled && (s.error || !s.healthy));
  if (broken) return { tone: "red", label: `${broken[0]} error`, detail: broken[1].error ?? "not healthy" };
  const off = servers.filter(([, s]) => !s.enabled || s.tools === 0).map(([n]) => n);
  if (off.length) return { tone: "amber", label: `${off.join(" + ")} off`, detail: "Enable it in Settings → Integrations" };
  if (!r.ffmpegFound) return { tone: "amber", label: "ffmpeg not found", detail: "Install ffmpeg (on PATH) to render" };
  // The count is the two media servers' listings, not the Director's tool set: it lives in the tooltip.
  return {
    tone: "green",
    label: "MCP ready · Shotcut + MediaForge",
    detail: `${r.shotcut.tools + r.mediaForge.tools} tools listed (Shotcut ${r.shotcut.tools}, MediaForge ${r.mediaForge.tools}). These are the media servers' tools, not the Director's full tool set.`,
  };
}

const TONE: Record<PillTone, string> = {
  green: "border-teal/50 text-teal-soft",
  amber: "border-amber/50 text-amber-soft",
  red: "border-alert/60 text-alert",
  violet: "border-violet/50 text-violet",
  unknown: "border-white/10 text-ink-3",
};
const DOT: Record<PillTone, string> = { green: "bg-teal", amber: "bg-amber", red: "bg-alert", violet: "bg-violet", unknown: "bg-ink-3" };

export function StudioBar() {
  const { projects, slug, project, job } = useDirector();
  const readiness = useDirector((s) => s.readiness);
  const readinessError = useDirector((s) => s.readinessError);
  const go = useNav((s) => s.go);
  const [naming, setNaming] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  usePoll(
    async () => {
      try {
        const r = await api.readiness();
        setReadiness(r, null);
        return r;
      } catch (e) {
        setReadiness(null, e instanceof Error ? e.message : String(e));
        throw e;
      }
    },
    READINESS_POLL_MS,
  );
  const pill = readinessPill(readiness, readinessError);
  // ComfyUI status + queue for the baton pill and the Queue card, only while a project is open.
  // refreshComfy never throws (an unavailable bridge lands in statusError).
  usePoll(
    async () => {
      if (slug) await refreshComfy();
      return null;
    },
    COMFY_STATUS_POLL_MS,
    [slug],
  );

  const create = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      await createProject(title.trim());
      setNaming(false);
      setTitle("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <header className="glass flex flex-wrap items-center gap-2 r-20 px-4 py-3">
      <Clapperboard size={17} className="text-amber-soft" />
      <h1 className="mr-1 fs-15 font-semibold text-ink">Director Suite</h1>
      {slug && (
        <button onClick={closeProject} className="pill-glass !h-8 !w-8 !p-0" title="All projects" aria-label="All projects">
          <Home size={13} />
        </button>
      )}
      {projects.length > 0 && (
        <Select
          value={slug ?? ""}
          onChange={(e) => {
            const v = e.target.value;
            if (v === ALL_PROJECTS) closeProject();
            else if (v) void openProject(v);
          }}
          className="!h-8 !w-auto max-w-[240px] !py-0 fs-13"
          aria-label="Project"
        >
          {!slug && <option value="">Open a project…</option>}
          {projects.map((p) => (
            <option key={p.slug} value={p.slug}>
              {p.title}
            </option>
          ))}
          {slug && project && !projects.some((p) => p.slug === slug) && <option value={slug}>{project.title}</option>}
          {slug && <option value={ALL_PROJECTS}>All projects…</option>}
        </Select>
      )}
      {naming ? (
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setNaming(false)} placeholder="Project title" className="field !h-8 !w-48 !py-0 fs-13" aria-label="New project title" />
          <button type="submit" disabled={!title.trim() || busy} className="pill-primary !h-8 !px-3 text-xs disabled:opacity-50">
            {busy ? <Loader2 size={12} className="animate-spin" /> : "Create"}
          </button>
        </form>
      ) : (
        <button onClick={() => setNaming(true)} className="pill-glass !h-8 !px-3 text-xs">
          <Plus size={13} /> New Project
        </button>
      )}

      <div className="ml-auto flex flex-wrap items-center gap-2">
        {slug && <BatonPill />}
        {job && <RenderBadge job={job} />}
        <span className={`flex h-8 items-center gap-1.5 rounded-full border bg-[rgba(11,13,17,0.45)] px-3 fs-12 ${TONE[pill.tone]}`} title={pill.detail ?? pill.label} role="status">
          <span className={`size-2 rounded-full ${DOT[pill.tone]}`} />
          {pill.label}
        </span>
        {(pill.tone === "amber" || pill.tone === "red") && (
          <button
            onClick={() => {
              requestSettingsTab("integrations");
              go("settings");
            }}
            className="pill-glass !h-8 !px-3 text-xs"
          >
            <Settings2 size={13} /> Open Settings
          </button>
        )}
      </div>
    </header>
  );
}

const LIVE = new Set<RenderJob["status"]>(["queued", "running"]);

function RenderBadge({ job }: { job: RenderJob }) {
  const live = LIVE.has(job.status);
  const tone = job.status === "failed" ? "border-alert/60 text-alert" : job.status === "done" ? "border-teal/50 text-teal-soft" : "border-amber/50 text-amber-soft";
  return (
    <span className={`flex h-8 items-center gap-1.5 rounded-full border bg-[rgba(11,13,17,0.45)] px-3 fs-12 ${tone}`} title={job.stage} role="status">
      <Cpu size={12} />
      {live ? (
        <>
          CPU render · {Math.round(job.pct)}%{job.etaSec != null ? ` · ~${Math.ceil(job.etaSec)}s` : ""} · GPU free for LM Studio
          <button onClick={() => void api.renderCancel({ jobId: job.jobId }).catch(() => undefined)} className="ml-1 grid size-5 place-items-center rounded-full hover:bg-white/10" title="Cancel render" aria-label="Cancel render">
            <Square size={10} />
          </button>
        </>
      ) : (
        <>Render {job.status}</>
      )}
    </span>
  );
}
