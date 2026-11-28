import { create } from "zustand";
import { persist } from "zustand/middleware";
import { CORNERS, FREQUENCIES, POP_MS, dayKey, isStreak, mayPop, pickLine, type CharacterEvent, type Corner, type Frequency } from "./logic";
import { CHARACTERS, characterById } from "./roster";

/**
 * UI fixes 2: the overlay characters' settings (saved) and what they are doing (not saved).
 * Settings → Appearance → Live characters edits the saved part; right-click or press and hold a
 * character for the quick Mute / Hide menu.
 */
export interface CharacterPrefs {
  on: boolean;
  corner: Corner;
}

export interface CharacterPop {
  id: string;
  text: string;
  /** "react" = a tap (a quick reaction), "pop" = something happened. */
  kind: "pop" | "react";
  at: number;
}

export interface CharactersState {
  /** Show the characters at all (Hide turns this off). */
  visible: boolean;
  /** No pop-ups on their own (taps still work). */
  muted: boolean;
  frequency: Frequency;
  chars: Record<string, CharacterPrefs>;
  /** The day the hello was last said (saved, so it is once a day, not once per launch). */
  helloDay: string;
  // ── Not saved ──
  pop: CharacterPop | null;
  lastPopAt: number;
  lastLine: string | null;
  done: { day: string; n: number };
  setVisible: (v: boolean) => void;
  setMuted: (v: boolean) => void;
  setFrequency: (f: Frequency) => void;
  setChar: (id: string, patch: Partial<CharacterPrefs>) => void;
  /** Something happened: the first character that is on may pop up (frequency and mute permitting). Returns whether one did. */
  emit: (e: CharacterEvent, now?: number) => boolean;
  /** You tapped a character: it always reacts. */
  tap: (id: string, now?: number) => void;
  /** Tuck away now. */
  tuck: () => void;
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

/** Rehydration / import guard. Pure. */
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
    frequency: FREQUENCIES.includes(r.frequency as Frequency) ? (r.frequency as Frequency) : "normal",
    chars,
  };
}

let tuckTimer: ReturnType<typeof setTimeout> | undefined;

export const useCharacters = create<CharactersState>()(
  persist(
    (set, get) => {
      const show = (pop: CharacterPop) => {
        set({ pop, lastLine: pop.text, ...(pop.kind === "pop" ? { lastPopAt: pop.at } : {}) });
        clearTimeout(tuckTimer);
        tuckTimer = setTimeout(() => get().pop === pop && set({ pop: null }), POP_MS);
      };
      return {
        ...CHARACTER_DEFAULTS,
        helloDay: "",
        pop: null,
        lastPopAt: 0,
        lastLine: null,
        done: { day: "", n: 0 },
        setVisible: (visible) => set(visible ? { visible } : { visible, pop: null }),
        setMuted: (muted) => set({ muted }),
        setFrequency: (frequency) => FREQUENCIES.includes(frequency) && set({ frequency }),
        setChar: (id, patch) =>
          set((s) => {
            if (!characterById(id)) return s;
            const cur = s.chars[id] ?? { on: true, corner: characterById(id)!.corner };
            const next = { on: typeof patch.on === "boolean" ? patch.on : cur.on, corner: patch.corner && CORNERS.includes(patch.corner) ? patch.corner : cur.corner };
            return { chars: { ...s.chars, [id]: next }, ...(next.on || s.pop?.id !== id ? {} : { pop: null }) };
          }),
        emit: (e, now = Date.now()) => {
          const s = get();
          // A finished thing counts towards today's streak even when nobody pops up for it.
          let kind = e.kind;
          // Hello: once a day at most.
          if (kind === "hello") {
            if (s.helloDay === dayKey(now)) return false;
            set({ helloDay: dayKey(now) });
          }
          if (kind === "done") {
            const day = dayKey(now);
            const n = s.done.day === day ? s.done.n + 1 : 1;
            set({ done: { day, n } });
            if (isStreak(n)) kind = "streak";
          }
          const who = activeCharacters(s).find((c) => c.reactsTo.includes(kind));
          if (!who || !mayPop(now, s.lastPopAt, s.frequency, s.muted, "event")) return false;
          const n = get().done.n;
          const text = e.text?.trim() || pickLine(who.lines[kind] ?? who.lines.done, s.lastLine).replace("{n}", String(n));
          show({ id: who.id, text, kind: "pop", at: now });
          return true;
        },
        tap: (id, now = Date.now()) => {
          const c = characterById(id);
          if (!c) return;
          // A second tap while it is up tucks it away.
          if (get().pop?.id === id) return set({ pop: null });
          show({ id, text: pickLine(c.lines.tap, get().lastLine), kind: "react", at: now });
        },
        tuck: () => set({ pop: null }),
        reset: () => set({ ...CHARACTER_DEFAULTS, pop: null }),
      };
    },
    {
      name: "cc.characters",
      version: 1,
      partialize: (s) => ({ visible: s.visible, muted: s.muted, frequency: s.frequency, chars: s.chars, helloDay: s.helloDay }),
      merge: (persisted, current) => {
        if (persisted == null) return current;
        const day = (persisted as { helloDay?: unknown }).helloDay;
        return { ...current, ...sanitizeCharacters(persisted), helloDay: typeof day === "string" ? day.slice(0, 10) : "" };
      },
    },
  ),
);
