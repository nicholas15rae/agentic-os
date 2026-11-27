/**
 * Diagnostic & Load Probe — pure rules (unit-tested): the tuning thresholds, per-node health,
 * run-level bottleneck attribution and the concurrency presets. Contract:
 * `diagnostics.contract.ts`. Tune the numbers in `THRESHOLDS` only.
 */
import type { Bottleneck, Footprint, Health, Intensity, ModeSync, OrchestrationMode, OrchestratorPolicy, Phases, PolicyView, PresetId, ProbeEvent, ProbeNode, RunSummary, Thresholds } from "./diagnostics.contract";

/**
 * Green / Amber / Red tuning. RTT is the backend-measured round trip per node (dispatch → done).
 * - LIGHT has no model: anything over a few ms is IPC / runtime / lock overhead.
 * - MEDIUM is one short streamed completion (~48 tokens) on the loaded local model.
 * - HEAVY is ~4k tokens of context + 384 generated tokens per GPU node, serialised on one GPU.
 */
export const THRESHOLDS: Thresholds = {
  rttMs: {
    LIGHT: { green: 25, amber: 120 },
    MEDIUM: { green: 3_000, amber: 9_000 },
    // Measured 2026-11-24 (RTX 3060, qwen3.5-9b): one Heavy probe alone = ~19–22 s (≈4k-token
    // prefill + 384 tokens at ~25 tok/s). Green = runs alone; amber = 1–2 jobs ahead; red = 3+.
    HEAVY: { green: 25_000, amber: 60_000 },
  },
  queueShareAmber: 0.4,
  vramSpillPct: 0.95,
  spillTokPerSec: 8,
};

/** A queue wait below this never counts as contention (scheduler jitter). */
export const MIN_QUEUE_MS: Readonly<Record<Intensity, number>> = { LIGHT: 5, MEDIUM: 250, HEAVY: 1_000 };

export const HEALTH_COLOR: Readonly<Record<Health, string>> = { green: "#34d399", amber: "#fbbf24", red: "#f87171" };

/** Every probe target in panel order (the arbiter's 14 nodes). */
export const PROBE_NODES: readonly ProbeNode[] = ["tony", "prompter", "coder", "designer", "director", "librarian", "finance", "booking", "ops", "bizops", "trading", "observer", "security", "garbage"];

export const PROBE_LABEL: Readonly<Record<ProbeNode, string>> = {
  tony: "Tony",
  prompter: "Prompter",
  coder: "Coder",
  designer: "Designer",
  director: "Director",
  librarian: "Librarian",
  finance: "Financer",
  booking: "BookingAgent",
  ops: "Ops",
  bizops: "BizOps",
  trading: "Trading Agent",
  observer: "Observer",
  security: "Security",
  garbage: "GarbageDaemon",
};

export const isProbeNode = (s: string): s is ProbeNode => (PROBE_NODES as readonly string[]).includes(s);

const DAEMONS: ProbeNode[] = ["observer", "security", "garbage"];

export interface Preset {
  id: PresetId;
  label: string;
  hint: string;
  nodes: ProbeNode[];
  /** Librarian's intermittent ping: a random delay in [min, max] ms, drawn per pulse. */
  stagger?: Partial<Record<ProbeNode, readonly [number, number]>>;
}

export const PRESETS: readonly Preset[] = [
  { id: "daemons", label: "Background Daemons", hint: "Observer + Security + GarbageDaemon", nodes: DAEMONS },
  { id: "daily", label: "Live Daily Stack", hint: "Tony + daemons, Librarian pinged at a random offset (RAG hand-off while you talk)", nodes: ["tony", ...DAEMONS, "librarian"], stagger: { librarian: [600, 2_500] } },
  { id: "dual", label: "Active Dual-Worker", hint: "Tony + Coder + Librarian + daemons", nodes: ["tony", "coder", "librarian", ...DAEMONS] },
  { id: "stress", label: "Full Stress / Trading", hint: "Tony + Trading Agent + Coder + Librarian + daemons (worst case)", nodes: ["tony", "trading", "coder", "librarian", ...DAEMONS] },
];

