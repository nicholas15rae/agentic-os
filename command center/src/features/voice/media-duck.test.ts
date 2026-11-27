import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  cmd: vi.fn(),
  tauri: true,
  /** What `media_duck` answers. */
  local: { ducked: 1, spotifyLocal: true } as { ducked: number; spotifyLocal: boolean; timedOut?: boolean } | Error,
  /** What `spotify_duck` (the Web API fallback) answers. */
  webResult: true as boolean,
  /** What `spotify_unduck` answers, in order (true = Rust kept the duck); then false. */
  unduck: [] as boolean[],
  cfg: { enabled: true, reductionPct: 15, restoreMs: 800, onWakeListen: true, webApiFallback: true },
}));

vi.mock("@/lib/platform", () => ({ cmd: h.cmd, isTauri: () => h.tauri }));
vi.mock("@/stores/settings", () => ({
  isDesktopApp: () => h.tauri,
  isAndroidApp: () => false, useSettings: { getState: () => ({ conversation: { mediaDuck: h.cfg }, vad: { maxUtteranceMs: 15_000 } }) } }));

type Duck = typeof import("./media-duck");
let d: Duck;

const calls = (name: string) => h.cmd.mock.calls.filter((c) => c[0] === name).length;
const ducks = () => calls("media_duck");
const unducks = () => calls("media_unduck");
const webDucks = () => calls("spotify_duck");
const webUnducks = () => calls("spotify_unduck");
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
/** A promise and its resolver (a pause / turn / Tony's speech still in flight). */
function later() {
  let done!: () => void;
  const p = new Promise<void>((r) => (done = r));
  return { p, done };
}

beforeEach(async () => {
  vi.useFakeTimers();
  h.unduck = [];
  h.local = { ducked: 1, spotifyLocal: true };
  h.webResult = true;
  h.cmd.mockReset().mockImplementation((name: string) => {
    if (name === "media_duck") return h.local instanceof Error ? Promise.reject(h.local) : Promise.resolve(h.local);
    if (name === "media_unduck") return Promise.resolve(false);
    if (name === "spotify_duck") return Promise.resolve(h.webResult);
    if (name === "spotify_unduck") return Promise.resolve(h.unduck.shift() ?? false);
    return Promise.resolve(undefined);
  });
  h.tauri = true;
  h.cfg = { enabled: true, reductionPct: 15, restoreMs: 800, onWakeListen: true, webApiFallback: true };
  vi.resetModules(); // fresh module state per test
  d = await import("./media-duck");
});

afterEach(() => vi.useRealTimers());

