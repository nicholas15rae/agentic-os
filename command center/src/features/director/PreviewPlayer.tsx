import { useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, Volume2, VolumeX } from "lucide-react";
import { SubTabs } from "@/components/ui";
import { fileSrc } from "./api";
import type { MediaAsset, TimelineClip, VerifiedRender } from "./contract";
import { setPlayhead, setPreviewMode, setPreviewTime, useDirector, type DirectorState } from "./director-store";
import { clipStarts, timecode } from "./manifest";

export type PreviewSource =
  | { kind: "asset"; asset: MediaAsset; clip: null; clipStart: 0 }
  | { kind: "clip"; asset: MediaAsset; clip: TimelineClip; clipStart: number }
  | { kind: "render"; render: VerifiedRender }
  | null;

/** What the preview plays (pure): Working = the selected asset / clip (else the first clip); Final = the selected or latest verified render. */
export function previewSource(s: Pick<DirectorState, "selection" | "previewMode" | "assets" | "manifest" | "renders">): PreviewSource {
  if (s.previewMode === "final") {
    const r = (s.selection?.kind === "render" ? s.renders.find((x) => x.id === s.selection?.id) : undefined) ?? s.renders[0];
    return r ? { kind: "render", render: r } : null;
  }
  const byId = (id: string) => s.assets.find((a) => a.id === id);
  if (s.selection?.kind === "asset") {
    const a = byId(s.selection.id);
    if (a) return { kind: "asset", asset: a, clip: null, clipStart: 0 };
  }
  const clips = s.manifest?.clips ?? [];
  const clip = (s.selection?.kind === "clip" ? clips.find((c) => c.id === s.selection?.id) : undefined) ?? clips[0];
  if (clip && s.manifest) {
    const a = byId(clip.assetId);
    const starts = clipStarts(s.manifest);
    if (a) return { kind: "clip", asset: a, clip, clipStart: starts[clips.indexOf(clip)] ?? 0 };
  }
  return null;
}

