/**
 * One motion level for every animation loop and infinite CSS animation in the UI, so the
 * WebView2 gpu-process stops sharing the RTX 3060 with STT and the LLM when nobody is looking.
 *
 *   off  — the window is hidden (tray) or minimised: `document.hidden`, or the desktop shell's
 *          `window-visibility` event (src-tauri/src/webview_visibility.rs). Nothing draws.
 *   calm — visible, but the window isn't focused or nobody has touched it for IDLE_MS (and
 *          Settings → Appearance → "Calm when idle" is on). Ambient motion pauses: wallpaper
 *          drift and rotation, weather particles, pulses and spinners, System Map drift. Live
 *          voice feedback (orb, waveform, meter) keeps running at a lower frame rate.
 *   full — focused and in use: everything as designed.
 *
 * The level is mirrored to `<html data-motion="…">` (styles/index.css pauses the infinite
 * animations from there) and read by canvas loops through `frameLoop()` / `useMotionLevel()`.
 */
import { useSyncExternalStore } from "react";

export type MotionLevel = "full" | "calm" | "off";

/** No pointer / key / wheel / touch input for this long → calm. */
export const IDLE_MS = 60_000;

export interface MotionInputs {
  /** Window on screen: not hidden, not minimised. */
  visible: boolean;
  /** The window (or a frame inside it) has focus. */
  focused: boolean;
  /** Milliseconds since the last input. */
  idleMs: number;
  /** Settings → Appearance → "Calm when idle". Off = never calm. */
  calmWhenIdle: boolean;
}

export function resolveMotion(i: MotionInputs): MotionLevel {
  if (!i.visible) return "off";
  if (i.calmWhenIdle && (!i.focused || i.idleMs >= IDLE_MS)) return "calm";
  return "full";
}

// ── Store ───────────────────────────────────────────────────────────────────

let level: MotionLevel = "full";
const listeners = new Set<(l: MotionLevel) => void>();

export function motionLevel(): MotionLevel {
  return level;
}

