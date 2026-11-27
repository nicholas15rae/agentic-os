import { useEffect, useMemo, useRef, useState, type CSSProperties, type SyntheticEvent } from "react";
import { Pause, Play, X } from "lucide-react";
import { SubTabs } from "@/components/ui";
import { fileSrc } from "./api";
import type { AssetRole, TimelineManifest, VerifiedRender } from "./contract";
import { closeCompare, loadSnapshot, setPreviewTime, useDirector, type DirectorState } from "./director-store";
import { timecode } from "./manifest";
import { diffSummary, syncFollower, versionLabel, type DiffSummary } from "./versions";

export type CompareMode = "wipe" | "side";
interface Side {
  render: VerifiedRender;
  src: string;
  /** "v002" */
  label: string;
}

export interface CompareProps {
  a: Side;
  b: Side;
  /** local state, default "side" */
  mode: CompareMode;
  /** 0–1, a range input (clip-path: inset on B; no loop) */
  wipe: number;
  /** diffSummary(snapA, snapB) when both snapshots exist */
  diff: DiffSummary | null;
  onMode: (m: CompareMode) => void;
  onWipe: (x: number) => void;
  onClose: () => void;
  /** A's media time (timeupdate / seeked), so a note added while comparing lands at it. */
  onTimeA?: (sec: number) => void;
}

/** A/B two renders. A leads: one play button and one seek bar drive A, and A's play / pause /
 * seeked / timeupdate events move B (`syncFollower`; event-driven, no frame loop). */
