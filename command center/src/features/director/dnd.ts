/**
 * HTML5 drag-and-drop + ingest helpers shared by the bin, the shot list and the timeline.
 * (Native OS file drop stays off app-wide: dropped files arrive as HTML5 `File`s.)
 */
import type { DragEvent } from "react";
import { useToasts } from "@/features/reminders/notify";
import type { AssetRole, MediaAsset, MediaKind } from "./contract";
import { ingestFile } from "./api";
import { addAssets, setUpload, useDirector } from "./director-store";
import { roleForKind } from "./manifest";

export const ASSET_MIME = "application/x-director-asset";
export const CLIP_MIME = "application/x-director-clip";

export const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes("Files");
export const hasType = (e: DragEvent, t: string) => Array.from(e.dataTransfer.types).includes(t);

const EXT: Record<MediaKind, string[]> = {
  video: ["mp4", "mov", "m4v", "mkv", "webm", "avi"],
  image: ["png", "jpg", "jpeg", "webp", "gif", "bmp"],
  audio: ["mp3", "wav", "m4a", "aac", "ogg", "opus", "flac"],
};

export const DIALOG_FILTERS = [
  { name: "Media", extensions: [...EXT.video, ...EXT.image, ...EXT.audio] },
  { name: "Video", extensions: EXT.video },
  { name: "Images", extensions: EXT.image },
  { name: "Audio", extensions: EXT.audio },
];

export function kindOfFile(f: Pick<File, "name" | "type">): MediaKind | null {
  if (f.type.startsWith("video/")) return "video";
  if (f.type.startsWith("image/")) return "image";
  if (f.type.startsWith("audio/")) return "audio";
  const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
  return (Object.keys(EXT) as MediaKind[]).find((k) => EXT[k].includes(ext)) ?? null;
}

/** Stream dropped files into raw/ one after another (progress in the store). Returns the new assets. */
export async function ingestDropped(slug: string, files: File[], role: AssetRole): Promise<MediaAsset[]> {
  const out: MediaAsset[] = [];
  for (const f of files) {
    const kind = kindOfFile(f);
    if (!kind) {
      useToasts.getState().push({ title: "Skipped", body: `${f.name} isn't a video, image or audio file.`, tone: "warn" });
      continue;
    }
    const key = `drop-${f.name}-${f.size}-${Date.now()}`;
    setUpload(key, { name: f.name, received: 0, total: f.size });
    try {
      const a = await ingestFile(slug, f, roleForKind(kind, role), (received, total) => setUpload(key, { name: f.name, received, total }));
      out.push(a);
      addAssets([a]);
    } catch (e) {
      useToasts.getState().push({ title: `Couldn't stage ${f.name}`, body: e instanceof Error ? e.message : String(e), tone: "error" });
    } finally {
      setUpload(key, null);
    }
  }
  return out;
}

/** The asset dragged from the bin (by id), if it belongs to the open project. */
export function draggedAsset(e: DragEvent): MediaAsset | null {
  const id = e.dataTransfer.getData(ASSET_MIME);
  return id ? (useDirector.getState().assets.find((a) => a.id === id) ?? null) : null;
}
