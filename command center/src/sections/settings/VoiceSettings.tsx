import { useEffect, useRef, useState } from "react";
import { micEnabled, useMic } from "@/features/voice/mic-gate";
import { Loader2, Play, RefreshCw, Upload } from "lucide-react";
import { Card, Field, Input, Select } from "@/components/ui";
import { cmd, nativeRaw, type AgentVoice, type AgentVoicePatch, type VoicesView } from "@/lib/platform";
import { roleLabel } from "@/features/dispatcher/roles";
import { useSettings } from "@/stores/settings";
import { audioContext } from "@/features/voice/engines";
import { detectRoute, detectedRoute, detectedRouteLabel, effectiveRoute, onRouteChange } from "@/features/voice/audio-route";
import { duckReadout } from "@/features/voice/media-duck";
import { modelsFor, useProviders } from "./use-providers";
import { ModelSelect } from "./ServicesSettings";
import { Toggle } from "./os-ui";
import { synthBytes } from "@/features/voice/engines";

const LANGS: [string, string][] = [
  ["auto", "Auto-detect"], ["en", "English"], ["fr", "French"], ["es", "Spanish"], ["it", "Italian"], ["pt", "Portuguese"],
  ["de", "German"], ["nl", "Dutch"], ["pl", "Polish"], ["ru", "Russian"], ["uk", "Ukrainian"], ["zh", "Chinese"],
  ["ja", "Japanese"], ["ko", "Korean"], ["hi", "Hindi"], ["pa", "Punjabi"], ["ar", "Arabic"], ["tl", "Tagalog"],
];

/** STT engines the Settings select offers, by providers.json `engine` id. "fasterwhisper" is
 * stt/fw_server.py on :8177 (policy.stt since 2026-11-26): without it the select fell back to its
 * first option and showed "whisper.cpp" for it. */
export const STT_ENGINES: [string, string][] = [
  ["whispercpp", "whisper.cpp server (hot-swap models)"],
  ["fasterwhisper", "faster-whisper (GPU)"],
  ["openai", "OpenAI-compatible (speaches / faster-whisper)"],
];

/** The select's options; an engine id it doesn't know is listed as itself, never shown as another. */
export function sttEngineOptions(current: string | undefined): [string, string][] {
  const id = current ?? "whispercpp";
  return STT_ENGINES.some(([e]) => e === id) ? STT_ENGINES : [...STT_ENGINES, [id, id]];
}

