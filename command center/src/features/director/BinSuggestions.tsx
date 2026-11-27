import { Check, Sparkles, X } from "lucide-react";
import type { MediaAsset, ShotSlot } from "./contract";
import { acceptMatch, acceptMoment, rejectMatch, rejectMoment, useDirector, type MatchSuggestion, type MomentSuggestion } from "./director-store";
import { timecode } from "./manifest";

export interface BinSuggestionsProps {
  matches: MatchSuggestion[];
  moments: MomentSuggestion[];
  assets: Pick<MediaAsset, "id" | "name">[];
  slots: Pick<ShotSlot, "id" | "label">[];
  onMatch: (id: string, accept: boolean) => void;
  onMoment: (id: string, accept: boolean) => void;
}

/** The Director's pending match_footage suggestions, each waiting for Nic's accept / reject. Props only. */
export function BinSuggestionsView({ matches, moments, assets, slots, onMatch, onMoment }: BinSuggestionsProps) {
  if (!matches.length && !moments.length) return null;
  const name = (id: string) => assets.find((a) => a.id === id)?.name ?? id;
  const slot = (id: string) => {
    const s = slots.find((x) => x.id === id);
    return s ? `${s.id} ${s.label}` : id;
  };
  return (
    <div className="mb-2 r-12 border border-amber/30 bg-amber/[0.06] p-2" role="group" aria-label="Director suggestions">
      <p className="flex items-center gap-1 fs-11 text-amber-soft">
        <Sparkles size={11} /> Director suggestions: accept or reject each
      </p>
      <ul className="mt-1.5 space-y-1.5">
        {matches.map((m) => (
          <li key={m.id} className="flex items-start gap-1.5">
            <div className="min-w-0 flex-1 fs-11">
              <p className="truncate text-ink">
                {name(m.assetId)} → {slot(m.slotId)}
              </p>
              {m.reason && <p className="text-ink-2">{m.reason}</p>}
            </div>
            <Decide label={`match ${name(m.assetId)} to ${slot(m.slotId)}`} onDecide={(ok) => onMatch(m.id, ok)} />
          </li>
        ))}
        {moments.map((m) => (
          <li key={m.id} className="flex items-start gap-1.5">
            <div className="min-w-0 flex-1 fs-11">
              <p className="truncate text-ink">
                Moment in {name(m.assetId)} · <span className="font-mono fs-10">{timecode(m.inSec)}–{timecode(m.outSec)}</span>
              </p>
              <p className="text-ink-2">
                {m.label} · {Math.round(m.score * 100)}%
              </p>
            </div>
            <Decide label={`moment ${m.label}`} onDecide={(ok) => onMoment(m.id, ok)} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function Decide({ label, onDecide }: { label: string; onDecide: (accept: boolean) => void }) {
  return (
    <span className="flex shrink-0 gap-1">
      <button onClick={() => onDecide(true)} className="grid size-7 place-items-center rounded-full border border-teal/50 text-teal-soft hover:bg-teal/10" title="Accept" aria-label={`Accept ${label}`}>
        <Check size={12} />
      </button>
      <button onClick={() => onDecide(false)} className="grid size-7 place-items-center rounded-full border border-white/15 text-ink-2 hover:bg-white/5" title="Reject" aria-label={`Reject ${label}`}>
        <X size={12} />
      </button>
    </span>
  );
}

export function BinSuggestions() {
  const matches = useDirector((s) => s.matchSuggestions);
  const moments = useDirector((s) => s.momentSuggestions);
  const assets = useDirector((s) => s.assets);
  const slots = useDirector((s) => s.manifest?.shotList ?? EMPTY);
  return (
    <BinSuggestionsView
      matches={matches}
      moments={moments}
      assets={assets}
      slots={slots}
      onMatch={(id, ok) => (ok ? void acceptMatch(id) : rejectMatch(id))}
      onMoment={(id, ok) => (ok ? void acceptMoment(id) : rejectMoment(id))}
    />
  );
}
const EMPTY: ShotSlot[] = [];
