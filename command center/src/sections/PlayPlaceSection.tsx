import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Archive, BookMarked, Code2, Copy, Eye, Hammer, Lightbulb, Loader2, Maximize2, OctagonX, Play, RotateCcw, Send, Sparkles, Trash2, Wand2, Wrench } from "lucide-react";
import { Card, Empty } from "@/components/ui";
import { useCollection } from "@/lib/cc-api";
import { gateway } from "@/lib/gateway";
import { cmd, isTauri, type Idea, type PlayCard } from "@/lib/platform";
import { xcmd } from "@/lib/native-ext";
import { useSettings } from "@/stores/settings";
import { ideaAction, runForIdea, stagingPath, usePipelines, type PipelineRun } from "@/features/os/pipeline-store";
import { requestBuild, requestPipeline } from "@/features/voice/voice-controller";
import { useFocus } from "@/features/os/focus-store";
import { useOsName } from "@/features/os/os-store";
import { useToasts } from "@/features/reminders/notify";
import { deletedToast } from "@/features/buildhub/trash";
import { runTruth } from "@/features/buildhub/build-truth";
import { useHub } from "@/features/buildhub/hub-store";
import { devFixMode } from "@/features/memmap/format";
import { useModes } from "@/features/modes/modes-store";
import { StagingHub } from "@/features/buildhub/StagingHub";
import { PromptBox } from "@/components/PromptBox";
import { useDraft } from "@/lib/prompt-drafts";
import { PinButton } from "@/features/myapps/PinButton";
import { SendToDirectorButton } from "@/features/director/SendToDirectorButton";
import { playCardHandoff } from "@/features/director/handoff";

/** Phase 2 Part D: Solo (surface_only) builds nothing; the Rust gate stays authoritative. */
const SOLO_BUILD_HINT = "Solo mode: switch modes to build";
const useSoloMode = () => useModes((s) => s.effective.dispatch === "surface_only");

/** P6 Dev Fix · Claude Queue: the System Map's dev-queue store, loaded only when the tab opens. */
const DevFixQueue = lazy(() => import("@/features/memmap/DevFixQueue").then((m) => ({ default: m.DevFixQueue })));
type LedgerTab = "ideas" | "fixes";

/**
 * The Play Place: prototypes the Designer / Coder pipeline staged, rendered in
 * a sandboxed iframe (opaque origin — it can't touch the OS or your files),
 * plus the Ideas & Tasks Ledger they came from.
 */
export function PlayPlaceSection() {
  const clearUnseen = usePipelines((s) => s.clearUnseen);
  useEffect(() => clearUnseen(), [clearUnseen]);
  return (
    <div className="mx-auto h-full w-full max-w-7xl space-y-4 overflow-y-auto px-4 pb-32 md:px-6 md:pb-8">
      {/* Thought-to-Product Phase 3: the universal staging hub (desktop; renders nothing on the phone). */}
      <StagingHub />
      <PipelineBars />
      <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
        <PlayCards />
        <IdeasLedger />
      </div>
    </div>
  );
}

const OWNER_LABEL: Record<string, string> = { tony: "Tony", prompter: "Prompter", librarian: "Librarian", designer: "Designer", coder: "Coder", staging: "Staging", system: "Checks" };
const ownerLabel = (o: string) => OWNER_LABEL[o] ?? o;

/** Retry a failed build from its failed stage (desktop: `task_retry`). An explicit click. */
async function retryTask(taskId: string, title: string) {
  try {
    await cmd("task_retry", { task_id: taskId });
    useToasts.getState().push({ title: "Retrying", body: `“${title}” goes back to the worker.`, tone: "info" });
  } catch (e) {
    useToasts.getState().push({ title: "Couldn't retry", body: e instanceof Error ? e.message : String(e), tone: "error" });
  }
}

function StagingLink({ slug }: { slug: string | null }) {
  const path = stagingPath(slug);
  if (!path) return null;
  return (
    <button
      type="button"
      onClick={() => void navigator.clipboard?.writeText(path).then(() => useToasts.getState().push({ title: "Copied", body: path, tone: "info" }))}
      className="flex items-center gap-1 font-mono fs-11 text-teal hover:underline"
      title="The build's files (in the repo's staging folder). Click to copy the path."
    >
      <Copy size={10} /> {path}
    </button>
  );
}

