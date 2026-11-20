import { heuristicPlan } from "@/features/orchestrator/plan";
import { requestConfirmation, startHandoffCue } from "@/features/voice/voice-controller";
import { noteHandoff, withHandoff } from "@/features/voice/handoff-cues";
import { tonyThread, useVoice } from "@/features/voice/voice-store";
import { xcmd } from "@/lib/native-ext";
import { useHub } from "./hub-store";
import type { Compiled } from "./compile";
import { RUNTIME_BADGE } from "./format";

const WORKER_LABEL = { claude: "Claude Code", coder: "the Coder", designer: "the Designer" } as const;

/** The card was declined, timed out or replaced by another one: nothing was staged. */
export class HubDispatchCancelled extends Error {
  constructor(readonly reason = "not staged") {
    super(reason);
  }
}

/** The "Intake interview:" block of a (Rust-scrubbed) build brief, for the chat record. Pure. */
export function interviewOf(brief: string): string | null {
  const i = brief.indexOf("Intake interview:");
  if (i < 0) return null;
  const rest = brief.slice(i + "Intake interview:".length);
  const end = rest.search(/\n\s*\nBrainstorm notes \(/);
  const block = (end >= 0 ? rest.slice(0, end) : rest).trim();
  return block || null;
}

/**
 * Phase 2 dispatch: a compiled TaskEnvelope goes into the Play Place staging queue only behind
 * the confirmation card — `approve()` runs `plan.run`, the one caller that sends `approved: true`
 * (Rust refuses anything else, and Solo mode queues nothing). Settles once the card is ANSWERED
 * and the enqueue is done: resolves with the build id; rejects with `HubDispatchCancelled` (no /
 * timeout / superseded) or the enqueue's own refusal — so the interview stays open, answers
 * intact, until it really is staged. `source`: who asked the interview questions (for the record).
 */
export function requestHubDispatch(c: Compiled, onQueued?: (buildId: string) => void, source?: "prompter" | "fallback"): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    void stageBehindCard(c, onQueued, source, resolve, reject);
  });
}

function stageBehindCard(c: Compiled, onQueued: ((buildId: string) => void) | undefined, source: "prompter" | "fallback" | undefined, resolve: (id: string) => void, reject: (e: unknown) => void) {
  const e = c.envelope;
  const plan = heuristicPlan(`Stage the build ${e.title}`, "prompter");
  plan.mutating = true;
  plan.thread = tonyThread();
  plan.summary = `Stage “${e.title}” → ${RUNTIME_BADGE[e.target_runtime].toLowerCase()}, built by ${WORKER_LABEL[e.assigned_worker]}`;
  plan.intent = `stage “${e.title}” in the Play Place`;
  plan.readBack = `Queue “${e.title}” for ${WORKER_LABEL[e.assigned_worker]}? Proceed?`;
  plan.target = { kind: "bridge", action: "pipeline", scopes: ["delegation"] };
  plan.payload = { title: e.title, buildId: e.build_id, runtime: e.target_runtime, worker: e.assigned_worker, notes: c.noteIds.length };
  plan.verification = { status: "verified", notes: [], by: "compiled from your notes and interview" };
  plan.run = async () => {
    // Phase 5: the enqueue goes out first; the vocal handoff (Tony → Coder / Designer) starts beside
    // it and is never awaited. Claude Code isn't one of Tony's voiced crew: chip only.
    const role = e.assigned_worker === "claude" ? null : e.assigned_worker;
    const { result, cue } = withHandoff(() => xcmd("build_enqueue", { envelope: e, brief: c.brief, noteIds: c.noteIds, approved: true }), () => (role ? startHandoffCue(role) : null));
    noteHandoff(role ?? "claude", !!cue);
    // A refused hand-off (Solo mode, validation) drops the rest of the exchange.
    const queued = await result.catch((err: unknown) => {
      cue?.cancel();
      reject(err);
      throw err;
    });
    const view = await xcmd("build_hub_view").catch(() => null);
    if (view) useHub.getState().set(view);
    const built = view?.builds.find((b) => b.envelope.build_id === queued.build_id);
    // The interview (the Prompter's questions and Nic's answers) is part of the conversation:
    // recorded in Tony's thread from the brief Rust stored (secret-scrubbed), with the contract.
    const iv = built ? interviewOf(built.brief ?? "") : null;
    if (iv) {
      const criteria = queued.acceptance_criteria.map((a) => `• ${a}`).join("\n");
      useVoice.getState().pushTurn({
        who: "agent",
        from: "prompter",
        thread: plan.thread,
        text: `Intake interview for “${queued.title}” (${source === "prompter" ? "the Prompter's questions" : "standard questions"}):\n${iv}\n\nAcceptance criteria:\n${criteria}`,
        meta: `play place · intake · ${queued.build_id}`,
      });
    }
    onQueued?.(queued.build_id);
    resolve(queued.build_id);
    const pos = built?.position;
    return { text: `Staged “${queued.title}”${pos ? ` — #${pos} in the queue` : ""}. Watch it in the Play Place.`, meta: "play place · staged" };
  };
  plan.onCancel = () => reject(new HubDispatchCancelled());
  return requestConfirmation(plan, "text");
}
