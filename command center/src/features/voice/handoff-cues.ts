import { create } from "zustand";
import { isTauri, native } from "@/lib/platform";
import defaultPool from "./handoff-cues.json";

/**
 * Phase 5 vocal handoff cues: when Tony delegates to a sub-agent, an ultra-short 3-beat spoken
 * exchange — Tony, the sub-agent (its own roster voice), Tony — over the existing TTS pipeline.
 *
 * - Fire-and-forget: the delegation is dispatched first and never waits on a cue (`withHandoff`).
 * - Never recaps the task: every line is templated from the pool (nicknames + agent name only).
 * - ≤ `maxSeconds` (default 5): only an exchange whose estimate fits is picked, and a beat that
 *   would start past the deadline is skipped.
 * - Cancelled cleanly by a barge-in, a stand-down or the hard mic shutoff (`isLive()` goes false:
 *   the voice controller's mic generation moved / the mic is locked) — the background job is not
 *   touched, only the remaining beats are dropped.
 * - The pool is an editable JSON file: `<app config dir>/handoff-cues.json` (seeded from the
 *   bundled `handoff-cues.json` on first use). Toggle: Settings `routing.vocalHandoffs`.
 */

export interface HandoffPool {
  version: number;
  maxSeconds: number;
  nicknames: { nic: string[]; tony: string[] };
  agentNames: Record<string, string>;
  tonyOpen: string[];
  agentReply: Record<string, string[]> & { default: string[] };
  tonyClose: string[];
}

export interface Beat {
  /** "general" = Tony's voice; else the sub-agent's roster role. */
  speaker: string;
  text: string;
}

export const DEFAULT_POOL = defaultPool as HandoffPool;
/** Lines longer than this are ignored (they could never fit the budget). */
export const LINE_MAX = 90;
/** Sub-agents that get a cue: Tony's crew. */
export const CUE_ROLES: readonly string[] = ["coder", "designer", "prompter", "librarian", "booking", "ops"];

/** Speech-time estimate: ~2.8 words/s (conversational TTS) plus a short gap per beat (pure). */
export function estimateSecs(beats: readonly Beat[]): number {
  return beats.reduce((t, b) => t + b.text.split(/\s+/).filter(Boolean).length / 2.8 + 0.2, 0);
}

const fill = (line: string, nic: string, tony: string, agent: string) => line.replace(/\{nic\}/g, nic).replace(/\{tony\}/g, tony).replace(/\{agent\}/g, agent);
const choose = <T,>(xs: readonly T[], rng: () => number): T => xs[Math.min(xs.length - 1, Math.floor(rng() * xs.length))];
const usable = (xs: readonly string[] | undefined) => (xs ?? []).filter((l) => typeof l === "string" && l.trim() && l.length <= LINE_MAX);

/** Pick one exchange for `role` that fits the time budget (pure given `rng`). Null for non-crew roles. */
export function pickExchange(pool: HandoffPool, role: string, rng: () => number = Math.random): Beat[] | null {
  if (!CUE_ROLES.includes(role)) return null;
  const open = usable(pool.tonyOpen);
  const reply = usable(pool.agentReply?.[role]).concat(usable(pool.agentReply?.default));
  const close = usable(pool.tonyClose);
  if (!open.length || !reply.length || !close.length) return null;
  const nics = pool.nicknames?.nic?.length ? pool.nicknames.nic : ["Nic"];
  const tonys = pool.nicknames?.tony?.length ? pool.nicknames.tony : ["Tone"];
  const agent = pool.agentNames?.[role] ?? role;
  const max = Math.min(Math.max(pool.maxSeconds || 5, 2), 5);
  const make = (o: string, r: string, c: string, nic: string, tony: string): Beat[] => [
    { speaker: "general", text: fill(o, nic, tony, agent) },
    { speaker: role, text: fill(r, nic, tony, agent) },
    { speaker: "general", text: fill(c, nic, tony, agent) },
  ];
  for (let i = 0; i < 12; i++) {
    const beats = make(choose(open, rng), choose(reply, rng), choose(close, rng), choose(nics, rng), choose(tonys, rng));
    if (estimateSecs(beats) <= max) return beats;
  }
  // Nothing random fit: the shortest line of each kind (the runtime deadline still applies).
  const shortest = (xs: string[]) => xs.reduce((a, b) => (b.split(/\s+/).length < a.split(/\s+/).length ? b : a));
  return make(shortest(open), shortest(reply), shortest(close), nics[0], tonys[0]);
}

