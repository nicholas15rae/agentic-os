import { useEffect, useRef, useState } from "react";
import { Loader2, Mic, Square } from "lucide-react";
import { useToasts } from "@/features/reminders/notify";
import { MIC_LOCKED_MSG, assertMicAllowed, captureClosed, captureOpened, micEnabled, registerCapture } from "@/features/voice/mic-gate";
import { api } from "./api";
import { addAssets, editManifest, useDirector } from "./director-store";
import { addAudio } from "./manifest";

export const VO_MIME = "audio/webm;codecs=opus";

/**
 * Record a voiceover (MediaRecorder, webm/opus) → media_voiceover_save → a new asset on the audio
 * lane at the playhead. Refuses while the mic is locked off, and registers with the mic gate so a
 * mute stops the recording mid-take (nothing is saved then).
 */
export function VoiceoverRecorder() {
  const slug = useDirector((s) => s.slug);
  const [state, setState] = useState<"idle" | "recording" | "saving">("idle");
  const [secs, setSecs] = useState(0);
  const meter = useRef<HTMLDivElement>(null);
  const stopRef = useRef<(save: boolean) => void>(() => undefined);

  useEffect(() => () => stopRef.current(false), []);

  const start = async () => {
    const toast = useToasts.getState().push;
    if (!slug) return;
    if (!micEnabled()) {
      toast({ title: MIC_LOCKED_MSG, body: "Unlock the mic to record a voiceover.", tone: "warn" });
      return;
    }
    let stream: MediaStream | null = null;
    try {
      assertMicAllowed();
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      assertMicAllowed();
    } catch (e) {
      stream?.getTracks().forEach((t) => t.stop());
      toast({ title: micEnabled() ? "Couldn't open the mic" : MIC_LOCKED_MSG, body: micEnabled() ? (e instanceof Error ? e.message : String(e)) : undefined, tone: "warn" });
      return;
    }
    const mime = typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(VO_MIME) ? VO_MIME : "audio/webm";
    const rec = new MediaRecorder(stream, { mimeType: mime });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);

    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    let raf = 0;
    const t0 = performance.now();
    const tick = () => {
      analyser.getFloatTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v));
      if (meter.current) meter.current.style.width = `${Math.min(100, Math.round(peak * 140))}%`;
      setSecs(Math.floor((performance.now() - t0) / 1000));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    let save = true;
    let release: () => void = () => undefined;
    let opened = false;
    const cleanup = () => {
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      void ctx.close().catch(() => undefined);
      release();
      if (opened) captureClosed();
    };
    stopRef.current = (s: boolean) => {
      save = s;
      if (rec.state !== "inactive") rec.stop();
    };
    rec.onstop = async () => {
      cleanup();
      stopRef.current = () => undefined;
      if (!save || !chunks.length) {
        setState("idle");
        return;
      }
      setState("saving");
      try {
        const bytes = new Uint8Array(await new Blob(chunks, { type: "audio/webm" }).arrayBuffer());
        const asset = await api.voiceoverSave({ slug, bytes, mime: "audio/webm" });
        addAssets([asset]);
        const at = useDirector.getState().playhead;
        editManifest((m) => addAudio(m, asset, at));
        toast({ title: "Voiceover added", body: `${asset.name} at ${at.toFixed(2)}s`, tone: "info" });
      } catch (e) {
        toast({ title: "Couldn't save the voiceover", body: e instanceof Error ? e.message : String(e), tone: "error" });
      } finally {
        setState("idle");
      }
    };
    try {
      // A mute (mic gate) stops the take and discards it.
      release = registerCapture({ stop: () => stopRef.current(false) });
    } catch {
      cleanup();
      toast({ title: MIC_LOCKED_MSG, tone: "warn" });
      return;
    }
    captureOpened();
    opened = true;
    rec.start(250);
    setSecs(0);
    setState("recording");
  };

  if (state === "recording")
    return (
      <div className="flex items-center gap-2">
        <button onClick={() => stopRef.current(true)} className="pill-primary !h-8 !px-3 text-xs" aria-label="Stop recording">
          <Square size={11} /> Stop · {secs}s
        </button>
        <div className="h-1.5 w-24 overflow-hidden rounded-full bg-white/10" aria-hidden>
          <div ref={meter} className="h-full bg-teal" style={{ width: "0%" }} />
        </div>
      </div>
    );
  return (
    <button onClick={() => void start()} disabled={state === "saving" || !slug} className="pill-glass !h-8 !px-3 text-xs disabled:opacity-50" title="Record a voiceover at the playhead">
      {state === "saving" ? <Loader2 size={12} className="animate-spin" /> : <Mic size={12} />} Voiceover
    </button>
  );
}
