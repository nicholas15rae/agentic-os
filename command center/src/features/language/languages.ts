/**
 * The Language Hub's language registry — extend by adding a row. `kokoro` marks languages the
 * local Kokoro voice pack speaks (Rust `kokoro_voice` / gateway `KOKORO_VOICES`); every other
 * language is spoken by the browser's Web Speech voice for `bcp47` (or `speechFallback`).
 */
export interface LangInfo {
  code: string;
  name: string;
  /** Endonym, shown under the name. */
  native: string;
  bcp47: string;
  kokoro: boolean;
  /** Web Speech tag to try when the device has no voice for `bcp47` (Latin → Italian). */
  speechFallback?: string;
  /** Names Whisper may report for it (verbose_json gives full English names). */
  whisper: string[];
}

export const LANGUAGES: LangInfo[] = [
  { code: "en", name: "English", native: "English", bcp47: "en-US", kokoro: true, whisper: ["english"] },
  { code: "it", name: "Italian", native: "Italiano", bcp47: "it-IT", kokoro: true, whisper: ["italian"] },
  { code: "es", name: "Spanish", native: "Español", bcp47: "es-ES", kokoro: true, whisper: ["spanish"] },
  { code: "fr", name: "French", native: "Français", bcp47: "fr-FR", kokoro: true, whisper: ["french"] },
  { code: "la", name: "Latin", native: "Latina", bcp47: "la", kokoro: false, speechFallback: "it-IT", whisper: ["latin"] },
  { code: "ja", name: "Japanese", native: "日本語", bcp47: "ja-JP", kokoro: true, whisper: ["japanese"] },
  { code: "pt", name: "Portuguese", native: "Português", bcp47: "pt-BR", kokoro: true, whisper: ["portuguese"] },
  { code: "de", name: "German", native: "Deutsch", bcp47: "de-DE", kokoro: false, whisper: ["german"] },
  { code: "zh", name: "Chinese (Mandarin)", native: "中文", bcp47: "zh-CN", kokoro: true, whisper: ["chinese", "mandarin"] },
  { code: "ko", name: "Korean", native: "한국어", bcp47: "ko-KR", kokoro: false, whisper: ["korean"] },
  { code: "hi", name: "Hindi", native: "हिन्दी", bcp47: "hi-IN", kokoro: true, whisper: ["hindi"] },
  { code: "ar", name: "Arabic", native: "العربية", bcp47: "ar-SA", kokoro: false, whisper: ["arabic"] },
  { code: "ru", name: "Russian", native: "Русский", bcp47: "ru-RU", kokoro: false, whisper: ["russian"] },
  { code: "el", name: "Greek", native: "Ελληνικά", bcp47: "el-GR", kokoro: false, whisper: ["greek"] },
  { code: "nl", name: "Dutch", native: "Nederlands", bcp47: "nl-NL", kokoro: false, whisper: ["dutch"] },
  { code: "pl", name: "Polish", native: "Polski", bcp47: "pl-PL", kokoro: false, whisper: ["polish"] },
  { code: "tr", name: "Turkish", native: "Türkçe", bcp47: "tr-TR", kokoro: false, whisper: ["turkish"] },
  { code: "vi", name: "Vietnamese", native: "Tiếng Việt", bcp47: "vi-VN", kokoro: false, whisper: ["vietnamese"] },
];

const BY_CODE = new Map(LANGUAGES.map((l) => [l.code, l]));

export const langInfo = (code: string): LangInfo | undefined => BY_CODE.get(code.split("-")[0]?.toLowerCase() ?? "");

export const langName = (code: string | null | undefined): string => {
  if (!code || code === "auto") return "Auto-detect";
  return langInfo(code)?.name ?? code.toUpperCase();
};

/**
 * A language Whisper / the LLM reported ("it", "Italian", "italian", "it-IT") → our code.
 * Unknown but well-formed ISO codes pass through; anything else is null.
 */
export function normalizeLang(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (!s || s === "auto" || s === "unknown") return null;
  for (const l of LANGUAGES) {
    if (l.code === s || l.name.toLowerCase() === s || l.whisper.includes(s) || l.bcp47.toLowerCase() === s) return l.code;
  }
  const base = s.split(/[-_]/)[0];
  if (BY_CODE.has(base)) return base;
  return /^[a-z]{2,3}$/.test(base) ? base : null;
}
