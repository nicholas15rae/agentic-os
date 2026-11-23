import { useEffect, useRef, useState } from "react";
import { AlignEndHorizontal, AlignStartHorizontal, FileCheck2, Loader2, Music, Trash2 } from "lucide-react";
import { Chip, Select } from "@/components/ui";
import type { MediaAsset, TimelineClip, TimelineManifest } from "./contract";
import { editManifest, requestPlan, select, useDirector } from "./director-store";
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
import { Thumb } from "./StagingBin";
import { VoiceoverRecorder } from "./VoiceoverRecorder";

const num = (v: string) => (v.trim() === "" ? NaN : Number(v));

export function MiniTimeline() {
  const manifest = useDirector((s) => s.manifest);
  const assets = useDirector((s) => s.assets);
  const selection = useDirector((s) => s.selection);
  const playhead = useDirector((s) => s.playhead);
  const planBusy = useDirector((s) => s.planBusy);
  const saving = useDirector((s) => s.saving);
  const focus = useDirector((s) => s.focus);
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
    <section ref={box} className={`glass rounded-[20px] p-4 ${focus?.target === "timeline" ? "ring-1 ring-amber/40" : ""}`}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="label-caps text-amber-soft">Timeline</h2>
        <span className="font-mono text-[11px] text-ink-3">
          {manifest.clips.length} clips · {timecode(total)} · playhead {timecode(playhead)} · rev {manifest.revision}
          {saving ? " · saving…" : ""}
        </span>
        <button onClick={() => void requestPlan("nic")} disabled={!manifest.clips.length || planBusy} className="pill-glass ml-auto !h-8 !px-3 text-xs disabled:opacity-50" title="Build a render plan from the saved timeline (you approve it before anything renders)">
          {planBusy ? <Loader2 size={12} className="animate-spin" /> : <FileCheck2 size={12} />} Render plan
        </button>
      </div>

      {/* Clip strip: drag to reorder; drop assets from the bin to insert. */}
      <div
        className="well flex min-h-[76px] gap-1.5 overflow-x-auto rounded-[14px] p-1.5"
        onDragOver={(e) => accepts(e) && e.preventDefault()}
        onDrop={(e) => accepts(e) && dropAt(e, manifest.clips.length)}
      >
        {manifest.clips.length === 0 && <p className="m-auto text-[12px] text-ink-3">Drag clips here from the bin, or Assemble with the Director.</p>}
        {manifest.clips.map((c, i) => {
          const a = byId.get(c.assetId);
          const on = selClip?.id === c.id;
          const w = Math.max(72, Math.min(220, total ? (clipLength(c) / total) * 640 : 96));
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
              className={`relative flex shrink-0 cursor-grab flex-col gap-1 rounded-[10px] border p-1 active:cursor-grabbing ${on ? "border-amber/60 bg-amber/10" : "border-white/10 bg-white/[0.03]"} ${dragFrom === i ? "opacity-40" : ""} ${overIdx === i && dragFrom !== i ? "ring-1 ring-teal/70" : ""}`}
              title={a?.name}
            >
              {a ? <Thumb asset={a} className="h-9 w-full" /> : <div className="h-9 rounded-[8px] bg-alert/20" />}
              <span className="truncate text-[10px] text-ink-2">
                {a?.role === "slate" || a?.role === "outro" ? "▣ " : ""}
                {a?.name ?? "missing asset"}
              </span>
              <span className="font-mono text-[9px] text-ink-3">{clipLength(c).toFixed(2)}s</span>
            </div>
          );
        })}
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
              className="!h-8 !w-auto max-w-[200px] !py-0 text-[12px]"
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
          <label className="ml-auto flex items-center gap-1.5 text-[11px] text-ink-2" title="Camera audio under the voiceover / music">
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
                <li key={l.id} className="flex flex-wrap items-center gap-2 rounded-[10px] border border-white/[0.08] bg-white/[0.02] px-2 py-1.5 text-[11px]">
                  <Music size={12} className="text-teal" />
                  <span className="min-w-0 flex-1 truncate text-ink-2" title={a?.name}>
                    {a?.role ?? "audio"} · {a?.name ?? "missing asset"}
                  </span>
                  <label className="flex items-center gap-1 text-ink-3">
                    at
                    <input type="number" min={0} step={0.1} value={l.startSec} onChange={(e) => editManifest((m) => updateAudio(m, l.id, { startSec: num(e.target.value) || 0 }, assets))} className="field !h-7 !w-16 !py-0 font-mono !text-[11px]" aria-label="Start offset (s)" />s
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
          <p className="text-[11px] text-ink-3">No voiceover or music yet.</p>
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
    <div className="mt-3 rounded-[14px] border border-white/[0.08] bg-white/[0.02] p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
          #{index + 1} · {asset?.name ?? "missing asset"}
        </span>
        <button onClick={() => editManifest((m) => snapClip(m, clip.id, "start"))} disabled={index === 0} className="pill-glass !h-7 !px-2 text-[11px] disabled:opacity-40" title="Snap to the start (slate)">
          <AlignStartHorizontal size={11} /> Start
        </button>
        <button onClick={() => editManifest((m) => snapClip(m, clip.id, "end"))} disabled={index === count - 1} className="pill-glass !h-7 !px-2 text-[11px] disabled:opacity-40" title="Snap to the end (outro slate)">
          <AlignEndHorizontal size={11} /> End
        </button>
        <button
          onClick={() => {
            editManifest((m) => removeClip(m, clip.id));
            select(null);
          }}
          className="pill-glass !h-7 !px-2 text-[11px] hover:!border-alert/50"
        >
          <Trash2 size={11} /> Remove
        </button>
      </div>
      {still ? (
        <label className="flex items-center gap-2 text-xs text-ink-2">
          Hold
          <input type="range" min={STILL_MIN} max={STILL_MAX} step={0.1} value={clip.outSec} onChange={(e) => trim(0, Number(e.target.value))} className="flex-1 accent-amber" aria-label="Hold seconds" />
          <input type="number" min={STILL_MIN} max={STILL_MAX} step={0.1} value={clip.outSec} onChange={(e) => trim(0, num(e.target.value))} className="field !h-7 !w-20 !py-0 font-mono !text-[12px]" aria-label="Hold seconds (number)" />s
        </label>
      ) : (
        <>
          <div className="relative h-10 overflow-hidden rounded-[8px] bg-white/[0.03]">
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
              <input type="number" min={0} max={dur} step={0.01} value={clip.inSec} onChange={(e) => trim(num(e.target.value), clip.outSec)} className="field !h-7 !w-20 !py-0 font-mono !text-[12px]" aria-label="In point (s)" />s
            </label>
            <label className="flex items-center gap-1">
              Out
              <input type="number" min={0} max={dur} step={0.01} value={clip.outSec} onChange={(e) => trim(clip.inSec, num(e.target.value))} className="field !h-7 !w-20 !py-0 font-mono !text-[12px]" aria-label="Out point (s)" />s
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
      <Select value={output.aspect} onChange={(e) => editManifest((m) => setOutput(m, { aspect: e.target.value as TimelineManifest["output"]["aspect"] }))} className="!h-8 !w-auto !py-0 text-[12px]" aria-label="Aspect ratio">
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
      <label className="flex items-center gap-1 text-[11px] text-ink-2">
        ≤
        <input
          type="number"
          min={1}
          step={1}
          value={output.maxSizeMb ?? ""}
          placeholder="no cap"
          onChange={(e) => editManifest((m) => setOutput(m, { maxSizeMb: e.target.value.trim() === "" ? null : Number(e.target.value) }))}
          className="field !h-8 !w-20 !py-0 font-mono !text-[12px]"
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
      className="field !h-8 !w-44 !py-0 font-mono !text-[12px]"
      aria-label="Output name"
    />
  );
}
