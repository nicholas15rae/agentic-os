import { useState } from "react";
import { FolderOpen, Loader2, PackageCheck, Send } from "lucide-react";
import { useToasts } from "@/features/reminders/notify";
import { useCloud } from "@/features/cloud/cloud-store";
import { api } from "./api";
import type { Deliverable, VerifiedRender } from "./contract";
import { sendRenderToBizOps, type BizOpsResult } from "./bizops";
import { PLATFORM_LABEL } from "./review-ui";

const base = (p: string) => p.split(/[\\/]/).pop() ?? p;
const reveal = (path: string) => void api.reveal({ path }).catch((e) => useToasts.getState().push({ title: "Couldn't open the folder", body: String(e), tone: "error" }));

/** The starting hashtags for a post: the project's asset tags (pure). */
export function defaultHashtags(tags: string[][]): string {
  return [...new Set(tags.flat())].slice(0, 10).join(" ");
}

/** One approved final and its "Send to Biz Ops" form. The send only RAISES the Instagram card. */
function DeliverableRow({ d, render, hashtags }: { d: Deliverable; render: VerifiedRender | null; hashtags: string }) {
  const [open, setOpen] = useState(false);
  const [caption, setCaption] = useState("");
  const [tags, setTags] = useState(hashtags);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BizOpsResult | null>(null);
  const send = async () => {
    if (!render) return;
    setBusy(true);
    setResult(null);
    try {
      setResult(await sendRenderToBizOps(render, useCloud.getState(), { caption, hashtags: tags.split(/[\s,]+/).filter(Boolean) }, d));
    } catch (e) {
      setResult({ ok: false, reason: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="r-12 border border-teal/25 bg-teal/[0.04] p-2">
      <div className="flex items-center gap-2">
        <span className="shrink-0 rounded-full border border-teal/40 px-1.5 fs-10 text-teal-soft">{PLATFORM_LABEL[d.platform]}</span>
        <span className="min-w-0 flex-1 truncate fs-12 text-ink" title={d.path}>
          {base(d.path)}
        </span>
        <button onClick={() => reveal(d.path)} className="pill-glass !h-7 !w-7 shrink-0 !p-0" title="Open folder" aria-label={`Open folder of ${base(d.path)}`}>
          <FolderOpen size={11} />
        </button>
      </div>
      {d.captionPath && <p className="mt-0.5 truncate font-mono fs-10 text-ink-3">captions: {base(d.captionPath)}</p>}
      {!open ? (
        <button onClick={() => setOpen(true)} disabled={!render} className="pill-glass mt-1.5 !h-7 !px-2.5 fs-11 disabled:opacity-50" title={render ? "Fill in the post, then raise the Instagram card for your approval" : "Its verified render isn't on the shelf"}>
          <Send size={11} /> Send to Biz Ops
        </button>
      ) : (
        <form
          className="mt-1.5 space-y-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <textarea value={caption} onChange={(e) => setCaption(e.target.value)} rows={2} maxLength={2200} placeholder="Caption" className="field min-h-[44px] resize-y fs-12" aria-label="Instagram caption" />
          <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="hashtags, space separated" className="field !h-8 !py-0 fs-12" aria-label="Hashtags" />
          <p className="fs-10 text-ink-3">This opens the Instagram card. Nothing is posted until you approve it there.</p>
          <div className="flex gap-1.5">
            <button type="submit" disabled={busy} className="pill-primary !h-7 !px-2.5 fs-11 disabled:opacity-50">
              {busy ? <Loader2 size={11} className="animate-spin" /> : <Send size={11} />} Raise the Instagram card
            </button>
            <button type="button" onClick={() => setOpen(false)} className="pill-glass !h-7 !px-2.5 fs-11">
              Close
            </button>
          </div>
          {result && (result.ok ? <p className="fs-11 text-teal-soft">Card raised: approve or cancel it there.</p> : <p className="fs-11 text-alert">{result.reason}</p>)}
        </form>
      )}
    </li>
  );
}

/** The approved finals (renders/final/<platform>/). */
export function DeliverablesList({ deliverables, renders, hashtags, done }: { deliverables: Deliverable[]; renders: VerifiedRender[]; hashtags: string; done: boolean }) {
  if (!deliverables.length) return done ? <p className="mt-3 fs-11 text-ink-3">This project is done: its finals are in renders/final.</p> : null;
  return (
    <div className="mt-3">
      <p className="label-caps flex items-center gap-1 text-teal-soft">
        <PackageCheck size={11} /> Deliverables
      </p>
      <ul className="mt-1.5 space-y-1.5">
        {deliverables.map((d) => (
          <DeliverableRow key={`${d.platform}-${d.path}`} d={d} render={renders.find((r) => r.id === d.renderId) ?? null} hashtags={hashtags} />
        ))}
      </ul>
    </div>
  );
}
