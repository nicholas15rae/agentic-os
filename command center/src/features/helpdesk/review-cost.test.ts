import { describe, expect, it } from "vitest";
import { CLAUDE_PRICES_PER_MTOK, DEFAULT_PRICED_MODEL, formatReviewCost, overseerChars, REVIEW_OUTPUT_TOKENS, reviewCost, tokensOf } from "./review-cost";

describe("Overseer review cost estimate (Section 20.15)", () => {
  it("tokens are ~chars/4 and the price comes from the one table", () => {
    expect(tokensOf(4000)).toBe(1000);
    expect(tokensOf(1)).toBe(1);
    const p = CLAUDE_PRICES_PER_MTOK["claude-opus-5-5"];
    expect(reviewCost(4000, "claude-opus-5-5")).toBeCloseTo((1000 * p.input + REVIEW_OUTPUT_TOKENS * p.output) / 1e6, 10);
    // An unknown id is priced as the default model.
    expect(reviewCost(4000, "claude-made-up")).toBe(reviewCost(4000, DEFAULT_PRICED_MODEL));
    expect(reviewCost(4000, "claude-fable-5-1")).toBeGreaterThan(reviewCost(4000, "claude-sonnet-5-5"));
  });

  it("counts what overseer_ask sends: system prompt, clipped context, last 12 messages, question", () => {
    const msg = (n: number) => ({ role: "user" as const, content: "x".repeat(n) });
    const base = overseerChars("q", []);
    expect(overseerChars("q", [msg(100)])).toBe(base + 100);
    expect(overseerChars("q", Array.from({ length: 20 }, () => msg(10)))).toBe(base + 120);
    expect(overseerChars("q", [], "c".repeat(5000))).toBe(base + 2000);
  });

  it("formats as ~$0.0X per review", () => {
    expect(formatReviewCost(0.0161)).toBe("~$0.02 per review");
    expect(formatReviewCost(0.004)).toBe("<$0.01 per review");
    expect(formatReviewCost(0.1)).toBe("~$0.10 per review");
  });
});
