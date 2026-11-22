import { SUB_AGENTS, type AgentRole } from "@/features/dispatcher/agents";
import { DEFAULT_ROUTING_CONFIG, isSelfRoleId, resolve } from "@/features/dispatcher/router";
import { execute } from "@/features/orchestrator/execute";
import { heuristicPlan, parseConfirmation, parseOfferReply, planIntent, stripWake, type ActionPlan } from "@/features/orchestrator/plan";
import { classifyTier, commitStrength, DEFER_LABEL, looksBuildShaped, offerTarget, parseDefer, type DeferTarget, type OfferTarget } from "@/features/dialogue/tier";
import { useDialogue } from "@/features/dialogue/dialogue-store";
import { briefOf, buildArtifact, conversationSlice, fallbackTitle, fitBrief, saveArtifact } from "@/features/dialogue/package";
import { roleLabel } from "@/features/dispatcher/roles";
import { dispatch, queueDesktopItem } from "@/features/dispatcher/dispatch";
import { handleLocalIntent } from "@/features/reminders/intents";
import { gated } from "@/features/bridge/gate";
import { liveContext } from "@/features/os/context";
import { cuePlayingNow, parseOsLine, runOsIntent } from "@/features/os/os-intents";
import type { OsIntent } from "@/features/os/os-intent-parse";
import { cueOwnsVolume, parseSpotifyLine, runPendingSpotify, runSpotifyIntent } from "@/features/os/spotify-intents";
import type { SpotifyIntent } from "@/lib/platform";
import { useOs } from "@/features/os/os-store";
import { runPipeline, trackTask } from "@/features/os/pipeline-store";
import { cueFor, fireCue, registerCueIO } from "@/features/cues/cue-runtime";
import { cueRecentlyActive, registerSpeechCancel, setCueDuck, stopAllAudio } from "@/features/cues/player";
import { cc } from "@/lib/cc-api";
import { clientTrace } from "@/features/memmap/client-trace";
import { cmd, isTauri, onNativeEvent, type AgentEvent, type ChatMessage, type OsTurnResult, type RoutingConfig, type TaskSource, type TtsFallbackEvent } from "@/lib/platform";
import { useProviders } from "@/sections/settings/use-providers";
import { useNav } from "@/stores/nav";
import { useSettings } from "@/stores/settings";
import { audioContext, createEngines, type SpeakOpts } from "./engines";
import { nextStreamChunk, utteranceIdFor } from "./tts-text";
import { fallbackNotice } from "./tts-fallback-notice";
import { introLine } from "./handoff";
import { currentPool, loadPool, noteHandoff, pickExchange, playExchange, type CueHandle } from "./handoff-cues";
import { ack, GREETING, maybeFlavour, standDownLine } from "./persona";
import { setSectionSource, tonyThread, useVoice, type Channel, type ThreadId, type VoiceTurn } from "./voice-store";
import { isSelfRelay, isSubAgentThread, relayThreadFor, routeFor, routingNotice, soloHold, type RoutedTurn } from "./route-for";
import { toggleAction, type TurnOrigin } from "./voice-status";
import { wakeCommand } from "./wake-word";
import { isBareCut, listenTakesReflex, parseReflex, type Reflex, type ReflexCtx } from "./reflex-parse";
import { detectRoute, detectedRoute, effectiveRoute } from "./audio-route";
import { hydrateMic, micEnabled, onMicChange, requestMicEnabled, MIC_LOCKED_MSG } from "./mic-gate";
import { syncThresholdFromOs } from "./threshold";
import { cutMedia, holdMedia, releaseMedia, type HeldMedia } from "./media-hold";
import { startNarrator, type NarratorSnapshot } from "./narrator";
import { useModes } from "@/features/modes/modes-store";
import { calmModeError, MODE_NOT_AUTO, MODE_SURFACE_ONLY, tier3Action } from "@/features/modes/modes";
import { duckOnSpeech, duckOnTrigger, musicPlayingHere, restoreAfterPause, restoreDuck, scheduleRestore, settleCommand, settleNoise } from "./spotify-duck";

/**
 * Conversation state machine (voice-first; text uses the same path):
 *
 *   listen → transcribe → plan (+verify)
 *        ├─ read-only → execute → speak reply
 *        └─ mutating  → CONFIRM card + spoken read-back → listen for yes/no
 *                         ├─ yes / tap Approve → execute → speak result
 *                         ├─ no / tap Cancel / Esc → cancelled, nothing sent
 *                         ├─ unclear → re-prompt once, then cancel
 *                         └─ timeout → cancelled (fails closed)
 *
 * Module-level singletons so a session survives navigation.
 */
const { stt, tts } = createEngines();
let confirmTimer: ReturnType<typeof setTimeout> | undefined;

export const voiceCaps = {
  stt: !!stt,
  sttName: stt?.name ?? "typed input",
  get ttsName() {
    return tts.name;
  },
};

const store = () => useVoice.getState();
// Tony's thread follows the visible section (his Agents tab ⇒ "general", else "auto").
setSectionSource(() => useNav.getState().section);

/** One thread's conversation (isolated per Dispatcher tab; default: Tony's). */
const history = (thread: ThreadId = tonyThread()): ChatMessage[] =>
  store()
    .turns.filter((t) => t.thread === thread && (t.who === "user" || t.who === "agent"))
    .slice(-8)
    .map((t) => ({ role: t.who === "user" ? "user" : "assistant", content: t.text }));

/** Says can overlap (osRun's routing notice + streamed chunks), so the cue duck is held while
 * any is in flight. Replaced on a hard speech stop, so a cancelled say can't release a later one's duck. */
let ttsDuck = { depth: 0 };
function releaseTtsDuck() {
  ttsDuck = { depth: 0 };
  setCueDuck("tts", false);
}

/** Callers of `ttsIdle()` waiting for Tony to go quiet. */
let idleWaiters: Array<() => void> = [];

function flushTtsIdle() {
  const w = idleWaiters;
  idleWaiters = [];
  for (const r of w) r();
}

/**
 * Resolves once no say() is in flight (`sayDepth === 0`) — or as soon as speech is cancelled
 * (a cut, a stand-down, a new listen): a cancelled speak() can still be awaiting its synthesis,
 * and the music duck (`settleCommand`) must not wait that out. P4: the duck holds through Tony's
 * confirmation and comes back after it.
 */
export function ttsIdle(): Promise<void> {
  if (sayDepth === 0) return Promise.resolve();
  return new Promise((r) => idleWaiters.push(r));
}

/** Hard speech stop: `tts.cancel()`, and anyone waiting for Tony to go quiet stops waiting. */
function cancelTts() {
  tts.cancel();
  flushTtsIdle();
}

/** Defaults to Tony ("general") when the caller names neither a voice nor an agent —
 * every plain Tony line (confirmations, reminders, cancellations…) outside `osRun`'s
 * per-agent answers; the caller's other opts (`utteranceId`, `cache`, `previousText`)
 * are kept either way. A cue's own explicit `voice` (no `agent`) is left exactly as
 * given: cue clips are never routed through the roster (see `registerCueIO` below).
 * Cue audio ducks under the line unless `noDuck` (a cue intro already ducks its own theme). */
async function say(text: string, opts?: SpeakOpts & { noDuck?: boolean; traceId?: string }) {
  // (Phase 2: no `convo.barged` gate any more — a barge-in only ducks Tony until the reflex
  // decision; a superseded turn is silenced by `micGen`, which `sayLive` checks.)
  if (!tts.supported || !text) return;
  const { noDuck, traceId, ...speakOpts } = opts ?? {};
  const effective: SpeakOpts = speakOpts.voice || speakOpts.agent ? speakOpts : { ...speakOpts, agent: "general" };
  const duck = noDuck ? null : ttsDuck;
  if (duck && duck.depth++ === 0) setCueDuck("tts", true);
  // System Map TTS hop (synthesis + playback of this line); engine name only, never the text.
  const t0 = performance.now();
  let ttsError: string | undefined;
  sayDepth++;
  try {
    await tts.speak(text, effective);
  } catch (e) {
    /* speech is best-effort; the text is on screen */
    ttsError = e instanceof Error ? e.message : String(e);
  } finally {
    sayDepth--;
    if (sayDepth === 0) {
      lastTtsEndAt = Date.now();
      flushTtsIdle();
    }
    if (duck && duck === ttsDuck && --duck.depth === 0) setCueDuck("tts", false);
    clientTrace.tts(traceId, tts.name, performance.now() - t0, !ttsError, ttsError);
  }
}

/**
 * Thought-to-Product Phase 5: start the vocal handoff exchange (Tony → `role` → Tony) for a
 * delegation. Null when "Vocal Handoffs" is off, the mic is locked off, TTS is unavailable or
 * `role` isn't one of Tony's crew. Fire-and-forget: callers dispatch first and never await it.
 * Each beat is checked against this mic generation, so a barge-in / stand-down / hard mic stop
 * (`micGen` moves, `hardStopMic` cancels the line in flight) drops the rest of the exchange. The
 * cue itself never touches the delegated job, but those same reflexes treat the delegated turn
 * like any turn in flight: a new command said over it, "cut it" or a stand-down also cancel it
 * (`cancelStreams`), exactly as before Phase 5. Beats go through `say()`, so they duck cue audio
 * exactly like any Tony line and use each agent's roster voice.
 */
export function startHandoffCue(role: string): CueHandle | null {
  if (!useSettings.getState().routing.vocalHandoffs || !micEnabled() || !tts.supported) return null;
  void loadPool(); // the editable pool, cached after the first read (this cue uses what's loaded)
  const pool = currentPool();
  const beats = pickExchange(pool, role);
  if (!beats) return null;
  const gen = micGen;
  const live = () => gen === micGen && micEnabled();
  return playExchange(
    beats,
    {
      speak: (text, voice) => (live() ? say(text, { agent: voice, cache: true }) : Promise.resolve()),
      prefetch: (text, voice) => tts.prefetch?.(text, { agent: voice, cache: true }),
      isLive: live,
    },
    pool.maxSeconds,
  );
}

/** Does `role`'s roster entry have auto-speak on? Reads whatever `useProviders`
 * last loaded (fetched once at module init, below, and refreshed whenever the
 * Voice settings page is opened) — missing/unloaded roster = no auto-speak,
 * exactly like today. */
function agentAutoSpeak(role: string): boolean {
  return !!useProviders.getState().view?.agentVoices[role === "tony" ? "general" : role]?.autoSpeak;
}

// ── Conversation: barge-in while Tony talks, follow-up listening after ─────
//
// While Tony is speaking a voice reply, the mic listens with a STRICTER trigger
// (echo cancellation removes most of his own voice; the offset covers the rest).
// If you start talking, he stops mid-sentence and your words are transcribed.
// When he finishes, the mic stays open for a few seconds for your follow-up —
// no wake word, no button.
// Phase 2: a barge-in no longer stops him on the spot. Speech onset DUCKS him (one audio
// frame); once Whisper returns, `parseReflex` decides: cut / hold / stand-down / a new command.
// `ducked` = you started talking over this listen and the decision is still pending.
const convo = { barged: false, active: false, ducked: false };
/** say() calls in flight (incl. one paused by a hold) — Tony or an agent has audio queued. */
let sayDepth = 0;
/** When the last say() ended and when Nic's VAD last heard speech (the narrator's 1.5 s quiet gap). */
let lastTtsEndAt = 0;
let lastUserSpeechAt = 0;
/** streamIds of `os_turn`s in flight, so "cut it" can stop them server-side (`os_turn_cancel`). */
const activeStreams = new Set<string>();
/** Rust `agents::TURN_CANCELLED`: the error a cancelled os_turn returns. */
const TURN_CANCELLED = "turn cancelled";
/** Hold mode ("take it easy" over a busy turn / "whoa" / "madone" / "aspetta") — see the reflex section at the end. */
const hold = {
  active: false,
  /** What you've said since the hold began (shown live in the HUD). */
  segments: [] as string[],
  /** What the hold paused (Spotify / the cue theme), so resume only unpauses that. */
  media: null as Promise<HeldMedia> | null,
  deadline: 0,
  timer: undefined as ReturnType<typeof setTimeout> | undefined,
  /** A hold listen is open. */
  listening: false,
};

/** Bumped by every hard stop. A turn captures it at its start and stays silent (no speech,
 * no mic reopen) once it changes, so a cancelled turn's late result never resurfaces. */
let micGen = 0;
/** Bumped by every `startListening`: a line spoken after an await can tell a listen opened meanwhile. */
let listenSeq = 0;
/** The VAD heard speech during the current listen (the mic button then submits instead of cancelling). */
let heardSpeech = false;
let turnOrigin: TurnOrigin = "text";
/** The current listen is hands-free's silent wake-word re-arm, not something the user opened. */
let passiveListen = false;
/** Other mic users (the System Map's note dictation) holding hands-free re-arming off. */
let wakeHolds = 0;
/** The current listen is the short follow-up window after a reply (ducks music only with `onWakeListen`). */
let followUpListen = false;
/** STT errors in a row over a reply; bounds re-arming the barge-in listen after one (P4). */
let sttErrorStreak = 0;
const MAX_BARGE_REARMS = 2;

/** Follow-up listening and barge-in only while hands-free is on, or for a turn the user started by tapping. */
const conversational = () => useSettings.getState().wakeMode || turnOrigin === "tap";

