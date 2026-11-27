import { lazy, Suspense, useEffect } from "react";
import { WallpaperSlideshow } from "@/features/wallpaper/WallpaperSlideshow";
import { WeatherCanvas } from "@/features/weather/WeatherCanvas";
import { VoiceHUD } from "@/features/voice/VoiceHUD";
import { ConfirmCard } from "@/features/orchestrator/ConfirmCard";
import { useReminderScheduler } from "@/features/reminders/scheduler";
import { useOsBoot } from "@/features/os/thread-sync";
import { useCueScheduler } from "@/features/cues/cue-runtime";
import { installSpotifyReauthNotice } from "@/features/integrations/spotify-connect";
import { Toasts } from "@/components/Toasts";
import { TopBar } from "@/shell/TopBar";
import { MobileTabs, SideRail } from "@/shell/Navigation";
import { ReelDock } from "@/shell/ReelDock";
import { PageSwitcher } from "@/shell/PageSwitcher";
import { useNav, type Section } from "@/stores/nav";
import { useSettings } from "@/stores/settings";
import { useLayout } from "@/core/widgets/layout-store";
import { useMyApps } from "@/features/myapps/store";
import { cc } from "@/lib/cc-api";
import { platform } from "@/lib/platform";
import { CommandSection } from "@/sections/CommandSection";
import { useRefresh } from "@/features/lifecycle/refresh";
import { bootOps } from "@/features/ops/ops-store";
import { useKillSwitchHotkey } from "@/features/trading/kill-switch";
import { SecurityGate } from "@/features/security/SecurityGate";
import { installPageLinks } from "@/core/widgets/page-links";
import { installWallTone } from "@/features/wallpaper/wall-tone";

// Heavier tabs load on demand.
const SECTION_VIEWS: Record<Section, React.LazyExoticComponent<() => React.JSX.Element> | (() => React.JSX.Element)> = {
  command: CommandSection,
  agents: lazy(() => import("@/sections/AgentsSection").then((m) => ({ default: m.AgentsSection }))),
  playplace: lazy(() => import("@/sections/PlayPlaceSection").then((m) => ({ default: m.PlayPlaceSection }))),
  director: lazy(() => import("@/sections/DirectorSuiteSection").then((m) => ({ default: m.DirectorSuiteSection }))),
  comms: lazy(() => import("@/sections/CommsSection").then((m) => ({ default: m.CommsSection }))),
  brainstorm: lazy(() => import("@/sections/BrainstormSection").then((m) => ({ default: m.BrainstormSection }))),
  finance: lazy(() => import("@/sections/FinanceSection").then((m) => ({ default: m.FinanceSection }))),
  // Operations Manager: business registry, Review Queue (HITL digest), audit trail.
  operations: lazy(() => import("@/sections/OperationsSection").then((m) => ({ default: m.OperationsSection }))),
  trading: lazy(() => import("@/sections/TradingSection").then((m) => ({ default: m.TradingSection }))),
  // Language Hub: translator, tutor, phrase library (its own store; on the phone via the gateway).
  language: lazy(() => import("@/sections/LanguageSection").then((m) => ({ default: m.LanguageSection }))),
  vault: lazy(() => import("@/sections/VaultSection").then((m) => ({ default: m.VaultSection }))),
  wallpapers: lazy(() => import("@/sections/WallpapersSection").then((m) => ({ default: m.WallpapersSection }))),
  // System Map: the only chunk that loads three.js (Part 5's HoloViewport).
  memorymap: lazy(() => import("@/sections/MemoryMapSection").then((m) => ({ default: m.MemoryMapSection }))),
  settings: lazy(() => import("@/sections/SettingsSection").then((m) => ({ default: m.SettingsSection }))),
  // MY APPS: a Play Place build mounted as a page (sandboxed, error-bounded).
  app: lazy(() => import("@/features/myapps/MountedAppView").then((m) => ({ default: m.MountedAppView }))),
};

