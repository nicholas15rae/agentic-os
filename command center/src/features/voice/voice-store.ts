import { create } from "zustand";
import type { LearnedPathway } from "@/features/modes/learning";
import type { DispatchView, PacketResult } from "@/features/arbiter/api";
import { persist } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";
import type { AgentRole } from "@/features/dispatcher/agents";
import type { ActionPlan } from "@/features/orchestrator/plan";
import type { Section } from "@/stores/nav";

/**
 * The conversation store. The floating HUD, the Voice Console widget, the
 * confirmation card and the Agents section are all views of this.
 *
 * Conversations are split into isolated threads, one per Dispatcher tab:
 * "auto" (Auto-route), each sub-agent (librarian, coder, booking, ops) and
 * "general" (the OS itself, "Tony"). Inter-agent traffic (TONY → BOOKING
 * AGENT and back) is logged as `relay` turns in that agent's thread.
 */
export type VoiceState =
  | "idle"
  | "listening" // mic open, waiting for / hearing speech
  | "transcribing" // Whisper is converting the utterance
  | "thinking" // planning, verifying or executing
  | "confirming" // a mutating plan is waiting for yes/no
  | "speaking"
  | "holding" // Phase 2: "whoa" / "madone" / "aspetta" (or "take it easy" over a busy turn) — reply paused, collecting your thought
  | "error";

export type Channel = "voice" | "text";
export type ThreadId = "auto" | AgentRole;
export const THREADS: ThreadId[] = ["auto", "general", "prompter", "designer", "director", "coder", "booking", "librarian", "ops"];

/** The phone HUD (`/cc/?view=hud`, MobileHud): Tony's thread there is always "general". */
const HUD_VIEW = typeof location !== "undefined" && new URLSearchParams(location.search).get("view") === "hud";

/**
 * Tony's own conversation thread (P2/U2) — where voice turns and every Tony output land, and
 * what the Tony views (VoiceHUD, VoiceConsole, MobileHud's Tony pill) show: "general" while the
 * Agents section's Tony tab is open (and always on the phone HUD), else "auto". Never a
 * sub-agent thread, whichever tab is open.
 */
export function tonyThreadFor(section: Section, activeThread: ThreadId, hud = false): ThreadId {
  if (hud) return "general";
  return section === "agents" && activeThread === "general" ? "general" : "auto";
}

/** The visible section, registered by the voice controller (`setSectionSource`) — this store
 * stays free of the nav store, which reads `location` at import. */
let sectionSource: () => Section = () => "command";
export const setSectionSource = (fn: () => Section) => {
  sectionSource = fn;
};

export const tonyThread = (): ThreadId => tonyThreadFor(sectionSource(), useVoice.getState().activeThread, HUD_VIEW);

/** Tony's thread for a view that already knows the section (`useTonyThread` in VoiceParts). */
export const tonyThreadForView = (section: Section, activeThread: ThreadId): ThreadId => tonyThreadFor(section, activeThread, HUD_VIEW);

export interface VoiceTurn {
  id: string;
  /** relay = an agent-to-agent message (shown with FROM → TO badges). */
  who: "user" | "agent" | "system" | "relay";
  text: string;
  thread: ThreadId;
  at: number;
  role?: AgentRole;
  meta?: string;
  tone?: "ok" | "warn" | "error";
  /** Speaker id for agent/relay turns: "os", "booking", "overseer"… */
  from?: string;
  to?: string;
  /** "View in Booking Desk →" pill. */
  link?: ThreadId;
  /** "Jump to Thread in Comms →" pill (comms thread key). */
  commsThread?: string;
  /** "Open in Play Place →" pill. */
  cardId?: string;
  /** Learning mode: the pathways Tony saved on this reply ("Memory saved: …" pills). */
  learned?: LearnedPathway[];
  /** Tony's dispatch packet under his reply (held / pending approval / queued). */
  dispatch?: DispatchView;
  /** A dispatched packet's outcome (per task: status, attempts, output). */
  packet?: PacketResult;
  /** One-tap answers under the message ("Yes, run the pipeline"). */
  actions?: { label: string; run: string }[];
  /** The build (worker task) an agent / pipeline turn belongs to (grouping, review). */
  taskId?: string;
  /** An Agent Conversation card (transcript-store.ts): the reviewable Tony ↔ agents record of
   * one task / build / delegation. Rendered from Rust's transcript, hidden by
   * `chat.showAgentConversation`; on the phone it is a plain line. */
  convId?: string;
  /** Bumped by every in-place `updateTurn` (token streaming): the phone mirror replaces a copy
   * it already holds when the desktop's is newer (it used to keep the first, cut-off one). */
  rev?: number;
}

export interface PendingConfirmation {
  plan: ActionPlan;
  channel: Channel;
  deadline: number;
  reprompted: boolean;
}

interface VoiceStore {
  state: VoiceState;
  /** HUD expanded (panel) vs collapsed (pill). */
  expanded: boolean;
  /** The Voice Console widget is on screen, so the floating HUD steps aside. */
  consoleVisible: boolean;
  partial: string;
  turns: VoiceTurn[];
  /** The tab new input goes to (and the HUD shows). */
  activeThread: ThreadId;
  pending: PendingConfirmation | null;
  error: string | null;
  /** Hold mode: what you've said since the hold began (live in the HUD); null when not holding. */
  held: string[] | null;
  /** When each thread was last cleared: Agent Conversation cards older than that aren't re-added
   * by a restart's rebuild. */
  clearedAt: Partial<Record<ThreadId, number>>;
  setHeld: (h: string[] | null) => void;
  setState: (s: VoiceState) => void;
  setExpanded: (v: boolean) => void;
  setConsoleVisible: (v: boolean) => void;
  setPartial: (t: string) => void;
  setActiveThread: (t: ThreadId) => void;
  pushTurn: (t: Omit<VoiceTurn, "id" | "at" | "thread"> & { thread?: ThreadId }) => VoiceTurn;
  /** Patch a turn in place (token streaming). */
  updateTurn: (id: string, patch: Partial<VoiceTurn>) => void;
  setPending: (p: PendingConfirmation | null) => void;
  setError: (e: string | null) => void;
  /** Clear one thread (default: the active one). */
  clear: (thread?: ThreadId) => void;
  /** Replace threads from the gateway (phone sync). */
  mergeRemote: (turns: VoiceTurn[]) => void;
}

