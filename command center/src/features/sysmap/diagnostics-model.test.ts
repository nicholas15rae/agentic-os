import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { dirOf, reportToRun } from "./diagnostics-store";
import type { Footprint, HwPeak, OrchestratorPolicy, ProbeEvent, ProbeNode, RunSummary } from "./diagnostics.contract";
import { classifyRun, drawStagger, footprintVerdict, healthOf, phaseShares, phaseSummaryText, policyBrief, PRESETS, PROBE_NODES, THRESHOLDS } from "./diagnostics-model";
import { badgeText, conduitFor } from "./DiagnosticOverlay";
import { busPath, linkPath, ROSTER, SPINE_X } from "./model";

const hw = (o: Partial<HwPeak> = {}): HwPeak => ({ cpuPct: 20, ramUsedGb: 12, gpuUtilPct: 30, vramUsedMb: 6000, vramTotalMb: 12288, ...o });
const ev = (o: Partial<ProbeEvent>): ProbeEvent => ({ runId: "r", node: "tony", phase: "completed", profile: "gpu", at: 0, queueWaitMs: 0, execMs: 0, totalRttMs: 0, tokensPerSec: null, tokens: null, hw: hw(), error: null, phases: null, ...o });
const run = (o: Partial<RunSummary> = {}): RunSummary => ({ runId: "r", intensity: "MEDIUM", wallMs: 2000, hw: hw(), baseline: hw({ vramUsedMb: 5800 }), aborted: false, trigger: "ui", reportPath: null, hwApp: null, hwOther: null, ...o });