function speechHandlers() {
  return {
    onPartial: (t: string) => store().setPartial(t),
    onPhase: (p: string) => {
      clientTrace.phase(p);
      if (p === "speech") {
        heardSpeech = true;
        lastUserSpeechAt = Date.now();
        cancelNarration();
        setCueDuck("user", true);
        // A barge-in over Tony ducks the music like an explicit listen; the follow-up window after
        // him is gated like a passive one (`onWakeListen`).
        duckOnSpeech(followUpListen);
      }
      if (p === "speech" && convo.active) {
        // Barge-in: you talked over Tony (or over a turn still thinking). Duck, don't stop:
        // the transcript decides (cut / hold / new command) — see onFinal.
        convo.barged = true;
        convo.active = false;
        convo.ducked = true;
        tts.duck?.(true);
      }
      if (p === "transcribing") {
        setCueDuck("user", false);
        scheduleRestore();
        // Over a ducked reply the orb keeps showing him speaking until the decision.
        if (!convo.ducked) store().setState("transcribing");
      }
    },
    onFinal: (t: string) => {
      clientTrace.sttFinal(voiceCaps.sttName, !!t);
      setCueDuck("user", false);
      const overTony = convo.ducked;
      convo.active = false;
      convo.ducked = false;
      followUpListen = false;
      sttErrorStreak = 0;
      store().setPartial("");
      if (t) {
        // Reflexes first (< 15 ms: a pure parse), before wake-word handling and handleInput. Over
        // Tony "take it easy" is a hold; in the follow-up listen after him, a stand-down (P5).
        const r = parseReflex(t, reflexCtx());
        if (r && takeReflex(r, t)) return;
        // A new command said over Tony (or over a turn still thinking): he stops, the old turn's
        // server stream is dropped and it goes quiet (its bubble stays on screen).
        if (overTony || sayDepth > 0) {
          // Over a vocal handoff cue too: a surviving delegated turn would outlive its mic
          // generation and wedge the voice state (review #29, left for Nic to decide).
          cancelStreams();
          supersedeTurn();
        }
        return settleCommand(handleInput(t, { channel: "voice" }), ttsIdle);
      }
      settleNoise();
      convo.barged = false;
      tts.duck?.(false);
      if (sayDepth > 0 || activeStreams.size > 0) {
        // Noise (or a long silence) over a reply / a turn still thinking: un-duck, keep the
        // turn's state, and keep listening for a reflex over the rest of it.
        store().setState(sayDepth > 0 ? "speaking" : "thinking");
        return startBargeIn();
      }
      store().setState(store().pending ? "confirming" : "idle");
      rearmWake();
    },
    onError: (e: string) => {
      clientTrace.sttError(voiceCaps.sttName, e);
      setCueDuck("user", false);
      restoreDuck();
      // P4 fix: an STT error over a ducked reply used to leave Tony at the duck gain for the rest
      // of it, `barged` set (so no follow-up listen after him) and the orb on "error" while he talked.
      if (convo.ducked) tts.duck?.(false);
      convo.active = false;
      convo.ducked = false;
      convo.barged = false;
      followUpListen = false;
      if (sayDepth > 0 || activeStreams.size > 0) {
        // He's still talking (or about to): keep the turn's state and listen for a reflex again,
        // a bounded number of times (a mic that keeps failing must not spin).
        store().setState(sayDepth > 0 ? "speaking" : "thinking");
        if (++sttErrorStreak <= MAX_BARGE_REARMS) startBargeIn();
        return;
      }
      store().setError(e);
      rearmWake();
    },
  };
}

/** Start listening for a barge-in while a voice reply plays. */
function startBargeIn() {
  const c = useSettings.getState().conversation;
  if (!micEnabled() || !c.bargeIn || !stt || convo.active || hold.active || store().pending || !conversational()) return;
  convo.active = true;
  heardSpeech = false;
  passiveListen = false;
  followUpListen = false;
  void detectRoute(); // re-checked each turn; the answer lands for the next decision
  // Shorter end-of-speech pause (default 500 ms) so "cut it" lands fast. Tradeoff: a long new
  // command said over Tony may be split — the follow-up listen catches the rest.
  stt.start(speechHandlers(), {
    maxSilenceStartMs: 120_000,
    barge: true,
    speakers: currentRoute() === "speakers",
    endSilenceMs: c.bargeEndSilenceMs > 0 ? c.bargeEndSilenceMs : undefined,
  });
}

/** Drop a barge-in listen nobody has spoken into yet (a turn ended without speaking). */
function endIdleBargeIn() {
  if (!convo.active || convo.ducked) return;
  convo.active = false;
  stt?.abort();
  setCueDuck("user", false);
  restoreDuck();
}

/** Reply finished: hand over to a short follow-up window (or back to rest). `gen` is the turn's `micGen`. */
function afterVoiceReply(gen: number) {
  if (gen !== micGen) return; // hard-stopped while this turn ran
  sttErrorStreak = 0; // the reply is over: the next one gets its own re-arm budget
  const c = useSettings.getState().conversation;
  if (convo.barged) return; // already capturing what you said over Tony
  if (convo.active) {
    convo.active = false;
    stt?.abort();
  }
  if (c.followUp && stt && micEnabled() && !store().pending && conversational()) {
    store().setState("listening");
    heardSpeech = false;
    passiveListen = false;
    followUpListen = true;
    stt.start(speechHandlers(), { maxSilenceStartMs: c.followUpSecs * 1000 });
  } else store().setState("idle");
}

/** Re-listens inside a turn (confirmation yes/no, "build that") never pop the HUD open on their own. */
const relistenOpts = () => ({ silent: !store().expanded, origin: turnOrigin });

/**
 * Mic off, now: discards the current listen (nothing is transcribed), drops any turn still
 * transcribing/thinking (see `micGen`) and returns to rest. `rearm` (default): hands-free, if
 * still armed, re-arms (a "cut it", the thinking/transcribing hard stop). `rearm: false` (Esc,
 * the HUD close, the mic lock; D8): nothing reopens the mic, and a hold is dropped too.
 */
function hardStopMic(opts: { rearm?: boolean } = {}) {
  const rearm = opts.rearm ?? true;
  if (!rearm && hold.active) {
    releaseHeldMedia();
    clearHold();
    // The hold paused the reply (`tts.pause`); with the hold gone nothing can resume it, so drop
    // it here, or every later say() waits forever in the paused engine (the mic lock path).
    cancelTts();
    releaseTtsDuck();
  }
  micGen++;
  heardSpeech = false;
  passiveListen = false;
  convo.active = false;
  convo.barged = false;
  if (convo.ducked) tts.duck?.(false);
  convo.ducked = false;
  stt?.abort(); // abort() never fires onFinal/onError, so release ducking explicitly here.
  setCueDuck("user", false);
  restoreDuck(); // a cut's own restore (after the pause lands) is deferred and left alone
  store().setPartial("");
  store().setState(store().pending ? "confirming" : "idle");
  if (wake.armed && rearm) rearmWake();
  else clearTimeout(wake.timer);
}

// ── Listening ───────────────────────────────────────────────────────────────

/** `origin` defaults to "tap": every caller that doesn't pass one is an explicit user action.
 * `afterGreeting`: the listen right after the bare-"Hey Tony" greeting ("what's up?") — the answer
 * is for Tony, so it doesn't need the wake word again. */
export function startListening(opts: { forConfirmation?: boolean; silent?: boolean; origin?: TurnOrigin; afterGreeting?: boolean } = {}) {
  const v = store();
  const origin = opts.origin ?? "tap";
  // Phase 2 Part B: locked off = nothing listens. An explicit tap says why; a passive re-arm or a
  // yes/no re-listen stays silent (the card is still tappable, its state is left alone).
  if (!micEnabled()) {
    if (origin === "tap" && !opts.silent && !opts.forConfirmation) {
      v.setExpanded(true);
      v.setError(MIC_LOCKED_MSG);
    }
    return;
  }
  // Captured now, not at onFinal: tapping the mic to submit a hands-free listen disarms
  // hands-free first, and that line still has to pass the wake-word check it was heard under.
  const wakeListen = wake.armed && !opts.forConfirmation && !opts.afterGreeting;
  listenSeq++;
  heardSpeech = false;
  passiveListen = !!opts.silent && origin === "wake";
  followUpListen = false;
  sttErrorStreak = 0;
  convo.active = false;
  cancelTts();
  // `silent`: passive hands-free wake-word rearming, not a real interaction yet — never force
  // the floating HUD back open over a user who just closed it (that was the "pops back open on
  // its own" bug). Every other caller here is an explicit tap/hotkey or an actually-detected
  // wake word / pending confirmation, so it keeps expanding as before.
  if (!opts.silent) v.setExpanded(true);
  v.setPartial("");
  if (!stt) {
    v.setError("Speech-to-text unavailable here — type below");
    return;
  }
  v.setState("listening");
  // P4: a listen opened on purpose (tap, hotkey, orb, a yes/no card, "Hey Tony" then listen)
  // lowers the music now, before you speak; a passive wake listen waits for the VAD (below).
  if (opts.forConfirmation || !passiveListen) duckOnTrigger();
  // Cue audio ducks only once the VAD hears you (so Whisper can catch "turn off gabagool mode"
  // over the theme), never just because the mic is open. Released on transcribing/final/error.
  stt.start(
    {
      onPartial: (t) => store().setPartial(t),
      onPhase: (p) => {
        clientTrace.phase(p);
        if (p === "speech") {
          heardSpeech = true;
          lastUserSpeechAt = Date.now();
          // Nic started talking over a narration line (headset: the wake listen stays open under
          // it): only that line stops; whatever he says is handled as usual.
          cancelNarration();
          setCueDuck("user", true);
          duckOnSpeech(passiveListen);
        }
        if (p === "transcribing") {
          setCueDuck("user", false);
          scheduleRestore();
          store().setState("transcribing");
        }
      },
      onFinal: (t) => {
        clientTrace.sttFinal(voiceCaps.sttName, !!t);
        setCueDuck("user", false);
        store().setPartial("");
        wakeErrorStreak = 0;
        if (t) {
          // Phase 2 reflexes, before wake-word handling. A yes/no listen only takes "cut it"
          // (it cancels the card) or a stand-down (rejects it silently). A passive hands-free
          // listen hears the room, so there only a cut, a whole-line "take it easy" stand-down
          // (P5) or a hold over a busy turn acts without the wake word; "Tony, take it easy, I'm
          // thinking…" still locks a thought (checked on the command text below). A bare "stop"
          // heard in the room is too common to pause the music on: it needs the wake word.
          const ctx = reflexCtx();
          const r = parseReflex(t, ctx);
          const bare = wakeListen && useSettings.getState().wakeRequire;
          if (r && listenTakesReflex(r, { forConfirmation: opts.forConfirmation, bare, busy: ctx.busy, cueActive: cueRecentlyActive(), ttsAudible: ctx.ttsAudible, musicAudible: ctx.musicAudible }) && takeReflex(r, t, { addressed: !bare })) return;
        }
        if (t && wakeListen) {
          // Hands-free: only lines that start with a wake word ("Hey Tony…") count.
          const cmdText = useSettings.getState().wakeRequire ? afterWakeWord(t) : t;
          const wctx = reflexCtx();
          const wr = cmdText ? parseReflex(cmdText, wctx) : null;
          if (wr && cmdText && listenTakesReflex(wr, { bare: false, busy: false, cueActive: cueRecentlyActive(), ttsAudible: wctx.ttsAudible }) && takeReflex(wr, cmdText)) return;
          if (cmdText === null) {
            // People shout "stop" / "turn it down" at a cue without the wake word.
            const intent = cueRecentlyActive() ? parseOsLine(t) : null;
            if (intent?.kind === "gabagool-off" || intent?.kind === "cue-volume") return settleCommand(handleInput(t, { channel: "voice", origin }).finally(rearmWake), ttsIdle);
            settleNoise(); // room talk without the wake word
            store().setState("idle");
            return void rearmWake();
          }
          if (!cmdText) {
            // A bare "Hey Tony": the greeting, THEN the listen (startListening cancels TTS).
            const gen = micGen;
            store().setState("speaking");
            return void say(GREETING, { agent: "general", cache: true }).then(() => {
              if (gen !== micGen) return; // stood down / hard-stopped meanwhile
              // The greeting asked a question: the reply is for Tony without a second "Hey Tony".
              if (wake.armed) return startListening({ origin: "wake", afterGreeting: true });
              restoreDuck();
              store().setState("idle");
            });
          }
          // The line passed the wake word: it's for Tony, so the music stays down through his
          // answer even when a passive listen didn't duck on onset (`onWakeListen` off).
          duckOnTrigger();
          return settleCommand(handleInput(cmdText, { channel: "voice", origin }).finally(rearmWake), ttsIdle);
        }
        // The answer to the greeting's "what's up?": hands-free re-arms after it like any wake line.
        if (t && opts.afterGreeting) return settleCommand(handleInput(t, { channel: "voice", origin }).finally(rearmWake), ttsIdle);
        if (t) return settleCommand(handleInput(t, { channel: "voice", origin }), ttsIdle);
        // Silence: back to the right resting state.
        settleNoise();
        store().setState(store().pending ? "confirming" : "idle");
        rearmWake();
      },
      onError: (e) => {
        clientTrace.sttError(voiceCaps.sttName, e);
        setCueDuck("user", false);
        restoreDuck();
        const p = store().pending;
        store().setError(e);
        if (p) store().setState("confirming"); // keep the card; tap still works
        // Words Nic said were lost (Whisper failed on them): the chat says so, so the thought
        // isn't silently gone. A passive wake listen that heard nothing stays quiet.
        if (heardSpeech && !opts.forConfirmation) store().pushTurn({ who: "system", text: `Didn't catch that (${e}). Say it again?`, tone: "warn", thread: tonyThread() });
        // Hands-free must never go deaf after one failed listen (Whisper reloading, a 5xx, a
        // getUserMedia hiccup): re-arm, bounded, with a single line once it gives up.
        if (wakeListen && wake.armed) rearmWakeAfterError(e);
      },
    },
    { maxSilenceStartMs: opts.forConfirmation ? 8000 : 7000 },
  );
}

