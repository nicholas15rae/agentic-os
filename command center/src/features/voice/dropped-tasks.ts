import { directTool } from "@/features/dispatcher/router";

/**
 * Dropped tasks (section pass). When Nic changes the subject over a turn that is still working on
 * a TASK ("check my last five Gmail messages"), the old turn is superseded — before this, silently
 * abandoned. Now its line is kept, and once the new subject is answered Tony asks whether to finish
 * it ("Finish it" button, or a spoken / typed "yes"). A deliberate stop ("cut it", "never mind",
 * the stand-down) never offers anything: only the supersede path records a drop.
 */

export interface TaskLine {
  id: string;
  line: string;
  thread: string;
  at: number;
}

/** An offer stays answerable by "yes" for this long. */
export const RESUME_TTL_MS = 120_000;

const TASK_VERB = /^(?:(?:hey |yo |ok |okay )?(?:tony,? )?)?(?:please |can you |could you |would you |go |quickly )*(?:check|read|find|look up|look for|search|pull up|get me|get|list|summari[sz]e|draft|show me|show|count|tell me what|what did|go through|fetch|grab)\b/i;

/** Is `line` a task Tony would be working on (a live-tool read, or a check / find / draft ask)? Pure. */
export function isTaskLine(line: string): boolean {
  const t = line.trim();
  if (t.split(/\s+/).length < 2) return false;
  return directTool(t) !== null || TASK_VERB.test(t);
}

/** "never mind", "forget it", "cancel that", "stop": the new line drops the old task on purpose. Pure. */
export function isDismissal(line: string): boolean {
  return /^(?:(?:ok |okay |actually |no )?(?:never ?mind|forget (?:it|that|about it)|cancel(?: that| it)?|stop(?: that| it)?|scratch that|skip (?:it|that)|don'?t bother|leave it))\b/i.test(line.trim());
}

/** A yes to "want me to finish …?". Pure. */
export function isResumeYes(line: string): boolean {
  return /^(?:yes|yeah|yep|yup|sure|ok|okay|please|do it|go ahead|go for it|finish it|finish that|carry on|continue|sounds good)\b(?:[ ,.!]+(?:please|do it|go ahead|finish it|tony|thanks))*[ .!]*$/i.test(line.trim());
}

/** A no to the offer. Pure. */
export function isResumeNo(line: string): boolean {
  return /^(?:no|nah|nope|not now|no thanks|leave it|skip it|forget it|never ?mind)\b[ ,.!]*(?:tony|thanks)?[ .!]*$/i.test(line.trim());
}

/** "Earlier you asked me to …": the offer, as text. Pure. */
export function resumeOffer(task: Pick<TaskLine, "line">): string {
  const q = task.line.trim().replace(/[?.!]+$/, "");
  return `You changed the subject before I finished “${q}”. Want me to finish it now?`;
}

/** The in-flight task, the dropped one and the open offer (module state, one controller). */
export interface DroppedState {
  inFlight: (TaskLine & { gen: number }) | null;
  dropped: TaskLine | null;
  offer: TaskLine | null;
}

export function createDroppedTasks(now: () => number = Date.now) {
  const s: DroppedState = { inFlight: null, dropped: null, offer: null };
  let n = 0;
  return {
    state: s,
    /** A line starts a turn at mic generation `gen`. Returns the tracked task (null: not a task). */
    begin(line: string, thread: string, gen: number): (TaskLine & { gen: number }) | null {
      if (isDismissal(line)) {
        s.dropped = null;
        s.offer = null;
      }
      if (!isTaskLine(line)) return null;
      s.inFlight = { id: `task-${now()}-${++n}`, line: line.trim(), thread, at: now(), gen };
      return s.inFlight;
    },
    /** The turn for `task` ended (answered or not). */
    end(task: { id: string } | null) {
      if (task && s.inFlight?.id === task.id) s.inFlight = null;
    },
    /** A new command superseded the turn in flight: keep its task. */
    supersede() {
      if (s.inFlight) s.dropped = { id: s.inFlight.id, line: s.inFlight.line, thread: s.inFlight.thread, at: s.inFlight.at };
      s.inFlight = null;
    },
    /** The superseding turn finished: the dropped task becomes an open offer (once). */
    takeOffer(currentLine: string): TaskLine | null {
      const d = s.dropped;
      s.dropped = null;
      if (!d || d.line.toLowerCase() === currentLine.trim().toLowerCase()) return null;
      s.offer = { ...d, at: now() };
      return s.offer;
    },
    /** Nic's next line against the open offer: "resume" (re-run it), "decline", or null (unrelated, offer closed). */
    answer(line: string): { kind: "resume" | "decline"; task: TaskLine } | null {
      const o = s.offer;
      if (!o) return null;
      if (now() - o.at > RESUME_TTL_MS) {
        s.offer = null;
        return null;
      }
      if (isResumeYes(line)) {
        s.offer = null;
        return { kind: "resume", task: o };
      }
      if (isResumeNo(line)) {
        s.offer = null;
        return { kind: "decline", task: o };
      }
      s.offer = null;
      return null;
    },
    /** The "Finish it" button: the offer with this id, consumed. */
    claim(id: string): TaskLine | null {
      const o = s.offer;
      if (!o || o.id !== id) return null;
      s.offer = null;
      return o;
    },
  };
}
