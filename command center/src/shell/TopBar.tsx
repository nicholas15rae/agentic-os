import { useEffect } from "react";
import { AwayButton } from "@/features/arbiter/AwayButton";
import { Command, LayoutGrid, Check } from "lucide-react";
import { useSettings } from "@/stores/settings";
import { useNav } from "@/stores/nav";
import { useActiveSurface } from "@/core/widgets/surface-context";
import { useLayout } from "@/core/widgets/layout-store";
import { TopBarClock } from "./TopBarClock";
import { STATE_LABEL, useVoice } from "@/features/voice/voice-store";
import { STATE_DOT } from "@/features/voice/VoiceParts";
import { headerSubtitle } from "@/features/voice/voice-status";
import { ActiveSlotPill, ComputeModeSwitch, DropletBadge, KillSwitch, PrivacyPill } from "@/features/os/OsControls";
import { LockNowButton } from "@/features/security/SecurityGate";
import { ModePill } from "@/features/modes/ModePill";
import { MicLockBadge, useMicIndicator } from "@/features/voice/MicLockBadge";
import { isMicOff } from "@/features/voice/mic-indicator";
import { BusinessSwitcher } from "@/features/ops/BusinessSwitcher";

export function TopBar() {
  const identity = useSettings((s) => s.identity);
  const section = useNav((s) => s.section);
  // The page on screen: home, or a page drawn with the shared LayoutSurface.
  const surface = useActiveSurface((s) => s.store);
  const editing = surface((s) => s.editing);
  const setEditing = surface((s) => s.setEditing);
  const wakeMode = useSettings((s) => s.wakeMode);
  const voiceState = useVoice((s) => s.state);
  // Phase 2 Part D: a locked-off mic replaces the state dot with a static red MicOff at every width.
  const mic = useMicIndicator();
  // Derived on every render, never written back: the subtitle setting stays what the user typed.
  // "error" is a resting state (capture already stopped), so it reads STANDBY; the dot still shows red.
  const status = headerSubtitle(identity.subtitle, wakeMode || (voiceState !== "idle" && voiceState !== "error"), voiceState === "holding");

  // The HUD's typed input autofocuses when the panel expands.
  const openCommand = () => useVoice.getState().setExpanded(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        openCommand();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <header className="flex items-center gap-3 px-4 pb-3 pt-[calc(env(safe-area-inset-top)+0.75rem)] md:px-6 xl:px-8">
      {/* Below md the callsign keeps ~3 characters next to the clock and Widgets (it never pushes them off). */}
      <div className="glass-thin flex h-11 min-w-0 items-center gap-3 rounded-full px-4 max-sm:min-w-[5.75rem]">
        {isMicOff(mic) ? <MicLockBadge variant="dot" /> : <span className={`size-2 shrink-0 rounded-full ${STATE_DOT[voiceState]}`} />}
        <span data-callsign className="truncate font-mono fs-13 font-semibold tracking-wider text-ink">{identity.callsign}</span>
        <span className="hidden h-4 w-px bg-white/15 sm:block" />
        <span className="label-caps hidden text-teal sm:block">{status.text}</span>
        {status.chip && (
          <span className="label-caps hidden shrink-0 rounded-full border border-teal/30 px-2 py-0.5 text-ink-2 sm:block">{STATE_LABEL[voiceState]}</span>
        )}
      </div>

      {/* md–lg: icon only, so the clock and the callsign keep their room (the name stays as the aria-label). */}
      <button onClick={openCommand} aria-label="Command (Ctrl K)" title="Command (Ctrl K)" className="glass-thin hidden h-11 shrink-0 items-center gap-2 rounded-full px-4 text-ink-2 transition-colors hover:text-ink md:flex">
        <Command size={14} />
        <span className="label-caps hidden lg:inline">Command</span>
        <kbd className="label-caps hidden rounded border border-white/10 px-1.5 text-ink-3 lg:inline">Ctrl K</kbd>
      </button>

      {/* One right-side group: the OS pills (md+), the clock in the old atmosphere-picker slot (every width;
          the picker now lives in the Living Weather widget), then Widgets on the Command page. */}
      <div className="ml-auto flex shrink-0 items-center gap-3">
        <div className="hidden md:flex md:items-center md:gap-2">
          <BusinessSwitcher />
          <AwayButton />
          <ActiveSlotPill />
          <ComputeModeSwitch compact />
          <DropletBadge />
          <ModePill />
          <PrivacyPill />
          <LockNowButton />
          <KillSwitch />
        </div>
        <TopBarClock />
        {(section === "command" || surface !== useLayout) && <EditToggle editing={editing} setEditing={setEditing} />}
      </div>
    </header>
  );
}

function EditToggle({ editing, setEditing }: { editing: boolean; setEditing: (v: boolean) => void }) {
  return (
    <button
      onClick={() => setEditing(!editing)}
      aria-pressed={editing}
      aria-label={editing ? "Done" : "Widgets"}
      title={editing ? "Done editing widgets" : "Edit widgets"}
      className={`flex h-11 shrink-0 items-center gap-2 rounded-full px-3.5 transition-colors sm:px-4 ${editing ? "bg-amber text-canvas glow-amber" : "glass-thin text-ink-2 hover:text-ink"}`}
    >
      {editing ? <Check size={15} /> : <LayoutGrid size={15} />}
      {/* Icon-only on phones (the aria-label keeps the name). */}
      <span className="label-caps hidden sm:inline">{editing ? "Done" : "Widgets"}</span>
    </button>
  );
}