/** Consecutive failed hands-free listens (reset by any finished listen). */
let wakeErrorStreak = 0;
export const MAX_WAKE_ERROR_REARMS = 4;

/** A hands-free listen failed: re-arm with backoff, up to `MAX_WAKE_ERROR_REARMS` times in a row;
 * then pause hands-free with one visible line (a dead Whisper must not spin). */
function rearmWakeAfterError(e: string) {
  wakeErrorStreak++;
  if (wakeErrorStreak > MAX_WAKE_ERROR_REARMS) {
    wakeErrorStreak = 0;
    setWakeMode(false);
    store().pushTurn({ who: "system", text: `Hands-free paused: speech-to-text isn't answering (${e}). Tap the mic or turn hands-free back on to retry.`, tone: "error", thread: tonyThread() });
    return;
  }
  clearTimeout(wake.timer);
  wake.timer = setTimeout(() => rearmWake(), 400 * 2 ** (wakeErrorStreak - 1));
}

/** Mic button while listening: stop and use what was said so far. */
export function finishListening() {
  stt?.stop();
}

/**
 * Esc / close: stop everything. A pending action is cancelled (fail closed). D8: nothing reopens
 * the mic afterwards, so hands-free is turned off (like a tap on a live hands-free listen) rather
 * than left armed with no listen behind it.
 */
export function stopVoice() {
  if (hold.active) endHold(); // Esc / mic button while holding: drop the paused reply, unpause music
  if (wake.armed) {
    wake.armed = false;
    clearTimeout(wake.timer);
    useSettings.getState().set({ wakeMode: false });
  }
  hardStopMic({ rearm: false }); // D8: closing / Esc never reopens the mic
  cancelTts();
  releaseTtsDuck();
  if (store().pending) return reject("stopped");
}

/** Mic button / orb / hotkey. While hands-free is on, a tap on a live listen also turns hands-free off. */
export function toggleListening() {
  const s = store().state;
  switch (toggleAction(s, heardSpeech)) {
    case "submit":
      if (wake.armed) {
        wake.armed = false;
        clearTimeout(wake.timer);
        useSettings.getState().set({ wakeMode: false });
      }
      return finishListening();
    case "hard-stop":
      if (s === "listening" && wake.armed) return setWakeMode(false);
      return hardStopMic();
    case "stop-voice":
      return stopVoice();
    case "start":
      return startListening({ forConfirmation: s === "confirming", origin: "tap" });
  }
}

// ── Routing (Part 1 / P2) ────────────────────────────────────────────────────
//
// One resolver for the planner (mutating plans → a gateway agent) and the OS turn (read-only →
// an AnythingLLM sub-agent): the pure `routeFor` in route-for.ts. A Named sub-agent always wins;
// Tony is never a target ("Self"); voice is always Tony's conversation (never "Tab"); typed text
// on a sub-agent tab still goes to that agent.
const routeOpts = (utterance: string, thread: ThreadId, channel: Channel, cfg: RoutingConfig) => ({ utterance, thread, channel, cfg, osName: useSettings.getState().osName || "Tony" });

// ── Input handling ──────────────────────────────────────────────────────────

/** `origin`: who opened the mic for a voice line; omitted = the current turn's (follow-up / barge-in). */
export async function handleInput(text: string, opts: { channel: Channel; thread?: ThreadId; origin?: TurnOrigin }): Promise<void> {
  const v = store();
  const t = text.trim();
  if (!t) return;
  if (hold.active) return holdInput(t); // Phase 2: typed lines while holding join the held thought
  // P5: "take it easy" as the whole line while Tony is idle (typed too) — before any card,
  // grammar or cue. Over a busy turn the voice paths already made it a hold. (No audio-route
  // read needed: Tony audible always means busy, so a stand-down can't come out of it.)
  if (parseReflex(t, { busy: turnBusy(), holding: false })?.kind === "standdown") return standDown(opts.channel);
  clientTrace.begin(opts.channel);
  const gen = micGen;
  const live = () => gen === micGen;
  if (opts.channel === "text") turnOrigin = "text";
  else if (opts.origin) turnOrigin = opts.origin;
  // One parse decides stops, cue volume and whether a cue may fire; a line it leaves alone asks
  // Rust's Spotify grammar (`spotify_parse`, the only Spotify grammar).
  const intent = parseOsLine(t);
  let sp: SpotifyIntent | null = intent ? null : await parseSpotifyLine(t);
  if (sp && cueOwnsVolume(sp, cuePlayingNow(), t)) sp = null; // "volume 30" during Gabagool ⇒ Tony, as before
  if (store().pending) {
    if (intent && worksWhileConfirming(intent)) return controlWhileConfirming(t, intent, opts.channel);
    if (sp?.tool === "spotify.pause") return controlWhileConfirming(t, sp, opts.channel);
    return answerConfirmation(t, opts.channel);
  }

  convo.barged = false;
  // Voice is always Tony's conversation (P2/U2): `tonyThread()` — Tony's tab or Auto, never a
  // sub-agent tab, whichever is open. Typed text: the caller's thread (a sub-agent tab's input
  // keeps talking to that agent); main bars pass "auto" or nothing, and only the visible Agents
  // tab counts — never a stale tab left over from an earlier visit.
  const thread: ThreadId =
    opts.channel === "voice"
      ? opts.thread && !isSubAgentThread(opts.thread)
        ? opts.thread
        : tonyThread()
      : (opts.thread ?? (useNav.getState().section === "agents" ? v.activeThread : "auto"));
  const userTurn = v.pushTurn({ who: "user", text: t, thread });

  // "Stop gabagool mode" (any spelling Whisper produces) — checked BEFORE starting cues,
  // since the phrase itself contains "gabagool mode". Stops the cue clips AND Tony's
  // own speech (the intro line keeps talking otherwise).
  if (intent?.kind === "gabagool-off") {
    stopAllAudio();
    store().pushTurn({ who: "system", text: "Gabagool mode off.", tone: "ok", thread });
    store().setState("idle");
    if (opts.channel === "voice") void sayAck(ack(), { listenAfter: wake.armed || conversational() });
    return;
  }

  // Voice & Triggers: "enter gabagool mode" etc. run their cue widget (never a restart
  // of a running cue from a line without an ON verb — see `cueFor`).
  const cue = cueFor(t, intent, sp);
  if (cue) {
    store().setState("idle");
    fireCue(cue);
    return;
  }

  // Native OS controls (cue volume, Spotify, workspace switch, model swap, compute mode,
  // kill switch, status, plus a backstop for Gabagool phrasings the cue phrase list doesn't
  // cover): in-process, no gateway hop, no confirmation card — local, reversible controls,
  // so they never reach the planner as a mutating plan.
  const osIntent = intent
    ? await runOsIntent(intent, opts.channel).catch(() => null)
    : sp
      ? await runSpotifyIntent(sp, opts.channel).catch(() => null)
      : null;
  if (osIntent) {
    if (osIntent.reply) store().pushTurn({ who: "agent", from: "os", text: osIntent.reply, thread, meta: "os-control" });
    if (!live()) return; // hard-stopped meanwhile: the change happened, but stay silent
    // A Spotify approval card may already be up (it speaks its own read-back on voice).
    store().setState(store().pending ? "confirming" : "idle");
    if (osIntent.reply && opts.channel === "voice" && !osIntent.card) {
      store().setState("speaking");
      startBargeIn();
      // "Hey Prompter, where are we at?" is answered in the Prompter's own roster voice.
      await say(osIntent.reply, osIntent.agent ? { agent: osIntent.agent } : undefined);
      return afterVoiceReply(gen);
    }
    return;
  }
  if (!live()) return;

  const osName = useSettings.getState().osName || "Tony";
  // Tony's own conversation (not a typed sub-agent tab): the P3 tiers apply.
  const tonyTab = thread === "auto" || thread === "general";

  // Tier 4 (P3): "nah, save it for later" / "add it to my brainstorming list" / "put it in Play
  // Place" — packaged and parked in-process. Never a plan, never a worker agent. Dev-queue lines
  // ("add this to the dev queue: …") are OS intents and were handled above.
  const defer = tonyTab ? parseDefer(t, osName) : null;
  if (defer) return deferTurn(defer.target, thread, opts.channel, [userTurn.id]);

  v.setState("thinking");

  // Local intents (alarms, reminders, countdowns) write only to this machine's
  // own store — nothing leaves it — so they don't need the confirmation card.
  const local = await handleLocalIntent(t).catch((e) => ({ reply: `Couldn't save that: ${e instanceof Error ? e.message : e}`, meta: "local" }));
  if (local) {
    v.pushTurn({ who: "agent", text: local.reply, meta: local.meta, thread });
    if (!live()) return;
    if (opts.channel === "voice") {
      v.setState("speaking");
      await say(local.reply);
    }
    store().setState("idle");
    return;
  }
  if (!live()) return;

  const routingCfg = useOs.getState().cfg?.routing ?? DEFAULT_ROUTING_CONFIG;
  const routed = routeFor(routeOpts(stripWake(t), thread, opts.channel, routingCfg));

  // ── P3 tiers (Tony's thread only) ──
  if (tonyTab) {
    const dlg = useDialogue.getState();
    const session = dlg.active(thread);
    const mutating = heuristicPlan(stripWake(t), routed.role).mutating;
    let tier = classifyTier(t, { brainstormActive: !!session, routeKind: routed.kind, routeConfidence: routed.confidence, mutating, directTool: routed.kind === "Direct", osName });
    if (tier === 3 && session) {
      // "ok let's do it" inside a live brainstorm: OFFER to delegate (the yes is approve()).
      const slice = conversationSlice(store().turns, thread, { fromTurnId: session.fromTurnId });
      const userText = slice.filter((x) => x.who === "user").map((x) => x.text).join("\n");
      const target = offerTarget({ buildShaped: session.buildShaped, topicRole: session.topicRole, userText, cfg: routingCfg, osName });
      if (target) {
        // Phase 2 Part C: Tony's mode decides what the commit cue does (D15/D16). Builder +
        // a build-shaped brainstorm queues it at once (staging only); Solo hands nothing off and
        // offers to park it; everything else is today's spoken offer card.
        switch (tier3Action(useModes.getState().effective, target)) {
          case "auto":
            // Only a real commit ("let's do it", "lock it in") skips the card: bare agreement
            // ("sounds good", "yeah that works") mid-brainstorm is usually a yes to a sub-point.
            if (target.kind === "pipeline" && commitStrength(t, osName) === "strong") return autoDelegateBuild(t, thread, opts.channel, slice);
            break;
          case "solo":
            return offerPark(t, thread, opts.channel, slice);
        }
        return offerDelegation(t, thread, opts.channel, target, slice);
      }
      tier = 2; // nothing to hand off: Tony just keeps talking
    }
    if (tier === 2) {
      // The agent Tony kept this from (voice on Tony's tab already folded a Domain hit into
      // "Self", so read the matrix itself) — the Tier-3 delegate if it comes to that.
      const det = resolve(stripWake(t), routingCfg, osName);
      const agentKept = (det.kind === "Domain" || det.kind === "Named") && det.role && !isSelfRoleId(det.role, osName) ? (det.role as AgentRole) : undefined;
      dlg.touch(thread, userTurn.id, { topicRole: agentKept, buildShaped: looksBuildShaped(t) });
      return brainstormTurn(t, thread, opts.channel);
    }
    // An explicit switch (a Named delegation or a real action) ends the brainstorm.
    if (session && ((routed.kind === "Named" && routed.confidence === "high") || mutating)) dlg.end(thread);
  }

  let plan;
  try {
    plan = await planIntent(stripWake(t), { role: routed.role, history: history(thread).slice(0, -1) });
  } catch (e) {
    return live() ? fail(e, thread) : undefined;
  }
  if (!live()) return;
  plan.thread = thread;
  plan.routeKind = routed.kind;
  plan.explicitRole = routed.kind === "Tab" || (routed.kind === "Named" && routed.role === thread);

  if (!plan.mutating) return run(plan, opts.channel);
  await requestConfirmation(plan, opts.channel);
}

/**
 * Put a mutating plan in front of the human: card + (for voice) a spoken
 * read-back, then listen for yes/no. Also used by features that build a plan
 * themselves (e.g. "Add to Google Calendar" on a reminder).
 */
export async function requestConfirmation(plan: ActionPlan, channel: Channel) {
  const gen = micGen;
  const v = store();
  if (v.pending) reject("superseded");
  const timeoutSec = useSettings.getState().confirmTimeoutSec;
  v.setPending({ plan, channel, deadline: Date.now() + timeoutSec * 1000, reprompted: false });
  v.setState("confirming");
  clearTimeout(confirmTimer);
  confirmTimer = setTimeout(() => reject("timed out"), timeoutSec * 1000);

  // Manual Overseer Mode: a second opinion lands on the card while you decide.
  const os = useOs.getState().cfg;
  if (os?.overseer.manualMode && isTauri() && plan.target.kind !== "bridge") void overseerReview(plan);

  if (channel === "voice") {
    await say(plan.readBack);
    // Only listen if this same plan is still waiting (user may have tapped meanwhile).
    if (gen === micGen && store().pending?.plan.id === plan.id) startListening({ forConfirmation: true, ...relistenOpts() });
  }
}

