import { useEffect, useRef, useState } from "react";
import { Loader2, Power, RotateCw, Activity } from "lucide-react";
import { isTauri } from "@/lib/platform";
import { xcmd } from "@/lib/native-ext";
import { useToasts } from "@/features/reminders/notify";
import { healthView } from "./health";
import { reconnectGateway, startHealth, useHealth } from "./health-store";
import { hardRefresh, softRefresh, useRefresh } from "./refresh";

const railBtn = "relative grid size-11 place-items-center rounded-[14px] text-ink-2 transition-all duration-200 hover:bg-white/5 hover:text-ink";

/** Bottom of the left rail: gateway heartbeat, Refresh / Hard Reload, Exit (Phase 1). */
export function LifecycleRail() {
  useEffect(startHealth, []);
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
  const v = healthView(h);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  const reset = async () => {
    try {
      const after = await reconnectGateway();
      await softRefresh();
      useToasts.getState().push({ title: "Master reset", body: `Gateway ${healthView(after).label}. Views re-synced.`, tone: after.state === "online" || after.state === "slow" ? "info" : "error" });
    } catch (e) {
      useToasts.getState().push({ title: "Reconnect failed", body: e instanceof Error ? e.message : String(e), tone: "error" });
    }
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={v.title}
        title={v.title}
        aria-expanded={open}
        className={`${railBtn} ${v.alarm ? "border border-alert/60 bg-alert/10 text-alert" : ""}`}
      >
        <Activity size={17} />
        <span className={`absolute right-2 top-2 size-2 rounded-full ${v.dot} ${v.alarm ? "animate-pulse" : ""}`} />
      </button>
      {open && (
        <div role="dialog" aria-label="Gateway health" className="glass absolute bottom-0 left-[calc(100%+10px)] z-50 w-60 rounded-[14px] p-3 text-xs">
          <p className="label-caps text-ink-3">Gateway</p>
          <p className={`mt-1 font-mono text-[13px] ${v.tone === "ok" ? "text-teal" : v.tone === "warn" ? "text-amber-soft" : v.tone === "bad" ? "text-alert" : "text-ink-2"}`}>{v.label}</p>
          {h.detail && <p className="mt-0.5 text-ink-3">{h.detail}</p>}
          {h.checkedAt > 0 && <p className="mt-0.5 font-mono text-[10px] text-ink-3">checked {new Date(h.checkedAt).toLocaleTimeString()}</p>}
          <button onClick={() => void reset()} disabled={h.reconnecting} className={`${v.alarm ? "pill-primary" : "pill-glass"} mt-2 !h-8 w-full justify-center text-[11px]`}>
            {h.reconnecting ? <Loader2 size={12} className="animate-spin" /> : <RotateCw size={12} />} Trigger Master Reset / Reconnect
          </button>
        </div>
      )}
    </div>
  );
}

function RefreshButton() {
  const busy = useRefresh((s) => s.busy);
  const run = async (hard: boolean) => {
    if (!hard) return softRefresh();
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