describe("media-duck — trigger and onset", () => {
  it("an explicit trigger ducks BY 15 % with the 120 ms fade, once; a later onset only extends it", async () => {
    d.duckOnTrigger();
    await tick(0);
    expect(h.cmd).toHaveBeenCalledWith("media_duck", { reductionPct: 15, fadeMs: 120 });
    d.duckOnSpeech();
    d.duckOnSpeech(true);
    await tick(0);
    expect(ducks()).toBe(1);
    expect(d.musicPlayingHere()).toBe(true);
  });

  it("follows the reduction setting (clamped to 0–50)", async () => {
    h.cfg.reductionPct = 35;
    d.duckOnSpeech();
    await tick(0);
    expect(h.cmd).toHaveBeenCalledWith("media_duck", { reductionPct: 35, fadeMs: d.FADE_DOWN_MS });
    d.restoreDuck();
    await tick(0);
    h.cfg.reductionPct = 90;
    d.duckOnTrigger();
    await tick(0);
    expect(h.cmd).toHaveBeenLastCalledWith("media_duck", { reductionPct: 50, fadeMs: 120 });
  });

  it("a local Spotify session means the Web API is never called (no 85 % × 85 %)", async () => {
    h.local = { ducked: 1, spotifyLocal: true };
    d.duckOnTrigger();
    await tick(0);
    expect(webDucks()).toBe(0);
    // Local but nothing lowered (muted / multi-process session): still no fallback.
    d.restoreDuck();
    await tick(0);
    h.local = { ducked: 0, spotifyLocal: true };
    d.duckOnTrigger();
    await tick(0);
    expect(webDucks()).toBe(0);
    expect(d.musicPlayingHere()).toBe(true);
  });

  it("no local session + fallback on: one relative Web API duck; restore asks both", async () => {
    h.local = { ducked: 0, spotifyLocal: false };
    d.duckOnTrigger();
    await tick(0);
    expect(h.cmd).toHaveBeenCalledWith("spotify_duck", { reduction: 15 });
    expect(webDucks()).toBe(1);
    expect(d.musicPlayingHere()).toBe(true);
    d.restoreDuck();
    await tick(0);
    expect(h.cmd).toHaveBeenCalledWith("media_unduck", { fadeMs: 320 });
    expect(webUnducks()).toBe(1);
  });

  it("no local session + fallback off: nothing more; music isn't known to play here", async () => {
    h.local = { ducked: 0, spotifyLocal: false };
    h.cfg.webApiFallback = false;
    d.duckOnTrigger();
    await tick(0);
    expect(webDucks()).toBe(0);
    expect(d.musicPlayingHere()).toBe(false);
    d.restoreDuck();
    await tick(0);
    expect(unducks()).toBe(1);
    expect(webUnducks()).toBe(0);
  });

  it("a media_duck that timed out is 'unknown', not 'no local Spotify': no Web API duck on top", async () => {
    // Fix pass: the first call (COM start-up + endpoint scan) can outlive Rust's 1 s wait; its
    // queued fade still lands, so a Web API duck as well would stack to ~72 %.
    h.local = { ducked: 0, spotifyLocal: false, timedOut: true };
    d.duckOnTrigger();
    await tick(0);
    expect(webDucks()).toBe(0);
    // The command hold treats it like a local duck (the long cap), and restore still ramps it up.
    d.settleCommand(new Promise(() => undefined));
    await tick(d.COMMAND_RESTORE_CAP_MS);
    expect(unducks()).toBe(0);
    await tick(d.COMMAND_HOLD_CAP_MS - d.COMMAND_RESTORE_CAP_MS);
    expect(unducks()).toBe(1);
    expect(webUnducks()).toBe(0);
  });

  it("a failing local IPC still falls back (and reports what the Web API said)", async () => {
    h.local = new Error("ipc");
    h.webResult = false;
    d.duckOnSpeech();
    await tick(0);
    expect(webDucks()).toBe(1);
    expect(d.musicPlayingHere()).toBe(false);
  });

  it("does nothing when off, off the desktop app, or on a passive listen without onWakeListen", async () => {
    h.cfg.enabled = false;
    d.duckOnSpeech();
    d.duckOnTrigger();
    h.cfg.enabled = true;
    h.tauri = false;
    d.duckOnSpeech();
    h.tauri = true;
    h.cfg.onWakeListen = false;
    d.duckOnSpeech(true);
    await tick(60_000);
    expect(h.cmd).not.toHaveBeenCalled();
    d.duckOnSpeech(false); // a real (non-passive) listen still ducks
    expect(ducks()).toBe(1);
  });
});

