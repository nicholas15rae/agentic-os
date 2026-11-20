import { useEffect, useState } from "react";
import { Bot, ClipboardCopy, FileText, Loader2, Plus, Square, Wrench } from "lucide-react";
import { Empty } from "@/components/ui";
import { cmd, isTauri, type DevTask } from "@/lib/platform";
import { useToasts } from "@/features/reminders/notify";
import { cancelFix, dispatchFix, ensureFixEvents, queueFix, useDevQueue, useFixProgress } from "./dev-queue";
import { canDispatchFix, devFixMode, errorSummary, fixChip, isFixRunning, PRIORITY_LABEL, sortTasks } from "./format";

const CHIP_TONE = {
  draft: "border-ember/50 bg-ember/10 text-ember",
  queued: "border-holo/40 bg-holo/10 text-holo",
  running: "border-teal/50 bg-teal/10 text-teal-soft animate-pulse",
  progress: "border-teal/50 bg-teal/10 text-teal-soft",
  done: "border-white/10 bg-white/[0.04] text-ink-3",
  failed: "border-alert/50 bg-alert/10 text-alert",
} as const;

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function copy(label: string, text: string) {
  try {
    await navigator.clipboard.writeText(text);
    useToasts.getState().push({ title: `${label} copied`, body: text, tone: "info" });
  } catch {
    useToasts.getState().push({ title: `Couldn't copy the ${label.toLowerCase()}`, body: text, tone: "error" });
  }
}

/**
 * Ideas & Tasks Ledger → "Dev Fix · Claude Queue" (P6). The fixes in the desktop's devqueue.db
 * (mirrored to `.agenticos/claude-fix-queue.json` for Claude Code's `/fix-queue`). "Run with
 * Claude Code" raises the confirmation card; only its yes starts a worktree run, and Rust's own
 * verify decides Done. Progress lines live in memory only. On the phone: read-only, no dispatch.
 */
export function DevFixQueue({ compact = false }: { compact?: boolean }) {
  const mode = devFixMode(isTauri());
  const tasks = useDevQueue((s) => s.tasks);
  const loaded = useDevQueue((s) => s.loaded);
  const error = useDevQueue((s) => s.error);
  const [showDone, setShowDone] = useState(false);

  useEffect(() => {
    if (mode.readOnly) return;
    ensureFixEvents();
    void useDevQueue.getState().load();
  }, [mode.readOnly]);

  if (mode.readOnly) return <Empty>{mode.message}</Empty>;

  const fixes = sortTasks(tasks.filter((t) => t.kind === "fix"));
  const running = fixes.some(isFixRunning);
  const rows = fixes.filter((t) => showDone || t.status !== "Done").sort((a, b) => Number(isFixRunning(b)) - Number(isFixRunning(a)));
  const done = fixes.length - fixes.filter((t) => t.status !== "Done").length;

  return (
    <div className="space-y-2">
      {!compact && <QueueForm />}
      {error && <p className="truncate font-mono text-[10px] text-ember" title={error}>{error}</p>}
      {!loaded ? (
        <p className="py-3 text-center text-xs text-ink-3">Loading…</p>
      ) : rows.length === 0 ? (
        <Empty>No fixes queued. Say “queue a Claude fix for …”, use Queue fix on a failed trace step, or add one above.</Empty>
      ) : (
        <ul className="space-y-2">
          {rows.map((t) => (
            <FixRow key={t.id} t={t} anyRunning={running} compact={compact} canDispatch={mode.canDispatch} />
          ))}
        </ul>
      )}
      {done > 0 && (
        <button type="button" onClick={() => setShowDone((v) => !v)} className="label-caps text-[9px] text-ink-3 hover:text-ink-2">
          {showDone ? "Hide" : "Show"} done ({done})
        </button>
      )}
    </div>
  );
}

