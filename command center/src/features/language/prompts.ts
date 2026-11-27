/**
 * Structured prompts for the local LLM (LM Studio) and the normalisers that turn whatever JSON
 * it returns into the contract's shapes. Pure — unit-tested in prompts.test.ts.
 */
import type { CoachNote, LangEntry, Lesson, LessonItem, Level, TranslateResult, TutorReply } from "./contract";
import { langName, normalizeLang } from "./languages";

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const JSON_ONLY = "Respond with ONLY one JSON object — no markdown, no commentary.";
const PHONETIC_RULE =
  "Phonetic guides are for an English speaker: simple English-like syllables separated by hyphens, the stressed syllable in CAPITALS (e.g. Buongiorno → bwon-JOR-no). For Latin use classical pronunciation. For Japanese/Chinese give romaji/pinyin with the guide.";

export function translatePrompt(text: string, from: string, to: string): { system: string; prompt: string } {
  const src = from === "auto" ? "Detect the input language yourself" : `The input is ${langName(from)} (${from})`;
  // Say exactly which text gets the guide: a small model leaves an abstract rule empty.
  const phonetic =
    to !== "en"
      ? `REQUIRED: pronunciation guide for your ${langName(to)} translation`
      : from === "en"
        ? "empty string"
        : "REQUIRED unless the input is English: pronunciation guide for the ORIGINAL input text";
  return {
    system: [
      "You are a precise, natural-sounding translator.",
      `${src}. Translate it into ${langName(to)} (${to}).`,
      "Keep the speaker's tone and register; prefer what a native speaker would actually say.",
      "The input may come from speech recognition and contain misheard words: translate what the speaker most plausibly meant, and never invent explanations or slang meanings for odd words.",
      PHONETIC_RULE,
      JSON_ONLY,
      `Shape: {"detected_language": "<ISO 639-1 code of the INPUT>", "translation": "<natural translation>", "phonetic": "<${phonetic}>", "literal": "<word-by-word gloss of the input when it differs meaningfully from the natural translation, else empty>", "notes": "<one short usage or cultural note, or empty>"}`,
    ].join("\n"),
    prompt: text.slice(0, 4000),
  };
}

export function normalizeTranslate(raw: unknown, from: string): TranslateResult {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const translation = str(o.translation) || str(o.translated_text) || str(o.text);
  if (!translation) throw new Error("The model returned no translation");
  return {
    detected_language: normalizeLang(str(o.detected_language) || str(o.language)) ?? (from === "auto" ? "auto" : from),
    translation,
    phonetic: str(o.phonetic) || str(o.pronunciation),
    literal: str(o.literal),
    notes: str(o.notes),
  };
}

export interface TutorTurn {
  role: "user" | "tutor";
  text: string;
}

const LEVEL_STYLE: Record<Level, string> = {
  beginner: "Use short, simple sentences and the most common words. Be encouraging.",
  intermediate: "Use everyday sentences with some variety; introduce one new useful word or structure per reply.",
  conversational: "Talk like a friendly native speaker at natural speed and idiom.",
};

export function tutorPrompt(lang: string, level: Level, history: TutorTurn[], userText: string): { system: string; prompt: string } {
  const name = langName(lang);
  const recent = history
    .slice(-8)
    .map((t) => `${t.role === "user" ? "Learner" : "Tutor"}: ${t.text}`)
    .join("\n");
  return {
    system: [
      `You are a warm ${name} conversation coach. The learner is at ${level} level. ${LEVEL_STYLE[level]}`,
      `Always reply IN ${name} to keep the conversation going (1–3 sentences, end with a question when natural).`,
      "The learner may write in English or in imperfect " + name + ". Coach them on THEIR last message.",
      PHONETIC_RULE,
      JSON_ONLY,
      `Shape: {"reply": "<your reply in ${name}>", "reply_phonetic": "<phonetic guide for your reply>", "reply_english": "<English meaning of your reply>", "coach_note": {"corrections": "<grammar/spelling fixes to the learner's message, or 'Looks good!'>", "better_phrasing": "<how a native would say what the learner meant, in ${name}>", "phonetic_hint": "<pronunciation tip for the better phrasing>", "meaning": "<English meaning of the learner's message>"}}`,
    ].join("\n"),
    prompt: `${recent ? `Conversation so far:\n${recent}\n\n` : ""}Learner's new message: ${userText.slice(0, 2000)}`,
  };
}

export function normalizeTutor(raw: unknown): TutorReply {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const reply = str(o.reply);
  if (!reply) throw new Error("The tutor returned no reply");
  const c = (o.coach_note && typeof o.coach_note === "object" ? o.coach_note : {}) as Record<string, unknown>;
  const coach: CoachNote = { corrections: str(c.corrections), better_phrasing: str(c.better_phrasing), phonetic_hint: str(c.phonetic_hint), meaning: str(c.meaning) };
  return { reply, reply_phonetic: str(o.reply_phonetic), reply_english: str(o.reply_english), coach_note: coach };
}

export type LessonKind = "phrases" | "scenario" | "grammar" | "library";

export const LESSON_KINDS: { id: LessonKind; label: string; hint: string }[] = [
  { id: "phrases", label: "Common phrases", hint: "everyday essentials" },
  { id: "scenario", label: "Real-world scenario", hint: "café, train, directions…" },
  { id: "grammar", label: "Grammar pattern", hint: "one pattern, many examples" },
  { id: "library", label: "From my Library", hint: "drill what you saved" },
];

export function lessonPrompt(lang: string, level: Level, kind: LessonKind, topic: string, saved: Pick<LangEntry, "source_text" | "translated_text">[] = []): { system: string; prompt: string } {
  const name = langName(lang);
  const focus =
    kind === "library"
      ? `Build the drill around these phrases the learner saved (reuse them, add close variations):\n${saved
          .slice(0, 12)
          .map((s) => `- ${s.source_text} = ${s.translated_text}`)
          .join("\n")}`
      : kind === "scenario"
        ? `Scenario: ${topic || "ordering at a café"}. Give the phrases someone actually needs there.`
        : kind === "grammar"
          ? `Grammar pattern: ${topic || "the most useful beginner pattern for this level"}. Each item shows the pattern in use.`
          : `Theme: ${topic || "greetings and everyday essentials"}.`;
  return {
    system: [
      `You write bite-sized ${name} lessons for an English speaker at ${level} level. ${LEVEL_STYLE[level]}`,
      PHONETIC_RULE,
      JSON_ONLY,
      `Shape: {"title": "<short lesson title>", "items": [{"english": "<English>", "target": "<${name}>", "phonetic": "<guide>", "note": "<one-line tip or empty>"}]} with 6 to 8 items.`,
    ].join("\n"),
    prompt: focus,
  };
}

export function normalizeLesson(raw: unknown): Lesson {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const items: LessonItem[] = (Array.isArray(o.items) ? o.items : [])
    .map((x) => {
      const i = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
      return { english: str(i.english), target: str(i.target) || str(i.translation), phonetic: str(i.phonetic), note: str(i.note) };
    })
    .filter((i) => i.english && i.target)
    .slice(0, 12);
  if (!items.length) throw new Error("The lesson came back empty");
  return { title: str(o.title) || "Lesson", items };
}

/** Next mastery after a flashcard answer. */
export function nextMastery(current: LangEntry["mastery_status"], gotIt: boolean): LangEntry["mastery_status"] {
  if (!gotIt) return "learning";
  return current === "new" ? "learning" : "mastered";
}
