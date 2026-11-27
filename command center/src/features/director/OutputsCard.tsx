import { useState, type ReactNode } from "react";
import { Clapperboard, Loader2 } from "lucide-react";
import { Card, Chip, Select } from "@/components/ui";
import type { CaptionTrack, ColorLook, Platform, PlatformPreset } from "./contract";
import { editManifest, useDirector } from "./director-store";
import { CAPTION_STYLES, CAPTION_WORDS_MAX, COLOR_PRESETS, MAX_OUTPUTS, PLATFORMS, platformWantsCaptions, setCaptions, setColor, setOutputs } from "./manifest";
import { PLATFORM_LABEL, togglePlatform } from "./review-ui";
import { VERSION_PLATFORMS, versionOutputs } from "./more-versions";
import { planVersions } from "./launcher";

const STYLE_LABEL: Record<CaptionTrack["style"], string> = { clean: "Clean", bold_pop: "Bold pop", karaoke: "Karaoke", minimal: "Minimal" };
const COLOR_LABEL: Record<ColorLook["preset"], string> = { none: "None", warm: "Warm", cool: "Cool", punchy: "Punchy", film: "Film", bw: "Black & white" };

/** "9:16 · −14 LUFS · ≤ 90 s" (pure). */
export function presetSpec(p: PlatformPreset): string {
  return [p.aspect, `−${Math.abs(p.loudnessLufs)} LUFS`, p.maxSec != null ? `≤ ${p.maxSec} s` : null, p.maxSizeMb != null ? `≤ ${p.maxSizeMb} MB` : null].filter(Boolean).join(" · ");
}

export interface OutputsViewProps {
  outputs: PlatformPreset[];
  captions: CaptionTrack;
  color: ColorLook;
  onOutputs: (platforms: Platform[]) => void;
  onCaptions: (patch: Partial<CaptionTrack>) => void;
  onColor: (patch: Partial<ColorLook>) => void;
  /** Below the card's settings (versions on demand, once a final is approved). */
  extra?: ReactNode;
}

/** Outputs for the next render (1–4 platform presets from one approval) + caption style + colour look. Props only. */
export function OutputsView({ outputs, captions, color, onOutputs, onCaptions, onColor, extra }: OutputsViewProps) {
  const selected = outputs.map((o) => o.platform);
  const noCaptions = selected.filter((p) => !platformWantsCaptions(p));
  return (
    <Card title="Outputs" hint={`Pick up to ${MAX_OUTPUTS} formats; one approval renders them all on the CPU.`}>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Output platforms">
        {PLATFORMS.map((p) => {
          const on = selected.includes(p);
          const next = togglePlatform(selected, p);
          return (
            <Chip key={p} active={on} tone="teal" onClick={next ? () => onOutputs(next) : undefined}>
              {PLATFORM_LABEL[p]}
            </Chip>
          );
        })}
      </div>
      <ul className="mt-2 space-y-0.5">
        {outputs.map((o) => (
          <li key={o.platform} className="flex gap-2 text-[11px]">
            <span className="w-16 shrink-0 text-ink-2">{PLATFORM_LABEL[o.platform]}</span>
            <span className="font-mono text-[10px] text-ink-3">{presetSpec(o)}</span>
          </li>
        ))}
      </ul>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label className="flex items-center gap-1.5 text-[12px] text-ink">
            <input type="checkbox" checked={captions.enabled} onChange={(e) => onCaptions({ enabled: e.target.checked })} className="accent-teal" />
            Captions
          </label>
          <Select value={captions.style} disabled={!captions.enabled} onChange={(e) => onCaptions({ style: e.target.value as CaptionTrack["style"] })} className="!h-8 !py-0 text-[12px] disabled:opacity-50" aria-label="Caption style">
            {CAPTION_STYLES.map((s) => (
              <option key={s} value={s}>
                {STYLE_LABEL[s]}
              </option>
            ))}
          </Select>
          <div className="flex items-center gap-1.5">
            <Select value={captions.position} disabled={!captions.enabled} onChange={(e) => onCaptions({ position: e.target.value as CaptionTrack["position"] })} className="!h-8 !py-0 text-[12px] disabled:opacity-50" aria-label="Caption position">
              <option value="lower">Lower third</option>
              <option value="middle">Middle</option>
            </Select>
            <input type="number" min={1} max={CAPTION_WORDS_MAX} value={captions.maxWordsPerLine} disabled={!captions.enabled} onChange={(e) => onCaptions({ maxWordsPerLine: Number(e.target.value) })} className="field !h-8 !w-16 shrink-0 !py-0 text-[12px] disabled:opacity-50" aria-label="Words per line" title="Words per line" />
          </div>
          {captions.enabled && noCaptions.length > 0 && <p className="text-[10px] text-ink-3">{noCaptions.map((p) => PLATFORM_LABEL[p]).join(", ")} renders without captions.</p>}
        </div>
        <div className="space-y-1.5">
          <p className="text-[12px] text-ink">Colour look</p>
          <Select value={color.preset} onChange={(e) => onColor({ preset: e.target.value as ColorLook["preset"] })} className="!h-8 !py-0 text-[12px]" aria-label="Colour look">
            {COLOR_PRESETS.map((c) => (
              <option key={c} value={c}>
                {COLOR_LABEL[c]}
              </option>
            ))}
          </Select>
          <label className="flex items-center gap-2 text-[11px] text-ink-2">
            Strength
            <input type="range" min={0} max={1} step={0.05} value={color.strength} disabled={color.preset === "none"} onChange={(e) => onColor({ strength: Number(e.target.value) })} className="min-w-0 flex-1 accent-amber disabled:opacity-40" aria-label="Colour strength" />
            <span className="w-8 shrink-0 text-right font-mono text-[10px]">{Math.round(color.strength * 100)}%</span>
          </label>
        </div>
      </div>
      {extra}
    </Card>
  );
}

