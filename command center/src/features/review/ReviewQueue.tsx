import { useEffect, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, RotateCcw, ShieldCheck, Trash2 } from "lucide-react";
import { Card, Empty } from "@/components/ui";
import { gated } from "@/features/bridge/gate";
import { useToasts } from "@/features/reminders/notify";
import { ocmd } from "@/features/ops/api";
import { digestLine, idsOf, reasonLabel } from "@/features/ops/logic";
import { useOps } from "@/features/ops/ops-store";
import type { BatchResult, QItem } from "@/features/ops/types";

const ago = (ms: number) => {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  return m < 60 ? `${m}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

const size = (b: number) => (b < 1024 ? `${b} B` : `${(b / 1024).toFixed(1)} KB`);

function report(what: string, r: BatchResult | null) {
  if (!r) return;
  const failed = r.results.filter((x) => !x.ok);
  const ok = r.results.length - failed.length;
  useToasts.getState().push({
    title: failed.length ? `${what}: ${ok} done, ${failed.length} failed` : `${what}: ${ok} item${ok === 1 ? "" : "s"}`,
    body: failed.length ? failed.map((f) => f.error).slice(0, 3).join(" · ") : undefined,
    tone: failed.length ? "error" : "info",
  });
}

/** Approve Purge (the only hard delete) behind the standard confirmation card. */
async function purge(ids: string[], label: string) {
  if (!ids.length) return;
  const r = await gated(
    { action: "review-purge", summary: `Permanently delete ${ids.length} quarantined item${ids.length === 1 ? "" : "s"} (${label})`, detail: { items: ids.length } },
    (approved) => ocmd("review_approve", { itemIds: ids, approved }),
    (x) => `${x.results.filter((y) => y.ok).length} purged`,
  );
  report("Purged", r);
  await useOps.getState().refreshReview();
}

async function restore(ids: string[]) {
  if (!ids.length) return;
  try {
    report("Restored", await ocmd("review_reject", { itemIds: ids }));
  } catch (e) {
    useToasts.getState().push({ title: "Restore failed", body: String(e), tone: "error" });
  }
  await useOps.getState().refreshReview();
}

/**
 * The HITL digest: every pending purge and Security flag in one calm list, grouped by business
 * and reason. Nothing is deleted until you approve it; Restore puts the exact bytes back.
 */
/** `markSeen`: showing it clears the digest dot (false for a hidden copy, e.g. a collapsed panel's badge copy). */
export function ReviewQueue({ markSeen = true }: { markSeen?: boolean } = {}) {
  const review = useOps((s) => s.review);
  const refreshReview = useOps((s) => s.refreshReview);
  const markDigestSeen = useOps((s) => s.markDigestSeen);

  useEffect(() => {
    if (markSeen) markDigestSeen();
    void refreshReview();
  }, [markSeen, markDigestSeen, refreshReview]);

  if (!review) return <Empty>Loading the review queue…</Empty>;
  const all = idsOf(review.groups);

  return (
    <div className="space-y-4">
      {review.integrity && (
        <div role="alert" className="flex items-start gap-3 r-16 border border-alert/40 bg-alert/10 p-4 text-sm text-alert">
          <AlertTriangle size={18} className="mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold">Security rules failed their integrity check, so automated actions are halted.</p>
            <p className="mt-1 fs-12 opacity-90">{review.integrity}. Purge, restore, Garbage sweeps and Operations writes refuse until the app restarts with intact rules files.</p>
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-ink-2">{digestLine(review.groups)}</p>
        {all.length > 1 && (
          <div className="ml-auto flex gap-2">
            <button onClick={() => void restore(all)} className="h-9 rounded-full border border-white/10 px-3 fs-12 text-ink-2 hover:text-ink">
              Restore all
            </button>
            <button onClick={() => void purge(all, "everything pending")} className="h-9 rounded-full border border-alert/40 px-3 fs-12 text-alert hover:bg-alert/10">
              Approve purge for all
            </button>
          </div>
        )}
      </div>

      {!review.groups.length && (
        <Card>
          <div className="flex items-center gap-3 py-4 text-sm text-ink-2">
            <ShieldCheck size={18} className="text-teal" /> All clear. Garbage and Security will batch anything new here.
          </div>
        </Card>
      )}

      {review.groups.map((g) => {
        const ids = idsOf(review.groups, g.businessId);
        return (
          <Card
            key={g.businessId}
            title={`${g.displayName} · ${g.count}`}
            action={
              <>
                <button onClick={() => void restore(ids)} className="fs-12 text-ink-3 hover:text-ink">
                  Restore {ids.length > 1 ? "all" : ""}
                </button>
                <button onClick={() => void purge(ids, g.displayName)} className="fs-12 text-alert/80 hover:text-alert">
                  Purge {ids.length > 1 ? "all" : ""}
                </button>
              </>
            }
          >
            <div className="space-y-4">
              {g.reasons.map((r) => (
                <div key={r.reasonCode}>
                  <p className="label-caps mb-1.5 text-ink-3">
                    {reasonLabel(r.reasonCode)} · {r.items.length}
                  </p>
                  <ul className="divide-y divide-white/[0.05] r-12 border border-white/[0.06]">
                    {r.items.map((i) => (
                      <ItemRow key={i.itemId} item={i} />
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </Card>
        );
      })}

      {review.recentlyResolved.length > 0 && (
        <Card title="Recently resolved">
          <ul className="space-y-1 fs-12 text-ink-3">
            {review.recentlyResolved.map((i) => (
              <li key={i.itemId} className="flex gap-2">
                <span className={i.status === "purged" ? "text-alert/80" : "text-teal-soft"}>{i.status}</span>
                <span className="truncate font-mono">{i.rel}</span>
                <span className="ml-auto shrink-0">{i.resolvedAt ? ago(i.resolvedAt) : ""}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function ItemRow({ item }: { item: QItem }) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<string | null | undefined>(undefined);
  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && preview === undefined) {
      try {
        setPreview((await ocmd("review_inspect", { itemId: item.itemId })).preview);
      } catch (e) {
        setPreview(`(couldn't load: ${String(e)})`);
      }
    }
  };
  return (
    <li className="px-3 py-2">
      <div className="flex items-center gap-2">
        <button onClick={() => void toggle()} aria-expanded={open} aria-label={`Inspect ${item.rel}`} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          {open ? <ChevronDown size={14} className="shrink-0 text-ink-3" /> : <ChevronRight size={14} className="shrink-0 text-ink-3" />}
          <span className="min-w-0">
            <span className="block truncate font-mono fs-12 text-ink">{item.rel}</span>
            <span className="block truncate fs-11 text-ink-3">
              {item.reason} · {item.sourceAgent} · {ago(item.timestamp)} · {size(item.bytes)}
            </span>
          </span>
        </button>
        <button onClick={() => void restore([item.itemId])} title={item.kind === "blocked_write" ? "Write it into this business anyway" : "Put it back"} className="grid size-8 shrink-0 place-items-center rounded-full text-ink-3 hover:bg-white/5 hover:text-teal">
          <RotateCcw size={14} />
          <span className="sr-only">Reject and restore</span>
        </button>
        <button onClick={() => void purge([item.itemId], item.rel)} title="Approve purge (permanent)" className="grid size-8 shrink-0 place-items-center rounded-full text-ink-3 hover:bg-alert/10 hover:text-alert">
          <Trash2 size={14} />
          <span className="sr-only">Approve purge</span>
        </button>
      </div>
      {open && (
        <div className="mt-2 space-y-1.5 pl-6">
          <pre className="well max-h-48 overflow-auto whitespace-pre-wrap r-10 p-2.5 fs-11 leading-relaxed text-ink-2">{preview === undefined ? "Loading…" : (preview ?? "(binary or empty)")}</pre>
          <p className="break-all font-mono fs-10 text-ink-3">
            {item.itemId} · sha256 {item.sha256.slice(0, 16)}… · {item.kind === "blocked_write" ? "never written (held by Security)" : "snapshot kept until you decide"}
          </p>
        </div>
      )}
    </li>
  );
}
