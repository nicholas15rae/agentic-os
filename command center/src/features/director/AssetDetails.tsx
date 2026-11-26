import { useEffect, useState } from "react";
import { FileText, Loader2, Plus, Tag, TriangleAlert, X } from "lucide-react";
import { fileSrc } from "./api";
import type { MediaAsset } from "./contract";
import { MAX_TAGS, TAG_MAX_CHARS, cleanTags, seekTo, setAssetTags } from "./director-store";
import { timecode } from "./manifest";
import { FLAG_LABEL, shotCount, transcriptFile, transcriptLines, type TranscriptLine } from "./review-ui";

/** The one-line badges under an asset's name: flags as warnings, the shot count, the transcript size. Props only. */
export function AssetBadges({ asset }: { asset: MediaAsset }) {
  const shots = asset.kind === "video" ? shotCount(asset.scenes) : null;
  return (
    <>
      {asset.flags.map((f) => (
        <span key={f.kind} className="flex items-center gap-0.5 rounded-full border border-amber/40 px-1.5 text-[10px] text-amber-soft" title={f.detail}>
          <TriangleAlert size={9} /> {FLAG_LABEL[f.kind] ?? f.kind}
        </span>
      ))}
      {shots && <span className="rounded-full border border-white/10 px-1.5 font-mono text-[10px] text-ink-2">{shots}</span>}
      {asset.transcript && (
        <span className="flex items-center gap-0.5 rounded-full border border-white/10 px-1.5 font-mono text-[10px] text-ink-2" title="Transcribed">
          <FileText size={9} /> {asset.transcript.words}w
        </span>
      )}
    </>
  );
}

/** Tags as removable chips plus an add field (media_asset_update). Props only. */
export function TagEditor({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => void }) {
  const [text, setText] = useState("");
  const add = () => {
    const next = cleanTags([...tags, ...text.split(",")]);
    setText("");
    if (next.join() !== tags.join()) onChange(next);
  };
  return (
    <div className="flex flex-wrap items-center gap-1" aria-label="Tags">
      <Tag size={11} className="text-ink-3" />
      {tags.map((t) => (
        <span key={t} className="flex h-6 items-center gap-0.5 rounded-full border border-teal/30 pl-2 pr-0.5 text-[11px] text-teal-soft">
          {t}
          <button onClick={() => onChange(tags.filter((x) => x !== t))} className="grid size-5 place-items-center rounded-full hover:bg-white/10" aria-label={`Remove tag ${t}`}>
            <X size={9} />
          </button>
        </span>
      ))}
      {tags.length < MAX_TAGS && (
        <form
          className="flex items-center"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <input value={text} onChange={(e) => setText(e.target.value)} maxLength={TAG_MAX_CHARS * 3} placeholder="add tag" className="h-6 w-20 rounded-full border border-white/10 bg-transparent px-2 text-[11px] text-ink outline-none placeholder:text-ink-3 focus:border-teal/50" aria-label="New tag" />
          <button type="submit" disabled={!text.trim()} className="ml-0.5 grid size-6 place-items-center rounded-full border border-white/10 text-ink-2 disabled:opacity-40" aria-label="Add tag">
            <Plus size={10} />
          </button>
        </form>
      )}
    </div>
  );
}

