import { lazy, Suspense, useState } from "react";
import { AlertTriangle, CloudUpload, LifeBuoy, Loader2, X } from "lucide-react";
import { cmd, isTauri } from "@/lib/platform";
import { useVoice } from "@/features/voice/voice-store";
import { queueFix } from "@/features/memmap/dev-queue";
import { diagnosisTitle, HELPDESK_ENGINE, HELPDESK_QUESTION, HELPDESK_TURNS, helpdeskTranscript, noProblem, ticketBody } from "./helpdesk-review";

const DevFixQueue = lazy(() => import("@/features/memmap/DevFixQueue").then((m) => ({ default: m.DevFixQueue })));

type Phase = { k: "idle" } | { k: "running" } | { k: "done"; answer: string; ticket: string | null; ms: number; redacted: boolean } | { k: "error"; message: string };

/**
 * "Something's off": one button for the whole thread (replaces the per-message Ask Overseer).
 * Opens a panel that says up front what leaves the PC; only the panel's own button sends the
 * last turns to the Claude CLI. The diagnosis becomes a fix ticket in the Claude Code fix queue,
 * listed right below it. Desktop only; never automatic.
 */
export function HelpDeskButton({ thread }: { thread: string }) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>({ k: "idle" });
  if (!isTauri()) return null;

  const review = async () => {
    const transcript = helpdeskTranscript(useVoice.getState().turns, thread);
    if (!transcript.length) return setPhase({ k: "error", message: "Nothing in this thread to review yet." });
    setPhase({ k: "running" });
    try {
      const r = await cmd("overseer_ask", { req: { question: HELPDESK_QUESTION, transcript, context: "", engine: HELPDESK_ENGINE } });
      let ticket: string | null = null;
      if (!noProblem(r.answer)) {
        const t = await queueFix({ title: diagnosisTitle(r.answer), description: ticketBody(r.answer, transcript, thread), source: "typed" });
        ticket = t.title;
      }
      setPhase({ k: "done", answer: r.answer, ticket, ms: r.latencyMs, redacted: r.redacted });
    } catch (e) {
      setPhase({ k: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-9 items-center gap-1.5 rounded-full border border-white/10 px-3 text-[12px] text-ink-2 hover:text-ink"
        title="Something's off: have Claude review the last few turns and file a fix ticket"
      >
        <LifeBuoy size={13} /> Something's off
      </button>
      {open && (
        <div className="fixed inset-0 z-[75] flex justify-end bg-black/40" onClick={() => setOpen(false)}>
          <aside className="glass-chat h-full w-full max-w-xl space-y-4 overflow-y-auto rounded-none p-5" onClick={(e) => e.stopPropagation()} aria-label="Help desk">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-ink">Help desk</h2>
              <button onClick={() => setOpen(false)} className="grid size-9 place-items-center rounded-full text-ink-2 hover:text-ink" aria-label="Close help desk">
                <X size={16} />
              </button>
            </div>
            <p className="flex gap-2 rounded-[12px] border border-amber/30 bg-amber/[0.06] p-3 text-sm leading-relaxed text-ink-2">
              <CloudUpload size={16} className="mt-0.5 shrink-0 text-amber-soft" aria-hidden />
              <span>
                Sends the last {HELPDESK_TURNS} turns of this thread to <b>Claude (cloud)</b> through the Claude CLI, after the privacy diffuser. Blocked by the kill switch and LOCAL ONLY mode.
                Runs only when you press the button below.
              </span>
            </p>
            <button type="button" onClick={() => void review()} disabled={phase.k === "running"} className="pill-primary !h-9 !px-4 text-sm">
              {phase.k === "running" ? <Loader2 size={14} className="animate-spin" /> : <LifeBuoy size={14} />} Review the last {HELPDESK_TURNS} turns
            </button>
            {phase.k === "error" && (
              <p className="flex items-center gap-2 text-sm text-alert">
                <AlertTriangle size={14} /> {phase.message}
              </p>
            )}
            {phase.k === "done" && (
              <div className="space-y-2">
                <p className="font-mono text-[11px] text-ink-3">
                  {HELPDESK_ENGINE}
                  {phase.redacted ? " · privacy-diffused" : ""} · {phase.ms}ms
                </p>
                <pre className="whitespace-pre-wrap rounded-[12px] border border-white/10 bg-black/20 p-3 text-sm leading-relaxed text-ink">{phase.answer}</pre>
                <p className="text-xs text-ink-3">{phase.ticket ? `Saved as a fix ticket: “${phase.ticket}”. Hand it to Claude Code with /fix-queue or the buttons below.` : "No problem found, so no ticket was saved."}</p>
              </div>
            )}
            <div>
              <h3 className="label-caps mb-2 text-ink-3">Fix tickets</h3>
              <Suspense fallback={<p className="text-sm text-ink-3">Loading…</p>}>
                <DevFixQueue compact />
              </Suspense>
            </div>
          </aside>
        </div>
      )}
    </>
  );
}
