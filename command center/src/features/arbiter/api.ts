/**
 * Compute arbiter ("hot potato"), Finance vault and health commands (arbiter.rs,
 * finance_vault.rs, tony_dispatch.rs). Feature-local typed contract, same `native()` invoke and
 * desktop-only rule as `native-ext.ts`.
 */
import { isTauri, native } from "@/lib/platform";

export type NodeState = "DORMANT" | "QUEUED" | "ACTIVE_TOKEN" | "ACTIVE" | "LOCKED_VAULT" | "ERROR";
export type NodeGroup = "foreground" | "build_circle" | "retrieval" | "script" | "vault" | "auditor" | "mesh";

export interface ArbiterNode {
  id: string;
  label: string;
  group: NodeGroup;
  compute: "gpu" | "cpu" | "api";
  namespace: string | null;
  schedule: string;
  state: NodeState;
  configured: boolean;
  note: string;
  error: string | null;
  runs: number;
  lastActiveAt: number | null;
  holdingMs: number | null;
}

export interface Handoff {
  at: number;
  from: string;
  to: string;
  kind: "token" | "handoff" | "memory_read" | "memory_write" | "script";
  ms: number | null;
  label: string;
}

export interface Percentiles {
  n: number;
  last?: number;
  p50?: number;
  p95?: number;
  max?: number;
}

export interface MemoryRow {
  namespace: string;
  active: number;
  archived: number;
  activeKb: number;
}

export interface GpuReading {
  name: string;
  utilPct: number;
  vramUsedMb: number;
  vramTotalMb: number;
}

export interface ArbiterSnapshot {
  nodes: ArbiterNode[];
  holder: string | null;
  queued: string[];
  away: boolean;
  vaultOpen: boolean;
  feed: Handoff[];
  latency: { tony: Percentiles; turnaround: Percentiles };
  contextTokens: number | null;
  idleSecs: number | null;
  taskPermits: number;
  hardware?: { gpu: GpuReading | null; gpuSampler: boolean; cpuPct: number; ramUsedMb: number; ramTotalMb: number };
  memory?: MemoryRow[];
  edges?: [string, string][];
}

/** `arbiter-state` payload (the node view, on change). */
export interface ArbiterStateEvent {
  nodes: ArbiterNode[];
  away: boolean;
  holder: string | null;
}

export interface VaultStatus {
  open: boolean;
  entries: number | null;
  hasKey: boolean;
  hasLedger: boolean;
  idleSecs: number | null;
}

export interface HealthReport {
  at: number;
  ok: boolean;
  queueDispatcher: { running: number; queuedTasks: number; finished: number; halted: number; gpuRelayBusy: boolean; last: { id: string; summary: string; at: number } | null };
  gpuLock: { holder: string | null; waiting: string[]; settling: number; capacity: number; away: boolean; tokenNode: string | null };
  garbageDaemon: { ok: boolean; status: { running: boolean; heartbeatAt: number | null; lastPurgeAt: number | null; handshakes: number; refused: number; lastResult: unknown } };
  financeVault: { ok: boolean; open: boolean; checks: { check: string; pass: boolean; detail: string }[] };
  gpuSampler: boolean;
}

/** Tony's dispatch packet as Rust reports it under a reply (`DispatchView`). */
export interface DispatchView {
  id: string;
  state: "held" | "pending" | "queued" | "invalid";
  priority: "low" | "normal" | "urgent";
  reason: string;
  tasks: { taskId: string; targetAgent: string; action: string; acceptance: string[]; dependsOn: string[]; status: string; detail: string }[];
}

export interface PacketResult {
  id: string;
  summary: string;
  results: { taskId: string; targetAgent: string; status: "done" | "failed" | "halted" | "blocked" | "refused" | "held"; attempts: number; preempted: number; output: string | null; error: string | null }[];
}

interface Commands {
  arbiter_snapshot: { args: undefined; result: ArbiterSnapshot };
  arbiter_set_away: { args: { on: boolean }; result: ArbiterSnapshot };
  system_health: { args: undefined; result: HealthReport };
  finance_vault_status: { args: undefined; result: VaultStatus };
  finance_vault_unlock: { args: undefined; result: { open: boolean; entries: number } };
  finance_vault_lock: { args: undefined; result: { open: boolean } };
  tony_dispatch_approve: { args: { id: string }; result: DispatchView };
  tony_dispatch_discard: { args: { id: string }; result: boolean };
}

export function acmd<K extends keyof Commands>(name: K, ...args: Commands[K]["args"] extends undefined ? [] : [Commands[K]["args"]]): Promise<Commands[K]["result"]> {
  return native<Commands[K]["result"]>(name, args[0] as Record<string, unknown> | undefined);
}

export type ArbiterEventName = "arbiter-state" | "arbiter-handoff" | "packet-result";

export async function onArbiterEvent<P>(event: ArbiterEventName, handler: (payload: P) => void): Promise<() => void> {
  if (!isTauri()) return () => undefined;
  const { listen } = await import("@tauri-apps/api/event");
  return listen<P>(event, (e) => handler(e.payload));
}
