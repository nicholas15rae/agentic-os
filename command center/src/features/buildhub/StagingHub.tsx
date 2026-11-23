import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ChevronsUp, Copy, Eye, EyeOff, FlaskConical, Loader2, OctagonX, Pause, Play, Rocket, RotateCcw, ShieldAlert, ShieldCheck, Terminal, Trash2, Wrench } from "lucide-react";
import { Card, Empty } from "@/components/ui";
import { PromptBox } from "@/components/PromptBox";
import { useDraft } from "@/lib/prompt-drafts";
import { PinButton } from "@/features/myapps/PinButton";
import { useMyApps } from "@/features/myapps/store";
import { isTauri } from "@/lib/platform";
import { xcmd, type ExtCommands } from "@/lib/native-ext";
import { useToasts } from "@/features/reminders/notify";
import { useLayout } from "@/core/widgets/layout-store";
import { clearOnSuccess, errText, startHub, useHub } from "./hub-store";
import { placePromotedTile } from "./promote-tile";
import { currentMilestone, elapsedEta, hubCounts, RUNTIME_BADGE, smokeBadge, STATUS_LABEL, workerIndicator } from "./format";
import { PeekView } from "./PeekView";
import { SandboxView } from "./SandboxView";
import type { BuildView, DeleteReport } from "./types";

type Tab = "staging" | "repair";

/**
 * Play Place universal staging hub (Phase 3): one status card per staged build, in queue order,
 * plus the Repair Queue tab (Phase 4). Everything here renders `build-hub` events; the Rust hub
 * owns ordering, hand-off, smoke tests and preview serving.
 */
export function StagingHub() {
  useEffect(startHub, []);
  const view = useHub((s) => s.view);
  const error = useHub((s) => s.error);
  const [tab, setTab] = useState<Tab>("staging");
  if (!isTauri()) return null;
  const builds = view?.builds ?? [];
  const counts = hubCounts(builds);
  const shown = builds.filter((b) => (tab === "repair") === (b.envelope.status === "repair_queue"));
  const failed = builds.filter((b) => b.envelope.status === "repair_queue" || b.envelope.status === "cancelled").length;
  const tabs = (
    <div role="tablist" aria-label="Staging hub view" className="flex flex-wrap gap-1">
      {(
        [
          ["staging", `Staging (${counts.staging})`, FlaskConical],
          ["repair", `Repair Queue (${counts.repair})`, Wrench],
        ] as const
      ).map(([id, label, Icon]) => (
        <button
          key={id}
          role="tab"
          aria-selected={tab === id}
          onClick={() => setTab(id)}
          className={`label-caps flex h-6 items-center gap-1 rounded-full border px-2 !text-[9px] ${tab === id ? "border-amber/50 bg-amber/10 text-amber-soft" : "border-transparent text-ink-3 hover:text-ink-2"} ${id === "repair" && counts.repair ? "!text-alert" : ""}`}
        >
          <Icon size={10} /> {label}
        </button>
      ))}
      {failed > 0 && <ClearFailed count={failed} />}
    </div>
  );
  return (
    <Card
      title="Staging hub"
      action={tabs}
      hint={
        tab === "staging"
          ? `Builds pushed from Brainstorming run one at a time per lane, in this order (Coder/Designer → the local pipeline; Claude → the Dev Fix Queue, which asks before running). Internal widgets land in ${view?.staging_root || "staging"}; external apps in ${view?.external_base || "G:\\ai-hub\\external-builds"}.`
          : "Builds that failed their smoke test twice (or that you sent here). Fix by hand in the output folder and re-run the check, or re-queue with a fix note."
      }
    >
      {error && <p className="mb-2 font-mono text-[11px] text-alert">{error}</p>}
      {!view ? (
        <p className="py-3 text-center text-xs text-ink-3">Loading…</p>
      ) : !shown.length ? (
        <Empty>{tab === "staging" ? "Nothing staged. In Brainstorm, Select a few entries → Push to Play Place." : "No builds need repair."}</Empty>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {shown.map((b) => (tab === "repair" ? <RepairCard key={b.envelope.build_id} b={b} /> : <BuildCard key={b.envelope.build_id} b={b} />))}
        </div>
      )}
    </Card>
  );
}

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