describe("media-duck — restore timing", () => {
  it("a noise line: the restore timer starts once it's known to be noise and uses the 320 ms ramp", async () => {
    d.duckOnSpeech();
    await tick(10_000); // a long utterance: still ducked
    expect(unducks()).toBe(0);
    d.scheduleRestore(); // 'transcribing'
    d.settleNoise(); // the transcript: not for Tony
    await tick(799);
    expect(unducks()).toBe(0);
    await tick(1);
    expect(unducks()).toBe(1);
    expect(h.cmd).toHaveBeenCalledWith("media_unduck", { fadeMs: d.FADE_UP_MS });
  });

  it("follows the restore delay setting", async () => {
    h.cfg.restoreMs = 1500;
    d.duckOnSpeech();
    d.scheduleRestore();
    d.settleNoise();
    await tick(1499);
    expect(unducks()).toBe(0);
    await tick(1);
    expect(unducks()).toBe(1);
  });

  it("talking again before the restore keeps it ducked (no second duck call)", async () => {
    d.duckOnSpeech();
    d.scheduleRestore();
    await tick(500);
    d.duckOnSpeech();
    await tick(5000);
    expect(unducks()).toBe(0);
    expect(ducks()).toBe(1);
    d.scheduleRestore();
    d.settleNoise();
    await tick(800);
    expect(unducks()).toBe(1);
  });

  it("a slow transcript doesn't bring the music back before the command is known (Whisper race)", async () => {
    // Fix pass: 'transcribing' started the 800 ms restore; a 1.2 s Whisper round trip let it
    // fire first, st.call was gone, and settleCommand could no longer hold through Tony's reply.
    d.duckOnTrigger();
    await tick(0);
    d.scheduleRestore(); // 'transcribing'
    await tick(1200); // Whisper still working
    expect(unducks()).toBe(0);
    const speech = later();
    d.settleCommand(Promise.resolve(), () => speech.p); // onFinal: "what's on my calendar tomorrow"
    await tick(4000); // Tony reads his answer
    expect(unducks()).toBe(0);
    expect(ducks()).toBe(1); // and no ramp-up / re-duck pumping
    speech.done();
    await tick(0);
    expect(unducks()).toBe(1);
  });

  it("a transcript that never arrives still restores after the transcribe cap", async () => {
    d.duckOnTrigger();
    await tick(0);
    d.scheduleRestore();
    await tick(d.TRANSCRIBE_WAIT_CAP_MS - 1);
    expect(unducks()).toBe(0);
    await tick(1);
    expect(unducks()).toBe(1);
    // A hung transcript isn't "noise": no anti-pumping cooldown after it.
    d.duckOnSpeech();
    expect(ducks()).toBe(2);
  });

  it("a reflex / error after transcribing still restores at once", async () => {
    d.duckOnSpeech();
    d.scheduleRestore();
    d.restoreDuck(); // onError / a resume reflex
    await tick(0);
    expect(unducks()).toBe(1);
  });

  it("hard ceiling: an aborted listen (no callbacks) can't leave the music ducked", async () => {
    d.duckOnTrigger();
    await tick(15_000 + d.CEILING_PAD_MS - 1);
    expect(unducks()).toBe(0);
    await tick(1);
    expect(unducks()).toBe(1);
  });

  it("restoreDuck (abort / error / hard stop) restores at once, and only once", async () => {
    d.duckOnSpeech();
    d.restoreDuck();
    d.restoreDuck();
    await tick(0);
    expect(unducks()).toBe(1);
    await tick(60_000);
    expect(unducks()).toBe(1);
  });

  it("nothing ducked: no restore calls at all", async () => {
    d.restoreDuck();
    d.restoreDuck({ force: true });
    d.scheduleRestore();
    d.settleNoise();
    d.settleCommand(Promise.resolve());
    d.restoreAfterPause(Promise.resolve());
    await tick(60_000);
    expect(h.cmd).not.toHaveBeenCalled();
  });

  it("still asks Rust to unduck after a duck that reported nothing (it may have landed late)", async () => {
    h.local = { ducked: 0, spotifyLocal: false };
    h.webResult = false;
    d.duckOnSpeech();
    await tick(0); // the fallback PUT may have timed out yet landed: Rust's read-back decides
    d.restoreDuck();
    await tick(0);
    expect(unducks()).toBe(1);
    expect(webUnducks()).toBe(1);
  });
});

describe("media-duck — anti-pumping cooldown", () => {
  it("no re-duck on speech within the cooldown after a no-command restore", async () => {
    d.duckOnSpeech();
    d.settleNoise();
    await tick(800);
    expect(unducks()).toBe(1);
    d.duckOnSpeech(true);
    d.duckOnSpeech(false);
    expect(ducks()).toBe(1);
    await tick(d.COOLDOWN_MS);
    d.duckOnSpeech(true);
    expect(ducks()).toBe(2);
  });

  it("an explicit trigger ignores the cooldown", async () => {
    d.duckOnSpeech();
    d.settleNoise();
    await tick(800);
    d.duckOnTrigger();
    expect(ducks()).toBe(2);
  });

  it("a command restore starts no cooldown", async () => {
    d.duckOnSpeech();
    d.settleCommand(Promise.resolve());
    await tick(0);
    expect(unducks()).toBe(1);
    d.duckOnSpeech();
    expect(ducks()).toBe(2);
  });

  it("inCooldown is a plain time window", () => {
    expect(d.inCooldown(1000, 0)).toBe(true);
    expect(d.inCooldown(d.COOLDOWN_MS, 0)).toBe(false);
    expect(d.inCooldown(5, -Infinity)).toBe(false);
  });
});

