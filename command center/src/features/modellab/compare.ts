/**
 * Model Lab A/B compare (src-tauri/src/commands/modellab/compare.rs): the typed commands and the
 * pure A-vs-B table the Model Lab card shows. Kept beside the card (not in platform.ts's shared
 * NativeCommands) like native-ext.ts does, using the same `native()` invoke.
 */
import { native } from "@/lib/platform";

export type CompareVariant = "base" | "a" | "b";

export const VARIANT_LABEL: Record<CompareVariant, string> = {
  base: "As Tony sends it",
  a: "+ enable_thinking off",
  b: "+ Qwen sampling",
};

export interface CompareProgress {
  runId: string;
  modelA: string;
  modelB: string;
  startedAt: number;
  phase: string;
  done: number;
  total: number;
  estMinutes: number;
}

export interface CompareLoad {
  loadMs: (number | null)[];
  medianLoadMs: number | null;
  ctxOk: boolean;
  context: number | null;
  vramAfterLoadMb: number | null;
  vramPeakMb: number | null;
  vramTotalMb: number | null;
  errors: string[];
}

export interface CompareVariantSummary {
  chatRuns: number;
  routerRuns: number;
  errors: number;
  timing: {
    runs: number;
    ttfdMs: number | null;
    firstContentMs: number | null;
    firstSpeakableMs: number | null;
    totalMs: number | null;
    completionTokens: number | null;
    promptTokens: number | null;
    prefillTps: number | null;
    genTps: number | null;
    tokensApprox: boolean;
    /**
     * How prefillTps was worked out (compare.rs `token_metrics`): "server" (llama.cpp timings),
     * "uncached" (uncached prompt tokens ÷ first delta), "prompt" (ALL prompt tokens ÷ first delta:
     * Bionic reports no cache hits, so a cached prefix inflates it), "mixed" or "none". Absent in
     * reports from before it.
     */
    prefillBasis?: "server" | "uncached" | "prompt" | "mixed" | "none";
  };
  reasoning: { tokensMax: number; runsWithReasoning: number };
  persona: Record<"pass" | "sentencesOk" | "noMarkdown" | "noAiTalk" | "noBanned" | "noWrongName" | "noToolTalk" | "noThinkLeak" | "noCjk" | "addressesNic", number | null>;
  packets: { parseRate: number | null; dispatchMatch: number | null };
  router: {
    runs: number;
    jsonFirst: number | null;
    jsonAfterRetry: number | null;
    /** Over the picks the router was asked for: a second pass skipped after a wrong first pick is left out. */
    exactTool: number | null;
    argsOk: number | null;
    /** Two-step second passes never asked (the first pick was wrong); they count against twoStep. Absent in older reports. */
    skippedSecondPasses?: number;
    unoffered: number;
    spotifyWriteOnNonMedia: number;
    twoStep: number | null;
    unfairCases: string[];
    medianMs: number | null;
  };
  /** `noAnswer`: guard runs that errored, timed out, came back empty or gave no JSON; they count as NOT held in `pass` (absent in reports from before it). */
  guard: { runs?: number; pass: number | null; chatPass: number | null; routerPass: number | null; noAnswer?: number; claimed: number; complied: number; exfil: number };
}

export interface CompareSide {
  model: string;
  load: CompareLoad;
  variants: Partial<Record<CompareVariant, CompareVariantSummary>>;
}

/** The newest report without its per-case rows (`compare::compact`). */
export interface CompareReport {
  runId: string;
  startedAt?: number;
  finishedAt?: number;
  wallMs?: number;
  plan?: { modelA: string; modelB: string; tony: string; repeats: number; variants: CompareVariant[]; maxMinutes: number; warnings: string[] };
  summary?: { A?: CompareSide; B?: CompareSide };
  restore?: { ok: boolean; model: string; loadMs?: number | null; context?: number | null; loadedLlms?: string[]; notes?: string[] };
  stopped?: string | null;
  error?: string | null;
}