async function overseerReview(plan: ActionPlan) {
  try {
    const r = await cmd("overseer_ask", {
      req: {
        question: `Before the user approves it, review this action in two sentences: is it what they asked for, and is anything risky or missing?\nRequest: "${plan.utterance}"\nPlan: ${plan.summary} ${JSON.stringify(plan.payload)}`,
        transcript: [],
        context: await liveContext(),
      },
    });
    const p = store().pending;
    if (p?.plan.id !== plan.id) return;
    const notes = [...p.plan.verification.notes, `Overseer (${r.engine}): ${r.answer.slice(0, 400)}`];
    store().setPending({ ...p, plan: { ...p.plan, verification: { ...p.plan.verification, notes } } });
  } catch {
    /* advisory only */
  }
}

/** Speak a line outside a conversation turn (alarms firing, brainstorm acks). */
export async function announce(text: string) {
  if (!micEnabled()) return; // D6: no unsolicited speech while the mic is locked off (the toast still shows)
  await say(text);
}

async function answerConfirmation(reply: string, channel: Channel): Promise<void> {
  const gen = micGen;
  const p = store().pending!;
  if (p.plan.offer) return answerOffer(reply, channel, p);
  store().pushTurn({ who: "user", text: reply, thread: p.plan.thread });
  const verdict = parseConfirmation(reply);
  if (verdict === "yes") return approve(channel === "voice" ? "voice" : "typed");
  if (verdict === "no") return reject("declined");
  if (p.reprompted) return reject("reply unclear");
  store().setPending({ ...p, reprompted: true });
  store().setState("confirming");
  if (channel === "voice") {
    await say("Say yes to proceed, or no to cancel.");
    if (gen === micGen && store().pending?.plan.id === p.plan.id) startListening({ forConfirmation: true, ...relistenOpts() });
  }
}

/** Audio controls that act at once even while a confirmation card waits (otherwise "stop" reads as an
 * unclear yes/no). Spotify's pause (a `spotify.pause` intent) is let through by `handleInput` too. */
const worksWhileConfirming = (i: OsIntent) => i.kind === "gabagool-off" || i.kind === "cue-volume";

/** Run one of those and keep the card: it is still answered by yes/no or a tap. */
async function controlWhileConfirming(text: string, intent: OsIntent | SpotifyIntent, channel: Channel) {
  const gen = micGen;
  const p = store().pending!;
  store().pushTurn({ who: "user", text, thread: p.plan.thread });
  const r = await ("tool" in intent ? runSpotifyIntent(intent, channel) : runOsIntent(intent, channel)).catch(() => null);
  if (r?.reply) store().pushTurn({ who: "agent", from: "os", text: r.reply, thread: p.plan.thread, meta: "os-control" });
  if (store().pending?.plan.id !== p.plan.id) return;
  store().setState("confirming");
  if (channel !== "voice" || gen !== micGen) return;
  // "Hey Coder, where are we at?" while a card waits: still in the Coder's own roster voice.
  if (r?.reply) await say(r.reply, r.agent ? { agent: r.agent } : undefined);
  if (gen === micGen && store().pending?.plan.id === p.plan.id) startListening({ forConfirmation: true, ...relistenOpts() });
}

/** Drop the yes/no listen. abort() silences every STT callback, so the user-speech duck its
 * VAD may have engaged has to be released here (the same as hardStopMic does). */
function abortConfirmListen() {
  stt?.abort();
  heardSpeech = false;
  setCueDuck("user", false);
  restoreDuck();
}

/**
 * A reply to a Tier-3 delegation OFFER (P3). Park / save first ("nah, save it for later" saves —
 * it is not a no), then yes → `approve()`, no → a quiet decline; anything else silently drops the
 * offer and is handled as a brand-new turn (no "say yes or no" re-prompt).
 */
async function answerOffer(reply: string, channel: Channel, p: NonNullable<ReturnType<typeof store>["pending"]>): Promise<void> {
  const verdict = parseOfferReply(reply);
  const thread = p.plan.thread ?? tonyThread();
  if (verdict === "other") {
    reject("superseded", { silent: true });
    return handleInput(reply, { channel, thread });
  }
  const turn = store().pushTurn({ who: "user", text: reply, thread });
  if (verdict === "yes") return approve(channel === "voice" ? "voice" : "typed");
  if (verdict === "no") return reject("declined");
  reject("parked", { silent: true });
  return deferTurn(parseDefer(reply, useSettings.getState().osName || "Tony")?.target ?? "brainstorm", thread, channel, [turn.id]);
}

/** The offer card's "Park it" button: the brainstorm goes to the Brainstorm list, nothing runs. */
export function parkPending() {
  const p = store().pending;
  if (!p?.plan.offer) return;
  const thread = p.plan.thread ?? tonyThread();
  reject("parked", { silent: true });
  void deferTurn("brainstorm", thread, p.channel);
}

/** The ONLY path by which a mutating plan reaches an executor. */
export async function approve(via: "voice" | "tap" | "typed") {
  const p = store().pending;
  if (!p) return;
  clearTimeout(confirmTimer);
  abortConfirmListen();
  cancelTts();
  store().setPending(null);
  store().pushTurn({ who: "system", text: `Approved (${via}): ${p.plan.summary}`, tone: "ok", thread: p.plan.thread });
  const failedBefore = failCount;
  await run(p.plan, p.channel);
  // An approved delegation ends the brainstorm it came from (P3) — only once the hand-off DID
  // happen: a refused / failed one (a Solo refusal, the task store down) keeps the session, so
  // "switch modes and I'll build it" or "park it" still find the brainstorm.
  if (p.plan.offer && failCount === failedBefore) useDialogue.getState().end(p.plan.thread ?? tonyThread());
}

/** `silent`: no spoken "Cancelled." (a "cut it" never makes Tony say a sentence). A delegation
 * offer (P3) never says "Cancelled." and only an explicit decline leaves a line in the thread:
 * timeouts, supersedes and parks drop it quietly (the brainstorm just carries on). */
export function reject(reason: string, opts: { silent?: boolean } = {}) {
  const p = store().pending;
  if (!p) return;
  clearTimeout(confirmTimer);
  abortConfirmListen();
  store().setPending(null);
  p.plan.onCancel?.();
  if (p.plan.offer) {
    if (reason === "declined" || reason === "dismissed") store().pushTurn({ who: "system", text: `Kept it with ${useSettings.getState().osName || "Tony"} — nothing was delegated.`, thread: p.plan.thread });
    store().setState("idle");
    return;
  }
  store().pushTurn({ who: "system", text: `Cancelled (${reason}) — nothing was sent.`, tone: "warn", thread: p.plan.thread });
  store().setState("idle");
  if (p.channel === "voice" && !opts.silent && micEnabled()) void say("Cancelled.");
}

async function run(plan: Parameters<typeof execute>[0], channel: Channel) {
  const gen = micGen;
  store().setState("thinking");
  const thread = plan.thread ?? tonyThread();
  // Read-only questions go through the OS core (context + sub-agents + tools).
  if (!plan.mutating && plan.target.kind === "agent" && !plan.run && isTauri()) return osRun(plan, channel, thread);
  // An approved Tier-3 delegation (P3): the OS core, straight to that agent (only reached from approve()).
  if (plan.delegateTo && !plan.run && isTauri()) return osRun(plan, channel, thread);
  try {
    const traceId = clientTrace.id ?? undefined;
    const r = await execute(plan, history(thread).slice(0, -1));
    // An empty result: the runner's caller posts (and speaks) the outcome itself (a gated
    // os_turn): never a second copy, and the turn's state is the caller's.
    if (!r.text) return;
    store().pushTurn({ who: "agent", text: r.text, role: plan.role, meta: r.meta, thread, from: "os" });
    clientTrace.ui(traceId, "reply shown");
    if (gen !== micGen) return;
    if (channel === "voice") {
      store().setState("speaking");
      startBargeIn();
      await say(r.text, { traceId });
      return afterVoiceReply(gen);
    }
    if (store().state === "speaking" || store().state === "thinking") store().setState("idle");
  } catch (e) {
    fail(e, thread);
  }
}

// Raw transport/parsing failures the chain can surface (dispatch.rs / plan.ts /
// the gateway) are developer-shaped, not something to read or speak verbatim
// to the user. Each maps to one calm, spoken-safe line; the raw text is kept
// in the turn's `meta` (shown small, never spoken) for anyone debugging.
const CALM_ERRORS: [RegExp, string][] = [
  // Phase 2 Part C: a build Tony's mode refused (Rust `modes::refusal_message`).
  [new RegExp(MODE_SURFACE_ONLY), calmModeError(MODE_SURFACE_ONLY)!],
  [new RegExp(MODE_NOT_AUTO), calmModeError(MODE_NOT_AUTO)!],
  [/all providers failed/i, "None of my models answered just now — check Settings → Services, or try again in a moment."],
  [/no reachable providers/i, "None of my models are reachable right now — check Settings → Services."],
  [/malformed (completion|gateway reply)/i, "I got back something I couldn't read from that model — try again, or switch models in Settings."],
  [/planner returned no JSON/i, "I couldn't turn that into a clean plan — try rephrasing it."],
  [/model returned no JSON|verifier gave no verdict/i, "I couldn't organize that cleanly — try again."],
  [/CLI not installed/i, "That assistant isn't installed on this machine."],
  [/timed out/i, "That took too long and timed out — try again."],
  [/unreachable/i, "I couldn't reach that service — check it's running."],
];

function calmMessage(raw: string): string {
  for (const [re, calm] of CALM_ERRORS) if (re.test(raw)) return calm;
  return raw;
}

/** Failures surfaced so far (approve() compares it around a run). */
let failCount = 0;

function fail(e: unknown, thread?: ThreadId) {
  failCount++;
  const raw = e instanceof Error ? e.message : String(e);
  const calm = calmMessage(raw);
  store().pushTurn({ who: "system", text: calm, tone: "error", thread, meta: calm === raw ? undefined : raw });
  if (hold.active) return; // keep HOLDING on screen; the error is in the thread
  store().setError(calm);
  clientTrace.ui(clientTrace.id, "error shown", false, calm);
}

// ── P3 tiered dialogue: Tier 2 brainstorm, Tier 3 offer, Tier 4 park ───────────

/** The Tier-3 offer card's spoken read-back (exact). */
export const OFFER_READBACK = "Want me to go ahead and delegate that, or park it for later?";

/** Tier 2: Tony answers himself — never a worker agent, no planner, no card. */
function brainstormTurn(t: string, thread: ThreadId, channel: Channel) {
  const plan = heuristicPlan(stripWake(t), "general");
  // Talk, not an action: no tool binding (a draft-shaped thought), no runner, no card.
  plan.mutating = false;
  plan.target = { kind: "agent" };
  plan.payload = {};
  plan.run = undefined;
  plan.noDelegate = true;
  plan.thread = thread;
  plan.routeKind = "Self";
  plan.explicitRole = false;
  plan.plannerNote = "brainstorm with Tony (Tier 2)";
  return run(plan, channel);
}

/**
 * Tier 4: package this thread's brainstorm and park it (Brainstorm list / Ideas & Tasks Ledger /
 * Play Place). One spoken line. Storage only: never idea_capture, a pipeline or an os_turn.
 */
async function deferTurn(target: DeferTarget, thread: ThreadId, channel: Channel, excludeIds: string[] = []) {
  const gen = micGen;
  store().setState("thinking");
  const osName = useSettings.getState().osName || "Tony";
  const session = useDialogue.getState().active(thread);
  const slice = conversationSlice(store().turns, thread, { fromTurnId: session?.fromTurnId, excludeIds });
  let reply: string;
  if (!slice.some((x) => x.who === "user")) reply = "There's nothing to save yet — tell me the idea first.";
  else {
    try {
      const a = await buildArtifact(slice, { osName });
      await saveArtifact(target, a, slice, osName);
      reply = `Saved “${a.title}” to your ${DEFER_LABEL[target]}.`;
      useDialogue.getState().end(thread);
    } catch (e) {
      reply = `I couldn't save that to your ${DEFER_LABEL[target]} — ${calmMessage(e instanceof Error ? e.message : String(e))}`;
    }
  }
  store().pushTurn({ who: "agent", from: "os", text: reply, thread, meta: "parked" });
  if (gen !== micGen) return;
  if (channel === "voice") {
    store().setState("speaking");
    startBargeIn();
    await say(reply);
    return afterVoiceReply(gen);
  }
  store().setState("idle");
}

/**
 * Tier 3: "ok let's do it" in a live brainstorm. Tony asks before anything leaves him — a
 * confirmation card (Delegate / Park it / Not now), so the yes IS `approve()`. Build-shaped →
 * the Prompter → Designer → Coder pipeline; otherwise the agent the brainstorm was about (U5).
 */
async function offerDelegation(t: string, thread: ThreadId, channel: Channel, target: OfferTarget, slice: VoiceTurn[]) {
  const osName = useSettings.getState().osName || "Tony";
  const title = fallbackTitle(slice);
  const brief = briefOf(slice, osName, { dropText: t });
  const who = target.kind === "pipeline" ? "the Prompter → Designer → Coder pipeline" : roleLabel(target.role);
  const plan = heuristicPlan(stripWake(t), target.kind === "agent" ? target.role : "prompter");
  plan.mutating = true;
  plan.offer = "delegate";
  plan.thread = thread;
  plan.summary = `Delegate “${title}” to ${who}`;
  plan.intent = `delegate “${title}” to ${who}`;
  plan.readBack = OFFER_READBACK;
  plan.target = { kind: "bridge", action: "delegate", scopes: ["delegation"] };
  const handoff = `[${osName} — approved hand-off from a brainstorm with the user] Take it from here:\n${brief}`;
  plan.payload = { to: target.kind === "pipeline" ? "pipeline" : target.role, title, brief: target.kind === "pipeline" ? brief : handoff };
  plan.verification = { status: "verified", notes: [], by: "your own brainstorm with " + osName };
  plan.plannerNote = "delegation offer (Tier 3)";
  plan.onCancel = () => undefined;
  if (target.kind === "pipeline") plan.run = () => delegateBuild(brief, title, thread, channel === "voice" ? "voice" : "typed");
  else if (isTauri()) plan.delegateTo = target.role;
  else {
    const role = target.role;
    plan.run = async () => {
      const { result } = await dispatch(handoff, { role, history: [] });
      return { text: result.content || "(no response)", meta: `${roleLabel(role)} · ${result.providerId} · delegated (Tier 3)` };
    };
  }
  store().setState("idle");
  await requestConfirmation(plan, channel);
}

