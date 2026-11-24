import { describe, expect, it } from "vitest";
import { BROWSER_ENGINE, type VoiceEngineInfo } from "./contract";
import { defaultVoicePrefs, kokoroVoiceLang, normalizeVoicePrefs, resolveVoice, voicesForLang } from "./voice";

const engines: VoiceEngineInfo[] = [
  { id: "kokoro", label: "Kokoro", engine: "kokoro", local: true, model: "kokoro", voice: "am_michael" },
  { id: "elevenlabs", label: "ElevenLabs", engine: "elevenlabs", local: false, model: "eleven_v4_turbo", voice: "QhE" },
];

describe("voice prefs", () => {
  it("defaults to Kokoro and survives junk", () => {
    expect(defaultVoicePrefs(engines)).toEqual({ engine: "kokoro", model: null, voices: {} });
    expect(normalizeVoicePrefs(null, engines).engine).toBe("kokoro");
    expect(normalizeVoicePrefs({ engine: "elevenlabs", model: "m", voices: { elevenlabs: { "*": "v", bad: 3 }, x: 1 } }, engines)).toEqual({
      engine: "elevenlabs",
      model: "m",
      voices: { elevenlabs: { "*": "v" } },
    });
  });

  it("reads Kokoro voice languages", () => {
    expect(kokoroVoiceLang("if_sara")).toBe("it");
    expect(kokoroVoiceLang("bm_george")).toBe("en");
    expect(kokoroVoiceLang("custom-clone")).toBeNull();
    const vs = [{ id: "if_sara", label: null }, { id: "im_nicola", label: null }, { id: "af_heart", label: null }];
    expect(voicesForLang(engines[0], vs, "it").map((v) => v.id)).toEqual(["if_sara", "im_nicola"]);
    expect(voicesForLang(engines[1], vs, "it")).toHaveLength(3); // cloud voices are multilingual
  });
});

describe("resolveVoice", () => {
  it("per-language pick beats the default; Kokoro's default only for its own language", () => {
    const p = { engine: "kokoro", model: "ignored", voices: { kokoro: { "*": "if_sara", ja: "jm_kumo" } } };
    expect(resolveVoice(p, "it", engines)).toMatchObject({ engine: "kokoro", kind: "server", voice: "if_sara", model: null });
    expect(resolveVoice(p, "ja", engines).voice).toBe("jm_kumo");
    expect(resolveVoice(p, "fr", engines).voice).toBeNull(); // engine's own French voice
  });

  it("cloud engines take one voice for every language, plus the model", () => {
    const p = { engine: "elevenlabs", model: "eleven_multilingual_v2", voices: { elevenlabs: { "*": "abc" } } };
    expect(resolveVoice(p, "la", engines)).toMatchObject({ engine: "elevenlabs", voice: "abc", model: "eleven_multilingual_v2", label: "ElevenLabs" });
  });

  it("browser and missing engines", () => {
    expect(resolveVoice({ engine: BROWSER_ENGINE, model: null, voices: { browser: { it: "Google italiano" } } }, "it", engines)).toMatchObject({ kind: "browser", voice: "Google italiano" });
    expect(resolveVoice({ engine: "gone", model: null, voices: {} }, "it", engines).engine).toBe("kokoro");
    expect(resolveVoice({ engine: "gone", model: null, voices: {} }, "it", []).engine).toBe("gone"); // engines not loaded yet
  });
});
