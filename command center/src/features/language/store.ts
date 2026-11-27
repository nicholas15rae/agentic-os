/**
 * Language Hub state. The library and tutor tracks live on disk (api.ts); this store keeps the
 * in-memory session feed, tutor chats, the current drill deck, and per-device preferences
 * (localStorage, best effort). Nothing here is shared with any other feature's store.
 */
import { create } from "zustand";
import type { Category, LangEntry, LangEntryPatch, LangStatus, LangTrack, Level, NewLangEntry, SpokeWith, TutorReply, VoiceEngineInfo, VoicePrefs } from "./contract";
import { defaultVoicePrefs, normalizeVoicePrefs } from "./voice";
import { langApi } from "./api";
import type { TutorTurn } from "./prompts";

export type HubView = "translate" | "learn" | "library";

export interface FeedItem {
  key: string;
  /** "out": I spoke/typed English (or the source) → target. "in": a capture → English. */
  dir: "out" | "in";
  source_lang: string;
  target_lang: string;
  source_text: string;
  translated_text: string;
  phonetic: string;
  literal: string;
  notes: string;
  category: Category;
  /** Library id once saved. */
  savedId: string | null;
  via: "voice" | "text";
  at: number;
}

export interface TutorMsg extends TutorTurn {
  key: string;
  /** Tutor turns: the structured reply. User turns: the coach note about that message. */
  reply?: TutorReply;
}

export interface DrillCard {
  key: string;
  english: string;
  target: string;
  phonetic: string;
  lang: string;
  /** Set when the card is a Library entry (answers update its mastery). */
  entryId?: string;
}

interface Prefs {
  view: HubView;
  source: string; // "auto" or a code
  target: string;
  autoSave: boolean;
  autoSpeak: boolean;
  trackLang: string;
  /** This device's Web Speech voice per language ("*" = all), by voiceURI. Device-specific, so not synced. */
  browserVoices: Record<string, string>;
}

const PREFS_KEY = "language-hub.prefs.v1";
const DEFAULT_PREFS: Prefs = { view: "translate", source: "auto", target: "it", autoSave: true, autoSpeak: true, trackLang: "it", browserVoices: {} };

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<Prefs>) } : DEFAULT_PREFS;
  } catch {
    return DEFAULT_PREFS;
  }
}

function savePrefs(p: Prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* private mode / blocked storage: prefs just don't persist */
  }
}

let seq = 0;
export const newKey = (p: string) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

interface HubState extends Prefs {
  status: LangStatus | null;
  library: LangEntry[];
  libraryLoaded: boolean;
  libraryError: string | null;
  tracks: Record<string, LangTrack>;
  feed: FeedItem[];
  tutor: Record<string, TutorMsg[]>;
  deck: DrillCard[];
  lastEngine: SpokeWith | null;
  /** The shared voice choice (settings "voice") and the TTS providers available. */
  voice: VoicePrefs;
  engines: VoiceEngineInfo[];

  setPrefs: (p: Partial<Prefs>) => void;
  swap: () => void;
  loadAll: () => Promise<void>;
  addFeed: (f: Omit<FeedItem, "key" | "at" | "savedId">) => FeedItem;
  saveFeed: (key: string) => Promise<LangEntry | null>;
  clearUnsaved: () => void;
  saveEntry: (e: NewLangEntry) => Promise<LangEntry>;
  updateEntry: (id: string, patch: LangEntryPatch) => Promise<void>;
  deleteEntries: (ids: string[]) => Promise<number>;
  track: (lang: string) => LangTrack;
  bumpTrack: (lang: string, d: Partial<Pick<LangTrack, "got" | "again" | "lessons">> & { level?: Level }) => void;
  pushTutor: (lang: string, m: Omit<TutorMsg, "key">) => void;
  patchTutor: (lang: string, key: string, reply: TutorReply) => void;
  resetTutor: (lang: string) => void;
  setDeck: (cards: DrillCard[]) => void;
  setEngine: (e: SpokeWith) => void;
  setVoice: (v: VoicePrefs) => Promise<void>;
}

const prefsOf = (s: Prefs): Prefs => ({ view: s.view, source: s.source, target: s.target, autoSave: s.autoSave, autoSpeak: s.autoSpeak, trackLang: s.trackLang, browserVoices: s.browserVoices });

