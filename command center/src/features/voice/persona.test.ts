import { describe, expect, it } from "vitest";
import { ACKS, ack, FLAVOUR, FLAVOUR_COOLDOWN_MS, GREETING, maybeFlavour, seededRng, STAND_DOWN_LINES, standDownLine, TONY_STYLE } from "./persona";
import { parseReflex } from "./reflex-parse";

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const HOUR = 60 * 60 * 1000;

describe("persona lines", () => {
  it("are the exact required strings", () => {
    expect([...ACKS]).toEqual(["Alright man, got it.", "Got it, Nic."]);
    expect(GREETING).toBe("Hey Nicky, what's up?");
    expect(FLAVOUR).toBe("What about a slice of gabagool?");
  });
  it("acks, greeting and stand-down lines are short (≤ 6 words)", () => {
    for (const s of [...ACKS, GREETING, ...STAND_DOWN_LINES]) expect(words(s), s).toBeLessThanOrEqual(6);
  });
  it("ack / standDownLine pick from their lists, deterministic for a given rng", () => {
    expect(ack(() => 0)).toBe(ACKS[0]);
    expect(ack(() => 0.99)).toBe(ACKS[1]);
    expect(ack(() => 1)).toBe(ACKS[1]); // clamped, never undefined
    expect(STAND_DOWN_LINES).toContain(standDownLine(seededRng(7)));
    expect(standDownLine(seededRng(7))).toBe(standDownLine(seededRng(7)));
  });
  it("none of Tony's own lines reads back as a reflex or a stand-down if the mic hears it", () => {
    for (const s of [...ACKS, GREETING, ...STAND_DOWN_LINES]) {
      for (const ctx of [{ busy: false, holding: false }, { busy: true, holding: false }]) expect(parseReflex(s, ctx), s).toBeNull();
    }
  });
  it("the TS style rule names Nic and never mentions json (skip_agentic_os)", () => {
    expect(TONY_STYLE).toContain("Nic (sometimes Nicholas or Nicky)");
    expect(TONY_STYLE).toContain("My bad.");
    expect(TONY_STYLE.toLowerCase()).not.toContain("json");
    expect(TONY_STYLE.toLowerCase()).not.toContain("gabagool");
  });
});

describe("maybeFlavour — rare, deterministic, never before a listen", () => {
  const base = { now: 100 * HOUR, lastAt: null as number | null, listenAfter: false, cueActive: false };
  it("never when a listen follows or a cue is active (even with a winning draw)", () => {
    expect(maybeFlavour({ ...base, listenAfter: true, rng: () => 0 })).toBeNull();
    expect(maybeFlavour({ ...base, cueActive: true, rng: () => 0 })).toBeNull();
  });
  it("never inside the 6 h cooldown", () => {
    expect(maybeFlavour({ ...base, lastAt: base.now - FLAVOUR_COOLDOWN_MS + 1, rng: () => 0 })).toBeNull();
    expect(maybeFlavour({ ...base, lastAt: base.now - FLAVOUR_COOLDOWN_MS, rng: () => 0 })).toBe(FLAVOUR);
  });
  it("only on a low draw (p ≈ 0.05)", () => {
    expect(maybeFlavour({ ...base, rng: () => 0.049 })).toBe(FLAVOUR);
    expect(maybeFlavour({ ...base, rng: () => 0.05 })).toBeNull();
    expect(maybeFlavour({ ...base, rng: () => 0.9 })).toBeNull();
  });
  it("same seed, same answers", () => {
    const run = () => {
      const rng = seededRng(42);
      return Array.from({ length: 50 }, () => maybeFlavour({ ...base, rng }));
    };
    expect(run()).toEqual(run());
  });
  it("over many eligible lines it stays rare (about 1 in 20, never more than 1 per 6 h)", () => {
    const rng = seededRng(1234);
    let hits = 0;
    for (let i = 0; i < 4000; i++) if (maybeFlavour({ ...base, rng })) hits++;
    expect(hits).toBeGreaterThan(120);
    expect(hits).toBeLessThan(290);
    // With the cooldown applied: one line per minute for a day → at most 4 (one per 6 h).
    const rng2 = seededRng(99);
    let lastAt: number | null = null;
    let said = 0;
    for (let t = 0; t < 24 * HOUR; t += 60_000) {
      if (maybeFlavour({ now: t, lastAt, listenAfter: false, cueActive: false, rng: rng2 })) {
        said++;
        lastAt = t;
      }
    }
    expect(said).toBeGreaterThan(0);
    expect(said).toBeLessThanOrEqual(4);
  });
});
