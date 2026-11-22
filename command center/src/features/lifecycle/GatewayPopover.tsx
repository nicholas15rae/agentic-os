import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Gauge, Globe, Loader2, RotateCw, Server, Wifi, WifiOff, X } from "lucide-react";
import { create } from "zustand";
import { isTauri, native } from "@/lib/platform";
import { useSettings } from "@/stores/settings";
import { healthView, type HealthSnapshot } from "./health";

/** Live poll cadence while the popover is open (never polled while closed). */
export const NET_POLL_MS = 2000;
const SPARK_POINTS = 30;

export interface NetTelemetry {
  connected: boolean;
  interfaceName: string | null;
  interfaceKind: string | null;
  pingMs: number | null;
  pingTarget: string | null;
  downBps: number | null;
  upBps: number | null;
  at: number;
}

export interface SpeedResult {
  downloadMbps: number;
  uploadMbps: number;
  pingMs: number | null;
  loadedPingMs: number | null;
  downBytes: number;
  upBytes: number;
  at: number;
}

/** Throughput for humans: "820 B/s", "4.2 KB/s", "12.4 Mbps". Pure. */
export function fmtRate(bps: number | null | undefined): string {
  if (bps == null || !Number.isFinite(bps)) return "—";
  const bits = bps * 8;
  if (bits >= 1_000_000) return `${(bits / 1_000_000).toFixed(bits >= 100_000_000 ? 0 : 1)} Mbps`;
  if (bps >= 1024) return `${(bps / 1024).toFixed(bps >= 102_400 ? 0 : 1)} KB/s`;
  return `${Math.round(bps)} B/s`;
}

/** "just now" / "42s ago" / "5m ago" / "3h ago". Pure. */
export function fmtAgo(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

/** The last speed test survives closing the popover (session only). */
const useSpeed = create<{ result: SpeedResult | null; phase: string | null; error: string | null }>(() => ({ result: null, phase: null, error: null }));

async function runSpeedTest() {
  if (useSpeed.getState().phase) return;
  useSpeed.setState({ phase: "ping", error: null });
  let off: (() => void) | undefined;
  try {
    const { listen } = await import("@tauri-apps/api/event");
    off = await listen<{ phase: string }>("speed-test-progress", (e) => useSpeed.setState({ phase: e.payload.phase }));
    const result = await native<SpeedResult>("run_speed_test");
    useSpeed.setState({ result, phase: null });
  } catch (e) {
    useSpeed.setState({ phase: null, error: e instanceof Error ? e.message : String(e) });
  } finally {
    off?.();
  }
}

const PHASE_LABEL: Record<string, string> = { ping: "Measuring ping…", download: "Testing download…", upload: "Testing upload…", done: "Finishing…" };

function Spark({ values, color }: { values: number[]; color: string }) {
  if (values.length < 2) return <div className="h-5" />;
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => `${(i / (SPARK_POINTS - 1)) * 100},${20 - (v / max) * 18}`).join(" ");
  return (
    <svg viewBox="0 0 100 20" preserveAspectRatio="none" className="h-5 w-full" aria-hidden>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.4} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Live internet telemetry while mounted (the popover mounts this only while open). */
function useNetTelemetry(): { net: NetTelemetry | null; error: string | null; down: number[]; up: number[] } {
  const [net, setNet] = useState<NetTelemetry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hist, setHist] = useState<{ down: number[]; up: number[] }>({ down: [], up: [] });
  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const n = await native<NetTelemetry>("get_network_telemetry");
        if (!alive) return;
        setNet(n);
        setError(null);
        if (n.downBps != null && n.upBps != null) setHist((h) => ({ down: [...h.down, n.downBps!].slice(-SPARK_POINTS), up: [...h.up, n.upBps!].slice(-SPARK_POINTS) }));
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive) timer = setTimeout(() => void tick(), NET_POLL_MS);
      }
    };
    void tick();
    return () => {
      // Closed: stop polling at once and reset the counter baseline.
      alive = false;
      clearTimeout(timer);
      void native("network_telemetry_stop").catch(() => undefined);
    };
  }, []);
  return { net, error, ...hist };
}

const Row = ({ k, v, tone }: { k: string; v: React.ReactNode; tone?: string }) => (
  <div className="flex items-center justify-between gap-3 text-[11.5px]">
    <span className="text-ink-3">{k}</span>
    <span className={`font-mono ${tone ?? "text-ink-2"}`}>{v}</span>
  </div>
);

/**
 * The Gateway quick-look HUD: rendered in a `document.body` portal at z-9999 (above the Spotify
 * widget, the Reel bar and every dashboard widget), anchored to the right of the rail button.
 * Closes on a second click of the button, an outside click, or Esc.
 */
