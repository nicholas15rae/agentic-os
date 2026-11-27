import { useState } from "react";
import { useSettings } from "@/stores/settings";
import { useOsName } from "@/features/os/os-store";
import { useMic } from "./mic-gate";
import { setMicEnabled, setWakeMode } from "./voice-controller";
import { ThresholdMeter } from "./ThresholdMeter";

function Switch({ on, onClick, label, title, tone, disabled }: { on: boolean; onClick: () => void; label: string; title: string; tone: "teal" | "alert"; disabled?: boolean }) {
  const offTone = tone === "alert" ? "bg-alert/70" : "bg-white/15";
  return (
    <button role="switch" aria-checked={on} onClick={onClick} disabled={disabled} title={title} className="flex items-center gap-2 text-xs disabled:opacity-60">
      <span className={`relative h-5 w-9 rounded-full transition-colors ${on ? "bg-teal/80" : offTone}`}>
        <span className={`absolute top-0.5 size-4 rounded-full bg-white shadow transition-[left] duration-200 ${on ? "left-[18px]" : "left-0.5"}`} />
      </span>
      <span className={on ? "text-teal" : tone === "alert" ? "text-alert" : "text-ink-2"}>{label}</span>
    </button>
  );
}

/**
 * Pop-up voice controls (Phase 2 Part B): the hard Mic switch (locked off = no capture, no STT,
 * no hands-free), Hands-free on/off, "needs Hey Tony", and the activation threshold with its
 * live meter (visible whenever a capture is open).
 */
export function ListenControls() {
  const name = useOsName();
  const wakeMode = useSettings((s) => s.wakeMode);
  const wakeRequire = useSettings((s) => s.wakeRequire);
  const set = useSettings((s) => s.set);
  const micOn = useMic((s) => s.enabled);
  const hydrated = useMic((s) => s.hydrated);
  const live = useMic((s) => s.live);
  const [busy, setBusy] = useState(false);

  const toggleMic = () => {
    if (busy) return;
    if (micOn) return void setMicEnabled(false); // applied at once, before the IPC
    setBusy(true);
    void setMicEnabled(true).finally(() => setBusy(false));
  };

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 pb-2">
      <Switch
        on={micOn}
        onClick={toggleMic}
        disabled={busy}
        tone="alert"
        label={micOn ? "Mic on" : hydrated ? "Mic locked off" : "Mic locked (starting)"}
        title={micOn ? "Lock the mic off: nothing is captured or transcribed until you unlock it here" : "Unlock the mic"}
      />
      {micOn && (
        <Switch
          on={wakeMode}
          onClick={() => setWakeMode(!wakeMode)}
          tone="teal"
          label={`Hands-free ${wakeMode ? "on" : "off"}`}
          title={wakeMode ? "Hands-free: the mic stays open for the wake word" : "Off: the mic only opens when you tap it or press Ctrl+Shift+Space"}
        />
      )}
      {micOn && wakeMode && (
        <button
          onClick={() => set({ wakeRequire: !wakeRequire })}
          aria-pressed={wakeRequire}
          className={`rounded-full border px-2.5 py-0.5 text-[11px] ${wakeRequire ? "border-amber/50 bg-amber/10 text-amber-light" : "border-white/10 text-ink-3"}`}
          title={wakeRequire ? `Only acts on lines that start with “Hey ${name}”` : "Acts on everything it hears"}
        >
          {wakeRequire ? `Needs “Hey ${name}”` : "Any speech"}
        </button>
      )}
      {micOn && live > 0 && <ThresholdMeter variant="compact" />}
    </div>
  );
}
