import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Columns2, History, Loader2, RotateCcw } from "lucide-react";
import { Empty } from "@/components/ui";
import type { AssetRole, TimelineManifest } from "./contract";
import { loadSnapshot, openCompare, restoreVersion, useDirector } from "./director-store";
import { timecode } from "./manifest";
import { diffSummary, sameCut, versionRows, type DiffSummary, type VersionRow } from "./versions";

export const vLabel = (n: number | null) => (n == null ? "—" : `v${String(n).padStart(3, "0")}`);
const shortPlan = (id: string) => (id.length > 10 ? `${id.slice(0, 10)}…` : id);
const day = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

export const RESTORE_CONFIRM = (label: string) => `Restore ${label}'s cut? The timeline becomes that cut; notes and the shot list stay. Undo is available.`;
export const NO_SNAPSHOT_HINT = "Made before versions were kept";

export interface VersionsProps {
  rows: VersionRow[];
  /** renderId awaiting confirm */
  confirming: string | null;
  busy: string | null;
  /** vs the working manifest, loaded on expand ("none" = no snapshot) */
  diff: Record<string, DiffSummary | "none" | "loading">;
  /** The row showing its diff. */
  expanded: string | null;
  /** first pick for Compare */
  compareA: string | null;
  onExpand: (renderId: string) => void;
  onAskRestore: (renderId: string) => void;
  onConfirmRestore: (renderId: string) => void;
  onCancel: () => void;
  /** first click marks A, second opens Compare with B */
  onCompare: (renderId: string) => void;
}

/** Past renders as versions: restore a version's cut (asks first) or compare two (pure). Restore is
 * on every version's first row; it is disabled only when that cut is already the timeline's. */