/** Draw this pulse's stagger (ms) from a preset's ranges. `rand` is injectable for tests. */
export function drawStagger(p: Preset | undefined, rand: () => number = Math.random): Partial<Record<ProbeNode, number>> {
  const out: Partial<Record<ProbeNode, number>> = {};
  for (const [n, r] of Object.entries(p?.stagger ?? {}) as [ProbeNode, readonly [number, number]][]) out[n] = Math.round(r[0] + (r[1] - r[0]) * rand());
  return out;
}

export const isTerminal = (e: Pick<ProbeEvent, "phase">) => e.phase === "completed" || e.phase === "timeout" || e.phase === "error";

const vramShare = (hw: { vramUsedMb: number | null; vramTotalMb: number | null } | null | undefined) => (hw?.vramUsedMb != null && hw.vramTotalMb ? hw.vramUsedMb / hw.vramTotalMb : null);

/** Is the node mostly waiting in line (slot / permit) rather than working? */
export function queueBound(e: ProbeEvent, intensity: Intensity, t: Thresholds = THRESHOLDS): boolean {
  const q = e.queueWaitMs ?? 0;
  const rtt = e.totalRttMs ?? 0;
  return rtt > 0 && q >= MIN_QUEUE_MS[intensity] && q / rtt > t.queueShareAmber;
}

/** Health of one finished probe; null while it is still in flight. */
export function healthOf(e: ProbeEvent, intensity: Intensity, t: Thresholds = THRESHOLDS): Health | null {
  if (!isTerminal(e)) return null;
  if (e.phase !== "completed") return "red";
  const v = vramShare(e.hw);
  if (v != null && v >= t.vramSpillPct) return "red";
  const rtt = e.totalRttMs ?? 0;
  const band = t.rttMs[intensity];
  if (rtt > band.amber) return "red";
  if (rtt > band.green || queueBound(e, intensity, t)) return "amber";
  return "green";
}

export interface RunReadout {
  slowest: { node: ProbeNode; rttMs: number } | null;
  wallMs: number;
  peakGpuPct: number | null;
  /** VRAM the run added on top of the baseline, and the headroom left at the peak (MB). */
  vramDeltaMb: number | null;
  vramHeadroomMb: number | null;
  peakCpuPct: number;
  bottleneck: Bottleneck;
  /** One plain sentence on why. */
  why: string;
}

export const BOTTLENECK_LABEL: Readonly<Record<Bottleneck, string>> = {
  clean: "No Bottleneck (Clean Headroom)",
  queue_serialization: "LLM Queue Serialization (Single-GPU Wait)",
  vram_spill: "VRAM Spillover / Swapping",
  cpu_ipc: "CPU/IPC Overhead",
  timeouts: "Timeouts / Failures",
};

