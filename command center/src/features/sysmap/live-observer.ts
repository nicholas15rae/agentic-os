/**
 * [v3] Live Observer — webview side. ONLY while Live Observer Mode is on:
 * - a 250 ms `setInterval` drift monitor: a tick that arrives > 250 ms late means the main thread
 *   was blocked; it is reported as `ui_stall` (ms = the lag) through `live_ui_event` (ticks while the
 *   window is hidden, and the first tick after it is restored, are throttled, not stalls: ignored);
 * - window `error` / `unhandledrejection` -> `ui_error` with a short label only (error name + first
 *   120 chars of the message; never the stack, never user data).
 * Both are rate-limited to one report per 2 s; anything inside the cooldown is merged into the next
 * report. `syncLiveObserver(false)` removes the interval and both listeners (zero cost when off).
 */
import { isTauri, native } from "@/lib/platform";
import type { DiagCommands, UiEventKind } from "./diagnostics.contract";

export const TICK_MS = 250;
export const STALL_MS = 250;
export const REPORT_GAP_MS = 2_000;
export const LABEL_MAX = 120;

/** How late a fixed-period tick arrived (pure, injected clock). */
export class DriftMonitor {
  private expected: number;
  constructor(
    now: number,
    readonly periodMs = TICK_MS,
    readonly thresholdMs = STALL_MS,
  ) {
    this.expected = now + periodMs;
  }
  /** Call on every tick: the lag in ms when it exceeds the threshold, else null. Re-bases on `now`. */
  tick(now: number): number | null {
    const lag = now - this.expected;
    this.expected = now + this.periodMs;
    return lag > this.thresholdMs ? Math.round(lag) : null;
  }
}

export interface Emit {
  ms: number;
  detail: string | null;
}

/**
 * At most one emit per `gapMs`; offers inside the cooldown are merged (count, max, total, first
 * label) and come out with the next allowed flush (pure, injected clock).
 */
export class MergingLimiter {
  private last = Number.NEGATIVE_INFINITY;
  private pending: { count: number; maxMs: number; totalMs: number; first: string | null } | null = null;
  constructor(
    private readonly format: (p: { count: number; maxMs: number; totalMs: number; first: string | null }) => Emit,
    readonly gapMs = REPORT_GAP_MS,
  ) {}
  offer(now: number, ms: number, detail: string | null = null): Emit | null {
    const p = this.pending;
    this.pending = p ? { count: p.count + 1, maxMs: Math.max(p.maxMs, ms), totalMs: p.totalMs + ms, first: p.first ?? detail } : { count: 1, maxMs: ms, totalMs: ms, first: detail };
    return this.flush(now);
  }
  /** Emit what is pending if the cooldown has passed. */
  flush(now: number): Emit | null {
    if (!this.pending || now - this.last < this.gapMs) return null;
    const e = this.format(this.pending);
    this.pending = null;
    this.last = now;
    return e;
  }
  get hasPending(): boolean {
    return this.pending !== null;
  }
}

/** ui_stall: ms = worst lag; merged stalls say how many and their total (numbers only). */
export const formatStall = (p: { count: number; maxMs: number; totalMs: number }): Emit => ({ ms: p.maxMs, detail: p.count > 1 ? `merged ${p.count} stalls, total ${p.totalMs}ms` : null });

/** ui_error: the first label, plus how many more were merged. */
export const formatError = (p: { count: number; first: string | null }): Emit => ({ ms: 0, detail: `${p.first ?? "Error"}${p.count > 1 ? ` (+${p.count - 1} more)` : ""}` });

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** Short, stack-free label for anything thrown (pure): "TypeError: first 120 chars of message". */
export function errorLabel(x: unknown): string {
  if (x instanceof Error) return `${oneLine(x.name || "Error")}: ${oneLine(String(x.message ?? "")).slice(0, LABEL_MAX)}`;
  if (typeof x === "string") return `Error: ${oneLine(x).slice(0, LABEL_MAX)}`;
  if (x && typeof x === "object" && "name" in x && "message" in x) {
    const o = x as { name: unknown; message: unknown };
    return `${oneLine(String(o.name)).slice(0, 40)}: ${oneLine(String(o.message)).slice(0, LABEL_MAX)}`;
  }
  return `NonError: ${x === null ? "null" : typeof x}`;
}

