/**
 * Native OS-control intents — the executing half. Local, reversible controls
 * (Gabagool on/off/volume, stop-audio, workspace switch, model swap, compute mode,
 * kill switch, status) run in-process: no gateway hop, no confirmation card.
 * Spotify lines are parsed and run by `spotify-intents.ts` (Rust grammar + `spotify_tool`).
 *
 * `voice-controller.ts handleInput` parses every line once with `parseOsLine`
 * (before a pending confirmation, so "stop" still works there) and runs the
 * result BEFORE idea capture, local intents and the planner, so a phrase like
 * "turn off gabagool mode" can never reach a gateway agent.
 */
import { collections } from "@/lib/cc-api";
import { gateway } from "@/lib/gateway";
import { cmd, isTauri, type FeedbackLevel } from "@/lib/platform";
import { useNav } from "@/stores/nav";
import { useSettings } from "@/stores/settings";
import { fireCue } from "@/features/cues/cue-runtime";
import { cueRecentlyActive, gabagoolOn, nudgeCueVolume, stopAllAudio, useCueRun } from "@/features/cues/player";
import type { CueWidget } from "@/features/cues/types";
import { useHealthStore } from "@/features/services/use-health";
import { useVoice } from "@/features/voice/voice-store";
import { roleLabel } from "@/features/dispatcher/roles";
import { useOs } from "./os-store";
import { usePipelines } from "./pipeline-store";
import { feedbackLevel } from "@/features/voice/narrator";
import { notifyDevQueueChanged, uiState } from "@/features/memmap/devqueue-events";
import { addressedStatusLine, parseOsIntent, resolveModel, slugCandidates, taskStatusText, type DevNoteKind, type OsIntent, type StatusTask, type WorkspaceId } from "./os-intent-parse";

export interface OsIntentResult {
  /** Spoken/shown reply; "" means the action already speaks for itself (a cue's intro). */
  reply: string;
  /** An approval card was raised for this request: on voice the card speaks its own read-back,
   * so `reply` is shown but not spoken (and the HUD stays "confirming"). */
  card?: boolean;
  /** Speak `reply` in this agent's roster voice ("hey Prompter, where are we at?"); default Tony. */
  agent?: string;
}

/** A cue's theme is playing right now (what `parseOsLine` reads as `cuePlaying`). */
export const cuePlayingNow = (): boolean => !!useCueRun.getState().running;

/** Parse a line against the live cue state. Null for anything that isn't an OS-control phrase. */
export function parseOsLine(text: string): OsIntent | null {
  const osName = useSettings.getState().osName || "Tony";
  return parseOsIntent(text, { osName, cueActive: cueRecentlyActive(), cuePlaying: cuePlayingNow() });
}

/** `channel` is where the line came from ("voice" or typed); only the dev queue records it.
 * Null: the line isn't ours after all (a weak "where's X at" with no build called X) — it goes on
 * to Tony as a normal turn. */
export async function runOsIntent(intent: OsIntent, channel?: string): Promise<OsIntentResult | null> {
  switch (intent.kind) {
    case "gabagool-on":
      return gabagoolOnAction();
    case "gabagool-off":
      return gabagoolOffAction(intent.explicit);
    case "cue-volume":
      return cueVolumeAction(intent.steps);
    case "workspace":
      return workspaceAction(intent.thread);
    case "model":
      return modelAction(intent.query);
    case "compute":
      return computeAction(intent.mode);
    case "kill-switch":
      return killSwitchAction(intent.on);
    case "status":
      return { reply: statusSummary() };
    case "agent-status":
      return agentStatusAction(intent);
    case "narration":
      return narrationAction(intent);
    case "dev-task":
      if (intent.taskKind === "fix") return queueFixAction(intent.title, channel === "voice" ? "voice" : "typed");
      return devTaskAction(intent.taskKind, intent.title, channel === "voice" ? "voice" : "typed");
    case "dev-fix-dispatch":
      return dispatchFixAction(intent.query, channel === "voice" ? "voice" : "text");
  }
}

/**
 * "Queue a Claude fix for …" / "dev fix: …" / "queue a fix for …": straight into the Claude
 * Code fix queue (devqueue.db → `.agenticos/claude-fix-queue.json`) as Queued, with the recent
 * failed trace steps and the UI route attached. Local and reversible: no card, no agent. The
 * store is loaded on demand so the System Map chunk stays out of the main bundle.
 */
