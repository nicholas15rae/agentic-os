import { useRef, useState } from "react";
import { ArrowLeftRight, Ear, Loader2, Trash2 } from "lucide-react";
import { Chip } from "@/components/ui";
import { requestMicEnabled } from "@/features/voice/mic-gate";
import { langApi } from "./api";
import { speak } from "./audio";
import { useRecorder } from "./audio";
import { langName, normalizeLang } from "./languages";
import { normalizeTranslate, translatePrompt } from "./prompts";
import { CopyButton, LangSelect, PlayButton, RecordButton, SaveButton, toastError } from "./parts";
import { useHub, type FeedItem } from "./store";

type Flow = "speak" | "listen";
type Phase = "transcribing" | "translating" | null;

async function runTranslate(text: string, from: string, to: string) {
  const { system, prompt } = translatePrompt(text, from, to);
  return normalizeTranslate(await langApi.llmJson(system, prompt), from);
}

/**
 * Translate `text` and put it in the session feed (auto-save / auto-speak per the toggles).
 * Already in the destination language? Redirect instead of echoing it back: English goes to
 * your target language, anything in the destination goes to English. Toward English = "in"
 * (a capture); away from English = "out" (my translation).
 */
async function translateInto(text: string, from: string, to: string, via: FeedItem["via"]): Promise<FeedItem> {
  const hub = useHub.getState();
  let r = await runTranslate(text, from, to);
  if (r.detected_language === to) {
    const target = hub.target === "en" ? "it" : hub.target;
    to = to === "en" ? target : "en";
    r = await runTranslate(text, r.detected_language, to);
  }
  const dir: FeedItem["dir"] = to === "en" ? "in" : "out";
  const item = hub.addFeed({
    dir,
    source_lang: r.detected_language === "auto" ? from : r.detected_language,
    target_lang: to,
    source_text: text,
    translated_text: r.translation,
    phonetic: r.phonetic,
    literal: r.literal,
    notes: r.notes,
    category: dir === "in" ? "public_capture" : "my_translation",
    via,
  });
  const s = useHub.getState();
  if (dir === "in" && s.autoSave) void s.saveFeed(item.key).catch((e) => toastError("Auto-save failed", e));
  if (dir === "out" && s.autoSpeak) void speak(r.translation, to).then(s.setEngine);
  return item;
}