/** Attribute the run's primary bottleneck (pure). Order: failures, VRAM, GPU queue, CPU/IPC, clean. */
export function classifyRun(summary: RunSummary, probes: readonly ProbeEvent[], t: Thresholds = THRESHOLDS): RunReadout {
  const done = probes.filter(isTerminal);
  const ok = done.filter((p) => p.phase === "completed");
  const slowestEv = done.reduce<ProbeEvent | null>((a, p) => ((p.totalRttMs ?? 0) > (a?.totalRttMs ?? -1) ? p : a), null);
  const slowest = slowestEv && isProbeNode(slowestEv.node) ? { node: slowestEv.node, rttMs: slowestEv.totalRttMs ?? 0 } : null;
  const vt = summary.hw.vramTotalMb;
  const vramDeltaMb = summary.hw.vramUsedMb != null && summary.baseline.vramUsedMb != null ? Math.max(0, summary.hw.vramUsedMb - summary.baseline.vramUsedMb) : null;
  const vramHeadroomMb = vt != null && summary.hw.vramUsedMb != null ? vt - summary.hw.vramUsedMb : null;
  const base = { slowest, wallMs: summary.wallMs, peakGpuPct: summary.hw.gpuUtilPct, vramDeltaMb, vramHeadroomMb, peakCpuPct: summary.hw.cpuPct };
  const i = summary.intensity;

  const failed = done.filter((p) => p.phase !== "completed");
  if (failed.length && !summary.aborted) {
    const n = failed.map((p) => p.node).join(", ");
    return { ...base, bottleneck: "timeouts", why: `${failed.length} probe${failed.length === 1 ? "" : "s"} failed or timed out (${n}): ${failed[0].error ?? "no answer"}` };
  }
  const peakV = vramShare(summary.hw);
  const gpu = ok.filter((p) => p.profile === "gpu");
  const slowGen = gpu.filter((p) => p.tokensPerSec != null && p.tokensPerSec < t.spillTokPerSec);
  if ((peakV != null && peakV >= t.vramSpillPct) || (peakV != null && peakV >= 0.85 && slowGen.length)) {
    return { ...base, bottleneck: "vram_spill", why: `VRAM peaked at ${Math.round((peakV ?? 0) * 100)}%${slowGen.length ? ` and generation fell to ${Math.min(...slowGen.map((p) => p.tokensPerSec ?? 0))} tok/s` : ""}: weights / KV cache are spilling to system RAM.` };
  }
  const queuedGpu = gpu.filter((p) => queueBound(p, i, t));
  if (gpu.length >= 2 && queuedGpu.length) {
    const worst = queuedGpu.reduce((a, p) => ((p.queueWaitMs ?? 0) > (a.queueWaitMs ?? 0) ? p : a));
    return { ...base, bottleneck: "queue_serialization", why: `${queuedGpu.length} of ${gpu.length} GPU probes spent most of their time waiting for the single GPU slot (worst: ${PROBE_LABEL[worst.node as ProbeNode] ?? worst.node} queued ${worst.queueWaitMs} ms).` };
  }
  const queuedCpu = ok.filter((p) => p.profile === "cpu" && queueBound(p, i, t));
  const lightSlow = i === "LIGHT" && ok.some((p) => (p.totalRttMs ?? 0) > t.rttMs.LIGHT.green);
  if (summary.hw.cpuPct >= 90 || queuedCpu.length || lightSlow) {
    const why = summary.hw.cpuPct >= 90 ? `CPU peaked at ${Math.round(summary.hw.cpuPct)}%.` : queuedCpu.length ? `${queuedCpu.length} CPU daemon probe${queuedCpu.length === 1 ? "" : "s"} waited for one of the arbiter's script permits.` : `IPC / runtime round trips above ${t.rttMs.LIGHT.green} ms with no model involved.`;
    return { ...base, bottleneck: "cpu_ipc", why };
  }
  return { ...base, bottleneck: "clean", why: ok.length ? `All ${ok.length} probes answered inside the green band with no meaningful queueing.` : "Nothing finished (aborted)." };
}

// ── [v3] App vs system footprint, Librarian phases, policy brief ────────────

export type FootprintResource = "CPU" | "GPU" | "VRAM";

/** Below these the difference is noise (percentage points / MB). */
export const FOOTPRINT_MARGIN: Readonly<Record<FootprintResource, number>> = { CPU: 2, GPU: 2, VRAM: 256 };

/**
 * Where did the load come from (pure)? `outside` lists every resource on which the processes
 * outside the agent stack peaked clearly above the stack itself (unknown values never count).
 */
export function footprintVerdict(app: Footprint, other: Footprint, margin: Readonly<Record<FootprintResource, number>> = FOOTPRINT_MARGIN): { outside: FootprintResource[] } {
  const pairs: [FootprintResource, number | null, number | null][] = [
    ["CPU", app.cpuPct, other.cpuPct],
    ["GPU", app.gpuUtilPct, other.gpuUtilPct],
    ["VRAM", app.vramUsedMb, other.vramUsedMb],
  ];
  return { outside: pairs.filter(([r, a, o]) => a != null && o != null && o - a > margin[r]).map(([r]) => r) };
}

export type PhaseKey = "queueWaitMs" | "retrievalMs" | "prefillMs" | "generationMs";

export const PHASE_PARTS: readonly { key: PhaseKey; label: string; color: string }[] = [
  { key: "queueWaitMs", label: "Queue", color: "#fbbf24" },
  { key: "retrievalMs", label: "Retrieval", color: "#a78bfa" },
  { key: "prefillMs", label: "Prefill", color: "#22d3ee" },
  { key: "generationMs", label: "Generation", color: "#34d399" },
];

export interface PhaseShare {
  key: PhaseKey;
  label: string;
  color: string;
  ms: number;
  /** Whole percent; the parts sum to exactly 100 (largest remainder). */
  pct: number;
}

