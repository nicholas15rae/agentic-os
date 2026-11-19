import { create } from "zustand";
import { cmd, isTauri, onNativeEvent, type DevBriefExport, type DevErrorItem, type DevFixProgress, type DevTask, type DevTaskPriority, type DevTaskSource, type DevTraceStep, type DevUiState, type NativeCommands, type TraceStep } from "@/lib/platform";
import { useNav } from "@/stores/nav";
import { useSettings } from "@/stores/settings";
import { useVoice } from "@/features/voice/voice-store";
import { useFocus } from "@/features/os/focus-store";
import { gated } from "@/features/bridge/gate";
import { notifyDevQueueChanged, onDevQueueChanged, uiState } from "./devqueue-events";
import { nextPriority, nextStatus, sortTasks, upsertTask, type CategoryFilter } from "./format";
import { scrubText, useTrace } from "./trace-store";
import { useZoneUi } from "./zone-store";

/**
 * The TaskDock's view of the Rust-owned dev task queue (`devqueue.db`). Every write goes
 * through a `dev_task_*` command and the returned row replaces the local one, so the list
 * always shows what SQLite holds. Desktop only.
 */

export const QUEUE_DESKTOP_ONLY = "The dev task queue lives in the desktop app.";

type AddArgs = NativeCommands["dev_task_add"]["args"];

interface DevQueueState {
  tasks: DevTask[];
  loaded: boolean;
  error: string | null;
  filter: CategoryFilter;
  showDone: boolean;
  exporting: boolean;
  lastExport: { path: string; at: number } | null;
  setFilter: (f: CategoryFilter) => void;
  setShowDone: (v: boolean) => void;
  load: () => Promise<void>;
  /** `ui` defaults to the current voice/section/view state. Returns the stored task. */
  add: (args: AddArgs) => Promise<DevTask>;
  cycleStatus: (id: string) => Promise<void>;
  cyclePriority: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  exportBrief: () => Promise<DevBriefExport>;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The UI keys a snapshot keeps, from the live stores. */
export function currentUi(extra: { sttEngine?: string; ttsEngine?: string } = {}) {
  const v = useVoice.getState();
  return uiState({
    voiceState: v.state,
    listening: v.state === "listening",
    section: useNav.getState().section,
    thread: v.activeThread,
    viewMode: useSettings.getState().systemMapMode,
    ...extra,
  });
}

export const useDevQueue = create<DevQueueState>((set, get) => {
  const replace = (t: DevTask) => set((s) => ({ tasks: upsertTask(s.tasks, t), error: null }));
  const need = () => {
    if (!isTauri()) throw new Error(QUEUE_DESKTOP_ONLY);
  };
  return {
    tasks: [],
    loaded: false,
    error: isTauri() ? null : QUEUE_DESKTOP_ONLY,
    filter: "all",
    showDone: false,
    exporting: false,
    lastExport: null,
    setFilter: (filter) => set({ filter }),
    setShowDone: (showDone) => set({ showDone }),

    load: async () => {
      if (!isTauri()) return set({ error: QUEUE_DESKTOP_ONLY });
      try {
        set({ tasks: sortTasks(await cmd("dev_task_list", {})), loaded: true, error: null });
      } catch (e) {
        set({ error: msg(e), loaded: true });
      }
    },

    add: async (args) => {
      need();
      const t = await cmd("dev_task_add", { ...args, ui: args.ui ?? currentUi() });
      replace(t);
      return t;
    },

    cycleStatus: async (id) => {
      const t = get().tasks.find((x) => x.id === id);
      if (!t) return;
      try {
        need();
        replace(await cmd("dev_task_update", { id, status: nextStatus(t.status, t) }));
      } catch (e) {
        set({ error: msg(e) });
      }
    },

    cyclePriority: async (id) => {
      const t = get().tasks.find((x) => x.id === id);
      if (!t) return;
      try {
        need();
        replace(await cmd("dev_task_update", { id, priority: nextPriority(t.priority) as DevTaskPriority }));
      } catch (e) {
        set({ error: msg(e) });
      }
    },

    remove: async (id) => {
      try {
        need();
        await cmd("dev_task_delete", { id });
        set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id), error: null }));
      } catch (e) {
        set({ error: msg(e) });
      }
    },

    exportBrief: async () => {
      need();
      set({ exporting: true });
      try {
        const r = await cmd("dev_brief_export");
        set({ lastExport: { path: r.path, at: Date.now() }, error: null });
        return r;
      } finally {
        set({ exporting: false });
      }
    },
  };
});

// Writes from elsewhere (the voice intent) refresh the dock when it's loaded.
if (typeof window !== "undefined") {
  onDevQueueChanged(() => {
    if (useDevQueue.getState().loaded) void useDevQueue.getState().load();
  });
}

export { notifyDevQueueChanged };

// ── P6: Claude Code fix queue ───────────────────────────────────────────────