export function GatewayPopover({ anchor, health, onClose, onReset }: { anchor: RefObject<HTMLElement | null>; health: HealthSnapshot; onClose: () => void; onReset: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
  const v = healthView(health);
  const gatewayUrl = useSettings((s) => s.gatewayUrl);
  const { net, error, down, up } = useNetTelemetry();
  const speed = useSpeed();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  useLayoutEffect(() => {
    const place = () => {
      const r = anchor.current?.getBoundingClientRect();
      if (r) setPos({ left: r.right + 10, bottom: Math.max(8, window.innerHeight - r.bottom) });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || anchor.current?.contains(t)) return; // the button toggles itself
      onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [anchor, onClose]);

  if (!pos) return null;
  const toneCls = v.tone === "ok" ? "text-teal" : v.tone === "warn" ? "text-amber-soft" : v.tone === "bad" ? "text-alert" : "text-ink-2";
  let endpoint = gatewayUrl;
  try {
    const u = new URL(gatewayUrl);
    endpoint = `${u.hostname}:${u.port || (u.protocol === "https:" ? "443" : "80")}`;
  } catch {
    /* keep the raw setting */
  }
  return createPortal(
    <div
      ref={panel}
      role="dialog"
      aria-label="Gateway and network"
      className="fixed z-[9999] w-[300px] rounded-[16px] border border-white/10 bg-[rgba(6,8,12,0.96)] p-3 text-xs shadow-[0_18px_50px_rgba(0,0,0,0.6)]"
      style={{ left: pos.left, bottom: pos.bottom }}
    >
      <div className="mb-2 flex items-center">
        <span className="label-caps text-ink-2">Gateway &amp; network</span>
        <button type="button" onClick={onClose} className="ml-auto grid size-6 place-items-center rounded-full text-ink-3 hover:bg-white/10 hover:text-ink" aria-label="Close">
          <X size={12} />
        </button>
      </div>

      <section className="space-y-1 rounded-[12px] border border-white/[0.07] bg-white/[0.02] p-2.5">
        <p className="label-caps mb-1 flex items-center gap-1.5 text-ink-3">
          <Server size={11} /> Local gateway
        </p>
        <Row k="Status" v={v.label} tone={toneCls} />
        <Row k="Loopback latency" v={health.latencyMs != null ? `${health.latencyMs} ms` : "—"} />
        <Row k="Endpoint" v={endpoint} />
        {health.detail && health.state !== "online" && <p className="text-[10.5px] text-ink-3">{health.detail}</p>}
        <button type="button" onClick={onReset} disabled={health.reconnecting} className={`${v.alarm ? "pill-primary" : "pill-glass"} mt-1.5 !h-8 w-full justify-center text-[11px]`}>
          {health.reconnecting ? <Loader2 size={12} className="animate-spin" /> : <RotateCw size={12} />} Reconnect / Refresh
        </button>
      </section>

      <section className="mt-2 space-y-1 rounded-[12px] border border-white/[0.07] bg-white/[0.02] p-2.5">
        <p className="label-caps mb-1 flex items-center gap-1.5 text-ink-3">
          <Globe size={11} /> Internet
        </p>
        {!isTauri() ? (
          <p className="text-[11px] text-ink-3">Internet telemetry needs the desktop app.</p>
        ) : (
          <>
            <Row
              k="Connection"
              v={
                net ? (
                  <span className={`flex items-center gap-1 ${net.connected ? "text-teal" : "text-alert"}`}>
                    {net.connected ? <Wifi size={11} /> : <WifiOff size={11} />} {net.connected ? "Connected" : "Offline"}
                  </span>
                ) : (
                  "…"
                )
              }
            />
            <Row k="Interface" v={net?.interfaceKind ? `${net.interfaceKind}${net.interfaceName && net.interfaceName !== net.interfaceKind ? ` · ${net.interfaceName}` : ""}` : "—"} />
            <Row k={`Ping${net?.pingTarget ? ` (${net.pingTarget})` : ""}`} v={net?.pingMs != null ? `${net.pingMs} ms` : "—"} tone={net?.pingMs != null && net.pingMs > 150 ? "text-amber-soft" : undefined} />
            <div className="grid grid-cols-2 gap-2 pt-1">
              <div>
                <Row k="↓ Down" v={fmtRate(net?.downBps)} tone="text-teal" />
                <Spark values={down} color="#2dd4bf" />
              </div>
              <div>
                <Row k="↑ Up" v={fmtRate(net?.upBps)} tone="text-amber-soft" />
                <Spark values={up} color="#fbbf24" />
              </div>
            </div>
            {error && <p className="text-[10.5px] text-alert">{error}</p>}
            <div className="mt-1 border-t border-white/[0.06] pt-2">
              {speed.result && !speed.phase && (
                <div className="mb-1.5 space-y-0.5">
                  <Row k="Download" v={`${speed.result.downloadMbps} Mbps`} tone="text-teal" />
                  <Row k="Upload" v={`${speed.result.uploadMbps} Mbps`} tone="text-amber-soft" />
                  <Row k="Ping unloaded / loaded" v={`${speed.result.pingMs ?? "—"} / ${speed.result.loadedPingMs ?? "—"} ms`} />
                  <p className="text-right font-mono text-[10px] text-ink-3">Tested {fmtAgo(speed.result.at, now)}</p>
                </div>
              )}
              {speed.error && !speed.phase && <p className="mb-1 text-[10.5px] text-alert">{speed.error}</p>}
              <button type="button" onClick={() => void runSpeedTest()} disabled={!!speed.phase} className="pill-glass !h-8 w-full justify-center text-[11px]" title="Downloads ~10 MB and uploads ~3 MB (Cloudflare) — only when you click">
                {speed.phase ? <Loader2 size={12} className="animate-spin" /> : <Gauge size={12} />} {speed.phase ? (PHASE_LABEL[speed.phase] ?? "Testing…") : speed.result ? "Test speed again" : "Test speed"}
              </button>
            </div>
          </>
        )}
      </section>
    </div>,
    document.body,
  );
}
