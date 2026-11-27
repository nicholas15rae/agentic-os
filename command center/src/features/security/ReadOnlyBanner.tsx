import { useEffect, useState } from "react";
import { Eye, Lock, LockOpen } from "lucide-react";
import { isTauri } from "@/lib/platform";
import { MODULE_LABEL, securityApi, type ProtectedModule } from "./api";
import { useSecurity } from "./store";

/**
 * Read-Only posture of a protected section (Trading, Finance, Settings): viewing is always
 * safe; changes need a step-up PIN. Shows the countdown while unlocked and a one-click relock.
 */
export function ReadOnlyBanner({ module }: { module: ProtectedModule }) {
  const status = useSecurity((s) => s.status);
  const setStatus = useSecurity((s) => s.setStatus);
  const [, tick] = useState(0);
  const until = status?.modules.find((m) => m.module === module)?.elevatedUntil ?? null;
  // Same machine, same clock: Rust's unix seconds compare directly with Date.now().
  const left = until ? Math.max(0, Math.round(until - Date.now() / 1000)) : 0;
  useEffect(() => {
    if (!until) return;
    const t = window.setInterval(() => {
      tick((n) => n + 1);
      if (Date.now() / 1000 >= until) void useSecurity.getState().refresh();
    }, 1000);
    return () => window.clearInterval(t);
  }, [until]);

  const label = MODULE_LABEL[module];
  if (!isTauri()) {
    return (
      <div className="glass-thin flex items-center gap-2 rounded-full px-3 py-1.5 text-[11px] text-ink-3">
        <Eye size={12} /> {label}: read-only on this device (changes need the desktop app)
      </div>
    );
  }
  if (!status || !status.enabled) return null;
  if (left > 0) {
    return (
      <div className="flex items-center gap-2 rounded-full bg-amber/15 px-3 py-1.5 text-[11px] text-amber-light" role="status">
        <LockOpen size={12} />
        <span className="label-caps">{label} unlocked</span>
        <span className="font-mono">
          {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
        </span>
        <button className="ml-1 underline-offset-2 hover:underline" onClick={() => void securityApi.dropElevation(module).then(setStatus)}>
          Lock now
        </button>
      </div>
    );
  }
  return (
    <div className="glass-thin flex items-center gap-2 rounded-full px-3 py-1.5 text-[11px] text-ink-3" role="status">
      <Eye size={12} />
      <span className="label-caps">Read-only</span>
      <button className="flex items-center gap-1 text-ink-2 underline-offset-2 hover:text-ink hover:underline" onClick={() => void useSecurity.getState().requestStepUp(module).catch(() => undefined)}>
        <Lock size={11} /> Unlock changes
      </button>
    </div>
  );
}
