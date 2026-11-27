import { useEffect, useRef, useState } from "react";
import { Loader2, Power, RotateCw, Activity } from "lucide-react";
import { GatewayPopover } from "./GatewayPopover";
import { isTauri } from "@/lib/platform";
import { xcmd } from "@/lib/native-ext";
import { useToasts } from "@/features/reminders/notify";
import { healthView } from "./health";
import { reconnectGateway, startHealth, useHealth } from "./health-store";
import { hardRefresh, registerBusyProbe, softRefresh, useRefresh, type SoftOutcome } from "./refresh";
import { useDictation } from "@/features/memmap/dictation";
import { useBrainstorm } from "@/features/brainstorm/capture";
import { cueActive } from "@/features/voice/handoff-cues";

const railBtn = "relative grid size-11 place-items-center rounded-[14px] text-ink-2 transition-all duration-200 hover:bg-white/5 hover:text-ink";

/** Bottom of the left rail: gateway heartbeat, Refresh / Hard Reload, Exit (Phase 1). */
/** Mics under `<main>` (a re-mount would drop them) and audio a hard reload would cut. */
function useBusyProbes() {
  useEffect(() => {
    const off = [
      registerBusyProbe("Memory dictation", "mic", () => useDictation.getState().phase !== "idle"),
      registerBusyProbe("Brainstorm Listen Mode", "mic", () => useBrainstorm.getState().listening),
      registerBusyProbe("vocal handoff", "audio", cueActive),
    ];
    return () => off.forEach((f) => f());
  }, []);
}

/** Tell Nic when a refresh re-synced but kept the view mounted for an open mic. */
export function noteSoft(o: SoftOutcome) {
  if (!o.remounted) useToasts.getState().push({ title: "Re-synced", body: `Views kept as they are while ${o.keptOpen.join(" and ")} is open — nothing you're dictating is lost.`, tone: "info" });
}

export function LifecycleRail() {
  useEffect(startHealth, []);
  useBusyProbes();
  return (
    <div className="mt-auto flex flex-col items-center gap-2.5 pt-2">
      <HealthButton />
      <RefreshButton />
      {isTauri() && <ExitButton />}
    </div>
  );
}

function HealthButton() {
  const h = useHealth((s) => s.health);
  const webview = useHealth((s) => s.webview);
  const v = healthView(h, webview);
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);

  const reset = async () => {
    try {
      const after = await reconnectGateway();
      noteSoft(await softRefresh());
      useToasts.getState().push({ title: "Master reset", body: `Gateway ${healthView(after).label}. Views re-synced.`, tone: after.state === "online" || after.state === "slow" ? "info" : "error" });
    } catch (e) {
      useToasts.getState().push({ title: "Reconnect failed", body: e instanceof Error ? e.message : String(e), tone: "error" });
    }
  };

  // The popover lives in a body portal (the rail is overflow-clipped and blurred, which hid the
  // old in-rail panel): the button only toggles; outside clicks / Esc close from the popover.
  return (
    <>
      <button
        ref={btn}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={v.title}
        title={v.title}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={`${railBtn} ${v.alarm ? "border border-alert/60 bg-alert/10 text-alert" : ""} ${open ? "bg-white/10 text-ink" : ""}`}
      >
        <Activity size={17} />
        <span className={`absolute right-2 top-2 size-2 rounded-full ${v.dot} ${v.alarm ? "animate-pulse" : ""}`} />
      </button>
      {open && <GatewayPopover anchor={btn} health={h} onClose={() => setOpen(false)} onReset={() => void reset()} />}
    </>
  );
}

function RefreshButton() {
  const busy = useRefresh((s) => s.busy);
  const run = async (hard: boolean) => {
    if (!hard) return noteSoft(await softRefresh());
    const out = await hardRefresh();
    if (out === "soft-fallback") useToasts.getState().push({ title: "Soft refresh instead", body: "Audio was still playing, so the full reload was skipped. Views were re-synced.", tone: "info" });
  };
  return (
    <button
      type="button"
      onClick={(e) => void run(e.shiftKey)}
      onContextMenu={(e) => {
        e.preventDefault();
        void run(true);
      }}
      aria-label="Refresh views (Shift-click or right-click: hard reload)"
      title="Refresh: clear caches, re-sync from the gateway, re-mount views. Shift-click / right-click: hard reload (waits for audio to go quiet)."
      className={railBtn}
    >
      {busy ? <Loader2 size={17} className="animate-spin" /> : <RotateCw size={17} />}
    </button>
  );
}

function ExitButton() {
  const [busy, setBusy] = useState(false);
  const exit = async () => {
    setBusy(true);
    try {
      const { busy: labels } = await xcmd("app_exit_check");
      if (labels.length && !confirm(`Quit now? This would interrupt:\n\n• ${labels.join("\n• ")}\n\nInterrupted builds resume from their last checkpoint next launch.`)) return;
      await xcmd("app_exit", { force: labels.length > 0 });
    } catch (e) {
      useToasts.getState().push({ title: "Couldn't exit", body: e instanceof Error ? e.message : String(e), tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" onClick={() => void exit()} disabled={busy} aria-label="Exit Command Center" title="Exit (closes the app cleanly)" className={`${railBtn} hover:!bg-alert/10 hover:!text-alert`}>
      {busy ? <Loader2 size={17} className="animate-spin" /> : <Power size={17} />}
    </button>
  );
}
