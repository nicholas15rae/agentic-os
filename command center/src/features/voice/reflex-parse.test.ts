import { describe, expect, it } from "vitest";
import { listenTakesReflex, parseReflex } from "./reflex-parse";

const BUSY = { busy: true, holding: false };
const IDLE = { busy: false, holding: false };
const HOLDING = { busy: false, holding: true };

describe("parseReflex — required fixtures (said in a row, live)", () => {
  for (const said of ["Take it ease.", "Take it easy", "take it eas", "eh", "aye", "whoa", "oh", "madone", "aspetta", "Aspet", "aspett"]) {
    it(`"${said}" is a hold while busy`, () => {
      expect(parseReflex(said, BUSY)).toEqual({ kind: "hold", rest: "" });
    });
  }
});

describe("parseReflex — negatives", () => {
  it('"oh and add milk" (busy) is a normal command', () => expect(parseReflex("oh and add milk", BUSY)).toBeNull());
  it('"oh" (idle) is nothing', () => expect(parseReflex("oh", IDLE)).toBeNull());
  it('"go ahead and email Sam" (not holding) is a normal command', () => expect(parseReflex("go ahead and email Sam", BUSY)).toBeNull());
  it('"take it easy on the bass" (busy) holds with the rest as the first segment', () => {
    expect(parseReflex("take it easy on the bass", BUSY)).toEqual({ kind: "hold", rest: "on the bass" });
  });
  it("idle questions starting with oh stay commands", () => expect(parseReflex("oh what's the weather", IDLE)).toBeNull());
  it("ordinary lines are not reflexes", () => {
    for (const s of ["what's the weather", "play Bilmuri on Spotify", "continue the music", "keep going", "send it to Sam"]) expect(parseReflex(s, IDLE)).toBeNull();
  });
  it("hey kitties is never a prefix", () => {
    for (const ctx of [IDLE, BUSY, HOLDING]) expect(parseReflex("hey kitties are cute", ctx)).toBeNull();
  });
});

describe("parseReflex — cut", () => {
  for (const s of ["Cut it.", "cut it out", "Cut that!", "cutit", "Yo Tony, cut it.", "Tony cut it", "stop talking", "stop, stop", "hey tony cut it", "okay cut it now"]) {
    it(`"${s}" cuts in every state`, () => {
      for (const ctx of [IDLE, BUSY, HOLDING, { busy: true, holding: false, ttsAudible: true }]) expect(parseReflex(s, ctx)?.kind).toBe("cut");
    });
  }
  it("a long line that starts with a cut phrase still cuts", () => {
    expect(parseReflex("cut it, I want to ask something else entirely", BUSY)).toEqual({ kind: "cut", rest: "I want to ask something else entirely" });
  });
  it("a long line with cut it in the middle is a command", () => {
    expect(parseReflex("tell the coder to cut it down to three paragraphs", BUSY)).toBeNull();
  });
});

