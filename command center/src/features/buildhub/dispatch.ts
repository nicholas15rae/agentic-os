import { heuristicPlan } from "@/features/orchestrator/plan";
import { requestConfirmation } from "@/features/voice/voice-controller";
import { tonyThread } from "@/features/voice/voice-store";
import { xcmd } from "@/lib/native-ext";
import { useHub } from "./hub-store";
import type { Compiled } from "./compile";
import { RUNTIME_BADGE } from "./format";

const WORKER_LABEL = { claude: "Claude Code", coder: "the Coder", designer: "the Designer" } as const;

/**
 * Phase 2 dispatch: a compiled TaskEnvelope goes into the Play Place staging queue only behind
 * the confirmation card — `approve()` runs `plan.run`, the one caller that sends `approved: true`
 * (Rust refuses anything else, and Solo mode queues nothing). Returns once the card is answered.
 */
export function requestHubDispatch(c: Compiled, onQueued?: (buildId: string) => void) {
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
    const queued = await xcmd("build_enqueue", { envelope: e, brief: c.brief, noteIds: c.noteIds, approved: true });
    void xcmd("build_hub_view").then((v) => useHub.getState().set(v)).catch(() => undefined);
    onQueued?.(queued.build_id);
    const pos = useHub.getState().view?.builds.find((b) => b.envelope.build_id === queued.build_id)?.position;
    return { text: `Staged “${queued.title}”${pos ? ` — #${pos} in the queue` : ""}. Watch it in the Play Place.`, meta: "play place · staged" };
  };
  return requestConfirmation(plan, "text");
}
