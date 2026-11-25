// diagnostics.contract.ts — Schematic Diagnostic & Load Probe. LOCKED after approval.
// [v3] additions (orchestrator policy + Live Observer Mode) are marked "[v3]".
//
// Rust: new `commands/diagnostics.rs` (registered in lib.rs). Out-of-band: it never calls
// `Arbiter::run_task`, `memtier::query/put`, AnythingLLM, the gateway or any webhook, and its
// GPU-slot label (`diagnostic · probe <node>`) is explicitly mapped to NO node by
// `arbiter::node_for_label`, so `runs`, RAG `active`, `archived` (disk) and conversation memory
// never move. Results live only in this zustand store (volatile, never localStorage).

import type { RosterId } from "./model";

/** Every probe target: the schematic roster plus the isolated Trading agent (new card on the schematic). */
export type ProbeNode = RosterId | "trading";

export type Intensity = "LIGHT" | "MEDIUM" | "HEAVY";

/**
 * How a node is exercised (decided in Rust from arbiter `compute`, not by the UI):
 * - "gpu":  LIGHT = IPC/wake round trip; MEDIUM = 1 short streamed LM Studio completion through the
 *           real GPU slot (background priority; Tony = foreground, like a real turn); HEAVY = ~4k-token
 *           synthetic context + 384-token generation through the slot.
 * - "cpu":  LIGHT = IPC/wake; MEDIUM/HEAVY = the real `security_gate::scan_secrets` + hashing over
 *           synthetic text, holding one of the arbiter's TASK_PERMITS (real script contention).
 * - Finance / Booking never touch the vault or n8n: they get the "cpu" profile.
 * Librarian at MEDIUM/HEAVY additionally does a read-only `memtier::peek` (no hit / last_hit bump).
 */
export type ProbeProfile = "gpu" | "cpu";

export type ProbePhase = "dispatched" | "queued" | "executing" | "completed" | "timeout" | "error";

export interface HwPeak {
  cpuPct: number;
  ramUsedGb: number;
  gpuUtilPct: number | null;
  vramUsedMb: number | null;
  vramTotalMb: number | null;
}

/** One `diag-probe` event (Rust emits one per phase change per node). Synthetic payloads are dropped in Rust. */
export interface ProbeEvent {
  runId: string;
  node: ProbeNode;
  phase: ProbePhase;
  profile: ProbeProfile;
  /** Unix ms of this event. */
  at: number;
  /** Present from `queued` on. */
  queueWaitMs: number | null;
  /** Present on terminal phases. */
  execMs: number | null;
  totalRttMs: number | null;
  tokensPerSec: number | null;
  tokens: number | null;
  /** Peak during this node's execution window (terminal phases). */
  hw: HwPeak | null;
  error: string | null;
  /** [v3] Per-phase timing (Librarian's pipeline today; null for every other node / older reports). */
  phases: Phases | null;
}

/** `diag-run` event: the run finished (all nodes terminal or aborted). */
export interface RunSummary {
  runId: string;
  intensity: Intensity;
  wallMs: number;
  /** Peak across the whole run (sampled every 250 ms). */
  hw: HwPeak;
  /** Baseline right before dispatch (VRAM headroom = peak − baseline vs total). */
  baseline: HwPeak;
  aborted: boolean;
  /** [v2] Who started it. */
  trigger: RunTrigger;
  /** [v2] Absolute path of the report written to disk (null: the write failed). */
  reportPath: string | null;
  /** [v3] Peak footprint of the agent stack (command-center + children, LM Studio, AnythingLLM, gateway, Bionic) during the run. */
  hwApp: Footprint | null;
  /** [v3] Peak footprint of everything else on the machine during the run. */
  hwOther: Footprint | null;
}

export type RunTrigger = "ui" | "schedule" | "request";

/**
 * [v2] The full report Rust writes for every finished run, before `diag-run` fires:
 * `<config>/telemetry/diagnostics/reports/<runId>.json` + `latest.json` (newest 500 kept).
 */
