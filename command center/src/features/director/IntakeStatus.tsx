import { FolderInput, Loader2, TriangleAlert } from "lucide-react";
import { useToasts } from "@/features/reminders/notify";
import { usePoll } from "@/lib/use-poll";
import { api } from "./api";
import type { DirectorCommands } from "./contract";
import { setAutoMatch, useDirector } from "./director-store";

export type IntakeInfo = DirectorCommands["media_intake_status"]["result"];
export const INTAKE_POLL_MS = 5_000;

/** The watched inbox line (pure): where to drop files, what's waiting, what's processing, the last error. */
export function IntakeStatusView({ info, error, autoMatch, onReveal, onAutoMatch }: { info: IntakeInfo | null; error: string | null; autoMatch: boolean; onReveal: (path: string) => void; onAutoMatch: (on: boolean) => void }) {
  if (!info) return error ? <p className="mb-2 fs-11 text-ink-3">Inbox status unavailable: {error}</p> : null;
  return (
    <div className="mb-2 r-12 border border-white/[0.08] bg-white/[0.02] p-2 fs-11 text-ink-2" role="status" aria-label="Inbox status">
      <div className="flex items-center gap-1.5">
        <FolderInput size={12} className="shrink-0 text-ink-3" />
        <span className="min-w-0 flex-1 truncate font-mono fs-10" title={info.inbox}>
          {info.inbox}
        </span>
        <button onClick={() => onReveal(info.inbox)} className="pill-glass !h-6 shrink-0 !px-2 fs-10" title="Open the inbox folder: files dropped there are staged automatically">
          Reveal
        </button>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span>{info.pending ? `${info.pending} waiting` : "Inbox empty"}</span>
        {info.processing && (
          <span className="flex min-w-0 items-center gap-1 text-amber-soft">
            <Loader2 size={10} className="shrink-0 animate-spin" />
            <span className="truncate">processing {info.processing}</span>
          </span>
        )}
        <label className="ml-auto flex cursor-pointer items-center gap-1" title="When new clips finish transcribing, ask the Director once for footage matches (suggestions only)">
          <input type="checkbox" checked={autoMatch} onChange={(e) => onAutoMatch(e.target.checked)} className="accent-teal" />
          Auto-match
        </label>
      </div>
      {info.lastError && (
        <p className="mt-1 flex items-start gap-1 text-alert">
          <TriangleAlert size={10} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{info.lastError}</span>
        </p>
      )}
    </div>
  );
}

export function IntakeStatusLine() {
  const slug = useDirector((s) => s.slug);
  const autoMatch = useDirector((s) => s.autoMatch);
  // Re-read on every asset change too (intake events refresh the assets).
  const assetsN = useDirector((s) => s.assets.length);
  const poll = usePoll(() => (slug ? api.intakeStatus({ slug }) : Promise.resolve(null)), INTAKE_POLL_MS, [slug, assetsN]);
  return (
    <IntakeStatusView
      info={poll.data}
      error={poll.error}
      autoMatch={autoMatch}
      onAutoMatch={setAutoMatch}
      onReveal={(path) => void api.reveal({ path }).catch((e) => useToasts.getState().push({ title: "Couldn't open the inbox", body: e instanceof Error ? e.message : String(e), tone: "error" }))}
    />
  );
}