async function queueFixAction(title: string, source: "voice" | "typed"): Promise<OsIntentResult> {
  if (!isTauri()) return { reply: "The dev queue lives in the desktop app." };
  try {
    const { queueFix } = await import("@/features/memmap/dev-queue");
    const t = await queueFix({ title, source });
    notifyDevQueueChanged();
    return { reply: `Queued a fix for Claude Code (${t.category}, P${t.priority}). It's in the Dev Fix queue.` };
  } catch (e) {
    return { reply: `Couldn't queue that fix: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * "Run the mic fix with Claude Code": find the open fix and RAISE the confirmation card. Nothing
 * runs before its yes (and Rust refuses the run without `approved: true` anyway).
 */
async function dispatchFixAction(query: string, channel: "voice" | "text"): Promise<OsIntentResult> {
  if (!isTauri()) return { reply: "Claude Code fix runs start from the desktop app." };
  try {
    const { dispatchFix, matchFix } = await import("@/features/memmap/dev-queue");
    const t = matchFix(await cmd("dev_task_list", {}), query);
    if (!t) return { reply: `I couldn't find an open fix matching “${query}”. Queue it first: “queue a Claude fix for …”.` };
    void dispatchFix(t, channel).catch(() => undefined);
    return { reply: `Running “${t.title}” with Claude Code in its own worktree needs your OK.`, card: true };
  } catch (e) {
    return { reply: `Couldn't start that fix: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * "Log a dev note …" / "queue a fix for …" / "add … to the dev queue": straight into the
 * System Map's local dev task queue (devqueue.db). Local and reversible (delete it from the
 * dock), so no confirmation card — and nothing is sent to Tony or any agent.
 */
async function devTaskAction(kind: DevNoteKind, title: string, source: "voice" | "typed"): Promise<OsIntentResult> {
  if (!isTauri()) return { reply: "The dev queue lives in the desktop app." };
  try {
    const ui = uiState({
      voiceState: useVoice.getState().state,
      section: useNav.getState().section,
      thread: useVoice.getState().activeThread,
      viewMode: useSettings.getState().systemMapMode,
    });
    const t = await cmd("dev_task_add", { title, kind, source, ui });
    notifyDevQueueChanged();
    const what = kind === "note" ? "dev note" : kind === "fix" ? "fix" : "task";
    return { reply: `Logged a ${what} to the dev queue (${t.category}, P${t.priority}).` };
  } catch (e) {
    return { reply: `Couldn't log that to the dev queue: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function gabagoolOnAction(): OsIntentResult {
  if (gabagoolOn()) return { reply: "Gabagool mode is already on." };
  const w = collections.snapshot<CueWidget>("cues").find((c) => c.builtin === "gabagool" && !c._deleted);
  if (!w) return { reply: "Gabagool mode isn't set up yet — add it in Settings → Voice & Triggers." };
  if (!w.enabled) return { reply: "Gabagool mode is turned off in Settings → Voice & Triggers." };
  fireCue(w);
  // The cue speaks its own intro line; no extra reply needed.
  return { reply: "" };
}

function gabagoolOffAction(explicit: boolean): OsIntentResult {
  // `explicit: false` only reaches here when a cue is running or fired within the last
  // 10 minutes (parseOsIntent's cueActive gate) — always worth stopping (and cancelling
  // any TTS still mid-intro), even if the cue itself already finished.
  const wasActive = !!useCueRun.getState().running || gabagoolOn();
  stopAllAudio();
  if (!wasActive && explicit) return { reply: "Gabagool mode is already off." };
  return { reply: "Gabagool mode off." };
}

async function cueVolumeAction(steps: number): Promise<OsIntentResult> {
  const pct = await nudgeCueVolume(25 * steps);
  return { reply: pct === null ? "No Gabagool theme loaded — add one in Settings → Voice & Triggers." : `Music at ${pct}%.` };
}

function workspaceAction(thread: WorkspaceId): OsIntentResult {
  useVoice.getState().setActiveThread(thread);
  useNav.getState().go("agents");
  return { reply: thread === "auto" ? "Switched to auto-routing." : `Switched to ${roleLabel(thread)}.` };
}

async function modelAction(query: string): Promise<OsIntentResult> {
  if (!isTauri()) return { reply: "Model switching needs the desktop app." };
  try {
    const models = await cmd("provider_models", { id: "lmstudio" });
    const id = resolveModel(query, models);
    if (!id) return { reply: `I couldn't find a model matching "${query}".` };
    try {
      await cmd("model_use", { model: id });
    } catch (e) {
      // A tight / spilling model needs the Model Lab's explicit confirm; voice never forces it.
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.startsWith("FIT_WARN:")) return { reply: `I didn't switch to ${id}: ${msg.replace(/^FIT_WARN:[a-z]+:\s*/, "")}. Confirm it in Settings → Model Lab if you still want it.` };
      throw e;
    }
    return { reply: `Switched the model to ${id}.` };
  } catch (e) {
    return { reply: `Couldn't switch models: ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function computeAction(mode: "local" | "hybrid" | "cloud"): Promise<OsIntentResult> {
  if (!isTauri()) return { reply: "Compute mode needs the desktop app." };
  try {
    await useOs.getState().patch({ compute: { mode } });
    return { reply: `Compute mode: ${mode.toUpperCase()}.` };
  } catch (e) {
    return { reply: `Couldn't change compute mode: ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function killSwitchAction(on: boolean): Promise<OsIntentResult> {
  if (!isTauri()) return { reply: "The kill switch needs the desktop app." };
  try {
    await useOs.getState().patch({ privacy: { killSwitch: on } });
    return { reply: on ? "Kill switch on — everything stays local." : "Kill switch off — cloud routing restored." };
  } catch (e) {
    return { reply: `Couldn't change the kill switch: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** A short status line from what's already on screen — no LLM call. */
export function statusSummary(): string {
  const svc = useHealthStore.getState().services;
  const cfg = useOs.getState().cfg;
  const open = Object.keys(usePipelines.getState().runs).length;
  const builds = open ? `${open} build${open === 1 ? "" : "s"} in progress` : "";
  if (!svc.length) return builds ? `${builds}. No service status yet — check the Services page.` : "No service status yet — check the Services page.";
  const up = svc.filter((s) => s.up).length;
  const down = svc.filter((s) => !s.up);
  const parts = [`${up}/${svc.length} services up`];
  if (down.length) parts.push(`down: ${down.map((s) => s.label).join(", ")}`);
  if (cfg) parts.push(`compute ${cfg.compute.mode}${cfg.privacy.killSwitch ? " · kill switch on" : ""}`);
  if (builds) parts.push(builds);
  return parts.join(" · ");
}

type AgentStatusIntent = Extract<OsIntent, { kind: "agent-status" }>;

/**
 * Status on demand (Part 6): "what's the coder doing", "where's the build at", "status of
 * my-app", "hey Prompter, where are we at?". A template over the task store — never an os_turn,
 * never a model call. Said TO an agent: that agent's latest voice summary, in its own roster
 * voice. Desktop: `task_status` (tasks.db). Phone: the gateway's task mirror.
 */
export async function agentStatusAction(i: AgentStatusIntent): Promise<OsIntentResult | null> {
  const voice = i.addressed && i.agent ? i.agent : undefined;
  try {
    if (isTauri()) {
      let r = await cmd("task_status", { agent: i.agent, slug: i.slug });
      // "status of my audition tracker": try the name without "my" too.
      for (const alt of i.slug ? slugCandidates(i.slug).slice(1) : []) if (!r.task_id) r = await cmd("task_status", { agent: i.agent, slug: alt });
      if (i.weak && !r.task_id) return null;
      // Said TO an agent: the line it speaks itself (its voice summary, or a first-person template).
      const text = voice ? (r.voice?.text ?? r.text) : r.text;
      return { reply: text, agent: voice };
    }
    const r = await gateway<{ items: StatusTask[] }>("/api/tasks?limit=50");
    const items = r.items ?? [];
    const slug = i.slug ? (slugCandidates(i.slug).find((s) => items.some((t) => t.project_slug === s)) ?? i.slug) : undefined;
    // Weak: a named one needs a build with that name; a general one ("how's the project going") an open build.
    const hit = slug ? items.some((t) => t.project_slug === slug) : items.some((t) => t.status !== "review_ready" && t.status !== "failed");
    if (i.weak && !hit) return null;
    const text = voice ? addressedStatusLine(items, voice) : taskStatusText(items, { agent: i.agent, slug });
    return { reply: text, agent: voice };
  } catch (e) {
    if (i.weak) return null;
    return { reply: `I couldn't read the build status just now: ${e instanceof Error ? e.message : String(e)}` };
  }
}

const NARRATION_WORDS: Record<FeedbackLevel, string> = { 0: "off (toasts only)", 1: "milestones only", 2: "milestones and handoffs", 3: "everything" };

/** "Narration off" / "narrate everything" / "quieter narration": os.json `feedback.sensitivity`. */
async function narrationAction(i: Extract<OsIntent, { kind: "narration" }>): Promise<OsIntentResult> {
  if (!isTauri()) return { reply: "Narration is set on the desktop app." };
  const cur = feedbackLevel(useOs.getState().cfg);
  const next = (i.level ?? Math.max(0, Math.min(3, cur + (i.step ?? 0)))) as FeedbackLevel;
  try {
    await useOs.getState().patch({ feedback: { sensitivity: next } });
    return { reply: `Narration: ${NARRATION_WORDS[next]}.` };
  } catch (e) {
    return { reply: `Couldn't change narration: ${e instanceof Error ? e.message : String(e)}` };
  }
}