export interface DiagReport {
  schema: "agentic-os.diagnostic-report/1";
  diagnostic: true;
  ephemeral: true;
  runId: string;
  trigger: RunTrigger;
  preset: PresetId | null;
  intensity: Intensity;
  nodes: ProbeNode[];
  staggerMs: Partial<Record<ProbeNode, number>>;
  timeoutMs: number;
  startedAt: number;
  finishedAt: number;
  wallMs: number;
  aborted: boolean;
  hardware: {
    baseline: HwPeak;
    peak: HwPeak;
    vramSpikeMb: number | null;
    vramHeadroomMb: number | null;
    vramPeakPct: number | null;
    /** [v3] App vs everything else (peaks). Absent in reports written before v3. */
    app?: Footprint | null;
    other?: Footprint | null;
  };
  slowest: { node: ProbeNode; totalRttMs: number | null } | null;
  probes: ProbeEvent[];
  counters: {
    before: CounterSnapshot;
    after: CounterSnapshot;
    unchanged: boolean;
    changes: { counter: string; before: number; after: number }[];
    note: string;
  };
  /** [v3] Recent Librarian pipeline profiles (probe + real worker, newest last, at most 50). Absent before v3. */
  librarianProfiles?: LibrarianProfile[];
  /** [v3] The orchestrator policy in force when the run started. Absent before v3. */
  policy?: OrchestratorPolicy;
  /** [v3] GPU slot holders / waiters / breaker right before dispatch. Absent before v3. */
  slotDetailBefore?: SlotDetail | null;
}

export interface CounterSnapshot {
  runs: Partial<Record<ProbeNode, number>>;
  memory: { namespace: string; active: number; archived: number; activeKb: number }[];
}

/** [v2] Background schedule (`<telemetry dir>/schedule.json`). */
export interface DiagSchedule {
  enabled: boolean;
  everyMinutes: number;
  preset: PresetId;
  intensity: Intensity;
  /** Medium/Heavy fire only while nothing holds or waits for the GPU. */
  onlyWhenGpuIdle: boolean;
  lastRunAt: number | null;
}

export interface ScheduleView {
  schedule: DiagSchedule;
  nextAt: number | null;
  dir: string | null;
  presets: PresetId[];
}

export interface DiagRunArgs {
  nodes: ProbeNode[];
  intensity: Intensity;
  /** Per-node stagger in ms (Live Daily Stack's intermittent Librarian pings); default {}. */
  staggerMs: Partial<Record<ProbeNode, number>>;
  /** Per-node timeout; default LIGHT 5 s, MEDIUM 60 s, HEAVY 180 s. */
  timeoutMs: number | null;
  /** [v2] Preset label recorded in the report. */
  preset: PresetId | null;
}

/** Tauri IPC (all NEW in diagnostics.rs). Every request is tagged `{ diagnostic: true, ephemeral: true }` in Rust. */
export interface DiagCommands {
  /** fn diag_run(app, os, dispatch, sys, args: DiagRunArgs) -> Result<String (runId), String>; returns at once, streams events. */
  diag_run: { args: { args: DiagRunArgs }; result: string };
  /** fn diag_abort(run_id: Option<String>) -> bool; cancels in-flight probes (drops the HTTP stream + slot guard). */
  diag_abort: { args: { runId: string | null }; result: boolean };
  /** [v2] Newest report on disk + the run in flight (a reloaded window re-attaches) + the folder. */
  diag_latest: { args: Record<string, never>; result: { latest: DiagReport | null; activeRunId: string | null; dir: string | null } };
  /** [v2] Newest reports, newest first (default 20, max 100). */
  diag_reports: { args: { limit: number | null }; result: DiagReport[] };
  diag_schedule_get: { args: Record<string, never>; result: ScheduleView };
  diag_schedule_set: { args: { schedule: DiagSchedule }; result: ScheduleView };
  /** [v3] live.rs: turn Live Observer Mode on / off (OFF by default and after every restart). */
  live_set: { args: { on: boolean }; result: LiveStatus };
  /** [v3] live.rs: current Live Observer state. */
  live_status: { args: Record<string, never>; result: LiveStatus };
  /** [v3] live.rs: a webview-side event, sent only while Live is on (labels and numbers only). */
  live_ui_event: { args: { kind: UiEventKind; ms: number; detail: string | null }; result: null };
  /** [v3] policy.rs: the policy in force + its load state + the file path. */
  policy_get: { args: Record<string, never>; result: PolicyView };
  /** [v4] NEW (policy.rs, needs the app rebuild): rewrite orchestrator_policy.json for `mode` and apply it at once. */
  policy_set_mode: { args: { mode: OrchestrationMode }; result: PolicyView };
}
// [v2] On-demand without the UI: write `{ "preset": "stress", "intensity": "MEDIUM" }` (or
// `{ "nodes": [...], "intensity": … }`) to `<telemetry dir>/request.json`; the engine consumes it
// within ~5 s (after any run in flight), runs it and notes the outcome in `last-request.json`.

export type DiagEvents = {
  "diag-probe": ProbeEvent;
  "diag-run": RunSummary;
  /** [v3] live.rs emits this on every Live Observer state change. */
  "live-status": LiveStatus;
};