/** Turns kept per thread (`cap`); transcript-store places cards against it. */
export const PER_THREAD = 120;

/** Should a mirrored copy of a turn replace the local one? Pure. */
export function remoteIsNewer(local: VoiceTurn, remote: VoiceTurn): boolean {
  const lr = local.rev ?? 0;
  const rr = remote.rev ?? 0;
  if (rr !== lr) return rr > lr;
  return remote.at >= local.at && (remote.text !== local.text || remote.meta !== local.meta);
}

function cap(turns: VoiceTurn[]): VoiceTurn[] {
  const counts = new Map<ThreadId, number>();
  const out: VoiceTurn[] = [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const n = counts.get(turns[i].thread) ?? 0;
    if (n < PER_THREAD) {
      out.push(turns[i]);
      counts.set(turns[i].thread, n + 1);
    }
  }
  return out.reverse();
}

export const useVoice = create<VoiceStore>()(
  persist(
    (set, get) => ({
      state: "idle",
      expanded: false,
      consoleVisible: false,
      partial: "",
      turns: [],
      activeThread: "auto",
      pending: null,
      error: null,
      held: null,
      clearedAt: {},
      setHeld: (held) => set({ held }),
      // While holding, the interrupted turn keeps running quietly; its state changes
      // ("speaking", "thinking"…) must not knock HOLDING off the orb/HUD/header.
      setState: (state) => {
        if (get().held && state !== "holding") return;
        set({ state, ...(state !== "error" ? { error: null } : {}) });
      },
      setExpanded: (expanded) => set({ expanded }),
      setConsoleVisible: (consoleVisible) => set({ consoleVisible }),
      setPartial: (partial) => set({ partial }),
      setActiveThread: (activeThread) => set({ activeThread }),
      pushTurn: (t) => {
        // No thread given ⇒ Tony's thread, never whichever sub-agent tab happens to be open.
        const turn: VoiceTurn = { ...t, thread: t.thread ?? tonyThreadFor(sectionSource(), get().activeThread, HUD_VIEW), id: crypto.randomUUID(), at: Date.now() };
        set((s) => ({ turns: cap([...s.turns, turn]) }));
        return turn;
      },
      updateTurn: (id, patch) => set((s) => ({ turns: s.turns.map((t) => (t.id === id ? { ...t, ...patch, rev: (t.rev ?? 0) + 1 } : t)) })),
      setPending: (pending) => set({ pending }),
      setError: (error) => set({ error, state: error ? "error" : "idle" }),
      clear: (thread) => {
        const th = thread ?? get().activeThread;
        set((s) => ({ turns: s.turns.filter((t) => t.thread !== th), partial: "", error: null, clearedAt: { ...s.clearedAt, [th]: Date.now() } }));
      },
      mergeRemote: (remote) =>
        set((s) => {
          const byId = new Map(remote.filter((t) => t && THREADS.includes(t.thread)).map((t) => [t.id, t]));
          // A turn both sides hold: the remote copy wins when it is a newer revision (a streamed
          // answer finished after the first push) or differs at an equal-or-later time.
          const kept = s.turns.map((t) => {
            const r = byId.get(t.id);
            if (!r) return t;
            byId.delete(t.id);
            return remoteIsNewer(t, r) ? r : t;
          });
          const merged = [...kept, ...byId.values()].sort((a, b) => a.at - b.at);
          return { turns: cap(merged) };
        }),
    }),
    {
      name: "cc.voice.threads",
      version: 1,
      // Only the conversation persists; live voice state always boots idle.
      // `activeThread` is NOT persisted — the main bars (VoiceConsole/VoiceHUD)
      // always pass thread "auto" explicitly, and a resumed session should
      // never silently inherit whatever tab was open when it was last closed
      // (that's how a stale "Prompter" tab used to swallow every request).
      partialize: (s) => ({ turns: s.turns, clearedAt: s.clearedAt }),
    },
  ),
);

/** Turns of one thread (hook). */
export const useThreadTurns = (thread?: ThreadId) =>
  useVoice(
    useShallow((s) => {
      const th = thread ?? s.activeThread;
      return s.turns.filter((t) => t.thread === th);
    }),
  );

/**
 * Audio level 0..1, written ~60×/s by the mic capture or TTS playback and
 * read by the waveform loop. Deliberately NOT React state.
 */
export const voiceLevel = { current: 0 };

/** The mic's input level 0..1 (Phase 2 Part B: kept apart from TTS so neither clobbers the other). */
export const micLevel = { current: 0 };

export const STATE_LABEL: Record<VoiceState, string> = {
  idle: "Standby",
  listening: "Listening",
  transcribing: "Transcribing",
  thinking: "Dispatching",
  confirming: "Awaiting confirmation",
  speaking: "Speaking",
  holding: "Holding",
  error: "Fault",
};