export const useHub = create<HubState>((set, get) => ({
  ...loadPrefs(),
  status: null,
  library: [],
  libraryLoaded: false,
  libraryError: null,
  tracks: {},
  feed: [],
  tutor: {},
  deck: [],
  lastEngine: null,
  voice: defaultVoicePrefs(),
  engines: [],

  setPrefs: (p) => {
    set(p);
    savePrefs(prefsOf(get()));
  },

  swap: () => {
    const { source, target } = get();
    get().setPrefs(source === "auto" ? { source: target, target: "en" } : { source: target, target: source });
  },

  loadAll: async () => {
    try {
      const [library, tracks, status, engines, voiceRaw] = await Promise.all([
        langApi.list(),
        langApi.tracks().catch(() => []),
        langApi.status().catch(() => null),
        langApi.voiceEngines().catch(() => [] as VoiceEngineInfo[]),
        langApi.getSetting("voice").catch(() => null),
      ]);
      set({ library, libraryLoaded: true, libraryError: null, status, tracks: Object.fromEntries(tracks.map((t) => [t.lang, t])), engines, voice: normalizeVoicePrefs(voiceRaw, engines) });
    } catch (e) {
      set({ libraryLoaded: true, libraryError: e instanceof Error ? e.message : String(e) });
    }
  },

  addFeed: (f) => {
    const item: FeedItem = { ...f, key: newKey("f"), at: Date.now(), savedId: null };
    set((s) => ({ feed: [item, ...s.feed].slice(0, 200) }));
    return item;
  },

  saveFeed: async (key) => {
    const f = get().feed.find((x) => x.key === key);
    if (!f || f.savedId) return null;
    const entry = await get().saveEntry({
      source_lang: f.source_lang,
      target_lang: f.target_lang,
      source_text: f.source_text,
      translated_text: f.translated_text,
      phonetic_guide: f.phonetic || null,
      context_note: f.notes || null,
      category: f.category,
    });
    set((s) => ({ feed: s.feed.map((x) => (x.key === key ? { ...x, savedId: entry.id } : x)) }));
    return entry;
  },

  clearUnsaved: () => set((s) => ({ feed: s.feed.filter((f) => f.savedId) })),

  saveEntry: async (e) => {
    const entry = await langApi.save(e);
    set((s) => ({ library: [entry, ...s.library] }));
    return entry;
  },

  updateEntry: async (id, patch) => {
    const entry = await langApi.update(id, patch);
    set((s) => ({ library: s.library.map((x) => (x.id === id ? entry : x)) }));
  },

  deleteEntries: async (ids) => {
    const n = await langApi.remove(ids);
    const gone = new Set(ids);
    set((s) => ({
      library: s.library.filter((x) => !gone.has(x.id)),
      feed: s.feed.map((f) => (f.savedId && gone.has(f.savedId) ? { ...f, savedId: null } : f)),
      deck: s.deck.filter((c) => !c.entryId || !gone.has(c.entryId)),
    }));
    return n;
  },

  track: (lang) => get().tracks[lang] ?? { lang, level: "beginner", got: 0, again: 0, lessons: 0, updated: 0 },

  bumpTrack: (lang, d) => {
    const t = get().track(lang);
    const next: LangTrack = { ...t, level: d.level ?? t.level, got: t.got + (d.got ?? 0), again: t.again + (d.again ?? 0), lessons: t.lessons + (d.lessons ?? 0), updated: Date.now() };
    set((s) => ({ tracks: { ...s.tracks, [lang]: next } }));
    void langApi.saveTrack(next).catch(() => undefined);
  },

  pushTutor: (lang, m) => set((s) => ({ tutor: { ...s.tutor, [lang]: [...(s.tutor[lang] ?? []), { ...m, key: newKey("t") }].slice(-60) } })),
  patchTutor: (lang, key, reply) => set((s) => ({ tutor: { ...s.tutor, [lang]: (s.tutor[lang] ?? []).map((m) => (m.key === key ? { ...m, reply } : m)) } })),
  resetTutor: (lang) => set((s) => ({ tutor: { ...s.tutor, [lang]: [] } })),
  setDeck: (deck) => set({ deck }),
  setEngine: (lastEngine) => set({ lastEngine }),
  setVoice: async (voice) => {
    set({ voice });
    await langApi.setSetting("voice", voice);
  },
}));