describe("parseReflex — bare hard stops (standalone or leading only)", () => {
  for (const s of ["Stop.", "stop it", "Shut it off!", "shut it down", "shut off", "Tony, stop please", "hey Tony stop", "stop it now", "okay shut it off then", "please stop", "Please, shut it off."]) {
    it(`"${s}" on its own cuts in every state, flagged as needing the wake word in a room listen`, () => {
      for (const ctx of [IDLE, BUSY, HOLDING, { busy: true, holding: false, ttsAudible: true, musicAudible: true }]) {
        expect(parseReflex(s, ctx)).toEqual({ kind: "cut", rest: "", needsAddress: true });
      }
    });
  }
  for (const [s, rest] of [
    ["Stop, what's next?", "what's next?"],
    ["stop the timer", "the timer"],
    ["stop at the store", "at the store"],
    ["stop playing Bilmuri", "playing Bilmuri"],
    ["Tony, shut it off at 11", "at 11"],
    ["shut it down after this song", "after this song"],
    ["stop it from raining", "from raining"],
    ["hey Tony, stop and tell me the time", "tell me the time"],
    ["please stop the music", "the music"],
  ] as const) {
    it(`"${s}" starts with a hard stop, so it cuts (the rest is dropped with the turn)`, () => {
      for (const ctx of [IDLE, BUSY, HOLDING]) expect(parseReflex(s, ctx)).toEqual({ kind: "cut", rest, needsAddress: true });
    });
  }
  for (const s of [
    "don't stop the music", "please don't stop", "Don't stop.", "do not stop", "never stop", "I can't stop", "tell him to stop",
    "the bus will stop here", "when does the music stop", "don't shut it off", "don't shut it down yet", "can you shut it off at 11",
    "who's going to stop it", "make it stop", "stopping by later", "the stopwatch",
  ]) {
    it(`"${s}" is not a cut (mid-sentence or negated: falls through to the grammars / LLM)`, () => {
      for (const ctx of [IDLE, BUSY, HOLDING]) expect(parseReflex(s, ctx)).toBeNull();
    });
  }
  it("negated classic cut phrases are not cuts either", () => {
    for (const s of ["don't stop talking", "please don't stop talking", "don't cut it", "never cut it out", "you can't cut that"]) {
      for (const ctx of [IDLE, BUSY]) expect(parseReflex(s, ctx), s).toBeNull();
    }
  });
  it('an emphatic "no" is a lead word, not a negator', () => {
    for (const x of ["No, cut it!", "No, no, cut it.", "Tony no, cut it", "No! Stop talking!", "no stop talking", "please stop talking", "please stop stop"]) {
      for (const ctx of [IDLE, BUSY, HOLDING]) expect(parseReflex(x, ctx), x).toEqual({ kind: "cut", rest: "" });
    }
    for (const x of ["No, stop!", "No no, stop.", "no, shut it off"]) {
      for (const ctx of [IDLE, BUSY, HOLDING]) expect(parseReflex(x, ctx), x).toEqual({ kind: "cut", rest: "", needsAddress: true });
    }
    for (const x of ["no don't stop", "no, please don't stop the music", "no, never stop"]) expect(parseReflex(x, BUSY), x).toBeNull();
  });
  it("stop-phrases from the classic table are leading-only too", () => {
    expect(parseReflex("ok stop talking", BUSY)).toEqual({ kind: "cut", rest: "" });
    expect(parseReflex("why did you stop talking", BUSY)).toBeNull();
  });
  it("the classic cut phrases carry no wake-word requirement", () => {
    expect(parseReflex("cut it", IDLE)).toEqual({ kind: "cut", rest: "" });
    expect(parseReflex("stop talking", IDLE)?.needsAddress).toBeUndefined();
  });
  it("hey kitties stays a hold over a busy turn", () => expect(parseReflex("hey kitties", BUSY)).toEqual({ kind: "hold", rest: "" }));
});

describe("parseReflex — hold", () => {
  for (const s of ["madonna", "ma donna", "my donna", "mad one", "a spetta", "ah spet", "Madone!", "Aspetta, aspetta"]) {
    it(`"${s}" holds even when idle (thought-form lock)`, () => expect(parseReflex(s, IDLE)?.kind).toBe("hold"));
  }
  for (const s of ["take it ees", "take it knees", "take at ease", "take it is"]) {
    it(`"${s}" holds over a busy turn and while holding`, () => {
      expect(parseReflex(s, BUSY)).toEqual({ kind: "hold", rest: "" });
      expect(parseReflex(s, HOLDING)).toEqual({ kind: "hold", rest: "" });
    });
  }
  it("hey kitties (Whisper's take it ease) holds standalone", () => expect(parseReflex("Hey kitties.", BUSY)).toEqual({ kind: "hold", rest: "" }));
  it("thought-form lock keeps the rest as the first segment (idle + trailing content stays a hold)", () => {
    expect(parseReflex("Take it ease, I'm thinking about the tour dates.", IDLE)).toEqual({ kind: "hold", rest: "I'm thinking about the tour dates." });
    expect(parseReflex("take it easy, I'm thinking about the tour dates", IDLE)).toEqual({ kind: "hold", rest: "I'm thinking about the tour dates" });
    expect(parseReflex("take it easy on the bass", IDLE)).toEqual({ kind: "hold", rest: "on the bass" });
  });
  it("address words before a hold are skipped", () => expect(parseReflex("Hey Tony, take it easy", BUSY)).toEqual({ kind: "hold", rest: "" }));
  it("single syllables repeat", () => {
    expect(parseReflex("whoa whoa", BUSY)?.kind).toBe("hold");
    expect(parseReflex("Woah.", BUSY)?.kind).toBe("hold");
    expect(parseReflex("Ay, ay.", BUSY)?.kind).toBe("hold");
  });
  it("single syllables count while holding", () => expect(parseReflex("eh", HOLDING)?.kind).toBe("hold"));
  it("speakers mode: single syllables ignored while TTS is audible", () => {
    expect(parseReflex("oh", { busy: true, holding: false, ttsAudible: true })).toBeNull();
    expect(parseReflex("whoa", { busy: true, holding: false, ttsAudible: true })).toBeNull();
  });
  it("speakers mode: multi-word holds and cuts still count while audible", () => {
    const loud = { busy: true, holding: false, ttsAudible: true };
    expect(parseReflex("take it ease", loud)?.kind).toBe("hold");
    expect(parseReflex("take it easy", loud)?.kind).toBe("hold");
    expect(parseReflex("aspetta", loud)?.kind).toBe("hold");
    expect(parseReflex("cut it", loud)?.kind).toBe("cut");
  });
  it("speakers mode: single syllables ignored while Spotify is audible (a lyric's oh)", () => {
    const music = { busy: true, holding: false, musicAudible: true };
    expect(parseReflex("oh", music)).toBeNull();
    expect(parseReflex("eh eh", { busy: false, holding: true, musicAudible: true })).toBeNull();
    expect(parseReflex("take it ease", music)?.kind).toBe("hold");
    expect(parseReflex("cut it", music)?.kind).toBe("cut");
  });
  it("speakers mode: single syllables count while only thinking (not audible)", () => {
    expect(parseReflex("oh", { busy: true, holding: false, ttsAudible: false })?.kind).toBe("hold");
  });
});