async function run<K extends keyof ExtCommands>(label: string, name: K, args: ExtCommands[K]["args"]) {
  try {
    return await (xcmd as (n: K, a: ExtCommands[K]["args"]) => Promise<ExtCommands[K]["result"]>)(name, args);
  } catch (e) {
    useToasts.getState().push({ title: label, body: errText(e), tone: "error" });
    return undefined;
  }
}

const copyPath = (p: string) => void navigator.clipboard?.writeText(p).then(() => useToasts.getState().push({ title: "Copied", body: p, tone: "info" }));

function Badge({ children, tone }: { children: React.ReactNode; tone: "amber" | "teal" | "alert" | "holo" | "ink" }) {
  const c = { amber: "border-amber/50 text-amber-soft", teal: "border-teal/50 text-teal-soft", alert: "border-alert/60 text-alert", holo: "border-holo/40 text-holo", ink: "border-white/15 text-ink-2" }[tone];
  return <span className={`label-caps inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-2 !text-[9px] ${c}`}>{children}</span>;
}

function BuildCard({ b }: { b: BuildView }) {
  const e = b.envelope;
  const id = e.build_id;
  const live = e.status === "building" || e.status === "smoke_testing";
  const now = useNow(live);
  const [peek, setPeek] = useState(false);
  const [steer, setSteer] = useDraft(`steer.${id}`);
  const [busy, setBusy] = useState<string | null>(null);
  const boxRef = useRef<HTMLElement>(null);
  const focusReq = useMyApps((s) => s.focusBuild);
  useEffect(() => {
    if (focusReq?.id !== id) return;
    boxRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    boxRef.current?.querySelector("textarea")?.focus({ preventScroll: true });
    useMyApps.getState().clearFocus();
  }, [focusReq, id]);
  const w = workerIndicator(b);
  const smoke = smokeBadge(b);
  const ready = e.status === "ready_for_merge";
  const waiting = b.position != null;
  const act = async <K extends keyof ExtCommands>(label: string, name: K, args: ExtCommands[K]["args"]) => {
    setBusy(label);
    const r = await run(label, name, args);
    setBusy(null);
    return r;
  };

  const promote = async () => {
    const r = await act("Promote", "build_promote", { buildId: id });
    if (r && e.target_runtime === "internal_widget") {
      placePromotedTile(id, e.title);
    }
  };

  return (
    <section ref={boxRef} className={`rounded-[16px] border p-3 ${e.status === "paused" ? "border-amber/40 bg-amber/[0.04]" : e.status === "cancelled" ? "border-alert/25 bg-alert/[0.02] opacity-80" : "border-white/[0.08] bg-white/[0.02]"}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-[11px] text-ink-3">{waiting ? `#${b.position}` : `Build ${b.seq}`}</span>
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-ink" title={e.title}>
          {e.title}
        </h3>
        <Badge tone="holo">{RUNTIME_BADGE[e.target_runtime]}</Badge>
        {smoke && (
          <Badge tone={smoke.tone === "ok" ? "teal" : smoke.tone === "bad" ? "alert" : "amber"}>
            {smoke.tone === "ok" ? <ShieldCheck size={10} /> : smoke.tone === "bad" ? <ShieldAlert size={10} /> : <Loader2 size={10} className="animate-spin" />} {smoke.label}
          </Badge>
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px]">
        <span className={`flex items-center gap-1 ${w.live ? "text-teal-soft" : "text-ink-3"}`}>
          <span className={`size-1.5 rounded-full ${w.live ? "animate-pulse bg-teal" : "bg-ink-3"}`} /> {w.label}
        </span>
        <span className={`label-caps ${e.status === "paused" ? "text-amber-soft" : "text-ink-2"}`}>{STATUS_LABEL[e.status]}</span>
        {b.max_iterations > 0 && b.iteration > 0 && <span className="font-mono text-ink-3">iter {b.iteration}/{b.max_iterations}</span>}
        <span className="ml-auto font-mono text-ink-3">{elapsedEta(b, now)}</span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/10">
        <div className={`h-full rounded-full transition-[width] duration-500 ${e.status === "paused" ? "bg-amber/60" : "bg-gradient-to-r from-amber to-teal"}`} style={{ width: `${b.progress}%` }} />
      </div>
      <p className="mt-1 truncate text-[11px] text-ink-2" title={e.milestones.join(" → ")}>
        <span className="text-ink-3">Milestone:</span> {currentMilestone(b)}
        {b.stage ? <span className="font-mono text-ink-3"> · {b.stage}</span> : null}
      </p>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {e.status === "paused" ? (
          <button disabled={!!busy} onClick={() => void act("Resume", "build_resume", { buildId: id })} className="pill-primary !h-7 !px-2.5 text-[11px]">
            <Play size={11} /> Resume
          </button>
        ) : (
          ["queued", "building", "smoke_testing"].includes(e.status) && (
            <button disabled={!!busy} onClick={() => void act("Pause", "build_pause", { buildId: id })} className="pill-glass !h-7 !px-2.5 text-[11px]" title="Pause at the next checkpoint: the step in flight finishes and commits, state and logs are kept">
              <Pause size={11} /> Pause
            </button>
          )
        )}
        {ACTIVE.includes(e.status) && (
          <button
            disabled={!!busy}
            onClick={() => confirm(`Cancel “${e.title}”? The step in flight is aborted now (its GPU slot is released and any Claude run is killed). The card, files and logs stay — Re-queue runs it again, Delete purges it.`) && void act("Cancel", "cancel_build_job", { jobId: id })}
            className="pill-glass !h-7 !px-2.5 text-[11px] !text-alert hover:!border-alert/60"
            title="Cancel / abort (not Pause): hard-stop the build now"
          >
            {busy === "Cancel" ? <Loader2 size={11} className="animate-spin" /> : <OctagonX size={11} />} Cancel
          </button>
        )}
        {e.status === "cancelled" && (
          <button disabled={!!busy} onClick={() => void act("Re-queue", "build_requeue", { buildId: id })} className="pill-primary !h-7 !px-2.5 text-[11px]" title="Back into staging (tail of the queue) for a fresh pass">
            <RotateCcw size={11} /> Re-queue
          </button>
        )}
        <button onClick={() => setPeek((v) => !v)} className="pill-glass !h-7 !px-2.5 text-[11px]" aria-pressed={peek} title="Live Read-In / Peek View">
          {peek ? <EyeOff size={11} /> : <Eye size={11} />} Peek
        </button>
        {waiting && (
          <>
            <button onClick={() => void act("Move", "build_reorder", { buildId: id, direction: "top" })} className="pill-glass !h-7 !w-7 !p-0" title="Bump to the front of the queue" aria-label="Bump to front">
              <ChevronsUp size={12} />
            </button>
            <button onClick={() => void act("Move", "build_reorder", { buildId: id, direction: "up" })} className="pill-glass !h-7 !w-7 !p-0" aria-label="Move up">
              <ArrowUp size={12} />
            </button>
            <button onClick={() => void act("Move", "build_reorder", { buildId: id, direction: "down" })} className="pill-glass !h-7 !w-7 !p-0" aria-label="Move down">
              <ArrowDown size={12} />
            </button>
          </>
        )}
        {ready && (
          <button disabled={!!busy} onClick={() => void promote()} className="pill-primary !h-7 !px-2.5 text-[11px]" title={e.target_runtime === "internal_widget" ? "Promote to Live Dashboard (smoke test passed)" : "Mark deployed (smoke test passed)"}>
            <Rocket size={11} /> {e.target_runtime === "internal_widget" ? "Promote to Live Dashboard" : "Mark deployed"}
          </button>
        )}
        {e.status !== "deployed" && e.status !== "cancelled" && (
          <button disabled={!!busy} onClick={() => void act("Repair", "build_to_repair", { buildId: id })} className="pill-glass !h-7 !px-2.5 text-[11px] hover:!border-alert/50" title="Send to Repair Queue">
            <Wrench size={11} /> Repair
          </button>
        )}
        <button onClick={() => copyPath(e.output_directory)} className="pill-glass !h-7 !w-7 !p-0" title={`Copy the output folder: ${e.output_directory}`} aria-label="Copy output folder">
          <Copy size={11} />
        </button>
        <PinButton target={{ kind: "build", ref: id, title: e.title }} />
        <DeleteButton b={b} busy={busy} setBusy={setBusy} />
      </div>

      {e.status !== "deployed" && e.status !== "cancelled" && (
        <div className="mt-2">
          <PromptBox
            label={`Steer “${e.title}”`}
            value={steer}
            onChange={setSteer}
            busy={busy === "Steer"}
            disabled={!!busy && busy !== "Steer"}
            historyKey="steer"
            maxHeight={120}
            submitLabel="Steer"
            placeholder="Steer — e.g. “dark theme, bigger buttons” (next agent step, no restart). Paste a whole master prompt if you like; Enter is a new line."
            adornment={e.assigned_worker !== "claude" && <MaxIterations b={b} busy={!!busy} onPick={(max) => void act("Max iterations", "build_set_max_iterations", { buildId: id, max })} />}
            onSubmit={(d) => {
              if (busy) return; // one steer at a time: never sent twice
              // Cleared only on success, and only if Nic hasn't typed something new meanwhile.
              return clearOnSuccess(act("Steer", "build_steer", { buildId: id, directive: d }), () => setSteer((cur) => (cur.trim() === d ? "" : cur)));
            }}
          />
        </div>
      )}
      {e.human_override.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {e.human_override.map((o, i) => (
            <li key={i} className="truncate font-mono text-[10px] text-ink-3" title={o.directive.length > 2000 ? `${o.directive.slice(0, 2000)}… (${o.directive.length.toLocaleString()} chars in all)` : o.directive}>
              <span className={o.applied_at ? "text-teal-soft" : "text-amber-soft"}>{o.applied_at ? `✓ injected${o.applied_stage ? ` at ${o.applied_stage}` : ""}` : "⏳ next step"}</span> {o.auto ? "(auto) " : ""}
              {o.directive.length > 160 ? `${o.directive.split("\n")[0].slice(0, 160)}… (${o.directive.length.toLocaleString()} chars)` : o.directive}
            </li>
          ))}
        </ul>
      )}

      {e.target_runtime === "external_os" && (
        <p className="mt-2 rounded-[10px] border border-holo/20 bg-holo/[0.04] px-2 py-1 font-mono text-[10px] text-ink-2">
          Local Bridge · {e.output_directory} · Peek for the embedded read-in, or Window for a dedicated preview
        </p>
      )}
      {peek && <PeekView b={b} />}
      {!peek && e.target_runtime === "internal_widget" && (ready || e.status === "deployed") && <SandboxView key={e.status} buildId={id} title={e.title} version={b.preview_version} height={260} />}
      <LogPanel b={b} />
    </section>
  );
}

/** Statuses a Cancel can hard-stop (a bound worker / Claude run, or about to get one). */
const ACTIVE: readonly string[] = ["queued", "building", "smoke_testing", "paused"];

/** Take a deleted build off the screen now (the `build-hub` event confirms it), plus its
 * promoted dashboard widget and its My Apps pin. */
function forgetBuild(id: string) {
  useHub.setState((s) => (s.view ? { view: { ...s.view, builds: s.view.builds.filter((b) => b.envelope.build_id !== id) } } : s));
  useLayout.setState((s) => ({ pages: s.pages.map((p) => ({ ...p, items: p.items.filter((i) => (i.config as { buildId?: unknown } | undefined)?.buildId !== id) })) }));
  const pin = useMyApps.getState().apps.find((a) => a.kind === "build" && a.ref === id);
  if (pin) useMyApps.getState().unmount(pin.id);
}

function deleteSummary(r: DeleteReport): string {
  const parts = [r.aborted ? "aborted, then deleted" : "deleted", r.purged.length ? `${r.purged.length} folder(s) removed from disk` : "no folders on disk"];
  if (r.kept) parts.push(`kept ${r.kept}`);
  return parts.join(" · ");
}

/** Delete (trash): on every card. A running build gets a fast confirm, is aborted, then purged. */
function DeleteButton({ b, busy, setBusy }: { b: BuildView; busy: string | null; setBusy: (v: string | null) => void }) {
  const e = b.envelope;
  const running = ACTIVE.includes(e.status);
  const onClick = async () => {
    const ask = running
      ? `“${e.title}” is ${STATUS_LABEL[e.status].toLowerCase()}. Abort it and delete it permanently (card, logs and its output folder)?`
      : `Delete “${e.title}” permanently? The card, its logs and its output folder are removed.`;
    if (!confirm(ask)) return;
    setBusy("Delete");
    const r = await run("Delete", "delete_build_job", { jobId: e.build_id, purgeFiles: true });
    setBusy(null);
    if (!r) return;
    forgetBuild(e.build_id);
    useToasts.getState().push({ title: `Deleted “${e.title}”`, body: deleteSummary(r), tone: "info" });
  };
  return (
    <button disabled={!!busy} onClick={() => void onClick()} className="pill-glass !h-7 !w-7 !p-0 hover:!border-alert/50 hover:!text-alert" aria-label={`Delete ${e.title}`} title={running ? "Abort and delete permanently" : "Delete permanently (card, logs, output folder)"}>
      {busy === "Delete" ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
    </button>
  );
}

/** Sweep every Repair Queue and cancelled build. */
function ClearFailed({ count }: { count: number }) {
  const [busy, setBusy] = useState(false);
  const onClick = async () => {
    if (!confirm(`Delete all ${count} failed / cancelled build(s) permanently, with their output folders?`)) return;
    setBusy(true);
    const r = await run("Clear failed", "clear_failed_jobs", { purgeFiles: true });
    setBusy(false);
    if (!r) return;
    r.forEach((x) => forgetBuild(x.buildId));
    useToasts.getState().push({ title: "Cleared", body: `${r.length} build(s) deleted · ${r.reduce((n, x) => n + x.purged.length, 0)} folder(s) removed`, tone: "info" });
  };
  return (
    <button disabled={busy} onClick={() => void onClick()} className="label-caps flex h-6 items-center gap-1 rounded-full border border-alert/30 px-2 !text-[9px] text-alert hover:border-alert/60" title="Delete every Repair Queue and cancelled build">
      {busy ? <Loader2 size={10} className="animate-spin" /> : <Trash2 size={10} />} Clear failed ({count})
    </button>
  );
}

const ITERATION_CHOICES = [3, 5, 10, 15] as const;

/** Max Iterations for one build: the worker's Designer/Coder loop budget (applies at once to a live run). */
function MaxIterations({ b, busy, onPick }: { b: BuildView; busy: boolean; onPick: (max: number) => void }) {
  const current = b.max_iter_override ?? (b.max_iterations || 3);
  const choices = ITERATION_CHOICES.includes(current as (typeof ITERATION_CHOICES)[number]) ? ITERATION_CHOICES : [...ITERATION_CHOICES, current].sort((x, y) => x - y);
  return (
    <label className="flex h-6 items-center gap-1 rounded-full border border-white/10 px-2 font-mono text-[10px] text-ink-3" title="Max iterations: how many Designer/Coder fix loops this build may run before it stops (applies to the running pass too)">
      max iter
      <select value={current} disabled={busy || b.envelope.status === "deployed"} onChange={(ev) => onPick(Number(ev.target.value))} className="bg-transparent text-ink-2 outline-none" aria-label="Max iterations">
        {choices.map((n) => (
          <option key={n} value={n} className="bg-canvas">
            {n}
          </option>
        ))}
      </select>
    </label>
  );
}

function LogPanel({ b }: { b: BuildView }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (open && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [open, b.logs.length]);
  const errs = b.logs.filter((l) => l.stream === "stderr").length;
  return (
    <details className="mt-2" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="flex cursor-pointer items-center gap-1 text-[11px] text-teal">
        <Terminal size={11} /> Live log ({b.logs.length}
        {errs ? <span className="text-alert"> · {errs} stderr</span> : null})
      </summary>
      <pre ref={ref} className="well mt-1 max-h-56 overflow-auto rounded-[10px] p-2 font-mono text-[10.5px] leading-relaxed">
        {b.logs.map((l, i) => (
          <div key={i} className={l.stream === "stderr" ? "text-alert" : l.stream === "event" ? "text-amber-soft" : "text-ink-2"}>
            <span className="text-ink-3">{new Date(l.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })} </span>
            {l.text}
          </div>
        ))}
      </pre>
    </details>
  );
}

function RepairCard({ b }: { b: BuildView }) {
  const e = b.envelope;
  const id = e.build_id;
  const [note, setNote] = useDraft(`requeue.${id}`);
  const [busy, setBusy] = useState<string | null>(null);
  const [peek, setPeek] = useState(false);
  const r = b.repair;
  const act = async <K extends keyof ExtCommands>(label: string, name: K, args: ExtCommands[K]["args"]) => {
    setBusy(label);
    const out = await run(label, name, args);
    setBusy(null);
    return out;
  };
  return (
    <section className="rounded-[16px] border border-alert/30 bg-alert/[0.03] p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <ShieldAlert size={14} className="text-alert" />
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{e.title}</h3>
        <Badge tone="holo">{RUNTIME_BADGE[e.target_runtime]}</Badge>
        {r?.auto && <Badge tone="alert">auto-routed</Badge>}
      </div>
      {r && <p className="mt-1 text-xs text-alert">{r.reason}</p>}
      {!!r?.failed_assertions.length && (
        <ul className="mt-1.5 space-y-0.5">
          {r.failed_assertions.map((f, i) => (
            <li key={i} className="font-mono text-[10.5px] text-ink-2">
              ✗ {f}
            </li>
          ))}
        </ul>
      )}
      {r?.trace && (
        <details className="mt-1.5">
          <summary className="cursor-pointer text-[11px] text-teal">Error trace</summary>
          <pre className="well mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-[10px] p-2 font-mono text-[10.5px] text-ink-2">{r.trace}</pre>
        </details>
      )}
      <div className="mt-2 flex flex-wrap gap-1.5">
        <button disabled={!!busy} onClick={() => void act("Smoke test", "build_smoke", { buildId: id }).then((rep) => rep && useToasts.getState().push({ title: rep.passed ? "Check passed" : "Still failing", body: rep.passed ? "Back in staging as Ready for merge." : rep.failed_assertions.join("; "), tone: rep.passed ? "info" : "error" }))} className="pill-primary !h-7 !px-2.5 text-[11px]" title="One-click fix: after editing the files by hand, re-run the check">
          {busy === "Smoke test" ? <Loader2 size={11} className="animate-spin" /> : <ShieldCheck size={11} />} Re-run check
        </button>
        <button onClick={() => copyPath(e.output_directory)} className="pill-glass !h-7 !px-2.5 text-[11px]" title="Edit the output by hand">
          <Copy size={11} /> Output folder
        </button>
        <button onClick={() => setPeek((v) => !v)} className="pill-glass !h-7 !px-2.5 text-[11px]">
          {peek ? <EyeOff size={11} /> : <Eye size={11} />} Peek
        </button>
        <DeleteButton b={b} busy={busy} setBusy={setBusy} />
      </div>
      <div className="mt-2">
        <PromptBox
          label={`Fix note for “${e.title}”`}
          value={note}
          onChange={setNote}
          allowEmpty
          busy={busy === "Re-queue"}
          disabled={!!busy && busy !== "Re-queue"}
          historyKey="steer"
          submitLabel="Re-queue"
          submitIcon={<RotateCcw size={11} />}
          submitTitle="Back into staging (tail of the queue) with the failure and your note as overrides"
          placeholder="Fix note for the agents (optional) — e.g. “inline the CSS, no CDN”"
          adornment={e.assigned_worker !== "claude" && <MaxIterations b={b} busy={!!busy} onPick={(max) => void act("Max iterations", "build_set_max_iterations", { buildId: id, max })} />}
          onSubmit={(sent) => clearOnSuccess(act("Re-queue", "build_requeue", { buildId: id, note: sent || undefined }), () => setNote((cur) => (cur.trim() === sent ? "" : cur)))}
        />
      </div>
      {peek && <PeekView b={b} height={300} />}
      <LogPanel b={b} />
    </section>
  );
}