/** Reads the transcript JSON through the asset protocol; shows the summary only when it can't. */
function TranscriptLines({ path, assetId }: { path: string; assetId: string }) {
  const [lines, setLines] = useState<TranscriptLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const url = fileSrc(path);
    if (!url) {
      setError("Transcripts open in the desktop app only.");
      return;
    }
    fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: unknown) => alive && setLines(transcriptLines(j)))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [path]);
  if (error) return <p className="text-[11px] text-ink-3">Couldn't read the transcript file ({error}).</p>;
  if (!lines) return <Loader2 size={12} className="animate-spin text-ink-3" />;
  if (!lines.length) return <p className="text-[11px] text-ink-3">No speech in the transcript.</p>;
  return (
    <ol className="max-h-48 space-y-0.5 overflow-y-auto pr-1">
      {lines.map((l, i) => (
        <li key={i} className="flex gap-1.5 text-[11px]">
          <button onClick={() => seekTo({ kind: "asset", id: assetId }, l.start)} className="shrink-0 font-mono text-[10px] text-teal-soft hover:underline" title="Play from here">
            {timecode(l.start)}
          </button>
          <span className="min-w-0 flex-1 text-ink-2">{l.text}</span>
        </li>
      ))}
    </ol>
  );
}

/** The expanded asset: tags, transcript, moments and scene cuts. */
export function AssetDetails({ asset, projectRoot }: { asset: MediaAsset; projectRoot: string | null }) {
  const [showText, setShowText] = useState(false);
  const t = asset.transcript;
  const file = transcriptFile(asset, projectRoot);
  const cuts = asset.scenes ?? [];
  return (
    <div className="mt-1.5 space-y-2 rounded-[10px] bg-white/[0.02] p-2">
      <TagEditor tags={asset.tags} onChange={(tags) => void setAssetTags(asset.id, tags)} />
      {t ? (
        <div>
          <p className="text-[11px] text-ink-2">
            Transcript · {t.lang} · {t.words} words
            {t.firstSpeechSec != null && t.lastSpeechSec != null ? ` · speech ${timecode(t.firstSpeechSec)}–${timecode(t.lastSpeechSec)}` : ""}
          </p>
          {file && (
            <button onClick={() => setShowText((v) => !v)} className="mt-0.5 text-[11px] text-teal-soft hover:underline" aria-expanded={showText}>
              {showText ? "Hide transcript" : "View transcript"}
            </button>
          )}
          {showText && file && (
            <div className="mt-1">
              <TranscriptLines path={file} assetId={asset.id} />
            </div>
          )}
        </div>
      ) : (
        asset.kind !== "image" && <p className="text-[11px] text-ink-3">Not transcribed yet.</p>
      )}
      {asset.moments.length > 0 && (
        <div>
          <p className="label-caps text-ink-3">Moments</p>
          <ul className="mt-0.5 space-y-0.5">
            {asset.moments.map((m) => (
              <li key={m.id}>
                <button onClick={() => seekTo({ kind: "asset", id: asset.id }, m.inSec)} className="flex w-full items-center gap-1.5 text-left text-[11px] hover:text-ink" title="Play this moment">
                  <span className="shrink-0 font-mono text-[10px] text-teal-soft">
                    {timecode(m.inSec)}–{timecode(m.outSec)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-ink-2">{m.label}</span>
                  <span className="shrink-0 font-mono text-[10px] text-ink-3">
                    {Math.round(m.score * 100)}% · {m.by === "nic" ? "you" : "Director"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {asset.kind === "video" && asset.scenes != null && (
        <p className="text-[11px] text-ink-2">
          {shotCount(asset.scenes)}
          {cuts.length > 0 && (
            <>
              {" · cuts at "}
              {cuts.slice(0, 8).map((c, i) => (
                <button key={c} onClick={() => seekTo({ kind: "asset", id: asset.id }, c)} className="font-mono text-[10px] text-teal-soft hover:underline">
                  {i ? ", " : ""}
                  {timecode(c)}
                </button>
              ))}
              {cuts.length > 8 ? ` +${cuts.length - 8}` : ""}
            </>
          )}
        </p>
      )}
      {asset.flags.length > 0 && (
        <ul className="space-y-0.5">
          {asset.flags.map((f) => (
            <li key={f.kind} className="flex items-start gap-1 text-[11px] text-amber-soft">
              <TriangleAlert size={10} className="mt-0.5 shrink-0" /> {FLAG_LABEL[f.kind] ?? f.kind}: {f.detail}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
