import { useEffect } from "react";
import { hydrateMic, micEnabled } from "@/features/voice/mic-gate";
import { collections, useCollection } from "@/lib/cc-api";
import { useNav, SECTIONS, type FixedSection } from "@/stores/nav";
import { useVoice, THREADS, type ThreadId } from "@/features/voice/voice-store";
import { useToasts } from "@/features/reminders/notify";
import { hasOnVerb, type OsIntent } from "@/features/os/os-intent-parse";
import type { SpotifyIntent } from "@/lib/platform";
import { cueIntroMigration, DEFAULT_CUES, type CueWidget } from "./types";
import { norm } from "./gaba";
import { cueGeneration, runCue, stopAllAudio, useCueRun } from "./player";
import { originalBuiltin, startupQueue, type LiveCue } from "./startup";
export { originalBuiltin, startupQueue } from "./startup";

/**
 * Cue triggers: voice/text phrase, time of day, app startup. The voice
 * controller registers Tony's TTS and the input handler here (no import cycle).
 */
type Speak = (text: string, voice?: string) => Promise<void>;
type Prompt = (text: string) => void;
let speak: Speak = async () => undefined;
let prompt: Prompt = () => undefined;
export const registerCueIO = (s: Speak, p: Prompt) => {
  speak = s;
  prompt = p;
};

/** Whisper hears "gabagool" a dozen ways (gaba gool, gobble, cabbage cool…): see gaba.ts. */
export { norm };

/** A cue whose phrase is in what the user said/typed ("hey tony, enter gabagool mode"). */
export function matchCue(text: string): (CueWidget & { id: string }) | null {
  const t = ` ${norm(text)} `;
  const cues = collections.snapshot<CueWidget>("cues").filter((c) => c.enabled && !c._deleted);
  // Longest phrase wins ("enter gabagool mode" before "gabagool").
  let best: { cue: CueWidget & { id: string }; len: number } | null = null;
  for (const c of cues) {
    for (const p of c.phrases) {
      const n = norm(p);
      if (n && t.includes(` ${n} `) && (!best || n.length > best.len)) best = { cue: c, len: n.length };
    }
  }
  return best?.cue ?? null;
}

/**
 * The cue a line should fire, given what the OS-intent parser and Spotify's grammar made of
 * it: a Gabagool-on phrase, a line both left alone, or a "play …" that didn't name Spotify
 * (`!spotify.explicit`) and is really a cue's phrase. A cue that is already running only
 * restarts on an ON verb, so "make the gabagool music louder" or "gabagool is great" never
 * replays the intro.
 */
export function cueFor(text: string, intent: OsIntent | null, spotify: SpotifyIntent | null = null): (CueWidget & { id: string }) | null {
  const playLine = spotify?.tool === "spotify.play" && !spotify.explicit;
  if ((intent && intent.kind !== "gabagool-on") || (spotify && !playLine)) return null;
  const cue = matchCue(text);
  if (!cue || (useCueRun.getState().cueId === cue.id && !hasOnVerb(text))) return null;
  return cue;
}

function runAction(w: CueWidget) {
  const { kind, value } = w.action;
  if (kind === "tab" && SECTIONS.some((s) => s.id === value)) useNav.getState().go(value as FixedSection);
  else if (kind === "thread" && THREADS.includes(value as ThreadId)) {
    useVoice.getState().setActiveThread(value as ThreadId);
    useNav.getState().go("agents");
  } else if (kind === "prompt" && value.trim()) prompt(value.trim());
}

const cueFailed = (w: CueWidget, e: unknown) => useToasts.getState().push({ title: `${w.name} couldn't play`, body: String(e), tone: "error" });

export function fireCue(w: CueWidget) {
  void runCue(w, speak, runAction).catch((e) => cueFailed(w, e));
}

/**
 * Play every enabled startup cue ONE AFTER ANOTHER (the built-in welcome first). Firing them
 * together made each `runCue` stop the one before it, so only the last survived. A cue the
 * user stops (or that anything else supersedes) ends the chain.
 */
