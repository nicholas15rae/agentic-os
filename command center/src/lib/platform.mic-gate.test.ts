import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 2 Part B: `nativeRaw("stt_transcribe")` is the webview's only door to Whisper. While the
 * mic is locked off it refuses before Tauri's `invoke` is even imported.
 */
const h = vi.hoisted(() => {
  Object.assign(globalThis, { window: { __TAURI_INTERNALS__: {} } });
  return { invoke: vi.fn() };
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));

import { nativeRaw } from "./platform";
import { MicLockedError, resetMicGateForTests, setMicEnabledLocal } from "@/features/voice/mic-gate";

const wav = new Uint8Array(2048);

beforeEach(() => {
  resetMicGateForTests();
  h.invoke.mockReset();
  h.invoke.mockResolvedValue("hello");
});

describe("nativeRaw stt_transcribe gate", () => {
  it("muted: rejects with MicLockedError and invoke is never called", async () => {
    await expect(nativeRaw("stt_transcribe", wav)).rejects.toBeInstanceOf(MicLockedError);
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("live: exactly one invoke", async () => {
    setMicEnabledLocal(true);
    await expect(nativeRaw<string>("stt_transcribe", wav)).resolves.toBe("hello");
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(h.invoke.mock.calls[0][0]).toBe("stt_transcribe");
  });

  it("the gate is STT-only: a voice upload still works while muted", async () => {
    await expect(nativeRaw("tts_voice_upload", wav)).resolves.toBe("hello");
    expect(h.invoke).toHaveBeenCalledTimes(1);
  });
});