/** Whisper STT: model variant, language and input device. */
export function SttCard() {
  const { view, patch } = useProviders();
  const micDeviceId = useSettings((s) => s.micDeviceId);
  const set = useSettings((s) => s.set);
  const [variants, setVariants] = useState<string[]>([]);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const micOn = useMic((m) => m.enabled);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const stt = view?.providers.find((p) => p.id === view.policy.stt);

  useEffect(() => {
    if (stt) void modelsFor(stt.id, true).then((r) => setVariants(r.models));
  }, [stt?.id, stt?.engine, stt?.modelsDir]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadMics = async () => {
    try {
      // Labels are only exposed after mic permission has been granted once. Phase 2 Part B: never
      // probe (open) the mic while it is locked off; list devices only (names may be hidden).
      if (micEnabled()) {
        const probe = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
        probe?.getTracks().forEach((t) => t.stop());
      }
      setMics((await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput"));
    } catch {
      setMics([]);
    }
  };
  useEffect(() => void loadMics(), []);

  if (!stt) return null;
  const configure = async (model?: string, language?: string) => {
    setBusy(true);
    setNote(null);
    try {
      setNote(await cmd("stt_configure", { model, language }));
      await useProviders.getState().load();
    } catch (e) {
      setNote(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Speech-to-text · Whisper" hint="Bigger models are more accurate but slower. turbo ≈ large-v3 quality at a fraction of the cost. *.en variants are English-only and faster." action={busy ? <Loader2 size={14} className="animate-spin text-ink-3" /> : null}>
      <div className="grid gap-2 sm:grid-cols-3">
        <Field label="Model">
          <Select value={stt.model} onChange={(e) => void configure(e.target.value)}>
            {[...new Set([stt.model, ...variants])].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </Select>
        </Field>
        <Field label="Language">
          <Select value={stt.language ?? "auto"} onChange={(e) => void configure(undefined, e.target.value)}>
            {LANGS.map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Microphone">
          <div className="flex gap-1.5">
            <Select value={micDeviceId} onChange={(e) => set({ micDeviceId: e.target.value })}>
              <option value="">System default</option>
              {mics.map((m) => (
                <option key={m.deviceId} value={m.deviceId}>
                  {m.label || `Mic ${m.deviceId.slice(0, 6)}`}
                </option>
              ))}
            </Select>
            <button type="button" aria-label="Refresh microphones" onClick={() => void loadMics()} className="grid size-10 shrink-0 place-items-center r-12 border border-white/10 text-ink-2 hover:text-ink">
              <RefreshCw size={14} />
            </button>
          </div>
          {!micOn && mics.some((m) => !m.label) && <p className="mt-1 fs-11 text-ink-3">Unlock mic to see device names</p>}
        </Field>
        <Field label="Engine">
          {/* Saved as providers.json `engine` (Rust providers_update stores the id as given). */}
          <Select value={stt.engine ?? "whispercpp"} onChange={(e) => void patch({ id: stt.id, engine: e.target.value })}>
            {sttEngineOptions(stt.engine).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Endpoint">
          <Input defaultValue={stt.baseUrl} onBlur={(e) => e.target.value !== stt.baseUrl && void patch({ id: stt.id, baseUrl: e.target.value })} className="font-mono !fs-12" spellCheck={false} />
        </Field>
        <Field label="Models folder (ggml-*.bin)">
          <Input defaultValue={stt.modelsDir ?? ""} placeholder="G:\\whisper\\models" onBlur={(e) => e.target.value !== (stt.modelsDir ?? "") && void patch({ id: stt.id, modelsDir: e.target.value })} className="font-mono !fs-12" spellCheck={false} />
        </Field>
      </div>
      <Field label="Vocabulary prompt" className="mt-2">
        {/* Keyed on the saved value so a reload from Rust refreshes the box. */}
        <textarea
          key={stt.sttPrompt ?? ""}
          defaultValue={stt.sttPrompt ?? ""}
          rows={3}
          maxLength={800}
          spellCheck={false}
          placeholder="Empty = no prompt"
          onBlur={(e) => e.target.value !== (stt.sttPrompt ?? "") && void patch({ id: stt.id, sttPrompt: e.target.value })}
          className="field resize-y !fs-12 leading-relaxed"
        />
      </Field>
      <p className="mt-1 fs-11 text-ink-3">
        Words Whisper should expect (names, reflex phrases), written as natural speech. A transcript that just repeats 4+ of these words in a row is dropped as a hallucination.
      </p>
      {note && <p className={`mt-2 text-xs ${/not found|fail|error|unreach/i.test(note) ? "text-alert" : "text-teal"}`}>{note}</p>}
    </Card>
  );
}

/** TTS voice manager: dropdown of every installed voice, preview, and custom-voice upload. */
export function TtsCard() {
  const { view, patch, policy } = useProviders();
  const [voices, setVoices] = useState<VoicesView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const tts = view?.providers.find((p) => p.id === view.policy.tts);

  const load = async () => {
    try {
      setVoices(await cmd("tts_voices", {}));
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  };
  useEffect(() => void load(), [tts?.baseUrl, tts?.engine, tts?.voicesDir]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!tts) return null;

  const preview = async (voice: string) => {
    setBusy(`Previewing ${voice}…`);
    try {
      const bytes = await synthBytes({ text: `Hi, I'm ${useSettings.getState().osName || "Tony"}. This is how I'll sound on your command center.`, voice });
      const ac = await audioContext();
      const buf = await ac.decodeAudioData(bytes);
      const src = ac.createBufferSource();
      src.buffer = buf;
      src.connect(ac.destination);
      src.start();
      setBusy(null);
    } catch (e) {
      setBusy(`Preview failed: ${String(e)}`);
    }
  };

  const upload = async (f: File) => {
    setBusy(`Uploading ${f.name}…`);
    try {
      const id = await nativeRaw<string>("tts_voice_upload", new Uint8Array(await f.arrayBuffer()), { "x-filename": f.name });
      await load();
      if (/\.(wav|mp3|flac|ogg)$/i.test(f.name) && tts.engine !== "xtts") {
        setBusy(`Saved “${id}”. Reference audio clones a voice with XTTS — switch the engine to Coqui XTTS to use it.`);
      } else {
        await patch({ id: tts.id, voice: id });
        setBusy(`Added and selected “${id}”.`);
      }
    } catch (e) {
      setBusy(`Upload failed: ${String(e)}`);
    }
  };

  const current = tts.voice ?? voices?.current ?? "";
  const list = voices?.voices ?? [];
  const eleven = tts.engine === "elevenlabs";
  const ttsProviders = view?.providers.filter((x) => x.kind === "tts") ?? [];
  const label = (id: string) => list.find((v) => v.id === id)?.label ?? id;
  // ElevenLabs groups by category (cloned first); local engines by server vs custom file.
  const groups: [string, typeof list][] = eleven
    ? (["cloned", "professional", "generated", "premade"] as const)
        .map((c) => [CATEGORY_LABEL[c], list.filter((v) => (v.category ?? "premade") === c)] as [string, typeof list])
        .concat([["Other", list.filter((v) => !["cloned", "professional", "generated", "premade"].includes(v.category ?? "premade"))]])
        .filter(([, vs]) => vs.length > 0)
    : [
        ["Server voices", list.filter((v) => v.source === "server")],
        ["Custom voices", list.filter((v) => v.source === "custom")],
      ];
  const cloned = list.filter((v) => v.category === "cloned").length;

  return (
    <Card
      title="Text-to-speech · voices"
      hint={
        eleven
          ? "Your ElevenLabs account's voices, fetched live — cloned voices first. This is the fallback voice: any agent below with no roster row of its own (and Tony, until his own row is set) speaks with it. If ElevenLabs is offline or out of quota, live replies fall back to local Kokoro."
          : "Kokoro ships dozens of voices; Coqui XTTS clones a voice from a few seconds of reference audio. Custom files are saved to the voices folder — mount it into the TTS container so it can load them. This is the fallback voice for any agent below with no roster row of its own."
      }
    >
      <div className="grid gap-2 sm:grid-cols-[1.4fr_auto]">
        <Field label="Speaking engine">
          <Select value={view?.policy.tts ?? tts.id} onChange={(e) => void policy({ tts: e.target.value })}>
            {ttsProviders.map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
                {x.engine === "elevenlabs" ? " (cloud)" : " (local)"}
              </option>
            ))}
          </Select>
        </Field>
        {eleven ? <ModelSelect provider={tts} onChange={(model) => void patch({ id: tts.id, model })} /> : <span />}

        {/* Full card width, not squeezed into the 1.4fr column — a cloned voice's label plus its
            full ElevenLabs ID ("Tony Soprano Master Gabagool · QHdQg83KluWzfCPPis6D") needs it. */}
        <Field label={eleven ? `Voice${list.length ? ` (${list.length} on your account${cloned ? `, ${cloned} cloned` : ""})` : ""}` : `Voice${list.length ? ` (${list.length} installed)` : ""}`} className="sm:col-span-2">
          <Select value={current} onChange={(e) => void patch({ id: tts.id, voice: e.target.value })}>
            {!list.some((v) => v.id === current) && current && <option value={current}>{eleven ? `${current} (not on this account)` : current}</option>}
            {groups.map(([name, vs]) => (
              <optgroup key={name} label={name}>
                {vs.map((v) => (
                  <option key={v.id} value={v.id}>
                    {eleven ? `${v.label ?? v.id} · ${v.id}` : v.file ? `${v.id} (${v.file})` : v.id}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </Field>
        <div className="flex items-end gap-2">
          <button className="pill-glass !h-10 text-xs" onClick={() => void preview(current)} disabled={!current} title={eleven ? "Uses ElevenLabs characters" : undefined}>
            <Play size={13} /> Preview
          </button>
          {eleven ? (
            <button className="pill-glass !h-10 text-xs" onClick={() => void load()} title="Re-fetch voices from ElevenLabs">
              <RefreshCw size={13} /> Refresh voices
            </button>
          ) : (
            <>
              <button className="pill-primary !h-10 text-xs" onClick={() => file.current?.click()}>
                <Upload size={13} /> Add / load custom voice
              </button>
              <input
                ref={file}
                type="file"
                hidden
                accept=".wav,.mp3,.flac,.ogg,.pt,.pth,.onnx,.json"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void upload(f);
                  e.target.value = "";
                }}
              />
            </>
          )}
        </div>

        {eleven ? (
          <p className="text-xs text-ink-3 sm:col-span-2">
            Selected: <span className="text-ink">{label(current)}</span> <span className="font-mono">({current || "none"})</span> · API key:{" "}
            <span className={voices?.keySource === "missing" ? "text-alert" : "text-teal"}>{KEY_SOURCE[voices?.keySource ?? "missing"]}</span>
          </p>
        ) : (
          <>
            <Field label="Engine">
              <Select value={tts.engine ?? "kokoro"} onChange={(e) => void patch({ id: tts.id, engine: e.target.value })}>
                <option value="kokoro">Kokoro-FastAPI (/v1/audio/speech)</option>
                <option value="xtts">Coqui XTTS api-server (voice cloning)</option>
              </Select>
            </Field>
            <Field label="Endpoint">
              <Input defaultValue={tts.baseUrl} onBlur={(e) => e.target.value !== tts.baseUrl && void patch({ id: tts.id, baseUrl: e.target.value })} className="font-mono !fs-12" spellCheck={false} />
            </Field>
            <Field label="Voices folder" className="sm:col-span-2">
              <Input defaultValue={tts.voicesDir ?? voices?.voicesDir ?? ""} onBlur={(e) => e.target.value !== (tts.voicesDir ?? "") && void patch({ id: tts.id, voicesDir: e.target.value })} className="font-mono !fs-12" spellCheck={false} />
            </Field>
          </>
        )}
      </div>
      {(err || voices?.serverError) && (
        <p className="mt-2 text-xs text-alert">
          {eleven ? "ElevenLabs" : "TTS server"}: {err ?? voices?.serverError}
          {eleven ? "" : " — custom voices still listed."}
        </p>
      )}
      {busy && <p className={`mt-2 text-xs ${/fail/i.test(busy) ? "text-alert" : "text-teal"}`}>{busy}</p>}
    </Card>
  );
}

/** Row order the spec gives: Tony first, then the sub-agents. */
const ROSTER_ORDER = ["general", "prompter", "designer", "director", "coder", "booking", "librarian", "ops", "bizops", "finance", "trading"] as const;

/** Per-agent voice roster (Part 3): engine, voice, model and auto-speak, one row
 * per agent. Tony's own row ("general") doubles as the fallback for any agent
 * with no row of its own — see `tts_synthesize`'s roster resolution in Rust. */
export function AgentVoiceRoster() {
  const { view, agentVoice, allTony } = useProviders();
  if (!view) return null;
  const defaultEngine = view.providers.find((p) => p.id === view.policy.tts)?.engine ?? "kokoro";
  // Mirrors voice.rs `roster_entry_for`: once the roster is in use, a sub-agent without a row
  // speaks a built-in Kokoro voice (when Kokoro is set up), else Tony's.
  const rosterInUse = Object.keys(view.agentVoices).length > 0;
  const kokoro = view.providers.some((p) => p.kind === "tts" && p.engine === "kokoro");
  const fallbackNote = (role: string) => (role === "general" || view.agentVoices[role] || !rosterInUse ? undefined : kokoro ? "No row yet: speaks a built-in Kokoro voice" : "No row yet: speaks with Tony's voice");

  return (
    <Card
      title="Agent voice roster"
      hint="Give each agent its own engine, voice and model. A row left on “Default” speaks with the Text-to-speech card above; auto-speak reads that agent's reply aloud even when you typed instead of talked. Own voice: that agent's finished-job reports (Comms inbox) play in its voice; off, Tony reads them."
    >
      <Toggle
        on={!!view.agentVoicesAllTony}
        onChange={(on) => void allTony(on)}
        label="All Tony"
        hint="Every agent report speaks in Tony's voice, whatever the Own voice switches below say. Turn it off and each agent's switch applies again, as you left it."
      />
      <div className="-mx-1 overflow-x-auto">
        <table className="w-full min-w-[780px] text-left text-sm">
          <thead>
            <tr className="label-caps fs-11 text-ink-3">
              <th className="px-1 py-1.5">Agent</th>
              <th className="px-1 py-1.5">Engine</th>
              <th className="px-1 py-1.5">Voice</th>
              <th className="px-1 py-1.5">Model</th>
              <th className="px-1 py-1.5">Preview</th>
              <th className="px-1 py-1.5">Auto-speak</th>
              <th className="px-1 py-1.5" title="Speak in own voice: this agent's reports play in its voice (off: Tony reads them)">Own voice</th>
            </tr>
          </thead>
          <tbody>
            {ROSTER_ORDER.map((role) => (
              <RosterRow key={role} role={role} entry={view.agentVoices[role]} defaultEngine={defaultEngine} note={fallbackNote(role)} allTony={!!view.agentVoicesAllTony} onPatch={(patch) => void agentVoice(role, patch)} />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function RosterRow({ role, entry, defaultEngine, note, allTony, onPatch }: { role: string; entry: AgentVoice | undefined; defaultEngine: string; note?: string; allTony: boolean; onPatch: (p: AgentVoicePatch) => void }) {
  const own = entry?.ownVoice !== false;
  const engine = entry?.engine ?? defaultEngine;
  const [voices, setVoices] = useState<VoicesView | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    void cmd("tts_voices", { engine })
      .then(setVoices)
      .catch(() => setVoices(null));
  }, [engine]);
  useEffect(() => {
    if (engine === "elevenlabs") void modelsFor("elevenlabs").then((r) => setModels(r.models));
  }, [engine]);

  const list = voices?.voices ?? [];
  const current = entry?.voice ?? "";

  const preview = async () => {
    setBusy("Previewing…");
    try {
      // Its own breaker scope (P1): a failing click falls back once with ONE notice.
      const bytes = await synthBytes({ text: `Hey Nic, ${roleLabel(role)} online. What are we building?`, agent: role, utteranceId: crypto.randomUUID() });
      const ac = await audioContext();
      const buf = await ac.decodeAudioData(bytes);
      const src = ac.createBufferSource();
      src.buffer = buf;
      src.connect(ac.destination);
      src.start();
      setBusy(null);
    } catch (e) {
      setBusy(`Failed: ${String(e)}`);
    }
  };

  return (
    <tr className="border-t border-white/[0.06]">
      <td className="px-1 py-1.5 font-medium text-ink">
        {roleLabel(role)}
        {note && <span className="block fs-10 font-normal text-ink-3">{note}</span>}
      </td>
      <td className="px-1 py-1.5">
        <Select value={engine} onChange={(e) => onPatch({ engine: e.target.value as AgentVoice["engine"] })} className="!h-9 !w-36 !py-0 !text-xs !leading-normal">
          <option value="elevenlabs">ElevenLabs (cloud)</option>
          <option value="kokoro">Kokoro (local)</option>
        </Select>
      </td>
      <td className="px-1 py-1.5">
        {/* w-40 used to clip a cloned voice's full name ("Tony Soprano Master Gabagool"); wide
            enough now for that plus some headroom, with a title so hover shows the rest anyway. */}
        <Select value={current} onChange={(e) => onPatch({ voice: e.target.value })} className="!h-9 !w-56 !py-0 !text-xs !leading-normal" title={engine === "elevenlabs" ? current || undefined : undefined}>
          <option value="">Default</option>
          {!list.some((v) => v.id === current) && current && <option value={current}>{current}</option>}
          {list.map((v) => (
            <option key={v.id} value={v.id}>
              {engine === "elevenlabs" ? v.label ?? v.id : v.file ? `${v.id} (${v.file})` : v.id}
            </option>
          ))}
        </Select>
      </td>
      <td className="px-1 py-1.5">
        {engine === "elevenlabs" ? (
          <Select value={entry?.model ?? ""} onChange={(e) => onPatch({ model: e.target.value })} className="!h-9 !w-32 !py-0 !text-xs !leading-normal">
            <option value="">Default</option>
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
        ) : (
          <span className="text-ink-3">—</span>
        )}
      </td>
      <td className="px-1 py-1.5">
        <button type="button" className="pill-glass !h-8 !px-2.5 text-xs" onClick={() => void preview()} disabled={busy === "Previewing…"} title="Preview this agent's voice">
          <Play size={12} />
        </button>
        {busy && busy !== "Previewing…" && <span className="ml-1.5 fs-10 text-alert">{busy}</span>}
      </td>
      <td className="px-1 py-1.5">
        <button
          type="button"
          role="switch"
          aria-checked={!!entry?.autoSpeak}
          aria-label={`Auto-speak ${roleLabel(role)}`}
          onClick={() => onPatch({ autoSpeak: !entry?.autoSpeak })}
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${entry?.autoSpeak ? "bg-teal/80" : "bg-white/15"}`}
        >
          <span className={`absolute top-0.5 size-4 rounded-full bg-white shadow transition-[left] duration-200 ${entry?.autoSpeak ? "left-[18px]" : "left-0.5"}`} />
        </button>
      </td>
      <td className="px-1 py-1.5">
        {role === "general" ? (
          <span className="text-ink-3">—</span>
        ) : (
          <button
            type="button"
            role="switch"
            aria-checked={own}
            aria-label={`Speak in own voice: ${roleLabel(role)}`}
            title={allTony ? "All Tony is on: Tony reads every report (this switch is kept for later)" : own ? "Reports play in this agent's voice" : "Tony reads this agent's reports"}
            onClick={() => onPatch({ ownVoice: !own })}
            className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${own ? "bg-teal/80" : "bg-white/15"} ${allTony ? "opacity-40" : ""}`}
          >
            <span className={`absolute top-0.5 size-4 rounded-full bg-white shadow transition-[left] duration-200 ${own ? "left-[18px]" : "left-0.5"}`} />
          </button>
        )}
      </td>
    </tr>
  );
}

const CATEGORY_LABEL = { cloned: "Cloned voices", professional: "Professional clones", generated: "Designed voices", premade: "Premade voices" } as const;

const KEY_SOURCE: Record<NonNullable<VoicesView["keySource"]>, string> = {
  env: "ELEVENLABS_API_KEY environment variable",
  "env-file": "project .env (ELEVENLABS_API_KEY)",
  keychain: "OS keychain",
  missing: "missing — run npx -y @elevenlabs/cli@latest onboard init",
};

/**
 * Phase 2 voice reflexes ("cut it", "whoa", "take it easy"): where Tony's voice comes out and
 * how fast a listen over him ends. Speakers mode ignores one-syllable holds while he's audible
 * (his own "oh" can reach the mic) and uses a stricter barge-in trigger.
 */
export function ConversationReflexesCard() {
  const conversation = useSettings((s) => s.conversation);
  const set = useSettings((s) => s.set);
  const up = (p: Partial<typeof conversation>) => set({ conversation: { ...conversation, ...p } });
  const duck = conversation.mediaDuck;
  const upDuck = (p: Partial<typeof duck>) => up({ mediaDuck: { ...duck, ...p } });
  const [detected, setDetected] = useState(detectedRoute());
  const [label, setLabel] = useState(detectedRouteLabel());
  useEffect(() => {
    const sync = () => {
      setDetected(detectedRoute());
      setLabel(detectedRouteLabel());
    };
    const off = onRouteChange(sync);
    void detectRoute().then(sync);
    return () => void off();
  }, []);
  const effective = effectiveRoute(conversation.audioRoute, detected);

  return (
    <Card
      title="Voice reflexes"
      hint="Say “cut it” to stop everything, “whoa” / “aspetta” (or “take it easy” while Tony talks) to pause and add a thought, then “keep going” or “go ahead”. “Take it easy” on its own while he’s idle turns hands-free off."
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Audio route">
          <Select value={conversation.audioRoute} onChange={(e) => up({ audioRoute: e.target.value as typeof conversation.audioRoute })}>
            <option value="auto">Auto (from the output device)</option>
            <option value="headset">Headset</option>
            <option value="speakers">Open speakers</option>
          </Select>
        </Field>
        <Field label="Pause that ends a line said over Tony">
          <Select value={String(conversation.bargeEndSilenceMs)} onChange={(e) => up({ bargeEndSilenceMs: Number(e.target.value) })}>
            {[350, 500, 700, 1000].map((ms) => (
              <option key={ms} value={ms}>
                {ms} ms{ms === 500 ? " (default)" : ""}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <p className="mt-2 flex items-center gap-2 text-xs text-ink-2" aria-live="polite">
        <span className={`size-2 shrink-0 rounded-full ${effective === "headset" ? "bg-teal" : "bg-amber"}`} />
        In effect: <span className="font-semibold text-ink">{effective === "headset" ? "Headset" : "Speakers"}</span>
        {conversation.audioRoute === "auto" && <span className="truncate text-ink-3">· {label ? `“${label}”` : "device name not readable yet (speakers is the safe default)"}</span>}
      </p>
      <p className="mt-1 fs-11 text-ink-3">
        Speakers: “oh / eh / whoa” only count while Tony is silent, and talking over him needs a clearer voice. A short pause means quick reflexes; a long command said over Tony may be split, and the follow-up listen catches the rest.
      </p>
      <div className="mt-3 border-t border-white/5 pt-2">
        <Toggle
          on={conversation.bargeIn}
          onChange={(bargeIn) => up({ bargeIn })}
          label="Let me talk over Tony"
          hint="Off: the mic stays closed while he speaks, so he's never interrupted (and “cut it” has to wait for him to finish)."
        />
        <Toggle
          on={conversation.followUp}
          onChange={(followUp) => up({ followUp })}
          label="Keep listening after Tony answers"
          hint="A short window for your follow-up, no wake word needed (hands-free, or a turn you started by tapping)."
        />
        <div className="mt-1 grid gap-2 sm:grid-cols-2">
          <Field label="Follow-up window">
            <Select value={String(conversation.followUpSecs)} disabled={!conversation.followUp} onChange={(e) => up({ followUpSecs: Number(e.target.value) })}>
              {[4, 6, 8, 12].map((sec) => (
                <option key={sec} value={sec}>
                  {sec} s{sec === 6 ? " (default)" : ""}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </div>
      <div className="mt-3 border-t border-white/5 pt-2">
        <Toggle
          on={duck.enabled}
          onChange={(enabled) => upDuck({ enabled })}
          label="Lower Spotify while I talk to Tony"
          hint="Spotify on this PC fades down in about 0.1 s and back in about 0.3 s once Tony has answered. It never mutes, and Tony's own voice is never lowered; a cut or a hold pauses the music instead."
        />
        <label className="mt-1 block text-sm text-ink-2">
          Lower it by
          <div className="mt-1 flex items-center gap-3">
            <span className="w-16 fs-11 text-ink-3">barely</span>
            <input
              type="range"
              min={0}
              max={50}
              step={5}
              value={duck.reductionPct}
              disabled={!duck.enabled}
              onChange={(e) => upDuck({ reductionPct: Number(e.target.value) })}
              className="flex-1 accent-teal disabled:opacity-50"
              aria-label="How much to lower Spotify while you talk"
            />
            <span className="w-16 text-right fs-11 text-ink-3">half</span>
            <span className="w-36 text-right font-mono text-ink">{duckReadout(duck.reductionPct)}</span>
          </div>
        </label>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <Field label="Back up after a line that wasn't for Tony">
            <Select value={String(duck.restoreMs)} disabled={!duck.enabled} onChange={(e) => upDuck({ restoreMs: Number(e.target.value) })}>
              {[500, 800, 1500, 2500].map((ms) => (
                <option key={ms} value={ms}>
                  {ms / 1000} s{ms === 800 ? " (default)" : ""}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Toggle
          on={duck.onWakeListen}
          disabled={!duck.enabled}
          onChange={(onWakeListen) => upDuck({ onWakeListen })}
          label="Also while hands-free waits for the wake word"
          hint="And in the follow-up window after Tony. Room talk and loud vocals can trip it; after a line that wasn't for Tony it waits a few seconds before lowering again."
        />
        <Toggle
          on={duck.webApiFallback}
          disabled={!duck.enabled}
          onChange={(webApiFallback) => upDuck({ webApiFallback })}
          label="Spotify Web API fallback"
          hint="Only when Windows shows no Spotify audio here but Spotify says it's playing on this PC: one volume change through your Spotify account instead (no fade)."
        />
      </div>
    </Card>
  );
}
