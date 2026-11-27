import { lazy, Suspense, useEffect, useState } from "react";
import { PencilLine, PinOff, RotateCw, TriangleAlert } from "lucide-react";
import { useCollection } from "@/lib/cc-api";
import { isTauri, type PlayCard } from "@/lib/platform";
import { useNav } from "@/stores/nav";
import { useSettings } from "@/stores/settings";
import { editInPlayPlace } from "./MyAppsRail";
import { SandboxBoundary } from "@/features/buildhub/SandboxView";
import { startHub, useHub } from "@/features/buildhub/hub-store";
import { iconOf, useMyApps, type MountedApp } from "./store";

const SandboxFrame = lazy(() => import("@/features/buildhub/SandboxFrame"));

/**
 * A MY APPS page: the mounted app full-viewport, like a native section. It runs in an
 * opaque-origin sandboxed iframe inside an error boundary, so a broken prototype can't reach or
 * crash the rest of the Command Center. The top-right pill jumps back to its Play Place card
 * (Steer box focused) or reloads it.
 */
export function MountedAppView() {
  const appId = useNav((s) => s.appId);
  const app = useMyApps((s) => s.apps.find((a) => a.id === appId));
  const [reload, setReload] = useState(0);
  if (!app) return <Gone title="This page isn't in My Apps any more" body="It was unpinned. Pin it again from its Play Place card." />;
  return (
    <div className="relative h-full w-full px-2 pb-24 md:px-3 md:pb-3">
      <div className="h-full overflow-hidden rounded-[14px] border border-white/[0.08] bg-white">
        <SandboxBoundary key={`${app.id}:${reload}`} label={app.label} onReset={() => setReload((n) => n + 1)}>
          {app.kind === "build" ? <BuildApp app={app} reload={reload} /> : <CardApp app={app} reload={reload} />}
        </SandboxBoundary>
      </div>
      <ActionPill app={app} onReload={() => setReload((n) => n + 1)} />
    </div>
  );
}

function ActionPill({ app, onReload }: { app: MountedApp; onReload: () => void }) {
  const Icon = iconOf(app.icon);
  const edit = () => editInPlayPlace(app);
  return (
    <div className="glass-thin absolute right-4 top-2 z-10 flex items-center gap-1 rounded-full py-1 pl-3 pr-1 opacity-60 shadow-lg transition-opacity duration-200 hover:opacity-100 focus-within:opacity-100 md:right-5">
      <Icon size={12} className="text-amber-soft" />
      <span className="max-w-40 truncate text-[11px] font-medium text-ink">{app.label}</span>
      <button onClick={edit} className="pill-glass !h-6 !px-2 text-[10.5px]" title="Back to its Play Place card, Steer box focused">
        <PencilLine size={11} /> Edit in Play Place
      </button>
      <button onClick={onReload} className="pill-glass !h-6 !w-6 !p-0" title="Reload the app" aria-label="Reload the app">
        <RotateCw size={11} />
      </button>
    </div>
  );
}

/** A staging-hub build, served from its output (or its promoted copy) on a loopback preview. */
function BuildApp({ app, reload }: { app: MountedApp; reload: number }) {
  useEffect(startHub, []);
  const view = useHub((s) => s.view);
  const build = view?.builds.find((b) => b.envelope.build_id === app.ref);
  if (!isTauri()) return <Gone title="Desktop only" body="Hub builds are served by the desktop app." />;
  if (view && !build) return <Gone title={`“${app.label}” is no longer in the staging hub`} body="Its build was removed. The files may still be in its output folder." app={app} />;
  return (
    <Suspense fallback={<Loading />}>
      <SandboxFrame buildId={app.ref} title={app.label} version={(build?.preview_version ?? 0) * 1000 + reload} />
    </Suspense>
  );
}

/** A Play Place prototype, served by the gateway (the same sandbox as its card). */
function CardApp({ app, reload }: { app: MountedApp; reload: number }) {
  const gw = useSettings((s) => s.gatewayUrl).replace(/\/+$/, "");
  const { items, loaded } = useCollection<PlayCard>("playplace");
  const card = items.find((c) => c.id === app.ref);
  if (loaded && !card) return <Gone title={`“${app.label}” was discarded from the Play Place`} body="Unpin it to tidy the rail." app={app} />;
  const src = `${gw}/api/play-place/${encodeURIComponent(app.ref)}/preview?v=${Math.round(card?._updated ?? 0)}&r=${reload}`;
  return (
    <iframe
      key={src}
      src={src}
      title={app.label}
      // No allow-same-origin: an opaque origin, isolated from the Command Center and your files.
      sandbox="allow-scripts allow-forms allow-modals allow-popups"
      className="size-full border-0 bg-white"
    />
  );
}

function Loading() {
  return <div className="grid h-full place-items-center bg-canvas font-mono text-[11px] text-ink-3">starting the app…</div>;
}

function Gone({ title, body, app }: { title: string; body: string; app?: MountedApp }) {
  return (
    <div className="grid h-full place-items-center bg-canvas p-6 text-center">
      <div>
        <TriangleAlert size={20} className="mx-auto mb-2 text-amber-soft" />
        <p className="text-sm text-ink">{title}</p>
        <p className="mt-1 text-xs text-ink-3">{body}</p>
        {app && (
          <button
            onClick={() => {
              useMyApps.getState().unmount(app.id);
              useNav.getState().go("playplace");
            }}
            className="pill-glass mt-3 !h-8 text-xs"
          >
            <PinOff size={12} /> Unpin
          </button>
        )}
      </div>
    </div>
  );
}