/** Solo mode's Tier-3 card read-back: nothing is handed off, the brainstorm can be parked. */
export const SOLO_PARK_READBACK = "Solo mode — want me to park that for later?";

/**
 * Tier 3 under Solo (`surface_only`, D15): nothing leaves Tony. A park-only card; its yes (still
 * `approve()`) packages the brainstorm into the Brainstorm list. No task, no agent.
 */
async function offerPark(t: string, thread: ThreadId, channel: Channel, slice: VoiceTurn[]) {
  const osName = useSettings.getState().osName || "Tony";
  const title = fallbackTitle(slice);
  const plan = heuristicPlan(stripWake(t), "general");
  plan.mutating = true;
  plan.offer = "park";
  plan.thread = thread;
  plan.summary = `Park “${title}” in your ${DEFER_LABEL.brainstorm} (Solo mode: nothing gets built now)`;
  plan.intent = `park “${title}” for later`;
  plan.readBack = SOLO_PARK_READBACK;
  plan.target = { kind: "bridge", action: "park", scopes: [] };
  plan.payload = { title };
  plan.verification = { status: "verified", notes: [], by: "your own brainstorm with " + osName };
  plan.plannerNote = "park offer (Solo mode)";
  plan.onCancel = () => undefined;
  plan.run = async () => {
    const a = await buildArtifact(slice, { osName });
    await saveArtifact("brainstorm", a, slice, osName);
    return { text: `Saved “${a.title}” to your ${DEFER_LABEL.brainstorm}.`, meta: "parked (Solo mode)" };
  };
  store().setState("idle");
  await requestConfirmation(plan, channel);
}

/**
 * Tier 3 under Builder (`auto_dispatch`, D16): Nic's per-mode opt-in to skip the spoken offer for a
 * build-shaped brainstorm — ONE queued TaskEnvelope (staging only) and the templated line, no card.
 * Rust re-checks the mode (`task_create{auto}`); a stale webview that hits `MODE_NOT_AUTO` falls
 * back to today's offer card, and a Solo refusal to the park card.
 */
async function autoDelegateBuild(t: string, thread: ThreadId, channel: Channel, slice: VoiceTurn[]) {
  const gen = micGen;
  const osName = useSettings.getState().osName || "Tony";
  const title = fallbackTitle(slice);
  const brief = briefOf(slice, osName, { dropText: t });
  store().setState("thinking");
  let r: { text: string; meta: string };
  try {
    r = await delegateBuild(brief, title, thread, channel === "voice" ? "voice" : "typed", { auto: true });
    // The brainstorm ends only once the build IS queued: a MODE_* fallback card (or a failure)
    // keeps it, so Park / a second commit cue still package the whole conversation.
    useDialogue.getState().end(thread);
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    if (raw.includes(MODE_NOT_AUTO)) return offerDelegation(t, thread, channel, { kind: "pipeline" }, slice);
    if (raw.includes(MODE_SURFACE_ONLY)) return offerPark(t, thread, channel, slice);
    return fail(e, thread);
  }
  store().pushTurn({ who: "agent", text: r.text, role: "prompter", meta: `${r.meta} · Builder mode`, thread, from: "os" });
  if (gen !== micGen) return;
  if (channel === "voice") {
    store().setState("speaking");
    startBargeIn();
    await say(r.text);
    return afterVoiceReply(gen);
  }
  if (store().state === "speaking" || store().state === "thinking") store().setState("idle");
}

/** What Tony says the moment an approved build is queued (templated: no model, no wait). */
export const BUILD_QUEUED_LINE = "Queued. The Prompter's on it. Ask me where the build's at anytime.";

/**
 * An approved build (thin Tony, Part 6): ONE queued TaskEnvelope, then an immediate templated
 * line. The Rust worker runs Prompter → Librarian → Designer → Coder → staging in the background
 * and reports through `agent-event` (narration / chat / status on demand). Only ever a plan's
 * `run`, so it only ever runs from `approve()` (the Tier-3 yes or a Build-prototype card).
 * Desktop: `task_create`. Phone: an `os_queue` item of kind `task` the desktop claims; the phone
 * doesn't wait for it.
 */
async function delegateBuild(brief: string, title: string, thread: ThreadId, source: TaskSource, opts: { auto?: boolean } = {}): Promise<{ text: string; meta: string }> {
  const auto = opts.auto === true;
  if (isTauri()) {
    const r = await cmd("task_create", { raw_intent: brief, title, thread, source, ...(auto ? { auto: true } : {}) });
    markAnnounced(r.task_id);
    trackTask(r.task_id, r.title || title, thread);
    if (!r.created) return { text: `“${r.title || title}” is already queued. Ask me where the build's at anytime.`, meta: "delegated · task (Tier 3)" };
    return { text: BUILD_QUEUED_LINE, meta: "delegated · task (Tier 3)" };
  }
  // Phone: wait for the desktop's answer (task creation is quick) so a mode-gate refusal
  // (MODE_SURFACE_ONLY / MODE_NOT_AUTO from a phone whose mode view is stale) throws, never
  // "Queued". The refusal also refreshes the phone's mode view.
  let r: Record<string, unknown> | null;
  try {
    r = await queueDesktopItem("task", { raw_intent: brief, title, thread, ...(auto ? { auto: true } : {}) }, { capMs: PHONE_TASK_CAP_MS });
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    if (raw.includes(MODE_NOT_AUTO) || raw.includes(MODE_SURFACE_ONLY)) void useModes.getState().load();
    throw e;
  }
  if (!r) return { text: BUILD_SENT_LINE, meta: "sent to the desktop (not picked up yet)" };
  const name = typeof r.title === "string" && r.title ? r.title : title;
  if (r.created === false) return { text: `“${name}” is already queued. Ask me where the build's at anytime.`, meta: "delegated · task via the desktop (Tier 3)" };
  return { text: BUILD_QUEUED_LINE, meta: "delegated · task via the desktop (Tier 3)" };
}

/** Phone: how long to wait on the desktop's answer to a build `task` once it has claimed it. */
const PHONE_TASK_CAP_MS = 30_000;
/** Phone: the desktop hasn't picked the build up yet (app closed / busy) — nothing claimed. */
export const BUILD_SENT_LINE = "Sent it to the desktop. It gets queued once the app picks it up.";

/** A pipeline run for a ledger idea — always behind the card (the yes is `approve()`). */
export function requestPipeline(ideaId: string, title: string, thread: ThreadId, channel: Channel = "text", utterance?: string) {
  const plan = heuristicPlan(utterance ?? `Run the pipeline for ${title}`, "prompter");
  plan.mutating = true;
  plan.thread = thread;
  plan.summary = `Build “${title}” (Prompter → Librarian → Designer → Coder → staging)`;
  plan.intent = `run the prototype pipeline for “${title}”`;
  plan.readBack = `Run the prototype pipeline for “${title}”? Proceed?`;
  plan.target = { kind: "bridge", action: "pipeline", scopes: ["delegation"] };
  plan.payload = { ideaId };
  plan.verification = { status: "verified", notes: [], by: "built from your own request" };
  // Waits for the task to EXIST (task_from_idea is quick; the worker builds in the background) and
  // reports the real outcome: a refusal (Solo, an oversized idea, the ledger down) throws into the
  // calm-error path instead of "Queued…" followed by "Couldn't start".
  plan.run = async () => ({ text: await runPipeline(ideaId, title, thread), meta: "pipeline · task" });
  return requestConfirmation(plan, channel);
}

/** "Build prototype" on a parked Play Place card: the same approved build as a Tier-3 yes. */
export function requestBuild(text: string, title: string, thread: ThreadId = tonyThread()) {
  const plan = heuristicPlan(`Build a prototype of ${title}`, "prompter");
  plan.mutating = true;
  plan.thread = thread;
  plan.summary = `Build a prototype of “${title}” (Prompter → Designer → Coder)`;
  plan.intent = `build a prototype of “${title}”`;
  plan.readBack = `Build a prototype of “${title}”? Proceed?`;
  plan.target = { kind: "bridge", action: "pipeline", scopes: ["delegation"] };
  plan.payload = { title };
  plan.verification = { status: "verified", notes: [], by: "built from your own click" };
  plan.run = () => delegateBuild(fitBrief(text), title, thread, "playplace");
  return requestConfirmation(plan, "text");
}

/** One-tap answers rendered under a message: a failed build's Retry / Offload (pipeline-store). */
export function runTurnAction(run: string, thread: ThreadId) {
  // retry:<task_id>  ·  offload:<engine>:<task_id>
  const retry = /^retry:(.+)$/.exec(run);
  const offload = /^offload:([a-z-]+):(.+)$/.exec(run);
  if (retry || offload) {
    const taskId = (retry ?? offload)![retry ? 1 : 2];
    store().pushTurn({ who: "system", text: offload ? `Re-running the failed step on ${offload[1]}…` : "Retrying the failed step…", tone: "ok", thread });
    // `pipeline_resume` takes the task id (and explains an old pipeline checkpoint clearly).
    void cmd("pipeline_resume", { checkpoint: taskId, offload: offload?.[1] }).catch((e) => store().pushTurn({ who: "system", text: String(e), tone: "error", thread }));
  }
}

// ── OS core turn (desktop) ───────────────────────────────────────────────────

/** Did the sub-agent itself produce this answer? Rust says so (`answeredBy`); for an older build
 * that doesn't, a turn where Tony "stepped in" for the agent is his. Pure. */
export function answeredByAgent(r: Pick<OsTurnResult, "answeredBy" | "steps">): boolean {
  if (r.answeredBy) return r.answeredBy === "agent";
  return !r.steps.some((s) => s.kind === "step-in");
}

