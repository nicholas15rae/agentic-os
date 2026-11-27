import { useEffect, useRef, useState } from "react";
import { AlignEndHorizontal, AlignStartHorizontal, FileCheck2, Loader2, Music, Trash2 } from "lucide-react";
import { Chip, Select } from "@/components/ui";
import type { MediaAsset, TimelineClip, TimelineManifest } from "./contract";
import { editManifest, requestPlan, seekTo, select, useDirector } from "./director-store";
import { ASSET_MIME, CLIP_MIME, draggedAsset, hasType } from "./dnd";
import {
  ASPECTS,
  FADE_MAX,
  LUFS,
  MIN_CLIP,
  STILL_MAX,
  STILL_MIN,
  addAudio,
  addClip,
  clipLength,
  isStill,
  removeAudio,
  removeClip,
  reorderClip,
  setClipAudioVolume,
  setClipFade,
  setOutput,
  snapClip,
  timecode,
  timelineLength,
  trimClip,
  updateAudio,
} from "./manifest";
import { markerLeftPx, noteMarkers, type NoteMarker } from "./review-ui";
import { Thumb } from "./StagingBin";
import { VoiceoverRecorder } from "./VoiceoverRecorder";

const num = (v: string) => (v.trim() === "" ? NaN : Number(v));
const NO_NOTES: TimelineManifest["notes"] = [];
/** Gap between clip boxes in the strip (gap-1.5). */
const STRIP_GAP_PX = 6;

/** A clip box's drawn width: its share of 640 px, clamped to 72–220 px. Pure. */
export function clipBoxWidth(c: Pick<TimelineClip, "inSec" | "outSec">, totalSec: number): number {
  return Math.max(72, Math.min(220, totalSec ? (clipLength(c) / totalSec) * 640 : 96));
}

/** Markers closer than this (px, or 1% of the strip without `leftPx`) draw as one marker with a count. */
export const MARKER_MERGE_PX = 12;

/** Pure: group markers that would overlap (sorted by position). Each group seeks to its first note. */
export function clusterMarkers(markers: NoteMarker[], leftPx?: (x: number) => number): { pos: number; items: NoteMarker[] }[] {
  const at = (m: NoteMarker) => (leftPx ? leftPx(m.x) : m.x);
  const gap = leftPx ? MARKER_MERGE_PX : 0.01;
  const out: { pos: number; items: NoteMarker[] }[] = [];
  for (const m of [...markers].sort((x, y) => at(x) - at(y))) {
    const last = out[out.length - 1];
    if (last && at(m) - last.pos < gap) last.items.push(m);
    else out.push({ pos: at(m), items: [m] });
  }
  return out;
}

/** The note lane above the clip strip: one amber dot per timed note (hollow on a render, faded when
 * resolved), each on a 20 px hit target; notes that would overlap merge into one dot with a count.
 * Click seeks the preview to the (first) note. `leftPx` places a marker against the real clip boxes;
 * without it, markers sit by percentage. Null when there are no markers. Props only. */