export function TranslateView({ compact = false }: { compact?: boolean }) {
  const { source, target, autoSave, autoSpeak, setPrefs, swap, feed, clearUnsaved, status } = useHub();
  // A recording the 90 s cap ended still gets transcribed (finish is re-bound every render).
  const finishRef = useRef<(wav: Uint8Array | null) => Promise<void>>(async () => undefined);
  const rec = useRecorder((wav) => void finishRef.current(wav));
  const [flow, setFlow] = useState<Flow | null>(null);
  const [phase, setPhase] = useState<Phase>(null);
  const [text, setText] = useState("");
  const [heard, setHeard] = useState<string | null>(null);
  const [micLocked, setMicLocked] = useState(false);
  const busy = phase !== null;
  const targetName = langName(target);
  const unsaved = feed.filter((f) => !f.savedId).length;

  const startRec = async (f: Flow) => {
    setFlow(f);
    setHeard(null);
    try {
      await rec.start();
      setMicLocked(false);
    } catch (e) {
      setFlow(null);
      if (e instanceof Error && /locked/i.test(e.message)) setMicLocked(true);
      else toastError("Microphone", e);
    }
  };

  const stopRec = async () => finish(await rec.stop());

  const finish = async (wav: Uint8Array | null) => {
    const f = flow;
    if (!wav || !f) {
      setFlow(null);
      if (f) toastError("Nothing recorded", "Hold the phone closer and try again.");
      return;
    }
    try {
      setPhase("transcribing");
      // "Speak English" pins Whisper to English (Tony's model, fast); "Listen" auto-detects or uses the chosen source.
      const sttLang = f === "speak" ? "en" : source === "en" ? "auto" : source;
      const stt = await langApi.stt(wav, sttLang);
      if (!stt.text) throw new Error("Didn't catch any speech — try again a little closer.");
      setHeard(stt.text);
      setPhase("translating");
      const detected = normalizeLang(stt.language) ?? (sttLang === "auto" ? "auto" : sttLang);
      if (f === "speak" || detected === "en") await translateInto(stt.text, "en", target === "en" ? "it" : target, "voice");
      else await translateInto(stt.text, detected, "en", "voice");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toastError(
        "Translation failed",
        /LANG_STT_NO_MULTILINGUAL/.test(msg) ? "Foreign speech needs a multilingual Whisper model (e.g. ggml-small.bin) in the Whisper models folder. Text translation and “Speak English” work without it." : msg,
      );
    } finally {
      setPhase(null);
      setFlow(null);
    }
  };
  finishRef.current = finish;

  const submitText = async (to: "target" | "en") => {
    const t = text.trim();
    if (!t || busy) return;
    setPhase("translating");
    try {
      await translateInto(t, source, to === "target" ? target : "en", "text");
      setText("");
    } catch (e) {
      toastError("Translation failed", e);
    } finally {
      setPhase(null);
    }
  };

  return (
    <div className={compact ? "space-y-3" : "grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]"}>
      <div className="space-y-3">
        <section className="glass space-y-3 r-20 p-3 md:p-4" aria-label="Languages">
          <div className="flex items-center gap-2">
            <LangSelect value={source} onChange={(v) => setPrefs({ source: v })} auto label="Source language" className="min-w-0 flex-1" />
            <button type="button" onClick={swap} aria-label="Swap languages" title="Swap languages" className="pill-glass !h-10 !w-10 shrink-0 !p-0">
              <ArrowLeftRight size={16} />
            </button>
            <LangSelect value={target} onChange={(v) => setPrefs({ target: v })} label="Target language" className="min-w-0 flex-1" />
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Chip active={autoSpeak} onClick={() => setPrefs({ autoSpeak: !autoSpeak })}>
              Auto-speak translation
            </Chip>
            <Chip active={autoSave} onClick={() => setPrefs({ autoSave: !autoSave })} tone="teal">
              Auto-save all captures
            </Chip>
          </div>
        </section>

        <div className={`grid gap-3 ${compact ? "" : "sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2"}`}>
          <RecordButton
            big={compact}
            label={`Speak English → ${targetName}`}
            sub="Tap to talk · hold works too"
            recording={rec.state !== "idle" && flow === "speak"}
            busy={busy || (rec.state !== "idle" && flow !== "speak")}
            level={rec.level}
            onStart={() => void startRec("speak")}
            onStop={() => void stopRec()}
          />
          <RecordButton
            big={compact}
            tone="teal"
            label={`Listen (${source === "auto" || source === "en" ? "Auto-Detect" : langName(source)}) → English`}
            sub="Hand the phone over — they speak"
            recording={rec.state !== "idle" && flow === "listen"}
            busy={busy || (rec.state !== "idle" && flow !== "listen")}
            level={rec.level}
            onStart={() => void startRec("listen")}
            onStop={() => void stopRec()}
          />
        </div>

        {micLocked && (
          <p role="alert" className="flex flex-wrap items-center gap-2 r-14 border border-alert/40 bg-alert/10 p-3 text-sm text-alert">
            The mic is locked off.
            <button type="button" className="pill-glass !h-8 text-xs" onClick={() => void requestMicEnabled(true).then(() => setMicLocked(false))}>
              Unlock mic
            </button>
          </p>
        )}

        {(phase || heard) && (
          <p role="status" className="flex items-center gap-2 px-1 fs-13 text-ink-2">
            {phase && <Loader2 size={13} className="animate-spin" />}
            {phase === "transcribing" ? "Transcribing locally…" : phase === "translating" ? "Translating on the local model…" : null}
            {heard && <span className="truncate italic text-ink-3">“{heard}”</span>}
          </p>
        )}

        <section className="glass space-y-2 r-20 p-3 md:p-4" aria-label="Type or paste">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                // Smart default: toward English, or to your target when what you typed is English.
                void submitText(source === "en" ? "target" : "en");
              }
            }}
            rows={compact ? 2 : 3}
            placeholder="Type English, or paste foreign text (a sign, a menu, a message)…"
            aria-label="Text to translate"
            className="field min-h-[4.5rem] w-full resize-y fs-15"
          />
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy || !text.trim()} onClick={() => void submitText("target")} className="pill-primary !h-10 flex-1 text-sm disabled:opacity-40">
              → {targetName}
            </button>
            <button type="button" disabled={busy || !text.trim()} onClick={() => void submitText("en")} className="pill-glass !h-10 flex-1 text-sm disabled:opacity-40">
              → English
            </button>
          </div>
        </section>

        {status && !status.multilingualModel && !compact && (
          <p className="glass r-14 px-3 py-2 fs-11 leading-relaxed text-ink-2">
            <Ear size={11} className="mr-1 inline" />
            Foreign-speech capture needs a multilingual Whisper model (e.g. <span className="font-mono">ggml-small.bin</span>) next to your current one. Until then, “Speak English”, typed and pasted text all work.
          </p>
        )}
      </div>

      <section aria-label="This session" className="glass space-y-2 self-start r-20 p-3 md:p-4">
        <div className="flex items-center gap-2 px-1">
          <h2 className="label-caps text-amber-soft">This session</h2>
          <span className="font-mono fs-11 text-ink-3">{feed.length}</span>
          {unsaved > 0 && (
            <button type="button" onClick={clearUnsaved} className="pill-glass ml-auto !h-8 text-xs" title="Removes unsaved cards from this session; the Library is untouched">
              <Trash2 size={12} /> Clear unsaved ({unsaved})
            </button>
          )}
        </div>
        {feed.length === 0 ? (
          <div className="grid min-h-32 place-items-center p-6 text-center text-sm text-ink-3">Your exchanges appear here, newest first.</div>
        ) : (
          <ul className="space-y-2">
            {feed.map((f) => (
              <FeedCard key={f.key} f={f} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function FeedCard({ f }: { f: FeedItem }) {
  const saveFeed = useHub((s) => s.saveFeed);
  // The foreign side is what you want to hear.
  const foreign = f.dir === "out" ? { text: f.translated_text, lang: f.target_lang } : { text: f.source_text, lang: f.source_lang };
  return (
    <li className="r-16 border border-white/[0.06] bg-white/[0.03] p-3.5">
      <div className="mb-1.5 flex items-center gap-2">
        <span className={`rounded-full px-2 py-0.5 font-mono fs-10 uppercase tracking-wider ${f.dir === "in" ? "bg-teal/15 text-teal" : "bg-amber/15 text-amber-light"}`}>
          {f.dir === "in" ? "Capture" : "You"} · {langName(f.source_lang)} → {langName(f.target_lang)}
        </span>
        <span className="ml-auto font-mono fs-10 text-ink-3">{new Date(f.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
      </div>
      <p className="fs-13 text-ink-2">{f.source_text}</p>
      <p className="mt-1 fs-17 font-semibold leading-snug text-ink">{f.translated_text}</p>
      {f.phonetic && <p className="mt-0.5 font-mono fs-12 text-amber-soft">{f.phonetic}</p>}
      {(f.literal || f.notes) && (
        <details className="mt-1.5 fs-12 text-ink-3">
          <summary className="cursor-pointer select-none">Literal &amp; notes</summary>
          {f.literal && <p className="mt-1">Literal: {f.literal}</p>}
          {f.notes && <p className="mt-1">{f.notes}</p>}
        </details>
      )}
      <div className="mt-2 flex items-center gap-1.5">
        <PlayButton text={foreign.text} lang={foreign.lang} label={`Play ${langName(foreign.lang)}`} />
        <CopyButton text={f.translated_text} />
        <SaveButton saved={!!f.savedId} onSave={() => saveFeed(f.key)} />
        {f.savedId && <span className="fs-11 text-teal">Saved</span>}
      </div>
    </li>
  );
}
