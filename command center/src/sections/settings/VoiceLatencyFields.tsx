import { useSettings } from "@/stores/settings";
import { Toggle } from "./os-ui";

/**
 * Settings → Voice detection → Latency (the Section 26 latency pass). Every switch is off by
 * default; each saves at once and applies from the next listen / the next reply.
 */
export function VoiceLatencyFields() {
  const lat = useSettings((s) => s.latency);
  const setAll = useSettings((s) => s.set);
  const set = (patch: Partial<typeof lat>) => setAll({ latency: { ...lat, ...patch } });
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
    </div>
  );
}