describe("parseReflex — take it easy depends on context (P5)", () => {
  const FAMILY = ["take it easy", "Take it easy.", "Take it ease.", "take it eas", "take it ees", "take it knees", "take at ease", "take it is", "Hey kitties."];
  const ADDRESSED = ["Hey, take it easy", "hey take it easy", "Hey Tony, take it easy", "Tony, take it easy.", "yo tony take it easy", "okay take it easy", "please take it easy"];
  const TAILED = ["take it easy man", "Take it easy, Nic.", "take it easy nicky", "take it easy buddy", "take it easy now", "take it easy please", "Hey, take it easy, Tony."];
  for (const s of [...FAMILY, ...ADDRESSED, ...TAILED]) {
    it(`"${s}" stands down when idle / just listening`, () => expect(parseReflex(s, IDLE)).toEqual({ kind: "standdown", rest: "" }));
    it(`"${s}" is a hold over a busy turn (Tony talking or a turn thinking)`, () => expect(parseReflex(s, BUSY)).toEqual({ kind: "hold", rest: "" }));
    it(`"${s}" is a hold while already holding`, () => expect(parseReflex(s, HOLDING)).toEqual({ kind: "hold", rest: "" }));
  }
  it("busy + trailing content: hold with the rest as the first segment (unchanged)", () => {
    expect(parseReflex("take it easy on the bass", BUSY)).toEqual({ kind: "hold", rest: "on the bass" });
    expect(parseReflex("Hey Tony, take it easy, I want to change that", BUSY)).toEqual({ kind: "hold", rest: "I want to change that" });
  });
  it("never while Tony is audible (speakers mode): a hold instead", () => {
    expect(parseReflex("take it easy", { busy: false, holding: false, ttsAudible: true })).toEqual({ kind: "hold", rest: "" });
  });
  it("music playing doesn't change the parse (the passive-listen guard lives in listenTakesReflex)", () => {
    expect(parseReflex("hey, take it easy", { busy: false, holding: false, musicAudible: true })).toEqual({ kind: "standdown", rest: "" });
  });
  it("mid-sentence, negated or 'hey kitties' with more after it: not a stand-down", () => {
    for (const s of ["I take it easy on weekends", "don't take it easy", "Don't take it easy on them", "hey, don't take it easy", "you should take it easy", "never take it easy", "hey kitties are cute"]) {
      for (const ctx of [IDLE, BUSY]) expect(parseReflex(s, ctx), s).toBeNull();
    }
  });
  it("cut still wins over a line that also says take it easy", () => {
    for (const ctx of [IDLE, BUSY, HOLDING]) {
      expect(parseReflex("cut it, take it easy", ctx)?.kind).toBe("cut");
      expect(parseReflex("take it easy, cut it", ctx)?.kind).toBe("cut");
      expect(parseReflex("stop, take it easy", ctx)?.kind).toBe("cut");
    }
  });
  it("madone / aspetta / whoa / oh / eh / aye stay holds in every state they did before", () => {
    for (const s of ["madone", "aspetta", "Aspet"]) for (const ctx of [IDLE, BUSY, HOLDING]) expect(parseReflex(s, ctx)?.kind, s).toBe("hold");
    for (const s of ["whoa", "oh", "eh", "aye"]) {
      for (const ctx of [BUSY, HOLDING]) expect(parseReflex(s, ctx)?.kind, s).toBe("hold");
      expect(parseReflex(s, IDLE), s).toBeNull();
    }
  });
});