export function CompareView(p: CompareProps) {
  const va = useRef<HTMLVideoElement>(null);
  const vb = useRef<HTMLVideoElement>(null);
  const [audio, setAudio] = useState<"a" | "b">("a");
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(p.a.render.durationSec || 0);

  const sync = () => {
    const a = va.current;
    const b = vb.current;
    if (!a || !b) return;
    const r = syncFollower({ paused: a.paused, currentTime: a.currentTime, duration: a.duration }, { paused: b.paused, currentTime: b.currentTime, duration: b.duration });
    if (r.seekTo != null) b.currentTime = r.seekTo;
    if (r.play === true) void b.play().catch(() => undefined);
    else if (r.play === false) b.pause();
  };
  const toggle = () => {
    const a = va.current;
    if (!a) return;
    if (a.paused) void a.play().catch(() => undefined);
    else a.pause();
  };
  // A new pair: back to the start, paused.
  useEffect(() => {
    setPlaying(false);
    setT(0);
  }, [p.a.src, p.b.src, p.mode]);

  const wipeStyle = { "--wipe": String(p.wipe) } as CSSProperties;
  const video = (s: Side, which: "a" | "b", extra = "") => (
    <video
      ref={which === "a" ? va : vb}
      key={s.src}
      src={s.src}
      preload="metadata"
      playsInline
      muted={audio !== which}
      className={`h-full w-full object-contain ${extra}`}
      aria-label={`${which.toUpperCase()}: ${s.label}`}
      data-testid={`compare-${which}`}
      {...(which === "a"
        ? {
            onLoadedMetadata: (e: SyntheticEvent<HTMLVideoElement>) => setDur(e.currentTarget.duration || p.a.render.durationSec || 0),
            onPlay: () => {
              setPlaying(true);
              sync();
            },
            onPause: () => {
              setPlaying(false);
              sync();
            },
            onSeeked: (e: SyntheticEvent<HTMLVideoElement>) => {
              p.onTimeA?.(e.currentTarget.currentTime);
              sync();
            },
            onTimeUpdate: (e: SyntheticEvent<HTMLVideoElement>) => {
              setT(e.currentTarget.currentTime);
              p.onTimeA?.(e.currentTarget.currentTime);
              sync();
            },
            onClick: toggle,
          }
        : { onClick: toggle })}
    />
  );
  const tag = (s: Side, which: "a" | "b") => (
    <span className="pointer-events-none absolute left-2 top-2 rounded-full bg-black/60 px-2 py-0.5 font-mono fs-11 text-ink">
      {which.toUpperCase()} · {s.label}
    </span>
  );

  return (
    <section className="@container glass r-20 p-4" aria-label="Compare versions">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SubTabs
          tabs={[
            { id: "side", label: "Side by side" },
            { id: "wipe", label: "Wipe" },
          ]}
          value={p.mode}
          onChange={p.onMode}
        />
        <span className="font-mono fs-11 text-ink-3">
          {p.a.label} vs {p.b.label}
        </span>
        <button onClick={p.onClose} className="pill-glass ml-auto !h-8 !px-3 text-xs" title="Back to the preview">
          <X size={12} /> Close
        </button>
      </div>
      {p.mode === "side" ? (
        <div className="grid gap-2 @xl:grid-cols-2">
          <div className="relative aspect-video overflow-hidden r-14 bg-black">
            {video(p.a, "a")}
            {tag(p.a, "a")}
          </div>
          <div className="relative aspect-video overflow-hidden r-14 bg-black">
            {video(p.b, "b")}
            {tag(p.b, "b")}
          </div>
        </div>
      ) : (
        <div className="relative aspect-video overflow-hidden r-14 bg-black" style={wipeStyle}>
          {video(p.a, "a")}
          <div className="absolute inset-0" style={{ clipPath: "inset(0 0 0 calc(var(--wipe) * 100%))" }}>
            {video(p.b, "b")}
          </div>
          {tag(p.a, "a")}
          <span className="pointer-events-none absolute right-2 top-2 rounded-full bg-black/60 px-2 py-0.5 font-mono fs-11 text-ink">B · {p.b.label}</span>
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button onClick={toggle} className="pill-glass !h-8 !w-8 shrink-0 !p-0" aria-label={playing ? "Pause both" : "Play both"}>
          {playing ? <Pause size={13} /> : <Play size={13} />}
        </button>
        <input
          type="range"
          min={0}
          max={Math.max(0.01, dur)}
          step={0.01}
          value={Math.min(t, Math.max(0.01, dur))}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (va.current) va.current.currentTime = v;
            setT(v);
          }}
          className="min-w-0 flex-1 accent-amber"
          aria-label="Seek both"
        />
        <span className="shrink-0 font-mono fs-11 tabular text-ink-2">
          {timecode(t)} / {timecode(dur)}
        </span>
        <SubTabs
          tabs={[
            { id: "a", label: "Audio A" },
            { id: "b", label: "Audio B" },
          ]}
          value={audio}
          onChange={setAudio}
        />
      </div>
      {p.mode === "wipe" && (
        <label className="mt-2 flex items-center gap-2 fs-11 text-ink-2">
          <span className="label-caps shrink-0">Wipe</span>
          <input type="range" min={0} max={1} step={0.01} value={p.wipe} onChange={(e) => p.onWipe(Number(e.target.value))} className="min-w-0 flex-1 accent-violet" aria-label="Wipe position" />
        </label>
      )}
      {p.diff && (
        <div className="well mt-3 r-12 p-2.5 fs-12">
          <p className="label-caps mb-1">
            {p.a.label} → {p.b.label}
          </p>
          <ul className="space-y-0.5 text-ink-2">
            {p.diff.lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** Both compared renders, or null when either is gone (pure). */
export function compareRenders(s: Pick<DirectorState, "compare" | "renders">): { a: VerifiedRender; b: VerifiedRender } | null {
  if (!s.compare) return null;
  const a = s.renders.find((r) => r.id === s.compare?.a);
  const b = s.renders.find((r) => r.id === s.compare?.b);
  return a && b ? { a, b } : null;
}

/** Store-connected Compare (replaces the preview while `compare` is set). */
export function Compare() {
  const compare = useDirector((s) => s.compare);
  const renders = useDirector((s) => s.renders);
  const assets = useDirector((s) => s.assets);
  const pair = useMemo(() => compareRenders({ compare, renders }), [compare, renders]);
  const [mode, setMode] = useState<CompareMode>("side");
  const [wipe, setWipe] = useState(0.5);
  const [snaps, setSnaps] = useState<{ key: string; a: TimelineManifest | null; b: TimelineManifest | null } | null>(null);
  const key = pair ? `${pair.a.id}|${pair.b.id}` : "";

  useEffect(() => {
    if (!pair) return;
    let live = true;
    Promise.all([loadSnapshot(pair.a.id), loadSnapshot(pair.b.id)])
      .then(([a, b]) => live && setSnaps({ key, a, b }))
      .catch(() => live && setSnaps({ key, a: null, b: null }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const diff = useMemo(() => {
    if (!snaps || snaps.key !== key || !snaps.a || !snaps.b) return null;
    const names = Object.fromEntries(assets.map((x) => [x.id, x.name]));
    const roles = Object.fromEntries(assets.map((x) => [x.id, x.role])) as Record<string, AssetRole>;
    return diffSummary(snaps.a, snaps.b, names, roles);
  }, [snaps, key, assets]);

  if (!pair) return null;
  return (
    <CompareView
      a={{ render: pair.a, src: fileSrc(pair.a.path), label: versionLabel(pair.a.path) }}
      b={{ render: pair.b, src: fileSrc(pair.b.path), label: versionLabel(pair.b.path) }}
      mode={mode}
      wipe={wipe}
      diff={diff}
      onMode={setMode}
      onWipe={setWipe}
      onClose={closeCompare}
      onTimeA={setPreviewTime}
    />
  );
}
