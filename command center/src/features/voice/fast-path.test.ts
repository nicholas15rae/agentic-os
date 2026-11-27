import { describe, expect, it } from "vitest";
import {
  BUILTIN_PHRASES,
  FAST_HANDLERS,
  FAST_REPLY_MAX,
  dateReply,
  isFastTarget,
  matchFastPath,
  normalizeFastPhrase,
  pendingReply,
  timeReply,
  validateFastCue,
  weatherReply,
  WEATHER_MAX_AGE_MS,
  type ValidateCtx,
} from "./fast-path";

const names = ["Tony", "hey tony", "yo tony"];
const on = { builtins: true, userCuesOn: true, userCues: [], names };

describe("normalizeFastPhrase", () => {
  it("drops wake, filler, politeness, punctuation; 'what is' → 'whats'", () => {
    expect(normalizeFastPhrase("Hey Tony, what's the time?", names)).toBe("whats the time");
    expect(normalizeFastPhrase("yo tony what is the weather like outside", names)).toBe("whats the weather like outside");
    expect(normalizeFastPhrase("Can you tell me what time it is, Tony?", names)).toBe("what time it is");
    expect(normalizeFastPhrase("What’s today’s date please", names)).toBe("whats todays date");
    expect(normalizeFastPhrase("  ok, so, WHAT'S PENDING!!  ", names)).toBe("whats pending");
  });
});

describe("matchFastPath: built-ins (whole line only)", () => {
  it.each([
    ["what time is it", "time"],
    ["What's the time?", "time"],
    ["hey tony, what time is it", "time"],
    ["what's the date today", "date"],
    ["what day is it", "date"],
    ["how's the weather", "weather"],
    ["what's the weather like", "weather"],
    ["how cold is it outside", "weather"],
    ["what reminders do I have", "pending"],
    ["any reminders, tony?", "pending"],
    ["what's on my to-do list", "pending"],
  ])("%s → %s", (line, handler) => {
    expect(matchFastPath(line, on)).toMatchObject({ handler, source: "builtin" });
  });

  it.each([
    "what time is it in Tokyo",
    "what's the weather tomorrow",
    "what time does the store close",
    "remind me what time it is in 10 minutes",
    "text Sam what time it is",
    "add what's pending to the calendar",
    "send the weather to Sam",
    "what's pending in the build",
    "buy the weather app",
    "stop",
    "",
  ])("falls through: %s", (line) => {
    expect(matchFastPath(line, on)).toBeNull();
  });

  it("built-ins off: nothing matches", () => {
    expect(matchFastPath("what time is it", { ...on, builtins: false })).toBeNull();
  });

  it("every built-in phrase is already normalised and maps to a known handler", () => {
    for (const [h, ps] of Object.entries(BUILTIN_PHRASES)) {
      expect(FAST_HANDLERS.some((x) => x.id === h)).toBe(true);
      for (const p of ps) expect(normalizeFastPhrase(p, names)).toBe(p);
    }
  });
});

describe("matchFastPath: user fast cues", () => {
  const userCues = [
    { id: "a", phrase: "lock in", target: "reply" as const, reply: "Locked in, Nic." },
    { id: "b", phrase: "my jam", target: "music.play" as const },
    { id: "c", phrase: "whats the time", target: "reply" as const, reply: "Time to get it." },
    { id: "d", phrase: "broken", target: "rm -rf" as never },
  ];
  it("matches a fixed reply and a handler; a user cue wins over the same built-in phrase", () => {
    expect(matchFastPath("Lock in!", { ...on, userCues })).toMatchObject({ handler: "reply", source: "user", cueId: "a", reply: "Locked in, Nic." });
    expect(matchFastPath("hey tony my jam", { ...on, userCues })).toMatchObject({ handler: "music.play", cueId: "b" });
    expect(matchFastPath("what's the time", { ...on, userCues })).toMatchObject({ handler: "reply", cueId: "c" });
  });
  it("user cues off, an unknown target, or extra words: no user match", () => {
    expect(matchFastPath("lock in", { ...on, userCues, userCuesOn: false })).toBeNull();
    expect(matchFastPath("broken", { ...on, userCues })).toBeNull();
    expect(matchFastPath("lock in the deal with Sam", { ...on, userCues })).toBeNull();
  });
});

