import { cmd, isTauri } from "@/lib/platform";
import { useSettings } from "@/stores/settings";

/**
 * Lowering Spotify while you talk to Tony (P4; was `spotify-duck.ts`, which re-exports this).
 *
 * BY `reductionPct` % (default 15, so it plays at 85 %), never TO a level. Primary path: Rust
 * `media_duck` fades the Spotify desktop app's own Windows audio session (WASAPI) down in 120 ms and
 * `media_unduck` ramps it back in 320 ms — local, $0, no rate limit. Fallback: only when no local
 * Spotify session exists (`spotifyLocal: false`) and the setting allows it, ONE Web API volume
 * change (`spotify_duck { reduction }`, no fade), so the two never stack.
 *
 * When: explicit triggers (tap, hotkey, orb, a confirmation listen, a line that passed the wake
 * word) duck at listen start (`duckOnTrigger`); passive hands-free and follow-up listens duck on
 * VAD onset (`duckOnSpeech(true)`, gated by `onWakeListen`). A command holds the duck until its
 * turn settles AND Tony has finished talking (`ttsIdle`), capped at 15 s (3 s when only the Web
 * API duck is active); between the end of speech and the transcript nothing restores (capped at
 * `TRANSCRIBE_WAIT_CAP_MS`); a line that wasn't for Tony restores after `restoreMs`; a cut / hold
 * restores once its pause has landed. A `media_duck` that timed out (`timedOut`) never adds the
 * Web API duck on top.
 *
 * Best effort and silent, like `media-hold.ts`: no card, no error, no log. Rust decides whether to
 * duck at all (kill switch, a local session, the Web API gates) and keeps the snapshots, so a
 * restore here is just "undo it if the level is still ours". Restores are never gated.
 */

/** Fade down / ramp up (ms). Hard-coded (decision D): not settings. */
export const FADE_DOWN_MS = 120;
export const FADE_UP_MS = 320;
/** No re-duck this soon after a restore for a line that wasn't a command: music vocals can trip
 * the VAD through speakers (duck → noise → restore → duck …). */
export const COOLDOWN_MS = 4000;
/** Past the utterance cap: `stt.abort()` fires no callbacks, so this bounds a duck nobody ends. */
export const CEILING_PAD_MS = 3000;
/** A command restores once its turn settles and Tony is quiet, or after this (local duck). */
export const COMMAND_HOLD_CAP_MS = 15_000;
/** …or after this when only the Web API duck is active: long enough for a Spotify volume line to
 * finish first (Rust `h_volume` then consumes the duck instead of racing the restore). */
export const COMMAND_RESTORE_CAP_MS = 3000;
/** Utterance end ('transcribing') to the decision (command / noise / reflex): the duck holds,
 * because the restore can't know yet whether the line was for Tony. Only a transcript that never
 * arrives (a hung STT call) restores after this. */
export const TRANSCRIBE_WAIT_CAP_MS = 15_000;
/** A cut / hold's pause that never settles (a hung IPC) still restores after this. */
export const PAUSE_WAIT_CAP_MS = 10_000;
/** Rust keeps a Web API duck whose restore failed (429, network, timeout) and says so: retried after these. */
export const UNDUCK_RETRY_MS = [1500, 4000];
/** Ceiling base when the utterance cap is off (`Infinity`). */
const UNCAPPED_UTTERANCE_MS = 60_000;

type Timer = ReturnType<typeof setTimeout>;

const st = {
  /** The duck call (in flight or settled); null = nothing to restore. */
  call: null as Promise<boolean> | null,
  /** Bumped by every new duck call: a call only reports into `st` while it's still the live one. */
  callId: 0,
  /** Bumped by every restore decision, so a superseded deferred restore stays quiet. */
  gen: 0,
  /** A cut / hold / command restore is waiting for its pause or turn; plain restores leave it be. */
  deferred: false,
  /** A restore for a line that wasn't for Tony is counting down: a passive re-onset can't extend it. */
  noise: false,
  /** Spotify is playing on this PC (a local session, or the Web API said so) and nothing paused it since. */
  playingHere: false,
  /** The current duck lowered a local session (the command hold may run to the long cap). */
  local: false,
  /** The current duck tried the Web API fallback (its restore must be asked for). */
  webTried: false,
  restoreTimer: undefined as Timer | undefined,
  ceiling: undefined as Timer | undefined,
  /** When the last no-command restore ran (anti-pumping cooldown). */
  noopAt: -Infinity,
};

