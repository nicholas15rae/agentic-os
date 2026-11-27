/**
 * Part 6 versions on demand (pure). From an approved cut, Nic picks other platforms; they join the
 * manifest's outputs (≤ MAX_OUTPUTS, media.rs validate_manifest refuses more) and a render plan is
 * raised. Nothing renders until Nic's Approve & Render click.
 */
import type { Platform, TimelineManifest } from "./contract";
import { MAX_OUTPUTS, setOutputs } from "./manifest";

export const VERSION_PLATFORMS: readonly Exclude<Platform, "custom">[] = ["reels", "tiktok", "youtube", "self_tape"];

/** The platforms the outputs would hold with `picks` added, or a reason it can't (pure). The
 * placeholder "custom" output gives way to real platforms. */
export function versionOutputs(current: Platform[], picks: Platform[]): { platforms: Platform[]; added: Platform[] } | { error: string } {
  const base = current.filter((p) => p !== "custom");
  const added = [...new Set(picks)].filter((p) => p !== "custom" && !base.includes(p));
  if (!added.length) return { error: "Those formats are already in Outputs." };
  const platforms = [...base, ...added];
  if (platforms.length > MAX_OUTPUTS) return { error: `Up to ${MAX_OUTPUTS} formats per render: ${platforms.length} picked.` };
  return { platforms, added };
}

/** The manifest with the versions added (pure), or the reason it can't be. */
export function withVersions(m: TimelineManifest, picks: Platform[]): { manifest: TimelineManifest; added: Platform[] } | { error: string } {
  const r = versionOutputs(
    m.outputs.map((o) => o.platform),
    picks,
  );
  if ("error" in r) return r;
  return { manifest: setOutputs(m, r.platforms), added: r.added };
}