// ── [v3] Orchestrator policy + Live Observer Mode ───────────────────────────
// docs/proposals/orchestrator-policy-and-live-observer.md

/** [v3] Librarian pipeline phases (diagnostics.rs `Phases`). Every field is nullable. */
export interface Phases {
  queueWaitMs: number | null;
  retrievalMs: number | null;
  prefillMs: number | null;
  generationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  tokensPerSec: number | null;
  /** Backend diagnosis rule result, e.g. "retrieval / disk", "oversized context", "scheduling", "genuine compute". */
  diagnosis: string | null;
}

/** [v3] One recent Librarian pipeline profile in a report (phases + where it came from; extras optional). */
export interface LibrarianProfile extends Partial<Phases> {
  at?: number;
  /** "probe" | "worker" (free text from Rust). */
  source?: string;
  filesWalked?: number | null;
  bytesRead?: number | null;
  hits?: Record<string, number>;
}

/** [v3] procstats.rs `Footprint`. cpuPct is a share of the WHOLE machine (0-100). */
export interface Footprint {
  cpuPct: number;
  ramUsedGb: number;
  gpuUtilPct: number | null;
  vramUsedMb: number | null;
  processes: string[];
}

/** [v3] live.rs `LiveStatus`. */
export interface LiveStatus {
  on: boolean;
  port: number | null;
  url: string | null;
  /** Folder holding live_observer.json + live_stream.jsonl. */
  dir: string | null;
  ticks: number;
  /** Unix ms. */
  startedAt: number | null;
  lastError: string | null;
}

/** [v3] Webview-side Live events (live-observer.ts). */
export type UiEventKind = "ui_stall" | "ui_error";

/** [v3] scheduler.rs slot detail (camelCase). */
export interface SlotEntry {
  label: string;
  node: string | null;
  tier: number;
  /** Held for (holders) / waiting for (waiters). */
  ms: number;
}
export interface BreakerView {
  tripped: boolean;
  sinceMsAgo: number | null;
  trips: number;
  lastReason: string | null;
}
export interface SlotDetail {
  capacity: number;
  settling: number;
  holders: SlotEntry[];
  waiters: SlotEntry[];
  breaker: BreakerView;
  tier1WaitP95Ms: number | null;
}

/** [v3] `orchestrator_policy.json` (policy.rs `Policy`, camelCase). Tiers are 1-3 (1 = served first). */
export interface OrchestratorPolicy {
  version: number;
  gpu: {
    /** Default / absent = 1 (locked to the single GPU). null = follow the Settings slider (os.json scheduler.maxConcurrency); 2-8 = override (never exposed in the UI). */
    maxConcurrentSlots: number | null;
    /** Node id -> tier. Empty = every node on defaultTier. */
    tiers: Record<string, number>;
    defaultTier: number;
    /** "1" / "2" / "3" -> ms before a queue_timeout alert (0 = never). */
    queueTimeoutMs: Record<string, number>;
    preemptTier3ForTier1: boolean;
  };
  circuitBreaker: { enabled: boolean; tier1WaitMs: number; holdMs: number; clearAfterIdleMs: number };
  tradingHours: {
    timezone: string;
    /** "HH:MM-HH:MM" in timezone. */
    window: string;
    weekdaysOnly: boolean;
    daemonGapSeconds: number;
    holdGarbageHygiene: boolean;
    tier3MaxConcurrentBackground: number;
    librarianMinIntervalMs: number;
  };
  librarian: {
    packetMaxChars: number;
    itemMaxChars: number;
    perRootHits: number;
    historyHits: number;
    archiveHits: number;
    walkFilesMax: number;
    walkDepth: number;
    archiveGzMaxBytes: number;
    maxOutputTokens: number | null;
  };
  liveObserver: { tickMs: number; port: number; streamMaxMb: number };
}

/** [v3] `policy_status.json`. "rejected" / "missing": the last good policy stays in force. */
export interface PolicyStatus {
  state: "defaults" | "applied" | "rejected" | "missing";
  file: string | null;
  at?: number;
  errors?: string[];
  inForce?: string;
}

/** [v3] `policy_get` result. */
export interface PolicyView {
  policy: OrchestratorPolicy;
  status: PolicyStatus;
  file: string | null;
  /** [v4] Orchestration mode in force ("custom" = the file matches no mode row). Absent on builds before v4. */
  mode?: OrchestrationMode | "custom";
  /** [v4] Selectable modes, in display order (policy.rs `MODES`). */
  modes?: OrchestrationMode[];
}

