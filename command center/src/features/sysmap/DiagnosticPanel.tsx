import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Activity, ChevronRight, Copy, Download, Play, RefreshCw, Repeat, Square, Trash2 } from "lucide-react";
import { isTauri } from "@/lib/platform";
import type { DiagSchedule, Footprint, HwPeak, Intensity, OrchestrationMode, PresetId, ProbeEvent } from "./diagnostics.contract";
import { BOTTLENECK_LABEL, canSwitchMode, classifyRun, footprintVerdict, HEALTH_COLOR, isTerminal, modeOf, ORCHESTRATION_MODES, phaseShares, phaseSummaryText, policyBrief, PRESETS, PROBE_LABEL, PROBE_NODES } from "./diagnostics-model";
import { useDiag } from "./diagnostics-store";

const INTENSITY: readonly { id: Intensity; label: string; hint: string }[] = [
  { id: "LIGHT", label: "Light", hint: "IPC / runtime / registry round trip · 0 tokens" },
  { id: "MEDIUM", label: "Medium", hint: "One short local completion per GPU node (+ Librarian RAG peek); CPU daemons run the real scanner" },
  { id: "HEAVY", label: "Heavy", hint: "~4k-token context + 384 generated tokens per GPU node: VRAM / queue pressure" },
];
const EVERY = [5_000, 10_000, 30_000] as const;

const gb = (mb: number | null) => (mb == null ? "—" : `${(mb / 1024).toFixed(1)} GB`);
const pct = (n: number | null | undefined) => (n == null ? "—" : `${Math.round(n)}%`);
const RED = "#f87171";

const SYNC_TONE = { applied: HEALTH_COLOR.green, applying: HEALTH_COLOR.amber, needs_rebuild: HEALTH_COLOR.amber, rejected: RED, error: RED, loading: "var(--color-ink-3)" } as const;

/**
 * [v4] Orchestration Mode: how the single GPU slot treats Trading vs running Tier-3 jobs. Writes
 * orchestrator_policy.json through policy_set_mode (applied at once, logged in events.jsonl).
 */
