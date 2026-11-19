/** Cue widgets: a trigger (phrase / time / startup) → Tony line + soundbite + theme music + OS action. */

export interface AudioClip {
  /** Gateway file id (uploaded once; trims never touch the file). */
  fileId: string;
  name: string;
  /** Seconds, read from the decoded audio. */
  duration: number;
  inPoint: number;
  outPoint: number;
  /** 0–300 % (above 100 boosts; the cue bus limiter keeps it from clipping hard). */
  volume: number;
  fadeInMs: number;
  fadeOutMs: number;
  loop: boolean;
}

export interface ThemeClip extends AudioClip {
  /** Duck under Tony's voice and the soundbite. */
  duck: boolean;
  /** Ducked level, 0–100 % (20–25 % sits nicely under speech). */
  duckLevel: number;
}

export type CueActionKind = "none" | "tab" | "thread" | "prompt";

export interface CueWidget {
  name: string;
  enabled: boolean;
  /** Voice / text phrases ("enter gabagool mode"). */
  phrases: string[];
  /** "HH:MM" 24h, or "" for no schedule. */
  time: string;
  /** 0 = Sunday … 6 = Saturday; empty = every day. */
  days: number[];
  startup: boolean;
  /**
   * The spoken line (text-to-speech). `voice` = a voice ID from the TTS engine (e.g. a
   * cloned ElevenLabs voice); empty = Tony's voice from Settings → Voice.
   */
  intro: { mode: "static" | "llm"; text: string; voice?: string; voiceLabel?: string };
  soundbite: AudioClip | null;
  theme: ThemeClip | null;
  action: { kind: CueActionKind; value: string };
  /** Last scheduled fire (YYYY-MM-DD HH:MM) so a time cue fires once per slot. */
  lastFired?: string;
  /** Built-in widgets can't be deleted (only disabled). */
  builtin?: "gabagool" | "startup";
}

export const newClip = (fileId: string, name: string, duration: number): AudioClip => ({
  fileId,
  name,
  duration,
  inPoint: 0,
  outPoint: Math.round(duration * 10) / 10,
  volume: 100,
  fadeInMs: 150,
  fadeOutMs: 400,
  loop: false,
});

/** The startup cue's line (P5 persona greeting). */
export const STARTUP_INTRO = "Hey Nicky, what's up?";
/** Earlier built-in default texts, by builtin id: a stored copy still holding one exactly is upgraded once. */
export const LEGACY_DEFAULT_INTROS: Partial<Record<NonNullable<CueWidget["builtin"]>, { from: string; to: string }>> = {
  startup: { from: "Command center online. What are we building today?", to: STARTUP_INTRO },
};

/**
 * The intro patch a stored built-in cue needs, or null. Only a text that is EXACTLY the old
 * default is replaced, so anything Nic edited himself survives.
 */
export function cueIntroMigration(c: Pick<CueWidget, "builtin" | "intro">): CueWidget["intro"] | null {
  const m = c.builtin ? LEGACY_DEFAULT_INTROS[c.builtin] : undefined;
  if (!m || c.intro?.text !== m.from) return null;
  return { ...c.intro, text: m.to };
}

export const DEFAULT_CUES: CueWidget[] = [
  {
    name: "Gabagool Mode",
    enabled: true,
    phrases: ["enter gabagool mode", "gabagool mode", "gabagool"],
    time: "",
    days: [],
    startup: false,
    intro: { mode: "static", text: "Entering Gabagool mode." },
    soundbite: null,
    theme: null,
    action: { kind: "none", value: "" },
    builtin: "gabagool",
  },
  {
    name: "Startup Welcome",
    enabled: true,
    phrases: [],
    time: "",
    days: [],
    startup: true,
    intro: { mode: "static", text: STARTUP_INTRO },
    soundbite: null,
    theme: null,
    action: { kind: "none", value: "" },
    builtin: "startup",
  },
];
