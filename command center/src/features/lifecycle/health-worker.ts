/// <reference lib="webworker" />
/**
 * Phone / browser gateway heartbeat, in a Web Worker so the probe loop never runs on the UI
 * thread (the desktop's heartbeat is Rust's `lifecycle::health_loop`). Messages:
 *   in:  { base, token, everyMs, failEveryMs, timeoutMs } (start / reconfigure), "now" (probe now)
 *   out: Probe ({ ok, latencyMs } | { ok: false, timeout, detail })
 */
type Cfg = { base: string; token: string; everyMs: number; failEveryMs: number; timeoutMs: number };
let cfg: Cfg | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

async function probe(): Promise<void> {
  if (!cfg) return;
  const c = cfg;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), c.timeoutMs);
  const t0 = performance.now();
  let failed = false;
  try {
    const headers: Record<string, string> = c.token.trim() ? { Authorization: `Bearer ${c.token.trim()}` } : {};
    let r = await fetch(`${c.base}/api/ping`, { signal: ctrl.signal, headers, cache: "no-store" });
    if (r.status === 404) r = await fetch(`${c.base}/api/status`, { signal: ctrl.signal, headers, cache: "no-store" });
    if (r.ok) postMessage({ ok: true, latencyMs: Math.round(performance.now() - t0) });
    else {
      failed = true;
      postMessage({ ok: false, timeout: false, detail: `HTTP ${r.status}` });
    }
  } catch (e) {
    failed = true;
    const timeout = e instanceof DOMException && e.name === "AbortError";
    postMessage({ ok: false, timeout, detail: timeout ? "no answer" : "unreachable" });
  } finally {
    clearTimeout(t);
  }
  clearTimeout(timer);
  timer = setTimeout(() => void probe(), failed ? c.failEveryMs : c.everyMs);
}

self.onmessage = (e: MessageEvent<Cfg | "now">) => {
  if (e.data === "now") return void probe();
  cfg = e.data;
  void probe();
};