function ModeSection({ desktop }: { desktop: boolean }) {
  const view = useDiag((s) => s.policy);
  const sync = useDiag((s) => s.modeSync);
  const setMode = useDiag((s) => s.setMode);
  // The policy can change outside this panel (a hand edit, another agent): re-read it every 3 s
  // while the panel is open (policy_get is an in-memory read).
  useEffect(() => {
    if (!desktop) return;
    const t = setInterval(() => void useDiag.getState().refreshPolicy(), 3_000);
    return () => clearInterval(t);
  }, [desktop]);
  const canSwitch = canSwitchMode(view);
  const active = view ? modeOf(view) : null;
  const shown = sync.state === "applying" && sync.target ? sync.target : active;
  const status: keyof typeof SYNC_TONE =
    sync.state === "applying"
      ? "applying"
      : sync.state === "error"
        ? "error"
        : !view
          ? "loading"
          : view.status.state === "rejected"
            ? "rejected"
            : sync.state === "needs_rebuild" || !canSwitch
              ? "needs_rebuild"
              : "applied";
  const statusText = { applied: "applied", applying: "applying…", needs_rebuild: "applied · switch needs rebuild", rejected: "file rejected", error: "not applied", loading: desktop ? "loading…" : "desktop only" }[status];
  const desc = ORCHESTRATION_MODES.find((m) => m.id === shown)?.tradeoff ?? (shown === "custom" ? "Custom: the policy matches no mode (GPU slots not pinned to 1, or keys set by hand). Pick a mode to pin it." : "");
  const interactive = !disabledMode(desktop, view, canSwitch, sync.state);
  const slots = view?.policy.gpu.maxConcurrentSlots;
  const pick = (id: OrchestrationMode) => {
    if (interactive && id !== shown) void setMode(id);
  };
  // ARIA radio pattern: one Tab stop (the checked radio), arrows move + select.
  const onKey = (e: ReactKeyboardEvent, i: number) => {
    const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const next = ORCHESTRATION_MODES[(i + d + ORCHESTRATION_MODES.length) % ORCHESTRATION_MODES.length];
    (e.currentTarget.parentElement?.children[ORCHESTRATION_MODES.indexOf(next)] as HTMLElement | undefined)?.focus();
    pick(next.id);
  };
  return (
    <section aria-labelledby="orch-mode-h" className="space-y-1">
      <div className="flex items-center gap-2">
        <h3 id="orch-mode-h" className="flex-1 font-mono fs-10 tracking-[0.14em] text-ink-3">
          ORCHESTRATION MODE
        </h3>
        <span className="font-mono fs-10" style={{ color: SYNC_TONE[status] }} aria-live="polite">
          ● {statusText}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-1 r-10 border border-white/10 p-0.5" role="radiogroup" aria-labelledby="orch-mode-h">
        {ORCHESTRATION_MODES.map((m, i) => {
          const on = shown === m.id;
          return (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={on}
              // aria-disabled (not disabled): focus stays on the control while a switch applies.
              aria-disabled={!interactive}
              tabIndex={on || (shown !== "trading_priority" && shown !== "build_balanced" && i === 0) ? 0 : -1}
              onClick={() => pick(m.id)}
              onKeyDown={(e) => onKey(e, i)}
              title={m.tradeoff}
              className={`min-h-[30px] r-8 px-1.5 font-mono fs-11 leading-tight transition-colors aria-disabled:cursor-not-allowed ${
                on ? (m.preempt ? "bg-amber/15 text-ink ring-1 ring-amber/60" : "bg-holo/15 text-ink ring-1 ring-holo/50") : "text-ink-2 hover:text-ink"
              }`}
            >
              {m.label}
            </button>
          );
        })}
      </div>
      {desc && <p className="fs-10.5 leading-snug text-ink-2">{desc}</p>}
      <p className="font-mono fs-10 text-ink-3">
        {slots === 1 ? "1 GPU slot · locked (single-GPU setup)" : slots == null ? "GPU slots: follow Settings · pick a mode to lock 1" : `${slots} GPU slots (policy) · pick a mode to lock 1`}
      </p>
      {desktop && view && !canSwitch && (
        <p className="font-mono fs-10 leading-snug" style={{ color: HEALTH_COLOR.amber }}>
          Read from the live policy. Switching needs the pending app rebuild (policy_set_mode).
        </p>
      )}
      {sync.state === "error" && sync.error && <p className="break-words font-mono fs-10 leading-snug" style={{ color: RED }}>{sync.error}</p>}
    </section>
  );
}

/** Is the mode selector inert right now (pure)? */
function disabledMode(desktop: boolean, view: unknown, canSwitch: boolean, state: string): boolean {
  return !desktop || !view || !canSwitch || state === "applying";
}

/** [v3] Live Observer Mode: OFF by default (and after every restart); no background cost while off. */
function LiveSection({ desktop }: { desktop: boolean }) {
  const live = useDiag((s) => s.live);
  const busy = useDiag((s) => s.liveBusy);
  const setLive = useDiag((s) => s.setLive);
  const on = !!live?.on;
  // The tick counter: re-read every 2 s, only while Live is on and this panel is open.
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => void useDiag.getState().refreshLive(), 2_000);
    return () => clearInterval(t);
  }, [on]);
  return (
    <section aria-label="Live Observer" className="space-y-1">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        disabled={!desktop || busy}
        onClick={() => void setLive(!on)}
        title="Streams a tick per second + every policy / breaker / probe event to disk and a loopback-only read-only HTTP port"
        className={`sysmap-ctl w-full ${on ? "border-holo/60 text-ink" : ""}`}
      >
        <span className="flex w-full items-center justify-between gap-2 font-mono fs-11">
          <span>Live Observer Mode</span>
          <span aria-hidden className={`relative h-3.5 w-6 rounded-full border transition-colors ${on ? "border-holo/70 bg-holo/30" : "border-white/20 bg-white/5"}`}>
            <span className={`absolute top-[1px] h-2.5 w-2.5 rounded-full transition-[left] ${on ? "left-[11px] bg-holo" : "left-[1px] bg-ink-3"}`} />
          </span>
        </span>
      </button>
      {on && live ? (
        <div className="space-y-0.5 font-mono fs-10 leading-snug" aria-live="polite">
          <p className="break-all text-ink-2">
            <span className="sysmap-blink text-[#f87171]">●</span> LIVE · {live.url ?? (live.port ? `127.0.0.1:${live.port}` : "no port")} · {live.ticks} ticks
          </p>
          {live.dir && (
            <p className="break-all text-ink-3" title="live_observer.json = latest tick; live_stream.jsonl = every tick + event">
              {live.dir} · live_observer.json / live_stream.jsonl
            </p>
          )}
        </div>
      ) : (
        <p className="font-mono fs-10 leading-snug text-ink-3">Off · no background cost. On: ticks + events to disk and 127.0.0.1 (read-only).</p>
      )}
      {live?.lastError && <p className="break-words font-mono fs-10 leading-snug" style={{ color: RED }}>{live.lastError}</p>}
    </section>
  );
}

