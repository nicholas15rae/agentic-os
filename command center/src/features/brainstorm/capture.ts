import { create } from "zustand";
import { cc, collections } from "@/lib/cc-api";
import { platform } from "@/lib/platform";
import { useSettings } from "@/stores/settings";
import { WebSpeechStt, WhisperStt, type SttEngine } from "@/features/voice/engines";
import { MIC_LOCKED_MSG, micEnabled, onMicChange } from "@/features/voice/mic-gate";
import { LISTEN_PROFILES } from "./listen-profiles";

export { LISTEN_PROFILES };

export interface BrainstormNote {
  title: string;
  titleLocked?: boolean;
  rawText: string;
  segments: { t: number; text: string; device: string }[];
  organized?: {
    title?: string;
    summary?: string;
    categories?: { name: string; bullets: string[] }[];
    actions?: { text: string; due?: string | null }[];
    tags?: string[];
  };
  organizedAt?: number;
  tags?: string[];
  /** Who made it: Listen Mode, or a Tony brainstorm parked with "save it for later" (P3). */
  source?: "listen" | "tony";
  summary?: string;
}

/**
 * Continuous "Brainstorm Listen Mode".
 *
 * Its own STT engine instance, deliberately separate from the voice
 * command pipeline: brain-dumps are captured verbatim and never dispatched
 * as commands. Each utterance is appended to the note in the shared store
 * as it's heard (so the phone and desktop see it live), and the local LLM
 * re-organizes every N segments and when you stop.
 */
interface CaptureState {
  noteId: string | null;
  listening: boolean;
  phase: "idle" | "waiting" | "speech" | "transcribing";
  sinceOrganize: number;
  organizing: boolean;
  error: string | null;
  start: (noteId?: string) => Promise<void>;
  stop: () => Promise<void>;
  /** Discard (not flush) the in-flight utterance and stop listening; nothing is appended or organized. */
  abort: () => void;
  /** Flush the current utterance and restart the loop with the (possibly just-changed) profile. No-op when not listening. */
  restartProfile: () => void;
  organize: (id?: string) => Promise<void>;
}

/** The engine listening right now (stop / abort / restartProfile act on it). */
let engine: SttEngine | null = null;
let probe: SttEngine | null = null;
/** Whisper (desktop) or Web Speech (phones), as one support probe. */
const getEngine = () => (probe ??= ((w) => (w.supported ? w : new WebSpeechStt()))(new WhisperStt()));
/** A fresh engine of the supported kind per listen: Whisper transcribes the last utterance on its
 * own engine while the next one already records (the mic is never closed for the round trip). */
const newEngine = (): SttEngine => (getEngine() instanceof WhisperStt ? new WhisperStt() : getEngine());

/** Resolves once the in-flight utterance (if any) has been transcribed and appended. `stop()` awaits this instead of discarding it. */
let pendingFinal: Promise<void> = Promise.resolve();
let resolvePendingFinal: (() => void) | null = null;
/** Appends land in spoken order, one after the other (transcriptions can overlap now). */
let appendChain: Promise<void> = Promise.resolve();
/** Phrases transcribed but not saved yet (the gateway blipped): saved with the next one that lands. */
let unsaved: { t: number; text: string }[] = [];
/** Continuous profile: one clip is cut and sent at most this often (Whisper's clip cap is ~8.7 min
 * and its call times out at 180 s), while recording carries straight on. */
export const CONTINUOUS_SEGMENT_MS = 90_000;
let segmentTimer: ReturnType<typeof setTimeout> | undefined;

/** Listen Mode holds Tony's hands-free wake listen (one mic, one listener): a brain-dump line that
 * starts with "Hey Tony" or a short "cut it" must never run as a command, nor be transcribed twice. */
let wakeHeld = false;
function holdTonyWake(on: boolean) {
  if (on === wakeHeld) return;
  wakeHeld = on;
  void import("@/features/voice/voice-controller").then((m) => m.holdWake(on)).catch(() => undefined);
}

