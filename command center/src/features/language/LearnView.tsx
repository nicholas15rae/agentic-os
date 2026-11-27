import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Eye, GraduationCap, Layers, Loader2, RotateCcw, Send, Sparkles, ThumbsUp } from "lucide-react";
import { Chip, Input } from "@/components/ui";
import { Segmented } from "@/components/segmented";
import type { LangEntry, Lesson, Level, TutorReply } from "./contract";
import { LEVELS } from "./contract";
import { langApi } from "./api";
import { speak, useRecorder } from "./audio";
import { langName } from "./languages";
import { foreignSide } from "./library";
import { lessonPrompt, LESSON_KINDS, nextMastery, normalizeLesson, normalizeTutor, tutorPrompt, type LessonKind } from "./prompts";
import { LangSelect, PlayButton, RecordButton, SaveButton, toastError } from "./parts";
import { newKey, useHub, type DrillCard, type TutorMsg } from "./store";

type Tool = "coach" | "drills";

export function LearnView({ compact = false }: { compact?: boolean }) {
  const lang = useHub((s) => s.trackLang);
  const setPrefs = useHub((s) => s.setPrefs);
  const tracks = useHub((s) => s.tracks);
  const track = useHub((s) => s.track)(lang);
  const bumpTrack = useHub((s) => s.bumpTrack);
  const deck = useHub((s) => s.deck);
  const [tool, setTool] = useState<Tool>("coach");
  // "Send to Practice Drill" from the Library lands here with a fresh deck.
  useEffect(() => {
    if (deck.length) setTool("drills");
  }, [deck]);
  const known = useMemo(() => [...new Set([lang, ...Object.keys(tracks)])].filter((l) => l !== "en"), [lang, tracks]);

  return (
    <div className="space-y-3">
      <section className="glass space-y-3 r-20 p-3 md:p-4" aria-label="Language track">
        <div className="flex flex-wrap items-center gap-2">
          <GraduationCap size={16} className="text-amber-light" />
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Your tracks">
            {known.map((l) => (
              <Chip key={l} active={l === lang} onClick={() => setPrefs({ trackLang: l })}>
                {langName(l)}
              </Chip>
            ))}
          </div>
          <LangSelect value={lang} onChange={(v) => v !== "en" && setPrefs({ trackLang: v })} label="Practice language" className="!w-44 ml-auto" />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Segmented<Level> label="Level" value={track.level} options={LEVELS.map((l) => ({ id: l.id, label: l.label }))} onChange={(level) => bumpTrack(lang, { level })} size="sm" />
          <span className="font-mono fs-11 text-ink-3">
            {track.got} got it · {track.again} review · {track.lessons} lessons
          </span>
        </div>
      </section>

      <Segmented<Tool>
        label="Practice tool"
        value={tool}
        options={[
          { id: "coach", label: "Conversational coach", tone: "amber" },
          { id: "drills", label: "Drills & flashcards", tone: "teal" },
        ]}
        onChange={setTool}
      />

      {tool === "coach" ? <Coach lang={lang} level={track.level} compact={compact} /> : <Drills lang={lang} level={track.level} />}
    </div>
  );
}

// ── Conversational coach ────────────────────────────────────────────────────

