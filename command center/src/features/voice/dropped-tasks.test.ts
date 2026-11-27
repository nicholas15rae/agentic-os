import { describe, expect, it } from "vitest";
import { createDroppedTasks, isDismissal, isResumeNo, isResumeYes, isTaskLine, RESUME_TTL_MS, resumeOffer } from "./dropped-tasks";

describe("dropped tasks", () => {
  it("knows a task line from small talk", () => {
    for (const t of ["check my last five Gmail messages", "can you find the invoice from Sam", "draft a reply to the casting email", "what's on my calendar tomorrow"]) expect(isTaskLine(t), t).toBe(true);
    for (const t of ["how are you", "nice", "tell me a joke about cats", "thanks"]) expect(isTaskLine(t), t).toBe(false);
  });

  it("keeps a superseded task and offers it once the new subject is answered", () => {
    const d = createDroppedTasks(() => 1000);
    const old = d.begin("check my last five Gmail messages", "auto", 1);
    d.supersede(); // Nic talks over Tony
    d.end(old); // the old turn winds down quietly
    const cur = d.begin("what's the weather like", "auto", 2);
    d.end(cur);
    const offer = d.takeOffer("what's the weather like");
    expect(offer?.line).toBe("check my last five Gmail messages");
    expect(resumeOffer(offer!)).toContain("Want me to finish it now?");
    expect(d.takeOffer("anything")).toBeNull(); // offered once
  });

  it("a finished task is never offered", () => {
    const d = createDroppedTasks();
    const t = d.begin("check my messages", "auto", 1);
    d.end(t);
    d.begin("how are you", "auto", 1);
    expect(d.takeOffer("how are you")).toBeNull();
  });

  it("'never mind' drops it on purpose", () => {
    const d = createDroppedTasks();
    d.begin("check my last five Gmail messages", "auto", 1);
    d.supersede();
    expect(isDismissal("never mind")).toBe(true);
    d.begin("never mind", "auto", 2);
    expect(d.takeOffer("never mind")).toBeNull();
  });

  it("yes resumes, no declines, anything else closes the offer; offers expire", () => {
    let now = 0;
    const d = createDroppedTasks(() => now);
    const arm = () => {
      d.begin("check my last five Gmail messages", "auto", 1);
      d.supersede();
      return d.takeOffer("what time is it")!;
    };
    arm();
    expect(d.answer("yes please")?.kind).toBe("resume");
    arm();
    expect(d.answer("no thanks")?.kind).toBe("decline");
    arm();
    expect(d.answer("play some music")).toBeNull();
    expect(d.answer("yes")).toBeNull();
    arm();
    now += RESUME_TTL_MS + 1;
    expect(d.answer("yes")).toBeNull();
    const o = arm();
    expect(d.claim("nope")).toBeNull();
    expect(d.claim(o.id)?.line).toBe("check my last five Gmail messages");
    expect(isResumeYes("go ahead")).toBe(true);
    expect(isResumeNo("nah")).toBe(true);
  });
});
