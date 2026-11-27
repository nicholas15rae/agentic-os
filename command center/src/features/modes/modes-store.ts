import { create } from "zustand";
import { useOs } from "@/features/os/os-store";
import { isDesktopApp } from "@/stores/settings";
import type { FeedbackLevel } from "@/lib/platform";
import { osSwitchboard, ownsServer } from "@/features/os/switchboard";
import { tonyModeTools } from "@/features/os/tool-load";
import { DEFAULT_EFFECTIVE, DEFAULT_MODE_ID, NOVELTY_MODE_ID, PRESET_MODES, BUILTIN_MODE_IDS, agentLive, isAlwaysLiveServer, toolGloballyFrozen, toolLive, viewFromMirror, type Curiosity, type DispatchPolicy, type EffectiveMode, type ModeMirror, type ModeOverrides, type ModesView, type SwitchboardFreeze, type TonyMode, type Verbosity } from "./modes";

/**
 * Tony's modes in the webview (Phase 2 Part C). Not persisted here: Rust owns modes.json and the
 * overrides; this store mirrors them.
 *   - Desktop: `tony_modes_*` commands + the `tony-mode-changed` event.
 *   - Phone: the `mode` block of `/api/os/state`, written through the inbox `command` item
 *     (`{modeId}` / `{overrides}` / `{resetOverrides: true}`); editing modes is desktop-only.
 * Before `load()` resolves it holds the presets with Brainstorming active (D11), so the voice
 * controller's Tier-3 decision is today's offer card until Rust says otherwise.
 *
 * Gabagool is a novelty overlay (D19): `toggleNovelty` plays/stops it through the cue system and
 * never changes the work mode.
 */

export type OverridePatch = { curiosity?: Curiosity; dispatch?: DispatchPolicy; verbosity?: Verbosity };

interface ModesState {
  modes: TonyMode[];
  activeId: string;
  effective: EffectiveMode;
  overrides: ModeOverrides;
  builtinIds: string[];
  /** Phone: the master switchboard's freezes from the mirror (desktop: null, read os.json). */
  frozen: { agents: string[]; tools: string[] } | null;
  /** Phone: Rust's exact MODE block from the mirror (desktop: null). */
  promptTail: string | null;
  loaded: boolean;
  error: string | null;
  load: () => Promise<void>;
  setActive: (id: string) => Promise<void>;
  override: (patch: OverridePatch) => Promise<void>;
  reset: () => Promise<void>;
  upsert: (mode: TonyMode, isNew?: boolean) => Promise<void>;
  duplicate: (id: string, newName?: string) => Promise<TonyMode | null>;
  remove: (id: string) => Promise<void>;
  toggleNovelty: (id: string) => Promise<void>;
}

const platform = () => import("@/lib/platform");

