import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { AgentReport, InboxMessage } from "@/features/voice/agent-reports";

/** Inbox rows kept (newest win). */
export const INBOX_CAP = 200;

/** Add `r` to `list` (newest first, deduped by id, capped). An existing row keeps its read state. Pure. */
export function addMessage(list: readonly InboxMessage[], r: AgentReport, cap = INBOX_CAP): InboxMessage[] {
  if (list.some((m) => m.id === r.id)) return list as InboxMessage[];
  return [{ ...r, read: false }, ...list].sort((a, b) => b.at - a.at).slice(0, cap);
}

/** Mark rows read (`ids`; all of `agent`'s when given; everything when neither). Pure. */
export function markRead(list: readonly InboxMessage[], o: { ids?: readonly string[]; agent?: string }): InboxMessage[] {
  const hit = (m: InboxMessage) => (o.ids ? o.ids.includes(m.id) : o.agent ? m.agent === o.agent : true);
  return list.map((m) => (!m.read && hit(m) ? { ...m, read: true } : m));
}

interface InboxState {
  messages: InboxMessage[];
  add: (r: AgentReport) => void;
  /** Played in full: read, with who spoke it and whether it cut in. */
  heard: (id: string, meta: { voice: string; interrupted: boolean }) => void;
  read: (o: { ids?: readonly string[]; agent?: string }) => void;
  clearRead: () => void;
}

/**
 * The Comms inbox of agent reports (desktop). Persisted in this webview's storage, so a report
 * left while Nic was away (or still queued behind Tony) is waiting after a restart too.
 */
export const useAgentInbox = create<InboxState>()(
  persist(
    (set, get) => ({
      messages: [],
      add: (r) => set({ messages: addMessage(get().messages, r) }),
      heard: (id, meta) => set({ messages: get().messages.map((m) => (m.id === id ? { ...m, read: true, spokenAt: Date.now(), voice: meta.voice, interrupted: meta.interrupted || m.interrupted } : m)) }),
      read: (o) => set({ messages: markRead(get().messages, o) }),
      clearRead: () => set({ messages: get().messages.filter((m) => !m.read) }),
    }),
    {
      name: "cc-agent-inbox",
      version: 1,
      storage: createJSONStorage(() => {
        try {
          return localStorage;
        } catch {
          return { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
        }
      }),
      partialize: (s) => ({ messages: s.messages }),
    },
  ),
);

export const unreadCount = (msgs: readonly InboxMessage[]) => msgs.reduce((n, m) => n + (m.read ? 0 : 1), 0);