describe("answers", () => {
  const at = new Date(2026, 10, 27, 15, 7);
  it("time and date", () => {
    expect(timeReply(at)).toBe("It's 3:07 PM.");
    expect(timeReply(new Date(2026, 10, 27, 0, 5))).toBe("It's 12:05 AM.");
    expect(timeReply(at, "h23")).toBe("It's 15:07.");
    expect(dateReply(at)).toBe("It's Friday, November 27th.");
    expect(dateReply(new Date(2026, 10, 1))).toBe("It's Sunday, November 1st.");
    expect(dateReply(new Date(2026, 10, 12))).toBe("It's Thursday, November 12th.");
  });

  it("weather: fresh reading only (stale or missing → null = fall through)", () => {
    const now = at.getTime();
    const w = { tempC: 3.6, windKph: 31, label: "Overcast", place: "Toronto", fetchedAt: now - 5 * 60_000 };
    expect(weatherReply(w, now)).toBe("It's 4 degrees and overcast in Toronto. Windy too, about 31 km/h.");
    expect(weatherReply({ ...w, windKph: 5, label: "—", place: "" }, now)).toBe("It's 4 degrees.");
    expect(weatherReply({ ...w, fetchedAt: now - WEATHER_MAX_AGE_MS - 1 }, now)).toBeNull();
    expect(weatherReply(null, now)).toBeNull();
    expect(weatherReply({ ...w, tempC: NaN }, now)).toBeNull();
  });

  it("what's pending: reminders + Finance; not loaded → null; Finance missing is said", () => {
    const now = at.getTime();
    const reminders = [
      { title: "Call Sam", kind: "reminder", dueAt: now + 60_000 },
      { title: "Audition", kind: "countdown", dueAt: now + 86_400_000 },
      { title: "Old", kind: "reminder", dueAt: now - 1000, firedAt: now - 500 },
      { title: "Gone", kind: "alarm", dueAt: now + 1000, dismissed: true },
      { title: "Past countdown", kind: "countdown", dueAt: now - 1000 },
      { title: "Gym", kind: "alarm", dueAt: now + 3_600_000 },
    ];
    const finance = [{ title: "Follow up on INV-12 · Acme", overdue: true }, { title: "Deposit 2 cheques", overdue: false }];
    expect(pendingReply({ reminders: null, finance, now })).toBeNull();
    expect(pendingReply({ reminders, finance, now })).toBe("You've got 3 reminders: call Sam, gym and 1 more. Money side, 2 things, 1 overdue. Top one: follow up on INV-12.");
    expect(pendingReply({ reminders: [], finance: [], now })).toBe("Nothing pending, Nic. You're clear.");
    expect(pendingReply({ reminders: [], finance: null, now })).toBe("No reminders pending. For money that's still owed, ask me what's pending.");
    // Money questions are never an instant cue (finance.ask reads the gateway's live data).
    for (const line of ["what's pending", "anything pending", "what's outstanding", "what's on my plate"]) expect(matchFastPath(line, { builtins: true, userCuesOn: true, userCues: [], names: ["Tony"] })).toBeNull();
  });
});

describe("validateFastCue", () => {
  const ctx: ValidateCtx = {
    existing: [{ id: "x", phrase: "lock in", target: "reply", reply: "ok" }],
    names,
    routingNames: [{ name: "coder", agent: "Coder" }, { name: "booking desk", agent: "Booking" }],
    cuePhrases: ["enter gabagool mode", "gabagool"],
  };
  const v = (phrase: string, target = "reply", reply = "Sure.") => validateFastCue({ phrase, target, reply }, ctx);

  it("a clean phrase passes and is normalised", () => {
    expect(v("Hey Tony, what's my vibe?")).toMatchObject({ ok: true, phrase: "whats my vibe", reply: "Sure.", errors: [], warnings: [] });
    expect(v("my jam", "music.play")).toMatchObject({ ok: true, reply: undefined });
  });

  it("errors: empty, only the name, too long, too many words, stop words, OS controls, duplicates, bad target, empty reply", () => {
    expect(v("").ok).toBe(false);
    expect(v("hey tony").ok).toBe(false);
    expect(v("a".repeat(90)).ok).toBe(false);
    expect(v("one two three four five six seven eight nine ten eleven twelve thirteen").ok).toBe(false);
    for (const stop of ["stop", "cut it", "take it easy", "hold on", "whoa", "yes", "go ahead", "send it"]) expect(v(stop).errors.join(" ")).toMatch(/stop \/ hold/);
    expect(v("turn on the kill switch").errors.join(" ")).toMatch(/OS control/);
    expect(v("kill switch").errors.join(" ")).toMatch(/OS control/);
    expect(v("lock it down").ok).toBe(false);
    expect(v("panic").errors.join(" ")).toMatch(/OS control/);
    // Review fix: stops that only count while a cue plays, and a card's yes / no, are refused too.
    for (const p of ["turn it off", "enough", "make it stop", "stop the music"]) expect(v(p, "mode.builder").ok, p).toBe(false);
    for (const p of ["scratch that", "negative", "proceed", "make it so"]) expect(v(p, "mode.builder").ok, p).toBe(false);
    expect(v("Lock in!").errors.join(" ")).toMatch(/Another fast cue/);
    expect(validateFastCue({ phrase: "lock in", target: "x" }, { ...ctx, existing: [] }).ok).toBe(false);
    expect(v("my vibe", "reply", "   ").ok).toBe(false);
  });

  it("the same cue edited is not its own duplicate", () => {
    expect(validateFastCue({ phrase: "lock in", target: "reply", reply: "ok" }, { ...ctx, selfId: "x" }).ok).toBe(true);
  });

  it("warnings: built-in collision, mode switch, routing names, cue widget phrases; reply capped", () => {
    expect(v("what time is it").warnings.join(" ")).toMatch(/built-in/);
    expect(v("builder mode", "time").warnings.join(" ")).toMatch(/switches modes/);
    expect(v("coder check in", "time").warnings.join(" ")).toMatch(/Coder/);
    expect(v("gabagool", "time").warnings.join(" ")).toMatch(/cue widget/);
    const long = v("my vibe", "reply", "x".repeat(400));
    expect(long.reply).toHaveLength(FAST_REPLY_MAX);
    expect(long.warnings.join(" ")).toMatch(/cut/);
  });

  it("fixed replies are text only (control characters stripped)", () => {
    expect(v("my vibe", "reply", "Line one\n\u0007two").reply).toBe("Line one two");
  });

  it("isFastTarget only accepts known handler ids", () => {
    expect(isFastTarget("time")).toBe(true);
    expect(isFastTarget("mode.builder")).toBe(true);
    expect(isFastTarget("reply")).toBe(true);
    expect(isFastTarget("spotify.play")).toBe(false);
    expect(isFastTarget(undefined)).toBe(false);
  });
});
