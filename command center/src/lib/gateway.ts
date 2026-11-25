/**
 * Client for the existing Agentic OS FastAPI backend (server.py, default :8080).
 * On desktop it runs next to the app; on mobile the PWA reaches it over NetBird.
 */
import { useSettings } from "@/stores/settings";
import { gatewayUpPerHeartbeat, noteWebviewReach } from "@/features/lifecycle/health-store";

export class GatewayError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/**
 * Protected modules (trading / finance / settings) are Read-Only at the gateway
 * (security_api.py): a write needs an `X-CC-Elevation` token minted by Rust after a step-up
 * PIN. A 423 STEP_UP_REQUIRED opens the PIN modal (desktop) and retries once with a token.
 */
export async function gateway<T>(path: string, init?: RequestInit & { timeoutMs?: number }, retried = false): Promise<T> {
  const { gatewayUrl, gatewayToken } = useSettings.getState();
  const base = gatewayUrl.replace(/\/+$/, "");
  const method = (init?.method ?? "GET").toUpperCase();
  const elevation = method !== "GET" ? await elevationFor(path) : null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init?.timeoutMs ?? 15_000);
  try {
    const res = await fetch(`${base}${path}`, {
      ...init,
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", ...authHeader(gatewayToken), ...(elevation ? { "X-CC-Elevation": elevation } : {}), ...(init?.headers ?? {}) },
    });
    noteWebviewReach(true);
    if (res.status === 423) {
      clearTimeout(timer);
      return await onLocked<T>(res, path, init, retried);
    }
    if (!res.ok) throw new GatewayError(`${res.status} ${res.statusText}`, res.status);
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof GatewayError) throw err;
    if (err instanceof Error && err.name === "AbortError") throw new GatewayError("Gateway timed out");
    noteWebviewReach(false, "network error");
    // The heartbeat (Rust, no CORS) reaching it while this window can't means a block, not an outage.
    throw new GatewayError(gatewayUpPerHeartbeat() ? `Gateway blocked for this window (origin ${location.origin} isn't allowed)` : "Gateway unreachable");
  } finally {
    clearTimeout(timer);
  }
}

async function elevationFor(path: string): Promise<string | null> {
  const { gatewayModule } = await import("@/features/security/api");
  const module = gatewayModule(path);
  if (!module) return null;
  const { elevationHeader } = await import("@/features/security/store");
  return elevationHeader(module);
}

async function onLocked<T>(res: Response, path: string, init: (RequestInit & { timeoutMs?: number }) | undefined, retried: boolean): Promise<T> {
  const body = (await res.json().catch(() => null)) as { detail?: { code?: string; module?: string; message?: string } } | null;
  const d = body?.detail ?? {};
  const { isTauri } = await import("@/lib/platform");
  if (d.code === "STEP_UP_REQUIRED" && d.module && isTauri() && !retried) {
    const { useSecurity } = await import("@/features/security/store");
    try {
      await useSecurity.getState().requestStepUp(d.module);
    } catch (e) {
      throw new GatewayError(e instanceof Error ? e.message : "step-up cancelled", 423); // cancelled: stays read-only
    }
    return gateway<T>(path, init, true);
  }
  if (d.code === "HARD_LOCKED" && isTauri()) {
    const { useSecurity } = await import("@/features/security/store");
    void useSecurity.getState().refresh();
  }
  throw new GatewayError(d.message ?? (d.code === "STEP_UP_REQUIRED" ? `${d.module ?? "This module"} is read-only on this device` : "Locked"), 423);
}

/** Network lock: the phone presents the gateway token (the desktop on loopback doesn't need it). */
export const authHeader = (token: string): Record<string, string> => (token.trim() ? { Authorization: `Bearer ${token.trim()}` } : {});

// ── Typed endpoints (see server.py) ──────────────────────────────────────────

export interface AgentHealth {
  name: string;
  status: string;
  version?: string;
  success_rate?: number;
  last_seen?: string;
}

export const api = {
  status: () => gateway<Record<string, unknown>>("/api/status"),
  agentsHealth: () => gateway<{ agents: AgentHealth[]; updated: string }>("/api/agents/health"),
  routerSuggest: (task: string) =>
    gateway<{ suggested_agent: string; confidence: string }>("/api/router/suggest", {
      method: "POST",
      body: JSON.stringify({ task }),
    }),
  chat: (agent: "opencode" | "agy", message: string) =>
    gateway<{ status: string; response: { content: string; agent: string; timestamp: string } }>("/api/chat", {
      method: "POST",
      body: JSON.stringify({ agent, message }),
      timeoutMs: 180_000,
    }),
};