async function osRun(plan: ActionPlan, channel: Channel, thread: ThreadId) {
  const gen = micGen;
  const isLive = () => gen === micGen;
  // System Map: Rust's os-trace steps for this turn join the webview's own hops.
  const traceId = clientTrace.id ?? undefined;
  // Queued sentences check again when their turn comes: a hard stop mid-stream drops the rest.
  const sayLive = (text: string, o: SpeakOpts) => (isLive() ? say(text, { ...o, traceId }) : undefined);
  const routingCfg = useOs.getState().cfg?.routing ?? DEFAULT_ROUTING_CONFIG;
  // P3: a Tier-2 brainstorm stays Tony's ("Self" + `noDelegate`, so Rust never re-routes it); an
  // approved Tier-3 delegation goes to the agent the card named, with the packaged brief as its task.
  const routed0: RoutedTurn = plan.delegateTo
    ? { role: plan.delegateTo, kind: "Named", confidence: "high", reason: "approved delegation (Tier 3)", task: typeof plan.payload.brief === "string" ? plan.payload.brief : plan.utterance }
    : plan.noDelegate
      ? { role: "general", kind: "Self", confidence: "high", reason: "brainstorm with Tony (Tier 2)", task: plan.utterance }
      : routeFor(routeOpts(plan.utterance, thread, channel, routingCfg));
  // "Explicit" = talking directly to the tab you're on — no Tony synthesis,
  // no relay turn, no link pill. A Named/Domain route that pulls you to a
  // *different* agent than the one you're looking at is never explicit, even
  // from that agent's own tab (fixes: naming another agent from Tony's tab,
  // or from a different agent's tab, used to be silently ignored).
  // Solo (surface_only) keeps a Domain / low-confidence hit with Tony exactly as Rust will, so
  // the chat never announces "Routing … to Coder…" (and plays the handoff cue) for a delegation
  // that doesn't happen. An approved Tier-3 hand-off is never held.
  const routed: RoutedTurn = plan.delegateTo ? routed0 : soloHold(routed0, { explicit: thread !== "auto" && routed0.role === thread, dispatch: useModes.getState().effective?.dispatch });
  const role = routed.role;
  const task = routed.task;
  const explicit = thread !== "auto" && role === thread;

  // Phase 2 §4 announcer handoff (voice, delegated): Tony speaks a short cached intro, then the
  // agent's own reply plays in its roster voice; his synthesis is shown but not spoken.
  const handoff = channel === "voice" && !explicit && role !== "general" && useSettings.getState().routing.announcerHandoff;
  // This turn's id: the `tony-token`/`os-agent-reply` stream key and (P1) the TTS breaker
  // scope — `${streamId}-${agent}` per voice, the same id on every prefetch/speak pair, so an
  // ElevenLabs failure trips one reply once (one notice) instead of every sentence.
  // Created before the routing notice so that line shares Tony's scope.
  const streamId = crypto.randomUUID();
  const uttFor = (agent: string) => utteranceIdFor(streamId, agent);

  // Tony-feed relay turn for a real delegation only (`routingNotice`: never Tony himself, never
  // Self / Direct / Tab, never the agent whose thread this is) — no "TONY → TONY".
  // Spoken (Tony's own voice) only for voice turns — a typed handoff notice
  // stays silent even when the target agent has auto-speak on.
  // An approved Tier-3 hand-off names the brainstorm by its title, not its (long) brief.
  const noticeTask = plan.delegateTo && typeof plan.payload.title === "string" ? `“${plan.payload.title}”` : task;
  const notice = routingNotice({ role, kind: routed.kind, explicit, thread, task: noticeTask, utterance: plan.utterance });
  // Phase 5 vocal handoff: starts now, in parallel — the turn below dispatches without waiting on it.
  const handoffCue = notice ? startHandoffCue(role) : null;
  if (notice) {
    noteHandoff(role, !!handoffCue);
    store().pushTurn({ who: "relay", from: "os", to: role, text: notice, thread, meta: "routing" });
    if (channel === "voice" && isLive() && !handoff) {
      store().setState("speaking");
      startBargeIn();
      // Fire-and-forget: the actual dispatch below doesn't need to wait for this courtesy
      // notice to finish playing (it used to `await` it, stacking its TTS time in front of
      // every delegated turn's real latency). `say()` cancels this mid-sentence on its own
      // if the real answer's first chunk is ready sooner, which reads as the assistant
      // getting straight to the point rather than anything breaking.
      // P5: the bubble keeps "Routing … to …"; Tony just says a one-line ack (cached, so no
      // utteranceId — a cached line never pins the reply's TTS breaker scope).
      // With Vocal Handoffs on, the exchange replaces the one-line ack.
      if (!handoffCue) void say(ack(), { agent: "general", traceId, cache: true });
    }
  }

  // Independent I/O — run concurrently instead of one after the other.
  const [context0, librarianHits] = await Promise.all([liveContext(), role === "librarian" ? cc.agentSearch(plan.utterance, 5).catch(() => null) : Promise.resolve(null)]);
  let context = context0;
  if (librarianHits?.results.length) context += `\nLocal vault matches (cite them):\n${librarianHits.results.map((r, i) => `[${i + 1}] (${r.collection}) ${r.snippet.replace(/\s+/g, " ")}`).join("\n")}`;
  const finalFromFor = (agent: string) => (agent === "general" ? "os" : agent);

  // Stream the answer token-by-token into a live bubble. Two sources feed this
  // same event: Tony's own synthesis (always tagged "general" server-side, or
  // untagged — treated the same) and, for an explicit-tab turn, the sub-agent's
  // own AnythingLLM stream-chat (tagged with that agent's role, Part 6 §1) —
  // never both in the same turn (see agents.rs `run_os_turn`).
  let live: string | null = null;
  let buffered = "";
  // Voice: start talking at the first complete sentence instead of after the whole answer.
  let spokenUpTo = 0;
  // Every spoken line of this turn queues behind the vocal handoff exchange (if one is playing),
  // so the reply and the cue beats never cut each other off (both go through tts.speak()).
  let speakQ: Promise<void> = handoffCue ? handoffCue.done.then(() => undefined) : Promise.resolve();
  let streamAgent = "general";
  let lastSpokenChunk: string | undefined;
  // Registered for "cut it" (`killTurn` → `os_turn_cancel`); removed when the turn returns.
  activeStreams.add(streamId);
  // Announcer handoff: who Tony has introduced, which agent replies were queued to speak.
  const introduced = new Set<string>();
  const spokenReplies = new Set<string>();
  const queueAgentReply = (agent: string, text: string) => {
    const body = text.trim();
    if (!body || spokenReplies.has(`${agent}|${body}`) || !isLive()) return;
    spokenReplies.add(`${agent}|${body}`);
    if (!introduced.has(agent)) {
      introduced.add(agent);
      speakQ = speakQ.then(() => sayLive(introLine([agent]), { agent: "general", cache: true }));
    }
    if (store().state !== "speaking") {
      store().setState("speaking");
      startBargeIn();
    }
    const bodyOpts = { agent, utteranceId: uttFor(agent) };
    tts.prefetch?.(body, bodyOpts);
    speakQ = speakQ.then(() => sayLive(body, bodyOpts));
  };
  // Explicit-tab voice turn: Tony introduces the agent once, right before its first spoken words
  // (never for Tony's own or direct-tool turns: role is "general" there).
  const tabIntro = channel === "voice" && explicit && role !== "general" && useSettings.getState().routing.announcerHandoff;
  const introOnce = (agent: string) => {
    if (!tabIntro || agent !== role || introduced.has(agent) || !isLive()) return;
    introduced.add(agent);
    speakQ = speakQ.then(() => sayLive(introLine([agent]), { agent: "general", cache: true }));
  };
  if (handoff && isLive() && (routed.kind === "Named" || routed.kind === "Domain")) {
    introduced.add(role);
    store().setState("speaking");
    startBargeIn();
    // The vocal handoff exchange already introduces the agent: its reply waits for the cue's last
    // beat (playback order only — the agent's job is already running).
    speakQ = speakQ.then(() => (handoffCue ? handoffCue.done.then(() => undefined) : sayLive(introLine([role]), { agent: "general", cache: true })));
  } else if (channel === "voice" && isLive()) startBargeIn(); // "cut it" / "whoa" work while it thinks
  const offAgent = handoff ? await onAgentReply((e) => e.streamId === streamId && queueAgentReply(e.agent, e.text)) : () => undefined;
  const off = await onNativeEvent<{ streamId: string; delta: string; agent?: string }>("tony-token", (e) => {
    if (e.streamId !== streamId) return;
    const agent = e.agent ?? "general";
    if (live && agent !== streamAgent) {
      // The sub-agent's stream broke off and Tony took over under the same stream: the agent's
      // partial reply keeps its own (now closed) bubble; Tony's answer gets a new one — never
      // glued together and labelled as the agent.
      store().updateTurn(live, { meta: "interrupted" });
      live = null;
      buffered = "";
      spokenUpTo = 0;
      lastSpokenChunk = undefined;
    }
    streamAgent = agent;
    buffered += e.delta;
    if (!live) live = store().pushTurn({ who: "agent", from: finalFromFor(streamAgent), text: buffered, thread, meta: "streaming…" }).id;
    else store().updateTurn(live, { text: buffered });
    // Handoff: Tony's synthesis of a delegated answer is shown, never spoken (no re-summary).
    if (channel === "voice" && isLive() && !(handoff && streamAgent === "general")) {
      const next = nextStreamChunk(buffered, spokenUpTo);
      if (next) {
        const { chunk } = next;
        spokenUpTo = next.end;
        // Render it now, while the previous chunk is still playing — no gap between sentences.
        const previousText = lastSpokenChunk;
        lastSpokenChunk = chunk;
        const chunkOpts = { agent: streamAgent, previousText, utteranceId: uttFor(streamAgent) };
        tts.prefetch?.(chunk, chunkOpts);
        if (store().state !== "speaking") {
          store().setState("speaking");
          startBargeIn();
        }
        introOnce(streamAgent);
        speakQ = speakQ.then(() => sayLive(chunk, chunkOpts));
      }
    }
  });
  // askCards: a Spotify write held by the Ask tier comes back as `pendingSpotify` (card below), not a failure note.
  // cuePlaying: Rust keeps "volume 30" during a Gabagool cue away from Spotify (same rule as cueOwnsVolume).
  const req = { text: task, role, explicit, routeKind: routed.kind, routeReason: routed.reason, history: history(thread).slice(0, -1), context, streamId, traceId, askCards: true, cuePlaying: cuePlayingNow(), noDelegate: !!plan.noDelegate };
  // The steps Rust reports as they happen (`os-step`): what Tony sent an agent and what came back
  // still reach the chat when the turn then fails or is cut.
  const liveSteps: OsTurnResult["steps"] = [];
  const offSteps = await onNativeEvent<{ streamId: string; index: number; step: OsTurnResult["steps"][number] }>("os-step", (e) => {
    if (e.streamId === streamId && Number.isInteger(e.index) && e.index >= 0 && e.index < 64) liveSteps[e.index] = e.step;
  });
  const osName = useSettings.getState().osName || "Tony";
  // Inter-agent dialogue: delegation lives in that agent's own tab. Tony's thread stays a clean
  // Nic↔Tony transcript (U3): tool / step-in relays go to the agent's tab or the System Map
  // trace only (`relayThreadFor`), and a Tony → Tony relay is never pushed anywhere.
  const renderSteps = (steps: OsTurnResult["steps"], finalRole: AgentRole, finalExplicit: boolean) => {
    const relayThread: ThreadId = finalExplicit ? thread : finalRole === "general" ? thread : finalRole;
    for (const s of steps) {
      if (!s) continue;
      if (finalExplicit && s.kind === "delegate") continue; // you're already talking to it directly
      if (finalExplicit && s.kind === "reply") continue; // shown as the answer below
      let target: ThreadId | null;
      if (isSubAgentThread(thread)) {
        // Typed on a sub-agent tab: that tab is the agent's own log, as before.
        const inAgentTab = s.kind === "delegate" || s.kind === "reply" || (s.kind === "error" && s.from === finalRole);
        target = isSelfRelay(s, osName) ? null : inAgentTab ? relayThread : thread;
      } else target = relayThreadFor(s, { finalRole, relayThread, tonyThread: thread, osName });
      if (!target) continue;
      store().pushTurn({ who: "relay", text: s.text, from: s.from, to: s.to, tone: s.ok ? undefined : "warn", meta: s.ms ? `${s.kind} · ${s.ms}ms` : s.kind, thread: target });
    }
    return relayThread;
  };
  let r: OsTurnResult | null;
  try {
    const call = (approved: boolean) => cmd("os_turn", { req: { ...req, approved } });
    // An approved Tier-3 hand-off was already approved on its card (`approve()`): no second card.
    // That card named the `delegation` scope only, so it satisfies the delegation gate alone
    // (`delegationApproved`); Ask-tier tools the turn prefetches stay unapproved (never `approved`).
    // Otherwise the delegation gate's card lands in this thread, is spoken on a voice turn, and
    // never posts the answer itself (this function does, once, as the right speaker).
    r = plan.delegateTo
      ? await cmd("os_turn", { req: { ...req, approved: false, delegationApproved: true } })
      : await gated({ action: "os-turn", summary: `Let ${useSettings.getState().osName} use ${role === "general" ? "its tools" : SUB_AGENTS[role].label}`, detail: { role }, channel, thread, silent: true }, call, (x) => x.answer);
  } catch (e) {
    off();
    offAgent();
    offSteps();
    activeStreams.delete(streamId);
    // Whatever was asked / answered before it failed or was cut is part of the record.
    renderSteps(liveSteps, role, explicit);
    // "Cut it" dropped this turn server-side: no error, the partial bubble just stays.
    if (String(e instanceof Error ? e.message : e).includes(TURN_CANCELLED)) {
      if (live) store().updateTurn(live, { meta: "cut" });
      return;
    }
    if (live) store().updateTurn(live, { meta: "interrupted" });
    endIdleBargeIn();
    return fail(e, thread);
  }
  off();
  offAgent();
  offSteps();
  activeStreams.delete(streamId);
  if (!r) {
    endIdleBargeIn();
    store().setState("idle");
    return;
  }
  // D14: Rust held back a Spotify write for approval. Raise the card for exactly that call
  // (approve ⇒ `spotify_tool(name, args, approved: true)`, never this turn again).
  if (r.pendingSpotify) return pendingSpotifyReply(r, r.pendingSpotify, channel, thread, gen);

  // The Rust safety net (phone/inbox turns against the full config) may have
  // refined the role; fall back to what we already computed when it didn't.
  const finalRole = (r.routedRole as AgentRole) || role;
  const finalExplicit = explicit && finalRole === role;
  const relayThread = renderSteps(r.steps, finalRole, finalExplicit);
  const linked = r.delegatedTo && !finalExplicit && relayThread !== thread ? relayThread : undefined;
  const meta = [r.providerId, r.tool && `tool ${r.tool}`, r.redacted && "privacy-diffused", `${r.latencyMs}ms`].filter(Boolean).join(" · ");
  // The answer is the agent's only when the agent itself produced it: on an explicit tab where
  // the agent failed (or has no workspace) Tony answers, and it is labelled — and voiced — as Tony.
  const final = { text: r.answer, role: finalRole, meta, from: finalExplicit && answeredByAgent(r) ? finalRole : "os", link: linked, commsThread: r.commsThread };
  // Who the answer is spoken as: the sub-agent itself only for an explicit-tab
  // direct answer (`final.from` is the agent, not "os"); every Tony-synthesized
  // reply — delegated or his own — speaks as "general", matching `final.from`.
  const voiceAgent = final.from === "os" ? "general" : final.from;
  if (live) {
    // Relay steps were logged after the stream started; move the answer below them.
    store().updateTurn(live, { ...final, at: Date.now() });
    useVoice.setState((s) => ({ turns: [...s.turns.filter((t) => t.id !== live), ...s.turns.filter((t) => t.id === live)] }));
  } else store().pushTurn({ who: "agent", thread, ...final });
  clientTrace.ui(traceId, "reply shown");

  // Auto-switch: when this was delegated (not explicit) and the Agents
  // section is already what's on screen, land the user on the exchange
  // instead of leaving it behind a link pill. Never force-navigate into
  // Agents just to do this — a voice-only HUD just speaks, as it already does.
  // Typed turns only: a voice turn never moves the tab (it would make the next
  // voice turn's view a sub-agent's — voice stays in Tony's thread).
  if (channel === "text" && !finalExplicit && relayThread !== thread && routingCfg.autoSwitch && useNav.getState().section === "agents") {
    store().setActiveThread(relayThread);
  }
  if (!isLive()) return;
  if (channel === "voice") {
    if (handoff) {
      // Replies the event didn't already deliver (e.g. a Librarian comms quote) speak now, in order.
      for (const s of r.steps) if (s.kind === "reply" && s.ok && s.from !== "os") queueAgentReply(s.from, s.text.replace(/\n\nSources: [\s\S]*$/, ""));
      if (!spokenReplies.size) {
        // No agent answered (it failed and Tony stepped in): his answer is the reply — in his
        // own voice, after the intro, never silently in place of an agent's voice.
        const answer = r.answer;
        store().setState("speaking");
        startBargeIn();
        speakQ = speakQ.then(() => sayLive(answer, { agent: "general", utteranceId: uttFor("general") }));
      }
      await speakQ;
      return afterVoiceReply(gen);
    }
    if (spokenUpTo > 0) {
      // Already speaking sentence-by-sentence, in whichever voice streamed
      // (`streamAgent` — Tony's or, for an explicit-tab turn, the sub-agent's
      // own): queue whatever is left, then wait.
      const rest = r.answer.slice(spokenUpTo).trim();
      if (rest) {
        const restOpts = { agent: streamAgent, previousText: lastSpokenChunk, utteranceId: uttFor(streamAgent) };
        tts.prefetch?.(rest, restOpts);
        speakQ = speakQ.then(() => sayLive(rest, restOpts));
      }
      await speakQ;
    } else {
      store().setState("speaking");
      startBargeIn();
      introOnce(voiceAgent);
      await speakQ;
      await say(r.answer, { agent: voiceAgent, traceId, utteranceId: uttFor(voiceAgent) });
    }
    return afterVoiceReply(gen);
  }
  // Typed turn: silent unless this agent's roster entry has auto-speak on
  // (Part 3) — a voice turn always speaks (above); a typed one only opts in.
  if (isTauri() && agentAutoSpeak(voiceAgent)) {
    store().setState("speaking");
    if (handoffCue) await handoffCue.done; // never talk over (or get cut by) the hand-off beats
    await say(r.answer, { agent: voiceAgent, traceId, utteranceId: uttFor(voiceAgent) });
    if (store().state === "speaking") store().setState("idle");
    return;
  }
  if (store().state === "speaking" || store().state === "thinking") store().setState("idle");
}