export async function runStartupCues(cues: LiveCue[]) {
  const queue = startupQueue(cues);
  for (const c of queue) {
    const run = runCue(c, speak, runAction);
    const gen = cueGeneration(); // runCue bumps it synchronously before its first await
    try {
      await run;
    } catch (e) {
      cueFailed(c, e);
    }
    if (cueGeneration() !== gen) return;
  }
}

/** Toggle from the top-bar pill: stop if running, else start Gabagool Mode. */
export function toggleGabagool() {
  if (useCueRun.getState().running) return stopAllAudio();
  const w = originalBuiltin(collections.snapshot<LiveCue>("cues"), "gabagool");
  if (w) fireCue(w);
  else useToasts.getState().push({ title: "Gabagool Mode", body: "Set it up in Settings → Voice & Triggers.", tone: "info" });
}

/**
 * The Mode Panel / ModePill Gabagool switch (D19). Its state is "Gabagool is playing", so a tap
 * matches it: Gabagool playing → stop it; anything else playing (a startup / time-of-day cue) →
 * that one stops and Gabagool starts; nothing playing → Gabagool starts.
 */
export function toggleGabagoolMode() {
  const run = useCueRun.getState();
  if (run.running && run.builtin === "gabagool") return stopAllAudio();
  const w = originalBuiltin(collections.snapshot<LiveCue>("cues"), "gabagool");
  if (!w) return void useToasts.getState().push({ title: "Gabagool Mode", body: "Set it up in Settings → Voice & Triggers.", tone: "info" });
  if (run.running) stopAllAudio();
  fireCue(w);
}

const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

/** Seeds the built-in widgets, fires startup cues once, and runs the time-of-day schedule. */
export function useCueScheduler() {
  const { items, loaded, error, create, update } = useCollection<CueWidget>("cues");
  // Only a load that SUCCEEDED counts: a failed read (gateway down, the phone's token not loaded
  // yet) looks like an empty list, which re-seeded the defaults and ran startup with no cues.
  const ready = loaded && !error;

  useEffect(() => {
    if (!ready) return;
    for (const d of DEFAULT_CUES) if (!items.some((i) => i.builtin === d.builtin)) void create(d);
    // One-time upgrade of an untouched old default line (P5: the startup greeting).
    for (const i of items) {
      const intro = i._deleted ? null : cueIntroMigration(i);
      if (intro) void update(i.id, { intro }).catch(() => undefined);
    }
  }, [ready]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!ready) return;
    // The once-per-session flag is claimed only when the timer actually fires: React StrictMode
    // (dev) mounts → cleans up → mounts again, and a flag set up front made the second mount bail
    // while the first mount's timer had been cleared, so startup cues never played in dev.
    const t = setTimeout(() => {
      try {
        if (sessionStorage.getItem("cc.cues.startup") === "1") return;
        sessionStorage.setItem("cc.cues.startup", "1");
      } catch {
        /* private mode */
      }
      // Phase 2 Part B (D6): no unsolicited startup cue while the mic is locked off. Wait for
      // the authoritative read, so a slow hydration isn't mistaken for a locked mic.
      void hydrateMic().then(() => {
        if (micEnabled()) void runStartupCues(collections.snapshot<CueWidget>("cues"));
      });
    }, 2500);
    return () => clearTimeout(t);
  }, [ready]);

  useEffect(() => {
    const tick = () => {
      if (!micEnabled()) return; // D6: time-of-day cues stay quiet while the mic is locked off
      const now = new Date();
      const slot = `${now.toISOString().slice(0, 10)} ${hhmm(now)}`;
      for (const c of collections.snapshot<CueWidget & { id: string }>("cues")) {
        if (!c.enabled || c._deleted || !c.time || c.time !== hhmm(now) || c.lastFired === slot) continue;
        if (c.days.length && !c.days.includes(now.getDay())) continue;
        void update(c.id, { lastFired: slot });
        fireCue(c);
      }
    };
    const iv = setInterval(tick, 15_000);
    return () => clearInterval(iv);
  }, [update]);
}