/** Builds in flight (TaskEnvelopes: status, who has it, iteration n/max), plus the latest finished ones. */
export function PipelineBars() {
  const runs = Object.values(usePipelines((s) => s.runs)).sort((a, b) => a.at - b.at);
  const recent = Object.values(usePipelines((s) => s.recent))
    .sort((a, b) => b.at - a.at)
    .slice(0, 3);
  const builds = useHub((s) => s.view?.builds) ?? [];
  const [clearing, setClearing] = useState(false);
  if (!runs.length && !recent.length) return null;
  // Finished runs whose Staging Hub build has settled: the hub card is their truth now.
  const stale = recent.filter((r) => runTruth(r, builds).stale);
  const clearStale = async () => {
    setClearing(true);
    for (const r of stale) {
      try {
        // Files stay (the hub build uses them); the row goes to the Trash, so it can come back.
        await xcmd("runner_dismiss", { taskId: r.id, purgeFiles: false });
        forgetRun(r.id);
      } catch {
        /* left on the list */
      }
    }
    setClearing(false);
  };
  return (
    <Card
      title="Build runners"
      hint={runs.length ? `${runs.length} running` : "Recent runs"}
      action={
        stale.length > 0 && isTauri() ? (
          <button className="pill-glass !h-7 !px-2.5 fs-11" disabled={clearing} onClick={() => void clearStale()} title="Remove finished runs whose Staging Hub build already decided (kept in the Trash)">
            {clearing ? <Loader2 size={11} className="animate-spin" /> : <Archive size={11} />} Clear settled ({stale.length})
          </button>
        ) : undefined
      }
    >
      <ul className="space-y-2">
        {runs.map((r) => (
          <RunRow key={r.id} r={r} />
        ))}
        {recent.map((r) => (
          <RunRow key={r.id} r={r} />
        ))}
      </ul>
    </Card>
  );
}

function RunRow({ r }: { r: PipelineRun }) {
  const failed = r.status === "failed";
  const ready = r.status === "review_ready";
  // One true state: a run that belongs to a Staging Hub build shows the hub's status.
  const builds = useHub((s) => s.view?.builds) ?? [];
  const truth = runTruth(r, builds);
  const okTone = truth.tone === "ok";
  const badTone = truth.tone === "bad";
  return (
    <li>
      <div className="mb-1 flex flex-wrap items-center gap-2 text-xs">
        {okTone ? <Sparkles size={12} className="text-teal" /> : badTone ? <RotateCcw size={12} className="text-alert" /> : <Loader2 size={12} className="animate-spin text-amber-soft" />}
        <span className="text-ink">{r.title || "Prototype"}</span>
        <span className={`label-caps ${badTone ? "text-alert" : okTone ? "text-teal" : "text-amber-soft"}`} title={truth.hub ? "Status of its Staging Hub build" : undefined}>
          {truth.label}
        </span>
        {!ready && !failed && <span className="font-mono text-ink-3">{ownerLabel(r.owner)}</span>}
        {truth.showIteration && (
          <span className="font-mono text-ink-3" title="Designer/Coder loop: iteration n of max">
            iter {r.iteration}/{r.maxIterations}
          </span>
        )}
        <span className="ml-auto font-mono text-ink-2">{r.pct}%</span>
      </div>
      <p className="mb-1 truncate fs-11 text-ink-3" title={truth.note ?? r.label}>
        {truth.note ?? (failed && r.error ? r.error : r.label)}
      </p>
      {ready && <StagingLink slug={r.slug} />}
      {truth.canRetry && isTauri() && (
        <button onClick={() => void retryTask(r.id, r.title)} className="pill-glass !h-7 !px-3 fs-11">
          <RotateCcw size={11} /> Retry
        </button>
      )}
      {isTauri() && <RunnerControls r={r} live={!ready && !failed} />}
      {!ready && !failed && (
        <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
          <div className="h-full rounded-full bg-gradient-to-r from-amber to-teal transition-[width] duration-500" style={{ width: `${r.pct}%` }} />
        </div>
      )}
    </li>
  );
}

