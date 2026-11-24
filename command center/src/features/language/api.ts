/**
 * Language Hub client: Rust commands on the desktop, the gateway's /api/cc/lang/* on the phone.
 * Both reach the same `<repo>/data/language-hub/library.db` and the same local voice stack.
 */
import { cmd, isTauri, nativeRaw } from "@/lib/platform";
import { authHeader, gateway, GatewayError } from "@/lib/gateway";
import { useSettings } from "@/stores/settings";
import type { LangEntry, LangEntryPatch, LangStatus, LangTrack, NewLangEntry, SttResult, VoiceEngineInfo, VoiceOption } from "./contract";

const json = (body: unknown) => ({ body: JSON.stringify(body) });
const base = () => useSettings.getState().gatewayUrl.replace(/\/+$/, "");
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const langApi = {
  status: (): Promise<LangStatus> => (isTauri() ? cmd("lang_status") : gateway<LangStatus>("/api/cc/lang/status")),

  list: async (): Promise<LangEntry[]> => (isTauri() ? cmd("lang_library_list") : (await gateway<{ entries: LangEntry[] }>("/api/cc/lang/entries")).entries),

  save: (entry: NewLangEntry): Promise<LangEntry> => (isTauri() ? cmd("lang_library_save", { entry }) : gateway<LangEntry>("/api/cc/lang/entries", { method: "POST", ...json(entry) })),

  update: (id: string, patch: LangEntryPatch): Promise<LangEntry> =>
    isTauri() ? cmd("lang_library_update", { id, patch }) : gateway<LangEntry>(`/api/cc/lang/entries/${encodeURIComponent(id)}`, { method: "PATCH", ...json(patch) }),

  remove: async (ids: string[]): Promise<number> =>
    isTauri() ? cmd("lang_library_delete", { ids }) : (await gateway<{ deleted: number }>("/api/cc/lang/entries/delete", { method: "POST", ...json({ ids }) })).deleted,

  tracks: async (): Promise<LangTrack[]> => (isTauri() ? cmd("lang_tracks_list") : (await gateway<{ tracks: LangTrack[] }>("/api/cc/lang/tracks")).tracks),

  saveTrack: (track: LangTrack): Promise<LangTrack> =>
    isTauri() ? cmd("lang_track_save", { track }) : gateway<LangTrack>(`/api/cc/lang/tracks/${encodeURIComponent(track.lang)}`, { method: "PUT", ...json(track) }),

  /** 16 kHz WAV → text + the language Whisper heard. `lang`: "auto" or a code. */
  stt: (wav: Uint8Array, lang: string): Promise<SttResult> =>
    isTauri()
      ? nativeRaw<SttResult>("lang_stt", wav, { "x-lang": lang })
      : gateway<SttResult>(`/api/cc/lang/stt?lang=${encodeURIComponent(lang)}`, { method: "POST", body: wav as BodyInit, headers: { "Content-Type": "audio/wav" }, timeoutMs: 200_000 }),

  /** Audio on `opts.engine` (default Kokoro), or a rejection (UNSUPPORTED_LANG, NO_LOCAL_TTS, KILL_SWITCH,
   * ENGINE_DESKTOP_ONLY on the phone, or the engine's own error) — the caller falls back. */
  tts: async (text: string, lang: string, opts: { engine?: string; voice?: string | null; model?: string | null } = {}): Promise<ArrayBuffer> => {
    const extra = { engine: opts.engine || undefined, voice: opts.voice || undefined, model: opts.model || undefined };
    if (isTauri()) return cmd("lang_tts", { text, lang, ...extra });
    const res = await fetch(`${base()}/api/cc/lang/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader(useSettings.getState().gatewayToken) },
      body: JSON.stringify({ text, lang, ...extra }),
    });
    if (!res.ok) throw new GatewayError(String((await res.json().catch(() => ({}))).detail ?? res.status), res.status);
    return res.arrayBuffer();
  },

  /** One JSON-only completion on the local LLM. */
  llmJson: async (system: string, prompt: string): Promise<unknown> => {
    try {
      return isTauri() ? await cmd("lang_llm_json", { system, prompt }) : await gateway<unknown>("/api/cc/lang/llm", { method: "POST", ...json({ system, prompt }), timeoutMs: 150_000 });
    } catch (e) {
      throw new Error(`Local LLM: ${errText(e)}`);
    }
  },

  /** TTS providers for the Voice panel. */
  voiceEngines: async (): Promise<VoiceEngineInfo[]> =>
    isTauri() ? cmd("lang_voice_engines") : (await gateway<{ engines: VoiceEngineInfo[] }>("/api/cc/lang/voice/engines")).engines,

  /** Voices of one provider (desktop: the existing `tts_voices`, which also lists ElevenLabs; phone: local engines only). */
  voices: async (engine: VoiceEngineInfo): Promise<VoiceOption[]> => {
    if (isTauri()) {
      const v = await cmd("tts_voices", { engine: engine.engine });
      if (v.serverError && !v.voices.length) throw new Error(v.serverError);
      return v.voices.map((x) => ({ id: x.id, label: x.label }));
    }
    return (await gateway<{ voices: VoiceOption[] }>(`/api/cc/lang/voice/voices?engine=${encodeURIComponent(engine.id)}`)).voices;
  },

  /** Models of a cloud provider (ElevenLabs), desktop only; [] elsewhere. */
  models: async (engine: VoiceEngineInfo): Promise<string[]> => (isTauri() && !engine.local ? cmd("provider_models", { id: engine.id }) : []),

  getSetting: async (key: string): Promise<unknown> =>
    isTauri() ? cmd("lang_settings_get", { key }) : (await gateway<{ value: unknown }>(`/api/cc/lang/settings/${encodeURIComponent(key)}`)).value,

  setSetting: async (key: string, value: unknown): Promise<void> => {
    if (isTauri()) return cmd("lang_settings_set", { key, value });
    await gateway(`/api/cc/lang/settings/${encodeURIComponent(key)}`, { method: "PUT", ...json({ value }) });
  },

  /** Leaving the Hub: stop the multilingual Whisper sidecar now. Best effort. */
  release: (): void => {
    const p = isTauri() ? cmd("lang_release") : gateway("/api/cc/lang/release", { method: "POST" });
    void p.catch(() => undefined);
  },
};
