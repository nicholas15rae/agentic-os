import { describe, expect, it } from "vitest";
import { briefPoints, compileWidgetBuild, MAX_POINTS, needsPipeline } from "./brief-points";
import { envelopeProblems } from "./compile";

const FORTUNE = "Make me a fortune cookie widget: tap the cookie to crack it open, show a random fortune, a button for a new fortune, keep a history of the last 5 fortunes and show 6 lucky numbers";

describe("brief checklist", () => {
  it("splits the fortune cookie request into its five points", () => {
    const b = briefPoints(FORTUNE);
    expect(b.title).toBe("Fortune cookie");
    expect(b.points).toEqual(["Tap the cookie to crack it open", "Show a random fortune", "A button for a new fortune", "Keep a history of the last 5 fortunes", "Show 6 lucky numbers"]);
    expect(b.overflow).toEqual([]);
  });

  it("handles lines, bullets and 'that' descriptions", () => {
    expect(briefPoints("build a water tracker that\n- adds a glass per tap\n- resets at midnight\n- shows today's total").points).toEqual(["Adds a glass per tap", "Resets at midnight", "Shows today's total"]);
    expect(briefPoints("Countdown to my Dec 12 shoot").points).toEqual(["Countdown to my Dec 12 shoot"]);
  });

  it("never splits 'and' inside a thing (salt and pepper), only before a new action", () => {
    expect(briefPoints("a recipe card: list salt and pepper amounts and show the cook time").points).toEqual(["List salt and pepper amounts", "Show the cook time"]);
  });

  it("caps the points and says what didn't fit", () => {
    const many = `a widget: ${Array.from({ length: 12 }, (_, i) => `show item ${i + 1}`).join(", ")}`;
    const b = briefPoints(many);
    expect(b.points).toHaveLength(MAX_POINTS);
    expect(b.overflow).toHaveLength(12 - MAX_POINTS);
  });

  it("interactive or multi-point requests go to the build pipeline; a plain card does not", () => {
    expect(needsPipeline(FORTUNE, briefPoints(FORTUNE).points)).toBe(true);
    expect(needsPipeline("HST paid on fuel receipts", ["HST paid on fuel receipts"])).toBe(false);
  });

  it("compiles to a valid internal-widget envelope with every point as an acceptance criterion", () => {
    const b = briefPoints(FORTUNE);
    const c = compileWidgetBuild(FORTUNE, b, { now: 1_700_000_000_000, rand: "abcd", stagingRoot: "C:\\staging", externalBase: "C:\\ext" });
    expect(envelopeProblems(c.envelope)).toEqual([]);
    expect(c.envelope.target_runtime).toBe("internal_widget");
    expect(c.envelope.assigned_worker).toBe("coder");
    expect(c.envelope.title).toBe("Fortune cookie");
    for (const p of b.points) expect(c.envelope.acceptance_criteria).toContain(p);
    expect(c.brief).toContain("Keep a history of the last 5 fortunes");
  });

  it("keeps numbers, quotes and plain lists in one point (review fixes)", () => {
    expect(briefPoints("a savings widget that shows progress toward $1,000, a bar and the date").points).toEqual(["Shows progress toward $1,000", "A bar and the date"]);
    expect(briefPoints("make a color picker widget with red, green and blue sliders").points).toEqual(["Red, green and blue sliders"]);
    expect(briefPoints('build a quote widget that shows "Hello, world" and a share button').points).toEqual(['Shows "Hello, world" and a share button']);
  });

  it("titles never keep a leading article", () => {
    expect(briefPoints("a savings widget that shows progress").title).toBe("Savings");
    expect(briefPoints("a stopwatch app with lap times").title).toBe("Stopwatch");
  });

  it("routes input-driven widgets to the build, plain data cards to the quick card", () => {
    for (const t of ["make a to-do list widget where I can add tasks and check them off", "a habit tracker widget where I can mark each day done", "a notes widget I can type into and it saves", "a unit converter widget with an input box and a dropdown"])
      expect(needsPipeline(t, briefPoints(t).points), t).toBe(true);
    for (const t of ["a battery level widget", "show the leafs score tonight", "a widget showing my spotify history", "a sound level meter", "countdown to my Dec 12 shoot"])
      expect(needsPipeline(t, briefPoints(t).points), t).toBe(false);
  });

  it("a ';' typed into a point stays one criterion; the standing checks always fit", () => {
    const pts = ["a; b", "c; d", "e", "f", "g", "h", "i", "j", "k"];
    const c = compileWidgetBuild("x", { title: "Many", points: pts }, { now: 1, rand: "abcd", stagingRoot: "C:\\staging", externalBase: "C:\\ext" });
    expect(c.envelope.acceptance_criteria).toContain("a, b");
    expect(c.envelope.acceptance_criteria).toContain("Runs inside a sandboxed iframe (no parent / top access)");
    expect(c.envelope.acceptance_criteria).toHaveLength(12);
  });
});
