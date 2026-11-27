import { useState } from "react";
import { ExternalLink, Route as RouteIcon, Trash2 } from "lucide-react";
import { useSavedRoutes } from "@/lib/cc-api";
import { shortLabel } from "@/features/maps/map-geo";
import { savedOriginText } from "@/features/maps/nav";
import type { SavedDeleteState, SavedRouteRowProps, SavedRoutesProps } from "@/features/maps/contract";
import { SAVED_DELETE_IDLE, savedDeleteHandlers } from "./saved-delete";

// Contract: features/maps/contract.ts (DRAFT). The Saved tab: the synced "routes" collection
// (never in the vault / AI search). Delete always asks "Delete? Yes / No" inline first.

export function SavedRouteRow({ route: r, confirming, busy, onRoute, onOpen, onAskDelete, onConfirmDelete, onCancelDelete, compact }: SavedRouteRowProps) {
  const stops = r.stops?.length ?? 0;
  return (
    <li className="r-12 border border-white/[0.06] bg-white/[0.02] px-2.5 py-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs text-ink" title={r.name}>
          {r.name}
        </span>
        {!confirming && (
          <span className="flex shrink-0 gap-1">
            <button type="button" onClick={onRoute} disabled={busy} className="pill-glass !h-7 !px-2 fs-11" title="Draw this route on the map">
              <RouteIcon size={12} /> Route
            </button>
            <button type="button" onClick={onOpen} className="pill-glass !h-7 !px-2 fs-11" aria-label="Open in Maps" title="Turn-by-turn in Google Maps">
              <ExternalLink size={12} />
            </button>
            <button type="button" onClick={onAskDelete} disabled={busy} className="pill-glass !h-7 !px-2 fs-11" aria-label={`Delete ${r.name}`} title="Delete this saved route">
              <Trash2 size={12} />
            </button>
          </span>
        )}
        {confirming && (
          <span className="flex shrink-0 items-center gap-1 fs-11" role="group" aria-label="Confirm delete">
            <span className="text-alert">Delete?</span>
            <button type="button" onClick={onConfirmDelete} disabled={busy} className="pill-glass !h-7 !px-2 fs-11 text-alert">
              Yes
            </button>
            <button type="button" onClick={onCancelDelete} disabled={busy} className="pill-glass !h-7 !px-2 fs-11" autoFocus>
              No
            </button>
          </span>
        )}
      </div>
      {!compact && (
        <p className="mt-0.5 truncate fs-11 text-ink-3">
          to {shortLabel(r.destination.label) || "a saved place"} {savedOriginText(r.origin)}
          {stops ? ` · ${stops} stop${stops === 1 ? "" : "s"}` : ""}
        </p>
      )}
    </li>
  );
}

export default function SavedRoutes({ onRoute, onOpen, compact }: SavedRoutesProps) {
  const { items, loaded, error, remove } = useSavedRoutes();
  const [del, setDel] = useState<SavedDeleteState>(SAVED_DELETE_IDLE);
  const err = del.error;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {error && <p className="fs-11 text-alert">Saved routes: {error}</p>}
      {err && <p className="fs-11 text-alert">{err}</p>}
      {!loaded && !items.length ? (
        <p className="text-xs text-ink-3">Loading saved routes…</p>
      ) : !items.length ? (
        <p className="text-xs text-ink-3">No saved routes yet. Route somewhere on the Map tab, then press Save.</p>
      ) : (
        <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-0.5" aria-label="Saved routes">
          {items.map((r) => (
            <SavedRouteRow
              key={r.id}
              route={r}
              compact={compact}
              onRoute={() => onRoute(r)}
              onOpen={() => onOpen(r)}
              {...savedDeleteHandlers(r.id, del, setDel, remove)}
            />
          ))}
        </ul>
      )}
      <p className="fs-10 text-ink-3">Synced between your devices. Kept out of search and agents.</p>
    </div>
  );
}