export interface CueDeps {
  speak: (text: string, voice: string) => Promise<void>;
  prefetch?: (text: string, voice: string) => void;
  /** False once Nic barged in / stood Tony down / locked the mic: drop the remaining beats. */
  isLive: () => boolean;
  now?: () => number;
}

export type CueOutcome = "completed" | "cancelled" | "timeout";

export interface CueHandle {
  beats: Beat[];
  done: Promise<CueOutcome>;
  cancel: () => void;
}

/** Play the beats in order (never throws). Starts at once; callers never await it before dispatching. */
export function playExchange(beats: readonly Beat[], deps: CueDeps, maxSeconds = 5): CueHandle {
  const now = deps.now ?? (() => Date.now());
  const t0 = now();
  let cancelled = false;
  for (const b of beats) deps.prefetch?.(b.text, b.speaker);
  const done = (async (): Promise<CueOutcome> => {
    for (const b of beats) {
      if (cancelled || !deps.isLive()) return "cancelled";
      const left = maxSeconds * 1000 - (now() - t0);
      if (left < estimateSecs([b]) * 1000 * 0.6) return "timeout";
      try {
        await deps.speak(b.text, b.speaker);
      } catch {
        /* best effort: the routing chip still shows the hand-off */
      }
    }
    return cancelled || !deps.isLive() ? "cancelled" : "completed";
  })();
  return { beats: [...beats], done, cancel: () => void (cancelled = true) };
}

/**
 * Dispatch FIRST, then start the cue — the cue can never delay or block the job. Returns the
 * dispatch's own promise untouched (pure orchestration; tested with a never-ending cue).
 */
export function withHandoff<T>(dispatch: () => Promise<T>, startCue: () => CueHandle | null): { result: Promise<T>; cue: CueHandle | null } {
  const result = dispatch();
  let cue: CueHandle | null = null;
  try {
    cue = startCue();
  } catch {
    cue = null;
  }
  return { result, cue };
}

// ── Pool loading ──

let pool: HandoffPool = DEFAULT_POOL;
let loaded = false;

/** The editable pool from the app config dir (desktop), else the bundled default. Cached. */
export function loadPool(force = false): Promise<HandoffPool> {
  if (loaded && !force) return Promise.resolve(pool);
  loaded = true;
  try {
    if (!isTauri()) return Promise.resolve(pool);
  } catch {
    return Promise.resolve(pool);
  }
  let call: Promise<{ pool: HandoffPool; path: string }>;
  try {
    call = native<{ pool: HandoffPool; path: string }>("handoff_pool_get");
  } catch {
    return Promise.resolve(pool);
  }
  return call
    .then((r) => {
      pool = r.pool;
      useHandoffChip.setState({ poolPath: r.path });
      return pool;
    })
    .catch(() => pool);
}

export const currentPool = () => pool;

// ── Routing chip (shown with the cue ON, alone with it OFF) ──

export interface HandoffChip {
  to: string;
  voiced: boolean;
  at: number;
}

export const useHandoffChip = create<{ chip: HandoffChip | null; poolPath: string | null }>(() => ({ chip: null, poolPath: null }));

export function noteHandoff(to: string, voiced: boolean, at = Date.now()) {
  useHandoffChip.setState({ chip: { to, voiced, at } });
}
