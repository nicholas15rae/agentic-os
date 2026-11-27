import { useEffect, useMemo, useState } from "react";
import { Cloud, Cpu, Loader2, Play, RotateCcw, X } from "lucide-react";
import { Chip, Select } from "@/components/ui";
import { isTauri } from "@/lib/platform";
import { BROWSER_ENGINE, type VoiceEngineInfo, type VoiceOption, type VoicePrefs } from "./contract";
import { langApi } from "./api";
import { browserVoicesFor, speak, useBrowserVoices } from "./audio";
import { LANGUAGES } from "./languages";
import { toastError } from "./parts";
import { useHub } from "./store";
import { kokoroVoiceLang, resolveVoice, voicesForLang, type VoicePlan } from "./voice";

/**
 * Voice panel: which TTS engine speaks the Hub (any provider configured in Settings → Voice, or
 * this device's browser voices), the cloud model, a default voice, and per-language overrides.
 * Engine / model / server voices are saved to the Hub's own settings (shared with the phone);
 * browser voices are per device. Every row has a ▶ preview.
 */
export function VoicePanel({ onClose }: { onClose: () => void }) {
  const { voice, engines, setVoice, browserVoices, setPrefs } = useHub();
  const info = engines.find((e) => e.id === voice.engine);
  const isBrowser = voice.engine === BROWSER_ENGINE;
  const browserList = useBrowserVoices();
  const [serverVoices, setServerVoices] = useState<VoiceOption[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  // Load the chosen engine's voices (and models for a cloud engine) whenever it changes.
  useEffect(() => {
    if (!info) return setServerVoices([]);
    let live = true;
    setLoading(true);
    setVoiceError(null);
    Promise.all([langApi.voices(info), langApi.models(info).catch(() => [])])
      .then(([v, m]) => {
        if (!live) return;
        setServerVoices(v);
        setModels(m);
      })
      .catch((e) => live && (setServerVoices([]), setVoiceError(e instanceof Error ? e.message : String(e))))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [info]);

  const save = (next: VoicePrefs) => void setVoice(next).catch((e) => toastError("Couldn't save the voice", e));
  const picks = voice.voices[voice.engine] ?? {};
  const setPick = (lang: string, id: string) => {
    const mine = { ...picks };
    if (id) mine[lang] = id;
    else delete mine[lang];
    save({ ...voice, voices: { ...voice.voices, [voice.engine]: mine } });
  };
  const browserPick = (lang: string, uri: string) => {
    const next = { ...browserVoices };
    if (uri) next[lang] = uri;
    else delete next[lang];
    setPrefs({ browserVoices: next });
  };

  const engineName = (e: VoiceEngineInfo) => `${e.label}${e.local ? "" : isTauri() ? " · cloud" : " · desktop only"}`;
  const cloudOnPhone = !!info && !info.local && !isTauri();

  return (
    <section className="glass space-y-4 r-20 p-4 md:p-5" aria-label="Voice settings">
      <div className="flex items-center gap-2">
        <h2 className="label-caps text-amber-soft">Voice</h2>
        <span className="fs-11 text-ink-3">How the Hub speaks translations, the coach and flashcards.</span>
        <button type="button" onClick={onClose} aria-label="Close voice settings" className="pill-glass ml-auto !h-8 !w-8 !p-0">
          <X size={14} />
        </button>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="block space-y-1.5">
          <span className="label-caps text-ink-3">Engine</span>
          <Select value={voice.engine} onChange={(e) => save({ ...voice, engine: e.target.value })} aria-label="Voice engine" className="!h-10 fs-13">
            {engines.map((e) => (
              <option key={e.id} value={e.id}>
                {engineName(e)}
              </option>
            ))}
            <option value={BROWSER_ENGINE}>Browser voice (this device)</option>
          </Select>
        </label>
        {info && !info.local && (
          <label className="block space-y-1.5">
            <span className="label-caps text-ink-3">Model</span>
            <Select value={voice.model ?? ""} onChange={(e) => save({ ...voice, model: e.target.value || null })} aria-label="Voice model" className="!h-10 fs-13">
              <option value="">Provider default ({info.model || "—"})</option>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
          </label>
        )}
      </div>

      <p className="flex items-start gap-1.5 fs-11.5 leading-relaxed text-ink-3">
        {isBrowser ? (
          <>
            <Cpu size={12} className="mt-0.5 shrink-0" /> Uses this device's built-in voices; each device keeps its own picks.
          </>
        ) : info?.local === false ? (
          <>
            <Cloud size={12} className="mt-0.5 shrink-0" />
            Cloud voice: phrase text is sent to {info.label}. Off while the kill switch is on, and on the phone (its key lives on the desktop) — those fall back to Kokoro, then the browser voice.
          </>
        ) : (
          <>
            <Cpu size={12} className="mt-0.5 shrink-0" /> Local voice: nothing leaves this machine. Languages it can't speak fall back to the browser voice.
          </>
        )}
      </p>

      {loading && (
        <p role="status" className="flex items-center gap-2 fs-12 text-ink-3">
          <Loader2 size={12} className="animate-spin" /> Loading voices…
        </p>
      )}
      {voiceError && !cloudOnPhone && <p className="fs-12 text-alert">Couldn't list voices: {voiceError}</p>}
      {cloudOnPhone && <p className="fs-12 text-amber-light">This engine runs from the desktop only; on this phone the Hub uses Kokoro or the browser voice.</p>}

      <VoiceRows
        isBrowser={isBrowser}
        info={info}
        serverVoices={serverVoices}
        browserList={browserList}
        picks={isBrowser ? browserVoices : picks}
        showAll={showAll}
        onPick={isBrowser ? browserPick : setPick}
      />

      <div className="flex flex-wrap items-center gap-2">
        {info?.engine === "kokoro" && (
          <Chip active={showAll} onClick={() => setShowAll((s) => !s)}>
            Show every Kokoro voice
          </Chip>
        )}
        <button
          type="button"
          className="pill-glass ml-auto !h-8 text-xs"
          onClick={() => (isBrowser ? setPrefs({ browserVoices: {} }) : save({ ...voice, voices: { ...voice.voices, [voice.engine]: {} } }))}
        >
          <RotateCcw size={12} /> Reset voices to automatic
        </button>
      </div>
    </section>
  );
}

function VoiceRows({
  isBrowser,
  info,
  serverVoices,
  browserList,
  picks,
  showAll,
  onPick,
}: {
  isBrowser: boolean;
  info: VoiceEngineInfo | undefined;
  serverVoices: VoiceOption[];
  browserList: SpeechSynthesisVoice[];
  picks: Record<string, string>;
  showAll: boolean;
  onPick: (lang: string, id: string) => void;
}) {
  const voice = useHub((s) => s.voice);
  const engines = useHub((s) => s.engines);
  const optionsFor = (lang: string): VoiceOption[] => {
    if (isBrowser) return (lang === "*" ? browserList : browserVoicesFor(browserList, lang)).map((v) => ({ id: v.voiceURI, label: `${v.name} (${v.lang})` }));
    if (lang === "*" || showAll) return serverVoices;
    return voicesForLang(info, serverVoices, lang);
  };
  const label = (o: VoiceOption) => {
    const l = o.label && o.label !== o.id ? `${o.label}` : o.id;
    const k = info?.engine === "kokoro" ? kokoroVoiceLang(o.id) : null;
    return k ? `${l} · ${k}` : l;
  };
  const rows = useMemo(() => [{ code: "*", name: "Default (all languages)", sample: "" }, ...LANGUAGES.map((l) => ({ code: l.code, name: l.name, sample: l.sample ?? "Hello!" }))], []);

  return (
    <div className="max-h-[46vh] space-y-1 overflow-y-auto pr-1" role="list" aria-label="Voice per language">
      {rows.map((r) => {
        const opts = optionsFor(r.code);
        const auto = r.code === "*" ? "Automatic (per language)" : picks["*"] ? "Use the default" : "Automatic";
        const previewLang = r.code === "*" ? "en" : r.code;
        const plan: VoicePlan = isBrowser
          ? { engine: BROWSER_ENGINE, kind: "browser", voice: picks[r.code] ?? picks["*"] ?? null, model: null, label: "Browser voice" }
          : r.code === "*" && picks["*"]
            ? { ...resolveVoice(voice, "en", engines), voice: picks["*"] }
            : resolveVoice(voice, previewLang, engines);
        const sample = r.code === "*" ? "Hello! This is how I sound." : r.sample;
        return (
          <div key={r.code} role="listitem" className={`flex items-center gap-2 r-12 px-2 py-1.5 ${r.code === "*" ? "bg-white/[0.04]" : ""}`}>
            <span className={`w-36 shrink-0 truncate fs-13 ${r.code === "*" ? "font-semibold text-ink" : "text-ink-2"}`}>{r.name}</span>
            <Select value={picks[r.code] ?? ""} onChange={(e) => onPick(r.code, e.target.value)} aria-label={`${r.name} voice`} className="!h-9 min-w-0 flex-1 !py-0 fs-12.5">
              <option value="">{auto}</option>
              {opts.map((o) => (
                <option key={o.id} value={o.id}>
                  {label(o)}
                </option>
              ))}
              {picks[r.code] && !opts.some((o) => o.id === picks[r.code]) && <option value={picks[r.code]}>{picks[r.code]}</option>}
            </Select>
            <PreviewButton text={sample} lang={previewLang} plan={plan} name={r.name} />
          </div>
        );
      })}
    </div>
  );
}

function PreviewButton({ text, lang, plan, name }: { text: string; lang: string; plan: VoicePlan; name: string }) {
  const [busy, setBusy] = useState(false);
  const setEngine = useHub((s) => s.setEngine);
  return (
    <button
      type="button"
      aria-label={`Preview ${name} voice`}
      title="Preview"
      className="pill-glass !h-9 !w-9 shrink-0 !p-0"
      onClick={async () => {
        setBusy(true);
        try {
          setEngine(await speak(text, lang, plan));
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
    </button>
  );
}
