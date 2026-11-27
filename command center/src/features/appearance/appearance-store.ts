import { create } from "zustand";
import { persist } from "zustand/middleware";
import { BUILTIN_THEMES, DEFAULT_TOKENS, resolveTokens, sanitizePatch, type Theme, type ThemeTokens, type TokenKey, type TokenPatch } from "./theme";

/** What Reset / applying a theme / an import replaced, so Undo can bring it back (this session). */
interface Snapshot {
  activeTheme: string;
  app: TokenPatch;
  pages: Record<string, TokenPatch>;
}

export interface AppearanceState extends Snapshot {
  /** Themes you saved (the built-ins are not stored). */
  themes: Theme[];
  lastReset: Snapshot | null;
  /** One token, app-wide (no page) or for one page only. */
  setToken: <K extends TokenKey>(key: K, value: ThemeTokens[K], page?: string | null) => void;
  /** Back to the inherited value (page: the app-wide one; app-wide: the theme's). */
  clearToken: (key: TokenKey, page?: string | null) => void;
  /** Reset to default: everything (theme, app-wide edits, every page's overrides). Undo-able. */
  resetAll: () => void;
  /** One page back to the app-wide look. Undo-able. */
  resetPage: (page: string) => void;
  undoReset: () => void;
  applyTheme: (id: string) => void;
  /** Save the current app-wide look as a theme (it becomes the active one); returns its id. */
  saveTheme: (name: string) => string;
  /** Overwrite a saved theme with the current app-wide look. */
  updateTheme: (id: string) => void;
  renameTheme: (id: string, name: string) => void;
  deleteTheme: (id: string) => void;
}

const snap = (s: Snapshot): Snapshot => ({ activeTheme: s.activeTheme, app: s.app, pages: s.pages });

export const allThemes = (s: Pick<AppearanceState, "themes">): Theme[] => [...BUILTIN_THEMES, ...s.themes];
export const themeOf = (s: Pick<AppearanceState, "themes" | "activeTheme">): Theme => allThemes(s).find((t) => t.id === s.activeTheme) ?? BUILTIN_THEMES[0];

/** The look in force: the theme, your app-wide edits, then `page`'s overrides. */
export function resolvedFor(s: Pick<AppearanceState, "themes" | "activeTheme" | "app" | "pages">, page?: string | null): ThemeTokens {
  return resolveTokens(themeOf(s).tokens, s.app, page ? s.pages[page] : undefined);
}

/** Only what differs from the default (what a saved theme stores). Pure. */
export function diffFromDefault(t: ThemeTokens): TokenPatch {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(DEFAULT_TOKENS) as TokenKey[]) if (t[k] !== DEFAULT_TOKENS[k]) out[k] = t[k];
  return out as TokenPatch;
}

/** Rehydration / import guard. Pure. */
export function sanitizeAppearance(raw: unknown): Pick<AppearanceState, "themes" | "activeTheme" | "app" | "pages"> {
  const r = (raw ?? {}) as Partial<AppearanceState>;
  const themes = (Array.isArray(r.themes) ? r.themes : [])
    .filter((t): t is Theme => !!t && typeof t.id === "string" && /^[\w-]{1,40}$/.test(t.id) && !BUILTIN_THEMES.some((b) => b.id === t.id))
    .map((t) => ({ id: t.id, name: typeof t.name === "string" && t.name.trim() ? t.name.trim().slice(0, 40) : "Theme", tokens: sanitizePatch(t.tokens) }))
    .slice(0, 50);
  const activeTheme = typeof r.activeTheme === "string" && [...BUILTIN_THEMES, ...themes].some((t) => t.id === r.activeTheme) ? r.activeTheme : "default";
  const pages: Record<string, TokenPatch> = {};
  if (r.pages && typeof r.pages === "object")
    for (const [k, v] of Object.entries(r.pages)) {
      const p = sanitizePatch(v);
      if (/^[\w-]{1,40}$/.test(k) && Object.keys(p).length) pages[k] = p;
    }
  return { themes, activeTheme, app: sanitizePatch(r.app), pages };
}

const newId = () => `t-${crypto.randomUUID().slice(0, 8)}`;

export const useAppearance = create<AppearanceState>()(
  persist(
    (set, get) => ({
      themes: [],
      activeTheme: "default",
      app: {},
      pages: {},
      lastReset: null,
      setToken: (key, value, page) => {
        const patch = sanitizePatch({ [key]: value });
        if (!(key in patch)) return;
        // An edit after a reset means that reset is settled (Undo would throw the edit away).
        set((s) => (page ? { pages: { ...s.pages, [page]: { ...s.pages[page], ...patch } }, lastReset: null } : { app: { ...s.app, ...patch }, lastReset: null }));
      },
      clearToken: (key, page) =>
        set((s) => {
          if (page) {
            const p = { ...s.pages[page] };
            delete p[key];
            const pages = { ...s.pages };
            if (Object.keys(p).length) pages[page] = p;
            else delete pages[page];
            return { pages, lastReset: null };
          }
          const app = { ...s.app };
          delete app[key];
          return { app, lastReset: null };
        }),
      resetAll: () => set((s) => ({ lastReset: snap(s), activeTheme: "default", app: {}, pages: {} })),
      resetPage: (page) =>
        set((s) => {
          if (!s.pages[page]) return s;
          const pages = { ...s.pages };
          delete pages[page];
          return { lastReset: snap(s), pages };
        }),
      undoReset: () => {
        const r = get().lastReset;
        if (r) set({ ...r, lastReset: null });
      },
      applyTheme: (id) => {
        if (!allThemes(get()).some((t) => t.id === id)) return;
        // A theme shows as designed: your app-wide edits are set aside (Undo brings them back).
        set((s) => ({ lastReset: snap(s), activeTheme: id, app: {} }));
      },
      saveTheme: (name) => {
        const s = get();
        const id = newId();
        const tokens = diffFromDefault(resolvedFor(s));
        set({ themes: [...s.themes, { id, name: name.trim().slice(0, 40) || "My theme", tokens }], activeTheme: id, app: {}, lastReset: null });
        return id;
      },
      updateTheme: (id) =>
        set((s) => {
          if (!s.themes.some((t) => t.id === id)) return s;
          const tokens = diffFromDefault(resolvedFor(s));
          return { themes: s.themes.map((t) => (t.id === id ? { ...t, tokens } : t)), activeTheme: id, app: {}, lastReset: null };
        }),
      renameTheme: (id, name) => {
        const n = name.trim().slice(0, 40);
        if (n) set((s) => ({ themes: s.themes.map((t) => (t.id === id ? { ...t, name: n } : t)) }));
      },
      deleteTheme: (id) =>
        set((s) => ({ themes: s.themes.filter((t) => t.id !== id), activeTheme: s.activeTheme === id ? "default" : s.activeTheme, lastReset: null })),
    }),
    {
      name: "cc.appearance",
      version: 1,
      partialize: (s) => ({ themes: s.themes, activeTheme: s.activeTheme, app: s.app, pages: s.pages }),
      merge: (persisted, current) => (persisted == null ? current : { ...current, ...sanitizeAppearance(persisted) }),
    },
  ),
);
