import { useEffect, useRef, useState } from "react";
import { Mic, Square } from "lucide-react";
import { Card, Select } from "@/components/ui";
import { MicCapture, encodeWav16k } from "@/features/voice/engines";
import { MicLockedError, onMicChange, useMic } from "@/features/voice/mic-gate";
import { ThresholdMeter } from "@/features/voice/ThresholdMeter";
import { SPEECH_PROB_OFF, SPEECH_PROB_ON } from "@/features/voice/vad-gate";
import { DEFAULT_PARTIAL_MS, partialMsChoices, partialMsFrom } from "@/features/voice/stt-partials";
import { isTauri } from "@/lib/platform";
import { useSettings } from "@/stores/settings";
import { transcribeWav } from "@/features/voice/engines";

/**
 * `vad.partialMs`: live captions while you speak, one Whisper pass on the clip so far every this
 * many ms of speech (GPU STT only); 0 (the default since Section 20.5) turns them off. The phone
 * keeps streaming its audio either way, so the gateway's final needs no WAV upload.
 */
export function LiveCaptionsField({ value, onChange }: { value: number | undefined; onChange: (ms: number) => void }) {
  const ms = partialMsFrom(value);
  return (
    <div className="text-sm text-ink-2">
      <label className="flex items-center gap-3">
        Live captions
        <Select value={String(ms)} onChange={(e) => onChange(Number(e.target.value))} className="!h-9 !w-60 !py-0 !text-xs" aria-label="Live captions">
          {partialMsChoices(value).map((v) => (
            <option key={v} value={v}>
              {v === 0 ? `Off${v === DEFAULT_PARTIAL_MS ? " (default)" : ""}` : `every ${v} ms of speech${v === DEFAULT_PARTIAL_MS ? " (default)" : ""}`}
            </option>
          ))}
        </Select>
      </label>
      <p className="mt-1 text-[11px] text-ink-3">
        What Whisper has heard so far, shown while you talk (faster-whisper on the GPU only). Each caption costs the GPU about one final transcription, so a shorter spacing keeps it busier; captions already pause while Tony's reply streams. Off is the default: the phone still streams its audio for a quick final, just without captions.
      </p>
    </div>
  );
}

/**
 * Settings → Voice & Triggers → Activation threshold (Phase 2 Part B). One absolute dBFS gate
 * decides what reaches Whisper; the meter under the slider uses the same scale, so you can see
 * whether your voice clears it. "Test my mic" opens a capture (never while the mic is locked off).
 */
