import { describe, expect, it } from "vitest";
import { compileEnvelope, criteriaFor, deriveTitle, envelopeProblems, newBuildId, orderNotes, runtimeFrom, slugify, workerFrom, type IntakeNote } from "./compile";
import { noteToIntake } from "./notes";
import { RUNTIMES, STATUSES, WORKERS, type BuildEnvelope, type IntakeQuestion } from "./types";

const notes: IntakeNote[] = [
  { id: "n3", title: "Later thought", text: "add a dark mode", created: 300 },
  { id: "n1", title: "Tip calculator", text: "split the bill between friends", created: 100 },
  { id: "n2", title: "Untitled brainstorm", text: "round up to the nearest dollar", created: 200 },
];

const questions: IntakeQuestion[] = [
  { id: "q1", question: "Who uses it?", options: ["Just me", "Friends"], allow_free_text: true },
  { id: "success", question: "What does done look like?", options: ["It renders and the main action works", "My own criteria (type them)"], allow_free_text: true },
  { id: "runtime", question: "Where should it run?", options: ["Internal widget (inside the dashboard)", "Standalone app (external-builds folder)"], allow_free_text: false },
  { id: "worker", question: "Who builds it?", options: ["Coder (local pipeline)", "Designer-led (look first)", "Claude Code (queued; asks before running)"], allow_free_text: false },
];

const ctx = { now: 1_800_000_000_000, rand: "ab12", stagingRoot: "D:\\Art Apps\\agentic os\\staging\\", externalBase: "C:\\ai-hub\\external-builds" };

const SPEC_KEYS = ["build_id", "project_slug", "title", "target_runtime", "output_directory", "spec_summary", "milestones", "acceptance_criteria", "assigned_worker", "preview_url", "status"];

describe("TaskEnvelope compiler", () => {
  it("emits exactly the spec's contract (plus human_override) with valid enums", () => {
    const { envelope } = compileEnvelope(notes, questions, { runtime: { choice: questions[2].options[0] } }, ctx);
    expect(Object.keys(envelope).sort()).toEqual([...SPEC_KEYS, "human_override"].sort());
    expect(RUNTIMES).toContain(envelope.target_runtime);
    expect(WORKERS).toContain(envelope.assigned_worker);
    expect(STATUSES).toContain(envelope.status);
    expect(envelope.status).toBe("queued");
    expect(envelope.preview_url).toBeNull();
    expect(envelope.human_override).toEqual([]);
    expect(envelopeProblems(envelope)).toEqual([]);
    // Strict JSON round trip.
    expect(JSON.parse(JSON.stringify(envelope))).toEqual(envelope);
  });

  it("is deterministic: selection order never changes the envelope or brief", () => {
    const a = compileEnvelope(notes, questions, {}, ctx);
    const b = compileEnvelope([...notes].reverse(), questions, {}, ctx);
    expect(b).toEqual(a);
    expect(a.noteIds).toEqual(["n1", "n2", "n3"]);
    expect(a.brief.indexOf("Tip calculator")).toBeLessThan(a.brief.indexOf("Later thought"));
  });

  it("maps the interview onto runtime, worker and output directory (C:\\ai-hub baseline for external)", () => {
    const ext = compileEnvelope(notes, questions, { runtime: { choice: "Standalone app (external-builds folder)" }, worker: { choice: "Claude Code (queued; asks before running)" } }, ctx).envelope;
    expect(ext.target_runtime).toBe("external_os");
    expect(ext.assigned_worker).toBe("claude");
    expect(ext.output_directory).toBe("C:\\ai-hub\\external-builds\\tip-calculator-2");
    const int = compileEnvelope(notes, questions, { worker: { choice: "Designer-led (look first)" } }, ctx).envelope;
    expect(int.target_runtime).toBe("internal_widget");
    expect(int.assigned_worker).toBe("designer");
    expect(int.output_directory).toBe("D:\\Art Apps\\agentic os\\staging\\tip-calculator-2");
    expect(int.milestones.at(-1)).toBe("Promoted to the dashboard");
    expect(ext.milestones.at(-1)).toBe("Ready for merge");
  });

  it("uses Nic's edited title for the title and slug", () => {
    const { envelope } = compileEnvelope(notes, questions, {}, { ...ctx, title: "  Bill Splitter!! " });
    expect(envelope.title).toBe("Bill Splitter!!");
    expect(envelope.project_slug).toBe("bill-splitter");
  });

  it("acceptance criteria: chosen + typed + safety defaults, deduped and capped", () => {
    const c = criteriaFor("internal_widget", { success: { choice: "It renders and the main action works", text: "totals update live; works offline\nrenders with no console errors" } });
    expect(c[0]).toBe("It renders and the main action works");
    expect(c).toContain("totals update live");
    expect(c).toContain("works offline");
    expect(c.filter((x) => /console errors/i.test(x))).toHaveLength(1);
    expect(c).toContain("Runs inside a sandboxed iframe (no parent / top access)");
    expect(criteriaFor("external_os", { success: { choice: "My own criteria (type them)" } })).not.toContain("My own criteria (type them)");
  });

  it("brief carries every note and every Q/A; unanswered questions say so", () => {
    const { brief } = compileEnvelope(notes, questions, { q1: { choice: "Friends", text: "on phones" } }, ctx);
    expect(brief).toContain("Brainstorm notes (3, oldest first)");
    expect(brief).toContain("Q: Who uses it?\nA: Friends — on phones");
    expect(brief).toContain("(no answer — use your judgment)");
  });

  it("helpers: slugs, ids, titles, ordering", () => {
    expect(slugify("Ünïcode & Spaces — 2.0")).toBe("unicode-spaces-2-0");
    expect(slugify("!!!")).toBe("build");
    expect(slugify("x".repeat(80))).toHaveLength(48);
    expect(newBuildId(36 ** 3, "Z9-*")).toBe("b-1000-z9");
    expect(deriveTitle([{ id: "a", title: "Untitled brainstorm", text: "", created: 1 }])).toBe("Brainstorm build");
    expect(orderNotes([{ id: "b", title: "", text: "", created: 1 }, { id: "a", title: "", text: "", created: 1 }]).map((n) => n.id)).toEqual(["a", "b"]);
    expect(runtimeFrom({})).toBe("internal_widget");
    expect(workerFrom({})).toBe("coder");
  });

  it("refuses an empty selection", () => {
    expect(() => compileEnvelope([], questions, {}, ctx)).toThrow();
  });

  it("envelopeProblems flags a tampered envelope", () => {
    const { envelope } = compileEnvelope(notes, questions, {}, ctx);
    const bad: BuildEnvelope = { ...envelope, status: "building", project_slug: "Bad Slug", milestones: [], output_directory: "C:\\elsewhere" };
    expect(envelopeProblems(bad)).toEqual(expect.arrayContaining(["status", "project_slug", "milestones", "output_directory"]));
  });

  it("noteToIntake reads organized notes and raw transcripts", () => {
    const n = noteToIntake({
      id: "x",
      title: "",
      rawText: "raw words",
      segments: [],
      organized: { summary: "A summary", tags: [], categories: [{ name: "UI", bullets: ["big buttons"] }], actions: [{ text: "ship it" }] },
      _created: 5,
      _updated: 6,
    } as never);
    expect(n).toEqual({ id: "x", title: "Untitled brainstorm", text: "A summary\nUI: big buttons\nActions: ship it\nRaw: raw words", created: 5 });
  });
});