describe("parseReflex — resume / submit (holding only)", () => {
  for (const s of ["keep going", "Go on.", "continue", "carry on", "where were you", "you were saying", "okay keep going please"]) {
    it(`"${s}" resumes while holding`, () => {
      expect(parseReflex(s, HOLDING)).toEqual({ kind: "resume", rest: "" });
      expect(parseReflex(s, BUSY)).toBeNull();
    });
  }
  for (const s of ["go ahead", "Run that.", "over to you", "That's it.", "thats it", "send it"]) {
    it(`"${s}" submits while holding`, () => {
      expect(parseReflex(s, HOLDING)).toEqual({ kind: "submit", rest: "" });
      expect(parseReflex(s, IDLE)).toBeNull();
    });
  }
  it("submit with a trailing thought keeps it", () => {
    expect(parseReflex("go ahead and email Sam", HOLDING)).toEqual({ kind: "submit", rest: "email Sam" });
  });
  it("a held segment that merely mentions continuing is not a resume", () => {
    expect(parseReflex("continue with the second verse idea", HOLDING)).toBeNull();
  });
});

describe("listenTakesReflex — which listens act on a reflex", () => {
  const stop = parseReflex("stop", BUSY)!;
  const cutIt = parseReflex("cut it", BUSY)!;
  const whoa = parseReflex("whoa", BUSY)!;
  const room = { bare: true, busy: true, cueActive: false };
  it("a passive listen over a busy turn: a bare 'stop' (song lyric, room talk) needs the wake word", () => {
    expect(stop.needsAddress).toBe(true);
    expect(listenTakesReflex(stop, room)).toBe(false);
    expect(listenTakesReflex(cutIt, room)).toBe(true);
    expect(listenTakesReflex(whoa, room)).toBe(true);
    expect(listenTakesReflex(whoa, { ...room, busy: false })).toBe(false);
  });
  it("after the wake word (or a tapped listen) a bare 'stop' cuts", () => {
    expect(listenTakesReflex(stop, { bare: false, busy: false, cueActive: false })).toBe(true);
  });
  it("a yes/no listen keeps a bare 'stop' as its 'no'; 'cut it' still cuts", () => {
    const yesNo = { forConfirmation: true, bare: false, busy: true, cueActive: false };
    expect(listenTakesReflex(stop, yesNo)).toBe(false);
    expect(listenTakesReflex(cutIt, yesNo)).toBe(true);
    expect(listenTakesReflex(whoa, yesNo)).toBe(false);
  });
  it("a stand-down acts in a passive listen without the wake word, and in a yes/no listen", () => {
    const easy = parseReflex("hey, take it easy", IDLE)!;
    expect(easy.kind).toBe("standdown");
    expect(listenTakesReflex(easy, { bare: true, busy: false, cueActive: false })).toBe(true);
    expect(listenTakesReflex(easy, { bare: false, busy: false, cueActive: false })).toBe(true);
    expect(listenTakesReflex(easy, { forConfirmation: true, bare: false, busy: false, cueActive: false })).toBe(true);
    expect(listenTakesReflex(easy, { bare: true, busy: false, cueActive: true })).toBe(true);
  });
  it("never while Tony is audible", () => {
    const easy = parseReflex("take it easy", IDLE)!;
    expect(listenTakesReflex(easy, { bare: true, busy: false, cueActive: false, ttsAudible: true })).toBe(false);
    expect(listenTakesReflex(easy, { forConfirmation: true, bare: false, busy: false, cueActive: false, ttsAudible: true })).toBe(false);
  });
  it("while Spotify is audible here, a passive listen ignores it (a lyric); the wake word or a tapped mic still works", () => {
    const easy = parseReflex("take it easy", { busy: false, holding: false, musicAudible: true })!;
    expect(easy.kind).toBe("standdown");
    const music = { busy: false, cueActive: false, musicAudible: true };
    expect(listenTakesReflex(easy, { ...music, bare: true })).toBe(false);
    expect(listenTakesReflex(easy, { ...music, bare: false })).toBe(true);
    expect(listenTakesReflex(easy, { ...music, bare: false, forConfirmation: true })).toBe(true);
    expect(listenTakesReflex(easy, { bare: true, busy: false, cueActive: false, musicAudible: false })).toBe(true);
  });
  it("an idle thought-form lock in a passive listen still needs the wake word", () => {
    const lock = parseReflex("take it easy, I'm thinking about the tour dates", IDLE)!;
    expect(lock.kind).toBe("hold");
    expect(listenTakesReflex(lock, { bare: true, busy: false, cueActive: false })).toBe(false);
    expect(listenTakesReflex(lock, { bare: false, busy: false, cueActive: false })).toBe(true);
  });
  it("while a cue plays a bare 'stop' is the cue's own stop, not a cut", () => {
    expect(listenTakesReflex(stop, { bare: false, busy: false, cueActive: true })).toBe(false);
    expect(listenTakesReflex(cutIt, { bare: false, busy: false, cueActive: true })).toBe(true);
  });
});