function Coach({ lang, level, compact }: { lang: string; level: Level; compact: boolean }) {
  const msgs = useHub((s) => s.tutor[lang]) ?? [];
  const { pushTutor, patchTutor, resetTutor } = useHub();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const heardRef = useRef<(wav: Uint8Array | null) => Promise<unknown>>(async () => undefined);
  const rec = useRecorder((wav) => void heardRef.current(wav)); // the 90 s cap still sends what was said
  const end = useRef<HTMLDivElement>(null);
  // Braces matter: newer Chromium's scrollIntoView() returns a Promise, which React would take as a cleanup.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [msgs.length]);

  const send = async (said: string) => {
    const t = said.trim();
    if (!t) return;
    const hist = useHub.getState().tutor[lang] ?? [];
    pushTutor(lang, { role: "user", text: t });
    const userKey = (useHub.getState().tutor[lang] ?? []).at(-1)?.key;
    setBusy(true);
    try {
      const { system, prompt } = tutorPrompt(lang, level, hist, t);
      const r = normalizeTutor(await langApi.llmJson(system, prompt));
      if (userKey) patchTutor(lang, userKey, r); // the coach note belongs to the learner's line
      pushTutor(lang, { role: "tutor", text: r.reply, reply: r });
      if (useHub.getState().autoSpeak) void speak(r.reply, lang).then(useHub.getState().setEngine);
    } catch (e) {
      toastError("Tutor", e);
    } finally {
      setBusy(false);
    }
  };

  const stopAndSend = async () => heard(await rec.stop());

  const heard = async (wav: Uint8Array | null) => {
    if (!wav) return;
    setBusy(true);
    try {
      // The learner may answer in English or the target language: let Whisper detect it.
      const stt = await langApi.stt(wav, "auto");
      setBusy(false);
      if (stt.text) await send(stt.text);
    } catch (e) {
      setBusy(false);
      // No multilingual Whisper yet: fall back to English-only dictation.
      if (/LANG_STT_NO_MULTILINGUAL/.test(String(e))) {
        try {
          const stt = await langApi.stt(wav, "en");
          if (stt.text) await send(stt.text);
          return;
        } catch (e2) {
          return toastError("Speech", e2);
        }
      }
      toastError("Speech", e);
    }
  };
  heardRef.current = heard;

  return (
    <section className="glass flex flex-col r-20 p-3 md:p-4" aria-label="Conversational coach">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="label-caps text-amber-soft">Coach · {langName(lang)}</h2>
        {msgs.length > 0 && (
          <button type="button" onClick={() => resetTutor(lang)} className="pill-glass ml-auto !h-8 text-xs">
            <RotateCcw size={12} /> New conversation
          </button>
        )}
      </div>
      <div className={`space-y-2 overflow-y-auto ${compact ? "max-h-[50dvh]" : "max-h-[55vh]"}`}>
        {msgs.length === 0 && (
          <p className="p-4 text-center text-sm text-ink-3">
            Say or type anything — in {langName(lang)} or English. The coach answers in {langName(lang)} and notes how to say yours better.
          </p>
        )}
        {msgs.map((m) => (m.role === "user" ? <LearnerLine key={m.key} m={m} lang={lang} /> : <TutorLine key={m.key} m={m} lang={lang} />))}
        {busy && (
          <p role="status" className="flex items-center gap-2 px-1 fs-13 text-ink-3">
            <Loader2 size={13} className="animate-spin" /> Coach is thinking…
          </p>
        )}
        <div ref={end} />
      </div>
      <form
        className="mt-3 flex items-stretch gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (busy) return;
          const t = text;
          setText("");
          void send(t);
        }}
      >
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={`Reply in ${langName(lang)} or English…`} aria-label="Your reply" className="!h-11 min-w-0 flex-1" />
        <button type="submit" disabled={busy || !text.trim()} aria-label="Send" className="pill-primary !h-11 !w-11 !p-0 disabled:opacity-40">
          <Send size={16} />
        </button>
      </form>
      <div className="mt-2">
        <RecordButton
          label="Speak your reply"
          recording={rec.state !== "idle"}
          busy={busy}
          level={rec.level}
          onStart={() => void rec.start().catch((e) => toastError("Microphone", e))}
          onStop={() => void stopAndSend()}
        />
      </div>
    </section>
  );
}

