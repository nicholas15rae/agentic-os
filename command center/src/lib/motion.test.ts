import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAnimationSweep,
  frameLoop,
  IDLE_MS,
  installMotionWatcher,
  MAX_FRAME_STEP,
  motionLevel,
  resolveMotion,
  setMotionLevel,
  subscribeMotion,
  type AnimationLike,
  type FrameLoopDeps,
  type MotionEnv,
  type MotionLevel,
} from "./motion";

beforeEach(() => setMotionLevel("full"));

describe("resolveMotion", () => {
  const base = { visible: true, focused: true, idleMs: 0, calmWhenIdle: true };
  it("is off whenever the window is hidden, whatever else holds", () => {
    expect(resolveMotion({ ...base, visible: false })).toBe("off");
    expect(resolveMotion({ ...base, visible: false, calmWhenIdle: false })).toBe("off");
  });
  it("is calm when unfocused or idle for IDLE_MS", () => {
    expect(resolveMotion({ ...base, focused: false })).toBe("calm");
    expect(resolveMotion({ ...base, idleMs: IDLE_MS })).toBe("calm");
    expect(resolveMotion({ ...base, idleMs: IDLE_MS - 1 })).toBe("full");
  });
  it("never goes calm with the setting off", () => {
    expect(resolveMotion({ ...base, focused: false, idleMs: IDLE_MS * 10, calmWhenIdle: false })).toBe("full");
  });
});

// ── Watcher ─────────────────────────────────────────────────────────────────

function fakeEnv(over: Partial<{ hidden: boolean; focus: boolean; calm: boolean; native: boolean }> = {}) {
  const st = { hidden: false, focus: true, calm: true, ...over };
  const doc = new Map<string, Set<() => void>>();
  const win = new Map<string, Set<() => void>>();
  const calmSubs = new Set<() => void>();
  const nativeVis = new Set<(v: boolean) => void>();
  const nativeFocus = new Set<(f: boolean) => void>();
  const add = (m: Map<string, Set<() => void>>) => (ev: string, fn: () => void) => {
    if (!m.has(ev)) m.set(ev, new Set());
    m.get(ev)!.add(fn);
    return () => m.get(ev)!.delete(fn);
  };
  const root = { dataset: {} as Record<string, string | undefined> };
  const env: MotionEnv = {
    now: () => Date.now(),
    isHidden: () => st.hidden,
    hasFocus: () => st.focus,
    onDoc: add(doc),
    onWin: add(win),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    calmWhenIdle: () => st.calm,
    onCalmSetting: (fn) => (calmSubs.add(fn), () => calmSubs.delete(fn)),
    root,
    ...(over.native
      ? {
          onNativeVisibility: (fn: (v: boolean) => void) => (nativeVis.add(fn), () => nativeVis.delete(fn)),
          onNativeFocus: (fn: (f: boolean) => void) => (nativeFocus.add(fn), () => nativeFocus.delete(fn)),
        }
      : {}),
  };
  const fire = (m: Map<string, Set<() => void>>, ev: string) => [...(m.get(ev) ?? [])].forEach((f) => f());
  return {
    env,
    st,
    root,
    doc: (ev: string) => fire(doc, ev),
    win: (ev: string) => fire(win, ev),
    calmChanged: () => calmSubs.forEach((f) => f()),
    nativeVisible: (v: boolean) => nativeVis.forEach((f) => f(v)),
    nativeFocused: (f: boolean) => nativeFocus.forEach((g) => g(f)),
    listeners: () => [...doc.values(), ...win.values()].reduce((n, s) => n + s.size, 0),
  };
}