describe("media-duck — command hold (through Tony's confirmation)", () => {
  it("holds until the turn settles AND Tony is idle, then ramps up with 320 ms", async () => {
    d.duckOnTrigger();
    await tick(0);
    const turn = later();
    const speech = later();
    d.settleCommand(turn.p, () => speech.p);
    await tick(1000);
    expect(unducks()).toBe(0);
    turn.done();
    await tick(4000); // the turn is done but Tony is still reading the confirmation back
    expect(unducks()).toBe(0);
    speech.done();
    await tick(0);
    expect(unducks()).toBe(1);
    expect(h.cmd).toHaveBeenLastCalledWith("media_unduck", { fadeMs: 320 });
  });

  it("the 15 s cap restores even if Tony never goes idle", async () => {
    d.duckOnTrigger();
    await tick(0);
    d.settleCommand(Promise.resolve(), () => new Promise(() => undefined));
    await tick(d.COMMAND_HOLD_CAP_MS - 1);
    expect(unducks()).toBe(0);
    await tick(1);
    expect(unducks()).toBe(1);
  });

  it("only the Web API duck active: the cap stays 3 s", async () => {
    h.local = { ducked: 0, spotifyLocal: false };
    d.duckOnTrigger();
    await tick(0);
    d.settleCommand(new Promise(() => undefined));
    await tick(d.COMMAND_RESTORE_CAP_MS - 1);
    expect(unducks()).toBe(0);
    await tick(1);
    expect(unducks()).toBe(1);
    expect(webUnducks()).toBe(1);
  });

  it("a failed turn still restores (once Tony is idle)", async () => {
    d.duckOnTrigger();
    d.settleCommand(Promise.reject(new Error("offline")));
    await tick(0);
    expect(unducks()).toBe(1);
  });

  it("talking again during a deferred command restore keeps the music ducked", async () => {
    d.duckOnSpeech();
    const turn = later();
    d.settleCommand(turn.p);
    d.duckOnSpeech(); // barge-in over Tony's reply
    turn.done();
    await tick(d.COMMAND_HOLD_CAP_MS);
    expect(unducks()).toBe(0);
    d.scheduleRestore();
    d.settleNoise();
    await tick(800);
    expect(unducks()).toBe(1);
    expect(ducks()).toBe(1);
  });

  it("restoreDuck leaves a deferred command restore alone; force (stand-down) restores now", async () => {
    d.duckOnTrigger();
    d.settleCommand(new Promise(() => undefined), () => new Promise(() => undefined));
    d.restoreDuck();
    await tick(0);
    expect(unducks()).toBe(0);
    d.restoreDuck({ force: true });
    await tick(0);
    expect(unducks()).toBe(1);
    await tick(60_000);
    expect(unducks()).toBe(1);
  });
});

describe("media-duck — cut / hold", () => {
  it("cut and hold: restore only after the pause lands; plain restores wait for it", async () => {
    d.duckOnSpeech();
    const pause = later();
    d.restoreAfterPause(pause.p);
    expect(d.musicPlayingHere()).toBe(false);
    d.restoreDuck(); // hardStopMic right after the cut
    await tick(d.PAUSE_WAIT_CAP_MS - 1); // nothing, not even the ceiling, restores before the pause
    expect(unducks()).toBe(0);
    pause.done();
    await tick(0);
    expect(unducks()).toBe(1);
  });

  it("a pause that never settles still restores after the cap", async () => {
    d.duckOnSpeech();
    d.restoreAfterPause(new Promise(() => undefined));
    await tick(d.PAUSE_WAIT_CAP_MS - 1);
    expect(unducks()).toBe(0);
    await tick(1);
    expect(unducks()).toBe(1);
  });

  it("a failed pause still restores", async () => {
    d.duckOnSpeech();
    d.restoreAfterPause(Promise.reject(new Error("offline")));
    await tick(0);
    expect(unducks()).toBe(1);
  });
});

