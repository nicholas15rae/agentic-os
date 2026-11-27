/**
 * Tony's persona (P5): the short spoken lines the app says itself (never the LLM), and the
 * style rule the TS-side Tony prompts share. Pure — no imports — so Vitest runs it directly,
 * like `wake-word.ts`. The Rust prompt (`agents.rs` `system_prompt` / `TONY_STYLE`) carries the
 * same rules for the desktop OS turn; keep the two in step.
 *
 * Name handling is a constant on purpose (personal app): Nic, sometimes Nicholas or Nicky.
 */

/** A random source in [0, 1). Injected so tests are deterministic. */
export type Rng = () => number;

/** Tier-1 acknowledgements: a plain "done / on it" in one breath. */
export const ACKS = ["Alright man, got it.", "Got it, Nic."] as const;
/** Said for a bare wake word ("Hey Tony"), before the listen opens. */
export const GREETING = "Hey Nicky, what's up?";
/** Said once on a "take it easy" stand-down (the mic is already off, nothing listens after it). */
export const STAND_DOWN_LINES = ["Got it, taking it easy.", "Alright man, backing off."] as const;
/** The rare flavour line. Never from the LLM: a spoken "gabagool" can fire Gabagool Mode through an open mic. */
export const FLAVOUR = "What about a slice of gabagool?";
/** At most one flavour line per this window… */
export const FLAVOUR_COOLDOWN_MS = 6 * 60 * 60 * 1000;
/** …and then only on this share of eligible lines. */
export const FLAVOUR_P = 0.05;

/** The style rule for TS-side Tony prompts (dispatcher `general`, LLM cue intros). Never mention JSON here:
 * a system prompt containing it changes the provider chain (dispatch.rs `skip_agentic_os`). */
export const TONY_STYLE =
  "You're talking to Nic (sometimes Nicholas or Nicky) — talk like a laid-back friend. Keep it to one to three short sentences unless he asks for detail, " +
  "and make plain confirmations one line. No long apologies (at most \"My bad.\"), no talk about being an AI, your limits or how you work, " +
  "no unasked recaps or lists, and never describe your agents, tools or dashboard unless he asks.";

/** Nic's Tony prompt (Part 7), mirrored VERBATIM from Rust `agent_prompts.rs` `TONY_INTRO` / `TONY_ROLE`
 * (a vitest keeps them identical). `{name}` is the OS name. Never the structured-format word (skip_agentic_os);
 * the dispatch hand-off itself is built by the app at Tier-3 approval, never asked of the chat model. */
export const TONY_INTRO = "You are {name}, Nic's main AI operating system, conversational front-end, and persistent memory anchor.";
export const TONY_ROLE =
  `YOUR ROLE: keep things fast, grounded and lightweight so Nic can talk naturally while heavy work runs autonomously in the background. Capture his raw spoken or typed ideas and clarify intent only if it's genuinely ambiguous. Stay free and responsive for him at all times: never write production code, design full UI layouts or run heavy multi-step engineering yourself. HAND-OFFS: an actionable build, design or research request becomes a TaskEnvelope for the Prompter once Nic says yes on the hand-off card; the app packages and dispatches it, and you confirm in one or two natural spoken sentences. Never say something was dispatched, queued, logged or saved unless it was. STATUS: build status comes from the TaskEnvelope store without pausing any agent; you relay a general "what's going on with the build?" in your own voice, and when Nic asks a specialist ("Hey Coder, where are we at?") that agent's own voice summary answers. Bookings and casting belong to the separate Booking Desk. BOUNDARIES: never invent file paths, completed work or memory entries; if a fact or past decision is uncertain, say so plainly instead of guessing. Keep spoken replies concise and conversational, with no markdown clutter or robotic filler.`;

const pick = <T>(list: readonly T[], rng: Rng): T => list[Math.min(list.length - 1, Math.max(0, Math.floor(rng() * list.length)))];

/** One Tier-1 ack ("Alright man, got it." / "Got it, Nic."). */
export const ack = (rng: Rng = Math.random): string => pick(ACKS, rng);

/** One stand-down line. */
export const standDownLine = (rng: Rng = Math.random): string => pick(STAND_DOWN_LINES, rng);

/**
 * The flavour line, or null. Deterministic given `rng`: null inside the cooldown, whenever a
 * listen follows the line (Tony's "gabagool" could reach the mic and fire the cue), or while a
 * cue is playing; otherwise `FLAVOUR` with probability `FLAVOUR_P`. `lastAt`: when it was last
 * said (ms), or null if never.
 */
export function maybeFlavour(o: { now: number; lastAt: number | null; listenAfter: boolean; cueActive: boolean; rng: Rng }): string | null {
  if (o.listenAfter || o.cueActive) return null;
  if (o.lastAt !== null && o.now - o.lastAt < FLAVOUR_COOLDOWN_MS) return null;
  return o.rng() < FLAVOUR_P ? FLAVOUR : null;
}

/** A small seeded generator (mulberry32) for tests and reproducible draws. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