const cfg = () => useSettings.getState().conversation.mediaDuck;

function clearTimers() {
  clearTimeout(st.restoreTimer);
  clearTimeout(st.ceiling);
  st.restoreTimer = st.ceiling = undefined;
}

function armCeiling() {
  clearTimeout(st.ceiling);
  const cap = useSettings.getState().vad.maxUtteranceMs;
  st.ceiling = setTimeout(() => void restore(), (Number.isFinite(cap) && cap > 0 ? cap : UNCAPPED_UTTERANCE_MS) + CEILING_PAD_MS);
}

/** Pure: the anti-pumping rule. */
export function inCooldown(now: number, noopAt: number): boolean {
  return now - noopAt < COOLDOWN_MS;
}

/** Pure: the Settings slider readout, "15% (plays at 85%)". */
export function duckReadout(reductionPct: number): string {
  const r = Math.max(0, Math.min(50, Math.round(reductionPct)));
  return r === 0 ? "0% (off in effect)" : `${r}% (plays at ${100 - r}%)`;
}

/** Spotify is (as far as the last duck knew) playing on this PC: "oh" / "eh" may be lyrics. */
export function musicPlayingHere(): boolean {
  return st.playingHere;
}

/** Tony's speech has finished (or was cancelled). The voice controller passes its own; default: already idle. */
type IdleWait = () => Promise<void>;
const alreadyIdle: IdleWait = () => Promise.resolve();

/** The listen was opened on purpose (tap, hotkey, orb, a confirmation listen, a line that passed
 * the wake word): duck now, before any speech. Ignores the anti-pumping cooldown. */
export function duckOnTrigger(): void {
  duck(false, true);
}

/** VAD speech onset. `passive`: a hands-free wake listen or a follow-up listen (ducks only with `onWakeListen`). */
export function duckOnSpeech(passive = false): void {
  duck(passive, false);
}

function duck(passive: boolean, trigger: boolean): void {
  const c = cfg();
  if (!c?.enabled || !isTauri()) {
    st.playingHere = false; // nothing here checks any more: don't keep an old answer
    return;
  }
  if (passive && !c.onWakeListen) return;
  if (st.call) {
    // Music vocals through speakers keep tripping a passive listen's VAD: they must not keep a
    // duck that's already on its way back down for good.
    if (passive && st.noise) return;
    // Talking again before the restore: stay ducked (one call per duck), take over any deferred restore.
    clearTimers();
    st.gen++;
    st.deferred = false;
    st.noise = false;
    armCeiling();
    return;
  }
  if (!trigger && inCooldown(Date.now(), st.noopAt)) return;
  const reduction = Math.max(0, Math.min(50, Math.round(c.reductionPct ?? 15)));
  const fallback = c.webApiFallback !== false && reduction > 0;
  st.local = false;
  st.webTried = false;
  const id = ++st.callId;
  // Still the live duck (not restored, not replaced by a newer one).
  const live = () => st.call !== null && st.callId === id;
  st.call = (async () => {
    const r = await cmd("media_duck", { reductionPct: reduction, fadeMs: FADE_DOWN_MS }).catch(() => null);
    const local = !!r?.spotifyLocal;
    // Rust's worker didn't answer in time (first call: COM start-up): its fade may still land, so
    // "no local Spotify" is unknown — no Web API duck on top (never 85 % × 85 %), and the command
    // hold may run to the long cap like a local duck. The restore always asks media_unduck.
    const unknown = !!r?.timedOut;
    if (live()) st.local = unknown || (r?.ducked ?? 0) > 0;
    let web = false;
    // Only when no local Spotify session is known not to exist: never 85 % × 85 %.
    if (!local && !unknown && fallback && live()) {
      st.webTried = true;
      web = await cmd("spotify_duck", { reduction }).catch(() => false);
    }
    const here = local || web;
    if (live()) st.playingHere = here;
    return here;
  })();
  armCeiling();
}

