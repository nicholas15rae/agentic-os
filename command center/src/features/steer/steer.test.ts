import { beforeEach, describe, expect, it } from "vitest";
import { classifyIdea, pitchesFor, questionsFor, runnerUp, shortName, steerBrief, tagsFromAnswers, titleFor } from "./steer";
import { sanitizeTraits, tasteLine, topTraits, useTaste } from "./taste-store";

describe("UI fixes 4: which kind of build", () => {
  it.each([
    ["a little guy that cheers when I finish a task", "novelty"],
    ["a cute ghost mascot that pops up on my streaks", "novelty"],
    ["track my auditions and show this week's callbacks", "functional"],
    ["a countdown timer widget for my next shoot", "functional"],
    ["a portfolio website I can share with clients", "standalone"],
    ["a game for my nephew, its own app on his phone", "standalone"],
  ])("%s → %s", (idea, kind) => {
    expect(classifyIdea(idea).kind).toBe(kind);
  });

  it("no signal at all is a widget, with zero confidence", () => {
    const c = classifyIdea("hmm something");
    expect(c.kind).toBe("functional");
    expect(c.confidence).toBe(0);
  });

  it("names the words that decided it", () => {
    expect(classifyIdea("a cheeky mascot that pops up").reasons).toEqual(expect.arrayContaining(["mascot", "pops up", "cheeky"]));
  });

  it("a close second is offered", () => {
    const c = classifyIdea("a widget with a little character that reacts when I log a workout");
    expect(runnerUp(c)).not.toBeNull();
  });
});

describe("UI fixes 4: pitching and asking", () => {
  it("a widget with character in it gets the pop-up character pitch", () => {
    const idea = "a habit tracker widget with a cute frog";
    const c = classifyIdea(idea);
    expect(c.kind).toBe("functional");
    const p = pitchesFor(idea, c, null);
    expect(p[0].kind).toBe("functional");
    expect(p.some((x) => x.kind === "novelty" && /pop-up character/.test(x.text) && /\?$/.test(x.text))).toBe(true);
  });

  it("uses the taste profile in the pitch", () => {
    const p = pitchesFor("track my water", classifyIdea("track my water"), "You usually pick dark and rounded designs.");
    expect(p.at(-1)!.text).toMatch(/dark and rounded.*start there/);
  });

  it("a few sharp questions per kind, plus the feeling one for a very short idea", () => {
    expect(questionsFor("novelty", "a little guy that cheers when I finish things")).toHaveLength(3);
    expect(questionsFor("functional", "water tracker").map((q) => q.id)).toContain("feeling");
  });

  it("the brief carries the idea in Nic's words, the kind's rules, the answers and the taste", () => {
    const qs = questionsFor("novelty", "a little guy that cheers when I finish a task");
    const b = steerBrief("a little guy that cheers when I finish a task", "novelty", qs, { trigger: { choice: "When I finish something" }, personality: { choice: "Cheeky" } }, "You usually pick playful designs.");
    expect(b).toContain("Idea (Nic's words): a little guy that cheers when I finish a task");
    expect(b).toMatch(/Kind: Live character\..*never block clicks.*safety control.*reduced motion/s);
    expect(b).toContain("- What makes it pop up? When I finish something");
    expect(b).toContain("Taste: You usually pick playful designs.");
    expect(tagsFromAnswers(qs, { personality: { choice: "Cheeky" } })).toEqual(["playful"]);
  });

  it("titles drop the lead-in", () => {
    expect(shortName("I want a little guy that cheers")).toBe("little guy that cheers");
    expect(titleFor("can you make me a fortune cookie widget please")).toBe("Fortune cookie widget please");
    expect(titleFor("!!!")).toBe("New idea");
  });
});

describe("UI fixes 4: taste profile", () => {
  beforeEach(() => useTaste.getState().reset());

  it("picks teach it; the line names the strongest traits", () => {
    expect(tasteLine(useTaste.getState().traits)).toBeNull();
    useTaste.getState().record(["dark", "rounded"]);
    useTaste.getState().record(["dark"]);
    expect(topTraits(useTaste.getState().traits)).toEqual(["dark", "rounded"]);
    expect(tasteLine(useTaste.getState().traits)).toBe("You usually pick dark and rounded designs.");
    useTaste.getState().forget("dark");
    expect(topTraits(useTaste.getState().traits)).toEqual(["rounded"]);
  });

  it("a bad save can't break it", () => {
    expect(sanitizeTraits({ dark: 3, "Bad Key": 1, huge: 1e9, nan: Number.NaN, s: "x" })).toEqual({ dark: 3, huge: 20 });
  });
});