/** Max recent errors a fix carries (Rust caps it again). */
export const FIX_ERRORS_MAX = 20;
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n)}…`);

/**
 * The newest failed trace steps (`ok: false`), oldest first, at most `max`: labels, hops and
 * error text only (already scrubbed by the trace ring; scrubbed again here). Never arguments.
 */
export function recentErrors(steps: readonly TraceStep[], max = FIX_ERRORS_MAX): DevErrorItem[] {
  return steps
    .filter((s) => s.ok === false)
    .slice(-max)
    .map((s) => ({ source: "trace" as const, at: s.at, hop: s.hop, label: clip(scrubText(s.label ?? ""), 160), error: clip(scrubText(s.error ?? "failed"), 300) }));
}

/** `currentUi()` plus the URL route and the focused card / zone. */
export function fixUi(): DevUiState {
  const route = typeof location !== "undefined" ? clip(location.hash || "", 120) : "";
  const focus = useFocus.getState().card ?? useZoneUi.getState().selected ?? undefined;
  return { ...currentUi(), ...uiState({ route, focus }) };
}

/**
 * Queue a fix for Claude Code: `dev_fix_queue` stores it as Queued (kind fix, tags
 * dev-fix + claude-queue) with the recent failed steps, the UI route and Rust's scrubbed
 * snapshot, and rewrites `.agenticos/claude-fix-queue.json`. Local and reversible: no card.
 */
export async function queueFix(args: { title: string; description?: string; priority?: DevTaskPriority; source?: DevTaskSource; trace?: DevTraceStep }): Promise<DevTask> {
  if (!isTauri()) throw new Error(QUEUE_DESKTOP_ONLY);
  const t = await cmd("dev_fix_queue", { ...args, errors: recentErrors(useTrace.getState().steps), ui: fixUi() });
  useDevQueue.setState((s) => ({ tasks: upsertTask(s.tasks, t), error: null }));
  return t;
}

/**
 * Ask to run Claude Code on a fix in its own worktree. ALWAYS raises the confirmation card
 * first (`required` makes `gated` skip the unapproved call), and only its yes calls
 * `dev_fix_dispatch` with `approved: true`. Resolves null when cancelled or blocked.
 */
export function dispatchFix(t: Pick<DevTask, "id" | "title">, channel: "voice" | "text" = "text"): Promise<DevTask | null> {
  if (!isTauri()) return Promise.reject(new Error(QUEUE_DESKTOP_ONLY));
  ensureFixEvents();
  const branch = `fix/${t.id.slice(0, 8)}`;
  return gated(
    {
      action: "claude-dispatch",
      summary: `Run Claude Code on the fix “${t.title}” in a new worktree (branch ${branch})`,
      required: "PERMISSION_REQUIRED:execute,write",
      detail: { fix: t.title, branch, verify: "typecheck · vitest · cargo test", commits: "none — you review and merge" },
      channel,
    },
    (approved) => cmd("dev_fix_dispatch", { id: t.id, approved }),
    (r) => `Claude Code is working on “${r.title}” on ${branch}. The app re-runs the checks; only a pass marks it Done.`,
  ).then((r) => {
    if (r) useDevQueue.setState((s) => ({ tasks: upsertTask(s.tasks, r), error: null }));
    return r;
  });
}

/** Stop a live run. */
export async function cancelFix(id: string): Promise<boolean> {
  if (!isTauri()) return false;
  return cmd("dev_fix_cancel", { id });
}

const STOP_WORDS = new Set(["the", "a", "an", "my", "that", "this", "for", "on", "of", "to", "fix", "bug", "issue", "one"]);
const words = (s: string) =>
  s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !STOP_WORDS.has(w));

/** The open fix a spoken name refers to ("mic" → "Mic stutters after a barge-in"), or null. */
export function matchFix(tasks: readonly DevTask[], query: string): DevTask | null {
  const q = words(query);
  const open = tasks.filter((t) => t.kind === "fix" && t.status !== "Done");
  if (!q.length) return null;
  const raw = query.trim().toLowerCase();
  const idHit = raw.length >= 6 ? open.find((t) => t.id.startsWith(raw)) : undefined;
  if (idHit) return idHit;
  const rank = (x: DevTask) => (x.status === "Pending" ? 0 : 1);
  let best: { t: DevTask; score: number } | null = null;
  for (const t of open) {
    const tw = [...new Set(words(t.title))];
    const hit = q.filter((w) => tw.includes(w) || tw.some((x) => x.length >= 4 && w.length >= 4 && (x.startsWith(w) || w.startsWith(x)))).length;
    const score = hit / q.length;
    if (score < 0.5) continue;
    if (!best || score > best.score || (score === best.score && (rank(t) > rank(best.t) || (rank(t) === rank(best.t) && t.createdAt > best.t.createdAt)))) best = { t, score };
  }
  return best?.t ?? null;
}

/** Live-run progress, per fix, in memory only (never localStorage): the last 40 lines. */
export const PROGRESS_MAX = 40;
const PHASES = new Set<string>(["start", "init", "text", "tool", "result", "verify", "done", "failed"]);

export const useFixProgress = create<{ lines: Record<string, DevFixProgress[]>; clear: (id: string) => void }>((set) => ({
  lines: {},
  clear: (id) =>
    set((s) => {
      const lines = { ...s.lines };
      delete lines[id];
      return { lines };
    }),
}));

/** Validate a `dev-fix-progress` payload (untrusted shape) and append it to the in-memory tail. */
export function pushProgress(raw: unknown): void {
  if (!raw || typeof raw !== "object") return;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !/^[0-9a-f-]{36}$/.test(r.id) || typeof r.phase !== "string" || !PHASES.has(r.phase)) return;
  const p: DevFixProgress = { id: r.id, phase: r.phase as DevFixProgress["phase"], text: clip(scrubText(typeof r.text === "string" ? r.text : ""), 220), at: typeof r.at === "number" ? r.at : Date.now() };
  useFixProgress.setState((s) => ({ lines: { ...s.lines, [p.id]: [...(s.lines[p.id] ?? []), p].slice(-PROGRESS_MAX) } }));
}

let listening = false;
/** Subscribe once to the live-run events (progress lines; queue changes from Rust → the dock/ledger reload). */
export function ensureFixEvents(): void {
  if (listening || !isTauri()) return;
  listening = true;
  void onNativeEvent("dev-fix-progress", pushProgress);
  void onNativeEvent("devqueue-changed", () => notifyDevQueueChanged());
}
