import type { ChatMessage } from "@/lib/platform";

/**
 * Section 20.15: what one Overseer / help-desk review costs, roughly. Pure.
 *
 * ESTIMATES ONLY. US$ per million tokens at Anthropic's first-party API list prices as cached on
 * 2026-10-06; check claude.com/pricing before relying on them. Through the Claude Code CLI on a
 * subscription a review is not billed per token: the figure is then the API-equivalent cost.
 */
export const CLAUDE_PRICES_PER_MTOK: Readonly<Record<string, { input: number; output: number }>> = {
  "claude-fable-5-1": { input: 10, output: 50 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};
/** A model id the table doesn't know is priced as the Overseer's default. */
export const DEFAULT_PRICED_MODEL = "claude-opus-5-5";
/** A diagnosis (TITLE / WHAT HAPPENED / LIKELY CAUSE / SUGGESTED FIX) runs about this long. */
export const REVIEW_OUTPUT_TOKENS = 500;
/** `overseer_ask`'s own system prompt around the request (Rust agents.rs), in characters. */
const OVERSEER_SYSTEM_CHARS = 420;
/** It keeps the last 12 transcript messages and up to 2000 characters of dashboard context. */
const OVERSEER_TRANSCRIPT_MAX = 12;
const OVERSEER_CONTEXT_MAX = 2000;

/** ~chars / 4. */
export const tokensOf = (chars: number) => Math.ceil(Math.max(0, chars) / 4);

/** Characters `overseer_ask` sends for this request (system prompt + context + transcript + question). */
export function overseerChars(question: string, transcript: readonly ChatMessage[], context = ""): number {
  const turns = transcript.slice(-OVERSEER_TRANSCRIPT_MAX).reduce((n, m) => n + m.content.length, 0);
  return OVERSEER_SYSTEM_CHARS + Math.min(context.length, OVERSEER_CONTEXT_MAX) + turns + question.length;
}

/** Estimated US$ for one review sending `inputChars` characters to `model`. */
export function reviewCost(inputChars: number, model: string, outputTokens = REVIEW_OUTPUT_TOKENS): number {
  const p = CLAUDE_PRICES_PER_MTOK[model.trim()] ?? CLAUDE_PRICES_PER_MTOK[DEFAULT_PRICED_MODEL];
  return (tokensOf(inputChars) * p.input + outputTokens * p.output) / 1_000_000;
}

/** "~$0.02 per review" (cents, rounded up; under a cent says so). */
export function formatReviewCost(usd: number): string {
  if (usd < 0.01) return "<$0.01 per review";
  // Rounded to 1/100 of a cent first, so float noise (0.1 * 100 = 10.000…02) never adds a cent.
  return `~$${(Math.ceil(Math.round(usd * 10_000) / 100) / 100).toFixed(2)} per review`;
}
