import { cmd } from "@/lib/platform";

/**
 * The Engine / Models screen's calls to `/api/engine/*`, through Rust (`engine_call`): the gateway
 * first, then the engine sidecar (`python -m engine.serve`, 127.0.0.1:8081) when the gateway's
 * code has no engine routes yet. Same shape as `gateway()` (path + method / JSON body / timeout).
 */
export async function engineApi<T>(path: string, init?: { method?: string; body?: string; timeoutMs?: number }): Promise<T> {
  return (await cmd("engine_call", {
    method: (init?.method ?? "GET").toUpperCase(),
    path,
    body: init?.body ? JSON.parse(init.body) : undefined,
    timeoutSecs: Math.ceil((init?.timeoutMs ?? 15_000) / 1000),
  })) as T;
}