function QueueForm() {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const t = title.trim();
    if (!t) return;
    setBusy(true);
    try {
      await queueFix({ title: t, description: description.trim() || undefined, source: "typed" });
      setTitle("");
      setDescription("");
    } catch (e) {
      useToasts.getState().push({ title: "Couldn't queue the fix", body: msg(e), tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="flex gap-1.5">
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Queue a fix — e.g. “the duck stays on after a barge-in”" className="field !h-8 min-w-0 flex-1 !py-1 text-xs" aria-label="Fix title" />
        <button className="pill-glass !h-8 text-[11px]" disabled={!title.trim() || busy} title="Queue it for Claude Code (recent errors and the UI route are attached, secrets scrubbed)">
          {busy ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />} Queue
        </button>
      </div>
      {title.trim() && <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="What's wrong, how to reproduce (optional)" className="field !py-1 text-xs" aria-label="Fix description" />}
    </form>
  );
}

function FixRow({ t, anyRunning, compact, canDispatch }: { t: DevTask; anyRunning: boolean; compact: boolean; canDispatch: boolean }) {
  const lines = useFixProgress((s) => s.lines[t.id]);
  const [busy, setBusy] = useState(false);
  const chip = fixChip(t);
  const d = t.dispatch ?? {};
  const live = isFixRunning(t);
  const summary = errorSummary(t);

  const run = async () => {
    setBusy(true);
    try {
      await dispatchFix(t, "text");
    } catch (e) {
      useToasts.getState().push({ title: "Claude Code didn't start", body: msg(e), tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  const bump = async () => {
    try {
      const r = await cmd("dev_task_update", { id: t.id, priority: Math.max(0, t.priority - 1) as typeof t.priority });
      useDevQueue.setState((s) => ({ tasks: s.tasks.map((x) => (x.id === r.id ? r : x)) }));
    } catch (e) {
      useToasts.getState().push({ title: "Couldn't bump it", body: msg(e), tone: "error" });
    }
  };
  const queue = async () => {
    try {
      const r = await cmd("dev_task_update", { id: t.id, status: "Queued" });
      useDevQueue.setState((s) => ({ tasks: s.tasks.map((x) => (x.id === r.id ? r : x)) }));
    } catch (e) {
      useToasts.getState().push({ title: "Couldn't queue it", body: msg(e), tone: "error" });
    }
  };

  return (
    <li className="rounded-[12px] border border-white/[0.06] bg-white/[0.02] p-3">
      <div className="flex items-center gap-2">
        <Wrench size={12} className="shrink-0 text-ember" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-sm text-ink" title={t.title}>
          {t.title}
        </span>
        {/* Priority bump (Thought-to-Product Phase 3): one click = one step more urgent; the queue
            stays deterministic FIFO within a priority. Never on a live run. */}
        <button
          type="button"
          disabled={t.priority === 0 || isFixRunning(t) || t.status === "Done"}
          onClick={() => void bump()}
          className="rounded font-mono text-[10px] text-ink-3 enabled:hover:text-amber-soft disabled:cursor-default"
          title={t.priority === 0 ? PRIORITY_LABEL[t.priority] : `${PRIORITY_LABEL[t.priority]} — click to bump to P${t.priority - 1}`}
        >
          P{t.priority}
          {t.priority > 0 && !isFixRunning(t) && t.status !== "Done" ? "↑" : ""}
        </button>
        <span className={`label-caps inline-flex h-5 items-center rounded-full border px-2 !text-[9px] ${CHIP_TONE[chip.tone]}`}>{chip.label}</span>
      </div>
      {!compact && t.body && <p className="mt-1 line-clamp-2 text-xs text-ink-2">{t.body}</p>}
      {!compact && summary && (
        <p className="mt-1 truncate font-mono text-[10px] text-ink-3" title={summary}>
          {summary}
        </p>
      )}
      {(d.note || d.branch) && (
        <p className="mt-1 truncate font-mono text-[10px] text-ink-3" title={[d.branch, d.note].filter(Boolean).join(" · ")}>
          {d.branch && <span className="text-holo">{d.branch}</span>}
          {d.branch && d.note ? " · " : ""}
          {d.note}
        </p>
      )}
      {!compact && d.verify?.steps?.length ? (
        <div className="mt-1 flex flex-wrap gap-1">
          {d.verify.steps.map((s) => (
            <span key={s.label} title={s.tail ?? `${s.ms} ms`} className={`rounded-full border px-1.5 font-mono text-[9px] ${s.ok ? "border-teal/40 text-teal-soft" : "border-alert/50 text-alert"}`}>
              {s.ok ? "✓" : "✗"} {s.label}
            </span>
          ))}
        </div>
      ) : null}
      {lines?.length ? (
        <ul className="well mt-2 max-h-28 space-y-0.5 overflow-y-auto rounded-[8px] p-1.5 font-mono text-[10px] text-ink-2" aria-label="Claude Code progress">
          {lines.slice(compact ? -3 : -8).map((l, i) => (
            <li key={`${l.at}-${i}`} className="truncate" title={l.text}>
              <span className="text-ink-3">{l.phase}</span> {l.text}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {canDispatch && canDispatchFix(t, anyRunning) && (
          <button type="button" disabled={busy} onClick={() => void run()} className="pill-primary !h-7 !px-3 text-[11px]" title="Opens a confirmation card. On yes: a fresh git worktree on fix/<id>, Claude Code with a fixed tool allowlist, then the app runs typecheck · vitest · cargo test — only a pass marks it Done. Claude never commits.">
            {busy ? <Loader2 size={11} className="animate-spin" /> : <Bot size={11} />} Run with Claude Code
          </button>
        )}
        {live && (
          <button type="button" onClick={() => void cancelFix(t.id)} className="pill-glass !h-7 !px-3 text-[11px] hover:!border-alert/50" title="Stop Claude Code (and its verify step); the fix goes back to Queued">
            <Square size={11} /> Cancel
          </button>
        )}
        {t.status === "Pending" && (
          <button type="button" onClick={() => void queue()} className="pill-glass !h-7 !px-3 text-[11px]" title="Put this draft in the Claude Code queue (.agenticos/claude-fix-queue.json)">
            <Plus size={11} /> Queue for Claude
          </button>
        )}
        {d.worktree && (
          <button type="button" onClick={() => void copy("Worktree path", d.worktree!)} className="pill-glass !h-7 !px-3 text-[11px]" title={d.worktree}>
            <ClipboardCopy size={11} /> Worktree
          </button>
        )}
        {d.logPath && (
          <button type="button" onClick={() => void copy("Run log path", d.logPath!)} className="pill-glass !h-7 !px-3 text-[11px]" title={d.logPath}>
            <FileText size={11} /> Log
          </button>
        )}
      </div>
    </li>
  );
}