/**
 * [v4] Orchestration modes (policy.rs `MODES`; add a row there + here to offer a new profile).
 * Every mode pins gpu.maxConcurrentSlots to 1: multi-slot concurrency is never exposed in the UI.
 */
export type OrchestrationMode = "trading_priority" | "build_balanced";

/** [v4] The mode selector's sync state. */
export interface ModeSync {
  state: "idle" | "applying" | "needs_rebuild" | "error";
  /** The mode being applied (or that failed). */
  target: OrchestrationMode | null;
  error: string | null;
}

// ── UI ──────────────────────────────────────────────────────────────────────

export type PresetId = "daemons" | "daily" | "dual" | "stress";

export type Bottleneck = "clean" | "queue_serialization" | "vram_spill" | "cpu_ipc" | "timeouts";

export type Health = "green" | "amber" | "red";

/** Tuning thresholds (one exported const in diagnostics-model.ts, unit-tested). */
export interface Thresholds {
  /** RTT ≤ green → green, ≤ amber → amber, else red; per intensity. */
  rttMs: Record<Intensity, { green: number; amber: number }>;
  /** queue share of RTT above this → amber at least ("waiting in line"). */
  queueShareAmber: number;
  /** VRAM used / total above this during the run → red + "vram_spill". */
  vramSpillPct: number;
  /** tokens/s below this on MEDIUM/HEAVY with high VRAM → spill. */
  spillTokPerSec: number;
}

export interface DiagStore {
  intensity: Intensity;
  /** Intensity of the in-flight / last run (badges are judged by it, not by the toggle). [added in build] */
  runIntensity: Intensity;
  selected: ProbeNode[];
  loop: { on: boolean; everyMs: 5000 | 10000 | 30000 };
  status: "idle" | "running" | "error";
  runId: string | null;
  /** Latest event per node for the current/last run (cleared by Clear Metrics). */
  probes: Partial<Record<ProbeNode, ProbeEvent>>;
  summary: RunSummary | null;
  /** All finished runs this session (for Export JSON); volatile only. */
  history: { summary: RunSummary; probes: ProbeEvent[] }[];
  error: string | null;
  panelOpen: boolean;
  setIntensity: (i: Intensity) => void;
  toggle: (n: ProbeNode) => void;
  applyPreset: (p: PresetId) => void;
  pulse: () => Promise<void>;
  setLoop: (on: boolean, everyMs?: 5000 | 10000 | 30000) => void;
  abort: () => Promise<void>;
  clear: () => void;
  /** Collapse / expand the panel. [added in build: panelOpen had no setter] */
  togglePanel: () => void;
  /** [v2] Folder the reports land in (null until loaded / browser). */
  dir: string | null;
  /** [v2] Background schedule (null until loaded / browser). */
  schedule: ScheduleView | null;
  /** [v2] Load the newest report + history from disk and re-attach to a run in flight. */
  hydrate: () => Promise<void>;
  setSchedule: (s: DiagSchedule) => Promise<void>;
  exportJson: () => string;
  /** [v3] Live Observer state (null until loaded / browser). */
  live: LiveStatus | null;
  /** [v3] A live_set call is in flight. */
  liveBusy: boolean;
  /** [v3] Policy in force + load state (null until loaded / browser). */
  policy: PolicyView | null;
  /** [v3] Turn Live Observer Mode on / off (also starts / stops the webview stall + error reporter). */
  setLive: (on: boolean) => Promise<void>;
  /** [v3] Re-read live_status (tick counter). */
  refreshLive: () => Promise<void>;
  /** [v3] Re-read policy_get (the backend watches the file itself; this refreshes the view). */
  refreshPolicy: () => Promise<void>;
  /** [v4] Orchestration mode selector state. */
  modeSync: ModeSync;
  /** [v4] Switch the orchestration mode (writes orchestrator_policy.json via policy_set_mode). */
  setMode: (mode: OrchestrationMode) => Promise<void>;
}

// States:
// - not desktop (browser/PWA): panel renders, controls disabled, "Probes need the desktop engine".
// - idle / empty: badges hidden; summary strip says "No run yet".
// - running: Run Pulse disabled, Stop/Abort enabled; conduits pulse per dispatched/returned event.
// - error (IPC failure): inline message in the panel; nodes keep their last badge.
// Mutating actions: none against user data. Probes do consume the GPU slot (that is the test);
// a Tony probe queues as foreground and can preempt a running background worker step, which
// re-queues itself exactly as when you talk to Tony. Persisted [v2]: the run reports and the
// schedule, in the telemetry folder only (never localStorage, never agent memory / RAG / counters).
