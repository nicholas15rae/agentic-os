/**
 * Play Place staging hub (Thought-to-Product Phases 2–4). Mirrors of `buildhub.rs` — snake_case on
 * the wire, exactly as the spec's TaskEnvelope contract.
 */

export type TargetRuntime = "internal_widget" | "external_os";
export type AssignedWorker = "claude" | "coder" | "designer";
export type BuildStatus = "queued" | "building" | "paused" | "repair_queue" | "smoke_testing" | "ready_for_merge" | "deployed";

export const RUNTIMES: readonly TargetRuntime[] = ["internal_widget", "external_os"];
export const WORKERS: readonly AssignedWorker[] = ["claude", "coder", "designer"];
export const STATUSES: readonly BuildStatus[] = ["queued", "building", "paused", "repair_queue", "smoke_testing", "ready_for_merge", "deployed"];

export interface HumanOverride {
  directive: string;
  priority: "high";
  at: number;
  applied_at: number | null;
  applied_stage: string | null;
  auto?: boolean;
}

/** The spec's strict TaskEnvelope (`human_override` is the Phase 4 extension). */
export interface BuildEnvelope {
  build_id: string;
  project_slug: string;
  title: string;
  target_runtime: TargetRuntime;
  output_directory: string;
  spec_summary: string;
  milestones: string[];
  acceptance_criteria: string[];
  assigned_worker: AssignedWorker;
  preview_url: string | null;
  status: BuildStatus;
  human_override: HumanOverride[];
}

export interface SmokeCheck {
  name: string;
  ok: boolean;
  required: boolean;
  detail: string;
}

export interface SmokeReport {
  passed: boolean;
  at: number;
  ms: number;
  checks: SmokeCheck[];
  failed_assertions: string[];
  trace: string;
}

export interface LogLine {
  at: number;
  stream: "stdout" | "stderr" | "event";
  text: string;
}

export interface BuildView {
  envelope: BuildEnvelope;
  seq: number;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  progress: number;
  stage: string | null;
  iteration: number;
  max_iterations: number;
  worker_task_id: string | null;
  dev_task_id: string | null;
  logs: LogLine[];
  smoke: { attempts: number; failures: number; running: boolean; last: SmokeReport | null };
  repair: { reason: string; trace: string; failed_assertions: string[]; at: number; auto: boolean } | null;
  paused_from: BuildStatus | null;
  brief: string;
  note_ids: string[];
  promoted_at: number | null;
  preview_version: number;
  committing: boolean;
  /** 1-based place among the builds still waiting (null once handed to an agent). */
  position: number | null;
  peek: { url: string | null; reachable: boolean; checked_at: number };
}

export interface BuildHubView {
  builds: BuildView[];
  external_base: string;
  staging_root: string;
  worker_lane_busy: boolean;
  claude_lane_busy: boolean;
}

export interface IntakeQuestion {
  id: string;
  question: string;
  options: string[];
  allow_free_text: boolean;
}

export interface PeekStatus {
  url: string | null;
  reachable: boolean;
  status: BuildStatus;
  version: number;
}

export interface RuntimeConfig {
  staging_root: string;
  external_base: string;
  default_external_base: string;
}