describe("review #17: the Prompter's answers reach the envelope", () => {
  const prompterQs: IntakeQuestion[] = [
    { id: "q1", question: "What must the export do?", options: ["CSV", "PDF"], allow_free_text: true },
    { id: "q2", question: "What's the scope of the first build?", options: ["Clickable mock", "Working app"], allow_free_text: true },
    { id: "q3", question: "Anything else?", options: ["No", "Yes (type it)"], allow_free_text: true },
    ...questions.filter((q) => q.id === "runtime" || q.id === "worker"),
  ];

  it("answered q1..q3 become acceptance criteria (scope excepted), typed lines split out", () => {
    const { envelope } = compileEnvelope(notes, prompterQs, { q1: { choice: "CSV", text: "dark mode; works offline" }, q3: { choice: "Yes (type it)", text: "keyboard shortcuts" } }, ctx);
    expect(envelope.acceptance_criteria.slice(0, 4)).toEqual(["What must the export do: CSV", "dark mode", "works offline", "keyboard shortcuts"]);
    expect(envelope.acceptance_criteria).toContain("Renders with no console errors");
    expect(envelope.acceptance_criteria.some((c) => /scope/i.test(c))).toBe(false);
    expect(envelopeProblems(envelope)).toEqual([]);
  });

  it("a mock scope answer on a Prompter question switches the milestones", () => {
    const { envelope } = compileEnvelope(notes, prompterQs, { q2: { choice: "Clickable mock" } }, ctx);
    expect(envelope.milestones).toContain("Clickable mock of every screen");
  });

  it("with a `success` question present, only its answer is used (fallback path unchanged)", () => {
    const { envelope } = compileEnvelope(notes, questions, { q1: { choice: "Friends" }, success: { choice: "It renders and the main action works" } }, ctx);
    expect(envelope.acceptance_criteria[0]).toBe("It renders and the main action works");
    expect(envelope.acceptance_criteria.some((c) => c.includes("Friends"))).toBe(false);
  });
});
