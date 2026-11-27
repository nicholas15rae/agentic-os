import { useState } from "react";
import { Loader2, Power, RefreshCw } from "lucide-react";
import { StatusDot, WidgetHeader } from "@/components/WidgetHeader";
import { cmd } from "@/lib/platform";
import { isDesktopApp } from "@/stores/settings";
import { useServicesHealth } from "@/features/services/use-health";

const TAG: Record<string, string> = { local: "LOCAL", cloud: "CLOUD", "agentic-os": "AGENT", stt: "STT", tts: "TTS", n8n: "N8N" };

/** Every node is shown green only after a real probe answered (not just "configured"). */
export default function AgentNodes() {
  const { services, error, refresh, at } = useServicesHealth();
  const [starting, setStarting] = useState<string | null>(null);
  const up = services.filter((s) => s.up).length;
  const gateway = services.find((s) => s.id === "gateway");

  const desktop = isDesktopApp();
  const startGateway = async () => {
    if (!desktop) {
      // Phone / browser: the gateway runs on the PC. Re-test it and show the real reason.
      setStarting("Starting test…");
      await refresh();
      setStarting(null);
      return;
    }
    setStarting("Starting gateway…");
    try {
      const r = await cmd("gateway_ensure");
      setStarting(r.up ? null : r.detail);
      await refresh();
    } catch (e) {
      setStarting(String(e));
    }
  };

  return (
    <div className="flex h-full flex-col">
      <WidgetHeader
        title="Active nodes"
        status={
          <>
            <StatusDot tone={error ? "down" : up === services.length && up ? "ok" : up ? "warn" : "idle"} label={at ? `${up}/${services.length} up` : "probing"} />
            <button aria-label="Re-check nodes" onClick={() => void refresh()} className="grid size-6 place-items-center rounded-full text-ink-3 hover:text-ink">
              <RefreshCw size={11} />
            </button>
          </>
        }
      />
      {gateway && !gateway.up && (
        <button onClick={() => void startGateway()} disabled={!!starting && starting.startsWith("Starting")} className="pill-primary mb-2 !h-8 w-full text-xs">
          {starting?.startsWith("Starting") ? <Loader2 size={13} className="animate-spin" /> : desktop ? <Power size={13} /> : <RefreshCw size={13} />}{" "}
          {desktop ? "Start gateway (server.py)" : "Test gateway connection"}
        </button>
      )}
      {gateway && !gateway.up && !desktop && <p className="mb-2 fs-11 text-alert">{gateway.detail}</p>}
      {starting && !starting.startsWith("Starting") && <p className="mb-2 fs-11 text-alert">{starting}</p>}
      <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto">
        {services.map((s) => (
          <li key={s.id} title={s.detail} className="flex items-center gap-2.5 rounded-full border border-white/[0.06] bg-white/[0.02] px-3 py-1.5">
            <span className={`size-1.5 shrink-0 rounded-full ${s.up ? "bg-teal shadow-[0_0_6px_#00e5c3]" : s.manual ? "bg-ink-3" : "bg-alert"}`} />
            <span className="truncate font-mono fs-12.5 text-ink">{s.label}</span>
            <span className={`truncate font-mono fs-10.5 ${s.up ? "text-ink-3" : s.manual ? "text-ink-3" : "text-alert/80"}`}>{s.up ? `${s.latencyMs}ms` : s.detail}</span>
            <span className="label-caps ml-auto shrink-0 text-amber-soft">{TAG[s.kind] ?? s.kind.toUpperCase()}</span>
          </li>
        ))}
        {!services.length && <li className="text-sm text-ink-3">{error ?? "Probing services…"}</li>}
      </ul>
    </div>
  );
}