export function VersionsView(p: VersionsProps) {
  if (!p.rows.length) return <Empty>No versions yet. Each verified render becomes one.</Empty>;
  const aRow = p.rows.find((r) => r.renderId === p.compareA);
  return (
    <div className="space-y-1.5">
      {aRow && <p className="text-[11px] text-violet">Comparing from {vLabel(aRow.version)}: pick a second version.</p>}
      <ul className="space-y-1.5" aria-label="Versions">
        {p.rows.map((r) => {
          const d = p.diff[r.renderId];
          const open = p.expanded === r.renderId;
          const label = vLabel(r.version);
          const canRestore = r.primary;
          const none = d === "none";
          const same = r.current || (typeof d === "object" && d.same);
          const isA = p.compareA === r.renderId;
          return (
            <li key={r.renderId} className={`rounded-[12px] border p-2 ${isA ? "border-violet/40 bg-violet/[0.06]" : "border-white/[0.08]"}`} data-testid={`version-${r.renderId}`}>
              <div className="flex items-center gap-2">
                <button onClick={() => p.onExpand(r.renderId)} className="min-w-0 flex-1 text-left" aria-expanded={open} title="Show what changed since this version">
                  <p className="flex items-center gap-1.5 text-[13px] text-ink">
                    {open ? <ChevronDown size={12} className="shrink-0 text-ink-3" /> : <ChevronRight size={12} className="shrink-0 text-ink-3" />}
                    <span className="font-mono">{label}</span>
                    {r.current && <span className="rounded-full border border-teal/40 px-1.5 text-[10px] text-teal-soft">Current</span>}
                    <span className="truncate text-[11px] text-ink-3">{day(r.createdAt)}</span>
                  </p>
                  <p className="truncate font-mono text-[10px] text-ink-3">
                    {shortPlan(r.planId)} · {timecode(r.durationSec)} · {r.width}×{r.height}
                    {!r.primary ? " · same cut as above" : ""}
                  </p>
                </button>
                {canRestore && (
                  <button
                    onClick={() => p.onAskRestore(r.renderId)}
                    disabled={none || same || !!p.busy || p.confirming === r.renderId}
                    className="pill-glass !h-7 !px-2 shrink-0 text-[11px] disabled:opacity-50"
                    title={none ? NO_SNAPSHOT_HINT : same ? "Already the timeline's cut" : `Make ${label}'s cut the timeline (asks first)`}
                  >
                    <RotateCcw size={11} /> Restore…
                  </button>
                )}
                <button
                  onClick={() => p.onCompare(r.renderId)}
                  disabled={!!p.busy}
                  aria-pressed={isA}
                  className="pill-glass !h-7 !px-2 shrink-0 text-[11px] disabled:opacity-50"
                  title={isA ? "Picked as A (click again to unpick)" : p.compareA ? `Compare with ${vLabel(aRow?.version ?? null)}` : "Pick as A, then pick a second version"}
                >
                  <Columns2 size={11} /> {isA ? "A" : "Compare"}
                </button>
              </div>
              {canRestore && none && <p className="mt-1 text-[11px] text-ink-3">{NO_SNAPSHOT_HINT}.</p>}
              {open && (
                <div className="well mt-1.5 rounded-[10px] p-2 text-[11px]">
                  {d === "loading" || d === undefined ? (
                    <p className="flex items-center gap-1 text-ink-3">
                      <Loader2 size={11} className="animate-spin" /> Loading…
                    </p>
                  ) : d === "none" ? (
                    <p className="text-ink-3">{NO_SNAPSHOT_HINT}, so there is no cut to show.</p>
                  ) : (
                    <>
                      <p className="label-caps mb-1">Since {label}</p>
                      <ul className="space-y-0.5 text-ink-2">
                        {d.lines.map((l) => (
                          <li key={l}>{l}</li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              )}
              {p.confirming === r.renderId && (
                <div className="mt-2 rounded-[12px] border border-amber/40 bg-amber/[0.06] p-2.5" role="alertdialog" aria-label="Confirm restore">
                  <p className="text-[12px] text-ink">{RESTORE_CONFIRM(label)}</p>
                  <div className="mt-2 flex gap-1.5">
                    <button onClick={() => p.onConfirmRestore(r.renderId)} disabled={!!p.busy} className="pill-primary !h-8 !px-3 text-xs disabled:opacity-50">
                      {p.busy === r.renderId ? <Loader2 size={12} className="animate-spin" /> : <History size={12} />} Yes, restore
                    </button>
                    <button onClick={p.onCancel} disabled={!!p.busy} className="pill-glass !h-8 !px-3 text-xs">
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

type Snap = TimelineManifest | null | "loading" | "error";

/** Store-connected Versions (inside the VerifiedShelf card). */
export function Versions() {
  const slug = useDirector((s) => s.slug);
  const renders = useDirector((s) => s.renders);
  const manifest = useDirector((s) => s.manifest);
  const assets = useDirector((s) => s.assets);
  const [snaps, setSnaps] = useState<Record<string, Snap>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [compareA, setCompareA] = useState<string | null>(null);
  const requested = useRef(new Set<string>());
  // Another project: nothing picked, expanded or loaded carries over.
  useEffect(() => {
    requested.current = new Set();
    setSnaps({});
    setExpanded(null);
    setConfirming(null);
    setCompareA(null);
  }, [slug]);
  // "Current" = the versions whose cut is the working timeline's, so every snapshot is loaded
  // (cached per render; one read each).
  const currentPlans = useMemo(() => {
    const plans = new Set<string>();
    if (!manifest) return plans;
    for (const r of renders) {
      const s = snaps[r.id];
      if (s && typeof s === "object" && sameCut(s, manifest)) plans.add(r.planId);
    }
    return plans;
  }, [renders, snaps, manifest]);
  const rows = useMemo(() => versionRows(renders, currentPlans), [renders, currentPlans]);
  const pickedA = compareA && rows.some((r) => r.renderId === compareA) ? compareA : null;
  const names = useMemo(() => Object.fromEntries(assets.map((a) => [a.id, a.name])), [assets]);
  const roles = useMemo(() => Object.fromEntries(assets.map((a) => [a.id, a.role])) as Record<string, AssetRole>, [assets]);

  const diff = useMemo(() => {
    const out: VersionsProps["diff"] = {};
    for (const [id, s] of Object.entries(snaps)) {
      if (s === "loading") out[id] = "loading";
      else if (s === null) out[id] = "none";
      else if (s === "error") out[id] = { same: false, lines: ["Couldn't load this version's cut."] };
      else if (manifest) out[id] = diffSummary(s, manifest, names, roles);
    }
    return out;
  }, [snaps, manifest, names, roles]);

  const fetchSnap = (id: string, retry = false) => {
    if (requested.current.has(id) && !(retry && snaps[id] === "error")) return;
    requested.current.add(id);
    const forSlug = slug;
    setSnaps((m) => ({ ...m, [id]: "loading" }));
    loadSnapshot(id)
      .then((s) => forSlug === useDirector.getState().slug && setSnaps((m) => ({ ...m, [id]: s })))
      .catch(() => forSlug === useDirector.getState().slug && setSnaps((m) => ({ ...m, [id]: "error" })));
  };
  useEffect(() => {
    for (const r of renders) {
      const first = renders.find((x) => x.planId === r.planId);
      if (first === r) fetchSnap(r.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renders, slug]);

  return (
    <VersionsView
      rows={rows}
      confirming={confirming}
      busy={busy}
      diff={diff}
      expanded={expanded}
      compareA={pickedA}
      onExpand={(id) => {
        setExpanded((e) => (e === id ? null : id));
        fetchSnap(id, true);
      }}
      onAskRestore={(id) => {
        setConfirming(id);
        fetchSnap(id, true);
      }}
      onConfirmRestore={(id) => {
        setBusy(id);
        void restoreVersion(id).finally(() => {
          setBusy(null);
          setConfirming(null);
        });
      }}
      onCancel={() => setConfirming(null)}
      onCompare={(id) => {
        if (!pickedA) setCompareA(id);
        else if (pickedA === id) setCompareA(null);
        else {
          openCompare(pickedA, id);
          setCompareA(null);
        }
      }}
    />
  );
}
