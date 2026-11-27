/**
 * Which engine, voice and model speak a line in a given language — from the Voice panel's
 * choice (VoicePrefs). Pure; unit-tested in voice.test.ts.
 */
import { BROWSER_ENGINE, type VoiceEngineInfo, type VoiceOption, type VoicePrefs } from "./contract";
import { langInfo } from "./languages";

export const DEFAULT_ENGINE = "kokoro";

export function defaultVoicePrefs(engines: VoiceEngineInfo[] = []): VoicePrefs {
  const kokoro = engines.find((e) => e.engine === "kokoro") ?? engines.find((e) => e.local);
  return { engine: kokoro?.id ?? (engines.length ? BROWSER_ENGINE : DEFAULT_ENGINE), model: null, voices: {} };
}

/** A stored value → VoicePrefs (anything malformed falls back to the defaults). */
export function normalizeVoicePrefs(raw: unknown, engines: VoiceEngineInfo[] = []): VoicePrefs {
  const d = defaultVoicePrefs(engines);
  if (!raw || typeof raw !== "object") return d;
  const o = raw as Record<string, unknown>;
  const voices: VoicePrefs["voices"] = {};
  if (o.voices && typeof o.voices === "object") {
    for (const [eng, map] of Object.entries(o.voices as Record<string, unknown>)) {
      if (!map || typeof map !== "object") continue;
      const m: Record<string, string> = {};
      for (const [lang, v] of Object.entries(map as Record<string, unknown>)) if (typeof v === "string" && v) m[lang] = v;
      voices[eng] = m;
    }
  }
  return { engine: typeof o.engine === "string" && o.engine ? o.engine : d.engine, model: typeof o.model === "string" && o.model ? o.model : null, voices };
}

/** Kokoro voice ids start with a language letter (af_heart → American English, if_sara → Italian). */
const KOKORO_PREFIX: Record<string, string> = { a: "en", b: "en", e: "es", f: "fr", h: "hi", i: "it", j: "ja", p: "pt", z: "zh" };

export const kokoroVoiceLang = (id: string): string | null => (/^[a-z][fm]_/.test(id) ? (KOKORO_PREFIX[id[0]] ?? null) : null);

/** Voices that can speak `lang` on this engine. Kokoro voices are language-bound; others aren't. */
export function voicesForLang(engine: VoiceEngineInfo | undefined, voices: VoiceOption[], lang: string): VoiceOption[] {
  if (engine?.engine !== "kokoro") return voices;
  const base = lang.split("-")[0];
  return voices.filter((v) => kokoroVoiceLang(v.id) === base);
}

export interface VoicePlan {
  /** Provider id, or BROWSER_ENGINE. */
  engine: string;
  kind: "server" | "browser";
  voice: string | null;
  model: string | null;
  label: string;
}

/**
 * The plan for one line. A per-language pick beats the "*" default. On Kokoro a "*" voice only
 * applies to its own language (an Italian voice reading Japanese is gibberish), otherwise the
 * engine picks per language. An engine that no longer exists falls back to Kokoro (or the browser).
 */
export function resolveVoice(prefs: VoicePrefs, lang: string, engines: VoiceEngineInfo[]): VoicePlan {
  const base = lang.split("-")[0];
  let engineId = prefs.engine;
  let info = engines.find((e) => e.id === engineId);
  if (engineId !== BROWSER_ENGINE && !info && engines.length) {
    info = engines.find((e) => e.engine === "kokoro") ?? engines.find((e) => e.local);
    engineId = info?.id ?? BROWSER_ENGINE;
  }
  const picks = prefs.voices[engineId] ?? {};
  if (engineId === BROWSER_ENGINE) {
    return { engine: BROWSER_ENGINE, kind: "browser", voice: picks[base] ?? picks["*"] ?? null, model: null, label: "Browser voice" };
  }
  let voice = picks[base] ?? null;
  if (!voice && picks["*"]) {
    const star = picks["*"];
    const bound = info?.engine === "kokoro" ? kokoroVoiceLang(star) : null;
    if (!bound || bound === base) voice = star;
  }
  return { engine: engineId, kind: "server", voice, model: info && !info.local ? prefs.model : null, label: info?.label ?? engineId };
}

/** Whether Kokoro (the fallback) can speak this language with its automatic voice. */
export const kokoroSpeaks = (lang: string): boolean => langInfo(lang)?.kokoro ?? false;
