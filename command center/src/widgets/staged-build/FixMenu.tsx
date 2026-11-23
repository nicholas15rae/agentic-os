import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Loader2, Rocket, Wrench, X } from "lucide-react";
import { xcmd } from "@/lib/native-ext";
import { useNav } from "@/stores/nav";
import { useToasts } from "@/features/reminders/notify";
import { useMyApps } from "@/features/myapps/store";
import { errText, startHub, useHub } from "@/features/buildhub/hub-store";
import { reworkView, type ReworkView } from "@/features/buildhub/promoted";
import { placePromotedTile } from "@/features/buildhub/promote-tile";

export interface FixMenuProps {
  buildId: string;
  title: string;
}

type FixState = { kind: "closed" } | { kind: "editing"; text: string } | { kind: "sending"; text: string } | { kind: "error"; text: string; message: string };

const openInPlayPlace = (buildId: string) => {
  useMyApps.getState().requestFocus(buildId);
  useNav.getState().go("playplace");
};

/** Hover "Fix" dropdown on a promoted tile, and the tile's rework status while the Play Place works on it. */
export function FixMenu({ buildId, title }: FixMenuProps) {
  useEffect(startHub, []);
  const build = useHub((s) => s.view?.builds.find((b) => b.envelope.build_id === buildId));
  const view = reworkView(build);
  const [state, setState] = useState<FixState>({ kind: "closed" });
  const [promoting, setPromoting] = useState(false);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const open = state.kind !== "closed";
  const text = state.kind === "closed" ? "" : state.text;
  useEffect(() => {
    if (open) boxRef.current?.focus();
  }, [open]);

  const send = async (directive: string) => {
    setState({ kind: "sending", text: directive });
    try {
      await xcmd("build_rework", { buildId, directive });
      setState({ kind: "closed" });
      useToasts.getState().push({ title: "Sent to the Play Place", body: `“${title}” is being reworked. The tile keeps the current version until you promote the update.`, tone: "info" });
    } catch (e) {
      // Keep what was typed: a refusal must never lose the instructions.
      setState({ kind: "error", text: directive, message: errText(e) });
    }
  };

  const promote = async () => {
    setPromoting(true);
    try {
      await xcmd("build_promote", { buildId });
      placePromotedTile(buildId, title);
    } catch (e) {
      useToasts.getState().push({ title: "Promote update", body: errText(e), tone: "error" });
    } finally {
      setPromoting(false);
    }
  };

  if (view.kind !== "live") return <ReworkStatus view={view} promoting={promoting} onPromote={() => void promote()} onOpen={() => openInPlayPlace(buildId)} />;

  return (
    <>
      <button
        onClick={() => setState(open ? { kind: "closed" } : { kind: "editing", text: "" })}
        className={`absolute left-1.5 top-1.5 z-10 flex h-7 items-center gap-1 rounded-full border border-white/15 bg-[rgba(11,13,17,0.55)] px-2 text-[11px] text-ink-2 backdrop-blur transition-opacity hover:text-ink focus-visible:opacity-100 ${open ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
        aria-expanded={open}
        aria-label={`Fix or develop ${title}`}
        title="Fix or develop this widget in the Play Place"
      >
        <Wrench size={12} /> Fix
      </button>
      {open && (
        <form
          className="absolute left-1.5 right-1.5 top-10 z-20 space-y-2 rounded-[14px] border border-white/15 bg-[rgba(11,13,17,0.78)] p-2.5 shadow-xl backdrop-blur-md"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim() && state.kind !== "sending") void send(text.trim());
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setState({ kind: "closed" });
          }}
        >
          <div className="flex items-center justify-between">
            <span className="label-caps truncate text-ink-3">Fix or develop “{title}”</span>
            <button type="button" onClick={() => setState({ kind: "closed" })} className="text-ink-3 hover:text-ink" aria-label="Close">
              <X size={13} />
            </button>
          </div>
          <textarea
            ref={boxRef}
            className="field min-h-20 w-full resize-y text-[13px]"
            placeholder="What should change or be added? e.g. “thinner second hand and a date on the E46 face”"
            value={text}
            disabled={state.kind === "sending"}
            onChange={(e) => setState({ kind: "editing", text: e.target.value })}
            aria-label="What should change"
          />
          {state.kind === "error" && (
            <p role="alert" className="text-[12px] text-alert">
              {state.message}
            </p>
          )}
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-ink-3">The live tile stays as it is until you promote the update.</span>
            <button className="pill-primary !h-8 shrink-0 !px-3 text-xs" disabled={state.kind === "sending" || !text.trim()}>
              {state.kind === "sending" ? <Loader2 size={13} className="animate-spin" /> : <Wrench size={13} />} Send to Play Place
            </button>
          </div>
        </form>
      )}
    </>
  );
}

export function reworkLabel(view: Exclude<ReworkView, { kind: "live" }>): string {
  switch (view.kind) {
    case "working":
      return `Reworking in the Play Place · ${view.label}${view.progress > 0 ? ` ${Math.round(view.progress)}%` : ""}`;
    case "ready":
      return "Update ready";
    case "repair":
      return "Rework needs attention (Repair Queue)";
    case "cancelled":
      return "Rework cancelled";
  }
}

function ReworkStatus({ view, promoting, onPromote, onOpen }: { view: Exclude<ReworkView, { kind: "live" }>; promoting: boolean; onPromote: () => void; onOpen: () => void }) {
  const tone = view.kind === "repair" ? "border-alert/40 text-alert" : view.kind === "ready" ? "border-teal/40 text-teal-soft" : "border-white/15 text-ink-2";
  return (
    <div className={`absolute bottom-1.5 left-1.5 z-10 flex max-w-[calc(100%-12px)] items-center gap-1.5 rounded-full border bg-[rgba(11,13,17,0.6)] py-0.5 pl-2.5 pr-1 text-[11px] backdrop-blur ${tone}`} role="status">
      {view.kind === "working" && <Loader2 size={11} className="shrink-0 animate-spin" />}
      <span className="truncate">{reworkLabel(view)}</span>
      {view.kind === "ready" && (
        <button onClick={onPromote} disabled={promoting} className="pill-primary !h-6 shrink-0 !px-2 text-[11px]">
          {promoting ? <Loader2 size={11} className="animate-spin" /> : <Rocket size={11} />} Promote update
        </button>
      )}
      <button onClick={onOpen} className="pill-glass !h-6 shrink-0 !px-2 text-[11px]" title="Open this build's card in the Play Place">
        Play Place <ArrowUpRight size={11} />
      </button>
    </div>
  );
}
