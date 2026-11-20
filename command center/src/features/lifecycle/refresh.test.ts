import { describe, expect, it, vi } from "vitest";
import { audioBusy, busyProbes, hardRefresh, registerBusyProbe, softRefresh, type AudioSnapshot, type RefreshDeps } from "./refresh";

function deps(audio: () => AudioSnapshot): RefreshDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    resync: vi.fn(async () => void calls.push("resync")),
    reloadConfig: vi.fn(async () => void calls.push("config")),
    remount: vi.fn(() => void calls.push("remount")),
    reload: vi.fn(() => void calls.push("reload")),
    audio,
    sleep: vi.fn(async () => undefined),
  };
}

const quiet: AudioSnapshot = { voiceState: "idle", cueRunning: false };

describe("refresh", () => {
  it("audioBusy: speaking / listening / holding or a running cue are busy", () => {
    expect(audioBusy(quiet)).toBe(false);
    expect(audioBusy({ voiceState: "error", cueRunning: false })).toBe(false);
    expect(audioBusy({ voiceState: "speaking", cueRunning: false })).toBe(true);
    expect(audioBusy({ voiceState: "holding", cueRunning: false })).toBe(true);
    expect(audioBusy({ voiceState: "idle", cueRunning: true })).toBe(true);
  });

  it("soft refresh re-syncs then re-mounts, and never reloads the webview", async () => {
    const d = deps(() => ({ voiceState: "speaking", cueRunning: true }));
    await softRefresh(d);
    expect(d.calls).toEqual(["resync", "config", "remount"]);
    expect(d.reload).not.toHaveBeenCalled();
  });

  it("soft refresh still re-mounts when the gateway is down", async () => {
    const d = deps(() => quiet);
    d.resync = vi.fn(async () => Promise.reject(new Error("Gateway unreachable")));
    await softRefresh(d);
    expect(d.remount).toHaveBeenCalledOnce();
  });

  it("hard refresh reloads at once when audio is idle", async () => {
    const d = deps(() => quiet);
    expect(await hardRefresh(d)).toBe("reloaded");
    expect(d.reload).toHaveBeenCalledOnce();
  });

  it("hard refresh waits for Tony to finish speaking, then reloads", async () => {
    let n = 0;
    const d = deps(() => (n++ < 3 ? { voiceState: "speaking", cueRunning: false } : quiet));
    expect(await hardRefresh(d, 10_000)).toBe("reloaded");
    expect(d.sleep).toHaveBeenCalledTimes(3);
  });

  it("hard refresh never cuts playing audio: it falls back to a soft refresh", async () => {
    const d = deps(() => ({ voiceState: "idle", cueRunning: true }));
    expect(await hardRefresh(d, 1000)).toBe("soft-fallback");
    expect(d.reload).not.toHaveBeenCalled();
    expect(d.remount).toHaveBeenCalledOnce();
  });
});

describe("review #19 / #11: open mics and playing cues", () => {
  it("soft refresh re-syncs but keeps the view mounted while a mic under <main> is open", async () => {
    const d = deps(() => quiet);
    d.micBusy = () => ["Memory dictation"];
    expect(await softRefresh(d)).toEqual({ remounted: false, keptOpen: ["Memory dictation"] });
    expect(d.resync).toHaveBeenCalledOnce();
    expect(d.remount).not.toHaveBeenCalled();
    d.micBusy = () => [];
    expect(await softRefresh(d)).toEqual({ remounted: true });
  });

  it("hard reload waits for a busy probe (dictation, Brainstorm, a handoff cue) and never cuts it", async () => {
    const d = deps(() => ({ voiceState: "idle", cueRunning: false, busy: ["vocal handoff"] }));
    expect(await hardRefresh(d, 1000)).toBe("soft-fallback");
    expect(d.reload).not.toHaveBeenCalled();
  });

  it("registered probes report by kind, unregister cleanly, and a throwing probe never blocks", () => {
    let on = true;
    const offMic = registerBusyProbe("Memory dictation", "mic", () => on);
    const offAudio = registerBusyProbe("vocal handoff", "audio", () => true);
    const offBad = registerBusyProbe("broken", "audio", () => {
      throw new Error("x");
    });
    expect(busyProbes("mic")).toEqual(["Memory dictation"]);
    expect(busyProbes().sort()).toEqual(["Memory dictation", "vocal handoff"]);
    on = false;
    expect(busyProbes("mic")).toEqual([]);
    offMic();
    offAudio();
    offBad();
    expect(busyProbes()).toEqual([]);
  });
});
