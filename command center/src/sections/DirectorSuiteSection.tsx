import { useEffect } from "react";
import { Loader2 } from "lucide-react";
import { isTauri } from "@/lib/platform";
import { createProject, lastSlug, loadProjects, openProject, refreshAssets, startDirectorEvents, useDirector } from "@/features/director/director-store";
import { onPullDone, startCloud } from "@/features/cloud/cloud-store";
import { DesktopOnlyView, EmptyStateView } from "@/features/director/EmptyState";
import { ProjectsBoard } from "@/features/director/ProjectsBoard";
import { startFromPreset } from "@/features/director/launcher";
import { StudioBar } from "@/features/director/StudioBar";
import { StagingBin } from "@/features/director/StagingBin";
import { ShotList } from "@/features/director/ShotList";
import { PreviewPlayer } from "@/features/director/PreviewPlayer";
import { Compare, compareRenders } from "@/features/director/Compare";
import { MiniTimeline } from "@/features/director/MiniTimeline";
import { DirectorChat } from "@/features/director/DirectorChat";
import { RenderPlanCard } from "@/features/director/RenderPlanCard";
import { VerifiedShelf } from "@/features/director/VerifiedShelf";
import { BriefCard } from "@/features/director/BriefCard";
import { ReviewPanel } from "@/features/director/ReviewPanel";
import { OutputsCard } from "@/features/director/OutputsCard";
import { GeneratePanel } from "@/features/director/GeneratePanel";
import { RenderQueue } from "@/features/director/RenderQueue";
import { startComfyEvents } from "@/features/director/comfy-store";
import { SceneReaderCard } from "@/features/director/SceneReaderCard";
import { AuditionCard } from "@/features/director/AuditionCard";
import "@/features/director/director.css";

/**
 * Director Suite: stage media, shape a timeline with the Director, approve a CPU render and get a
 * verified output. Four zones on desktop (Studio Bar · brief + bin + shot list · preview + review +
 * timeline + outputs · render plan + chat + verified shelf), stacked below `lg`. Desktop-only.
 * `director-suite` scopes the readability tweaks in director.css to this page.
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
  const comparing = useDirector((s) => compareRenders(s) !== null);

  useEffect(() => {
    void loadProjects();
    const last = lastSlug();
    if (last && !useDirector.getState().slug) void openProject(last);
    // render + ingest + intake (intake refreshes the bin and drives the one debounced auto-match turn).
    const stopEvents = startDirectorEvents();
    // ComfyUI queue / service / asset events + the GPU baton (fails quietly when the bridge is down).
    const stopComfy = startComfyEvents().catch(() => () => undefined);
    // Google Drive: status/transfers for the shelf and bin; a finished pull into the open project refreshes the bin.
    const releaseCloud = startCloud();
    const offPull = onPullDone((t) => {
      if (t.project === useDirector.getState().slug) void refreshAssets(t.project);
    });
    return () => {
      void stopEvents.then((off) => off());
      void stopComfy.then((off) => off());
      offPull();
      releaseCloud();
    };
  }, []);

  return (
    <div className="director-suite mx-auto h-full w-full max-w-[1600px] space-y-4 overflow-y-auto px-4 pb-32 md:px-6 md:pb-8">
      <StudioBar />
      {!slug ? (
        <EmptyStateView
          onQuickStart={(q, title) => createProject(title, q)}
          onPreset={(id, title) => startFromPreset(id, title)}
          board={
            <>
              <SceneReaderCard />
              <ProjectsBoard />
            </>
          }
        />
      ) : loading && !manifest ? (
        <div className="grid h-64 place-items-center text-ink-3">
          <Loader2 className="animate-spin" />
        </div>
      ) : !manifest ? (
        <p className="glass r-20 p-5 text-sm text-alert">Couldn't open this project{error ? `: ${error}` : "."}</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(240px,300px)_minmax(0,1fr)_minmax(280px,360px)]">
          <div className="min-w-0 space-y-4">
            <BriefCard />
            <AuditionCard />
            <StagingBin />
            <ShotList />
          </div>
          <div className="min-w-0 space-y-4">
            {comparing ? <Compare /> : <PreviewPlayer />}
            <ReviewPanel />
            <MiniTimeline />
            <OutputsCard />
            <GeneratePanel />
            <RenderQueue />
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