describe("disk reports", () => {
  it("Rust's PRESET_NODES mirror the panel's PRESETS (scheduled / request runs = UI presets)", () => {
    const rs = readFileSync(resolve(__dirname, "../../../src-tauri/src/commands/diagnostics.rs"), "utf8");
    for (const p of PRESETS) {
      const m = rs.match(new RegExp(`\\("${p.id}", &\\[([^\\]]*)\\]\\)`));
      expect(m, p.id).not.toBeNull();
      expect(m![1].split(",").map((s) => s.trim().replace(/"/g, "")).filter(Boolean)).toEqual(p.nodes);
    }
  });
  it("maps a report back to a run record and finds its folder", () => {
    const dir = "C:\\Users\\x\\AppData\\Roaming\\os.agentic.commandcenter\\telemetry\\diagnostics";
    expect(dirOf(`${dir}\\reports\\diag-1-2.json`)).toBe(dir);
    const r = reportToRun(
      {
        schema: "agentic-os.diagnostic-report/1", diagnostic: true, ephemeral: true, runId: "diag-1-2", trigger: "schedule", preset: "stress", intensity: "HEAVY", nodes: ["tony"], staggerMs: {}, timeoutMs: 1, startedAt: 0, finishedAt: 1, wallMs: 9, aborted: false,
        hardware: { baseline: hw(), peak: hw({ vramUsedMb: 9000 }), vramSpikeMb: 3000, vramHeadroomMb: 3288, vramPeakPct: 73.2 }, slowest: null, probes: [ev({})],
        counters: { before: { runs: {}, memory: [] }, after: { runs: {}, memory: [] }, unchanged: true, changes: [], note: "" },
      },
      dir,
    );
    expect(r.summary.reportPath).toBe(`${dir}\\reports\\diag-1-2.json`);
    expect(r.summary.hw.vramUsedMb).toBe(9000);
    expect(r.summary.trigger).toBe("schedule");
    // [v3] a pre-v3 report: no app/other footprint, no phases.
    expect(r.summary.hwApp).toBeNull();
    expect(r.summary.hwOther).toBeNull();
    expect(r.probes[0].phases).toBeNull();
  });
});

describe("probe nodes", () => {
  it("cover the whole roster (the arbiter's 14 nodes)", () => {
    expect([...PROBE_NODES].sort()).toEqual([...ROSTER].sort());
  });
  it("presets name only known nodes and the stress preset includes Trading", () => {
    for (const p of PRESETS) for (const n of p.nodes) expect(PROBE_NODES).toContain(n);
    expect(PRESETS.find((p) => p.id === "stress")!.nodes).toEqual(expect.arrayContaining(["tony", "trading", "coder", "librarian", "observer", "security", "garbage"]));
  });
  it("draws the Librarian stagger inside its range", () => {
    const daily = PRESETS.find((p) => p.id === "daily");
    expect(drawStagger(daily, () => 0).librarian).toBe(600);
    expect(drawStagger(daily, () => 1).librarian).toBe(2500);
    expect(drawStagger(undefined)).toEqual({});
  });
});

describe("healthOf", () => {
  it("is null while in flight", () => {
    expect(healthOf(ev({ phase: "executing" }), "MEDIUM")).toBeNull();
  });
  it("bands by RTT per intensity", () => {
    expect(healthOf(ev({ totalRttMs: 10, queueWaitMs: 0 }), "LIGHT")).toBe("green");
    expect(healthOf(ev({ totalRttMs: THRESHOLDS.rttMs.LIGHT.green + 1, queueWaitMs: 0 }), "LIGHT")).toBe("amber");
    expect(healthOf(ev({ totalRttMs: THRESHOLDS.rttMs.LIGHT.amber + 1, queueWaitMs: 0 }), "LIGHT")).toBe("red");
  });
  it("marks a fast node that mostly waited in line as amber", () => {
    expect(healthOf(ev({ totalRttMs: 2000, queueWaitMs: 1500, execMs: 500 }), "MEDIUM")).toBe("amber");
  });
  it("is red on timeout, error or VRAM spill", () => {
    expect(healthOf(ev({ phase: "timeout" }), "MEDIUM")).toBe("red");
    expect(healthOf(ev({ phase: "error" }), "MEDIUM")).toBe("red");
    expect(healthOf(ev({ totalRttMs: 100, hw: hw({ vramUsedMb: 12000 }) }), "MEDIUM")).toBe("red");
  });
});

describe("classifyRun", () => {
  it("clean headroom", () => {
    const r = classifyRun(run(), [ev({ node: "tony", totalRttMs: 900, execMs: 880, queueWaitMs: 20 }), ev({ node: "observer", profile: "cpu", totalRttMs: 40, execMs: 40 })]);
    expect(r.bottleneck).toBe("clean");
    expect(r.slowest).toEqual({ node: "tony", rttMs: 900 });
    expect(r.vramDeltaMb).toBe(200);
  });
  it("single-GPU queue serialisation", () => {
    const r = classifyRun(run(), [ev({ node: "tony", totalRttMs: 1000, execMs: 1000, queueWaitMs: 0 }), ev({ node: "coder", totalRttMs: 2100, execMs: 1000, queueWaitMs: 1100 })]);
    expect(r.bottleneck).toBe("queue_serialization");
  });
  it("VRAM spill beats queueing", () => {
    const r = classifyRun(run({ hw: hw({ vramUsedMb: 11900 }) }), [ev({ node: "tony", totalRttMs: 1000, queueWaitMs: 0 }), ev({ node: "coder", totalRttMs: 2100, queueWaitMs: 1100 })]);
    expect(r.bottleneck).toBe("vram_spill");
  });
  it("CPU permit contention among daemons", () => {
    const d = (node: ProbeNode, q: number) => ev({ node, profile: "cpu", totalRttMs: 600 + q, execMs: 600, queueWaitMs: q });
    expect(classifyRun(run(), [d("observer", 0), d("security", 0), d("garbage", 600)]).bottleneck).toBe("cpu_ipc");
  });
  it("failures first, unless the run was aborted", () => {
    const evs = [ev({ node: "tony", phase: "timeout", totalRttMs: 60000, error: "no answer within 60000 ms" })];
    expect(classifyRun(run(), evs).bottleneck).toBe("timeouts");
    expect(classifyRun(run({ aborted: true }), evs).bottleneck).toBe("clean");
  });
});

describe("overlay", () => {
  it("routes Trading over its Financer link, never Tony's spine", () => {
    expect(conduitFor("trading")).toBe(linkPath("finance", "trading"));
    expect(conduitFor("trading")).not.toContain(`M ${SPINE_X} `);
    expect(conduitFor("observer")).toBe(busPath("observer"));
  });
  it("badge shows the queue / exec split", () => {
    expect(badgeText(ev({ totalRttMs: 1200, queueWaitMs: 300, execMs: 900, tokensPerSec: 41.5 }))).toBe("1200ms · Queue: 300ms | Exec: 900ms · 41.5 tok/s");
    expect(badgeText(ev({ phase: "queued", totalRttMs: null }))).toBe("QUEUED…");
  });
});

// ── [v3] ────────────────────────────────────────────────────────────────────

const fp = (o: Partial<Footprint> = {}): Footprint => ({ cpuPct: 5, ramUsedGb: 2, gpuUtilPct: 80, vramUsedMb: 9000, processes: ["command-center", "llama-server"], ...o });

describe("footprintVerdict", () => {
  it("blames nothing outside when the agent stack dominates", () => {
    expect(footprintVerdict(fp(), fp({ cpuPct: 4, gpuUtilPct: 5, vramUsedMb: 600 })).outside).toEqual([]);
  });
  it("names each resource where other processes peaked clearly higher", () => {
    expect(footprintVerdict(fp({ cpuPct: 6, gpuUtilPct: 10 }), fp({ cpuPct: 35, gpuUtilPct: 30, vramUsedMb: 1000 })).outside).toEqual(["CPU", "GPU"]);
  });
  it("ignores noise inside the margin and unknown GPU / VRAM", () => {
    expect(footprintVerdict(fp({ cpuPct: 5 }), fp({ cpuPct: 6.5, gpuUtilPct: null, vramUsedMb: null })).outside).toEqual([]);
    expect(footprintVerdict(fp({ gpuUtilPct: null }), fp({ gpuUtilPct: 99, cpuPct: 1, vramUsedMb: 0 })).outside).toEqual([]);
  });
});

describe("phaseShares", () => {
  const ph = (o = {}) => ({ queueWaitMs: 1000, retrievalMs: 500, prefillMs: 2000, generationMs: 6500, inputTokens: 2300, outputTokens: 160, tokensPerSec: 24.6, diagnosis: "genuine compute", ...o });
  it("splits the four phases and sums to exactly 100", () => {
    const s = phaseShares(ph())!;
    expect(s.totalMs).toBe(10_000);
    expect(s.parts.map((p) => [p.label, p.pct])).toEqual([["Queue", 10], ["Retrieval", 5], ["Prefill", 20], ["Generation", 65]]);
    const odd = phaseShares(ph({ queueWaitMs: 1, retrievalMs: 1, prefillMs: 1, generationMs: 0 }))!;
    expect(odd.parts.reduce((a, p) => a + p.pct, 0)).toBe(100);
    expect(odd.parts.find((p) => p.key === "generationMs")!.pct).toBe(0);
  });
  it("skips untimed phases and returns null when nothing was timed", () => {
    expect(phaseShares(ph({ queueWaitMs: null, retrievalMs: null }))!.parts.map((p) => p.key)).toEqual(["prefillMs", "generationMs"]);
    expect(phaseShares(ph({ queueWaitMs: null, retrievalMs: null, prefillMs: null, generationMs: null }))).toBeNull();
    expect(phaseShares(ph({ queueWaitMs: 0, retrievalMs: 0, prefillMs: 0, generationMs: 0 }))).toBeNull();
    expect(phaseShares(null)).toBeNull();
  });
  it("has a text alternative for the bar", () => {
    expect(phaseSummaryText(phaseShares(ph())!)).toBe("Queue 10% (1000 ms), Retrieval 5% (500 ms), Prefill 20% (2000 ms), Generation 65% (6500 ms); total 10000 ms");
  });
});

describe("policyBrief", () => {
  const pol = (): OrchestratorPolicy => ({
    version: 1,
    gpu: { maxConcurrentSlots: 1, tiers: { trading: 1, tony: 1, librarian: 3 }, defaultTier: 3, queueTimeoutMs: { "1": 0, "2": 120000, "3": 600000 }, preemptTier3ForTier1: false },
    circuitBreaker: { enabled: true, tier1WaitMs: 1500, holdMs: 30000, clearAfterIdleMs: 5000 },
    tradingHours: { timezone: "America/New_York", window: "08:00-16:00", weekdaysOnly: true, daemonGapSeconds: 90, holdGarbageHygiene: true, tier3MaxConcurrentBackground: 0, librarianMinIntervalMs: 0 },
    librarian: { packetMaxChars: 9000, itemMaxChars: 1600, perRootHits: 3, historyHits: 5, archiveHits: 5, walkFilesMax: 600, walkDepth: 4, archiveGzMaxBytes: 8388608, maxOutputTokens: null },
    liveObserver: { tickMs: 1000, port: 8791, streamMaxMb: 50 },
  });
  it("summarises slots, Tier 1 and the breaker", () => {
    expect(policyBrief(pol())).toBe("1 GPU slot (policy) · Tier 1: Trading Agent, Tony · breaker on @ 1500 ms");
    const p = pol();
    p.gpu.tiers = {};
    p.gpu.maxConcurrentSlots = 2;
    p.circuitBreaker.enabled = false;
    expect(policyBrief(p)).toBe("2 GPU slots (policy) · no tiers (FIFO) · breaker off");
  });
  it("says the Settings slider decides when maxConcurrentSlots is null or absent", () => {
    const p = pol();
    p.gpu.maxConcurrentSlots = null;
    expect(policyBrief(p)).toBe("GPU slots: Settings · Tier 1: Trading Agent, Tony · breaker on @ 1500 ms");
    delete (p.gpu as Partial<OrchestratorPolicy["gpu"]>).maxConcurrentSlots;
    expect(policyBrief(p)).toBe("GPU slots: Settings · Tier 1: Trading Agent, Tony · breaker on @ 1500 ms");
  });
  it("matches the Rust defaults' field names (camelCase serde)", () => {
    const rs = readFileSync(resolve(__dirname, "../../../src-tauri/src/commands/policy.rs"), "utf8");
    const camel = (k: string) => k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
    const p = pol() as unknown as Record<string, Record<string, unknown>>;
    for (const [rustStruct, key] of [["GpuPolicy", "gpu"], ["BreakerPolicy", "circuitBreaker"], ["TradingHours", "tradingHours"], ["LibrarianPolicy", "librarian"], ["LivePolicy", "liveObserver"]] as const) {
      const body = rs.match(new RegExp(`pub struct ${rustStruct} \\{([^}]*)\\}`))![1];
      const fields = [...body.matchAll(/pub (\w+):/g)].map((m) => camel(m[1])).sort();
      expect(Object.keys(p[key]).sort(), rustStruct).toEqual(fields);
    }
  });
});