/** Drop a runner row from the store now (the backend hides it from `task_list` for good). */
function forgetRun(id: string) {
  usePipelines.setState((s) => {
    const runs = { ...s.runs };
    const recent = { ...s.recent };
    delete runs[id];
    delete recent[id];
    return { runs, recent };
  });
}

/** Build Runners row: Cancel (hard abort, distinct from Pause) while live; Delete on every row. */
function RunnerControls({ r, live }: { r: PipelineRun; live: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToasts.getState().push;
  const cancel = async () => {
    if (!confirm(`Cancel “${r.title || "Prototype"}”? The step in flight is aborted now and its GPU slot released.`)) return;
    setBusy("cancel");
    try {
      await cmd("task_cancel", { task_id: r.id });
    } catch (e) {
      toast({ title: "Cancel", body: e instanceof Error ? e.message : String(e), tone: "error" });
    }
    setBusy(null);
  };
  const del = async () => {
    // Into the Trash (30 days, Undo on the toast); only a live run asks first.
    if (live && !confirm(`“${r.title || "Prototype"}” is still running. Abort it and move it to the Trash?`)) return;
    setBusy("delete");
    try {
      const rep = await xcmd("runner_dismiss", { taskId: r.id, purgeFiles: true });
      forgetRun(r.id);
      deletedToast(r.title || "Prototype", rep);
    } catch (e) {
      toast({ title: "Delete", body: e instanceof Error ? e.message : String(e), tone: "error" });
    }
    setBusy(null);
  };
  return (
    <div className="mb-1 flex gap-1.5">
      {live && (
        <button disabled={!!busy} onClick={() => void cancel()} className="pill-glass !h-7 !px-2.5 fs-11 !text-alert hover:!border-alert/60" title="Cancel / abort this run now">
          {busy === "cancel" ? <Loader2 size={11} className="animate-spin" /> : <OctagonX size={11} />} Cancel
        </button>
      )}
      <button disabled={!!busy} onClick={() => void del()} className="pill-glass !h-7 !w-7 !p-0 hover:!border-alert/50 hover:!text-alert" aria-label="Delete run" title={live ? "Abort and delete" : "Delete from the runner list"}>
        {busy === "delete" ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
      </button>
    </div>
  );
}

const queue = (kind: string, payload: Record<string, unknown>) => gateway("/api/os/inbox", { method: "POST", body: JSON.stringify({ kind, payload }) });

export function PlayCards({ compact = false }: { compact?: boolean }) {
  const { items, loaded, update, remove } = useCollection<PlayCard>("playplace");
  const focus = useFocus((s) => s.card);
  const cards = items.filter((c) => c.status !== "archived").sort((a, b) => (b._updated ?? 0) - (a._updated ?? 0));
  if (!loaded) return <Card title="Play Place">Loading…</Card>;
  if (!cards.length)
    return (
      <Card title="Play Place">
        <Empty>Nothing staged yet. Brainstorm an idea with {"Tony"} (“I’ve been thinking about building…”): say “ok, let’s do it” and approve the hand-off to build a prototype here, or “put it in Play Place” to park it for later.</Empty>
      </Card>
    );
  return (
    <div className="space-y-4">
      {cards.map((c) => (
        <PlayCardView key={c.id} card={c} compact={compact} focused={focus === c.id} onArchive={() => void update(c.id, { status: "archived" })} onDiscard={() => void remove(c.id)} />
      ))}
    </div>
  );
}

function PlayCardView({ card, compact, focused, onArchive, onDiscard }: { card: PlayCard; compact: boolean; focused: boolean; onArchive: () => void; onDiscard: () => void }) {
  if (card.status === "parked") return <ParkedCardView card={card} compact={compact} focused={focused} onArchive={onArchive} onDiscard={onDiscard} />;
  return <LiveCardView card={card} compact={compact} focused={focused} onArchive={onArchive} onDiscard={onDiscard} />;
}

/**
 * A brainstorm parked with “put it in Play Place” (P3 Tier 4): text only — no preview iframe (there
 * is no HTML), no Approve & Build / Iterate / Commit. “Build prototype” raises the confirmation
 * card; nothing runs before its yes.
 */
function ParkedCardView({ card, compact, focused, onArchive, onDiscard }: { card: PlayCard; compact: boolean; focused: boolean; onArchive: () => void; onDiscard: () => void }) {
  const solo = useSoloMode();
  return (
    <section className={`glass r-20 p-4 ${focused ? "ring-2 ring-amber/60" : ""}`}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <BookMarked size={15} className="text-amber-soft" />
        <h2 className="fs-15 font-semibold text-ink">{card.title}</h2>
        <span className="label-caps text-ink-3">parked</span>
      </div>
      {(card.summary || card.brief) && <p className="text-sm text-ink-2">{card.summary || card.brief}</p>}
      <Tags tags={card.tags} />
      {card.idea && !compact && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-teal">The conversation</summary>
          <pre className="well mt-1 max-h-64 overflow-auto whitespace-pre-wrap r-10 p-2 fs-11 text-ink-2">{card.idea}</pre>
        </details>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          onClick={() => void requestBuild(card.idea || card.summary || card.brief || card.title, card.title)}
          disabled={solo}
          className="pill-primary !h-9 text-xs disabled:opacity-50"
          title={solo ? SOLO_BUILD_HINT : "Prompter → Designer → Coder, after you approve the card"}
        >
          <Hammer size={13} /> Build prototype
        </button>
        <SendToDirectorButton handoff={() => playCardHandoff(card)} />
        <button onClick={onArchive} className="pill-glass !h-9 text-xs" title="Hide from the Play Place (kept in the vault)">
          <Archive size={13} /> Archive
        </button>
        <button onClick={() => confirm(`Discard “${card.title}”? This deletes the parked idea.`) && onDiscard()} className="pill-glass !h-9 text-xs hover:!border-alert/50" title="Delete this parked idea">
          <Trash2 size={13} /> Discard
        </button>
      </div>
    </section>
  );
}

function Tags({ tags }: { tags?: string[] }) {
  if (!tags?.length) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {tags.map((t) => (
        <span key={t} className="rounded-full border border-white/10 px-2 py-0.5 font-mono fs-10 text-ink-3">
          #{t}
        </span>
      ))}
    </div>
  );
}

function LiveCardView({ card, compact, focused, onArchive, onDiscard }: { card: PlayCard; compact: boolean; focused: boolean; onArchive: () => void; onDiscard: () => void }) {
  const gw = useSettings((s) => s.gatewayUrl).replace(/\/+$/, "");
  const [code, setCode] = useState(false);
  const [tweak, setTweak] = useDraft(`tweak.${card.id}`);
  const boxRef = useRef<HTMLElement>(null);
  // "Edit in Play Place" from a mounted page: bring this card into view with its Tweak box focused.
  useEffect(() => {
    if (!focused) return;
    boxRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    boxRef.current?.querySelector("textarea")?.focus({ preventScroll: true });
  }, [focused]);
  const [target, setTarget] = useState<"designer" | "coder">("coder");
  const [busy, setBusy] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  const desktop = isTauri();
  const src = `${gw}/api/play-place/${card.id}/preview?v=${Math.round(card._updated ?? 0)}`;

  const act = async (label: string, desktopRun: () => Promise<unknown>, phonePayload: Record<string, unknown>) => {
    setBusy(label);
    try {
      if (desktop) await desktopRun();
      else {
        await queue("playplace", { cardId: card.id, ...phonePayload });
        useToasts.getState().push({ title: "Sent to the desktop", body: `${label} is running on MORTADELLA.`, tone: "info" });
      }
    } catch (e) {
      useToasts.getState().push({ title: label, body: String(e), tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  const statusTone = card.status === "approved" ? "text-teal" : card.status === "committed" ? "text-volt" : card.status === "building" ? "text-amber-soft" : "text-ink-2";
  return (
    <section ref={boxRef} className={`glass r-20 p-4 ${focused ? "ring-2 ring-amber/60" : ""}`}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Sparkles size={15} className="text-amber-soft" />
        <h2 className="fs-15 font-semibold text-ink">{card.title}</h2>
        <span className={`label-caps ${statusTone}`}>{card.status}</span>
        {card.versions && <span className="font-mono fs-11 text-ink-3">v{card.versions.length}</span>}
        <div className="ml-auto flex gap-1">
          {(card.hasHtml || !!card.html) && <PinButton target={{ kind: "card", ref: card.id, title: card.title }} size="md" />}
          <SendToDirectorButton handoff={() => playCardHandoff(card)} className="!h-8 !px-2.5" />
          <button onClick={() => setCode((v) => !v)} className="pill-glass !h-8 !px-2.5 text-xs" aria-pressed={code} title="Code inspector">
            {code ? <Eye size={13} /> : <Code2 size={13} />} {code ? "Preview" : "Code"}
          </button>
          <button onClick={() => setFull(true)} className="pill-glass !h-8 !w-8 !p-0" title="Full screen" aria-label="Full screen preview">
            <Maximize2 size={13} />
          </button>
        </div>
      </div>
      {card.idea && !compact && <p className="mb-2 line-clamp-2 text-xs text-ink-3">{card.idea}</p>}

      {code ? (
        <pre className="well max-h-[420px] overflow-auto whitespace-pre-wrap r-12 p-3 font-mono fs-11 text-ink-2">{card.html || "(no HTML)"}</pre>
      ) : (
        <iframe
          key={src}
          src={src}
          title={`Prototype: ${card.title}`}
          // No allow-same-origin: the prototype runs in an opaque origin, isolated from the OS.
          sandbox="allow-scripts allow-forms allow-modals allow-popups"
          className={`w-full r-12 border border-white/10 bg-white ${compact ? "h-[340px]" : "h-[480px]"}`}
          loading="lazy"
        />
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          disabled={!!busy}
          onClick={() => void act("Approve & Build", () => cmd("playplace_approve", { cardId: card.id }), { action: "approve" })}
          className="pill-primary !h-9 text-xs"
          title="Lock the concept → Prompter writes build instructions → Coder"
        >
          {busy === "Approve & Build" ? <Loader2 size={13} className="animate-spin" /> : <Hammer size={13} />} Approve & Build
        </button>
        <button
          disabled={!!busy}
          onClick={() => void act("Commit to Librarian Vault", () => cmd("playplace_commit", { cardId: card.id }), { action: "commit" })}
          className="pill-glass !h-9 text-xs"
          title="Spec, prompt chain and code → Tony's notes (memory/tony) + the Librarian's RAG"
        >
          {busy === "Commit to Librarian Vault" ? <Loader2 size={13} className="animate-spin" /> : <BookMarked size={13} />} Commit to Vault
        </button>
        <button onClick={onArchive} className="pill-glass !h-9 text-xs" title="Hide from the Play Place (kept in the vault)">
          <Archive size={13} /> Archive
        </button>
        <button onClick={() => confirm(`Discard “${card.title}”? This deletes the staged prototype.`) && onDiscard()} className="pill-glass !h-9 text-xs hover:!border-alert/50" title="Delete this staging artifact">
          <Trash2 size={13} /> Discard
        </button>
      </div>

      <div className="mt-2">
        <PromptBox
          label={`Tweak “${card.title}”`}
          value={tweak}
          onChange={setTweak}
          busy={busy === "Iterate"}
          disabled={!!busy && busy !== "Iterate"}
          historyKey="tweak"
          submitLabel="Tweak"
          submitIcon={<Wand2 size={11} />}
          placeholder="Iterate / tweak — e.g. “bigger CTA, add a dark calendar view”. Enter is a new line."
          adornment={
            <select value={target} onChange={(e) => setTarget(e.target.value as "designer" | "coder")} className="h-6 rounded-full border border-white/10 bg-transparent px-1.5 font-mono fs-10 text-ink-2 outline-none" aria-label="Send tweak to">
              <option value="coder" className="bg-canvas">Coder</option>
              <option value="designer" className="bg-canvas">Designer</option>
            </select>
          }
          onSubmit={(notes) => {
            setTweak("");
            return act("Iterate", () => cmd("playplace_iterate", { cardId: card.id, notes, target }), { action: "iterate", notes, target });
          }}
        />
      </div>

      {card.buildPlan && !compact && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-teal">Build plan (Prompter → Coder)</summary>
          <pre className="well mt-1 max-h-64 overflow-auto whitespace-pre-wrap r-10 p-2 fs-11 text-ink-2">{card.buildPlan}</pre>
        </details>
      )}
      {card.vaultPath && <p className="mt-2 font-mono fs-11 text-ink-3">Vault: {card.vaultPath}</p>}

      {full && (
        <div className="fixed inset-0 z-[85] flex flex-col bg-black/80 p-3" role="dialog" aria-modal="true" aria-label={`${card.title} full screen`}>
          <div className="mb-2 flex items-center">
            <span className="text-sm text-ink">{card.title}</span>
            <button onClick={() => setFull(false)} className="pill-glass ml-auto !h-8 text-xs">
              Close
            </button>
          </div>
          <iframe src={src} title={`Prototype full screen: ${card.title}`} sandbox="allow-scripts allow-forms allow-modals allow-popups" className="w-full flex-1 r-12 border-0 bg-white" />
        </div>
      )}
    </section>
  );
}

/** Ideas & Tasks Ledger (Tony → Prompter → Designer → Coder), plus the Dev Fix · Claude Queue tab (P6). */
export function IdeasLedger({ compact = false }: { compact?: boolean }) {
  const [tab, setTab] = useState<LedgerTab>("ideas");
  const name = useOsName();
  const tabs = (
    <div role="tablist" aria-label="Ledger view" className="flex gap-1">
      <LedgerTabButton id="ideas" tab={tab} setTab={setTab} icon={Lightbulb} label="Ideas" />
      <LedgerTabButton id="fixes" tab={tab} setTab={setTab} icon={Wrench} label="Dev Fix · Claude Queue" />
    </div>
  );
  const hint = compact
    ? undefined
    : tab === "ideas"
      ? `Ideas you park with ${name} (“add it to the ledger”) wait here. Run (after you approve the card) queues a build: Prompter → Designer → Coder, landing in the repo's staging folder for review. ${name} keeps notes in memory/tony.`
      : "Fixes for Claude Code (devqueue.db, mirrored to .agenticos/claude-fix-queue.json for /fix-queue). “Run with Claude Code” asks first, works in its own worktree, never commits — and only the app's own checks mark a fix Done.";
  return (
    <Card title="Ideas & tasks ledger" action={tabs} hint={hint}>
      {tab === "ideas" ? (
        <IdeasList compact={compact} />
      ) : !isTauri() ? (
        <Empty>{devFixMode(false).message}</Empty>
      ) : (
        <Suspense fallback={<p className="py-3 text-center text-xs text-ink-3">Loading…</p>}>
          <DevFixQueue compact={compact} />
        </Suspense>
      )}
    </Card>
  );
}

function LedgerTabButton({ id, tab, setTab, icon: Icon, label }: { id: LedgerTab; tab: LedgerTab; setTab: (t: LedgerTab) => void; icon: typeof Wrench; label: string }) {
  const on = tab === id;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={on}
      onClick={() => setTab(id)}
      className={`label-caps flex h-6 items-center gap-1 rounded-full border px-2 !fs-9 transition-colors ${on ? "border-amber/50 bg-amber/10 text-amber-soft" : "border-transparent text-ink-3 hover:text-ink-2"}`}
    >
      <Icon size={10} /> {label}
    </button>
  );
}

function IdeasList({ compact }: { compact: boolean }) {
  const { items, update } = useCollection<Idea>("ideas");
  const solo = useSoloMode();
  const running = usePipelines((s) => s.runs);
  const recent = usePipelines((s) => s.recent);
  const ideas = items.filter((i) => i.status !== "archived").sort((a, b) => (b._updated ?? 0) - (a._updated ?? 0));
  return (
    <>
      {!ideas.length && <Empty>No ideas yet.</Empty>}
      <ul className="space-y-2">
        {ideas.map((i) => {
          const done = i.tasks?.filter((t) => t.done).length ?? 0;
          const run = runForIdea(i, running, recent);
          const live = !!run && run.status !== "failed" && run.status !== "review_ready";
          const action = ideaAction(i.status, live, !!i.taskId);
          return (
            <li key={i.id} className="r-12 border border-white/[0.06] bg-white/[0.02] p-3">
              <div className="flex items-center gap-2">
                <span className="text-sm text-ink">{i.title}</span>
                <span className="label-caps text-ink-3">{i.status}</span>
                <span className="ml-auto font-mono fs-11 text-ink-3">
                  {done}/{i.tasks?.length ?? 0}
                </span>
              </div>
              {i.summary && !compact && <p className="mt-1 text-xs text-ink-2">{i.summary}</p>}
              {!compact && <Tags tags={i.tags} />}
              {!compact && (
                <ul className="mt-2 space-y-1">
                  {(i.tasks ?? []).map((t) => (
                    <li key={t.id}>
                      <label className="flex items-start gap-2 text-xs text-ink-2">
                        <input type="checkbox" checked={t.done} onChange={() => void update(i.id, { tasks: i.tasks.map((x) => (x.id === t.id ? { ...x, done: !x.done } : x)) })} className="mt-0.5 accent-teal" />
                        <span className={t.done ? "line-through opacity-60" : ""}>{t.text}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {live && run && (
                  <span className="flex h-7 items-center gap-1 font-mono fs-11 text-amber-soft">
                    <Loader2 size={11} className="animate-spin" /> {ownerLabel(run.owner)}
                    {run.iteration > 0 ? ` · iter ${run.iteration}/${run.maxIterations}` : ""}
                  </span>
                )}
                {(action === "run" || action === "rebuild") && (
                  <button
                    onClick={() => void requestPipeline(i.id, i.title, "general")}
                    disabled={solo}
                    className="pill-primary !h-7 !px-3 fs-11 disabled:opacity-50"
                    title={solo ? SOLO_BUILD_HINT : "Prompter → Designer → Coder, after you approve the card"}
                  >
                    <Play size={11} /> {action === "rebuild" ? "Rebuild prototype" : i.status === "prototyping" || i.status === "failed" ? "Retry build" : "Run pipeline"}
                  </button>
                )}
                {action === "retry" && i.taskId && isTauri() && (
                  <button onClick={() => void retryTask(i.taskId!, i.title)} className="pill-primary !h-7 !px-3 fs-11" title="Re-run the failed step (the earlier steps' work is kept)">
                    <RotateCcw size={11} /> Retry
                  </button>
                )}
                {action === "retry" && !isTauri() && (
                  <button
                    onClick={() => void requestPipeline(i.id, i.title, "general")}
                    disabled={solo}
                    className="pill-primary !h-7 !px-3 fs-11 disabled:opacity-50"
                    title={solo ? SOLO_BUILD_HINT : "Queue it again on the desktop, after you approve the card"}
                  >
                    <RotateCcw size={11} /> Retry build
                  </button>
                )}
                {!live && run?.status === "review_ready" && <StagingLink slug={run.slug} />}
                {i.status === "failed" && i.error && !compact && <p className="w-full fs-11 text-alert">{i.error}</p>}
                {i.cardId && (
                  <button onClick={() => useFocus.getState().set({ card: i.cardId! })} className="pill-glass !h-7 !px-3 fs-11">
                    <Send size={11} /> Prototype
                  </button>
                )}
                <button onClick={() => void update(i.id, { status: "archived" })} className="pill-glass !h-7 !px-3 fs-11">
                  <Archive size={11} /> Archive
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
