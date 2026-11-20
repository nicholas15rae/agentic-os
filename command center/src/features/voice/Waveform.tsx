import { useEffect, useRef } from "react";
import { useSettings } from "@/stores/settings";
import { usePrefersReducedMotion } from "@/lib/use-media-query";
import { micLevel, voiceLevel, type VoiceState } from "./voice-store";

/**
 * Bold, opaque, glowing voice waveform. Three phase-shifted sine bands share
 * one horizontal gradient (Stitch spectrum: volt cyan → violet → coral, or the
 * user's own colours from Settings) and taper to a point at both ends.
 *
 *   idle      → slow low breathing
 *   listening → amplitude follows the mic
 *   thinking  → a travelling pulse sweeps left→right
 *   speaking  → amplitude follows the TTS envelope
 *   locked    → (Phase 2 Part D) a flat, static alert-red line: the mic is locked off, so
 *               nothing is animated (no rAF runs) and it can't pass for a live waveform.
 */
export function Waveform({ state, height = 72, className = "", locked = false }: { state: VoiceState; height?: number; className?: string; locked?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const colors = useSettings((s) => s.waveColors);
  const thickness = useSettings((s) => s.waveThickness);
  const reduced = usePrefersReducedMotion();
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    let raf = 0;
    let t = 0;
    let amp = 0.1;
    let w = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const resize = () => {
      w = canvas.clientWidth;
      canvas.width = w * dpr;
      canvas.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const bands = [
      { freq: 2.2, speed: 0.9, phase: 0, scale: 1, width: 1, alpha: 1 },
      { freq: 3.1, speed: -1.25, phase: 1.7, scale: 0.7, width: 0.6, alpha: 0.75 },
      { freq: 1.6, speed: 0.6, phase: 3.4, scale: 0.5, width: 0.45, alpha: 0.55 },
    ];

    if (locked) {
      // One static frame: a flat alert line at 40 %, then no animation loop at all.
      const flat = () => {
        ctx.clearRect(0, 0, w, height);
        const alert = getComputedStyle(document.documentElement).getPropertyValue("--color-alert").trim() || "#ff5a5f";
        ctx.globalAlpha = 0.4;
        ctx.strokeStyle = alert;
        ctx.lineWidth = Math.max(1.5, thickness * 0.6);
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(thickness, height / 2);
        ctx.lineTo(w - thickness, height / 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      };
      flat();
      const ro2 = new ResizeObserver(() => (resize(), flat()));
      ro2.observe(canvas);
      return () => {
        ro.disconnect();
        ro2.disconnect();
      };
    }

    const draw = () => {
      const s = stateRef.current;
      // The mic's level while listening, Tony's TTS envelope while speaking.
      const level = s === "listening" || s === "transcribing" ? micLevel.current : s === "speaking" ? voiceLevel.current : Math.max(voiceLevel.current, micLevel.current);
      const target = s === "listening" || s === "speaking" ? 0.18 + level * 0.82 : s === "thinking" ? 0.35 : s === "error" ? 0.05 : 0.1;
      amp += (target - amp) * 0.12;
      t += reduced ? 0 : s === "thinking" ? 0.05 : 0.03;

      ctx.clearRect(0, 0, w, height);
      const mid = height / 2;
      const grad = ctx.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0, colors[0]);
      grad.addColorStop(0.5, colors[1]);
      grad.addColorStop(1, colors[2]);

      const pulseX = s === "thinking" ? (t * 0.35) % 1.4 - 0.2 : -1;

      for (let b = bands.length - 1; b >= 0; b--) {
        const band = bands[b];
        ctx.beginPath();
        const steps = Math.max(48, Math.floor(w / 4));
        for (let i = 0; i <= steps; i++) {
          const x = i / steps;
          const taper = Math.pow(Math.sin(Math.PI * x), 2);
          const pulse = pulseX >= -0.2 ? 0.35 + 0.65 * Math.exp(-Math.pow((x - pulseX) * 5, 2)) : 1;
          const y = mid + Math.sin(x * Math.PI * 2 * band.freq + t * band.speed * 3 + band.phase) * (mid - thickness * 2) * amp * band.scale * taper * pulse;
          if (i === 0) ctx.moveTo(x * w, y);
          else ctx.lineTo(x * w, y);
        }
        ctx.globalAlpha = band.alpha;
        ctx.strokeStyle = grad;
        ctx.lineWidth = thickness * band.width + (b === 0 ? 0.5 : 0);
        ctx.lineCap = "round";
        ctx.shadowColor = colors[1];
        ctx.shadowBlur = b === 0 ? 14 : 6;
        ctx.stroke();

        // Atmospheric 10% wash under the lead band.
        if (b === 0) {
          ctx.lineTo(w, mid);
          ctx.lineTo(0, mid);
          ctx.closePath();
          ctx.globalAlpha = 0.1;
          ctx.shadowBlur = 0;
          ctx.fillStyle = grad;
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [colors, thickness, height, reduced, locked]);

  return <canvas ref={ref} aria-hidden data-locked={locked || undefined} className={`block w-full ${className}`} style={{ height }} />;
}
