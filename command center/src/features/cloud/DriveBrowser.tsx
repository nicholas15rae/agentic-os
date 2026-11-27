import { useEffect, useState } from "react";
import { Check, ChevronRight, File, FileAudio, Folder, Image as ImageIcon, Inbox, Loader2, Search, Send, Video, X } from "lucide-react";
import type { CloudFolderRef, CloudItem, CloudListing } from "./contract";
import { browse, isMedia, loadMore, setFolder, toggleSelect, useCloud } from "./cloud-store";
import { itemMeta } from "./format";

/** My Drive root as the browser shows it before the first listing arrives. */
export const ROOT: CloudFolderRef = { id: "root", name: "My Drive" };

export function ItemIcon({ kind, size = 14 }: { kind: CloudItem["kind"]; size?: number }) {
  const I = kind === "folder" ? Folder : kind === "video" ? Video : kind === "image" ? ImageIcon : kind === "audio" ? FileAudio : File;
  return <I size={size} className={kind === "folder" ? "shrink-0 text-amber-soft" : "shrink-0 text-ink-3"} />;
}

/** Breadcrumb trail: the listing's ancestors then the folder itself. */
export const crumbs = (l: CloudListing | null): CloudFolderRef[] => (l ? [...l.parents, l.folder] : [ROOT]);

/**
 * Drive folder browser: breadcrumbs, search, folders to open, media to multi-select, "Load more",
 * and "Set as inbox / outbox" for the folder on screen. Selection lives in the cloud store.
 */
export function DriveBrowser({ startFolderId, compact = false, showOutbox = true }: { startFolderId?: string | null; compact?: boolean; showOutbox?: boolean }) {
  const listing = useCloud((s) => s.listing);
  const loading = useCloud((s) => s.listingLoading);
  const error = useCloud((s) => s.listingError);
  const selected = useCloud((s) => s.selected);
  const query = useCloud((s) => s.query);
  const status = useCloud((s) => s.status);
  const [text, setText] = useState(query);

  useEffect(() => {
    void browse(startFolderId ?? null);
    setText("");
    // Start folder only on mount (or when the saved inbox changes).
  }, [startFolderId]);

  const folder = listing?.folder ?? ROOT;
  const folderId = listing ? listing.folder.id : (startFolderId ?? null);
  const isInbox = status?.inboxFolder?.id === folder.id;
  const isOutbox = status?.outboxFolder?.id === folder.id;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <nav aria-label="Drive folders" className="flex min-w-0 flex-wrap items-center gap-0.5 fs-12">
        {crumbs(listing).map((c, i, all) => (
          <span key={`${c.id}-${i}`} className="flex min-w-0 items-center gap-0.5">
            {i > 0 && <ChevronRight size={11} className="shrink-0 text-ink-3" />}
            {i === all.length - 1 ? (
              <span className="truncate font-medium text-ink" aria-current="page">
                {c.name}
              </span>
            ) : (
              <button onClick={() => void browse(c.id === "root" ? null : c.id)} className="truncate text-ink-2 hover:text-ink">
                {c.name}
              </button>
            )}
          </span>
        ))}
      </nav>

      <div className="flex flex-wrap items-center gap-1.5">
        <form
          role="search"
          className="flex min-w-[140px] flex-1 items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            void browse(folderId, text);
          }}
        >
          <div className="relative min-w-0 flex-1">
            <Search size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search this folder" aria-label="Search Drive" className="field !h-8 !py-0 !pl-7 fs-12" />
          </div>
          {query && (
            <button
              type="button"
              onClick={() => {
                setText("");
                void browse(folderId);
              }}
              className="pill-glass !h-8 !w-8 !p-0"
              title="Clear search"
              aria-label="Clear search"
            >
              <X size={12} />
            </button>
          )}
        </form>
        {!compact && (
          <>
            <button
              onClick={() => void setFolder("inbox", folder)}
              disabled={isInbox || !listing}
              className="pill-glass !h-8 !px-2.5 fs-11 disabled:opacity-50"
              title="Remember this folder as the Drive inbox (where new footage lands)"
            >
              <Inbox size={12} /> {isInbox ? "Inbox" : "Set as inbox"}
            </button>
            {showOutbox && (
              <button onClick={() => void setFolder("outbox", folder)} disabled={isOutbox || !listing} className="pill-glass !h-8 !px-2.5 fs-11 disabled:opacity-50" title="Uploads go to this folder by default">
                <Send size={12} /> {isOutbox ? "Outbox" : "Set as outbox"}
              </button>
            )}
          </>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto r-12 border border-white/[0.06]">
        {error ? (
          <p className="p-3 fs-12 text-alert" role="alert">
            {error}
          </p>
        ) : !listing && loading ? (
          <div className="grid place-items-center p-6 text-ink-3">
            <Loader2 size={15} className="animate-spin" />
          </div>
        ) : listing && listing.items.length === 0 ? (
          <p className="p-4 text-center fs-12 text-ink-3">{query ? "Nothing matches." : "This folder is empty."}</p>
        ) : (
          <ul className="divide-y divide-white/[0.04]">
            {listing?.items.map((it) => (
              <DriveRow key={it.id} item={it} on={selected.includes(it.id)} compact={compact} />
            ))}
          </ul>
        )}
        {listing?.nextPageToken && (
          <div className="p-2 text-center">
            <button onClick={() => void loadMore()} disabled={loading} className="pill-glass !h-7 !px-3 fs-11 disabled:opacity-50">
              {loading ? <Loader2 size={11} className="animate-spin" /> : null} Load more
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function DriveRow({ item, on, compact }: { item: CloudItem; on: boolean; compact?: boolean }) {
  const media = isMedia(item);
  const meta = itemMeta(item);
  if (item.kind === "folder")
    return (
      <li>
        <button onClick={() => void browse(item.id)} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-white/5">
          <ItemIcon kind="folder" />
          <span className="min-w-0 flex-1 truncate fs-13 text-ink">{item.name}</span>
          <ChevronRight size={12} className="shrink-0 text-ink-3" />
        </button>
      </li>
    );
  return (
    <li>
      <button
        onClick={() => toggleSelect(item)}
        disabled={!media}
        aria-pressed={media ? on : undefined}
        title={media ? item.name : `${item.name} — only video, image and audio files can be imported`}
        className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left ${on ? "bg-teal/10" : media ? "hover:bg-white/5" : "cursor-not-allowed opacity-45"}`}
      >
        <span className={`grid size-4 shrink-0 place-items-center r-4 border ${on ? "border-teal bg-teal text-canvas" : "border-white/20"}`}>{on && <Check size={10} />}</span>
        <ItemIcon kind={item.kind} />
        <span className="min-w-0 flex-1 truncate fs-13 text-ink">{item.name}</span>
        {!compact && meta && <span className="shrink-0 font-mono fs-10 text-ink-3">{meta}</span>}
      </button>
    </li>
  );
}