/**
 * Layer stack (back → front):
 *   WallpaperSlideshow (-z-10) → WeatherCanvas (-z-5) → shell + section →
 *   VoiceHUD / orb (z-50) → drawers and modals (z-75…z-85: Agents drawer,
 *   Intake / settings modals z-80, Play Place full screen z-85) →
 *   ConfirmCard (z-90) → Toasts (z-95)
 * The ConfirmCard sits above every modal because a modal can raise one (the
 * Brainstorm intake's "Dispatch to Play Place" does): a card under its own
 * modal can't be clicked and times out. src/lib/layers.test.ts pins this.
 * The HUD, scheduler and confirmation gate live outside the section switch,
 * so voice sessions and alarms survive navigation.
 */
const MobileHud = lazy(() => import("@/features/hud/MobileHud").then((m) => ({ default: m.MobileHud })));
const HUD_VIEW = typeof location !== "undefined" && new URLSearchParams(location.search).get("view") === "hud";

export default function App() {
  // The app only mounts while the Rust session is unlocked (desktop / mobile app; the PWA
  // passes through and the gateway keeps its protected modules read-only).
  return <SecurityGate>{HUD_VIEW ? <HudApp /> : <MainApp />}</SecurityGate>;
}

/** Galaxy S22 Lockdown Command Center (/mobile-hud → /cc/?view=hud). */
function HudApp() {
  useOsBoot();
  useCueScheduler();
  return (
    <>
      <Suspense fallback={<div className="grid h-dvh place-items-center bg-black font-mono text-xs text-ink-3">loading…</div>}>
        <MobileHud />
      </Suspense>
      <ConfirmCard />
      <Toasts />
    </>
  );
}

function MainApp() {
  const section = useNav((s) => s.section);
  const View = SECTION_VIEWS[section];
  // Phase 1 Refresh: a new epoch re-mounts only the section view (audio lives outside <main>).
  const epoch = useRefresh((s) => s.epoch);
  useReminderScheduler();
  useOsBoot();
  useCueScheduler();
  useConfigSnapshot();
  useKillSwitchHotkey(); // Ctrl+Shift+X: trading E-stop from any section
  useEffect(installSpotifyReauthNotice, []); // toast when Rust opens a Spotify consent tab by itself
  useEffect(bootOps, []); // business registry + review-digest badge
  useEffect(installPageLinks, []); // page presets: a page ↔ Tony's mode, a page's own wallpaper
  useEffect(installWallTone, []); // widget text legibility follows the wallpaper's brightness
  return (
    <>
      <WallpaperSlideshow />
      <WeatherCanvas />
      <div className="flex h-dvh">
        <SideRail />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar />
          <main key={epoch} className="min-h-0 flex-1">
            <Suspense fallback={<div className="grid h-full place-items-center font-mono text-xs text-ink-3">loading…</div>}>
              <View />
            </Suspense>
          </main>
          {section === "command" && <ReelDock />}
        </div>
      </div>
      <MobileTabs />
      {section === "command" && <PageSwitcher mobile />}
      <VoiceHUD />
      <ConfirmCard />
      <Toasts />
    </>
  );
}

/**
 * Mirror this device's UI configuration (settings + every dashboard page) to the
 * gateway, so the scheduled backup captures it and you can restore it on a
 * new device. Debounced; never includes secrets (those live in the keychain).
 */
function useConfigSnapshot() {
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const push = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const { set: _set, ...settings } = useSettings.getState();
        const { pages, activePage } = useLayout.getState();
        const layout = { pages, activePage };
        const myApps = useMyApps.getState().apps;
        void cc.kvSet(`ui.${platform}`, { settings, layout, myApps, at: Date.now() }).catch(() => undefined);
      }, 5000);
    };
    push();
    const a = useSettings.subscribe(push);
    const b = useLayout.subscribe(push);
    const c = useMyApps.subscribe(push);
    return () => {
      a();
      b();
      c();
      clearTimeout(t);
    };
  }, []);
}
