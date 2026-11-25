import { create } from "zustand";
import { isTauri, native } from "@/lib/platform";
import type { DiagCommands, DiagEvents, DiagReport, DiagStore, LiveStatus, PolicyView, ProbeEvent, ProbeNode, RunSummary } from "./diagnostics.contract";
import { canSwitchMode, drawStagger, isMissingCommand, modeOf, nextModeSync, PRESETS, type Preset } from "./diagnostics-model";
import { syncLiveObserver } from "./live-observer";

/**
 * Diagnostic & Load Probe state (contract: `diagnostics.contract.ts`). Strictly volatile: nothing
 * here touches localStorage, disk or any agent; Export JSON is the only way results leave.
 */

function dcmd<K extends keyof DiagCommands>(name: K, args: DiagCommands[K]["args"]): Promise<DiagCommands[K]["result"]> {
  return native<DiagCommands[K]["result"]>(name, args as unknown as Record<string, unknown>);
}

async function onDiag<K extends keyof DiagEvents>(event: K, handler: (p: DiagEvents[K]) => void): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<DiagEvents[K]>(event, (e) => handler(e.payload));
}

/** Preset whose node set is selected (its stagger applies); cleared by any manual toggle. */
let activePreset: Preset | undefined;
let loopTimer: ReturnType<typeof setTimeout> | null = null;
let listening: Promise<void> | null = null;
/** Events that arrived before `diag_run` returned their run id (fast LIGHT probes). */
let early: ProbeEvent[] = [];
let earlyRun: RunSummary[] = [];

const clearLoop = () => {
  if (loopTimer) clearTimeout(loopTimer);
  loopTimer = null;
};

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** `…\telemetry\diagnostics\reports\x.json` → `…\telemetry\diagnostics` (pure). */
export function dirOf(reportPath: string): string {
  const parts = reportPath.split(/[\\/]/);
  return parts.slice(0, -2).join(reportPath.includes("\\") ? "\\" : "/");
}

/** A report from disk as the panel's run record (pure). */
export function reportToRun(r: DiagReport, dir: string | null): { summary: RunSummary; probes: ProbeEvent[] } {
  const sep = dir?.includes("\\") ? "\\" : "/";
  return {
    summary: {
      runId: r.runId,
      intensity: r.intensity,
      wallMs: r.wallMs,
      hw: r.hardware.peak,
      baseline: r.hardware.baseline,
      aborted: r.aborted,
      trigger: r.trigger,
      reportPath: dir ? [dir, "reports", `${r.runId}.json`].join(sep) : null,
      hwApp: r.hardware.app ?? null,
      hwOther: r.hardware.other ?? null,
    },
    // Reports written before v3 have no `phases`.
    probes: r.probes.map((p) => ({ ...p, phases: p.phases ?? null })),
  };
}

