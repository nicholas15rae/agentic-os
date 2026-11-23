import { useEffect } from "react";
import { Loader2 } from "lucide-react";
import { isTauri } from "@/lib/platform";
import { onDirectorEvent } from "@/features/director/api";
import { createProject, lastSlug, loadProjects, onIngestEvent, onRenderEvent, openProject, useDirector } from "@/features/director/director-store";
import { DesktopOnlyView, EmptyStateView } from "@/features/director/EmptyState";
import { StudioBar } from "@/features/director/StudioBar";
import { StagingBin } from "@/features/director/StagingBin";
import { ShotList } from "@/features/director/ShotList";
import { PreviewPlayer } from "@/features/director/PreviewPlayer";
import { MiniTimeline } from "@/features/director/MiniTimeline";
import { DirectorChat } from "@/features/director/DirectorChat";
import { RenderPlanCard } from "@/features/director/RenderPlanCard";
import { VerifiedShelf } from "@/features/director/VerifiedShelf";

/**
 * Director Suite: stage media, shape a timeline with the Director, approve a CPU render and get a
 * verified output. Four zones on desktop (Studio Bar · bin + shot list · preview + timeline ·
 * chat + render plan + verified shelf), stacked below `lg`. Desktop-only.
 */
export function DirectorSuiteSection() {
  if (!isTauri()) return <DesktopOnlyView />;
  return <DirectorStudio />;
}

function DirectorStudio() {
  const slug = useDirector((s) => s.slug);
  const loading = useDirector((s) => s.loading);
  const error = useDirector((s) => s.error);
  const manifest = useDirector((s) => s.manifest);
  const projects = useDirector((s) => s.projects);
  const loaded = useDirector((s) => s.projectsLoaded);

  useEffect(() => {
    void loadProjects();
    const last = lastSlug();
    if (last && !useDirector.getState().slug) void openProject(last);
    const offs = [onDirectorEvent("media-render", onRenderEvent), onDirectorEvent("media-ingest", onIngestEvent)];
    return () => offs.forEach((p) => void p.then((off) => off()));
  }, []);

  return (
    <div className="mx-auto h-full w-full max-w-[1600px] space-y-4 overflow-y-auto px-4 pb-32 md:px-6 md:pb-8">
      <StudioBar />
      {!slug ? (
        <EmptyStateView projects={projects} loaded={loaded} onQuickStart={(q, title) => createProject(title, q)} onOpen={(s) => void openProject(s)} />
      ) : loading && !manifest ? (
        <div className="grid h-64 place-items-center text-ink-3">
          <Loader2 className="animate-spin" />
        </div>
      ) : !manifest ? (
        <p className="glass rounded-[20px] p-5 text-sm text-alert">Couldn't open this project{error ? `: ${error}` : "."}</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(240px,300px)_minmax(0,1fr)_minmax(280px,360px)]">
          <div className="min-w-0 space-y-4">
            <StagingBin />
            <ShotList />
          </div>
          <div className="min-w-0 space-y-4">
            <PreviewPlayer />
            <MiniTimeline />
          </div>
          <div className="min-w-0 space-y-4">
            <RenderPlanCard />
            <DirectorChat />
            <VerifiedShelf />
          </div>
        </div>
      )}
    </div>
  );
}
