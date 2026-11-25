import { create } from "zustand";
import { onExtEvent, xcmd } from "@/lib/native-ext";
import { isDesktopApp, useSettings } from "@/stores/settings";
import { initPhoneToken } from "./phone-token";
import { foldProbe, UNKNOWN_HEALTH, type HealthSnapshot, type Probe, type WebviewReach } from "./health";

/**
 * Gateway heartbeat state. Desktop: Rust probes (`lifecycle::health_loop`) and pushes
 * `gateway-health`; this store only listens. Phone/browser: a Web Worker probes and posts results.
 * Either way no polling runs on the UI thread, and nothing here touches audio.
 */
interface HealthStore {
  health: HealthSnapshot;
  /** The window's own last gateway request (null until a view has called it). */
  webview: WebviewReach | null;
  set: (h: HealthSnapshot) => void;
}

export const useHealth = create<HealthStore>((set) => ({ health: UNKNOWN_HEALTH, webview: null, set: (health) => set({ health }) }));

/** Record a gateway request's network outcome (`ok` = an HTTP response came back, whatever its
 * status). Writes only on a change or every 5 s, so busy views don't re-render the rail. */
export function noteWebviewReach(ok: boolean, detail?: string): void {
  const prev = useHealth.getState().webview;
  const now = Date.now();
  if (prev && prev.ok === ok && now - prev.at < 5000) return;
  const origin = typeof location !== "undefined" ? location.origin : "?";
  useHealth.setState({ webview: { ok, at: now, origin, detail } });
}

/** Rust says the gateway is up: a network failure in this window is then a block, not an outage. */
export const gatewayUpPerHeartbeat = (): boolean => ["online", "slow"].includes(useHealth.getState().health.state);

let started = false;
let worker: Worker | null = null;

export function startHealth(): void {
  if (started) return;
  started = true;
  // Android: the gateway token comes back from the Keystore-encrypted store (and is saved on change).
  void initPhoneToken();
  if (isDesktopApp()) {
    void xcmd("gateway_health")
      .then((h) => h.checkedAt && useHealth.getState().set(h))
      .catch(() => undefined);
    void onExtEvent<HealthSnapshot>("gateway-health", (h) => useHealth.getState().set(h));
    return;
  }
  if (typeof Worker === "undefined") return;
  worker = new Worker(new URL("./health-worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (e: MessageEvent<Probe>) => useHealth.getState().set(foldProbe(useHealth.getState().health, e.data, Date.now()));
  const configure = () => {
    const { gatewayUrl, gatewayToken } = useSettings.getState();
    worker?.postMessage({ base: gatewayUrl.replace(/\/+$/, ""), token: gatewayToken, everyMs: 10_000, failEveryMs: 5_000, timeoutMs: 3_000 });
  };
  configure();
  useSettings.subscribe((s, p) => {
    if (s.gatewayUrl !== p.gatewayUrl || s.gatewayToken !== p.gatewayToken) configure();
  });
}

/** One-click Master Reset / Reconnect: Rust re-probes and relaunches the gateway if it is down;
 * the phone just re-probes now. The caller soft-refreshes the views afterwards. */
export async function reconnectGateway(): Promise<HealthSnapshot> {
  if (isDesktopApp()) {
    useHealth.getState().set({ ...useHealth.getState().health, reconnecting: true });
    const h = await xcmd("gateway_reconnect");
    useHealth.getState().set(h);
    return h;
  }
  worker?.postMessage("now");
  return useHealth.getState().health;
}