describe("installMotionWatcher", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("goes off when the document hides and full again when it shows, mirroring <html data-motion>", () => {
    const f = fakeEnv();
    const off = installMotionWatcher(f.env);
    expect(motionLevel()).toBe("full");
    expect(f.root.dataset.motion).toBe("full");
    f.st.hidden = true;
    f.doc("visibilitychange");
    expect(motionLevel()).toBe("off");
    expect(f.root.dataset.motion).toBe("off");
    f.st.hidden = false;
    f.doc("visibilitychange");
    expect(motionLevel()).toBe("full");
    off();
  });

  it("goes calm on blur once focus has really left, not when it moved into an iframe", () => {
    const f = fakeEnv();
    const off = installMotionWatcher(f.env);
    // Focus moved into a TradingView iframe: blur fires but the document still has focus.
    f.win("blur");
    vi.advanceTimersByTime(0);
    expect(motionLevel()).toBe("full");
    // Another app took focus.
    f.st.focus = false;
    f.win("blur");
    vi.advanceTimersByTime(0);
    expect(motionLevel()).toBe("calm");
    f.st.focus = true;
    f.win("focus");
    vi.advanceTimersByTime(0);
    expect(motionLevel()).toBe("full");
    off();
  });

  it("goes calm after IDLE_MS without input and back to full on the next input", () => {
    const f = fakeEnv();
    const off = installMotionWatcher(f.env);
    vi.advanceTimersByTime(IDLE_MS - 5_000);
    f.win("pointermove"); // resets the idle window
    vi.advanceTimersByTime(IDLE_MS - 1_000);
    expect(motionLevel()).toBe("full");
    vi.advanceTimersByTime(2_000);
    expect(motionLevel()).toBe("calm");
    expect(f.root.dataset.motion).toBe("calm");
    f.win("keydown");
    expect(motionLevel()).toBe("full");
    off();
  });

  it("never goes calm with the setting off, and re-evaluates when it is switched", () => {
    const f = fakeEnv({ calm: false, focus: false });
    const off = installMotionWatcher(f.env);
    vi.advanceTimersByTime(IDLE_MS * 3);
    expect(motionLevel()).toBe("full");
    f.st.calm = true;
    f.calmChanged();
    expect(motionLevel()).toBe("calm");
    off();
  });

  it("follows the desktop shell's window-visibility event even when document.hidden lags", () => {
    const f = fakeEnv({ native: true });
    const off = installMotionWatcher(f.env);
    f.nativeVisible(false);
    expect(motionLevel()).toBe("off");
    f.nativeVisible(true);
    expect(motionLevel()).toBe("full");
    // Native focus wins over document.hasFocus().
    f.nativeFocused(false);
    expect(motionLevel()).toBe("calm");
    f.nativeFocused(true);
    expect(motionLevel()).toBe("full");
    off();
  });

  it("removes every listener and the idle timer on dispose", () => {
    const f = fakeEnv();
    const off = installMotionWatcher(f.env);
    expect(f.listeners()).toBeGreaterThan(0);
    off();
    expect(f.listeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ── Frame loop ──────────────────────────────────────────────────────────────

/** A 143 Hz display: rAF callbacks fire every 1000/143 ms when `step()` runs. */
function fakeDisplay(hz = 143) {
  let pending = new Map<number, (ts: number) => void>();
  let nextId = 1;
  let ts = 1_000;
  let lvl: MotionLevel = "full";
  const subs = new Set<(l: MotionLevel) => void>();
  const deps: FrameLoopDeps = {
    raf: (cb) => {
      const id = nextId++;
      pending.set(id, cb);
      return id;
    },
    caf: (id) => void pending.delete(id),
    level: () => lvl,
    subscribe: (fn) => (subs.add(fn), () => subs.delete(fn)),
  };
  return {
    deps,
    pending: () => pending.size,
    /** Run `n` display frames. */
    step(n: number) {
      for (let i = 0; i < n; i++) {
        ts += 1000 / hz;
        const due = pending;
        pending = new Map();
        due.forEach((cb) => cb(ts));
      }
    },
    setLevel(l: MotionLevel) {
      lvl = l;
      subs.forEach((f) => f(l));
    },
  };
}

describe("frameLoop", () => {
  it("draws at the requested rate on a 143 Hz display, not once per display frame", () => {
    const d = fakeDisplay();
    let n30 = 0;
    let n60 = 0;
    frameLoop(() => void n30++, () => 30, d.deps);
    frameLoop(() => void n60++, () => 60, d.deps);
    d.step(143); // one second
    expect(n30).toBeGreaterThanOrEqual(29);
    expect(n30).toBeLessThanOrEqual(31);
    expect(n60).toBeGreaterThanOrEqual(59);
    expect(n60).toBeLessThanOrEqual(61);
  });

  it("puts loops of the same rate on the same frames", () => {
    const d = fakeDisplay();
    const a: number[] = [];
    const b: number[] = [];
    frameLoop((ts) => void a.push(ts), () => 30, d.deps);
    d.step(7); // start the second loop mid-way
    frameLoop((ts) => void b.push(ts), () => 30, d.deps);
    d.step(143);
    const shared = b.slice(1).filter((t) => a.includes(t)).length;
    expect(shared).toBe(b.length - 1);
  });

  it("reports how many display frames went by since the last draw", () => {
    const d = fakeDisplay();
    const frames: number[] = [];
    frameLoop((_ts, n) => void frames.push(n), () => 30, d.deps);
    d.step(143);
    // First draw after a start counts 1; then ~143 / 30 display frames per draw.
    expect(frames[0]).toBe(1);
    for (const n of frames.slice(1)) expect([4, 5, 6]).toContain(n);
    // Every display frame up to the last draw is accounted for (the few after it carry over).
    const total = frames.reduce((s, n) => s + n, 0);
    expect(total).toBeGreaterThan(143 - 6);
    expect(total).toBeLessThanOrEqual(143);
    expect(Math.max(...frames)).toBeLessThanOrEqual(MAX_FRAME_STEP);
  });

  it("holds no rAF while off and resumes when the window shows again", () => {
    const d = fakeDisplay();
    let n = 0;
    frameLoop(() => void n++, () => 30, d.deps);
    d.step(30);
    const before = n;
    d.setLevel("off");
    d.step(1); // the queued frame finds "off" and parks
    expect(d.pending()).toBe(0);
    d.step(300);
    expect(n).toBe(before);
    d.setLevel("full");
    expect(d.pending()).toBe(1);
    d.step(143);
    expect(n - before).toBeGreaterThanOrEqual(29);
  });

  it("uses the calm rate while calm, and parks when that rate is 0", () => {
    const d = fakeDisplay();
    let voice = 0;
    let weather = 0;
    frameLoop(() => void voice++, (l) => (l === "full" ? 30 : 15), d.deps);
    frameLoop(() => void weather++, (l) => (l === "full" ? 30 : 0), d.deps);
    d.setLevel("calm");
    d.step(1);
    voice = 0;
    weather = 0;
    d.step(143);
    expect(voice).toBeGreaterThanOrEqual(14);
    expect(voice).toBeLessThanOrEqual(16);
    expect(weather).toBe(0);
    expect(d.pending()).toBe(1); // only the voice loop is still scheduled
  });

  it("parks after draw returns false until kick()", () => {
    const d = fakeDisplay();
    let n = 0;
    let settle = false;
    const loop = frameLoop(() => {
      n++;
      return !settle;
    }, () => 30, d.deps);
    d.step(20);
    settle = true;
    d.step(20);
    const settledAt = n;
    expect(d.pending()).toBe(0);
    d.step(100);
    expect(n).toBe(settledAt);
    settle = false;
    loop.kick();
    d.step(20);
    expect(n).toBeGreaterThan(settledAt);
  });

  it("stop() cancels the pending frame and ignores later level changes", () => {
    const d = fakeDisplay();
    let n = 0;
    const loop = frameLoop(() => void n++, () => 30, d.deps);
    loop.stop();
    expect(d.pending()).toBe(0);
    d.setLevel("calm");
    d.setLevel("full");
    d.step(143);
    expect(n).toBe(0);
  });
});

// ── Store + sweep ───────────────────────────────────────────────────────────

describe("motion store", () => {
  it("notifies subscribers once per change", () => {
    const seen: MotionLevel[] = [];
    const off = subscribeMotion((l) => seen.push(l));
    setMotionLevel("calm");
    setMotionLevel("calm");
    setMotionLevel("off");
    setMotionLevel("full");
    off();
    setMotionLevel("calm");
    expect(seen).toEqual(["calm", "off", "full"]);
  });
});

describe("createAnimationSweep", () => {
  const anim = (iterations: number, playState = "running") => {
    const a = {
      playState,
      effect: { getTiming: () => ({ iterations }) },
      pause: vi.fn(() => void (a.playState = "paused")),
      play: vi.fn(() => void (a.playState = "running")),
    };
    return a;
  };

  it("pauses running infinite animations only, and plays back exactly those", () => {
    const spinner = anim(Infinity);
    const toast = anim(1); // finite: must finish, never frozen half-way in
    const cssPaused = anim(Infinity, "paused"); // the [data-motion] CSS list already got it
    const all: AnimationLike[] = [spinner, toast, cssPaused];
    const sweep = createAnimationSweep(() => all);
    expect(sweep.pause()).toBe(1);
    expect(spinner.pause).toHaveBeenCalledOnce();
    expect(toast.pause).not.toHaveBeenCalled();
    expect(cssPaused.pause).not.toHaveBeenCalled();
    // A spinner that appears while calm is caught by the next sweep.
    const late = anim(Infinity);
    all.push(late);
    expect(sweep.pause()).toBe(1);
    expect(sweep.held).toBe(2);
    sweep.resume();
    expect(spinner.play).toHaveBeenCalledOnce();
    expect(late.play).toHaveBeenCalledOnce();
    expect(cssPaused.play).not.toHaveBeenCalled();
    expect(sweep.held).toBe(0);
  });
});

describe("Settings → Appearance → Motion", () => {
  const on = { visible: true, focused: true, idleMs: 0, calmWhenIdle: true };
  it("off stops every loop, reduced caps at calm, full changes nothing", () => {
    expect(resolveMotion({ ...on, pref: "off" })).toBe("off");
    expect(resolveMotion({ ...on, pref: "reduced" })).toBe("calm");
    expect(resolveMotion({ ...on, pref: "full" })).toBe("full");
    expect(resolveMotion({ ...on, visible: false, pref: "reduced" })).toBe("off");
  });
});
