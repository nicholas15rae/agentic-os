import type { Category, LangEntry, Mastery } from "./contract";

export interface LibraryFilter {
  q: string;
  lang: string | null;
  category: Category | null;
  favorites: boolean;
  mastery: Mastery | null;
}

export const EMPTY_FILTER: LibraryFilter = { q: "", lang: null, category: null, favorites: false, mastery: null };

const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/** Search (original, translation, phonetic and note; accent-insensitive) + chip filters. Pure. */
export function filterEntries(entries: LangEntry[], f: LibraryFilter): LangEntry[] {
  const terms = fold(f.q.trim()).split(/\s+/).filter(Boolean);
  return entries.filter((e) => {
    if (f.lang && e.source_lang !== f.lang && e.target_lang !== f.lang) return false;
    if (f.category && e.category !== f.category) return false;
    if (f.favorites && !e.favorite) return false;
    if (f.mastery && e.mastery_status !== f.mastery) return false;
    if (!terms.length) return true;
    const hay = fold(`${e.source_text} ${e.translated_text} ${e.phonetic_guide ?? ""} ${e.context_note ?? ""}`);
    return terms.every((t) => hay.includes(t));
  });
}

/** Languages present in the library (either side), English last since it's on most rows. */
export function libraryLanguages(entries: LangEntry[]): string[] {
  const set = new Set<string>();
  for (const e of entries) {
    for (const l of [e.source_lang, e.target_lang]) if (l && l !== "auto") set.add(l);
  }
  return [...set].sort((a, b) => (a === "en" ? 1 : b === "en" ? -1 : a.localeCompare(b)));
}

/** The foreign (non-English) side of an entry — what a drill shows and what audio speaks. */
export function foreignSide(e: Pick<LangEntry, "source_lang" | "target_lang" | "source_text" | "translated_text">): { lang: string; text: string; english: string } {
  if (e.target_lang !== "en") return { lang: e.target_lang, text: e.translated_text, english: e.source_text };
  return { lang: e.source_lang, text: e.source_text, english: e.translated_text };
}