export function NoteMarkersView({ markers, onSeek, leftPx }: { markers: NoteMarker[]; onSeek: (m: NoteMarker) => void; leftPx?: (x: number) => number }) {
  if (!markers.length) return null;
  return (
    <div className="relative h-5 w-full" role="group" aria-label="Note markers">
      {clusterMarkers(markers, leftPx).map(({ pos, items }) => {
        const m = items[0];
        const one = (n: NoteMarker) => `Note at ${timecode(n.atSec)}${n.onRender ? " on the render" : ""}: ${n.text}`;
        const label = items.length === 1 ? one(m) : `${items.length} notes from ${timecode(m.atSec)}: ${items.map((n) => n.text).join("; ")}`;
        const resolved = items.every((n) => n.resolved);
        return (
          <button
            key={m.id}
            type="button"
            onClick={() => onSeek(m)}
            style={leftPx ? { left: pos } : { left: `${pos * 100}%` }}
            className={`absolute top-0 grid size-5 -translate-x-1/2 place-items-center rounded-full ${resolved ? "opacity-40" : ""}`}
            title={items.length === 1 ? label : items.map(one).join("\n")}
            aria-label={label}
            data-marker={m.onRender ? "render" : "timeline"}
            data-count={items.length > 1 ? items.length : undefined}
          >
            {items.length === 1 ? (
              <span className={`size-2 rounded-full ${m.onRender ? "border border-amber bg-transparent" : "bg-amber"}`} />
            ) : (
              <span className="grid size-3.5 place-items-center rounded-full bg-amber font-mono fs-8 leading-none text-black">{items.length}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function MiniTimeline() {
  const manifest = useDirector((s) => s.manifest);
  const assets = useDirector((s) => s.assets);
  const selection = useDirector((s) => s.selection);
  const playhead = useDirector((s) => s.playhead);
  const planBusy = useDirector((s) => s.planBusy);
  const saving = useDirector((s) => s.saving);
  const focus = useDirector((s) => s.focus);
  const renders = useDirector((s) => s.renders);
  const box = useRef<HTMLElement>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);

  useEffect(() => {
    if (focus?.target === "timeline") box.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focus]);

  if (!manifest) return null;
  const byId = new Map(assets.map((a) => [a.id, a]));
  const total = timelineLength(manifest);
  const selClip = selection?.kind === "clip" ? manifest.clips.find((c) => c.id === selection.id) : undefined;
  const audioAssets = assets.filter((a) => a.kind === "audio");
  const markers = noteMarkers(manifest.notes ?? NO_NOTES, manifest, total, renders);
  const boxes = manifest.clips.map((c) => ({ widthPx: clipBoxWidth(c, total), sec: clipLength(c) }));

  const dropAt = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    setOverIdx(null);
    if (hasType(e, CLIP_MIME)) {
      const from = Number(e.dataTransfer.getData(CLIP_MIME));
      if (Number.isInteger(from)) editManifest((m) => reorderClip(m, from, Math.min(index, m.clips.length - 1)));
    } else {
      const a = draggedAsset(e);
      if (a) editManifest((m) => (a.kind === "audio" ? addAudio(m, a, useDirector.getState().playhead) : addClip(m, a, index)));
    }
    setDragFrom(null);
  };
  const accepts = (e: React.DragEvent) => hasType(e, CLIP_MIME) || hasType(e, ASSET_MIME);

  return (
    <section ref={box} className={`glass r-20 p-4 ${focus?.target === "timeline" ? "ring-1 ring-amber/40" : ""}`}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="label-caps text-amber-soft">Timeline</h2>
        <span className="font-mono fs-11 text-ink-3">
          {manifest.clips.length} clips · {timecode(total)} · playhead {timecode(playhead)} · rev {manifest.revision}
          {saving ? " · saving…" : ""}
        </span>
        <button onClick={() => void requestPlan("nic")} disabled={!manifest.clips.length || planBusy} className="pill-glass ml-auto !h-8 !px-3 text-xs disabled:opacity-50" title="Build a render plan from the saved timeline (you approve it before anything renders)">
          {planBusy ? <Loader2 size={12} className="animate-spin" /> : <FileCheck2 size={12} />} Render plan
        </button>
      </div>

      {/* Clip strip: drag to reorder; drop assets from the bin to insert. The note lane sits above
          it inside the same scroller, so markers stay over their clips. */}
      <div
        className="well overflow-x-auto r-14 p-1.5"
        onDragOver={(e) => accepts(e) && e.preventDefault()}
        onDrop={(e) => accepts(e) && dropAt(e, manifest.clips.length)}
      >
        <div className="flex w-max min-w-full flex-col gap-1">
        <NoteMarkersView markers={markers} onSeek={(m) => seekTo(m.target.sel, m.target.sec)} leftPx={(x) => markerLeftPx(x, boxes, STRIP_GAP_PX)} />
        <div className="flex min-h-[64px] gap-1.5">
        {manifest.clips.length === 0 && <p className="m-auto fs-12 text-ink-3">Drag clips here from the bin, or Assemble with the Director.</p>}
        {manifest.clips.map((c, i) => {
          const a = byId.get(c.assetId);
          const on = selClip?.id === c.id;
          const w = boxes[i].widthPx;
          return (
            <div
              key={c.id}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(CLIP_MIME, String(i));
                e.dataTransfer.effectAllowed = "move";
                setDragFrom(i);
              }}
              onDragEnd={() => {
                setDragFrom(null);
                setOverIdx(null);
              }}
              onDragOver={(e) => {
                if (!accepts(e)) return;
                e.preventDefault();
                e.stopPropagation();
                setOverIdx(i);
              }}
              onDrop={(e) => {
                e.stopPropagation();
                if (accepts(e)) dropAt(e, i);
              }}
              onClick={() => select({ kind: "clip", id: c.id })}
              style={{ width: w }}
              className={`relative flex shrink-0 cursor-grab flex-col gap-1 r-10 border p-1 active:cursor-grabbing ${on ? "border-amber/60 bg-amber/10" : "border-white/10 bg-white/[0.03]"} ${dragFrom === i ? "opacity-40" : ""} ${overIdx === i && dragFrom !== i ? "ring-1 ring-teal/70" : ""}`}
              title={a?.name}
            >
              {a ? <Thumb asset={a} className="h-9 w-full" /> : <div className="h-9 r-8 bg-alert/20" />}
              <span className="truncate fs-10 text-ink-2">
                {a?.role === "slate" || a?.role === "outro" ? "▣ " : ""}
                {a?.name ?? "missing asset"}
              </span>
              <span className="font-mono fs-9 text-ink-3">{clipLength(c).toFixed(2)}s</span>
            </div>
          );
        })}
        </div>
        </div>
      </div>

      {selClip && <ClipEditor clip={selClip} asset={byId.get(selClip.assetId)} index={manifest.clips.indexOf(selClip)} count={manifest.clips.length} />}

      {/* Audio lane */}
      <div className="mt-4">
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          <span className="label-caps text-ink-3">Audio</span>
          {audioAssets.length > 0 && (
            <Select
              value=""
              onChange={(e) => {
                const a = byId.get(e.target.value);
                if (a) editManifest((m) => addAudio(m, a, playhead));
              }}
              className="!h-8 !w-auto max-w-[200px] !py-0 fs-12"
              aria-label="Add an audio layer at the playhead"
            >
              <option value="">+ Add audio at playhead</option>
              {audioAssets.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.role}: {a.name}
                </option>
              ))}
            </Select>
          )}
          <VoiceoverRecorder />
          <label className="ml-auto flex items-center gap-1.5 fs-11 text-ink-2" title="Camera audio under the voiceover / music">
            Clip audio
            <input type="range" min={0} max={2} step={0.05} value={manifest.clipAudioVolume} onChange={(e) => editManifest((m) => setClipAudioVolume(m, Number(e.target.value)))} className="w-20 accent-teal" aria-label="Clip audio volume" />
            <span className="w-8 font-mono">{manifest.clipAudioVolume.toFixed(2)}</span>
          </label>
        </div>
        {manifest.audio.length ? (
          <ul className="space-y-1.5">
            {manifest.audio.map((l) => {
              const a = byId.get(l.assetId);
              return (
                <li key={l.id} className="flex flex-wrap items-center gap-2 r-10 border border-white/[0.08] bg-white/[0.02] px-2 py-1.5 fs-11">
                  <Music size={12} className="text-teal" />
                  <span className="min-w-0 flex-1 truncate text-ink-2" title={a?.name}>
                    {a?.role ?? "audio"} · {a?.name ?? "missing asset"}
                  </span>
                  <label className="flex items-center gap-1 text-ink-3">
                    at
                    <input type="number" min={0} step={0.1} value={l.startSec} onChange={(e) => editManifest((m) => updateAudio(m, l.id, { startSec: num(e.target.value) || 0 }, assets))} className="field !h-7 !w-16 !py-0 font-mono !fs-11" aria-label="Start offset (s)" />s
                  </label>
                  <label className="flex items-center gap-1 text-ink-3">
                    vol
                    <input type="range" min={0} max={2} step={0.05} value={l.volume} onChange={(e) => editManifest((m) => updateAudio(m, l.id, { volume: Number(e.target.value) }, assets))} className="w-16 accent-teal" aria-label="Layer volume" />
                    <span className="w-7 font-mono">{l.volume.toFixed(2)}</span>
                  </label>
                  <button onClick={() => editManifest((m) => removeAudio(m, l.id))} className="grid size-6 place-items-center rounded-full text-ink-3 hover:text-alert" aria-label="Remove audio layer">
                    <Trash2 size={11} />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="fs-11 text-ink-3">No voiceover or music yet.</p>
        )}
      </div>

      <OutputSettings output={manifest.output} />
    </section>
  );
}

function ClipEditor({ clip, asset, index, count }: { clip: TimelineClip; asset: MediaAsset | undefined; index: number; count: number }) {
  const assets = useDirector((s) => s.assets);
  const trim = (i: number, o: number) => editManifest((m) => trimClip(m, clip.id, i, o, assets));
  const still = isStill(asset);
  const dur = asset?.durationSec ?? Math.max(clip.outSec, 1);
  const pct = (v: number) => (dur ? (v / dur) * 100 : 0);
  return (
    <div className="mt-3 r-14 border border-white/[0.08] bg-white/[0.02] p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate fs-13 text-ink">
          #{index + 1} · {asset?.name ?? "missing asset"}
        </span>
        <button onClick={() => editManifest((m) => snapClip(m, clip.id, "start"))} disabled={index === 0} className="pill-glass !h-7 !px-2 fs-11 disabled:opacity-40" title="Snap to the start (slate)">
          <AlignStartHorizontal size={11} /> Start
        </button>
        <button onClick={() => editManifest((m) => snapClip(m, clip.id, "end"))} disabled={index === count - 1} className="pill-glass !h-7 !px-2 fs-11 disabled:opacity-40" title="Snap to the end (outro slate)">
          <AlignEndHorizontal size={11} /> End
        </button>
        <button
          onClick={() => {
            editManifest((m) => removeClip(m, clip.id));
            select(null);
          }}
          className="pill-glass !h-7 !px-2 fs-11 hover:!border-alert/50"
        >
          <Trash2 size={11} /> Remove
        </button>
      </div>
      {still ? (
        <label className="flex items-center gap-2 text-xs text-ink-2">
          Hold
          <input type="range" min={STILL_MIN} max={STILL_MAX} step={0.1} value={clip.outSec} onChange={(e) => trim(0, Number(e.target.value))} className="flex-1 accent-amber" aria-label="Hold seconds" />
          <input type="number" min={STILL_MIN} max={STILL_MAX} step={0.1} value={clip.outSec} onChange={(e) => trim(0, num(e.target.value))} className="field !h-7 !w-20 !py-0 font-mono !fs-12" aria-label="Hold seconds (number)" />s
        </label>
      ) : (
        <>
          <div className="relative h-10 overflow-hidden r-8 bg-white/[0.03]">
            <div className="absolute inset-y-0 bg-teal/25" style={{ left: `${pct(clip.inSec)}%`, width: `${pct(clip.outSec - clip.inSec)}%` }} />
            <div className="pointer-events-none absolute inset-y-0 border-l-2 border-amber" style={{ left: `${pct(clip.inSec)}%` }} />
            <div className="pointer-events-none absolute inset-y-0 border-l-2 border-amber" style={{ left: `${pct(clip.outSec)}%` }} />
            {/* Two overlaid range inputs = dual-handle trimmer (only the thumbs take pointer events). */}
            <input type="range" min={0} max={dur} step={0.01} value={clip.inSec} aria-label="In point" onChange={(e) => trim(Math.min(Number(e.target.value), clip.outSec - MIN_CLIP), clip.outSec)} className="trim-range absolute inset-0 w-full" />
            <input type="range" min={0} max={dur} step={0.01} value={clip.outSec} aria-label="Out point" onChange={(e) => trim(clip.inSec, Math.max(Number(e.target.value), clip.inSec + MIN_CLIP))} className="trim-range absolute inset-0 w-full" />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-ink-2">
            <label className="flex items-center gap-1">
              In
              <input type="number" min={0} max={dur} step={0.01} value={clip.inSec} onChange={(e) => trim(num(e.target.value), clip.outSec)} className="field !h-7 !w-20 !py-0 font-mono !fs-12" aria-label="In point (s)" />s
            </label>
            <label className="flex items-center gap-1">
              Out
              <input type="number" min={0} max={dur} step={0.01} value={clip.outSec} onChange={(e) => trim(clip.inSec, num(e.target.value))} className="field !h-7 !w-20 !py-0 font-mono !fs-12" aria-label="Out point (s)" />s
            </label>
            <span className="font-mono text-ink-3">
              {timecode(clip.inSec)} → {timecode(clip.outSec)} of {timecode(dur)}
            </span>
          </div>
        </>
      )}
      <label className="mt-2 flex items-center gap-2 text-xs text-ink-2">
        Fade
        <input type="range" min={0} max={FADE_MAX} step={50} value={clip.fadeMs} onChange={(e) => editManifest((m) => setClipFade(m, clip.id, Number(e.target.value)))} className="w-32 accent-amber" aria-label="Fade (ms)" />
        <span className="font-mono">{clip.fadeMs}ms</span>
      </label>
    </div>
  );
}

function OutputSettings({ output }: { output: TimelineManifest["output"] }) {
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-3">
      <span className="label-caps text-ink-3">Output</span>
      <Select value={output.aspect} onChange={(e) => editManifest((m) => setOutput(m, { aspect: e.target.value as TimelineManifest["output"]["aspect"] }))} className="!h-8 !w-auto !py-0 fs-12" aria-label="Aspect ratio">
        {ASPECTS.map((a) => (
          <option key={a} value={a}>
            {a}
          </option>
        ))}
      </Select>
      {LUFS.map((l) => (
        <Chip key={l} active={output.loudnessLufs === l} onClick={() => editManifest((m) => setOutput(m, { loudnessLufs: l }))} tone="teal">
          {l} LUFS
        </Chip>
      ))}
      <label className="flex items-center gap-1 fs-11 text-ink-2">
        ≤
        <input
          type="number"
          min={1}
          step={1}
          value={output.maxSizeMb ?? ""}
          placeholder="no cap"
          onChange={(e) => editManifest((m) => setOutput(m, { maxSizeMb: e.target.value.trim() === "" ? null : Number(e.target.value) }))}
          className="field !h-8 !w-20 !py-0 font-mono !fs-12"
          aria-label="Max size (MB)"
        />
        MB
      </label>
      <NameField name={output.name} />
    </div>
  );
}

/** Output name: edited locally, cleaned + saved on blur / Enter (so clearing it to retype works). */
function NameField({ name }: { name: string }) {
  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft(name), [name]);
  const commit = () => draft !== name && editManifest((m) => setOutput(m, { name: draft }));
  return (
    <input
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
      className="field !h-8 !w-44 !py-0 font-mono !fs-12"
      aria-label="Output name"
    />
  );
}