export const useDiag = create<DiagStore>((set, get) => {
  const awaitingId = () => get().status === "running" && get().runId === null;

  const onProbe = (ev: ProbeEvent) => {
    if (awaitingId()) return void early.push(ev);
    // A scheduled / request.json run started while this window was idle: follow it live.
    if (ev.runId !== get().runId && get().status !== "running" && ev.phase === "dispatched") {
      set({ runId: ev.runId, status: "running", probes: {}, summary: null });
    }
    if (ev.runId !== get().runId) return;
    set({ probes: { ...get().probes, [ev.node]: ev } });
  };

  const onRun = (s: RunSummary) => {
    if (awaitingId()) return void earlyRun.push(s);
    if (s.runId !== get().runId) return;
    const probes = Object.values(get().probes).filter((p): p is ProbeEvent => !!p);
    set({ summary: s, status: "idle", dir: s.reportPath ? dirOf(s.reportPath) : get().dir, history: [...get().history, { summary: s, probes }].slice(-50) });
    if (s.trigger !== "ui") void get().hydrate();
    clearLoop();
    const { loop } = get();
    if (loop.on && !s.aborted) loopTimer = setTimeout(() => void get().pulse(), loop.everyMs);
  };

  /** [v3] Every Live state we learn about also starts / tears down the webview observer. */
  /** [v4] A fresh policy view; a stale mode error / needs-rebuild clears once the policy recovers. */
  const applyPolicy = (policy: PolicyView) => {
    set({ policy, modeSync: nextModeSync(get().modeSync, policy) });
  };

  const applyLive = (live: LiveStatus) => {
    set({ live });
    syncLiveObserver(!!live.on);
  };

  const listen = () =>
    (listening ??= (async () => {
      await onDiag("diag-probe", onProbe);
      await onDiag("diag-run", onRun);
      await onDiag("live-status", applyLive);
    })());

  return {
    intensity: "LIGHT",
    runIntensity: "LIGHT",
    selected: [...PRESETS[0].nodes],
    loop: { on: false, everyMs: 10_000 },
    status: "idle",
    runId: null,
    probes: {},
    summary: null,
    history: [],
    error: null,
    panelOpen: true,
    setIntensity: (intensity) => set({ intensity }),
    toggle: (n: ProbeNode) => {
      activePreset = undefined;
      const s = get().selected;
      set({ selected: s.includes(n) ? s.filter((x) => x !== n) : [...s, n] });
    },
    applyPreset: (id) => {
      activePreset = PRESETS.find((p) => p.id === id);
      if (activePreset) set({ selected: [...activePreset.nodes] });
    },
    async pulse() {
      clearLoop();
      if (!isTauri()) return set({ error: "Probes need the desktop engine." });
      const { selected, intensity, status } = get();
      if (status === "running") return;
      if (!selected.length) return set({ error: "Pick at least one node." });
      try {
        await listen();
        early = [];
        earlyRun = [];
        set({ status: "running", runIntensity: intensity, error: null, probes: {}, summary: null, runId: null });
        const runId = await dcmd("diag_run", { args: { nodes: selected, intensity, staggerMs: drawStagger(activePreset), timeoutMs: null, preset: activePreset?.id ?? null } });
        set({ runId });
        const [evs, runs] = [early, earlyRun];
        early = [];
        earlyRun = [];
        evs.forEach(onProbe);
        runs.forEach(onRun);
      } catch (e) {
        clearLoop();
        set({ status: "error", error: errText(e), loop: { ...get().loop, on: false } });
      }
    },
    setLoop: (on, everyMs) => {
      set({ loop: { on, everyMs: everyMs ?? get().loop.everyMs } });
      if (!on) clearLoop();
      else if (get().status !== "running") void get().pulse();
    },
    async abort() {
      clearLoop();
      set({ loop: { ...get().loop, on: false } });
      if (!isTauri()) return;
      try {
        await dcmd("diag_abort", { runId: get().runId });
      } catch (e) {
        set({ error: errText(e) });
      }
    },
    clear: () => {
      if (get().status === "running") return;
      set({ probes: {}, summary: null, error: null });
    },
    togglePanel: () => set({ panelOpen: !get().panelOpen }),
    dir: null,
    schedule: null,
    async hydrate() {
      if (!isTauri()) return;
      try {
        await listen();
        // [v3] Live + policy load on their own: a failure here never hides the reports.
        void get().refreshLive();
        void dcmd("policy_get", {}).then(applyPolicy, () => undefined);
        const [{ latest, activeRunId, dir }, reports, schedule] = await Promise.all([dcmd("diag_latest", {}), dcmd("diag_reports", { limit: 20 }), dcmd("diag_schedule_get", {})]);
        const history = reports.slice().reverse().map((r) => reportToRun(r, dir));
        set({ dir, schedule, history });
        if (get().status === "running" && get().runId) return;
        if (activeRunId) {
          // A run is in flight (this window reloaded mid-run): re-attach; its events fill in.
          set({ runId: activeRunId, status: "running", probes: {}, summary: null });
        } else if (latest && !get().summary) {
          const run = reportToRun(latest, dir);
          set({ runId: latest.runId, runIntensity: latest.intensity, summary: run.summary, probes: Object.fromEntries(run.probes.map((p) => [p.node, p])) });
        }
      } catch (e) {
        set({ error: errText(e) });
      }
    },
    async setSchedule(schedule) {
      try {
        set({ schedule: await dcmd("diag_schedule_set", { schedule }), error: null });
      } catch (e) {
        set({ error: errText(e) });
      }
    },
    exportJson: () =>
      JSON.stringify({ tool: "agentic-os schematic diagnostic probe", diagnostic: true, ephemeral: true, exportedAt: new Date().toISOString(), runs: get().history }, null, 2),
    live: null,
    liveBusy: false,
    policy: null,
    async setLive(on) {
      if (!isTauri()) return set({ error: "Live Observer needs the desktop engine." });
      if (get().liveBusy) return;
      set({ liveBusy: true });
      try {
        await listen();
        applyLive(await dcmd("live_set", { on }));
        set({ error: null });
      } catch (e) {
        set({ error: `Live Observer: ${errText(e)}` });
      } finally {
        set({ liveBusy: false });
      }
    },
    async refreshLive() {
      if (!isTauri()) return;
      try {
        applyLive(await dcmd("live_status", {}));
      } catch {
        /* live.rs not registered (older build): the toggle stays off */
      }
    },
    async refreshPolicy() {
      if (!isTauri()) return;
      try {
        applyPolicy(await dcmd("policy_get", {}));
      } catch (e) {
        set({ error: `Policy: ${errText(e)}` });
      }
    },
    modeSync: { state: "idle", target: null, error: null },
    async setMode(mode) {
      if (!isTauri() || get().modeSync.state === "applying") return;
      const cur = get().policy;
      if (cur && !canSwitchMode(cur)) {
        // A pre-v4 build: don't attempt a switch it can't make.
        return set({ modeSync: { state: "needs_rebuild", target: mode, error: null } });
      }
      set({ modeSync: { state: "applying", target: mode, error: null } });
      try {
        // Rust writes orchestrator_policy.json and applies it at once (events.jsonl logs the switch).
        const view = await dcmd("policy_set_mode", { mode });
        const ok = view.status.state === "applied" && modeOf(view) === mode;
        set({ policy: view, modeSync: ok ? { state: "idle", target: null, error: null } : { state: "error", target: mode, error: `policy ${view.status.state}` } });
      } catch (e) {
        const msg = errText(e);
        // A build from before v4 has no policy_set_mode: say so instead of a raw IPC error.
        set({ modeSync: { state: isMissingCommand(msg) ? "needs_rebuild" : "error", target: mode, error: msg } });
        void get().refreshPolicy();
      }
    },
  };
});