describe("media-duck — review fixes", () => {
  it("a Web API restore Rust couldn't land (it kept the duck) is retried, then given up", async () => {
    h.local = { ducked: 0, spotifyLocal: false };
    h.unduck = [true, true, true];
    d.duckOnSpeech();
    await tick(0);
    d.restoreDuck();
    await tick(0);
    expect(webUnducks()).toBe(1);
    await tick(d.UNDUCK_RETRY_MS[0]);
    expect(webUnducks()).toBe(2);
    await tick(d.UNDUCK_RETRY_MS[1]);
    expect(webUnducks()).toBe(3);
    await tick(60_000);
    expect(webUnducks()).toBe(3);
    expect(unducks()).toBe(1); // the local ramp-up is asked once
  });

  it("a new duck during the retry wait owns the snapshot: no stray restore", async () => {
    h.local = { ducked: 0, spotifyLocal: false };
    h.unduck = [true];
    d.duckOnSpeech();
    await tick(0);
    d.restoreDuck();
    await tick(0);
    d.duckOnSpeech(); // talking again
    await tick(d.UNDUCK_RETRY_MS[0]);
    expect(webUnducks()).toBe(1);
    expect(ducks()).toBe(2);
  });

  it("a restore while the duck call is in flight never starts the Web API duck afterwards", async () => {
    h.local = { ducked: 0, spotifyLocal: false };
    let answer!: (r: { ducked: number; spotifyLocal: boolean }) => void;
    h.cmd.mockImplementation((name: string) => (name === "media_duck" ? new Promise((r) => (answer = r)) : Promise.resolve(false)));
    d.duckOnTrigger();
    d.restoreDuck();
    answer({ ducked: 0, spotifyLocal: false });
    await tick(0);
    expect(webDucks()).toBe(0);
    expect(unducks()).toBe(1);
  });

  it("passive re-onsets (vocals through speakers) don't extend a noise restore", async () => {
    d.duckOnSpeech(true);
    d.scheduleRestore(); // 'transcribing'
    d.settleNoise(); // no wake word
    await tick(500);
    d.duckOnSpeech(true); // the vocals trip the VAD again
    d.scheduleRestore();
    d.settleNoise();
    await tick(300);
    expect(unducks()).toBe(1); // on the first line's schedule
    expect(ducks()).toBe(1);
  });

  it("a real listen's onset still keeps the music down over a noise restore", async () => {
    d.duckOnSpeech(true);
    d.settleNoise();
    await tick(500);
    d.duckOnSpeech(false); // the user taps / addresses Tony
    await tick(5000);
    expect(unducks()).toBe(0);
  });

  it("turning the duck off forgets whether music plays here", async () => {
    d.duckOnSpeech();
    await tick(0);
    expect(d.musicPlayingHere()).toBe(true);
    h.cfg.enabled = false;
    d.duckOnSpeech();
    expect(d.musicPlayingHere()).toBe(false);
  });

  it("the old import path is a shim of this module", async () => {
    const shim = await import("./spotify-duck");
    expect(shim.duckOnTrigger).toBe(d.duckOnTrigger);
    expect(shim.restoreDuck).toBe(d.restoreDuck);
    expect(shim.settleCommand).toBe(d.settleCommand);
  });
});

describe("media-duck — settings readout", () => {
  it("says what the slider means: BY, and where it plays", () => {
    expect(d.duckReadout(15)).toBe("15% (plays at 85%)");
    expect(d.duckReadout(50)).toBe("50% (plays at 50%)");
    expect(d.duckReadout(90)).toBe("50% (plays at 50%)");
    expect(d.duckReadout(0)).toBe("0% (off in effect)");
  });

  it("0 %: a local check still runs, but the Web API fallback never fires", async () => {
    h.cfg.reductionPct = 0;
    h.local = { ducked: 0, spotifyLocal: false };
    d.duckOnTrigger();
    await tick(0);
    expect(h.cmd).toHaveBeenCalledWith("media_duck", { reductionPct: 0, fadeMs: 120 });
    expect(webDucks()).toBe(0);
  });
});
