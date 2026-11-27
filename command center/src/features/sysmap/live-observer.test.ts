import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DriftMonitor, errorLabel, formatError, formatStall, MergingLimiter, startLiveObserver, syncLiveObserver, liveObserverRunning, type ObserverEnv } from "./live-observer";

describe("DriftMonitor", () => {
  it("reports only ticks that arrive more than 250 ms late, and re-bases", () => {
    const d = new DriftMonitor(0);
    expect(d.tick(250)).toBeNull();
    expect(d.tick(510)).toBeNull(); // 10 ms jitter
    expect(d.tick(760 + 251)).toBe(251);
    expect(d.tick(1011 + 250)).toBeNull(); // re-based on the late tick
  });
});

describe("MergingLimiter", () => {
  it("emits at most once per 2 s and merges what came in between", () => {
    const l = new MergingLimiter(formatStall);
    expect(l.offer(0, 400)).toEqual({ ms: 400, detail: null });
    expect(l.offer(500, 300)).toBeNull();
    expect(l.offer(900, 900)).toBeNull();
    expect(l.flush(1_999)).toBeNull();
    expect(l.flush(2_000)).toEqual({ ms: 900, detail: "merged 2 stalls, total 1200ms" });
    expect(l.flush(5_000)).toBeNull();
    expect(l.hasPending).toBe(false);
  });
  it("keeps the first error label and counts the rest", () => {
    const l = new MergingLimiter(formatError);
    expect(l.offer(0, 0, "TypeError: a")).toEqual({ ms: 0, detail: "TypeError: a" });
    l.offer(10, 0, "RangeError: b");
    l.offer(20, 0, "Error: c");
    expect(l.flush(2_100)).toEqual({ ms: 0, detail: "RangeError: b (+1 more)" });
  });
});

describe("errorLabel", () => {
  it("is name + first 120 chars of the message, one line, never the stack", () => {
    const e = new TypeError(`x is undefined\n${"y".repeat(300)}`);
    const l = errorLabel(e);
    expect(l.startsWith("TypeError: x is undefined y")).toBe(true);
    expect(l.length).toBe("TypeError: ".length + 120);
    expect(l).not.toContain("\n");
    expect(l).not.toContain("at ");
  });
  it("handles strings, error-like objects and anything else", () => {
    expect(errorLabel("boom")).toBe("Error: boom");
    expect(errorLabel({ name: "AbortError", message: "aborted" })).toBe("AbortError: aborted");
    expect(errorLabel({ secret: "nope" })).toBe("NonError: object");
    expect(errorLabel(null)).toBe("NonError: null");
    expect(errorLabel(undefined)).toBe("NonError: undefined");
  });
});

describe("startLiveObserver (fake timers)", () => {
  let target: EventTarget;
  let report: ReturnType<typeof vi.fn<ObserverEnv["report"]>>;
  let visible: boolean;
  const env = (): ObserverEnv => ({
    now: () => Date.now(),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    addEventListener: (t, fn) => target.addEventListener(t, fn),
    removeEventListener: (t, fn) => target.removeEventListener(t, fn),
    report,
    visible: () => visible,
  });
  /** Block the "main thread" for `ms`: the clock jumps, the pending tick fires late. */
  const block = (ms: number) => {
    vi.setSystemTime(Date.now() + ms);
    vi.advanceTimersToNextTimer();
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    target = new EventTarget();
    report = vi.fn<ObserverEnv["report"]>();
    visible = true;
  });
  afterEach(() => {
    syncLiveObserver(false);
    vi.useRealTimers();
  });

  it("is silent while the thread keeps up", () => {
    const stop = startLiveObserver(env());
    vi.advanceTimersByTime(10_000);
    expect(report).not.toHaveBeenCalled();
    stop();
  });

  it("reports a stall with its lag, rate-limited and merged", () => {
    const stop = startLiveObserver(env());
    vi.advanceTimersByTime(250);
    block(800);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]).toEqual(["ui_stall", 800, null]);
    block(400);
    block(600);
    expect(report).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2_000);
    expect(report).toHaveBeenCalledTimes(2);
    expect(report.mock.calls[1]).toEqual(["ui_stall", 600, "merged 2 stalls, total 1000ms"]);
    stop();
  });

  it("ignores lateness while the window is hidden (throttled timers)", () => {
    const stop = startLiveObserver(env());
    visible = false;
    block(1_500);
    expect(report).not.toHaveBeenCalled();
    stop();
  });

  it("does not report the first late tick after the window is restored, but still reports real stalls", () => {
    const stop = startLiveObserver(env());
    vi.advanceTimersByTime(250);
    visible = false;
    block(1_500);
    visible = true;
    block(600); // first visible tick: still late from throttling -> re-based, not a stall
    expect(report).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000); // back to normal ticks
    expect(report).not.toHaveBeenCalled();
    block(700); // a genuine stall afterwards is reported
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]).toEqual(["ui_stall", 700, null]);
    stop();
  });

  it("a hide shorter than one tick (no hidden tick at all) is caught by the visibility event", () => {
    let fire: (() => void) | null = null;
    const off = vi.fn();
    const stop = startLiveObserver({ ...env(), onVisibilityChange: (fn) => ((fire = fn), off) });
    vi.advanceTimersByTime(250);
    fire!(); // hidden…
    fire!(); // …and visible again before any tick ran
    block(600); // throttled late tick right after the restore
    expect(report).not.toHaveBeenCalled();
    block(700); // a genuine stall afterwards is still reported
    expect(report.mock.calls[0]).toEqual(["ui_stall", 700, null]);
    stop();
    expect(off).toHaveBeenCalledTimes(1);
  });

  it("reports window errors and rejections as short labels", () => {
    const stop = startLiveObserver(env());
    const err = Object.assign(new Event("error"), { error: new RangeError("bad index"), message: "bad index" });
    target.dispatchEvent(err);
    expect(report).toHaveBeenLastCalledWith("ui_error", 0, "RangeError: bad index");
    target.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: new Error("nope") }));
    expect(report).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2_000);
    expect(report).toHaveBeenLastCalledWith("ui_error", 0, "Unhandled Error: nope");
    stop();
  });

  it("tears everything down: no interval, no listeners", () => {
    const stop = startLiveObserver(env());
    stop();
    expect(vi.getTimerCount()).toBe(0);
    target.dispatchEvent(Object.assign(new Event("error"), { error: new Error("late") }));
    block(5_000);
    expect(report).not.toHaveBeenCalled();
  });

  it("syncLiveObserver is idempotent and fully stops on off", () => {
    syncLiveObserver(true, env());
    syncLiveObserver(true, env());
    expect(liveObserverRunning()).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    syncLiveObserver(false);
    expect(liveObserverRunning()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    // Outside the desktop (no window) nothing starts.
    syncLiveObserver(true, null);
    expect(liveObserverRunning()).toBe(false);
  });
});
