/**
 * Language Hub — locked contract (types + IPC/HTTP surface). Self-contained: nothing here is read
 * by Tony, the vault, the RAG stores or the System Map.
 *
 * Storage: ONE SQLite file, `<repo>/data/language-hub/library.db` (gitignored). The desktop opens
 * it through Rust (`commands/language_hub.rs`); the phone reaches the same file through the
 * gateway router `/api/cc/lang/*` (`language_hub_api.py`). Same DDL on both sides.
 *
 * Desktop (Tauri)                     Phone (gateway)
 *   lang_status                        GET    /api/cc/lang/status
 *   lang_library_list                  GET    /api/cc/lang/entries
 *   lang_library_save {entry}          POST   /api/cc/lang/entries
 *   lang_library_update {id, patch}    PATCH  /api/cc/lang/entries/{id}
 *   lang_library_delete {ids}          POST   /api/cc/lang/entries/delete
 *   lang_tracks_list                   GET    /api/cc/lang/tracks
 *   lang_track_save {track}            PUT    /api/cc/lang/tracks/{lang}
 *   lang_stt  (raw WAV, x-lang header) POST   /api/cc/lang/stt?lang=…   (raw WAV body)
 *   lang_tts {text, lang, engine?, voice?, model?}
 *                                      POST   /api/cc/lang/tts           → audio (local engines only)
 *   lang_voice_engines                 GET    /api/cc/lang/voice/engines
 *   tts_voices {engine} (existing)     GET    /api/cc/lang/voice/voices?engine=<provider id>
 *   provider_models {id} (existing)    (desktop only — cloud models)
 *   lang_settings_get/set {key,value}  GET/PUT /api/cc/lang/settings/{key}
 *   lang_llm_json {system, prompt}     POST   /api/cc/lang/llm           (local LM Studio, thinking off)
 *   lang_release                       POST   /api/cc/lang/release
 *
 * STT routing: `en` → the configured Whisper (base.en, Tony's); anything else / auto → an
 * on-demand multilingual whisper-server sidecar on 127.0.0.1:8179, started on first use and
 * stopped on `release` (leaving the Hub) or after 3 idle minutes. TTS: whatever the Voice panel
 * picks (voice.ts resolves it); by default Kokoro, with a voice per language. When the chosen
 * engine can't speak a line it falls back to Kokoro, then the browser's Web Speech voice, and the
 * badge says so.
 */

export type Category = "public_capture" | "my_translation" | "lesson_vocab";
export type Mastery = "new" | "learning" | "mastered";
export type Level = "beginner" | "intermediate" | "conversational";

export const CATEGORIES: { id: Category; label: string }[] = [
  { id: "public_capture", label: "Public capture" },
  { id: "my_translation", label: "My translation" },
  { id: "lesson_vocab", label: "Lesson vocab" },
];
export const MASTERY: { id: Mastery; label: string }[] = [
  { id: "new", label: "New" },
  { id: "learning", label: "Learning" },
  { id: "mastered", label: "Mastered" },
];
export const LEVELS: { id: Level; label: string }[] = [
  { id: "beginner", label: "Beginner" },
  { id: "intermediate", label: "Intermediate" },
  { id: "conversational", label: "Conversational" },
];

/** One archived phrase (the stored record — field names are the on-disk column names). */
export interface LangEntry {
  id: string;
  /** ms since epoch */
  timestamp: number;
  source_lang: string;
  target_lang: string;
  source_text: string;
  translated_text: string;
  phonetic_guide: string | null;
  context_note: string | null;
  category: Category;
  favorite: boolean;
  mastery_status: Mastery;
}

export type NewLangEntry = Omit<LangEntry, "id" | "timestamp" | "favorite" | "mastery_status" | "phonetic_guide" | "context_note"> &
  Partial<Pick<LangEntry, "favorite" | "mastery_status" | "phonetic_guide" | "context_note">>;

/** Editable fields. `context_note: ""` clears the note. */
export type LangEntryPatch = Partial<Pick<LangEntry, "context_note" | "favorite" | "mastery_status" | "translated_text" | "phonetic_guide">>;

/** Per-language tutor progress. */
export interface LangTrack {
  lang: string;
  level: Level;
  got: number;
  again: number;
  lessons: number;
  /** ms since epoch */
  updated: number;
}

export interface SttResult {
  text: string;
  /** What Whisper reported (an ISO code or an English name such as "italian"); null when unknown. */
  language: string | null;
  /** "whisper" (Tony's English model) or "whisper-multilingual" (the sidecar). */
  engine: string;
}

export interface LangStatus {
  dbPath: string;
  entries: number;
  /** The multilingual Whisper model the sidecar would load, or null when none is installed. */
  multilingualModel: string | null;
  sidecarRunning: boolean;
  /** Kokoro reachable as a configured local TTS provider. */
  localTts: boolean;
  llmModel: string | null;
}

/** LLM structured outputs (see prompts.ts for the exact prompts). */
export interface TranslateResult {
  detected_language: string;
  translation: string;
  phonetic: string;
  literal: string;
  notes: string;
}

export interface CoachNote {
  corrections: string;
  better_phrasing: string;
  phonetic_hint: string;
  meaning: string;
}

export interface TutorReply {
  reply: string;
  reply_phonetic: string;
  reply_english: string;
  coach_note: CoachNote;
}

export interface LessonItem {
  english: string;
  target: string;
  phonetic: string;
  note: string;
}

export interface Lesson {
  title: string;
  items: LessonItem[];
}

/** Which voice actually spoke a line (the badge). `fallback`: the chosen engine couldn't. */
export interface SpokeWith {
  label: string;
  fallback: boolean;
  reason?: string;
}

/** "Engine" id for this device's own Web Speech voices. */
export const BROWSER_ENGINE = "browser";

/**
 * The Hub's voice choice (settings key "voice"; shared by desktop and phone). Voices are kept per
 * engine so switching engines and back keeps your picks.
 */
export interface VoicePrefs {
  /** A TTS provider id from providers.json (kokoro, elevenlabs, …) or BROWSER_ENGINE. */
  engine: string;
  /** Cloud model override (ElevenLabs model id); null = the provider's own. */
  model: string | null;
  /** engine id → language code, or "*" for every language → voice id. Missing = automatic. */
  voices: Record<string, Record<string, string>>;
}

/** A TTS provider the Voice panel offers (`lang_voice_engines` / GET /api/cc/lang/voice/engines). */
export interface VoiceEngineInfo {
  id: string;
  label: string;
  engine: string;
  /** false = cloud (ElevenLabs): desktop only, off while the kill switch is on. */
  local: boolean;
  model: string;
  voice: string | null;
}

export interface VoiceOption {
  id: string;
  label: string | null;
}