export const useBrainstorm = create<CaptureState>((set, get) => ({
  noteId: null,
  listening: false,
  phase: "idle",
  sinceOrganize: 0,
  organizing: false,
  error: null,

  start: async (existing) => {
    if (!micEnabled()) return set({ error: MIC_LOCKED_MSG });
    const stt = getEngine();
    if (!stt.supported) return set({ error: "No speech-to-text available here (desktop needs Whisper; phones need Chrome)." });
    let id = existing ?? get().noteId;
    // Never reuse a note that was deleted meanwhile (a PATCH would bring it back holding only the
    // new phrase): a missing note means a new one.
    if (id && !(await noteExists(id))) id = null;
    if (!id) id = await newNote();
    set({ noteId: id, listening: true, error: null, sinceOrganize: 0 });
    holdTonyWake(true);
    loop(id);
  },

  stop: async () => {
    set({ listening: false, phase: "idle" });
    clearTimeout(segmentTimer);
    holdTonyWake(false);
    // Flush (not abort): transcribe whatever was captured since the last pause instead of
    // throwing it away, and wait for it (and every earlier phrase) to land before organizing.
    engine?.stop();
    await pendingFinal;
    await appendChain;
    const id = get().noteId;
    if (id && get().sinceOrganize > 0) await get().organize(id);
  },

  abort: () => {
    set({ listening: false, phase: "idle" });
    clearTimeout(segmentTimer);
    holdTonyWake(false);
    engine?.abort(); // calls no handlers: the last phrase is never transcribed
    resolvePendingFinal?.();
    resolvePendingFinal = null;
  },

  restartProfile: () => {
    // The in-flight onFinal handler re-invokes loop() with the freshly-read profile once it
    // resolves, as long as we're still listening — so flushing here is enough.
    if (get().listening) engine?.stop();
  },

  organize: async (id) => {
    const target = id ?? get().noteId;
    if (!target) return;
    set({ organizing: true, error: null });
    // Only the phrases this pass read are organized: ones appended while it ran still count.
    const read = get().sinceOrganize;
    try {
      await cc.organize(target);
      await collections.sync("notes");
      set({ sinceOrganize: Math.max(0, get().sinceOrganize - read) });
    } catch (e) {
      set({ error: `Organize: ${e instanceof Error ? e.message : e}` });
    } finally {
      set({ organizing: false });
    }
  },
}));

function loop(noteId: string) {
  const s = useBrainstorm.getState();
  if (!s.listening || s.noteId !== noteId || !micEnabled()) return;
  pendingFinal = new Promise<void>((resolve) => (resolvePendingFinal = resolve));
  let done = false;
  const resolveMine = resolvePendingFinal;
  const settle = () => {
    if (done) return;
    done = true;
    resolveMine?.();
    if (resolvePendingFinal === resolveMine) resolvePendingFinal = null;
  };
  // Re-arm exactly once per listen: right when the utterance ends (Whisper), else after it lands.
  let rearmed = false;
  const rearm = (ms: number) => {
    if (rearmed) return;
    rearmed = true;
    clearTimeout(segmentTimer);
    if (useBrainstorm.getState().listening) setTimeout(() => loop(noteId), ms);
  };
  const profile = useSettings.getState().brainstorm.listenProfile;
  const stt = newEngine();
  engine = stt;
  const overlap = stt instanceof WhisperStt;
  stt.start(
    {
      onPartial: () => undefined,
      onPhase: (phase) => {
        // A finished phrase being transcribed: the next listen starts NOW (its own engine), so
        // nothing said during the Whisper round trip and the note save is lost.
        if (phase === "transcribing" && overlap) {
          if (engine === stt) useBrainstorm.setState({ phase });
          return rearm(0);
        }
        if (engine === stt) useBrainstorm.setState({ phase });
      },
      onFinal: (text) => {
        const at = Date.now();
        const saved = text ? enqueueAppend(noteId, text, at) : appendChain;
        void saved.finally(() => {
          settle();
          // Keep listening until the user turns it off (or re-reads a just-changed profile).
          rearm(120);
        });
      },
      onError: (e) => {
        settle();
        useBrainstorm.setState({ error: e });
        rearm(1500);
      },
    },
    LISTEN_PROFILES[profile],
  );
  // Continuous: never one huge clip (it would exceed Whisper's limit and lose the whole session):
  // cut and transcribe on a cadence while the next segment records.
  if (profile === "continuous" && overlap) {
    clearTimeout(segmentTimer);
    segmentTimer = setTimeout(() => {
      if (engine === stt && useBrainstorm.getState().listening) stt.stop();
    }, CONTINUOUS_SEGMENT_MS);
  }
}