export function PreviewPlayer() {
  const selection = useDirector((s) => s.selection);
  const previewMode = useDirector((s) => s.previewMode);
  const assets = useDirector((s) => s.assets);
  const manifest = useDirector((s) => s.manifest);
  const renders = useDirector((s) => s.renders);
  const src = useMemo(() => previewSource({ selection, previewMode, assets, manifest, renders }), [selection, previewMode, assets, manifest, renders]);

  const media = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);

  const kind = src?.kind === "render" ? "video" : src ? src.asset.kind : null;
  const path = src?.kind === "render" ? src.render.path : src?.asset.path;
  const url = fileSrc(path);
  const range = src?.kind === "clip" && kind !== "image" ? { inSec: src.clip.inSec, outSec: src.clip.outSec } : null;
  const lo = range?.inSec ?? 0;
  const hi = range?.outSec ?? dur;

  // New source or trim: seek to the in point.
  useEffect(() => {
    const el = media.current;
    if (!el) return;
    el.pause();
    setPlaying(false);
    if (el.readyState >= 1) el.currentTime = lo;
    setT(lo);
  }, [url, lo, hi]);

  // A review note (or a moment) asked to seek: now if loaded, else once the new source's metadata lands.
  const seek = useDirector((s) => s.seek);
  const pendingSeek = useRef<number | null>(null);
  useEffect(() => {
    if (!seek) return;
    const el = media.current;
    if (el && el.readyState >= 1) {
      el.currentTime = seek.sec;
      setT(seek.sec);
      setPreviewTime(seek.sec);
    } else pendingSeek.current = seek.sec;
  }, [seek]);
  const startAt = (el: HTMLMediaElement) => {
    const s = pendingSeek.current;
    pendingSeek.current = null;
    el.currentTime = s ?? lo;
    setT(s ?? lo);
    setPreviewTime(s ?? lo);
  };

  useEffect(() => {
    if (media.current) {
      media.current.muted = muted;
      media.current.volume = volume;
    }
  }, [muted, volume, url]);

  const onTime = () => {
    const el = media.current;
    if (!el) return;
    if (range && el.currentTime >= range.outSec) {
      el.pause();
      el.currentTime = range.outSec;
    }
    setT(el.currentTime);
    setPreviewTime(el.currentTime);
    if (src?.kind === "clip") setPlayhead(src.clipStart + Math.max(0, el.currentTime - src.clip.inSec));
  };

  const toggle = () => {
    const el = media.current;
    if (!el) return;
    if (el.paused) {
      if (range && el.currentTime >= range.outSec - 0.02) el.currentTime = range.inSec;
      void el.play().catch(() => undefined);
    } else el.pause();
  };

  const tabs = (
    <SubTabs
      tabs={[
        { id: "working", label: "Working Preview" },
        { id: "final", label: "Final Verified Render" },
      ]}
      value={previewMode}
      onChange={setPreviewMode}
    />
  );

  return (
    <section className="glass rounded-[20px] p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {tabs}
        <span className="ml-auto min-w-0 truncate font-mono text-[11px] text-ink-3">{src?.kind === "render" ? src.render.path.split(/[\\/]/).pop() : src?.asset.name}</span>
      </div>
      <div className="grid aspect-video w-full place-items-center overflow-hidden rounded-[14px] bg-black">
        {!src ? (
          <p className="px-6 text-center text-sm text-ink-3">{previewMode === "final" ? "No verified render yet." : "Select a staged asset or a timeline clip."}</p>
        ) : kind === "image" ? (
          <img src={url} alt={src.kind !== "render" ? src.asset.name : ""} className="max-h-full max-w-full object-contain" />
        ) : kind === "audio" ? (
          <audio ref={media} src={url} preload="metadata" onLoadedMetadata={(e) => { setDur(e.currentTarget.duration || 0); startAt(e.currentTarget); }} onTimeUpdate={onTime} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} />
        ) : (
          <video
            ref={media}
            key={url}
            src={url}
            preload="metadata"
            playsInline
            className="max-h-full max-w-full"
            onLoadedMetadata={(e) => {
              setDur(e.currentTarget.duration || 0);
              startAt(e.currentTarget);
            }}
            onTimeUpdate={onTime}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onClick={toggle}
          />
        )}
      </div>
      {src && kind !== "image" && (
        <div className="mt-3 flex items-center gap-2">
          <button onClick={toggle} className="pill-glass !h-8 !w-8 shrink-0 !p-0" aria-label={playing ? "Pause" : "Play"}>
            {playing ? <Pause size={13} /> : <Play size={13} />}
          </button>
          <input
            type="range"
            min={lo}
            max={Math.max(lo + 0.01, hi)}
            step={0.01}
            value={Math.min(Math.max(t, lo), Math.max(lo, hi))}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (media.current) media.current.currentTime = v;
              setT(v);
              setPreviewTime(v);
            }}
            className="min-w-0 flex-1 accent-amber"
            aria-label="Scrub"
          />
          <span className="shrink-0 font-mono text-[11px] tabular text-ink-2">
            {timecode(t - lo)} / {timecode(Math.max(0, hi - lo))}
          </span>
          <button onClick={() => setMuted((m) => !m)} className="pill-glass !h-8 !w-8 shrink-0 !p-0" aria-label={muted ? "Unmute" : "Mute"}>
            {muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
          </button>
          <input type="range" min={0} max={1} step={0.05} value={volume} onChange={(e) => setVolume(Number(e.target.value))} className="w-20 shrink-0 accent-teal" aria-label="Volume" />
        </div>
      )}
      {src?.kind === "clip" && kind === "image" && <p className="mt-2 text-center font-mono text-[11px] text-ink-3">Still · held {src.clip.outSec}s</p>}
    </section>
  );
}
