import { Gpu } from "lucide-react";
import { useComfy } from "./comfy-store";
import { batonInfo, type BatonInfo } from "./comfy-ui";
import { useDirector } from "./director-store";
import type { PillTone } from "./StudioBar";

const TONE: Record<PillTone, string> = {
  green: "border-teal/50 text-teal-soft",
  amber: "border-amber/50 text-amber-soft",
  red: "border-alert/60 text-alert",
  violet: "border-violet/50 text-violet",
  unknown: "border-white/10 text-ink-3",
};
const DOT: Record<PillTone, string> = { green: "bg-teal", amber: "bg-amber", red: "bg-alert", violet: "bg-violet", unknown: "bg-ink-3" };

/** Who holds the GPU baton: Tony, ComfyUI, another agent, or nobody. Static dot (no animation). Props only. */
export function BatonPillView({ info }: { info: BatonInfo }) {
  return (
    <span className={`flex h-8 max-w-[320px] items-center gap-1.5 rounded-full border bg-[rgba(11,13,17,0.45)] px-3 fs-12 ${TONE[info.tone]}`} title={info.detail ?? info.label} role="status" aria-label={`GPU baton: ${info.label}`}>
      <Gpu size={12} className="shrink-0" />
      <span className={`size-2 shrink-0 rounded-full ${DOT[info.tone]}`} />
      <span className="truncate">{info.label}</span>
    </span>
  );
}

/** StudioBar, left of RenderBadge. Hidden while both the slot and the ComfyUI status are unknown. */
export function BatonPill() {
  const slot = useComfy((s) => s.slot);
  const status = useComfy((s) => s.status);
  const statusError = useComfy((s) => s.statusError);
  const job = useDirector((s) => s.job);
  const live = statusError ? null : status;
  if (!slot && !live) return null;
  return <BatonPillView info={batonInfo(slot, live, job)} />;
}
