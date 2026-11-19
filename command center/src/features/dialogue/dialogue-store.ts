import { create } from "zustand";
import type { AgentRole } from "@/features/dispatcher/agents";
import type { ThreadId } from "@/features/voice/voice-store";

/**
 * P3 brainstorm sessions, one per thread. Live state only (never persisted, like the voice
 * store's pending card): a session starts on the first Tier-2 turn and ends on an approved
 * delegation, a park/save, an explicit Tier-1 switch (a Named delegation or a mutating request),
 * or after 20 minutes without a Tier-2 turn. It marks where the conversation slice starts when
 * the brainstorm is packaged.
 */
export const BRAINSTORM_IDLE_MS = 20 * 60_000;

export interface BrainstormSession {
  startedAt: number;
  lastAt: number;
  /** The user turn that started it (the packaged slice starts here). */
  fromTurnId: string;
  /** The agent Tony kept this from (a Domain / mentioned agent) — the Tier-3 delegate. */
  topicRole?: AgentRole;
  /** Something buildable came up: the Tier-3 yes runs the full pipeline (U5). */
  buildShaped: boolean;
}

interface DialogueStore {
  sessions: Partial<Record<ThreadId, BrainstormSession>>;
  /** Start or extend the thread's session with a Tier-2 turn. */
  touch: (thread: ThreadId, turnId: string, info?: { topicRole?: AgentRole; buildShaped?: boolean }, now?: number) => void;
  end: (thread: ThreadId) => void;
  /** The live session, or null (none, or idle past 20 min — then it is dropped). */
  active: (thread: ThreadId, now?: number) => BrainstormSession | null;
}

export const useDialogue = create<DialogueStore>((set, get) => ({
  sessions: {},
  touch: (thread, turnId, info = {}, now = Date.now()) => {
    const cur = get().active(thread, now);
    const next: BrainstormSession = cur
      ? { ...cur, lastAt: now, topicRole: cur.topicRole ?? info.topicRole, buildShaped: cur.buildShaped || !!info.buildShaped }
      : { startedAt: now, lastAt: now, fromTurnId: turnId, topicRole: info.topicRole, buildShaped: !!info.buildShaped };
    set((s) => ({ sessions: { ...s.sessions, [thread]: next } }));
  },
  end: (thread) =>
    set((s) => {
      if (!s.sessions[thread]) return s;
      const sessions = { ...s.sessions };
      delete sessions[thread];
      return { sessions };
    }),
  active: (thread, now = Date.now()) => {
    const s = get().sessions[thread];
    if (!s) return null;
    if (now - s.lastAt > BRAINSTORM_IDLE_MS) {
      get().end(thread);
      return null;
    }
    return s;
  },
}));