export interface CompareStatus {
  running: boolean;
  progress: CompareProgress | null;
  latest: CompareReport | null;
  dir: string | null;
}

export interface CompareStarted {
  runId: string;
  estMinutes: number;
  total: number;
}

/** Start a run (B = `modelB`, A = Tony's configured model). Returns at once; poll the status. */
export const startCompare = (modelB: string) => native<CompareStarted>("model_compare", { request: { modelB } });
export const compareStatus = () => native<CompareStatus>("model_compare_status");
/** Stop after the current case; Tony's model is still put back. */
export const cancelCompare = () => native<boolean>("model_compare_cancel");

// ── The A-vs-B table (pure) ─────────────────────────────────────────────────

type Better = "lower" | "higher" | "none";
type Kind = "ms" | "rate" | "count" | "tps" | "mb" | "num" | "ok";

export interface CompareRow {
  label: string;
  a: string;
  b: string;
  /** Which side did better on this row (null: a tie, no data, or no direction). */
  better: "a" | "b" | null;
  /** A value that fails a hard rule (reasoning tokens > 0, a context that didn't take). */
  badA?: boolean;
  badB?: boolean;
}

export function fmt(v: number | boolean | null | undefined, kind: Kind): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (!Number.isFinite(v)) return "—";
  switch (kind) {
    case "ms":
      return v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(2)} s`;
    case "rate":
      return `${Math.round(v * 100)}%`;
    case "tps":
      return `${Math.round(v)} tok/s`;
    case "mb":
      return `${(v / 1024).toFixed(1)} GB`;
    case "count":
    case "num":
      return `${Math.round(v)}`;
    default:
      return String(v);
  }
}

function pick(a: number | null | undefined, b: number | null | undefined, better: Better): "a" | "b" | null {
  if (better === "none" || a === null || a === undefined || b === null || b === undefined || a === b) return null;
  return (better === "lower" ? a < b : a > b) ? "a" : "b";
}

/** The compact A-vs-B rows for one variant (load / VRAM rows are per model, whatever the variant). */
export function compareRows(report: CompareReport | null | undefined, variant: CompareVariant): CompareRow[] {
  const A = report?.summary?.A;
  const B = report?.summary?.B;
  if (!A && !B) return [];
  const va = A?.variants[variant];
  const vb = B?.variants[variant];
  const rows: CompareRow[] = [];
  const num = (label: string, a: number | null | undefined, b: number | null | undefined, kind: Kind, better: Better) =>
    rows.push({ label, a: fmt(a, kind), b: fmt(b, kind), better: pick(a, b, better) });
  num("Load time (median)", A?.load.medianLoadMs, B?.load.medianLoadMs, "ms", "lower");
  rows.push({ label: "Context 32k × 2 took", a: fmt(A?.load.ctxOk, "ok"), b: fmt(B?.load.ctxOk, "ok"), better: null, badA: A?.load.ctxOk === false, badB: B?.load.ctxOk === false });
  num("VRAM after load", A?.load.vramAfterLoadMb, B?.load.vramAfterLoadMb, "mb", "lower");
  num("VRAM peak (500 ms)", A?.load.vramPeakMb, B?.load.vramPeakMb, "mb", "lower");
  num("First delta", va?.timing.ttfdMs, vb?.timing.ttfdMs, "ms", "lower");
  num("First content", va?.timing.firstContentMs, vb?.timing.firstContentMs, "ms", "lower");
  num("First speakable chunk", va?.timing.firstSpeakableMs, vb?.timing.firstSpeakableMs, "ms", "lower");
  num("Total answer", va?.timing.totalMs, vb?.timing.totalMs, "ms", "lower");
  const ra = va?.reasoning.tokensMax;
  const rb = vb?.reasoning.tokensMax;
  rows.push({ label: "Reasoning tokens (must be 0)", a: fmt(ra, "count"), b: fmt(rb, "count"), better: pick(ra, rb, "lower"), badA: (ra ?? 0) > 0, badB: (rb ?? 0) > 0 });
  num("Completion tokens", va?.timing.completionTokens, vb?.timing.completionTokens, "num", "none");
  num("Prompt tokens", va?.timing.promptTokens, vb?.timing.promptTokens, "num", "none");
  num(prefillLabel(va?.timing.prefillBasis, vb?.timing.prefillBasis), va?.timing.prefillTps, vb?.timing.prefillTps, "tps", "higher");
  num("Generation", va?.timing.genTps, vb?.timing.genTps, "tps", "higher");
  num("Router: JSON first try", va?.router.jsonFirst, vb?.router.jsonFirst, "rate", "higher");
  num("Router: JSON after retry", va?.router.jsonAfterRetry, vb?.router.jsonAfterRetry, "rate", "higher");
  num("Router: exact tool", va?.router.exactTool, vb?.router.exactTool, "rate", "higher");
  num("Router: required args", va?.router.argsOk, vb?.router.argsOk, "rate", "higher");
  num("Router: two-step", va?.router.twoStep, vb?.router.twoStep, "rate", "higher");
  num("Router: unoffered tool", va?.router.unoffered, vb?.router.unoffered, "count", "lower");
  num("Router: Spotify write on a non-media line", va?.router.spotifyWriteOnNonMedia, vb?.router.spotifyWriteOnNonMedia, "count", "lower");
  num("Tier-3 packets parsed", va?.packets.parseRate, vb?.packets.parseRate, "rate", "higher");
  num("Persona rules held", va?.persona.pass, vb?.persona.pass, "rate", "higher");
  num("Guardrails held", va?.guard.pass, vb?.guard.pass, "rate", "higher");
  // A guard run with nothing to judge is never a pass: shown, so a silent model's score is questioned.
  const na = va?.guard.noAnswer;
  const nb = vb?.guard.noAnswer;
  rows.push({ label: "Guardrails: no answer (counted as not held)", a: fmt(na, "count"), b: fmt(nb, "count"), better: pick(na, nb, "lower"), badA: (na ?? 0) > 0, badB: (nb ?? 0) > 0 });
  num("Guardrails: claimed / complied", sum(va?.guard.claimed, va?.guard.complied), sum(vb?.guard.claimed, vb?.guard.complied), "count", "lower");
  num("Guardrails: exfiltration", va?.guard.exfil, vb?.guard.exfil, "count", "lower");
  num("Errors / no content (all runs)", va?.errors, vb?.errors, "count", "lower");
  return rows;
}

/** "Prefill", qualified when a side's rate counts every prompt token (Bionic reports no cache hits). */
export function prefillLabel(a?: string, b?: string): string {
  return a === "prompt" || b === "prompt" || a === "mixed" || b === "mixed" ? "Prefill (all prompt tokens ÷ first delta; cache not reported)" : "Prefill";
}

function sum(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
}

/** The variants the report has for either side, in run order. */
export function reportVariants(report: CompareReport | null | undefined): CompareVariant[] {
  const has = (v: CompareVariant) => !!(report?.summary?.A?.variants[v] || report?.summary?.B?.variants[v]);
  return (["base", "a", "b"] as CompareVariant[]).filter(has);
}

/** One line on how the run ended (Tony back or not). */
export function restoreLine(report: CompareReport | null | undefined): { ok: boolean; text: string } | null {
  if (!report) return null;
  const r = report.restore;
  const why = report.error ? ` ${report.error}.` : report.stopped ? ` Stopped early: ${report.stopped}.` : "";
  if (!r) return { ok: false, text: `No restore step recorded.${why}` };
  if (r.ok) return { ok: true, text: `Tony's model (${r.model}) is back alone at ${Math.round((r.context ?? 0) / 1024)}k.${why}` };
  return { ok: false, text: `Tony's model may not be back: loaded ${JSON.stringify(r.loadedLlms ?? [])}${r.notes?.length ? ` (${r.notes.join("; ")})` : ""}. Check Bionic.${why}` };
}
