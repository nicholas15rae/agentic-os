import type { AssignedWorker, BuildEnvelope, IntakeQuestion, TargetRuntime } from "./types";

/**
 * Phase 2 compiler (pure): selected brainstorm notes + the intake interview's answers → ONE strict
 * TaskEnvelope plus the brief the agents read. Deterministic: the same notes (in any selection
 * order) and answers always compile to the same envelope, apart from `build_id`.
 */

export interface IntakeNote {
  id: string;
  title: string;
  text: string;
  /** Creation time (any unit, compared only) — notes are ordered oldest first. */
  created: number;
}

export interface Answer {
  choice?: string;
  text?: string;
}
export type Answers = Record<string, Answer>;

export interface CompileCtx {
  now: number;
  /** 4+ chars of [a-z0-9] (randomness lives outside the compiler). */
  rand: string;
  stagingRoot: string;
  externalBase: string;
  /** Nic's edited title (else derived from the notes). */
  title?: string;
}

export const SUMMARY_MAX = 2000;
export const BRIEF_MAX = 8000;
export const NOTE_MAX = 3000;
export const LIST_MAX = 12;

/** Oldest first, then id — selection order never matters. */
export function orderNotes<T extends IntakeNote>(notes: readonly T[]): T[] {
  return [...notes].sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
}

export function slugify(title: string): string {
  const s = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return s || "build";
}

export function newBuildId(now: number, rand: string): string {
  return `b-${now.toString(36)}-${rand.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "x"}`;
}

const pick = (a: Answers, id: string) => a[id]?.choice ?? "";

export function runtimeFrom(a: Answers): TargetRuntime {
  return /standalone|external/i.test(pick(a, "runtime")) ? "external_os" : "internal_widget";
}

export function workerFrom(a: Answers): AssignedWorker {
  const c = pick(a, "worker");
  if (/claude/i.test(c)) return "claude";
  if (/designer/i.test(c)) return "designer";
  return "coder";
}

const joinPath = (root: string, slug: string) => `${root.replace(/[\\/]+$/, "")}\\${slug}`;

