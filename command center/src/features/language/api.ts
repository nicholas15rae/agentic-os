/**
 * Language Hub client: Rust commands on the desktop, the gateway's /api/cc/lang/* on the phone.
 * Both reach the same `<repo>/data/language-hub/library.db` and the same local voice stack.
 */
import { cmd, isTauri, nativeRaw } from "@/lib/platform";
import { authHeader, gateway, GatewayError } from "@/lib/gateway";
import { useSettings } from "@/stores/settings";
import type { LangEntry, LangEntryPatch, LangStatus, LangTrack, NewLangEntry, SttResult } from "./contract";

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

  /** Kokoro mp3, or a rejection whose message starts with UNSUPPORTED_LANG / NO_LOCAL_TTS. */
  tts: async (text: string, lang: string): Promise<ArrayBuffer> => {
    if (isTauri()) return cmd("lang_tts", { text, lang });
    const res = await fetch(`${base()}/api/cc/lang/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader(useSettings.getState().gatewayToken) },
      body: JSON.stringify({ text, lang }),
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

  /** Leaving the Hub: stop the multilingual Whisper sidecar now. Best effort. */
  release: (): void => {
    const p = isTauri() ? cmd("lang_release") : gateway("/api/cc/lang/release", { method: "POST" });
    void p.catch(() => undefined);
  },
};