type Listener = (ev: Event) => void;

/** Everything the observer touches, injectable for tests. */
export interface ObserverEnv {
  now: () => number;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (h: unknown) => void;
  addEventListener: (type: "error" | "unhandledrejection", fn: Listener) => void;
  removeEventListener: (type: "error" | "unhandledrejection", fn: Listener) => void;
  report: (kind: UiEventKind, ms: number, detail: string | null) => void;
  /** False while the window is hidden: timers are throttled then, so lateness is not a stall. */
  visible?: () => boolean;
  /** Subscribe to visibility changes (returns the unsubscribe). A hide shorter than one tick never
   *  shows up as a hidden tick, so the transition itself marks the next tick as throttled. */
  onVisibilityChange?: (fn: () => void) => () => void;
}

/** Start the drift monitor + error listeners; returns the full teardown. */
export function startLiveObserver(env: ObserverEnv): () => void {
  const drift = new DriftMonitor(env.now());
  const stalls = new MergingLimiter(formatStall);
  const errors = new MergingLimiter(formatError);
  const send = (kind: UiEventKind, e: Emit | null) => {
    if (e) env.report(kind, e.ms, e.detail);
  };
  // The first tick after the window is restored is still late from throttling: re-base, don't report it.
  let wasHidden = false;
  const handle = env.setInterval(() => {
    const now = env.now();
    const lag = drift.tick(now);
    if (env.visible && !env.visible()) {
      wasHidden = true;
      return;
    }
    const restored = wasHidden;
    wasHidden = false;
    send("ui_stall", lag != null && !restored ? stalls.offer(now, lag) : stalls.flush(now));
    send("ui_error", errors.flush(now));
  }, TICK_MS);
  const onError: Listener = (ev) => {
    const e = ev as Event & { error?: unknown; message?: unknown };
    send("ui_error", errors.offer(env.now(), 0, errorLabel(e.error ?? (typeof e.message === "string" ? e.message : "Script error"))));
  };
  const onRejection: Listener = (ev) => {
    send("ui_error", errors.offer(env.now(), 0, `Unhandled ${errorLabel((ev as Event & { reason?: unknown }).reason)}`));
  };
  env.addEventListener("error", onError);
  env.addEventListener("unhandledrejection", onRejection);
  const offVisibility = env.onVisibilityChange?.(() => {
    wasHidden = true;
  });
  return () => {
    env.clearInterval(handle);
    offVisibility?.();
    env.removeEventListener("error", onError);
    env.removeEventListener("unhandledrejection", onRejection);
  };
}

function windowEnv(): ObserverEnv | null {
  if (typeof window === "undefined" || !isTauri()) return null;
  return {
    now: () => performance.now(),
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: (h) => window.clearInterval(h as number),
    addEventListener: (t, fn) => window.addEventListener(t, fn),
    removeEventListener: (t, fn) => window.removeEventListener(t, fn),
    visible: () => document.visibilityState !== "hidden",
    onVisibilityChange: (fn) => {
      document.addEventListener("visibilitychange", fn);
      return () => document.removeEventListener("visibilitychange", fn);
    },
    report: (kind, ms, detail) => {
      const args: DiagCommands["live_ui_event"]["args"] = { kind, ms, detail };
      // A failed report is dropped: it must never surface as another unhandled rejection.
      native<null>("live_ui_event", args as unknown as Record<string, unknown>).catch(() => undefined);
    },
  };
}

let stop: (() => void) | null = null;

/** Start (on) / fully tear down (off) the webview observer. Idempotent; a no-op outside the desktop. */
export function syncLiveObserver(on: boolean, env: ObserverEnv | null = windowEnv()): void {
  if (on && !stop && env) stop = startLiveObserver(env);
  else if (!on && stop) {
    stop();
    stop = null;
  }
}

/** Is the observer running (for tests / the panel)? */
export const liveObserverRunning = () => stop !== null;