export function outputDirectory(runtime: TargetRuntime, slug: string, ctx: Pick<CompileCtx, "stagingRoot" | "externalBase">): string {
  return joinPath(runtime === "external_os" ? ctx.externalBase : ctx.stagingRoot, slug);
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Cut `s` to `max` chars with an explicit, counted marker (never a silent cut). Pure. */
export function clipMarked(s: string, max: number): string {
  if (s.length <= max) return s;
  const marker = (n: number) => `\n[…${n} more chars not included]`;
  const keep = Math.max(0, max - marker(s.length).length);
  return `${s.slice(0, keep)}${marker(s.length - keep)}`;
}
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const answerText = (a: Answer | undefined) => oneLine([a?.choice, a?.text].filter(Boolean).join(" — "));

/** Questions that set envelope fields directly (never copied into the criteria). */
const ENVELOPE_QS = new Set(["runtime", "worker"]);
/** The scope question: the fallback's `scope`, or a Prompter question about scope / the first build. */
const isScopeQ = (q: IntakeQuestion) => q.id === "scope" || /\bscope\b|first build|how much/i.test(q.question);

export function milestonesFor(runtime: TargetRuntime, a: Answers, questions: readonly IntakeQuestion[] = []): string[] {
  const scopeIds = new Set(["scope", ...questions.filter(isScopeQ).map((q) => q.id)]);
  const mock = [...scopeIds].some((id) => /mock/i.test(answerText(a[id])));
  const core = mock ? "Clickable mock of every screen" : runtime === "internal_widget" ? "Core interactions working" : "Core features working";
  return runtime === "internal_widget"
    ? ["Spec locked from the interview", "Layout & components", core, "Smoke test passes", "Promoted to the dashboard"]
    : ["Spec locked from the interview", "App scaffold in external-builds", core, "Smoke test passes", "Ready for merge"];
}

export function criteriaFor(runtime: TargetRuntime, a: Answers, questions: readonly IntakeQuestion[] = []): string[] {
  const out: string[] = [];
  const s = a.success;
  if (s?.choice && !/own criteria/i.test(s.choice)) out.push(s.choice);
  for (const line of (s?.text ?? "").split(/[\n;]+/)) if (line.trim()) out.push(oneLine(line));
  // The Prompter's own questions (q1..q3) carry no fixed id: with no `success` question, every
  // answered one (scope / stack excepted) becomes a checkable requirement, typed lines split out.
  if (!s) {
    for (const q of questions) {
      if (ENVELOPE_QS.has(q.id) || q.id === "stack" || isScopeQ(q)) continue;
      const ans = a[q.id];
      if (!ans?.choice && !ans?.text) continue;
      const head = q.question.replace(/\?\s*$/, "");
      // Skip only the free-text chip ("My own criteria (type them)"), never an answer that merely
      // contains the letters ("Dropdown menu", "Prototype layout", "Countdown").
      if (ans.choice && !/\b(?:my own|type (?:them|it|my own))\b/i.test(ans.choice)) out.push(`${head}: ${ans.choice}`);
      for (const l of (ans.text ?? "").split(/[\n;]+/)) if (l.trim()) out.push(oneLine(l));
    }
  }
  out.push("Renders with no console errors");
  out.push("No secrets, no calls to private hosts");
  out.push(runtime === "internal_widget" ? "Runs inside a sandboxed iframe (no parent / top access)" : "Opens on its own from app/index.html");
  const seen = new Set<string>();
  return out.filter((c) => !seen.has(c.toLowerCase()) && seen.add(c.toLowerCase())).slice(0, LIST_MAX).map((c) => clip(c, 240));
}

export function deriveTitle(notes: readonly IntakeNote[]): string {
  const real = orderNotes(notes).find((n) => n.title.trim() && !/^untitled/i.test(n.title.trim()));
  const t = real ? oneLine(real.title) : "Brainstorm build";
  return clip(notes.length > 1 ? `${t} (+${notes.length - 1})` : t, 120);
}

export interface Compiled {
  envelope: BuildEnvelope;
  brief: string;
  noteIds: string[];
  /** The interview as asked and answered (the build's Agent Conversation opens with it; Rust
   * scrubs and caps it again). */
  intake?: { q: string; a: string }[];
}

export function compileEnvelope(notes: readonly IntakeNote[], questions: readonly IntakeQuestion[], answers: Answers, ctx: CompileCtx): Compiled {
  if (!notes.length) throw new Error("select at least one brainstorm entry");
  const ordered = orderNotes(notes);
  const title = clip(oneLine(ctx.title ?? "") || deriveTitle(ordered), 120);
  const slug = slugify(title);
  const runtime = runtimeFrom(answers);
  const qa = questions.map((q) => ({ q: q.question, a: answerText(answers[q.id]) || "(no answer — use your judgment)" }));
  const firstText = oneLine(ordered[0].text).slice(0, 300);
  const extra = questions.filter((q) => q.id !== "runtime" && q.id !== "worker").map((q) => `${q.question} ${answerText(answers[q.id]) || "—"}`);
  const summary = clip(oneLine(`${title}. ${firstText} ${extra.join(" ")}`), SUMMARY_MAX);
  // The interview answers LEAD (they are what Nic decided; the worker reads the head of the
  // brief), then the notes, each with a fair share of what's left and a visible cut marker — the
  // answers used to come last and were the first thing cut with 5-6 long notes.
  const qaBlock = ["Intake interview:", ...qa.map(({ q, a }) => `Q: ${q}\nA: ${a}`)].join("\n");
  const header = `Brainstorm notes (${ordered.length}, oldest first):`;
  const titles = ordered.map((n) => `## ${oneLine(n.title) || "Untitled"}`);
  const room = BRIEF_MAX - qaBlock.length - header.length - titles.reduce((a, t) => a + t.length + 2, 0) - 4;
  const share = Math.min(NOTE_MAX, Math.max(200, Math.floor(room / ordered.length)));
  const brief = clip([qaBlock, "", header, ...ordered.map((n, i) => `${titles[i]}\n${clipMarked(n.text.trim(), share)}`)].join("\n"), BRIEF_MAX);
  const envelope: BuildEnvelope = {
    build_id: newBuildId(ctx.now, ctx.rand),
    project_slug: slug,
    title,
    target_runtime: runtime,
    output_directory: outputDirectory(runtime, slug, ctx),
    spec_summary: summary,
    milestones: milestonesFor(runtime, answers, questions),
    acceptance_criteria: criteriaFor(runtime, answers, questions),
    assigned_worker: workerFrom(answers),
    preview_url: null,
    status: "queued",
    human_override: [],
  };
  return { envelope, brief, noteIds: ordered.map((n) => n.id), intake: qa };
}

/** Structural check of an envelope (mirrors Rust `validate_new`'s shape rules). */
export function envelopeProblems(e: BuildEnvelope): string[] {
  const p: string[] = [];
  if (!/^b-[a-z0-9-]{1,62}$/i.test(e.build_id)) p.push("build_id");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(e.project_slug)) p.push("project_slug");
  if (!e.title.trim()) p.push("title");
  if (!["internal_widget", "external_os"].includes(e.target_runtime)) p.push("target_runtime");
  if (!["claude", "coder", "designer"].includes(e.assigned_worker)) p.push("assigned_worker");
  if (!e.spec_summary.trim()) p.push("spec_summary");
  if (!e.milestones.length || e.milestones.length > LIST_MAX) p.push("milestones");
  if (!e.acceptance_criteria.length || e.acceptance_criteria.length > LIST_MAX) p.push("acceptance_criteria");
  if (e.status !== "queued") p.push("status");
  if (!e.output_directory.toLowerCase().endsWith(`\\${e.project_slug}`)) p.push("output_directory");
  return p;
}