/** Queue one phrase's append behind the earlier ones (spoken order). Never rejects. */
function enqueueAppend(noteId: string, text: string, at: number): Promise<void> {
  appendChain = appendChain.then(() => appendSafe(noteId, text, at));
  return appendChain;
}

/** Append a phrase; a failed save keeps it (with any earlier unsaved ones) for the next try and
 * says so — the transcribed thought is never thrown away, and Listen Mode keeps listening. */
async function appendSafe(noteId: string, text: string, at: number): Promise<void> {
  unsaved.push({ t: at, text });
  const batch = unsaved;
  try {
    const id = await append(useBrainstorm.getState().noteId ?? noteId, batch);
    unsaved = unsaved.filter((u) => !batch.includes(u));
    if (id !== useBrainstorm.getState().noteId) useBrainstorm.setState({ noteId: id });
    if (useBrainstorm.getState().error?.startsWith("Couldn't save")) useBrainstorm.setState({ error: null });
  } catch (e) {
    useBrainstorm.setState({ error: `Couldn't save ${batch.length === 1 ? "that thought" : `${batch.length} thoughts`} yet (${e instanceof Error ? e.message : String(e)}) — kept, and saved with the next one` });
  }
}

// Phase 2 Part B: locking the mic ends Listen Mode at once. The phrase in flight is discarded,
// not flushed (flushing would send audio heard before the mute to Whisper).
onMicChange((on) => {
  if (on || !useBrainstorm.getState().listening) return;
  holdTonyWake(false);
  useBrainstorm.getState().abort();
  useBrainstorm.setState({ error: "Mic locked off: Listen Mode stopped (last phrase discarded)" });
});

const newNote = async () =>
  (
    await collections.create<BrainstormNote>("notes", {
      title: `Brainstorm · ${new Date().toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`,
      rawText: "",
      segments: [],
    })
  ).id;

/** Is the note still there (not deleted)? A sync failure counts as "yes" (don't fork a note offline). */
async function noteExists(id: string): Promise<boolean> {
  await collections.sync("notes");
  const snap = collections.snapshot<BrainstormNote>("notes");
  return snap.length === 0 || snap.some((n) => n.id === id);
}

/** Append phrases to the note. A note deleted meanwhile is never resurrected with only the new
 * phrase: a fresh note takes it (and Listen Mode moves to it). Returns the note id written. */
async function append(noteId: string, items: { t: number; text: string }[]): Promise<string> {
  await collections.sync("notes");
  const snap = collections.snapshot<BrainstormNote>("notes");
  let id = noteId;
  let note = snap.find((n) => n.id === noteId);
  if (!note && snap.length > 0) {
    id = await newNote();
    note = undefined;
    useBrainstorm.setState({ error: "That note was deleted — kept listening in a new one" });
  }
  const segments = [...(note?.segments ?? []), ...items.map((i) => ({ t: i.t, text: i.text, device: platform }))];
  await collections.update<BrainstormNote>("notes", id, {
    segments,
    rawText: segments.map((s) => s.text).join("\n"),
  });
  const n = useBrainstorm.getState().sinceOrganize + items.length;
  useBrainstorm.setState({ sinceOrganize: n });
  const every = useSettings.getState().brainstorm.autoOrganizeEvery;
  if (every > 0 && n >= every && !useBrainstorm.getState().organizing) void useBrainstorm.getState().organize(id);
  return id;
}