/** osRun's `pendingSpotify` branch: show Rust's answer (normally ""), raise the card, and show /
 * speak the reply like a fast-path one. On voice the card speaks its own read-back instead. */
async function pendingSpotifyReply(r: OsTurnResult, p: NonNullable<OsTurnResult["pendingSpotify"]>, channel: Channel, thread: ThreadId, gen: number) {
  if (r.answer.trim()) store().pushTurn({ who: "agent", from: "os", text: r.answer, thread });
  endIdleBargeIn(); // the card's yes/no listen takes the mic
  const out = await runPendingSpotify(p, channel).catch(() => null);
  if (out?.reply) store().pushTurn({ who: "agent", from: "os", text: out.reply, thread, meta: "os-control" });
  if (gen !== micGen) return;
  store().setState(store().pending ? "confirming" : "idle");
  if (out?.reply && channel === "voice" && !out.card) {
    store().setState("speaking");
    startBargeIn();
    await say(out.reply);
    return afterVoiceReply(gen);
  }
}

/** "Ask Claude Overseer" on any message: second opinion on that exchange. */
export async function askOverseer(turn: VoiceTurn) {
  const thread = turn.thread;
  const turns = store().turns.filter((t) => t.thread === thread && (t.who === "user" || t.who === "agent"));
  const idx = turns.findIndex((t) => t.id === turn.id);
  const transcript: ChatMessage[] = turns.slice(Math.max(0, idx - 8), idx + 1).map((t) => ({ role: t.who === "user" ? "user" : "assistant", content: t.text }));
  const engine = useOs.getState().cfg?.overseer.engine ?? "claude-cli";
  store().pushTurn({ who: "relay", from: "os", to: "overseer", text: `Escalated for review (${engine})`, thread });
  store().setState("thinking");
  try {
    const r = await cmd("overseer_ask", {
      req: {
        question:
          turn.who === "agent"
            ? "Review the assistant's last answer. If it's wrong, incomplete or refused something it shouldn't have, give the correct answer or the exact next step."
            : `Answer this directly: ${turn.text}`,
        transcript,
        context: await liveContext(),
      },
    });
    store().pushTurn({ who: "agent", from: "overseer", text: r.answer, meta: `overseer · ${r.engine}${r.redacted ? " · privacy-diffused" : ""} · ${r.latencyMs}ms`, thread });
  } catch (e) {
    store().pushTurn({ who: "system", text: `Overseer: ${e instanceof Error ? e.message : String(e)}`, tone: "error", thread });
  }
  store().setState("idle");
}

// ── Hands-free wake word ────────────────────────────────────────────────────

const wake = { armed: false, timer: undefined as ReturnType<typeof setTimeout> | undefined };

/** Text after a wake word ("Hey, Tony, what's…" → "what's…"), "" for a bare wake word, null if none. */
export function afterWakeWord(text: string): string | null {
  return wakeCommand(text, useSettings.getState().wakeWords);
}

function rearmWake() {
  clearTimeout(wake.timer);
  if (!wake.armed || !stt || wakeHolds > 0 || !micEnabled()) return; // a held re-arm resumes on release
  wake.timer = setTimeout(() => {
    if (wakeHolds > 0 || !micEnabled()) return;
    // A passive re-arm's startListening cancels all TTS: wait out the narration line instead.
    if (narration.active) return rearmWake();
    const s = store().state;
    if (wake.armed && (s === "idle" || s === "error") && !store().pending) startListening({ silent: true, origin: "wake" });
    else if (wake.armed) rearmWake();
  }, 600);
}

/** Hands-free is only waiting for a wake word (nothing heard yet): another mic user may take over. */
export function isPassiveWakeListen(): boolean {
  return passiveListen && !heardSpeech && !convo.active && store().state === "listening";
}

/**
 * Hold hands-free re-arming off while another mic user (the System Map's note dictation)
 * records, so a wake listen can't reopen Tony's mic mid-note and hear it as a command.
 * Holding also drops a passive wake listen in progress; hands-free itself stays armed and
 * re-arms on the last release.
 */
export function holdWake(on: boolean) {
  if (on) {
    wakeHolds++;
    clearTimeout(wake.timer);
    if (isPassiveWakeListen()) {
      passiveListen = false;
      stt?.abort(); // fires no handlers
      setCueDuck("user", false);
      restoreDuck();
      store().setPartial("");
      store().setState("idle");
    }
    return;
  }
  wakeHolds = Math.max(0, wakeHolds - 1);
  if (wakeHolds === 0 && wake.armed) rearmWake();
}

/** Turn hands-free listening on/off (Settings → Voice, or the HUD). */
export function setWakeMode(on: boolean) {
  // The preference is kept either way (D7); a locked-off mic only suspends it.
  wake.armed = on && !!stt && micEnabled();
  useSettings.getState().set({ wakeMode: on });
  // Off = hard stop regardless of state: a barge-in listen opens the mic without ever setting
  // state to "listening", and a turn still in flight must not speak or reopen the mic after.
  if (wake.armed) rearmWake();
  else hardStopMic();
}

// ── Hard mic sovereignty (Phase 2 Part B) ────────────────────────────────────

/** The Mic switch (UI only, D5: nothing can hear "mic on" once the line is dead). */
export function setMicEnabled(on: boolean): Promise<boolean> {
  return requestMicEnabled(on);
}

/**
 * Locked off: everything that could reopen the mic stops. The captures themselves were already
 * stopped by the gate (before this runs); here hands-free is suspended (its preference kept), a
 * hold and a narration line end, any listen is dropped without transcribing, and the turn origin
 * resets so no barge-in / follow-up can follow a reply still in flight.
 */
export function lockDown() {
  wake.armed = false;
  clearTimeout(wake.timer);
  cancelNarration();
  abortConfirmListen();
  hardStopMic({ rearm: false });
  turnOrigin = "text";
}

onMicChange((on) => {
  if (!on) return lockDown();
  // Unlocked (or hydrated live at startup): hands-free comes back only if it is the preference.
  if (useSettings.getState().wakeMode) setWakeMode(true);
});

// Fail closed: the mic stays locked until the authoritative state is read (D3). Hands-free's
// startup arm is the listener above, once hydration finds the mic live.
void hydrateMic();
void syncThresholdFromOs();
// Phase 2 Part C: Tony's mode (Rust modes.json) — until it loads, Brainstorming (today's offer card).
void useModes.getState().load();

// A stop said during a cue's intro also cancels Tony's TTS (no import cycle: player.ts
// only holds the cancel function, it doesn't import the voice controller).
registerSpeechCancel(() => {
  cancelTts();
  releaseTtsDuck();
});

// Cue widgets speak with Tony's voice and can drop a prompt into the conversation.
// `voice` here is the cue's OWN explicit voice choice (tied to whichever engine it was
// picked from) — never routed through the agent roster, so `agentAutoSpeak`/the roster's
// "general" fallback never changes which engine a cue clip plays on.
registerCueIO(
  async (text, voice) => {
    store().setState("speaking");
    await say(text, { voice, noDuck: true });
    if (store().state === "speaking") store().setState("idle");
  },
  (text) => void handleInput(text, { channel: "text" }),
);

// The voice roster lives in providers.json, loaded only when Settings → Voice is
// opened; fetch it once up front too, so `agentAutoSpeak`/per-agent voices work for a
// session that never visits Settings. Settings' own `load()` keeps it fresh afterwards.
if (isTauri()) void useProviders.getState().load();

// Rust fell back from an agent's configured engine to a local one (offline, out of
// quota…) — surfaced here instead of only in the Rust console (`eprintln!`). P1: ONE
// compact amber line per reply / cooldown window (`fallbackNotice` dedupes; Rust's
// breaker already emits once per trip).
const fallbackSeen = new Map<string, number>();
void onNativeEvent<TtsFallbackEvent>("tts-fallback", (e) => {
  const text = fallbackNotice(e, fallbackSeen, Date.now());
  if (text) store().pushTurn({ who: "system", text, tone: "warn", thread: tonyThread() });
});

// ── Phase 2 reflexes: cut / hold / resume ─────────────────────────────────────
//
// `parseReflex` (pure, tested) decides; these act. The decision itself is a string parse
// (well under 15 ms once Whisper returns); what you *feel* is the duck on speech onset.

/** Hold-mode listening: long pauses allowed while you think out loud. */
const HOLD_LISTEN = { endSilenceMs: 4500, maxUtteranceMs: 120_000 };
const HOLD_TIMEOUT_MS = 90_000;

/** Speakers vs headset, as the reflexes and barge-in should treat it right now. */
function currentRoute() {
  return effectiveRoute(useSettings.getState().conversation.audioRoute, detectedRoute());
}

/** Tony or an agent has audio queued, or a turn is thinking / executing. */
function turnBusy(): boolean {
  const s = store().state;
  return sayDepth > 0 || activeStreams.size > 0 || s === "thinking" || s === "speaking";
}

function reflexCtx(): ReflexCtx {
  const busy = turnBusy();
  // Through open speakers his own "oh" can reach the mic; a paused (held) reply is silent.
  // So can a lyric from Spotify playing on this PC (ducked, still audible; a hold paused it).
  const audible = sayDepth > 0 && !hold.active;
  const speakers = currentRoute() === "speakers";
  return { busy, holding: hold.active, ttsAudible: speakers && audible, musicAudible: speakers && !hold.active && musicPlayingHere() };
}

/** Is there anything a cut would stop (a turn, a card, a hold, a cue)? */
function cutHasTarget(): boolean {
  return turnBusy() || !!store().pending || hold.active || cueRecentlyActive();
}

/**
 * Act on a parsed reflex heard in `line`. A cut that is more than a bare "cut it" / "stop"
 * ("Stop motion studio app, I want…", "let's cut that feature") is NOT a cut when nothing is
 * running: it's an ordinary line, and the caller carries on with it (returns false). Over a busy
 * turn it still cuts, and anything said after the cut phrase becomes the next turn (it used to be
 * dropped with no trace in the chat) — but only when the line was addressed to Tony. A bare
 * passive hands-free listen (no wake word: room audio, a TV, Tony's own echo) may cut, never start
 * a turn: the rest is shown, not run, so Nic can say it again to Tony.
 */
function takeReflex(r: NonNullable<Reflex>, line: string, o: { addressed?: boolean } = {}): boolean {
  if (r.kind === "cut" && !isBareCut(line)) {
    if (!cutHasTarget()) return false;
    killTurn();
    const rest = r.rest.trim();
    if (rest && o.addressed !== false) void handleInput(rest, { channel: "voice" });
    else if (rest) store().pushTurn({ who: "system", text: `Cut. Didn't run “${rest}” — it came without the wake word; say it to ${useSettings.getState().osName || "Tony"} if you meant it.` });
    return true;
  }
  applyReflex(r);
  return true;
}

function applyReflex(r: NonNullable<Reflex>) {
  convo.barged = false;
  clientTrace.phase(`reflex:${r.kind}`);
  switch (r.kind) {
    case "cut":
      return killTurn();
    case "hold":
      return enterHold(r.rest);
    case "resume":
      restoreDuck();
      return resumeHold();
    case "submit":
      restoreDuck();
      return submitHold(r.rest);
    case "standdown":
      return standDown("voice");
    default: {
      const never: never = r.kind;
      return never;
    }
  }
}

/**
 * "Take it easy" said to an idle Tony (P5, U8): disengage. Drops a hold, every stream, Tony's
 * speech and a pending card (silently — fail closed, never approved), turns hands-free OFF and
 * persists it, stops the mic and releases every duck — but never pauses Spotify (unlike a cut).
 * Then one short spoken line (voice only); nothing re-arms, no barge-in or follow-up listen.
 */