export function VoiceDetectionCard() {
  const vad = useSettings((s) => s.vad);
  const set = useSettings((s) => s.set);
  const up = (p: Partial<typeof vad>) => set({ vad: { ...vad, ...p } });
  const micOn = useMic((s) => s.enabled);
  const [testing, setTesting] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const mic = useRef<MicCapture | null>(null);
  const prob = useRef<HTMLDivElement>(null);
  const engine = useRef<HTMLSpanElement>(null);
  const dot = useRef<HTMLSpanElement>(null);

  // X-Ray row: the speech probability (Silero), only while testing.
  useEffect(() => {
    if (!testing) return;
    let raf = 0;
    const draw = () => {
      const m = mic.current?.meter;
      if (m) {
        if (prob.current) prob.current.style.width = `${m.prob === null ? 0 : m.prob * 100}%`;
        if (engine.current) engine.current.textContent = m.neural ? "Silero must agree (AND)" : "level only (Silero loading or unavailable)";
        if (dot.current) dot.current.style.opacity = m.speaking ? "1" : "0.15";
      }
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [testing]);

  // Locking the mic ends a test (the gate already stopped its capture).
  useEffect(
    () =>
      onMicChange((on) => {
        if (on) return;
        mic.current = null;
        setTesting(false);
      }),
    [],
  );

  const listen = () => {
    const m = (mic.current ??= new MicCapture());
    const t0 = performance.now();
    let speechAt = 0;
    void m
      .start({
        record: true,
        maxSilenceStartMs: 60_000,
        onSpeechStart: () => (speechAt = performance.now()),
        onUtteranceEnd: async (pcm, rate) => {
          const ended = performance.now();
          const secs = (pcm.length / rate).toFixed(1);
          let line = `heard ${secs}s · detected ${Math.round(speechAt - t0)}ms after start · endpoint ${Math.round(ended - speechAt)}ms`;
          if (isTauri()) {
            try {
              const w0 = performance.now();
              const text = await transcribeWav(encodeWav16k(pcm, rate));
              line += ` · Whisper ${Math.round(performance.now() - w0)}ms → “${text.trim()}”`;
            } catch (e) {
              line += ` · Whisper failed: ${String(e).slice(0, 80)}`;
            }
          }
          setLog((l) => [line, ...l].slice(0, 6));
          if (mic.current === m) listen(); // keep testing
        },
      })
      .catch((e) => {
        if (e instanceof MicLockedError) {
          mic.current = null;
          setTesting(false);
        }
        setLog((l) => [`mic error: ${e instanceof Error ? e.message : e}`, ...l]);
      });
  };

  const toggle = () => {
    if (testing) {
      mic.current?.stop();
      mic.current = null;
      setTesting(false);
    } else {
      if (!micOn) return;
      setLog([]);
      setTesting(true);
      listen();
    }
  };
  useEffect(() => () => mic.current?.stop(), []);

  return (
    <Card
      title="Activation threshold"
      hint="One fixed loudness gate decides what reaches Whisper: speech must be louder than the line, and when the local Silero model is loaded it must also sound like speech. Drag the line so your normal voice clears it (the bar turns teal) and the room doesn't. The amber tick is the stricter line for talking over Tony through speakers."
      action={
        <button
          onClick={toggle}
          disabled={!testing && !micOn}
          title={!micOn ? "Mic is locked off: unlock it to test" : undefined}
          className={testing ? "pill-glass !h-8 text-xs !border-alert/50 text-alert" : "pill-primary !h-8 text-xs disabled:opacity-50"}
        >
          {testing ? <Square size={12} /> : <Mic size={12} />} {testing ? "Stop test" : "Test my mic"}
        </button>
      }
    >
      <div className="space-y-4">
        <div className="text-sm text-ink-2">
          <div className="mb-1 flex items-center justify-between">
            <span>Activation threshold</span>
            <span className="text-[11px] text-ink-3">{micOn ? (testing ? "live" : "press Test my mic to see your level") : "Mic is locked off: unlock it to test"}</span>
          </div>
          <ThresholdMeter variant="full" />
          <div className="mt-1 flex justify-between text-[11px] text-ink-3">
            <span>hears whispers (-70 dB)</span>
            <span>ignores the room (-10 dB)</span>
          </div>
        </div>
        <label className="block text-sm text-ink-2">
          Barge-in margin
          <div className="mt-1 flex items-center gap-3">
            <input type="range" min={0} max={20} step={1} value={vad.bargeMarginDb} onChange={(e) => up({ bargeMarginDb: Number(e.target.value) })} className="flex-1 accent-amber" aria-label="Barge-in margin (dB)" />
            <span className="w-16 text-right font-mono text-ink">+{vad.bargeMarginDb} dB</span>
          </div>
        </label>
        <label className="block text-sm text-ink-2">
          End-of-speech pause
          <div className="mt-1 flex items-center gap-3">
            <span className="w-20 text-[11px] text-ink-3">snappy</span>
            <input type="range" min={350} max={1600} step={50} value={vad.endSilenceMs} onChange={(e) => up({ endSilenceMs: Number(e.target.value) })} className="flex-1 accent-amber" aria-label="End-of-speech pause" />
            <span className="w-24 text-right text-[11px] text-ink-3">lets you think</span>
            <span className="w-16 text-right font-mono text-ink">{vad.endSilenceMs}ms</span>
          </div>
        </label>
        <label className="flex items-center gap-3 text-sm text-ink-2">
          Max utterance
          <input type="range" min={5000} max={30000} step={1000} value={vad.maxUtteranceMs} onChange={(e) => up({ maxUtteranceMs: Number(e.target.value) })} className="flex-1 accent-amber" aria-label="Max utterance" />
          <span className="w-12 text-right font-mono text-ink">{vad.maxUtteranceMs / 1000}s</span>
        </label>
        <LiveCaptionsField value={vad.partialMs} onChange={(partialMs) => up({ partialMs })} />

        {testing && (
          <div>
            <div className="label-caps mb-1 text-[10px] text-ink-3">X-Ray</div>
            <div className="relative h-3 overflow-hidden rounded-full bg-white/[0.05]" title="speech probability">
              <div ref={prob} className="h-full rounded-full bg-teal/70 transition-[width] duration-75" style={{ width: "0%" }} />
              <div className="absolute inset-y-0 w-0.5 bg-amber/60" style={{ left: `${SPEECH_PROB_OFF * 100}%` }} title="quiet below this" />
              <div className="absolute inset-y-0 w-0.5 bg-teal" style={{ left: `${SPEECH_PROB_ON * 100}%` }} title="speech at or above this" />
            </div>
            <div className="mt-1 flex items-center gap-3 text-[11px] text-ink-3">
              <span className="flex items-center gap-1">
                <span ref={dot} className="size-2 rounded-full bg-teal" /> speech
              </span>
              <span>
                speech probability · <span ref={engine} className="text-ink-2" />
              </span>
            </div>
            <ul className="mt-2 space-y-1 font-mono text-[11px] text-ink-2">
              {log.length === 0 && <li className="text-ink-3">Say something…</li>}
              {log.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}
