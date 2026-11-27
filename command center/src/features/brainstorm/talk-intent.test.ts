import { describe, expect, it } from "vitest";
import { norm } from "@/features/cues/gaba";
import { isCommitCue, parseDefer } from "@/features/dialogue/tier";
import { CUT, CUT_LEADING, EASE_MULTI, EASE_STANDALONE, HOLD_MULTI, HOLD_SINGLE, RESUME, SUBMIT, isBareCut, parseReflex } from "@/features/voice/reflex-parse";
import { END_TALK_PHRASES, WRAP_PHRASES, classifyTalkLine, isEndTalkPhrase, isWrapPhrase } from "./talk-intent";

const STATES = [
  { busy: false, holding: false },
  { busy: true, holding: false },
  { busy: false, holding: true },
  { busy: true, holding: true, ttsAudible: true },
];
const IDLE = { busy: false, holding: false, osName: "Tony" };

/** Spoken forms of the wrap phrases, as a person (and Whisper) writes them. */
const SPOKEN_WRAPS = [
  "Wrap it up.", "wrap it up", "Let's wrap up", "let's wrap it up, Tony", "Tony, wrap it up please",
  "Okay, let's wrap this up.", "End and wrap up", "end and wrap it up", "Time to wrap up.", "Can we wrap it up?",
  "Alright, wrap things up", "End the session and wrap up",
];

/** Every reflex and defer phrase the app knows, from the real tables. */
const REFLEX_PHRASES = [...CUT, ...CUT_LEADING, ...EASE_MULTI, ...EASE_STANDALONE, ...HOLD_MULTI, ...HOLD_SINGLE, ...RESUME, ...SUBMIT];
const DEFER_PHRASES = [
  "save it for later", "nah, save it for later", "park it", "shelve that idea", "save for later", "park for now",
  "put it in Play Place", "add this to the ideas and tasks ledger", "save that to the ledger for later",
  "add it to my brainstorming list", "keep that for another time", "stash it for later",
];

describe("wrap phrases never collide with reflex or defer phrases", () => {
  it("no wrap phrase (table or spoken) is a reflex in any state", () => {
    for (const p of [...WRAP_PHRASES, ...SPOKEN_WRAPS]) {
      for (const s of STATES) expect(parseReflex(p, s), `${p} ${JSON.stringify(s)}`).toBeNull();
      expect(isBareCut(p), p).toBe(false);
    }
  });
  it("no wrap phrase is a defer or a commit cue", () => {
    for (const p of [...WRAP_PHRASES, ...SPOKEN_WRAPS]) {
      expect(parseDefer(p, "Tony"), p).toBeNull();
      expect(isCommitCue(p, "Tony"), p).toBe(false);
    }
  });
  it("no reflex or defer phrase is a wrap or end-talk phrase", () => {
    for (const p of [...REFLEX_PHRASES, ...DEFER_PHRASES]) {
      expect(isWrapPhrase(p), p).toBe(false);
      expect(isEndTalkPhrase(`Tony, ${p}`), p).toBe(false);
    }
    for (const p of DEFER_PHRASES) expect(parseDefer(p, "Tony"), p).not.toBeNull(); // the fixtures are real defers
  });
  it("tables are written in norm() form and do not overlap", () => {
    for (const p of [...WRAP_PHRASES, ...END_TALK_PHRASES]) expect(norm(p)).toBe(p);
    const reflexNorm = new Set(REFLEX_PHRASES.map(norm));
    for (const p of [...WRAP_PHRASES, ...END_TALK_PHRASES]) expect(reflexNorm.has(p), p).toBe(false);
    expect(WRAP_PHRASES.filter((p) => END_TALK_PHRASES.includes(p))).toEqual([]);
  });
  it("no end-talk phrase starts with a stop or cut word", () => {
    for (const p of END_TALK_PHRASES) {
      expect(p.split(" ")[0]).not.toMatch(/^(stop|cut|shut)$/);
      for (const s of STATES) expect(parseReflex(`Tony, ${p}`, s), p).toBeNull();
    }
  });
});

