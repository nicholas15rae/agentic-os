import { describe, expect, it } from "vitest";
import type { LangEntry } from "./contract";
import { langName, normalizeLang } from "./languages";
import { EMPTY_FILTER, filterEntries, foreignSide, libraryLanguages } from "./library";
import { lessonPrompt, nextMastery, normalizeLesson, normalizeTranslate, normalizeTutor, translatePrompt, tutorPrompt } from "./prompts";

const entry = (p: Partial<LangEntry>): LangEntry => ({
  id: Math.random().toString(36),
  timestamp: 1,
  source_lang: "it",
  target_lang: "en",
  source_text: "Buongiorno, un caffè per favore",
  translated_text: "Good morning, a coffee please",
  phonetic_guide: "bwon-JOR-no",
  context_note: "Heard at coffee shop",
  category: "public_capture",
  favorite: false,
  mastery_status: "new",
  ...p,
});

describe("language registry", () => {
  it("normalises Whisper and LLM language names to codes", () => {
    expect(normalizeLang("italian")).toBe("it");
    expect(normalizeLang("Italian")).toBe("it");
    expect(normalizeLang("it-IT")).toBe("it");
    expect(normalizeLang("latin")).toBe("la");
    expect(normalizeLang("mandarin")).toBe("zh");
    expect(normalizeLang("sw")).toBe("sw"); // unknown but well-formed passes through
    expect(normalizeLang("auto")).toBeNull();
    expect(normalizeLang("klingon dialect")).toBeNull();
    expect(langName("auto")).toBe("Auto-detect");
    expect(langName("la")).toBe("Latin");
  });
});

describe("prompts", () => {
  it("translate prompt names both languages and asks for JSON", () => {
    const p = translatePrompt("Hello", "en", "it");
    expect(p.system).toContain("English (en)");
    expect(p.system).toContain("Italian (it)");
    expect(p.system).toContain("detected_language");
    expect(translatePrompt("x", "auto", "en").system).toContain("Detect the input language");
    expect(p.system).toContain("pronunciation guide for your Italian translation");
    expect(translatePrompt("x", "auto", "en").system).toContain("for the ORIGINAL input text");
  });

  it("normalises translation output and falls back on the requested source", () => {
    expect(normalizeTranslate({ detected_language: "Italian", translation: " Hi ", phonetic: "x" }, "auto")).toEqual({ detected_language: "it", translation: "Hi", phonetic: "x", literal: "", notes: "" });
    expect(normalizeTranslate({ translation: "Ciao" }, "en").detected_language).toBe("en");
    expect(() => normalizeTranslate({ phonetic: "x" }, "en")).toThrow();
  });

  it("tutor prompt keeps the last turns and the level", () => {
    const hist = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? ("tutor" as const) : ("user" as const), text: `t${i}` }));
    const p = tutorPrompt("ja", "beginner", hist, "konnichiwa");
    expect(p.prompt).not.toContain("t3");
    expect(p.prompt).toContain("t11");
    expect(p.system).toContain("Japanese");
    expect(p.system).toContain("beginner");
    const r = normalizeTutor({ reply: "こんにちは", coach_note: { corrections: "Looks good!" } });
    expect(r.coach_note.corrections).toBe("Looks good!");
    expect(r.coach_note.meaning).toBe("");
    expect(() => normalizeTutor({})).toThrow();
  });

  it("library lessons quote the saved phrases", () => {
    const p = lessonPrompt("it", "beginner", "library", "", [entry({})]);
    expect(p.prompt).toContain("Buongiorno");
    const l = normalizeLesson({ title: "Café", items: [{ english: "Coffee", target: "Caffè" }, { english: "" }] });
    expect(l.items).toHaveLength(1);
    expect(() => normalizeLesson({ items: [] })).toThrow();
  });

  it("flashcard mastery steps", () => {
    expect(nextMastery("new", true)).toBe("learning");
    expect(nextMastery("learning", true)).toBe("mastered");
    expect(nextMastery("mastered", false)).toBe("learning");
  });
});

describe("library filter", () => {
  const rows = [
    entry({ id: "a" }),
    entry({ id: "b", source_lang: "en", target_lang: "la", source_text: "I came, I saw", translated_text: "Veni, vidi", category: "my_translation", favorite: true, context_note: null }),
    entry({ id: "c", source_lang: "en", target_lang: "ja", source_text: "Thank you", translated_text: "ありがとう", category: "lesson_vocab", mastery_status: "mastered", context_note: null }),
  ];
  const ids = (f: Partial<typeof EMPTY_FILTER>) => filterEntries(rows, { ...EMPTY_FILTER, ...f }).map((e) => e.id);

  it("searches both sides accent-insensitively", () => {
    expect(ids({ q: "caffe" })).toEqual(["a"]);
    expect(ids({ q: "vidi saw" })).toEqual(["b"]);
    expect(ids({ q: "coffee shop" })).toEqual(["a"]); // the note counts too
  });

  it("applies chips", () => {
    expect(ids({ lang: "la" })).toEqual(["b"]);
    expect(ids({ category: "lesson_vocab" })).toEqual(["c"]);
    expect(ids({ favorites: true })).toEqual(["b"]);
    expect(ids({ mastery: "new" })).toEqual(["a", "b"]);
  });

  it("lists languages and picks the foreign side", () => {
    expect(libraryLanguages(rows)).toEqual(["it", "ja", "la", "en"]);
    expect(foreignSide(rows[0]).lang).toBe("it");
    expect(foreignSide(rows[1])).toEqual({ lang: "la", text: "Veni, vidi", english: "I came, I saw" });
  });
});
