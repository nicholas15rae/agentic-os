import { create } from "zustand";
import { persist } from "zustand/middleware";
import { CORNERS, HELLO_GAP_MS, POP_MS, dayKey, isStreak, mayPop, migrateFrequency, pickLine, type CharacterEvent, type Corner, type Frequency } from "./logic";
import { CHARACTERS, characterById } from "./roster";

/**
 * The pop-in characters' settings (saved) and what they are doing (not saved). Nothing is on
 * screen at rest: a character only exists while it pops in. Settings → Appearance → Live
 * characters edits the saved part; clicking a character opens its menu (Mute / Hide / Settings).
 */
export interface CharacterPrefs {
  on: boolean;
  corner: Corner;
}

export interface CharacterPop {
  id: string;
  text: string;
  at: number;
}

export interface CharactersState {
  /** Characters may pop in at all (Hide characters turns this off). */
  visible: boolean;
  /** No pop-ins (Mute pop-ups). */
  muted: boolean;
  frequency: Frequency;
  chars: Record<string, CharacterPrefs>;
  /** When the last random "hey, what's up" was (saved, so it stays at most once an hour across launches). */
  lastHelloAt: number;
  // ── Not saved ──
  pop: CharacterPop | null;
  /** His menu is open: he stays until it closes. */
  held: boolean;
  lastPopAt: number;
  lastLine: string | null;
  done: { day: string; n: number };
  setVisible: (v: boolean) => void;
  setMuted: (v: boolean) => void;
  setFrequency: (f: Frequency) => void;
  setChar: (id: string, patch: Partial<CharacterPrefs>) => void;
  /** Something happened: the first character that is on may pop in (frequency, mute and quiet permitting). Returns whether one did. */
  emit: (e: CharacterEvent, now?: number) => boolean;
  /** Settings → Try it: pop in now, whatever the frequency. */
  preview: (id: string, now?: number) => void;
  /** Keep him while his menu is open; letting go sends him off shortly after. */
  hold: (on: boolean) => void;
  /** Duck out now. */
  leave: () => void;
  /** Settings back to the defaults. */
  reset: () => void;
}

export const CHARACTER_DEFAULTS = {
  visible: true,
  muted: false,
  frequency: "normal" as Frequency,
  chars: Object.fromEntries(CHARACTERS.map((c) => [c.id, { on: true, corner: c.corner }])) as Record<string, CharacterPrefs>,
};

/** The characters that are on, in roster order. Pure. */
export const activeCharacters = (s: Pick<CharactersState, "visible" | "chars">) => (s.visible ? CHARACTERS.filter((c) => s.chars[c.id]?.on ?? true) : []);

/** Rehydration / import guard (older saves' frequencies are mapped). Pure. */
export function sanitizeCharacters(raw: unknown): typeof CHARACTER_DEFAULTS {
  const r = (raw ?? {}) as Partial<CharactersState>;
  const chars: Record<string, CharacterPrefs> = {};
  for (const c of CHARACTERS) {
    const v = (r.chars as Record<string, Partial<CharacterPrefs>> | undefined)?.[c.id];
    chars[c.id] = { on: typeof v?.on === "boolean" ? v.on : true, corner: CORNERS.includes(v?.corner as Corner) ? (v!.corner as Corner) : c.corner };
  }
  return {
    visible: typeof r.visible === "boolean" ? r.visible : true,
    muted: typeof r.muted === "boolean" ? r.muted : false,
    frequency: migrateFrequency(r.frequency),
    chars,
  };
}

/** Why a pop-in must wait right now (a call, typing, full screen, Trading, Do Not Disturb). Set by events.ts. */
let quietCheck: () => string | null = () => null;
export function setQuietCheck(fn: () => string | null): void {
  quietCheck = fn;
}

let leaveTimer: ReturnType<typeof setTimeout> | undefined;

export const useCharacters = create<CharactersState>()(
  persist(
    (set, get) => {
      const scheduleLeave = (ms: number) => {
        clearTimeout(leaveTimer);
        const pop = get().pop;
        leaveTimer = setTimeout(() => {
          const s = get();
          if (s.pop === pop && !s.held) set({ pop: null });
        }, ms);
      };
      const show = (pop: CharacterPop) => {
        set({ pop, held: false, lastLine: pop.text, lastPopAt: pop.at });
        scheduleLeave(POP_MS);
      };
      return {
        ...CHARACTER_DEFAULTS,
        lastHelloAt: 0,
        pop: null,
        held: false,
        lastPopAt: 0,
        lastLine: null,
        done: { day: "", n: 0 },
        setVisible: (visible) => set(visible ? { visible } : { visible, pop: null, held: false }),
        setMuted: (muted) => set(muted ? { muted, pop: null, held: false } : { muted }),
        setFrequency: (f) => set({ frequency: migrateFrequency(f) }),
        setChar: (id, patch) =>
          set((s) => {
            if (!characterById(id)) return s;
            const cur = s.chars[id] ?? { on: true, corner: characterById(id)!.corner };
            const next = { on: typeof patch.on === "boolean" ? patch.on : cur.on, corner: patch.corner && CORNERS.includes(patch.corner) ? patch.corner : cur.corner };
            return { chars: { ...s.chars, [id]: next }, ...(next.on || s.pop?.id !== id ? {} : { pop: null, held: false }) };
          }),
        emit: (e, now = Date.now()) => {
          const s = get();
          // A finished thing counts towards today's streak even when nobody pops in for it.
          let kind = e.kind;
          if (kind === "done") {
            const day = dayKey(now);
            const n = s.done.day === day ? s.done.n + 1 : 1;
            set({ done: { day, n } });
            if (isStreak(n)) kind = "streak";
          }
          if (s.pop) return false; // one at a time
          if (kind === "hello" && now - s.lastHelloAt < HELLO_GAP_MS) return false;
          const who = activeCharacters(s).find((c) => c.reactsTo.includes(kind));
          if (!who || !mayPop(now, s.lastPopAt, s.frequency, s.muted) || quietCheck()) return false;
          const text = e.text?.trim() || pickLine(who.lines[kind] ?? who.lines.done, s.lastLine).replace("{n}", String(get().done.n));
          if (kind === "hello") set({ lastHelloAt: now });
          show({ id: who.id, text, at: now });
          return true;
        },
        preview: (id, now = Date.now()) => {
          const c = characterById(id);
          if (!c) return;
          show({ id, text: pickLine([...(c.lines.hello ?? []), ...c.lines.done], get().lastLine), at: now });
        },
        hold: (on) => {
          set({ held: on });
          if (!on && get().pop) scheduleLeave(1_200);
        },
        leave: () => set({ pop: null, held: false }),
        reset: () => set({ ...CHARACTER_DEFAULTS, pop: null, held: false }),
      };
    },
    {
      name: "cc.characters",
      version: 2,
      partialize: (s) => ({ visible: s.visible, muted: s.muted, frequency: s.frequency, chars: s.chars, lastHelloAt: s.lastHelloAt }),
      migrate: (persisted) => persisted as never,
      merge: (persisted, current) => {
        if (persisted == null) return current;
        const at = (persisted as { lastHelloAt?: unknown }).lastHelloAt;
        return { ...current, ...sanitizeCharacters(persisted), lastHelloAt: typeof at === "number" && Number.isFinite(at) ? at : 0 };
      },
    },
  ),
);