const POLICY_TONE = { applied: HEALTH_COLOR.green, defaults: "var(--color-ink-2)", rejected: RED, missing: HEALTH_COLOR.amber } as const;

/** [v3] The orchestrator policy in force. The backend hot-reloads the file; Reload only refreshes this view. */
function PolicySection({ desktop }: { desktop: boolean }) {
  const view = useDiag((s) => s.policy);
  const refreshPolicy = useDiag((s) => s.refreshPolicy);
  const [busy, setBusy] = useState(false);
  if (!desktop) return null;
  const st = view?.status;
  const file = st?.file ?? view?.file ?? null;
  const reload = async () => {
    setBusy(true);
    await refreshPolicy();
    setBusy(false);
  };
  const lastGood = st?.state === "rejected" || st?.state === "missing";
  return (
    <section aria-label="Orchestrator policy" className="space-y-0.5 font-mono fs-10 leading-snug">
      <div className="flex items-center gap-2">
        <span className="tracking-[0.14em] text-ink-3">POLICY</span>
        <span className="min-w-0 flex-1 truncate fs-10.5" style={{ color: st ? POLICY_TONE[st.state] : undefined }}>
          {st ? (st.state === "missing" ? "file missing" : st.state) : "not loaded"}
        </span>
        <button type="button" onClick={() => void reload()} disabled={busy} className="sysmap-ctl h-[22px] min-w-0 px-2 fs-10" aria-label="Reload policy view">
          <span className="flex items-center gap-1"><RefreshCw size={10} className={busy ? "animate-spin" : undefined} /> Reload</span>
        </button>
      </div>
      {file && <p className="break-all text-ink-3">{file}</p>}
      {st?.state === "rejected" && !!st.errors?.length && (
        <ul className="list-disc space-y-0.5 pl-3.5" style={{ color: RED }} aria-label="Policy errors">
          {st.errors.map((e, i) => (
            <li key={i} className="break-words">{e}</li>
          ))}
        </ul>
      )}
      {lastGood && <p style={{ color: st?.state === "rejected" ? RED : HEALTH_COLOR.amber }}>last good policy in force</p>}
      {view && <p className="text-ink-3">{policyBrief(view.policy)}</p>}
    </section>
  );
}

