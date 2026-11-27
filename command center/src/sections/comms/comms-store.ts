import { create } from "zustand";
import { gateway } from "@/lib/gateway";

export interface Thread {
  thread: string;
  contact: string;
  address: string;
  body: string;
  ts: number;
  direction: "in" | "out";
  channel: string;
  unread: number;
  trusted: boolean;
  /** The phone-book entry this number is filed under (os_api comms_threads), if any. */
  contactId?: string | null;
  contactName?: string;
  company?: string;
  role?: string;
}

/**
 * The Comms page's thread list and selection, shared by its Conversations and Conversation panels
 * (they are separate panels on the shared layout, so the selection can't be local state).
 */
export const useCommsThreads = create<{
  threads: Thread[] | null;
  err: string | null;
  sel: string | null;
  setSel: (sel: string | null) => void;
  load: () => void;
}>((set) => ({
  threads: null,
  err: null,
  sel: null,
  setSel: (sel) => set({ sel }),
  load: () =>
    void gateway<{ threads: Thread[] }>("/api/comms/threads")
      .then((r) => set({ threads: r.threads, err: null }))
      .catch((e) => set({ err: String(e) })),
}));
