import { Select } from "@/components/ui";
import { FAST_END_DEFAULT_MS, FAST_END_MIN_MS } from "@/features/voice/vad-gate";
import { useSettings } from "@/stores/settings";
import { Toggle } from "./os-ui";

/**
 * Settings → Voice detection → Latency (the Section 26 latency pass). Every switch is off by
 * default; each saves at once and applies from the next listen / the next reply.
 */
export function VoiceLatencyFields() {
  const lat = useSettings((s) => s.latency);
  const setAll = useSettings((s) => s.set);
  const endMs = useSettings((s) => s.vad?.endSilenceMs ?? 700);
  const set = (patch: Partial<typeof lat>) => setAll({ latency: { ...lat, ...patch } });
  const choices = [...new Set([FAST_END_MIN_MS, 350, 400, 450, FAST_END_DEFAULT_MS, 550, 600, 650, lat?.smartEndMs ?? FAST_END_DEFAULT_MS])].filter((v) => v <= endMs).sort((a, b) => a - b);
  return (
    <div className="mt-4 border-t border-white/[0.06] pt-3">
      <p className="mb-2 text-sm text-ink-2">Latency</p>
      <Toggle
        on={!!lat?.streamTts}
        onChange={(x) => set({ streamTts: x })}
        label="Stream the first sentence"
        hint="Tony starts talking on the first slice of ElevenLabs audio instead of after the whole sentence. Same voice and model. Measured: about 0.3 s instead of 0.45-0.87 s."
      />
      <Toggle
        on={!!lat?.earlyStt}
        onChange={(x) => set({ earlyStt: x })}
        label="Start Whisper in the pause"
        hint="Desktop: Whisper starts on what you said after 150 ms of quiet, so the text is ready when your turn ends. Speak again and it starts over. Same transcript; one extra Whisper pass when you pause mid-thought."
      />
      <Toggle
        on={!!lat?.smartEnd}
        onChange={(x) => set({ smartEnd: x })}
        label="Shorter end-of-turn wait (Silero-checked)"
        hint={`Your turn ends after the shorter wait below instead of ${endMs} ms, but only when the neural detector (Silero, on the CPU) heard clear silence for the whole pause. A breath, an "mmm" or a trailing sound waits the full ${endMs} ms. A long silent pause mid-thought can still end your turn, so raise the wait if it cuts you off.`}
      />
      <label className={`ml-12 flex items-center gap-3 text-sm text-ink-2 ${lat?.smartEnd ? "" : "opacity-50"}`}>
        Shorter wait
        <Select value={String(lat?.smartEndMs ?? FAST_END_DEFAULT_MS)} disabled={!lat?.smartEnd} onChange={(e) => set({ smartEndMs: Number(e.target.value) })} className="!h-9 !w-40 !py-0 !text-xs" aria-label="Shorter end-of-turn wait">
          {choices.map((v) => (
            <option key={v} value={v}>
              {v} ms{v === FAST_END_DEFAULT_MS ? " (default)" : ""}
            </option>
          ))}
        </Select>
      </label>
    </div>
  );
}