describe("classifyTalkLine", () => {
  it("wrap phrases wrap (whole line only)", () => {
    for (const p of SPOKEN_WRAPS) expect(classifyTalkLine(p, IDLE), p).toEqual({ kind: "wrap" });
    for (const p of ["we should wrap up the login flow by Friday", "wrap it up in a nice bow for the demo", "I never wrap things up properly"]) {
      expect(classifyTalkLine(p, IDLE).kind, p).toBe("talk");
    }
  });
  it("end talk needs the name in front", () => {
    expect(classifyTalkLine("Tony, end talk", IDLE)).toEqual({ kind: "end_talk" });
    expect(classifyTalkLine("hey tony end talk mode please", IDLE)).toEqual({ kind: "end_talk" });
    expect(classifyTalkLine("Jarvis, end the talk", { ...IDLE, osName: "Jarvis" })).toEqual({ kind: "end_talk" });
    expect(classifyTalkLine("end talk", IDLE).kind).toBe("talk");
    expect(classifyTalkLine("I think we should end talk radio ads", IDLE).kind).toBe("talk");
  });
  it("reflexes run first", () => {
    expect(classifyTalkLine("cut it", IDLE)).toEqual({ kind: "reflex", reflex: { kind: "cut", rest: "" } });
    expect(classifyTalkLine("take it easy", { busy: true, holding: false })).toMatchObject({ kind: "reflex", reflex: { kind: "hold" } });
    expect(classifyTalkLine("madone", IDLE)).toMatchObject({ kind: "reflex", reflex: { kind: "hold" } });
  });
  it("command-looking lines become talk turns, not commands", () => {
    const lines = [
      "play devil's advocate for a second",
      "what if we queue a fix for the login bug",
      "play some Drake on Spotify",
      "open the settings page",
      "tell the coder to refactor the router",
      "send Sam a text saying I'm late",
      "turn the volume up",
      "save it for later",
      "put it in Play Place",
      "ok let's do it",
      "build me a weather widget",
      "delete all my notes",
      "approve all of them",
    ];
    for (const l of lines) for (const s of STATES) expect(classifyTalkLine(l, { ...s, osName: "Tony" }), `${l} ${JSON.stringify(s)}`).toEqual({ kind: "talk", text: l });
  });
  it("resume and submit lines are talk turns in every state, holding included", () => {
    const lines = [
      "go ahead and text Sam I'm late",
      "send it to the coder",
      "run that build",
      "keep going",
      "go ahead",
      "that's it",
      "over to you, delete the logs",
      "continue",
    ];
    for (const l of lines) for (const s of STATES) expect(classifyTalkLine(l, { ...s, osName: "Tony" }), `${l} ${JSON.stringify(s)}`).toEqual({ kind: "talk", text: l });
  });
  it("only a bare stop is a cut; thinking aloud that starts with stop is a talk turn", () => {
    for (const s of STATES) {
      const ctx = { ...s, osName: "Tony" };
      for (const l of ["stop motion would be cool for the trailer", "Stop the timer", "stop, what's next?", "shut it down for the winter, the old site"]) {
        expect(classifyTalkLine(l, ctx), `${l} ${JSON.stringify(s)}`).toEqual({ kind: "talk", text: l });
      }
      for (const l of ["stop", "Stop.", "Tony, stop", "stop please", "shut it off"]) {
        expect(classifyTalkLine(l, ctx), `${l} ${JSON.stringify(s)}`).toMatchObject({ kind: "reflex", reflex: { kind: "cut", rest: "" } });
      }
    }
  });
  it("blank lines are empty, never a talk turn", () => {
    for (const l of ["", "   ", "\n\t "]) for (const s of STATES) expect(classifyTalkLine(l, { ...s, osName: "Tony" })).toEqual({ kind: "empty" });
  });
  it("never returns a resume or submit reflex", () => {
    for (const p of [...REFLEX_PHRASES, ...SUBMIT.map((x) => `${x} and send Sam a text`)]) {
      for (const s of STATES) {
        const r = classifyTalkLine(p, { ...s, osName: "Tony" });
        if (r.kind === "reflex") expect(["cut", "hold", "standdown"], `${p} ${JSON.stringify(s)}`).toContain(r.reflex.kind);
      }
    }
  });
  it("trims the talk text and keeps the words verbatim", () => {
    expect(classifyTalkLine("  what if <b>it</b> glowed  ", IDLE)).toEqual({ kind: "talk", text: "what if <b>it</b> glowed" });
  });
});