/**
 * The utterance ended (`transcribing`): hold the duck until the transcript decides — a command
 * (`settleCommand`: through Tony's reply), noise (`settleNoise`: `restoreMs`), a reflex — capped
 * at `TRANSCRIBE_WAIT_CAP_MS` for a transcript that never arrives. (It used to start the
 * `restoreMs` timer here, which raced Whisper: an 800 ms restore fired before a 1.2 s transcript
 * and the music came back up under Tony's answer.) `noop`: that decision was "noise".
 */
export function scheduleRestore(noop = false): void {
  if (!st.call || st.deferred || st.noise) return;
  clearTimers();
  st.noise = noop;
  st.restoreTimer = setTimeout(() => void restore(noop), noop ? Math.max(0, cfg()?.restoreMs ?? 800) : TRANSCRIBE_WAIT_CAP_MS);
}

/** A line that wasn't for Tony (silence, noise, room talk without the wake word): restore on the
 * normal delay, then hold off re-ducking for a moment. */
export function settleNoise(): void {
  scheduleRestore(true);
}

/** A command was handed off: restore once its turn settles AND Tony is quiet (`ttsIdle`), capped. */
export function settleCommand(turn: Promise<unknown>, ttsIdle: IdleWait = alreadyIdle): void {
  const done = turn.catch(() => undefined).then(() => ttsIdle().catch(() => undefined));
  // The cap starts now: 3 s, extended to 15 s once it's known a local session was lowered (a
  // hung duck call never extends it).
  const cap = new Promise<void>((r) => setTimeout(r, COMMAND_RESTORE_CAP_MS)).then(() =>
    st.local ? new Promise<void>((r) => setTimeout(r, COMMAND_HOLD_CAP_MS - COMMAND_RESTORE_CAP_MS)) : undefined,
  );
  restoreAfter(done, cap);
}

/** Cut / hold: restore once the pause has landed, so a later resume isn't stuck at the duck level. */
export function restoreAfterPause(paused: Promise<unknown>): void {
  st.playingHere = false;
  restoreAfter(paused.catch(() => undefined), new Promise<void>((r) => setTimeout(r, PAUSE_WAIT_CAP_MS)));
}

/** Restore when `p` settles or `cap` fires, whichever comes first. */
function restoreAfter(p: Promise<unknown>, cap: Promise<unknown>): void {
  if (!st.call) return;
  clearTimers();
  st.deferred = true;
  st.noise = false;
  const gen = ++st.gen;
  void Promise.race([p, cap]).then(() => {
    if (gen === st.gen) return restore();
  });
}

/** Unduck now (abort / error / hard stop / hands-free off). Idempotent; a deferred cut / hold /
 * command restore keeps its own timing unless `force` (a stand-down releases everything now). */
export function restoreDuck(opts: { force?: boolean } = {}): void {
  if (st.call && (!st.deferred || opts.force)) void restore();
}

async function restore(noop = false): Promise<void> {
  const call = st.call;
  clearTimers();
  st.gen++;
  st.call = null;
  st.deferred = false;
  st.noise = false;
  if (!call) return;
  await call; // wait out a duck still in flight
  if (noop) st.noopAt = Date.now();
  // A new duck began meanwhile: it owns the snapshots now (and restores them itself).
  if (st.call) return;
  const webTried = st.webTried;
  // Always asked, even after "nothing ducked": a duck that timed out may still have landed, and
  // Rust's read-back decides. A no-op in Rust when nothing is ducked.
  void cmd("media_unduck", { fadeMs: FADE_UP_MS }).catch(() => false);
  if (!webTried) return;
  // `true` = the Web API restore didn't land (Rust kept the duck): try again a little later,
  // unless a new duck has taken over.
  for (let i = 0; ; i++) {
    const pending = await cmd("spotify_unduck").catch(() => false);
    if (!pending || i >= UNDUCK_RETRY_MS.length) return;
    await new Promise((r) => setTimeout(r, UNDUCK_RETRY_MS[i]));
    if (st.call) return;
  }
}