/** The four timed phases as shares of their sum (pure). Null when nothing was timed. */
export function phaseShares(p: Phases | null | undefined): { totalMs: number; parts: PhaseShare[] } | null {
  if (!p) return null;
  const known = PHASE_PARTS.flatMap((d) => {
    const ms = p[d.key];
    return ms != null && Number.isFinite(ms) && ms >= 0 ? [{ ...d, ms }] : [];
  });
  const totalMs = known.reduce((a, d) => a + d.ms, 0);
  if (!known.length || totalMs <= 0) return null;
  const raw = known.map((d) => (d.ms / totalMs) * 100);
  const pct = raw.map(Math.floor);
  let left = 100 - pct.reduce((a, b) => a + b, 0);
  for (const i of raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0]).map(([, i]) => i)) {
    if (left <= 0) break;
    pct[i] += 1;
    left -= 1;
  }
  return { totalMs, parts: known.map((d, i) => ({ ...d, pct: pct[i] })) };
}

/** Text alternative for the stacked phase bar (pure). */
export const phaseSummaryText = (s: { totalMs: number; parts: PhaseShare[] }) => `${s.parts.map((p) => `${p.label} ${p.pct}% (${p.ms} ms)`).join(", ")}; total ${s.totalMs} ms`;

/** [v4] The selectable orchestration modes, in display order (mirrors policy.rs `MODES`). */
export const ORCHESTRATION_MODES: readonly { id: OrchestrationMode; label: string; tradeoff: string; preempt: boolean }[] = [
  {
    id: "trading_priority",
    label: "Trading Priority",
    tradeoff: "Trading preempts running Coder / Librarian / Prompter jobs (they re-queue) — near-zero trading wait; Tony is never preempted.",
    preempt: true,
  },
  {
    id: "build_balanced",
    label: "Build / Balanced",
    tradeoff: "Fair queueing — running coding / research jobs finish uninterrupted; Trading can wait up to one job (~20 s on Heavy).",
    preempt: false,
  },
];

/** The mode a policy is in (pure; mirrors policy.rs `mode_of` for builds that don't report it). */
export function modeOf(view: PolicyView): OrchestrationMode | "custom" {
  if (view.mode) return view.mode;
  const g = view.policy.gpu;
  return ORCHESTRATION_MODES.find((m) => m.preempt === g.preemptTier3ForTier1 && g.maxConcurrentSlots === 1)?.id ?? "custom";
}

/** Can the running build switch modes? A pre-v4 build's policy_get has no `modes` (pure). */
export const canSwitchMode = (view: PolicyView | null) => !!view?.modes?.length;

/**
 * [v4] The selector state after a fresh policy read (pure): an in-flight switch is left alone; a
 * stale error clears once the policy is applied again; needs-rebuild clears once the build can switch.
 */
export function nextModeSync(cur: ModeSync, view: PolicyView): ModeSync {
  const idle: ModeSync = { state: "idle", target: null, error: null };
  if (cur.state === "applying" || cur.state === "idle") return cur;
  if (cur.state === "needs_rebuild") return canSwitchMode(view) ? idle : cur;
  return view.status.state === "applied" ? idle : cur;
}

/** An IPC error that means "this command isn't in the running build yet" (pure). */
export const isMissingCommand = (msg: string) => /not found|unknown command|not allowed|isn't registered|is not registered/i.test(msg);

/** One terse line on what the policy in force does (pure). */
export function policyBrief(p: OrchestratorPolicy): string {
  // null / absent: the Settings slider (os.json scheduler.maxConcurrency) decides; a number is a policy override.
  const n = p.gpu.maxConcurrentSlots;
  const slots = n == null ? "GPU slots: Settings" : `${n} GPU slot${n === 1 ? "" : "s"} (policy)`;
  const t1 = Object.entries(p.gpu.tiers)
    .filter(([, t]) => t === 1)
    .map(([n]) => (isProbeNode(n) ? PROBE_LABEL[n] : n));
  const tiers = Object.keys(p.gpu.tiers).length ? `Tier 1: ${t1.length ? t1.join(", ") : "none"}` : "no tiers (FIFO)";
  const cb = p.circuitBreaker.enabled ? `breaker on @ ${p.circuitBreaker.tier1WaitMs} ms` : "breaker off";
  return `${slots} · ${tiers} · ${cb}`;
}
