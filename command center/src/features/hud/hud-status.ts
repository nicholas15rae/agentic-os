import type { ComputeMode } from "@/lib/platform";
import { PRESET_MODES, type ModeMirror } from "@/features/modes/modes";
import type { OverridePatch } from "@/features/modes/modes-store";

/**
 * The phone HUD's view of the desktop (`/api/os/state`, the os-state.json mirror) and the
 * commands it can send back through the inbox. Pure: unit-tested without the HUD's imports.
 */
export interface OsStatus {
  computeMode: ComputeMode;
  privacy: { diffuser: boolean; networkLock: boolean; killSwitch: boolean };
  osName?: string;
  scheduler?: { profile: string; tonyPriorityPct: number; offloadPct: number };
  runtime?: { droplet?: { state: string; detail: string } };
  /** Phase 2 Part C mirror: Tony's mode (phone only; the desktop reads `useModes`). */
  mode?: ModeMirror;
  /** Phase 2 Part B mirror: the desktop mic (phone only; the desktop reads `useMic`). */
  voice?: { micEnabled?: boolean; activationDb?: number };
}

/** Everything the HUD can ask the desktop to change (the inbox `command` payload). */
export interface HudCommand {
  killSwitch?: boolean;
  computeMode?: ComputeMode;
  modeId?: string;
  overrides?: OverridePatch;
  resetOverrides?: boolean;
  micEnabled?: boolean;
}

/**
 * A preset's dials. A custom mode's dials aren't in the mirror list, so until the next poll its
 * dispatch is the conservative "ask" (never the previous mode's auto_dispatch, which would let
 * the phone skip the card under a mode that doesn't allow it).
 */
const presetDials = (id: string) => {
  const p = PRESET_MODES.find((x) => x.id === id);
  return p ? { curiosity: p.curiosity_level, verbosity: p.verbosity, dispatch: p.agent_dispatch_policy } : { dispatch: "ask_before_dispatch" as const };
};

/**
 * The phone's optimistic copy of a command; the desktop applies it within ~3 s and the next poll
 * confirms (or corrects) it. The novelty mode is never made the work mode.
 */
export function applyOptimistic(r: OsStatus, p: HudCommand): OsStatus {
  let next: OsStatus = { ...r, computeMode: p.computeMode ?? r.computeMode, privacy: { ...r.privacy, killSwitch: p.killSwitch ?? r.privacy.killSwitch } };
  if (p.micEnabled !== undefined) next = { ...next, voice: { ...r.voice, micEnabled: p.micEnabled } };
  let m = r.mode;
  if (m && p.modeId) {
    const item = m.list.find((x) => x.id === p.modeId);
    if (item && !item.isNovelty) m = { ...m, id: item.id, name: item.name, icon: item.icon, overridden: [], ...presetDials(item.id) };
  }
  if (m && p.resetOverrides) m = { ...m, overridden: [], ...presetDials(m.id) };
  if (m && p.overrides) {
    const o = p.overrides;
    const keys = (["curiosity", "dispatch", "verbosity"] as const).filter((k) => o[k] !== undefined);
    m = {
      ...m,
      curiosity: o.curiosity ?? m.curiosity,
      dispatch: o.dispatch ?? m.dispatch,
      verbosity: o.verbosity ?? m.verbosity,
      overridden: [...new Set([...(m.overridden ?? []), ...keys])],
    };
  }
  return m ? { ...next, mode: m } : next;
}