/** Versions on demand (Part 6): from the approved cut, pick other formats; one click adds them to
 * Outputs and raises a render plan. Nothing renders until Approve & Render. Props only. */
export function MoreVersionsView({ outputs, busy, onPlan }: { outputs: Platform[]; busy: boolean; onPlan: (picks: Platform[]) => void }) {
  const [picks, setPicks] = useState<Platform[]>([]);
  const choices = VERSION_PLATFORMS.filter((p) => !outputs.includes(p));
  // A pick turned on in Outputs above has no chip here any more: drop it from the plan.
  const live = picks.filter((p) => (choices as Platform[]).includes(p));
  if (!choices.length) return null;
  const r = live.length ? versionOutputs(outputs, live) : null;
  const blocked = r && "error" in r ? r.error : null;
  return (
    <div className="mt-3 rounded-[12px] border border-white/10 p-2.5" role="group" aria-label="More versions">
      <p className="text-[12px] text-ink">More versions of the approved cut</p>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {choices.map((p) => {
          const on = picks.includes(p);
          return (
            <Chip key={p} active={on} tone="teal" onClick={() => setPicks(on ? live.filter((x) => x !== p) : [...live, p])}>
              {PLATFORM_LABEL[p]}
            </Chip>
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={!live.length || !!blocked || busy}
          onClick={() => {
            onPlan(live);
            setPicks([]);
          }}
          className="pill-primary !h-8 !px-3 text-xs disabled:opacity-50"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Clapperboard size={12} />} {live.length > 1 ? `Plan ${live.length} versions` : "Plan version"}
        </button>
        <span className="text-[10px] text-ink-3">{blocked ?? "Adds them to Outputs and shows a render plan. Nothing renders until Approve & Render."}</span>
      </div>
    </div>
  );
}

export function OutputsCard() {
  const manifest = useDirector((s) => s.manifest);
  const approved = useDirector((s) => s.deliverables.length > 0);
  const planBusy = useDirector((s) => s.planBusy);
  if (!manifest) return null;
  const platforms = manifest.outputs.map((o) => o.platform);
  return (
    <OutputsView
      extra={approved ? <MoreVersionsView outputs={platforms} busy={planBusy} onPlan={(p) => void planVersions(p)} /> : null}
      outputs={manifest.outputs}
      captions={manifest.captions}
      color={manifest.color}
      onOutputs={(p) => editManifest((m) => setOutputs(m, p))}
      onCaptions={(patch) => editManifest((m) => setCaptions(m, patch))}
      onColor={(patch) => editManifest((m) => setColor(m, patch))}
    />
  );
}
