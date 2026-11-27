import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Settings → Voice: the STT card's Engine select knows faster-whisper (policy.stt's engine since
 * 2026-11-26), and Voice detection has the live-captions spacing (`vad.partialMs`). The heavy
 * imports (Tauri IPC, the mic, audio) are stubbed; nothing runs but the render.
 */
const h = vi.hoisted(() => ({
  view: null as unknown,
  patch: vi.fn(),
  set: vi.fn(),
  vad: { activationDb: -44, bargeMarginDb: 6, endSilenceMs: 700, maxUtteranceMs: 15000, partialMs: 600 } as Record<string, number | undefined>,
}));
vi.mock("@/lib/platform", () => ({ cmd: vi.fn(), nativeRaw: vi.fn(), isTauri: () => true }));
vi.mock("@/features/voice/mic-gate", () => ({ micEnabled: () => true, useMic: (sel: (s: { enabled: boolean }) => unknown) => sel({ enabled: true }), MicLockedError: class extends Error {}, onMicChange: () => () => undefined }));
vi.mock("@/features/dispatcher/roles", () => ({ roleLabel: (r: string) => r }));
vi.mock("@/stores/settings", () => ({ useSettings: (sel: (s: unknown) => unknown) => sel({ micDeviceId: "", set: h.set, vad: h.vad }) }));
vi.mock("@/features/voice/engines", () => ({ audioContext: vi.fn(), synthBytes: vi.fn(), transcribeWav: vi.fn(), encodeWav16k: vi.fn(), MicCapture: class {} }));
vi.mock("@/features/voice/audio-route", () => ({ detectRoute: async () => "headset", detectedRoute: () => "headset", detectedRouteLabel: () => "", effectiveRoute: () => "headset", onRouteChange: () => () => undefined }));
vi.mock("@/features/voice/media-duck", () => ({ duckReadout: () => "" }));
vi.mock("@/features/voice/ThresholdMeter", () => ({ ThresholdMeter: () => null }));
vi.mock("./use-providers", () => ({ modelsFor: async () => ({ models: [] }), useProviders: Object.assign(() => ({ view: h.view, patch: h.patch }), { getState: () => ({ load: async () => undefined }) }) }));
vi.mock("./ServicesSettings", () => ({ ModelSelect: () => null }));
vi.mock("./os-ui", () => ({ Toggle: () => null }));

import { STT_ENGINES, SttCard, sttEngineOptions } from "./VoiceSettings";
import { LiveCaptionsField, VoiceDetectionCard } from "./VadSettings";

/** The live providers.json STT entries (no secrets in them). */
const fasterWhisper = { id: "faster-whisper", label: "faster-whisper (GPU)", kind: "stt", baseUrl: "http://127.0.0.1:8177/v1", model: "large-v3-turbo", needsKey: false, engine: "fasterwhisper", language: "en", hasKey: false };
const whisper = { id: "whisper", label: "Whisper STT", kind: "stt", baseUrl: "http://127.0.0.1:8178/v1", model: "base.en", needsKey: false, engine: "whispercpp", language: "en", modelsDir: "G:\\whisper\\models", hasKey: false };
const viewWith = (stt: string) => ({ providers: [whisper, fasterWhisper], policy: { stt, tts: "kokoro", chain: [], verifier: "" }, agentVoices: {} });

/** The <select> right after a field label, as rendered. */
function selectAfter(html: string, label: string): string {
  const at = html.indexOf(`>${label}</span>`);
  expect(at, `no "${label}" field`).toBeGreaterThan(-1);
  const start = html.indexOf("<select", at);
  return html.slice(start, html.indexOf("</select>", start));
}

beforeEach(() => {
  h.vad.partialMs = 600;
});

describe("STT Engine select", () => {
  it("shows policy.stt's faster-whisper provider as faster-whisper, not whisper.cpp", () => {
    h.view = viewWith("faster-whisper");
    const engine = selectAfter(renderToStaticMarkup(<SttCard />), "Engine");
    expect(engine).toContain('<option value="fasterwhisper" selected="">faster-whisper (GPU)</option>');
    expect(engine).not.toMatch(/value="whispercpp" selected/);
  });

  it("still shows whisper.cpp for the whisper provider, and never relabels an unknown engine", () => {
    h.view = viewWith("whisper");
    expect(selectAfter(renderToStaticMarkup(<SttCard />), "Engine")).toContain('<option value="whispercpp" selected="">whisper.cpp server (hot-swap models)</option>');
    expect(STT_ENGINES.map(([id]) => id)).toEqual(["whispercpp", "fasterwhisper", "openai"]);
    expect(sttEngineOptions("speaches").at(-1)).toEqual(["speaches", "speaches"]);
    expect(sttEngineOptions(undefined)).toBe(STT_ENGINES);
  });
});

describe("Live captions (vad.partialMs)", () => {
  it("sits with the other voice-detection settings, off by default (Section 20.5)", () => {
    h.vad.partialMs = undefined; // an older settings file: the default applies
    const html = renderToStaticMarkup(<VoiceDetectionCard />);
    expect(html).toContain("Live captions");
    expect(html).toContain('<option value="0" selected="">Off (default)</option>');
    expect(html).toContain('<option value="600">every 600 ms of speech</option>');
  });

  it("shows off and a hand-set value as they are, and saves a number", () => {
    expect(renderToStaticMarkup(<LiveCaptionsField value={0} onChange={() => undefined} />)).toContain('<option value="0" selected="">Off');
    expect(renderToStaticMarkup(<LiveCaptionsField value={700} onChange={() => undefined} />)).toContain('<option value="700" selected="">every 700 ms');
    const onChange = vi.fn();
    type El = { props?: { onChange?: (e: { target: { value: string } }) => void; children?: unknown } };
    const find = (n: unknown): El | null => {
      if (Array.isArray(n)) return n.map(find).find(Boolean) ?? null;
      const e = n as El;
      return e?.props?.onChange ? e : e?.props ? find(e.props.children) : null;
    };
    find(LiveCaptionsField({ value: 600, onChange }))!.props!.onChange!({ target: { value: "1000" } });
    expect(onChange).toHaveBeenCalledWith(1000);
  });
});