/** [v3] App / inference vs Total system (peaks during the run). */
function FootprintBlock({ app, other, system }: { app: Footprint; other: Footprint; system: HwPeak }) {
  const { outside } = footprintVerdict(app, other);
  const rows: { id: "CPU" | "GPU" | "VRAM"; cells: [string, string, string] }[] = [
    { id: "CPU", cells: [pct(app.cpuPct), pct(other.cpuPct), pct(system.cpuPct)] },
    { id: "GPU", cells: [pct(app.gpuUtilPct), pct(other.gpuUtilPct), pct(system.gpuUtilPct)] },
    { id: "VRAM", cells: [gb(app.vramUsedMb), gb(other.vramUsedMb), gb(system.vramUsedMb)] },
  ];
  return (
    <div className="space-y-1">
      <table className="w-full table-fixed fs-10.5" aria-label="App and inference versus total system, peaks during the run">
        <thead>
          <tr className="text-ink-3">
            <th scope="col" className="w-[3.2rem] text-left font-normal tracking-[0.08em]">PEAK</th>
            <th scope="col" className="text-right font-normal" title={app.processes.join(", ") || undefined}>App</th>
            <th scope="col" className="text-right font-normal">Other</th>
            <th scope="col" className="text-right font-normal">System</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <th scope="row" className="text-left font-normal text-ink-3">{r.id}</th>
              <td className="text-right text-ink">{r.cells[0]}</td>
              <td className="text-right" style={{ color: outside.includes(r.id) ? HEALTH_COLOR.amber : "var(--color-ink)" }}>{r.cells[1]}</td>
              <td className="text-right text-ink-2">{r.cells[2]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {outside.length > 0 && (
        <p className="leading-snug" style={{ color: HEALTH_COLOR.amber }}>
          Other &gt; App on {outside.join(", ")}: spike came from outside the agent stack.
        </p>
      )}
    </div>
  );
}

/** [v3] Librarian pipeline: Queue / Retrieval / Prefill / Generation as a stacked bar + tokens + diagnosis. */
function PhaseBreakdown({ probes }: { probes: ProbeEvent[] }) {
  const p = probes.find((e) => e.node === "librarian" && e.phases)?.phases;
  if (!p) return null;
  const sh = phaseShares(p);
  const n = (v: number | null) => (v == null ? "—" : String(v));
  return (
    <div role="group" aria-label="Librarian phase breakdown" className="space-y-1 border-t border-white/10 pt-2 font-mono fs-10.5">
      <h3 className="fs-10 tracking-[0.14em] text-ink-3">LIBRARIAN PHASES{sh ? ` · ${sh.totalMs}ms` : ""}</h3>
      {sh && (
        <>
          <div role="img" aria-label={`Librarian phases: ${phaseSummaryText(sh)}`} className="flex h-2.5 w-full overflow-hidden rounded-full border border-white/10 bg-white/5">
            {sh.parts.map((x) => (x.pct > 0 ? <span key={x.key} style={{ width: `${x.pct}%`, background: x.color }} /> : null))}
          </div>
          <ul aria-hidden className="flex flex-wrap gap-x-2 gap-y-0.5 fs-10 text-ink-3">
            {sh.parts.map((x) => (
              <li key={x.key} className="flex items-center gap-1">
                <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: x.color }} />
                {x.label} {x.pct}% <span className="text-ink-2">{x.ms}ms</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="fs-10 text-ink-3">
        in <span className="text-ink">{n(p.inputTokens)}</span> tok · out <span className="text-ink">{n(p.outputTokens)}</span> tok ·{" "}
        <span className="text-ink">{p.tokensPerSec == null ? "—" : p.tokensPerSec.toFixed(1)}</span> tok/s
      </p>
      {p.diagnosis && (
        <p className="leading-snug text-ink-2">
          Diagnosis: <span className="text-ink">{p.diagnosis}</span>
        </p>
      )}
    </div>
  );
}

function SummaryStrip() {
  const summary = useDiag((s) => s.summary);
  const probes = useDiag((s) => s.probes);
  const status = useDiag((s) => s.status);
  const list = useMemo(() => Object.values(probes).filter((p): p is ProbeEvent => !!p), [probes]);
  const r = useMemo(() => (summary ? classifyRun(summary, list) : null), [summary, list]);
  if (status === "running") {
    const done = list.filter(isTerminal).length;
    return <p className="font-mono fs-11 text-ink-2">Running… {done}/{list.length || "?"} nodes back</p>;
  }
  if (!summary || !r) return <p className="font-mono fs-11 text-ink-3">No run yet. Results stay in this window only.</p>;
  const tone = r.bottleneck === "clean" ? HEALTH_COLOR.green : r.bottleneck === "cpu_ipc" ? HEALTH_COLOR.amber : HEALTH_COLOR.red;
  return (
    <div className="space-y-1.5 font-mono fs-11" aria-live="polite">
      <p className="rounded-md border px-2 py-1.5 fs-11.5 font-semibold" style={{ borderColor: `${tone}88`, color: tone, background: `${tone}14` }}>
        {BOTTLENECK_LABEL[r.bottleneck]}
        {summary.aborted ? " · aborted" : ""}
      </p>
      <p className="leading-snug text-ink-2">{r.why}</p>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-ink-3">
        <dt>Slowest</dt>
        <dd className="text-right text-ink">{r.slowest ? `${PROBE_LABEL[r.slowest.node]} · ${r.slowest.rttMs}ms` : "—"}</dd>
        <dt>Wall clock</dt>
        <dd className="text-right text-ink">{r.wallMs}ms</dd>
        <dt>Peak GPU</dt>
        <dd className="text-right text-ink">{r.peakGpuPct == null ? "—" : `${Math.round(r.peakGpuPct)}%`}</dd>
        <dt>VRAM spike</dt>
        <dd className="text-right text-ink">{r.vramDeltaMb == null ? "—" : `+${gb(r.vramDeltaMb)}`}</dd>
        <dt>VRAM headroom</dt>
        <dd className="text-right text-ink">{gb(r.vramHeadroomMb)} of {gb(summary.hw.vramTotalMb)}</dd>
        <dt>Peak CPU / RAM</dt>
        <dd className="text-right text-ink">
          {Math.round(r.peakCpuPct)}% · {summary.hw.ramUsedGb.toFixed(1)} GB
        </dd>
      </dl>
      {summary.hwApp && summary.hwOther && <FootprintBlock app={summary.hwApp} other={summary.hwOther} system={summary.hw} />}
    </div>
  );
}

const SCHEDULE_EVERY = [5, 15, 30, 60, 240] as const;

/** Background schedule: the engine runs + saves a report on its own, even with this page closed. */
function ScheduleSection({ disabled }: { disabled: boolean }) {
  const view = useDiag((s) => s.schedule);
  const setSchedule = useDiag((s) => s.setSchedule);
  if (!view) return null;
  const sc = view.schedule;
  const put = (patch: Partial<DiagSchedule>) => void setSchedule({ ...sc, ...patch });
  const sel = "h-[26px] rounded-full border border-white/12 bg-[rgba(4,7,12,0.82)] px-2 font-mono fs-10.5 text-ink-2 disabled:opacity-45";
  return (
    <section aria-label="Background schedule" className="space-y-1.5 border-t border-white/10 pt-2.5">
      <label className="flex items-center justify-between gap-2">
        <span className="font-mono fs-10 tracking-[0.14em] text-ink-3">AUTO SCHEDULE</span>
        <input type="checkbox" checked={sc.enabled} disabled={disabled} onChange={(e) => put({ enabled: e.target.checked })} className="accent-[#22d3ee]" aria-label="Run diagnostics on a schedule" />
      </label>
      <div className="flex flex-wrap gap-1">
        <select aria-label="Schedule interval" value={sc.everyMinutes} disabled={disabled} onChange={(e) => put({ everyMinutes: Number(e.target.value) })} className={sel}>
          {[...new Set([...SCHEDULE_EVERY, sc.everyMinutes])].sort((a, b) => a - b).map((m) => (
            <option key={m} value={m}>
              every {m >= 60 ? `${m / 60}h` : `${m}m`}
            </option>
          ))}
        </select>
        <select aria-label="Schedule preset" value={sc.preset} disabled={disabled} onChange={(e) => put({ preset: e.target.value as PresetId })} className={sel}>
          {PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <select aria-label="Schedule intensity" value={sc.intensity} disabled={disabled} onChange={(e) => put({ intensity: e.target.value as Intensity })} className={sel}>
          {INTENSITY.map((i) => (
            <option key={i.id} value={i.id}>
              {i.label}
            </option>
          ))}
        </select>
      </div>
      <label className="flex items-center gap-1.5 fs-10.5 text-ink-3">
        <input type="checkbox" checked={sc.onlyWhenGpuIdle} disabled={disabled} onChange={(e) => put({ onlyWhenGpuIdle: e.target.checked })} className="accent-[#22d3ee]" />
        Medium/Heavy only while the GPU is idle
      </label>
      <p className="font-mono fs-10 leading-snug text-ink-3">
        {sc.enabled && view.nextAt ? `Next ≈ ${new Date(view.nextAt).toLocaleTimeString()}` : "Off"}
        {sc.lastRunAt ? ` · last ${new Date(sc.lastRunAt).toLocaleTimeString()}` : ""}
      </p>
      {view.dir && (
        <p className="break-all font-mono fs-10 leading-snug text-ink-3" title="Drop request.json here to run on demand">
          Reports: {view.dir}
        </p>
      )}
    </section>
  );
}

/**
 * Diagnostic & Load Panel (System Map · Schematic Flowchart, right side). Fires ephemeral probes
 * through `diagnostics.rs`; live results land on the schematic as conduit pulses and badges.
 */
export function DiagnosticPanel() {
  const s = useDiag();
  const desktop = isTauri();
  const running = s.status === "running";
  const [copied, setCopied] = useState(false);
  const probeList = useMemo(() => Object.values(s.probes).filter((p): p is ProbeEvent => !!p), [s.probes]);
  // Reports live on disk: a reload (or HMR) restores the last run and re-attaches to one in flight.
  useEffect(() => void useDiag.getState().hydrate(), []);

  if (!s.panelOpen) {
    return (
      <button type="button" onClick={s.togglePanel} className="sysmap-ctl absolute right-3 top-3 z-20 gap-1.5 font-mono" aria-expanded={false} aria-controls="diag-panel">
        <span className="flex items-center gap-1.5"><Activity size={13} /> Diagnostics{running ? " · running" : ""}</span>
      </button>
    );
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(s.exportJson());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked: Export still works */
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([s.exportJson()], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `diagnostic-report-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return (
    <aside
      id="diag-panel"
      aria-label="Diagnostic and load probe panel"
      className="sysmap-drawer absolute right-3 top-3 z-20 flex max-h-[calc(100%-24px)] w-[min(300px,calc(100%-24px))] flex-col overflow-hidden r-12 border border-holo/25 bg-[rgba(4,7,12,0.92)] shadow-[0_12px_40px_rgba(0,0,0,0.5)]"
    >
      <header className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
        <Activity size={14} className="text-holo" />
        <h2 className="flex-1 font-mono fs-11.5 tracking-[0.14em] text-ink">DIAGNOSTIC & LOAD</h2>
        <span className="rounded-full border border-white/10 px-1.5 font-mono fs-9.5 text-ink-3" title="Probes never write RAG, disk artifacts, runs counters or agent memory">
          EPHEMERAL
        </span>
        <button type="button" onClick={s.togglePanel} className="text-ink-3 hover:text-ink" aria-label="Collapse diagnostic panel" aria-expanded>
          <ChevronRight size={15} />
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {!desktop && <p className="rounded-md border border-amber/30 bg-amber/10 px-2 py-1.5 fs-11 text-ink-2">Probes need the desktop engine.</p>}

        <ModeSection desktop={desktop} />
        <LiveSection desktop={desktop} />
        <PolicySection desktop={desktop} />

        <section aria-label="Intensity">
          <div className="grid grid-cols-3 gap-1 rounded-full border border-white/10 p-0.5" role="radiogroup">
            {INTENSITY.map((i) => (
              <button
                key={i.id}
                type="button"
                role="radio"
                aria-checked={s.intensity === i.id}
                title={i.hint}
                onClick={() => s.setIntensity(i.id)}
                className={`h-7 rounded-full font-mono fs-11 transition-colors ${s.intensity === i.id ? "bg-holo/15 text-ink ring-1 ring-holo/50" : "text-ink-2 hover:text-ink"}`}
              >
                {i.label}
              </button>
            ))}
          </div>
          <p className="mt-1 fs-10.5 leading-snug text-ink-3">{INTENSITY.find((i) => i.id === s.intensity)?.hint}</p>
        </section>

        <section aria-label="Presets" className="space-y-1">
          <h3 className="font-mono fs-10 tracking-[0.14em] text-ink-3">PRESETS</h3>
          <div className="grid grid-cols-2 gap-1">
            {PRESETS.map((p) => (
              <button key={p.id} type="button" title={p.hint} onClick={() => s.applyPreset(p.id)} disabled={running} className="sysmap-ctl h-auto min-h-[30px] justify-start py-1 text-left leading-tight">
                {p.label}
              </button>
            ))}
          </div>
        </section>

        <section aria-label="Nodes" className="space-y-1">
          <h3 className="font-mono fs-10 tracking-[0.14em] text-ink-3">
            NODES · {s.selected.length} selected
          </h3>
          <div className="flex flex-wrap gap-1">
            {PROBE_NODES.map((n) => {
              const on = s.selected.includes(n);
              const p = s.probes[n];
              return (
                <button
                  key={n}
                  type="button"
                  aria-pressed={on}
                  disabled={running}
                  onClick={() => s.toggle(n)}
                  className={`h-6 rounded-full border px-2 font-mono fs-10.5 transition-colors disabled:cursor-not-allowed ${on ? "border-holo/60 bg-holo/10 text-ink" : "border-white/10 text-ink-3 hover:border-white/25 hover:text-ink-2"}`}
                >
                  {PROBE_LABEL[n]}
                  {p && isTerminal(p) && <span className="ml-1 text-ink-3">{p.totalRttMs}ms</span>}
                </button>
              );
            })}
          </div>
        </section>

        <section aria-label="Run controls" className="space-y-1.5">
          <div className="flex gap-1">
            <button type="button" onClick={() => void s.pulse()} disabled={!desktop || running || !s.selected.length} className="sysmap-ctl flex-1 gap-1.5 border-holo/50 text-ink">
              <span className="flex items-center gap-1.5"><Play size={12} /> Run Pulse</span>
            </button>
            <button type="button" onClick={() => void s.abort()} disabled={!desktop || (!running && !s.loop.on)} className="sysmap-ctl gap-1.5" aria-label="Stop / Abort">
              <span className="flex items-center gap-1.5"><Square size={11} /> Stop</span>
            </button>
          </div>
          <div className="flex items-center gap-1">
            <button type="button" aria-pressed={s.loop.on} onClick={() => s.setLoop(!s.loop.on)} disabled={!desktop || !s.selected.length} className="sysmap-ctl flex-1 gap-1.5">
              <span className="flex items-center gap-1.5"><Repeat size={12} /> Sustained Loop</span>
            </button>
            <select
              aria-label="Loop interval"
              value={s.loop.everyMs}
              onChange={(e) => s.setLoop(s.loop.on, Number(e.target.value) as (typeof EVERY)[number])}
              className="h-[30px] rounded-full border border-white/12 bg-[rgba(4,7,12,0.82)] px-2 font-mono fs-11 text-ink-2"
            >
              {EVERY.map((ms) => (
                <option key={ms} value={ms}>
                  every {ms / 1000}s
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-1">
            <button type="button" onClick={s.clear} disabled={running} className="sysmap-ctl flex-1 gap-1.5">
              <span className="flex items-center gap-1.5"><Trash2 size={12} /> Clear Metrics</span>
            </button>
            <button type="button" onClick={() => void copy()} disabled={!s.history.length} className="sysmap-ctl gap-1" aria-label="Copy JSON report">
              <span className="flex items-center gap-1"><Copy size={12} /> {copied ? "Copied" : "Copy"}</span>
            </button>
            <button type="button" onClick={download} disabled={!s.history.length} className="sysmap-ctl" aria-label="Export JSON report" title="Export JSON report">
              <Download size={12} />
            </button>
          </div>
          {s.error && <p className="fs-11 text-[#f87171]">{s.error}</p>}
        </section>

        <section aria-label="Bottleneck summary" className="space-y-2 border-t border-white/10 pt-2.5">
          <SummaryStrip />
          <PhaseBreakdown probes={probeList} />
          {s.summary?.reportPath && (
            <p className="mt-1.5 break-all font-mono fs-10 leading-snug text-ink-3" title="Every run is written to disk automatically">
              Saved · {s.summary.trigger !== "ui" ? `${s.summary.trigger} run · ` : ""}
              {s.summary.reportPath}
            </p>
          )}
        </section>

        <ScheduleSection disabled={!desktop} />
      </div>
    </aside>
  );
}