export function subscribeMotion(fn: (l: MotionLevel) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Set by the watcher (and tests). Notifies only on a change. */
export function setMotionLevel(next: MotionLevel): void {
  if (next === level) return;
  level = next;
  for (const fn of [...listeners]) fn(next);
}

export function useMotionLevel(): MotionLevel {
  return useSyncExternalStore(subscribeMotion, motionLevel, () => "full");
}

// ── Watcher ─────────────────────────────────────────────────────────────────

type Off = () => void;

/** Everything the watcher touches, injectable so tests run without a DOM. */
export interface MotionEnv {
  now(): number;
  isHidden(): boolean;
  hasFocus(): boolean;
  /** Document-level events (visibilitychange) and window-level ones (focus, blur, input). */
  onDoc(ev: string, fn: () => void): Off;
  onWin(ev: string, fn: () => void): Off;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(id: unknown): void;
  calmWhenIdle(): boolean;
  onCalmSetting(fn: () => void): Off;
  /** Desktop shell: window shown / hidden (`window-visibility`) and focus changes. */
  onNativeVisibility?(fn: (visible: boolean) => void): Off;
  onNativeFocus?(fn: (focused: boolean) => void): Off;
  /** `<html>`'s dataset: gets `data-motion`. */
  root?: { dataset: Record<string, string | undefined> };
}

/** User input that counts as "someone is here". */
export const INPUT_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;

/**
 * Track visibility, focus and input and keep the motion level current. Returns a disposer.
 * Input while already `full` only stamps a time; the idle timer re-checks when it could expire.
 */
export function installMotionWatcher(env: MotionEnv): Off {
  let nativeVisible = true;
  let nativeFocused: boolean | undefined;
  let lastInput = env.now();
  let timer: unknown;
  const offs: Off[] = [];

  const focused = () => nativeFocused ?? env.hasFocus();

  const recompute = () => {
    if (timer !== undefined) env.clearTimer(timer);
    timer = undefined;
    const idleMs = env.now() - lastInput;
    const next = resolveMotion({ visible: nativeVisible && !env.isHidden(), focused: focused(), idleMs, calmWhenIdle: env.calmWhenIdle() });
    setMotionLevel(next);
    if (env.root) env.root.dataset.motion = next;
    // Full and calm-capable: wake up when the idle window could run out.
    if (next === "full" && env.calmWhenIdle()) timer = env.setTimer(recompute, Math.max(250, IDLE_MS - idleMs + 50));
  };

  const touch = () => {
    lastInput = env.now();
    if (level !== "full") recompute();
  };
  for (const ev of INPUT_EVENTS) offs.push(env.onWin(ev, touch));

  // Back on screen or back in focus counts as activity: the user is looking.
  offs.push(env.onDoc("visibilitychange", () => {
    if (!env.isHidden()) lastInput = env.now();
    recompute();
  }));
  // blur also fires when focus moves into an iframe (TradingView, Spotify): re-read hasFocus()
  // once the move has settled instead of trusting the event.
  const refocus = () => {
    env.setTimer(() => {
      if (focused()) lastInput = env.now();
      recompute();
    }, 0);
  };
  offs.push(env.onWin("focus", refocus), env.onWin("blur", refocus));
  offs.push(env.onCalmSetting(recompute));
  if (env.onNativeVisibility)
    offs.push(env.onNativeVisibility((v) => {
      nativeVisible = v;
      if (v) lastInput = env.now();
      recompute();
    }));
  if (env.onNativeFocus)
    offs.push(env.onNativeFocus((f) => {
      nativeFocused = f;
      if (f) lastInput = env.now();
      recompute();
    }));

  recompute();
  return () => {
    if (timer !== undefined) env.clearTimer(timer);
    offs.forEach((off) => off());
  };
}

// ── Frame loop ──────────────────────────────────────────────────────────────

export interface FrameLoopDeps {
  raf(cb: (ts: number) => void): number;
  caf(id: number): void;
  level(): MotionLevel;
  subscribe(fn: (l: MotionLevel) => void): Off;
}

const browserFrames = (): FrameLoopDeps => ({
  raf: (cb) => requestAnimationFrame(cb),
  caf: (id) => cancelAnimationFrame(id),
  level: motionLevel,
  subscribe: subscribeMotion,
});

export interface FrameLoop {
  /** Start again after `draw` returned false, or re-read `rate` after a state change. */
  kick(): void;
  stop(): void;
}

/**
 * A requestAnimationFrame loop that follows the motion level.
 *
 * `rate(level)` is the frame rate wanted at `full` / `calm` (0 = paused; never asked for `off`,
 * which always parks). Frames between draws are skipped without drawing, so a 30 fps loop on the
 * 143 Hz desktop panel damages the screen 30 times a second, not 143. A parked loop holds no rAF
 * at all and restarts on a level change or `kick()`. `draw` returns false when it has settled;
 * the loop then parks until `kick()`.
 *
 * Draws land on a shared time grid (`floor(ts / interval)`), so every loop at 30 fps (or 15, 10:
 * divisors of the same grid) draws on the SAME frames. WebView2 redraws the whole frame for any
 * damage (measured: one pulsing dot costs as much GPU as a full-screen animation), so what counts
 * is the number of distinct frames per second, not how many loops run.
 *
 * `draw(ts, frames)`: `frames` is how many display frames went by since the previous draw (1 on the
 * first draw after a start, capped at MAX_FRAME_STEP), so a loop whose motion constants are "per
 * frame" can step that many times and keep the speed it had when it drew every frame.
 */
export const MAX_FRAME_STEP = 12;

export function frameLoop(draw: (ts: number, frames: number) => boolean | void, rate: (l: Exclude<MotionLevel, "off">) => number, deps: FrameLoopDeps = browserFrames()): FrameLoop {
  let id = 0;
  let running = true;
  let stopped = false;
  let slot = NaN;
  let frames = 0;

  const interval = (): number => {
    const l = deps.level();
    if (l === "off") return Infinity;
    const fps = rate(l);
    return fps > 0 ? 1000 / fps : Infinity;
  };

  const tick = (ts: number) => {
    id = 0;
    if (stopped || !running) return;
    const iv = interval();
    if (iv === Infinity) return; // parked until the level changes or kick()
    frames++;
    const s = Math.floor(ts / iv);
    if (s !== slot) {
      slot = s;
      const n = Math.min(frames, MAX_FRAME_STEP);
      frames = 0;
      if (draw(ts, n) === false) {
        running = false;
        return;
      }
    }
    id = deps.raf(tick);
  };

  const wake = () => {
    if (stopped || !running || id || interval() === Infinity) return;
    slot = NaN;
    frames = 0;
    id = deps.raf(tick);
  };
  const unsub = deps.subscribe(wake);
  wake();

  return {
    kick() {
      running = true;
      wake();
    },
    stop() {
      stopped = true;
      if (id) deps.caf(id);
      id = 0;
      unsub();
    },
  };
}

// ── Infinite-animation sweep ────────────────────────────────────────────────

/** The slice of the Web Animations API the sweep uses (document.getAnimations()). */
export interface AnimationLike {
  readonly playState: string;
  readonly effect: { getTiming(): { iterations?: number } } | null;
  pause(): void;
  play(): void;
}

/**
 * Safety net under the CSS pause list (styles/index.css `[data-motion]`): pauses every running
 * animation that repeats forever — a class the list doesn't name, a library's spinner — and plays
 * exactly those again on resume. Finite animations (toasts sliding in, fades) are left alone so
 * nothing freezes half-way in. Anything the CSS list already paused reads "paused" and is skipped.
 */
export function createAnimationSweep(getAnimations: () => AnimationLike[]) {
  const held = new Set<AnimationLike>();
  return {
    pause(): number {
      let n = 0;
      for (const a of getAnimations()) {
        if (a.playState !== "running" || a.effect?.getTiming().iterations !== Infinity) continue;
        a.pause();
        held.add(a);
        n++;
      }
      return n;
    },
    resume(): void {
      for (const a of held) if (a.playState === "paused") a.play();
      held.clear();
    },
    get held(): number {
      return held.size;
    },
  };
}

/** While calm / off, re-sweep this often for infinite animations that started since. */
export const SWEEP_MS = 2_000;

// ── Browser wiring ──────────────────────────────────────────────────────────

/** Install once at startup (main.tsx). Desktop: also follows the Rust window events. */
export function installBrowserMotionWatcher(opts: { calmWhenIdle(): boolean; onCalmSetting(fn: () => void): Off; isTauri: boolean }): Off {
  const nativeSubs: ((visible: boolean) => void)[] = [];
  const focusSubs: ((focused: boolean) => void)[] = [];
  const pending: Promise<Off>[] = [];
  if (opts.isTauri) {
    pending.push(
      import("@tauri-apps/api/event").then(({ listen }) => listen<boolean>("window-visibility", (e) => nativeSubs.forEach((f) => f(e.payload !== false)))),
      import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().onFocusChanged((e) => focusSubs.forEach((f) => f(e.payload)))),
    );
  }
  const on = (t: Document | Window) => (ev: string, fn: () => void) => {
    t.addEventListener(ev, fn, { passive: true });
    return () => t.removeEventListener(ev, fn);
  };
  const dispose = installMotionWatcher({
    now: () => performance.now(),
    isHidden: () => document.hidden,
    hasFocus: () => document.hasFocus(),
    onDoc: on(document),
    onWin: on(window),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    calmWhenIdle: opts.calmWhenIdle,
    onCalmSetting: opts.onCalmSetting,
    root: document.documentElement,
    ...(opts.isTauri
      ? {
          onNativeVisibility: (fn: (v: boolean) => void) => (nativeSubs.push(fn), () => undefined),
          onNativeFocus: (fn: (f: boolean) => void) => (focusSubs.push(fn), () => undefined),
        }
      : {}),
  });
  const sweep = createAnimationSweep(() => (typeof document.getAnimations === "function" ? (document.getAnimations() as unknown as AnimationLike[]) : []));
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  const onLevel = (l: MotionLevel) => {
    if (l === "full") {
      clearInterval(sweepTimer);
      sweepTimer = undefined;
      sweep.resume();
    } else {
      sweep.pause();
      sweepTimer ??= setInterval(() => sweep.pause(), SWEEP_MS);
    }
  };
  const unsubLevel = subscribeMotion(onLevel);
  if (level !== "full") onLevel(level);
  return () => {
    unsubLevel();
    clearInterval(sweepTimer);
    sweep.resume();
    dispose();
    pending.forEach((p) => void p.then((off) => off()).catch(() => undefined));
  };
}