export function standDown(channel: Channel = "voice") {
  if (hold.active) {
    // Before any setState: the store keeps "holding" while `held` is set.
    releaseHeldMedia();
    clearHold();
  }
  cancelStreams();
  cancelTts();
  releaseTtsDuck();
  // Every music duck comes back now, even one a command restore was still holding (P4).
  restoreDuck({ force: true });
  if (store().pending) reject("stand-down", { silent: true });
  turnOrigin = "text"; // no barge-in / follow-up can reopen the mic
  setWakeMode(false); // wake.armed off, wakeMode:false persisted, hardStopMic (micGen++, unduck, idle)
  store().pushTurn({ who: "system", text: "Taking it easy, hands-free off.", tone: "ok", thread: tonyThread() });
  if (channel === "voice") void sayAck(standDownLine(), { listenAfter: false });
}

// ── Tier-1 acks (P5) ──────────────────────────────────────────────────────────

const FLAVOUR_KEY = "cc.voice.flavourAt";
/** When the gabagool flavour line was last said (ms), shared across sessions where storage allows. */
let flavourAt: number | null = (() => {
  try {
    const v = Number(localStorage.getItem(FLAVOUR_KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
})();

/** A cached one-line ack, plus — rarely, and only when no listen follows and no cue plays — the
 * flavour line (`maybeFlavour`). Both cached: a small fixed set costs no repeat synthesis. */
async function sayAck(line: string, o: { listenAfter: boolean }) {
  const seq = listenSeq;
  const gen = micGen;
  await say(line, { agent: "general", cache: true });
  const now = Date.now();
  // A mic opened while the ack played (a tap / hotkey right after a stand-down) is a listen that
  // follows: a spoken "gabagool" there would be transcribed as Nic's own line (U9).
  const s = store().state;
  const micOpened = seq !== listenSeq || gen !== micGen || s === "listening" || s === "transcribing";
  const extra = maybeFlavour({ now, lastAt: flavourAt, listenAfter: o.listenAfter || wake.armed || micOpened, cueActive: cueRecentlyActive(), rng: Math.random });
  if (!extra || !micEnabled()) return; // D6: no unsolicited flavour line while locked off
  flavourAt = now;
  try {
    localStorage.setItem(FLAVOUR_KEY, String(now));
  } catch {
    /* best-effort */
  }
  await say(extra, { agent: "general", cache: true });
}

/** A new command said over Tony: he stops and the old turn goes quiet (its bubble stays). */
function supersedeTurn() {
  micGen++;
  cancelTts();
  releaseTtsDuck();
}

/** Stop every os_turn still generating (its LLM / sub-agent streams) server-side. */
function cancelStreams() {
  for (const id of activeStreams) void cmd("os_turn_cancel", { streamId: id }).catch(() => undefined);
  activeStreams.clear();
}

/**
 * "Cut it" (Decision 1): everything stops — Tony and any sub-agent voice, the LLM / agent
 * streams server-side, a pending card (fail closed), the Gabagool theme and Spotify playback
 * (paused, never disconnected, never auto-resumed). No sentence after it: a soft blip only.
 */
export function killTurn() {
  cancelStreams();
  if (hold.active) {
    // A cut drops the held thought — never silently: what was held stays in the chat.
    const lost = hold.segments.join(" ").trim();
    if (lost) store().pushTurn({ who: "system", text: `Cut — the held thought was not sent: ${lost}`, tone: "warn", thread: tonyThread() });
    clearHold(); // whatever the hold paused stays stopped
  }
  cancelTts();
  releaseTtsDuck();
  restoreAfterPause(cutMedia()); // the speech duck comes back only once Spotify is paused
  if (store().pending) reject("cut", { silent: true });
  hardStopMic(); // micGen++ silences anything still thinking/streaming here; idle; re-arms hands-free
  void playCutCue();
}

/** The local acknowledgement for a cut: a 140 ms soft falling blip, never the LLM. */
async function playCutCue() {
  try {
    const ac = await audioContext();
    const t = ac.currentTime;
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(660, t);
    o.frequency.exponentialRampToValueAtTime(330, t + 0.12);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.05, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    o.connect(g).connect(ac.destination);
    o.start(t);
    o.stop(t + 0.16);
  } catch {
    /* silence is an acceptable acknowledgement */
  }
}

/** "Take it easy" (over a busy turn) / "whoa" / "madone" / "aspetta": pause (not cancel) whoever is speaking and collect your thought. */
function enterHold(rest: string) {
  if (!hold.active) {
    hold.active = true;
    hold.segments = [];
    // Pause first, then un-duck: the paused reply resumes at full volume.
    tts.pause?.();
    tts.duck?.(false);
    hold.media = holdMedia();
    restoreAfterPause(hold.media); // un-duck Spotify once paused, so a resume isn't at the duck level
    store().setHeld([]); // before setState: the store keeps "holding" while `held` is set
    store().setState("holding");
  }
  if (rest) addSegment(rest);
  bumpHoldDeadline();
  holdListen();
}

function addSegment(t: string) {
  hold.segments.push(t);
  store().setHeld([...hold.segments]);
}

function bumpHoldDeadline() {
  hold.deadline = Date.now() + HOLD_TIMEOUT_MS;
  clearTimeout(hold.timer);
  const check = () => {
    if (!hold.active) return;
    // Mid-utterance (you're still talking): wait for it.
    if ((hold.listening && heardSpeech) || Date.now() < hold.deadline) hold.timer = setTimeout(check, 1000);
    else holdTimeout();
  };
  hold.timer = setTimeout(check, HOLD_TIMEOUT_MS + 250);
}

function holdListen() {
  if (!hold.active || !stt || hold.listening || !micEnabled()) return;
  const left = hold.deadline - Date.now();
  if (left <= 0) return holdTimeout();
  hold.listening = true;
  heardSpeech = false;
  passiveListen = false;
  stt.start(
    {
      onPartial: (t) => store().setPartial(t),
      onPhase: (p) => {
        clientTrace.phase(p);
        if (p === "speech") {
          heardSpeech = true;
          lastUserSpeechAt = Date.now();
          bumpHoldDeadline();
        }
      },
      onFinal: (t) => {
        hold.listening = false;
        store().setPartial("");
        if (!hold.active) return;
        clientTrace.sttFinal(voiceCaps.sttName, !!t);
        if (t) return holdInput(t);
        if (Date.now() >= hold.deadline) return holdTimeout();
        holdListen();
      },
      onError: (e) => {
        hold.listening = false;
        clientTrace.sttError(voiceCaps.sttName, e);
        // A segment Nic spoke was lost: say so, so "go ahead" isn't sent without it unknowingly.
        if (hold.active && heardSpeech) store().pushTurn({ who: "system", text: `Missed that last part (${e}) — say it again.`, tone: "warn", thread: tonyThread() });
        if (hold.active) setTimeout(holdListen, 1000); // the 90 s timeout still bounds this
      },
    },
    { ...HOLD_LISTEN, maxSilenceStartMs: left },
  );
}

/** A line heard (or typed) while holding: a reflex, else one more held segment. */
function holdInput(t: string) {
  const r = parseReflex(t, reflexCtx());
  // While holding only a BARE cut cuts: "Stop button should be red" / "and cut that intro" are
  // part of the thought being held (a cut used to wipe every held segment).
  if (r && !(r.kind === "cut" && !isBareCut(t))) return applyReflex(r);
  addSegment(t);
  bumpHoldDeadline();
  holdListen();
}

/** Leave hold mode's own state (not the paused reply, the media or the mic). */
function clearHold() {
  hold.active = false;
  hold.segments = [];
  hold.listening = false;
  clearTimeout(hold.timer);
  store().setHeld(null);
  store().setPartial("");
}

/** Hold over: unpause only what the hold itself paused. */
function releaseHeldMedia() {
  const m = hold.media;
  hold.media = null;
  void m?.then(releaseMedia);
}

/**
 * Resume ("keep going", the HUD's Resume button). Nothing held → Tony (or the agent) restarts
 * the interrupted sentence and the music comes back. Something held → sent as one turn.
 */
export function resumeHold() {
  if (!hold.active) return;
  if (hold.segments.length) return submitHold("");
  releaseHeldMedia();
  clearHold();
  stt?.abort();
  tts.resume?.();
  if (sayDepth > 0) {
    store().setState("speaking");
    startBargeIn();
  } else if (activeStreams.size > 0) store().setState("thinking"); // speaks when the answer lands
  else {
    store().setState("idle");
    rearmWake();
  }
}

/** "Go ahead" / "that's it": drop the paused reply and send everything held as ONE new turn
 * (the thread already has the original request). The superseded reply's server stream is
 * dropped too — it would otherwise hold the model slot ahead of the new turn. */
function submitHold(rest: string) {
  if (rest) addSegment(rest);
  const text = hold.segments.join(" ").trim();
  cancelStreams();
  supersedeTurn();
  releaseHeldMedia();
  clearHold();
  stt?.abort();
  if (!text) {
    store().setState("idle");
    return rearmWake();
  }
  void handleInput(text, { channel: "voice" });
}

/** 90 s without speech: drop the paused audio quietly, keep the turns on screen, go idle. */
function holdTimeout() {
  if (!hold.active) return;
  const lost = hold.segments.join(" ").trim();
  supersedeTurn();
  releaseHeldMedia();
  clearHold();
  stt?.abort();
  if (lost) store().pushTurn({ who: "system", text: `Hold timed out (not sent): ${lost}`, tone: "warn", thread: tonyThread() });
  store().setState("idle");
  rearmWake();
}

/** Esc / mic button while holding (`stopVoice` does the rest). */
function endHold() {
  releaseHeldMedia();
  clearHold();
}

/** `os-agent-reply` (agents.rs): a delegated agent's answer the moment it lands. */
function onAgentReply(h: (e: { streamId: string; agent: string; text: string }) => void): Promise<() => void> {
  return onNativeEvent<{ streamId: string; agent: string; text: string }>("os-agent-reply", h);
}

if (isTauri()) void detectRoute();

// ── Part 6 narration: agent progress in each agent's roster voice, never over Nic or Tony ──

/** A narration line is playing; `gen` tells a cancelled line from a later one. */
const narration = { active: false, gen: 0 };

/** Speech onset (or any listen Nic opens) stops ONLY a narration line. No-op otherwise. */
function cancelNarration() {
  if (!narration.active) return;
  narration.active = false;
  narration.gen++;
  cancelTts();
}

/** Drop hands-free's silent wake listen (its open mic would hear the narration through the
 * speakers); `rearmWake` brings it back after the line. Same as `holdWake(true)` does. */
function dropPassiveListen() {
  passiveListen = false;
  stt?.abort(); // fires no handlers
  setCueDuck("user", false);
  restoreDuck();
  store().setPartial("");
  store().setState("idle");
}

/**
 * Speak one narration line in `agent`'s roster voice (`localOnly`: the local Kokoro engine, same
 * per-agent voice). Never through `osRun`'s speakQ and never a voice-state change: the narrator
 * only calls this when `narratorSnapshot()` says the room is quiet. Over open speakers a passive
 * wake listen is closed for the line and re-armed after it; on a headset it stays open and Nic's
 * speech onset cancels the line. Not cached: narration text is mostly one-off (the session pin
 * cache is unbounded).
 */
export async function narrate(text: string, agent: string, opts: { localOnly?: boolean } = {}): Promise<void> {
  if (!tts.supported || !text.trim() || !micEnabled()) return; // D6: no narration while the mic is locked off
  const passive = isPassiveWakeListen();
  const dropMic = passive && currentRoute() !== "headset";
  if (dropMic) dropPassiveListen();
  narration.active = true;
  const gen = ++narration.gen;
  try {
    await say(text, { agent, localOnly: opts.localOnly || undefined });
  } finally {
    if (narration.gen === gen) narration.active = false;
    if (dropMic && wake.armed) rearmWake();
  }
}

/** What the narrator's `canSpeak` needs from the controller right now. */
export function narratorSnapshot(): NarratorSnapshot {
  return {
    state: store().state,
    sayDepth,
    activeStreams: activeStreams.size,
    heardSpeech,
    holding: hold.active,
    pending: !!store().pending,
    passiveWake: isPassiveWakeListen(),
    lastUserSpeechAt,
    lastTtsEndAt,
  };
}

/** A narration line is playing now (tests, HUD). */
export const narrationActive = () => narration.active;

/** Tasks whose queueing Tony said himself (BUILD_QUEUED_LINE): the narrator skips their
 * `task_queued` row, so "Queued: <title>" isn't said a second time. Capped, oldest out. */
const announcedTasks = new Set<string>();
function markAnnounced(taskId: string | undefined) {
  if (!taskId) return;
  announcedTasks.add(taskId);
  if (announcedTasks.size > 100) announcedTasks.delete(announcedTasks.values().next().value as string);
}

/** Trace ids of the turn in flight: the announcer handoff already speaks its agents. */
function liveTraceIds(): ReadonlySet<string> {
  const ids = new Set<string>();
  if (clientTrace.id) ids.add(clientTrace.id);
  for (const s of activeStreams) ids.add(`stream:${s}`);
  return ids;
}

/** The desktop narrator (the phone gets no agent events; it asks for status instead). */
export const narrator = isTauri()
  ? startNarrator({
      narrate,
      snapshot: narratorSnapshot,
      cfg: () => useOs.getState().cfg,
      liveTraceIds,
      announcedTasks: () => announcedTasks,
      wakeWords: () => {
        const st = useSettings.getState();
        return [...(st.wakeWords ?? []), st.osName || "Tony", "tony", "jarvis"];
      },
      subscribe: (h) => onNativeEvent<AgentEvent>("agent-event", h),
    })
  : null;