function LearnerLine({ m, lang }: { m: TutorMsg; lang: string }) {
  const [open, setOpen] = useState(false);
  const saveEntry = useHub((s) => s.saveEntry);
  const [saved, setSaved] = useState(false);
  const note = m.reply?.coach_note;
  return (
    <div className="ml-auto max-w-[88%] r-16 rounded-br-[6px] bg-amber/10 p-3">
      <p className="fs-14 text-ink">{m.text}</p>
      {note && (
        <div className="mt-1.5">
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex items-center gap-1 fs-11 font-semibold uppercase tracking-wider text-amber-light">
            Coach note <ChevronDown size={12} className={`transition-transform ${open ? "rotate-180" : ""}`} />
          </button>
          {open && (
            <dl className="mt-1.5 space-y-1 fs-12.5 text-ink-2">
              {note.corrections && <Row k="Corrections" v={note.corrections} />}
              {note.better_phrasing && (
                <div className="flex items-start gap-2">
                  <Row k="More natural" v={note.better_phrasing} />
                  <PlayButton text={note.better_phrasing} lang={lang} size={12} label="Play natural phrasing" />
                  <SaveButton
                    saved={saved}
                    onSave={async () => {
                      await saveEntry({ source_lang: "en", target_lang: lang, source_text: note.meaning || m.text, translated_text: note.better_phrasing, phonetic_guide: note.phonetic_hint || null, context_note: "Coach correction", category: "lesson_vocab" });
                      setSaved(true);
                    }}
                  />
                </div>
              )}
              {note.phonetic_hint && <Row k="Say it" v={note.phonetic_hint} mono />}
              {note.meaning && <Row k="Meaning" v={note.meaning} />}
            </dl>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="min-w-0 flex-1">
      <dt className="inline font-semibold text-ink-3">{k}: </dt>
      <dd className={`inline ${mono ? "font-mono text-amber-soft" : ""}`}>{v}</dd>
    </div>
  );
}

function TutorLine({ m, lang }: { m: TutorMsg; lang: string }) {
  const r = m.reply as TutorReply;
  const [showEn, setShowEn] = useState(false);
  const [saved, setSaved] = useState(false);
  const saveEntry = useHub((s) => s.saveEntry);
  return (
    <div className="max-w-[92%] r-16 rounded-bl-[6px] border border-white/[0.06] bg-white/[0.03] p-3">
      <p className="fs-15 font-medium leading-snug text-ink">{r.reply}</p>
      {r.reply_phonetic && <p className="mt-0.5 font-mono fs-12 text-amber-soft">{r.reply_phonetic}</p>}
      {showEn && r.reply_english && <p className="mt-1 fs-13 text-ink-2">{r.reply_english}</p>}
      <div className="mt-2 flex items-center gap-1.5">
        <PlayButton text={r.reply} lang={lang} />
        <button type="button" onClick={() => setShowEn((s) => !s)} aria-pressed={showEn} className="pill-glass !h-8 text-xs" title="Show the English meaning">
          <Eye size={12} /> EN
        </button>
        <SaveButton
          saved={saved}
          onSave={async () => {
            await saveEntry({ source_lang: "en", target_lang: lang, source_text: r.reply_english || r.reply, translated_text: r.reply, phonetic_guide: r.reply_phonetic || null, context_note: "From the coach", category: "lesson_vocab" });
            setSaved(true);
          }}
        />
      </div>
    </div>
  );
}

// ── Drills & flashcards ─────────────────────────────────────────────────────

function Drills({ lang, level }: { lang: string; level: Level }) {
  const library = useHub((s) => s.library);
  const deck = useHub((s) => s.deck);
  const { setDeck, saveEntry, bumpTrack } = useHub();
  const [kind, setKind] = useState<LessonKind>("phrases");
  const [topic, setTopic] = useState("");
  const [lesson, setLesson] = useState<Lesson | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedIdx, setSavedIdx] = useState<Set<number>>(new Set());
  const saved = useMemo(() => library.filter((e) => e.source_lang === lang || e.target_lang === lang), [library, lang]);

  const generate = async () => {
    setBusy(true);
    try {
      const pool = [...saved].sort((a, b) => (a.mastery_status === "mastered" ? 1 : 0) - (b.mastery_status === "mastered" ? 1 : 0)).map(foreignSide).map((f) => ({ source_text: f.english, translated_text: f.text }));
      const { system, prompt } = lessonPrompt(lang, level, kind, topic, pool);
      setLesson(normalizeLesson(await langApi.llmJson(system, prompt)));
      setSavedIdx(new Set());
      bumpTrack(lang, { lessons: 1 });
    } catch (e) {
      toastError("Lesson", e);
    } finally {
      setBusy(false);
    }
  };

  const libraryDeck = (entries: LangEntry[]): DrillCard[] =>
    entries.map((e) => {
      const f = foreignSide(e);
      return { key: newKey("d"), english: f.english, target: f.text, phonetic: e.phonetic_guide ?? "", lang: f.lang, entryId: e.id };
    });

  if (deck.length) return <Flashcards cards={deck} onDone={() => setDeck([])} />;

  return (
    <section className="glass space-y-3 r-20 p-3 md:p-4" aria-label="Drills">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Lesson type">
        {LESSON_KINDS.map((k) => (
          <Chip key={k.id} active={kind === k.id} onClick={() => setKind(k.id)} tone={k.id === "library" ? "teal" : "amber"}>
            {k.label}
          </Chip>
        ))}
      </div>
      {kind !== "library" ? (
        <Input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder={LESSON_KINDS.find((k) => k.id === kind)?.hint} aria-label="Lesson topic" className="!h-10" />
      ) : (
        <p className="fs-12 text-ink-3">{saved.length ? `${saved.length} saved ${langName(lang)} phrase${saved.length === 1 ? "" : "s"} to build from.` : `Nothing saved in ${langName(lang)} yet — save phrases from Translate or the coach first.`}</p>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => void generate()} disabled={busy || (kind === "library" && !saved.length)} className="pill-primary !h-10 text-sm disabled:opacity-40">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} Generate lesson
        </button>
        {saved.length > 0 && (
          <button type="button" onClick={() => setDeck(libraryDeck(saved.filter((e) => e.mastery_status !== "mastered").slice(0, 20)))} className="pill-glass !h-10 text-sm">
            <Layers size={14} /> Flashcards from Library
          </button>
        )}
      </div>

      {lesson && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <h3 className="fs-15 font-semibold text-ink">{lesson.title}</h3>
            <button
              type="button"
              className="pill-glass ml-auto !h-8 text-xs"
              onClick={() => setDeck(lesson.items.map((i) => ({ key: newKey("d"), english: i.english, target: i.target, phonetic: i.phonetic, lang })))}
            >
              <Layers size={12} /> Recall mode
            </button>
          </div>
          <ul className="space-y-1.5">
            {lesson.items.map((i, n) => (
              <li key={n} className="flex items-start gap-2 r-14 border border-white/[0.06] bg-white/[0.02] p-2.5">
                <div className="min-w-0 flex-1">
                  <p className="fs-15 font-medium text-ink">{i.target}</p>
                  {i.phonetic && <p className="font-mono fs-11.5 text-amber-soft">{i.phonetic}</p>}
                  <p className="fs-12.5 text-ink-2">{i.english}</p>
                  {i.note && <p className="fs-11.5 text-ink-3">{i.note}</p>}
                </div>
                <PlayButton text={i.target} lang={lang} />
                <SaveButton
                  saved={savedIdx.has(n)}
                  onSave={async () => {
                    await saveEntry({ source_lang: "en", target_lang: lang, source_text: i.english, translated_text: i.target, phonetic_guide: i.phonetic || null, context_note: lesson.title, category: "lesson_vocab" });
                    setSavedIdx((s) => new Set(s).add(n));
                  }}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Flashcards({ cards, onDone }: { cards: DrillCard[]; onDone: () => void }) {
  const { updateEntry, bumpTrack, library } = useHub();
  const [i, setI] = useState(0);
  const [shown, setShown] = useState(false);
  const [queue, setQueue] = useState(cards);
  const [stats, setStats] = useState({ got: 0, again: 0 });
  useEffect(() => {
    setQueue(cards);
    setI(0);
    setShown(false);
  }, [cards]);
  const card = queue[i];

  if (!card) {
    return (
      <section className="glass space-y-3 r-20 p-5 text-center" aria-label="Flashcards done">
        <p className="text-lg font-semibold text-ink">Deck done</p>
        <p className="text-sm text-ink-2">
          {stats.got} got it · {stats.again} to review again
        </p>
        <button type="button" onClick={onDone} className="pill-primary mx-auto !h-10 text-sm">
          Back to drills
        </button>
      </section>
    );
  }

  const answer = async (got: boolean) => {
    setStats((s) => (got ? { ...s, got: s.got + 1 } : { ...s, again: s.again + 1 }));
    bumpTrack(card.lang, got ? { got: 1 } : { again: 1 });
    if (card.entryId) {
      const e = library.find((x) => x.id === card.entryId);
      if (e) void updateEntry(e.id, { mastery_status: nextMastery(e.mastery_status, got) }).catch((err) => toastError("Couldn't update mastery", err));
    }
    // "Review again" puts the card back at the end of this session's deck.
    if (!got) setQueue((q) => [...q, { ...card, key: newKey("d") }]);
    setShown(false);
    setI((n) => n + 1);
  };

  return (
    <section className="glass space-y-4 r-20 p-4 md:p-6" aria-label="Flashcards">
      <div className="flex items-center gap-2 fs-12 text-ink-3">
        <span className="font-mono">
          {i + 1} / {queue.length}
        </span>
        <span>{langName(card.lang)}</span>
        <button type="button" onClick={onDone} className="pill-glass ml-auto !h-8 text-xs">
          End
        </button>
      </div>
      <div className="grid min-h-40 place-items-center r-18 border border-white/[0.06] bg-white/[0.02] p-5 text-center">
        <div className="space-y-2">
          <p className="fs-13 uppercase tracking-wider text-ink-3">How do you say</p>
          <p className="text-xl font-semibold text-ink">{card.english}</p>
          {shown && (
            <div className="space-y-1 pt-2">
              <p className="text-2xl font-semibold text-amber-light">{card.target}</p>
              {card.phonetic && <p className="font-mono fs-13 text-amber-soft">{card.phonetic}</p>}
            </div>
          )}
        </div>
      </div>
      {!shown ? (
        <button
          type="button"
          onClick={() => {
            setShown(true);
            void speak(card.target, card.lang).then(useHub.getState().setEngine);
          }}
          className="pill-primary !h-12 w-full fs-15"
        >
          <Eye size={16} /> Reveal &amp; play
        </button>
      ) : (
        <div className="grid grid-cols-[auto_1fr_1fr] gap-2">
          <PlayButton text={card.target} lang={card.lang} />
          <button type="button" onClick={() => void answer(false)} className="pill-glass !h-12 fs-14">
            <RotateCcw size={15} /> Review again
          </button>
          <button type="button" onClick={() => void answer(true)} className="pill-primary !h-12 fs-14">
            <ThumbsUp size={15} /> Got it
          </button>
        </div>
      )}
    </section>
  );
}
