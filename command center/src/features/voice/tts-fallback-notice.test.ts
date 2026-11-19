import { describe, expect, it } from "vitest";
import type { TtsFallbackEvent } from "@/lib/platform";
import { NOTICE_MAX_CHARS, NOTICE_SEEN_CAP, fallbackNotice } from "./tts-fallback-notice";

const ev = (o: Partial<TtsFallbackEvent> = {}): TtsFallbackEvent => ({
  from: "elevenlabs",
  to: "kokoro",
  reason: "HTTP 400 · model does not support previous_text",
  status: 400,
  utteranceId: "turn-1-general",
  cooldownSecs: null,
  scope: "utterance",
  ...o,
});

describe("fallbackNotice", () => {
  it("N events for one reply → one notice", () => {
    const seen = new Map<string, number>();
    const out = Array.from({ length: 5 }, (_, i) => fallbackNotice(ev(), seen, 1000 + i));
    expect(out.filter(Boolean)).toEqual(["Voice → Kokoro for this reply (ElevenLabs HTTP 400)"]);
  });

  it("different replies get one notice each", () => {
    const seen = new Map<string, number>();
    expect(fallbackNotice(ev({ utteranceId: "a-general" }), seen, 0)).not.toBeNull();
    expect(fallbackNotice(ev({ utteranceId: "a-coder" }), seen, 1)).not.toBeNull();
    expect(fallbackNotice(ev({ utteranceId: "a-coder" }), seen, 2)).toBeNull();
  });

  it("no id: one notice per reason within 10 s, then again", () => {
    const seen = new Map<string, number>();
    const e = ev({ utteranceId: null, scope: "call" });
    expect(fallbackNotice(e, seen, 0)).toBe("Voice → Kokoro for this line (ElevenLabs HTTP 400)");
    expect(fallbackNotice(e, seen, 9_999)).toBeNull();
    expect(fallbackNotice(ev({ utteranceId: null, scope: "call", reason: "HTTP 401", status: 401 }), seen, 5_000)).not.toBeNull();
    expect(fallbackNotice(e, seen, 10_001)).not.toBeNull();
  });

  it("cooldown: one notice per window, and the replies it skips stay quiet", () => {
    const seen = new Map<string, number>();
    const cd = ev({ status: 429, reason: "HTTP 429", scope: "global", cooldownSecs: 60, utteranceId: "t1-general" });
    expect(fallbackNotice(cd, seen, 0)).toBe("ElevenLabs paused 60 s (HTTP 429), speaking with Kokoro");
    expect(fallbackNotice({ ...cd, utteranceId: "t2-general", cooldownSecs: 30 }, seen, 30_000)).toBeNull();
    // A skipped reply's own utterance-scope event inside the window: still quiet.
    expect(fallbackNotice(ev({ utteranceId: "t3-general", status: 429 }), seen, 40_000)).toBeNull();
    // After the window a new pause is a new notice.
    expect(fallbackNotice({ ...cd, utteranceId: "t4-general" }, seen, 61_000)).not.toBeNull();
  });

  it("a per-voice 402 pause names the voice and doesn't silence other voices' failures", () => {
    const seen = new Map<string, number>();
    const v = ev({ status: 402, reason: "HTTP 402", scope: "voice", cooldownSecs: 120, utteranceId: "t1-coder", cooldownKey: "vL1" });
    expect(fallbackNotice(v, seen, 0)).toBe("ElevenLabs voice paused 120 s (HTTP 402), speaking with Kokoro");
    expect(fallbackNotice({ ...v, utteranceId: "t2-coder" }, seen, 1_000)).toBeNull();
    expect(fallbackNotice(ev({ utteranceId: "t2-general" }), seen, 2_000)).not.toBeNull();
  });

  it("a second voice's 402 pause inside the first one's window still gets its own line", () => {
    // Fix pass: the key was `cd:voice` for every voice, so the Booking Desk's own pause (another
    // voice, its own Rust cooldown) was swallowed by the Coder's and it went Kokoro silently.
    const seen = new Map<string, number>();
    const l1 = ev({ status: 402, reason: "HTTP 402", scope: "voice", cooldownSecs: 120, utteranceId: "s1-coder", cooldownKey: "vL1" });
    const l2 = ev({ status: 402, reason: "HTTP 402", scope: "voice", cooldownSecs: 120, utteranceId: "s2-booking", cooldownKey: "vL2" });
    expect(fallbackNotice(l1, seen, 0)).toBe("ElevenLabs voice paused 120 s (HTTP 402), speaking with Kokoro");
    expect(fallbackNotice(l2, seen, 30_000)).toBe("ElevenLabs voice paused 120 s (HTTP 402), speaking with Kokoro");
    // Each voice's own re-emit inside its window stays one line.
    expect(fallbackNotice({ ...l1, utteranceId: "s3-coder" }, seen, 40_000)).toBeNull();
    expect(fallbackNotice({ ...l2, utteranceId: "s4-booking" }, seen, 40_000)).toBeNull();
  });

  it("a 404 / 5xx (scope 'call') says 'for this line' and doesn't use up the reply's one notice", () => {
    // Fix pass: Rust doesn't trip the reply on a 503, so the next sentences go back to
    // ElevenLabs; "for this reply" was wrong, and a later real trip lost its notice.
    const seen = new Map<string, number>();
    const call = ev({ status: 503, reason: "HTTP 503", scope: "call", utteranceId: "t1-general" });
    expect(fallbackNotice(call, seen, 0)).toBe("Voice → Kokoro for this line (ElevenLabs HTTP 503)");
    expect(fallbackNotice(call, seen, 1_000)).toBeNull(); // same reason within 10 s
    expect(fallbackNotice(ev({ utteranceId: "t1-general" }), seen, 2_000)).toBe("Voice → Kokoro for this reply (ElevenLabs HTTP 400)");
  });

  it("a reply announced by a cooldown notice gets no second line for itself", () => {
    const seen = new Map<string, number>();
    expect(fallbackNotice(ev({ status: 402, scope: "voice", cooldownSecs: 120 }), seen, 0)).not.toBeNull();
    expect(fallbackNotice(ev(), seen, 10)).toBeNull();
  });

  it("text is compact: ≤90 chars, includes the code, never the old wording or raw detail", () => {
    const seen = new Map<string, number>();
    const long = ev({ reason: `HTTP 400 · ${"x".repeat(200)}`, to: "some-very-long-local-provider-id" });
    const t = fallbackNotice(long, seen, 0)!;
    expect(t.length).toBeLessThanOrEqual(NOTICE_MAX_CHARS);
    expect(t).toContain("HTTP 400");
    expect(t).not.toContain("Voice fell back to");
    expect(t).not.toContain("xxx");
    expect(t).toContain("local voice");
  });

  it("a transport failure (no status) shows Rust's short reason", () => {
    const t = fallbackNotice(ev({ status: null, reason: "ElevenLabs timed out" }), new Map(), 0);
    expect(t).toBe("Voice → Kokoro for this reply (ElevenLabs timed out)");
  });

  it("caps the seen map", () => {
    const seen = new Map<string, number>();
    for (let i = 0; i < 200; i++) fallbackNotice(ev({ utteranceId: `u${i}` }), seen, i);
    expect(seen.size).toBeLessThanOrEqual(NOTICE_SEEN_CAP);
    // The newest reply is still deduped after the cap evicted older ones.
    expect(fallbackNotice(ev({ utteranceId: "u199" }), seen, 300)).toBeNull();
  });
});