async function phoneCommand(payload: Record<string, unknown>): Promise<void> {
  const { gateway } = await import("@/lib/gateway");
  await gateway("/api/os/inbox", { method: "POST", body: JSON.stringify({ kind: "command", payload }) });
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

let listening = false;
/** Phone: the desktop can switch modes at any time; re-read the mirror this often while visible. */
export const PHONE_MODE_REFRESH_MS = 15_000;
let phoneRefresh: ReturnType<typeof setInterval> | undefined;

/**
 * Desktop: a mode switch / reset / active-mode edit rewrites os.json `feedback.sensitivity` in
 * Rust, but the narrator, the pipeline chat gate and NarrationControl read `useOs.cfg`. Keep its
 * level in step with the mode view (the effective level is what Rust wrote). No-op on the phone
 * (no cfg there) or before the OS config has loaded.
 */
export function syncFeedbackLevel(level: number): void {
  const cfg = useOs.getState().cfg;
  if (!cfg?.feedback || !Number.isFinite(level) || cfg.feedback.sensitivity === level) return;
  const sensitivity = Math.min(3, Math.max(0, Math.round(level))) as FeedbackLevel;
  if (cfg.feedback.sensitivity === sensitivity) return;
  useOs.setState({ cfg: { ...cfg, feedback: { ...cfg.feedback, sensitivity } } });
}

export const useModes = create<ModesState>((set, get) => {
  const apply = (v: ModesView) => {
    set({ modes: v.modes, activeId: v.active_mode_id, effective: v.effective, overrides: v.overrides ?? {}, builtinIds: v.builtin_ids, frozen: v.frozen ?? null, promptTail: v.prompt_tail ?? null, loaded: true, error: null });
    if (typeof v.effective?.feedback_level === "number") syncFeedbackLevel(v.effective.feedback_level);
  };

  /** Desktop: a command returning the new view. Phone: an inbox command, then a re-read. */
  const write = async (desktop: () => Promise<ModesView>, phone: Record<string, unknown> | null) => {
    try {
      // The Android app is Tauri too, but its Rust modes are the phone's own: it drives the desktop's
      // Tony through the inbox like the PWA.
      if (isDesktopApp()) apply(await desktop());
      else if (phone) {
        await phoneCommand(phone);
        setTimeout(() => void get().load(), 4000);
      } else throw new Error("Editing Tony's modes is desktop-only");
    } catch (e) {
      set({ error: errText(e) });
      throw e;
    }
  };

  return {
    modes: [...PRESET_MODES],
    activeId: DEFAULT_MODE_ID,
    effective: DEFAULT_EFFECTIVE,
    overrides: {},
    builtinIds: [...BUILTIN_MODE_IDS],
    frozen: null,
    promptTail: null,
    loaded: false,
    error: null,

    load: async () => {
      try {
        const p = await platform();
        if (isDesktopApp()) {
          if (!listening) {
            listening = true;
            void p.onNativeEvent<ModesView>("tony-mode-changed", (v) => v && apply(v)).catch(() => (listening = false));
          }
          apply(await p.cmd("tony_modes_get"));
        } else {
          watchPhoneMode(() => void get().load());
          const { gateway } = await import("@/lib/gateway");
          const st = await gateway<{ mode?: ModeMirror }>("/api/os/state");
          if (st?.mode?.id) apply(viewFromMirror(st.mode));
        }
      } catch (e) {
        set({ error: errText(e) });
      }
    },

    setActive: async (id) => {
      // D19: the novelty is a toggle, never the work mode.
      if (id === NOVELTY_MODE_ID || get().modes.find((m) => m.id === id)?.is_novelty) return get().toggleNovelty(id);
      const p = await platform();
      await write(() => p.cmd("tony_mode_set_active", { id }), { modeId: id });
    },

    override: async (patch) => {
      const p = await platform();
      await write(() => p.cmd("tony_mode_override", { patch }), { overrides: patch });
    },

    reset: async () => {
      const p = await platform();
      await write(() => p.cmd("tony_mode_reset"), { resetOverrides: true });
    },

    upsert: async (mode, isNew = true) => {
      const p = await platform();
      await write(() => p.cmd("tony_mode_upsert", { mode, isNew }), null);
    },

    duplicate: async (id, newName) => {
      const p = await platform();
      let made: TonyMode | null = null;
      await write(async () => {
        const r = await p.cmd("tony_mode_duplicate", { id, newName });
        made = r.mode;
        return r.view;
      }, null);
      return made;
    },

    remove: async (id) => {
      const p = await platform();
      await write(() => p.cmd("tony_mode_delete", { id }), null);
    },

    toggleNovelty: async (id) => {
      if (id !== NOVELTY_MODE_ID) return;
      const { toggleGabagoolMode } = await import("@/features/cues/cue-runtime");
      toggleGabagoolMode();
    },
  };
});

/**
 * Phone (outside the HUD view, which has its own poll): keep the mode view fresh, so the ModePill,
 * the Mode Panel and the Tier-3 decision don't run on a mode the desktop has since left. Re-reads
 * on focus / becoming visible and every PHONE_MODE_REFRESH_MS while visible. Installed once.
 */
function watchPhoneMode(reload: () => void): void {
  if (phoneRefresh !== undefined || typeof window === "undefined" || typeof document === "undefined") return;
  phoneRefresh = setInterval(() => {
    if (document.visibilityState !== "hidden") reload();
  }, PHONE_MODE_REFRESH_MS);
  window.addEventListener("focus", reload);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") reload();
  });
}

/**
 * The master switchboard's freezes this turn: the phone mirror's when it carries them, else the
 * desktop's os.json (`useOs.cfg.switchboard`). Nothing frozen before either has loaded.
 */
export function currentFreeze(): SwitchboardFreeze {
  const f = useModes.getState().frozen;
  if (f) return { frozenAgents: f.agents, frozenTools: f.tools };
  const s = osSwitchboard(useOs.getState().cfg);
  return { frozenAgents: s.frozenAgents, frozenTools: s.frozenTools };
}

/** Is `agent` live this turn (the active mode's overlay + the master switchboard)? */
export const isAgentLiveNow = (agent: string, osName = ""): boolean => agentLive(useModes.getState().effective, agent, currentFreeze(), osName);

/** Is `server` live for TONY this turn (section pass, Rust `modes::tony_server_live`)? His base
 * (the servers he owns) is on in every mode; the mode's extras (os.json `tonyModeTools`) in that
 * mode; only the master switchboard takes one away. Before the config loads: the mode rule. */
export function isTonyToolLiveNow(server: string): boolean {
  const cfg = useOs.getState().cfg;
  if (!cfg) return isToolLiveNow(server);
  if (isAlwaysLiveServer(server)) return true;
  if (toolGloballyFrozen(server, currentFreeze())) return false;
  const own = cfg.mcps?.some((m) => m.id === server && ownsServer(m.agents, "general"));
  return !!own || (tonyModeTools(cfg)[useModes.getState().effective.mode_id] ?? []).includes(server);
}

/** Is the tool server `server` live this turn? */
export const isToolLiveNow = (server: string): boolean => toolLive(useModes.getState().effective, server, currentFreeze());

/** Tests only: back to the presets, not loaded. */
export function resetModesForTests(): void {
  clearInterval(phoneRefresh);
  phoneRefresh = undefined;
  listening = false;
  useModes.setState({ modes: [...PRESET_MODES], activeId: DEFAULT_MODE_ID, effective: DEFAULT_EFFECTIVE, overrides: {}, builtinIds: [...BUILTIN_MODE_IDS], frozen: null, promptTail: null, loaded: false, error: null });
}
